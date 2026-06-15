const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');

const POLICY_TYPES = Object.freeze({
  FORBIDDEN_SEQUENCE: 'forbidden_sequence',
  MANDATORY_DWELL: 'mandatory_dwell',
  EVENT_RATE_LIMIT: 'event_rate_limit'
});

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    throw new Error('Policy must be an object');
  }
  if (!policy.machineId) {
    throw new Error('Policy machineId is required');
  }
  if (!policy.type || !Object.values(POLICY_TYPES).includes(policy.type)) {
    throw new Error(`Invalid policy type. Must be one of: ${Object.values(POLICY_TYPES).join(', ')}`);
  }
  if (!policy.name || typeof policy.name !== 'string' || !policy.name.trim()) {
    throw new Error('Policy name is required');
  }
  const config = policy.config || {};
  switch (policy.type) {
    case POLICY_TYPES.FORBIDDEN_SEQUENCE:
      if (!Array.isArray(config.sequence) || config.sequence.length < 2) {
        throw new Error('forbidden_sequence requires config.sequence array with at least 2 state names');
      }
      break;
    case POLICY_TYPES.MANDATORY_DWELL:
      if (!config.stateName || typeof config.stateName !== 'string') {
        throw new Error('mandatory_dwell requires config.stateName');
      }
      if (typeof config.minSeconds !== 'number' || config.minSeconds < 0) {
        throw new Error('mandatory_dwell requires config.minSeconds (non-negative number)');
      }
      break;
    case POLICY_TYPES.EVENT_RATE_LIMIT:
      if (!config.eventName || typeof config.eventName !== 'string') {
        throw new Error('event_rate_limit requires config.eventName');
      }
      if (typeof config.windowSeconds !== 'number' || config.windowSeconds <= 0) {
        throw new Error('event_rate_limit requires config.windowSeconds (positive number)');
      }
      if (typeof config.maxCount !== 'number' || config.maxCount < 1 || !Number.isInteger(config.maxCount)) {
        throw new Error('event_rate_limit requires config.maxCount (positive integer)');
      }
      break;
  }
  return true;
}

async function addPolicy(policy) {
  validatePolicy(policy);
  const id = policy.id || uuidv4();
  const now = new Date().toISOString();
  const configJson = JSON.stringify(policy.config || {});
  await run(
    'INSERT INTO compliance_policies (id, machine_id, name, description, type, config_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      policy.machineId,
      policy.name.trim(),
      policy.description || '',
      policy.type,
      configJson,
      policy.enabled !== false ? 1 : 0,
      now
    ]
  );
  return getPolicyById(id);
}

async function updatePolicy(id, updates) {
  const existing = await getPolicyById(id);
  if (!existing) {
    throw new Error('Policy not found');
  }
  const merged = {
    ...existing,
    ...updates,
    config: { ...existing.config, ...(updates.config || {}) }
  };
  validatePolicy(merged);
  const fields = [];
  const params = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name.trim());
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    params.push(updates.description || '');
  }
  if (updates.config !== undefined) {
    fields.push('config_json = ?');
    params.push(JSON.stringify(merged.config));
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(updates.enabled ? 1 : 0);
  }
  if (fields.length === 0) {
    return existing;
  }
  params.push(id);
  await run(`UPDATE compliance_policies SET ${fields.join(', ')} WHERE id = ?`, params);
  return getPolicyById(id);
}

async function deletePolicy(id) {
  const result = await run('DELETE FROM compliance_policies WHERE id = ?', [id]);
  return result.changes > 0;
}

async function getPolicyById(id) {
  const row = await get('SELECT * FROM compliance_policies WHERE id = ?', [id]);
  return row ? rowToPolicy(row) : null;
}

async function getPoliciesByMachineId(machineId, { includeDisabled = false } = {}) {
  let sql = 'SELECT * FROM compliance_policies WHERE machine_id = ?';
  const params = [machineId];
  if (!includeDisabled) {
    sql += ' AND enabled = 1';
  }
  sql += ' ORDER BY created_at ASC';
  const rows = await all(sql, params);
  return rows.map(rowToPolicy);
}

function rowToPolicy(row) {
  return {
    id: row.id,
    machineId: row.machine_id,
    name: row.name,
    description: row.description || '',
    type: row.type,
    config: JSON.parse(row.config_json || '{}'),
    enabled: !!row.enabled,
    createdAt: row.created_at
  };
}

function buildStateNameMap(machineDefinition) {
  const map = new Map();
  if (machineDefinition && machineDefinition.states) {
    for (const s of machineDefinition.states) {
      map.set(s.id, s.name);
      map.set(s.name, s.id);
    }
  }
  return map;
}

async function recordViolation({ policyId, machineId, instanceId, eventName, fromStateId, toStateId, reason, payloadSnapshot, attemptedAt, detectedDuring = 'runtime' }) {
  const id = uuidv4();
  const now = attemptedAt || new Date().toISOString();
  await run(
    'INSERT INTO compliance_violations (id, policy_id, machine_id, instance_id, event_name, from_state_id, to_state_id, reason, payload_snapshot, attempted_at, detected_during) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      policyId || null,
      machineId,
      instanceId || null,
      eventName || null,
      fromStateId || null,
      toStateId || null,
      reason || '',
      payloadSnapshot ? JSON.stringify(payloadSnapshot) : null,
      now,
      detectedDuring
    ]
  );
  return id;
}

async function getViolations(filters = {}) {
  let sql = 'SELECT * FROM compliance_violations WHERE 1=1';
  const params = [];
  if (filters.machineId) {
    sql += ' AND machine_id = ?';
    params.push(filters.machineId);
  }
  if (filters.instanceId) {
    sql += ' AND instance_id = ?';
    params.push(filters.instanceId);
  }
  if (filters.policyId) {
    sql += ' AND policy_id = ?';
    params.push(filters.policyId);
  }
  if (filters.detectedDuring) {
    sql += ' AND detected_during = ?';
    params.push(filters.detectedDuring);
  }
  sql += ' ORDER BY attempted_at DESC';
  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    policyId: r.policy_id,
    machineId: r.machine_id,
    instanceId: r.instance_id,
    eventName: r.event_name,
    fromStateId: r.from_state_id,
    toStateId: r.to_state_id,
    reason: r.reason,
    payloadSnapshot: r.payload_snapshot ? JSON.parse(r.payload_snapshot) : null,
    attemptedAt: r.attempted_at,
    detectedDuring: r.detected_during
  }));
}

function checkForbiddenSequence(policy, context) {
  const { sequence } = policy.config;
  const { stateNameMap, history, currentStateId, targetStateId } = context;
  if (!stateNameMap || !sequence || sequence.length < 2) return null;
  const currentName = currentStateId ? stateNameMap.get(currentStateId) : null;
  const targetName = targetStateId ? stateNameMap.get(targetStateId) : null;
  const historyNames = [];
  if (history && history.length > 0) {
    const firstFromName = history[0].fromStateId ? stateNameMap.get(history[0].fromStateId) : null;
    if (firstFromName) historyNames.push(firstFromName);
    for (const h of history) {
      const name = h.toStateId ? stateNameMap.get(h.toStateId) : null;
      if (name) historyNames.push(name);
    }
  }
  if (currentName && historyNames[historyNames.length - 1] !== currentName) {
    historyNames.push(currentName);
  }
  if (!targetName) return null;
  const projected = [...historyNames, targetName];
  const seqLen = sequence.length;
  if (projected.length < seqLen) return null;
  const tail = projected.slice(-seqLen);
  let matches = true;
  for (let i = 0; i < seqLen; i++) {
    if (tail[i] !== sequence[i]) {
      matches = false;
      break;
    }
  }
  if (matches) {
    return {
      policyId: policy.id,
      policyType: policy.type,
      policyName: policy.name,
      reason: `禁止序列 [${sequence.join(' → ')}] 即将形成 (当前轨迹末尾: ${tail.join(' → ')})`,
      detail: { sequence, tail }
    };
  }
  return null;
}

function checkMandatoryDwell(policy, context) {
  const { stateName, minSeconds } = policy.config;
  const { stateNameMap, currentStateId, enteredStateAt, eventTimestamp } = context;
  if (!stateNameMap || !currentStateId || !enteredStateAt) return null;
  const currentName = stateNameMap.get(currentStateId);
  if (currentName !== stateName) return null;
  const enteredTime = new Date(enteredStateAt).getTime();
  const nowTime = eventTimestamp ? new Date(eventTimestamp).getTime() : Date.now();
  const elapsedSeconds = (nowTime - enteredTime) / 1000;
  if (elapsedSeconds < minSeconds) {
    const remaining = Math.round((minSeconds - elapsedSeconds) * 10) / 10;
    return {
      policyId: policy.id,
      policyType: policy.type,
      policyName: policy.name,
      reason: `状态 [${stateName}] 最短停留 ${minSeconds}s, 当前仅停留 ${Math.round(elapsedSeconds * 10) / 10}s (还需 ${remaining}s)`,
      detail: { stateName, minSeconds, elapsedSeconds, remaining }
    };
  }
  return null;
}

function checkEventRateLimit(policy, context) {
  const { eventName, windowSeconds, maxCount } = policy.config;
  const { history, event, eventTimestamp } = context;
  if (!event || event !== eventName) return null;
  const nowTime = eventTimestamp ? new Date(eventTimestamp).getTime() : Date.now();
  const windowStart = nowTime - windowSeconds * 1000;
  let count = 0;
  if (history) {
    for (const h of history) {
      if (h.event === eventName && h.createdAt) {
        const t = new Date(h.createdAt).getTime();
        if (t >= windowStart && t <= nowTime) {
          count++;
        }
      }
    }
  }
  const projectedCount = count + 1;
  if (projectedCount > maxCount) {
    return {
      policyId: policy.id,
      policyType: policy.type,
      policyName: policy.name,
      reason: `事件 [${eventName}] 在 ${windowSeconds}s 窗口内最多允许 ${maxCount} 次, 当前窗口已 ${count} 次, 本次将达 ${projectedCount} 次`,
      detail: { eventName, windowSeconds, maxCount, currentWindowCount: count, projectedCount }
    };
  }
  return null;
}

function evaluatePolicies(policies, context) {
  const violations = [];
  if (!Array.isArray(policies)) return violations;
  for (const policy of policies) {
    if (!policy.enabled) continue;
    let result = null;
    try {
      switch (policy.type) {
        case POLICY_TYPES.FORBIDDEN_SEQUENCE:
          result = checkForbiddenSequence(policy, context);
          break;
        case POLICY_TYPES.MANDATORY_DWELL:
          result = checkMandatoryDwell(policy, context);
          break;
        case POLICY_TYPES.EVENT_RATE_LIMIT:
          result = checkEventRateLimit(policy, context);
          break;
      }
    } catch (e) {
      console.error(`[Compliance] Policy ${policy.id} (${policy.name}) evaluation error:`, e);
    }
    if (result) {
      violations.push(result);
    }
  }
  return violations;
}

async function checkTransitionCompliance({ machineId, machineDefinition, instanceId, currentStateId, targetStateId, event, payload, history, enteredStateAt, eventTimestamp, recordViolations: shouldRecord = true }) {
  const policies = await getPoliciesByMachineId(machineId);
  if (policies.length === 0) {
    return { allowed: true, violations: [] };
  }
  const stateNameMap = buildStateNameMap(machineDefinition);
  const context = {
    stateNameMap,
    history,
    currentStateId,
    targetStateId,
    event,
    payload,
    enteredStateAt,
    eventTimestamp: eventTimestamp || new Date().toISOString()
  };
  const violations = evaluatePolicies(policies, context);
  if (shouldRecord && violations.length > 0) {
    for (const v of violations) {
      try {
        await recordViolation({
          policyId: v.policyId,
          machineId,
          instanceId,
          eventName: event,
          fromStateId: currentStateId,
          toStateId: targetStateId,
          reason: v.reason,
          payloadSnapshot: payload,
          attemptedAt: context.eventTimestamp,
          detectedDuring: 'runtime'
        });
      } catch (e) {
        console.error('[Compliance] Failed to record violation:', e);
      }
    }
  }
  return {
    allowed: violations.length === 0,
    violations
  };
}

async function auditInstanceHistory({ instanceId, machineId, machineDefinition, fullHistory, initialStateId, initialEnteredAt, instanceCreatedAt, policiesOverride }) {
  const policies = policiesOverride || (await getPoliciesByMachineId(machineId));
  const auditResults = [];
  if (policies.length === 0) {
    return { audited: false, policiesCount: 0, violations: [] };
  }
  const stateNameMap = buildStateNameMap(machineDefinition);
  const historyTimeline = [];
  let currentStateId = initialStateId;
  let enteredStateAt = initialEnteredAt || instanceCreatedAt;
  if (fullHistory && fullHistory.length > 0) {
    for (const h of fullHistory) {
      historyTimeline.push({
        type: 'transition',
        event: h.event,
        fromStateId: h.fromStateId,
        toStateId: h.toStateId,
        payload: h.payload,
        timestamp: h.createdAt
      });
    }
  }
  for (let i = 0; i < historyTimeline.length; i++) {
    const step = historyTimeline[i];
    const transitionHistory = fullHistory.slice(0, i);
    const context = {
      stateNameMap,
      history: transitionHistory,
      currentStateId,
      targetStateId: step.toStateId,
      event: step.event,
      payload: step.payload,
      enteredStateAt,
      eventTimestamp: step.timestamp
    };
    const violations = evaluatePolicies(policies, context);
    for (const v of violations) {
      auditResults.push({
        ...v,
        instanceId,
        machineId,
        eventName: step.event,
        fromStateId: currentStateId,
        toStateId: step.toStateId,
        attemptedAt: step.timestamp,
        transitionIndex: i,
        detectedDuring: 'audit',
        detail: v.detail
      });
      try {
        await recordViolation({
          policyId: v.policyId,
          machineId,
          instanceId,
          eventName: step.event,
          fromStateId: currentStateId,
          toStateId: step.toStateId,
          reason: v.reason,
          payloadSnapshot: step.payload,
          attemptedAt: step.timestamp,
          detectedDuring: 'audit'
        });
      } catch (e) {
        console.error('[Compliance Audit] Failed to record audit violation:', e);
      }
    }
    currentStateId = step.toStateId;
    enteredStateAt = step.timestamp;
  }
  return {
    audited: true,
    policiesCount: policies.length,
    transitionsScanned: historyTimeline.length,
    violations: auditResults
  };
}

async function auditCompletedInstances(machineId, { machineDefinition, policiesOverride } = {}) {
  const instances = await all(
    'SELECT * FROM instances WHERE machine_id = ? AND is_final = 1 ORDER BY created_at ASC',
    [machineId]
  );
  if (instances.length === 0) {
    return { totalInstances: 0, scannedInstances: 0, totalViolations: 0, byInstance: {} };
  }
  let def = machineDefinition;
  if (!def) {
    const mRow = await get('SELECT definition FROM machines WHERE id = ?', [machineId]);
    if (!mRow) {
      throw new Error('Machine not found');
    }
    def = JSON.parse(mRow.definition);
  }
  const initialState = def.states.find(s => s.isInitial);
  const results = {};
  let totalViolations = 0;
  let scannedInstances = 0;
  for (const inst of instances) {
    const histRows = await all(
      'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
      [inst.id]
    );
    const history = histRows.map(h => ({
      id: h.id,
      event: h.event_name,
      fromStateId: h.from_state_id,
      toStateId: h.to_state_id,
      payload: h.payload_snapshot ? JSON.parse(h.payload_snapshot) : null,
      createdAt: h.created_at
    }));
    const r = await auditInstanceHistory({
      instanceId: inst.id,
      machineId,
      machineDefinition: def,
      fullHistory: history,
      initialStateId: initialState ? initialState.id : null,
      initialEnteredAt: inst.created_at,
      instanceCreatedAt: inst.created_at,
      policiesOverride
    });
    scannedInstances++;
    totalViolations += r.violations.length;
    results[inst.id] = {
      instanceId: inst.id,
      createdAt: inst.created_at,
      transitionsScanned: r.transitionsScanned || 0,
      violations: r.violations
    };
  }
  return {
    totalInstances: instances.length,
    scannedInstances,
    totalViolations,
    byInstance: results
  };
}

function getTriggeredCondition(policy) {
  const config = policy.config || {};
  switch (policy.type) {
    case POLICY_TYPES.FORBIDDEN_SEQUENCE:
      return `状态序列 [${(config.sequence || []).join(' → ')}] 出现时触发`;
    case POLICY_TYPES.MANDATORY_DWELL:
      return `在状态 [${config.stateName || ''}] 停留不足 ${config.minSeconds || 0} 秒时触发`;
    case POLICY_TYPES.EVENT_RATE_LIMIT:
      return `事件 [${config.eventName || ''}] 在 ${config.windowSeconds || 0} 秒内超过 ${config.maxCount || 0} 次时触发`;
    default:
      return null;
  }
}

function evaluatePoliciesDetailed(policies, context) {
  const results = [];
  if (!Array.isArray(policies)) return results;
  for (const policy of policies) {
    if (!policy.enabled) {
      results.push({
        policyId: policy.id,
        policyName: policy.name,
        policyType: policy.type,
        enabled: false,
        result: 'skipped',
        reason: null,
        detail: null,
        triggeredCondition: null,
        durationMs: 0
      });
      continue;
    }
    const start = Date.now();
    let violation = null;
    try {
      switch (policy.type) {
        case POLICY_TYPES.FORBIDDEN_SEQUENCE:
          violation = checkForbiddenSequence(policy, context);
          break;
        case POLICY_TYPES.MANDATORY_DWELL:
          violation = checkMandatoryDwell(policy, context);
          break;
        case POLICY_TYPES.EVENT_RATE_LIMIT:
          violation = checkEventRateLimit(policy, context);
          break;
      }
    } catch (e) {
      results.push({
        policyId: policy.id,
        policyName: policy.name,
        policyType: policy.type,
        enabled: true,
        result: 'error',
        reason: e.message,
        detail: null,
        triggeredCondition: getTriggeredCondition(policy),
        durationMs: Date.now() - start
      });
      continue;
    }
    if (violation) {
      results.push({
        policyId: policy.id,
        policyName: policy.name,
        policyType: policy.type,
        enabled: true,
        result: 'violation',
        reason: violation.reason,
        detail: violation.detail,
        triggeredCondition: getTriggeredCondition(policy),
        durationMs: Date.now() - start
      });
    } else {
      results.push({
        policyId: policy.id,
        policyName: policy.name,
        policyType: policy.type,
        enabled: true,
        result: 'pass',
        reason: null,
        detail: null,
        triggeredCondition: getTriggeredCondition(policy),
        durationMs: Date.now() - start
      });
    }
  }
  return results;
}

module.exports = {
  POLICY_TYPES,
  validatePolicy,
  addPolicy,
  updatePolicy,
  deletePolicy,
  getPolicyById,
  getPoliciesByMachineId,
  recordViolation,
  getViolations,
  checkTransitionCompliance,
  auditInstanceHistory,
  auditCompletedInstances,
  evaluatePolicies,
  evaluatePoliciesDetailed,
  checkForbiddenSequence,
  checkMandatoryDwell,
  checkEventRateLimit,
  buildStateNameMap,
  getTriggeredCondition
};
