const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { evaluateGuard } = require('./guard');
const { isInstanceFrozen, freezeInstance, unfreezeInstance, enqueueEvent } = require('./takeover-engine');
const { recordStateDuration, checkTransitionCompliance } = require('./metrics');

const BATCH_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed'
});

const RESULT_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped'
});

const OPERATION_TYPE = Object.freeze({
  SEND_EVENT: 'send_event',
  FREEZE: 'freeze',
  UNFREEZE: 'unfreeze'
});

async function addTagsToInstance(instanceId, tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return { success: true, added: 0 };
  }

  const existingTags = await getInstanceTags(instanceId);
  const existingSet = new Set(existingTags);
  const newTags = tags.filter(t => !existingSet.has(t) && t.trim() !== '');

  if (newTags.length === 0) {
    return { success: true, added: 0 };
  }

  const now = new Date().toISOString();
  for (const tag of newTags) {
    await run(
      'INSERT INTO instance_tags (id, instance_id, tag, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), instanceId, tag.trim(), now]
    );
  }

  return { success: true, added: newTags.length };
}

async function removeTagsFromInstance(instanceId, tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return { success: true, removed: 0 };
  }

  const placeholders = tags.map(() => '?').join(',');
  const result = await run(
    `DELETE FROM instance_tags WHERE instance_id = ? AND tag IN (${placeholders})`,
    [instanceId, ...tags]
  );

  return { success: true, removed: result.changes || 0 };
}

async function getInstanceTags(instanceId) {
  const rows = await all(
    'SELECT tag FROM instance_tags WHERE instance_id = ? ORDER BY tag',
    [instanceId]
  );
  return rows.map(r => r.tag);
}

async function getAllTags(machineId = null) {
  let sql = 'SELECT DISTINCT tag FROM instance_tags';
  const params = [];
  if (machineId) {
    sql += ' WHERE instance_id IN (SELECT id FROM instances WHERE machine_id = ?)';
    params.push(machineId);
  }
  sql += ' ORDER BY tag';
  const rows = await all(sql, params);
  return rows.map(r => r.tag);
}

async function findInstancesByTags(tags, machineId = null) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return [];
  }

  const tagPlaceholders = tags.map(() => '?').join(',');
  let sql = `
    SELECT i.* FROM instances i
    INNER JOIN instance_tags it ON i.id = it.instance_id
    WHERE it.tag IN (${tagPlaceholders})
  `;
  const params = [...tags];

  if (machineId) {
    sql += ' AND i.machine_id = ?';
    params.push(machineId);
  }

  sql += `
    GROUP BY i.id
    HAVING COUNT(DISTINCT it.tag) = ?
    ORDER BY i.created_at DESC
  `;
  params.push(tags.length);

  return await all(sql, params);
}

async function createBatchOperation({ operationType, targetTags, eventName, eventPayload, operatorId, operatorName }) {
  const id = uuidv4();
  const now = new Date().toISOString();

  await run(
    `INSERT INTO batch_operations 
     (id, operation_type, target_tags_json, event_name, event_payload, 
      operator_id, operator_name, created_at, status) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      operationType,
      JSON.stringify(targetTags),
      eventName || null,
      eventPayload ? JSON.stringify(eventPayload) : null,
      operatorId,
      operatorName,
      now,
      BATCH_STATUS.RUNNING
    ]
  );

  return { id, createdAt: now };
}

async function addBatchResult(batchOperationId, instanceId, status, resultMessage) {
  const id = uuidv4();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO batch_operation_results 
     (id, batch_operation_id, instance_id, status, result_message, executed_at) 
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, batchOperationId, instanceId, status, resultMessage, now]
  );
  return { id, executedAt: now };
}

async function updateBatchStats(batchOperationId, totalCount, successCount, failedCount, skippedCount) {
  await run(
    `UPDATE batch_operations 
     SET total_count = ?, success_count = ?, failed_count = ?, skipped_count = ?, status = ?
     WHERE id = ?`,
    [totalCount, successCount, failedCount, skippedCount, BATCH_STATUS.COMPLETED, batchOperationId]
  );
}

async function checkEventApplicable(instance, machine, eventName, payload) {
  if (instance.is_final) {
    return { applicable: false, reason: 'Instance is in final state' };
  }

  const currentStateId = instance.current_state_id;
  const outgoing = machine.definition.transitions.filter(
    t => t.sourceStateId === currentStateId && t.event === eventName
  );

  if (outgoing.length === 0) {
    return { applicable: false, reason: `No outgoing transition for event '${eventName}' from current state` };
  }

  const context = JSON.parse(instance.context_data);
  for (const t of outgoing) {
    try {
      if (evaluateGuard(t.guard, payload || {}, context)) {
        return { applicable: true, transition: t };
      }
    } catch (e) {
      console.error('Guard evaluation error:', e);
    }
  }

  return { applicable: false, reason: `No transition with passing guard for event '${eventName}'` };
}

async function executeSendEvent(instance, machine, eventName, payload, operatorId) {
  const getMachineById = require('./version-migration').getMachineById;
  const machineDef = machine || await getMachineById(instance.machine_id);

  if (!machineDef) {
    return { success: false, message: 'Machine not found' };
  }

  const applicability = await checkEventApplicable(instance, machineDef, eventName, payload);
  if (!applicability.applicable) {
    return { success: false, skipped: true, message: applicability.reason };
  }

  const frozen = await isInstanceFrozen(instance.id);
  if (frozen) {
    const queued = await enqueueEvent(instance.id, eventName, payload, operatorId);
    return { success: true, message: 'Instance frozen, event queued', queued: true };
  }

  const context = JSON.parse(instance.context_data);
  const currentStateId = instance.current_state_id;
  const transition = applicability.transition;
  const targetState = machineDef.definition.states.find(s => s.id === transition.targetStateId);

  if (!targetState) {
    return { success: false, message: 'Target state not found' };
  }

  const historyRows = await all(
    'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
    [instance.id]
  );
  const history = historyRows.map(h => ({
    id: h.id,
    event: h.event_name,
    fromStateId: h.from_state_id,
    toStateId: h.to_state_id,
    payload: h.payload_snapshot ? JSON.parse(h.payload_snapshot) : null,
    createdAt: h.created_at
  }));

  const complianceCheck = await checkTransitionCompliance({
    machineId: machineDef.id,
    machineDefinition: machineDef.definition,
    instanceId: instance.id,
    currentStateId,
    targetStateId: targetState.id,
    event: eventName,
    payload: payload || {},
    history,
    enteredStateAt: instance.entered_state_at || instance.created_at
  });

  if (!complianceCheck.allowed) {
    return { success: false, message: 'Compliance check failed', violations: complianceCheck.violations };
  }

  const transitionId = uuidv4();
  const now = new Date().toISOString();
  const isFinal = targetState.isFinal ? 1 : 0;

  await run(
    'UPDATE instances SET current_state_id = ?, is_final = ?, entered_state_at = ? WHERE id = ?',
    [targetState.id, isFinal, now, instance.id]
  );

  await run(
    'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [transitionId, instance.id, currentStateId, targetState.id, eventName, JSON.stringify(payload || {}), now, 'batch']
  );

  await recordStateDuration(instance.id, instance.machine_id, currentStateId, instance.entered_state_at || instance.created_at, now);
  if (targetState.isFinal) {
    await recordStateDuration(instance.id, instance.machine_id, targetState.id, now, now);
  }

  const clearInstanceTimeout = require('./timeout-manager').clearInstanceTimeout;
  const scheduleTimeout = require('./timeout-manager').scheduleTimeout;
  clearInstanceTimeout(instance.id);
  if (!targetState.isFinal && targetState.timeout) {
    scheduleTimeout(instance.id, targetState.timeout, now);
  }

  return {
    success: true,
    message: `Transitioned to state '${targetState.name || targetState.id}'`,
    transitionId,
    fromStateId: currentStateId,
    toStateId: targetState.id
  };
}

async function executeFreeze(instance, operatorId, operatorName) {
  const frozen = await isInstanceFrozen(instance.id);
  if (frozen) {
    return { success: false, skipped: true, message: 'Instance already frozen' };
  }

  if (instance.is_final) {
    return { success: false, skipped: true, message: 'Instance is in final state' };
  }

  const result = await freezeInstance(instance.id, operatorId, operatorName, 'Batch freeze operation');
  return { success: true, message: 'Instance frozen' };
}

async function executeUnfreeze(instance, operatorId, operatorName) {
  const frozen = await isInstanceFrozen(instance.id);
  if (!frozen) {
    return { success: false, skipped: true, message: 'Instance not frozen' };
  }

  const result = await unfreezeInstance(instance.id, operatorId, operatorName);
  if (result.success) {
    return { success: true, message: 'Instance unfrozen' };
  }
  return { success: false, message: 'Failed to unfreeze' };
}

async function executeBatchOperation({ operationType, targetTags, eventName, eventPayload, operatorId, operatorName, machineId }) {
  const instances = await findInstancesByTags(targetTags, machineId);
  const getMachineById = require('./version-migration').getMachineById;

  if (instances.length === 0) {
    return { success: false, message: 'No instances found matching the specified tags' };
  }

  const { id: batchOperationId, createdAt } = await createBatchOperation({
    operationType,
    targetTags,
    eventName,
    eventPayload,
    operatorId,
    operatorName
  });

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  const machineCache = new Map();
  for (const instance of instances) {
    try {
      if (!machineCache.has(instance.machine_id)) {
        const m = await getMachineById(instance.machine_id);
        machineCache.set(instance.machine_id, m);
      }
      const machine = machineCache.get(instance.machine_id);

      let result;
      switch (operationType) {
        case OPERATION_TYPE.SEND_EVENT:
          result = await executeSendEvent(instance, machine, eventName, eventPayload, operatorId);
          break;
        case OPERATION_TYPE.FREEZE:
          result = await executeFreeze(instance, operatorId, operatorName);
          break;
        case OPERATION_TYPE.UNFREEZE:
          result = await executeUnfreeze(instance, operatorId, operatorName);
          break;
        default:
          result = { success: false, message: `Unknown operation type: ${operationType}` };
      }

      let status;
      if (result.skipped) {
        status = RESULT_STATUS.SKIPPED;
        skippedCount++;
      } else if (result.success) {
        status = RESULT_STATUS.SUCCESS;
        successCount++;
      } else {
        status = RESULT_STATUS.FAILED;
        failedCount++;
      }

      await addBatchResult(batchOperationId, instance.id, status, result.message);

      results.push({
        instanceId: instance.id,
        status,
        message: result.message
      });
    } catch (e) {
      failedCount++;
      await addBatchResult(batchOperationId, instance.id, RESULT_STATUS.FAILED, e.message);
      results.push({
        instanceId: instance.id,
        status: RESULT_STATUS.FAILED,
        message: e.message
      });
    }
  }

  await updateBatchStats(batchOperationId, instances.length, successCount, failedCount, skippedCount);

  return {
    batchOperationId,
    createdAt,
    total: instances.length,
    successCount,
    failedCount,
    skippedCount,
    results
  };
}

async function listBatchOperations({ machineId, limit = 50, offset = 0 } = {}) {
  let sql = `
    SELECT bo.* FROM batch_operations bo
  `;
  const params = [];

  if (machineId) {
    sql += `
      WHERE EXISTS (
        SELECT 1 FROM batch_operation_results bor
        INNER JOIN instances i ON bor.instance_id = i.id
        WHERE bor.batch_operation_id = bo.id AND i.machine_id = ?
      )
    `;
    params.push(machineId);
  }

  sql += `
    ORDER BY bo.created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = await all(sql, params);
  return rows.map(r => ({
    id: r.id,
    operationType: r.operation_type,
    targetTags: JSON.parse(r.target_tags_json || '[]'),
    eventName: r.event_name,
    eventPayload: r.event_payload ? JSON.parse(r.event_payload) : null,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    createdAt: r.created_at,
    totalCount: r.total_count,
    successCount: r.success_count,
    failedCount: r.failed_count,
    skippedCount: r.skipped_count,
    status: r.status
  }));
}

async function getBatchOperationDetail(batchOperationId) {
  const row = await get('SELECT * FROM batch_operations WHERE id = ?', [batchOperationId]);
  if (!row) return null;

  const resultRows = await all(
    `SELECT bor.*, i.machine_id 
     FROM batch_operation_results bor
     LEFT JOIN instances i ON bor.instance_id = i.id
     WHERE bor.batch_operation_id = ?
     ORDER BY bor.executed_at`,
    [batchOperationId]
  );

  return {
    id: row.id,
    operationType: row.operation_type,
    targetTags: JSON.parse(row.target_tags_json || '[]'),
    eventName: row.event_name,
    eventPayload: row.event_payload ? JSON.parse(row.event_payload) : null,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    createdAt: row.created_at,
    totalCount: row.total_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    status: row.status,
    results: resultRows.map(r => ({
      id: r.id,
      instanceId: r.instance_id,
      machineId: r.machine_id,
      status: r.status,
      message: r.result_message,
      executedAt: r.executed_at
    }))
  };
}

module.exports = {
  BATCH_STATUS,
  RESULT_STATUS,
  OPERATION_TYPE,
  addTagsToInstance,
  removeTagsFromInstance,
  getInstanceTags,
  getAllTags,
  findInstancesByTags,
  executeBatchOperation,
  listBatchOperations,
  getBatchOperationDetail
};
