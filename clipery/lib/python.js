/**
 * Which Python should Clipery call?
 *
 * Ubuntu 24.04 / Debian 12 refuse "pip install" into the system Python
 * (PEP 668, the "externally-managed-environment" error), so the normal fix is
 * a virtual environment next to the app:
 *
 *     python3 -m venv venv
 *     venv/bin/pip install opencv-python-headless faster-whisper yt-dlp
 *
 * This module finds that venv on its own, so `npm start` just works and you
 * never have to export PYTHON=... by hand.
 *
 * Order of preference:
 *   1. $PYTHON            - you said exactly which one, so we obey
 *   2. ./venv  or ./.venv - the local virtual environment (Linux and Windows)
 *   3. python3 / python   - system-wide install
 */

"use strict";

const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const WIN = process.platform === "win32";

function firstExisting(candidates) {
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;

  const venv = firstExisting([
    path.join(APP_DIR, "venv", WIN ? "Scripts/python.exe" : "bin/python"),
    path.join(APP_DIR, ".venv", WIN ? "Scripts/python.exe" : "bin/python"),
    path.join(APP_DIR, "..", "venv", WIN ? "Scripts/python.exe" : "bin/python"),
  ]);
  if (venv) return venv;

  return WIN ? "python" : "python3";
}

const PYTHON = resolvePython();

/** True when we are using a project virtual environment rather than the system one. */
const IS_VENV = PYTHON.includes("venv");

/**
 * Command-line tools installed BY pip (yt-dlp) land in the venv's bin folder,
 * which is not on PATH unless you activated the venv. Resolve them the same
 * way we resolve python itself, so `npm start` finds them regardless.
 */
function bin(name) {
  if (!IS_VENV) return name;
  const dir = path.dirname(PYTHON);
  const candidate = firstExisting([
    path.join(dir, WIN ? `${name}.exe` : name),
    path.join(dir, name),
  ]);
  return candidate || name;
}

module.exports = { PYTHON, IS_VENV, resolvePython, bin };
