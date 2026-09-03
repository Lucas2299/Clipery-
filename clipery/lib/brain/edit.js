/**
 * BRAIN 3 - Video editor.
 *
 * Answers: "How should this moment actually become a Short?"
 *
 * Takes a rough window plus what Brain 1 and Brain 2 found, and produces one
 * edit decision:
 *   start / end   - exact cut points (story edges, sentence start, pauses)
 *   layout        - follow / static / wide / center, and the camera path
 *   speaker       - where the subject sits
 *   captions      - on/off and which words to emphasise
 *   emphasis      - the line the whole clip is built around (for the hook)
 *   trims         - dead-air stretches inside the clip worth cutting later
 *
 * The heavy lifting (reframe maths, silence detection, ASS building) lives in
 * the modules that already do it well; this file only decides. It has no
 * ffmpeg in it, so it is unit-testable.
 */

"use strict";

const signals = require("../brain");
const story = require("../story");
const { reframeFilter } = require("../reframe");

/**
 * Decide the exact cut for a candidate.
 *
 * @param {object} o
 * @param {Array} o.words      whisper words for the whole video (may be null)
 * @param {number} o.start     rough start
 * @param {number} o.end       rough end
 * @param {number} o.duration  source duration
 * @param {object} o.mode      {targetMin, targetMax}
 * @param {Array}  o.silences  [{start,end}] from ffmpeg silencedetect (optional)
 * @returns {{start:number,end:number,anchor:string|null,reasons:string[],changed:boolean}}
 */
function decideCut(o) {
  const mode = o.mode || { targetMin: 30, targetMax: 50 };
  let start = o.start;
  let end = o.end;
  const reasons = [];
  let anchor = null;

  if (Array.isArray(o.words) && o.words.length) {
    // 1. Story edges: enough setup to care, run on until the payoff lands.
    const arc = story.findArc(o.words, start, end, {
      min: mode.targetMin,
      max: mode.targetMax,
      duration: o.duration,
    });
    if (arc && arc.end - arc.start >= mode.targetMin * 0.85) {
      const before = story.arcScore(o.words, start, end).score;
      const after = story.arcScore(o.words, arc.start, arc.end).score;
      if (after + 2 >= before) {
        start = arc.start;
        end = arc.end;
        anchor = arc.anchor ? arc.anchor.text : null;
        reasons.push(...(arc.reasons || []));
      }
    }
    // 2. Never open mid-word; prefer the strongest opening line nearby.
    const snapped = signals.snapToSentence(o.words, start, end);
    if (snapped !== start && end - snapped >= mode.targetMin * 0.9) start = snapped;
  }

  // 3. Breathe: begin right after a pause, stop at a pause.
  if (Array.isArray(o.silences) && o.silences.length) {
    const s = snapToSilence(o.silences, start, end, o.duration);
    start = s.start;
    end = s.end;
  }

  return {
    start: +start.toFixed(2),
    end: +Math.min(end, o.duration || end).toFixed(2),
    anchor,
    reasons,
    changed: start !== o.start || end !== o.end,
  };
}

/** Move [start,end] to nearby silence edges (same rules the engine used). */
function snapToSilence(sils, start, end, totalDur) {
  let ns = start;
  let cand = null;
  for (const s of sils) {
    if (s.end > start && s.end <= start + 1.6 && s.start <= start + 1.6) cand = s.end;
  }
  if (cand !== null && end - cand >= 6) ns = cand;

  let ne = end;
  cand = null;
  for (const s of sils) {
    if (s.start >= end - 2.2 && s.start <= end) cand = s.start;
  }
  if (cand !== null && cand - ns >= 6) ne = cand;

  ne = Math.min(ne, totalDur || ne);
  if (ne - ns < 6) return { start, end };
  return { start: +ns.toFixed(2), end: +ne.toFixed(2) };
}

/**
 * Dead-air stretches inside the clip. Not cut yet (that is a later step),
 * but reported so the studio can show "3s of silence could be trimmed".
 */
function deadAir(words, start, end, minGap = 1.6) {
  const list = signals.wordsIn(words, start, end);
  const gaps = [];
  for (let i = 1; i < list.length; i++) {
    const a = Number(list[i - 1].e || list[i - 1].s);
    const b = Number(list[i].s);
    if (b - a >= minGap) gaps.push({ from: +a.toFixed(2), to: +b.toFixed(2), secs: +(b - a).toFixed(2) });
  }
  return gaps;
}

/**
 * Words worth emphasising in the captions: numbers, strong feeling words,
 * negations and superlatives. Returned as lower-case strings.
 */
const EMPHASIS = /^(\$?\d[\d.,]*[km%]?|never|always|nobody|everyone|biggest|worst|best|only|insane|crazy|lost|won|failed|hate|love|secret|truth|free|million|billion|thousand|hundred)$/i;
function emphasisWords(words, start, end) {
  const list = signals.wordsIn(words, start, end);
  const out = new Set();
  for (const w of list) {
    const t = String(w.w || "").replace(/[^a-z0-9$%.,]/gi, "");
    if (t && EMPHASIS.test(t)) out.add(t.toLowerCase());
  }
  return [...out].slice(0, 12);
}

/**
 * Framing decision for a clip from its detector track.
 * Thin wrapper over reframe.js so the decision lives with the other edits.
 */
function decideFraming(track, srcW, srcH, outW = 608, outH = 1080) {
  const rf = reframeFilter({ samples: track || [], srcW, srcH, outW, outH });
  const seen = (track || []).filter((s) => s && Number.isFinite(s.x));
  const xs = seen.map((s) => s.x).sort((a, b) => a - b);
  return {
    layout: rf.layout,
    filter: rf.filter,
    keys: rf.keys,
    moves: rf.keys.length > 1 ? rf.keys.length - 1 : 0,
    speakerX: xs.length ? +xs[Math.floor(xs.length / 2)].toFixed(3) : null,
    people: seen.length ? Math.max(...seen.map((s) => s.faces || 1)) : 0,
  };
}

/**
 * The whole edit plan for one clip, as one object the studio can show.
 */
function plan(o) {
  const cut = decideCut(o);
  const words = Array.isArray(o.words) ? o.words : null;
  const gaps = words ? deadAir(words, cut.start, cut.end) : [];
  return {
    start: cut.start,
    end: cut.end,
    duration: +(cut.end - cut.start).toFixed(2),
    anchor: cut.anchor,
    reasons: cut.reasons,
    captions: !!(o.captions && words),
    emphasis: words ? emphasisWords(words, cut.start, cut.end) : [],
    deadAir: gaps,
    trimmable: +gaps.reduce((a, g) => a + Math.max(0, g.secs - 0.6), 0).toFixed(1),
  };
}

/* ------------------------------------------------------------------ *
 * Punch-in: a gentle zoom on the line the clip is built around
 * ------------------------------------------------------------------ */

/**
 * Where the anchor sentence sits inside the clip, from the clip's own word
 * timings (clip-relative seconds). Returns {from,to} or null.
 */
function locateLine(words, lineText, clipDur) {
  if (!Array.isArray(words) || !words.length || !lineText) return null;
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const target = norm(lineText).split(" ").filter(Boolean);
  if (target.length < 3) return null;
  const ws = words.map((w) => norm(w.w));
  const key = target.slice(0, 3).join(" ");
  for (let i = 0; i + 2 < ws.length; i++) {
    if (ws[i] + " " + ws[i + 1] + " " + ws[i + 2] !== key) continue;
    const j = Math.min(words.length - 1, i + target.length - 1);
    const from = Number(words[i].s);
    const to = Number(words[j].e || words[j].s) + 0.3;
    if (to <= from || from < 0 || (clipDur && from > clipDur)) return null;
    return { from: +from.toFixed(2), to: +Math.min(to, clipDur || to).toFixed(2) };
  }
  return null;
}

/**
 * ffmpeg filter that zooms in `amount` (0.08 = 8%) between `from` and `to`,
 * easing in and out over `ramp` seconds. Goes AFTER the 9:16 crop/scale so it
 * works for every layout, and keeps the frame size unchanged. It is one
 * per-frame scale + centre crop: cheap, unlike zoompan.
 */
function punchInFilter(from, to, outW, outH, amount = 0.08, ramp = 0.35) {
  if (!(to > from)) return null;
  const n2 = (v) => (Math.round(v * 100) / 100).toString();
  const rise = `min(1\\,max(0\\,(t-${n2(from)})/${n2(ramp)}))`;
  const fall = `min(1\\,max(0\\,(${n2(to)}-t)/${n2(ramp)}))`;
  const z = `(1+${n2(amount)}*${rise}*${fall})`;
  return (
    `scale=w='trunc(${outW}*${z}/2)*2':h='trunc(${outH}*${z}/2)*2':eval=frame,` +
    `crop=${outW}:${outH}`
  );
}

/* ------------------------------------------------------------------ *
 * Dead-air trim: drop long silent stretches inside the clip
 * ------------------------------------------------------------------ */

/**
 * Which stretches to remove. Keeps `keep` seconds of each pause so speech
 * still breathes, never cuts the first or last second, and gives up if the
 * cuts would remove more than a third of the clip (that is a bad clip, not
 * a trimming job).
 */
function trimPlan(gaps, clipDur, opts = {}) {
  const keep = opts.keep != null ? opts.keep : 0.5;
  const minCut = opts.minCut != null ? opts.minCut : 0.9;
  const cuts = [];
  for (const g of gaps || []) {
    const from = g.from + keep / 2;
    const to = g.to - keep / 2;
    if (to - from < minCut) continue;
    if (from < 1 || to > clipDur - 1) continue;
    cuts.push({ from: +from.toFixed(2), to: +to.toFixed(2) });
  }
  const removed = cuts.reduce((a, c) => a + (c.to - c.from), 0);
  if (!cuts.length || removed > clipDur / 3) return { cuts: [], removed: 0 };
  return { cuts, removed: +removed.toFixed(2) };
}

/**
 * Video + audio select expressions that skip the cut ranges, with timestamps
 * re-based so the result plays continuously. `t` here is the clip-relative
 * time because the input was already seeked with -ss.
 */
function trimFilters(cuts) {
  if (!cuts || !cuts.length) return null;
  const n2 = (v) => (Math.round(v * 100) / 100).toString();
  const keepExpr = cuts.map((c) => `between(t\\,${n2(c.from)}\\,${n2(c.to)})`).join("+");
  return {
    video: `select='not(${keepExpr})',setpts=N/FRAME_RATE/TB`,
    audio: `aselect='not(${keepExpr})',asetpts=N/SR/TB`,
  };
}

/**
 * Shift the caption timings so they still line up after the cuts.
 * Words that fall inside a removed range snap to the cut point.
 */
function shiftWords(words, cuts) {
  if (!cuts || !cuts.length) return words;
  const shift = (t) => {
    let d = 0;
    for (const c of cuts) {
      if (t >= c.to) d += c.to - c.from;
      else if (t > c.from) d += t - c.from;
    }
    return +(t - d).toFixed(3);
  };
  return (words || []).map((w) => ({ ...w, s: shift(Number(w.s)), e: shift(Number(w.e != null ? w.e : w.s)) }));
}

module.exports = {
  decideCut,
  snapToSilence,
  deadAir,
  emphasisWords,
  decideFraming,
  plan,
  locateLine,
  punchInFilter,
  trimPlan,
  trimFilters,
  shiftWords,
};
