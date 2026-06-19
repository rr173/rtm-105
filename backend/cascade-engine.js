const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { evaluateGuard } = require('./guard');
const {
  buildAndSaveTrace,
  linkTraceToTransition
} = require('./decision-trace');
const { recordStateDuration } = require('./metrics');
const { resolveSlaViolation } = require('./sla-engine');
const {
  scheduleTimeout,
  clearInstanceTimeout
} = require('./timeout-manager');
const {
  auditInstanceHistory,
  recordViolation
} = require('./compliance-engine');
const {
  triggerTransitionWebhooks
} = require('./webhook-engine');
const { isInstanceFrozen } = require('./takeover-engine');
const { getMachineById } = require('./version-migration');

const MAX_CASCADE_DEPTH = 3;
const LINK_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  BROKEN: 'broken'
};
const LINK_TYPE = {
  PARENT_CHILD: 'parent_child',
  PEER: 'peer'
};

function rowToLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceInstanceId: row.source_instance_id,
    targetInstanceId: row.target_instance_id,
    linkType: row.link_type,
    triggerRules: JSON.parse(row.trigger_rules_json || '[]'),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceMachineId: row.source_machine_id,
    targetMachineId: row.target_machine_id
  };
}

function rowToSkipLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    linkId: row.link_id,
    sourceInstanceId: row.source_instance_id,
    targetInstanceId: row.target_instance_id,
    sourceEvent: row.source_event,
    targetEvent: row.target_event,
    sourceStateId: row.source_state_id,
    reason: row.reason,
    cascadeDepth: row.cascade_depth,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    createdAt: row.created_at
  };
}

async function recordSkipLog({
  linkId,
  sourceInstanceId,
  targetInstanceId,
  sourceEvent,
  targetEvent,
  sourceStateId,
  reason,
  cascadeDepth,
  detail
}) {
  const id = uuidv4();
  const now = new Date().toISOString();
  const effectiveLinkId = linkId || null;
  const effectiveTargetInstanceId = targetInstanceId || null;
  const effectiveTargetEvent = targetEvent || null;
  const effectiveSourceStateId = sourceStateId || null;
  const effectiveCascadeDepth = typeof cascadeDepth === 'number' ? cascadeDepth : null;
  const effectiveDetailJson = detail ? JSON.stringify(detail) : null;

  await run(
    `INSERT INTO instance_link_skip_logs 
     (id, link_id, source_instance_id, target_instance_id, source_event, target_event, source_state_id, reason, cascade_depth, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      effectiveLinkId,
      sourceInstanceId,
      effectiveTargetInstanceId,
      sourceEvent,
      effectiveTargetEvent,
      effectiveSourceStateId,
      reason,
      effectiveCascadeDepth,
      effectiveDetailJson,
      now
    ]
  );
  return { id, createdAt: now };
}

async function detectCycle(sourceInstanceId, targetInstanceId) {
  const visited = new Set();
  const path = [];
  const adjacency = new Map();

  const activeLinks = await all(
    `SELECT source_instance_id, target_instance_id FROM instance_links 
     WHERE status = ?`,
    [LINK_STATUS.ACTIVE]
  );

  for (const link of activeLinks) {
    if (!adjacency.has(link.source_instance_id)) {
      adjacency.set(link.source_instance_id, []);
    }
    adjacency.get(link.source_instance_id).push(link.target_instance_id);
  }

  if (!adjacency.has(sourceInstanceId)) {
    adjacency.set(sourceInstanceId, []);
  }
  adjacency.get(sourceInstanceId).push(targetInstanceId);

  function dfs(node) {
    if (path.includes(node)) {
      const cycleStartIdx = path.indexOf(node);
      return path.slice(cycleStartIdx).concat(node);
    }
    if (visited.has(node)) return null;

    visited.add(node);
    path.push(node);

    const neighbors = adjacency.get(node) || [];
    for (const next of neighbors) {
      const result = dfs(next);
      if (result) return result;
    }

    path.pop();
    return null;
  }

  for (const start of adjacency.keys()) {
    if (!visited.has(start)) {
      const cycle = dfs(start);
      if (cycle) return cycle;
    }
  }

  return null;
}

async function createLink({
  sourceInstanceId,
  targetInstanceId,
  linkType,
  triggerRules
}) {
  if (!sourceInstanceId || !targetInstanceId) {
    throw new Error('sourceInstanceId and targetInstanceId are required');
  }
  if (sourceInstanceId === targetInstanceId) {
    throw new Error('Cannot create link from instance to itself');
  }
  if (!linkType || !Object.values(LINK_TYPE).includes(linkType)) {
    throw new Error(`linkType must be one of: ${Object.values(LINK_TYPE).join(', ')}`);
  }
  if (!Array.isArray(triggerRules) || triggerRules.length === 0) {
    throw new Error('triggerRules must be a non-empty array');
  }

  for (const rule of triggerRules) {
    if (!rule.sourceEvent || !rule.targetEvent || !rule.targetStateId) {
      throw new Error('Each trigger rule must have sourceEvent, targetEvent, and targetStateId');
    }
  }

  const sourceInstance = await get(
    'SELECT * FROM instances WHERE id = ?',
    [sourceInstanceId]
  );
  if (!sourceInstance) {
    throw new Error('Source instance not found');
  }

  const targetInstance = await get(
    'SELECT * FROM instances WHERE id = ?',
    [targetInstanceId]
  );
  if (!targetInstance) {
    throw new Error('Target instance not found');
  }

  const sourceMachine = await getMachineById(sourceInstance.machine_id);
  const targetMachine = await getMachineById(targetInstance.machine_id);
  if (!sourceMachine || !targetMachine) {
    throw new Error('Machine definition not found for one of the instances');
  }

  if (sourceMachine.name !== targetMachine.name) {
    throw new Error('Instances must belong to the same state machine (same name, possibly different versions)');
  }

  const cycle = await detectCycle(sourceInstanceId, targetInstanceId);
  if (cycle) {
    const error = new Error('Cycle detected in instance links');
    error.cyclePath = cycle;
    throw error;
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  await run(
    `INSERT INTO instance_links 
     (id, source_instance_id, target_instance_id, link_type, trigger_rules_json, status, created_at, updated_at, source_machine_id, target_machine_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sourceInstanceId,
      targetInstanceId,
      linkType,
      JSON.stringify(triggerRules),
      LINK_STATUS.ACTIVE,
      now,
      now,
      sourceInstance.machine_id,
      targetInstance.machine_id
    ]
  );

  return getLinkById(id);
}

async function getLinkById(id) {
  const row = await get(
    'SELECT * FROM instance_links WHERE id = ?',
    [id]
  );
  return rowToLink(row);
}

async function getLinksByMachineId(machineId, { includeBroken = false } = {}) {
  const statusClause = includeBroken
    ? 'AND (source_machine_id = ? OR target_machine_id = ?)'
    : 'AND status != ? AND (source_machine_id = ? OR target_machine_id = ?)';
  const params = includeBroken
    ? [machineId, machineId]
    : [LINK_STATUS.BROKEN, machineId, machineId];

  const rows = await all(
    `SELECT * FROM instance_links WHERE 1=1 ${statusClause} ORDER BY created_at DESC`,
    params
  );
  return rows.map(rowToLink);
}

async function getLinksByInstanceId(instanceId, { includeBroken = false } = {}) {
  const statusClause = includeBroken
    ? ''
    : 'AND status != ?';
  const params = includeBroken
    ? [instanceId, instanceId]
    : [LINK_STATUS.BROKEN, instanceId, instanceId];

  const rows = await all(
    `SELECT * FROM instance_links 
     WHERE 1=1 ${statusClause} AND (source_instance_id = ? OR target_instance_id = ?)
     ORDER BY created_at DESC`,
    params
  );
  return rows.map(rowToLink);
}

async function getActiveSourceLinks(sourceInstanceId) {
  const rows = await all(
    `SELECT * FROM instance_links 
     WHERE source_instance_id = ? AND status = ?`,
    [sourceInstanceId, LINK_STATUS.ACTIVE]
  );
  return rows.map(rowToLink);
}

async function pauseLink(id) {
  const link = await getLinkById(id);
  if (!link) {
    throw new Error('Link not found');
  }
  if (link.status === LINK_STATUS.BROKEN) {
    throw new Error('Cannot pause a broken link');
  }
  if (link.status === LINK_STATUS.PAUSED) {
    return link;
  }

  const now = new Date().toISOString();
  await run(
    'UPDATE instance_links SET status = ?, updated_at = ? WHERE id = ?',
    [LINK_STATUS.PAUSED, now, id]
  );
  return getLinkById(id);
}

async function resumeLink(id) {
  const link = await getLinkById(id);
  if (!link) {
    throw new Error('Link not found');
  }
  if (link.status === LINK_STATUS.BROKEN) {
    throw new Error('Cannot resume a broken link');
  }
  if (link.status === LINK_STATUS.ACTIVE) {
    return link;
  }

  const now = new Date().toISOString();
  await run(
    'UPDATE instance_links SET status = ?, updated_at = ? WHERE id = ?',
    [LINK_STATUS.ACTIVE, now, id]
  );
  return getLinkById(id);
}

async function deleteLink(id) {
  const result = await run(
    'DELETE FROM instance_links WHERE id = ?',
    [id]
  );
  return result.changes > 0;
}

async function markLinkAsBroken(id, reason) {
  const now = new Date().toISOString();
  await run(
    'UPDATE instance_links SET status = ?, updated_at = ? WHERE id = ? AND status != ?',
    [LINK_STATUS.BROKEN, now, id, LINK_STATUS.BROKEN]
  );
  console.log(`[Cascade] Link ${id} marked as broken: ${reason}`);
}

async function checkAndMarkBrokenLinks() {
  const nonBrokenLinks = await all(
    `SELECT * FROM instance_links WHERE status != ?`,
    [LINK_STATUS.BROKEN]
  );

  for (const link of nonBrokenLinks) {
    const sourceExists = await get(
      'SELECT id FROM instances WHERE id = ?',
      [link.source_instance_id]
    );
    const targetExists = await get(
      'SELECT id FROM instances WHERE id = ?',
      [link.target_instance_id]
    );

    if (!sourceExists) {
      await markLinkAsBroken(link.id, `Source instance ${link.source_instance_id} deleted`);
    } else if (!targetExists) {
      await markLinkAsBroken(link.id, `Target instance ${link.target_instance_id} deleted`);
    }
  }
}

async function getSkipLogsByLinkId(linkId, { limit = 50, offset = 0 } = {}) {
  const rows = await all(
    `SELECT * FROM instance_link_skip_logs 
     WHERE link_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [linkId, limit, offset]
  );
  return rows.map(rowToSkipLog);
}

async function getCascadeHistoryByLinkId(linkId, { limit = 50, offset = 0 } = {}) {
  const rows = await all(
    `SELECT t.*, il.source_instance_id, il.target_instance_id, il.link_type
     FROM transitions t
     CROSS JOIN instance_links il
     WHERE t.triggered_by = ?
     AND json_extract(t.cascade_detail, '$.linkId') = il.id
     AND il.id = ?
     ORDER BY t.created_at DESC
     LIMIT ? OFFSET ?`,
    ['cascade', linkId, limit, offset]
  );

  return rows.map(row => {
    const cascadeDetail = row.cascade_detail ? JSON.parse(row.cascade_detail) : null;
    return {
      id: row.id,
      instanceId: row.instance_id,
      fromStateId: row.from_state_id,
      toStateId: row.to_state_id,
      event: row.event_name,
      payload: row.payload_snapshot ? JSON.parse(row.payload_snapshot) : null,
      createdAt: row.created_at,
      triggeredBy: row.triggered_by,
      cascadeDetail,
      sourceInstanceId: row.source_instance_id,
      targetInstanceId: row.target_instance_id,
      linkType: row.link_type
    };
  });
}

async function cascadeSendEvent({
  targetInstanceId,
  event,
  payload,
  cascadeDetail,
  broadcastCallback
}) {
  const row = await get('SELECT * FROM instances WHERE id = ?', [targetInstanceId]);
  if (!row) {
    return { success: false, error: 'Target instance not found' };
  }

  if (row.is_final) {
    return { success: false, skipped: true, reason: 'target_in_final_state', error: 'Target instance is in final state' };
  }

  const frozen = await isInstanceFrozen(targetInstanceId);
  if (frozen) {
    return { success: false, skipped: true, reason: 'target_frozen', error: 'Target instance is frozen' };
  }

  const machine = await getMachineById(row.machine_id);
  if (!machine) {
    return { success: false, error: 'Machine not found' };
  }

  const context = JSON.parse(row.context_data);
  const currentStateId = row.current_state_id;

  const historyRows = await all(
    'SELECT * FROM transitions WHERE instance_id = ? ORDER BY created_at ASC',
    [targetInstanceId]
  );
  const history = historyRows.map(h => ({
    id: h.id,
    event: h.event_name,
    fromStateId: h.from_state_id,
    toStateId: h.to_state_id,
    payload: h.payload_snapshot ? JSON.parse(h.payload_snapshot) : null,
    createdAt: h.created_at
  }));

  const traceResult = await buildAndSaveTrace({
    machineId: machine.id,
    machineDefinition: machine.definition,
    instanceId: row.id,
    currentStateId,
    eventName: event,
    payload: payload || {},
    context,
    history,
    enteredStateAt: row.entered_state_at || row.created_at,
    triggeredBy: 'cascade'
  });

  if (traceResult.decisionResult === 'rejected_no_match') {
    return {
      success: false,
      skipped: true,
      reason: 'no_matching_transition',
      error: 'No matching transition for this event',
      traceId: traceResult.traceId
    };
  }

  if (traceResult.decisionResult === 'rejected_compliance') {
    const now = new Date().toISOString();
    for (const v of traceResult.complianceViolations) {
      try {
        await recordViolation({
          policyId: v.policyId,
          machineId: machine.id,
          instanceId: row.id,
          eventName: event,
          fromStateId: currentStateId,
          toStateId: traceResult.targetStateId,
          reason: v.reason,
          payloadSnapshot: payload,
          attemptedAt: now,
          detectedDuring: 'runtime'
        });
      } catch (e) {
        console.error('[Compliance] Failed to record violation:', e);
      }
    }
    return {
      success: false,
      skipped: true,
      reason: 'compliance_blocked',
      error: 'Compliance check failed',
      traceId: traceResult.traceId
    };
  }

  const targetState = machine.definition.states.find(s => s.id === traceResult.targetStateId);
  if (!targetState) {
    return { success: false, error: 'Target state not found' };
  }

  const transitionId = uuidv4();
  const now = new Date().toISOString();
  const isFinal = targetState.isFinal ? 1 : 0;

  await run(
    'UPDATE instances SET current_state_id = ?, is_final = ?, entered_state_at = ? WHERE id = ?',
    [targetState.id, isFinal, now, row.id]
  );

  await run(
    `INSERT INTO transitions 
     (id, instance_id, from_state_id, to_state_id, event_name, payload_snapshot, created_at, triggered_by, cascade_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      transitionId,
      row.id,
      currentStateId,
      targetState.id,
      event,
      JSON.stringify(payload || {}),
      now,
      'cascade',
      JSON.stringify(cascadeDetail)
    ]
  );

  await linkTraceToTransition(traceResult.traceId, transitionId);

  await recordStateDuration(row.id, row.machine_id, currentStateId, row.entered_state_at || row.created_at, now);
  await resolveSlaViolation(row.id, currentStateId, row.entered_state_at || row.created_at, now, false);
  if (targetState.isFinal) {
    await recordStateDuration(row.id, row.machine_id, targetState.id, now, now);
  }

  clearInstanceTimeout(row.id);
  if (!targetState.isFinal && targetState.timeout) {
    scheduleTimeout(row.id, targetState.timeout, now);
  }

  if (typeof broadcastCallback === 'function') {
    const wsMessage = {
      type: 'transition',
      instanceId: row.id,
      machineId: row.machine_id,
      fromStateId: currentStateId,
      toStateId: targetState.id,
      event,
      triggeredBy: 'cascade',
      cascadeDetail,
      timestamp: now,
      isFinal: !!isFinal
    };
    broadcastCallback(row.machine_id, wsMessage);
  }

  const matchedDefTransition = machine.definition.transitions.find(t =>
    t.sourceStateId === currentStateId &&
    t.targetStateId === targetState.id &&
    t.event === event
  );

  triggerTransitionWebhooks({
    machineId: row.machine_id,
    machineDefinition: machine.definition,
    instanceId: row.id,
    transitionRecordId: transitionId,
    sourceStateId: currentStateId,
    targetStateId: targetState.id,
    eventName: event,
    payload: payload || {},
    context: context,
    definitionTransitionId: matchedDefTransition ? matchedDefTransition.id : null
  }).catch(webhookErr => {
    console.error('[Webhook] Error triggering cascade transition webhooks (async):', webhookErr);
  });

  return {
    success: true,
    transitionId,
    fromStateId: currentStateId,
    toStateId: targetState.id,
    event,
    timestamp: now,
    isFinal: !!isFinal,
    machineId: row.machine_id,
    instanceId: row.id,
    traceId: traceResult.traceId
  };
}

async function processCascade({
  sourceInstanceId,
  sourceEvent,
  sourceToStateId,
  payload,
  depth = 0,
  visitedChain = [],
  broadcastCallback
}) {
  if (depth >= MAX_CASCADE_DEPTH) {
    console.warn(`[Cascade] Max depth (${MAX_CASCADE_DEPTH}) reached, skipping cascade from instance ${sourceInstanceId}`);
    try {
      await recordSkipLog({
        sourceInstanceId,
        sourceEvent,
        reason: 'max_depth_exceeded',
        cascadeDepth: depth,
        detail: {
          maxCascadeDepth: MAX_CASCADE_DEPTH,
          sourceToStateId,
          payload,
          visitedChain
        }
      });
    } catch (logErr) {
      console.error('[Cascade] Failed to record max_depth skip log:', logErr);
    }
    return { skipped: true, reason: 'max_depth_exceeded', results: [] };
  }

  await checkAndMarkBrokenLinks();

  const activeLinks = await getActiveSourceLinks(sourceInstanceId);
  const results = [];

  for (const link of activeLinks) {
    for (const rule of link.triggerRules) {
      if (rule.sourceEvent !== sourceEvent || rule.targetStateId !== sourceToStateId) {
        continue;
      }

      let cascadePayload;
      if (rule.payloadTransform && typeof rule.payloadTransform === 'function') {
        cascadePayload = rule.payloadTransform(payload);
      } else {
        cascadePayload = {
          ...(payload || {}),
          ...(rule.payload || {})
        };
      }

      const targetInstance = await get(
        'SELECT * FROM instances WHERE id = ?',
        [link.targetInstanceId]
      );

      if (!targetInstance) {
        await markLinkAsBroken(link.id, `Target instance ${link.targetInstanceId} not found during cascade`);
        continue;
      }

      if (targetInstance.is_final) {
        await recordSkipLog({
          linkId: link.id,
          sourceInstanceId,
          targetInstanceId: link.targetInstanceId,
          sourceEvent,
          targetEvent: rule.targetEvent,
          sourceStateId: sourceToStateId,
          reason: 'target_in_final_state'
        });
        results.push({
          linkId: link.id,
          rule,
          success: false,
          skipped: true,
          reason: 'target_in_final_state'
        });
        continue;
      }

      const targetFrozen = await isInstanceFrozen(link.targetInstanceId);
      if (targetFrozen) {
        await recordSkipLog({
          linkId: link.id,
          sourceInstanceId,
          targetInstanceId: link.targetInstanceId,
          sourceEvent,
          targetEvent: rule.targetEvent,
          sourceStateId: sourceToStateId,
          reason: 'target_frozen'
        });
        results.push({
          linkId: link.id,
          rule,
          success: false,
          skipped: true,
          reason: 'target_frozen'
        });
        continue;
      }

      const cascadeDetail = {
        depth: depth + 1,
        sourceInstanceId,
        linkId: link.id,
        linkType: link.linkType,
        rule: {
          sourceEvent: rule.sourceEvent,
          targetStateId: rule.targetStateId,
          targetEvent: rule.targetEvent
        },
        chain: [...visitedChain, { instanceId: sourceInstanceId, event: sourceEvent }]
      };

      const sendResult = await cascadeSendEvent({
        targetInstanceId: link.targetInstanceId,
        event: rule.targetEvent,
        payload: cascadePayload,
        cascadeDetail,
        broadcastCallback
      });

      results.push({
        linkId: link.id,
        rule,
        ...sendResult
      });

      if (sendResult.success) {
        const nextChain = [...visitedChain, { instanceId: sourceInstanceId, event: sourceEvent }];
        const nestedResults = await processCascade({
          sourceInstanceId: link.targetInstanceId,
          sourceEvent: rule.targetEvent,
          sourceToStateId: sendResult.toStateId,
          payload: cascadePayload,
          depth: depth + 1,
          visitedChain: nextChain,
          broadcastCallback
        });
        results.push(...(nestedResults.results || []));
      }
    }
  }

  return { depth, results };
}

module.exports = {
  LINK_STATUS,
  LINK_TYPE,
  MAX_CASCADE_DEPTH,
  createLink,
  getLinkById,
  getLinksByMachineId,
  getLinksByInstanceId,
  getActiveSourceLinks,
  pauseLink,
  resumeLink,
  deleteLink,
  markLinkAsBroken,
  checkAndMarkBrokenLinks,
  detectCycle,
  processCascade,
  getSkipLogsByLinkId,
  getCascadeHistoryByLinkId,
  recordSkipLog
};
