const http = require('http');

function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: body ? JSON.parse(body) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data: body, raw: true });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== Cascade Engine Test Suite ===\n');

  try {
    console.log('Test 1: Get link constants');
    const constantsRes = await makeRequest('GET', '/api/links/constants');
    console.log('  Status:', constantsRes.status);
    console.log('  Data:', JSON.stringify(constantsRes.data).slice(0, 200));
    console.log('  ✓ PASS\n');

    console.log('Test 2: List all machines');
    const machinesRes = await makeRequest('GET', '/api/machines');
    const orderMachine = machinesRes.data.find(m => m.name === '订单审批');
    console.log('  Status:', machinesRes.status);
    console.log('  订单审批 Machine ID:', orderMachine ? orderMachine.id.slice(0, 12) + '...' : 'NOT FOUND');
    if (!orderMachine) throw new Error('订单审批 machine not found');
    console.log('  ✓ PASS\n');

    console.log('Test 3: List links for order machine');
    const linksRes = await makeRequest('GET', `/api/machines/${orderMachine.id}/links`);
    console.log('  Status:', linksRes.status);
    console.log('  Links count:', linksRes.data.length);
    linksRes.data.forEach((link, idx) => {
      console.log(`  Link ${idx + 1}: type=${link.linkType}, status=${link.status}`);
      console.log(`    source: ${link.sourceInstanceId.slice(0, 12)}... -> target: ${link.targetInstanceId.slice(0, 12)}...`);
      console.log(`    rules: ${link.triggerRules.length} rules`);
      link.triggerRules.forEach((r, i) => {
        console.log(`      Rule ${i + 1}: sourceEvent=${r.sourceEvent} targetState=${r.targetStateId.slice(0, 8)}... → targetEvent=${r.targetEvent}`);
      });
    });
    if (linksRes.data.length !== 2) throw new Error(`Expected 2 links, got ${linksRes.data.length}`);
    console.log('  ✓ PASS\n');

    console.log('Test 4: List cascade demo instances');
    const instancesRes = await makeRequest('GET', `/api/machines/${orderMachine.id}/instances`);
    const demoInstances = instancesRes.data.filter(i =>
      i.context && i.context.orderId && i.context.orderId.includes('CASCADE')
    );
    console.log('  Status:', instancesRes.status);
    console.log('  Demo instances count:', demoInstances.length);
    const mainOrder = demoInstances.find(i => i.context.orderType === 'main');
    const subOrders = demoInstances.filter(i => i.context.orderType === 'sub');
    console.log('  Main order:', mainOrder ? mainOrder.context.orderId : 'NOT FOUND');
    subOrders.forEach(s => console.log('  Sub order:', s.context.orderId));
    if (!mainOrder) throw new Error('Main order not found');
    if (subOrders.length !== 2) throw new Error(`Expected 2 sub orders, got ${subOrders.length}`);
    console.log('  ✓ PASS\n');

    console.log('Test 5: Get links for main order instance');
    const instLinksRes = await makeRequest('GET', `/api/instances/${mainOrder.id}/links`);
    console.log('  Status:', instLinksRes.status);
    console.log('  Links for main order:', instLinksRes.data.length);
    console.log('  ✓ PASS\n');

    console.log('Test 6: Pause and resume a link');
    const firstLink = linksRes.data[0];
    const pauseRes = await makeRequest('POST', `/api/links/${firstLink.id}/pause`);
    console.log('  Pause status:', pauseRes.status);
    console.log('  Paused link status:', pauseRes.data ? pauseRes.data.status : '?');
    if (pauseRes.data && pauseRes.data.status !== 'paused') throw new Error('Link not paused');
    const resumeRes = await makeRequest('POST', `/api/links/${firstLink.id}/resume`);
    console.log('  Resume status:', resumeRes.status);
    console.log('  Resumed link status:', resumeRes.data ? resumeRes.data.status : '?');
    if (resumeRes.data && resumeRes.data.status !== 'active') throw new Error('Link not resumed');
    console.log('  ✓ PASS\n');

    console.log('Test 7: Send approve to main order (CASCADE TRIGGER)');
    const sendResult = await makeRequest('POST', `/api/instances/${mainOrder.id}/send`, {
      event: 'approve',
      payload: { amount: 3000, approvedBy: 'test_user' }
    });
    console.log('  Send status:', sendResult.status);
    if (sendResult.status !== 200) {
      console.log('  Error:', JSON.stringify(sendResult.data).slice(0, 500));
      throw new Error('Send event failed');
    }
    console.log('  Transition success:', !!sendResult.data.transitionId);
    console.log('  Cascade result present:', !!sendResult.data.cascade);
    if (sendResult.data.cascade) {
      const casc = sendResult.data.cascade;
      console.log('  Cascade depth:', casc.depth);
      console.log('  Cascade results count:', casc.results ? casc.results.length : 0);
      casc.results && casc.results.forEach((r, i) => {
        const status = r.success ? 'SUCCESS' : (r.skipped ? `SKIP(${r.reason})` : 'FAIL');
        console.log(`    Result ${i + 1}: ${status} | event=${r.event || (r.rule || {}).targetEvent}`);
        if (r.success) {
          console.log(`      toState: ${r.toStateId ? r.toStateId.slice(0, 8) + '...' : '?'}, isFinal=${r.isFinal}`);
        }
      });
      const successCount = casc.results ? casc.results.filter(r => r.success).length : 0;
      if (successCount < 2) throw new Error(`Expected at least 2 cascade successes, got ${successCount}`);
    }
    console.log('  ✓ PASS\n');

    console.log('Test 8: Verify sub-orders were cascade-updated (all should be final)');
    const updatedInstancesRes = await makeRequest('GET', `/api/machines/${orderMachine.id}/instances`);
    const updatedDemoInstances = updatedInstancesRes.data.filter(i =>
      i.context && i.context.orderId && i.context.orderId.includes('CASCADE')
    );
    let allFinal = true;
    updatedDemoInstances.forEach(i => {
      const type = i.context.orderType;
      const state = i.isFinal ? 'FINAL ✓' : `ACTIVE (${i.currentStateId.slice(0, 8)}...)`;
      console.log(`  ${i.context.orderId} (${type}): isFinal=${i.isFinal} -> ${state}`);
      if (!i.isFinal) allFinal = false;
    });
    if (!allFinal) throw new Error('Not all demo instances reached final state');
    console.log('  ✓ PASS\n');

    console.log('Test 9: Check cascade history from link');
    const historyRes = await makeRequest('GET', `/api/links/${linksRes.data[0].id}/cascade-history`);
    console.log('  Status:', historyRes.status);
    console.log('  History records:', historyRes.data ? historyRes.data.total : 0);
    if (historyRes.data && historyRes.data.history && historyRes.data.history.length > 0) {
      const rec = historyRes.data.history[0];
      console.log('  Sample record:');
      console.log(`    triggeredBy: ${rec.triggeredBy}`);
      console.log(`    cascadeDetail.depth: ${rec.cascadeDetail ? rec.cascadeDetail.depth : '?'}`);
      console.log(`    cascadeDetail.sourceInstanceId: ${rec.cascadeDetail ? (rec.cascadeDetail.sourceInstanceId || '').slice(0, 8) : '?'}...`);
      console.log(`    cascadeDetail.linkId: ${rec.cascadeDetail ? (rec.cascadeDetail.linkId || '').slice(0, 8) : '?'}...`);
    }
    console.log('  ✓ PASS\n');

    console.log('Test 10: Get skip logs from link');
    const skipLogsRes = await makeRequest('GET', `/api/links/${linksRes.data[0].id}/skip-logs`);
    console.log('  Status:', skipLogsRes.status);
    console.log('  Skip logs count:', skipLogsRes.data ? skipLogsRes.data.skipLogs.length : 0);
    console.log('  ✓ PASS\n');

    console.log('Test 11: Verify instance history includes cascadeDetail');
    const subOrder = subOrders[0];
    const instanceDetailRes = await makeRequest('GET', `/api/instances/${subOrder.id}`);
    console.log('  Status:', instanceDetailRes.status);
    const history = instanceDetailRes.data ? instanceDetailRes.data.history : [];
    console.log('  History entries count:', history.length);
    let foundCascade = false;
    history.forEach((h, i) => {
      const hasCascade = !!h.cascadeDetail;
      console.log(`    Hist ${i + 1}: event=${h.event}, triggeredBy=${h.triggeredBy}, hasCascadeDetail=${hasCascade}`);
      if (hasCascade && h.triggeredBy === 'cascade') {
        foundCascade = true;
        console.log(`       cascadeDetail.depth: ${h.cascadeDetail.depth}`);
        console.log(`       cascadeDetail.sourceInstanceId: ${(h.cascadeDetail.sourceInstanceId || '').slice(0, 8)}...`);
      }
    });
    if (!foundCascade) throw new Error('No cascade history found in sub-order');
    console.log('  ✓ PASS\n');

    console.log('=== ALL TESTS PASSED! ===');
    process.exit(0);

  } catch (e) {
    console.error('\n❌ TEST FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

setTimeout(runTests, 500);
