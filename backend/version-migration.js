const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { clearInstanceTimeout, scheduleTimeout } = require('./timeout-manager');
const { evaluateGuard } = require('./guard');

async function getMachineVersionsByName(machineName) {
  const rows = await all(
    'SELECT * FROM machines WHERE name = ? ORDER BY version DESC',
    [machineName]
  );
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    definition: JSON.parse(row.definition)
  }));
}

async function checkSingleInstanceMigratable(instanceRow, sourceMachine, targetMachine) {
  const result = {
    instanceId: instanceRow.id,
    canMigrate: false,
    reason: null,
    warnings: [],
    currentStateId: instanceRow.current_state_id,
    context: JSON.parse(instanceRow.context_data)
  };

  const targetDef = targetMachine.definition;
  const sourceDef = sourceMachine.definition;

  const currentStateInSource = sourceDef.states.find(s => s.id === instanceRow.current_state_id);
  if (!currentStateInSource) {
    result.reason = '当前状态在源版本中不存在，数据异常';
    return result;
  }

  let targetState = targetDef.states.find(s => s.id === instanceRow.current_state_id);
  if (!targetState) {
    targetState = targetDef.states.find(s => s.name === currentStateInSource.name);
    if (targetState) {
      result.warnings.push(`状态ID不匹配，将按名称映射: ${currentStateInSource.name} (${instanceRow.current_state_id} → ${targetState.id})`);
    }
  }

  if (!targetState) {
    result.reason = `当前状态 [${currentStateInSource.name}] 在新版本中不存在`;
    return result;
  }

  if (targetState.isFinal) {
    result.warnings.push('目标状态是终态，迁移后实例将结束');
  }

  result.mappedTargetStateId = targetState.id;

  const outgoingInSource = sourceDef.transitions.filter(
    t => t.sourceStateId === instanceRow.current_state_id
  );
  const outgoingInTarget = targetDef.transitions.filter(
    t => t.sourceStateId === targetState.id
  );

  if (outgoingInSource.length > 0 && outgoingInTarget.length === 0) {
    result.reason = `状态 [${currentStateInSource.name}] 在新版本中没有任何出站转换，迁移后将无法继续流转`;
    return result;
  }

  const sourceEvents = new Set(outgoingInSource.map(t => t.event));
  const targetEvents = new Set(outgoingInTarget.map(t => t.event));
  const missingEvents = [...sourceEvents].filter(e => !targetEvents.has(e));
  if (missingEvents.length > 0) {
    result.warnings.push(`以下事件在新版本中不再可用: ${missingEvents.join(', ')}`);
  }

  const context = JSON.parse(instanceRow.context_data);
  for (const t of outgoingInTarget) {
    if (t.guard && t.guard.trim()) {
      try {
        const passes = evaluateGuard(t.guard, {}, context);
        if (!passes) {
          result.warnings.push(`守卫条件 [${t.guard}] 在当前上下文中不满足，对应事件可能无法触发`);
        }
      } catch (e) {
        result.warnings.push(`守卫条件 [${t.guard}] 解析失败: ${e.message}`);
      }
    }
  }

  result.canMigrate = true;
  return result;
}

async function checkMigratable(sourceMachineId, targetMachineId, instanceIds = null) {
  const sourceMachine = await getMachineById(sourceMachineId);
  if (!sourceMachine) {
    throw new Error('源状态机不存在');
  }

  const targetMachine = await getMachineById(targetMachineId);
  if (!targetMachine) {
    throw new Error('目标状态机不存在');
  }

  if (sourceMachine.name !== targetMachine.name) {
    throw new Error('只能在同名不同版本的状态机之间迁移');
  }

  if (sourceMachine.version === targetMachine.version) {
    throw new Error('源版本和目标版本相同，无需迁移');
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

  const results = [];
  for (const inst of instances) {
    const check = await checkSingleInstanceMigratable(inst, sourceMachine, targetMachine);
    results.push(check);
  }

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
    totalInstances: results.length,
    migratableCount: results.filter(r => r.canMigrate).length,
    blockedCount: results.filter(r => !r.canMigrate).length,
    instances: results
  };
}

async function getMachineById(id) {
  const row = await get('SELECT * FROM machines WHERE id = ?', [id]);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    definition: JSON.parse(row.definition)
  };
}

async function executeSingleMigration(instanceRow, sourceMachine, targetMachine, checkResult, operator = 'system') {
  const migrationId = uuidv4();
  const now = new Date().toISOString();
  const targetStateId = checkResult.mappedTargetStateId || instanceRow.current_state_id;

  const targetState = targetMachine.definition.states.find(s => s.id === targetStateId);
  if (!targetState) {
    throw new Error(`目标状态 ${targetStateId} 在新版本中不存在`);
  }

  const oldMachineId = instanceRow.machine_id;
  const oldStateId = instanceRow.current_state_id;
  const oldContext = instanceRow.context_data;

  await run(
    'UPDATE instances SET machine_id = ?, current_state_id = ?, is_final = ?, entered_state_at = ? WHERE id = ?',
    [
      targetMachine.id,
      targetStateId,
      targetState.isFinal ? 1 : 0,
      now,
      instanceRow.id
    ]
  );

  await run(
    'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      uuidv4(),
      instanceRow.id,
      oldStateId,
      targetStateId,
      '__version_migration__',
      JSON.stringify({
        fromVersion: sourceMachine.version,
        toVersion: targetMachine.version,
        sourceMachineId: sourceMachine.id,
        targetMachineId: targetMachine.id,
        warnings: checkResult.warnings || []
      }),
      now,
      `migration:${operator}`
    ]
  );

  await run(
    'INSERT INTO instance_migrations (id, instance_id, source_machine_id, target_machine_id, source_version, target_version, from_state_id, to_state_id, context_before, context_after, status, warnings, created_at, operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      migrationId,
      instanceRow.id,
      sourceMachine.id,
      targetMachine.id,
      sourceMachine.version,
      targetMachine.version,
      oldStateId,
      targetStateId,
      oldContext,
      instanceRow.context_data,
      'completed',
      JSON.stringify(checkResult.warnings || []),
      now,
      operator
    ]
  );

  clearInstanceTimeout(instanceRow.id);
  if (!targetState.isFinal && targetState.timeout) {
    scheduleTimeout(instanceRow.id, targetState.timeout, now);
  }

  return {
    migrationId,
    instanceId: instanceRow.id,
    success: true,
    sourceMachineId: sourceMachine.id,
    targetMachineId: targetMachine.id,
    fromStateId: oldStateId,
    toStateId: targetStateId,
    warnings: checkResult.warnings || [],
    timestamp: now
  };
}

async function executeMigration(sourceMachineId, targetMachineId, instanceIds, operator = 'system') {
  if (!instanceIds || instanceIds.length === 0) {
    throw new Error('请选择要迁移的实例');
  }

  const checkResult = await checkMigratable(sourceMachineId, targetMachineId, instanceIds);
  const sourceMachine = await getMachineById(sourceMachineId);
  const targetMachine = await getMachineById(targetMachineId);

  const results = [];
  const broadcastEvents = [];

  for (const instCheck of checkResult.instances) {
    const instanceRow = await get('SELECT * FROM instances WHERE id = ?', [instCheck.instanceId]);

    if (!instanceRow) {
      results.push({
        instanceId: instCheck.instanceId,
        success: false,
        error: '实例不存在'
      });
      continue;
    }

    if (!instCheck.canMigrate) {
      await run(
        'INSERT INTO instance_migrations (id, instance_id, source_machine_id, target_machine_id, source_version, target_version, from_state_id, to_state_id, context_before, context_after, status, warnings, error_message, created_at, operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          uuidv4(),
          instanceRow.id,
          sourceMachine.id,
          targetMachine.id,
          sourceMachine.version,
          targetMachine.version,
          instanceRow.current_state_id,
          null,
          instanceRow.context_data,
          instanceRow.context_data,
          'failed',
          JSON.stringify(instCheck.warnings || []),
          instCheck.reason,
          new Date().toISOString(),
          operator
        ]
      );

      results.push({
        instanceId: instCheck.instanceId,
        success: false,
        error: instCheck.reason,
        warnings: instCheck.warnings
      });
      continue;
    }

    try {
      const migrationResult = await executeSingleMigration(
        instanceRow,
        sourceMachine,
        targetMachine,
        instCheck,
        operator
      );
      results.push(migrationResult);
      broadcastEvents.push(migrationResult);
    } catch (e) {
      await run(
        'INSERT INTO instance_migrations (id, instance_id, source_machine_id, target_machine_id, source_version, target_version, from_state_id, to_state_id, context_before, context_after, status, warnings, error_message, created_at, operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          uuidv4(),
          instanceRow.id,
          sourceMachine.id,
          targetMachine.id,
          sourceMachine.version,
          targetMachine.version,
          instanceRow.current_state_id,
          null,
          instanceRow.context_data,
          instanceRow.context_data,
          'failed',
          JSON.stringify(instCheck.warnings || []),
          e.message,
          new Date().toISOString(),
          operator
        ]
      );

      results.push({
        instanceId: instCheck.instanceId,
        success: false,
        error: e.message,
        warnings: instCheck.warnings
      });
    }
  }

  return {
    sourceMachine: checkResult.sourceMachine,
    targetMachine: checkResult.targetMachine,
    total: results.length,
    successCount: results.filter(r => r.success).length,
    failedCount: results.filter(r => !r.success).length,
    results,
    broadcastEvents
  };
}

async function getMigrationHistory(instanceId) {
  const rows = await all(
    'SELECT * FROM instance_migrations WHERE instance_id = ? ORDER BY created_at ASC',
    [instanceId]
  );
  return rows.map(row => ({
    id: row.id,
    instanceId: row.instance_id,
    sourceMachineId: row.source_machine_id,
    targetMachineId: row.target_machine_id,
    sourceVersion: row.source_version,
    targetVersion: row.target_version,
    fromStateId: row.from_state_id,
    toStateId: row.to_state_id,
    status: row.status,
    warnings: JSON.parse(row.warnings || '[]'),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    operator: row.operator
  }));
}

async function getMachinesGroupedByName() {
  const allMachines = await all('SELECT * FROM machines ORDER BY name ASC, version DESC');
  
  const groups = new Map();
  for (const row of allMachines) {
    const name = row.name;
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    const cntRow = await get('SELECT COUNT(*) as cnt FROM instances WHERE machine_id = ? AND is_final = 0', [row.id]);
    groups.get(name).push({
      id: row.id,
      name: row.name,
      version: row.version,
      createdAt: row.created_at,
      activeInstances: cntRow.cnt,
      isLatest: false
    });
  }

  const result = [];
  for (const [name, machines] of groups) {
    if (machines.length > 0) {
      machines[0].isLatest = true;
    }
    result.push({
      name,
      latestVersion: machines.length > 0 ? machines[0].version : 0,
      totalActiveInstances: machines.reduce((sum, m) => sum + m.activeInstances, 0),
      machines
    });
  }

  return result;
}

module.exports = {
  getMachineVersionsByName,
  checkMigratable,
  executeMigration,
  getMigrationHistory,
  getMachinesGroupedByName,
  getMachineById
};
