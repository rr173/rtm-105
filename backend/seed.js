const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { recordStateDuration } = require('./metrics');

async function createInstanceWithHistory(machineId, states, path, baseTime) {
  const sMap = new Map();
  for (const s of states) sMap.set(s.name, s);

  let currentTime = baseTime;
  const instanceId = uuidv4();
  const initialState = sMap.get(path[0].state);

  await run(
    'INSERT INTO instances (id, machine_id, current_state_id, context_data, created_at, is_final, entered_state_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      instanceId,
      machineId,
      sMap.get(path[path.length - 1].state).id,
      JSON.stringify(path[path.length - 1].context || {}),
      new Date(baseTime).toISOString(),
      sMap.get(path[path.length - 1].state).isFinal ? 1 : 0,
      new Date(currentTime).toISOString()
    ]
  );

  let prevState = null;
  let prevEnteredAt = baseTime;
  let prevStep = null;

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const state = sMap.get(step.state);
    const enteredAt = currentTime;

    if (step.durationMs) {
      currentTime += step.durationMs;
    }

    if (prevState && prevStep) {
      const transitionId = uuidv4();
      await run(
        'INSERT INTO transitions (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          transitionId,
          instanceId,
          prevState.id,
          state.id,
          prevStep.event || 'submit',
          JSON.stringify(prevStep.payload || {}),
          new Date(enteredAt).toISOString(),
          prevStep.triggeredBy || 'user'
        ]
      );
      await recordStateDuration(
        instanceId,
        machineId,
        prevState.id,
        new Date(prevEnteredAt).toISOString(),
        new Date(enteredAt).toISOString()
      );
    }

    if (state.isFinal) {
      await recordStateDuration(
        instanceId,
        machineId,
        state.id,
        new Date(enteredAt).toISOString(),
        new Date(enteredAt).toISOString()
      );
    }

    prevState = state;
    prevEnteredAt = enteredAt;
    prevStep = step;
  }

  return instanceId;
}

async function seedDemoData() {
  const row = await get('SELECT COUNT(*) as cnt FROM machines');
  const templateRow = await get('SELECT COUNT(*) as cnt FROM templates');

  const now = new Date().toISOString();
  let orderMachineId = null;
  let orderStates = null;

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

    orderStates = [s1, s2, s3, s4, s5, s6, s7];

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
    const definition = JSON.stringify({ states: orderStates, transitions });

    await run(
      'INSERT INTO machines (id, name, version, created_at, definition) VALUES (?, ?, ?, ?, ?)',
      [orderMachineId, '订单审批', 1, now, definition]
    );

    const baseTime = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const demoPaths = [
      {
        path: [
          { state: '待提交', durationMs: 5 * 60 * 1000, event: 'submit', payload: { amount: 1500 } },
          { state: '待审批', durationMs: 45 * 60 * 1000, event: 'approve', payload: { amount: 1500, approvedBy: 'manager_a' } },
          { state: '已批准', context: { orderId: 'ORD-DEMO-001', amount: 1500 } }
        ],
        offsetMs: 0
      },
      {
        path: [
          { state: '待提交', durationMs: 2 * 60 * 1000, event: 'submit', payload: { amount: 800 } },
          { state: '待审批', durationMs: 2 * 60 * 60 * 1000, event: 'approve', payload: { amount: 800, approvedBy: 'manager_b' } },
          { state: '已批准', context: { orderId: 'ORD-DEMO-002', amount: 800 } }
        ],
        offsetMs: 3 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 10 * 60 * 1000, event: 'submit', payload: { amount: 3200 } },
          { state: '待审批', durationMs: 30 * 60 * 1000, event: 'approve', payload: { amount: 3200, approvedBy: 'manager_a' } },
          { state: '已批准', context: { orderId: 'ORD-DEMO-003', amount: 3200 } }
        ],
        offsetMs: 6 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 3 * 60 * 1000, event: 'submit', payload: { amount: 500 } },
          { state: '待审批', durationMs: 90 * 60 * 1000, event: 'reject', payload: { reason: '资料不全' } },
          { state: '已拒绝', context: { orderId: 'ORD-DEMO-004', amount: 500 } }
        ],
        offsetMs: 10 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 8 * 60 * 1000, event: 'submit', payload: { amount: 1200 } },
          { state: '待审批', durationMs: 3 * 60 * 60 * 1000, event: 'reject', payload: { reason: '预算不足' } },
          { state: '已拒绝', context: { orderId: 'ORD-DEMO-005', amount: 1200 } }
        ],
        offsetMs: 15 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 15 * 60 * 1000, event: 'submit', payload: { amount: 8000 } },
          { state: '待审批', durationMs: 15 * 60 * 1000, event: 'approve', payload: { amount: 8000, approvedBy: 'manager_a' } },
          { state: '人工复审', durationMs: 4 * 60 * 60 * 1000, event: 'approve', payload: { approvedBy: 'director' } },
          { state: '复审批准', context: { orderId: 'ORD-DEMO-006', amount: 8000 } }
        ],
        offsetMs: 20 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 20 * 60 * 1000, event: 'submit', payload: { amount: 12000 } },
          { state: '待审批', durationMs: 10 * 60 * 1000, event: 'approve', payload: { amount: 12000, approvedBy: 'manager_c' } },
          { state: '人工复审', durationMs: 6 * 60 * 60 * 1000, event: 'approve', payload: { approvedBy: 'vp' } },
          { state: '复审批准', context: { orderId: 'ORD-DEMO-007', amount: 12000 } }
        ],
        offsetMs: 30 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 4 * 60 * 1000, event: 'submit', payload: { amount: 15000 } },
          { state: '待审批', durationMs: 25 * 60 * 1000, event: 'approve', payload: { amount: 15000, approvedBy: 'manager_b' } },
          { state: '人工复审', durationMs: 2 * 60 * 60 * 1000, event: 'reject', payload: { reason: '风险过高' } },
          { state: '复审拒绝', context: { orderId: 'ORD-DEMO-008', amount: 15000 } }
        ],
        offsetMs: 45 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 6 * 60 * 1000, event: 'submit', payload: { amount: 20000 } },
          { state: '待审批', durationMs: 5 * 60 * 1000, event: 'approve', payload: { amount: 20000, approvedBy: 'manager_a' } },
          { state: '人工复审', durationMs: 8 * 60 * 60 * 1000, event: 'reject', payload: { reason: '不符合政策' } },
          { state: '复审拒绝', context: { orderId: 'ORD-DEMO-009', amount: 20000 } }
        ],
        offsetMs: 60 * 60 * 60 * 1000
      },
      {
        path: [
          { state: '待提交', durationMs: 1 * 60 * 1000, event: 'submit', payload: { amount: 4500 } },
          { state: '待审批', durationMs: 15 * 60 * 1000, event: 'approve', payload: { amount: 4500, approvedBy: 'manager_c' } },
          { state: '已批准', context: { orderId: 'ORD-DEMO-010', amount: 4500 } }
        ],
        offsetMs: 80 * 60 * 60 * 1000
      }
    ];

    for (const demo of demoPaths) {
      await createInstanceWithHistory(
        orderMachineId,
        orderStates,
        demo.path,
        baseTime + demo.offsetMs
      );
    }

    console.log('Demo data seeded: 订单审批 state machine and 10 completed demo instances created.');
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
