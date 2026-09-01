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

  const clean = (samples || [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.x))
    .sort((a, b) => a.t - b.t);
  if (!clean.length) return [];

  // Median-of-3 to kill single bad detections.
  const med = clean.map((s, i) => {
    const win = [clean[i - 1], s, clean[i + 1]].filter(Boolean).map((v) => v.x).sort((a, b) => a - b);
    return { t: s.t, x: win[Math.floor(win.length / 2)] };
  });

  const keys = [{ t: med[0].t, x: med[0].x }];
  let heldX = med[0].x;
  let heldSince = med[0].t;

  for (const s of med) {
    if (Math.abs(s.x - heldX) < deadZone) continue;      // wobble, ignore
    if (s.t - heldSince < holdFor) continue;             // too soon, hold the shot
    // Confirm the move is real: the next sample should agree.
    const ahead = med.filter((o) => o.t > s.t && o.t <= s.t + 0.9);
    if (ahead.length && !ahead.some((o) => Math.abs(o.x - s.x) < deadZone)) continue;

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
  if (multi.length < Math.max(2, (samples || []).length * 0.45)) return 0;
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
  if (!samples || samples.length < 2) return "center";
  // Both people in frame together and too wide to fit -> stop cropping.
  if (simultaneousSpread(samples) > cropFrac * 1.05) return "wide";
  // Subject moves around (or speakers take turns) -> follow them.
  if (buildCameraPath(samples).length > 1) return "follow";
  return "static";
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
  const layout = chooseLayout(o.samples, srcW, srcH, cropFrac);

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
    const keys = buildCameraPath(o.samples);
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
    const xs = o.samples.map((s) => s.x).sort((a, b) => a - b);
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

module.exports = { buildCameraPath, cropExpr, chooseLayout, spreadOf, simultaneousSpread, reframeFilter };
