"use strict";
/**
 * Subtitles pipeline: transcribe (PocketSphinx via lib/transcribe.py) → SRT →
 * burn TikTok-style captions into any finished video with ffmpeg.
 *
 * Every public function never throws: if the speech engine is missing, the
 * audio has no speech, or burning fails, the original video is kept untouched
 * and we simply report applied:false. Subtitles must never break a render.
 */
const fs = require("fs");
const path = require("path");
const { execFile, spawnSync } = require("child_process");

const PY = process.env.PYTHON || "python3";
const TRANSCRIBE_PY = path.join(__dirname, "transcribe.py");

// TikTok-style: white bold text, black outline, bottom-center, above the watermark strip.
const CAPTION_STYLE =
  "Fontname=DejaVu Sans,Fontsize=13,PrimaryColour=&H00FFFFFF," +
  "OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=120";

let engineCache = null;
function subtitlesAvailable() {
  if (engineCache !== null) return engineCache;
  try {
    const r = spawnSync(PY, ["-c", "import pocketsphinx"], { encoding: "utf8" });
    engineCache = r.status === 0;
  } catch {
    engineCache = false;
  }
  if (!engineCache) {
    console.warn("[subtitles] pocketsphinx not installed (pip install pocketsphinx) — subtitles skipped");
  }
  return engineCache;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout || 120000, maxBuffer: 1 << 22 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || "").slice(-400);
          return reject(new Error(tail || err.message));
        }
        resolve(String(stdout || ""));
      }
    );
  });
}

// ffmpeg filter syntax: escape \ ' and : inside the value
function escFilterPath(p) {
  return path.resolve(p).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

/** Transcribe media → SRT. Returns number of caption blocks (0 = no speech / failed). */
async function transcribeToSrt(mediaPath, srtPath) {
  if (!subtitlesAvailable()) return 0;
  try {
    const out = await run(PY, [TRANSCRIBE_PY, mediaPath, srtPath, "0"], { timeout: 30 * 60 * 1000 });
    const m = /srt-entries=(\d+)/.exec(out);
    const n = m ? parseInt(m[1], 10) : 0;
    if (n > 0 && fs.existsSync(srtPath) && fs.statSync(srtPath).size > 12) return n;
  } catch (e) {
    console.warn("[subtitles] transcribe failed:", e.message);
  }
  return 0;
}

/** Burn SRT into video, atomically replacing it. Returns true on success. */
async function burnSubtitles(videoPath, srtPath) {
  const tmpOut = videoPath + ".subbed.mp4";
  const vf = `subtitles='${escFilterPath(srtPath)}':force_style='${CAPTION_STYLE}'`;
  try {
    await run(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", videoPath,
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        tmpOut,
      ],
      { timeout: 20 * 60 * 1000 }
    );
    fs.renameSync(tmpOut, videoPath);
    return true;
  } catch (e) {
    console.warn("[subtitles] burn failed:", e.message);
    try { fs.unlinkSync(tmpOut); } catch {}
    return false;
  }
}

/**
 * Full pass: transcribe + burn captions into a rendered clip in place.
 * Keeps the .srt next to the video (downloadable captions file). Never throws.
 */
async function tryAddSubtitles(videoPath) {
  if (!subtitlesAvailable()) return { applied: false, reason: "engine-missing" };
  const srt = videoPath.replace(/\.mp4$/i, "") + ".subtitles.srt";
  const n = await transcribeToSrt(videoPath, srt);
  if (!n) {
    try { fs.unlinkSync(srt); } catch {}
    return { applied: false, reason: "no-speech-detected" };
  }
  const applied = await burnSubtitles(videoPath, srt);
  return applied ? { applied: true, captions: n } : { applied: false, reason: "burn-failed" };
}

module.exports = { subtitlesAvailable, tryAddSubtitles, transcribeToSrt, burnSubtitles };
