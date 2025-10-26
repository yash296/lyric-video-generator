/*
  Lyric Video Generator (Browser)
  - Canvas rendering + MediaRecorder capture
  - SRT parsing (simple, robust to common formats)
  - Animated backgrounds (gradient, shapes)
  - Synchronized lyrics with fade transitions
  All processing local; no AI used.
*/

// ---- DOM Elements ----
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const audioEl = document.getElementById("audio");

const audioInput = document.getElementById("audioInput");
const srtInput = document.getElementById("srtInput");

const startBtn = document.getElementById("startBtn");
const cancelBtn = document.getElementById("cancelBtn");
const downloadBtn = document.getElementById("downloadBtn");

const resolutionSel = document.getElementById("resolution");
const fpsInput = document.getElementById("fps");
const bgTypeSel = document.getElementById("bgType");
const bgSpeedInput = document.getElementById("bgSpeed");
const fontFamilyInput = document.getElementById("fontFamily");
const fontSizeInput = document.getElementById("fontSize");
const fontColorInput = document.getElementById("fontColor");
const strokeColorInput = document.getElementById("strokeColor");
const lyricYInput = document.getElementById("lyricY");

const progressEl = document.getElementById("progress");
const statusEl = document.getElementById("status");

// ---- State ----
let lyrics = []; // { start, end, text }
let audioBuffer = null;
let audioUrl = null;
let srtText = "";
let renderAbortController = null;
let mediaRecorder = null;
let recordedChunks = [];
let animationState = { t: 0, shapes: [] };
// WebAudio (headless) rendering state
let webAudioCtx = null;
let webAudioDest = null;
let webAudioSource = null;
let webAudioStartTime = 0;

// ---- Utilities ----
function parseResolution(value) {
  const [w, h] = value.split("x").map(Number);
  return { width: w, height: h };
}

function timeToSeconds(h, m, s, ms) {
  return h * 3600 + m * 60 + s + ms / 1000;
}

function parseSrt(srt) {
  // Returns array of { start: seconds, end: seconds, text: string }
  // Handles common SRT patterns, trims blank lines and HTML tags.
  const entries = [];
  const blocks = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split(/\n/);
    if (lines.length < 2) continue;
    let timeLineIndex = 0;
    // Some SRTs have an index line first
    if (/^\d+$/.test(lines[0].trim()) && lines.length >= 2) {
      timeLineIndex = 1;
    }
    const timeLine = lines[timeLineIndex];
    const m = timeLine.match(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})/
    );
    if (!m) continue;
    const start = timeToSeconds(+m[1], +m[2], +m[3], +m[4]);
    const end = timeToSeconds(+m[5], +m[6], +m[7], +m[8]);
    const textLines = lines.slice(timeLineIndex + 1);
    const text = textLines
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\\N/g, "\n")
      .trim();
    if (text) entries.push({ start, end, text });
  }
  // Merge consecutive identical text to reduce flicker
  const merged = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && last.text === e.text && Math.abs(last.end - e.start) < 0.15) {
      last.end = e.end;
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}

function fitCanvasToResolution() {
  const { width, height } = parseResolution(resolutionSel.value);
  canvas.width = width;
  canvas.height = height;
}

function loadAudioFile(file) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(file);
  audioEl.src = audioUrl;
}

async function readTextFile(file) {
  return await file.text();
}

async function decodeAudioFromFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    return decoded;
  } finally {
    try {
      await ctx.close();
    } catch (_) {}
  }
}

function canStart() {
  return (Boolean(audioEl.src) || Boolean(audioBuffer)) && lyrics.length > 0;
}

function setControlsState(state) {
  // state: 'idle' | 'ready' | 'rendering' | 'done'
  if (state === "idle") {
    startBtn.disabled = !canStart();
    cancelBtn.disabled = true;
    downloadBtn.disabled = true;
  } else if (state === "ready") {
    startBtn.disabled = false;
    cancelBtn.disabled = true;
    downloadBtn.disabled = true;
  } else if (state === "rendering") {
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    downloadBtn.disabled = true;
  } else if (state === "done") {
    startBtn.disabled = false;
    cancelBtn.disabled = true;
    downloadBtn.disabled = recordedChunks.length === 0;
  }
}

// ---- Backgrounds ----
function drawGradientBackground(t) {
  const w = canvas.width,
    h = canvas.height;
  const speed = parseFloat(bgSpeedInput.value) || 0.3;
  const p = (t * speed) % 1;
  const angle = p * Math.PI * 2;
  const cx = w / 2 + Math.cos(angle) * w * 0.25;
  const cy = h / 2 + Math.sin(angle) * h * 0.25;
  const grad = ctx.createRadialGradient(
    cx,
    cy,
    0,
    w / 2,
    h / 2,
    Math.hypot(w, h) / 2
  );
  grad.addColorStop(0, "#0ea5e9");
  grad.addColorStop(0.5, "#6366f1");
  grad.addColorStop(1, "#0b0f1a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // subtle overlay
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  for (let i = 0; i < 4; i++) {
    const a = angle + (i * Math.PI) / 2;
    const x = w / 2 + Math.cos(a) * w * 0.45;
    const y = h / 2 + Math.sin(a) * h * 0.45;
    const r = Math.min(w, h) * 0.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ensureShapes() {
  if (animationState.shapes.length) return;
  const count = 18;
  for (let i = 0; i < count; i++) {
    animationState.shapes.push({
      x: Math.random(),
      y: Math.random(),
      r: 0.02 + Math.random() * 0.06,
      vx: -0.02 + Math.random() * 0.04,
      vy: -0.02 + Math.random() * 0.04,
      hue: Math.floor(Math.random() * 360),
    });
  }
}

function drawShapesBackground(dt) {
  const w = canvas.width,
    h = canvas.height;
  const speed = parseFloat(bgSpeedInput.value) || 0.3;
  ctx.fillStyle = "#0b0f1a";
  ctx.fillRect(0, 0, w, h);
  ensureShapes();
  for (const s of animationState.shapes) {
    s.x += s.vx * dt * speed;
    s.y += s.vy * dt * speed;
    if (s.x < -0.1) s.x = 1.1;
    if (s.x > 1.1) s.x = -0.1;
    if (s.y < -0.1) s.y = 1.1;
    if (s.y > 1.1) s.y = -0.1;
    const px = s.x * w;
    const py = s.y * h;
    const pr = s.r * Math.min(w, h);
    const grad = ctx.createRadialGradient(px, py, pr * 0.2, px, py, pr);
    grad.addColorStop(0, `hsla(${s.hue}, 90%, 60%, 0.6)`);
    grad.addColorStop(1, "rgba(14, 10, 25, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- Lyrics ----
function currentLyricAt(t) {
  // t in seconds
  // binary search would be faster; linear is OK for < 1000 entries
  for (let i = 0; i < lyrics.length; i++) {
    const L = lyrics[i];
    if (t >= L.start - 0.05 && t <= L.end + 0.05) return { index: i, entry: L };
    if (t < L.start) break;
  }
  return { index: -1, entry: null };
}

function drawLyric(t) {
  const { entry } = currentLyricAt(t);
  if (!entry) return;
  const yPct = Math.max(0, Math.min(100, parseFloat(lyricYInput.value) || 50));
  const y = (yPct / 100) * canvas.height;
  const fontSize = Math.max(
    12,
    Math.min(400, parseInt(fontSizeInput.value || "56", 10))
  );
  const family = fontFamilyInput.value || "sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${fontSize}px ${family}`;

  // fade in/out and fancy pop-in
  const fade = 0.18;
  const aIn = Math.max(0, Math.min(1, (t - entry.start) / fade));
  const aOut = Math.max(0, Math.min(1, (entry.end - t) / fade));
  const alpha = Math.min(aIn, aOut);
  const popDur = 0.35;
  const p = Math.max(0, Math.min(1, (t - entry.start) / popDur));
  const backS = 1.25;
  const backOut = (x) => {
    const s = backS;
    const inv = x - 1;
    return inv * inv * ((s + 1) * inv + s) + 1;
  };
  const scale = 0.9 + 0.1 * backOut(p);

  const fill = fontColorInput.value || "#fff";
  const stroke = strokeColorInput.value || "#000";
  const lines = entry.text.split(/\n/);
  const lineHeight = fontSize * 1.25;
  const totalHeight = lineHeight * lines.length;
  const relStartY = -totalHeight / 2 + lineHeight / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(canvas.width / 2, y);
  ctx.scale(scale, scale);

  // glow that reduces as pop completes
  const glow = fontSize * (0.7 - 0.5 * p);
  ctx.shadowColor = fill;
  ctx.shadowBlur = Math.max(0, glow);
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(2, fontSize * 0.08);
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;

  for (let i = 0; i < lines.length; i++) {
    const ly = relStartY + i * lineHeight;
    ctx.strokeText(lines[i], 0, ly);
    ctx.fillText(lines[i], 0, ly);
  }
  ctx.restore();
}

// ---- Recording ----
function buildCanvasStreamWithAudio() {
  const fps = Math.max(15, Math.min(60, parseInt(fpsInput.value || "30", 10)));
  const canvasStream = canvas.captureStream(fps);
  const audioStream = audioEl.captureStream ? audioEl.captureStream() : null;
  if (!audioStream) return canvasStream;
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const source = ctx.createMediaElementSource(audioEl);
  source.connect(dest);
  // also connect to speakers for monitoring
  source.connect(ctx.destination);
  const composed = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => composed.addTrack(t));
  dest.stream.getAudioTracks().forEach((t) => composed.addTrack(t));
  return composed;
}

function buildCanvasStreamWithWebAudio() {
  const fps = Math.max(15, Math.min(60, parseInt(fpsInput.value || "30", 10)));
  const canvasStream = canvas.captureStream(fps);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(dest);
  // Do NOT connect to speakers to avoid audible playback
  src.start(0);
  webAudioCtx = ctx;
  webAudioDest = dest;
  webAudioSource = src;
  webAudioStartTime = ctx.currentTime;
  const composed = new MediaStream();
  canvasStream.getVideoTracks().forEach((t) => composed.addTrack(t));
  dest.stream.getAudioTracks().forEach((t) => composed.addTrack(t));
  return composed;
}

function startRecording(streamOverride) {
  recordedChunks = [];
  const stream = streamOverride || buildCanvasStreamWithAudio();
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm;codecs=vp8";
  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
  });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    setControlsState("done");
    statusEl.textContent = "Render complete";
    downloadBtn.disabled = recordedChunks.length === 0;
  };
  mediaRecorder.start();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

function downloadRecording() {
  const blob = new Blob(recordedChunks, {
    type: recordedChunks[0]?.type || "video/webm",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "lyric-video.webm";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Render Loop ----
async function renderAll() {
  const { width, height } = parseResolution(resolutionSel.value);
  canvas.width = width;
  canvas.height = height;

  const fps = Math.max(15, Math.min(60, parseInt(fpsInput.value || "30", 10)));
  const frameDuration = 1 / fps;
  const hasWebAudio = Boolean(audioBuffer);
  const totalDuration =
    hasWebAudio && isFinite(audioBuffer.duration)
      ? audioBuffer.duration
      : isFinite(audioEl.duration) && audioEl.duration > 0
      ? audioEl.duration
      : estimateDurationFromLyrics();

  progressEl.value = 0;
  statusEl.textContent = "Rendering...";
  setControlsState("rendering");

  // Choose audio path: WebAudio (headless) if we have decoded buffer; fallback to HTMLAudio
  if (hasWebAudio) {
    const composed = buildCanvasStreamWithWebAudio();
    startRecording(composed);
  } else {
    startRecording();
  }

  renderAbortController = new AbortController();
  const { signal } = renderAbortController;

  if (!hasWebAudio) {
    // Fallback path uses HTMLAudio playback
    audioEl.currentTime = 0;
    await audioEl.play().catch(() => {
      /* user gesture may be required, recording still proceeds */
    });
    await waitForPlaybackStart();
  }

  let lastT = 0;
  while (true) {
    if (signal.aborted) break;
    const t = hasWebAudio
      ? Math.max(
          0,
          webAudioCtx ? webAudioCtx.currentTime - webAudioStartTime : lastT
        )
      : Number.isFinite(audioEl.currentTime)
      ? audioEl.currentTime
      : lastT;
    const dt = Math.max(0, t - lastT);
    lastT = t;

    // Background
    if (bgTypeSel.value === "gradient") {
      drawGradientBackground(t);
    } else {
      drawShapesBackground(dt);
    }

    // Lyrics
    drawLyric(t);

    // Progress
    if (isFinite(totalDuration) && totalDuration > 0) {
      progressEl.value = Math.min(1, t / totalDuration);
    }

    // Stop condition
    if (
      (isFinite(totalDuration) && t >= totalDuration) ||
      (!hasWebAudio && audioEl.ended)
    ) {
      break;
    }

    // Frame pacing
    await waitSeconds(frameDuration);
  }

  stopRecording();
  if (hasWebAudio) {
    try {
      webAudioSource && webAudioSource.stop();
    } catch (_) {}
    try {
      webAudioCtx && webAudioCtx.close();
    } catch (_) {}
    webAudioCtx = null;
    webAudioDest = null;
    webAudioSource = null;
  } else {
    audioEl.pause();
  }
  statusEl.textContent = "Finalizing...";
}

function estimateDurationFromLyrics() {
  if (!lyrics.length) return 0;
  return lyrics[lyrics.length - 1].end;
}

function waitSeconds(sec) {
  return new Promise((r) => setTimeout(r, Math.max(0, sec * 1000)));
}

function waitForPlaybackStart() {
  return new Promise((resolve) => {
    if (!audioEl.paused) return resolve();
    const onPlay = () => {
      audioEl.removeEventListener("playing", onPlay);
      resolve();
    };
    audioEl.addEventListener("playing", onPlay, { once: true });
    // Fallback in case 'playing' doesn't fire promptly
    setTimeout(resolve, 300);
  });
}

function resetAnimationState() {
  animationState = { t: 0, shapes: [] };
}

// ---- Event wiring ----
audioInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  loadAudioFile(file);
  statusEl.textContent = "Audio loaded";
  // Decode for headless rendering
  decodeAudioFromFile(file)
    .then((buf) => {
      audioBuffer = buf;
      statusEl.textContent = "Audio decoded";
      startBtn.disabled = !canStart();
    })
    .catch(() => {
      audioBuffer = null;
    })
    .finally(() => {
      startBtn.disabled = !canStart();
    });
  startBtn.disabled = !canStart();
});

srtInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  srtText = await readTextFile(file);
  lyrics = parseSrt(srtText);
  if (!lyrics.length) {
    statusEl.textContent = "Failed to parse SRT";
  } else {
    statusEl.textContent = `Parsed ${lyrics.length} lyric lines`;
  }
  startBtn.disabled = !canStart();
});

resolutionSel.addEventListener("change", () => {
  fitCanvasToResolution();
});

startBtn.addEventListener("click", async () => {
  resetAnimationState();
  await renderAll();
});

cancelBtn.addEventListener("click", () => {
  if (renderAbortController) renderAbortController.abort();
  stopRecording();
  try {
    audioEl.pause();
  } catch (_) {}
  if (webAudioSource) {
    try {
      webAudioSource.stop();
    } catch (_) {}
  }
  if (webAudioCtx) {
    try {
      webAudioCtx.close();
    } catch (_) {}
  }
  webAudioCtx = null;
  webAudioDest = null;
  webAudioSource = null;
  setControlsState("idle");
  statusEl.textContent = "Cancelled";
});

downloadBtn.addEventListener("click", () => {
  downloadRecording();
});

// Enable download button when recording stops
document.addEventListener("visibilitychange", () => {
  // no-op; placeholder for potential focus handling
});

// When audio metadata is loaded, allow start if we have lyrics
audioEl.addEventListener("loadedmetadata", () => {
  startBtn.disabled = !canStart();
});

// Update controls on chunks available
function updateDownloadAvailability() {
  downloadBtn.disabled = recordedChunks.length === 0;
}

// When MediaRecorder stops, enable download button
// Already handled in onstop

// Initial setup
fitCanvasToResolution();
setControlsState("idle");
statusEl.textContent = "Idle";
