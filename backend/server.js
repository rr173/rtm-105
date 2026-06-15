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
  auditInstanceHistory,
  auditCompletedInstances,
  recordViolation
} = require('./compliance-engine');
const {
  getMachineVersionsByName,
  checkMigratable,
  executeMigration,
  getMigrationHistory,
  getMachinesGroupedByName,
  getMachineById
} = require('./version-migration');
const {
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
} = require('./simulation-engine');
const {
  initTakeoverDB,
  TAKEOVER_STATUS,
  ACTION_TYPES,
  isInstanceFrozen,
  getFreezeInfo,
  freezeInstance,
  unfreezeInstance,
  enqueueEvent,
  getPendingEvents,
  createTakeoverSession,
  getActiveTakeoverSession,
  getTakeoverSession,
  getTakeoverSessionsByInstance,
  getTakeoverActions,
  previewActions,
  executeTakeoverAction,
  getTakeoverDashboard,
  cancelTakeoverSession,
  resumeTakeoverSession,
  completeTakeoverSession,
  processQueuedEvents
} = require('./takeover-engine');
const {
  SEVERITY,
  ISSUE_TYPES,
  analyzeMachineDefinition,
  initAnalysisDB,
  saveAnalysisReport,
  getAnalysisReportById,
  getAnalysisReportsByMachine,
  getAnalysisReportsByMachineAndVersion,
  getLatestAnalysisReport,
  runAnalysisForMachine
} = require('./static-analysis');
const {
  OPERATION_TYPE,
  addTagsToInstance,
  removeTagsFromInstance,
  getInstanceTags,
  getAllTags,
  findInstancesByTags,
  executeBatchOperation,
  listBatchOperations,
  getBatchOperationDetail
} = require('./batch-engine');
const {
  initTraceDB,
  getTraceById,
  queryTraces,
  getTracesByInstanceId,
  countTraces,
  buildAndSaveTrace,
  linkTraceToTransition,
  saveTrace
} = require('./decision-trace');

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

    const definition = { states, transitions };
    const analysisResult = analyzeMachineDefinition(definition);

    if (!analysisResult.pass) {
      return res.status(422).json({
        error: 'Static analysis failed with blocking issues. Publish blocked.',
        analysisResult
      });
    }

    const existing = await get('SELECT MAX(version) as v FROM machines WHERE name = ?', [name]);
    const version = existing && existing.v ? existing.v + 1 : 1;

    const id = uuidv4();
    const now = new Date().toISOString();

    await run(
      'INSERT INTO machines (id, name, version, created_at, definition) VALUES (?, ?, ?, ?, ?)',
      [id, name, version, now, JSON.stringify(definition)]
    );

    const machine = await getMachineById(id);
    const report = await saveAnalysisReport({
      machineId: id,
      machineVersion: version,
      machineName: name,
      analysisResult,
      triggeredBy: 'publish',
      definitionSnapshot: definition
    });

    res.json({ ...machine, latestAnalysisReport: report });
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

    const instances = await Promise.all(rows.map(async row => {
      const freezeInfo = await getFreezeInfo(row.id);
      const activeTakeover = await getActiveTakeoverSession(row.id);
      const pendingEvents = await getPendingEvents(row.id);
      const tags = await getInstanceTags(row.id);
      return {
        id: row.id,
        machineId: row.machine_id,
        machineVersion: machine.version,
        currentStateId: row.current_state_id,
        context: JSON.parse(row.context_data),
        createdAt: row.created_at,
        isFinal: !!row.is_final,
        timeoutInfo: buildTimeoutInfo(row.id, machine.definition, row.current_state_id, row.entered_state_at),
        isFrozen: freezeInfo ? freezeInfo.isFrozen : false,
        freezeInfo,
        activeTakeover,
        pendingEventCount: pendingEvents.length,
        tags
      };
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

    const freezeInfo = await getFreezeInfo(req.params.id);
    const activeTakeover = await getActiveTakeoverSession(req.params.id);
    const pendingEvents = await getPendingEvents(req.params.id);
    const takeoverSessions = await getTakeoverSessionsByInstance(req.params.id);

    const violationsRows = await all(
      'SELECT * FROM compliance_violations WHERE instance_id = ? ORDER BY attempted_at DESC LIMIT 20',
      [req.params.id]
    );
    const recentViolations = violationsRows.map(v => ({
      id: v.id,
      policyId: v.policy_id,
      policyName: v.policy_name,
      policyType: v.policy_type,
      eventName: v.event_name,
      fromStateId: v.from_state_id,
      toStateId: v.to_state_id,
      reason: v.reason,
      attemptedAt: v.attempted_at,
      detectedDuring: v.detected_during
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
      migrationHistory,
      freezeInfo,
      activeTakeover,
      pendingEvents,
      takeoverSessions,
      recentViolations
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
    const { event, payload, operatorId, operatorName } = req.body;
    if (!event) return res.status(400).json({ error: 'Event name required' });

    const row = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Instance not found' });

    if (row.is_final) {
      return res.status(400).json({ error: 'Instance is in final state, cannot accept events' });
    }

    const frozen = await isInstanceFrozen(req.params.id);
    if (frozen) {
      const queued = await enqueueEvent(req.params.id, event, payload, operatorId || 'system');
      const activeSession = await getActiveTakeoverSession(req.params.id);
      if (activeSession) {
        broadcastToMachine(row.machine_id, {
          type: 'event_queued',
          instanceId: req.params.id,
          machineId: row.machine_id,
          event,
          queuedAt: queued.receivedAt,
          takeoverSessionId: activeSession.id,
          operatorName: activeSession.operatorName
        });
      }
      return res.json({
        queued: true,
        queueId: queued.id,
        event,
        receivedAt: queued.receivedAt,
        message: 'Instance is frozen, event has been queued'
      });
    }

    const machine = await getMachineById(row.machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const context = JSON.parse(row.context_data);
    const currentStateId = row.current_state_id;

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

    const traceResult = await buildAndSaveTrace({
      machineId: machine.id,
      machineDefinition: machine.definition,
      instanceId: row.id,
      currentStateId,
      eventName: event,
      payload: payload || {},
      context,
      history,
      enteredStateAt: row.entered_state_at || row.created_at,
      triggeredBy: 'user'
    });

    if (traceResult.decisionResult === 'rejected_no_match') {
      return res.status(400).json({
        error: 'No matching transition for this event',
        traceId: traceResult.traceId,
        decisionResult: traceResult.decisionResult,
        rejectionReason: traceResult.rejectionReason
      });
    }

    if (traceResult.decisionResult === 'rejected_compliance') {
      const now = new Date().toISOString();
      for (const v of traceResult.complianceViolations) {
        try {
          await recordViolation({
            policyId: v.policyId,
            machineId: machine.id,
            instanceId: row.id,
            eventName: event,
            fromStateId: currentStateId,
            toStateId: traceResult.targetStateId,
            reason: v.reason,
            payloadSnapshot: payload,
            attemptedAt: now,
            detectedDuring: 'runtime'
          });
        } catch (e) {
          console.error('[Compliance] Failed to record violation:', e);
        }
        broadcastToMachine(machine.id, {
          type: 'compliance_alert',
          machineId: machine.id,
          instanceId: row.id,
          policyId: v.policyId,
          policyName: v.policyName,
          policyType: v.policyType,
          eventName: event,
          fromStateId: currentStateId,
          toStateId: traceResult.targetStateId,
          reason: v.reason,
          attemptedAt: now,
          currentStateId
        });
      }

      return res.status(403).json({
        error: 'Compliance check failed, transition blocked',
        complianceViolations: traceResult.complianceViolations,
        traceId: traceResult.traceId,
        decisionResult: traceResult.decisionResult,
        rejectionReason: traceResult.rejectionReason
      });
    }

    const targetState = machine.definition.states.find(s => s.id === traceResult.targetStateId);
    if (!targetState) return res.status(500).json({ error: 'Target state not found' });

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

    await linkTraceToTransition(traceResult.traceId, transitionId);

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
      triggeredBy: 'user',
      traceId: traceResult.traceId
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

app.post('/api/simulations', async (req, res) => {
  try {
    const { sourceType, sourceMachineId, sourceInstanceId, name } = req.body;
    const result = await createSimulation({ sourceType, sourceMachineId, sourceInstanceId, name });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/simulations', async (req, res) => {
  try {
    const { sourceMachineId, sourceInstanceId } = req.query;
    const result = await listSimulations({ sourceMachineId, sourceInstanceId });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/simulations/:id', async (req, res) => {
  try {
    const result = await getSimulationDetail(req.params.id);
    if (!result) return res.status(404).json({ error: 'Simulation not found' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/simulations/:id', async (req, res) => {
  try {
    const deleted = await deleteSimulation(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Simulation not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/simulations/branches/:branchId/send', async (req, res) => {
  try {
    const { event, payload } = req.body;
    if (!event) return res.status(400).json({ error: 'Event name required' });
    const result = await sendEventToBranch(req.params.branchId, { event, payload: payload || {} });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/simulations/branches/:branchId/timeout', async (req, res) => {
  try {
    const { simulateSeconds } = req.body;
    const seconds = typeof simulateSeconds === 'number' ? simulateSeconds : 0;
    const result = await simulateTimeout(req.params.branchId, { simulateSeconds: seconds });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/simulations/branches/:branchId/fork', async (req, res) => {
  try {
    const { stepIndex, name, targetMachineId } = req.body;
    if (stepIndex === undefined || stepIndex === null) {
      return res.status(400).json({ error: 'stepIndex is required' });
    }
    const result = await forkBranch(req.params.branchId, { stepIndex, name, targetMachineId });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/simulations/branches/:branchId/refresh', async (req, res) => {
  try {
    const result = await refreshFromSource(req.params.branchId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/simulations/branches/:branchId/new-from-latest', async (req, res) => {
  try {
    const { name } = req.body;
    const result = await createBranchFromLatest(req.params.branchId, { name });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/simulations/branches/:branchId', async (req, res) => {
  try {
    const result = await getBranchDetail(req.params.branchId);
    if (!result) return res.status(404).json({ error: 'Branch not found' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/simulations/branches/compare/:branchA/:branchB', async (req, res) => {
  try {
    const branchA = await getBranchDetail(req.params.branchA);
    const branchB = await getBranchDetail(req.params.branchB);
    if (!branchA || !branchB) {
      return res.status(404).json({ error: 'One or both branches not found' });
    }
    const result = compareBranches(branchA, branchB);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/takeover/dashboard', async (req, res) => {
  try {
    const filters = {};
    if (req.query.machineId) filters.machineId = req.query.machineId;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.operatorId) filters.operatorId = req.query.operatorId;

    const sessions = await getTakeoverDashboard(filters);

    const enrichedSessions = [];
    for (const session of sessions) {
      const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
      const machine = instance ? await getMachineById(instance.machine_id) : null;
      const currentState = machine?.definition.states.find(s => s.id === instance.current_state_id);
      const pendingEvents = await getPendingEvents(session.instanceId);
      const violations = await all(
        'SELECT COUNT(*) as cnt FROM compliance_violations WHERE instance_id = ? AND attempted_at > datetime("now", "-7 days")',
        [session.instanceId]
      );
      const freezeInfo = await getFreezeInfo(session.instanceId);

      enrichedSessions.push({
        ...session,
        isFrozen: freezeInfo?.isFrozen || false,
        instance: {
          id: instance?.id,
          machineId: instance?.machine_id,
          currentStateId: instance?.current_state_id,
          currentStateName: currentState?.name || instance?.current_state_id,
          isFinal: !!instance?.is_final,
          pendingEventCount: pendingEvents.length,
          recentViolationCount: violations[0]?.cnt || 0
        }
      });
    }

    const stats = {
      total: enrichedSessions.length,
      active: enrichedSessions.filter(s => s.status === TAKEOVER_STATUS.ACTIVE).length,
      observing: enrichedSessions.filter(s => s.status === TAKEOVER_STATUS.OBSERVING).length,
      resolved: enrichedSessions.filter(s => s.status === TAKEOVER_STATUS.RESOLVED).length,
      frozen: enrichedSessions.filter(s => s.isFrozen).length,
      pendingEvents: enrichedSessions.reduce((sum, s) => sum + s.instance.pendingEventCount, 0)
    };

    res.json({
      success: true,
      sessions: enrichedSessions,
      stats
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/takeover/sessions', async (req, res) => {
  try {
    const { instanceId, operatorId, operatorName, note } = req.body;
    if (!instanceId || !operatorId || !operatorName) {
      return res.status(400).json({ error: 'instanceId, operatorId, and operatorName are required' });
    }

    const session = await createTakeoverSession(instanceId, operatorId, operatorName, note);
    const instance = await get('SELECT * FROM instances WHERE id = ?', [instanceId]);

    broadcastToMachine(instance.machine_id, {
      type: 'takeover_started',
      instanceId,
      machineId: instance.machine_id,
      sessionId: session.id,
      operatorId,
      operatorName,
      startedAt: session.startedAt
    });

    res.json(session);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/takeover/sessions/:sessionId', async (req, res) => {
  try {
    const session = await getTakeoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    const actions = await getTakeoverActions(req.params.sessionId);
    const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
    const machine = instance ? await getMachineById(instance.machine_id) : null;
    const pendingEvents = await getPendingEvents(session.instanceId);
    const freezeInfo = await getFreezeInfo(session.instanceId);

    const historyRows = await all(
      'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
      [session.instanceId]
    );

    const violationRows = await all(
      'SELECT * FROM compliance_violations WHERE instance_id = ? ORDER BY attempted_at DESC LIMIT 20',
      [session.instanceId]
    );

    const currentState = machine?.definition.states.find(s => s.id === instance.current_state_id);
    const availableEvents = currentState && machine?.definition.transitions
      ? [...new Set(machine.definition.transitions
          .filter(t => t.sourceStateId === instance.current_state_id)
          .map(t => t.event))]
      : [];

    const reachableStates = machine?.definition.states.filter(s => !s.isInitial) || [];

    const stateDiagram = machine ? {
      states: machine.definition.states,
      transitions: machine.definition.transitions,
      currentStateId: instance.current_state_id
    } : null;

    function safeParseJSON(str) {
      if (!str) return {};
      if (typeof str === 'object') return str;
      try { return JSON.parse(str); } catch (e) { return {}; }
    }

    res.json({
      success: true,
      detail: {
        session,
        instance: instance ? {
          id: instance.id,
          machineId: instance.machine_id,
          currentStateId: instance.current_state_id,
          currentStateName: currentState?.name || instance.current_state_id,
          context: safeParseJSON(instance.context_data),
          isFinal: !!instance.is_final,
          freezeInfo: freezeInfo,
          activeTakeover: session.status === 'active' ? {
            operatorId: session.operatorId,
            operatorName: session.operatorName,
            sessionId: session.id
          } : null
        } : null,
        pendingEvents: pendingEvents.map(e => ({
          id: e.id,
          eventName: e.eventName,
          payload: safeParseJSON(e.payload),
          receivedAt: e.receivedAt,
          queuedBy: e.queuedBy
        })),
        flowHistory: historyRows.map(h => ({
          id: h.id,
          eventName: h.event_name,
          fromStateId: h.from_state_id,
          toStateId: h.to_state_id,
          toStateName: machine?.definition.states.find(s => s.id === h.to_state_id)?.name || h.to_state_id,
          createdAt: h.created_at,
          guardResult: h.guard_result ? JSON.parse(h.guard_result) : null,
          complianceResult: h.compliance_result ? JSON.parse(h.compliance_result) : null,
          isTimeout: h.triggered_by === 'timeout'
        })),
        actionLogs: actions.map(a => ({
          id: a.id,
          actionType: a.actionType,
          description: a.note,
          operatorId: a.operatorId,
          operatorName: a.operatorName,
          createdAt: a.actionTime,
          fromStateId: a.fromStateId,
          toStateId: a.toStateId,
          eventName: a.eventName,
          eventPayload: a.eventPayload,
          previewOnly: a.previewOnly
        })),
        recentViolations: violationRows.map(v => ({
          id: v.id,
          policyName: v.policy_name,
          reason: v.reason,
          attemptedAt: v.attempted_at,
          eventName: v.event_name
        })),
        availableEvents,
        reachableStates,
        stateDiagram
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/takeover/instances/:instanceId/sessions', async (req, res) => {
  try {
    const sessions = await getTakeoverSessionsByInstance(req.params.instanceId);
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/takeover/instances/:instanceId/preview-actions', async (req, res) => {
  try {
    const row = await get('SELECT * FROM instances WHERE id = ?', [req.params.instanceId]);
    if (!row) return res.status(404).json({ error: 'Instance not found' });

    const machine = await getMachineById(row.machine_id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const preview = await previewActions(req.params.instanceId, machine.definition);
    res.json(preview);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/takeover/sessions/:sessionId/execute', async (req, res) => {
  try {
    const { actionType, actionData, description, previewResult, operatorId, operatorName } = req.body;
    if (!actionType) {
      return res.status(400).json({ success: false, error: 'actionType is required' });
    }
    if (!operatorId || !operatorName) {
      return res.status(400).json({ success: false, error: 'operatorId and operatorName are required' });
    }

    const session = await getTakeoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    if (session.operatorId !== operatorId) {
      return res.status(403).json({ success: false, error: 'Only the takeover operator can execute actions' });
    }

    const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
    if (!instance) return res.status(404).json({ success: false, error: 'Instance not found' });

    const machine = await getMachineById(instance.machine_id);
    if (!machine) return res.status(404).json({ success: false, error: 'Machine not found' });

    const action = {
      actionType: actionType === 'inject' ? 'inject_event' :
                  actionType === 'jump' ? 'jump_to_state' :
                  actionType === 'terminate' ? 'terminate' :
                  actionType === 'context' ? 'modify_context' : actionType,
      ...actionData,
      note: description,
      previewStateId: previewResult?.targetStateId,
      previewAccepted: previewResult?.accepted
    };

    const result = await executeTakeoverAction(
      req.params.sessionId,
      action,
      operatorId,
      operatorName,
      machine.definition
    );

    broadcastToMachine(instance.machine_id, {
      type: 'takeover_action',
      instanceId: session.instanceId,
      machineId: instance.machine_id,
      sessionId: req.params.sessionId,
      actionType: action.actionType,
      operatorId,
      operatorName,
      timestamp: result.action.actionTime,
      fromStateId: result.action.fromStateId,
      toStateId: result.action.toStateId,
      eventName: result.action.eventName
    });

    if (action.actionType === ACTION_TYPES.RESUME_AUTO) {
      broadcastToMachine(instance.machine_id, {
        type: 'takeover_ended',
        instanceId: session.instanceId,
        machineId: instance.machine_id,
        sessionId: req.params.sessionId,
        operatorId,
        operatorName,
        status: TAKEOVER_STATUS.RESOLVED
      });
    }

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/takeover/sessions/:sessionId/cancel', async (req, res) => {
  try {
    const { operatorId, operatorName } = req.body;
    if (!operatorId || !operatorName) {
      return res.status(400).json({ error: 'operatorId and operatorName are required' });
    }

    const session = await getTakeoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const result = await cancelTakeoverSession(req.params.sessionId, operatorId, operatorName);

    const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
    if (instance) {
      broadcastToMachine(instance.machine_id, {
        type: 'takeover_ended',
        instanceId: session.instanceId,
        machineId: instance.machine_id,
        sessionId: req.params.sessionId,
        operatorId,
        operatorName,
        status: TAKEOVER_STATUS.CANCELLED
      });
    }

    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/takeover/sessions/:sessionId/preview', async (req, res) => {
  try {
    const { actionType, actionData } = req.body;
    if (!actionType) return res.status(400).json({ error: 'actionType is required' });

    const session = await getTakeoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
    const machine = await getMachineById(instance.machine_id);

    const preview = await previewActions(instance.id, machine.definition, actionType, actionData);
    res.json({ success: true, preview });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/takeover/sessions/:sessionId/resume', async (req, res) => {
  try {
    const { operatorId, operatorName } = req.body;
    if (!operatorId || !operatorName) {
      return res.status(400).json({ error: 'operatorId and operatorName are required' });
    }

    const session = await getTakeoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.operatorId !== operatorId) {
      return res.status(403).json({ error: 'Only the takeover operator can resume' });
    }

    const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
    const machine = await getMachineById(instance.machine_id);

    const result = await resumeTakeoverSession(req.params.sessionId, operatorId, operatorName);

    const pending = await getPendingEvents(session.instanceId);
    if (pending.length > 0) {
      await processQueuedEvents(session.instanceId, machine.definition);
    }

    broadcastToMachine(instance.machine_id, {
      type: 'takeover_action',
      instanceId: session.instanceId,
      machineId: instance.machine_id,
      sessionId: req.params.sessionId,
      actionType: 'resume',
      operatorId,
      operatorName
    });

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/takeover/sessions/:sessionId/unfreeze', async (req, res) => {
  try {
    const { operatorId, operatorName } = req.body;
    if (!operatorId || !operatorName) {
      return res.status(400).json({ error: 'operatorId and operatorName are required' });
    }

    const session = await getTakeoverSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.operatorId !== operatorId) {
      return res.status(403).json({ error: 'Only the takeover operator can unfreeze' });
    }

    const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
    const machine = await getMachineById(instance.machine_id);

    const unfreezeResult = await unfreezeInstance(session.instanceId, operatorId, operatorName);
    const completeResult = await completeTakeoverSession(req.params.sessionId, operatorId, operatorName, 'completed');

    const pending = await getPendingEvents(session.instanceId);
    if (pending.length > 0) {
      await processQueuedEvents(session.instanceId, machine.definition);
    }

    broadcastToMachine(instance.machine_id, {
      type: 'instance_unfrozen',
      instanceId: session.instanceId,
      machineId: instance.machine_id,
      unfrozenBy: operatorId,
      unfrozenByName: operatorName,
      unfrozenAt: unfreezeResult.unfrozenAt
    });

    broadcastToMachine(instance.machine_id, {
      type: 'takeover_ended',
      instanceId: session.instanceId,
      machineId: instance.machine_id,
      sessionId: req.params.sessionId,
      operatorId,
      operatorName,
      status: TAKEOVER_STATUS.RESOLVED
    });

    res.json({ success: true, ...completeResult, ...unfreezeResult });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.post('/api/instances/:id/freeze', async (req, res) => {
  try {
    const { operatorId, operatorName, reason } = req.body;
    if (!operatorId || !operatorName) {
      return res.status(400).json({ error: 'operatorId and operatorName are required' });
    }

    const result = await freezeInstance(req.params.id, operatorId, operatorName, reason);
    const instance = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);

    broadcastToMachine(instance.machine_id, {
      type: 'instance_frozen',
      instanceId: req.params.id,
      machineId: instance.machine_id,
      frozenBy: operatorId,
      frozenByName: operatorName,
      frozenAt: result.frozenAt,
      reason
    });

    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/instances/:id/unfreeze', async (req, res) => {
  try {
    const { operatorId, operatorName } = req.body;
    if (!operatorId || !operatorName) {
      return res.status(400).json({ error: 'operatorId and operatorName are required' });
    }

    const result = await unfreezeInstance(req.params.id, operatorId, operatorName);
    const instance = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);
    const machine = await getMachineById(instance.machine_id);

    broadcastToMachine(instance.machine_id, {
      type: 'instance_unfrozen',
      instanceId: req.params.id,
      machineId: instance.machine_id,
      unfrozenBy: operatorId,
      unfrozenByName: operatorName,
      unfrozenAt: result.unfrozenAt
    });

    const pending = await getPendingEvents(req.params.id);
    if (pending.length > 0 && machine) {
      const processResults = await processQueuedEvents(req.params.id, machine.definition);

      for (const r of processResults) {
        if (r.success && r.result) {
          broadcastToMachine(instance.machine_id, {
            type: 'transition',
            instanceId: req.params.id,
            machineId: instance.machine_id,
            fromStateId: r.result.fromStateId,
            toStateId: r.result.toStateId,
            event: r.eventName,
            triggeredBy: 'queued_event',
            timestamp: r.result.timestamp,
            isFinal: r.result.isFinal
          });
        }
      }
    }

    res.json({ ...result, processedEvents: pending.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/instances/:id/pending-events', async (req, res) => {
  try {
    const events = await getPendingEvents(req.params.id);
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/instances/:id/takeover', async (req, res) => {
  try {
    const { operatorId, operatorName, note } = req.body;
    if (!operatorId || !operatorName) {
      return res.status(400).json({ error: 'operatorId and operatorName are required' });
    }

    const session = await createTakeoverSession(req.params.id, operatorId, operatorName, note);
    const instance = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);

    broadcastToMachine(instance.machine_id, {
      type: 'takeover_started',
      instanceId: req.params.id,
      machineId: instance.machine_id,
      sessionId: session.id,
      operatorId,
      operatorName,
      startedAt: session.startedAt
    });

    res.json(session);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/analysis/severity-levels', async (req, res) => {
  res.json({
    blocking: SEVERITY.BLOCKING,
    warning: SEVERITY.WARNING,
    advisory: SEVERITY.ADVISORY
  });
});

app.get('/api/analysis/issue-types', async (req, res) => {
  res.json({
    unreachableState: ISSUE_TYPES.UNREACHABLE_STATE,
    deadEndState: ISSUE_TYPES.DEAD_END_STATE,
    noExitLoop: ISSUE_TYPES.NO_EXIT_LOOP,
    guardCoverageGap: ISSUE_TYPES.GUARD_COVERAGE_GAP
  });
});

app.post('/api/analysis/validate', async (req, res) => {
  try {
    const { states, transitions } = req.body;
    if (!Array.isArray(states) || !Array.isArray(transitions)) {
      return res.status(400).json({ error: 'states and transitions arrays are required' });
    }

    const result = analyzeMachineDefinition({ states, transitions });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/machines/:machineId/analysis', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const triggeredBy = (req.body && req.body.triggeredBy) || 'manual';
    const report = await runAnalysisForMachine(machine, triggeredBy);

    res.status(201).json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/analysis', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const limit = parseInt(req.query.limit, 10) || 20;
    const reports = await getAnalysisReportsByMachine(req.params.machineId, limit);
    res.json(reports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/analysis/latest', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const report = await getLatestAnalysisReport(req.params.machineId);
    if (!report) return res.status(404).json({ error: 'No analysis report found' });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/analysis/version/:version', async (req, res) => {
  try {
    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const version = parseInt(req.params.version, 10);
    if (isNaN(version)) return res.status(400).json({ error: 'Invalid version' });

    const reports = await getAnalysisReportsByMachineAndVersion(req.params.machineId, version);
    res.json(reports);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analysis/:reportId', async (req, res) => {
  try {
    const report = await getAnalysisReportById(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Analysis report not found' });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/tags', async (req, res) => {
  try {
    const tags = await getAllTags(req.params.machineId);
    res.json(tags);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instances/:id/tags', async (req, res) => {
  try {
    const tags = await getInstanceTags(req.params.id);
    res.json(tags);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/instances/:id/tags', async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array' });
    }
    const result = await addTagsToInstance(req.params.id, tags);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/instances/:id/tags', async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array' });
    }
    const result = await removeTagsFromInstance(req.params.id, tags);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/machines/:machineId/instances/by-tags', async (req, res) => {
  try {
    const { tags } = req.query;
    if (!tags) {
      return res.status(400).json({ error: 'tags query parameter is required' });
    }
    const tagArray = Array.isArray(tags) ? tags : tags.split(',').filter(t => t.trim());
    const rows = await findInstancesByTags(tagArray, req.params.machineId);

    const machine = await getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const instances = await Promise.all(rows.map(async row => {
      const freezeInfo = await getFreezeInfo(row.id);
      const activeTakeover = await getActiveTakeoverSession(row.id);
      const pendingEvents = await getPendingEvents(row.id);
      const instanceTags = await getInstanceTags(row.id);
      return {
        id: row.id,
        machineId: row.machine_id,
        machineVersion: machine.version,
        currentStateId: row.current_state_id,
        context: JSON.parse(row.context_data),
        createdAt: row.created_at,
        isFinal: !!row.is_final,
        timeoutInfo: buildTimeoutInfo(row.id, machine.definition, row.current_state_id, row.entered_state_at),
        isFrozen: freezeInfo ? freezeInfo.isFrozen : false,
        freezeInfo,
        activeTakeover,
        pendingEventCount: pendingEvents.length,
        tags: instanceTags
      };
    }));

    res.json(instances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/batch/execute', async (req, res) => {
  try {
    const { operationType, targetTags, eventName, eventPayload, operatorId, operatorName, machineId } = req.body;

    if (!operationType) {
      return res.status(400).json({ error: 'operationType is required' });
    }
    if (!Array.isArray(targetTags) || targetTags.length === 0) {
      return res.status(400).json({ error: 'targetTags must be a non-empty array' });
    }
    if (!operatorId || !operatorName) {
      return res.status(400).json({ error: 'operatorId and operatorName are required' });
    }
    if (operationType === OPERATION_TYPE.SEND_EVENT && !eventName) {
      return res.status(400).json({ error: 'eventName is required for send_event operation' });
    }

    const result = await executeBatchOperation({
      operationType,
      targetTags,
      eventName,
      eventPayload,
      operatorId,
      operatorName,
      machineId
    });

    if (!result.success && result.success === false) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/batch/operations', async (req, res) => {
  try {
    const { machineId, limit, offset } = req.query;
    const options = {};
    if (machineId) options.machineId = machineId;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    const operations = await listBatchOperations(options);
    res.json(operations);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/batch/operations/:id', async (req, res) => {
  try {
    const detail = await getBatchOperationDetail(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: 'Batch operation not found' });
    }
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/traces', async (req, res) => {
  try {
    const filters = {};
    if (req.query.instanceId) filters.instanceId = req.query.instanceId;
    if (req.query.machineId) filters.machineId = req.query.machineId;
    if (req.query.startTime) filters.startTime = req.query.startTime;
    if (req.query.endTime) filters.endTime = req.query.endTime;
    if (req.query.rejected !== undefined) filters.rejected = req.query.rejected;
    if (req.query.decisionResult) filters.decisionResult = req.query.decisionResult;
    if (req.query.limit) filters.limit = parseInt(req.query.limit, 10);
    if (req.query.offset) filters.offset = parseInt(req.query.offset, 10);

    const traces = await queryTraces(filters);
    const total = await countTraces(filters);

    res.json({
      total,
      limit: filters.limit || 50,
      offset: filters.offset || 0,
      traces
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/traces/:id', async (req, res) => {
  try {
    const trace = await getTraceById(req.params.id);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json(trace);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instances/:id/traces', async (req, res) => {
  try {
    const row = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Instance not found' });

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

    const traces = await getTracesByInstanceId(req.params.id, { limit, offset });
    const total = await countTraces({ instanceId: req.params.id });

    res.json({
      instanceId: req.params.id,
      total,
      limit,
      offset,
      traces
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function seedDemoTraces() {
  const traceCount = await get('SELECT COUNT(*) as cnt FROM decision_traces');
  if (traceCount.cnt > 0) {
    console.log('[DecisionTrace] Demo traces already exist, skipping.');
    return;
  }

  const orderMachineRow = await get('SELECT * FROM machines WHERE name = ? ORDER BY version DESC LIMIT 1', ['订单审批']);
  if (!orderMachineRow) {
    console.log('[DecisionTrace] No 订单审批 machine found, skipping demo traces.');
    return;
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

  const instanceRows = await all(
    'SELECT * FROM instances WHERE machine_id = ? ORDER BY created_at ASC LIMIT 10',
    [machine.id]
  );

  if (instanceRows.length === 0) return;

  const policies = await getPoliciesByMachineId(machine.id);
  const policyIdMap = {};
  for (const p of policies) {
    policyIdMap[p.name] = p;
  }

  const traceIdFn = uuidv4;

  for (const inst of instanceRows) {
    const transRows = await all(
      'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
      [inst.id]
    );

    for (const tr of transRows) {
      const fromState = stateMap.get(tr.from_state_id);
      const toState = stateMap.get(tr.to_state_id);
      const fromStateName = fromState ? fromState.name : tr.from_state_id;
      const toStateName = toState ? toState.name : tr.to_state_id;

      const outgoing = machine.definition.transitions.filter(
        t => t.sourceStateId === tr.from_state_id && t.event === tr.event_name
      );

      const payload = tr.payload_snapshot ? JSON.parse(tr.payload_snapshot) : {};
      const candidates = [];

      for (const t of outgoing) {
        const tgtState = stateMap.get(t.target_state_id);
        const tgtName = tgtState ? tgtState.name : t.target_state_id;
        const guardExpr = t.guard || '';
        let guardResult = false;
        let guardInput = null;

        if (!guardExpr.trim()) {
          guardResult = true;
        } else {
          guardInput = { payload, context: {} };
          try {
            guardResult = evaluateGuard(guardExpr, payload, {});
          } catch (e) {
            guardResult = false;
          }
        }

        const isSelected = t.targetStateId === tr.to_state_id;
        candidates.push({
          transitionId: t.id,
          targetStateId: t.targetStateId,
          targetStateName: tgtName,
          guardExpression: guardExpr || '(无守卫)',
          guardInput,
          guardResult,
          guardError: null,
          guardDurationMs: Math.floor(Math.random() * 3) + 1,
          passed: guardResult,
          selected: isSelected
        });
      }

      const phases = [
        {
          phase: 'candidate_matching',
          durationMs: Math.floor(Math.random() * 5) + 2,
          fromStateId: tr.from_state_id,
          fromStateName,
          eventName: tr.event_name,
          candidateCount: outgoing.length,
          candidates
        }
      ];

      const matchedCandidate = candidates.find(c => c.selected);
      if (matchedCandidate) {
        const policyResults = policies.map(p => ({
          policyId: p.id,
          policyName: p.name,
          policyType: p.type,
          enabled: true,
          result: 'pass',
          reason: null,
          detail: null,
          triggeredCondition: (p.type === 'mandatory_dwell')
            ? `在状态 [${p.config.stateName}] 停留不足 ${p.config.minSeconds} 秒时触发`
            : (p.type === 'event_rate_limit')
              ? `事件 [${p.config.eventName}] 在 ${p.config.windowSeconds} 秒内超过 ${p.config.maxCount} 次时触发`
              : null,
          durationMs: Math.floor(Math.random() * 4) + 1
        }));

        phases.push({
          phase: 'compliance_check',
          durationMs: Math.floor(Math.random() * 8) + 3,
          transitionId: matchedCandidate.transitionId,
          targetStateId: matchedCandidate.targetStateId,
          targetStateName: matchedCandidate.targetStateName,
          allowed: true,
          policyCount: policies.length,
          policies: policyResults
        });
      }

      const totalDurationMs = phases.reduce((s, p) => s + p.durationMs, 0);

      const decisionTree = {
        eventName: tr.event_name,
        fromStateId: tr.from_state_id,
        fromStateName,
        targetStateId: tr.to_state_id,
        targetStateName: toStateName,
        triggeredBy: tr.triggered_by || 'user',
        phases,
        summary: {
          candidateCount: outgoing.length,
          guardPassCount: candidates.filter(c => c.passed).length,
          complianceChecked: !!matchedCandidate,
          compliancePass: true,
          complianceViolationCount: 0
        }
      };

      await saveTrace({
        id: traceIdFn(),
        instanceId: inst.id,
        machineId: machine.id,
        transitionId: tr.id,
        eventName: tr.event_name,
        fromStateId: tr.from_state_id,
        targetStateId: tr.to_state_id,
        decisionResult: 'accepted',
        rejectionReason: null,
        decisionTree,
        totalDurationMs,
        createdAt: tr.created_at
      });
    }
  }

  const demoInstance = instanceRows[1] || instanceRows[0];
  const demoTransRows = await all(
    'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
    [demoInstance.id]
  );
  const submitTr = demoTransRows.find(t => t.event_name === 'submit');
  const approveTr = demoTransRows.find(t => t.event_name === 'approve');

  if (approveTr) {
    const fromState = stateMap.get(approveTr.from_state_id);
    const fromStateName = fromState ? fromState.name : approveTr.from_state_id;
    const payload = { amount: 3000, approvedBy: 'manager_x' };

    const outgoing = machine.definition.transitions.filter(
      t => t.sourceStateId === approveTr.from_state_id && t.event === 'approve'
    );

    const candidates = outgoing.map(t => {
      const tgtState = stateMap.get(t.targetStateId);
      const tgtName = tgtState ? tgtState.name : (t.targetStateId);
      const guardExpr = t.guard || '';
      let guardResult = false;
      let guardInput = null;
      if (!guardExpr.trim()) {
        guardResult = true;
      } else {
        guardInput = { payload, context: {} };
        try {
          guardResult = evaluateGuard(guardExpr, payload, {});
        } catch (e) {
          guardResult = false;
        }
      }
      return {
        transitionId: t.id,
        targetStateId: t.targetStateId,
        targetStateName: tgtName,
        guardExpression: guardExpr || '(无守卫)',
        guardInput,
        guardResult,
        guardError: null,
        guardDurationMs: Math.floor(Math.random() * 3) + 1,
        passed: guardResult,
        selected: false
      };
    });

    const matchedCandidate = candidates.find(c => c.passed);
    if (matchedCandidate) {
      matchedCandidate.selected = true;
    }

    const mandatoryDwellPolicy = policyIdMap['待审批最短停留5秒'];
    const rateLimitPolicy = policyIdMap['approve事件10秒内最多2次'];

    const compliancePolicies = [];
    if (mandatoryDwellPolicy) {
      compliancePolicies.push({
        policyId: mandatoryDwellPolicy.id,
        policyName: mandatoryDwellPolicy.name,
        policyType: mandatoryDwellPolicy.type,
        enabled: true,
        result: 'violation',
        reason: `状态 [待审批] 最短停留 5s, 当前仅停留 1.2s (还需 3.8s)`,
        detail: { stateName: '待审批', minSeconds: 5, elapsedSeconds: 1.2, remaining: 3.8 },
        triggeredCondition: '在状态 [待审批] 停留不足 5 秒时触发',
        durationMs: Math.floor(Math.random() * 4) + 1
      });
    }
    if (rateLimitPolicy) {
      compliancePolicies.push({
        policyId: rateLimitPolicy.id,
        policyName: rateLimitPolicy.name,
        policyType: rateLimitPolicy.type,
        enabled: true,
        result: 'pass',
        reason: null,
        detail: null,
        triggeredCondition: '事件 [approve] 在 10 秒内超过 2 次时触发',
        durationMs: Math.floor(Math.random() * 3) + 1
      });
    }

    const violationDescs = compliancePolicies
      .filter(p => p.result === 'violation')
      .map(v => `[${v.policyName}] ${v.reason}`);

    const totalDurationMs = 15;

    const decisionTree = {
      eventName: 'approve',
      fromStateId: approveTr.from_state_id,
      fromStateName,
      targetStateId: matchedCandidate ? matchedCandidate.targetStateId : null,
      targetStateName: matchedCandidate ? matchedCandidate.targetStateName : null,
      triggeredBy: 'user',
      phases: [
        {
          phase: 'candidate_matching',
          durationMs: 5,
          fromStateId: approveTr.from_state_id,
          fromStateName,
          eventName: 'approve',
          candidateCount: outgoing.length,
          candidates
        },
        {
          phase: 'compliance_check',
          durationMs: 10,
          transitionId: matchedCandidate ? matchedCandidate.transitionId : null,
          targetStateId: matchedCandidate ? matchedCandidate.targetStateId : null,
          targetStateName: matchedCandidate ? matchedCandidate.targetStateName : null,
          allowed: false,
          policyCount: policies.length,
          policies: compliancePolicies
        }
      ],
      summary: {
        candidateCount: outgoing.length,
        guardPassCount: candidates.filter(c => c.passed).length,
        complianceChecked: true,
        compliancePass: false,
        complianceViolationCount: compliancePolicies.filter(p => p.result === 'violation').length
      }
    };

    const complianceTraceTime = new Date(new Date(approveTr.created_at).getTime() - 1000).toISOString();

    await saveTrace({
      id: traceIdFn(),
      instanceId: demoInstance.id,
      machineId: machine.id,
      transitionId: null,
      eventName: 'approve',
      fromStateId: approveTr.from_state_id,
      targetStateId: null,
      decisionResult: 'rejected_compliance',
      rejectionReason: `合规引擎拦截: ${violationDescs.join('; ')}`,
      decisionTree,
      totalDurationMs,
      createdAt: complianceTraceTime
    });
  }

  if (submitTr && approveTr) {
    const rejectEventTime = new Date(new Date(submitTr.created_at).getTime() + 500).toISOString();
    const fromState = stateMap.get(submitTr.to_state_id);
    const fromStateName = fromState ? fromState.name : submitTr.to_state_id;

    const decisionTree = {
      eventName: 'cancel',
      fromStateId: submitTr.to_state_id,
      fromStateName,
      targetStateId: null,
      targetStateName: null,
      triggeredBy: 'user',
      phases: [
        {
          phase: 'candidate_matching',
          durationMs: 1,
          fromStateId: submitTr.to_state_id,
          fromStateName,
          eventName: 'cancel',
          candidateCount: 0,
          candidates: []
        }
      ],
      summary: {
        candidateCount: 0,
        guardPassCount: 0,
        complianceChecked: false,
        compliancePass: true,
        complianceViolationCount: 0
      }
    };

    await saveTrace({
      id: traceIdFn(),
      instanceId: demoInstance.id,
      machineId: machine.id,
      transitionId: null,
      eventName: 'cancel',
      fromStateId: submitTr.to_state_id,
      targetStateId: null,
      decisionResult: 'rejected_no_match',
      rejectionReason: `当前状态 [${fromStateName}] 不存在事件 [cancel] 的候选转换`,
      decisionTree,
      totalDurationMs: 1,
      createdAt: rejectEventTime
    });
  }

  console.log('[DecisionTrace] Demo traces seeded successfully.');
}

async function start() {
  try {
    await initDB();
    await initTakeoverDB();
    await initAnalysisDB();
    await initTraceDB();
    await seedDemoData();
    await seedDemoTraces();
    await rebuildAllTimers();

    const orderMachineRow = await get('SELECT * FROM machines WHERE name = ? ORDER BY version DESC LIMIT 1', ['订单审批']);
    if (orderMachineRow) {
      try {
        const orderMachine = {
          id: orderMachineRow.id,
          name: orderMachineRow.name,
          version: orderMachineRow.version,
          createdAt: orderMachineRow.created_at,
          definition: JSON.parse(orderMachineRow.definition)
        };
        const existingReport = await getLatestAnalysisReport(orderMachine.id);
        if (!existingReport) {
          const report = await runAnalysisForMachine(orderMachine, 'startup');
          console.log(`[Static Analysis] Analyzed 订单审批 state machine on startup: pass=${report.pass}, issues=${report.summary.total}, blocking=${report.summary.blockingCount}, warning=${report.summary.warningCount}`);
        } else {
          console.log(`[Static Analysis] 订单审批 state machine already has analysis report, skipping.`);
        }
      } catch (analyzeErr) {
        console.error('[Static Analysis] Failed to analyze 订单审批 state machine on startup:', analyzeErr);
      }
    }

    server.listen(PORT, () => {
      console.log(`Workflow server running on port ${PORT}`);
    });
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
}

start();
