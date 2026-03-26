const { createGeminiCoachSession } = require("./geminiLive");
const db = require("./db");

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function registerWs({ server, path = "/ws/coach" }) {
  const { WebSocketServer } = require("ws");

  const wss = new WebSocketServer({ server, path });

  const COACH_EVENTS_PER_MINUTE = Number(process.env.COACH_EVENTS_PER_MINUTE || 6);

  wss.on("connection", (ws) => {
    const state = {
      sessionId: null,
      userId: null,
      exerciseType: null,
      safetyEnabled: true,
      gemini: null,
      closed: false,
      coachEventTimestamps: [],
    };

    ws.on("message", async (raw) => {
      if (state.closed) return;
      const msg = safeJsonParse(raw.toString("utf8"));
      if (!msg || !msg.type) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
        return;
      }

      try {
        if (msg.type === "start_session") {
          const { userId, exerciseType, goalsText, safetyEnabled } = msg;
          state.sessionId = db.createSession({
            userId,
            exerciseType,
            goalsText,
            safetyEnabled: safetyEnabled !== false,
          });
          state.userId = userId;
          state.exerciseType = exerciseType;
          state.safetyEnabled = safetyEnabled !== false;

          state.gemini = await createGeminiCoachSession();

          ws.send(JSON.stringify({ type: "ack", sessionId: state.sessionId }));
          // eslint-disable-next-line no-console
          console.log(`[ws][start] session=${state.sessionId} user=${userId} exercise=${exerciseType} safety=${state.safetyEnabled}`);
          return;
        }

        if (msg.type === "metrics_snapshot") {
          if (!state.sessionId) return;
          const { correctnessScore, metrics } = msg;
          db.logMetricsSnapshot({ sessionId: state.sessionId, correctnessScore, metrics });
          return;
        }

        if (msg.type === "rep_event") {
          if (!state.sessionId) return;
          const { repPhase, repIndex, correctnessScore, metrics } = msg;
          db.logRepEvent({ sessionId: state.sessionId, repPhase, repIndex, correctnessScore, metrics });
          return;
        }

        if (msg.type === "coach_event") {
          if (!state.sessionId || !state.gemini) return;
          const { phase, issues, frameBase64, metrics } = msg;

          // Cost control: rate limit coach calls.
          const now = Date.now();
          state.coachEventTimestamps = state.coachEventTimestamps.filter((t) => now - t < 60_000);
          if (state.coachEventTimestamps.length >= COACH_EVENTS_PER_MINUTE) {
            ws.send(
              JSON.stringify({
                type: "coach_feedback",
                phase,
                coach_text: "Coach is temporarily rate-limited to control analysis cost. Keep moving and try again.",
                issues,
              })
            );
            return;
          }
          state.coachEventTimestamps.push(now);

          // Gemini placeholder: in gemini-live-integration this will call the real Live API.
          const result = await state.gemini.coachOnce({
            exerciseType: state.exerciseType,
            phase,
            frameBase64,
            metrics,
            issues,
          });

          const formEvent = db.logFormEvent({
            sessionId: state.sessionId,
            phase,
            issueCode: issues?.[0]?.code || "unknown",
            severity: issues?.[0]?.severity ?? 2,
            correctnessScore: msg.correctnessScore ?? null,
            metrics,
            coachText: result.coach_text,
          });

          // eslint-disable-next-line no-console
          console.log(`[ws][coach] session=${state.sessionId} phase=${phase} issues=${issues?.length || 0}`);

          ws.send(
            JSON.stringify({
              type: "coach_feedback",
              phase,
              coach_text: result.coach_text,
              issues,
            })
          );
          return;
        }

        if (msg.type === "end_session") {
          if (!state.sessionId) return;
          db.endSession({ sessionId: state.sessionId });
          await state.gemini?.close();
          ws.send(JSON.stringify({ type: "session_ended", sessionId: state.sessionId }));
          // eslint-disable-next-line no-console
          console.log(`[ws][end] session=${state.sessionId}`);
          state.closed = true;
          ws.close();
          return;
        }

        ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: e?.message || "Server error" }));
      }
    });

    ws.on("close", () => {
      state.closed = true;
    });
  });

  return wss;
}

module.exports = { registerWs };

