const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');

const SEVERITY = {
  BLOCKING: 'blocking',
  WARNING: 'warning',
  ADVISORY: 'advisory'
};

const ISSUE_TYPES = {
  UNREACHABLE_STATE: 'unreachable_state',
  DEAD_END_STATE: 'dead_end_state',
  NO_EXIT_LOOP: 'no_exit_loop',
  GUARD_COVERAGE_GAP: 'guard_coverage_gap'
};

function analyzeMachineDefinition(definition) {
  const issues = [];
  const { states, transitions } = definition;

  if (!states || states.length === 0) {
    return {
      issues: [{
        type: 'invalid_definition',
        severity: SEVERITY.BLOCKING,
        message: '状态机定义为空，没有任何状态',
        details: {}
      }],
      summary: buildSummary([]),
      pass: false
    };
  }

  const stateMap = new Map();
  for (const s of states) {
    stateMap.set(s.id, s);
  }

  const initialState = states.find(s => s.isInitial);

  detectUnreachableStates(states, transitions, initialState, stateMap, issues);
  detectDeadEndStates(states, transitions, stateMap, issues);
  detectNoExitLoops(states, transitions, stateMap, issues);
  detectGuardCoverageGaps(states, transitions, stateMap, issues);

  const summary = buildSummary(issues);
  const pass = !issues.some(i => i.severity === SEVERITY.BLOCKING);

  return { issues, summary, pass };
}

function detectUnreachableStates(states, transitions, initialState, stateMap, issues) {
  if (!initialState) {
    issues.push({
      type: ISSUE_TYPES.UNREACHABLE_STATE,
      severity: SEVERITY.BLOCKING,
      message: '状态机没有初始状态，所有状态均不可达',
      details: { stateIds: states.map(s => s.id) }
    });
    return;
  }

  const reachable = new Set();
  const queue = [initialState.id];
  reachable.add(initialState.id);

  while (queue.length > 0) {
    const current = queue.shift();
    const outgoing = transitions.filter(t => t.sourceStateId === current);
    for (const t of outgoing) {
      if (!reachable.has(t.targetStateId) && stateMap.has(t.targetStateId)) {
        reachable.add(t.targetStateId);
        queue.push(t.targetStateId);
      }
    }
  }

  const unreachable = states.filter(s => !reachable.has(s.id));
  for (const s of unreachable) {
    issues.push({
      type: ISSUE_TYPES.UNREACHABLE_STATE,
      severity: SEVERITY.BLOCKING,
      message: `状态 "${s.name}" 不可达：从初始状态出发没有任何路径能到达该状态`,
      details: {
        stateId: s.id,
        stateName: s.name
      }
    });
  }
}

function detectDeadEndStates(states, transitions, stateMap, issues) {
  for (const s of states) {
    if (s.isFinal) continue;

    const outgoing = transitions.filter(t => t.sourceStateId === s.id);
    if (outgoing.length === 0) {
      issues.push({
        type: ISSUE_TYPES.DEAD_END_STATE,
        severity: SEVERITY.BLOCKING,
        message: `状态 "${s.name}" 是死端：非终态但没有任何出向转换，实例一旦进入就无法继续流转`,
        details: {
          stateId: s.id,
          stateName: s.name
        }
      });
    }
  }
}

function detectNoExitLoops(states, transitions, stateMap, issues) {
  const nonFinalIds = states.filter(s => !s.isFinal).map(s => s.id);
  if (nonFinalIds.length === 0) return;

  const sccs = findSCCs(nonFinalIds, transitions);

  for (const scc of sccs) {
    if (scc.length < 1) continue;

    const hasExit = scc.some(stateId => {
      const outgoing = transitions.filter(t => t.sourceStateId === stateId);
      return outgoing.some(t => !scc.includes(t.targetStateId));
    });

    if (!hasExit && (scc.length > 1 || (scc.length === 1 && hasSelfLoop(scc[0], transitions)))) {
      const loopStates = scc.map(id => {
        const s = stateMap.get(id);
        return { stateId: id, stateName: s ? s.name : id };
      });
      issues.push({
        type: ISSUE_TYPES.NO_EXIT_LOOP,
        severity: SEVERITY.WARNING,
        message: `存在无出路循环：${loopStates.map(s => `"${s.stateName}"`).join(' ↔ ')} 之间互相可达，但没有任何转换能跳出该循环`,
        details: {
          states: loopStates
        }
      });
    }
  }
}

function findSCCs(nodeIds, transitions) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlink = new Map();
  const result = [];

  function strongconnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const outgoing = transitions.filter(t => t.sourceStateId === v);
    for (const t of outgoing) {
      const w = t.targetStateId;
      if (!nodeIds.includes(w)) continue;

      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      result.push(scc);
    }
  }

  for (const v of nodeIds) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
  }

  return result;
}

function hasSelfLoop(stateId, transitions) {
  return transitions.some(t => t.sourceStateId === stateId && t.targetStateId === stateId);
}

function detectGuardCoverageGaps(states, transitions, stateMap, issues) {
  for (const s of states) {
    const outgoing = transitions.filter(t => t.sourceStateId === s.id);
    const byEvent = new Map();

    for (const t of outgoing) {
      if (!byEvent.has(t.event)) {
        byEvent.set(t.event, []);
      }
      byEvent.get(t.event).push(t);
    }

    for (const [event, eventTransitions] of byEvent) {
      const guardedCount = eventTransitions.filter(t => t.guard && t.guard.trim()).length;
      const hasUnguarded = eventTransitions.some(t => !t.guard || !t.guard.trim());

      if (guardedCount > 0 && !hasUnguarded) {
        issues.push({
          type: ISSUE_TYPES.GUARD_COVERAGE_GAP,
          severity: SEVERITY.WARNING,
          message: `状态 "${s.name}" 的事件 "${event}" 配置了 ${guardedCount} 条带守卫的转换，但没有无守卫兜底。若所有守卫都不满足，该事件会被静默丢弃`,
          details: {
            stateId: s.id,
            stateName: s.name,
            event,
            guardedTransitionCount: guardedCount
          }
        });
      }
    }
  }
}

function buildSummary(issues) {
  const blocking = issues.filter(i => i.severity === SEVERITY.BLOCKING);
  const warning = issues.filter(i => i.severity === SEVERITY.WARNING);
  const advisory = issues.filter(i => i.severity === SEVERITY.ADVISORY);

  return {
    total: issues.length,
    blockingCount: blocking.length,
    warningCount: warning.length,
    advisoryCount: advisory.length,
    byType: {
      [ISSUE_TYPES.UNREACHABLE_STATE]: issues.filter(i => i.type === ISSUE_TYPES.UNREACHABLE_STATE).length,
      [ISSUE_TYPES.DEAD_END_STATE]: issues.filter(i => i.type === ISSUE_TYPES.DEAD_END_STATE).length,
      [ISSUE_TYPES.NO_EXIT_LOOP]: issues.filter(i => i.type === ISSUE_TYPES.NO_EXIT_LOOP).length,
      [ISSUE_TYPES.GUARD_COVERAGE_GAP]: issues.filter(i => i.type === ISSUE_TYPES.GUARD_COVERAGE_GAP).length
    }
  };
}

async function initAnalysisDB() {
  await run(`
    CREATE TABLE IF NOT EXISTS analysis_reports (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      machine_version INTEGER NOT NULL,
      machine_name TEXT NOT NULL,
      analyzed_at TEXT NOT NULL,
      pass INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      definition_snapshot TEXT NOT NULL,
      triggered_by TEXT NOT NULL DEFAULT 'manual',
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    );
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_analysis_reports_machine ON analysis_reports(machine_id);
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_analysis_reports_machine_version ON analysis_reports(machine_id, machine_version);
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_analysis_reports_created ON analysis_reports(analyzed_at);
  `);
}

async function saveAnalysisReport({ machineId, machineVersion, machineName, analysisResult, triggeredBy, definitionSnapshot }) {
  const id = uuidv4();
  const now = new Date().toISOString();

  await run(
    'INSERT INTO analysis_reports (id, machine_id, machine_version, machine_name, analyzed_at, pass, summary_json, issues_json, definition_snapshot, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      machineId,
      machineVersion,
      machineName,
      now,
      analysisResult.pass ? 1 : 0,
      JSON.stringify(analysisResult.summary),
      JSON.stringify(analysisResult.issues),
      JSON.stringify(definitionSnapshot),
      triggeredBy || 'manual'
    ]
  );

  return getAnalysisReportById(id);
}

async function getAnalysisReportById(id) {
  const row = await get('SELECT * FROM analysis_reports WHERE id = ?', [id]);
  if (!row) return null;
  return rowToReport(row);
}

async function getAnalysisReportsByMachine(machineId, limit = 20) {
  const rows = await all(
    'SELECT * FROM analysis_reports WHERE machine_id = ? ORDER BY analyzed_at DESC LIMIT ?',
    [machineId, limit]
  );
  return rows.map(rowToReport);
}

async function getAnalysisReportsByMachineAndVersion(machineId, version) {
  const rows = await all(
    'SELECT * FROM analysis_reports WHERE machine_id = ? AND machine_version = ? ORDER BY analyzed_at DESC',
    [machineId, version]
  );
  return rows.map(rowToReport);
}

async function getLatestAnalysisReport(machineId) {
  const row = await get(
    'SELECT * FROM analysis_reports WHERE machine_id = ? ORDER BY analyzed_at DESC LIMIT 1',
    [machineId]
  );
  if (!row) return null;
  return rowToReport(row);
}

async function runAnalysisForMachine(machine, triggeredBy = 'manual') {
  const definition = machine.definition;
  const result = analyzeMachineDefinition(definition);

  return saveAnalysisReport({
    machineId: machine.id,
    machineVersion: machine.version,
    machineName: machine.name,
    analysisResult: result,
    triggeredBy,
    definitionSnapshot: definition
  });
}

function rowToReport(row) {
  return {
    id: row.id,
    machineId: row.machine_id,
    machineVersion: row.machine_version,
    machineName: row.machine_name,
    analyzedAt: row.analyzed_at,
    pass: !!row.pass,
    summary: JSON.parse(row.summary_json || '{}'),
    issues: JSON.parse(row.issues_json || '[]'),
    triggeredBy: row.triggered_by
  };
}

module.exports = {
  SEVERITY,
  ISSUE_TYPES,
  analyzeMachineDefinition,
  initAnalysisDB,
  saveAnalysisReport,
  getAnalysisReportById,
  getAnalysisReportsByMachine,
  getAnalysisReportsByMachineAndVersion,
  getLatestAnalysisReport,
  runAnalysisForMachine
};
