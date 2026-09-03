/**
 * BRAIN 1 - Content understanding.
 *
 * Answers: "What is happening in this moment?"
 *
 * Reads the transcript for one window and reports, in plain terms:
 *   topic       - what the clip is about (a few key words)
 *   story       - is somebody telling a story?
 *   setup       - does the viewer get the background first?
 *   conflict    - disagreement, something going wrong, stakes
 *   claim       - a strong opinion or statement of fact
 *   reaction    - laughter, shock, an audible reaction
 *   punchline   - the surprising turn or the quotable line
 *   conclusion  - the payoff / lesson / result actually lands
 *   educational - useful how-to, numbers, concrete takeaways
 *   emotional   - feeling words, vulnerability
 *
 * Each of those is 0..100 so Brain 2 can weigh them. No model, no API key -
 * this is the rule-based reader. A smarter reader (an LLM, if ever wanted)
 * would plug in here and produce the same shape.
 */

"use strict";

const signals = require("../brain");
const story = require("../story");

const STOP = new Set(
  (
    "the a an and or but so if then than that this these those there here it its is are was were be been being " +
    "i me my we our you your he she they them his her their of to in on at for from with by as about into over " +
    "after before up down out off just really very like know think mean kind sort yeah yes no not do does did " +
    "have has had can could would should will going go get got one two thing things stuff way lot okay right " +
    "um uh oh well also because when what which who how where why all any some more most much many " +
    "honestly literally actually basically obviously definitely probably maybe pretty every never always " +
    "hundred thousand million billion week weeks month months year years day days time times people something " +
    "anything everything nothing said says say saying went come came back still even only around little bit"
  ).split(/\s+/)
);

/** The 3-4 words that best say what this window is about. */
function topicOf(text) {
  const counts = new Map();
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9']+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 4)
    .map((e) => e[0]);
}

const pct = (v) => Math.max(0, Math.min(100, Math.round(v)));

/**
 * @param {Array<{w,s,e}>} words  whisper words for the whole video
 * @param {number} start
 * @param {number} end
 * @returns {object|null} null when there is too little speech to read
 */
function understand(words, start, end) {
  const list = signals.wordsIn(words, start, end);
  if (list.length < 6) return null;
  const text = signals.textOf(list);
  const lower = text.toLowerCase();

  const content = signals.contentSignals(text, list);
  const ctx = story.contextCheck(words, start, end);
  const roles = new Set(ctx.roles || []);
  const hits = content.hits || {};
  const n = (k) => hits[k] || 0;

  const beats = story.beats(words, start, end);
  const payoffLate = beats.length
    ? beats.slice(Math.floor(beats.length / 2)).some((b) => b.role === "payoff")
    : false;

  const laughs = (lower.match(/\b(haha+|laughs?|laughing|lol|lmao)\b/g) || []).length;
  const shock = (lower.match(/\b(what|no way|oh my god|omg|wow|whoa|are you serious|shut up)\b/g) || []).length;

  const out = {
    topic: topicOf(text),
    words: list.length,
    story: pct(30 + n("story") * 25 + (roles.has("setup") ? 15 : 0) + (roles.has("tension") ? 15 : 0)),
    setup: pct(roles.has("setup") ? 75 : ctx.missing && ctx.missing.includes("opens mid-thought") ? 15 : 45),
    conflict: pct(25 + n("conflict") * 30 + (roles.has("tension") ? 25 : 0)),
    claim: pct(30 + n("claim") * 30 + (roles.has("statement") ? 25 : 0)),
    reaction: pct(20 + laughs * 30 + shock * 20 + (text.match(/!/g) || []).length * 6),
    punchline: pct(25 + n("surprise") * 30 + (roles.has("statement") ? 20 : 0) + (payoffLate ? 15 : 0)),
    conclusion: pct(roles.has("payoff") ? 80 + (payoffLate ? 10 : 0) : n("payoff") ? 60 : 25),
    educational: pct(25 + n("info") * 28 + n("numbers") * 18 + (content.reasons.includes("question then answer") ? 15 : 0)),
    emotional: pct(25 + n("emotion") * 30 + laughs * 10 + n("conflict") * 8),
    roles: [...roles],
    missing: ctx.missing || [],
    selfContained: ctx.score,
    notes: content.reasons.slice(0, 4),
  };

  // One line a human would say about it.
  out.summary = describe(out);
  return out;
}

function describe(u) {
  const parts = [];
  if (u.story >= 65) parts.push("a story");
  if (u.conflict >= 65) parts.push("a conflict");
  if (u.claim >= 65) parts.push("a strong claim");
  if (u.educational >= 65) parts.push("a useful takeaway");
  if (u.emotional >= 65) parts.push("an emotional moment");
  if (u.reaction >= 65) parts.push("a big reaction");
  const what = parts.length ? parts.slice(0, 2).join(" and ") : "a talking moment";
  const ending = u.conclusion >= 60 ? "with a payoff" : "without a clear payoff";
  const topic = u.topic.length ? ` about ${u.topic.slice(0, 2).join(", ")}` : "";
  return `${what}${topic}, ${ending}`;
}

module.exports = { understand, topicOf, describe };
