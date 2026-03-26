const { GoogleGenAI } = require("@google/genai");

function getOptionalEnv(name) {
  return process.env[name] || null;
}

function fallbackWorkoutPlan({ goalsText, exerciseType }) {
  const ex = exerciseType && exerciseType !== "auto" ? exerciseType : "your selected exercise";
  return [
    "At-home Workout Plan (MVP - Gemini not configured)",
    "",
    "Warm-up (5-8 minutes)",
    "- Gentle mobility + breathing. No pain, only mild stretch.",
    "",
    "Main exercise (based on your goals)",
    `- ${ex}: 2-3 sets of 8-12 reps, controlled tempo (2 seconds down / 2 seconds up), rest 60-90 seconds.`,
    "",
    "Progression (when it feels easy)",
    "- Add 1-2 reps per set, or increase time under tension slightly.",
    "",
    "Safety notes",
    "- Stop immediately if you feel sharp pain, dizziness, numbness, or severe discomfort.",
    "- If your PT gave contraindications, follow those over this plan.",
    "",
    `Goals noted: ${goalsText}`,
  ].join("\n");
}

async function generateWorkoutPlanText({ goalsText, exerciseType }) {
  const project = getOptionalEnv("GCP_PROJECT_ID");
  const location = getOptionalEnv("GCP_LOCATION") || "us-central1";
  const model = getOptionalEnv("GEMINI_REPORT_MODEL") || "gemini-3.1-flash-lite-preview";
  if (!project) {
    return fallbackWorkoutPlan({ goalsText, exerciseType });
  }

  const ai = new GoogleGenAI({ vertexai: true, project, location });

  const prompt = [
    "You are a physiotherapy assistant creating a safe at-home rehab workout plan.",
    "Create a structured workout plan that helps improve movement quality/posture. Bridge between at-home exercise and clinical physiotherapy.",
    "Safety is critical: do not diagnose, include risks and when to stop, and add a recommendation to consult a clinician if red-flag symptoms occur.",
    "Return Markdown with headings: Warm-up, Main block, Cooldown, Progression, Safety & when to seek care.",
    "",
    `User goals: ${goalsText}`,
    `Exercise focus (if provided): ${exerciseType || "auto"}`,
    "",
    "Use clear sets/reps, suggested tempo, rest times, and cue-based instructions.",
  ].join("\n");

  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return res.response?.text || res.text || "";
}

module.exports = {
  generateWorkoutPlanText,
};

