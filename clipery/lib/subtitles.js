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
// Rainbow karaoke: the spoken word cycles through this palette, one colour
// per word — party-style captions.
const RAINBOW = ["&H004CE7FF", "&H006D4DFF", "&H00F5D43C", "&H0058D130", "&H004C8AFF", "&H00FF6BA8"];
// MrBeast pop-in captions: punchy yellow-heavy palette, one colour per word.
const BEAST = ["&H004CE7FF", "&H00FFFFFF", "&H003B3BFF", "&H0058D130", "&H004C8AFF", "&H00F5D43C"];
// Styles that shout in UPPERCASE (Hormozi / MrBeast look). Caps are wider,
// so caption rows get 2 fewer characters to stay inside the frame.
const CAPS_STYLES = new Set(["hormozi", "mrbeast"]);
// STATIC decoration looks: plain text, every word in YOUR colour, no karaoke
// fill — the whole block simply changes page by page. These are the calm
// "Styles" tab options; the fancy animated ones live in Templates.
const STATIC_STYLES = new Set(["classic", "plain", "outlined", "thick", "shadow", "boxdark", "boxlight", "boxwhite", "boxred", "boxblack"]);
// Styles with a FORCED text colour (never the user's colour) so the words stay
// readable on their fixed background box.
const FIXED_PRIMARY = { boxwhite: "&H00000000", boxred: "&H00FFFFFF", boxblack: "&H00FFFFFF" };
// Border/decoration per style. Fields after BackColour:
// Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow
const DECO = {
  box: "&H78000000,&H00000000,1,0,0,0,100,100,0,0,3,8,0", // karaoke: translucent dark backdrop box (box colour lives in OutlineColour!)
  boxdark: "&H78000000,&H00000000,1,0,0,0,100,100,0,0,3,8,0", // static: translucent dark box behind text
  boxlight: "&H3C000000,&H00000000,1,0,0,0,100,100,0,0,3,8,0", // static: faint see-through box
  boxwhite: "&H00FFFFFF,&H00000000,1,0,0,0,100,100,0,0,3,8,0", // static: solid WHITE box, black text
  boxred: "&H003B3BFF,&H00000000,1,0,0,0,100,100,0,0,3,8,0", // static: solid RED box, white text
  boxblack: "&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,8,0", // static: solid BLACK box, white text
  pop: "&HFFFFFFFF,&H00000000,1,0,0,0,100,100,0,0,1,0,0", // pop-in: hidden ghosts
  mrbeast: "&HFFFFFFFF,&H00000000,1,0,0,0,100,100,0,0,1,0,0",
  hormozi: "&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0", // thick outline, shouty
  thick: "&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4.5,0", // extra thick stroke
  outlined: "&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2.5,0", // classic black outline
  shadow: "&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,1.5,3", // offset drop shadow
  plain: "&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,1,1", // clean, barely-there edge
};
// Font sizes in script units (PlayRes 384x684 matches our 608x1080 portrait
// canvas exactly, so 1 unit ≈ 1.6 real pixels).
const SUB_SIZES = { small: 26, medium: 30 };
// Max characters per caption row per size → guarantees max 2 rows, no overflow.
const ROW_CHARS = { small: 22, medium: 19 };
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
  const okStyles = ["box", "pop", "highlight", "classic", "rainbow", "hormozi", "mrbeast", "plain", "outlined", "thick", "shadow", "boxdark", "boxlight", "boxwhite", "boxred", "boxblack"];
  return {
    color: pick(input.color, SUB_COLORS, "white"),
    size: pick(input.size, SUB_SIZES, "medium"),
    pos: pick(input.pos, SUB_POSITIONS, "bottom"),
    style: okStyles.includes(st) ? st : "outline",
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
 * Caption pages: words appear one by one, left to right (karaoke).
 * A page starts as ONE row and can grow to a MAXIMUM of 2 rows;
 * once the 2nd row is full, we flip to a fresh page (starting with 1 row again).
 * Row 1 is pinned to the same Y (ASS Alignment 8 + margin from the top edge),
 * so flips never move the top line → zero bouncing, just clean page changes.
 * A long pause (> GAP_SPLIT) also starts a fresh page for the next sentence.
 */
function buildRollingPages(words, rowChars) {
  const pages = [];
  let r1 = [];
  let r2 = [];
  let lastEnd = 0;
  const rowLen = (arr) => arr.reduce((a, x) => a + x.w.length + 1, 0);
  const fits = (arr, word) => rowLen(arr) + word.length <= rowChars && arr.length < ROW_WORDS;

  const closePage = () => {
    if (!r1.length && !r2.length) return;
    pages.push({ r1, r2, intro: true }); // every page is spoken live
    r1 = [];
    r2 = [];
  };

  for (const w of words) {
    if ((r1.length || r2.length) && w.s - lastEnd > GAP_SPLIT) closePage(); // pause → fresh page

    if (!r1.length && !r2.length) {
      r1.push(w);
    } else if (!r2.length) {
      if (fits(r1, w.w)) r1.push(w); // still filling row 1
      else r2.push(w); // row 1 full → row 2 starts below
    } else {
      if (fits(r2, w.w)) {
        r2.push(w);
      } else {
        closePage(); // 2-row max reached → flip to a fresh page
        r1.push(w);
      }
    }
    lastEnd = Math.max(lastEnd, w.e);
  }
  closePage();
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

/* ---------------- AI hook title ---------------- */

const HOOK_POWER = new Set(
  (
    "how why what who when where which secret stop never always everyone nobody this trick mistake wrong " +
    "best worst now watch really actually dont don't can't won't shouldn't should could would new free " +
    "money time thing things people every nobody biggest first last"
  ).split(" ")
);
const HOOK_NUMBERS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|top|\d+)\b/i;
const HOOK_TAIL_STOP = new Set(["and", "but", "so", "then", "the", "a", "an", "to", "of", "with", "for", "or", "my", "your", "will", "can", "is", "are"]);

function trimHookTail(arr) {
  while (arr.length > 2 && HOOK_TAIL_STOP.has(arr[arr.length - 1].w.toLowerCase())) arr.pop();
  return arr;
}

/**
 * Pick the punchiest phrase from the first seconds of a clip as its HOOK.
 * Heuristic: split early speech into phrases at pauses, score for power words,
 * numbers and a punchy length, earliest strong phrase wins. Uppercase result.
 */
function pickHookText(words) {
  const early = words.filter((w) => w.s < 8);
  if (!early.length) return null;

  const phrases = [[]];
  for (const w of early) {
    const cur = phrases[phrases.length - 1];
    if (cur.length && w.s - cur[cur.length - 1].e > 0.5) phrases.push([]);
    phrases[phrases.length - 1].push(w);
  }

  let best = null;
  let bestScore = -1;
  for (const ph of phrases) {
    if (!ph.length || ph.length < 2) continue;
    const waitWords = trimHookTail(ph.slice(0, 7)); // hooks are short
    const text = waitWords.map((w) => w.w).join(" ");
    if (text.length > 40) continue;
    let score = ph[0].s * -0.15; // earlier is better
    for (const w of waitWords) {
      const lw = w.w.toLowerCase();
      if (HOOK_POWER.has(lw)) score += 2;
      if (HOOK_NUMBERS.test(lw)) score += 1.5;
    }
    if (waitWords.length >= 3 && waitWords.length <= 7) score += 1; // punchy length
    if (score > bestScore) {
      bestScore = score;
      best = waitWords.map((w) => w.w).join(" ");
    }
  }
  if (!best) best = early.slice(0, 6).map((w) => w.w).join(" "); // cold-open fallback
  const clean = best.replace(/[{}\\]/g, "").trim();
  return clean ? clean.toUpperCase() : null;
}

/** Split hook text into up to 2 rows (max ~18 chars each), balanced at a word boundary. */
function hookRows(text) {
  if (text.length <= 18) return [text];
  const ws = text.split(" ");
  let r1 = "";
  for (const w of ws) {
    const t = r1 ? r1 + " " + w : w;
    if (t.length > 18 && r1) break;
    r1 = t;
  }
  const r2 = text.slice(r1.length).trim();
  return r2 ? [r1, r2] : [r1];
}

/** Build hook info: text rows + display window. mode "intro" = first seconds, "full" = whole clip. */
function buildHook(words, clipDur, mode) {
  const text = pickHookText(words);
  if (!text) return null;
  const dur = Math.max(clipDur || 0, 0.6);
  const end = mode === "full" ? Math.max(dur - 0.05, 0.6) : Math.min(3.2, Math.max(1.2, dur));
  return { text, rows: hookRows(text), start: 0.1, end };
}

async function probeDuration(p) {
  try {
    const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", p]);
    return parseFloat(JSON.parse(out).format?.duration) || 0;
  } catch {
    return 0;
  }
}

/**
 * Build a complete .ass subtitle file with karaoke word highlighting.
 * \k tags: each word switches from dim (SecondaryColour) to full colour
 * exactly when it is spoken → words fill in left to right, karaoke-style.
 */
function buildKaraokeAss(pages, sub = {}, hook = null) {
  const s = normalizeSubStyle(sub);
  const size = SUB_SIZES[s.size];
  const marginV = SUB_POSITIONS[s.pos];
  const primary = FIXED_PRIMARY[s.style] || SUB_COLORS[s.color];
  // Fields: OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow
  const deco = DECO[s.style] || "&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2.5,0"; // karaoke outline
  // highlight/hormozi = crisp WHITE text, only the spoken words turn into your colour
  // STATIC (classic/plain/outlined/thick/shadow/boxdark/boxlight) = every word in
  // your colour at all times → calm static text, page changes only
  // mrbeast = words pop in coloured, completely hidden until spoken
  const secondary =
    s.style === "pop" || s.style === "mrbeast"
      ? KARAOKE_HIDDEN
      : s.style === "highlight" || s.style === "hormozi"
        ? "&H00FFFFFF"
        : STATIC_STYLES.has(s.style)
          ? primary
          : KARAOKE_DIM;

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
    // Hook title: big bold white with a strong outline, top of frame
    "Style: Hook,DejaVu Sans,33,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,0,8,12,12,78,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = [];
  if (hook && hook.rows && hook.rows.length) {
    const hookText = hook.rows.map((r) => r.replace(/[{}\\]/g, "").trim()).filter(Boolean).join("\\N");
    if (hookText) {
      const col = SUB_COLORS[s.color];
      events.push(
        `Dialogue: 1,${assTime(hook.start)},${assTime(hook.end)},Hook,,0,0,0,,{\\1c${col}}${hookText}`
      );
    }
  }
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

    const palette = s.style === "rainbow" ? RAINBOW : s.style === "mrbeast" ? BEAST : null;
    const caps = CAPS_STYLES.has(s.style);
    // STATIC styles never change colour while speaking → drop the per-word \k
    // karaoke tags, otherwise each word becomes its own box/runt. One clean
    // segment per row = one continuous background box around the whole text.
    const wholeBox = STATIC_STYLES.has(s.style);
    const fmtWord = (w) => cleanWord(caps ? String(w).toUpperCase() : w);
    let wordIdx = i * 10; // colour cycle keeps marching across pages
    const wordTag = (cs) =>
      palette ? `{\\1c${palette[wordIdx++ % palette.length]}\\k${cs}}` : `{\\k${cs}}`;

    const parts = [];
    for (const w of staticRow) parts.push(wholeBox ? fmtWord(w.w) : `${wordTag(5)}${fmtWord(w.w)}`); // already spoken → lit at once
    let prevStart = null;
    for (const w of liveRow) {
      let cs = prevStart === null ? Math.round((w.s - evStart) * 100) : Math.round((w.s - prevStart) * 100);
      if (cs < 5) cs = 5;
      parts.push(wholeBox ? fmtWord(w.w) : `${wordTag(cs)}${fmtWord(w.w)}`);
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
 * Full pass in ONE transcription: karaoke captions and/or an AI hook title.
 * opts: { clipDur?, subStyle|null, hook: {enabled, mode:"intro"|"full"}|null }
 * Keeps the .ass next to the video (downloadable captions file). Never throws.
 */
async function tryEnhanceClip(videoPath, opts = {}) {
  const wantSubs = !!opts.subStyle;
  const wantHook = !!(opts.hook && opts.hook.enabled !== false);
  if (!wantSubs && !wantHook) return { applied: false, reason: "nothing-requested" };
  if (!subtitlesAvailable()) return { applied: false, reason: "engine-missing" };

  const noExt = videoPath.replace(/\.mp4$/i, "");
  const jsonPath = noExt + ".words.json";
  const assPath = noExt + ".subtitles.ass";

  const n = await transcribeToWords(videoPath, jsonPath);
  let words = [];
  if (n) {
    try {
      words = JSON.parse(fs.readFileSync(jsonPath, "utf8")).words || [];
    } catch {}
  }
  try { fs.unlinkSync(jsonPath); } catch {}

  let pages = [];
  if (wantSubs && words.length) {
    const style = normalizeSubStyle(opts.subStyle);
    const rowChars = ROW_CHARS[style.size] - (CAPS_STYLES.has(style.style) ? 2 : 0);
    pages = buildRollingPages(words, rowChars);
  }

  let hook = null;
  if (wantHook && words.length) {
    const dur = opts.clipDur || (await probeDuration(videoPath));
    hook = buildHook(words, dur, (opts.hook && opts.hook.mode) || "intro");
  }

  if (!pages.length && !hook) {
    return { applied: false, reason: "no-speech-detected" };
  }

  fs.writeFileSync(assPath, buildKaraokeAss(pages, opts.subStyle || {}, hook), "utf8");
  const applied = await burnAss(videoPath, assPath);
  if (!applied) {
    try { fs.unlinkSync(assPath); } catch {}
    return { applied: false, reason: "burn-failed" };
  }
  return {
    applied: true,
    captions: pages.length,
    subtitlesApplied: pages.length > 0,
    hookApplied: !!hook,
    hookText: hook ? hook.text : null,
  };
}

/** Backwards-compatible wrapper: subtitles only. */
async function tryAddSubtitles(videoPath, subStyle = {}) {
  const r = await tryEnhanceClip(videoPath, { subStyle });
  if (!r.applied) return { applied: false, reason: r.reason };
  return { applied: true, captions: r.captions };
}

module.exports = {
  subtitlesAvailable,
  tryAddSubtitles,
  tryEnhanceClip,
  transcribeToWords,
  buildRollingPages,
  buildKaraokeAss,
  buildHook,
  pickHookText,
  normalizeSubStyle,
};
