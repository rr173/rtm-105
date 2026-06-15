const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { evaluateGuard } = require('./guard');
const { recordStateDuration } = require('./metrics');
const { checkTransitionCompliance } = require('./compliance-engine');

function getTimeoutManager() {
  return require('./timeout-manager');
}

function clearInstanceTimeout(id) {
  return getTimeoutManager().clearInstanceTimeout(id);
}

function scheduleTimeout(id, config, time) {
  return getTimeoutManager().scheduleTimeout(id, config, time);
}

function getTimeoutInfoForInstance(id) {
  return getTimeoutManager().getTimeoutInfoForInstance(id);
}

const TAKEOVER_STATUS = Object.freeze({
  ACTIVE: 'active',
  OBSERVING: 'observing',
  RESOLVED: 'resolved',
  CANCELLED: 'cancelled'
});

const ACTION_TYPES = Object.freeze({
  FREEZE: 'freeze',
  UNFREEZE: 'unfreeze',
  INJECT_EVENT: 'inject_event',
  JUMP_TO_STATE: 'jump_to_state',
  TERMINATE: 'terminate',
  OBSERVE: 'observe',
  RESUME_AUTO: 'resume_auto'
});

const QUEUE_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSED: 'processed',
  CANCELLED: 'cancelled'
});

function initTakeoverDB() {
  return new Promise((resolve, reject) => {
    const { db } = require('./db');
    db.serialize(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS instance_freeze (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          frozen_by TEXT NOT NULL,
          frozen_at TEXT NOT NULL,
          reason TEXT,
          is_frozen INTEGER NOT NULL DEFAULT 1,
          unfrozen_at TEXT,
          unfrozen_by TEXT,
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE TABLE IF NOT EXISTS takeover_sessions (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          operator_id TEXT NOT NULL,
          operator_name TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          initial_state_id TEXT NOT NULL,
          context_snapshot TEXT NOT NULL,
          history_snapshot TEXT NOT NULL,
          note TEXT,
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE TABLE IF NOT EXISTS takeover_actions (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          operator_id TEXT NOT NULL,
          operator_name TEXT NOT NULL,
          action_time TEXT NOT NULL,
          from_state_id TEXT,
          to_state_id TEXT,
          event_name TEXT,
          event_payload TEXT,
          context_before TEXT,
          context_after TEXT,
          preview_only INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          FOREIGN KEY (session_id) REFERENCES takeover_sessions(id),
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE TABLE IF NOT EXISTS instance_event_queue (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          event_payload TEXT,
          received_at TEXT NOT NULL,
          queued_by TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          processed_at TEXT,
          order_index INTEGER NOT NULL,
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE INDEX IF NOT EXISTS idx_instance_freeze_instance ON instance_freeze(instance_id);
        CREATE INDEX IF NOT EXISTS idx_instance_freeze_active ON instance_freeze(instance_id, is_frozen);
        CREATE INDEX IF NOT EXISTS idx_takeover_sessions_instance ON takeover_sessions(instance_id);
        CREATE INDEX IF NOT EXISTS idx_takeover_sessions_status ON takeover_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_takeover_sessions_operator ON takeover_sessions(operator_id);
        CREATE INDEX IF NOT EXISTS idx_takeover_actions_session ON takeover_actions(session_id);
        CREATE INDEX IF NOT EXISTS idx_takeover_actions_instance ON takeover_actions(instance_id);
        CREATE INDEX IF NOT EXISTS idx_takeover_actions_time ON takeover_actions(action_time);
        CREATE INDEX IF NOT EXISTS idx_event_queue_instance ON instance_event_queue(instance_id);
        CREATE INDEX IF NOT EXISTS idx_event_queue_pending ON instance_event_queue(instance_id, status);
        CREATE INDEX IF NOT EXISTS idx_event_queue_order ON instance_event_queue(instance_id, status, order_index);
      `, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

async function isInstanceFrozen(instanceId) {
  const row = await get(
    'SELECT * FROM instance_freeze WHERE instance_id = ? ORDER BY frozen_at DESC LIMIT 1',
    [instanceId]
  );
  return row && row.is_frozen === 1;
}

async function getFreezeInfo(instanceId) {
  const row = await get(
    'SELECT * FROM instance_freeze WHERE instance_id = ? ORDER BY frozen_at DESC LIMIT 1',
    [instanceId]
  );
  if (!row) return null;
  return {
    id: row.id,
    instanceId: row.instance_id,
    frozenBy: row.frozen_by,
    frozenAt: row.frozen_at,
    reason: row.reason,
    isFrozen: row.is_frozen === 1,
    unfrozenAt: row.unfrozen_at,
    unfrozenBy: row.unfrozen_by
  };
}

async function freezeInstance(instanceId, operatorId, operatorName, reason) {
  const instance = await get('SELECT * FROM instances WHERE id = ?', [instanceId]);
  if (!instance) {
    throw new Error('Instance not found');
  }

  const existingFreeze = await getFreezeInfo(instanceId);
  if (existingFreeze && existingFreeze.isFrozen) {
    throw new Error('Instance is already frozen');
  }

  const activeSession = await getActiveTakeoverSession(instanceId);
  if (activeSession && activeSession.operatorId !== operatorId) {
    throw new Error(`Instance is already being taken over by ${activeSession.operatorName}`);
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  await run(
    'INSERT INTO instance_freeze (id, instance_id, frozen_by, frozen_at, reason, is_frozen) VALUES (?, ?, ?, ?, ?, 1)',
    [id, instanceId, operatorId, now, reason || '']
  );

  clearInstanceTimeout(instanceId);

  return {
    id,
    instanceId,
    frozenBy: operatorId,
    frozenByName: operatorName,
    frozenAt: now,
    reason,
    isFrozen: true
  };
}

async function unfreezeInstance(instanceId, operatorId, operatorName) {
  const freezeInfo = await getFreezeInfo(instanceId);
  if (!freezeInfo || !freezeInfo.isFrozen) {
    throw new Error('Instance is not frozen');
  }

  const now = new Date().toISOString();

  await run(
    'UPDATE instance_freeze SET is_frozen = 0, unfrozen_at = ?, unfrozen_by = ? WHERE id = ?',
    [now, operatorId, freezeInfo.id]
  );

  return {
    instanceId,
    unfrozenAt: now,
    unfrozenBy: operatorId,
    unfrozenByName: operatorName
  };
}

async function enqueueEvent(instanceId, eventName, payload, queuedBy) {
  const now = new Date().toISOString();
  const id = uuidv4();

  const maxOrder = await get(
    'SELECT COALESCE(MAX(order_index), 0) as max_idx FROM instance_event_queue WHERE instance_id = ?',
    [instanceId]
  );
  const orderIndex = (maxOrder ? maxOrder.max_idx : 0) + 1;

  await run(
    'INSERT INTO instance_event_queue (id, instance_id, event_name, event_payload, received_at, queued_by, status, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, instanceId, eventName, payload ? JSON.stringify(payload) : null, now, queuedBy || 'system', QUEUE_STATUS.PENDING, orderIndex]
  );

  return {
    id,
    instanceId,
    eventName,
    payload,
    receivedAt: now,
    status: QUEUE_STATUS.PENDING,
    orderIndex
  };
}

async function getPendingEvents(instanceId) {
  const rows = await all(
    'SELECT * FROM instance_event_queue WHERE instance_id = ? AND status = ? ORDER BY order_index ASC',
    [instanceId, QUEUE_STATUS.PENDING]
  );
  return rows.map(r => ({
    id: r.id,
    instanceId: r.instance_id,
    eventName: r.event_name,
    payload: r.event_payload ? JSON.parse(r.event_payload) : null,
    receivedAt: r.received_at,
    queuedBy: r.queued_by,
    status: r.status,
    orderIndex: r.order_index
  }));
}

async function processQueuedEvents(instanceId, machineDefinition) {
  const pendingEvents = await getPendingEvents(instanceId);
  const results = [];

  for (const event of pendingEvents) {
    try {
      const result = await processSingleEvent(instanceId, event.eventName, event.payload, machineDefinition);
      await run(
        'UPDATE instance_event_queue SET status = ?, processed_at = ? WHERE id = ?',
        [QUEUE_STATUS.PROCESSED, new Date().toISOString(), event.id]
      );
      results.push({ ...event, success: true, result });
    } catch (e) {
      results.push({ ...event, success: false, error: e.message });
    }
  }

  return results;
}

async function processSingleEvent(instanceId, eventName, payload, machineDefinition) {
  const row = await get('SELECT * FROM instances WHERE id = ?', [instanceId]);
  if (!row) throw new Error('Instance not found');
  if (row.is_final) throw new Error('Instance is in final state');

  const context = JSON.parse(row.context_data);
  const currentStateId = row.current_state_id;

  const outgoing = machineDefinition.transitions.filter(
    t => t.sourceStateId === currentStateId && t.event === eventName
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
    throw new Error('No matching transition for this event');
  }

  const targetState = machineDefinition.states.find(s => s.id === matchedTransition.targetStateId);
  if (!targetState) throw new Error('Target state not found');

  const historyRows = await all(
    'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
    [instanceId]
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
    machineId: row.machine_id,
    machineDefinition,
    instanceId,
    currentStateId,
    targetStateId: targetState.id,
    event: eventName,
    payload: payload || {},
    history,
    enteredStateAt: row.entered_state_at || row.created_at
  });

  if (!complianceCheck.allowed) {
    throw new Error('Compliance check failed');
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
    [transitionId, row.id, currentStateId, targetState.id, eventName, JSON.stringify(payload || {}), now, 'queued_event']
  );

  await recordStateDuration(row.id, row.machine_id, currentStateId, row.entered_state_at || row.created_at, now);
  if (targetState.isFinal) {
    await recordStateDuration(row.id, row.machine_id, targetState.id, now, now);
  }

  clearInstanceTimeout(row.id);
  if (!targetState.isFinal && targetState.timeout) {
    scheduleTimeout(row.id, targetState.timeout, now);
  }

  return {
    transitionId,
    fromStateId: currentStateId,
    toStateId: targetState.id,
    event: eventName,
    timestamp: now,
    isFinal: !!isFinal
  };
}

async function createTakeoverSession(instanceId, operatorId, operatorName, note) {
  const instance = await get('SELECT * FROM instances WHERE id = ?', [instanceId]);
  if (!instance) throw new Error('Instance not found');

  const activeSession = await getActiveTakeoverSession(instanceId);
  if (activeSession) {
    if (activeSession.operatorId === operatorId) {
      return activeSession;
    }
    throw new Error(`Instance is already being taken over by ${activeSession.operatorName}`);
  }

  const existingFreeze = await getFreezeInfo(instanceId);
  let freezeResult;
  if (existingFreeze && existingFreeze.isFrozen) {
    if (existingFreeze.frozenBy !== operatorId) {
      throw new Error(`Instance is frozen by ${existingFreeze.frozenBy}`);
    }
    freezeResult = existingFreeze;
  } else {
    freezeResult = await freezeInstance(instanceId, operatorId, operatorName, note);
  }

  const historyRows = await all(
    'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
    [instanceId]
  );

  const id = uuidv4();
  const now = new Date().toISOString();

  await run(
    `INSERT INTO takeover_sessions (id, instance_id, operator_id, operator_name, status, started_at, initial_state_id, context_snapshot, history_snapshot, note) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      instanceId,
      operatorId,
      operatorName,
      TAKEOVER_STATUS.ACTIVE,
      now,
      instance.current_state_id,
      instance.context_data,
      JSON.stringify(historyRows),
      note || ''
    ]
  );

  await recordTakeoverAction({
    sessionId: id,
    instanceId,
    actionType: ACTION_TYPES.FREEZE,
    operatorId,
    operatorName,
    fromStateId: instance.current_state_id,
    toStateId: instance.current_state_id,
    note: note || 'Start manual takeover session'
  });

  return getTakeoverSession(id);
}

async function getActiveTakeoverSession(instanceId) {
  const row = await get(
    'SELECT * FROM takeover_sessions WHERE instance_id = ? AND status IN (?, ?) ORDER BY started_at DESC LIMIT 1',
    [instanceId, TAKEOVER_STATUS.ACTIVE, TAKEOVER_STATUS.OBSERVING]
  );
  if (!row) return null;
  return {
    id: row.id,
    instanceId: row.instance_id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    initialStateId: row.initial_state_id,
    note: row.note
  };
}

async function getTakeoverSession(sessionId) {
  const row = await get('SELECT * FROM takeover_sessions WHERE id = ?', [sessionId]);
  if (!row) return null;
  return {
    id: row.id,
    instanceId: row.instance_id,
    operatorId: row.operator_id,
    operatorName: row.operator_name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    initialStateId: row.initial_state_id,
    note: row.note
  };
}

async function getTakeoverSessionsByInstance(instanceId) {
  const rows = await all(
    'SELECT * FROM takeover_sessions WHERE instance_id = ? ORDER BY started_at DESC',
    [instanceId]
  );
  return rows.map(r => ({
    id: r.id,
    instanceId: r.instance_id,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    initialStateId: r.initial_state_id,
    note: r.note
  }));
}

async function recordTakeoverAction({
  sessionId,
  instanceId,
  actionType,
  operatorId,
  operatorName,
  fromStateId,
  toStateId,
  eventName,
  eventPayload,
  contextBefore,
  contextAfter,
  previewOnly = false,
  note
}) {
  const id = uuidv4();
  const now = new Date().toISOString();

  await run(
    `INSERT INTO takeover_actions (
      id, session_id, instance_id, action_type, operator_id, operator_name,
      action_time, from_state_id, to_state_id, event_name, event_payload,
      context_before, context_after, preview_only, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, sessionId, instanceId, actionType, operatorId, operatorName,
      now, fromStateId, toStateId, eventName,
      eventPayload ? JSON.stringify(eventPayload) : null,
      contextBefore ? JSON.stringify(contextBefore) : null,
      contextAfter ? JSON.stringify(contextAfter) : null,
      previewOnly ? 1 : 0, note || ''
    ]
  );

  return {
    id,
    sessionId,
    instanceId,
    actionType,
    operatorId,
    operatorName,
    actionTime: now,
    fromStateId,
    toStateId,
    eventName,
    eventPayload,
    previewOnly,
    note
  };
}

async function getTakeoverActions(sessionId) {
  const rows = await all(
    'SELECT * FROM takeover_actions WHERE session_id = ? ORDER BY action_time ASC',
    [sessionId]
  );
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    instanceId: r.instance_id,
    actionType: r.action_type,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    actionTime: r.action_time,
    fromStateId: r.from_state_id,
    toStateId: r.to_state_id,
    eventName: r.event_name,
    eventPayload: r.event_payload ? JSON.parse(r.event_payload) : null,
    previewOnly: r.preview_only === 1,
    note: r.note
  }));
}

function previewTransition(machineDefinition, currentStateId, context, eventName, payload) {
  const outgoing = machineDefinition.transitions.filter(
    t => t.sourceStateId === currentStateId && t.event === eventName
  );

  const results = [];

  for (const t of outgoing) {
    try {
      const guardPassed = evaluateGuard(t.guard, payload || {}, context);
      const targetState = machineDefinition.states.find(s => s.id === t.targetStateId);
      results.push({
        transition: t,
        targetState,
        guardPassed,
        guard: t.guard
      });
    } catch (e) {
      results.push({
        transition: t,
        guardPassed: false,
        error: e.message
      });
    }
  }

  return results;
}

async function previewActions(instanceId, machineDefinition) {
  const instance = await get('SELECT * FROM instances WHERE id = ?', [instanceId]);
  if (!instance) throw new Error('Instance not found');

  const context = JSON.parse(instance.context_data);
  const currentStateId = instance.current_state_id;
  const currentState = machineDefinition.states.find(s => s.id === currentStateId);

  const outgoing = machineDefinition.transitions.filter(t => t.sourceStateId === currentStateId);
  const events = [...new Set(outgoing.map(t => t.event))];

  const eventPreviews = events.map(event => ({
    actionType: 'inject_event',
    event,
    description: `Inject event "${event}"`,
    possibleOutcomes: previewTransition(machineDefinition, currentStateId, context, event, {})
  }));

  const reachableStates = machineDefinition.states.filter(s => {
    if (s.id === currentStateId) return false;
    return true;
  }).map(s => ({
    actionType: 'jump_to_state',
    targetStateId: s.id,
    targetStateName: s.name,
    isFinal: !!s.isFinal,
    description: `Jump directly to state "${s.name}"`
  }));

  const terminatePreview = {
    actionType: 'terminate',
    description: 'Terminate instance immediately',
    targetStateName: 'TERMINATED'
  };

  return {
    currentState: currentState,
    context,
    availableActions: [
      ...eventPreviews,
      ...reachableStates,
      terminatePreview
    ]
  };
}

async function executeTakeoverAction(sessionId, action, operatorId, operatorName, machineDefinition) {
  const session = await getTakeoverSession(sessionId);
  if (!session) throw new Error('Takeover session not found');
  if (session.status !== TAKEOVER_STATUS.ACTIVE) {
    throw new Error('Takeover session is not active');
  }
  if (session.operatorId !== operatorId) {
    throw new Error('Only the session operator can execute actions');
  }

  const instance = await get('SELECT * FROM instances WHERE id = ?', [session.instanceId]);
  if (!instance) throw new Error('Instance not found');

  const contextBefore = JSON.parse(instance.context_data);
  const fromStateId = instance.current_state_id;
  let contextAfter = contextBefore;
  let toStateId = fromStateId;
  let eventName = null;
  let eventPayload = null;

  switch (action.actionType) {
    case ACTION_TYPES.INJECT_EVENT: {
      eventName = action.eventName || action.event;
      eventPayload = action.payload || {};

      const result = await processSingleEvent(session.instanceId, eventName, eventPayload, machineDefinition);
      toStateId = result.toStateId;
      contextAfter = JSON.parse((await get('SELECT context_data FROM instances WHERE id = ?', [session.instanceId])).context_data);
      break;
    }

    case ACTION_TYPES.JUMP_TO_STATE: {
      toStateId = action.targetStateId;
      const targetState = machineDefinition.states.find(s => s.id === toStateId);
      if (!targetState) throw new Error('Target state not found');

      const now = new Date().toISOString();
      const isFinal = targetState.isFinal ? 1 : 0;

      if (action.context) {
        contextAfter = { ...contextBefore, ...action.context };
      }

      await run(
        'UPDATE instances SET current_state_id = ?, is_final = ?, entered_state_at = ?, context_data = ? WHERE id = ?',
        [toStateId, isFinal, now, JSON.stringify(contextAfter), session.instanceId]
      );

      await run(
        'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), session.instanceId, fromStateId, toStateId, '__manual_jump__', JSON.stringify(action.context || {}), now, 'manual_takeover']
      );

      await recordStateDuration(session.instanceId, instance.machine_id, fromStateId, instance.entered_state_at || instance.created_at, now);
      if (targetState.isFinal) {
        await recordStateDuration(session.instanceId, instance.machine_id, toStateId, now, now);
      }

      clearInstanceTimeout(session.instanceId);
      if (!targetState.isFinal && targetState.timeout) {
        scheduleTimeout(session.instanceId, targetState.timeout, now);
      }
      break;
    }

    case ACTION_TYPES.TERMINATE: {
      const now = new Date().toISOString();
      const finalStates = machineDefinition.states.filter(s => s.isFinal);
      const terminateState = finalStates[0] || { id: '__terminated__', name: 'Terminated', isFinal: true };
      toStateId = terminateState.id;

      await run(
        'UPDATE instances SET current_state_id = ?, is_final = 1, entered_state_at = ? WHERE id = ?',
        [toStateId, now, session.instanceId]
      );

      await run(
        'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), session.instanceId, fromStateId, toStateId, '__terminate__', JSON.stringify({ reason: action.reason || 'Manual termination' }), now, 'manual_takeover']
      );

      await recordStateDuration(session.instanceId, instance.machine_id, fromStateId, instance.entered_state_at || instance.created_at, now);
      clearInstanceTimeout(session.instanceId);
      break;
    }

    case ACTION_TYPES.OBSERVE: {
      await run(
        'UPDATE takeover_sessions SET status = ? WHERE id = ?',
        [TAKEOVER_STATUS.OBSERVING, sessionId]
      );
      break;
    }

    case ACTION_TYPES.RESUME_AUTO: {
      await run(
        'UPDATE takeover_sessions SET status = ?, ended_at = ? WHERE id = ?',
        [TAKEOVER_STATUS.RESOLVED, new Date().toISOString(), sessionId]
      );

      await unfreezeInstance(session.instanceId, operatorId, operatorName);

      const processResults = await processQueuedEvents(session.instanceId, machineDefinition);
      break;
    }

    default:
      throw new Error(`Unknown action type: ${action.actionType}`);
  }

  const actionRecord = await recordTakeoverAction({
    sessionId,
    instanceId: session.instanceId,
    actionType: action.actionType,
    operatorId,
    operatorName,
    fromStateId,
    toStateId,
    eventName,
    eventPayload,
    contextBefore,
    contextAfter,
    previewOnly: false,
    note: action.note || ''
  });

  return {
    success: true,
    action: actionRecord,
    newStateId: toStateId,
    newContext: contextAfter
  };
}

async function getTakeoverDashboard(filters = {}) {
  let sql = `
    SELECT 
      t.id as session_id,
      t.instance_id,
      t.operator_id,
      t.operator_name,
      t.status,
      t.started_at,
      t.note,
      i.current_state_id,
      i.machine_id,
      m.name as machine_name,
      m.version as machine_version,
      'has_session' as record_type
    FROM takeover_sessions t
    JOIN instances i ON t.instance_id = i.id
    JOIN machines m ON i.machine_id = m.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.machineId) {
    sql += ' AND i.machine_id = ?';
    params.push(filters.machineId);
  }
  if (filters.status) {
    sql += ' AND t.status = ?';
    params.push(filters.status);
  }
  if (filters.operatorId) {
    sql += ' AND t.operator_id = ?';
    params.push(filters.operatorId);
  }

  sql += `
    UNION ALL
    SELECT 
      NULL as session_id,
      f.instance_id,
      f.frozen_by as operator_id,
      f.frozen_by as operator_name,
      'frozen_only' as status,
      f.frozen_at as started_at,
      f.reason as note,
      i.current_state_id,
      i.machine_id,
      m.name as machine_name,
      m.version as machine_version,
      'frozen_only' as record_type
    FROM instance_freeze f
    JOIN instances i ON f.instance_id = i.id
    JOIN machines m ON i.machine_id = m.id
    WHERE f.is_frozen = 1
      AND f.instance_id NOT IN (SELECT instance_id FROM takeover_sessions WHERE status IN ('active', 'observing'))
  `;

  if (filters.machineId) {
    sql += ' AND i.machine_id = ?';
    params.push(filters.machineId);
  }

  sql += ' ORDER BY started_at DESC';

  const rows = await all(sql, params);

  return Promise.all(rows.map(async r => {
    const freezeInfo = await getFreezeInfo(r.instance_id);
    const pendingEvents = await getPendingEvents(r.instance_id);
    return {
      sessionId: r.session_id,
      instanceId: r.instance_id,
      machineId: r.machine_id,
      machineName: r.machine_name,
      machineVersion: r.machine_version,
      operatorId: r.operator_id,
      operatorName: r.operator_name,
      status: r.status,
      startedAt: r.started_at,
      currentStateId: r.current_state_id,
      note: r.note,
      isFrozen: freezeInfo ? freezeInfo.isFrozen : false,
      pendingEventCount: pendingEvents.length,
      recordType: r.record_type
    };
  }));
}

async function cancelTakeoverSession(sessionId, operatorId, operatorName) {
  const session = await get('SELECT * FROM takeover_sessions WHERE id = ?', [sessionId]);
  if (!session) throw new Error('Takeover session not found');
  if (session.operator_id !== operatorId) {
    throw new Error('Only the session operator can cancel');
  }
  if (session.status === TAKEOVER_STATUS.RESOLVED || session.status === TAKEOVER_STATUS.CANCELLED) {
    throw new Error('Session already ended');
  }

  await run(
    'UPDATE takeover_sessions SET status = ?, ended_at = ? WHERE id = ?',
    [TAKEOVER_STATUS.CANCELLED, new Date().toISOString(), sessionId]
  );

  await unfreezeInstance(session.instance_id, operatorId, operatorName);

  await recordTakeoverAction({
    sessionId,
    instanceId: session.instance_id,
    actionType: ACTION_TYPES.UNFREEZE,
    operatorId,
    operatorName,
    fromStateId: session.initial_state_id,
    toStateId: session.initial_state_id,
    note: 'Takeover session cancelled, resuming normal operation'
  });

  return { success: true };
}

async function resumeTakeoverSession(sessionId, operatorId, operatorName) {
  const session = await get('SELECT * FROM takeover_sessions WHERE id = ?', [sessionId]);
  if (!session) throw new Error('Session not found');
  if (session.operator_id !== operatorId) throw new Error('Not authorized to resume this session');

  await recordTakeoverAction({
    sessionId,
    instanceId: session.instance_id,
    actionType: ACTION_TYPES.RESUME_AUTO,
    operatorId,
    operatorName,
    fromStateId: session.initial_state_id,
    toStateId: session.initial_state_id,
    note: 'Resumed automatic event processing while remaining frozen for observation'
  });

  return { success: true, message: 'Instance resumed processing queued events' };
}

async function completeTakeoverSession(sessionId, operatorId, operatorName, status = 'resolved') {
  const session = await get('SELECT * FROM takeover_sessions WHERE id = ?', [sessionId]);
  if (!session) throw new Error('Session not found');
  if (session.operator_id !== operatorId) throw new Error('Not authorized to complete this session');

  const now = new Date().toISOString();
  await run(
    'UPDATE takeover_sessions SET status = ?, ended_at = ? WHERE id = ?',
    [status, now, sessionId]
  );

  await recordTakeoverAction({
    sessionId,
    instanceId: session.instance_id,
    actionType: ACTION_TYPES.UNFREEZE,
    operatorId,
    operatorName,
    fromStateId: session.initial_state_id,
    toStateId: session.initial_state_id,
    note: 'Takeover session completed, instance unfrozen'
  });

  return { success: true, endedAt: now, status };
}

module.exports = {
  initTakeoverDB,
  TAKEOVER_STATUS,
  ACTION_TYPES,
  QUEUE_STATUS,
  isInstanceFrozen,
  getFreezeInfo,
  freezeInstance,
  unfreezeInstance,
  enqueueEvent,
  getPendingEvents,
  processQueuedEvents,
  createTakeoverSession,
  getActiveTakeoverSession,
  getTakeoverSession,
  getTakeoverSessionsByInstance,
  getTakeoverActions,
  recordTakeoverAction,
  previewActions,
  executeTakeoverAction,
  getTakeoverDashboard,
  cancelTakeoverSession,
  processSingleEvent,
  resumeTakeoverSession,
  completeTakeoverSession
};
