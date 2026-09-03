/**
 * BRAIN 2 - Clip quality / virality.
 *
 * Answers: "Would someone actually keep watching this?"
 *
 * Eight scores, each 0..100:
 *   hook        - do the first 3 seconds stop the thumb?
 *   curiosity   - does it open a question the viewer wants answered?
 *   emotion     - feeling, laughter, stakes, vulnerability
 *   value       - does the viewer walk away with something?
 *   completion  - is it a whole thought, start to finish?
 *   surprise    - a turn the viewer did not see coming
 *   payoff      - does the ending land?
 *   retention   - pace, dead air, movement, energy: reasons to keep watching
 *
 * Combined into one ranking score with weights per mode. Brain 1's reading
 * goes in, Brain 2 never looks at the transcript itself.
 */

"use strict";

const signals = require("../brain");

const pct = (v) => Math.max(5, Math.min(99, Math.round(v)));

const WEIGHTS = {
  viral: { hook: 0.2, curiosity: 0.12, emotion: 0.12, value: 0.08, completion: 0.12, surprise: 0.1, payoff: 0.12, retention: 0.14 },
  ranked: { hook: 0.14, curiosity: 0.1, emotion: 0.1, value: 0.16, completion: 0.16, surprise: 0.08, payoff: 0.12, retention: 0.14 },
};

/**
 * @param {object} o
 * @param {object|null} o.understanding  Brain 1 output (null = no speech)
 * @param {Array} o.words                whisper words (for hook + speech)
 * @param {number} o.start  @param {number} o.end
 * @param {object} o.energy  {energy,punch} for this window
 * @param {object} o.stats   {avgEnergy,avgPunch} for the video
 * @param {Array} o.sceneTimes
 * @param {Array} o.faceTrack
 * @param {object} o.mode
 */
function score(o) {
  const u = o.understanding;
  const list = signals.wordsIn(o.words, o.start, o.end);
  const opening = signals.textOf(signals.wordsIn(o.words, o.start, Math.min(o.end, o.start + 3.5)));
  const hookQ = signals.hookQuality(opening);
  const speech = signals.speechSignals(list, o.energy, o.stats);
  const visual = signals.visualSignals(o.start, o.end, o.sceneTimes, o.faceTrack);
  const motion = visual.motion;

  const dims = {};
  const why = [];

  // HOOK - the opener, plus a bonus when the clip opens on the tension.
  dims.hook = pct(hookQ.score + (u && u.conflict >= 65 && u.setup < 50 ? 4 : 0));
  if (hookQ.strong.length) why.push("Hook: " + hookQ.strong.slice(0, 2).join(" + "));
  else if (hookQ.weak.length) why.push("Weak opening line");

  // CURIOSITY - an open question, a claim to be proven, a story just started.
  {
    let c = 40;
    if (/\?/.test(opening)) c += 22;
    if (u) {
      if (u.claim >= 65) c += 14;
      if (u.story >= 65 && u.conclusion < 60) c += 8; // still unfolding
      if (u.setup >= 70 && u.conflict >= 50) c += 12; // "so here is the situation... but"
      if (u.punchline >= 60) c += 6;
    }
    if (/\b(here's|the secret|nobody|what nobody|the truth|until)\b/i.test(opening)) c += 10;
    dims.curiosity = pct(c);
    if (dims.curiosity >= 75) why.push("Makes you want the answer");
  }

  // EMOTION
  {
    let e = 35;
    if (u) e += u.emotional * 0.35 + u.reaction * 0.2 + u.conflict * 0.1;
    if (speech.reasons.includes("laughter")) e += 10;
    if (speech.reasons.includes("voice lifts here")) e += 8;
    dims.emotion = pct(e);
    if (dims.emotion >= 72) why.push("Emotional moment");
  }

  // VALUE - what the viewer takes away.
  {
    let v = 35;
    if (u) v += u.educational * 0.4 + u.claim * 0.15 + u.conclusion * 0.1;
    dims.value = pct(v);
    if (dims.value >= 72) why.push("Useful takeaway");
  }

  // COMPLETION - whole thought, clean edges.
  {
    let k = u ? u.selfContained : 40;
    if (u && u.missing.length === 0) k += 10;
    if (u && u.missing.includes("cut off at the end")) k -= 6;
    dims.completion = pct(k);
    if (u && u.missing.length) why.push(cap(u.missing[0]));
    else if (dims.completion >= 75) why.push("Complete thought");
  }

  // SURPRISE
  {
    let s = 30;
    if (u) s += u.punchline * 0.45 + u.reaction * 0.15;
    if (speech.reasons.includes("dramatic pause")) s += 8;
    if (motion && motion.reason === "sudden burst of action") s += 12;
    dims.surprise = pct(s);
    if (dims.surprise >= 72) why.push("Surprising turn");
  }

  // PAYOFF
  {
    let p = u ? 20 + u.conclusion * 0.7 : 40;
    if (u && u.roles.includes("tension") && u.roles.includes("payoff")) p += 10;
    dims.payoff = pct(p);
    if (dims.payoff >= 75) why.push("Story pays off");
  }

  // RETENTION - reasons to keep watching, second by second.
  {
    let r = speech.score * 0.55 + visual.score * 0.45;
    if (speech.reasons.includes("dead air")) r -= 8;
    dims.retention = pct(r);
    const vr = visual.reasons[0];
    if (motion && motion.reason) why.push(cap(motion.reason));
    else if (vr && vr !== "static shot") why.push(cap(vr));
    if (speech.reasons[0] && !/dead air|slow patch/.test(speech.reasons[0])) why.push(cap(speech.reasons[0]));
  }

  const isViral = !o.mode || o.mode.id === "viral";
  const w = isViral ? WEIGHTS.viral : WEIGHTS.ranked;
  let total = 0;
  for (const k of Object.keys(w)) total += dims[k] * w[k];
  // No speech at all: only hook/retention are meaningful, do not punish the
  // rest to the floor - centre them.
  if (!u) total = dims.retention * 0.6 + dims.hook * 0.15 + 50 * 0.25;

  return {
    dims,
    total: pct(total),
    reasons: dedupe(why).slice(0, 4),
    quote: list.length ? firstLine(list) : null,
    wpm: speech.wpm,
    motion: motion ? motion.level : null,
  };
}

function firstLine(list) {
  const s = signals.sentences(list)[0] || list.slice(0, 14);
  const t = signals.textOf(s);
  return t.length > 90 ? t.slice(0, 87).trim() + "..." : t;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const dedupe = (arr) => [...new Set(arr.filter(Boolean))];

function verdictFor(total) {
  const key = total >= 90 ? "viral" : total >= 82 ? "strong" : total >= 72 ? "good" : total >= 60 ? "okay" : "low";
  const text = {
    viral: "Likely to go viral",
    strong: "Strong viral chance",
    good: "Good to post",
    okay: "Okay / test it",
    low: "Low priority",
  }[key];
  return { key, text };
}

module.exports = { score, verdictFor, WEIGHTS };
