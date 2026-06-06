const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');

async function seedDemoData() {
  const row = await get('SELECT COUNT(*) as cnt FROM machines');
  if (row.cnt > 0) return;

  const now = new Date().toISOString();

  const s1 = { id: uuidv4(), name: '待提交', isInitial: true, isFinal: false, x: 60, y: 180 };
  const s2 = { id: uuidv4(), name: '待审批', isInitial: false, isFinal: false, x: 240, y: 180 };
  const s3 = { id: uuidv4(), name: '已批准', isInitial: false, isFinal: true, x: 420, y: 60 };
  const s4 = { id: uuidv4(), name: '已拒绝', isInitial: false, isFinal: true, x: 420, y: 300 };
  const s5 = { id: uuidv4(), name: '人工复审', isInitial: false, isFinal: false, x: 420, y: 180 };
  const s6 = { id: uuidv4(), name: '复审批准', isInitial: false, isFinal: true, x: 600, y: 60 };
  const s7 = { id: uuidv4(), name: '复审拒绝', isInitial: false, isFinal: true, x: 600, y: 300 };

  const states = [s1, s2, s3, s4, s5, s6, s7];

  const transitions = [
    { id: uuidv4(), sourceStateId: s1.id, targetStateId: s2.id, event: 'submit', guard: '' },
    { id: uuidv4(), sourceStateId: s2.id, targetStateId: s3.id, event: 'approve', guard: 'payload.amount <= 5000' },
    { id: uuidv4(), sourceStateId: s2.id, targetStateId: s5.id, event: 'approve', guard: 'payload.amount > 5000' },
    { id: uuidv4(), sourceStateId: s2.id, targetStateId: s4.id, event: 'reject', guard: '' },
    { id: uuidv4(), sourceStateId: s5.id, targetStateId: s6.id, event: 'approve', guard: '' },
    { id: uuidv4(), sourceStateId: s5.id, targetStateId: s7.id, event: 'reject', guard: '' }
  ];

  const machineId = uuidv4();
  const definition = JSON.stringify({ states, transitions });

  await run(
    'INSERT INTO machines (id, name, version, created_at, definition) VALUES (?, ?, ?, ?, ?)',
    [machineId, '订单审批', 1, now, definition]
  );

  const inst1Id = uuidv4();
  await run(
    'INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final) VALUES (?, ?, ?, ?, ?, ?)',
    [inst1Id, machineId, s2.id, JSON.stringify({ orderId: 'ORD-001', amount: 2000 }), now, 0]
  );

  const h1 = uuidv4();
  await run(
    'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [h1, inst1Id, s1.id, s2.id, 'submit', JSON.stringify({ amount: 2000, reason: '创建订单' }), now]
  );

  const inst2Id = uuidv4();
  await run(
    'INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final) VALUES (?, ?, ?, ?, ?, ?)',
    [inst2Id, machineId, s3.id, JSON.stringify({ orderId: 'ORD-002', amount: 1500 }), now, 1]
  );

  const h2 = uuidv4();
  await run(
    'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [h2, inst2Id, s1.id, s2.id, 'submit', JSON.stringify({ amount: 1500 }), now]
  );

  const h3 = uuidv4();
  await run(
    'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [h3, inst2Id, s2.id, s3.id, 'approve', JSON.stringify({ amount: 1500, approvedBy: 'manager' }), now]
  );

  console.log('Demo data seeded: 订单审批 state machine and 2 demo instances created.');
}

module.exports = { seedDemoData };
