const { run, get, all } = require('./db');

function parseTimeFilter(req) {
  const { from, to } = req.query;
  const result = {};
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) result.from = d.toISOString();
  }
  if (to) {
    const d = new Date(to);
    if (!isNaN(d.getTime())) result.to = d.toISOString();
  }
  return result;
}

function buildTimeWhere(timeFilter, createdAtCol = 'created_at') {
  const where = [];
  const params = [];
  if (timeFilter.from) {
    where.push(`${createdAtCol} >= ?`);
    params.push(timeFilter.from);
  }
  if (timeFilter.to) {
    where.push(`${createdAtCol} <= ?`);
    params.push(timeFilter.to);
  }
  return { where, params, whereClause: where.length ? 'WHERE ' + where.join(' AND ') : '' };
}

function percentile(sortedValues, p) {
  if (!sortedValues || sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

function buildDurationBuckets(durations) {
  const buckets = [
    { label: '< 1s', minMs: 0, maxMs: 1000, count: 0 },
    { label: '1s - 10s', minMs: 1000, maxMs: 10000, count: 0 },
    { label: '10s - 1m', minMs: 10000, maxMs: 60000, count: 0 },
    { label: '1m - 10m', minMs: 60000, maxMs: 600000, count: 0 },
    { label: '10m - 1h', minMs: 600000, maxMs: 3600000, count: 0 },
    { label: '> 1h', minMs: 3600000, maxMs: null, count: 0 }
  ];
  for (const d of durations) {
    for (const b of buckets) {
      if (b.maxMs === null) {
        if (d >= b.minMs) {
          b.count++;
          break;
        }
      } else if (d >= b.minMs && d < b.maxMs) {
        b.count++;
        break;
      }
    }
  }
  return buckets;
}

async function getStateHeatmap(machineId, timeFilter) {
  const machine = await get('SELECT * FROM machines WHERE id = ?', [machineId]);
  if (!machine) return null;
  const definition = JSON.parse(machine.definition);
  const stateMap = new Map();
  for (const s of definition.states) {
    stateMap.set(s.id, { id: s.id, name: s.name });
  }

  const durWhere = buildTimeWhere(timeFilter, 'entered_at');
  const durationsRows = await all(
    `SELECT state_id, duration_ms FROM state_durations WHERE machine_id = ? AND duration_ms IS NOT NULL ${durWhere.whereClause ? 'AND ' + durWhere.whereClause.replace('WHERE ', '') : ''}`,
    [machineId, ...durWhere.params]
  );

  const stats = new Map();
  for (const s of definition.states) {
    stats.set(s.id, { stateId: s.id, stateName: s.name, visitCount: 0, totalDurationMs: 0, durations: [] });
  }
  for (const row of durationsRows) {
    if (stats.has(row.state_id)) {
      const st = stats.get(row.state_id);
      st.visitCount++;
      st.totalDurationMs += row.duration_ms || 0;
      st.durations.push(row.duration_ms || 0);
    }
  }

  const result = [];
  let maxAvgDuration = 0;
  let maxVisitCount = 0;
  for (const st of stats.values()) {
    st.avgDurationMs = st.visitCount > 0 ? Math.round(st.totalDurationMs / st.visitCount) : 0;
    maxAvgDuration = Math.max(maxAvgDuration, st.avgDurationMs);
    maxVisitCount = Math.max(maxVisitCount, st.visitCount);
  }
  for (const st of stats.values()) {
    let bottleneckScore = 0;
    if (maxAvgDuration > 0 && maxVisitCount > 0) {
      const durScore = st.avgDurationMs / maxAvgDuration;
      const visitScore = st.visitCount / maxVisitCount;
      bottleneckScore = Math.round((durScore * 0.6 + visitScore * 0.4) * 100) / 100;
    }
    result.push({
      stateId: st.stateId,
      stateName: st.stateName,
      visitCount: st.visitCount,
      avgDurationMs: st.avgDurationMs,
      totalDurationMs: st.totalDurationMs,
      bottleneckScore
    });
  }
  result.sort((a, b) => b.bottleneckScore - a.bottleneckScore);
  return result;
}

async function getTransitionFrequency(machineId, timeFilter) {
  const machine = await get('SELECT * FROM machines WHERE id = ?', [machineId]);
  if (!machine) return null;
  const definition = JSON.parse(machine.definition);
  const stateNameMap = new Map();
  for (const s of definition.states) stateNameMap.set(s.id, s.name);

  const tWhere = buildTimeWhere(timeFilter);
  const rows = await all(
    `SELECT from_state_id, to_state_id, event_name, COUNT(*) as trigger_count, MIN(created_at) as first_triggered_at, MAX(created_at) as last_triggered_at
     FROM transitions
     WHERE instance_id IN (SELECT id FROM instances WHERE machine_id = ?)
     ${tWhere.whereClause ? 'AND ' + tWhere.whereClause.replace('WHERE ', '') : ''}
     GROUP BY from_state_id, to_state_id, event_name
     ORDER BY trigger_count DESC`,
    [machineId, ...tWhere.params]
  );

  let maxCount = 0;
  for (const r of rows) maxCount = Math.max(maxCount, r.trigger_count);

  return rows.map((r, idx) => ({
    rank: idx + 1,
    fromStateId: r.from_state_id,
    fromStateName: stateNameMap.get(r.from_state_id) || r.from_state_id,
    toStateId: r.to_state_id,
    toStateName: stateNameMap.get(r.to_state_id) || r.to_state_id,
    event: r.event_name,
    triggerCount: r.trigger_count,
    relativeFrequency: maxCount > 0 ? Math.round((r.trigger_count / maxCount) * 100) / 100 : 0,
    firstTriggeredAt: r.first_triggered_at,
    lastTriggeredAt: r.last_triggered_at
  }));
}

async function getInstanceLifecycle(machineId, timeFilter) {
  const machine = await get('SELECT * FROM machines WHERE id = ?', [machineId]);
  if (!machine) return null;
  const definition = JSON.parse(machine.definition);

  const iWhere = buildTimeWhere(timeFilter, 'created_at');
  const instanceRows = await all(
    `SELECT id, created_at, is_final, current_state_id FROM instances WHERE machine_id = ? ${iWhere.whereClause ? 'AND ' + iWhere.whereClause.replace('WHERE ', '') : ''}`,
    [machineId, ...iWhere.params]
  );

  const instanceIds = instanceRows.map(r => r.id);
  const transitionsMap = new Map();
  if (instanceIds.length > 0) {
    const placeholders = instanceIds.map(() => '?').join(',');
    const tRows = await all(
      `SELECT instance_id, created_at FROM transitions WHERE instance_id IN (${placeholders}) ORDER BY created_at DESC`,
      instanceIds
    );
    for (const t of tRows) {
      if (!transitionsMap.has(t.instance_id)) {
        transitionsMap.set(t.instance_id, t.created_at);
      }
    }
  }

  const completedDurations = [];
  const inProgressDurations = [];
  const now = Date.now();
  for (const inst of instanceRows) {
    const startedAt = new Date(inst.created_at).getTime();
    const lastTransitionAt = transitionsMap.get(inst.id);
    let endedAt = null;
    if (inst.is_final) {
      endedAt = lastTransitionAt ? new Date(lastTransitionAt).getTime() : startedAt;
      completedDurations.push(endedAt - startedAt);
    } else {
      inProgressDurations.push(now - startedAt);
    }
  }

  const allDurations = [...completedDurations, ...inProgressDurations];
  allDurations.sort((a, b) => a - b);
  completedDurations.sort((a, b) => a - b);

  return {
    totalInstances: instanceRows.length,
    completedInstances: completedDurations.length,
    inProgressInstances: inProgressDurations.length,
    completed: {
      count: completedDurations.length,
      totalDurationMs: completedDurations.reduce((s, d) => s + d, 0),
      avgDurationMs: completedDurations.length > 0 ? Math.round(completedDurations.reduce((s, d) => s + d, 0) / completedDurations.length) : 0,
      minDurationMs: completedDurations.length > 0 ? completedDurations[0] : 0,
      maxDurationMs: completedDurations.length > 0 ? completedDurations[completedDurations.length - 1] : 0,
      p50: Math.round(percentile(completedDurations, 50)),
      p90: Math.round(percentile(completedDurations, 90)),
      p99: Math.round(percentile(completedDurations, 99)),
      distribution: buildDurationBuckets(completedDurations)
    },
    all: {
      count: allDurations.length,
      p50: Math.round(percentile(allDurations, 50)),
      p90: Math.round(percentile(allDurations, 90)),
      p99: Math.round(percentile(allDurations, 99)),
      distribution: buildDurationBuckets(allDurations)
    }
  };
}

async function recordStateDuration(instanceId, machineId, stateId, enteredAt, leftAt) {
  try {
    const entered = new Date(enteredAt).getTime();
    const left = new Date(leftAt).getTime();
    const durationMs = Math.max(0, left - entered);
    const id = require('uuid').v4();
    await run(
      'INSERT INTO state_durations (id, instance_id, machine_id, state_id, entered_at, left_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, instanceId, machineId, stateId, enteredAt, leftAt, durationMs]
    );
  } catch (e) {
    console.error('Failed to record state duration:', e);
  }
}

module.exports = {
  parseTimeFilter,
  getStateHeatmap,
  getTransitionFrequency,
  getInstanceLifecycle,
  recordStateDuration
};
