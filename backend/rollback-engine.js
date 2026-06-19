const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { getMachineById, getMachineVersionsByName } = require('./version-migration');
const { assessInstanceRisk } = require('./impact-assessment');
const { RISK_LEVEL } = require('./version-diff-engine');
const { clearInstanceTimeout, scheduleTimeout } = require('./timeout-manager');
const { getPoliciesByMachineId, addPolicy } = require('./compliance-engine');
const { getLinksByInstanceId } = require('./cascade-engine');

const activeRollbacks = new Map();

const ROLLBACK_ACTION = {
  MIGRATED: 'migrated',
  SKIPPED_DANGEROUS: 'skipped_dangerous',
  FAILED: 'failed'
};

const ROLLBACK_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

function isRollbackActive(machineName) {
  return activeRollbacks.has(machineName);
}

async function executeRollback({ machineName, targetVersion, operatorId, operatorName, reason }) {
  if (activeRollbacks.has(machineName)) {
    throw new Error(`状态机 [${machineName}] 已有一个回滚操作正在执行，请稍后再试`);
  }

  activeRollbacks.set(machineName, true);

  const rollbackId = uuidv4();
  const now = new Date().toISOString();

  try {
    const versions = await getMachineVersionsByName(machineName);
    if (!versions || versions.length === 0) {
      throw new Error(`状态机 [${machineName}] 不存在`);
    }

    const sortedVersions = [...versions].sort((a, b) => b.version - a.version);
    const currentMachine = sortedVersions[0];

    if (String(currentMachine.version) === String(targetVersion)) {
      throw new Error('目标版本与当前版本相同，无需回滚');
    }

    const targetMachine = versions.find(v => String(v.version) === String(targetVersion));
    if (!targetMachine) {
      throw new Error(`状态机 [${machineName}] 不存在版本 ${targetVersion}`);
    }

    await run(
      `INSERT INTO version_rollback_records 
       (id, machine_name, from_machine_id, to_machine_id, from_version, to_version, 
        operator_id, operator_name, total_instances, success_count, failed_count, skipped_count, status, reason, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rollbackId, machineName, currentMachine.id, targetMachine.id,
       currentMachine.version, targetMachine.version,
       operatorId, operatorName, 0, 0, 0, 0,
       ROLLBACK_STATUS.RUNNING, reason || null, now]
    );

    const instances = await all(
      'SELECT * FROM instances WHERE machine_id = ? AND is_final = 0',
      [currentMachine.id]
    );

    await run(
      'UPDATE version_rollback_records SET total_instances = ? WHERE id = ?',
      [instances.length, rollbackId]
    );

    const newPolicies = await getPoliciesByMachineId(currentMachine.id, { includeDisabled: true });
    const oldPolicyNames = new Set(
      (await getPoliciesByMachineId(targetMachine.id, { includeDisabled: true })).map(p => p.name)
    );
    const policiesToSync = newPolicies.filter(p => !oldPolicyNames.has(p.name));

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const details = [];

    for (const inst of instances) {
      const assessment = assessInstanceRisk(inst, targetMachine.definition, currentMachine.definition);
      const detailId = uuidv4();
      const currentStateId = inst.current_state_id;

      if (assessment.riskLevel === RISK_LEVEL.DANGEROUS) {
        skippedCount++;
        const detail = {
          id: detailId,
          rollbackId,
          instanceId: inst.id,
          fromStateId: currentStateId,
          toStateId: null,
          riskLevel: assessment.riskLevel,
          reasons: assessment.reasons,
          action: ROLLBACK_ACTION.SKIPPED_DANGEROUS,
          error: null
        };
        details.push(detail);

        await run(
          `INSERT INTO version_rollback_details 
           (id, rollback_id, instance_id, from_state_id, to_state_id, risk_level, reasons_json, action, error_message, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [detailId, rollbackId, inst.id, currentStateId, null,
           assessment.riskLevel, JSON.stringify(assessment.reasons),
           ROLLBACK_ACTION.SKIPPED_DANGEROUS, null, now]
        );
        continue;
      }

      try {
        const currentStateInNew = currentMachine.definition.states.find(s => s.id === currentStateId);
        let targetState = targetMachine.definition.states.find(s => s.id === currentStateId);
        let stateMappingInfo = null;

        if (!targetState && currentStateInNew && currentStateInNew.name) {
          targetState = targetMachine.definition.states.find(s => s.name === currentStateInNew.name);
          if (targetState) {
            stateMappingInfo = { mappedBy: 'name', oldId: currentStateId, newId: targetState.id };
          }
        }

        if (!targetState) {
          failedCount++;
          const failReason = `当前状态 [${currentStateInNew ? currentStateInNew.name : currentStateId}] 在目标版本中不存在`;
          const detail = {
            id: detailId,
            rollbackId,
            instanceId: inst.id,
            fromStateId: currentStateId,
            toStateId: null,
            riskLevel: assessment.riskLevel,
            reasons: assessment.reasons,
            action: ROLLBACK_ACTION.FAILED,
            error: failReason
          };
          details.push(detail);

          await run(
            `INSERT INTO version_rollback_details 
             (id, rollback_id, instance_id, from_state_id, to_state_id, risk_level, reasons_json, action, error_message, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [detailId, rollbackId, inst.id, currentStateId, null,
             assessment.riskLevel, JSON.stringify(assessment.reasons),
             ROLLBACK_ACTION.FAILED, failReason, now]
          );
          continue;
        }

        const targetStateId = targetState.id;
        const oldMachineId = inst.machine_id;
        const oldStateId = inst.current_state_id;

        await run(
          'UPDATE instances SET machine_id = ?, current_state_id = ?, is_final = ?, entered_state_at = ? WHERE id = ?',
          [targetMachine.id, targetStateId, targetState.isFinal ? 1 : 0, now, inst.id]
        );

        await run(
          `INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), inst.id, oldStateId, targetStateId, '__version_rollback__',
           JSON.stringify({
             fromVersion: currentMachine.version,
             toVersion: targetMachine.version,
             fromMachineId: currentMachine.id,
             toMachineId: targetMachine.id,
             rollbackId,
             riskLevel: assessment.riskLevel,
             reasons: assessment.reasons,
             stateMapping: stateMappingInfo
           }),
           now, `rollback:${operatorId}`]
        );

        await run(
          `INSERT INTO instance_migrations (id, instance_id, source_machine_id, target_machine_id, source_version, target_version, from_state_id, to_state_id, context_before, context_after, status, warnings, error_message, created_at, operator) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), inst.id, currentMachine.id, targetMachine.id,
           currentMachine.version, targetMachine.version,
           oldStateId, targetStateId,
           inst.context_data, inst.context_data,
           'completed', JSON.stringify(assessment.reasons || []),
           null, now, `rollback:${operatorId}`]
        );

        clearInstanceTimeout(inst.id);
        if (!targetState.isFinal && targetState.timeout) {
          scheduleTimeout(inst.id, targetState.timeout, now);
        }

        const links = await getLinksByInstanceId(inst.id, { includeBroken: false });
        for (const link of links) {
          const updates = [];
          const params = [];
          if (link.sourceInstanceId === inst.id) {
            updates.push('source_machine_id = ?');
            params.push(targetMachine.id);
          }
          if (link.targetInstanceId === inst.id) {
            updates.push('target_machine_id = ?');
            params.push(targetMachine.id);
          }
          if (updates.length > 0) {
            updates.push('updated_at = ?');
            params.push(now);
            params.push(link.id);
            await run(
              `UPDATE instance_links SET ${updates.join(', ')} WHERE id = ?`,
              params
            );
          }
        }

        successCount++;
        const detail = {
          id: detailId,
          rollbackId,
          instanceId: inst.id,
          fromStateId: oldStateId,
          toStateId: targetStateId,
          riskLevel: assessment.riskLevel,
          reasons: assessment.reasons,
          action: ROLLBACK_ACTION.MIGRATED,
          error: null,
          stateMapping: stateMappingInfo
        };
        details.push(detail);

        await run(
          `INSERT INTO version_rollback_details 
           (id, rollback_id, instance_id, from_state_id, to_state_id, risk_level, reasons_json, action, error_message, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [detailId, rollbackId, inst.id, oldStateId, targetStateId,
           assessment.riskLevel, JSON.stringify(assessment.reasons),
           ROLLBACK_ACTION.MIGRATED, null, now]
        );
      } catch (e) {
        failedCount++;
        const detail = {
          id: detailId,
          rollbackId,
          instanceId: inst.id,
          fromStateId: currentStateId,
          toStateId: null,
          riskLevel: assessment.riskLevel,
          reasons: assessment.reasons,
          action: ROLLBACK_ACTION.FAILED,
          error: e.message
        };
        details.push(detail);

        await run(
          `INSERT INTO version_rollback_details 
           (id, rollback_id, instance_id, from_state_id, to_state_id, risk_level, reasons_json, action, error_message, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [detailId, rollbackId, inst.id, currentStateId, null,
           assessment.riskLevel, JSON.stringify(assessment.reasons),
           ROLLBACK_ACTION.FAILED, e.message, now]
        );
      }
    }

    for (const policy of policiesToSync) {
      try {
        await addPolicy({
          machineId: targetMachine.id,
          name: policy.name,
          description: policy.description,
          type: policy.type,
          config: policy.config,
          enabled: policy.enabled
        });
      } catch (e) {
        console.error(`[Rollback] Failed to sync policy "${policy.name}" to target machine:`, e.message);
      }
    }

    const completedAt = new Date().toISOString();
    const finalStatus = failedCount > 0 && successCount === 0
      ? ROLLBACK_STATUS.FAILED
      : ROLLBACK_STATUS.COMPLETED;

    await run(
      `UPDATE version_rollback_records 
       SET success_count = ?, failed_count = ?, skipped_count = ?, status = ?, completed_at = ? 
       WHERE id = ?`,
      [successCount, failedCount, skippedCount, finalStatus, completedAt, rollbackId]
    );

    return {
      rollbackId,
      machineName,
      fromVersion: currentMachine.version,
      toVersion: targetMachine.version,
      fromMachineId: currentMachine.id,
      toMachineId: targetMachine.id,
      operatorId,
      operatorName,
      totalInstances: instances.length,
      successCount,
      failedCount,
      skippedCount,
      status: finalStatus,
      reason: reason || null,
      createdAt: now,
      completedAt,
      details
    };
  } catch (e) {
    try {
      await run(
        `UPDATE version_rollback_records SET status = ?, completed_at = ? WHERE id = ?`,
        [ROLLBACK_STATUS.FAILED, new Date().toISOString(), rollbackId]
      );
    } catch (_) {}

    throw e;
  } finally {
    activeRollbacks.delete(machineName);
  }
}

async function getRollbackRecord(rollbackId) {
  const row = await get('SELECT * FROM version_rollback_records WHERE id = ?', [rollbackId]);
  if (!row) return null;
  return rowToRecord(row);
}

async function getRollbackRecordWithDetails(rollbackId) {
  const record = await getRollbackRecord(rollbackId);
  if (!record) return null;

  const detailRows = await all(
    'SELECT * FROM version_rollback_details WHERE rollback_id = ? ORDER BY created_at ASC',
    [rollbackId]
  );

  return {
    ...record,
    details: detailRows.map(rowToDetail)
  };
}

async function listRollbackRecords(filters = {}) {
  let sql = 'SELECT * FROM version_rollback_records WHERE 1=1';
  const params = [];

  if (filters.machineName) {
    sql += ' AND machine_name = ?';
    params.push(filters.machineName);
  }
  if (filters.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.operatorId) {
    sql += ' AND operator_id = ?';
    params.push(filters.operatorId);
  }

  sql += ' ORDER BY created_at DESC';

  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }

  const rows = await all(sql, params);
  return rows.map(rowToRecord);
}

function rowToRecord(row) {
  return {
    id: row.id,
    machineName: row.machine_name,
    fromMachineId: row.from_machine_id,
    toMachineId: row.to_machine_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    totalInstances: row.total_instances,
    successCount: row.success_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

function rowToDetail(row) {
  return {
    id: row.id,
    rollbackId: row.rollback_id,
    instanceId: row.instance_id,
    fromStateId: row.from_state_id,
    toStateId: row.to_state_id,
    riskLevel: row.risk_level,
    reasons: JSON.parse(row.reasons_json || '[]'),
    action: row.action,
    errorMessage: row.error_message,
    createdAt: row.created_at
  };
}

module.exports = {
  ROLLBACK_ACTION,
  ROLLBACK_STATUS,
  isRollbackActive,
  executeRollback,
  getRollbackRecord,
  getRollbackRecordWithDetails,
  listRollbackRecords
};
