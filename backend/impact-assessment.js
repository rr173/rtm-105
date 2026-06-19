const { run, get, all } = require('./db');
const { getMachineById, getMachineVersionsByName } = require('./version-migration');
const { diffStates, diffTransitions, RISK_LEVEL, deepEqual } = require('./version-diff-engine');

function buildStateTransitionMap(definition) {
  const map = new Map();
  for (const state of definition.states) {
    const outgoing = definition.transitions.filter(t => t.sourceStateId === state.id);
    map.set(state.id, {
      state,
      outgoingTransitions: outgoing
    });
  }
  return map;
}

function transitionsEqual(transitionsA, transitionsB) {
  if (transitionsA.length !== transitionsB.length) return false;
  
  const keyA = transitionsA
    .map(t => `${t.sourceStateId}:${t.targetStateId}:${t.event}:${t.guard || ''}`)
    .sort()
    .join('|');
  
  const keyB = transitionsB
    .map(t => `${t.sourceStateId}:${t.targetStateId}:${t.event}:${t.guard || ''}`)
    .sort()
    .join('|');
  
  return keyA === keyB;
}

function assessInstanceRisk(instanceRow, oldDefinition, newDefinition) {
  const currentStateId = instanceRow.current_state_id;
  const context = instanceRow.context_data ? JSON.parse(instanceRow.context_data) : {};
  
  const oldStateInfo = oldDefinition.states.find(s => s.id === currentStateId);
  const newStateInfo = newDefinition.states.find(s => s.id === currentStateId);
  
  const result = {
    instanceId: instanceRow.id,
    currentStateId,
    currentStateName: oldStateInfo ? oldStateInfo.name : currentStateId,
    riskLevel: null,
    reasons: [],
    context
  };
  
  if (!newStateInfo) {
    result.riskLevel = RISK_LEVEL.DANGEROUS;
    result.reasons.push(`当前状态 "${oldStateInfo ? oldStateInfo.name : currentStateId}" 在新版本中已被删除`);
    
    const newStateByName = newDefinition.states.find(s => s.name === (oldStateInfo ? oldStateInfo.name : ''));
    if (newStateByName) {
      result.reasons.push(`提示：新版本中存在同名状态 "${newStateByName.name}"，但ID不同，可能需要手动映射`);
      result.suggestedStateId = newStateByName.id;
      result.suggestedStateName = newStateByName.name;
    }
    
    return result;
  }
  
  const oldOutgoing = oldDefinition.transitions.filter(t => t.sourceStateId === currentStateId);
  const newOutgoing = newDefinition.transitions.filter(t => t.sourceStateId === currentStateId);
  
  const hasTransitionChanges = !transitionsEqual(oldOutgoing, newOutgoing);
  
  if (hasTransitionChanges) {
    result.riskLevel = RISK_LEVEL.ATTENTION;
    
    const oldEvents = new Set(oldOutgoing.map(t => t.event));
    const newEvents = new Set(newOutgoing.map(t => t.event));
    
    const addedEvents = [...newEvents].filter(e => !oldEvents.has(e));
    const removedEvents = [...oldEvents].filter(e => !newEvents.has(e));
    
    if (addedEvents.length > 0) {
      result.reasons.push(`新增可触发事件: ${addedEvents.join(', ')}`);
    }
    if (removedEvents.length > 0) {
      result.reasons.push(`移除了原有事件: ${removedEvents.join(', ')}`);
    }
    
    const guardChanges = [];
    for (const oldT of oldOutgoing) {
      const newT = newOutgoing.find(t => t.event === oldT.event && t.targetStateId === oldT.targetStateId);
      if (newT && (oldT.guard || '') !== (newT.guard || '')) {
        guardChanges.push({
          event: oldT.event,
          targetStateId: oldT.targetStateId,
          oldGuard: oldT.guard || '',
          newGuard: newT.guard || ''
        });
      }
    }
    if (guardChanges.length > 0) {
      result.reasons.push(`守卫条件有变化，涉及 ${guardChanges.length} 个转换`);
      result.guardChanges = guardChanges;
    }
    
    const targetChanges = [];
    for (const oldT of oldOutgoing) {
      const newT = newOutgoing.find(t => t.event === oldT.event);
      if (newT && oldT.targetStateId !== newT.targetStateId) {
        const oldTarget = oldDefinition.states.find(s => s.id === oldT.targetStateId);
        const newTarget = newDefinition.states.find(s => s.id === newT.targetStateId);
        targetChanges.push({
          event: oldT.event,
          oldTarget: oldTarget ? oldTarget.name : oldT.targetStateId,
          newTarget: newTarget ? newTarget.name : newT.targetStateId
        });
      }
    }
    if (targetChanges.length > 0) {
      result.reasons.push(`部分事件的目标状态有变化`);
      result.targetChanges = targetChanges;
    }
    
    if (!addedEvents.length && !removedEvents.length && !guardChanges.length && !targetChanges.length) {
      result.reasons.push('出向转换有变化');
    }
  } else {
    result.riskLevel = RISK_LEVEL.SAFE;
    result.reasons.push('当前状态存在且出向转换无变化，迁移后行为一致');
  }
  
  if (newStateInfo.isFinal && !oldStateInfo.isFinal) {
    if (result.riskLevel === RISK_LEVEL.SAFE) {
      result.riskLevel = RISK_LEVEL.ATTENTION;
    }
    result.reasons.push('状态在新版本中变为终态，迁移后实例将结束');
  }
  
  if (!newStateInfo.isFinal && oldStateInfo.isFinal) {
    if (result.riskLevel === RISK_LEVEL.SAFE) {
      result.riskLevel = RISK_LEVEL.ATTENTION;
    }
    result.reasons.push('状态在新版本中不再是终态');
  }
  
  return result;
}

async function assessMigrationImpact(sourceMachineId, targetMachineId, instanceIds = null) {
  const sourceMachine = await getMachineById(sourceMachineId);
  if (!sourceMachine) {
    throw new Error('源状态机不存在');
  }
  
  const targetMachine = await getMachineById(targetMachineId);
  if (!targetMachine) {
    throw new Error('目标状态机不存在');
  }
  
  if (sourceMachine.name !== targetMachine.name) {
    throw new Error('只能在同名不同版本的状态机之间进行影响评估');
  }
  
  let instances;
  if (instanceIds && instanceIds.length > 0) {
    const placeholders = instanceIds.map(() => '?').join(',');
    instances = await all(
      `SELECT * FROM instances WHERE machine_id = ? AND id IN (${placeholders}) AND is_final = 0`,
      [sourceMachineId, ...instanceIds]
    );
  } else {
    instances = await all(
      'SELECT * FROM instances WHERE machine_id = ? AND is_final = 0',
      [sourceMachineId]
    );
  }
  
  const assessments = instances.map(inst => 
    assessInstanceRisk(inst, sourceMachine.definition, targetMachine.definition)
  );
  
  const stats = {
    total: assessments.length,
    safe: assessments.filter(a => a.riskLevel === RISK_LEVEL.SAFE).length,
    attention: assessments.filter(a => a.riskLevel === RISK_LEVEL.ATTENTION).length,
    dangerous: assessments.filter(a => a.riskLevel === RISK_LEVEL.DANGEROUS).length
  };
  
  return {
    sourceMachine: {
      id: sourceMachine.id,
      name: sourceMachine.name,
      version: sourceMachine.version
    },
    targetMachine: {
      id: targetMachine.id,
      name: targetMachine.name,
      version: targetMachine.version
    },
    stats,
    instances: assessments
  };
}

async function assessImpactByDiff(diffResult, sourceMachineId, instanceIds = null) {
  const sourceMachine = await getMachineById(sourceMachineId);
  if (!sourceMachine) {
    throw new Error('源状态机不存在');
  }
  
  let instances;
  if (instanceIds && instanceIds.length > 0) {
    const placeholders = instanceIds.map(() => '?').join(',');
    instances = await all(
      `SELECT * FROM instances WHERE machine_id = ? AND id IN (${placeholders}) AND is_final = 0`,
      [sourceMachineId, ...instanceIds]
    );
  } else {
    instances = await all(
      'SELECT * FROM instances WHERE machine_id = ? AND is_final = 0',
      [sourceMachineId]
    );
  }
  
  const removedStateIds = new Set(diffResult.states.removed.map(s => s.id));
  const modifiedStateIds = new Set(diffResult.states.modified.map(s => s.id));
  const addedTransitionStateIds = new Set(diffResult.transitions.added.map(t => t.sourceStateId));
  const removedTransitionStateIds = new Set(diffResult.transitions.removed.map(t => t.sourceStateId));
  const modifiedTransitionStateIds = new Set(diffResult.transitions.modified.map(t => t.sourceStateId));
  
  const affectedStateIds = new Set([
    ...removedStateIds,
    ...addedTransitionStateIds,
    ...removedTransitionStateIds,
    ...modifiedTransitionStateIds
  ]);
  
  const affectedInstances = [];
  for (const inst of instances) {
    const stateId = inst.current_state_id;
    
    let riskLevel;
    let reasons = [];
    
    if (removedStateIds.has(stateId)) {
      riskLevel = RISK_LEVEL.DANGEROUS;
      const stateInfo = diffResult.states.removed.find(s => s.id === stateId);
      reasons.push(`当前状态 "${stateInfo ? stateInfo.name : stateId}" 在新版本中已被删除`);
    } else if (affectedStateIds.has(stateId) || modifiedStateIds.has(stateId)) {
      riskLevel = RISK_LEVEL.ATTENTION;
      
      if (addedTransitionStateIds.has(stateId)) {
        const added = diffResult.transitions.added.filter(t => t.sourceStateId === stateId);
        reasons.push(`新增可触发事件: ${added.map(t => t.event).join(', ')}`);
      }
      if (removedTransitionStateIds.has(stateId)) {
        const removed = diffResult.transitions.removed.filter(t => t.sourceStateId === stateId);
        reasons.push(`移除了原有事件: ${removed.map(t => t.event).join(', ')}`);
      }
      if (modifiedTransitionStateIds.has(stateId)) {
        reasons.push('部分转换的配置有变化');
      }
      if (modifiedStateIds.has(stateId)) {
        reasons.push('状态属性有变更');
      }
    } else {
      riskLevel = RISK_LEVEL.SAFE;
      reasons.push('当前状态及出向转换无变化');
    }
    
    affectedInstances.push({
      instanceId: inst.id,
      currentStateId: stateId,
      riskLevel,
      reasons,
      context: inst.context_data ? JSON.parse(inst.context_data) : {}
    });
  }
  
  const stats = {
    total: affectedInstances.length,
    safe: affectedInstances.filter(a => a.riskLevel === RISK_LEVEL.SAFE).length,
    attention: affectedInstances.filter(a => a.riskLevel === RISK_LEVEL.ATTENTION).length,
    dangerous: affectedInstances.filter(a => a.riskLevel === RISK_LEVEL.DANGEROUS).length
  };
  
  return {
    stats,
    instances: affectedInstances
  };
}

module.exports = {
  assessInstanceRisk,
  assessMigrationImpact,
  assessImpactByDiff,
  buildStateTransitionMap,
  transitionsEqual
};
