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

        CREATE INDEX IF NOT EXISTS idx_instances_machine ON instances(machine_id);
        CREATE INDEX IF NOT EXISTS idx_transitions_instance ON transitions(instance_id);
        CREATE INDEX IF NOT EXISTS idx_templates_machine ON templates(machine_id);
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
