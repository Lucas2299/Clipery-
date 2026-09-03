/**
 * The three brains of Clipery, in one place.
 *
 *   Brain 1  understand(words, start, end)  -> what is happening here?
 *   Brain 2  score({...})                   -> would someone keep watching?
 *   Brain 3  edit.plan({...})               -> how does it become a Short?
 *
 * `think()` runs 1 and 2 together for one candidate window and returns the
 * shape clipEngine stores in `dimensions`. Brain 3 runs later, once the
 * shortlist is known, because it needs silence data and the detector track.
 */

"use strict";

const { understand } = require("./understand");
const { score, verdictFor } = require("./score");
const edit = require("./edit");

/**
 * @returns {object|null} null when nothing can be read (no words at all and no visuals)
 */
function think(o) {
  const u = Array.isArray(o.words) && o.words.length ? understand(o.words, o.start, o.end) : null;
  const s = score({ ...o, understanding: u });
  const verdict = verdictFor(s.total);
  return {
    understanding: u,
    scores: s.dims,
    total: s.total,
    reasons: s.reasons,
    quote: s.quote,
    wpm: s.wpm,
    motion: s.motion,
    verdict: verdict.text,
    verdictKey: verdict.key,
    summary: u ? u.summary : null,
    topic: u ? u.topic : [],
  };
}

module.exports = { think, understand, score, verdictFor, edit };
