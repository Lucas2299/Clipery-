/**
 * Clipery brain - decides WHICH moments deserve to be clips.
 *
 * The old scorer only listened to the audio waveform (loud = good). That is why
 * it kept missing the actual bangers: a calm sentence like "I lost a hundred
 * thousand dollars on that one mistake" is quiet, but it is the best 40 seconds
 * in the whole podcast.
 *
 * This module reads the transcript and scores each candidate window on four
 * families of signals:
 *
 *   content  - is something actually being SAID? story, payoff, numbers,
 *              surprising claim, conflict, useful how-to
 *   speech   - how it is being said: excitement, laughter, emphasis, pace
 *              changes, a dramatic pause before the punchline
 *   visual   - scene cuts, people entering/leaving frame, demonstrations
 *   hook     - would the first 3 seconds stop a thumb?
 *
 * Everything here is plain text analysis: no model download, no API key, works
 * offline. When there is no transcript at all the caller just falls back to the
 * audio-only scores.
 */

"use strict";

/* ------------------------------------------------------------------ *
 * word helpers
 * ------------------------------------------------------------------ */

/** Words that land inside [start, end). `words` is whisper output: {w, s, e}. */
function wordsIn(words, start, end) {
  if (!Array.isArray(words)) return [];
  const out = [];
  for (const w of words) {
    const s = Number(w.s);
    if (s >= end) break;
    if (s >= start) out.push(w);
  }
  return out;
}

function textOf(list) {
  return list
    .map((w) => String(w.w || ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a window into sentence-ish chunks using punctuation and long gaps. */
function sentences(list) {
  const out = [];
  let cur = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    cur.push(w);
    const txt = String(w.w || "");
    const next = list[i + 1];
    const gap = next ? Number(next.s) - Number(w.e || w.s) : 0;
    if (/[.!?]"?$/.test(txt) || gap > 0.75) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const count = (text, re) => (text.match(re) || []).length;

/* ------------------------------------------------------------------ *
 * 1. HOOK QUALITY - the first ~3 seconds
 * ------------------------------------------------------------------ */

/**
 * Openers that kill a short before it starts. "So today we're going to talk
 * about..." is the classic.
 */
const WEAK_OPENERS = [
  /^(so|and|but|um+|uh+|okay|ok|right|well|anyway|yeah)\b/i,
  /\b(today (we're|we are|i'm|i am) (going to|gonna) (talk|discuss|cover|look)\b)/i,
  /\b(welcome (back )?to|hey guys|what's up guys|in this video|before we (start|begin))\b/i,
  /\b(as i (said|mentioned)|like i was saying|continuing (on|from))\b/i,
  /\b(thanks for (watching|having me)|don't forget to (like|subscribe))\b/i,
];

/** Openers that earn attention. Stakes, numbers, conflict, curiosity. */
const STRONG_OPENERS = [
  { re: /\b(i|we|he|she|they)\s+(lost|made|spent|blew|earned|wasted|saved)\b/i, pts: 16, why: "personal stakes" },
  { re: /\$\s?\d|\b\d+([.,]\d+)?\s?(k|m|bn|billion|million|thousand|dollars|euros|percent|%)\b|\b(hundred|thousand|million|billion)\s+(thousand\s+)?(dollars|euros|pounds|users|people|subscribers)?\b/i, pts: 14, why: "a real number" },
  { re: /\b(nobody|no one|everyone|everybody)\s+(tells|talks|knows|thinks|says|realises|realizes)\b/i, pts: 15, why: "contrarian claim" },
  { re: /\b(the (biggest|worst|best|number one|#1|hardest|weirdest|dumbest))\b/i, pts: 12, why: "superlative" },
  { re: /\b(mistake|mistakes|failed|failure|fired|quit|scam|lawsuit|arrested|divorce|betrayed)\b/i, pts: 13, why: "conflict or failure" },
  { re: /\b(secret|truth|really happened|behind the scenes|they don't want|hidden)\b/i, pts: 12, why: "curiosity gap" },
  { re: /^(what|why|how|when|who)\b.*\?/i, pts: 11, why: "opens with a question" },
  { re: /\b(never|always|stop|don't ever|you need to|you have to|here's how)\b/i, pts: 10, why: "direct advice" },
  { re: /\b(imagine|picture this|think about it|let me tell you)\b/i, pts: 9, why: "invites you in" },
  { re: /\b(crazy|insane|shocking|unbelievable|wild|terrifying)\b/i, pts: 9, why: "high emotion" },
  { re: /\b(i (was|were) (so|really|completely)? ?(scared|broke|wrong|shocked|angry))\b/i, pts: 11, why: "vulnerable admission" },
];

/**
 * Score the opening line of a clip, 0..100.
 * Compare: "So today we're going to talk about savings" (weak) vs
 * "I lost $100,000 because I made this one mistake" (strong).
 */
function hookQuality(openingText) {
  const text = String(openingText || "").trim();
  if (!text) return { score: 50, reasons: [], strong: [], weak: [] };

  let score = 52;
  const strong = [];
  const weak = [];

  for (const o of STRONG_OPENERS) {
    if (o.re.test(text)) {
      score += o.pts;
      strong.push(o.why);
    }
  }
  for (const re of WEAK_OPENERS) {
    if (re.test(text)) {
      score -= 14;
      weak.push("slow open");
    }
  }

  // Starting mid-thought ("...and then he said") reads as a broken clip.
  if (/^(and|but|so|because|which|that's why|then)\b/i.test(text)) score -= 8;
  // A complete, punchy first sentence is worth a lot.
  const firstSentence = text.split(/[.!?]/)[0] || text;
  const fw = firstSentence.trim().split(/\s+/).length;
  if (fw >= 4 && fw <= 14) score += 8;
  else if (fw > 26) score -= 6;
  // Filler density at the very top.
  const fillers = count(text, /\b(um+|uh+|like|you know|kind of|sort of|basically|literally)\b/gi);
  score -= Math.min(12, fillers * 4);
  // Speaking straight to the viewer.
  if (/\byou('re|r| are| can| should| need| will)?\b/i.test(text)) score += 5;

  return {
    score: Math.max(5, Math.min(99, Math.round(score))),
    strong: [...new Set(strong)],
    weak: [...new Set(weak)],
  };
}

/* ------------------------------------------------------------------ *
 * 2. CONTENT - what is actually being said
 * ------------------------------------------------------------------ */

const CONTENT_RULES = [
  { key: "story", re: /\b(when i|one day|back in|the first time|so i|there was|at the time|years ago|last (year|week|month))\b/gi, pts: 9, why: "tells a story" },
  { key: "payoff", re: /\b(and that's (why|how|when)|turns out|the (result|lesson|point) (is|was)|ended up|in the end|finally|so the answer)\b/gi, pts: 12, why: "has a payoff" },
  { key: "surprise", re: /\b(actually|but here's the thing|plot twist|you'd think|what nobody|surprisingly|to my surprise|out of nowhere)\b/gi, pts: 11, why: "surprising turn" },
  { key: "conflict", re: /\b(disagree|wrong|that's not true|i pushed back|argument|fight|hate|refuse|no way|absolutely not)\b/gi, pts: 10, why: "disagreement" },
  { key: "info", re: /\b(here's how|the trick is|step (one|two|1|2)|you should|the way to|what worked|my rule|framework|strategy)\b/gi, pts: 9, why: "useful takeaway" },
  { key: "claim", re: /\b(most people|the reality is|the truth is|in my experience|i believe|i'd argue|fact is)\b/gi, pts: 7, why: "strong claim" },
  { key: "numbers", re: /\$\s?\d|\b\d+([.,]\d+)?\s?(k|m|x|%|percent|million|billion|thousand|hours|days|years|dollars)\b|\b(hundred|thousand|million|billion)\b/gi, pts: 8, why: "concrete numbers" },
  { key: "emotion", re: /\b(scared|terrified|devastated|proud|embarrassed|furious|heartbroken|obsessed|desperate)\b/gi, pts: 8, why: "emotional beat" },
  { key: "question", re: /\?/g, pts: 4, why: "asks a question" },
];

/** Sentences that answer a question asked earlier in the same window. */
function hasQuestionAnswer(list) {
  const sents = sentences(list).map((s) => textOf(s));
  for (let i = 0; i < sents.length - 1; i++) {
    if (/\?$/.test(sents[i]) && sents.slice(i + 1).join(" ").split(/\s+/).length >= 8) return true;
  }
  return false;
}

function contentSignals(text, list) {
  let score = 45;
  const hits = {};
  const reasons = [];

  for (const rule of CONTENT_RULES) {
    const n = count(text, rule.re);
    if (!n) continue;
    hits[rule.key] = n;
    score += Math.min(rule.pts * 2, rule.pts * Math.sqrt(n));
    reasons.push(rule.why);
  }
  if (hasQuestionAnswer(list)) {
    score += 10;
    reasons.push("question then answer");
  }

  // Substance check: a window of "yeah, right, exactly, mhm" is not a clip.
  const wordCount = list.length;
  const unique = new Set(text.toLowerCase().replace(/[^a-z' ]/g, "").split(/\s+/).filter(Boolean));
  const richness = unique.size / Math.max(1, wordCount);
  if (wordCount < 25) score -= 18;
  else if (richness < 0.45) score -= 8;
  else if (richness > 0.62) score += 5;

  const filler = count(text, /\b(um+|uh+|you know|i mean|kind of|sort of|basically)\b/gi);
  score -= Math.min(14, (filler / Math.max(1, wordCount / 40)) * 4);

  return { score: Math.max(5, Math.min(99, Math.round(score))), hits, reasons };
}

/* ------------------------------------------------------------------ *
 * 3. SPEECH - how it is delivered
 * ------------------------------------------------------------------ */

function speechSignals(list, energy, stats) {
  const reasons = [];
  let score = 50;

  const span = list.length ? Number(list[list.length - 1].e || list[list.length - 1].s) - Number(list[0].s) : 0;
  const wpm = span > 1 ? (list.length / span) * 60 : 0;

  // Pace: fast talking is exciting, dead air is not.
  if (wpm >= 170) {
    score += 10;
    reasons.push("fast, energetic delivery");
  } else if (wpm >= 130) score += 5;
  else if (wpm > 0 && wpm < 85) {
    score -= 8;
    reasons.push("slow patch");
  }

  // A long pause right before a line is a drum roll.
  let dramatic = 0;
  for (let i = 1; i < list.length; i++) {
    const gap = Number(list[i].s) - Number(list[i - 1].e || list[i - 1].s);
    if (gap >= 0.8 && gap <= 2.5) dramatic++;
  }
  if (dramatic) {
    score += Math.min(8, dramatic * 3);
    reasons.push("dramatic pause");
  }

  // Dead air ruins retention.
  let dead = 0;
  for (let i = 1; i < list.length; i++) {
    const gap = Number(list[i].s) - Number(list[i - 1].e || list[i - 1].s);
    if (gap > 3) dead += gap;
  }
  if (dead > 4) {
    score -= Math.min(20, dead * 2);
    reasons.push("dead air");
  }

  const text = textOf(list);
  if (/\b(haha|hahaha|laughs|laughing|lol)\b/i.test(text)) {
    score += 9;
    reasons.push("laughter");
  }
  const exclaims = count(text, /!/g);
  if (exclaims >= 2) {
    score += 6;
    reasons.push("excited delivery");
  }
  // Emphasis: repeated words ("no no no", "huge, huge") and all-caps shouting.
  if (/\b(\w+)\s+\1\b(\s+\1\b)?/i.test(text)) {
    score += 5;
    reasons.push("emphasis");
  }

  // Tone change vs the rest of the video (audio, not text).
  if (energy && stats) {
    const jump = energy.punch - stats.avgPunch;
    if (jump > 8) {
      score += Math.min(12, jump * 0.6);
      reasons.push("voice lifts here");
    } else if (jump < -10) score -= 6;
  }

  return { score: Math.max(5, Math.min(99, Math.round(score))), wpm: Math.round(wpm), reasons };
}

/* ------------------------------------------------------------------ *
 * 4. VISUALS
 * ------------------------------------------------------------------ */

/**
 * @param sceneTimes  all scene-cut timestamps of the source
 * @param faceTrack   optional [{t, faces}] samples from the face detector
 */
/**
 * How much things MOVE in this window compared with the rest of the video.
 * The detector attaches a `motion` reading (0..100) to every sample; a
 * talking head sits around 5-15, someone jumping around or fast gameplay
 * goes 40+. Everything is measured against this video's own median, so a
 * shaky vlog is not "all action" and a still podcast can still have peaks.
 *
 * @returns {{level:number, rel:number, bonus:number, reason:string|null}|null}
 */
function motionSignals(start, end, faceTrack) {
  const all = (faceTrack || []).filter((s) => s && Number.isFinite(s.motion));
  if (all.length < 6) return null;
  const inside = all.filter((s) => s.t >= start && s.t <= end);
  if (inside.length < 2) return null;
  const sorted = all.map((s) => s.motion).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const level = inside.reduce((a, s) => a + s.motion, 0) / inside.length;
  const peak = Math.max(...inside.map((s) => s.motion));
  const rel = level - median;

  let bonus = 0;
  let reason = null;
  if (rel >= 20 || (rel >= 10 && peak >= 60)) {
    bonus = 16;
    reason = "lots of action / movement";
  } else if (rel >= 8) {
    bonus = 9;
    reason = "more movement than usual";
  } else if (peak >= median + 35) {
    bonus = 7; // one big burst (a jump, a hit, a fall) inside a calm clip
    reason = "sudden burst of action";
  } else if (rel <= -10 && median >= 12) {
    bonus = -6; // the dull part of an otherwise lively video
  }
  return { level: Math.round(level), rel: Math.round(rel), peak: Math.round(peak), bonus, reason };
}

function visualSignals(start, end, sceneTimes, faceTrack) {
  const len = Math.max(1, end - start);
  const cuts = (sceneTimes || []).filter((t) => t > start && t < end).length;
  const perMin = (cuts / len) * 60;
  const reasons = [];
  let score = 50;

  // Real movement in the picture, not just editing cuts.
  const motion = motionSignals(start, end, faceTrack);
  if (motion) {
    score += motion.bonus;
    if (motion.reason) reasons.unshift(motion.reason);
  }

  if (perMin >= 6 && perMin <= 30) {
    score += 12;
    reasons.push("visually active");
  } else if (perMin > 30) {
    score += 4; // frantic, could just be a montage
  } else if (perMin < 1 && !(motion && motion.bonus > 0)) {
    // No cuts AND nothing moving. (Plenty of movement inside one long take
    // is action, not a static shot.)
    score -= 6;
    reasons.push("static shot");
  }

  // Someone entering or leaving frame = reaction / demonstration moment.
  const samples = (faceTrack || []).filter((s) => s.t >= start && s.t <= end);
  if (samples.length >= 3) {
    const counts = samples.map((s) => s.faces || 0);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (max > min) {
      score += 8;
      reasons.push(max > 1 ? "reaction shot / second person" : "someone enters frame");
    }
    if (min >= 1) score += 4; // a face on screen the whole time holds attention
  }

  return { score: Math.max(5, Math.min(99, Math.round(score))), cuts, reasons, motion };
}

/* ------------------------------------------------------------------ *
 * 5. Put it together
 * ------------------------------------------------------------------ */

/**
 * Score one candidate window with every transcript signal we have.
 * Returns null when there is no transcript (caller keeps the audio-only score).
 */
function analyzeMoment(opts) {
  const { words, start, end, energy, stats, sceneTimes, faceTrack, mode } = opts;
  const list = wordsIn(words, start, end);
  if (list.length < 6) return null;

  const text = textOf(list);
  const opening = textOf(wordsIn(words, start, Math.min(end, start + 3.5)));

  const hook = hookQuality(opening);
  const content = contentSignals(text, list);
  const speech = speechSignals(list, energy, stats);
  const visual = visualSignals(start, end, sceneTimes, faceTrack);

  const isViral = !mode || mode.id === "viral";
  const brain = isViral
    ? hook.score * 0.32 + content.score * 0.28 + speech.score * 0.21 + visual.score * 0.19
    : content.score * 0.36 + hook.score * 0.22 + speech.score * 0.21 + visual.score * 0.21;

  const reasons = [];
  if (hook.strong.length) reasons.push("Hook: " + hook.strong.slice(0, 2).join(" + "));
  else if (hook.weak.length) reasons.push("Weak opening line");
  reasons.push(...content.reasons.slice(0, 2).map((r) => r[0].toUpperCase() + r.slice(1)));
  reasons.push(...speech.reasons.slice(0, 1).map((r) => r[0].toUpperCase() + r.slice(1)));
  reasons.push(...visual.reasons.slice(0, 1).map((r) => r[0].toUpperCase() + r.slice(1)));

  return {
    brain: Math.round(brain),
    hook: hook.score,
    content: content.score,
    speech: speech.score,
    visual: visual.score,
    motion: visual.motion ? visual.motion.level : null,
    wpm: speech.wpm,
    quote: firstLine(list),
    reasons: reasons.filter(Boolean).slice(0, 4),
  };
}

/** A short quote so the user can see WHY a clip was picked. */
function firstLine(list) {
  const s = sentences(list)[0] || list.slice(0, 14);
  const t = textOf(s);
  return t.length > 90 ? t.slice(0, 87).trim() + "..." : t;
}

/**
 * Nudge a clip's start onto a clean sentence boundary so it never opens
 * mid-word, and prefer the strongest hook line within a couple of seconds.
 */
function snapToSentence(words, start, end, maxShift = 2.5) {
  const list = wordsIn(words, Math.max(0, start - maxShift), Math.min(end, start + maxShift));
  if (list.length < 3) return start;

  const starts = [];
  for (let i = 0; i < list.length; i++) {
    const prev = list[i - 1];
    if (!prev) {
      starts.push(Number(list[i].s));
      continue;
    }
    const gap = Number(list[i].s) - Number(prev.e || prev.s);
    if (/[.!?]"?$/.test(String(prev.w || "")) || gap > 0.5) starts.push(Number(list[i].s));
  }
  if (!starts.length) return start;

  let best = start;
  let bestScore = -Infinity;
  for (const s of starts) {
    if (s >= end - 5) continue;
    const opening = textOf(wordsIn(words, s, s + 3.5));
    if (!opening) continue;
    const q = hookQuality(opening).score - Math.abs(s - start) * 3; // small shifts only
    if (q > bestScore) {
      bestScore = q;
      best = s;
    }
  }
  return +Math.max(0, best - 0.15).toFixed(2); // tiny lead-in so no word is clipped
}

module.exports = {
  analyzeMoment,
  hookQuality,
  contentSignals,
  speechSignals,
  visualSignals,
  motionSignals,
  snapToSentence,
  wordsIn,
  textOf,
  sentences,
};
