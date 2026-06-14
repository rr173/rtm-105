const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'workflow.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function columnExists(tableName, columnName) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, (err, rows) => {
      if (err) reject(err);
      else resolve(rows.some(r => r.name === columnName));
    });
  });
}

async function migrateDB() {
  const hasEnteredStateAt = await columnExists('instances', 'entered_state_at');
  if (!hasEnteredStateAt) {
    await run('ALTER TABLE instances ADD COLUMN entered_state_at TEXT');
    console.log('Migrated: added instances.entered_state_at');
  }
  const hasTriggeredBy = await columnExists('transitions', 'triggered_by');
  if (!hasTriggeredBy) {
    await run('ALTER TABLE transitions ADD COLUMN triggered_by TEXT NOT NULL DEFAULT "user"');
    console.log('Migrated: added transitions.triggered_by');
  }
}

function initDB() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS machines (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          definition TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS instances (
          id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          current_state_id TEXT NOT NULL,
          context_data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          is_final INTEGER NOT NULL DEFAULT 0,
          entered_state_at TEXT,
          FOREIGN KEY (machine_id) REFERENCES machines(id)
        );

        CREATE TABLE IF NOT EXISTS transitions (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          from_state_id TEXT NOT NULL,
          to_state_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          payload_snapshot TEXT,
          created_at TEXT NOT NULL,
          triggered_by TEXT NOT NULL DEFAULT "user",
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE TABLE IF NOT EXISTS templates (
          id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          tags_json TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          clone_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS state_durations (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          state_id TEXT NOT NULL,
          entered_at TEXT NOT NULL,
          left_at TEXT,
          duration_ms INTEGER,
          FOREIGN KEY (instance_id) REFERENCES instances(id),
          FOREIGN KEY (machine_id) REFERENCES machines(id)
        );

        CREATE TABLE IF NOT EXISTS compliance_policies (
          id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          type TEXT NOT NULL,
          config_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY (machine_id) REFERENCES machines(id)
        );

        CREATE TABLE IF NOT EXISTS compliance_violations (
          id TEXT PRIMARY KEY,
          policy_id TEXT,
          machine_id TEXT NOT NULL,
          instance_id TEXT,
          event_name TEXT,
          from_state_id TEXT,
          to_state_id TEXT,
          reason TEXT NOT NULL,
          payload_snapshot TEXT,
          attempted_at TEXT NOT NULL,
          detected_during TEXT NOT NULL DEFAULT 'runtime',
          FOREIGN KEY (policy_id) REFERENCES compliance_policies(id),
          FOREIGN KEY (machine_id) REFERENCES machines(id),
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE INDEX IF NOT EXISTS idx_instances_machine ON instances(machine_id);
        CREATE INDEX IF NOT EXISTS idx_transitions_instance ON transitions(instance_id);
        CREATE INDEX IF NOT EXISTS idx_templates_machine ON templates(machine_id);
        CREATE INDEX IF NOT EXISTS idx_state_durations_machine ON state_durations(machine_id);
        CREATE INDEX IF NOT EXISTS idx_state_durations_instance ON state_durations(instance_id);
        CREATE INDEX IF NOT EXISTS idx_state_durations_entered ON state_durations(entered_at);
        CREATE INDEX IF NOT EXISTS idx_compliance_policies_machine ON compliance_policies(machine_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_violations_machine ON compliance_violations(machine_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_violations_instance ON compliance_violations(instance_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_violations_policy ON compliance_violations(policy_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_violations_attempted ON compliance_violations(attempted_at);

        CREATE TABLE IF NOT EXISTS instance_migrations (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          source_machine_id TEXT NOT NULL,
          target_machine_id TEXT NOT NULL,
          source_version INTEGER NOT NULL,
          target_version INTEGER NOT NULL,
          from_state_id TEXT NOT NULL,
          to_state_id TEXT,
          context_before TEXT NOT NULL,
          context_after TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          warnings TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          operator TEXT NOT NULL DEFAULT 'system',
          FOREIGN KEY (instance_id) REFERENCES instances(id),
          FOREIGN KEY (source_machine_id) REFERENCES machines(id),
          FOREIGN KEY (target_machine_id) REFERENCES machines(id)
        );

        CREATE INDEX IF NOT EXISTS idx_instance_migrations_instance ON instance_migrations(instance_id);
        CREATE INDEX IF NOT EXISTS idx_instance_migrations_source ON instance_migrations(source_machine_id);
        CREATE INDEX IF NOT EXISTS idx_instance_migrations_target ON instance_migrations(target_machine_id);
        CREATE INDEX IF NOT EXISTS idx_instance_migrations_created ON instance_migrations(created_at);

        CREATE TABLE IF NOT EXISTS simulations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_machine_id TEXT,
          source_instance_id TEXT,
          source_snapshot TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          is_archived INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS simulation_branches (
          id TEXT PRIMARY KEY,
          simulation_id TEXT NOT NULL,
          name TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          machine_snapshot TEXT NOT NULL,
          policies_snapshot TEXT,
          parent_branch_id TEXT,
          parent_step_id TEXT,
          current_state_id TEXT NOT NULL,
          context_data TEXT NOT NULL,
          entered_state_at TEXT,
          is_final INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (simulation_id) REFERENCES simulations(id)
        );

        CREATE TABLE IF NOT EXISTS simulation_steps (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL,
          step_index INTEGER NOT NULL,
          step_type TEXT NOT NULL,
          from_state_id TEXT,
          to_state_id TEXT,
          event_name TEXT,
          payload_snapshot TEXT,
          guard_result TEXT,
          compliance_result TEXT,
          timeout_info TEXT,
          context_before TEXT,
          context_after TEXT,
          duration_ms INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (branch_id) REFERENCES simulation_branches(id)
        );

        CREATE INDEX IF NOT EXISTS idx_simulations_source_machine ON simulations(source_machine_id);
        CREATE INDEX IF NOT EXISTS idx_simulations_source_instance ON simulations(source_instance_id);
        CREATE INDEX IF NOT EXISTS idx_simulations_created ON simulations(created_at);
        CREATE INDEX IF NOT EXISTS idx_simulation_branches_simulation ON simulation_branches(simulation_id);
        CREATE INDEX IF NOT EXISTS idx_simulation_branches_parent ON simulation_branches(parent_branch_id);
        CREATE INDEX IF NOT EXISTS idx_simulation_steps_branch ON simulation_steps(branch_id);
        CREATE INDEX IF NOT EXISTS idx_simulation_steps_branch_index ON simulation_steps(branch_id, step_index);
      `, async (err) => {
        if (err) return reject(err);
        try {
          await migrateDB();
          resolve();
        } catch (mErr) {
          reject(mErr);
        }
      });
    });
  });
}

module.exports = { db, run, get, all, initDB };
