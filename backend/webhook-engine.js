const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DELIVERY_STATUS = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  CIRCUIT_SKIPPED: 'circuit_skipped'
});

const circuitStates = new Map();
const pendingRetryTimers = new Map();

function initWebhookDB() {
  return new Promise((resolve, reject) => {
    const { db } = require('./db');
    db.serialize(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_configs (
          id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          transition_id TEXT NOT NULL,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT 'POST',
          headers_json TEXT,
          max_retries INTEGER NOT NULL DEFAULT 3,
          retry_interval_ms INTEGER NOT NULL DEFAULT 1000,
          circuit_breaker_threshold INTEGER NOT NULL DEFAULT 5,
          circuit_breaker_reset_ms INTEGER NOT NULL DEFAULT 60000,
          timeout_ms INTEGER NOT NULL DEFAULT 5000,
          enabled INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (machine_id) REFERENCES machines(id)
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_configs_machine ON webhook_configs(machine_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_configs_transition ON webhook_configs(transition_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_configs_machine_transition ON webhook_configs(machine_id, transition_id);

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          config_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          transition_record_id TEXT,
          source_state_id TEXT NOT NULL,
          target_state_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          payload_snapshot TEXT,
          context_data TEXT,
          request_url TEXT NOT NULL,
          request_headers_json TEXT,
          request_body_json TEXT,
          request_time TEXT NOT NULL,
          response_status INTEGER,
          response_body TEXT,
          response_duration_ms INTEGER,
          retry_count INTEGER NOT NULL DEFAULT 0,
          final_status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (config_id) REFERENCES webhook_configs(id),
          FOREIGN KEY (machine_id) REFERENCES machines(id),
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_machine ON webhook_deliveries(machine_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_instance ON webhook_deliveries(instance_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_config ON webhook_deliveries(config_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(final_status);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_machine_created ON webhook_deliveries(machine_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_instance_created ON webhook_deliveries(instance_id, created_at);
      `, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

function getCircuitState(configId) {
  if (!circuitStates.has(configId)) {
    circuitStates.set(configId, {
      consecutiveFailures: 0,
      circuitOpen: false,
      circuitOpenAt: null
    });
  }
  return circuitStates.get(configId);
}

function resetCircuitBreaker(configId) {
  const state = getCircuitState(configId);
  state.consecutiveFailures = 0;
  state.circuitOpen = false;
  state.circuitOpenAt = null;
}

function recordFailure(configId, threshold) {
  const state = getCircuitState(configId);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= threshold) {
    state.circuitOpen = true;
    state.circuitOpenAt = Date.now();
    console.log(`[Webhook] Circuit breaker OPEN for config ${configId} after ${state.consecutiveFailures} consecutive failures`);
  }
}

function recordSuccess(configId) {
  resetCircuitBreaker(configId);
}

function checkCircuitBreaker(configId, resetMs) {
  const state = getCircuitState(configId);
  if (!state.circuitOpen) return false;

  const elapsed = Date.now() - (state.circuitOpenAt || 0);
  if (elapsed >= resetMs) {
    state.circuitOpen = false;
    state.circuitOpenAt = null;
    state.consecutiveFailures = 0;
    console.log(`[Webhook] Circuit breaker CLOSED for config ${configId} after reset period`);
    return false;
  }
  return true;
}

async function addWebhookConfig(config) {
  const {
    machineId,
    transitionId,
    name,
    url,
    method = 'POST',
    headers = null,
    maxRetries = 3,
    retryIntervalMs = 1000,
    circuitBreakerThreshold = 5,
    circuitBreakerResetMs = 60000,
    timeoutMs = 5000,
    enabled = true,
    priority = 0
  } = config;

  if (!machineId || !transitionId || !name || !url) {
    throw new Error('machineId, transitionId, name, and url are required');
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  await run(
    `INSERT INTO webhook_configs (
      id, machine_id, transition_id, name, url, method, headers_json,
      max_retries, retry_interval_ms, circuit_breaker_threshold,
      circuit_breaker_reset_ms, timeout_ms, enabled, priority,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, machineId, transitionId, name, url, method,
      headers ? JSON.stringify(headers) : null,
      maxRetries, retryIntervalMs, circuitBreakerThreshold,
      circuitBreakerResetMs, timeoutMs, enabled ? 1 : 0, priority,
      now, now
    ]
  );

  return getWebhookConfigById(id);
}

async function updateWebhookConfig(configId, updates) {
  const existing = await getWebhookConfigById(configId);
  if (!existing) throw new Error('Webhook config not found');

  const allowedFields = [
    'name', 'url', 'method', 'headers', 'maxRetries',
    'retryIntervalMs', 'circuitBreakerThreshold',
    'circuitBreakerResetMs', 'timeoutMs', 'enabled', 'priority'
  ];

  const sets = [];
  const params = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      switch (field) {
        case 'headers':
          sets.push('headers_json = ?');
          params.push(updates[field] ? JSON.stringify(updates[field]) : null);
          break;
        case 'maxRetries':
          sets.push('max_retries = ?');
          params.push(updates[field]);
          break;
        case 'retryIntervalMs':
          sets.push('retry_interval_ms = ?');
          params.push(updates[field]);
          break;
        case 'circuitBreakerThreshold':
          sets.push('circuit_breaker_threshold = ?');
          params.push(updates[field]);
          break;
        case 'circuitBreakerResetMs':
          sets.push('circuit_breaker_reset_ms = ?');
          params.push(updates[field]);
          break;
        case 'timeoutMs':
          sets.push('timeout_ms = ?');
          params.push(updates[field]);
          break;
        case 'enabled':
          sets.push('enabled = ?');
          params.push(updates[field] ? 1 : 0);
          if (updates[field]) resetCircuitBreaker(configId);
          break;
        default:
          sets.push(`${field} = ?`);
          params.push(updates[field]);
      }
    }
  }

  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(configId);

  await run(`UPDATE webhook_configs SET ${sets.join(', ')} WHERE id = ?`, params);
  return getWebhookConfigById(configId);
}

async function deleteWebhookConfig(configId) {
  const existing = await getWebhookConfigById(configId);
  if (!existing) return false;

  if (pendingRetryTimers.has(configId)) {
    const timers = pendingRetryTimers.get(configId);
    for (const t of timers.values()) clearTimeout(t);
    pendingRetryTimers.delete(configId);
  }

  circuitStates.delete(configId);
  await run('DELETE FROM webhook_configs WHERE id = ?', [configId]);
  return true;
}

function rowToConfig(row) {
  if (!row) return null;
  return {
    id: row.id,
    machineId: row.machine_id,
    transitionId: row.transition_id,
    name: row.name,
    url: row.url,
    method: row.method,
    headers: row.headers_json ? JSON.parse(row.headers_json) : null,
    maxRetries: row.max_retries,
    retryIntervalMs: row.retry_interval_ms,
    circuitBreakerThreshold: row.circuit_breaker_threshold,
    circuitBreakerResetMs: row.circuit_breaker_reset_ms,
    timeoutMs: row.timeout_ms,
    enabled: !!row.enabled,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getWebhookConfigById(configId) {
  const row = await get('SELECT * FROM webhook_configs WHERE id = ?', [configId]);
  return rowToConfig(row);
}

async function getWebhookConfigsByMachineId(machineId, { includeDisabled = false } = {}) {
  let sql = 'SELECT * FROM webhook_configs WHERE machine_id = ?';
  const params = [machineId];
  if (!includeDisabled) {
    sql += ' AND enabled = 1';
  }
  sql += ' ORDER BY priority ASC, created_at ASC';
  const rows = await all(sql, params);
  return rows.map(rowToConfig);
}

async function getWebhookConfigsByTransition(machineId, transitionId, { includeDisabled = false } = {}) {
  let sql = 'SELECT * FROM webhook_configs WHERE machine_id = ? AND transition_id = ?';
  const params = [machineId, transitionId];
  if (!includeDisabled) {
    sql += ' AND enabled = 1';
  }
  sql += ' ORDER BY priority ASC, created_at ASC';
  const rows = await all(sql, params);
  return rows.map(rowToConfig);
}

async function listAllWebhookConfigs({ machineId, enabled } = {}) {
  let sql = 'SELECT * FROM webhook_configs WHERE 1=1';
  const params = [];
  if (machineId) {
    sql += ' AND machine_id = ?';
    params.push(machineId);
  }
  if (enabled !== undefined) {
    sql += ' AND enabled = ?';
    params.push(enabled ? 1 : 0);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = await all(sql, params);
  return rows.map(rowToConfig);
}

async function createDeliveryRecord({
  configId, machineId, instanceId, transitionRecordId,
  sourceStateId, targetStateId, eventName, payload, context,
  requestUrl, requestHeaders, requestBody
}) {
  const id = uuidv4();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO webhook_deliveries (
      id, config_id, machine_id, instance_id, transition_record_id,
      source_state_id, target_state_id, event_name, payload_snapshot,
      context_data, request_url, request_headers_json, request_body_json,
      request_time, response_status, response_body, response_duration_ms,
      retry_count, final_status, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, configId, machineId, instanceId, transitionRecordId,
      sourceStateId, targetStateId, eventName,
      payload !== undefined && payload !== null ? JSON.stringify(payload) : null,
      context !== undefined && context !== null ? JSON.stringify(context) : null,
      requestUrl,
      requestHeaders ? JSON.stringify(requestHeaders) : null,
      requestBody ? JSON.stringify(requestBody) : null,
      now, null, null, null, 0, 'pending', null, now
    ]
  );
  return id;
}

async function updateDeliveryResult(deliveryId, {
  responseStatus, responseBody, responseDurationMs,
  retryCount, finalStatus, errorMessage
}) {
  const sets = [];
  const params = [];

  if (responseStatus !== undefined) { sets.push('response_status = ?'); params.push(responseStatus); }
  if (responseBody !== undefined) {
    const truncated = typeof responseBody === 'string' ? responseBody.substring(0, 5000) : responseBody;
    sets.push('response_body = ?'); params.push(truncated ? JSON.stringify(truncated) : null);
  }
  if (responseDurationMs !== undefined) { sets.push('response_duration_ms = ?'); params.push(responseDurationMs); }
  if (retryCount !== undefined) { sets.push('retry_count = ?'); params.push(retryCount); }
  if (finalStatus !== undefined) { sets.push('final_status = ?'); params.push(finalStatus); }
  if (errorMessage !== undefined) { sets.push('error_message = ?'); params.push(errorMessage); }

  params.push(deliveryId);
  await run(`UPDATE webhook_deliveries SET ${sets.join(', ')} WHERE id = ?`, params);
}

function sendHttpRequest(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      const bodyStr = body !== undefined && body !== null ? JSON.stringify(body) : '';
      const reqHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(headers || {})
      };

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: reqHeaders,
        timeout: timeoutMs
      };

      const startTime = Date.now();
      const req = lib.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const duration = Date.now() - startTime;
          const responseBody = chunks.join('');
          resolve({
            status: res.statusCode,
            body: responseBody,
            durationMs: duration
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function executeDelivery(config, deliveryId, requestPayload) {
  try {
    const result = await sendHttpRequest(
      config.url,
      config.method,
      config.headers,
      requestPayload,
      config.timeoutMs
    );

    const success = result.status >= 200 && result.status < 300;

    await updateDeliveryResult(deliveryId, {
      responseStatus: result.status,
      responseBody: result.body,
      responseDurationMs: result.durationMs,
      finalStatus: success ? DELIVERY_STATUS.SUCCESS : DELIVERY_STATUS.FAILED,
      errorMessage: success ? null : `HTTP ${result.status}`
    });

    if (success) {
      recordSuccess(config.id);
    } else {
      recordFailure(config.id, config.circuitBreakerThreshold);
    }

    return { success, status: result.status, durationMs: result.durationMs };
  } catch (err) {
    await updateDeliveryResult(deliveryId, {
      finalStatus: DELIVERY_STATUS.FAILED,
      errorMessage: err.message
    });
    recordFailure(config.id, config.circuitBreakerThreshold);
    return { success: false, error: err.message };
  }
}

function scheduleRetry(config, deliveryId, requestPayload, retryCount, originalConfig) {
  const effectiveConfig = originalConfig || config;
  const delay = effectiveConfig.retryIntervalMs;

  const timer = setTimeout(async () => {
    if (!pendingRetryTimers.has(effectiveConfig.id)) return;
    pendingRetryTimers.get(effectiveConfig.id)?.delete(deliveryId);

    if (checkCircuitBreaker(effectiveConfig.id, effectiveConfig.circuitBreakerResetMs)) {
      await updateDeliveryResult(deliveryId, {
        finalStatus: DELIVERY_STATUS.CIRCUIT_SKIPPED,
        errorMessage: 'Circuit breaker open during retry',
        retryCount
      });
      return;
    }

    retryCount += 1;
    await updateDeliveryResult(deliveryId, { retryCount });
    const result = await executeDelivery(effectiveConfig, deliveryId, requestPayload);

    if (!result.success && retryCount < effectiveConfig.maxRetries) {
      scheduleRetry(effectiveConfig, deliveryId, requestPayload, retryCount, effectiveConfig);
    }
  }, delay);

  if (!pendingRetryTimers.has(effectiveConfig.id)) {
    pendingRetryTimers.set(effectiveConfig.id, new Map());
  }
  pendingRetryTimers.get(effectiveConfig.id).set(deliveryId, timer);
}

async function triggerTransitionWebhooks({
  machineId,
  machineDefinition,
  instanceId,
  transitionRecordId,
  sourceStateId,
  targetStateId,
  eventName,
  payload,
  context,
  definitionTransitionId
}) {
  const configs = definitionTransitionId
    ? await getWebhookConfigsByTransition(machineId, definitionTransitionId)
    : [];

  if (configs.length === 0) return [];

  const results = [];

  for (const config of configs) {
    try {
      const originalConfigSnapshot = { ...config };

      if (checkCircuitBreaker(config.id, config.circuitBreakerResetMs)) {
        const deliveryId = await createDeliveryRecord({
          configId: config.id,
          machineId,
          instanceId,
          transitionRecordId,
          sourceStateId,
          targetStateId,
          eventName,
          payload,
          context,
          requestUrl: config.url,
          requestHeaders: config.headers,
          requestBody: null
        });
        await updateDeliveryResult(deliveryId, {
          finalStatus: DELIVERY_STATUS.CIRCUIT_SKIPPED,
          errorMessage: 'Circuit breaker open - skipped delivery',
          request_time: new Date().toISOString()
        });
        results.push({ configId: config.id, status: DELIVERY_STATUS.CIRCUIT_SKIPPED, deliveryId });
        continue;
      }

      const requestPayload = {
        instanceId,
        machineId,
        sourceStateId,
        targetStateId,
        sourceStateName: machineDefinition?.states?.find(s => s.id === sourceStateId)?.name,
        targetStateName: machineDefinition?.states?.find(s => s.id === targetStateId)?.name,
        event: eventName,
        payload: payload || null,
        context: context || null,
        transitionRecordId,
        triggeredAt: new Date().toISOString()
      };

      const deliveryId = await createDeliveryRecord({
        configId: config.id,
        machineId,
        instanceId,
        transitionRecordId,
        sourceStateId,
        targetStateId,
        eventName,
        payload,
        context,
        requestUrl: config.url,
        requestHeaders: config.headers,
        requestPayload
      });

      const result = await executeDelivery(config, deliveryId, requestPayload);

      if (!result.success && config.maxRetries > 0) {
        scheduleRetry(config, deliveryId, requestPayload, 0, originalConfigSnapshot);
        results.push({ configId: config.id, status: 'retrying', deliveryId });
      } else {
        results.push({
          configId: config.id,
          status: result.success ? DELIVERY_STATUS.SUCCESS : DELIVERY_STATUS.FAILED,
          deliveryId,
          httpStatus: result.status
        });
      }
    } catch (err) {
      console.error(`[Webhook] Error processing config ${config.id}:`, err);
      results.push({ configId: config.id, status: DELIVERY_STATUS.FAILED, error: err.message });
    }
  }

  return results;
}

function rowToDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    configId: row.config_id,
    machineId: row.machine_id,
    instanceId: row.instance_id,
    transitionRecordId: row.transition_record_id,
    sourceStateId: row.source_state_id,
    targetStateId: row.target_state_id,
    eventName: row.event_name,
    payload: row.payload_snapshot ? JSON.parse(row.payload_snapshot) : null,
    context: row.context_data ? JSON.parse(row.context_data) : null,
    requestUrl: row.request_url,
    requestHeaders: row.request_headers_json ? JSON.parse(row.request_headers_json) : null,
    requestBody: row.request_body_json ? JSON.parse(row.request_body_json) : null,
    requestTime: row.request_time,
    responseStatus: row.response_status,
    responseBody: row.response_body ? JSON.parse(row.response_body) : null,
    responseDurationMs: row.response_duration_ms,
    retryCount: row.retry_count,
    finalStatus: row.final_status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    configName: row.config_name || undefined
  };
}

async function getDeliveries({ machineId, instanceId, configId, status, fromTime, toTime, limit = 50, offset = 0 } = {}) {
  let sql = `
    SELECT wd.*, wc.name as config_name
    FROM webhook_deliveries wd
    LEFT JOIN webhook_configs wc ON wd.config_id = wc.id
    WHERE 1=1
  `;
  const params = [];

  if (machineId) { sql += ' AND wd.machine_id = ?'; params.push(machineId); }
  if (instanceId) { sql += ' AND wd.instance_id = ?'; params.push(instanceId); }
  if (configId) { sql += ' AND wd.config_id = ?'; params.push(configId); }
  if (status) { sql += ' AND wd.final_status = ?'; params.push(status); }
  if (fromTime) { sql += ' AND wd.created_at >= ?'; params.push(fromTime); }
  if (toTime) { sql += ' AND wd.created_at <= ?'; params.push(toTime); }

  sql += ' ORDER BY wd.created_at DESC';
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = await all(sql, params);
  return rows.map(rowToDelivery);
}

async function countDeliveries({ machineId, instanceId, configId, status, fromTime, toTime } = {}) {
  let sql = 'SELECT COUNT(*) as cnt FROM webhook_deliveries WHERE 1=1';
  const params = [];

  if (machineId) { sql += ' AND machine_id = ?'; params.push(machineId); }
  if (instanceId) { sql += ' AND instance_id = ?'; params.push(instanceId); }
  if (configId) { sql += ' AND config_id = ?'; params.push(configId); }
  if (status) { sql += ' AND final_status = ?'; params.push(status); }
  if (fromTime) { sql += ' AND created_at >= ?'; params.push(fromTime); }
  if (toTime) { sql += ' AND created_at <= ?'; params.push(toTime); }

  const row = await get(sql, params);
  return row ? row.cnt : 0;
}

async function getDeliveryById(deliveryId) {
  const row = await get(`
    SELECT wd.*, wc.name as config_name
    FROM webhook_deliveries wd
    LEFT JOIN webhook_configs wc ON wd.config_id = wc.id
    WHERE wd.id = ?
  `, [deliveryId]);
  return rowToDelivery(row);
}

async function getCircuitBreakerStatus(configId) {
  const config = await getWebhookConfigById(configId);
  if (!config) throw new Error('Webhook config not found');

  const state = getCircuitState(configId);
  const isOpen = checkCircuitBreaker(configId, config.circuitBreakerResetMs);

  return {
    configId,
    circuitOpen: isOpen,
    consecutiveFailures: state.consecutiveFailures,
    circuitOpenAt: state.circuitOpenAt ? new Date(state.circuitOpenAt).toISOString() : null,
    threshold: config.circuitBreakerThreshold,
    resetMs: config.circuitBreakerResetMs,
    remainingResetMs: isOpen && state.circuitOpenAt
      ? Math.max(0, config.circuitBreakerResetMs - (Date.now() - state.circuitOpenAt))
      : 0
  };
}

async function resetCircuitBreakerManually(configId) {
  const config = await getWebhookConfigById(configId);
  if (!config) throw new Error('Webhook config not found');
  resetCircuitBreaker(configId);
  return { success: true, configId };
}

async function seedDemoWebhookData() {
  const configCount = await get('SELECT COUNT(*) as cnt FROM webhook_configs');
  const orderMachine = await get("SELECT * FROM machines WHERE name = ? ORDER BY version DESC LIMIT 1", ['订单审批']);
  if (!orderMachine) return;

  const definition = JSON.parse(orderMachine.definition);
  const transitions = definition.transitions || [];

  const approveTransition = transitions.find(t => {
    const source = definition.states.find(s => s.id === t.sourceStateId);
    const target = definition.states.find(s => s.id === t.targetStateId);
    return source?.name === '待审批' && target?.name === '已批准' && t.event === 'approve';
  });

  if (!approveTransition) {
    console.log('[Webhook] Could not find 待审批→已批准 transition for demo data');
    return;
  }

  let demoConfig = null;

  if (configCount.cnt === 0) {
    demoConfig = await addWebhookConfig({
      machineId: orderMachine.id,
      transitionId: approveTransition.id,
      name: '订单批准通知 - Demo Echo',
      url: 'http://localhost:3000/api/webhooks/echo',
      method: 'POST',
      headers: { 'X-Webhook-Source': 'workflow-demo' },
      maxRetries: 3,
      retryIntervalMs: 2000,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 30000,
      timeoutMs: 5000,
      enabled: true,
      priority: 0
    });
    console.log('[Webhook] Demo webhook config created for 待审批→已批准 transition');
  } else {
    const existingConfigs = await getWebhookConfigsByTransition(orderMachine.id, approveTransition.id, { includeDisabled: true });
    demoConfig = existingConfigs[0] || null;
  }

  if (!demoConfig) {
    const configs = await getWebhookConfigsByMachineId(orderMachine.id, { includeDisabled: true });
    demoConfig = configs[0] || null;
  }

  if (!demoConfig) return;

  const deliveryCount = await get('SELECT COUNT(*) as cnt FROM webhook_deliveries');
  if (deliveryCount.cnt > 0) {
    console.log('[Webhook] Demo delivery records already exist, skipping');
    return;
  }

  const instanceRows = await all(
    'SELECT * FROM instances WHERE machine_id = ? ORDER BY created_at ASC LIMIT 5',
    [orderMachine.id]
  );

  if (instanceRows.length === 0) return;

  const baseTime = Date.now() - 2 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < Math.min(6, instanceRows.length); i++) {
    const inst = instanceRows[i];
    const now = new Date(baseTime + i * 3600 * 1000).toISOString();
    const payload = { amount: 1000 + i * 500, approvedBy: `demo_manager_${i}` };
    const context = { orderId: `ORD-WEBHOOK-DEMO-${String(i + 1).padStart(3, '0')}`, amount: payload.amount };
    const requestPayload = {
      instanceId: inst.id,
      machineId: orderMachine.id,
      sourceStateId: approveTransition.sourceStateId,
      targetStateId: approveTransition.targetStateId,
      sourceStateName: '待审批',
      targetStateName: '已批准',
      event: 'approve',
      payload,
      context,
      transitionRecordId: uuidv4(),
      triggeredAt: now
    };

    const isSuccess = i < 4;

    const deliveryId = uuidv4();
    await run(
      `INSERT INTO webhook_deliveries (
        id, config_id, machine_id, instance_id, transition_record_id,
        source_state_id, target_state_id, event_name, payload_snapshot,
        context_data, request_url, request_headers_json, request_body_json,
        request_time, response_status, response_body, response_duration_ms,
        retry_count, final_status, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        deliveryId, demoConfig.id, orderMachine.id, inst.id, requestPayload.transitionRecordId,
        approveTransition.sourceStateId, approveTransition.targetStateId, 'approve',
        JSON.stringify(payload), JSON.stringify(context),
        demoConfig.url, JSON.stringify(demoConfig.headers), JSON.stringify(requestPayload),
        now,
        isSuccess ? 200 : 500,
        isSuccess ? JSON.stringify({ status: 'ok', echo: requestPayload }) : JSON.stringify({ error: 'Internal Server Error' }),
        isSuccess ? 45 + i * 10 : 1500 + i * 100,
        isSuccess ? 0 : i === 4 ? 2 : 0,
        isSuccess ? DELIVERY_STATUS.SUCCESS : i === 5 ? DELIVERY_STATUS.CIRCUIT_SKIPPED : DELIVERY_STATUS.FAILED,
        isSuccess ? null : i === 5 ? 'Circuit breaker open - skipped delivery' : 'HTTP 500 - Internal Server Error',
        now
      ]
    );
  }

  console.log('[Webhook] Demo delivery records seeded: 4 success, 1 failed, 1 circuit_skipped');
}

module.exports = {
  DELIVERY_STATUS,
  initWebhookDB,
  addWebhookConfig,
  updateWebhookConfig,
  deleteWebhookConfig,
  getWebhookConfigById,
  getWebhookConfigsByMachineId,
  getWebhookConfigsByTransition,
  listAllWebhookConfigs,
  triggerTransitionWebhooks,
  getDeliveries,
  countDeliveries,
  getDeliveryById,
  getCircuitBreakerStatus,
  resetCircuitBreakerManually,
  seedDemoWebhookData
};
