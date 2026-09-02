#!/usr/bin/env node
/**
 * Clipery doctor - tells you what is installed and what is missing.
 *
 *   cd clipery
 *   node scripts/doctor.js
 *
 * Every check prints the exact command to fix it, so you never have to guess
 * which pip or which folder.
 */

"use strict";

const { execFileSync } = require("child_process");
const os = require("os");

const { PYTHON: PY, IS_VENV, bin } = require("../lib/python");
const results = [];

function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim();
  } catch (e) {
    return null;
  }
}

function check(name, what, fix, why) {
  const out = what();
  results.push({ name, ok: !!out, detail: out || "not found", fix, why });
}

/**
 * The right install command for THIS machine. On Ubuntu 24.04 a system-wide
 * pip install is blocked (PEP 668), so we point at a venv instead.
 */
function pipHint(pkg) {
  if (IS_VENV) return `${PY} -m pip install -U ${pkg}`;
  if (os.platform() === "linux") {
    return `python3 -m venv venv && venv/bin/pip install ${pkg}     (or: pip install --break-system-packages ${pkg})`;
  }
  return `${PY} -m pip install -U ${pkg}`;
}

function pyModule(mod) {
  return () => tryRun(PY, ["-c", `import ${mod}; print(getattr(${mod}, "__version__", "ok"))`]);
}

check("Node.js", () => tryRun(process.execPath, ["-v"]), "https://nodejs.org (version 18 or newer)", "runs the site");
check("Python", () => {
  const v = tryRun(PY, ["--version"]);
  return v ? `${v}${IS_VENV ? "  (project venv)" : "  (system)"}` : null;
}, "https://python.org/downloads (tick 'Add Python to PATH')", "runs the face and speech helpers");
check("ffmpeg", () => {
  const v = tryRun("ffmpeg", ["-version"]);
  return v ? v.split("\n")[0] : null;
}, "Windows: winget install Gyan.FFmpeg | Mac: brew install ffmpeg | Linux: sudo apt install ffmpeg", "cuts and renders every clip");
check("ffprobe", () => {
  const v = tryRun("ffprobe", ["-version"]);
  return v ? v.split("\n")[0] : null;
}, "comes with ffmpeg", "reads video length and size");
check("yt-dlp", () => tryRun(bin("yt-dlp"), ["--version"]), pipHint("yt-dlp"), "downloads videos from a link");
check("OpenCV (face tracking)", () => {
  const v = pyModule("cv2")();
  if (!v) return null;
  // OpenCV 5 dropped the classic face cascade, so the tracker cannot run on it.
  if (parseInt(v, 10) >= 5) return null;
  return v;
}, pipHint("'opencv-python-headless<5'"), "smart reframing - the crop follows the speaker");
check("faster-whisper (transcript)", pyModule("faster_whisper"), pipHint("faster-whisper"), "the brain: hooks, story, payoff, captions");

const pad = Math.max(...results.map((r) => r.name.length));
let missing = 0;

console.log("\nClipery doctor\n");
for (const r of results) {
  const mark = r.ok ? "[ ok ]" : "[MISS]";
  console.log(`${mark} ${r.name.padEnd(pad)}  ${r.ok ? r.detail.split("\n")[0].slice(0, 46) : r.why}`);
  if (!r.ok) missing++;
}

if (!missing) {
  console.log("\nEverything is installed. Run: npm start\n");
} else {
  console.log(`\n${missing} thing(s) missing. Fix them with:\n`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.name}\n    ${r.fix}\n`);
  console.log("Clipery still runs without them - you just lose that feature.\n");
}

process.exit(0);
