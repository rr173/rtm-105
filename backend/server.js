const express = require('express');
const http = require('http');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const { run, get, all, initDB } = require('./db');
const { evaluateGuard } = require('./guard');
const { seedDemoData } = require('./seed');
const {
  parseTimeFilter,
  getStateHeatmap,
  getTransitionFrequency,
  getInstanceLifecycle,
  recordStateDuration
} = require('./metrics');
const {
  scheduleTimeout,
  clearInstanceTimeout,
  rebuildAllTimers,
  getTimeoutInfoForInstance,
  setBroadcast
} = require('./timeout-manager');
const {
  addPolicy,
  updatePolicy,
  deletePolicy,
  getPolicyById,
  getPoliciesByMachineId,
  getViolations,
  checkTransitionCompliance,
  auditInstanceHistory,
  auditCompletedInstances
} = require('./compliance-engine');
const {
  getMachineVersionsByName,
  checkMigratable,
  executeMigration,
  getMigrationHistory,
  getMachinesGroupedByName,
  getMachineById
} = require('./version-migration');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const subscriptions = new Map();

function broadcastToMachine(machineId, message) {
  const subs = subscriptions.get(machineId) || new Set();
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

setBroadcast(broadcastToMachine);

function buildTimeoutInfo(instanceId, machineDefinition, currentStateId, enteredStateAt) {
  const scheduled = getTimeoutInfoForInstance(instanceId);
  if (scheduled) return scheduled;

  if (!machineDefinition || !currentStateId) {
    return { hasTimeout: false, remainingSeconds: null, timeoutEvent: null };
  }
  const currentState = machineDefinition.states.find(s => s.id === currentStateId);
  if (!currentState || !currentState.timeout) {
    return { hasTimeout: false, remainingSeconds: null, timeoutEvent: null };
  }
  const t = currentState.timeout;
  const base = enteredStateAt ? new Date(enteredStateAt).getTime() : Date.now();
  const elapsed = (Date.now() - base) / 1000;
  const remaining = Math.max(0, t.duration - elapsed);
  return {
    hasTimeout: true,
    remainingSeconds: Math.round(remaining * 10) / 10,
    timeoutEvent: t.event
  };
}

wss.on('connection', (ws) => {
  let subscribedMachine = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && msg.machineId) {
        if (subscribedMachine && subscriptions.has(subscribedMachine)) {
          subscriptions.get(subscribedMachine).delete(ws);
        }
        subscribedMachine = msg.machineId;
        if (!subscriptions.has(subscribedMachine)) {
          subscriptions.set(subscribedMachine, new Set());
        }
        subscriptions.get(subscribedMachine).add(ws);
        ws.send(JSON.stringify({ type: 'subscribed', machineId: subscribedMachine }));
      }
    } catch (e) {
      console.error('WebSocket parse error:', e);
    }
  });

  ws.on('close', () => {
    if (subscribedMachine && subscriptions.has(subscribedMachine)) {
      subscriptions.get(subscribedMachine).delete(ws);
    }
  });
});

app.get('/api/machines', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM machines ORDER BY created_at DESC');
    const machines = [];
    for (const row of rows) {
      const cntRow = await get('SELECT COUNT(*) as cnt FROM instances WHERE machine_id = ? AND is_final = 0', [row.id]);
      machines.push({
        id: row.id,
        name: row.name,
        version: row.version,
        createdAt: row.created_at,
        activeInstances: cntRow.cnt
      });
    }
    res.json(machines);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:id', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    res.json(machine);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/machines', async (req, res) => {
  try {
    const { name, states, transitions } = req.body;

    if (!name || !Array.isArray(states) || !Array.isArray(transitions)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const initialStates = states.filter(s => s.isInitial);
    const finalStates = states.filter(s => s.isFinal);

    if (initialStates.length !== 1) {
      return res.status(400).json({ error: 'Must have exactly one initial state' });
    }
    if (finalStates.length < 1) {
      return res.status(400).json({ error: 'Must have at least one final state' });
    }

    const existing = await get('SELECT MAX(version) as v FROM machines WHERE name = ?', [name]);
    const version = existing && existing.v ? existing.v + 1 : 1;

    const id = uuidv4();
    const now = new Date().toISOString();
    const definition = JSON.stringify({ states, transitions });

    await run(
      'INSERT INTO machines (id, name, version, created_at, definition) VALUES (?, ?, ?, ?, ?)',
      [id, name, version, now, definition]
    );

    res.json(await getMachineById(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/grouped', async (req, res) => {
  try {
    const groups = await getMachinesGroupedByName();
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:name/versions', async (req, res) => {
  try {
    const versions = await getMachineVersionsByName(req.params.name);
    res.json(versions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/instances', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const rows = await all(
      'SELECT * FROM instances WHERE machine_id = ? ORDER BY created_at DESC',
      [req.params.machineId]
    );

    const instances = rows.map(row => ({
      id: row.id,
      machineId: row.machine_id,
      machineVersion: machine.version,
      currentStateId: row.current_state_id,
      context: JSON.parse(row.context_data),
      createdAt: row.created_at,
      isFinal: !!row.is_final,
      timeoutInfo: buildTimeoutInfo(row.id, machine.definition, row.current_state_id, row.entered_state_at)
    }));

    res.json(instances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/machines/:machineId/instances', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const initialState = machine.definition.states.find(s => s.isInitial);
    if (!initialState) return res.status(400).json({ error: 'No initial state' });

    const context = req.body || {};
    const id = uuidv4();
    const now = new Date().toISOString();

    await run(
      'INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final, entered_state_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, machine.id, initialState.id, JSON.stringify(context), now, initialState.isFinal ? 1 : 0, now]
    );

    if (initialState.isFinal) {
      await recordStateDuration(id, machine.id, initialState.id, now, now);
    }

    if (!initialState.isFinal && initialState.timeout) {
      scheduleTimeout(id, initialState.timeout, now);
    }

    res.json({
      id,
      machineId: machine.id,
      currentStateId: initialState.id,
      context,
      createdAt: now,
      isFinal: !!initialState.isFinal,
      timeoutInfo: buildTimeoutInfo(id, machine.definition, initialState.id, now)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instances/:id', async (req, res) => {
  try {
    const row = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Instance not found' });

    const machine = await getMachineById(row.machine_id);
    const migrationHistory = await getMigrationHistory(req.params.id);

    const historyRows = await all(
      'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );

    const history = historyRows.map(h => ({
      id: h.id,
      fromStateId: h.from_state_id,
      toStateId: h.to_state_id,
      event: h.event_name,
      payload: h.payload_snapshot ? JSON.parse(h.payload_snapshot) : null,
      createdAt: h.created_at,
      triggeredBy: h.triggered_by || 'user'
    }));

    res.json({
      id: row.id,
      machineId: row.machine_id,
      machineVersion: machine ? machine.version : null,
      machineName: machine ? machine.name : null,
      currentStateId: row.current_state_id,
      context: JSON.parse(row.context_data),
      createdAt: row.created_at,
      isFinal: !!row.is_final,
      timeoutInfo: buildTimeoutInfo(row.id, machine ? machine.definition : null, row.current_state_id, row.entered_state_at),
      history,
      migrationHistory
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/migration/check', async (req, res) => {
  try {
    const { sourceMachineId, targetMachineId, instanceIds } = req.body;
    if (!sourceMachineId || !targetMachineId) {
      return res.status(400).json({ error: 'sourceMachineId and targetMachineId are required' });
    }

    const result = await checkMigratable(sourceMachineId, targetMachineId, instanceIds);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/migration/execute', async (req, res) => {
  try {
    const { sourceMachineId, targetMachineId, instanceIds, operator } = req.body;
    if (!sourceMachineId || !targetMachineId || !instanceIds || !Array.isArray(instanceIds)) {
      return res.status(400).json({ error: 'sourceMachineId, targetMachineId, and instanceIds array are required' });
    }

    const result = await executeMigration(
      sourceMachineId,
      targetMachineId,
      instanceIds,
      operator || 'user'
    );

    for (const event of result.broadcastEvents) {
      broadcastToMachine(event.targetMachineId, {
        type: 'version_migration',
        migrationId: event.migrationId,
        instanceId: event.instanceId,
        sourceMachineId: event.sourceMachineId,
        targetMachineId: event.targetMachineId,
        fromStateId: event.fromStateId,
        toStateId: event.toStateId,
        timestamp: event.timestamp,
        warnings: event.warnings
      });

      broadcastToMachine(event.sourceMachineId, {
        type: 'version_migration_out',
        migrationId: event.migrationId,
        instanceId: event.instanceId,
        sourceMachineId: event.sourceMachineId,
        targetMachineId: event.targetMachineId,
        fromStateId: event.fromStateId,
        toStateId: event.toStateId,
        timestamp: event.timestamp
      });
    }

    res.json({
      sourceMachine: result.sourceMachine,
      targetMachine: result.targetMachine,
      total: result.total,
      successCount: result.successCount,
      failedCount: result.failedCount,
      results: result.results
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/instances/:id/send', async (req, res) => {
  try {
    const { event, payload } = req.body;
    if (!event) return res.status(400).json({ error: 'Event name required' });

    const row = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Instance not found' });

    if (row.is_final) {
      return res.status(400).json({ error: 'Instance is in final state, cannot accept events' });
    }

    const machine = await getMachineById(row.machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const context = JSON.parse(row.context_data);
    const currentStateId = row.current_state_id;

    const outgoing = machine.definition.transitions.filter(
      t => t.sourceStateId === currentStateId && t.event === event
    );

    let matchedTransition = null;
    for (const t of outgoing) {
      try {
        if (evaluateGuard(t.guard, payload || {}, context)) {
          matchedTransition = t;
          break;
        }
      } catch (e) {
        console.error('Guard evaluation error:', e);
      }
    }

    if (!matchedTransition) {
      return res.status(400).json({ error: 'No matching transition for this event' });
    }

    const targetState = machine.definition.states.find(s => s.id === matchedTransition.targetStateId);
    if (!targetState) return res.status(500).json({ error: 'Target state not found' });

    const historyRows = await all(
      'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
      [req.params.id]
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
      machineId: machine.id,
      machineDefinition: machine.definition,
      instanceId: row.id,
      currentStateId,
      targetStateId: targetState.id,
      event,
      payload: payload || {},
      history,
      enteredStateAt: row.entered_state_at || row.created_at
    });

    if (!complianceCheck.allowed) {
      const now = new Date().toISOString();
      for (const v of complianceCheck.violations) {
        const alertMsg = {
          type: 'compliance_alert',
          machineId: machine.id,
          instanceId: row.id,
          policyId: v.policyId,
          policyName: v.policyName,
          policyType: v.policyType,
          eventName: event,
          fromStateId: currentStateId,
          toStateId: targetState.id,
          reason: v.reason,
          attemptedAt: now,
          currentStateId: currentStateId
        };
        broadcastToMachine(machine.id, alertMsg);
      }

      return res.status(403).json({
        error: 'Compliance check failed, transition blocked',
        complianceViolations: complianceCheck.violations
      });
    }

    const transitionId = uuidv4();
    const now = new Date().toISOString();
    const isFinal = targetState.isFinal ? 1 : 0;

    await run(
      'UPDATE instances SET current_state_id = ?, is_final = ?, entered_state_at = ? WHERE id = ?',
      [targetState.id, isFinal, now, row.id]
    );

    await run(
      'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [transitionId, row.id, currentStateId, targetState.id, event, JSON.stringify(payload || {}), now, 'user']
    );

    await recordStateDuration(row.id, row.machine_id, currentStateId, row.entered_state_at || row.created_at, now);
    if (targetState.isFinal) {
      await recordStateDuration(row.id, row.machine_id, targetState.id, now, now);
    }

    clearInstanceTimeout(row.id);
    if (!targetState.isFinal && targetState.timeout) {
      scheduleTimeout(row.id, targetState.timeout, now);
    }

    const wsMessage = {
      type: 'transition',
      instanceId: row.id,
      machineId: row.machine_id,
      fromStateId: currentStateId,
      toStateId: targetState.id,
      event,
      triggeredBy: 'user',
      timestamp: now,
      isFinal: !!isFinal
    };
    broadcastToMachine(row.machine_id, wsMessage);

    res.json({
      transitionId,
      fromStateId: currentStateId,
      toStateId: targetState.id,
      event,
      timestamp: now,
      isFinal: !!isFinal,
      triggeredBy: 'user'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function rowToTemplate(row, includeDefinition = false) {
  const tpl = {
    id: row.id,
    machineId: row.machine_id,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags_json || '[]'),
    cloneCount: row.clone_count,
    createdAt: row.created_at
  };
  if (includeDefinition) {
    tpl.definition = JSON.parse(row.definition_json);
  }
  return tpl;
}

app.post('/api/templates', async (req, res) => {
  try {
    const { machineId, description, tags } = req.body;

    if (!machineId) {
      return res.status(400).json({ error: 'machineId is required' });
    }

    const existingTpl = await get('SELECT id FROM templates WHERE machine_id = ?', [machineId]);
    if (existingTpl) {
      return res.status(409).json({ error: 'Template for this machine already exists. Delete it first to republish.' });
    }

    const machine = await getMachineById(machineId);
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const tagsArr = Array.isArray(tags) ? tags : [];

    await run(
      'INSERT INTO templates (id, machine_id, name, description, tags_json, definition_json, clone_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        machineId,
        machine.name,
        description || '',
        JSON.stringify(tagsArr),
        JSON.stringify(machine.definition),
        0,
        now
      ]
    );

    const row = await get('SELECT * FROM templates WHERE id = ?', [id]);
    res.json(rowToTemplate(row, true));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/templates', async (req, res) => {
  try {
    const { search, tag, sort } = req.query;

    let sql = 'SELECT * FROM templates WHERE 1=1';
    const params = [];

    if (search) {
      sql += ' AND (name LIKE ? OR description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    let rows = await all(sql, params);
    let templates = rows.map(r => rowToTemplate(r, false));

    if (tag) {
      templates = templates.filter(t => t.tags.includes(tag));
    }

    if (sort === 'popular') {
      templates.sort((a, b) => b.cloneCount - a.cloneCount);
    } else {
      templates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    res.json(templates);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/templates/:id', async (req, res) => {
  try {
    const row = await get('SELECT * FROM templates WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(rowToTemplate(row, true));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    const row = await get('SELECT id FROM templates WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ error: 'Template not found' });
    }
    await run('DELETE FROM templates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/templates/:id/clone', async (req, res) => {
  try {
    const tplRow = await get('SELECT * FROM templates WHERE id = ?', [req.params.id]);
    if (!tplRow) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const template = rowToTemplate(tplRow, true);
    const overrideName = req.body && req.body.name;
    const newName = overrideName || (template.name + '_copy');

    const idMap = new Map();
    const newStates = template.definition.states.map((s, i) => {
      const newId = uuidv4();
      idMap.set(s.id, newId);
      return {
        ...s,
        id: newId,
        x: typeof s.x === 'number' ? s.x : (60 + i * 200),
        y: typeof s.y === 'number' ? s.y : (100 + (i % 3) * 100)
      };
    });
    const newTransitions = template.definition.transitions.map(t => ({
      ...t,
      id: uuidv4(),
      sourceStateId: idMap.get(t.sourceStateId) || t.sourceStateId,
      targetStateId: idMap.get(t.targetStateId) || t.targetStateId
    }));

    const existing = await get('SELECT MAX(version) as v FROM machines WHERE name = ?', [newName]);
    const version = existing && existing.v ? existing.v + 1 : 1;

    const newMachineId = uuidv4();
    const now = new Date().toISOString();
    const definition = JSON.stringify({ states: newStates, transitions: newTransitions });

    await run(
      'INSERT INTO machines (id, name, version, created_at, definition) VALUES (?, ?, ?, ?, ?)',
      [newMachineId, newName, version, now, definition]
    );

    await run(
      'UPDATE templates SET clone_count = clone_count + 1 WHERE id = ?',
      [req.params.id]
    );

    const machine = await getMachineById(newMachineId);
    res.json(machine);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/metrics/state-heatmap', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const timeFilter = parseTimeFilter(req);
    const data = await getStateHeatmap(req.params.machineId, timeFilter);
    res.json({
      machineId: req.params.machineId,
      machineName: machine.name,
      timeFilter,
      states: data || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/metrics/transition-frequency', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const timeFilter = parseTimeFilter(req);
    const data = await getTransitionFrequency(req.params.machineId, timeFilter);
    res.json({
      machineId: req.params.machineId,
      machineName: machine.name,
      timeFilter,
      transitions: data || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/metrics/lifecycle', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const timeFilter = parseTimeFilter(req);
    const data = await getInstanceLifecycle(req.params.machineId, timeFilter);
    res.json({
      machineId: req.params.machineId,
      machineName: machine.name,
      timeFilter,
      ...data
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/compliance/policies', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const includeDisabled = req.query.includeDisabled === 'true' || req.query.includeDisabled === '1';
    const policies = await getPoliciesByMachineId(req.params.machineId, { includeDisabled });
    res.json(policies);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/machines/:machineId/compliance/policies', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const policy = await addPolicy({
      ...req.body,
      machineId: req.params.machineId
    });
    res.status(201).json(policy);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/compliance/policies/:id', async (req, res) => {
  try {
    const policy = await getPolicyById(req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });
    res.json(policy);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/compliance/policies/:id', async (req, res) => {
  try {
    const policy = await updatePolicy(req.params.id, req.body);
    res.json(policy);
  } catch (e) {
    if (e.message === 'Policy not found') {
      return res.status(404).json({ error: e.message });
    }
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/compliance/policies/:id', async (req, res) => {
  try {
    const deleted = await deletePolicy(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Policy not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/compliance/violations', async (req, res) => {
  try {
    const filters = {};
    if (req.query.machineId) filters.machineId = req.query.machineId;
    if (req.query.instanceId) filters.instanceId = req.query.instanceId;
    if (req.query.policyId) filters.policyId = req.query.policyId;
    if (req.query.detectedDuring) filters.detectedDuring = req.query.detectedDuring;
    if (req.query.limit) {
      const n = parseInt(req.query.limit, 10);
      if (!isNaN(n) && n > 0) filters.limit = n;
    }
    const violations = await getViolations(filters);
    res.json(violations);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/machines/:machineId/compliance/audit', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const result = await auditCompletedInstances(req.params.machineId, {
      machineDefinition: machine.definition
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/instances/:id/compliance/audit', async (req, res) => {
  try {
    const row = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Instance not found' });
    const machine = await getMachineById(row.machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const initialState = machine.definition.states.find(s => s.isInitial);
    const histRows = await all(
      'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    const history = histRows.map(h => ({
      id: h.id,
      event: h.event_name,
      fromStateId: h.from_state_id,
      toStateId: h.to_state_id,
      payload: h.payload_snapshot ? JSON.parse(h.payload_snapshot) : null,
      createdAt: h.created_at
    }));

    const result = await auditInstanceHistory({
      instanceId: row.id,
      machineId: row.machine_id,
      machineDefinition: machine.definition,
      fullHistory: history,
      initialStateId: initialState ? initialState.id : null,
      initialEnteredAt: row.created_at,
      instanceCreatedAt: row.created_at
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/compliance/violations/stats', async (req, res) => {
  try {
    const machineId = req.params.machineId;
    const machine = await getMachineById(machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

    const totalResult = await get(
      'SELECT COUNT(*) as cnt FROM compliance_violations WHERE machine_id = ? AND detected_during = ?',
      [machineId, 'runtime']
    );

    const recentResult = await get(
      'SELECT COUNT(*) as cnt FROM compliance_violations WHERE machine_id = ? AND detected_during = ? AND attempted_at >= ?',
      [machineId, 'runtime', oneMinuteAgo]
    );

    const topPolicyResult = await get(
      `SELECT cv.policy_id, cp.name as policy_name, COUNT(*) as cnt 
       FROM compliance_violations cv 
       LEFT JOIN compliance_policies cp ON cv.policy_id = cp.id 
       WHERE cv.machine_id = ? AND cv.detected_during = ? 
       GROUP BY cv.policy_id, cp.name 
       ORDER BY cnt DESC 
       LIMIT 1`,
      [machineId, 'runtime']
    );

    res.json({
      machineId,
      totalViolations: totalResult ? totalResult.cnt : 0,
      lastMinuteViolations: recentResult ? recentResult.cnt : 0,
      lastMinuteFrequency: recentResult ? recentResult.cnt : 0,
      topPolicy: topPolicyResult ? {
        policyId: topPolicyResult.policy_id,
        policyName: topPolicyResult.policy_name || '未知策略',
        count: topPolicyResult.cnt
      } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  try {
    await initDB();
    await seedDemoData();
    await rebuildAllTimers();
    server.listen(PORT, () => {
      console.log(`Workflow server running on port ${PORT}`);
    });
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
}

start();
