const { all, get, run } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { evaluateGuard } = require('./guard');

const activeTimers = new Map();

let broadcastFn = null;
function setBroadcast(fn) {
  broadcastFn = fn;
}

function getTimeoutInfoForInstance(instanceId) {
  const entry = activeTimers.get(instanceId);
  if (!entry) return null;
  const { timeoutConfig, enteredAt } = entry;
  if (!timeoutConfig) return null;
  const elapsed = (Date.now() - new Date(enteredAt).getTime()) / 1000;
  const remaining = Math.max(0, timeoutConfig.duration - elapsed);
  return {
    hasTimeout: true,
    remainingSeconds: Math.round(remaining * 10) / 10,
    timeoutEvent: timeoutConfig.event
  };
}

function clearInstanceTimeout(instanceId) {
  const entry = activeTimers.get(instanceId);
  if (entry && entry.timerId) {
    clearTimeout(entry.timerId);
  }
  activeTimers.delete(instanceId);
}

async function sendTimeoutEvent(instanceId, timeoutConfig) {
  const { event, payload } = timeoutConfig;

  const row = await get('SELECT * FROM instances WHERE id = ?', [instanceId]);
  if (!row) {
    console.log(`[Timeout] Instance ${instanceId} not found, skipping timeout event ${event}`);
    return;
  }
  if (row.is_final) {
    console.log(`[Timeout] Instance ${instanceId} is final, skipping timeout event ${event}`);
    clearInstanceTimeout(instanceId);
    return;
  }

  const machineRow = await get('SELECT * FROM machines WHERE id = ?', [row.machine_id]);
  if (!machineRow) {
    console.log(`[Timeout] Machine ${row.machine_id} not found for instance ${instanceId}`);
    return;
  }
  const definition = JSON.parse(machineRow.definition);
  const context = JSON.parse(row.context_data);
  const currentStateId = row.current_state_id;

  const currentState = definition.states.find(s => s.id === currentStateId);
  if (!currentState || !currentState.timeout || currentState.timeout.event !== event) {
    console.log(`[Timeout] State ${currentStateId} no longer has matching timeout for instance ${instanceId}`);
    clearInstanceTimeout(instanceId);
    return;
  }

  const outgoing = definition.transitions.filter(
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
      console.error('Guard evaluation error during timeout:', e);
    }
  }

  if (!matchedTransition) {
    console.log(`[Timeout] No matching transition for event ${event} on instance ${instanceId}, state unchanged`);
    clearInstanceTimeout(instanceId);
    return;
  }

  const targetState = definition.states.find(s => s.id === matchedTransition.targetStateId);
  if (!targetState) {
    console.error(`[Timeout] Target state ${matchedTransition.targetStateId} not found`);
    return;
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
    [transitionId, row.id, currentStateId, targetState.id, event, JSON.stringify(payload || {}), now, 'timeout']
  );

  clearInstanceTimeout(instanceId);

  if (broadcastFn) {
    broadcastFn(row.machine_id, {
      type: 'transition',
      instanceId: row.id,
      machineId: row.machine_id,
      fromStateId: currentStateId,
      toStateId: targetState.id,
      event,
      triggeredBy: 'timeout',
      timestamp: now,
      isFinal: !!isFinal
    });
  }

  console.log(`[Timeout] Instance ${instanceId} transitioned from ${currentStateId} to ${targetState.id} via timeout event ${event}`);

  if (!isFinal && targetState.timeout) {
    scheduleTimeout(instanceId, targetState.timeout, now);
  }
}

function scheduleTimeout(instanceId, timeoutConfig, enteredAt) {
  if (!timeoutConfig || typeof timeoutConfig.duration !== 'number' || !timeoutConfig.event) {
    return;
  }

  clearInstanceTimeout(instanceId);

  const elapsedMs = Date.now() - new Date(enteredAt).getTime();
  const totalMs = timeoutConfig.duration * 1000;
  const remainingMs = Math.max(0, totalMs - elapsedMs);

  const timerId = setTimeout(() => {
    sendTimeoutEvent(instanceId, timeoutConfig).catch(err => {
      console.error(`[Timeout] Error processing timeout for instance ${instanceId}:`, err);
    });
  }, remainingMs);

  activeTimers.set(instanceId, { timerId, timeoutConfig, enteredAt });
}

async function rebuildAllTimers() {
  console.log('[Timeout] Rebuilding timeout timers from database...');

  const rows = await all(`
    SELECT i.*, m.definition
    FROM instances i
    JOIN machines m ON i.machine_id = m.id
    WHERE i.is_final = 0
  `);

  let rebuilt = 0;
  for (const row of rows) {
    try {
      const definition = JSON.parse(row.definition);
      const currentState = definition.states.find(s => s.id === row.current_state_id);
      if (currentState && currentState.timeout) {
        const enteredAt = row.entered_state_at || row.created_at;
        scheduleTimeout(row.id, currentState.timeout, enteredAt);
        rebuilt++;
      }
    } catch (e) {
      console.error(`[Timeout] Failed to rebuild timer for instance ${row.id}:`, e);
    }
  }

  console.log(`[Timeout] Rebuilt ${rebuilt} timeout timers.`);
}

module.exports = {
  scheduleTimeout,
  clearInstanceTimeout,
  rebuildAllTimers,
  getTimeoutInfoForInstance,
  setBroadcast
};
