const { GoogleGenAI, Modality, MediaResolution } = require("@google/genai");

function getOptionalEnv(name) {
  return process.env[name] || null;
}

function fallbackCoachText({ issues }) {
  const issueLine =
    issues && issues.length > 0 ? `I noticed ${issues.map((i) => i.description).join(", ")}.` : "Your movement looks on track right now.";
  const recs = issues
    ?.slice(0, 2)
    .map((i) => i.recommendation)
    .filter(Boolean)
    .join(" ");
  return recs ? `${issueLine} Focus on: ${recs}` : issueLine;
}

function buildSystemInstructions() {
  // Note: the Live API in Gemini's "native audio" family may only support audio output;
  // we request audio transcription so we can show text feedback to the user.
  return [
    "You are PostureCoach: a physiotherapy-style coach for at-home rehabilitation exercises.",
    "Your job is to interpret the user's movement quality from the provided video frame(s) and give short, actionable corrections.",
    "You must be safe: never claim to diagnose. If something seems unsafe or the user might be injured, say to stop and consult a clinician.",
    "Output should be spoken feedback (then transcribed). Keep it concise: 1-3 short paragraphs max.",
    "Include:",
    "- What the user is doing (phase) in plain language",
    "- One likely form issue (if any)",
    "- One or two corrective cues they can try immediately",
    "- A brief risk note: when to stop and seek care",
    "If confidence is low, recommend repeating more slowly and improving visibility (lighting/camera angle), and avoid strong claims.",
  ].join("\n");
}

async function createGeminiCoachSession() {
  const project = getOptionalEnv("GCP_PROJECT_ID");
  if (!project) {
    // No credentials configured: keep the MVP usable locally.
    return {
      async coachOnce({ issues }) {
        return { coach_text: fallbackCoachText({ issues }) };
      },
      async close() {},
    };
  }

  const location = getOptionalEnv("GCP_LOCATION") || "us-central1";
  const model = getOptionalEnv("GEMINI_LIVE_MODEL") || "gemini-live-2.5-flash-native-audio";

  const ai = new GoogleGenAI({ vertexai: true, project, location });

  const config = {
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {},
    mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
    realtimeInputConfig: {
      // We manually mark activity boundaries so the model doesn't try to generate continuously.
      automaticActivityDetection: { disabled: true },
    },
  };

  const responseQueue = [];
  let closed = false;

  let session;
  try {
    session = await ai.live.connect({
      model,
      config: { ...config },
      callbacks: {
        onopen: () => {},
        onmessage: (message) => {
          responseQueue.push(message);
        },
        onerror: () => {},
        onclose: () => {
          closed = true;
        },
      },
    });
  } catch (e) {
    // Fall back if Gemini Live can't be reached/authorized.
    return {
      async coachOnce({ issues }) {
        return { coach_text: fallbackCoachText({ issues }) };
      },
      async close() {},
    };
  }

  // Send system instructions as part of setup by immediately sending client content.
  // (The SDK abstracts setup; we will provide system instructions through the first client message.)
  // If the SDK supports systemInstruction in setup, we'd use it; this works reliably.
  await session.sendClientContent({
    turns: `${buildSystemInstructions()}\n\nSession started. Waiting for coaching frames.`,
  });

  async function waitForTurnComplete({ timeoutMs = 15000 } = {}) {
    const start = Date.now();
    const collected = [];

    const waitMessage = async () => {
      while (true) {
        if (closed) return null;
        if (responseQueue.length > 0) return responseQueue.shift();
        if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for Gemini response");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    while (true) {
      const msg = await waitMessage();
      if (!msg) break;
      collected.push(msg);
      const turnComplete = msg?.serverContent?.turnComplete;
      const interrupted = msg?.serverContent?.interrupted;
      if (interrupted || turnComplete) break;
    }
    return collected;
  }

  function extractTextFromTurnMessages(turnMessages) {
    const parts = [];
    for (const msg of turnMessages) {
      const t =
        msg?.serverContent?.outputTranscription?.text ||
        msg?.serverContent?.inputTranscription?.text ||
        msg?.text ||
        msg?.serverContent?.modelTurn?.parts?.find((p) => p.text)?.text;
      if (t) parts.push(String(t));
    }
    // Keep it clean: Gemini transcription can include multiple fragments.
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  async function coachOnce({ exerciseType, phase, frameBase64, metrics, issues }) {
    if (closed) throw new Error("Gemini Live session closed");

    // Compose a short coaching prompt using our structured metrics.
    const metricsLine = metrics
      ? [
          metrics.kneeAngleAvg != null ? `kneeAngleAvg=${metrics.kneeAngleAvg.toFixed?.(1) ?? metrics.kneeAngleAvg}` : null,
          metrics.elbowAngleAvg != null ? `elbowAngleAvg=${metrics.elbowAngleAvg.toFixed?.(1) ?? metrics.elbowAngleAvg}` : null,
          metrics.torsoAngle != null ? `torsoAngleFromVertical=${metrics.torsoAngle.toFixed?.(1) ?? metrics.torsoAngle}` : null,
          metrics.hipsSagRatio != null ? `hipsSagRatio=${metrics.hipsSagRatio.toFixed?.(3) ?? metrics.hipsSagRatio}` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : "";

    const issuesLine = issues && issues.length > 0 ? issues.map((i) => `${i.code} (severity ${i.severity})`).join(", ") : "none detected";

    const prompt = [
      `Coaching request: exercise=${exerciseType}, phase=${phase}.`,
      metricsLine ? `Local metrics: ${metricsLine}.` : "",
      `Local issue signals: ${issuesLine}.`,
      "Give the user human-like, interpretable feedback and 1-2 immediate corrective cues.",
    ]
      .filter(Boolean)
      .join("\n");

    // Activity boundary + single video frame.
    await session.sendRealtimeInput({ activityStart: {} });
    await session.sendRealtimeInput({
      video: {
        data: frameBase64,
        mimeType: "image/jpeg",
      },
    });
    await session.sendRealtimeInput({ activityEnd: {} });

    // Add a text request to ensure the model speaks for this frame.
    await session.sendClientContent({
      turns: prompt,
      turnComplete: true,
    });

    const turnMessages = await waitForTurnComplete();
    return {
      coach_text: extractTextFromTurnMessages(turnMessages) || "I couldn't generate feedback for that moment. Please try again slowly.",
    };
  }

  // Make coachOnce sequential by serializing calls at the session level.
  let chain = Promise.resolve();
  async function coachOnceSerialized(payload) {
    chain = chain.then(() => coachOnce(payload));
    return chain;
  }

  return {
    coachOnce: coachOnceSerialized,
    async close() {
      try {
        await session.close();
      } catch {}
    },
  };
}

module.exports = {
  createGeminiCoachSession,
};

