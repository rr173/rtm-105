const DIFF_TYPE = {
  ADDED: 'added',
  REMOVED: 'removed',
  MODIFIED: 'modified'
};

const RISK_LEVEL = {
  SAFE: 'safe',
  ATTENTION: 'attention',
  DANGEROUS: 'dangerous'
};

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  
  if (typeof a !== 'object') return a === b;
  
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  
  if (Array.isArray(a) || Array.isArray(b)) return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  
  return true;
}

function buildStateMap(states) {
  const map = new Map();
  for (const s of states) {
    map.set(s.id, s);
  }
  return map;
}

function buildTransitionMap(transitions) {
  const map = new Map();
  for (const t of transitions) {
    const key = `${t.sourceStateId}:${t.targetStateId}:${t.event}`;
    map.set(key, t);
  }
  return map;
}

function compareStateProps(oldState, newState) {
  const changes = [];
  const propsToCompare = ['name', 'isInitial', 'isFinal', 'timeout'];
  
  for (const prop of propsToCompare) {
    const oldVal = oldState[prop];
    const newVal = newState[prop];
    
    if (!deepEqual(oldVal, newVal)) {
      changes.push({
        property: prop,
        oldValue: oldVal,
        newValue: newVal
      });
    }
  }
  
  return changes;
}

function compareTransitionProps(oldTransition, newTransition) {
  const changes = [];
  const propsToCompare = ['guard', 'sourceStateId', 'targetStateId', 'event'];
  
  for (const prop of propsToCompare) {
    const oldVal = oldTransition[prop];
    const newVal = newTransition[prop];
    
    if (!deepEqual(oldVal, newVal)) {
      changes.push({
        property: prop,
        oldValue: oldVal,
        newValue: newVal
      });
    }
  }
  
  return changes;
}

function diffStates(oldStates, newStates) {
  const oldMap = buildStateMap(oldStates);
  const newMap = buildStateMap(newStates);
  
  const added = [];
  const removed = [];
  const modified = [];
  
  for (const [id, newState] of newMap) {
    if (!oldMap.has(id)) {
      added.push({
        type: DIFF_TYPE.ADDED,
        entityType: 'state',
        id,
        name: newState.name,
        newValue: newState
      });
    } else {
      const oldState = oldMap.get(id);
      const changes = compareStateProps(oldState, newState);
      if (changes.length > 0) {
        modified.push({
          type: DIFF_TYPE.MODIFIED,
          entityType: 'state',
          id,
          name: newState.name,
          oldValue: oldState,
          newValue: newState,
          changes
        });
      }
    }
  }
  
  for (const [id, oldState] of oldMap) {
    if (!newMap.has(id)) {
      removed.push({
        type: DIFF_TYPE.REMOVED,
        entityType: 'state',
        id,
        name: oldState.name,
        oldValue: oldState
      });
    }
  }
  
  return { added, removed, modified };
}

function diffTransitions(oldTransitions, newTransitions) {
  const oldMap = buildTransitionMap(oldTransitions);
  const newMap = buildTransitionMap(newTransitions);
  
  const oldById = new Map();
  for (const t of oldTransitions) oldById.set(t.id, t);
  
  const newById = new Map();
  for (const t of newTransitions) newById.set(t.id, t);
  
  const added = [];
  const removed = [];
  const modified = [];
  
  const oldIdToKey = new Map();
  for (const t of oldTransitions) {
    oldIdToKey.set(t.id, `${t.sourceStateId}:${t.targetStateId}:${t.event}`);
  }
  
  const newIdToKey = new Map();
  for (const t of newTransitions) {
    newIdToKey.set(t.id, `${t.sourceStateId}:${t.targetStateId}:${t.event}`);
  }
  
  for (const [key, newTransition] of newMap) {
    if (!oldMap.has(key)) {
      added.push({
        type: DIFF_TYPE.ADDED,
        entityType: 'transition',
        id: newTransition.id,
        event: newTransition.event,
        sourceStateId: newTransition.sourceStateId,
        targetStateId: newTransition.targetStateId,
        newValue: newTransition
      });
    } else {
      const oldTransition = oldMap.get(key);
      const changes = compareTransitionProps(oldTransition, newTransition);
      if (changes.length > 0) {
        modified.push({
          type: DIFF_TYPE.MODIFIED,
          entityType: 'transition',
          id: newTransition.id,
          event: newTransition.event,
          sourceStateId: newTransition.sourceStateId,
          targetStateId: newTransition.targetStateId,
          oldValue: oldTransition,
          newValue: newTransition,
          changes
        });
      }
    }
  }
  
  for (const [key, oldTransition] of oldMap) {
    if (!newMap.has(key)) {
      removed.push({
        type: DIFF_TYPE.REMOVED,
        entityType: 'transition',
        id: oldTransition.id,
        event: oldTransition.event,
        sourceStateId: oldTransition.sourceStateId,
        targetStateId: oldTransition.targetStateId,
        oldValue: oldTransition
      });
    }
  }
  
  return { added, removed, modified };
}

function compareDefinitions(oldDefinition, newDefinition) {
  const stateDiff = diffStates(oldDefinition.states, newDefinition.states);
  const transitionDiff = diffTransitions(oldDefinition.transitions, newDefinition.transitions);
  
  const allDiffs = [
    ...stateDiff.added,
    ...stateDiff.removed,
    ...stateDiff.modified,
    ...transitionDiff.added,
    ...transitionDiff.removed,
    ...transitionDiff.modified
  ];
  
  const summary = {
    states: {
      added: stateDiff.added.length,
      removed: stateDiff.removed.length,
      modified: stateDiff.modified.length
    },
    transitions: {
      added: transitionDiff.added.length,
      removed: transitionDiff.removed.length,
      modified: transitionDiff.modified.length
    },
    totalChanges: allDiffs.length
  };
  
  return {
    summary,
    states: stateDiff,
    transitions: transitionDiff,
    hasChanges: allDiffs.length > 0
  };
}

function compareMachines(oldMachine, newMachine) {
  if (oldMachine.name !== newMachine.name) {
    throw new Error('只能比较同名状态机的不同版本');
  }
  
  const diffResult = compareDefinitions(oldMachine.definition, newMachine.definition);
  
  return {
    oldVersion: {
      id: oldMachine.id,
      name: oldMachine.name,
      version: oldMachine.version,
      createdAt: oldMachine.createdAt
    },
    newVersion: {
      id: newMachine.id,
      name: newMachine.name,
      version: newMachine.version,
      createdAt: newMachine.createdAt
    },
    ...diffResult
  };
}

module.exports = {
  DIFF_TYPE,
  RISK_LEVEL,
  compareDefinitions,
  compareMachines,
  diffStates,
  diffTransitions,
  deepEqual
};
