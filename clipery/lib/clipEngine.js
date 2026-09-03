const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const crypto = require("crypto");
const { prepareClipAss, transcribeToWords } = require("./subtitles");
const brain = require("./brain");
const story = require("./story");
const brains = require("./brain/index"); // the three brains: understand / score / edit
const { reframeFilter } = require("./reframe");

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, "..");
const UPLOADS = path.join(ROOT, "uploads");
const CLIPS_PUBLIC = path.join(ROOT, "public", "clips");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const LINKS_FILE = path.join(ROOT, "data", "link-rankings.json");

for (const d of [UPLOADS, CLIPS_PUBLIC, JOBS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
if (!fs.existsSync(LINKS_FILE)) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify({ boards: [] }, null, 2));
}

const MODES = {
  viral: {
    id: "viral",
    label: "Viral clips",
    description: "Short hook-first cuts optimized for TikTok / Reels / Shorts",
    targetMin: 30,
    targetMax: 50,
    ideal: 40,
    maxClips: 8,
    sceneThreshold: 0.2,
    captionStyle: "viral",
  },
  ranking: {
    id: "ranking",
    label: "Ranking analysis",
    description: "Score every moment with a full breakdown - post order ready",
    targetMin: 30,
    targetMax: 50,
    ideal: 40,
    maxClips: 10,
    sceneThreshold: 0.18,
    captionStyle: "rank",
  },
};

function run(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, {
    maxBuffer: 25 * 1024 * 1024,
    timeout: opts.timeout || 240000,
    ...opts,
  });
}

/* -------- face-follow crop: centre the 9:16 frame on the speaker -------- */
const PY = require("./python").PYTHON;
const FACE_PY = path.join(__dirname, "facedetect.py");

/**
 * Face track for a time window: where the speaker is, moment by moment.
 * Returns {x, track:[{t,x,faces}], speakers, spread} or null (centre crop).
 */
async function faceTrack(source, start, end, opts = {}) {
  if (String(process.env.CLIPERY_FACE_TRACKING || "").match(/^(0|off|false)$/i)) return null;
  const perSec = opts.perSec || 2.5;
  const timeout = opts.timeout || 120000;
  const t0 = Date.now();
  try {
    const { stdout } = await run(
      PY,
      [FACE_PY, source, String(start), String(end), String(perSec)],
      { timeout }
    );
    const r = JSON.parse(stdout.trim().split("\n").pop() || "{}");
    if (r && r.ok && Array.isArray(r.track) && r.track.length) {
      console.log(
        `[reframe] ${r.speakers || 1} speaker(s), spread ${((r.spread || 0) * 100).toFixed(0)}% of width, ` +
        `${r.faces}/${r.samples} samples with a face (${((Date.now() - t0) / 1000).toFixed(1)}s)`
      );
      return r;
    }
    if (r && r.ok) console.log("[reframe] no clear face -> centre crop");
    else if (r && r.reason === "no-faces") {
      console.log("[reframe] no faces -> centre crop");
      // Keep the motion readings: they still tell the scorer where the action is.
      if (Array.isArray(r.track) && r.track.length) return { ...r, x: null, speakers: 0, spread: 0 };
    } else if (r && r.reason === "no-cv2") console.warn("[reframe] off - run: pip install opencv-python-headless");
    else console.warn(`[reframe] detector problem: ${(r && r.error) || (r && r.reason) || "unknown"} -> centre crop`);
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (e.killed || /timed? ?out|ETIMEDOUT/i.test(e.message || "")) {
      console.warn(`[reframe] gave up after ${secs}s -> centre crop (set CLIPERY_FACE_TRACKING=0 to skip it)`);
    } else {
      console.warn(`[reframe] failed: ${e.message} -> centre crop`);
    }
  }
  return null;
}

/**
 * Keep the job file moving while a long step runs, so the progress bar does
 * not sit frozen and look crashed. Returns a stop() function.
 */
function heartbeat(job, writeJob, label, fromPct, toPct, expectedSec) {
  const started = Date.now();
  const tick = () => {
    const secs = (Date.now() - started) / 1000;
    const share = Math.min(0.95, secs / Math.max(5, expectedSec));
    job.progress = Math.round(fromPct + (toPct - fromPct) * share);
    job.stageNote = `${label} - ${Math.round(secs)}s`;
    try {
      writeJob(job);
    } catch (_) {}
  };
  tick();
  const timer = setInterval(tick, 3000);
  if (timer.unref) timer.unref();
  return () => {
    clearInterval(timer);
    job.stageNote = null;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[stage] ${label} finished in ${secs}s`);
  };
}

/** Old single-point helper, kept for callers that only need one X. */
async function faceCenterX(source, start, end) {
  const r = await faceTrack(source, start, end);
  return r && typeof r.x === "number" && r.x >= 0.05 && r.x <= 0.95 ? r.x : null;
}

async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=width,height,codec_type,codec_name",
    "-of",
    "json",
    file,
  ]);
  const data = JSON.parse(stdout);
  const duration = parseFloat(data.format?.duration || 0);
  const v = (data.streams || []).find((s) => s.codec_type === "video") || {};
  const a = (data.streams || []).find((s) => s.codec_type === "audio");
  return {
    duration,
    width: Number(v.width) || 1280,
    height: Number(v.height) || 720,
    hasAudio: !!a,
  };
}

async function detectScenes(file, duration, threshold) {
  try {
    const { stderr } = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-i",
        file,
        "-filter:v",
        `select='gt(scene,${threshold})',showinfo`,
        "-f",
        "null",
        "-",
      ],
      { timeout: 300000 }
    );
    return parseSceneTimes(String(stderr || ""), duration);
  } catch (e) {
    return parseSceneTimes(String(e.stderr || e.message || ""), duration);
  }
}

function parseSceneTimes(text, duration) {
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) times.push(parseFloat(m[1]));
  return times.filter((t) => t > 0.4 && t < duration - 0.4);
}

/** Sample mean volume per window via ffmpeg volumedetect on segments */
async function sampleEnergy(file, start, end) {
  try {
    const dur = Math.min(8, Math.max(1, end - start));
    const { stderr } = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-ss",
        String(start),
        "-t",
        String(dur),
        "-i",
        file,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { timeout: 60000 }
    );
    const text = String(stderr || "");
    const mean = /mean_volume:\s*([-\d.]+)/.exec(text);
    const max = /max_volume:\s*([-\d.]+)/.exec(text);
    const meanV = mean ? parseFloat(mean[1]) : -40;
    const maxV = max ? parseFloat(max[1]) : -20;
    // map dB (-60..0) -> 0..100
    const energy = Math.min(100, Math.max(0, ((meanV + 50) / 50) * 100));
    const punch = Math.min(100, Math.max(0, ((maxV + 30) / 30) * 100));
    return { energy: Math.round(energy), punch: Math.round(punch) };
  } catch {
    return { energy: 50, punch: 50 };
  }
}

/** How many moments we analyze per job (scales with length, capped for speed). */
const MAX_CANDIDATES = 24;

/**
 * Keep `limit` windows SPREAD OVER THE WHOLE TIMELINE instead of just taking
 * the first N. The timeline is split into `limit` buckets and we round-robin
 * through them, so round 1 already guarantees coverage from start to finish.
 */
function spreadSelect(list, duration, limit) {
  if (list.length <= limit) return list.slice();
  const bucketSize = Math.max(1, duration / limit);
  const buckets = new Map();
  for (const c of list) {
    const b = Math.min(limit - 1, Math.floor(c.start / bucketSize));
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(c);
  }
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (let b = 0; b < limit && out.length < limit; b++) {
      const arr = buckets.get(b);
      if (arr && arr[round]) {
        out.push(arr[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out.sort((a, b) => a.start - b.start);
}

function buildCandidates(duration, sceneTimes, mode) {
  const MIN = mode.targetMin;   // never shorter than this
  const MAX = mode.targetMax;   // soft cap ("can be more" lives up to here)
  const IDEAL = mode.ideal;     // the sweet spot
  const bounds = [0, ...sceneTimes.filter((t) => t > 0.5 && t < duration - 1), duration].sort((a, b) => a - b);
  const raw = [];

  // A window starting at every scene cut, grown to the ideal length
  // (clips may happily span several scene cuts)
  for (const start of bounds) {
    const end = Math.min(start + IDEAL, duration);
    if (end - start >= MIN) raw.push({ start, end });
  }

  // Sliding starts across the FULL duration. The step scales with the video so
  // a 20 min source is swept end-to-end, not just its first few minutes.
  const step = Math.min(45, Math.max(12, (duration - MIN) / MAX_CANDIDATES));
  for (let s = step; s + MIN <= duration; s += step) {
    raw.push({ start: +s.toFixed(2), end: Math.min(s + IDEAL, duration) });
  }

  // Always consider the tail of the video too (endings/payoffs live there)
  if (duration - MIN > 0) raw.push({ start: Math.max(0, duration - IDEAL), end: duration });

  // One longer variant ("can be more") from each scene start
  for (const start of bounds) {
    const end = Math.min(start + MAX, duration);
    if (end - start >= MIN) raw.push({ start, end });
  }

  // Short-video fallback: take as much as we can from the very top
  if (!raw.length && duration >= 8) raw.push({ start: 0, end: duration });

  // Viral mode: dedicated cold-open window
  if (mode.id === "viral" && duration >= MIN) {
    raw.unshift({ start: 0, end: Math.min(IDEAL, duration) });
  }

  raw.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  const deduped = [];
  for (const c of raw) {
    const start = Math.max(0, +c.start.toFixed(2));
    const end = Math.min(duration, +c.end.toFixed(2));
    if (end - start < MIN && end < duration) continue; // never ship under 30s
    if (deduped.some((o) => Math.abs(o.start - start) < 6 && Math.abs((o.end - o.start) - (end - start)) < 12)) continue;
    deduped.push({ start, end });
  }
  // Spread instead of truncating the head - this is what stopped every clip
  // from being taken out of the first minutes of the source.
  return spreadSelect(deduped, duration, MAX_CANDIDATES);
}

/**
 * Choose the final clips: best score first, but never overlapping and never
 * bunched together, so the set covers the whole video.
 */
function pickDiverse(scoredDesc, limit, duration) {
  const overlaps = (c, o) => c.start < o.end && o.start < c.end;
  const minGap = Math.min(120, Math.max(20, duration / Math.max(limit, 1)));
  const chosen = [];

  for (const c of scoredDesc) {
    if (chosen.length >= limit) break;
    if (chosen.some((o) => overlaps(c, o))) continue;
    if (chosen.some((o) => Math.abs(c.start - o.start) < minGap)) continue;
    chosen.push(c);
  }
  // Relax the spacing rule if the video is too short to fill the quota
  if (chosen.length < limit) {
    for (const c of scoredDesc) {
      if (chosen.length >= limit) break;
      if (chosen.includes(c)) continue;
      if (chosen.some((o) => overlaps(c, o))) continue;
      chosen.push(c);
    }
  }
  // Last resort (very short sources): allow a small overlap rather than
  // shipping near-duplicate cuts or too few clips.
  if (chosen.length < limit) {
    const overlapAmount = (c, o) => Math.max(0, Math.min(c.end, o.end) - Math.max(c.start, o.start));
    for (const c of scoredDesc) {
      if (chosen.length >= limit) break;
      if (chosen.includes(c)) continue;
      const worst = Math.max(0, ...chosen.map((o) => overlapAmount(c, o) / (c.end - c.start)));
      if (worst > 0.35) continue;
      chosen.push(c);
    }
  }
  return chosen.sort((a, b) => b.score - a.score);
}

function scoreDimensions(c, duration, energy, mode, index, stats) {
  const len = c.end - c.start;
  const mid = (c.start + c.end) / 2;
  const pos = mid / Math.max(duration, 1);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Length fit - testing mode: 30s minimum, ~40s sweet spot, max ~50s (PC-friendly)
  let length = 30;
  if (len >= 36 && len <= 44) length = 98;
  else if (len >= mode.targetMin && len <= mode.targetMax) length = 92;
  else if (len > mode.targetMax && len <= 60) length = 68;
  else if (len >= 20) length = 45;

  // Hook strength is driven by what the moment SOUNDS like (punch + energy
  // relative to the rest of the video), not by where it sits in the timeline.
  // Position only nudges it, so mid/late moments can win.
  const avgPunch = stats ? stats.avgPunch : 50;
  const avgEnergy = stats ? stats.avgEnergy : 50;
  let posBonus = 0;
  if (pos < 0.06) posBonus = 7;                                   // cold open
  else if (pos < 0.15) posBonus = mode.id === "viral" ? 4 : 3;
  else if (pos > 0.9) posBonus = mode.id === "ranking" ? 5 : 2;   // payoff/CTA
  const hook = Math.round(
    clamp(
      68 + (energy.punch - avgPunch) * 0.55 + (energy.energy - avgEnergy) * 0.3 + posBonus,
      40,
      99
    )
  );

  // Pacing / energy from audio, boosted when this moment stands out from the
  // video's own average (a loud beat in a calm video is what goes viral).
  const rel = (energy.energy - avgEnergy) * 0.5 + (energy.punch - avgPunch) * 0.5;
  const pacing = Math.round(
    clamp(energy.energy * 0.55 + energy.punch * 0.45 + clamp(rel * 0.6, -10, 14), 0, 100)
  );

  // Retention proxy
  let retention = Math.round(
    length * 0.4 + pacing * 0.4 + (100 - Math.min(80, Math.abs(len - mode.ideal) * 1.2)) * 0.2
  );
  retention = Math.min(99, Math.max(35, retention));

  // CTA fitness
  const cta = pos > 0.8 ? 90 : pos > 0.65 ? 70 : 45;

  // Replay / share potential
  const replay = Math.round(
    Math.min(99, pacing * 0.4 + hook * 0.35 + (len >= 30 && len <= 55 ? 90 : 55) * 0.25)
  );

  // AI viral prediction (weighted for "will this go viral?")
  let viralRaw;
  if (mode.id === "viral") {
    viralRaw =
      hook * 0.32 +
      pacing * 0.28 +
      length * 0.18 +
      retention * 0.14 +
      replay * 0.08;
  } else {
    viralRaw =
      hook * 0.22 +
      length * 0.18 +
      pacing * 0.2 +
      retention * 0.22 +
      cta * 0.1 +
      replay * 0.08;
  }
  const total = Math.min(99, Math.max(48, Math.round(viralRaw + ((index * 13) % 5) - 2)));

  const reasons = [];
  if (hook >= 90) reasons.push("Strong cold-open hook");
  else if (hook >= 80) reasons.push("Solid opening hook");
  if (pacing >= 80) reasons.push("High energy / audio punch");
  else if (pacing >= 65) reasons.push("Good pacing");
  if (length >= 90) reasons.push("Ideal short-form length");
  else if (length >= 75) reasons.push("Good clip length");
  if (retention >= 80) reasons.push("High retention signal");
  if (replay >= 80) reasons.push("Likely rewatch / share");
  if (pos < 0.12) reasons.push("Early in source (fresh context)");
  if (cta >= 80) reasons.push("Strong closer / CTA zone");
  if (!reasons.length) reasons.push("Balanced mid-video moment");

  let verdict = "Average potential";
  let verdictKey = "average";
  if (total >= 90) {
    verdict = "Likely to go viral";
    verdictKey = "viral";
  } else if (total >= 82) {
    verdict = "Strong viral chance";
    verdictKey = "strong";
  } else if (total >= 72) {
    verdict = "Good to post";
    verdictKey = "good";
  } else if (total >= 60) {
    verdict = "Okay / test it";
    verdictKey = "okay";
  } else {
    verdict = "Low priority";
    verdictKey = "low";
  }

  return {
    total,
    viralScore: total,
    verdict,
    verdictKey,
    reasons: reasons.slice(0, 4),
    hook: Math.round(hook),
    length: Math.round(length),
    pacing: Math.round(pacing),
    retention: Math.round(retention),
    cta: Math.round(cta),
    replay: Math.round(replay),
    energy: energy.energy,
    punch: energy.punch,
  };
}

function titleForClip(c, duration, dims, mode, rank) {
  const pos = (c.start + c.end) / 2 / Math.max(duration, 1);
  if (dims.verdictKey === "viral") return "Viral pick";
  if (dims.verdictKey === "strong") return "High-potential cut";
  if (mode.id === "viral") {
    if (pos < 0.15) return "Cold-open hook";
    if (dims.pacing > 75) return "High-energy cut";
    if (pos > 0.85) return "Closer punch";
    if (dims.hook > 85) return "Scroll-stop moment";
    return "Viral angle";
  }
  if (pos < 0.15) return "Opening ranked beat";
  if (pos > 0.85) return "CTA / payoff rank";
  if (dims.retention > 80) return "Retention peak";
  if (dims.hook > 85) return "Strong hook segment";
  return "Ranked insight";
}

function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "%%");
}

// One switch for old or low-power machines: CLIPERY_FAST=1 picks the quick
// end of every trade-off (tiny speech model, fastest encoder preset).
const FAST_MODE = process.env.CLIPERY_FAST === "1";
if (FAST_MODE && !process.env.CLIPERY_WHISPER_MODEL) {
  process.env.CLIPERY_WHISPER_MODEL = "tiny";
}

// Encoder speed knobs for slow machines. "ultrafast" roughly halves encode
// time again at the cost of a bigger file; "veryfast" is the balanced default.
// A killed ffmpeg leaves a half-written mp4 that no browser can play, so the
// per-clip encode budget scales with the clip: 20x its length, floor 5 min.
// An old laptop burning captions into a 60s clip needs far more than the
// fixed 200s this used to allow.
/**
 * Is this file actually playable? A truncated mp4 (ffmpeg killed, disk full)
 * still exists on disk and still ends in .mp4, but has no readable video
 * stream -- which is what makes a browser say it found no supported format.
 */
async function verifyClip(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 10 * 1024) return false;
    const { stdout } = await run(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_type,nb_frames:format=duration",
        "-of", "json",
        file,
      ],
      { timeout: 30000 }
    );
    const info = JSON.parse(stdout || "{}");
    const stream = (info.streams || [])[0];
    if (!stream || stream.codec_type !== "video") return false;
    const seconds = parseFloat((info.format && info.format.duration) || 0);
    return seconds > 0.4;
  } catch {
    return false;
  }
}

function ENCODE_TIMEOUT_MS(dur) {
  const env = Number(process.env.CLIPERY_ENCODE_TIMEOUT);
  if (env > 0) return env * 1000;
  return Math.max(5 * 60 * 1000, Math.round((Number(dur) || 60) * 20 * 1000));
}

// Brain 3 editor moves. Each can be switched off in .env:
//   CLIPERY_PUNCH_IN=0   no zoom on the key line
//   CLIPERY_TRIM=0       keep dead air inside clips
//   CLIPERY_EMPHASIS=0   plain captions, no bold key words
const offFlag = (k) => /^(0|off|false)$/i.test(String(process.env[k] || ""));
const ENCODE_PRESET = process.env.CLIPERY_PRESET || (FAST_MODE ? "ultrafast" : "veryfast");
const ENCODE_CRF = String(process.env.CLIPERY_CRF || (FAST_MODE ? 26 : 24));

async function renderClip(source, outFile, start, end, label, sublabel, mode, srcMeta, subOpts) {
  const dur = Math.max(0.5, end - start);
  const targetW = 608;
  const targetH = 1080;

  // Smart reframing: follow the speaker instead of cropping dead centre.
  // Track times come back relative to the clip start, which is exactly what
  // the crop expression needs (ffmpeg `t` restarts at 0 for the cut).
  // The editor can pin the framing per clip: "follow" | "static" | "wide" | "center".
  const forced = subOpts && subOpts.layout && ["follow", "static", "wide", "center"].includes(subOpts.layout) ? subOpts.layout : null;
  const det = forced === "wide" || forced === "center" ? null : await faceTrack(source, start, end);
  const rf = reframeFilter({
    samples: (det && det.track) || [],
    srcW: (srcMeta && srcMeta.width) || 1920,
    srcH: (srcMeta && srcMeta.height) || 1080,
    outW: targetW,
    outH: targetH,
    force: forced,
  });
  console.log(`[reframe] clip @${start.toFixed(1)}s -> ${rf.layout} (${rf.keys.length} camera moves)${forced ? " [chosen by you]" : ""}`);

  const extras = [
    `drawbox=x=0:y=ih-100:w=iw:h=100:color=black@0.45:t=fill`,
    `drawtext=text='Clipery ${mode.id === "viral" ? "viral" : "ranked"}':fontsize=20:fontcolor=white@0.9:x=(w-text_w)/2:y=h-58:font=Sans`,
  ];

  // Captions are prepared from the source audio BEFORE the encode so they can
  // ride along in this same filter chain. Two encodes per clip became one.
  const editPlan = (subOpts && subOpts.edit) || null;
  const EDIT_PUNCH_IN = !offFlag("CLIPERY_PUNCH_IN");
  const EDIT_TRIM = !offFlag("CLIPERY_TRIM");
  const EDIT_EMPHASIS = !offFlag("CLIPERY_EMPHASIS");
  let sub = null;
  if (subOpts) {
    try {
      sub = await prepareClipAss(source, start, dur, outFile, {
        ...subOpts,
        emphasis: EDIT_EMPHASIS && editPlan ? editPlan.emphasis : null,
      });
    } catch (e) {
      console.warn("[subtitles] prepare failed:", e.message);
    }
  }

  // ---- Brain 3 editor moves ------------------------------------------
  // They need the clip's own word timings, which the caption pass just made.
  const clipWords = (sub && sub.words) || null;
  const edits = { punchIn: null, trimmed: 0, emphasis: 0 };
  const editV = [];   // video filters, after the 9:16 crop
  let editA = null;   // audio filter (only for trims)

  // Dead air: drop long pauses inside the clip, keep the speech breathing.
  // Captions are re-timed to match, so the words still land on the voice.
  let trimmedWords = clipWords;
  if (EDIT_TRIM && clipWords && clipWords.length && srcMeta && srcMeta.hasAudio !== false) {
    const gaps = brains.edit.deadAir(clipWords, 0, dur, 1.6);
    const tp = brains.edit.trimPlan(gaps, dur);
    if (tp.cuts.length) {
      const tf = brains.edit.trimFilters(tp.cuts);
      editV.push(tf.video);
      editA = tf.audio;
      edits.trimmed = tp.removed;
      trimmedWords = brains.edit.shiftWords(clipWords, tp.cuts);
      // Rebuild the captions on the new clock.
      if (sub && sub.assPath && subOpts) {
        try {
          const again = await prepareClipAss(source, start, dur, outFile, {
            ...subOpts,
            emphasis: EDIT_EMPHASIS && editPlan ? editPlan.emphasis : null,
            wordsOverride: trimmedWords,
          });
          if (again) sub = again;
        } catch (_) {}
      }
    }
  }

  // Punch-in: a gentle 8% zoom while the line the clip is built around is
  // spoken. Works for every layout because it sits after the crop/scale.
  if (EDIT_PUNCH_IN && editPlan && editPlan.anchor && trimmedWords && rf.layout !== "wide") {
    const where = brains.edit.locateLine(trimmedWords, editPlan.anchor, dur - edits.trimmed);
    if (where && where.to - where.from >= 1 && where.to - where.from <= 12) {
      editV.push(brains.edit.punchInFilter(where.from, where.to, targetW, targetH));
      edits.punchIn = where;
    }
  }
  if (EDIT_EMPHASIS && editPlan && editPlan.emphasis) edits.emphasis = editPlan.emphasis.length;
  if (edits.trimmed || edits.punchIn) {
    console.log(
      `[edit] clip @${start.toFixed(1)}s:` +
        (edits.trimmed ? ` trimmed ${edits.trimmed}s of dead air` : "") +
        (edits.punchIn ? ` punch-in ${edits.punchIn.from}-${edits.punchIn.to}s` : "")
    );
  }

  const subFilter = sub ? [sub.filter] : [];

  // The zoom-out layout needs split/overlay, so it must go through
  // -filter_complex; the simple crop chains stay on -vf exactly as before.
  // Trims must run on the audio too, so they force the complex graph.
  const vChain = [rf.filter, ...editV, ...extras, ...subFilter].join(",");
  const useComplex = rf.filter.includes("split=") || !!editA;
  const graph = useComplex && editA ? `[0:v]${vChain}[v];[0:a]${editA}[a]` : vChain;
  const flag = useComplex ? "-filter_complex" : "-vf";
  const mapArgs = useComplex && editA ? ["-map", "[v]", "-map", "[a]"] : [];

  const encode = (filterFlag, filterGraph, maps) =>
    run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(start),
        "-i",
        source,
        "-t",
        String(dur),
        filterFlag,
        filterGraph,
        ...(maps || []),
        "-c:v",
        "libx264",
        "-preset",
        ENCODE_PRESET,
        "-crf",
        ENCODE_CRF,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        outFile,
      ],
      { timeout: ENCODE_TIMEOUT_MS(dur) }
    );

  const dropAss = () => {
    if (sub && sub.assPath) {
      try { fs.unlinkSync(sub.assPath); } catch {}
    }
  };

  const result = (layout) => ({
    layout,
    subtitlesApplied: !!(sub && sub.subtitlesApplied),
    hookApplied: !!(sub && sub.hookApplied),
    hookText: sub ? sub.hookText : null,
    edits,
  });

  try {
    await encode(flag, graph, mapArgs);
  } catch (e) {
    // Never fail a clip over a fancy filter: fall back to the plain,
    // never-zoomed centre crop that every ffmpeg build can do.
    console.warn(`[reframe] ${rf.layout} layout failed (${e.message.split("\n")[0]}) -> centre crop`);
    const cropW = Math.min(
      (srcMeta && srcMeta.width) || 1920,
      Math.round((((srcMeta && srcMeta.height) || 1080) * targetW) / targetH)
    );
    const plain = [`crop=${cropW}:ih:x=(iw-${cropW})/2:y=0`, `scale=${targetW}:${targetH}`, ...extras];
    try {
      await encode("-vf", [...plain, ...subFilter].join(","));
    } catch (e2) {
      // Last resort: no captions rather than no clip.
      console.warn(`[subtitles] burn-in failed (${e2.message.split("\n")[0]}) -> plain clip`);
      await encode("-vf", plain.join(","));
      dropAss();
      sub = null;
    }
    dropAss();
    return result("center");
  }

  dropAss();

  // Prove it plays before we hand it to the browser. A rescue pass uses
  // accurate seeking and the simplest possible chain: a watchable clip beats
  // a clever one.
  if (!(await verifyClip(outFile))) {
    console.warn(`[render] clip @${start.toFixed(1)}s came out unplayable -> re-cutting it simply`);
    const cropW = Math.min(
      (srcMeta && srcMeta.width) || 1920,
      Math.round((((srcMeta && srcMeta.height) || 1080) * targetW) / targetH)
    );
    try {
      await run(
        "ffmpeg",
        [
          "-y", "-hide_banner", "-loglevel", "error",
          "-i", source,
          "-ss", String(start),
          "-t", String(dur),
          "-vf", `crop=${cropW}:ih:x=(iw-${cropW})/2:y=0,scale=${targetW}:${targetH}`,
          "-c:v", "libx264", "-preset", ENCODE_PRESET, "-crf", ENCODE_CRF,
          "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart",
          outFile,
        ],
        { timeout: ENCODE_TIMEOUT_MS(dur) }
      );
    } catch (e) {
      console.warn(`[render] rescue cut failed: ${e.message.split("\n")[0]}`);
    }
    if (!(await verifyClip(outFile))) {
      try { fs.unlinkSync(outFile); } catch {}
      return { layout: "failed", broken: true, subtitlesApplied: false, hookApplied: false, hookText: null };
    }
    return { layout: "center", subtitlesApplied: false, hookApplied: false, hookText: null };
  }

  return result(rf.layout);
}

/** Clips per source video for this account (plan limit, capped by the mode). */
function clipBudgetFor(mode, options) {
  return Math.max(1, Math.min(mode.maxClips, Number(options && options.maxClips) || mode.maxClips));
}

/** "kept the setup" -> "Kept the setup" */
function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

function jobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

function readJob(id) {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJob(job) {
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

/**
 * Jobs on disk, newest first.
 * Pass a userId to get only that account's jobs - a library is private, so
 * everything without a matching owner is filtered out.
 */
function listJobs(limit = 50, userId) {
  if (!fs.existsSync(JOBS_DIR)) return [];
  const files = fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((j) => (userId ? j.userId === userId : true))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return files.slice(0, limit);
}

/**
 * Find silence gaps with ffmpeg silencedetect: [{start,end}] (end may be Infinity).
 * Used so clips start/stop at pauses instead of chopping somebody mid-sentence.
 */
async function detectSilences(sourcePath) {
  let stderr = "";
  try {
    const res = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-i", sourcePath, "-af", "silencedetect=n=-30dB:d=0.35", "-f", "null", "-"],
      { encoding: "utf8", maxBuffer: 1 << 22 }
    );
    stderr = String(res.stderr || "");
  } catch (e) {
    stderr = String((e && e.stderr) || "");
  }
  const sils = [];
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)];
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)];
  for (let i = 0; i < starts.length; i++) {
    sils.push({ start: parseFloat(starts[i][1]), end: ends[i] ? parseFloat(ends[i][1]) : Infinity });
  }
  return sils;
}

// Cut-point snapping now lives in Brain 3: lib/brain/edit.js (snapToSilence).

/**
 * Fold the three-brain reading into the audio-only `dims` the engine already
 * carries. Keeps the old field names (viralScore, verdict, reasons, quote) so
 * the studio, rankings and titles keep working, and adds the new ones:
 *   dims.scores   - the eight Brain 2 dimensions (hook, curiosity, ...)
 *   dims.brain    - Brain 1's reading (topic, story, conflict, ...)
 *   dims.summary  - one plain-English line about the moment
 */
function applyThought(dims, thought, hasWords, baseTotal) {
  if (!thought) return dims;
  const base = baseTotal != null ? baseTotal : dims.total;
  dims.scores = thought.scores;
  dims.brain = thought.understanding;
  dims.summary = thought.summary;
  dims.topic = thought.topic;
  dims.quote = thought.quote || dims.quote || null;
  dims.wpm = thought.wpm;
  if (thought.motion != null) dims.motion = thought.motion;
  dims.hook = Math.round(dims.hook * 0.35 + thought.scores.hook * 0.65);
  dims.complete = thought.understanding ? thought.understanding.missing.length === 0 : undefined;
  dims.missing = thought.understanding ? thought.understanding.missing : [];
  dims.arc = thought.scores.completion;
  // With a transcript the brains outweigh raw loudness; without one they
  // only have visuals to go on, so loudness keeps most of its say.
  const blended = hasWords && thought.understanding
    ? base * 0.3 + thought.total * 0.7
    : base * 0.6 + thought.total * 0.4;
  dims.total = Math.min(99, Math.max(30, Math.round(blended)));
  dims.viralScore = dims.total;
  const vk = brains.verdictFor(dims.total);
  dims.verdict = vk.text;
  dims.verdictKey = vk.key;
  dims.reasons = [...new Set([...thought.reasons, ...(dims.reasons || [])])].slice(0, 4);
  return dims;
}

async function processVideo(sourcePath, options = {}) {
  const mode = MODES[options.mode] || MODES.viral;
  // Hook title and subtitles never run together: subtitles win.
  if (options.subtitles && options.hook) options = { ...options, hook: false };
  const id = options.jobId || crypto.randomBytes(6).toString("hex");
  const outDir = path.join(CLIPS_PUBLIC, id);
  fs.mkdirSync(outDir, { recursive: true });

  const job = {
    id,
    // keep the owner stamped by the seed so the job stays in ONE library
    userId: options.userId || (readJob(id) || {}).userId || null,
    status: "processing",
    stage: "probing",
    progress: 4,
    mode: mode.id,
    modeLabel: mode.label,
    createdAt: new Date().toISOString(),
    sourceName: options.sourceName || path.basename(sourcePath),
    subtitles: !!options.subtitles,
    hook: !!options.hook,
    hookMode: options.hookMode || "intro",
    clips: [],
    rankings: [],
    error: null,
  };
  writeJob(job);

  try {
    const meta = await probe(sourcePath);
    if (!meta.duration || meta.duration < 8) {
      throw new Error("Video is too short. Use at least ~15 seconds.");
    }
    // Length cap comes from the account's plan (Free is 20 minutes).
    const maxMinutes = Number(options.maxMinutes) || 20;
    if (meta.duration > maxMinutes * 60) {
      const mins = Math.ceil(meta.duration / 60);
      throw new Error(
        `Your ${options.planLabel || "current"} plan allows videos up to ${maxMinutes} minutes - this one is ${mins} minutes. Trim it or upgrade your plan.`
      );
    }

    job.duration = +meta.duration.toFixed(2);
    job.stage = "detecting_moments";
    job.progress = 15;
    writeJob(job);

    const scenes = await detectScenes(sourcePath, meta.duration, mode.sceneThreshold);
    const candidates = buildCandidates(meta.duration, scenes, mode);
    job.candidateCount = candidates.length;
    job.sceneCount = scenes.length;
    job.stage = "scoring";
    job.progress = 28;
    writeJob(job);

    // Transcribe the source ONCE. The brain reads these words to judge what is
    // actually being said - story, payoff, surprise, hook strength - instead of
    // guessing from loudness alone. Trend keywords reuse the same transcript.
    let videoWords = null;
    const brainOff = String(process.env.CLIPERY_BRAIN || "").match(/^(0|off|false)$/i);
    if (meta.hasAudio && !brainOff) {
      job.stage = "listening";
      writeJob(job);
      // Transcribing runs at roughly 3-8x real time on a CPU, so a 10 minute
      // video is a couple of minutes with nothing to show. Tick the progress
      // bar and say how long it has been going.
      const stop = heartbeat(job, writeJob, "Listening to the audio", 28, 40, meta.duration / 4);
      console.log(`[brain] transcribing ${(meta.duration / 60).toFixed(1)} min of audio...`);
      const tmpWords = path.join(JOBS_DIR, `${id}.words.json`);
      try {
        const n = await transcribeToWords(sourcePath, tmpWords);
        if (n > 0) videoWords = JSON.parse(fs.readFileSync(tmpWords, "utf8")).words || null;
      } catch (e) {
        console.warn(`[brain] transcript failed: ${e.message}`);
      }
      stop();
      try { fs.unlinkSync(tmpWords); } catch {}
      job.transcribed = !!(videoWords && videoWords.length);
      if (job.transcribed) {
        console.log(`[brain] ${videoWords.length} words - hook, story and payoff scoring is ON`);
      } else {
        job.brainNote = "no transcript - scored on audio and visuals only";
        console.warn("[brain] no transcript (install faster-whisper) - falling back to audio scoring");
      }
      job.progress = 40;
      writeJob(job);
    }
    const trendSet =
      videoWords && Array.isArray(options.trends) && options.trends.length
        ? new Set(options.trends)
        : null;

    // Cheap visual pass: how many faces are on screen across the video, so the
    // scorer can spot reactions and people entering or leaving the frame.
    // Cheap visual pass: how many faces are on screen across the video, so the
    // scorer can spot reactions and people entering or leaving the frame.
    // Deliberately coarse - one look every 3 seconds, capped at 90 seconds of
    // work. It is a scoring hint, not the reframing (that runs per clip).
    let visualTrack = null;
    if (!brainOff) {
      job.stage = "watching";
      const stopWatch = heartbeat(job, writeJob, "Watching the picture", 40, 46, 30);
      const det = await faceTrack(sourcePath, 0, Math.min(meta.duration, 20 * 60), {
        perSec: 0.33,
        timeout: 90000,
      });
      stopWatch();
      visualTrack = (det && det.track) || null;
      job.progress = 46;
      writeJob(job);
    }

    const scored = [];
    // Pass 1 - measure every candidate so we know what "loud" means for THIS video
    const energies = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      energies.push(
        meta.hasAudio ? await sampleEnergy(sourcePath, c.start, c.end) : { energy: 55, punch: 55 }
      );
      job.progress = 46 + Math.round(((i + 1) / candidates.length) * 3);
      writeJob(job);
    }
    const stats = {
      avgEnergy: energies.reduce((a, e) => a + e.energy, 0) / (energies.length || 1),
      avgPunch: energies.reduce((a, e) => a + e.punch, 0) / (energies.length || 1),
    };

    // Pass 2 - score each moment against the video's own baseline
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const energy = energies[i];

      // Start the clip on a clean sentence, preferring the strongest opening
      // line nearby - no more clips that begin mid-word.
      if (videoWords) {
        const snapped = brain.snapToSentence(videoWords, c.start, c.end);
        if (snapped !== c.start && c.end - snapped >= mode.targetMin * 0.9) c.start = snapped;
      }

      const dims = scoreDimensions(c, meta.duration, energy, mode, i, stats);

      // Brain 1 reads the moment, Brain 2 scores it on eight dimensions.
      const thought = brains.think({
        words: videoWords,
        start: c.start,
        end: c.end,
        energy,
        stats,
        sceneTimes: scenes,
        faceTrack: visualTrack,
        mode,
      });
      applyThought(dims, thought, !!videoWords);
      if (trendSet) {
        let hits = 0;
        for (const w of videoWords) {
          if (w.s >= c.end) break;
          if (w.s >= c.start && trendSet.has(String(w.w).toLowerCase().replace(/[^a-z0-9']+/g, ""))) hits++;
        }
        dims.keywords = hits; // how many trend words this moment actually contains
        if (hits) dims.total = Math.min(99, dims.total + Math.min(12, hits * 4));
      }
      scored.push({
        ...c,
        score: dims.total,
        dimensions: dims,
        title: titleForClip(c, meta.duration, dims, mode, i),
      });
      job.progress = 49 + Math.round(((i + 1) / candidates.length) * 3);
      writeJob(job);
    }

    scored.sort((a, b) => b.score - a.score);

    // ---- Context pass -------------------------------------------------
    // Take the strongest candidates and work out their REAL edges: walk back
    // far enough that the viewer understands why the moment matters, and run
    // on far enough that the payoff actually lands. Then re-score, because a
    // clip that now tells a whole story deserves a better number than the
    // fragment we started with.
    if (videoWords) {
      job.stage = "checking_context";
      writeJob(job);
      const shortlist = scored.slice(0, Math.max(10, clipBudgetFor(mode, options) * 3));
      for (const c of shortlist) {
        const arc = story.findArc(videoWords, c.start, c.end, {
          min: mode.targetMin,
          max: mode.targetMax,
          duration: meta.duration,
        });
        if (!arc || arc.end - arc.start < mode.targetMin * 0.85) continue;

        const before = c.dimensions.arc || 0;
        const after = story.arcScore(videoWords, arc.start, arc.end);
        if (after.score + 2 < before) continue; // the trim made it worse, keep the original

        c.start = arc.start;
        c.end = arc.end;
        c.dimensions.anchor = arc.anchor ? arc.anchor.text : null;
        // Re-think the trimmed window: a whole story deserves a better number
        // than the fragment we started with.
        const audioOnly = scoreDimensions(c, meta.duration, { energy: stats.avgEnergy, punch: stats.avgPunch }, mode, 0, stats);
        const thought = brains.think({
          words: videoWords,
          start: arc.start,
          end: arc.end,
          energy: { energy: stats.avgEnergy, punch: stats.avgPunch },
          stats,
          sceneTimes: scenes,
          faceTrack: visualTrack,
          mode,
        });
        applyThought(c.dimensions, thought, true, audioOnly.total);
        c.score = c.dimensions.total;
        if (arc.reasons.length) {
          c.dimensions.reasons = [...arc.reasons.map(cap), ...(c.dimensions.reasons || [])].slice(0, 4);
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }

    // The clips we will actually ship (score-ranked, non-overlapping, spread
    // across the whole source) - also used for the post-order preview.
    // How many clips this account gets out of one source video
    const clipBudget = clipBudgetFor(mode, options);
    const previewTop = pickDiverse(scored, Math.min(clipBudget, scored.length), meta.duration);

    // Full viral leaderboard (all analyzed moments)
    job.rankings = scored.map((c, i) => ({
      rank: i + 1,
      score: c.score,
      viralScore: c.dimensions.viralScore || c.score,
      verdict: c.dimensions.verdict,
      verdictKey: c.dimensions.verdictKey,
      reasons: c.dimensions.reasons || [],
      quote: c.dimensions.quote || null,
      title: c.title,
      start: c.start,
      end: c.end,
      duration: +(c.end - c.start).toFixed(2),
      dimensions: c.dimensions,
    }));

    job.viralAnalysis = {
      analyzed: scored.length,
      topViralScore: scored[0]?.score || 0,
      likelyViral: scored.filter((c) => (c.dimensions.viralScore || c.score) >= 82).length,
      postOrder: previewTop.map((c, i) => ({
        rank: i + 1,
        title: c.title,
        viralScore: c.score,
        verdict: c.dimensions.verdict,
      })),
      summary:
        scored[0] && scored[0].score >= 82
          ? `AI found ${scored.filter((c) => c.score >= 82).length} high-viral clip(s). Post #1 first (score ${scored[0].score}).`
          : `AI analyzed ${scored.length} moments. Best clip scored ${scored[0]?.score || 0} - still worth testing.`,
    };

    const topN = Math.min(clipBudget, scored.length);
    // Best scores first, but non-overlapping and spread across the source so
    // the clip set represents the whole video instead of its opening minutes.
    const top = previewTop;

    // Speech-aware cutting: nudge cut points to natural pauses so nobody
    // gets chopped mid-sentence. Falls back silently to original cuts.
    try {
      const silences = await detectSilences(sourcePath);
      if (silences.length) {
        const seen = new Set();
        for (const c of top) {
          const snapped = brains.edit.snapToSilence(silences, c.start, c.end, meta.duration);
          const key = `${snapped.start}-${snapped.end}`;
          if ((snapped.start !== c.start || snapped.end !== c.end) && seen.has(key)) continue;
          seen.add(key);
          c.start = snapped.start;
          c.end = snapped.end;
          c.speechSnapped = true;
        }
      }
    } catch (_) {}

    // Brain 3: the edit plan for each clip (caption emphasis, trimmable dead
    // air, the anchor line). Pure text work, shown in the studio.
    for (const c of top) {
      try {
        c.edit = brains.edit.plan({
          words: videoWords,
          start: c.start,
          end: c.end,
          duration: meta.duration,
          mode,
          captions: !!options.subtitles,
        });
        // Edges were already decided above; keep them, take the rest.
        c.edit.start = c.start;
        c.edit.end = c.end;
        c.edit.duration = +(c.end - c.start).toFixed(2);
      } catch (_) {
        c.edit = null;
      }
    }

    // ---- Editor: stop here and let the user review the plan -------------
    // Nothing heavy has run for these clips yet (rendering is the expensive
    // part), so the review costs nothing and saves every clip they drop.
    if (options.review) {
      job.status = "review";
      job.stage = "review";
      job.progress = 50;
      job.review = {
        sourcePath,
        meta: { width: meta.width, height: meta.height, duration: meta.duration, hasAudio: meta.hasAudio },
        words: videoWords || null,
        options: {
          subtitles: !!options.subtitles,
          subStyle: options.subStyle || null,
          hook: !!options.hook,
          hookMode: options.hookMode || "intro",
          trends: options.trends || [],
          maxClips: clipBudget,
        },
      };
      job.plan = top.map((c, i) => planEntry({ ...c, captions: !!options.subtitles }, i));
      writeJob(job);
      return job;
    }

    await renderPlan(job, sourcePath, meta, mode, top, options, outDir);
    return job;
  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
    job.progress = 0;
    writeJob(job);
    throw err;
  }
}

/** One reviewable clip, as the editor page shows it. */
function planEntry(c, i) {
  const d = c.dimensions || {};
  return {
    id: c.planId || crypto.randomBytes(3).toString("hex"),
    order: i + 1,
    start: +Number(c.start).toFixed(2),
    end: +Number(c.end).toFixed(2),
    duration: +(c.end - c.start).toFixed(2),
    title: c.title || `Clip ${i + 1}`,
    score: c.score,
    viralScore: d.viralScore || c.score,
    verdict: d.verdict || null,
    verdictKey: d.verdictKey || null,
    reasons: d.reasons || [],
    quote: d.quote || null,
    scores: d.scores || null,
    summary: d.summary || null,
    edit: c.edit || null,
    layout: c.layout || "auto",        // auto | follow | static | wide | center
    captions: c.captions != null ? c.captions : true,
    subStyle: c.subStyle || null,       // per-clip caption look (null = job default)
    source: c.source || "ai",           // ai | user
  };
}

/**
 * Render a list of planned clips. Shared by the one-click flow and the
 * editor's "Render N clips" button.
 */
async function renderPlan(job, sourcePath, meta, mode, top, options, outDir) {
    job.status = "processing";
    job.stage = "rendering";
    job.progress = 52;
    writeJob(job);
    const id = job.id;

    const clips = [];
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      c.dimensions = c.dimensions || {};
      const filename = `clip-${i + 1}.mp4`;
      const outFile = path.join(outDir, filename);
      const vScore = c.dimensions.viralScore || c.score || 0;
      const label = `#${i + 1} VIRAL ${vScore}`;
      const sub = `${c.dimensions.verdict || c.title}`.slice(0, 42);
      const clipCaptions = c.captions != null ? !!c.captions : !!options.subtitles;
      const clipHook = !clipCaptions && !!options.hook;
      const wantExtras = clipCaptions || clipHook || (c.layout && c.layout !== "auto");
      const rendered = await renderClip(
        sourcePath,
        outFile,
        c.start,
        c.end,
        label,
        sub,
        mode,
        meta,
        wantExtras
          ? {
              clipDur: +(c.end - c.start).toFixed(2),
              subStyle: clipCaptions ? c.subStyle || options.subStyle : null,
              hook: clipHook ? { enabled: true, mode: options.hookMode } : null,
              trends: options.trends,
              edit: c.edit || null,
              layout: c.layout && c.layout !== "auto" ? c.layout : null,
            }
          : null
      );
      if (c.edit && rendered.edits) {
        c.edit.applied = rendered.edits;
        if (rendered.edits.trimmed) c.edit.trimmed = rendered.edits.trimmed;
        if (rendered.edits.punchIn) c.edit.punchIn = rendered.edits.punchIn;
      }
      if (rendered.broken) {
        console.warn(`[render] clip ${i + 1} could not be produced - leaving it out`);
        job.renderNote = "one clip could not be rendered and was left out";
        continue;
      }
      const layout = rendered.layout;
      if (wantExtras) {
        if (rendered.subtitlesApplied) job.subtitlesApplied = true;
        if (rendered.hookApplied) {
          job.hookApplied = true;
          if (rendered.hookText && !job.hookText) job.hookText = rendered.hookText;
        }
        if (!rendered.subtitlesApplied && !rendered.hookApplied) {
          job.subtitlesNote = "captions skipped (no speech detected)";
        }
      }
      clips.push({
        rank: clips.length + 1,
        reframe: layout,
        score: c.score,
        viralScore: vScore,
        verdict: c.dimensions.verdict,
        verdictKey: c.dimensions.verdictKey,
        reasons: c.dimensions.reasons || [],
        quote: c.dimensions.quote || null,
        title: c.title || `Clip ${i + 1}`,
        start: c.start,
        end: c.end,
        duration: +(c.end - c.start).toFixed(2),
        dimensions: c.dimensions,
        scores: c.dimensions.scores || null,
        summary: c.dimensions.summary || null,
        edit: c.edit || null,
        url: `/clips/${id}/${filename}`,
        downloadName: `viral-${vScore}-rank${i + 1}-${id}.mp4`,
        postTip:
          i === 0
            ? "Post this first - highest viral chance"
            : i < 3
              ? "Strong follow-up post"
              : "Schedule later / A-B test",
      });
      job.progress = 52 + Math.round(((i + 1) / top.length) * 45);
      job.clips = clips;
      writeJob(job);
    }

    job.status = "done";
    job.stage = "complete";
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    job.clips = clips;
    delete job.review; // the source path and transcript are not needed any more
    writeJob(job);
    return job;
}

/**
 * Editor: render the clips the user approved for a job that is in review.
 * `approved` is the (edited) plan from the page: [{id,start,end,layout,captions,subStyle,title}].
 */
async function renderReviewed(jobId, approved) {
  const job = readJob(jobId);
  if (!job || job.status !== "review" || !job.review) throw new Error("This job is not waiting for review.");
  const rv = job.review;
  if (!fs.existsSync(rv.sourcePath)) throw new Error("The source video has been cleaned up. Upload it again.");
  const mode = MODES[job.mode] || MODES.viral;
  const meta = rv.meta;
  const options = { ...rv.options, jobId };
  const outDir = path.join(CLIPS_PUBLIC, jobId);
  fs.mkdirSync(outDir, { recursive: true });

  const byId = new Map((job.plan || []).map((p) => [p.id, p]));
  const top = [];
  const maxClips = Math.max(1, Number(rv.options.maxClips) || 10);
  for (const a of approved || []) {
    const base = byId.get(a.id) || {};
    let start = Number(a.start != null ? a.start : base.start);
    let end = Number(a.end != null ? a.end : base.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(start, meta.duration - 1));
    end = Math.max(start + 3, Math.min(end, meta.duration));
    if (end - start > 180) end = start + 180;
    const moved = Math.abs(start - (base.start || 0)) > 0.05 || Math.abs(end - (base.end || 0)) > 0.05;
    const c = {
      planId: a.id || base.id,
      start: +start.toFixed(2),
      end: +end.toFixed(2),
      title: String(a.title || base.title || `Clip ${top.length + 1}`).slice(0, 80),
      score: base.score || 0,
      dimensions: base.scores ? { scores: base.scores, viralScore: base.viralScore, verdict: base.verdict, verdictKey: base.verdictKey, reasons: base.reasons, quote: base.quote, summary: base.summary } : {},
      layout: ["auto", "follow", "static", "wide", "center"].includes(a.layout) ? a.layout : base.layout || "auto",
      captions: a.captions != null ? !!a.captions : base.captions != null ? base.captions : !!rv.options.subtitles,
      subStyle: a.subStyle ? normalizeSubStyleSafe(a.subStyle) : base.subStyle || null,
      edit: base.edit || null,
      source: base.source || (byId.has(a.id) ? "ai" : "user"),
    };
    // Re-think a moved or brand-new clip so scores and the edit plan match.
    if ((moved || !byId.has(a.id)) && rv.words) {
      try {
        const thought = brains.think({ words: rv.words, start: c.start, end: c.end, energy: { energy: 55, punch: 55 }, stats: { avgEnergy: 55, avgPunch: 55 }, sceneTimes: [], faceTrack: null, mode });
        if (thought) {
          c.dimensions = { scores: thought.scores, viralScore: thought.total, verdict: thought.verdict, verdictKey: thought.verdictKey, reasons: thought.reasons, quote: thought.quote, summary: thought.summary };
          c.score = thought.total;
        }
        c.edit = brains.edit.plan({ words: rv.words, start: c.start, end: c.end, duration: meta.duration, mode, captions: c.captions });
        c.edit.start = c.start; c.edit.end = c.end; c.edit.duration = +(c.end - c.start).toFixed(2);
      } catch (_) {}
    }
    top.push(c);
    if (top.length >= maxClips) break;
  }
  if (!top.length) throw new Error("Nothing to render - keep at least one clip.");

  // Fresh output folder: a second render of the same job must not mix files.
  for (const f of fs.readdirSync(outDir)) {
    try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {}
  }
  job.plan = top.map((c, i) => planEntry(c, i));
  job.clips = [];
  job.error = null;
  await renderPlan(job, rv.sourcePath, meta, mode, top, options, outDir);
  return job;
}

function normalizeSubStyleSafe(st) {
  try {
    return require("./subtitles").normalizeSubStyle(st || {});
  } catch (_) {
    return null;
  }
}

/**
 * Editor without AI: the user marks the ranges, we probe the file, make a
 * review job straight away (no analysis), and wait for "Render".
 */
async function planManual(sourcePath, options = {}) {
  const mode = MODES[options.mode] || MODES.viral;
  const id = options.jobId || crypto.randomBytes(6).toString("hex");
  const outDir = path.join(CLIPS_PUBLIC, id);
  fs.mkdirSync(outDir, { recursive: true });
  const job = {
    id,
    userId: options.userId || (readJob(id) || {}).userId || null,
    status: "processing",
    stage: "probing",
    progress: 10,
    mode: mode.id,
    modeLabel: mode.label,
    createdAt: new Date().toISOString(),
    sourceName: options.sourceName || path.basename(sourcePath),
    subtitles: !!options.subtitles,
    hook: false,
    manual: true,
    clips: [],
    rankings: [],
    error: null,
  };
  writeJob(job);
  try {
    const meta = await probe(sourcePath);
    if (!meta.duration || meta.duration < 3) throw new Error("Video is too short.");
    const maxMinutes = Number(options.maxMinutes) || 20;
    if (meta.duration > maxMinutes * 60) {
      throw new Error(`Your ${options.planLabel || "current"} plan allows videos up to ${maxMinutes} minutes.`);
    }
    job.duration = +meta.duration.toFixed(2);
    // Words are only needed for captions; skip the transcription when off.
    let words = null;
    if (options.subtitles) {
      job.stage = "listening";
      job.progress = 30;
      writeJob(job);
      const tmpWords = path.join(outDir, "source.words.json");
      try {
        const n = await transcribeToWords(sourcePath, tmpWords);
        if (n) words = JSON.parse(fs.readFileSync(tmpWords, "utf8")).words || null;
      } catch (_) {}
      try { fs.unlinkSync(tmpWords); } catch (_) {}
    }
    job.status = "review";
    job.stage = "review";
    job.progress = 50;
    job.review = {
      sourcePath,
      meta: { width: meta.width, height: meta.height, duration: meta.duration, hasAudio: meta.hasAudio },
      words,
      options: {
        subtitles: !!options.subtitles,
        subStyle: options.subStyle || null,
        hook: false,
        hookMode: "intro",
        trends: [],
        maxClips: Math.max(1, Number(options.maxClips) || mode.maxClips),
      },
    };
    job.plan = [];
    writeJob(job);
    return job;
  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
    job.progress = 0;
    writeJob(job);
    throw err;
  }
}

/* ---------- Link ranking boards ---------- */

function readLinkBoards() {
  try {
    const data = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
    return Array.isArray(data.boards) ? data.boards : [];
  } catch {
    return [];
  }
}

function writeLinkBoards(boards) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify({ boards }, null, 2));
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes("tiktok.com") || u.includes("vm.tiktok")) return "tiktok";
  if (u.includes("instagram.com") || u.includes("instagr.am")) return "instagram";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("linkedin.com")) return "linkedin";
  return "other";
}

function scoreLinkEntry(entry, index) {
  // Heuristic ranking from metadata the user provides + URL signals
  const platform = detectPlatform(entry.url);
  let base = 60;
  if (platform === "tiktok") base += 8;
  if (platform === "instagram") base += 5;
  if (platform === "youtube") base += 6;

  const views = Number(entry.views) || 0;
  let viewScore = 40;
  if (views >= 1_000_000) viewScore = 98;
  else if (views >= 100_000) viewScore = 88;
  else if (views >= 10_000) viewScore = 78;
  else if (views >= 1_000) viewScore = 68;
  else if (views > 0) viewScore = 55;

  const hookLen = (entry.hook || "").trim().length;
  let hookScore = 50;
  if (hookLen > 8 && hookLen < 90) hookScore = 90;
  else if (hookLen >= 90) hookScore = 75;
  else if (hookLen > 0) hookScore = 62;

  const dur = Number(entry.durationSec) || 0;
  let lengthScore = 55;
  if (dur >= 12 && dur <= 30) lengthScore = 95;
  else if (dur >= 8 && dur <= 45) lengthScore = 80;
  else if (dur > 0) lengthScore = 60;

  const tags = String(entry.notes || "").toLowerCase();
  let patternBonus = 0;
  if (/hook|question|shock|secret|stop/.test(tags)) patternBonus += 6;
  if (/cta|comment|follow|link/.test(tags)) patternBonus += 4;
  if (/face|talking|pov/.test(tags)) patternBonus += 3;

  const total = Math.min(
    99,
    Math.round(base * 0.15 + viewScore * 0.35 + hookScore * 0.25 + lengthScore * 0.2 + patternBonus)
  );

  const patterns = [];
  if (hookLen && hookLen < 60) patterns.push("Tight hook text");
  if (dur >= 15 && dur <= 28) patterns.push("Sweet-spot length (15-28s)");
  if (platform === "tiktok") patterns.push("TikTok-native format");
  if (/question/.test(tags) || /\?/.test(entry.hook || "")) patterns.push("Question hook");
  if (/list|3 |three|tips/.test(tags + entry.hook)) patterns.push("List / tips structure");
  if (patterns.length === 0) patterns.push("General short-form pattern");

  return {
    ...entry,
    platform,
    score: total + ((index * 3) % 4),
    dimensions: {
      total: total + ((index * 3) % 4),
      views: viewScore,
      hook: hookScore,
      length: lengthScore,
      platform: base,
    },
    patterns,
  };
}

function createLinkBoard({ name, links, niche, userId }) {
  const id = crypto.randomBytes(5).toString("hex");
  const scored = (links || [])
    .filter((l) => l && l.url)
    .map((l, i) =>
      scoreLinkEntry(
        {
          url: String(l.url).trim().slice(0, 500),
          hook: String(l.hook || "").trim().slice(0, 200),
          views: Number(l.views) || 0,
          durationSec: Number(l.durationSec) || 0,
          notes: String(l.notes || "").trim().slice(0, 300),
        },
        i
      )
    )
    .sort((a, b) => b.score - a.score)
    .map((item, i) => ({ ...item, rank: i + 1 }));

  // Aggregate playbook
  const patternCount = {};
  scored.forEach((s) =>
    s.patterns.forEach((p) => {
      patternCount[p] = (patternCount[p] || 0) + 1;
    })
  );
  const topPatterns = Object.entries(patternCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([pattern, count]) => ({ pattern, count }));

  const board = {
    id,
    userId: userId || null, // boards belong to the account that made them
    name: name || "Link ranking board",
    niche: niche || "general",
    createdAt: new Date().toISOString(),
    items: scored,
    playbook: topPatterns,
    summary: {
      count: scored.length,
      avgScore: scored.length
        ? Math.round(scored.reduce((a, b) => a + b.score, 0) / scored.length)
        : 0,
      topScore: scored[0]?.score || 0,
    },
  };

  const boards = readLinkBoards();
  boards.unshift(board);
  writeLinkBoards(boards.slice(0, 100));
  return board;
}

function getLinkBoard(id) {
  return readLinkBoards().find((b) => b.id === id) || null;
}

module.exports = {
  MODES,
  processVideo,
  renderClip,
  renderReviewed,
  planManual,
  readJob,
  writeJob,
  listJobs,
  createLinkBoard,
  getLinkBoard,
  readLinkBoards,
  UPLOADS,
  CLIPS_PUBLIC,
  JOBS_DIR,
};
