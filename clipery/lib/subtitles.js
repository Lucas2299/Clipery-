"use strict";
/**
 * Subtitles pipeline: transcribe word-level timings (PocketSphinx via
 * lib/transcribe.py) → build TikTok-style KARAOKE captions (.ass) → burn
 * into any finished video with ffmpeg.
 *
 * Caption behaviour (what viewers see):
 * - words light up ONE BY ONE, left to right, karaoke-style
 * - a calm 2-row block: row 1 pinned in place, row 2 can only appear BELOW it
 *   (never jumps up/down like centered single captions do)
 * - dim upcoming words, full-colour word that is being spoken
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

// ASS colors are &HAABBGGRR (alpha + blue-green-red order!).
const SUB_COLORS = {
  white: "&H00FFFFFF",
  yellow: "&H004CE7FF",
  pink: "&H006D4DFF", // Clipery #FF4D6D
  orange: "&H004C8AFF", // Clipery #FF8A4C
  red: "&H003B3BFF", // #FF3B3B
  green: "&H0058D130", // #30D158
  cyan: "&H00F5D43C", // #3CD4F5
  blue: "&H00FF8A4C", // #4C8AFF
  purple: "&H00FF6BA8", // #A86BFF
};
// dim "not-yet-spoken" karaoke colour (semi-transparent white);
// for the "pop" style upcoming words stay fully hidden until spoken.
const KARAOKE_DIM = "&H73FFFFFF";
const KARAOKE_HIDDEN = "&HFFFFFFFF";
// Font sizes in script units (PlayRes 384x684 matches our 608x1080 portrait
// canvas exactly, so 1 unit ≈ 1.6 real pixels).
const SUB_SIZES = { small: 26, medium: 30, large: 36, xl: 42 };
// Max characters per caption row per size → guarantees max 2 rows, no overflow.
const ROW_CHARS = { small: 22, medium: 19, large: 16, xl: 13 };
const ROW_WORDS = 5;
// Position: Alignment 8 = anchored at the TOP of the block, MarginV measured
// from the top edge → row 1 NEVER moves; row 2 grows downward underneath.
// bottom ≈ above watermark strip · middle ≈ screen center · top ≈ below title area.
const SUB_POSITIONS = {
  bottom: 540,
  middle: 303,
  top: 126,
};
// New block when speaker pauses longer than this (seconds).
const GAP_SPLIT = 0.9;

/** Validate free-form style input against whitelists. Always returns a complete style. */
function normalizeSubStyle(input = {}) {
  const pick = (v, map, dflt) => (map.hasOwnProperty(String(v).toLowerCase()) ? String(v).toLowerCase() : dflt);
  const st = String(input.style).toLowerCase();
  return {
    color: pick(input.color, SUB_COLORS, "white"),
    size: pick(input.size, SUB_SIZES, "medium"),
    pos: pick(input.pos, SUB_POSITIONS, "bottom"),
    style: st === "box" || st === "pop" ? st : "outline",
  };
}

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

/** Transcribe media → word-level JSON {words:[{w,s,e}]}. Returns word count (0 = no speech/failed). */
async function transcribeToWords(mediaPath, jsonPath) {
  if (!subtitlesAvailable()) return 0;
  try {
    const out = await run(PY, [TRANSCRIBE_PY, mediaPath, jsonPath, "0"], { timeout: 30 * 60 * 1000 });
    const m = /words=(\d+)/.exec(out);
    const n = m ? parseInt(m[1], 10) : 0;
    if (n > 0 && fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (Array.isArray(data.words) && data.words.length) return data.words.length;
    }
  } catch (e) {
    console.warn("[subtitles] transcribe failed:", e.message);
  }
  return 0;
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Rolling 2-row karaoke window (the real TikTok pattern):
 * words fill row 1 left→right, overflow continues on row 2 below;
 * when row 2 is full it SLIDES UP to become row 1 and fresh words take
 * row 2. The caption area is always the same height → zero bouncing.
 * A long pause (> GAP_SPLIT) resets the window for the next sentence.
 */
function buildRollingPages(words, rowChars) {
  const pages = [];
  let r1 = [];
  let r2 = [];
  let lastEnd = 0;
  let intro = true; // true while a fresh window's rows are still being spoken (karaoke live)
  const rowLen = (arr) => arr.reduce((a, x) => a + x.w.length + 1, 0);
  const fits = (arr, word) => rowLen(arr) + word.length <= rowChars && arr.length < ROW_WORDS;

  const closePage = (fresh) => {
    if (!r1.length && !r2.length) return;
    pages.push({ r1, r2, intro });
    if (fresh) {
      r1 = [];
      r2 = [];
      intro = true;
    } else {
      r1 = r2; // the filled row 2 scrolls up to become row 1
      r2 = [];
      intro = false;
    }
  };

  for (const w of words) {
    if ((r1.length || r2.length) && w.s - lastEnd > GAP_SPLIT) closePage(true); // pause → fresh window

    if (!r1.length && !r2.length) {
      r1.push(w);
    } else if (!r2.length) {
      if (fits(r1, w.w)) r1.push(w); // still filling row 1
      else r2.push(w); // row 1 full → row 2 starts
    } else {
      if (fits(r2, w.w)) {
        r2.push(w);
      } else {
        closePage(false); // row 2 full → slide content up
        r2.push(w);
      }
    }
    lastEnd = Math.max(lastEnd, w.e);
  }
  closePage(true);
  return pages;
}

function assTime(t) {
  if (t < 0) t = 0;
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

// keep ASS override braces/backslashes out of recognised words
const cleanWord = (w) => String(w).replace(/[{}\\]/g, "").trim();

/**
 * Build a complete .ass subtitle file with karaoke word highlighting.
 * \k tags: each word switches from dim (SecondaryColour) to full colour
 * exactly when it is spoken → words fill in left to right, karaoke-style.
 */
function buildKaraokeAss(pages, sub = {}) {
  const s = normalizeSubStyle(sub);
  const size = SUB_SIZES[s.size];
  const marginV = SUB_POSITIONS[s.pos];
  const primary = SUB_COLORS[s.color];
  // Fields: OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow
  const deco =
    s.style === "box"
      ? "&H00000000,&H78000000,1,0,0,0,100,100,0,0,3,8,0" // semi-transparent backdrop box
      : s.style === "pop"
        ? "&HFFFFFFFF,&H00000000,1,0,0,0,100,100,0,0,1,0,0" // true pop-in: no outline, hidden ghosts
        : "&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2.5,0"; // classic outline
  const secondary = s.style === "pop" ? KARAOKE_HIDDEN : KARAOKE_DIM;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 384",
    "PlayResY: 684",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,DejaVu Sans,${size},${primary},${secondary},${deco},8,12,12,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = [];
  const starts = pages.map((p) => (p.intro || !p.r2.length ? p.r1[0].s - 0.06 : p.r2[0].s - 0.08));
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const hasTwoRows = p.r2.length > 0;
    const staticRow = p.intro ? [] : p.r1; // intro pages karaoke everything live
    const liveRow = p.intro ? [...p.r1, ...p.r2] : p.r2;
    const row1Len = p.r1.length;

    const evStart = Math.max(0, starts[i]);
    const lastWord = liveRow[liveRow.length - 1];
    let evEnd = lastWord.e + 0.35;
    if (i + 1 < pages.length) evEnd = Math.min(evEnd, Math.max(0, starts[i + 1]) - 0.02);
    if (evEnd <= evStart + 0.2) evEnd = evStart + 0.2;

    const parts = [];
    for (const w of staticRow) parts.push(`{\\k5}${cleanWord(w.w)}`); // already spoken → lit at once
    let prevStart = null;
    for (const w of liveRow) {
      let cs = prevStart === null ? Math.round((w.s - evStart) * 100) : Math.round((w.s - prevStart) * 100);
      if (cs < 5) cs = 5;
      parts.push(`{\\k${cs}}${cleanWord(w.w)}`);
      prevStart = w.s;
    }
    if (!parts.length) continue;
    const text = hasTwoRows
      ? parts.slice(0, row1Len).join(" ") + "\\N" + parts.slice(row1Len).join(" ")
      : parts.join(" ");
    events.push(`Dialogue: 0,${assTime(evStart)},${assTime(evEnd)},Cap,,0,0,0,,${text}`);
  }
  return header.concat(events).join("\n") + "\n";
}

/** Burn an .ass subtitle file into video, atomically replacing it. Returns true on success. */
async function burnAss(videoPath, assPath) {
  const tmpOut = videoPath + ".subbed.mp4";
  const vf = `subtitles='${escFilterPath(assPath)}'`;
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
 * Full pass: transcribe → karaoke .ass → burn captions into a rendered clip
 * in place. Keeps the .ass next to the video (downloadable captions file).
 * Never throws.
 */
async function tryAddSubtitles(videoPath, subStyle = {}) {
  if (!subtitlesAvailable()) return { applied: false, reason: "engine-missing" };
  const noExt = videoPath.replace(/\.mp4$/i, "");
  const jsonPath = noExt + ".words.json";
  const assPath = noExt + ".subtitles.ass";

  const n = await transcribeToWords(videoPath, jsonPath);
  if (!n) {
    try { fs.unlinkSync(jsonPath); } catch {}
    return { applied: false, reason: "no-speech-detected" };
  }
  let pages = [];
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const style = normalizeSubStyle(subStyle);
    pages = buildRollingPages(data.words || [], ROW_CHARS[style.size]);
  } catch {}
  if (!pages.length) {
    try { fs.unlinkSync(jsonPath); } catch {}
    return { applied: false, reason: "no-speech-detected" };
  }
  fs.writeFileSync(assPath, buildKaraokeAss(pages, subStyle), "utf8");
  try { fs.unlinkSync(jsonPath); } catch {}

  const applied = await burnAss(videoPath, assPath);
  if (!applied) {
    try { fs.unlinkSync(assPath); } catch {}
    return { applied: false, reason: "burn-failed" };
  }
  return { applied: true, captions: pages.length };
}

module.exports = {
  subtitlesAvailable,
  tryAddSubtitles,
  transcribeToWords,
  buildRollingPages,
  buildKaraokeAss,
  normalizeSubStyle,
};
