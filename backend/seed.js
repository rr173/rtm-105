const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');

async function seedDemoData() {
  const row = await get('SELECT COUNT(*) as cnt FROM machines');
  const templateRow = await get('SELECT COUNT(*) as cnt FROM templates');

  const now = new Date().toISOString();
  let orderMachineId = null;

  if (row.cnt === 0) {
    const s1 = { id: uuidv4(), name: '待提交', isInitial: true, isFinal: false, x: 60, y: 180 };
    const s2 = {
      id: uuidv4(), name: '待审批', isInitial: false, isFinal: false, x: 240, y: 180,
      timeout: { duration: 30, event: 'timeout_reject', payload: { reason: '审批超时自动拒绝' } }
    };
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
      { id: uuidv4(), sourceStateId: s2.id, targetStateId: s4.id, event: 'timeout_reject', guard: '' },
      { id: uuidv4(), sourceStateId: s5.id, targetStateId: s6.id, event: 'approve', guard: '' },
      { id: uuidv4(), sourceStateId: s5.id, targetStateId: s7.id, event: 'reject', guard: '' }
    ];

    orderMachineId = uuidv4();
    const definition = JSON.stringify({ states, transitions });

    await run(
      'INSERT INTO machines (id, name, version, created_at, definition) VALUES (?, ?, ?, ?, ?)',
      [orderMachineId, '订单审批', 1, now, definition]
    );

    const inst1Id = uuidv4();
    await run(
      'INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final, entered_state_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [inst1Id, orderMachineId, s2.id, JSON.stringify({ orderId: 'ORD-001', amount: 2000 }), now, 0, now]
    );

    const h1 = uuidv4();
    await run(
      'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [h1, inst1Id, s1.id, s2.id, 'submit', JSON.stringify({ amount: 2000, reason: '创建订单' }), now, 'user']
    );

    const inst2Id = uuidv4();
    await run(
      'INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final, entered_state_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [inst2Id, orderMachineId, s3.id, JSON.stringify({ orderId: 'ORD-002', amount: 1500 }), now, 1, now]
    );

    const h2 = uuidv4();
    await run(
      'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [h2, inst2Id, s1.id, s2.id, 'submit', JSON.stringify({ amount: 1500 }), now, 'user']
    );

    const h3 = uuidv4();
    await run(
      'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [h3, inst2Id, s2.id, s3.id, 'approve', JSON.stringify({ amount: 1500, approvedBy: 'manager' }), now, 'user']
    );

    console.log('Demo data seeded: 订单审批 state machine and 2 demo instances created.');
  } else {
    const mRow = await get('SELECT id FROM machines WHERE name = ?', ['订单审批']);
    if (mRow) orderMachineId = mRow.id;
  }

  if (templateRow.cnt === 0) {
    if (orderMachineId) {
      const orderMachine = await get('SELECT * FROM machines WHERE id = ?', [orderMachineId]);
      if (orderMachine) {
        const tpl1Id = uuidv4();
        await run(
          'INSERT INTO templates (id, machine_id, name, description, tags_json, definition_json, clone_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            tpl1Id,
            orderMachineId,
            '订单审批',
            '经典订单审批流程，支持金额阈值分流至人工复审，适用于采购、报销等场景',
            JSON.stringify(['审批', '订单', '采购']),
            orderMachine.definition,
            3,
            now
          ]
        );
      }
    }

    const l1 = { id: uuidv4(), name: '草稿', isInitial: true, isFinal: false, x: 60, y: 180 };
    const l2 = { id: uuidv4(), name: '待主管审', isInitial: false, isFinal: false, x: 260, y: 180 };
    const l3 = { id: uuidv4(), name: '待HR审', isInitial: false, isFinal: false, x: 460, y: 180 };
    const l4 = { id: uuidv4(), name: '通过', isInitial: false, isFinal: true, x: 660, y: 80 };
    const l5 = { id: uuidv4(), name: '驳回', isInitial: false, isFinal: true, x: 660, y: 280 };

    const leaveStates = [l1, l2, l3, l4, l5];

    const leaveTransitions = [
      { id: uuidv4(), sourceStateId: l1.id, targetStateId: l2.id, event: 'submit', guard: '' },
      { id: uuidv4(), sourceStateId: l2.id, targetStateId: l3.id, event: 'approve', guard: '' },
      { id: uuidv4(), sourceStateId: l2.id, targetStateId: l5.id, event: 'reject', guard: '' },
      { id: uuidv4(), sourceStateId: l3.id, targetStateId: l4.id, event: 'approve', guard: '' },
      { id: uuidv4(), sourceStateId: l3.id, targetStateId: l5.id, event: 'reject', guard: '' }
    ];

    const leaveDefinition = JSON.stringify({ states: leaveStates, transitions: leaveTransitions });
    const tpl2Id = uuidv4();
    const leaveMachineId = uuidv4();

    await run(
      'INSERT INTO templates (id, machine_id, name, description, tags_json, definition_json, clone_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        tpl2Id,
        leaveMachineId,
        '请假审批',
        '员工请假审批流程：草稿→主管审批→HR审批→通过/驳回，适用于年假、事假等场景',
        JSON.stringify(['审批', 'HR', '请假']),
        leaveDefinition,
        5,
        now
      ]
    );

    console.log('Demo templates seeded: 订单审批 and 请假审批 templates created.');
  }
}

module.exports = { seedDemoData };
