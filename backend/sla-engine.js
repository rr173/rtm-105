const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');

let broadcastFn = null;
let scanInterval = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

async function initSlaDB() {
  await run(`
    CREATE TABLE IF NOT EXISTS sla_rules (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      state_id TEXT NOT NULL,
      max_seconds INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_sla_rules_machine ON sla_rules(machine_id)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_rules_machine_state ON sla_rules(machine_id, state_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS sla_violations (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      state_id TEXT NOT NULL,
      entered_at TEXT NOT NULL,
      violated_at TEXT NOT NULL,
      duration_seconds REAL NOT NULL,
      max_allowed_seconds INTEGER NOT NULL,
      resolved_at TEXT,
      resolved_within_sla INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES instances(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_sla_violations_machine ON sla_violations(machine_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_sla_violations_instance ON sla_violations(instance_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_sla_violations_state ON sla_violations(state_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_sla_violations_violated ON sla_violations(violated_at)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_sla_violations_instance_state_entered ON sla_violations(instance_id, state_id, entered_at)');

  console.log('[SLA] Database tables initialized.');
}

async function setSlaRule({ machineId, stateId, maxSeconds, enabled = true }) {
  if (!machineId || !stateId || typeof maxSeconds !== 'number' || maxSeconds <= 0) {
    throw new Error('machineId, stateId, and positive maxSeconds are required');
  }

  const now = new Date().toISOString();
  const existing = await get(
    'SELECT * FROM sla_rules WHERE machine_id = ? AND state_id = ?',
    [machineId, stateId]
  );

  if (existing) {
    await run(
      'UPDATE sla_rules SET max_seconds = ?, enabled = ?, updated_at = ? WHERE id = ?',
      [maxSeconds, enabled ? 1 : 0, now, existing.id]
    );
    return getSlaRuleById(existing.id);
  } else {
    const id = uuidv4();
    await run(
      'INSERT INTO sla_rules (id, machine_id, state_id, max_seconds, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, machineId, stateId, maxSeconds, enabled ? 1 : 0, now, now]
    );
    return getSlaRuleById(id);
  }
}

async function getSlaRuleById(id) {
  const row = await get('SELECT * FROM sla_rules WHERE id = ?', [id]);
  if (!row) return null;
  return rowToSlaRule(row);
}

async function getSlaRulesByMachineId(machineId, options = {}) {
  const includeDisabled = options.includeDisabled === true || options.includeDisabled === 'true';
  let sql = 'SELECT * FROM sla_rules WHERE machine_id = ?';
  const params = [machineId];
  if (!includeDisabled) {
    sql += ' AND enabled = 1';
  }
  const rows = await all(sql, params);
  return rows.map(rowToSlaRule);
}

async function getSlaRule(machineId, stateId) {
  const row = await get(
    'SELECT * FROM sla_rules WHERE machine_id = ? AND state_id = ? AND enabled = 1',
    [machineId, stateId]
  );
  if (!row) return null;
  return rowToSlaRule(row);
}

async function deleteSlaRule(id) {
  const result = await run('DELETE FROM sla_rules WHERE id = ?', [id]);
  return result.changes > 0;
}

function rowToSlaRule(row) {
  return {
    id: row.id,
    machineId: row.machine_id,
    stateId: row.state_id,
    maxSeconds: row.max_seconds,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function recordSlaViolation({ instanceId, machineId, stateId, enteredAt, violatedAt, durationSeconds, maxAllowedSeconds }) {
  const existing = await get(
    'SELECT id FROM sla_violations WHERE instance_id = ? AND state_id = ? AND entered_at = ?',
    [instanceId, stateId, enteredAt]
  );
  if (existing) {
    return null;
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO sla_violations 
     (id, instance_id, machine_id, state_id, entered_at, violated_at, duration_seconds, max_allowed_seconds, resolved_at, resolved_within_sla, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, instanceId, machineId, stateId, enteredAt, violatedAt, durationSeconds, maxAllowedSeconds, null, null, now]
  );

  return getSlaViolationById(id);
}

async function resolveSlaViolation(instanceId, stateId, enteredAt, leftAt, wasWithinSla) {
  const row = await get(
    'SELECT * FROM sla_violations WHERE instance_id = ? AND state_id = ? AND entered_at = ? AND resolved_at IS NULL',
    [instanceId, stateId, enteredAt]
  );
  if (!row) return null;

  await run(
    'UPDATE sla_violations SET resolved_at = ?, resolved_within_sla = ? WHERE id = ?',
    [leftAt, wasWithinSla ? 1 : 0, row.id]
  );
  return getSlaViolationById(row.id);
}

async function getSlaViolationById(id) {
  const row = await get('SELECT * FROM sla_violations WHERE id = ?', [id]);
  if (!row) return null;
  return rowToSlaViolation(row);
}

function rowToSlaViolation(row) {
  return {
    id: row.id,
    instanceId: row.instance_id,
    machineId: row.machine_id,
    stateId: row.state_id,
    enteredAt: row.entered_at,
    violatedAt: row.violated_at,
    durationSeconds: row.duration_seconds,
    maxAllowedSeconds: row.max_allowed_seconds,
    resolvedAt: row.resolved_at,
    resolvedWithinSla: row.resolved_within_sla === null ? null : !!row.resolved_within_sla,
    createdAt: row.created_at
  };
}

async function getSlaViolations(filters = {}) {
  let sql = 'SELECT sv.* FROM sla_violations sv WHERE 1=1';
  const params = [];

  if (filters.machineId) {
    sql += ' AND sv.machine_id = ?';
    params.push(filters.machineId);
  }
  if (filters.instanceId) {
    sql += ' AND sv.instance_id = ?';
    params.push(filters.instanceId);
  }
  if (filters.stateId) {
    sql += ' AND sv.state_id = ?';
    params.push(filters.stateId);
  }
  if (filters.fromTime) {
    sql += ' AND sv.violated_at >= ?';
    params.push(filters.fromTime);
  }
  if (filters.toTime) {
    sql += ' AND sv.violated_at <= ?';
    params.push(filters.toTime);
  }
  if (filters.resolved !== undefined) {
    if (filters.resolved) {
      sql += ' AND sv.resolved_at IS NOT NULL';
    } else {
      sql += ' AND sv.resolved_at IS NULL';
    }
  }

  sql += ' ORDER BY sv.violated_at DESC';

  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  if (filters.offset) {
    sql += ' OFFSET ?';
    params.push(filters.offset);
  }

  const rows = await all(sql, params);
  return rows.map(rowToSlaViolation);
}

async function scanSlaViolations() {
  try {
    const activeInstances = await all(`
      SELECT i.*, m.definition, m.name as machine_name
      FROM instances i
      JOIN machines m ON i.machine_id = m.id
      WHERE i.is_final = 0
    `);

    const now = Date.now();
    let violationCount = 0;

    for (const inst of activeInstances) {
      try {
        const enteredAt = inst.entered_state_at || inst.created_at;
        const enteredTime = new Date(enteredAt).getTime();
        const elapsedSeconds = (now - enteredTime) / 1000;

        const rule = await getSlaRule(inst.machine_id, inst.current_state_id);
        if (!rule) continue;

        if (elapsedSeconds > rule.maxSeconds) {
          const definition = JSON.parse(inst.definition);
          const state = definition.states.find(s => s.id === inst.current_state_id);
          const stateName = state ? state.name : inst.current_state_id;

          const violation = await recordSlaViolation({
            instanceId: inst.id,
            machineId: inst.machine_id,
            stateId: inst.current_state_id,
            enteredAt: enteredAt,
            violatedAt: new Date(now).toISOString(),
            durationSeconds: Math.round(elapsedSeconds * 10) / 10,
            maxAllowedSeconds: rule.maxSeconds
          });

          if (violation) {
            violationCount++;
            if (broadcastFn) {
              broadcastFn(inst.machine_id, {
                type: 'sla_violation',
                violationId: violation.id,
                instanceId: inst.id,
                machineId: inst.machine_id,
                machineName: inst.machine_name,
                stateId: inst.current_state_id,
                stateName: stateName,
                enteredAt: enteredAt,
                violatedAt: violation.violatedAt,
                durationSeconds: violation.durationSeconds,
                maxAllowedSeconds: rule.maxSeconds,
                timestamp: violation.violatedAt
              });
            }
          }
        }
      } catch (e) {
        console.error(`[SLA] Error processing instance ${inst.id}:`, e);
      }
    }

    if (violationCount > 0) {
      console.log(`[SLA] Scan complete: detected ${violationCount} new violation(s).`);
    }
  } catch (e) {
    console.error('[SLA] Scan error:', e);
  }
}

function startSlaScanner(intervalSeconds = 10) {
  if (scanInterval) {
    clearInterval(scanInterval);
  }
  console.log(`[SLA] Starting scanner with ${intervalSeconds}s interval.`);
  scanInterval = setInterval(() => {
    scanSlaViolations().catch(e => console.error('[SLA] Uncaught scan error:', e));
  }, intervalSeconds * 1000);
}

function stopSlaScanner() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
    console.log('[SLA] Scanner stopped.');
  }
}

async function getSlaComplianceStats(machineId, timeFilter = {}) {
  const machine = await get('SELECT * FROM machines WHERE id = ?', [machineId]);
  if (!machine) throw new Error('Machine not found');

  const definition = JSON.parse(machine.definition);
  const stateMap = new Map();
  for (const s of definition.states) {
    stateMap.set(s.id, { id: s.id, name: s.name });
  }

  let timeWhere = '';
  let timeParams = [];
  if (timeFilter.from) {
    timeWhere += ' AND sd.entered_at >= ?';
    timeParams.push(timeFilter.from);
  }
  if (timeFilter.to) {
    timeWhere += ' AND sd.entered_at <= ?';
    timeParams.push(timeFilter.to);
  }

  const stateStats = {};
  for (const s of definition.states) {
    stateStats[s.id] = {
      stateId: s.id,
      stateName: s.name,
      totalVisits: 0,
      withinSla: 0,
      violated: 0,
      noRule: 0,
      complianceRate: null
    };
  }

  const rules = await getSlaRulesByMachineId(machineId);
  const ruleMap = new Map();
  for (const r of rules) {
    ruleMap.set(r.stateId, r);
  }

  const durations = await all(
    `SELECT sd.* FROM state_durations sd 
     WHERE sd.machine_id = ? AND sd.duration_ms IS NOT NULL ${timeWhere}`,
    [machineId, ...timeParams]
  );

  for (const d of durations) {
    if (!stateStats[d.state_id]) continue;
    const stat = stateStats[d.state_id];
    stat.totalVisits++;

    const rule = ruleMap.get(d.state_id);
    if (!rule) {
      stat.noRule++;
      continue;
    }

    const durationSec = (d.duration_ms || 0) / 1000;
    if (durationSec <= rule.maxSeconds) {
      stat.withinSla++;
    } else {
      stat.violated++;
    }
  }

  const pendingInstances = await all(
    `SELECT i.* FROM instances i
     WHERE i.machine_id = ? AND i.is_final = 0`,
    [machineId]
  );

  const now = Date.now();
  for (const inst of pendingInstances) {
    if (!stateStats[inst.current_state_id]) continue;
    const stat = stateStats[inst.current_state_id];

    const enteredAt = inst.entered_state_at || inst.created_at;
    const elapsedSec = (now - new Date(enteredAt).getTime()) / 1000;
    const rule = ruleMap.get(inst.current_state_id);

    if (!rule) {
      stat.noRule++;
      stat.totalVisits++;
      continue;
    }

    const hasActiveViolation = await get(
      `SELECT id FROM sla_violations 
       WHERE instance_id = ? AND state_id = ? AND entered_at = ?`,
      [inst.id, inst.current_state_id, enteredAt]
    );

    stat.totalVisits++;
    if (hasActiveViolation || elapsedSec > rule.maxSeconds) {
      stat.violated++;
    } else {
      stat.withinSla++;
    }
  }

  const result = [];
  for (const stateId of Object.keys(stateStats)) {
    const stat = stateStats[stateId];
    const counted = stat.withinSla + stat.violated;
    stat.complianceRate = counted > 0 ? Math.round((stat.withinSla / counted) * 10000) / 100 : null;
    result.push(stat);
  }

  const totalCounted = result.reduce((s, r) => s + r.withinSla + r.violated, 0);
  const totalWithin = result.reduce((s, r) => s + r.withinSla, 0);
  const totalViolated = result.reduce((s, r) => s + r.violated, 0);

  return {
    machineId,
    machineName: machine.name,
    timeFilter,
    overall: {
      totalVisits: result.reduce((s, r) => s + r.totalVisits, 0),
      withinSla: totalWithin,
      violated: totalViolated,
      noRule: result.reduce((s, r) => s + r.noRule, 0),
      complianceRate: totalCounted > 0 ? Math.round((totalWithin / totalCounted) * 10000) / 100 : null
    },
    states: result
  };
}

async function seedDemoSlaData() {
  const orderMachine = await get('SELECT * FROM machines WHERE name = ? ORDER BY version DESC LIMIT 1', ['订单审批']);
  if (!orderMachine) {
    console.log('[SLA] No 订单审批 machine found, skipping demo SLA data.');
    return;
  }

  const definition = JSON.parse(orderMachine.definition);
  const pendingState = definition.states.find(s => s.name === '待审批');
  if (!pendingState) {
    console.log('[SLA] No 待审批 state found, skipping SLA rule creation.');
    return;
  }

  const existingRule = await getSlaRule(orderMachine.id, pendingState.id);
  if (!existingRule) {
    await setSlaRule({
      machineId: orderMachine.id,
      stateId: pendingState.id,
      maxSeconds: 60,
      enabled: true
    });
    console.log('[SLA] Created SLA rule: 待审批 state with 60s limit for 订单审批.');
  } else {
    console.log('[SLA] SLA rule for 待审批 already exists, skipping.');
  }

  const existingViolations = await get('SELECT COUNT(*) as cnt FROM sla_violations WHERE machine_id = ?', [orderMachine.id]);
  if (existingViolations.cnt > 0) {
    console.log('[SLA] Demo SLA violations already exist, skipping.');
    return;
  }

  const pendingInstances = await all(
    `SELECT i.* FROM instances i 
     WHERE i.machine_id = ? AND i.current_state_id = ? AND i.is_final = 0 
     ORDER BY i.created_at ASC LIMIT 2`,
    [orderMachine.id, pendingState.id]
  );

  if (pendingInstances.length === 0) {
    const demo1Id = uuidv4();
    const demo2Id = uuidv4();
    const now = new Date();
    const baseTime1 = new Date(now.getTime() - 5 * 60 * 1000);
    const baseTime2 = new Date(now.getTime() - 3 * 60 * 1000);

    await run(
      `INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final, entered_state_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [demo1Id, orderMachine.id, pendingState.id, JSON.stringify({ orderId: 'ORD-SLA-DEMO-001', amount: 2000 }), baseTime1.toISOString(), 0, baseTime1.toISOString()]
    );
    await run(
      `INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final, entered_state_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [demo2Id, orderMachine.id, pendingState.id, JSON.stringify({ orderId: 'ORD-SLA-DEMO-002', amount: 7500 }), baseTime2.toISOString(), 0, baseTime2.toISOString()]
    );

    await recordSlaViolation({
      instanceId: demo1Id,
      machineId: orderMachine.id,
      stateId: pendingState.id,
      enteredAt: baseTime1.toISOString(),
      violatedAt: new Date(baseTime1.getTime() + 61 * 1000).toISOString(),
      durationSeconds: 300,
      maxAllowedSeconds: 60
    });
    await recordSlaViolation({
      instanceId: demo2Id,
      machineId: orderMachine.id,
      stateId: pendingState.id,
      enteredAt: baseTime2.toISOString(),
      violatedAt: new Date(baseTime2.getTime() + 61 * 1000).toISOString(),
      durationSeconds: 180,
      maxAllowedSeconds: 60
    });

    console.log('[SLA] Created 2 demo SLA violations with pre-seeded instances.');
  } else {
    for (const inst of pendingInstances.slice(0, 2)) {
      const enteredAt = inst.entered_state_at || inst.created_at;
      const enteredTime = new Date(enteredAt).getTime();
      await recordSlaViolation({
        instanceId: inst.id,
        machineId: orderMachine.id,
        stateId: pendingState.id,
        enteredAt: enteredAt,
        violatedAt: new Date(enteredTime + 61 * 1000).toISOString(),
        durationSeconds: 120,
        maxAllowedSeconds: 60
      });
    }
    console.log(`[SLA] Created ${Math.min(2, pendingInstances.length)} demo SLA violations from existing instances.`);
  }
}

module.exports = {
  initSlaDB,
  setSlaRule,
  getSlaRuleById,
  getSlaRulesByMachineId,
  getSlaRule,
  deleteSlaRule,
  recordSlaViolation,
  resolveSlaViolation,
  getSlaViolationById,
  getSlaViolations,
  scanSlaViolations,
  startSlaScanner,
  stopSlaScanner,
  setBroadcast,
  getSlaComplianceStats,
  seedDemoSlaData
};
