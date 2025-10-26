#!/usr/bin/env node
// Node.js CLI renderer for Lyric Video Generator
// Renders frames using @napi-rs/canvas and muxes with MP3 via ffmpeg-static

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { Command } from "commander";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ffmpegPath from "ffmpeg-static";
import ffprobeMod from "ffprobe-static";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- CLI ----
const program = new Command();
program
  .name("brickoven-lyrics-render")
  .description("Render a lyric video headlessly with Node.js")
  .requiredOption("-a, --audio <file>", "Path to MP3 audio file")
  .requiredOption("-s, --srt <file>", "Path to SRT subtitle file")
  .option("-o, --out <file>", "Output video file", "lyric-video.mp4")
  .option("-r, --fps <number>", "Frames per second", "30")
  .option("-R, --resolution <WxH>", "Resolution, e.g. 1920x1080", "1920x1080")
  .option("--bg <type>", "Background type: gradient|shapes", "gradient")
  .option("--bg-speed <number>", "Background speed scalar", "0.3")
  .option("--font-family <name>", "Font family", "Inter, system-ui, sans-serif")
  .option("--font-file <path>", "Optional .ttf/.otf font file to register")
  .option("--font-size <px>", "Font size in px", "56")
  .option("--font-color <hex>", "Fill color", "#ffffff")
  .option("--stroke-color <hex>", "Stroke color", "#000000")
  .option("--lyric-y <percent>", "Vertical position (0-100)", "50")
  .parse(process.argv);

const opts = program.opts();

// ---- Helpers ----
function parseResolution(value) {
  const [w, h] = value.split("x").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error(`Bad resolution '${value}'. Expected WxH like 1920x1080.`);
  }
  return { width: w, height: h };
}

function timeToSeconds(h, m, s, ms) {
  return h * 3600 + m * 60 + s + ms / 1000;
}

function parseSrt(srt) {
  const entries = [];
  const blocks = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split(/\n/);
    if (lines.length < 2) continue;
    let timeLineIndex = 0;
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
    const text = lines
      .slice(timeLineIndex + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\\N/g, "\n")
      .trim();
    if (text) entries.push({ start, end, text });
  }
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

function estimateDurationFromLyrics(lyrics) {
  if (!lyrics.length) return 0;
  return lyrics[lyrics.length - 1].end;
}

async function probeAudioDurationSec(audioPath) {
  const probePath = ffprobeMod?.path || ffprobeMod?.ffprobe || ffprobeMod;
  if (!probePath) return null;
  return await new Promise((resolve) => {
    const proc = spawn(probePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      const val = parseFloat(out.trim());
      resolve(Number.isFinite(val) ? val : null);
    });
    proc.on("error", () => resolve(null));
  });
}

function parseColor(hex) {
  // simple hex to rgba string; accept #rgb, #rrggbb
  const h = hex.replace(/^#/, "");
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return `rgba(${r},${g},${b},1)`;
  }
  if (h.length === 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},1)`;
  }
  return hex; // fallback as-is
}

// ---- Backgrounds ----
function drawGradientBackground(ctx, canvas, t, speedScalar) {
  const w = canvas.width,
    h = canvas.height;
  const speed = isFinite(speedScalar) ? speedScalar : 0.3;
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

function ensureShapes(state) {
  if (state.shapes.length) return;
  const count = 18;
  for (let i = 0; i < count; i++) {
    state.shapes.push({
      x: Math.random(),
      y: Math.random(),
      r: 0.02 + Math.random() * 0.06,
      vx: -0.02 + Math.random() * 0.04,
      vy: -0.02 + Math.random() * 0.04,
      hue: Math.floor(Math.random() * 360),
    });
  }
}

function drawShapesBackground(ctx, canvas, dt, speedScalar, state) {
  const w = canvas.width,
    h = canvas.height;
  const speed = isFinite(speedScalar) ? speedScalar : 0.3;
  ctx.fillStyle = "#0b0f1a";
  ctx.fillRect(0, 0, w, h);
  ensureShapes(state);
  for (const s of state.shapes) {
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
function currentLyricAt(lyrics, t) {
  for (let i = 0; i < lyrics.length; i++) {
    const L = lyrics[i];
    if (t >= L.start - 0.05 && t <= L.end + 0.05) return { index: i, entry: L };
    if (t < L.start) break;
  }
  return { index: -1, entry: null };
}

function drawLyric(ctx, canvas, lyrics, t, style) {
  const { entry } = currentLyricAt(lyrics, t);
  if (!entry) return;
  const yPct = Math.max(0, Math.min(100, parseFloat(style.lyricY) || 50));
  const y = (yPct / 100) * canvas.height;
  const fontSize = Math.max(
    12,
    Math.min(400, parseInt(style.fontSize || "56", 10))
  );
  const familyRaw = style.fontFamily || "sans-serif";
  const family = familyRaw.split(",")[0];
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${fontSize}px ${family}`;

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

  const fill = parseColor(style.fontColor || "#fff");
  const stroke = parseColor(style.strokeColor || "#000");
  const lines = entry.text.split(/\n/);
  const lineHeight = fontSize * 1.25;
  const totalHeight = lineHeight * lines.length;
  const relStartY = -totalHeight / 2 + lineHeight / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(canvas.width / 2, y);
  ctx.scale(scale, scale);

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

// ---- Main render ----
async function main() {
  const audioPath = path.resolve(process.cwd(), opts.audio);
  const srtPath = path.resolve(process.cwd(), opts.srt);
  const outPath = path.resolve(process.cwd(), opts.out);
  const { width, height } = parseResolution(opts.resolution);
  const fps = Math.max(15, Math.min(60, parseInt(opts.fps || "30", 10)));
  const bgType = (opts.bg || "gradient").toLowerCase();
  const bgSpeed = parseFloat(opts.bgSpeed || "0.3");
  const style = {
    fontFamily: opts.fontFamily,
    fontSize: opts.fontSize,
    fontColor: opts.fontColor,
    strokeColor: opts.strokeColor,
    lyricY: opts.lyricY,
  };

  if (!fs.existsSync(audioPath))
    throw new Error(`Audio not found: ${audioPath}`);
  if (!fs.existsSync(srtPath)) throw new Error(`SRT not found: ${srtPath}`);

  if (opts.fontFile) {
    const fontPath = path.resolve(process.cwd(), opts.fontFile);
    if (!fs.existsSync(fontPath)) {
      throw new Error(`Font file not found: ${fontPath}`);
    }
    const familyName =
      (opts.fontFamily || "Custom").split(",")[0].trim() || "Custom";
    GlobalFonts.registerFromPath(fontPath, familyName);
  }

  const srtText = fs.readFileSync(srtPath, "utf8");
  const lyrics = parseSrt(srtText);
  if (!lyrics.length) {
    throw new Error("No lyrics parsed from SRT.");
  }

  let durationSec = await probeAudioDurationSec(audioPath);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = estimateDurationFromLyrics(lyrics);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Unable to determine duration from audio or SRT.");
  }

  const totalFrames = Math.ceil(durationSec * fps);
  console.log(
    `Rendering ${totalFrames} frames @ ${fps} FPS (${durationSec.toFixed(
      2
    )}s) ...`
  );

  // Prepare canvas
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const state = { t: 0, shapes: [] };

  // Prepare ffmpeg
  const ffmpeg = ffmpegPath;
  if (!ffmpeg) throw new Error("ffmpeg binary not found (ffmpeg-static).");

  const ffArgs = [
    "-y",
    // video pipe
    "-f",
    "image2pipe",
    "-r",
    String(fps),
    "-i",
    "pipe:0",
    // audio file
    "-i",
    audioPath,
    "-shortest",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outPath,
  ];

  const proc = spawn(ffmpeg, ffArgs, { stdio: ["pipe", "inherit", "inherit"] });

  let lastT = 0;
  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    const dt = i === 0 ? 0 : t - lastT;
    lastT = t;

    // Background
    if (bgType === "gradient") {
      drawGradientBackground(ctx, canvas, t, bgSpeed);
    } else {
      drawShapesBackground(ctx, canvas, dt, bgSpeed, state);
    }

    // Lyrics
    drawLyric(ctx, canvas, lyrics, t, style);

    // Write frame as PNG to ffmpeg stdin (await encode and handle backpressure)
    const png = await canvas.encode("png");
    if (!proc.stdin.write(png)) {
      await new Promise((resolve) => proc.stdin.once("drain", resolve));
    }

    if (i % Math.max(1, Math.floor(fps)) === 0) {
      process.stdout.write(`\rFrames: ${i + 1}/${totalFrames}`);
    }
  }

  // End of stream
  proc.stdin.end();
  await new Promise((resolve, reject) => {
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  process.stdout.write(`\rFrames: ${totalFrames}/${totalFrames}\n`);
  console.log(`Done → ${outPath}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
