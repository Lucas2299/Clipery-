const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const crypto = require("crypto");

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
    targetMin: 12,
    targetMax: 28,
    ideal: 18,
    maxClips: 8,
    sceneThreshold: 0.2,
    captionStyle: "viral",
  },
  ranking: {
    id: "ranking",
    label: "Ranking analysis",
    description: "Score every moment with a full breakdown — post order ready",
    targetMin: 10,
    targetMax: 40,
    ideal: 24,
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
    // map dB (-60..0) → 0..100
    const energy = Math.min(100, Math.max(0, ((meanV + 50) / 50) * 100));
    const punch = Math.min(100, Math.max(0, ((maxV + 30) / 30) * 100));
    return { energy: Math.round(energy), punch: Math.round(punch) };
  } catch {
    return { energy: 50, punch: 50 };
  }
}

function buildCandidates(duration, sceneTimes, mode) {
  const bounds = [0, ...sceneTimes, duration].sort((a, b) => a - b);
  const raw = [];
  const chunk = mode.ideal + 4;

  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    const len = end - start;
    if (len < 6) continue;
    if (len <= mode.targetMax + 8) {
      raw.push({ start, end: Math.min(end, start + mode.targetMax + 6) });
    } else {
      let s = start;
      while (s < end - 8) {
        const e = Math.min(s + chunk, end);
        if (e - s >= 8) raw.push({ start: s, end: e });
        s += Math.max(10, mode.ideal - 4);
      }
    }
  }

  if (raw.length < 5) {
    const step = Math.max(10, duration / 8);
    for (let s = 0; s < duration - 8; s += step) {
      const e = Math.min(s + mode.ideal + 4, duration);
      if (e - s >= 8) raw.push({ start: s, end: e });
    }
  }

  // Viral mode: add cold-open dedicated window
  if (mode.id === "viral" && duration > 20) {
    raw.unshift({ start: 0, end: Math.min(mode.ideal + 2, duration) });
  }

  raw.sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of raw) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.start - c.start) < 4) continue;
    const start = Math.max(0, +c.start.toFixed(2));
    let end = Math.min(duration, +c.end.toFixed(2));
    if (end - start > mode.targetMax + 10) end = start + mode.targetMax + 6;
    if (end - start >= 7) out.push({ start, end });
  }
  return out.slice(0, 16);
}

function scoreDimensions(c, duration, energy, mode, index) {
  const len = c.end - c.start;
  const mid = (c.start + c.end) / 2;
  const pos = mid / Math.max(duration, 1);

  // Length fit — TikTok sweet spot 12–28s
  let length = 40;
  if (len >= 15 && len <= 25) length = 98;
  else if (len >= mode.targetMin && len <= mode.targetMax) length = 92;
  else if (len >= mode.targetMin - 4 && len <= mode.targetMax + 8) length = 78;
  else if (len >= 8 && len <= 45) length = 58;

  // Hook / cold-open strength (first seconds win the algorithm)
  let hook = 70;
  if (pos < 0.08) hook = 99;
  else if (pos < 0.15) hook = mode.id === "viral" ? 96 : 90;
  else if (pos < 0.3) hook = 88;
  else if (pos < 0.55) hook = 76;
  else if (pos > 0.88) hook = mode.id === "ranking" ? 84 : 68;
  else hook = 72;

  // Pacing / energy from audio
  const pacing = Math.round(energy.energy * 0.55 + energy.punch * 0.45);

  // Retention proxy
  let retention = Math.round(
    length * 0.4 + pacing * 0.4 + (100 - Math.abs(len - mode.ideal) * 3) * 0.2
  );
  retention = Math.min(99, Math.max(35, retention));

  // CTA fitness
  const cta = pos > 0.8 ? 90 : pos > 0.65 ? 70 : 45;

  // Replay / share potential
  const replay = Math.round(
    Math.min(99, pacing * 0.4 + hook * 0.35 + (len >= 12 && len <= 30 ? 90 : 55) * 0.25)
  );

  // AI viral prediction (weighted for “will this go viral?”)
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

async function renderClip(source, outFile, start, end, label, sublabel, mode) {
  const dur = Math.max(0.5, end - start);
  const targetW = 608;
  const targetH = 1080;
  const accent = mode.id === "viral" ? "0xFF4D6D" : "0x8B7CFF";
  const title = escapeDrawtext(label);
  const sub = escapeDrawtext(sublabel);

  const vf = [
    `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase`,
    `crop=${targetW}:${targetH}`,
    `drawbox=x=0:y=0:w=iw:h=130:color=black@0.5:t=fill`,
    `drawbox=x=0:y=0:w=8:h=ih:color=${accent}:t=fill`,
    `drawtext=text='${title}':fontsize=30:fontcolor=white:x=24:y=36:font=Sans`,
    `drawtext=text='${sub}':fontsize=20:fontcolor=white@0.8:x=24:y=78:font=Sans`,
    `drawbox=x=0:y=ih-100:w=iw:h=100:color=black@0.45:t=fill`,
    `drawtext=text='Clipfoundry ${mode.id === "viral" ? "viral" : "ranked"}':fontsize=20:fontcolor=white@0.9:x=(w-text_w)/2:y=h-58:font=Sans`,
  ].join(",");

  await run(
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
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
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
    { timeout: 200000 }
  );
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

function listJobs(limit = 50) {
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
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return files.slice(0, limit);
}

async function processVideo(sourcePath, options = {}) {
  const mode = MODES[options.mode] || MODES.viral;
  const id = options.jobId || crypto.randomBytes(6).toString("hex");
  const outDir = path.join(CLIPS_PUBLIC, id);
  fs.mkdirSync(outDir, { recursive: true });

  const job = {
    id,
    status: "processing",
    stage: "probing",
    progress: 4,
    mode: mode.id,
    modeLabel: mode.label,
    createdAt: new Date().toISOString(),
    sourceName: options.sourceName || path.basename(sourcePath),
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
    if (meta.duration > 20 * 60) {
      throw new Error("Demo limit is 20 minutes. Trim your video and retry.");
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

    const scored = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const energy = meta.hasAudio
        ? await sampleEnergy(sourcePath, c.start, c.end)
        : { energy: 55, punch: 55 };
      const dims = scoreDimensions(c, meta.duration, energy, mode, i);
      scored.push({
        ...c,
        score: dims.total,
        dimensions: dims,
        title: titleForClip(c, meta.duration, dims, mode, i),
      });
      job.progress = 28 + Math.round(((i + 1) / candidates.length) * 22);
      writeJob(job);
    }

    scored.sort((a, b) => b.score - a.score);

    // Full viral leaderboard (all analyzed moments)
    job.rankings = scored.map((c, i) => ({
      rank: i + 1,
      score: c.score,
      viralScore: c.dimensions.viralScore || c.score,
      verdict: c.dimensions.verdict,
      verdictKey: c.dimensions.verdictKey,
      reasons: c.dimensions.reasons || [],
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
      postOrder: scored.slice(0, Math.min(mode.maxClips, scored.length)).map((c, i) => ({
        rank: i + 1,
        title: c.title,
        viralScore: c.score,
        verdict: c.dimensions.verdict,
      })),
      summary:
        scored[0] && scored[0].score >= 82
          ? `AI found ${scored.filter((c) => c.score >= 82).length} high-viral clip(s). Post #1 first (score ${scored[0].score}).`
          : `AI analyzed ${scored.length} moments. Best clip scored ${scored[0]?.score || 0} — still worth testing.`,
    };

    const topN = Math.min(mode.maxClips, scored.length);
    const top = scored.slice(0, topN);

    job.stage = "rendering";
    job.progress = 52;
    writeJob(job);

    const clips = [];
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      const filename = `clip-${i + 1}.mp4`;
      const outFile = path.join(outDir, filename);
      const vScore = c.dimensions.viralScore || c.score;
      const label = `#${i + 1} VIRAL ${vScore}`;
      const sub = `${c.dimensions.verdict || c.title}`.slice(0, 42);
      await renderClip(sourcePath, outFile, c.start, c.end, label, sub, mode);
      clips.push({
        rank: i + 1,
        score: c.score,
        viralScore: vScore,
        verdict: c.dimensions.verdict,
        verdictKey: c.dimensions.verdictKey,
        reasons: c.dimensions.reasons || [],
        title: c.title,
        start: c.start,
        end: c.end,
        duration: +(c.end - c.start).toFixed(2),
        dimensions: c.dimensions,
        url: `/clips/${id}/${filename}`,
        downloadName: `viral-${vScore}-rank${i + 1}-${id}.mp4`,
        postTip:
          i === 0
            ? "Post this first — highest viral chance"
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
  if (dur >= 15 && dur <= 28) patterns.push("Sweet-spot length (15–28s)");
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

function createLinkBoard({ name, links, niche }) {
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
