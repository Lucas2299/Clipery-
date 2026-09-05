/**
 * Smart reframing - turn a 16:9 source into 9:16 without the brutal centre zoom.
 *
 * Old behaviour:  16:9  ->  crop dead centre  ->  9:16   (speaker half out of frame)
 * New behaviour:  16:9  ->  detect faces      ->  track them over time
 *                       ->  move the 9:16 window with the speaker
 *                       ->  if two people are too far apart to fit, zoom OUT
 *                          and show the full frame instead of chopping someone off.
 *
 * Everything here is pure maths on a detector track, so it is unit-testable
 * without ffmpeg or a webcam.
 */

"use strict";

/** Clamp helper. */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Only the samples where a face was actually found. The detector reports
 * x:null when it sees nobody, and those must never reach the maths: sorting
 * a list with nulls in it used to put the crop hard against the left edge,
 * pointing the camera at empty scenery.
 */
function seenOnly(samples) {
  return (samples || []).filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.x));
}

/**
 * Where to point when the subject is lost: the centre of the action, taken
 * from the 10th-90th percentile of everywhere anybody stood. For one still
 * speaker that is simply where they are; for two hosts it is between them,
 * which keeps both in shot rather than staring at one empty chair.
 */
function homeX(samples) {
  const xs = seenOnly(samples).map((s) => s.x).sort((a, b) => a - b);
  if (!xs.length) return 0.5;
  const lo = xs[Math.floor(xs.length * 0.1)];
  const hi = xs[Math.floor(xs.length * 0.9)];
  return clamp((lo + hi) / 2, 0, 1);
}

/**
 * Two people close enough to share the window: aim between them, so neither
 * gets sliced off at the edge while the camera sits on the bigger face.
 * `fitFrac` is the window width as a fraction of the source (0 = off).
 */
function aimBetween(samples, fitFrac) {
  if (!(fitFrac > 0)) return seenOnly(samples);
  const sorted = seenOnly(samples).sort((a, b) => a.t - b.t);
  let pair = null; // last moment both were seen: {t, lo, hi}
  return sorted.map((s) => {
    if (Array.isArray(s.xs) && s.xs.length >= 2) {
      const lo = Math.min(...s.xs);
      const hi = Math.max(...s.xs);
      if (hi - lo <= fitFrac * 0.8) {
        pair = { t: s.t, lo, hi };
        return { t: s.t, x: (lo + hi) / 2, xs: s.xs };
      }
      pair = null;
      return s;
    }
    // The detector blinks on one of the two faces all the time. If the face
    // it still sees is one of the pair, keep the pair framing instead of
    // lurching over to that one person and back a moment later.
    if (pair && s.t - pair.t <= 4 && s.x >= pair.lo - 0.05 && s.x <= pair.hi + 0.05) {
      return { t: s.t, x: (pair.lo + pair.hi) / 2, xs: s.xs };
    }
    pair = null;
    return s;
  });
}

/** Share of samples that actually saw somebody, 0..1. */
function faceCoverage(samples) {
  const all = (samples || []).filter((s) => s && Number.isFinite(s.t));
  if (!all.length) return 0;
  return seenOnly(all).length / all.length;
}

/**
 * Turn raw detector samples into a smooth, broadcast-looking camera path.
 *
 * Rules borrowed from how a human operator works a camera:
 *   - dead zone: ignore small wobbles, only move when the subject really moved
 *   - hold:      once moved, stay put for a beat (no seasick micro-panning)
 *   - ease:      travel between hold positions over ~0.5s, not instantly
 *
 * @param {Array<{t:number,x:number}>} samples  detector output, x is 0..1
 * @param {object} opts
 * @returns {Array<{t:number,x:number}>} keyframes for the crop expression
 */
function buildCameraPath(samples, opts = {}) {
  const deadZone = opts.deadZone != null ? opts.deadZone : 0.06; // 6% of width
  const holdFor = opts.holdFor != null ? opts.holdFor : 1.2;     // seconds
  const travel = opts.travel != null ? opts.travel : 0.5;        // seconds to move
  const gapFor = opts.gapFor != null ? opts.gapFor : 2.5;        // lost-subject timeout

  const fitFrac = opts.fitFrac != null ? opts.fitFrac : 0;         // window width, 0..1

  const clean = aimBetween(samples, fitFrac).sort((a, b) => a.t - b.t);
  if (!clean.length) return [];
  const home = homeX(clean);

  // Median-of-3 to kill single bad detections.
  const med = clean.map((s, i) => {
    const win = [clean[i - 1], s, clean[i + 1]].filter(Boolean).map((v) => v.x).sort((a, b) => a - b);
    return { t: s.t, x: win[Math.floor(win.length / 2)] };
  });

  const keys = [{ t: med[0].t, x: med[0].x }];
  let heldX = med[0].x;
  let heldSince = med[0].t;

  // Nobody found for a while? Do not keep staring at where they used to be.
  // Ease back to the middle of the action instead.
  const path = [];
  for (let i = 0; i < med.length; i++) {
    if (i > 0 && med[i].t - med[i - 1].t > gapFor && Math.abs(home - med[i - 1].x) >= deadZone) {
      path.push({ t: +(med[i - 1].t + travel).toFixed(2), x: home, recentre: true });
    }
    path.push(med[i]);
  }

  for (const s of path) {
    if (s.recentre) {
      // A recentre is not a subject move, so it skips the hold and the
      // confirmation: the subject is gone, waiting only prolongs a dead shot.
      keys.push({ t: +Math.max(0, s.t - travel).toFixed(2), x: heldX });
      keys.push({ t: +s.t.toFixed(2), x: +s.x.toFixed(4) });
      heldX = s.x;
      heldSince = s.t;
      continue;
    }
    if (Math.abs(s.x - heldX) < deadZone) continue;      // wobble, ignore
    if (s.t - heldSince < holdFor) continue;             // too soon, hold the shot
    // Confirm the move is real: the next sample should agree, OR the subject
    // is clearly still walking in the same direction (a walk used to be
    // rejected sample after sample, leaving the person outside the window).
    const ahead = med.filter((o) => o.t > s.t && o.t <= s.t + 0.9);
    const dir = Math.sign(s.x - heldX);
    const agrees = ahead.some((o) => Math.abs(o.x - s.x) < deadZone);
    const keepsGoing = ahead.some((o) => Math.sign(o.x - heldX) === dir && Math.abs(o.x - heldX) >= deadZone);
    if (ahead.length && !agrees && !keepsGoing) continue;

    keys.push({ t: +Math.max(0, s.t - travel).toFixed(2), x: heldX }); // start of the move
    keys.push({ t: +s.t.toFixed(2), x: +s.x.toFixed(4) });             // end of the move
    heldX = s.x;
    heldSince = s.t;
  }
  return keys;
}

/**
 * How far apart the people in shot are, 0..1 of frame width.
 * Used to decide "follow one speaker" vs "zoom out and show both".
 */
function spreadOf(samples) {
  const xs = (samples || []).map((s) => s.x).filter(Number.isFinite);
  if (xs.length < 2) return 0;
  xs.sort((a, b) => a - b);
  const lo = xs[Math.floor(xs.length * 0.1)];
  const hi = xs[Math.floor(xs.length * 0.9)];
  return clamp(hi - lo, 0, 1);
}

/**
 * How far apart the people on screen are AT THE SAME MOMENT.
 * Two hosts taking turns produce a big time-spread but a small simultaneous
 * spread only when they actually share the shot - that is the difference
 * between "pan between them" and "zoom out to fit both".
 */
function simultaneousSpread(samples) {
  const multi = (samples || []).filter((s) => Array.isArray(s.xs) && s.xs.length >= 2);
  // Haar misses one of two faces quite often, so "both visible" only has to
  // hold for a third of the clip, not nearly half of it.
  if (multi.length < Math.max(2, seenOnly(samples).length * 0.3)) return 0;
  const spans = multi.map((s) => Math.max(...s.xs) - Math.min(...s.xs)).sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)]; // median, so one bad frame cannot force a zoom-out
}

/**
 * Decide the layout for this clip.
 *
 *  "follow" - one subject (or one at a time): pan the 9:16 window with them
 *  "static" - subject barely moves: lock the window, no drifting
 *  "wide"   - subjects too far apart to ever share the window: stop cropping,
 *             fit the whole 16:9 frame with a blurred backdrop (no head chopping)
 *  "center" - no faces found: plain centre crop, same as before
 */
function chooseLayout(samples, srcW, srcH, cropFrac) {
  const seen = seenOnly(samples);
  if (seen.length < 2) return "center";
  // Faces in only a fraction of the clip means the tracker is guessing.
  // Guessing is what makes the frame wander off the people, so hold still.
  if (faceCoverage(samples) < 0.35) return "static";
  // Both people in frame together and too wide to fit -> stop cropping.
  // Faces have width, so centres 80% of the window apart already means
  // both are half chopped - that is the point where zooming out wins.
  if (simultaneousSpread(samples) > cropFrac * 0.8) return "wide";
  // One person who stands in two different places (walks over, sits down)
  // cannot be served by a single locked frame either.
  if (spreadOf(seen) > cropFrac * 0.8 && seen.length >= 6) return "follow";
  // Subject moves around (or speakers take turns) -> follow them.
  if (buildCameraPath(samples, { fitFrac: cropFrac }).length > 1) return "follow";
  return "static";
}

/**
 * What kind of video is this? The user tells us, and it changes how eager
 * the camera is:
 *
 *  podcast - people talking at a desk. Faces are everything: follow the
 *            speaker, and if two people share the shot keep them both.
 *  gaming  - the gameplay IS the content. A face cam is small and in a
 *            corner, so never zoom into it: keep the full picture.
 *  stream  - a streamer reacting. The person matters, but so does what is
 *            happening around them: follow the face, allow more movement,
 *            fall back to full picture when the face is lost.
 *  talking - one person to camera (vlog, lecture). Lock on the face.
 *  auto    - the old behaviour, decide from the face track alone.
 */
const GENRES = ["auto", "podcast", "gaming", "stream", "talking"];
function applyGenre(layout, genre, samples, cropFrac) {
  const g = GENRES.includes(genre) ? genre : "auto";
  if (g === "auto") return layout;
  const seen = seenOnly(samples);
  const coverage = faceCoverage(samples);
  if (g === "gaming") return "wide";
  if (g === "podcast") {
    if (seen.length < 2) return "center";
    // Both hosts on screen most of the time -> keep both in the window
    // rather than cutting one off at the edge.
    if (simultaneousSpread(samples) > cropFrac * 0.8) return "wide";
    return coverage < 0.2 ? "static" : "follow";
  }
  if (g === "stream") {
    if (seen.length < 2 || coverage < 0.25) return "wide";
    return "follow";
  }
  if (g === "talking") {
    if (seen.length < 2) return "center";
    return layout === "wide" ? "static" : layout === "follow" && coverage > 0.6 ? "follow" : "static";
  }
  return layout;
}

/** ffmpeg-safe number. */
const n2 = (v) => (Math.round(v * 100) / 100).toString();

/**
 * Build an ffmpeg `x=` expression that walks through the keyframes with linear
 * interpolation, clamped so the crop window never leaves the frame.
 *
 * Produces: if(lt(t,T1), X0, if(lt(t,T2), X0+(X1-X0)*(t-T1)/(T2-T1), ...))
 * `x` values are in pixels of the scaled input; `iw` is used for the clamp.
 */
function cropExpr(keys, cropW, srcW) {
  const px = (x) => clamp(x * srcW - cropW / 2, 0, Math.max(0, srcW - cropW));

  if (!keys || !keys.length) return null;
  if (keys.length === 1) return n2(px(keys[0].x));

  // Collapse duplicate timestamps.
  const k = [];
  for (const key of keys) {
    if (k.length && Math.abs(k[k.length - 1].t - key.t) < 0.01) k[k.length - 1] = key;
    else k.push(key);
  }
  if (k.length === 1) return n2(px(k[0].x));

  let expr = n2(px(k[k.length - 1].x)); // after the last keyframe: hold
  for (let i = k.length - 2; i >= 0; i--) {
    const t0 = k[i].t;
    const t1 = k[i + 1].t;
    const x0 = px(k[i].x);
    const x1 = px(k[i + 1].x);
    const dt = Math.max(0.05, t1 - t0);
    const ramp = `${n2(x0)}+(${n2(x1 - x0)})*(t-${n2(t0)})/${n2(dt)}`;
    expr = `if(lt(t\\,${n2(t1)})\\,${ramp}\\,${expr})`;
  }
  // Before the first keyframe, hold the first position.
  return `if(lt(t\\,${n2(k[0].t)})\\,${n2(px(k[0].x))}\\,${expr})`;
}

/**
 * The whole filter chain for one clip.
 *
 * @param {object} o
 * @param {Array<{t:number,x:number,faces:number}>} o.samples detector track (t relative to clip start)
 * @param {number} o.srcW source width      @param {number} o.srcH source height
 * @param {number} o.outW output width      @param {number} o.outH output height
 * @returns {{filter:string, layout:string, keys:Array}}
 */
function reframeFilter(o) {
  const outW = o.outW || 608;
  const outH = o.outH || 1080;
  const srcW = o.srcW || 1920;
  const srcH = o.srcH || 1080;

  // The 9:16 window at full source height - this is the tightest we ever crop.
  const cropW = Math.min(srcW, Math.round((srcH * outW) / outH));
  const cropFrac = cropW / srcW;
  // The editor can pin a layout; "follow"/"static" still need faces to work
  // with, so they fall back to centre when the detector saw nobody.
  let layout = chooseLayout(o.samples, srcW, srcH, cropFrac);
  layout = applyGenre(layout, o.genre, o.samples, cropFrac);
  if (o.force === "wide" || o.force === "center") layout = o.force;
  else if (o.force === "follow" || o.force === "static") layout = seenOnly(o.samples).length >= 2 ? o.force : "center";

  if (layout === "wide") {
    // Two people too far apart: show the ENTIRE frame, no zoom, blurred backdrop.
    // This is the anti-"excessive zoom" path.
    return {
      layout,
      keys: [],
      filter:
        `split=2[bg][fg];` +
        `[bg]scale=${outW}:${outH}:force_original_aspect_ratio=increase,` +
        `crop=${outW}:${outH},gblur=sigma=28,eq=brightness=-0.06[bgb];` +
        `[fg]scale=${outW}:-2[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`,
    };
  }

  let xExpr = null;
  if (layout === "follow") {
    const keys = buildCameraPath(o.samples, { fitFrac: cropFrac });
    xExpr = cropExpr(keys, cropW, srcW);
    if (xExpr) {
      return {
        layout,
        keys,
        filter: `crop=${cropW}:${srcH}:x='${xExpr}':y=0,scale=${outW}:${outH}`,
      };
    }
  }

  if (layout === "static") {
    // If a second person is usually in shot too, a frame that fits both
    // beats a frame centred on one with the other cut at the edge.
    const aimed = aimBetween(o.samples, cropFrac);
    const pairs = aimed.filter((s) => Array.isArray(s.xs) && s.xs.length >= 2);
    const pool = pairs.length >= aimed.length * 0.3 ? pairs : aimed;
    const xs = pool.map((s) => s.x).sort((a, b) => a - b);
    if (!xs.length) {
      return {
        layout: "center",
        keys: [],
        filter: `crop=${cropW}:${srcH}:x=(iw-${cropW})/2:y=0,scale=${outW}:${outH}`,
      };
    }
    const x = xs[Math.floor(xs.length / 2)];
    const px = clamp(x * srcW - cropW / 2, 0, Math.max(0, srcW - cropW));
    return {
      layout,
      keys: [{ t: 0, x }],
      filter: `crop=${cropW}:${srcH}:x=${n2(px)}:y=0,scale=${outW}:${outH}`,
    };
  }

  // No faces: centre crop (never zoomed past full height).
  return {
    layout: "center",
    keys: [],
    filter: `crop=${cropW}:${srcH}:x=(iw-${cropW})/2:y=0,scale=${outW}:${outH}`,
  };
}

module.exports = {
  GENRES,
  applyGenre,
  buildCameraPath,
  cropExpr,
  chooseLayout,
  spreadOf,
  simultaneousSpread,
  reframeFilter,
  seenOnly,
  homeX,
  faceCoverage,
  aimBetween,
};
