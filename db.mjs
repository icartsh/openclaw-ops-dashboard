import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function openDb(dbPath = process.env.DB_PATH || path.join(process.cwd(), "state", "ops.db")) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_metrics (
      ts_ms INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      sessions_active INTEGER NOT NULL,
      tokens_24h_total INTEGER NOT NULL,
      cron_jobs INTEGER NOT NULL,
      cron_errors INTEGER NOT NULL,
      PRIMARY KEY (ts_ms, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_metrics_ts ON agent_metrics (ts_ms);
    CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_ts ON agent_metrics (agent_id, ts_ms);

    CREATE TABLE IF NOT EXISTS p0_events (
      ts_ms INTEGER NOT NULL,
      event_key TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT,
      title TEXT,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_p0_events_ts ON p0_events (ts_ms);

    CREATE TABLE IF NOT EXISTS cron_job_metrics (
      ts_ms INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      agent_id TEXT,
      enabled INTEGER NOT NULL,
      schedule_kind TEXT,
      schedule_expr TEXT,
      last_status TEXT,
      last_run_status TEXT,
      consecutive_errors INTEGER,
      last_error TEXT,
      next_run_at_ms INTEGER,
      last_run_at_ms INTEGER,
      PRIMARY KEY (ts_ms, job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cron_job_metrics_ts ON cron_job_metrics (ts_ms);
    CREATE INDEX IF NOT EXISTS idx_cron_job_metrics_job_ts ON cron_job_metrics (job_id, ts_ms);
  `);
}

export function insertAgentMetrics(db, { tsMs, agentId, sessionsActive, tokens24hTotal, cronJobs, cronErrors }) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agent_metrics
      (ts_ms, agent_id, sessions_active, tokens_24h_total, cron_jobs, cron_errors)
    VALUES
      (@tsMs, @agentId, @sessionsActive, @tokens24hTotal, @cronJobs, @cronErrors)
  `);
  stmt.run({ tsMs, agentId, sessionsActive, tokens24hTotal, cronJobs, cronErrors });
}

export function insertP0Event(db, { tsMs, key, kind, agentId = null, title = null, message }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO p0_events
      (ts_ms, event_key, kind, agent_id, title, message)
    VALUES
      (@tsMs, @key, @kind, @agentId, @title, @message)
  `);
  stmt.run({ tsMs, key, kind, agentId, title, message });
}

export function queryAgentMetrics(db, { days = 7 } = {}) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`
    SELECT ts_ms, agent_id, sessions_active, tokens_24h_total, cron_jobs, cron_errors
    FROM agent_metrics
    WHERE ts_ms >= @sinceMs
    ORDER BY ts_ms ASC
  `);
  return stmt.all({ sinceMs });
}

export function insertCronJobMetric(db, row) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cron_job_metrics
      (ts_ms, job_id, agent_id, enabled, schedule_kind, schedule_expr, last_status, last_run_status, consecutive_errors, last_error, next_run_at_ms, last_run_at_ms)
    VALUES
      (@tsMs, @jobId, @agentId, @enabled, @scheduleKind, @scheduleExpr, @lastStatus, @lastRunStatus, @consecutiveErrors, @lastError, @nextRunAtMs, @lastRunAtMs)
  `);
  stmt.run(row);
}

export function queryCronJobMetrics(db, { days = 7 } = {}) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`
    SELECT ts_ms, job_id, agent_id, enabled, schedule_kind, schedule_expr,
           last_status, last_run_status, consecutive_errors, last_error,
           next_run_at_ms, last_run_at_ms
    FROM cron_job_metrics
    WHERE ts_ms >= @sinceMs
    ORDER BY ts_ms ASC
  `);
  return stmt.all({ sinceMs });
}

export function queryP0Events(db, { days = 7 } = {}) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`
    SELECT ts_ms, event_key, kind, agent_id, title, message
    FROM p0_events
    WHERE ts_ms >= @sinceMs
    ORDER BY ts_ms DESC
  `);
  return stmt.all({ sinceMs });
}
