require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");

const { registerWs } = require("./wsServer");
const db = require("./db");
const { generateAndStoreReport, generateAndStoreClinicalReport } = require("./reportGenerator");
const { generateWorkoutPlanText } = require("./workoutPlanGenerator");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// Serve frontend
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/sessions", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  res.json({ sessions: db.listSessions({ userId, limit: 30 }) });
});

app.get("/api/frequency", (req, res) => {
  const userId = req.query.userId;
  const exerciseType = req.query.exerciseType;
  const days = req.query.days ? Number(req.query.days) : 30;
  if (!userId || !exerciseType) return res.status(400).json({ error: "Missing params" });
  res.json({ points: db.computeExerciseFrequency({ userId, exerciseType, days }) });
});

app.get("/api/metrics-summary", (req, res) => {
  const userId = req.query.userId;
  const exerciseType = req.query.exerciseType;
  const days = req.query.days ? Number(req.query.days) : 30;
  if (!userId || !exerciseType) return res.status(400).json({ error: "Missing params" });
  res.json({ summary: db.computeMetricsSummary({ userId, exerciseType, days }) });
});

app.get("/api/issue-stats", (req, res) => {
  const userId = req.query.userId;
  const exerciseType = req.query.exerciseType;
  const days = req.query.days ? Number(req.query.days) : 30;
  if (!userId || !exerciseType) return res.status(400).json({ error: "Missing params" });
  res.json({ issues: db.computeIssueStats({ userId, exerciseType, days }) });
});

app.get("/api/sessions/:sessionId/reps", (req, res) => {
  const { sessionId } = req.params;
  res.json({ repEvents: db.listRepEvents({ sessionId }) });
});

app.get("/api/sessions/:sessionId/form-events", (req, res) => {
  const { sessionId } = req.params;
  res.json({ formEvents: db.getFormEvents({ sessionId, limit: 100 }) });
});

app.get("/api/sessions/:sessionId/report", (req, res) => {
  const { sessionId } = req.params;
  const report = db.getReport({ sessionId });
  if (!report) return res.json({ status: "missing" });
  res.json({ report });
});

app.post("/api/sessions/:sessionId/report", (req, res) => {
  const { sessionId } = req.params;
  db.ensureReportRow({ sessionId });
  db.updateReport({ sessionId, status: "pending" });

  // Async background generation
  void generateAndStoreReport({ sessionId })
    .then(() => {})
    .catch((e) => {
      db.updateReport({
        sessionId,
        status: "failed",
        reportText: `Report generation failed: ${e?.message || String(e)}`,
      });
    });

  res.json({ status: "started" });
});

app.post("/api/workout-plans/generate", async (req, res) => {
  try {
    const { userId, goalsText, exerciseType } = req.body || {};
    if (!userId) return res.status(400).json({ error: "Missing userId" });
    if (!goalsText || !String(goalsText).trim()) return res.status(400).json({ error: "Missing goalsText" });

    const planText = await generateWorkoutPlanText({ goalsText: String(goalsText).trim(), exerciseType: exerciseType || "auto" });
    const id = db.createWorkoutPlan({ userId, goalsText: String(goalsText).trim(), exerciseType: exerciseType || null, planText });
    res.json({ id, plan_text: planText });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to generate workout plan" });
  }
});

// Clinical report (date range across sessions)
app.post("/api/reports/clinical", (req, res) => {
  const { userId, startDate, endDate } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  if (!startDate || !endDate) return res.status(400).json({ error: "Missing startDate/endDate" });

  const reportId = db.createClinicalReport({ userId, startDate, endDate });

  void generateAndStoreClinicalReport({ reportId, userId, startDate, endDate }).catch((e) => {
    db.updateClinicalReport({
      reportId,
      status: "failed",
      reportText: `Clinical report generation failed: ${e?.message || String(e)}`,
    });
  });

  res.json({ reportId });
});

app.get("/api/reports/clinical/:reportId", (req, res) => {
  const { reportId } = req.params;
  const report = db.getClinicalReport({ reportId });
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json({ report });
});

// Start server + WS
const server = http.createServer(app);
registerWs({ server, path: "/ws/coach" });

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${PORT}`);
});

