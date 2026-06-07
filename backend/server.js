const express = require('express');
const http = require('http');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const { run, get, all, initDB } = require('./db');
const { evaluateGuard } = require('./guard');
const { seedDemoData } = require('./seed');

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
      currentStateId: row.current_state_id,
      context: JSON.parse(row.context_data),
      createdAt: row.created_at,
      isFinal: !!row.is_final
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
      'INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final) VALUES (?, ?, ?, ?, ?, ?)',
      [id, machine.id, initialState.id, JSON.stringify(context), now, initialState.isFinal ? 1 : 0]
    );

    res.json({
      id,
      machineId: machine.id,
      currentStateId: initialState.id,
      context,
      createdAt: now,
      isFinal: !!initialState.isFinal
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instances/:id', async (req, res) => {
  try {
    const row = await get('SELECT * FROM instances WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Instance not found' });

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
      createdAt: h.created_at
    }));

    res.json({
      id: row.id,
      machineId: row.machine_id,
      currentStateId: row.current_state_id,
      context: JSON.parse(row.context_data),
      createdAt: row.created_at,
      isFinal: !!row.is_final,
      history
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

    const transitionId = uuidv4();
    const now = new Date().toISOString();
    const isFinal = targetState.isFinal ? 1 : 0;

    await run(
      'UPDATE instances SET current_state_id = ?, is_final = ? WHERE id = ?',
      [targetState.id, isFinal, row.id]
    );

    await run(
      'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [transitionId, row.id, currentStateId, targetState.id, event, JSON.stringify(payload || {}), now]
    );

    const wsMessage = {
      type: 'transition',
      instanceId: row.id,
      machineId: row.machine_id,
      fromStateId: currentStateId,
      toStateId: targetState.id,
      event,
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
      isFinal: !!isFinal
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  try {
    await initDB();
    await seedDemoData();
    server.listen(PORT, () => {
      console.log(`Workflow server running on port ${PORT}`);
    });
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
}

start();
