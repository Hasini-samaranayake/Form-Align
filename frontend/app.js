const $ = (id) => document.getElementById(id);

function getOrCreateUserId() {
  const key = "pc_user_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `user_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function nowMs() {
  return Date.now();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleAt(a, b, c) {
  // Angle ABC in degrees.
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;

  const dot = abx * cbx + aby * cby;
  const magAB = Math.hypot(abx, aby);
  const magCB = Math.hypot(cbx, cby);
  if (magAB < 1e-6 || magCB < 1e-6) return null;
  const cos = clamp(dot / (magAB * magCB), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

function torsoAngleFromVertical(hipMid, shoulderMid) {
  // Vector torso points from hip to shoulder.
  const vx = shoulderMid.x - hipMid.x;
  const vy = shoulderMid.y - hipMid.y;
  const mag = Math.hypot(vx, vy);
  if (mag < 1e-6) return null;

  // Vertical "up" vector is (0, -1).
  const dot = vx * 0 + vy * -1;
  const cos = clamp(dot / mag, -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

function pointToLineDistanceNormalized(p, a, b) {
  // Perpendicular distance from point p to line through a-b, normalized by segment length.
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const magAB = Math.hypot(abx, aby);
  if (magAB < 1e-6) return null;

  // area of parallelogram / base length
  const area2 = Math.abs(abx * apy - aby * apx);
  const distPx = area2 / magAB;
  return distPx / magAB;
}

function getKeypoint(pose, name) {
  return pose.keypoints.find((k) => k.name === name) || null;
}

function keypointToPt(kp) {
  return { x: kp.x, y: kp.y, score: kp.score };
}

function computePoseMetricsFromKeypoints(pose, exerciseType) {
  // pose.keypoints are normalized coords. We'll use 2D angles.
  const kp = (name) => getKeypoint(pose, name);

  const leftHip = kp("left_hip");
  const rightHip = kp("right_hip");
  const leftKnee = kp("left_knee");
  const rightKnee = kp("right_knee");
  const leftAnkle = kp("left_ankle");
  const rightAnkle = kp("right_ankle");
  const leftShoulder = kp("left_shoulder");
  const rightShoulder = kp("right_shoulder");
  const leftElbow = kp("left_elbow");
  const rightElbow = kp("right_elbow");
  const leftWrist = kp("left_wrist");
  const rightWrist = kp("right_wrist");

  const required = [
    leftHip,
    rightHip,
    leftKnee,
    rightKnee,
    leftAnkle,
    rightAnkle,
    leftShoulder,
    rightShoulder,
    leftElbow,
    rightElbow,
    leftWrist,
    rightWrist,
  ];
  if (required.some((k) => !k || k.score < 0.35)) return { ok: false };

  const confidence = required.reduce((sum, k) => sum + (k?.score ?? 0), 0) / required.length;

  const hipMid = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };
  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const ankleMid = {
    x: (leftAnkle.x + rightAnkle.x) / 2,
    y: (leftAnkle.y + rightAnkle.y) / 2,
  };

  const leftKneeAngle = angleAt(
    keypointToPt(leftHip),
    keypointToPt(leftKnee),
    keypointToPt(leftAnkle)
  );
  const rightKneeAngle = angleAt(
    keypointToPt(rightHip),
    keypointToPt(rightKnee),
    keypointToPt(rightAnkle)
  );
  const kneeAngleAvg =
    leftKneeAngle == null || rightKneeAngle == null ? null : (leftKneeAngle + rightKneeAngle) / 2;

  const leftElbowAngle = angleAt(
    keypointToPt(leftShoulder),
    keypointToPt(leftElbow),
    keypointToPt(leftWrist)
  );
  const rightElbowAngle = angleAt(
    keypointToPt(rightShoulder),
    keypointToPt(rightElbow),
    keypointToPt(rightWrist)
  );
  const elbowAngleAvg =
    leftElbowAngle == null || rightElbowAngle == null ? null : (leftElbowAngle + rightElbowAngle) / 2;

  const torsoAngle = torsoAngleFromVertical(hipMid, shoulderMid);
  const hipsSagRatio = pointToLineDistanceNormalized(hipMid, shoulderMid, ankleMid);

  return {
    ok: true,
    confidence,
    hipMid,
    shoulderMid,
    ankleMid,
    kneeAngleAvg,
    elbowAngleAvg,
    torsoAngle,
    hipsSagRatio,
  };
}

function decideExerciseAuto({ kneeAngleAvg, elbowAngleAvg }) {
  if (kneeAngleAvg == null && elbowAngleAvg == null) return "auto";
  if (kneeAngleAvg != null && elbowAngleAvg == null) return "squat";
  if (elbowAngleAvg != null && kneeAngleAvg == null) return "pushup";
  // Heuristic placeholder (real logic can be improved):
  return kneeAngleAvg > 90 ? "squat" : "pushup";
}

function computeRepAndIssues({ metrics, exerciseType, repState }) {
  // repState contains previous phase + repIndex.
  const issues = [];

  let phase = repState.phase || "unknown";

  const knee = metrics.kneeAngleAvg;
  const elbow = metrics.elbowAngleAvg;
  const torso = metrics.torsoAngle;
  const hipsSagRatio = metrics.hipsSagRatio;
  const confidence = metrics.confidence;

  let currentExercise = exerciseType;
  if (exerciseType === "auto") {
    currentExercise = decideExerciseAuto({ kneeAngleAvg: knee, elbowAngleAvg: elbow });
  }

  if (currentExercise === "squat" || currentExercise === "lunge") {
    if (knee == null) return { phase: "unknown", repIndex: repState.repIndex, issues, correctnessScore: 60, exercise: currentExercise };

    const down = knee < 85;
    const up = knee > 105;
    if (down) phase = "down";
    if (up) phase = "up";

    // Depth
    if (phase === "down" && knee > 85) {
      issues.push({
        code: "depth_too_shallow",
        severity: 2,
        description: "Your bend isn't deep enough",
        recommendation: "Go a bit lower while keeping your torso stable.",
      });
    }
    // Torso
    if (torso != null && torso > 35) {
      issues.push({
        code: "torso_too_forward",
        severity: 2,
        description: "Torso leans too far forward",
        recommendation: "Brace your core and keep a more upright trunk.",
      });
    }
  } else if (currentExercise === "pushup") {
    if (elbow == null) return { phase: "unknown", repIndex: repState.repIndex, issues, correctnessScore: 60, exercise: currentExercise };

    const down = elbow < 95;
    const up = elbow > 125;
    if (down) phase = "down";
    if (up) phase = "up";

    // Depth
    if (phase === "down" && elbow > 95) {
      issues.push({
        code: "not_low_enough",
        severity: 2,
        description: "You may not reach the intended depth",
        recommendation: "Lower a bit more with controlled elbows.",
      });
    }

    // Sagging
    if (hipsSagRatio != null && phase === "down" && hipsSagRatio > 0.05) {
      issues.push({
        code: "hips_sag",
        severity: 3,
        description: "Hips sag relative to shoulders/ankles",
        recommendation: "Tighten your glutes and keep your body in a straighter line.",
      });
    }
  } else if (currentExercise === "overhead_press") {
    // Minimal placeholder heuristics:
    if (torso != null && torso > 45) {
      issues.push({
        code: "leaning",
        severity: 2,
        description: "Your torso may be leaning",
        recommendation: "Keep ribs stacked over hips while pressing overhead.",
      });
    }
    phase = repState.phase || "press";
  }

  // Correctness score from issues
  const scoreStart = 100;
  const penalty = issues.reduce((sum, i) => sum + i.severity * 10, 0);
  let correctnessScore = clamp(scoreStart - penalty, 0, 100);
  if (confidence != null && confidence < 0.55) {
    issues.push({
      code: "low_confidence_camera",
      severity: 2,
      description: "Low visibility: joints not clearly detected",
      recommendation: "Move into better lighting and ensure your full joints are visible.",
    });
    correctnessScore = clamp(correctnessScore - 15, 0, 100);
  }

  // Rep counting: down -> up transition
  let repIndex = repState.repIndex;
  if (repState.phase === "down" && phase === "up") {
    repIndex = repState.repIndex + 1;
  }

  return { phase, repIndex, issues, correctnessScore, exercise: currentExercise };
}

async function main() {
  const userId = getOrCreateUserId();
  const backendBase = window.location.origin;
  const wsUrl = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/ws/coach";

  // UI state
  let ws = null;
  let sessionId = null;
  let stream = null;
  let detector = null;
  let running = false;
  let currentRoute = null;

  let repState = { phase: "unknown", repIndex: 0 };
  let lastMetricsSentAt = 0;
  let lastCoachSentAt = 0;
  let lastFrameBase64 = null;
  let lastCoachPhase = null;
  let lastPhaseChangeAt = 0;
  let coachCooldownMs = 4000;

  // Local intervals
  let poseTimer = null;
  let frameTimer = null;

  // Elements
  const statusPill = $("statusPill");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const clearLogsBtn = $("clearLogsBtn");

  const exerciseTypeSelect = $("exerciseType");
  const safetyEnabledSelect = $("safetyEnabled");
  const goalsInput = $("goalsInput");
  const manualWorkoutText = $("manualWorkoutText");
  const addWorkoutBtn = $("addWorkoutBtn");
  const manualWorkoutStatus = $("manualWorkoutStatus");

  const phasePill = $("phasePill");
  const scorePill = $("scorePill");
  const coachPill = $("coachPill");
  const repCounter = $("repCounter");
  const issueList = $("issueList");
  const sessionIdEl = $("sessionId");

  // Route containers + nav
  // Splash + home
  const splashCard = $("splashCard");
  const homeGenerate = $("homeGenerate");
  const homeUpload = $("homeUpload");
  const homeProgress = $("homeProgress");
  const homeClinical = $("homeClinical");
  const clinicalBackBtn = $("clinicalBackBtn");

  // Pages
  const pageSplash = $("page-splash");
  const pageHome = $("page-home");
  const pageCoach = $("page-coach");
  const pageGenerate = $("page-generate");
  const pageMetrics = $("page-metrics");
  const pageClinical = $("page-clinical-report");
  const pageProfile = $("page-profile");

  // Bottom tabs
  const bottomTabs = $("bottomTabs");
  const tabDashboard = $("tab-dashboard");
  const tabProfile = $("tab-profile");
  const profileUserId = $("profileUserId");
  const pairMatBtn = $("pairMatBtn");
  const disconnectMatBtn = $("disconnectMatBtn");
  const pairMatStatus = $("pairMatStatus");

  const reportsSessionId = $("reportsSessionId");
  const generateReportBtn = $("generateReportBtn");
  const refreshBtn = $("refreshBtn");
  const generateWorkoutPlanBtn = $("generateWorkoutPlanBtn");
  const workoutPlanOutput = $("workoutPlanOutput");
  const detectedExerciseFromPlan = $("detectedExerciseFromPlan");
  const startCoachingFromPlanBtn = $("startCoachingFromPlanBtn");

  const metricsExercise = $("metricsExercise");
  const metricsDays = $("metricsDays");
  const summaryLastUpdated = $("summaryLastUpdated");
  const metricsSummary = $("metricsSummary");
  const sessionsList = $("sessionsList");
  const frequencyChartCanvas = $("frequencyChart");
  let frequencyChart = null;
  const issueStatsEl = $("issueStats");
  const reportStatusEl = $("reportStatus");
  const clinicalAnalyticsUpdated = $("clinicalAnalyticsUpdated");
  const clinicalMetricsSummary = $("clinicalMetricsSummary");
  const clinicalIssueStats = $("clinicalIssueStats");

  // Clinical report UI
  const clinicalStartDate = $("clinicalStartDate");
  const clinicalEndDate = $("clinicalEndDate");
  const generateClinicalReportBtn = $("generateClinicalReportBtn");
  const clinicalReportStatus = $("clinicalReportStatus");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  function getRouteFromHash() {
    const h = (window.location.hash || "#/splash").trim();
    if (h === "#") return "/splash";
    if (h.startsWith("#/")) return h.slice(1); // "/coach"
    return "/splash";
  }

  function setActiveRoute(route) {
    currentRoute = route;
    const r = route || "/splash";

    // Route aliasing: upload == coach
    const normalized =
      r === "/upload" ? "/coach" : r;

    pageSplash?.classList.toggle("active", normalized === "/splash");
    pageHome?.classList.toggle("active", normalized === "/home");
    pageCoach?.classList.toggle("active", normalized === "/coach");
    pageGenerate?.classList.toggle("active", normalized === "/generate");
    pageMetrics?.classList.toggle("active", normalized === "/metrics");
    pageClinical?.classList.toggle("active", normalized === "/clinical-report");
    pageProfile?.classList.toggle("active", normalized === "/profile");

    // Bottom tab bar: hide on splash, show everywhere else.
    if (bottomTabs) bottomTabs.classList.toggle("hidden", normalized === "/splash");

    // Active tab highlighting based on normalized route.
    if (tabDashboard) tabDashboard.classList.toggle("active", normalized !== "/profile" && normalized !== "/splash");
    if (tabProfile) tabProfile.classList.toggle("active", normalized === "/profile");
  }

  function stopCoachingSessionIfRunning() {
    if (!running) return Promise.resolve();
    running = false;
    stopAllLoops();
    return (async () => {
      await endSession();
      await stopCamera();
      resetUiAfterStop();
    })();
  }

  function setStatus(text) {
    statusPill.textContent = text;
  }

  function setupBluetoothPairing() {
    if (!pairMatBtn || !disconnectMatBtn || !pairMatStatus) return;

    let btDevice = null;
    let btServer = null;
    const supported = typeof navigator !== "undefined" && !!navigator.bluetooth && window.isSecureContext;

    const render = (text) => {
      pairMatStatus.textContent = text;
    };

    if (!supported) {
      pairMatBtn.disabled = true;
      disconnectMatBtn.disabled = true;
      render("Bluetooth unavailable in this browser/context. Use HTTPS Chromium.");
      return;
    }

    pairMatBtn.addEventListener("click", async () => {
      try {
        pairMatBtn.disabled = true;
        render("Searching for Pilates mat...");
        btDevice = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: ["battery_service", "device_information"],
        });
        btDevice.addEventListener("gattserverdisconnected", () => {
          btServer = null;
          disconnectMatBtn.disabled = true;
          render(`Disconnected: ${btDevice?.name || "Unknown device"}`);
        });
        btServer = await btDevice.gatt?.connect();
        if (btServer) {
          disconnectMatBtn.disabled = false;
          render(`Paired: ${btDevice?.name || "Unknown device"}`);
        } else {
          render("Device selected, but GATT connection unavailable.");
        }
      } catch (e) {
        render(`Pairing canceled or failed: ${e?.message || String(e)}`);
      } finally {
        pairMatBtn.disabled = false;
      }
    });

    disconnectMatBtn.addEventListener("click", () => {
      try {
        if (btDevice?.gatt?.connected) btDevice.gatt.disconnect();
        btServer = null;
        disconnectMatBtn.disabled = true;
        render("Disconnected from Pilates mat.");
      } catch (e) {
        render(`Disconnect error: ${e?.message || String(e)}`);
      }
    });
  }

  function setCoachPill(text, kind = "neutral") {
    coachPill.textContent = `Feedback: ${text}`;
    coachPill.classList.remove("warn", "ok", "danger");
    if (kind === "warn") coachPill.classList.add("warn");
    if (kind === "ok") coachPill.classList.add("ok");
    if (kind === "danger") coachPill.classList.add("danger");
  }

  function setScorePill(score, issues) {
    const kind = score < 60 ? "danger" : score < 80 ? "warn" : "ok";
    scorePill.textContent = `Correctness: ${score.toFixed(0)}%`;
    scorePill.classList.remove("warn", "ok", "danger");
    scorePill.classList.add(kind);

    if (issues && issues.length > 0) {
      issueList.textContent = issues.slice(0, 3).map((i) => i.description).join(" | ");
    } else {
      issueList.textContent = "-";
    }
  }

  function updateRepCounter(repIndex) {
    repCounter.textContent = `${repIndex} reps`;
  }

  function formatExerciseName(exercise) {
    switch (exercise) {
      case "squat":
        return "Squat";
      case "pushup":
        return "Pushup";
      case "lunge":
        return "Lunge";
      case "overhead_press":
        return "Overhead press";
      default:
        return exercise;
    }
  }

  async function ensureDetector() {
    if (detector) return detector;
    // poseDetection is provided by the CDN script tag.
    const model = poseDetection.SupportedModels.MoveNet;
    detector = await poseDetection.createDetector(model);
    return detector;
  }

  async function startCamera() {
    const videoEl = $("video");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await new Promise((resolve) => {
      videoEl.onloadedmetadata = () => resolve();
    });

    // Use a fixed canvas size for consistent angles and payload sizes.
    canvas.width = 512;
    canvas.height = 512;
  }

  async function captureFrameBase64() {
    const videoEl = $("video");
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    // JPEG quality tradeoff: smaller base64 reduces latency.
    const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
    // Strip `data:image/jpeg;base64,`
    return dataUrl.split(",")[1];
  }

  function connectWs() {
    return new Promise((resolve) => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => resolve();
      ws.onerror = () => setStatus("WS error");
      ws.onclose = () => {
        if (running) setStatus("WS disconnected");
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "ack") {
          sessionId = msg.sessionId;
          sessionIdEl.textContent = sessionId;
          setStatus("Session started");
          return;
        }
        if (msg.type === "coach_feedback") {
          setCoachPill(msg.coach_text || "—", "warn");
          return;
        }
        if (msg.type === "session_ended") {
          setStatus("Session ended");
          return;
        }
        if (msg.type === "error") {
          setCoachPill(`Error: ${msg.message}`, "danger");
        }
      };
    });
  }

  async function sendStartSession() {
    const exerciseType = exerciseTypeSelect.value;
    const safetyEnabled = safetyEnabledSelect.value === "true";
    const goalsText = (manualWorkoutText?.value || goalsInput?.value || "").trim();

    ws.send(
      JSON.stringify({
        type: "start_session",
        userId,
        exerciseType,
        goalsText: goalsText || null,
        safetyEnabled,
      })
    );
  }

  function stopAllLoops() {
    if (poseTimer) clearInterval(poseTimer);
    if (frameTimer) clearInterval(frameTimer);
    poseTimer = null;
    frameTimer = null;
  }

  async function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    stream = null;
  }

  async function endSession() {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "end_session" }));
      }
    } catch {}
  }

  function shouldCoach({ correctnessScore, issues, phaseChanged, repChanged, safetyEnabled, painReported, confidence }) {
    // Local gating: never call the coach if pain gating is active and user reports pain.
    // For MVP painReported is controlled by a simple UI prompt below.
    if (safetyEnabled && painReported) return false;
    if (confidence != null && confidence < 0.55) return false;
    if (!issues || issues.length === 0) return false;
    if (repChanged) return true;
    if (phaseChanged && correctnessScore < 85) return true;
    if (correctnessScore < 65) return true;
    return false;
  }

  // For MVP: a simple pain prompt at session start (no medical data collection).
  // If user says "yes", we block Gemini coaching and show stop guidance.
  let painReported = false;

  function resetUiAfterStop() {
    phasePill.textContent = "Phase: -";
    scorePill.textContent = "Correctness: -";
    scorePill.classList.remove("warn", "ok", "danger");
    coachPill.textContent = "Feedback: -";
    issueList.textContent = "-";
    repCounter.textContent = "0 reps";
    sessionIdEl.textContent = "-";
  }

  async function run() {
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    repState = { phase: "unknown", repIndex: 0 };
    updateRepCounter(0);
    setCoachPill("-", "neutral");
    phasePill.textContent = "Phase: -";
    scorePill.textContent = "Correctness: -";
    issueList.textContent = "-";
    sessionIdEl.textContent = "-";
    painReported = false;

    // Safety question at the start of the session.
    const safetyEnabled = safetyEnabledSelect.value === "true";
    if (safetyEnabled) {
      const answer = window.prompt("Are you experiencing pain or severe discomfort right now? Type 'yes' to pause coaching.", "no");
      painReported = (answer || "").trim().toLowerCase() === "yes";
    }

    try {
      await startCamera();
      await ensureDetector();
      await connectWs();
      await sendStartSession();

      // Capture frames every 1s to match Live API expectations (~1 FPS).
      frameTimer = setInterval(async () => {
        try {
          if (!running) return;
          lastFrameBase64 = await captureFrameBase64();
        } catch (e) {
          // ignore
        }
      }, 1000);

      poseTimer = setInterval(async () => {
        try {
          if (!running) return;
          const videoEl = $("video");
          const poses = await detector.estimatePoses(videoEl, {
            flipHorizontal: false,
          });
          if (!poses || poses.length === 0) return;

          const pose = poses[0];
          const metrics = computePoseMetricsFromKeypoints(pose, exerciseTypeSelect.value);
          if (!metrics.ok) return;

          const prevPhase = repState.phase;
          const prevRepIndex = repState.repIndex;

          const { phase, repIndex, issues, correctnessScore, exercise } = computeRepAndIssues({
            metrics,
            exerciseType: exerciseTypeSelect.value,
            repState,
          });

          repState = { phase, repIndex };

          phasePill.textContent = `Phase: ${phase} (${formatExerciseName(exercise)})`;
          updateRepCounter(repIndex);
          setScorePill(correctnessScore, issues);

          const phaseChanged = phase !== prevPhase;
          const repChanged = repIndex !== prevRepIndex;
          const now = nowMs();
          lastPhaseChangeAt = phaseChanged ? now : lastPhaseChangeAt;

          // Rep event: send on phase change (only when it matters).
          if (phaseChanged && repChanged) {
            ws?.send(
              JSON.stringify({
                type: "rep_event",
                repPhase: phase,
                repIndex,
                correctnessScore,
                metrics,
              })
            );
          }

          // Metrics snapshot: send max once per second.
          if (now - lastMetricsSentAt > 1000) {
            ws?.send(
              JSON.stringify({
                type: "metrics_snapshot",
                correctnessScore,
                metrics,
              })
            );
            lastMetricsSentAt = now;
          }

          // Coach event throttled by cooldown.
          const safetyEnabledNow = safetyEnabledSelect.value === "true";
          if (metrics.confidence != null && metrics.confidence < 0.55) {
            setCoachPill("Low visibility detected. Improve lighting/camera angle and keep your full body in frame.", "warn");
          } else if (
            shouldCoach({
              correctnessScore,
              issues,
              phaseChanged,
              repChanged,
              safetyEnabled: safetyEnabledNow,
              painReported,
              confidence: metrics.confidence,
            }) &&
            now - lastCoachSentAt > coachCooldownMs &&
            lastFrameBase64
          ) {
            // Only send a coaching request if phase is stable enough.
            lastCoachSentAt = now;
            lastCoachPhase = phase;
            const coachPhase = phaseChanged ? phase : repState.phase;

            ws?.send(
              JSON.stringify({
                type: "coach_event",
                phase: coachPhase,
                issues,
                frameBase64: lastFrameBase64,
                metrics,
                correctnessScore,
              })
            );
          }
        } catch (e) {
          setCoachPill("Pose estimation error (check camera permissions)", "danger");
        }
      }, 250);

      setStatus("Running... live coach active");
    } catch (e) {
      setStatus("Failed to start");
      console.error(e);
      running = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  startBtn.addEventListener("click", run);
  stopBtn.addEventListener("click", async () => {
    if (!running) return;
    running = false;
    stopAllLoops();
    await endSession();
    await stopCamera();
    resetUiAfterStop();

    // Refresh metrics only when the user is on the metrics page.
    if (currentRoute === "/metrics") {
      await refreshSessions();
      await refreshMetricsSummary();
      await refreshFrequencyChart();
      await refreshIssueStats();
    }

    startBtn.disabled = false;
    stopBtn.disabled = true;
  });

  clearLogsBtn.addEventListener("click", () => {
    coachPill.textContent = "Feedback: -";
    issueList.textContent = "-";
  });

  function inferExerciseTypeFromText(text) {
    const t = (text || "").toLowerCase();
    const has = (re) => re.test(t);

    if (has(/\bsquat(s)?\b/) || has(/knee.*squat/) || has(/\bchair\s*squat\b/)) return "squat";
    if (has(/\bpush\s?up(s)?\b/) || has(/\bpress\s+up\b/)) return "pushup";
    if (has(/\blunge(s)?\b/)) return "lunge";
    if (has(/overhead\s*press/) || has(/shoulder\s*press/) || has(/\bOHP\b/)) return "overhead_press";

    // Fallback: if we can't detect, start with auto heuristics.
    return "auto";
  }

  if (addWorkoutBtn && manualWorkoutText) {
    addWorkoutBtn.addEventListener("click", () => {
      const text = manualWorkoutText.value.trim();
      if (!text) {
        manualWorkoutStatus.textContent = "Please paste your workout instructions first.";
        return;
      }

      const inferred = inferExerciseTypeFromText(text);
      exerciseTypeSelect.value = inferred;
      exerciseTypeSelect.disabled = false;

      manualWorkoutStatus.textContent = `Detected: ${formatExerciseName(inferred)}`;
      startBtn.disabled = false;
      setStatus("Workout added. Ready to start.");
    });
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      sessionsList.innerHTML = `<div class="small">No sessions yet.</div>`;
      return;
    }
    sessionsList.innerHTML = sessions
      .map((s) => {
        const score = s.avg_correctness;
        const tagClass = score == null ? "" : score < 60 ? "danger" : score < 80 ? "warn" : "ok";
        const tagText = score == null ? "—" : `${score.toFixed(0)}%`;
        const durationText =
          s.duration_seconds == null ? "" : ` | Duration: ${Math.max(0, Math.round(s.duration_seconds))}s`;
        return `
          <div class="item">
            <div class="itemTitle">
              <div class="small"><b>${formatExerciseName(s.exercise_type)}</b></div>
              <div class="tag ${tagClass}">${tagText}</div>
            </div>
            <div class="small mono" style="margin-top: 8px;">${s.id}</div>
            <div class="small" style="margin-top: 6px;">Started: ${new Date(s.started_at).toLocaleString()}</div>
            <div class="small" style="margin-top: 4px;">Reps: ${s.total_reps ?? 0}${durationText}</div>
            ${s.ended_at ? `<div class="small">Ended: ${new Date(s.ended_at).toLocaleString()}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  async function refreshSessions() {
    const sessions = await fetchJson(`/api/sessions?userId=${encodeURIComponent(userId)}`).then((d) => d.sessions);
    renderSessions(sessions);

    // Fill report session selector
    const options = sessions
      .filter((s) => s.status === "ended")
      .slice(0, 20)
      .map((s) => `<option value="${s.id}">${s.exercise_type} - ${s.id}</option>`)
      .join("");

    reportsSessionId.innerHTML = options || `<option value="">No ended sessions</option>`;
    generateReportBtn.disabled = !reportsSessionId.value;
  }

  async function refreshMetricsSummary() {
    const exerciseType = metricsExercise.value;
    const days = Number(metricsDays.value);
    const data = await fetchJson(
      `/api/metrics-summary?userId=${encodeURIComponent(userId)}&exerciseType=${encodeURIComponent(exerciseType)}&days=${days}`
    );
    const summary = data.summary;
    summaryLastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    metricsSummary.innerHTML = summary.avg_correctness == null ? "-" : `Average correctness: <b>${summary.avg_correctness.toFixed(0)}%</b> (snapshots: ${summary.snapshots})`;
    if (clinicalAnalyticsUpdated) {
      clinicalAnalyticsUpdated.textContent = summaryLastUpdated.textContent;
    }
    if (clinicalMetricsSummary) {
      clinicalMetricsSummary.innerHTML = metricsSummary.innerHTML;
    }
  }

  async function refreshFrequencyChart() {
    const exerciseType = metricsExercise.value;
    const days = Number(metricsDays.value);
    const data = await fetchJson(
      `/api/frequency?userId=${encodeURIComponent(userId)}&exerciseType=${encodeURIComponent(exerciseType)}&days=${days}`
    );
    const points = data.points || [];

    // If no points, clear chart.
    const labels = points.map((p) => p.day.slice(5)); // MM-DD
    const values = points.map((p) => p.sessions);

    const ctx = frequencyChartCanvas.getContext("2d");
    if (frequencyChart) frequencyChart.destroy();
    frequencyChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Sessions",
            data: values,
            backgroundColor: "rgba(74,108,247,0.35)",
            borderColor: "rgba(74,108,247,0.8)",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, precision: 0 },
        },
      },
    });
  }

  function issueCopy(issueCode) {
    // Clinically-style, safety-first copy. Keep it general; avoid claiming diagnosis.
    const map = {
      depth_too_shallow: {
        title: "Not deep enough (squat/lunge)",
        risk: "May reduce the intended stretch/strength benefit.",
        recommendation: "Go slightly deeper only within a pain-free range, keeping control.",
      },
      torso_too_forward: {
        title: "Torso leans too far forward",
        risk: "Can increase load on the lower back and reduce stability.",
        recommendation: "Brace your core and practice a more upright trunk (slow tempo).",
      },
      not_low_enough: {
        title: "Not low enough (pushup)",
        risk: "May limit chest/shoulder strengthening and change joint stress patterns.",
        recommendation: "Lower with control until you reach the target depth you can maintain safely.",
      },
      hips_sag: {
        title: "Hips sag (pushup form)",
        risk: "Can shift stress to the low back and reduce core engagement.",
        recommendation: "Tighten glutes and abdominals; keep a straighter line from shoulders to ankles.",
      },
      leaning: {
        title: "Torso leaning (overhead press)",
        risk: "May reduce overhead control and increase strain in the spine.",
        recommendation: "Press while keeping ribs stacked over hips; try a lighter weight.",
      },
      unknown: {
        title: "Form issue detected",
        risk: "Coaching confidence may be limited by camera angle/visibility.",
        recommendation: "Repeat slowly and ensure you are centered in frame with good lighting.",
      },
      low_confidence_camera: {
        title: "Low camera/pose visibility",
        risk: "Measurements may be unreliable, increasing the chance of incorrect cues.",
        recommendation: "Improve lighting and camera framing so key joints (hips/knees/ankles or shoulders/elbows/wrists) are clearly visible.",
      },
    };
    return map[issueCode] || map.unknown;
  }

  async function refreshIssueStats() {
    const exerciseType = metricsExercise.value;
    const days = Number(metricsDays.value);
    const data = await fetchJson(
      `/api/issue-stats?userId=${encodeURIComponent(userId)}&exerciseType=${encodeURIComponent(exerciseType)}&days=${days}`
    );
    const issues = data.issues || [];

    if (issues.length === 0) {
      issueStatsEl.textContent = "No form issues logged in this lookback window yet.";
      if (clinicalIssueStats) {
        clinicalIssueStats.textContent = issueStatsEl.textContent;
      }
      return;
    }

    issueStatsEl.innerHTML = issues
      .slice(0, 5)
      .map((i) => {
        const sev = i.avg_severity == null ? 2 : i.avg_severity;
        const tagClass = sev >= 2.7 ? "danger" : sev >= 1.7 ? "warn" : "ok";
        const copy = issueCopy(i.issue_code);
        return `
          <div style="margin-top: 10px;">
            <div class="small" style="display:flex; justify-content:space-between; gap:12px; align-items:baseline;">
              <b>${copy.title}</b>
              <span class="tag ${tagClass}" style="white-space:nowrap;">${i.occurrences}x</span>
            </div>
            <div class="small" style="margin-top: 4px;">Risk: ${copy.risk}</div>
            <div class="small" style="margin-top: 4px;">Recommendation: ${copy.recommendation}</div>
          </div>
        `;
      })
      .join("");
    if (clinicalIssueStats) {
      clinicalIssueStats.innerHTML = issueStatsEl.innerHTML;
    }
  }

  $("refreshBtn").addEventListener("click", async () => {
    await refreshSessions();
    await refreshMetricsSummary();
    await refreshFrequencyChart();
    await refreshIssueStats();
  });

  reportsSessionId.addEventListener("change", () => {
    generateReportBtn.disabled = !reportsSessionId.value;
  });

  metricsExercise.addEventListener("change", refreshMetricsSummary);
  metricsDays.addEventListener("change", refreshMetricsSummary);
  metricsExercise.addEventListener("change", refreshFrequencyChart);
  metricsDays.addEventListener("change", refreshFrequencyChart);
  metricsExercise.addEventListener("change", refreshIssueStats);
  metricsDays.addEventListener("change", refreshIssueStats);

  generateReportBtn.addEventListener("click", async () => {
    const sessionId = reportsSessionId.value;
    if (!sessionId) return;

    generateReportBtn.disabled = true;
    reportStatusEl.textContent = "Report generation started...";

    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const start = nowMs();
      while (nowMs() - start < 120000) {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/report`);
        if (!res.ok) throw new Error("Polling failed");
        const data = await res.json();
        if (data.report?.status === "completed") {
          reportStatusEl.textContent = "Report completed. Opening PDF download...";
          const pdfB64 = data.report.report_pdf_base64;
          if (pdfB64) {
            const a = document.createElement("a");
            a.href = `data:application/pdf;base64,${pdfB64}`;
            a.download = `physio_report_${sessionId}.pdf`;
            a.click();
          }
          // Also show a quick text preview for interpretability.
          const text = (data.report.report_text || "").slice(0, 1000);
          if (text) alert(text);
          break;
        }
        if (data.report?.status === "failed") {
          reportStatusEl.textContent = "Report generation failed (see backend logs).";
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      reportStatusEl.textContent = `Report error: ${e?.message || String(e)}`;
    } finally {
      generateReportBtn.disabled = !reportsSessionId.value;
    }
  });

  generateWorkoutPlanBtn.addEventListener("click", async () => {
    const goalsText = goalsInput.value.trim();
    if (!goalsText) {
      alert("Please enter some workout goals/notes first.");
      return;
    }
    generateWorkoutPlanBtn.disabled = true;
    workoutPlanOutput.textContent = "Generating workout plan...";
    try {
      const res = await fetch("/api/workout-plans/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          goalsText,
          // Let the backend choose the exercise sequence (or MVP heuristic fallback).
          exerciseType: "auto",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      workoutPlanOutput.textContent = data.plan_text || "No plan returned.";

      const inferred = inferExerciseTypeFromText(data.plan_text || "");
      if (detectedExerciseFromPlan) detectedExerciseFromPlan.textContent = formatExerciseName(inferred);
      if (startCoachingFromPlanBtn) startCoachingFromPlanBtn.disabled = false;

      // Pre-fill the coach with the generated plan text so it can be used as context/goals.
      if (manualWorkoutText) manualWorkoutText.value = data.plan_text || "";
    } catch (e) {
      workoutPlanOutput.textContent = `Failed: ${e?.message || String(e)}`;
    } finally {
      generateWorkoutPlanBtn.disabled = false;
    }
  });

  if (startCoachingFromPlanBtn) {
    startCoachingFromPlanBtn.addEventListener("click", async () => {
      const text = workoutPlanOutput?.textContent || "";
      const inferred = inferExerciseTypeFromText(text);

      // Ensure the coach page knows which exercise to analyze.
      if (exerciseTypeSelect) {
        exerciseTypeSelect.value = inferred;
        exerciseTypeSelect.disabled = false;
      }
      if (manualWorkoutStatus && manualWorkoutText) {
        manualWorkoutStatus.textContent = `Detected: ${formatExerciseName(inferred)}`;
        // Keep the generated plan as "goals" for logging.
      }

      // Enable the start button.
      if (startBtn) startBtn.disabled = false;

      // Navigate to coach page.
      window.location.hash = "/coach";
    });
  }

  async function maybeRefreshMetricsForRoute(route) {
    const r = route === "/upload" ? "/coach" : route;
    if (r !== "/metrics" && r !== "/clinical-report") return;
    await refreshSessions();
    await refreshMetricsSummary();
    await refreshIssueStats();
    if (r === "/metrics") {
      await refreshFrequencyChart();
    }
  }

  function bindNav() {
    // Home buttons
    if (homeGenerate) homeGenerate.addEventListener("click", () => (window.location.hash = "/generate"));
    if (homeUpload) homeUpload.addEventListener("click", () => (window.location.hash = "/upload"));
    if (homeProgress) homeProgress.addEventListener("click", () => (window.location.hash = "/metrics"));
    if (homeClinical) homeClinical.addEventListener("click", () => (window.location.hash = "/clinical-report"));
    if (clinicalBackBtn) clinicalBackBtn.addEventListener("click", () => (window.location.hash = "/home"));

    // Bottom tabs
    if (tabDashboard) tabDashboard.addEventListener("click", () => (window.location.hash = "/home"));
    if (tabProfile) tabProfile.addEventListener("click", () => (window.location.hash = "/profile"));
  }

  window.addEventListener("hashchange", async () => {
    const newRoute = getRouteFromHash();
    const prevRoute = currentRoute || "/coach";
    setActiveRoute(newRoute);

    // Safety: if we leave coach, stop camera + WS.
    const prevNorm = prevRoute === "/upload" ? "/coach" : prevRoute;
    const newNorm = newRoute === "/upload" ? "/coach" : newRoute;
    if (prevNorm === "/coach" && newNorm !== "/coach") {
      await stopCoachingSessionIfRunning();
      setStatus("Stopped (navigated away)");
    }

    await maybeRefreshMetricsForRoute(newRoute);
  });

  function startSplashTimer() {
    // Only run when we are on the splash route.
    const route = getRouteFromHash();
    if (route !== "/splash") return;

    // 6 seconds (within requested 5–8 seconds)
    const delayMs = 6000;
    setTimeout(() => {
      // Animate swipe up then route.
      if (splashCard) splashCard.classList.add("swipeUp");
      setTimeout(() => {
        window.location.hash = "/home";
      }, 650);
    }, delayMs);
  }

  // Initial load
  setActiveRoute(getRouteFromHash());
  bindNav();
  setupBluetoothPairing();
  if (profileUserId) profileUserId.textContent = userId;
  await maybeRefreshMetricsForRoute(currentRoute);
  startSplashTimer();

  // Clinical report generation (date range)
  if (generateClinicalReportBtn) {
    generateClinicalReportBtn.addEventListener("click", async () => {
      const startDate = clinicalStartDate?.value;
      const endDate = clinicalEndDate?.value;
      if (!startDate || !endDate) {
        clinicalReportStatus.textContent = "Please select both start and end dates.";
        return;
      }
      if (startDate > endDate) {
        clinicalReportStatus.textContent = "Start date must be before end date.";
        return;
      }

      generateClinicalReportBtn.disabled = true;
      clinicalReportStatus.textContent = "Clinical report generation started...";

      try {
        const res = await fetch("/api/reports/clinical", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, startDate, endDate }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const reportId = data.reportId;
        if (!reportId) throw new Error("No reportId returned");

        const start = nowMs();
        while (nowMs() - start < 120000) {
          const poll = await fetch(`/api/reports/clinical/${encodeURIComponent(reportId)}`);
          if (!poll.ok) throw new Error("Polling failed");
          const payload = await poll.json();
          if (payload.report?.status === "completed") {
            clinicalReportStatus.textContent = "Report completed. Opening PDF download...";
            const pdfB64 = payload.report.report_pdf_base64;
            if (pdfB64) {
              const a = document.createElement("a");
              a.href = `data:application/pdf;base64,${pdfB64}`;
              a.download = `formalign_clinical_report_${startDate}_to_${endDate}.pdf`;
              a.click();
            }
            break;
          }
          if (payload.report?.status === "failed") {
            clinicalReportStatus.textContent = "Report generation failed.";
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (e) {
        clinicalReportStatus.textContent = `Clinical report error: ${e?.message || String(e)}`;
      } finally {
        generateClinicalReportBtn.disabled = false;
      }
    });
  }

  // Expose for debugging
  window.__pc = {
    userId,
  };
}

// Wait for poseDetection global before starting.
window.addEventListener("load", () => {
  if (window.poseDetection) {
    main().catch((e) => console.error(e));
  } else {
    // Retry once
    const t = setInterval(() => {
      if (window.poseDetection) {
        clearInterval(t);
        main().catch((e) => console.error(e));
      }
    }, 250);
  }
});

