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

const DIFF_TYPES = {
  EVENT_MISMATCH: 'event_mismatch',
  FROM_STATE_MISMATCH: 'from_state_mismatch',
  DECISION_RESULT_MISMATCH: 'decision_result_mismatch',
  TARGET_STATE_MISMATCH: 'target_state_mismatch',
  CANDIDATE_SELECTION_DIFF: 'candidate_selection_diff',
  GUARD_RESULT_DIFF: 'guard_result_diff',
  COMPLIANCE_POLICY_DIFF: 'compliance_policy_diff',
  COMPLIANCE_ALLOWED_DIFF: 'compliance_allowed_diff',
  CANDIDATE_COUNT_DIFF: 'candidate_count_diff'
};

function compareTraces(traceA, traceB) {
  if (!traceA || !traceB) {
    throw new Error('Both traces are required for comparison');
  }

  const diffs = [];
  const alignedPhases = [];

  if (traceA.eventName !== traceB.eventName) {
    diffs.push({
      type: DIFF_TYPES.EVENT_MISMATCH,
      level: 'high',
      message: '事件名称不同',
      traceA: traceA.eventName,
      traceB: traceB.eventName,
      path: 'eventName'
    });
  }

  if (traceA.fromStateId !== traceB.fromStateId ||
      (traceA.decisionTree?.fromStateName !== traceB.decisionTree?.fromStateName)) {
    diffs.push({
      type: DIFF_TYPES.FROM_STATE_MISMATCH,
      level: 'high',
      message: '起始状态不同',
      traceA: traceA.decisionTree?.fromStateName || traceA.fromStateId,
      traceB: traceB.decisionTree?.fromStateName || traceB.fromStateId,
      path: 'fromState'
    });
  }

  if (traceA.decisionResult !== traceB.decisionResult) {
    diffs.push({
      type: DIFF_TYPES.DECISION_RESULT_MISMATCH,
      level: 'critical',
      message: '决策结果不同',
      traceA: traceA.decisionResult,
      traceB: traceB.decisionResult,
      traceARejection: traceA.rejectionReason,
      traceBRejection: traceB.rejectionReason,
      path: 'decisionResult'
    });
  }

  const targetA = traceA.decisionTree?.targetStateName || traceA.targetStateId;
  const targetB = traceB.decisionTree?.targetStateName || traceB.targetStateId;
  if (targetA !== targetB) {
    diffs.push({
      type: DIFF_TYPES.TARGET_STATE_MISMATCH,
      level: 'critical',
      message: '目标状态不同',
      traceA: targetA || '(无)',
      traceB: targetB || '(无)',
      path: 'targetState'
    });
  }

  const phasesA = traceA.decisionTree?.phases || [];
  const phasesB = traceB.decisionTree?.phases || [];
  const maxPhaseLen = Math.max(phasesA.length, phasesB.length);

  for (let i = 0; i < maxPhaseLen; i++) {
    const phaseA = phasesA[i];
    const phaseB = phasesB[i];

    const phaseEntry = {
      index: i,
      traceA: phaseA || null,
      traceB: phaseB || null,
      phaseType: phaseA?.phase || phaseB?.phase || 'unknown',
      phaseDiffs: []
    };

    if (!phaseA || !phaseB) {
      phaseEntry.phaseDiffs.push({
        type: 'phase_missing',
        level: 'medium',
        message: !phaseA ? 'Trace A 缺少此阶段' : 'Trace B 缺少此阶段',
        path: `phases[${i}]`
      });
      alignedPhases.push(phaseEntry);
      continue;
    }

    if (phaseA.phase === 'candidate_matching' && phaseB.phase === 'candidate_matching') {
      phaseEntry.phaseDiffs.push(...compareCandidatePhase(phaseA, phaseB, i));
    }

    if (phaseA.phase === 'compliance_check' && phaseB.phase === 'compliance_check') {
      phaseEntry.phaseDiffs.push(...compareCompliancePhase(phaseA, phaseB, i));
    }

    alignedPhases.push(phaseEntry);
  }

  for (const phase of alignedPhases) {
    for (const d of phase.phaseDiffs) {
      diffs.push(d);
    }
  }

  diffs.sort((a, b) => {
    const levelOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return (levelOrder[a.level] ?? 99) - (levelOrder[b.level] ?? 99);
  });

  return {
    traceA: {
      id: traceA.id,
      eventName: traceA.eventName,
      decisionResult: traceA.decisionResult,
      targetState: targetA,
      totalDurationMs: traceA.totalDurationMs,
      createdAt: traceA.createdAt
    },
    traceB: {
      id: traceB.id,
      eventName: traceB.eventName,
      decisionResult: traceB.decisionResult,
      targetState: targetB,
      totalDurationMs: traceB.totalDurationMs,
      createdAt: traceB.createdAt
    },
    totalDifferences: diffs.length,
    criticalCount: diffs.filter(d => d.level === 'critical').length,
    highCount: diffs.filter(d => d.level === 'high').length,
    mediumCount: diffs.filter(d => d.level === 'medium').length,
    lowCount: diffs.filter(d => d.level === 'low').length,
    hasDifferences: diffs.length > 0,
    differences: diffs,
    alignedPhases
  };
}

function compareCandidatePhase(phaseA, phaseB, phaseIndex) {
  const diffs = [];
  const pathPrefix = `phases[${phaseIndex}]`;

  if (phaseA.candidateCount !== phaseB.candidateCount) {
    diffs.push({
      type: DIFF_TYPES.CANDIDATE_COUNT_DIFF,
      level: 'medium',
      message: '候选转换数量不同',
      traceA: phaseA.candidateCount,
      traceB: phaseB.candidateCount,
      path: `${pathPrefix}.candidateCount`
    });
  }

  const candidatesA = phaseA.candidates || [];
  const candidatesB = phaseB.candidates || [];

  const candidateMapA = new Map();
  for (const c of candidatesA) {
    const key = c.transitionId || `${c.targetStateId}|${c.guardExpression}`;
    candidateMapA.set(key, c);
  }

  const candidateMapB = new Map();
  for (const c of candidatesB) {
    const key = c.transitionId || `${c.targetStateId}|${c.guardExpression}`;
    candidateMapB.set(key, c);
  }

  const allKeys = new Set([...candidateMapA.keys(), ...candidateMapB.keys()]);

  let selectedDiffFound = false;

  for (const key of allKeys) {
    const cA = candidateMapA.get(key);
    const cB = candidateMapB.get(key);
    const cPath = `${pathPrefix}.candidates[${key}]`;

    if (!cA || !cB) {
      diffs.push({
        type: 'candidate_missing',
        level: 'medium',
        message: !cA
          ? `Trace A 缺少候选转换 →${cB.targetStateName}[${cB.guardExpression}]`
          : `Trace B 缺少候选转换 →${cA.targetStateName}[${cA.guardExpression}]`,
        traceA: cA ? summarizeCandidate(cA) : null,
        traceB: cB ? summarizeCandidate(cB) : null,
        path: cPath
      });
      continue;
    }

    if (cA.guardResult !== cB.guardResult) {
      diffs.push({
        type: DIFF_TYPES.GUARD_RESULT_DIFF,
        level: 'critical',
        message: `守卫 [${cA.guardExpression}] 判定结果不同 →${cA.targetStateName}`,
        traceA: {
          guardResult: cA.guardResult,
          passed: cA.passed,
          guardInput: cA.guardInput,
          guardError: cA.guardError
        },
        traceB: {
          guardResult: cB.guardResult,
          passed: cB.passed,
          guardInput: cB.guardInput,
          guardError: cB.guardError
        },
        targetStateName: cA.targetStateName,
        guardExpression: cA.guardExpression,
        path: `${cPath}.guardResult`
      });
    }

    if (cA.selected !== cB.selected && !selectedDiffFound) {
      selectedDiffFound = true;
      diffs.push({
        type: DIFF_TYPES.CANDIDATE_SELECTION_DIFF,
        level: 'critical',
        message: '选中的转换不同',
        traceA: {
          transitionId: cA.selected ? cA.transitionId : null,
          targetStateName: cA.selected ? cA.targetStateName : null,
          guardExpression: cA.selected ? cA.guardExpression : null
        },
        traceB: {
          transitionId: cB.selected ? cB.transitionId : null,
          targetStateName: cB.selected ? cB.targetStateName : null,
          guardExpression: cB.selected ? cB.guardExpression : null
        },
        path: `${pathPrefix}.selectedCandidate`
      });
    }
  }

  if (!selectedDiffFound && candidatesA.length > 0 && candidatesB.length > 0) {
    const selA = candidatesA.find(c => c.selected);
    const selB = candidatesB.find(c => c.selected);
    if ((selA?.transitionId) !== (selB?.transitionId)) {
      diffs.push({
        type: DIFF_TYPES.CANDIDATE_SELECTION_DIFF,
        level: 'critical',
        message: '选中的转换不同',
        traceA: selA ? summarizeCandidate(selA) : null,
        traceB: selB ? summarizeCandidate(selB) : null,
        path: `${pathPrefix}.selectedCandidate`
      });
    }
  }

  return diffs;
}

function summarizeCandidate(c) {
  if (!c) return null;
  return {
    transitionId: c.transitionId,
    targetStateName: c.targetStateName,
    targetStateId: c.targetStateId,
    guardExpression: c.guardExpression,
    guardResult: c.guardResult,
    passed: c.passed,
    selected: c.selected
  };
}

function compareCompliancePhase(phaseA, phaseB, phaseIndex) {
  const diffs = [];
  const pathPrefix = `phases[${phaseIndex}]`;

  if (phaseA.allowed !== phaseB.allowed) {
    diffs.push({
      type: DIFF_TYPES.COMPLIANCE_ALLOWED_DIFF,
      level: 'critical',
      message: '合规检查最终结论不同',
      traceA: { allowed: phaseA.allowed, reason: traceAComplianceReason(phaseA) },
      traceB: { allowed: phaseB.allowed, reason: traceAComplianceReason(phaseB) },
      path: `${pathPrefix}.allowed`
    });
  }

  const policiesA = phaseA.policies || [];
  const policiesB = phaseB.policies || [];

  const pMapA = new Map();
  for (const p of policiesA) pMapA.set(p.policyId || p.policyName, p);
  const pMapB = new Map();
  for (const p of policiesB) pMapB.set(p.policyId || p.policyName, p);

  const allPKeys = new Set([...pMapA.keys(), ...pMapB.keys()]);

  for (const key of allPKeys) {
    const pA = pMapA.get(key);
    const pB = pMapB.get(key);
    const pPath = `${pathPrefix}.policies[${key}]`;

    if (!pA || !pB) {
      diffs.push({
        type: 'policy_missing',
        level: 'low',
        message: !pA
          ? `Trace A 缺少策略 [${pB?.policyName}]`
          : `Trace B 缺少策略 [${pA?.policyName}]`,
        traceA: pA ? { policyName: pA.policyName, result: pA.result } : null,
        traceB: pB ? { policyName: pB.policyName, result: pB.result } : null,
        path: pPath
      });
      continue;
    }

    if (pA.result !== pB.result) {
      diffs.push({
        type: DIFF_TYPES.COMPLIANCE_POLICY_DIFF,
        level: 'critical',
        message: `合规策略 [${pA.policyName}] 判定结果不同`,
        traceA: {
          policyName: pA.policyName,
          policyType: pA.policyType,
          result: pA.result,
          reason: pA.reason,
          detail: pA.detail
        },
        traceB: {
          policyName: pB.policyName,
          policyType: pB.policyType,
          result: pB.result,
          reason: pB.reason,
          detail: pB.detail
        },
        path: `${pPath}.result`
      });
    }
  }

  return diffs;
}

function traceAComplianceReason(phase) {
  if (!phase) return null;
  const violations = (phase.policies || []).filter(p => p.result === 'violation');
  if (violations.length === 0) return null;
  return violations.map(v => `[${v.policyName}] ${v.reason}`).join('; ');
}

async function getBottleneckStats(filters = {}) {
  const where = [];
  const params = [];

  if (filters.machineId) {
    where.push('machine_id = ?');
    params.push(filters.machineId);
  }
  if (filters.startTime) {
    where.push('created_at >= ?');
    params.push(filters.startTime);
  }
  if (filters.endTime) {
    where.push('created_at <= ?');
    params.push(filters.endTime);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await all(
    `SELECT id, decision_tree_json, total_duration_ms, machine_id, event_name, transition_id, created_at
     FROM decision_traces
     ${whereClause}
     ORDER BY created_at ASC`,
    params
  );

  const transitionStats = new Map();
  const guardStats = new Map();
  const compliancePolicyStats = new Map();
  let totalTraces = rows.length;
  let totalDurationSum = 0;
  const allTraceDurations = [];

  for (const row of rows) {
    let tree;
    try {
      tree = JSON.parse(row.decision_tree_json);
    } catch (e) {
      continue;
    }

    if (typeof row.total_duration_ms === 'number') {
      totalDurationSum += row.total_duration_ms;
      allTraceDurations.push(row.total_duration_ms);
    }

    const phases = tree?.phases || [];

    for (const phase of phases) {
      if (phase.phase === 'candidate_matching') {
        const candidates = phase.candidates || [];
        for (const c of candidates) {
          const transKey = c.transitionId || `${tree.fromStateId}|${c.targetStateId}|${row.event_name}`;
          if (!transitionStats.has(transKey)) {
            transitionStats.set(transKey, {
              key: transKey,
              transitionId: c.transitionId,
              fromStateId: tree.fromStateId,
              fromStateName: tree.fromStateName,
              targetStateId: c.targetStateId,
              targetStateName: c.targetStateName,
              eventName: row.event_name,
              callCount: 0,
              selectedCount: 0,
              durations: [],
              totalDuration: 0
            });
          }
          const ts = transitionStats.get(transKey);
          ts.callCount++;
          if (c.selected) ts.selectedCount++;

          if (typeof phase.durationMs === 'number' && c.selected) {
            const d = phase.durationMs;
            ts.durations.push(d);
            ts.totalDuration += d;
          }

          if (c.guardExpression && c.guardExpression !== '(无守卫)') {
            const guardKey = `${transKey}|${c.guardExpression}`;
            if (!guardStats.has(guardKey)) {
              guardStats.set(guardKey, {
                key: guardKey,
                guardExpression: c.guardExpression,
                fromStateName: tree.fromStateName,
                targetStateName: c.targetStateName,
                eventName: row.event_name,
                transitionId: c.transitionId,
                callCount: 0,
                passCount: 0,
                durations: [],
                totalDuration: 0
              });
            }
            const gs = guardStats.get(guardKey);
            gs.callCount++;
            if (c.guardResult) gs.passCount++;
            if (typeof c.guardDurationMs === 'number') {
              const gd = c.guardDurationMs;
              gs.durations.push(gd);
              gs.totalDuration += gd;
            }
          }
        }
      }

      if (phase.phase === 'compliance_check') {
        const policies = phase.policies || [];
        for (const p of policies) {
          const pk = p.policyId || p.policyName;
          if (!pk) continue;
          if (!compliancePolicyStats.has(pk)) {
            compliancePolicyStats.set(pk, {
              key: pk,
              policyId: p.policyId,
              policyName: p.policyName,
              policyType: p.policyType,
              callCount: 0,
              violationCount: 0,
              durations: [],
              totalDuration: 0
            });
          }
          const ps = compliancePolicyStats.get(pk);
          ps.callCount++;
          if (p.result === 'violation') ps.violationCount++;
          if (typeof p.durationMs === 'number') {
            const d = p.durationMs;
            ps.durations.push(d);
            ps.totalDuration += d;
          }
        }
      }
    }
  }

  function computePercentile(durations, p) {
    if (durations.length === 0) return 0;
    const sorted = [...durations].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  function finalizeStats(entries) {
    return entries.map(e => {
      const avg = e.durations.length > 0 ? e.totalDuration / e.durations.length : 0;
      const max = e.durations.length > 0 ? Math.max(...e.durations) : 0;
      const p50 = computePercentile(e.durations, 50);
      const p95 = computePercentile(e.durations, 95);
      const p99 = computePercentile(e.durations, 99);
      return {
        ...e,
        averageDurationMs: Math.round(avg * 1000) / 1000,
        maxDurationMs: max,
        p50DurationMs: p50,
        p95DurationMs: p95,
        p99DurationMs: p99,
        sampleCount: e.durations.length
      };
    });
  }

  const topTransitions = finalizeStats([...transitionStats.values()])
    .sort((a, b) => b.averageDurationMs - a.averageDurationMs)
    .slice(0, 5);

  const topGuards = finalizeStats([...guardStats.values()])
    .sort((a, b) => b.averageDurationMs - a.averageDurationMs)
    .slice(0, 5);

  const topCompliancePolicies = finalizeStats([...compliancePolicyStats.values()])
    .sort((a, b) => b.averageDurationMs - a.averageDurationMs)
    .slice(0, 5);

  allTraceDurations.sort((a, b) => a - b);

  return {
    filters: {
      machineId: filters.machineId || null,
      startTime: filters.startTime || null,
      endTime: filters.endTime || null
    },
    summary: {
      totalTraces,
      averageTotalDurationMs: totalTraces > 0 ? Math.round((totalDurationSum / totalTraces) * 1000) / 1000 : 0,
      maxTotalDurationMs: allTraceDurations.length > 0 ? Math.max(...allTraceDurations) : 0,
      p95TotalDurationMs: computePercentile(allTraceDurations, 95),
      p50TotalDurationMs: computePercentile(allTraceDurations, 50)
    },
    topTransitions: topTransitions.map(t => ({
      key: t.key,
      transitionId: t.transitionId,
      fromStateName: t.fromStateName,
      targetStateName: t.targetStateName,
      eventName: t.eventName,
      callCount: t.callCount,
      selectedCount: t.selectedCount,
      sampleCount: t.sampleCount,
      averageDurationMs: t.averageDurationMs,
      maxDurationMs: t.maxDurationMs,
      p50DurationMs: t.p50DurationMs,
      p95DurationMs: t.p95DurationMs,
      p99DurationMs: t.p99DurationMs,
      bottleneckScore: Math.round(
        (t.averageDurationMs * Math.log10(t.callCount + 1)) * 100
      ) / 100
    })),
    topGuards: topGuards.map(g => ({
      key: g.key,
      guardExpression: g.guardExpression,
      fromStateName: g.fromStateName,
      targetStateName: g.targetStateName,
      eventName: g.eventName,
      transitionId: g.transitionId,
      callCount: g.callCount,
      passCount: g.passCount,
      sampleCount: g.sampleCount,
      averageDurationMs: g.averageDurationMs,
      maxDurationMs: g.maxDurationMs,
      p50DurationMs: g.p50DurationMs,
      p95DurationMs: g.p95DurationMs,
      p99DurationMs: g.p99DurationMs,
      bottleneckScore: Math.round(
        (g.averageDurationMs * Math.log10(g.callCount + 1)) * 100
      ) / 100
    })),
    topCompliancePolicies: topCompliancePolicies.map(p => ({
      key: p.key,
      policyId: p.policyId,
      policyName: p.policyName,
      policyType: p.policyType,
      callCount: p.callCount,
      violationCount: p.violationCount,
      sampleCount: p.sampleCount,
      averageDurationMs: p.averageDurationMs,
      maxDurationMs: p.maxDurationMs,
      p50DurationMs: p.p50DurationMs,
      p95DurationMs: p.p95DurationMs,
      p99DurationMs: p.p99DurationMs
    }))
  };
}

async function generateBottleneckDemoTraces({ force = false } = {}) {
  const existingCount = await get('SELECT COUNT(*) as cnt FROM decision_traces');
  if (!force && existingCount && existingCount.cnt >= 500) {
    console.log('[BottleneckDemo] decision_traces already has >= 500 records, skipping bulk bottleneck demo data generation.');
    return { created: 0, reason: 'existing_enough' };
  }

  const orderMachineRow = await get(
    "SELECT * FROM machines WHERE name = ? ORDER BY version DESC LIMIT 1",
    ['订单审批']
  );
  if (!orderMachineRow) {
    console.log('[BottleneckDemo] No 订单审批 machine found, skipping.');
    return { created: 0, reason: 'no_machine' };
  }

  const machine = {
    id: orderMachineRow.id,
    definition: JSON.parse(orderMachineRow.definition)
  };

  const stateMap = new Map();
  for (const s of machine.definition.states) {
    stateMap.set(s.name, s);
    stateMap.set(s.id, s);
  }

  let fromPending = machine.definition.states.find(s => s.name === '待审批');
  if (!fromPending) fromPending = machine.definition.states.find(s => s.name === '待提交');
  if (!fromPending) {
    console.log('[BottleneckDemo] No pending state found, skipping.');
    return { created: 0, reason: 'no_pending_state' };
  }

  const transitionsByEvent = new Map();
  for (const t of machine.definition.transitions) {
    if (t.sourceStateId === fromPending.id) {
      const arr = transitionsByEvent.get(t.event) || [];
      arr.push(t);
      transitionsByEvent.set(t.event, arr);
    }
  }

  const approveTransitions = transitionsByEvent.get('approve') || [];
  const rejectTransitions = transitionsByEvent.get('reject') || [];

  const mockPolicies = [
    {
      policyId: 'p_dwell',
      policyName: '待审批最短停留5秒',
      policyType: 'mandatory_dwell',
      enabled: true,
      triggeredCondition: '在状态 [待审批] 停留不足 5 秒时触发'
    },
    {
      policyId: 'p_rate',
      policyName: 'approve事件10秒内最多2次',
      policyType: 'event_rate_limit',
      enabled: true,
      triggeredCondition: '事件 [approve] 在 10 秒内超过 2 次时触发'
    },
    {
      policyId: 'p_amount',
      policyName: '大额审批复核规则',
      policyType: 'custom',
      enabled: true,
      triggeredCondition: '金额 > 10000 时触发额外复核'
    }
  ];

  const nowTs = Date.now();
  const startTime = nowTs - 7 * 24 * 60 * 60 * 1000;
  const totalTraceCount = 800;
  let createdCount = 0;
  const v4 = require('uuid').v4;

  const demoInstanceIds = [];
  for (let k = 0; k < 50; k++) {
    demoInstanceIds.push('bottleneck_demo_' + k);
    try {
      const existing = await get("SELECT id FROM instances WHERE id = ?", [demoInstanceIds[k]]);
      if (!existing) {
        await run(
          "INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final, entered_state_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
          [demoInstanceIds[k], machine.id, fromPending.id, JSON.stringify({ orderId: 'BN-DEMO-' + k, amount: 1000 + k * 100 }), new Date(startTime + k*1000).toISOString(), new Date(startTime + k*1000).toISOString()]
        );
      }
    } catch (e) {
      // ignore insert errors (duplicates etc.)
    }
  }

  function randNormal(mean, std) {
    const u1 = Math.random() || 0.0001;
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * std;
  }

  const bottleneckTransitionIds = new Set();
  const bottleneckGuardKeys = new Map();
  const amountGuardTrans = approveTransitions.find(t => t.guard && t.guard.includes('payload.amount >'));
  const smallGuardTrans = approveTransitions.find(t => t.guard && t.guard.includes('payload.amount <='));
  if (amountGuardTrans) bottleneckTransitionIds.add(amountGuardTrans.id);
  if (smallGuardTrans) bottleneckGuardKeys.set('small_' + smallGuardTrans.id, { heavy: false });
  if (amountGuardTrans) bottleneckGuardKeys.set('heavy_' + amountGuardTrans.id, { heavy: true });

  for (let i = 0; i < totalTraceCount; i++) {
    const traceTs = startTime + Math.floor(Math.random() * (nowTs - startTime));
    const rand = Math.random();

    let eventName, outgoing, payload, pickedTransitionIndex;

    if (rand < 0.75) {
      eventName = 'approve';
      outgoing = approveTransitions;
      const amountRand = Math.random();
      if (amountRand < 0.6) {
        payload = { amount: Math.floor(Math.random() * 4500) + 100, approvedBy: 'manager_' + (i % 5) };
        if (smallGuardTrans) pickedTransitionIndex = outgoing.indexOf(smallGuardTrans);
      } else {
        payload = { amount: Math.floor(Math.random() * 20000) + 5500, approvedBy: 'manager_' + (i % 5) };
        if (amountGuardTrans) pickedTransitionIndex = outgoing.indexOf(amountGuardTrans);
      }
    } else if (rand < 0.92) {
      eventName = 'reject';
      outgoing = rejectTransitions;
      payload = { reason: ['资料不全', '预算不足', '不符合政策', '风险过高', '重复申请'][i % 5] };
    } else {
      eventName = 'timeout_reject';
      outgoing = transitionsByEvent.get('timeout_reject') || rejectTransitions;
      payload = { reason: '审批超时自动拒绝', auto: true };
    }

    if (!outgoing || outgoing.length === 0) continue;
    if (pickedTransitionIndex === undefined || pickedTransitionIndex < 0) pickedTransitionIndex = 0;

    const candidates = [];
    let candidateMatchingDuration = 0;
    for (let j = 0; j < outgoing.length; j++) {
      const t = outgoing[j];
      const isPicked = j === pickedTransitionIndex;
      const tgt = stateMap.get(t.targetStateId);
      const tgtName = tgt ? tgt.name : t.targetStateId;
      const guardExpr = t.guard || '';
      let guardResult = false;
      let guardInput = null;
      let guardDurationMs = 0;

      if (!guardExpr.trim()) {
        guardResult = true;
        guardDurationMs = Math.max(0, Math.round(randNormal(0.5, 0.2)));
      } else {
        guardInput = { payload, context: {} };
        try {
          guardResult = evaluateGuard(guardExpr, payload, {});
        } catch (e) {
          guardResult = false;
        }
        const isHeavyGuard = bottleneckTransitionIds.has(t.id);
        if (isHeavyGuard) {
          guardDurationMs = Math.max(1, Math.round(randNormal(18, 8)));
          if (Math.random() < 0.05) guardDurationMs += 40 + Math.floor(Math.random() * 30);
        } else if (smallGuardTrans && t.id === smallGuardTrans.id) {
          guardDurationMs = Math.max(0, Math.round(randNormal(2, 1)));
        } else {
          guardDurationMs = Math.max(0, Math.round(randNormal(1, 0.5)));
        }
      }

      candidates.push({
        transitionId: t.id,
        targetStateId: t.targetStateId,
        targetStateName: tgtName,
        guardExpression: guardExpr || '(无守卫)',
        guardInput,
        guardResult,
        guardError: null,
        guardDurationMs,
        passed: guardResult,
        selected: isPicked
      });
      candidateMatchingDuration += guardDurationMs;
    }

    const isHeavyMatch = candidates.some(c => bottleneckTransitionIds.has(c.transitionId) && c.selected);
    if (isHeavyMatch) {
      candidateMatchingDuration += Math.round(randNormal(15, 6));
    } else {
      candidateMatchingDuration += Math.max(1, Math.round(randNormal(3, 1)));
    }

    const selectedCandidate = candidates.find(c => c.selected);
    const decisionAccepted = selectedCandidate && selectedCandidate.passed;
    const targetState = selectedCandidate ? stateMap.get(selectedCandidate.targetStateId) : null;

    const phases = [
      {
        phase: 'candidate_matching',
        durationMs: Math.max(1, candidateMatchingDuration),
        fromStateId: fromPending.id,
        fromStateName: fromPending.name,
        eventName,
        candidateCount: outgoing.length,
        candidates
      }
    ];

    let complianceAllowed = true;
    const policyResults = [];
    let complianceDuration = 0;
    const policiesToUse = decisionAccepted && eventName === 'approve' ? mockPolicies : mockPolicies.slice(0, 2);

    for (let pIdx = 0; pIdx < policiesToUse.length; pIdx++) {
      const p = policiesToUse[pIdx];
      let pDuration;
      let pResult = 'pass';
      let pReason = null;
      let pDetail = null;

      if (p.policyType === 'mandatory_dwell') {
        const elapsed = Math.random() * 30;
        if (elapsed < 5 && Math.random() < 0.15) {
          pResult = 'violation';
          pReason = `状态 [待审批] 最短停留 5s, 当前仅停留 ${elapsed.toFixed(1)}s`;
          pDetail = { stateName: '待审批', minSeconds: 5, elapsedSeconds: elapsed, remaining: (5 - elapsed).toFixed(1) };
        }
        pDuration = Math.max(1, Math.round(randNormal(4, 1.5)));
      } else if (p.policyType === 'event_rate_limit') {
        if (Math.random() < 0.08) {
          pResult = 'violation';
          pReason = `事件 [approve] 10秒内超过 2 次频率限制`;
          pDetail = { windowSeconds: 10, maxCount: 2, actualCount: 3 };
        }
        pDuration = Math.max(1, Math.round(randNormal(3, 1)));
      } else if (p.policyType === 'custom') {
        pDuration = Math.max(2, Math.round(randNormal(22, 10)));
        if (Math.random() < 0.1) pDuration += 30 + Math.floor(Math.random() * 60);
        if (payload.amount && payload.amount > 15000 && Math.random() < 0.1) {
          pResult = 'violation';
          pReason = `大额订单 (¥${payload.amount}) 需要总监复核`;
          pDetail = { amount: payload.amount, requiredRole: 'director' };
        }
      } else {
        pDuration = Math.max(1, Math.round(randNormal(2, 1)));
      }

      if (pResult === 'violation') complianceAllowed = false;
      complianceDuration += pDuration;
      policyResults.push({
        policyId: p.policyId,
        policyName: p.policyName,
        policyType: p.policyType,
        enabled: true,
        result: pResult,
        reason: pReason,
        detail: pDetail,
        triggeredCondition: p.triggeredCondition,
        durationMs: pDuration
      });
    }

    if (complianceDuration > 0 && decisionAccepted) {
      phases.push({
        phase: 'compliance_check',
        durationMs: complianceDuration,
        transitionId: selectedCandidate ? selectedCandidate.transitionId : null,
        targetStateId: targetState ? targetState.id : null,
        targetStateName: targetState ? targetState.name : null,
        allowed: complianceAllowed,
        policyCount: policyResults.length,
        policies: policyResults
      });
    }

    const totalDurationMs = phases.reduce((s, p) => s + p.durationMs, 0);

    let finalResult, finalTargetId, finalTargetName, rejectionReason;
    if (!decisionAccepted) {
      finalResult = 'rejected_no_match';
      finalTargetId = null;
      finalTargetName = null;
      rejectionReason = `事件 [${eventName}] 的 ${outgoing.length} 条候选转换守卫均不通过`;
    } else if (!complianceAllowed) {
      finalResult = 'rejected_compliance';
      finalTargetId = targetState ? targetState.id : null;
      finalTargetName = targetState ? targetState.name : null;
      const violations = policyResults.filter(v => v.result === 'violation');
      rejectionReason = '合规引擎拦截: ' + violations.map(v => `[${v.policyName}] ${v.reason}`).join('; ');
    } else {
      finalResult = 'accepted';
      finalTargetId = targetState ? targetState.id : null;
      finalTargetName = targetState ? targetState.name : null;
      rejectionReason = null;
    }

    const decisionTree = {
      eventName,
      fromStateId: fromPending.id,
      fromStateName: fromPending.name,
      targetStateId: finalTargetId,
      targetStateName: finalTargetName,
      triggeredBy: Math.random() < 0.2 ? 'system' : 'user',
      phases,
      summary: {
        candidateCount: outgoing.length,
        guardPassCount: candidates.filter(c => c.passed).length,
        complianceChecked: !!(decisionAccepted && complianceDuration > 0),
        compliancePass: complianceAllowed,
        complianceViolationCount: policyResults.filter(p => p.result === 'violation').length
      }
    };

    try {
      await saveTrace({
        id: v4(),
        instanceId: 'bottleneck_demo_' + (i % 50),
        machineId: machine.id,
        transitionId: finalResult === 'accepted' ? v4() : null,
        eventName,
        fromStateId: fromPending.id,
        targetStateId: finalTargetId,
        decisionResult: finalResult,
        rejectionReason,
        decisionTree,
        totalDurationMs,
        createdAt: new Date(traceTs).toISOString()
      });
      createdCount++;
    } catch (e) {
      console.error('[BottleneckDemo] Failed to save trace #' + i + ':', e.message);
    }

    if ((i + 1) % 200 === 0) {
      console.log(`[BottleneckDemo] Progress: ${i + 1}/${totalTraceCount} traces generated...`);
      await new Promise(r => setTimeout(r, 10));
    }
  }

  console.log(`[BottleneckDemo] Bulk bottleneck demo data done: ${createdCount} traces created.`);
  return { created: createdCount, reason: 'ok' };
}

module.exports = {
  initTraceDB,
  saveTrace,
  getTraceById,
  queryTraces,
  getTracesByInstanceId,
  countTraces,
  buildAndSaveTrace,
  linkTraceToTransition,
  compareTraces,
  getBottleneckStats,
  generateBottleneckDemoTraces
};
