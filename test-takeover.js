#!/usr/bin/env node

const baseUrl = 'http://localhost:3000';
const operatorId = 'test_user_001';
const operatorName = '测试操作员';

async function test() {
  console.log('=== 人工接管工作台完整测试 ===\n');

  // 1. 创建测试状态机
  console.log('1. 创建测试状态机...');
  const machineRes = await fetch(`${baseUrl}/api/machines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '接管测试流程',
      version: 1,
      states: [
        { id: 'start', name: '开始', x: 100, y: 100, isInitial: true },
        { id: 'processing', name: '处理中', x: 350, y: 100 },
        { id: 'review', name: '审核中', x: 600, y: 100 },
        { id: 'completed', name: '完成', x: 850, y: 100, isFinal: true },
        { id: 'failed', name: '失败', x: 600, y: 300, isFinal: true }
      ],
      transitions: [
        { id: 't1', sourceStateId: 'start', targetStateId: 'processing', event: 'submit' },
        { id: 't2', sourceStateId: 'processing', targetStateId: 'review', event: 'send_review' },
        { id: 't3', sourceStateId: 'review', targetStateId: 'completed', event: 'approve' },
        { id: 't4', sourceStateId: 'review', targetStateId: 'failed', event: 'reject' },
        { id: 't5', sourceStateId: 'processing', targetStateId: 'failed', event: 'cancel' }
      ]
    })
  });
  const machineData = await machineRes.json();
  const machineId = machineData.id;
  console.log('   ✓ 状态机已创建, ID:', machineId);

  // 2. 发布状态机
  console.log('\n2. 发布状态机...');
  await fetch(`${baseUrl}/api/machines/${machineId}/publish`, { method: 'POST' });
  console.log('   ✓ 状态机已发布');

  // 3. 创建运行实例
  console.log('\n3. 创建运行实例...');
  const instRes = await fetch(`${baseUrl}/api/machines/${machineId}/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'ORD-2024-001', amount: 1000 })
  });
  const instData = await instRes.json();
  const instanceId = instData.id;
  console.log('   ✓ 实例已创建, ID:', instanceId);

  // 4. 发送事件让实例流转到处理中状态
  console.log('\n4. 发送submit事件...');
  await fetch(`${baseUrl}/api/instances/${instanceId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'submit', payload: {} })
  });
  console.log('   ✓ 事件已发送');

  // 5. 冻结实例
  console.log('\n5. 冻结实例...');
  const freezeRes = await fetch(`${baseUrl}/api/instances/${instanceId}/freeze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operatorId,
      operatorName,
      reason: '实例异常，需要人工介入'
    })
  });
  const freezeData = await freezeRes.json();
  console.log('   ✓ 冻结结果:', JSON.stringify(freezeData, null, 2).replace(/\n/g, '\n      '));

  // 6. 尝试在冻结状态下发送事件 - 应该被排队
  console.log('\n6. 冻结状态下发送事件 (应该排队)...');
  const queueRes = await fetch(`${baseUrl}/api/instances/${instanceId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'send_review', payload: {} })
  });
  const queueData = await queueRes.json();
  console.log('   ✓ 事件处理结果:', JSON.stringify(queueData, null, 2).replace(/\n/g, '\n      '));

  // 7. 再发一个事件
  console.log('\n7. 发送第二个排队事件...');
  await fetch(`${baseUrl}/api/instances/${instanceId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'cancel', payload: {} })
  });
  console.log('   ✓ 第二个事件已发送');

  // 8. 查看仪表盘
  console.log('\n8. 查看接管仪表盘...');
  const dashRes = await fetch(`${baseUrl}/api/takeover/dashboard`);
  const dashData = await dashRes.json();
  console.log('   ✓ 仪表盘数据:');
  console.log('     冻结中实例数:', dashData.stats.frozen);
  console.log('     排队事件总数:', dashData.stats.pendingEvents);
  console.log('     接管会话数:', dashData.sessions.length);

  const sessionId = dashData.sessions[0]?.id;
  console.log('     会话ID:', sessionId);

  // 9. 创建接管会话
  console.log('\n9. 创建接管会话...');
  const takeRes = await fetch(`${baseUrl}/api/instances/${instanceId}/takeover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operatorId,
      operatorName,
      note: '人工介入处理异常'
    })
  });
  const takeData = await takeRes.json();
  console.log('   ✓ 接管结果:', JSON.stringify(takeData, null, 2).replace(/\n/g, '\n      '));

  // 10. 查看会话详情
  console.log('\n10. 查看会话详情...');
  const currentSessionId = takeData.id;
  console.log('    会话ID:', currentSessionId);
  
  const detailRes = await fetch(`${baseUrl}/api/takeover/sessions/${currentSessionId}`);
  const detailData = await detailRes.json();
  console.log('    API success:', detailData.success);
  console.log('    Has detail:', !!detailData.detail);
  
  if (!detailData.success || !detailData.detail) {
    console.log('    完整响应:', JSON.stringify(detailData, null, 2).slice(0, 500));
    throw new Error('Invalid response');
  }
  
  console.log('    ✓ 会话详情:');
  console.log('      实例当前状态:', detailData.detail.instance.currentStateName);
  console.log('      排队事件数:', detailData.detail.pendingEvents.length);
  console.log('      可用事件:', detailData.detail.availableEvents);
  console.log('      可达状态数:', detailData.detail.reachableStates.length);
  console.log('      流转历史步数:', detailData.detail.flowHistory.length);

  // 11. 预览注入事件动作
  console.log('\n11. 预览注入事件动作...');
  const previewRes = await fetch(`${baseUrl}/api/takeover/sessions/${currentSessionId}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actionType: 'inject',
      actionData: { event: 'send_review', payload: { note: '人工注入' } }
    })
  });
  const previewData = await previewRes.json();
  console.log('    ✓ 预览结果:', JSON.stringify(previewData, null, 2).replace(/\n/g, '\n      '));

  // 12. 执行注入事件动作
  console.log('\n12. 执行注入事件动作...');
  const execRes = await fetch(`${baseUrl}/api/takeover/sessions/${currentSessionId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operatorId,
      operatorName,
      actionType: 'inject_event',
      actionData: { event: 'send_review', payload: { note: '人工注入' }, reason: '补送审核事件' },
      description: '人工注入send_review事件，补送审核',
      previewResult: previewData.preview
    })
  });
  const execData = await execRes.json();
  console.log('    ✓ 执行结果:', JSON.stringify(execData, null, 2).replace(/\n/g, '\n      '));

  // 13. 预览跳转状态动作
  console.log('\n13. 预览跳转到completed状态...');
  const preview2Res = await fetch(`${baseUrl}/api/takeover/sessions/${currentSessionId}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actionType: 'jump',
      actionData: { targetStateId: 'completed' }
    })
  });
  const preview2Data = await preview2Res.json();
  console.log('    ✓ 跳转预览:', JSON.stringify(preview2Data, null, 2).replace(/\n/g, '\n      '));

  // 14. 查看动作日志
  console.log('\n14. 查看会话详情(含动作日志)...');
  const detail2Res = await fetch(`${baseUrl}/api/takeover/sessions/${currentSessionId}`);
  const detail2Data = await detail2Res.json();
  console.log('    ✓ 当前状态:', detail2Data.detail.instance.currentStateName);
  console.log('    ✓ 动作日志数:', detail2Data.detail.actionLogs.length);
  detail2Data.detail.actionLogs.forEach((log, i) => {
    console.log(`      [${i+1}] ${getActionTypeLabel(log.actionType)} - ${log.description}`);
  });

  // 15. 恢复自动运行
  console.log('\n15. 恢复自动运行...');
  const resumeRes = await fetch(`${baseUrl}/api/takeover/sessions/${currentSessionId}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operatorId, operatorName })
  });
  const resumeData = await resumeRes.json();
  console.log('    ✓ 恢复结果:', JSON.stringify(resumeData, null, 2).replace(/\n/g, '\n      '));

  // 16. 查看最终状态
  await new Promise(r => setTimeout(r, 1000));
  console.log('\n16. 查看实例最终状态...');
  const instDetailRes = await fetch(`${baseUrl}/api/instances/${instanceId}`);
  const instDetail = await instDetailRes.json();
  console.log('    ✓ 最终状态:', instDetail.currentStateId);
  console.log('    ✓ 是否冻结:', instDetail.freezeInfo?.isFrozen ? '是' : '否');

  console.log('\n=== 测试完成 ===');
}

function getActionTypeLabel(type) {
  const labels = {
    'inject_event': '💉 注入事件',
    'jump_to_state': '⏭️ 跳过状态',
    'terminate': '🛑 终止实例',
    'modify_context': '✏️ 修改上下文',
    'resume_auto': '▶️ 恢复自动',
    'unfreeze': '☀️ 完全解冻',
    'freeze': '❄️ 冻结实例'
  };
  return labels[type] || type;
}

test().catch(console.error);
