const baseUrl = 'http://localhost:3000';

async function test() {
  // 1. 创建机器
  const machine = await fetch(`${baseUrl}/api/machines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '调试测试',
      version: 1,
      states: [
        { id: 'start', name: '开始', x: 100, y: 100, isInitial: true },
        { id: 'processing', name: '处理中', x: 350, y: 100 },
        { id: 'end', name: '结束', x: 600, y: 100, isFinal: true }
      ],
      transitions: [
        { id: 't1', sourceStateId: 'start', targetStateId: 'processing', event: 'go' },
        { id: 't2', sourceStateId: 'processing', targetStateId: 'end', event: 'finish' }
      ]
    })
  }).then(r => r.json());
  console.log('Machine:', machine.id);

  // 2. 发布
  await fetch(`${baseUrl}/api/machines/${machine.id}/publish`, { method: 'POST' });

  // 3. 创建实例
  const inst = await fetch(`${baseUrl}/api/machines/${machine.id}/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then(r => r.json());
  console.log('Instance:', inst.id);

  // 4. 发送事件
  await fetch(`${baseUrl}/api/instances/${inst.id}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'go' })
  }).then(r => r.json());

  // 5. 接管
  const takeRes = await fetch(`${baseUrl}/api/instances/${inst.id}/takeover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operatorId: 'test', operatorName: '测试', note: 'test' })
  });
  const takeData = await takeRes.json();
  console.log('Takeover response:', JSON.stringify(takeData, null, 2));
  console.log('Session ID:', takeData.id);

  // 6. 查看会话详情
  const detailRes = await fetch(`${baseUrl}/api/takeover/sessions/${takeData.id}`);
  const detailText = await detailRes.text();
  console.log('\n=== Session Detail Response ===');
  console.log('Status:', detailRes.status);
  console.log('Body:', detailText.slice(0, 500));
}

test().catch(e => console.error('Error:', e));
