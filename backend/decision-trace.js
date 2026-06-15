const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { evaluateGuard } = require('./guard');
const {
  getPoliciesByMachineId,
  evaluatePoliciesDetailed,
  buildStateNameMap
} = require('./compliance-engine');

async function initTraceDB() {
  const exists = await get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='decision_traces'"
  );
  if (!exists) {
    await run(`
      CREATE TABLE decision_traces (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        transition_id TEXT,
        event_name TEXT NOT NULL,
        from_state_id TEXT NOT NULL,
        target_state_id TEXT,
        decision_result TEXT NOT NULL,
        rejection_reason TEXT,
        decision_tree_json TEXT NOT NULL,
        total_duration_ms INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES instances(id),
        FOREIGN KEY (machine_id) REFERENCES machines(id),
        FOREIGN KEY (transition_id) REFERENCES transitions(id)
      )
    `);
    await run(
      'CREATE INDEX idx_decision_traces_instance ON decision_traces(instance_id)'
    );
    await run(
      'CREATE INDEX idx_decision_traces_machine ON decision_traces(machine_id)'
    );
    await run(
      'CREATE INDEX idx_decision_traces_created ON decision_traces(created_at)'
    );
    await run(
      'CREATE INDEX idx_decision_traces_result ON decision_traces(decision_result)'
    );
    console.log('Created decision_traces table and indexes');
  }
}

async function saveTrace(traceData) {
  const id = traceData.id || uuidv4();
  await run(
    `INSERT INTO decision_traces
      (id, instance_id, machine_id, transition_id, event_name, from_state_id,
       target_state_id, decision_result, rejection_reason, decision_tree_json,
       total_duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      traceData.instanceId,
      traceData.machineId,
      traceData.transitionId || null,
      traceData.eventName,
      traceData.fromStateId,
      traceData.targetStateId || null,
      traceData.decisionResult,
      traceData.rejectionReason || null,
      JSON.stringify(traceData.decisionTree),
      traceData.totalDurationMs || null,
      traceData.createdAt || new Date().toISOString()
    ]
  );
  return id;
}

async function getTraceById(id) {
  const row = await get('SELECT * FROM decision_traces WHERE id = ?', [id]);
  if (!row) return null;
  return rowToTrace(row);
}

async function queryTraces(filters = {}) {
  let sql = 'SELECT * FROM decision_traces WHERE 1=1';
  const params = [];

  if (filters.instanceId) {
    sql += ' AND instance_id = ?';
    params.push(filters.instanceId);
  }
  if (filters.machineId) {
    sql += ' AND machine_id = ?';
    params.push(filters.machineId);
  }
  if (filters.startTime) {
    sql += ' AND created_at >= ?';
    params.push(filters.startTime);
  }
  if (filters.endTime) {
    sql += ' AND created_at <= ?';
    params.push(filters.endTime);
  }
  if (filters.rejected === true || filters.rejected === 'true') {
    sql += " AND decision_result != 'accepted'";
  } else if (filters.rejected === false || filters.rejected === 'false') {
    sql += " AND decision_result = 'accepted'";
  }
  if (filters.decisionResult) {
    sql += ' AND decision_result = ?';
    params.push(filters.decisionResult);
  }

  sql += ' ORDER BY created_at DESC';

  const limit = filters.limit ? parseInt(filters.limit, 10) : 50;
  const offset = filters.offset ? parseInt(filters.offset, 10) : 0;
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await all(sql, params);
  return rows.map(rowToTrace);
}

async function getTracesByInstanceId(instanceId, { limit = 50, offset = 0 } = {}) {
  const rows = await all(
    'SELECT * FROM decision_traces WHERE instance_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    [instanceId, limit, offset]
  );
  return rows.map(rowToTrace);
}

async function countTraces(filters = {}) {
  let sql = 'SELECT COUNT(*) as cnt FROM decision_traces WHERE 1=1';
  const params = [];

  if (filters.instanceId) {
    sql += ' AND instance_id = ?';
    params.push(filters.instanceId);
  }
  if (filters.machineId) {
    sql += ' AND machine_id = ?';
    params.push(filters.machineId);
  }
  if (filters.startTime) {
    sql += ' AND created_at >= ?';
    params.push(filters.startTime);
  }
  if (filters.endTime) {
    sql += ' AND created_at <= ?';
    params.push(filters.endTime);
  }
  if (filters.rejected === true || filters.rejected === 'true') {
    sql += " AND decision_result != 'accepted'";
  } else if (filters.rejected === false || filters.rejected === 'false') {
    sql += " AND decision_result = 'accepted'";
  }

  const row = await get(sql, params);
  return row ? row.cnt : 0;
}

function rowToTrace(row) {
  let decisionTree = null;
  try {
    decisionTree = JSON.parse(row.decision_tree_json);
  } catch (e) {
    decisionTree = null;
  }
  return {
    id: row.id,
    instanceId: row.instance_id,
    machineId: row.machine_id,
    transitionId: row.transition_id,
    eventName: row.event_name,
    fromStateId: row.from_state_id,
    targetStateId: row.target_state_id,
    decisionResult: row.decision_result,
    rejectionReason: row.rejection_reason,
    decisionTree,
    totalDurationMs: row.total_duration_ms,
    createdAt: row.created_at,
    isRejected: row.decision_result !== 'accepted'
  };
}

async function buildAndSaveTrace({
  machineId,
  machineDefinition,
  instanceId,
  currentStateId,
  eventName,
  payload,
  context,
  history,
  enteredStateAt,
  triggeredBy
}) {
  const traceStart = Date.now();
  const stateNameMap = buildStateNameMap(machineDefinition);
  const currentStateName = stateNameMap.get(currentStateId) || currentStateId;

  const outgoing = machineDefinition.transitions.filter(
    t => t.sourceStateId === currentStateId && t.event === eventName
  );

  const candidatePhaseStart = Date.now();
  const candidateResults = [];
  let matchedTransition = null;
  let matchedIndex = -1;

  for (let i = 0; i < outgoing.length; i++) {
    const t = outgoing[i];
    const targetState = machineDefinition.states.find(
      s => s.id === t.targetStateId
    );
    const targetStateName = targetState ? targetState.name : t.targetStateId;
    const guardExpr = t.guard || '';
    const guardStart = Date.now();
    let guardResult = false;
    let guardError = null;
    let guardInput = {};

    if (!guardExpr.trim()) {
      guardResult = true;
    } else {
      guardInput = { payload: payload || {}, context: context || {} };
      try {
        guardResult = evaluateGuard(guardExpr, payload || {}, context || {});
      } catch (e) {
        guardError = e.message;
        guardResult = false;
      }
    }

    const guardDurationMs = Date.now() - guardStart;
    const passed = guardResult && !guardError;

    candidateResults.push({
      transitionId: t.id,
      targetStateId: t.targetStateId,
      targetStateName,
      guardExpression: guardExpr || '(无守卫)',
      guardInput: guardExpr.trim() ? guardInput : null,
      guardResult,
      guardError,
      guardDurationMs,
      passed,
      selected: false
    });

    if (passed && !matchedTransition) {
      matchedTransition = t;
      matchedIndex = i;
    }
  }

  const candidatePhaseDurationMs = Date.now() - candidatePhaseStart;

  const phases = [
    {
      phase: 'candidate_matching',
      durationMs: candidatePhaseDurationMs,
      fromStateId: currentStateId,
      fromStateName: currentStateName,
      eventName,
      candidateCount: outgoing.length,
      candidates: candidateResults
    }
  ];

  let decisionResult;
  let targetStateId = null;
  let targetStateName = null;
  let rejectionReason = null;
  let compliancePhase = null;
  let complianceAllowed = true;
  let complianceViolations = [];

  if (!matchedTransition) {
    decisionResult = 'rejected_no_match';
    rejectionReason = outgoing.length === 0
      ? `当前状态 [${currentStateName}] 不存在事件 [${eventName}] 的候选转换`
      : `事件 [${eventName}] 的 ${outgoing.length} 条候选转换守卫均不通过`;
  } else {
    candidateResults[matchedIndex].selected = true;
    const targetState = machineDefinition.states.find(
      s => s.id === matchedTransition.targetStateId
    );
    targetStateId = matchedTransition.targetStateId;
    targetStateName = targetState ? targetState.name : matchedTransition.targetStateId;

    const complianceStart = Date.now();
    const policies = await getPoliciesByMachineId(machineId);
    const complianceContext = {
      stateNameMap,
      history,
      currentStateId,
      targetStateId,
      event: eventName,
      payload,
      enteredStateAt,
      eventTimestamp: new Date().toISOString()
    };

    const policyResults = evaluatePoliciesDetailed(policies, complianceContext);
    const complianceDurationMs = Date.now() - complianceStart;

    complianceViolations = policyResults.filter(p => p.result === 'violation');
    complianceAllowed = complianceViolations.length === 0;

    compliancePhase = {
      phase: 'compliance_check',
      durationMs: complianceDurationMs,
      transitionId: matchedTransition.id,
      targetStateId,
      targetStateName,
      allowed: complianceAllowed,
      policyCount: policies.length,
      policies: policyResults
    };

    phases.push(compliancePhase);

    if (!complianceAllowed) {
      decisionResult = 'rejected_compliance';
      const violationDescs = complianceViolations.map(
        v => `[${v.policyName}] ${v.reason}`
      );
      rejectionReason = `合规引擎拦截: ${violationDescs.join('; ')}`;
    } else {
      decisionResult = 'accepted';
    }
  }

  const totalDurationMs = Date.now() - traceStart;

  const decisionTree = {
    eventName,
    fromStateId: currentStateId,
    fromStateName: currentStateName,
    targetStateId,
    targetStateName,
    triggeredBy: triggeredBy || 'user',
    phases,
    summary: {
      candidateCount: outgoing.length,
      guardPassCount: candidateResults.filter(c => c.passed).length,
      complianceChecked: !!matchedTransition,
      compliancePass: complianceAllowed,
      complianceViolationCount: complianceViolations.length
    }
  };

  const traceId = uuidv4();
  const traceData = {
    id: traceId,
    instanceId,
    machineId,
    transitionId: null,
    eventName,
    fromStateId: currentStateId,
    targetStateId: decisionResult === 'accepted' ? targetStateId : null,
    decisionResult,
    rejectionReason,
    decisionTree,
    totalDurationMs,
    createdAt: new Date().toISOString()
  };

  try {
    await saveTrace(traceData);
  } catch (e) {
    console.error('[DecisionTrace] Failed to save trace:', e);
  }

  return {
    traceId,
    matchedTransition: decisionResult === 'accepted' ? matchedTransition : null,
    complianceAllowed,
    complianceViolations,
    decisionResult,
    targetStateId: decisionResult === 'accepted' ? targetStateId : null,
    targetStateName: decisionResult === 'accepted' ? targetStateName : null,
    rejectionReason
  };
}

async function linkTraceToTransition(traceId, transitionId) {
  try {
    await run(
      'UPDATE decision_traces SET transition_id = ? WHERE id = ?',
      [transitionId, traceId]
    );
  } catch (e) {
    console.error('[DecisionTrace] Failed to link trace to transition:', e);
  }
}

module.exports = {
  initTraceDB,
  saveTrace,
  getTraceById,
  queryTraces,
  getTracesByInstanceId,
  countTraces,
  buildAndSaveTrace,
  linkTraceToTransition
};
