const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { evaluateGuard } = require('./guard');
const { evaluatePolicies, buildStateNameMap } = require('./compliance-engine');
const { getMachineById, getMachineVersionsByName } = require('./version-migration');

async function createSimulation({ sourceType, sourceMachineId, sourceInstanceId, name }) {
  if (!['machine', 'instance'].includes(sourceType)) {
    throw new Error('sourceType 必须是 machine 或 instance');
  }

  const now = new Date().toISOString();
  const simulationId = uuidv4();

  let sourceSnapshot = {};
  let initialMachine = null;
  let initialInstance = null;
  let initialHistory = [];

  if (sourceType === 'machine') {
    if (!sourceMachineId) throw new Error('sourceMachineId 不能为空');
    initialMachine = await getMachineById(sourceMachineId);
    if (!initialMachine) throw new Error('状态机不存在');
    sourceSnapshot = {
      type: 'machine',
      machineId: sourceMachineId,
      machine: initialMachine,
      createdAt: now
    };
  } else {
    if (!sourceInstanceId) throw new Error('sourceInstanceId 不能为空');
    const instRow = await get('SELECT * FROM instances WHERE id = ?', [sourceInstanceId]);
    if (!instRow) throw new Error('实例不存在');
    initialMachine = await getMachineById(instRow.machine_id);
    if (!initialMachine) throw new Error('状态机不存在');

    const histRows = await all(
      'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
      [sourceInstanceId]
    );
    initialHistory = histRows.map(h => ({
      id: h.id,
      fromStateId: h.from_state_id,
      toStateId: h.to_state_id,
      event: h.event_name,
      payload: h.payload_snapshot ? JSON.parse(h.payload_snapshot) : null,
      createdAt: h.created_at,
      triggeredBy: h.triggered_by || 'user'
    }));

    initialInstance = {
      id: instRow.id,
      machineId: instRow.machine_id,
      currentStateId: instRow.current_state_id,
      context: JSON.parse(instRow.context_data),
      createdAt: instRow.created_at,
      isFinal: !!instRow.is_final,
      enteredStateAt: instRow.entered_state_at || instRow.created_at
    };

    sourceSnapshot = {
      type: 'instance',
      instanceId: sourceInstanceId,
      machineId: instRow.machine_id,
      machine: initialMachine,
      instance: initialInstance,
      history: initialHistory,
      createdAt: now
    };
  }

  await run(
    'INSERT INTO simulations (id, name, source_type, source_machine_id, source_instance_id, source_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      simulationId,
      name || `推演-${new Date().toLocaleString()}`,
      sourceType,
      sourceMachineId || null,
      sourceInstanceId || null,
      JSON.stringify(sourceSnapshot),
      now,
      now
    ]
  );

  const policies = await all(
    'SELECT * FROM compliance_policies WHERE machine_id = ? AND enabled = 1',
    [initialMachine.id]
  );
  const policiesSnapshot = policies.map(p => ({
    id: p.id,
    machineId: p.machine_id,
    name: p.name,
    type: p.type,
    config: JSON.parse(p.config_json || '{}'),
    enabled: !!p.enabled
  }));

  const initialState = initialMachine.definition.states.find(s => s.isInitial);
  if (!initialState) throw new Error('状态机没有初始状态');

  let branchInitialState, branchContext, branchEnteredAt;

  if (sourceType === 'instance' && initialInstance) {
    branchInitialState = initialInstance.currentStateId;
    branchContext = JSON.parse(JSON.stringify(initialInstance.context));
    branchEnteredAt = initialInstance.enteredStateAt;
  } else {
    branchInitialState = initialState.id;
    branchContext = {};
    branchEnteredAt = now;
  }

  const branchId = await createBranch({
    simulationId,
    name: '主分支',
    machineId: initialMachine.id,
    machineSnapshot: initialMachine.definition,
    policiesSnapshot,
    currentStateId: branchInitialState,
    contextData: branchContext,
    enteredStateAt: branchEnteredAt,
    isFinal: sourceType === 'instance' ? initialInstance.isFinal : initialState.isFinal
  });

  const initialStepId = uuidv4();
  await run(
    'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, to_state_id, context_after, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      initialStepId,
      branchId,
      0,
      'initial',
      branchInitialState,
      JSON.stringify(branchContext),
      0,
      now
    ]
  );

  if (sourceType === 'instance' && initialHistory.length > 0) {
    let currentState = initialHistory.length > 0 ? initialHistory[0].fromStateId : branchInitialState;
    let context = JSON.parse(JSON.stringify(branchContext));
    const stateNameMap = buildStateNameMap(initialMachine.definition);

    for (let i = 0; i < initialHistory.length; i++) {
      const hist = initialHistory[i];
      const stepStart = new Date(hist.createdAt).getTime();

      const transition = initialMachine.definition.transitions.find(
        t => t.sourceStateId === hist.fromStateId &&
             t.targetStateId === hist.toStateId &&
             t.event === hist.event
      );

      let guardResult = { passed: true, expression: null, reason: null };
      if (transition && transition.guard) {
        try {
          const passed = evaluateGuard(transition.guard, hist.payload || {}, context);
          guardResult = { passed, expression: transition.guard, reason: passed ? null : '守卫条件不满足' };
        } catch (e) {
          guardResult = { passed: false, expression: transition.guard, reason: e.message };
        }
      }

      const transitionHistory = initialHistory.slice(0, i).map(h => ({
        event: h.event,
        fromStateId: h.fromStateId,
        toStateId: h.toStateId,
        payload: h.payload,
        createdAt: h.createdAt
      }));

      const policyContext = {
        stateNameMap,
        history: transitionHistory,
        currentStateId: hist.fromStateId,
        targetStateId: hist.toStateId,
        event: hist.event,
        payload: hist.payload || {},
        enteredStateAt: i === 0 ? initialInstance.createdAt : initialHistory[i - 1].createdAt,
        eventTimestamp: hist.createdAt
      };
      const violations = evaluatePolicies(policiesSnapshot, policyContext);
      const complianceResult = {
        allowed: violations.length === 0,
        violations
      };

      context = { ...context, ...(hist.payload || {}) };
      const stepEnd = new Date(hist.createdAt).getTime();

      await run(
        'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, from_state_id, to_state_id, event_name, payload_snapshot, guard_result, compliance_result, context_before, context_after, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          uuidv4(),
          branchId,
          i + 1,
          'transition',
          hist.fromStateId,
          hist.toStateId,
          hist.event,
          JSON.stringify(hist.payload || {}),
          JSON.stringify(guardResult),
          JSON.stringify(complianceResult),
          JSON.stringify({ ...context }),
          JSON.stringify(context),
          stepEnd - stepStart,
          hist.createdAt
        ]
      );

      currentState = hist.toStateId;
    }
  }

  return getSimulationDetail(simulationId);
}

async function createBranch({
  simulationId,
  name,
  machineId,
  machineSnapshot,
  policiesSnapshot,
  currentStateId,
  contextData,
  enteredStateAt,
  isFinal = false,
  parentBranchId = null,
  parentStepId = null
}) {
  const branchId = uuidv4();
  const now = new Date().toISOString();

  await run(
    'INSERT INTO simulation_branches (id, simulation_id, name, machine_id, machine_snapshot, policies_snapshot, parent_branch_id, parent_step_id, current_state_id, context_data, entered_state_at, is_final, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      branchId,
      simulationId,
      name,
      machineId,
      JSON.stringify(machineSnapshot),
      policiesSnapshot ? JSON.stringify(policiesSnapshot) : null,
      parentBranchId,
      parentStepId,
      currentStateId,
      JSON.stringify(contextData),
      enteredStateAt || now,
      isFinal ? 1 : 0,
      now,
      now
    ]
  );

  return branchId;
}

async function listSimulations({ sourceMachineId, sourceInstanceId } = {}) {
  let sql = 'SELECT * FROM simulations WHERE is_archived = 0';
  const params = [];
  if (sourceMachineId) {
    sql += ' AND source_machine_id = ?';
    params.push(sourceMachineId);
  }
  if (sourceInstanceId) {
    sql += ' AND source_instance_id = ?';
    params.push(sourceInstanceId);
  }
  sql += ' ORDER BY updated_at DESC';
  const rows = await all(sql, params);
  return Promise.all(rows.map(async row => {
    const branches = await all('SELECT id, name, is_final FROM simulation_branches WHERE simulation_id = ?', [row.id]);
    return {
      id: row.id,
      name: row.name,
      sourceType: row.source_type,
      sourceMachineId: row.source_machine_id,
      sourceInstanceId: row.source_instance_id,
      sourceSnapshot: JSON.parse(row.source_snapshot),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      branchCount: branches.length,
      branches
    };
  }));
}

async function getSimulationDetail(simulationId) {
  const simRow = await get('SELECT * FROM simulations WHERE id = ?', [simulationId]);
  if (!simRow) return null;

  const branches = await all('SELECT * FROM simulation_branches WHERE simulation_id = ? ORDER BY created_at ASC', [simulationId]);
  const branchDetails = await Promise.all(branches.map(async branch => {
    const steps = await all(
      'SELECT * FROM simulation_steps WHERE branch_id = ? ORDER BY step_index ASC',
      [branch.id]
    );
    return {
      id: branch.id,
      simulationId: branch.simulation_id,
      name: branch.name,
      machineId: branch.machine_id,
      machineSnapshot: JSON.parse(branch.machine_snapshot),
      policiesSnapshot: branch.policies_snapshot ? JSON.parse(branch.policies_snapshot) : null,
      parentBranchId: branch.parent_branch_id,
      parentStepId: branch.parent_step_id,
      currentStateId: branch.current_state_id,
      context: JSON.parse(branch.context_data),
      enteredStateAt: branch.entered_state_at,
      isFinal: !!branch.is_final,
      createdAt: branch.created_at,
      updatedAt: branch.updated_at,
      steps: steps.map(s => ({
        id: s.id,
        branchId: s.branch_id,
        stepIndex: s.step_index,
        stepType: s.step_type,
        fromStateId: s.from_state_id,
        toStateId: s.to_state_id,
        eventName: s.event_name,
        payload: s.payload_snapshot ? JSON.parse(s.payload_snapshot) : null,
        guardResult: s.guard_result ? JSON.parse(s.guard_result) : null,
        complianceResult: s.compliance_result ? JSON.parse(s.compliance_result) : null,
        timeoutInfo: s.timeout_info ? JSON.parse(s.timeout_info) : null,
        contextBefore: s.context_before ? JSON.parse(s.context_before) : null,
        contextAfter: s.context_after ? JSON.parse(s.context_after) : null,
        durationMs: s.duration_ms,
        createdAt: s.created_at
      }))
    };
  }));

  return {
    id: simRow.id,
    name: simRow.name,
    sourceType: simRow.source_type,
    sourceMachineId: simRow.source_machine_id,
    sourceInstanceId: simRow.source_instance_id,
    sourceSnapshot: JSON.parse(simRow.source_snapshot),
    createdAt: simRow.created_at,
    updatedAt: simRow.updated_at,
    isArchived: !!simRow.is_archived,
    branches: branchDetails
  };
}

async function deleteSimulation(simulationId) {
  const steps = await all(
    'SELECT ss.id FROM simulation_steps ss JOIN simulation_branches sb ON ss.branch_id = sb.id WHERE sb.simulation_id = ?',
    [simulationId]
  );
  for (const s of steps) {
    await run('DELETE FROM simulation_steps WHERE id = ?', [s.id]);
  }
  await run('DELETE FROM simulation_branches WHERE simulation_id = ?', [simulationId]);
  const result = await run('DELETE FROM simulations WHERE id = ?', [simulationId]);
  return result.changes > 0;
}

async function sendEventToBranch(branchId, { event, payload = {} }) {
  const branchRow = await get('SELECT * FROM simulation_branches WHERE id = ?', [branchId]);
  if (!branchRow) throw new Error('分支不存在');
  if (branchRow.is_final) throw new Error('分支已处于终态，无法继续操作');

  const machineDef = JSON.parse(branchRow.machine_snapshot);
  const policies = branchRow.policies_snapshot ? JSON.parse(branchRow.policies_snapshot) : [];
  const context = JSON.parse(branchRow.context_data);
  const currentStateId = branchRow.current_state_id;
  const enteredStateAt = branchRow.entered_state_at;

  const outgoing = machineDef.transitions.filter(
    t => t.sourceStateId === currentStateId && t.event === event
  );

  let matchedTransition = null;
  let guardResult = { passed: false, expression: null, reason: '没有匹配的转换' };

  for (const t of outgoing) {
    try {
      if (evaluateGuard(t.guard, payload || {}, context)) {
        matchedTransition = t;
        guardResult = { passed: true, expression: t.guard || null, reason: null };
        break;
      } else {
        guardResult = { passed: false, expression: t.guard, reason: '守卫条件不满足' };
      }
    } catch (e) {
      guardResult = { passed: false, expression: t.guard, reason: e.message };
    }
  }

  const prevSteps = await all(
    'SELECT * FROM simulation_steps WHERE branch_id = ? ORDER BY step_index ASC',
    [branchId]
  );
  const historyForCompliance = prevSteps
    .filter(s => s.step_type === 'transition')
    .map(s => ({
      event: s.event_name,
      fromStateId: s.from_state_id,
      toStateId: s.to_state_id,
      payload: s.payload_snapshot ? JSON.parse(s.payload_snapshot) : null,
      createdAt: s.created_at
    }));

  let complianceResult = { allowed: true, violations: [] };
  if (matchedTransition) {
    const stateNameMap = buildStateNameMap(machineDef);
    const targetState = machineDef.states.find(s => s.id === matchedTransition.targetStateId);
    const policyContext = {
      stateNameMap,
      history: historyForCompliance,
      currentStateId,
      targetStateId: targetState.id,
      event,
      payload: payload || {},
      enteredStateAt,
      eventTimestamp: new Date().toISOString()
    };
    const violations = evaluatePolicies(policies, policyContext);
    complianceResult = {
      allowed: violations.length === 0,
      violations
    };
  }

  const stepStart = Date.now();
  const now = new Date().toISOString();
  const newStepIndex = prevSteps.length;

  let newContext = context;
  let newStateId = currentStateId;
  let isFinal = !!branchRow.is_final;

  if (matchedTransition && complianceResult.allowed) {
    const targetState = machineDef.states.find(s => s.id === matchedTransition.targetStateId);
    newStateId = targetState.id;
    newContext = { ...context, ...(payload || {}) };
    isFinal = !!targetState.isFinal;

    await run(
      'UPDATE simulation_branches SET current_state_id = ?, context_data = ?, entered_state_at = ?, is_final = ?, updated_at = ? WHERE id = ?',
      [newStateId, JSON.stringify(newContext), now, isFinal ? 1 : 0, now, branchId]
    );
  }

  await run(
    'UPDATE simulations SET updated_at = ? WHERE id = (SELECT simulation_id FROM simulation_branches WHERE id = ?)',
    [now, branchId]
  );

  const stepId = uuidv4();
  const durationMs = Date.now() - stepStart;

  await run(
    'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, from_state_id, to_state_id, event_name, payload_snapshot, guard_result, compliance_result, context_before, context_after, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      stepId,
      branchId,
      newStepIndex,
      'transition',
      currentStateId,
      newStateId,
      event,
      JSON.stringify(payload || {}),
      JSON.stringify(guardResult),
      JSON.stringify(complianceResult),
      JSON.stringify(context),
      JSON.stringify(newContext),
      durationMs,
      now
    ]
  );

  return {
    stepId,
    branchId,
    fromStateId: currentStateId,
    toStateId: newStateId,
    event,
    guardResult,
    complianceResult,
    contextBefore: context,
    contextAfter: newContext,
    isFinal,
    transitionFound: !!matchedTransition,
    timestamp: now,
    durationMs
  };
}

async function simulateTimeout(branchId, { simulateSeconds }) {
  const branchRow = await get('SELECT * FROM simulation_branches WHERE id = ?', [branchId]);
  if (!branchRow) throw new Error('分支不存在');
  if (branchRow.is_final) throw new Error('分支已处于终态');

  const machineDef = JSON.parse(branchRow.machine_snapshot);
  const currentState = machineDef.states.find(s => s.id === branchRow.current_state_id);
  if (!currentState || !currentState.timeout) {
    return {
      triggered: false,
      reason: '当前状态没有超时配置',
      timeoutInfo: { hasTimeout: false }
    };
  }

  const enteredAt = new Date(branchRow.entered_state_at).getTime();
  const simulatedElapsed = (Date.now() - enteredAt) / 1000 + simulateSeconds;
  const willTrigger = simulatedElapsed >= currentState.timeout.duration;

  const timeoutInfo = {
    hasTimeout: true,
    originalDuration: currentState.timeout.duration,
    originalEvent: currentState.timeout.event,
    simulateSeconds,
    simulatedElapsedSeconds: Math.round(simulatedElapsed * 10) / 10,
    remainingSeconds: Math.max(0, Math.round((currentState.timeout.duration - simulatedElapsed) * 10) / 10),
    willTrigger
  };

  if (!willTrigger) {
    const now = new Date().toISOString();
    const prevSteps = await all('SELECT * FROM simulation_steps WHERE branch_id = ? ORDER BY step_index ASC', [branchId]);
    const stepId = uuidv4();

    await run(
      'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, from_state_id, to_state_id, timeout_info, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        stepId,
        branchId,
        prevSteps.length,
        'timeout_wait',
        branchRow.current_state_id,
        branchRow.current_state_id,
        JSON.stringify({ ...timeoutInfo, triggered: false }),
        simulateSeconds * 1000,
        now
      ]
    );

    return {
      triggered: false,
      reason: `还需等待 ${timeoutInfo.remainingSeconds}s 才会触发超时`,
      timeoutInfo
    };
  }

  return await sendEventToBranch(branchId, {
    event: currentState.timeout.event,
    payload: currentState.timeout.payload || {}
  }).then(result => ({
    ...result,
    stepType: 'timeout',
    timeoutInfo: { ...timeoutInfo, triggered: true }
  }));
}

async function forkBranch(branchId, { stepIndex, name, targetMachineId = null }) {
  const sourceBranch = await get('SELECT * FROM simulation_branches WHERE id = ?', [branchId]);
  if (!sourceBranch) throw new Error('源分支不存在');

  const steps = await all(
    'SELECT * FROM simulation_steps WHERE branch_id = ? AND step_index <= ? ORDER BY step_index ASC',
    [branchId, stepIndex]
  );

  if (steps.length === 0) throw new Error('指定的步骤不存在');

  const forkStep = steps[steps.length - 1];
  const contextAtFork = forkStep.context_after ? JSON.parse(forkStep.context_after) : {};
  const stateAtFork = forkStep.to_state_id;

  let machineDef = JSON.parse(sourceBranch.machine_snapshot);
  let policies = sourceBranch.policies_snapshot ? JSON.parse(sourceBranch.policies_snapshot) : [];
  let finalMachineId = sourceBranch.machine_id;

  if (targetMachineId && targetMachineId !== sourceBranch.machine_id) {
    const targetMachine = await getMachineById(targetMachineId);
    if (!targetMachine) throw new Error('目标状态机不存在');
    machineDef = targetMachine.definition;
    finalMachineId = targetMachine.id;

    const targetPolicies = await all(
      'SELECT * FROM compliance_policies WHERE machine_id = ? AND enabled = 1',
      [targetMachineId]
    );
    policies = targetPolicies.map(p => ({
      id: p.id,
      machineId: p.machine_id,
      name: p.name,
      type: p.type,
      config: JSON.parse(p.config_json || '{}'),
      enabled: !!p.enabled
    }));
  }

  let mappedStateId = stateAtFork;
  if (targetMachineId && targetMachineId !== sourceBranch.machine_id) {
    const oldState = JSON.parse(sourceBranch.machine_snapshot).states.find(s => s.id === stateAtFork);
    if (oldState) {
      const newState = machineDef.states.find(s => s.id === stateAtFork) ||
                      machineDef.states.find(s => s.name === oldState.name);
      if (newState) {
        mappedStateId = newState.id;
      } else {
        throw new Error(`状态 [${oldState.name}] 在目标状态机中不存在`);
      }
    }
  }

  const isFinal = machineDef.states.find(s => s.id === mappedStateId)?.isFinal || false;

  const newBranchId = await createBranch({
    simulationId: sourceBranch.simulation_id,
    name: name || `分支-${Date.now()}`,
    machineId: finalMachineId,
    machineSnapshot: machineDef,
    policiesSnapshot: policies,
    currentStateId: mappedStateId,
    contextData: contextAtFork,
    enteredStateAt: forkStep.created_at,
    isFinal,
    parentBranchId: branchId,
    parentStepId: forkStep.id
  });

  const now = new Date().toISOString();
  const initialStepId = uuidv4();

  await run(
    'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, from_state_id, to_state_id, timeout_info, context_after, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      initialStepId,
      newBranchId,
      0,
      'fork',
      stateAtFork,
      mappedStateId,
      JSON.stringify({
        fromBranchId: branchId,
        fromStepIndex: stepIndex,
        targetMachineId: targetMachineId || null
      }),
      JSON.stringify(contextAtFork),
      0,
      now
    ]
  );

  await run(
    'UPDATE simulations SET updated_at = ? WHERE id = ?',
    [now, sourceBranch.simulation_id]
  );

  return getBranchDetail(newBranchId);
}

async function refreshFromSource(branchId) {
  const branchRow = await get('SELECT * FROM simulation_branches WHERE id = ?', [branchId]);
  if (!branchRow) throw new Error('分支不存在');

  const simRow = await get('SELECT * FROM simulations WHERE id = ?', [branchRow.simulation_id]);
  if (!simRow) throw new Error('推演不存在');
  if (simRow.source_type !== 'instance') throw new Error('只有从实例创建的推演才能刷新');

  const sourceInstanceId = simRow.source_instance_id;
  const instRow = await get('SELECT * FROM instances WHERE id = ?', [sourceInstanceId]);
  if (!instRow) throw new Error('源实例不存在');

  const newHistoryRows = await all(
    `SELECT * FROM transitions 
     WHERE instance_id = ? AND created_at > ? 
     ORDER BY created_at ASC`,
    [sourceInstanceId, branchRow.entered_state_at || branchRow.created_at]
  );

  if (newHistoryRows.length === 0) {
    return { refreshed: false, message: '源实例没有新的流转' };
  }

  const machineDef = JSON.parse(branchRow.machine_snapshot);
  const policies = branchRow.policies_snapshot ? JSON.parse(branchRow.policies_snapshot) : [];
  const stateNameMap = buildStateNameMap(machineDef);

  let currentContext = JSON.parse(branchRow.context_data);
  let currentStateId = branchRow.current_state_id;
  let lastStepIndex = (await all(
    'SELECT MAX(step_index) as max_idx FROM simulation_steps WHERE branch_id = ?',
    [branchId]
  ))[0].max_idx;

  const appliedSteps = [];

  for (const hist of newHistoryRows) {
    const transition = machineDef.transitions.find(
      t => t.sourceStateId === hist.from_state_id &&
           t.targetStateId === hist.to_state_id &&
           t.event === hist.event_name
    );

    let guardResult = { passed: true, expression: null, reason: null };
    if (transition && transition.guard) {
      try {
        const payload = hist.payload_snapshot ? JSON.parse(hist.payload_snapshot) : {};
        const passed = evaluateGuard(transition.guard, payload, currentContext);
        guardResult = { passed, expression: transition.guard, reason: passed ? null : '守卫条件不满足' };
      } catch (e) {
        guardResult = { passed: false, expression: transition.guard, reason: e.message };
      }
    }

    const prevSteps = await all(
      'SELECT * FROM simulation_steps WHERE branch_id = ? AND step_type = "transition" ORDER BY step_index ASC',
      [branchId]
    );
    const historyForCompliance = prevSteps.map(s => ({
      event: s.event_name,
      fromStateId: s.from_state_id,
      toStateId: s.to_state_id,
      payload: s.payload_snapshot ? JSON.parse(s.payload_snapshot) : null,
      createdAt: s.created_at
    }));

    const payload = hist.payload_snapshot ? JSON.parse(hist.payload_snapshot) : {};
    const policyContext = {
      stateNameMap,
      history: historyForCompliance,
      currentStateId: hist.from_state_id,
      targetStateId: hist.to_state_id,
      event: hist.event_name,
      payload,
      enteredStateAt: currentStateId === hist.from_state_id ? branchRow.entered_state_at : hist.created_at,
      eventTimestamp: hist.created_at
    };
    const violations = evaluatePolicies(policies, policyContext);
    const complianceResult = { allowed: violations.length === 0, violations };

    lastStepIndex++;
    currentContext = { ...currentContext, ...payload };
    currentStateId = hist.to_state_id;

    const stepId = uuidv4();
    await run(
      'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, from_state_id, to_state_id, event_name, payload_snapshot, guard_result, compliance_result, context_before, context_after, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        stepId,
        branchId,
        lastStepIndex,
        'transition',
        hist.from_state_id,
        hist.to_state_id,
        hist.event_name,
        hist.payload_snapshot,
        JSON.stringify(guardResult),
        JSON.stringify(complianceResult),
        JSON.stringify({ ...currentContext }),
        JSON.stringify(currentContext),
        0,
        hist.created_at
      ]
    );

    appliedSteps.push({
      stepId,
      fromStateId: hist.from_state_id,
      toStateId: hist.to_state_id,
      event: hist.event_name
    });
  }

  const now = new Date().toISOString();
  const isFinal = machineDef.states.find(s => s.id === currentStateId)?.isFinal || false;

  await run(
    'UPDATE simulation_branches SET current_state_id = ?, context_data = ?, is_final = ?, updated_at = ? WHERE id = ?',
    [currentStateId, JSON.stringify(currentContext), isFinal ? 1 : 0, now, branchId]
  );

  await run(
    'UPDATE simulations SET updated_at = ? WHERE id = ?',
    [now, branchRow.simulation_id]
  );

  return {
    refreshed: true,
    appliedSteps,
    newStepCount: newHistoryRows.length
  };
}

async function createBranchFromLatest(branchId, { name }) {
  const branchRow = await get('SELECT * FROM simulation_branches WHERE id = ?', [branchId]);
  if (!branchRow) throw new Error('分支不存在');

  const simRow = await get('SELECT * FROM simulations WHERE id = ?', [branchRow.simulation_id]);
  if (!simRow) throw new Error('推演不存在');
  if (simRow.source_type !== 'instance') throw new Error('只有从实例创建的推演才能开新分支');

  const sourceInstanceId = simRow.source_instance_id;
  const instRow = await get('SELECT * FROM instances WHERE id = ?', [sourceInstanceId]);
  if (!instRow) throw new Error('源实例不存在');

  const machine = await getMachineById(instRow.machine_id);
  const policies = await all(
    'SELECT * FROM compliance_policies WHERE machine_id = ? AND enabled = 1',
    [instRow.machine_id]
  );
  const policiesSnapshot = policies.map(p => ({
    id: p.id,
    machineId: p.machine_id,
    name: p.name,
    type: p.type,
    config: JSON.parse(p.config_json || '{}'),
    enabled: !!p.enabled
  }));

  const context = JSON.parse(instRow.context_data);
  const currentStateId = instRow.current_state_id;
  const isFinal = !!instRow.is_final;

  const histRows = await all(
    'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
    [sourceInstanceId]
  );

  const newBranchId = await createBranch({
    simulationId: branchRow.simulation_id,
    name: name || `最新状态分支-${Date.now()}`,
    machineId: instRow.machine_id,
    machineSnapshot: machine.definition,
    policiesSnapshot,
    currentStateId,
    contextData: context,
    enteredStateAt: instRow.entered_state_at || instRow.created_at,
    isFinal,
    parentBranchId: branchId,
    parentStepId: null
  });

  const now = new Date().toISOString();
  const initialStepId = uuidv4();

  await run(
    'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, to_state_id, context_after, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      initialStepId,
      newBranchId,
      0,
      'refresh',
      currentStateId,
      JSON.stringify(context),
      0,
      now
    ]
  );

  if (histRows.length > 0) {
    const stateNameMap = buildStateNameMap(machine.definition);
    let currentContext = JSON.parse(JSON.stringify(context));

    for (let i = 0; i < histRows.length; i++) {
      const hist = histRows[i];
      const payload = hist.payload_snapshot ? JSON.parse(hist.payload_snapshot) : {};

      const transition = machine.definition.transitions.find(
        t => t.sourceStateId === hist.from_state_id &&
             t.targetStateId === hist.to_state_id &&
             t.event === hist.event_name
      );

      let guardResult = { passed: true, expression: null, reason: null };
      if (transition && transition.guard) {
        try {
          const passed = evaluateGuard(transition.guard, payload, currentContext);
          guardResult = { passed, expression: transition.guard, reason: passed ? null : '守卫条件不满足' };
        } catch (e) {
          guardResult = { passed: false, expression: transition.guard, reason: e.message };
        }
      }

      const transitionHistory = histRows.slice(0, i).map(h => ({
        event: h.event_name,
        fromStateId: h.from_state_id,
        toStateId: h.to_state_id,
        payload: h.payload_snapshot ? JSON.parse(h.payload_snapshot) : null,
        createdAt: h.created_at
      }));

      const policyContext = {
        stateNameMap,
        history: transitionHistory,
        currentStateId: hist.from_state_id,
        targetStateId: hist.to_state_id,
        event: hist.event_name,
        payload,
        enteredStateAt: i === 0 ? instRow.created_at : histRows[i - 1].created_at,
        eventTimestamp: hist.created_at
      };
      const violations = evaluatePolicies(policiesSnapshot, policyContext);
      const complianceResult = { allowed: violations.length === 0, violations };

      currentContext = { ...currentContext, ...payload };

      await run(
        'INSERT INTO simulation_steps (id, branch_id, step_index, step_type, from_state_id, to_state_id, event_name, payload_snapshot, guard_result, compliance_result, context_before, context_after, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          uuidv4(),
          newBranchId,
          i + 1,
          'transition',
          hist.from_state_id,
          hist.to_state_id,
          hist.event_name,
          hist.payload_snapshot,
          JSON.stringify(guardResult),
          JSON.stringify(complianceResult),
          JSON.stringify({ ...currentContext }),
          JSON.stringify(currentContext),
          0,
          hist.created_at
        ]
      );
    }
  }

  await run(
    'UPDATE simulations SET updated_at = ? WHERE id = ?',
    [now, branchRow.simulation_id]
  );

  return getBranchDetail(newBranchId);
}

async function getBranchDetail(branchId) {
  const branchRow = await get('SELECT * FROM simulation_branches WHERE id = ?', [branchId]);
  if (!branchRow) return null;

  const steps = await all(
    'SELECT * FROM simulation_steps WHERE branch_id = ? ORDER BY step_index ASC',
    [branchId]
  );

  return {
    id: branchRow.id,
    simulationId: branchRow.simulation_id,
    name: branchRow.name,
    machineId: branchRow.machine_id,
    machineSnapshot: JSON.parse(branchRow.machine_snapshot),
    policiesSnapshot: branchRow.policies_snapshot ? JSON.parse(branchRow.policies_snapshot) : null,
    parentBranchId: branchRow.parent_branch_id,
    parentStepId: branchRow.parent_step_id,
    currentStateId: branchRow.current_state_id,
    context: JSON.parse(branchRow.context_data),
    enteredStateAt: branchRow.entered_state_at,
    isFinal: !!branchRow.is_final,
    createdAt: branchRow.created_at,
    updatedAt: branchRow.updated_at,
    steps: steps.map(s => ({
      id: s.id,
      branchId: s.branch_id,
      stepIndex: s.step_index,
      stepType: s.step_type,
      fromStateId: s.from_state_id,
      toStateId: s.to_state_id,
      eventName: s.event_name,
      payload: s.payload_snapshot ? JSON.parse(s.payload_snapshot) : null,
      guardResult: s.guard_result ? JSON.parse(s.guard_result) : null,
      complianceResult: s.compliance_result ? JSON.parse(s.compliance_result) : null,
      timeoutInfo: s.timeout_info ? JSON.parse(s.timeout_info) : null,
      contextBefore: s.context_before ? JSON.parse(s.context_before) : null,
      contextAfter: s.context_after ? JSON.parse(s.context_after) : null,
      durationMs: s.duration_ms,
      createdAt: s.created_at
    }))
  };
}

function compareBranches(branchA, branchB) {
  const stepsA = branchA.steps || [];
  const stepsB = branchB.steps || [];
  const maxLen = Math.max(stepsA.length, stepsB.length);

  const differences = [];
  const commonTransitions = [];

  for (let i = 0; i < maxLen; i++) {
    const stepA = stepsA[i];
    const stepB = stepsB[i];

    if (!stepA || !stepB) {
      differences.push({
        stepIndex: i,
        type: 'existence',
        branchA: stepA ? summarizeStep(stepA) : null,
        branchB: stepB ? summarizeStep(stepB) : null
      });
      continue;
    }

    const diff = compareSteps(stepA, stepB);
    if (diff) {
      differences.push({
        stepIndex: i,
        type: diff.type,
        branchA: summarizeStep(stepA),
        branchB: summarizeStep(stepB),
        details: diff.details
      });
    } else {
      commonTransitions.push({
        stepIndex: i,
        event: stepA.eventName,
        fromStateId: stepA.fromStateId,
        toStateId: stepA.toStateId
      });
    }
  }

  const stateDiff = {
    branchA: branchA.currentStateId,
    branchB: branchB.currentStateId,
    same: branchA.currentStateId === branchB.currentStateId
  };

  const contextDiff = {
    same: JSON.stringify(branchA.context) === JSON.stringify(branchB.context),
    branchA: branchA.context,
    branchB: branchB.context
  };

  const totalDurationA = stepsA.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const totalDurationB = stepsB.reduce((sum, s) => sum + (s.durationMs || 0), 0);

  const violationsA = stepsA.flatMap(s => s.complianceResult?.violations || []);
  const violationsB = stepsB.flatMap(s => s.complianceResult?.violations || []);

  return {
    branchA: { id: branchA.id, name: branchA.name, stepCount: stepsA.length },
    branchB: { id: branchB.id, name: branchB.name, stepCount: stepsB.length },
    commonTransitions,
    differences,
    stateDiff,
    contextDiff,
    durationDiff: {
      branchA: totalDurationA,
      branchB: totalDurationB,
      diffMs: totalDurationB - totalDurationA
    },
    violationsDiff: {
      branchA: violationsA,
      branchB: violationsB,
      branchACount: violationsA.length,
      branchBCount: violationsB.length
    }
  };
}

function summarizeStep(step) {
  return {
    stepIndex: step.stepIndex,
    stepType: step.stepType,
    event: step.eventName,
    fromStateId: step.fromStateId,
    toStateId: step.toStateId,
    guardPassed: step.guardResult?.passed,
    complianceAllowed: step.complianceResult?.allowed,
    durationMs: step.durationMs,
    createdAt: step.createdAt
  };
}

function compareSteps(stepA, stepB) {
  const details = {};
  let hasDiff = false;

  if (stepA.stepType !== stepB.stepType) {
    details.stepType = { a: stepA.stepType, b: stepB.stepType };
    hasDiff = true;
  }

  if (stepA.eventName !== stepB.eventName) {
    details.event = { a: stepA.eventName, b: stepB.eventName };
    hasDiff = true;
  }

  if (stepA.fromStateId !== stepB.fromStateId) {
    details.fromState = { a: stepA.fromStateId, b: stepB.fromStateId };
    hasDiff = true;
  }

  if (stepA.toStateId !== stepB.toStateId) {
    details.toState = { a: stepA.toStateId, b: stepB.toStateId };
    hasDiff = true;
  }

  if ((stepA.guardResult?.passed) !== (stepB.guardResult?.passed)) {
    details.guard = {
      a: stepA.guardResult,
      b: stepB.guardResult
    };
    hasDiff = true;
  }

  if ((stepA.complianceResult?.allowed) !== (stepB.complianceResult?.allowed)) {
    details.compliance = {
      a: stepA.complianceResult,
      b: stepB.complianceResult
    };
    hasDiff = true;
  }

  if (JSON.stringify(stepA.payload) !== JSON.stringify(stepB.payload)) {
    details.payload = { a: stepA.payload, b: stepB.payload };
    hasDiff = true;
  }

  if (Math.abs((stepA.durationMs || 0) - (stepB.durationMs || 0)) > 10) {
    details.duration = {
      a: stepA.durationMs,
      b: stepB.durationMs,
      diffMs: (stepB.durationMs || 0) - (stepA.durationMs || 0)
    };
    hasDiff = true;
  }

  return hasDiff ? { type: 'step_difference', details } : null;
}

module.exports = {
  createSimulation,
  listSimulations,
  getSimulationDetail,
  deleteSimulation,
  sendEventToBranch,
  simulateTimeout,
  forkBranch,
  refreshFromSource,
  createBranchFromLatest,
  getBranchDetail,
  compareBranches
};
