const PDFDocument = require("pdfkit");
const { GoogleGenAI } = require("@google/genai");

const db = require("./db");

function getOptionalEnv(name) {
  return process.env[name] || null;
}

function markdownToPlainText(md) {
  if (!md) return "";
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "")) // keep code-ish blocks
    .replace(/[#>*_`]/g, "") // strip most markdown syntax
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pdfBase64FromText(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];

    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    doc.on("error", (e) => reject(e));

    doc.fontSize(12).text(text, {
      width: 515,
    });
    doc.end();
  });
}

async function generateReportTextWithGemini({ session, reps, formEvents, metricsSummary, issueCounts }) {
  const project = getOptionalEnv("GCP_PROJECT_ID");
  const model = getOptionalEnv("GEMINI_REPORT_MODEL") || "gemini-3.1-flash-lite-preview";
  if (!project) {
    return `Physio Report (MVP - Gemini not configured)\n\nSession: ${session.id}\nExercise: ${session.exercise_type}\n\nSummary\n- Average correctness: ${metricsSummary.avg_correctness ?? "n/a"}%\n- Total snapshots: ${metricsSummary.snapshots}\n\nTop issues\n${issueCounts
      .map((i) => `- ${i.issue_code}: ${i.occurrences}x (max severity ${i.max_severity})`)
      .join("\n")}\n\nSafety disclaimer\nThis report is for educational purposes only and is not medical advice. If you experience sharp pain, dizziness, numbness, or severe discomfort, stop and consult a clinician.`;
  }

  const location = getOptionalEnv("GCP_LOCATION") || "us-central1";
  const ai = new GoogleGenAI({ vertexai: true, project, location });

  const prompt = [
    "Create a professional, physiotherapy-style movement quality report for at-home rehabilitation.",
    "The report must be safe and must not claim to diagnose. Include risks and recommendations, and include a clear medical disclaimer.",
    "Write in clear, human language with headings.",
    "",
    "Return the report in Markdown.",
    "",
    "Session data (for your reference):",
    `- Session ID: ${session.id}`,
    `- Exercise: ${session.exercise_type}`,
    `- Goals/notes: ${session.goals_text || "(none)"}`,
    `- Safety enabled: ${session.safety_enabled ? "yes" : "no"}`,
    "",
    `Movement metrics summary: avg_correctness=${metricsSummary.avg_correctness ?? "n/a"}%, snapshots=${metricsSummary.snapshots}`,
    "",
    "Top issue counts (from coaching events):",
    ...issueCounts.map((i) => `- ${i.issue_code}: ${i.occurrences}x (max severity ${i.max_severity})`),
    "",
    `Rep events: ${reps.length ? "" : "(none)"}`,
    ...reps.slice(-20).map((r) => `- ${r.created_at}: rep_index=${r.rep_index}, phase=${r.rep_phase}, correctness=${r.correctness_score ?? "n/a"}`),
    "",
    `Form/coaching events: ${formEvents.length ? "" : "(none)"}`,
    ...formEvents.slice(-20).map((f) => `- ${f.created_at}: phase=${f.phase}, issue=${f.issue_code}, severity=${f.severity}, correctness=${f.correctness_score ?? "n/a"}`),
    "",
    "Report requirements:",
    "- Sections: Overview, Exercise Summary, Movement Quality Metrics, Key Issues & Likely Causes, Recommendations (cue-based), Safety & When to Seek Care, Next Steps.",
    "- In Key Issues, list up to 3 issues. For each: what it likely means, why it matters, and a cue to correct.",
    "- In Safety, explicitly advise stopping if pain/neurologic symptoms occur.",
  ].join("\n");

  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return res.response?.text || res.text || res?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
}

async function generateAndStoreReport({ sessionId }) {
  const session = db.getSession({ sessionId });
  if (!session) throw new Error("Session not found");

  const reps = db.listRepEvents({ sessionId });
  const formEvents = db.getFormEvents({ sessionId, limit: 200 });
  const metricsSummary = db.computeSessionMetricsSummary({ sessionId });
  const issueCounts = db.computeSessionIssueCounts({ sessionId });

  // Mark pending (best-effort).
  db.updateReport({ sessionId, status: "generating" });

  const reportText = await generateReportTextWithGemini({
    session,
    reps,
    formEvents,
    metricsSummary,
    issueCounts,
  });

  const safeText = markdownToPlainText(reportText);
  const reportPdfBase64 = await pdfBase64FromText(safeText);

  db.updateReport({
    sessionId,
    status: "completed",
    reportText,
    reportPdfBase64,
  });
}

async function generateClinicalReportTextWithGemini({ userId, startDate, endDate, aggregate }) {
  const project = getOptionalEnv("GCP_PROJECT_ID");
  const model = getOptionalEnv("GEMINI_REPORT_MODEL") || "gemini-3.1-flash-lite-preview";
  if (!project) {
    return `Clinical Report (MVP - Gemini not configured)\n\nUser: ${userId}\nDate range: ${startDate} to ${endDate}\n\nOverview\n- Sessions: ${aggregate.sessions_count}\n- Average correctness: ${aggregate.overall.avg_correctness ?? "n/a"}%\n- Total reps (estimated): ${aggregate.overall.total_reps}\n\nPer-exercise summary\n${aggregate.perExercise
      .map((e) => `- ${e.exercise_type}: sessions=${e.sessions}, avg_correctness=${e.avg_correctness ?? "n/a"}%`)
      .join("\n")}\n\nTop form issues\n${aggregate.topIssues
      .map((i) => `- ${i.issue_code}: ${i.occurrences}x (avg severity ${i.avg_severity?.toFixed?.(1) ?? i.avg_severity})`)
      .join("\n")}\n\nSafety disclaimer\nThis report is for educational purposes only and is not medical advice. If you experience sharp pain, dizziness, numbness, or severe discomfort, stop and consult a clinician.`;
  }

  const location = getOptionalEnv("GCP_LOCATION") || "us-central1";
  const ai = new GoogleGenAI({ vertexai: true, project, location });

  const prompt = [
    "Create a professional, physiotherapy-style clinical report for at-home rehabilitation progress over a date range.",
    "The report must be safe and must not claim to diagnose. Include risks and recommendations, and include a clear medical disclaimer.",
    "Write in clear, human language with headings. Return Markdown.",
    "",
    `Date range: ${startDate} to ${endDate}`,
    `Sessions in range: ${aggregate.sessions_count}`,
    `Overall avg correctness: ${aggregate.overall.avg_correctness ?? "n/a"}%`,
    `Total reps (estimated): ${aggregate.overall.total_reps}`,
    "",
    "Per-exercise summary:",
    ...aggregate.perExercise.map(
      (e) => `- ${e.exercise_type}: sessions=${e.sessions}, avg_correctness=${e.avg_correctness ?? "n/a"}%`
    ),
    "",
    "Top form issues:",
    ...aggregate.topIssues.map(
      (i) => `- ${i.issue_code}: ${i.occurrences}x (avg severity ${i.avg_severity?.toFixed?.(1) ?? i.avg_severity})`
    ),
    "",
    "Report requirements:",
    "- Sections: Overview, Adherence & Frequency, Movement Quality Metrics, Key Issues & Likely Causes, Recommendations (cue-based), Safety & When to Seek Care, Next Steps.",
    "- Include uncertainty and suggest clinician follow-up if red flags or persistent pain are present.",
  ].join("\n");

  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return res.response?.text || res.text || res?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
}

async function generateAndStoreClinicalReport({ reportId, userId, startDate, endDate }) {
  const aggregate = db.computeClinicalAggregate({ userId, startDate, endDate });
  db.updateClinicalReport({ reportId, status: "generating" });

  const reportText = await generateClinicalReportTextWithGemini({ userId, startDate, endDate, aggregate });
  const safeText = markdownToPlainText(reportText);
  const reportPdfBase64 = await pdfBase64FromText(safeText);

  db.updateClinicalReport({
    reportId,
    status: "completed",
    reportText,
    reportPdfBase64,
  });
}

module.exports = {
  generateAndStoreReport,
  generateAndStoreClinicalReport,
};

