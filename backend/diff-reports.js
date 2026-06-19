const { run, get, all } = require('./db');
const { v4: uuidv4 } = require('uuid');
const { compareMachines } = require('./version-diff-engine');
const { assessMigrationImpact, assessImpactByDiff } = require('./impact-assessment');
const { getMachineById, getMachineVersionsByName } = require('./version-migration');

async function saveDiffReport({
  oldMachineId,
  newMachineId,
  diffResult,
  triggeredBy = 'publish'
}) {
  const oldMachine = await getMachineById(oldMachineId);
  const newMachine = await getMachineById(newMachineId);
  
  if (!oldMachine || !newMachine) {
    throw new Error('源或目标状态机不存在');
  }
  
  const reportId = uuidv4();
  const now = new Date().toISOString();
  
  await run(
    `INSERT INTO version_diff_reports 
     (id, machine_name, old_machine_id, new_machine_id, old_version, new_version, 
      diff_data, summary_json, has_changes, triggered_by, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reportId,
      oldMachine.name,
      oldMachineId,
      newMachineId,
      oldMachine.version,
      newMachine.version,
      JSON.stringify(diffResult),
      JSON.stringify(diffResult.summary),
      diffResult.hasChanges ? 1 : 0,
      triggeredBy,
      now
    ]
  );
  
  return {
    id: reportId,
    machineName: oldMachine.name,
    oldMachineId,
    newMachineId,
    oldVersion: oldMachine.version,
    newVersion: newMachine.version,
    summary: diffResult.summary,
    hasChanges: diffResult.hasChanges,
    triggeredBy,
    createdAt: now
  };
}

async function getDiffReportById(reportId) {
  const row = await get('SELECT * FROM version_diff_reports WHERE id = ?', [reportId]);
  if (!row) return null;
  
  return {
    id: row.id,
    machineName: row.machine_name,
    oldMachineId: row.old_machine_id,
    newMachineId: row.new_machine_id,
    oldVersion: row.old_version,
    newVersion: row.new_version,
    diffData: JSON.parse(row.diff_data),
    summary: JSON.parse(row.summary_json),
    hasChanges: !!row.has_changes,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at
  };
}

async function getDiffReportsByMachineName(machineName) {
  const rows = await all(
    'SELECT * FROM version_diff_reports WHERE machine_name = ? ORDER BY created_at DESC',
    [machineName]
  );
  
  return rows.map(row => ({
    id: row.id,
    machineName: row.machine_name,
    oldMachineId: row.old_machine_id,
    newMachineId: row.new_machine_id,
    oldVersion: row.old_version,
    newVersion: row.new_version,
    summary: JSON.parse(row.summary_json),
    hasChanges: !!row.has_changes,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at
  }));
}

async function listDiffReports(filters = {}) {
  let sql = 'SELECT * FROM version_diff_reports WHERE 1=1';
  const params = [];
  
  if (filters.machineName) {
    sql += ' AND machine_name = ?';
    params.push(filters.machineName);
  }
  
  if (filters.triggeredBy) {
    sql += ' AND triggered_by = ?';
    params.push(filters.triggeredBy);
  }
  
  sql += ' ORDER BY created_at DESC';
  
  if (filters.limit) {
    sql += ' LIMIT ?';
    params.push(filters.limit);
  }
  
  const rows = await all(sql, params);
  
  return rows.map(row => ({
    id: row.id,
    machineName: row.machine_name,
    oldMachineId: row.old_machine_id,
    newMachineId: row.new_machine_id,
    oldVersion: row.old_version,
    newVersion: row.new_version,
    summary: JSON.parse(row.summary_json),
    hasChanges: !!row.has_changes,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at
  }));
}

async function compareAndSaveDiff(oldMachineId, newMachineId, triggeredBy = 'manual') {
  const oldMachine = await getMachineById(oldMachineId);
  const newMachine = await getMachineById(newMachineId);
  
  if (!oldMachine || !newMachine) {
    throw new Error('源或目标状态机不存在');
  }
  
  if (oldMachine.name !== newMachine.name) {
    throw new Error('只能比较同名状态机的不同版本');
  }
  
  const diffResult = compareMachines(oldMachine, newMachine);
  
  const report = await saveDiffReport({
    oldMachineId,
    newMachineId,
    diffResult,
    triggeredBy
  });
  
  return {
    ...report,
    diffData: diffResult
  };
}

async function getLatestDiffReport(machineName) {
  const row = await get(
    'SELECT * FROM version_diff_reports WHERE machine_name = ? ORDER BY created_at DESC LIMIT 1',
    [machineName]
  );
  
  if (!row) return null;
  
  return {
    id: row.id,
    machineName: row.machine_name,
    oldMachineId: row.old_machine_id,
    newMachineId: row.new_machine_id,
    oldVersion: row.old_version,
    newVersion: row.new_version,
    diffData: JSON.parse(row.diff_data),
    summary: JSON.parse(row.summary_json),
    hasChanges: !!row.has_changes,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at
  };
}

async function getDiffReportWithImpact(reportId) {
  const report = await getDiffReportById(reportId);
  if (!report) return null;
  
  const impactRows = await all(
    'SELECT * FROM version_diff_impact WHERE diff_report_id = ? ORDER BY risk_level DESC, created_at ASC',
    [reportId]
  );
  
  const impacts = impactRows.map(row => ({
    id: row.id,
    instanceId: row.instance_id,
    currentStateId: row.current_state_id,
    riskLevel: row.risk_level,
    reasons: JSON.parse(row.reasons_json),
    createdAt: row.created_at
  }));
  
  const stats = {
    total: impacts.length,
    safe: impacts.filter(i => i.riskLevel === 'safe').length,
    attention: impacts.filter(i => i.riskLevel === 'attention').length,
    dangerous: impacts.filter(i => i.riskLevel === 'dangerous').length
  };
  
  return {
    ...report,
    impact: {
      stats,
      instances: impacts
    }
  };
}

async function saveImpactAssessment(diffReportId, impactResult) {
  const now = new Date().toISOString();
  
  for (const inst of impactResult.instances) {
    const impactId = uuidv4();
    await run(
      `INSERT INTO version_diff_impact 
       (id, diff_report_id, instance_id, current_state_id, risk_level, reasons_json, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        impactId,
        diffReportId,
        inst.instanceId,
        inst.currentStateId,
        inst.riskLevel,
        JSON.stringify(inst.reasons),
        now
      ]
    );
  }
  
  return {
    diffReportId,
    savedCount: impactResult.instances.length,
    stats: impactResult.stats
  };
}

async function generateAndSaveImpact(reportId) {
  const report = await getDiffReportById(reportId);
  if (!report) {
    throw new Error('差异报告不存在');
  }
  
  const impactResult = await assessMigrationImpact(
    report.oldMachineId,
    report.newMachineId
  );
  
  await saveImpactAssessment(reportId, impactResult);
  
  return {
    reportId,
    ...impactResult
  };
}

module.exports = {
  saveDiffReport,
  getDiffReportById,
  getDiffReportsByMachineName,
  listDiffReports,
  compareAndSaveDiff,
  getLatestDiffReport,
  getDiffReportWithImpact,
  saveImpactAssessment,
  generateAndSaveImpact
};
