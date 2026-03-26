const path = require("path");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

const DATA_DIR = process.env.SQLITE_DATA_DIR
  ? path.resolve(process.env.SQLITE_DATA_DIR)
  : path.join(__dirname, "data");
const DB_PATH = process.env.SQLITE_DB_PATH ? path.resolve(process.env.SQLITE_DB_PATH) : path.join(DATA_DIR, "app.db");

function ensureDb() {
  const fs = require("fs");
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exercise_type TEXT NOT NULL,
      goals_text TEXT,
      safety_enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS rep_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rep_phase TEXT NOT NULL,
      rep_index INTEGER NOT NULL,
      correctness_score REAL,
      metrics_json TEXT
    );

    CREATE TABLE IF NOT EXISTS form_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      phase TEXT NOT NULL,
      issue_code TEXT NOT NULL,
      severity INTEGER NOT NULL,
      correctness_score REAL,
      metrics_json TEXT,
      coach_text TEXT
    );

    CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      correctness_score REAL NOT NULL,
      metrics_json TEXT
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      report_text TEXT,
      report_pdf_base64 TEXT
    );

    CREATE TABLE IF NOT EXISTS workout_plans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      exercise_type TEXT,
      goals_text TEXT NOT NULL,
      plan_text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clinical_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      report_text TEXT,
      report_pdf_base64 TEXT
    );
  `);

  return db;
}

const db = ensureDb();

function nowIso() {
  return new Date().toISOString();
}

function ensureUser(userId) {
  const stmt = db.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)");
  stmt.run(userId, nowIso());
}

function createSession({ userId, exerciseType, goalsText, safetyEnabled = true }) {
  ensureUser(userId);
  const sessionId = randomUUID();
  db.prepare(
    `
    INSERT INTO sessions (id, user_id, started_at, exercise_type, goals_text, safety_enabled, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(sessionId, userId, nowIso(), exerciseType, goalsText ?? null, safetyEnabled ? 1 : 0, "active");
  return sessionId;
}

function endSession({ sessionId }) {
  db.prepare("UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?").run(nowIso(), "ended", sessionId);
}

function logMetricsSnapshot({ sessionId, correctnessScore, metrics }) {
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO metrics_snapshots (id, session_id, created_at, correctness_score, metrics_json)
    VALUES (?, ?, ?, ?, ?)
  `
  ).run(id, sessionId, nowIso(), correctnessScore, JSON.stringify(metrics ?? {}));
}

function logRepEvent({ sessionId, repPhase, repIndex, correctnessScore, metrics }) {
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO rep_events (id, session_id, created_at, rep_phase, rep_index, correctness_score, metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(id, sessionId, nowIso(), repPhase, repIndex, correctnessScore ?? null, JSON.stringify(metrics ?? {}));
}

function logFormEvent({ sessionId, phase, issueCode, severity, correctnessScore, metrics, coachText }) {
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO form_events (id, session_id, created_at, phase, issue_code, severity, correctness_score, metrics_json, coach_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    sessionId,
    nowIso(),
    phase,
    issueCode,
    severity,
    correctnessScore ?? null,
    JSON.stringify(metrics ?? {}),
    coachText ?? null
  );
}

function updateFormEventCoachText({ formEventId, coachText }) {
  db.prepare("UPDATE form_events SET coach_text = ? WHERE id = ?").run(coachText, formEventId);
}

function listSessions({ userId, limit = 20 }) {
  const rows = db
    .prepare(
      `
      SELECT s.id, s.started_at, s.ended_at, s.exercise_type, s.status,
             (SELECT AVG(m.correctness_score) FROM metrics_snapshots m WHERE m.session_id = s.id) AS avg_correctness
             ,(SELECT COUNT(*) FROM rep_events r WHERE r.session_id = s.id) AS total_rep_events
             ,(SELECT COUNT(DISTINCT r.rep_index) FROM rep_events r WHERE r.session_id = s.id) AS total_reps
             ,CASE
                WHEN s.ended_at IS NULL THEN NULL
                ELSE (strftime('%s', s.ended_at) - strftime('%s', s.started_at))
              END AS duration_seconds
      FROM sessions s
      WHERE s.user_id = ?
      ORDER BY s.started_at DESC
      LIMIT ?
    `
    )
    .all(userId, limit);
  return rows.map((r) => ({
    ...r,
    avg_correctness: r.avg_correctness == null ? null : Number(r.avg_correctness),
    duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
    total_rep_events: Number(r.total_rep_events),
    total_reps: Number(r.total_reps),
  }));
}

function computeExerciseFrequency({ userId, exerciseType, days = 30 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `
      SELECT substr(s.started_at, 1, 10) AS day, COUNT(*) AS sessions
      FROM sessions s
      WHERE s.user_id = ? AND s.exercise_type = ? AND s.started_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `
    )
    .all(userId, exerciseType, since);

  return rows.map((r) => ({ day: r.day, sessions: r.sessions }));
}

function computeMetricsSummary({ userId, exerciseType, days = 30 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const row = db
    .prepare(
      `
      SELECT
        AVG(m.correctness_score) AS avg_correctness,
        COUNT(*) AS snapshots
      FROM sessions s
      JOIN metrics_snapshots m ON m.session_id = s.id
      WHERE s.user_id = ? AND s.exercise_type = ? AND s.started_at >= ?
    `
    )
    .get(userId, exerciseType, since);
  return {
    avg_correctness: row.avg_correctness == null ? null : Number(row.avg_correctness),
    snapshots: row.snapshots,
  };
}

function computeSessionMetricsSummary({ sessionId }) {
  const row = db
    .prepare(
      `
      SELECT AVG(m.correctness_score) AS avg_correctness, COUNT(*) AS snapshots
      FROM metrics_snapshots m
      WHERE m.session_id = ?
    `
    )
    .get(sessionId);

  return {
    avg_correctness: row.avg_correctness == null ? null : Number(row.avg_correctness),
    snapshots: row.snapshots,
  };
}

function computeSessionIssueCounts({ sessionId, limit = 12 }) {
  const rows = db
    .prepare(
      `
      SELECT
        issue_code,
        COUNT(*) AS occurrences,
        MAX(severity) AS max_severity
      FROM form_events
      WHERE session_id = ?
      GROUP BY issue_code
      ORDER BY occurrences DESC
      LIMIT ?
    `
    )
    .all(sessionId, limit);

  return rows.map((r) => ({
    issue_code: r.issue_code,
    occurrences: Number(r.occurrences),
    max_severity: Number(r.max_severity),
  }));
}

function computeIssueStats({ userId, exerciseType, days = 30, limit = 8 }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `
      SELECT
        fe.issue_code,
        COUNT(*) AS occurrences,
        AVG(fe.severity) AS avg_severity
      FROM form_events fe
      JOIN sessions s ON s.id = fe.session_id
      WHERE s.user_id = ? AND s.exercise_type = ? AND s.started_at >= ?
      GROUP BY fe.issue_code
      ORDER BY occurrences DESC
      LIMIT ?
    `
    )
    .all(userId, exerciseType, since, limit);

  return rows.map((r) => ({
    issue_code: r.issue_code,
    occurrences: Number(r.occurrences),
    avg_severity: r.avg_severity == null ? null : Number(r.avg_severity),
  }));
}

function getSession({ sessionId }) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
}

function getFormEvents({ sessionId, limit = 50 }) {
  return db
    .prepare(
      `
      SELECT * FROM form_events
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(sessionId, limit);
}

function ensureReportRow({ sessionId }) {
  const id = randomUUID();
  db.prepare(
    `
    INSERT OR IGNORE INTO reports (id, session_id, created_at, status)
    VALUES (?, ?, ?, 'pending')
  `
  ).run(id, sessionId, nowIso());
}

function updateReport({ sessionId, status, reportText, reportPdfBase64 }) {
  db.prepare(
    `
    UPDATE reports
    SET status = ?,
        report_text = ?,
        report_pdf_base64 = ?
    WHERE session_id = ?
  `
  ).run(status, reportText ?? null, reportPdfBase64 ?? null, sessionId);
}

function getReport({ sessionId }) {
  return db.prepare("SELECT * FROM reports WHERE session_id = ?").get(sessionId);
}

function listRepEvents({ sessionId }) {
  return db.prepare("SELECT * FROM rep_events WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
}

function createWorkoutPlan({ userId, goalsText, exerciseType, planText }) {
  ensureUser(userId);
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO workout_plans (id, user_id, created_at, exercise_type, goals_text, plan_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(id, userId, nowIso(), exerciseType ?? null, goalsText, planText);
  return id;
}

function listWorkoutPlans({ userId, limit = 10 }) {
  return db
    .prepare(
      `
      SELECT * FROM workout_plans
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(userId, limit);
}

function createClinicalReport({ userId, startDate, endDate }) {
  ensureUser(userId);
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO clinical_reports (id, user_id, start_date, end_date, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(id, userId, startDate, endDate, nowIso(), "pending");
  return id;
}

function updateClinicalReport({ reportId, status, reportText, reportPdfBase64 }) {
  db.prepare(
    `
    UPDATE clinical_reports
    SET status = ?,
        report_text = ?,
        report_pdf_base64 = ?
    WHERE id = ?
  `
  ).run(status, reportText ?? null, reportPdfBase64 ?? null, reportId);
}

function getClinicalReport({ reportId }) {
  return db.prepare("SELECT * FROM clinical_reports WHERE id = ?").get(reportId);
}

function listSessionsInDateRange({ userId, startDate, endDate }) {
  // Treat startDate/endDate as YYYY-MM-DD; compare against started_at ISO prefix.
  // Inclusive range.
  return db
    .prepare(
      `
      SELECT * FROM sessions
      WHERE user_id = ?
        AND substr(started_at, 1, 10) >= ?
        AND substr(started_at, 1, 10) <= ?
        AND status = 'ended'
      ORDER BY started_at ASC
    `
    )
    .all(userId, startDate, endDate);
}

function computeClinicalAggregate({ userId, startDate, endDate }) {
  const sessions = listSessionsInDateRange({ userId, startDate, endDate });
  const sessionIds = sessions.map((s) => s.id);

  const perExercise = db
    .prepare(
      `
      SELECT
        s.exercise_type AS exercise_type,
        COUNT(*) AS sessions,
        AVG(ms.correctness_score) AS avg_correctness
      FROM sessions s
      LEFT JOIN metrics_snapshots ms ON ms.session_id = s.id
      WHERE s.user_id = ?
        AND substr(s.started_at, 1, 10) >= ?
        AND substr(s.started_at, 1, 10) <= ?
        AND s.status = 'ended'
      GROUP BY s.exercise_type
      ORDER BY sessions DESC
    `
    )
    .all(userId, startDate, endDate)
    .map((r) => ({
      exercise_type: r.exercise_type,
      sessions: Number(r.sessions),
      avg_correctness: r.avg_correctness == null ? null : Number(r.avg_correctness),
    }));

  const overall = db
    .prepare(
      `
      SELECT
        AVG(ms.correctness_score) AS avg_correctness,
        COUNT(ms.id) AS snapshots
      FROM sessions s
      LEFT JOIN metrics_snapshots ms ON ms.session_id = s.id
      WHERE s.user_id = ?
        AND substr(s.started_at, 1, 10) >= ?
        AND substr(s.started_at, 1, 10) <= ?
        AND s.status = 'ended'
    `
    )
    .get(userId, startDate, endDate);

  const topIssues = db
    .prepare(
      `
      SELECT
        fe.issue_code,
        COUNT(*) AS occurrences,
        AVG(fe.severity) AS avg_severity
      FROM form_events fe
      JOIN sessions s ON s.id = fe.session_id
      WHERE s.user_id = ?
        AND substr(s.started_at, 1, 10) >= ?
        AND substr(s.started_at, 1, 10) <= ?
        AND s.status = 'ended'
      GROUP BY fe.issue_code
      ORDER BY occurrences DESC
      LIMIT 8
    `
    )
    .all(userId, startDate, endDate)
    .map((r) => ({
      issue_code: r.issue_code,
      occurrences: Number(r.occurrences),
      avg_severity: r.avg_severity == null ? null : Number(r.avg_severity),
    }));

  const totalRepsRow = db
    .prepare(
      `
      SELECT COUNT(DISTINCT re.session_id || ':' || re.rep_index) AS total_reps
      FROM rep_events re
      JOIN sessions s ON s.id = re.session_id
      WHERE s.user_id = ?
        AND substr(s.started_at, 1, 10) >= ?
        AND substr(s.started_at, 1, 10) <= ?
        AND s.status = 'ended'
    `
    )
    .get(userId, startDate, endDate);

  return {
    startDate,
    endDate,
    sessions_count: sessions.length,
    session_ids: sessionIds,
    overall: {
      avg_correctness: overall.avg_correctness == null ? null : Number(overall.avg_correctness),
      snapshots: Number(overall.snapshots),
      total_reps: Number(totalRepsRow?.total_reps || 0),
    },
    perExercise,
    topIssues,
  };
}

module.exports = {
  createSession,
  endSession,
  logMetricsSnapshot,
  logRepEvent,
  logFormEvent,
  listSessions,
  computeExerciseFrequency,
  computeMetricsSummary,
  computeSessionMetricsSummary,
  computeSessionIssueCounts,
  computeIssueStats,
  getSession,
  getFormEvents,
  ensureReportRow,
  updateReport,
  getReport,
  listRepEvents,
  createWorkoutPlan,
  listWorkoutPlans,
  createClinicalReport,
  updateClinicalReport,
  getClinicalReport,
  listSessionsInDateRange,
  computeClinicalAggregate,
};

