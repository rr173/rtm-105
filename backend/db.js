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

  const hasTagsTable = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='instance_tags'`);
  if (!hasTagsTable) {
    await run(`
      CREATE TABLE instance_tags (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES instances(id)
      )
    `);
    await run('CREATE INDEX idx_instance_tags_instance ON instance_tags(instance_id)');
    await run('CREATE INDEX idx_instance_tags_tag ON instance_tags(tag)');
    await run('CREATE UNIQUE INDEX idx_instance_tags_unique ON instance_tags(instance_id, tag)');
    console.log('Migrated: created instance_tags table');
  }

  const hasBatchOpsTable = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='batch_operations'`);
  if (!hasBatchOpsTable) {
    await run(`
      CREATE TABLE batch_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL,
        target_tags_json TEXT NOT NULL,
        event_name TEXT,
        event_payload TEXT,
        operator_id TEXT NOT NULL,
        operator_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running'
      )
    `);
    await run('CREATE INDEX idx_batch_operations_created ON batch_operations(created_at)');
    await run('CREATE INDEX idx_batch_operations_type ON batch_operations(operation_type)');
    console.log('Migrated: created batch_operations table');
  }

  const hasBatchResultsTable = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='batch_operation_results'`);
  if (!hasBatchResultsTable) {
    await run(`
      CREATE TABLE batch_operation_results (
        id TEXT PRIMARY KEY,
        batch_operation_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_message TEXT,
        executed_at TEXT NOT NULL,
        FOREIGN KEY (batch_operation_id) REFERENCES batch_operations(id),
        FOREIGN KEY (instance_id) REFERENCES instances(id)
      )
    `);
    await run('CREATE INDEX idx_batch_results_batch ON batch_operation_results(batch_operation_id)');
    await run('CREATE INDEX idx_batch_results_instance ON batch_operation_results(instance_id)');
    console.log('Migrated: created batch_operation_results table');
  }

  const hasCascadeDetail = await columnExists('transitions', 'cascade_detail');
  if (!hasCascadeDetail) {
    await run('ALTER TABLE transitions ADD COLUMN cascade_detail TEXT');
    console.log('Migrated: added transitions.cascade_detail');
  }

  const hasInstanceLinksTable = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='instance_links'`);
  if (!hasInstanceLinksTable) {
    await run(`
      CREATE TABLE instance_links (
        id TEXT PRIMARY KEY,
        source_instance_id TEXT NOT NULL,
        target_instance_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        trigger_rules_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_machine_id TEXT NOT NULL,
        target_machine_id TEXT NOT NULL,
        FOREIGN KEY (source_instance_id) REFERENCES instances(id),
        FOREIGN KEY (target_instance_id) REFERENCES instances(id)
      )
    `);
    await run('CREATE INDEX idx_instance_links_source ON instance_links(source_instance_id)');
    await run('CREATE INDEX idx_instance_links_target ON instance_links(target_instance_id)');
    await run('CREATE INDEX idx_instance_links_source_machine ON instance_links(source_machine_id)');
    await run('CREATE INDEX idx_instance_links_target_machine ON instance_links(target_machine_id)');
    await run('CREATE INDEX idx_instance_links_status ON instance_links(status)');
    console.log('Migrated: created instance_links table');
  } else {
    const oldUniqueIndex = await get(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_instance_links_unique'`
    );
    if (oldUniqueIndex) {
      await run('DROP INDEX idx_instance_links_unique');
      console.log('Migrated: dropped old unique index idx_instance_links_unique to allow multiple links per instance pair');
    }
  }

  const hasLinkSkipLogsTable = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='instance_link_skip_logs'`);
  if (!hasLinkSkipLogsTable) {
    await run(`
      CREATE TABLE instance_link_skip_logs (
        id TEXT PRIMARY KEY,
        link_id TEXT,
        source_instance_id TEXT NOT NULL,
        target_instance_id TEXT,
        source_event TEXT NOT NULL,
        target_event TEXT,
        source_state_id TEXT,
        reason TEXT NOT NULL,
        cascade_depth INTEGER,
        detail_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (link_id) REFERENCES instance_links(id)
      )
    `);
    await run('CREATE INDEX idx_link_skip_logs_link ON instance_link_skip_logs(link_id)');
    await run('CREATE INDEX idx_link_skip_logs_source ON instance_link_skip_logs(source_instance_id)');
    await run('CREATE INDEX idx_link_skip_logs_target ON instance_link_skip_logs(target_instance_id)');
    await run('CREATE INDEX idx_link_skip_logs_created ON instance_link_skip_logs(created_at)');
    await run('CREATE INDEX idx_link_skip_logs_reason ON instance_link_skip_logs(reason)');
    console.log('Migrated: created instance_link_skip_logs table');
  } else {
    const hasCascadeDepth = await columnExists('instance_link_skip_logs', 'cascade_depth');
    if (!hasCascadeDepth) {
      await run('ALTER TABLE instance_link_skip_logs ADD COLUMN cascade_depth INTEGER');
      console.log('Migrated: added instance_link_skip_logs.cascade_depth');
    }
    const hasDetailJson = await columnExists('instance_link_skip_logs', 'detail_json');
    if (!hasDetailJson) {
      await run('ALTER TABLE instance_link_skip_logs ADD COLUMN detail_json TEXT');
      console.log('Migrated: added instance_link_skip_logs.detail_json');
    }
    const hasReasonIdx = await get(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_link_skip_logs_reason'`
    );
    if (!hasReasonIdx) {
      await run('CREATE INDEX idx_link_skip_logs_reason ON instance_link_skip_logs(reason)');
      console.log('Migrated: added index idx_link_skip_logs_reason');
    }

    const skipLinkIdNotNull = await get(
      `SELECT name FROM pragma_table_info('instance_link_skip_logs') WHERE name='link_id' AND "notnull"=1`
    );
    if (skipLinkIdNotNull) {
      console.log('Migrate note: instance_link_skip_logs.link_id NOT NULL constraint preserved, will pass null-safe values');
    }
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
          cascade_detail TEXT,
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

        CREATE TABLE IF NOT EXISTS instance_tags (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_instance_tags_unique ON instance_tags(instance_id, tag);
        CREATE INDEX IF NOT EXISTS idx_instance_tags_instance ON instance_tags(instance_id);
        CREATE INDEX IF NOT EXISTS idx_instance_tags_tag ON instance_tags(tag);

        CREATE TABLE IF NOT EXISTS batch_operations (
          id TEXT PRIMARY KEY,
          operation_type TEXT NOT NULL,
          target_tags_json TEXT NOT NULL,
          event_name TEXT,
          event_payload TEXT,
          operator_id TEXT NOT NULL,
          operator_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          total_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running'
        );

        CREATE INDEX IF NOT EXISTS idx_batch_operations_created ON batch_operations(created_at);
        CREATE INDEX IF NOT EXISTS idx_batch_operations_type ON batch_operations(operation_type);

        CREATE TABLE IF NOT EXISTS batch_operation_results (
          id TEXT PRIMARY KEY,
          batch_operation_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          status TEXT NOT NULL,
          result_message TEXT,
          executed_at TEXT NOT NULL,
          FOREIGN KEY (batch_operation_id) REFERENCES batch_operations(id),
          FOREIGN KEY (instance_id) REFERENCES instances(id)
        );

        CREATE INDEX IF NOT EXISTS idx_batch_results_batch ON batch_operation_results(batch_operation_id);
        CREATE INDEX IF NOT EXISTS idx_batch_results_instance ON batch_operation_results(instance_id);

        CREATE TABLE IF NOT EXISTS decision_traces (
          id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          transition_id TEXT,
          event_name TEXT NOT NULL,
          from_state_id TEXT NOT NULL,
          target_state_id TEXT,
          decision_result TEXT NOT NULL,
          rejection_reason TEXT,
          decision_tree_json TEXT NOT NULL,
          total_duration_ms INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (instance_id) REFERENCES instances(id),
          FOREIGN KEY (machine_id) REFERENCES machines(id),
          FOREIGN KEY (transition_id) REFERENCES transitions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_decision_traces_instance ON decision_traces(instance_id);
        CREATE INDEX IF NOT EXISTS idx_decision_traces_machine ON decision_traces(machine_id);
        CREATE INDEX IF NOT EXISTS idx_decision_traces_created ON decision_traces(created_at);
        CREATE INDEX IF NOT EXISTS idx_decision_traces_result ON decision_traces(decision_result);

        CREATE TABLE IF NOT EXISTS instance_links (
          id TEXT PRIMARY KEY,
          source_instance_id TEXT NOT NULL,
          target_instance_id TEXT NOT NULL,
          link_type TEXT NOT NULL,
          trigger_rules_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          source_machine_id TEXT NOT NULL,
          target_machine_id TEXT NOT NULL,
          FOREIGN KEY (source_instance_id) REFERENCES instances(id),
          FOREIGN KEY (target_instance_id) REFERENCES instances(id)
        );

        CREATE INDEX IF NOT EXISTS idx_instance_links_source ON instance_links(source_instance_id);
        CREATE INDEX IF NOT EXISTS idx_instance_links_target ON instance_links(target_instance_id);
        CREATE INDEX IF NOT EXISTS idx_instance_links_source_machine ON instance_links(source_machine_id);
        CREATE INDEX IF NOT EXISTS idx_instance_links_target_machine ON instance_links(target_machine_id);
        CREATE INDEX IF NOT EXISTS idx_instance_links_status ON instance_links(status);

        CREATE TABLE IF NOT EXISTS instance_link_skip_logs (
          id TEXT PRIMARY KEY,
          link_id TEXT,
          source_instance_id TEXT NOT NULL,
          target_instance_id TEXT,
          source_event TEXT NOT NULL,
          target_event TEXT,
          source_state_id TEXT,
          reason TEXT NOT NULL,
          cascade_depth INTEGER,
          detail_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (link_id) REFERENCES instance_links(id)
        );

        CREATE INDEX IF NOT EXISTS idx_link_skip_logs_link ON instance_link_skip_logs(link_id);
        CREATE INDEX IF NOT EXISTS idx_link_skip_logs_source ON instance_link_skip_logs(source_instance_id);
        CREATE INDEX IF NOT EXISTS idx_link_skip_logs_target ON instance_link_skip_logs(target_instance_id);
        CREATE INDEX IF NOT EXISTS idx_link_skip_logs_created ON instance_link_skip_logs(created_at);
      `, (err) => {
        if (err) return reject(err);
        migrateDB().then(resolve).catch(reject);
      });
    });
  });
}

module.exports = { db, run, get, all, initDB };
