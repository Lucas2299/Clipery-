const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const crypto = require("crypto");
const { tryEnhanceClip } = require("./subtitles");

const execFileAsync = promisify(execFile);

const ROOT = path.join(__dirname, "..");
const UPLOADS = path.join(ROOT, "uploads");
const CLIPS_PUBLIC = path.join(ROOT, "public", "clips");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const TMP = path.join(ROOT, "tmp");

for (const d of [UPLOADS, CLIPS_PUBLIC, JOBS_DIR, TMP]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function run(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, {
    maxBuffer: 30 * 1024 * 1024,
    timeout: opts.timeout || 300000,
    ...opts,
  });
}

function jobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), "utf8"));
  } catch {
    return null;
  }
}

function writeJob(job) {
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "%%")
    .replace(/"/g, "")
    .slice(0, 80);
}

function detectPlatform(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("tiktok.com") || u.includes("vm.tiktok")) return "tiktok";
  if (u.includes("instagram.com")) return "instagram";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.startsWith("/samples/") || u.startsWith("sample:")) return "sample";
  return "other";
}

async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=width,height,codec_type",
    "-of", "json",
    file,
  ]);
  const data = JSON.parse(stdout);
  const duration = parseFloat(data.format?.duration || 0);
  const v = (data.streams || []).find((s) => s.codec_type === "video") || {};
  const a = (data.streams || []).find((s) => s.codec_type === "audio");
  return {
    duration,
    width: Number(v.width) || 720,
    height: Number(v.height) || 1280,
    hasAudio: !!a,
  };
}

async function sampleEnergy(file, duration) {
  try {
    const { stderr } = await run(
      "ffmpeg",
      [
        "-hide_banner", "-t", String(Math.min(duration, 20)),
        "-i", file, "-af", "volumedetect", "-f", "null", "-",
      ],
      { timeout: 60000 }
    );
    const text = String(stderr || "");
    const mean = /mean_volume:\s*([-\d.]+)/.exec(text);
    const max = /max_volume:\s*([-\d.]+)/.exec(text);
    const meanV = mean ? parseFloat(mean[1]) : -40;
    const maxV = max ? parseFloat(max[1]) : -20;
    const energy = Math.min(100, Math.max(0, ((meanV + 50) / 50) * 100));
    const punch = Math.min(100, Math.max(0, ((maxV + 30) / 30) * 100));
    return { energy: Math.round(energy), punch: Math.round(punch) };
  } catch {
    return { energy: 55, punch: 55 };
  }
}

function scoreVideo(meta, energy, index, label) {
  const dur = meta.duration || 0;
  let length = 50;
  if (dur >= 12 && dur <= 30) length = 96;
  else if (dur >= 8 && dur <= 45) length = 82;
  else if (dur >= 5 && dur <= 60) length = 68;
  else if (dur > 60) length = 55;

  const pacing = Math.round(energy.energy * 0.55 + energy.punch * 0.45);
  // vertical bonus
  const vertical = meta.height >= meta.width ? 92 : 60;
  const hook = Math.min(99, 70 + (label && label.length > 6 ? 15 : 0) + (index === 0 ? 5 : 0));
  const retention = Math.round(length * 0.45 + pacing * 0.55);

  const total = Math.min(
    99,
    Math.max(
      55,
      Math.round(hook * 0.25 + length * 0.25 + pacing * 0.3 + vertical * 0.1 + retention * 0.1 + ((index * 7) % 4))
    )
  );

  return {
    total,
    hook: Math.round(hook),
    length: Math.round(length),
    pacing: Math.round(pacing),
    retention: Math.round(retention),
    vertical: Math.round(vertical),
    energy: energy.energy,
    punch: energy.punch,
  };
}

/** Download a single URL with yt-dlp. Returns file path or throws. */
async function downloadUrl(url, outBase) {
  const platform = detectPlatform(url);

  // Built-in sample pack shortcuts
  if (url.startsWith("sample:") || url.startsWith("/samples/rank-pack/")) {
    const name = url.replace("sample:", "").replace("/samples/rank-pack/", "");
    const local = path.join(ROOT, "public", "samples", "rank-pack", name.endsWith(".mp4") ? name : `${name}.mp4`);
    if (!fs.existsSync(local)) throw new Error("Sample not found: " + name);
    const dest = outBase + ".mp4";
    fs.copyFileSync(local, dest);
    return { file: dest, title: name, platform: "sample" };
  }

  if (platform === "tiktok") {
    // Try anyway — may work on some hosts
    const errHint =
      "TikTok blocked downloads from this server IP. Use Upload videos instead (save TikToks to your phone/PC and upload), or paste YouTube Shorts URLs.";
    try {
      await tryYtdlp(url, outBase);
      const file = findDownloaded(outBase);
      if (file) return { file, title: path.basename(file), platform };
    } catch (e) {
      throw new Error(errHint + " (" + (e.message || "blocked") + ")");
    }
    throw new Error(errHint);
  }

  await tryYtdlp(url, outBase);
  const file = findDownloaded(outBase);
  if (!file) throw new Error("Download finished but no file found for " + url);
  return { file, title: path.basename(file), platform };
}

async function tryYtdlp(url, outBase) {
  const args = [
    "--no-playlist",
    "-f", "bv*[height<=720]+ba/b[height<=720]/b",
    "--max-filesize", "40M",
    "--merge-output-format", "mp4",
    "-o", outBase + ".%(ext)s",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android",
    url,
  ];
  try {
    await run("yt-dlp", args, { timeout: 180000 });
  } catch (e) {
    // retry simpler format
    try {
      await run(
        "yt-dlp",
        [
          "--no-playlist", "-f", "b", "--max-filesize", "40M",
          "-o", outBase + ".%(ext)s",
          "--extractor-args", "youtube:player_client=android",
          url,
        ],
        { timeout: 180000 }
      );
    } catch (e2) {
      const msg = String(e2.stderr || e2.message || e.message || "download failed");
      throw new Error(msg.slice(0, 240));
    }
  }
}

function findDownloaded(outBase) {
  const dir = path.dirname(outBase);
  const base = path.basename(outBase);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(base));
  // prefer mp4
  const mp4 = files.find((f) => f.endsWith(".mp4"));
  if (mp4) return path.join(dir, mp4);
  if (files[0]) return path.join(dir, files[0]);
  return null;
}

/**
 * Clean TikTok-style ranking overlay (like the dog photo):
 * - Yellow title at top only
 * - Numbers 1. 2. 3. on the LEFT only (current rank gold)
 * - Video name / caption at bottom
 * - NO grey boxes / panels / huge #rank badges
 */
function buildRankingOverlay({
  title,
  caption,
  currentRank,
  total,
  highlight = true,
}) {
  const W = 608;
  const H = 1080;
  const titleText = escapeDrawtext(title || "Top Videos");
  const cap = escapeDrawtext((caption || "").slice(0, 42));

  const filters = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
    // Title — yellow, top center (no background box)
    `drawtext=text='${titleText}':fontsize=50:fontcolor=0xFFE600:borderw=5:bordercolor=black:x=(w-text_w)/2:y=42:font=Sans`,
  ];

  // Left-side numbers only (1. 2. 3. …)
  const startY = 160;
  const gap = Math.min(72, Math.floor(700 / Math.max(total, 1)));
  for (let n = 1; n <= total; n++) {
    const y = startY + (n - 1) * gap;
    const isCurrent = highlight && n === currentRank;
    const fs = isCurrent ? 52 : 38;
    const color = isCurrent ? "0xFFE600" : "white";
    const border = isCurrent ? 5 : 3;
    filters.push(
      `drawtext=text='${n}.':fontsize=${fs}:fontcolor=${color}:borderw=${border}:bordercolor=black:x=24:y=${y}:font=Sans`
    );
  }

  // Bottom: video name only
  if (cap) {
    filters.push(
      `drawtext=text='${cap}':fontsize=34:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-90:font=Sans`
    );
  }

  return filters.join(",");
}

async function renderTikTokRankClip(source, outFile, {
  title,
  caption,
  rank,
  total,
  maxSeconds = 180,
}) {
  const meta = await probe(source);
  const take = Math.min(Math.max(meta.duration || 3, 0.5), maxSeconds);
  const vf = buildRankingOverlay({
    title,
    caption,
    currentRank: rank,
    total,
    highlight: true,
  });

  if (meta.hasAudio) {
    await run(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", source,
        "-t", String(take),
        "-vf", vf,
        "-r", "30",
        "-vsync", "cfr",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-af", "aresample=async=1:first_pts=0",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
        "-shortest",
        "-movflags", "+faststart",
        outFile,
      ],
      { timeout: 600000 }
    );
  } else {
    await run(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", source,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", String(take),
        "-vf", vf,
        "-r", "30",
        "-vsync", "cfr",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
        "-shortest",
        "-movflags", "+faststart",
        outFile,
      ],
      { timeout: 600000 }
    );
  }
}

/** Intro: yellow title + numbers only (no grey panels) */
async function makeListIntro(outFile, title, items, duration = 2.2) {
  const titleText = escapeDrawtext(title || "Top Videos");
  const total = items.length;
  const filters = [
    `drawtext=text='${titleText}':fontsize=56:fontcolor=0xFFE600:borderw=5:bordercolor=black:x=(w-text_w)/2:y=50:font=Sans`,
  ];
  const startY = 170;
  const gap = Math.min(72, Math.floor(700 / Math.max(total, 1)));
  for (let n = 1; n <= total; n++) {
    const y = startY + (n - 1) * gap;
    // show number + short video name on intro
    const name = escapeDrawtext((items[n - 1] || "").slice(0, 24));
    filters.push(
      `drawtext=text='${n}.':fontsize=40:fontcolor=white:borderw=3:bordercolor=black:x=28:y=${y}:font=Sans`
    );
    if (name) {
      filters.push(
        `drawtext=text='${name}':fontsize=28:fontcolor=white:borderw=3:bordercolor=black:x=100:y=${y + 6}:font=Sans`
      );
    }
  }

  await run(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=0x0d0d12:s=608x1080:d=${duration}:r=30`,
      "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
      "-vf", filters.join(","),
      "-r", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
      "-shortest", "-t", String(duration),
      "-movflags", "+faststart",
      outFile,
    ],
    { timeout: 60000 }
  );
}

async function makeWinnerCard(outFile, title, winnerLabel, duration = 2.2) {
  const t = escapeDrawtext(title || "Top Videos");
  const w = escapeDrawtext((winnerLabel || "Winner").slice(0, 32));
  await run(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=0x0d0d12:s=608x1080:d=${duration}:r=30`,
      "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
      "-vf",
      [
        `drawtext=text='${t}':fontsize=48:fontcolor=0xFFE600:borderw=5:bordercolor=black:x=(w-text_w)/2:y=200:font=Sans`,
        `drawtext=text='1.':fontsize=64:fontcolor=0xFFE600:borderw=5:bordercolor=black:x=40:y=420:font=Sans`,
        `drawtext=text='${w}':fontsize=40:fontcolor=white:borderw=4:bordercolor=black:x=120:y=440:font=Sans`,
      ].join(","),
      "-r", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
      "-shortest", "-t", String(duration),
      "-movflags", "+faststart",
      outFile,
    ],
    { timeout: 60000 }
  );
}

// keep old name as alias for any callers
async function renderRankedClip(source, outFile, rank, score, title, total) {
  return renderTikTokRankClip(source, outFile, {
    title: "Top Videos",
    caption: title || `Rank ${rank}`,
    rank,
    total,
    maxSeconds: 180,
  });
}

async function makeTitleCard(outFile, text, sub, duration = 2.2) {
  return makeListIntro(outFile, text, [sub || ""], duration);
}

/**
 * Concat already-normalized clips with stream copy when possible.
 * All inputs must share same codec / size / sample rate (we enforce that above).
 */
async function concatVideos(listFile, outFile) {
  // Prefer copy (perfect A/V sync, no drift). Fall back to re-encode if needed.
  try {
    await run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outFile,
      ],
      { timeout: 300000 }
    );
  } catch {
    await run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listFile,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-af",
        "aresample=async=1:first_pts=0",
        "-movflags",
        "+faststart",
        outFile,
      ],
      { timeout: 600000 }
    );
  }
}

/**
 * Process multiple source videos into ranked clips + one compilation ranking video.
 * sources: [{ path, label, url? }]
 */
async function processMultiRank(sources, options = {}) {
  const id = options.jobId || crypto.randomBytes(6).toString("hex");
  const outDir = path.join(CLIPS_PUBLIC, id);
  fs.mkdirSync(outDir, { recursive: true });

  const job = {
    id,
    status: "processing",
    stage: "scoring_sources",
    progress: 5,
    mode: "link-rank-video",
    modeLabel: "Link ranking video",
    createdAt: new Date().toISOString(),
    sourceName: options.sourceName || `${sources.length} links/videos`,
    clips: [],
    rankings: [],
    compilation: null,
    errors: [],
    error: null,
    sources: sources.map((s) => ({ label: s.label, url: s.url || null })),
  };
  writeJob(job);

  try {
    if (!sources.length) throw new Error("No videos to rank.");
    if (sources.length > 5) throw new Error("Max 5 videos per ranking job.");

    // Score each source
    const scored = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      job.stage = "scoring_sources";
      job.progress = 5 + Math.round((i / sources.length) * 25);
      writeJob(job);

      const meta = await probe(src.path);
      if (!meta.duration || meta.duration < 2) {
        job.errors.push({ label: src.label, error: "Too short" });
        continue;
      }
      const energy = meta.hasAudio
        ? await sampleEnergy(src.path, meta.duration)
        : { energy: 55, punch: 55 };
      const dims = scoreVideo(meta, energy, i, src.label);
      scored.push({
        ...src,
        meta,
        score: dims.total,
        dimensions: dims,
        title: src.label || `Video ${i + 1}`,
      });
    }

    if (!scored.length) throw new Error("No valid videos to rank.");

    scored.sort((a, b) => b.score - a.score);

    job.rankings = scored.map((s, i) => ({
      rank: i + 1,
      score: s.score,
      title: s.title,
      url: s.url || null,
      duration: +s.meta.duration.toFixed(2),
      dimensions: s.dimensions,
    }));
    job.stage = "rendering_clips";
    job.progress = 35;
    writeJob(job);

    // Board title like "Dog Videos" / "Top Videos"
    const boardTitle =
      (options.boardTitle || options.sourceName || "Top Videos")
        .replace(/\s*→.*$/, "")
        .replace(/^Ranking\s*[·•-]?\s*/i, "")
        .trim()
        .slice(0, 28) || "Top Videos";

    // Bottom caption = video name (clean, readable)
    function captionFor(s, rank) {
      let t = (s.title || "").trim();
      // strip extension / ugly file names a bit
      t = t.replace(/\.(mp4|mov|webm|mkv|m4v)$/i, "");
      t = t.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
      const looksLikeFile = /^v\d+$/i.test(t) || /^video\s*\d+$/i.test(t) || /^https?:/i.test(t);
      if (t && t.length >= 1 && t.length <= 40 && !looksLikeFile) {
        return t;
      }
      return `Video ${rank}`;
    }

    // Render each ranked clip with photo-style overlay (numbers + yellow title)
    const clips = [];
    for (let i = 0; i < scored.length; i++) {
      const s = scored[i];
      const rank = i + 1;
      const filename = `rank-${rank}.mp4`;
      const outFile = path.join(outDir, filename);
      const caption = captionFor(s, rank);
      await renderTikTokRankClip(s.path, outFile, {
        title: boardTitle,
        caption,
        rank,
        total: scored.length,
        maxSeconds: 180, // full original length (up to 3 min safety cap)
      });
      clips.push({
        rank,
        score: s.score,
        title: s.title,
        caption,
        sourceUrl: s.url || null,
        duration: +Math.min(s.meta.duration, 180).toFixed(2),
        dimensions: s.dimensions,
        url: `/clips/${id}/${filename}`,
        downloadName: `rank-${rank}-${id}.mp4`,
      });
      job.progress = 35 + Math.round(((i + 1) / scored.length) * 40);
      job.clips = clips;
      writeJob(job);
    }

    // Compilation: intro list → countdown #N … #1 (same layout as the photo)
    job.stage = "building_compilation";
    job.progress = 80;
    writeJob(job);

    const work = path.join(TMP, id);
    fs.mkdirSync(work, { recursive: true });
    const parts = [];

    const intro = path.join(work, "intro.mp4");
    await makeListIntro(
      intro,
      boardTitle,
      scored.map((s, i) => captionFor(s, i + 1)),
      2.8
    );
    parts.push(intro);

    // last place → first place (countdown reveal)
    for (let i = scored.length - 1; i >= 0; i--) {
      const rank = i + 1;
      parts.push(path.join(outDir, `rank-${rank}.mp4`));
    }

    const outro = path.join(work, "outro.mp4");
    await makeWinnerCard(outro, boardTitle, captionFor(scored[0], 1), 2.5);
    parts.push(outro);

    const listFile = path.join(work, "list.txt");
    fs.writeFileSync(
      listFile,
      parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
    );

    const compName = "ranking-compilation.mp4";
    const compPath = path.join(outDir, compName);
    await concatVideos(listFile, compPath);

    if (options.subtitles || options.hook) {
      const er = await tryEnhanceClip(compPath, {
        subStyle: options.subtitles ? options.subStyle : null,
        hook: options.hook ? { enabled: true, mode: options.hookMode } : null,
        trends: options.trends,
      });
      if (er.subtitlesApplied) job.subtitlesApplied = true;
      if (er.hookApplied) {
        job.hookApplied = true;
        if (er.hookText) job.hookText = er.hookText;
      }
      if (!er.subtitlesApplied && !er.hookApplied && er.reason) {
        job.subtitlesNote = `captions skipped (${er.reason})`;
      }
    }

    job.compilation = {
      url: `/clips/${id}/${compName}`,
      downloadName: `ranking-video-${id}.mp4`,
      title: `${boardTitle} — ranking countdown`,
      style: "tiktok-list-countdown",
    };
    job.boardTitle = boardTitle;
    job.status = "done";
    job.stage = "complete";
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    job.clips = clips;
    writeJob(job);

    // cleanup work dir (keep outputs)
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (_) {}

    return job;
  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
    job.progress = 0;
    writeJob(job);
    throw err;
  }
}

/**
 * Download many URLs then processMultiRank
 */
async function processLinksToRankingVideo(links, options = {}) {
  const id = options.jobId || crypto.randomBytes(6).toString("hex");
  const dlDir = path.join(UPLOADS, `links-${id}`);
  fs.mkdirSync(dlDir, { recursive: true });

  // seed job early
  const job = {
    id,
    status: "processing",
    stage: "downloading",
    progress: 2,
    mode: "link-rank-video",
    modeLabel: "Link ranking video",
    createdAt: new Date().toISOString(),
    sourceName: options.sourceName || `${links.length} links`,
    clips: [],
    rankings: [],
    compilation: null,
    errors: [],
    error: null,
  };
  writeJob(job);

  const sources = [];
  for (let i = 0; i < links.length; i++) {
    const item = links[i];
    const url = String(item.url || item).trim();
    if (!url) continue;
    job.stage = "downloading";
    job.progress = 2 + Math.round((i / links.length) * 30);
    job.downloadStatus = `Fetching ${i + 1}/${links.length}…`;
    writeJob(job);

    const outBase = path.join(dlDir, `src-${i}`);
    try {
      const got = await downloadUrl(url, outBase);
      sources.push({
        path: got.file,
        label: item.hook || item.label || got.title || `Video ${i + 1}`,
        url,
      });
    } catch (e) {
      job.errors.push({ url, error: e.message || String(e) });
      writeJob(job);
    }
  }

  if (!sources.length) {
    const tiktokOnly = links.every((l) => detectPlatform(l.url || l) === "tiktok");
    job.status = "error";
    job.error = tiktokOnly
      ? "Could not download TikTok links from this server (TikTok blocks the IP). Use “Upload videos” on the Rank page: save each TikTok and upload them — we’ll still make one ranked clip per video + a countdown ranking video."
      : "Could not download any links. Try YouTube Shorts URLs, sample pack, or upload video files.";
    job.progress = 0;
    writeJob(job);
    throw new Error(job.error);
  }

  // Continue with multi-rank using same job id
  return processMultiRank(sources, {
    jobId: id,
    sourceName: options.sourceName || `${sources.length} ranked videos`,
    boardTitle: options.boardTitle || options.sourceName || "Top Videos",
  });
}

module.exports = {
  processMultiRank,
  processLinksToRankingVideo,
  downloadUrl,
  detectPlatform,
  readJob,
  writeJob,
};
