/**
 * Housekeeping - stop the disk filling up.
 *
 * Every finished job leaves rendered clips on disk forever. On your laptop
 * that is fine; on a 25GB server with real users it fills the disk in weeks
 * and every upload starts failing with a confusing error.
 *
 * This module deletes, on a timer:
 *   - clips and job records older than CLIPERY_RETENTION_DAYS (default 30)
 *   - source uploads older than a day (they are only needed while rendering)
 *   - anything left in tmp/
 *   - expired login sessions
 *
 * Set CLIPERY_RETENTION_DAYS=0 to keep everything forever (the old behaviour).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..");
const JOBS_DIR = path.join(APP, "data", "jobs");
const CLIPS_DIR = path.join(APP, "public", "clips");
const UPLOADS_DIR = path.join(APP, "uploads");
const TMP_DIR = path.join(APP, "tmp");
const SESSIONS_FILE = path.join(APP, "data", "sessions.json");

const DAY = 24 * 60 * 60 * 1000;

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function ageOf(p) {
  try {
    return Date.now() - fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function dirSize(p) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    }
  } catch {}
  return total;
}

const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/**
 * One cleanup pass. Safe to call at any time - it never touches a job that is
 * still queued or processing.
 * @param {{quiet?: boolean}} opts
 */
function sweep(opts = {}) {
  const retainDays = num("CLIPERY_RETENTION_DAYS", 30);
  const uploadHours = num("CLIPERY_UPLOAD_HOURS", 24);
  const removed = { jobs: 0, clipFolders: 0, uploads: 0, tmp: 0, sessions: 0, bytes: 0 };

  // ---- old jobs and their clips ----
  if (retainDays > 0) {
    const maxAge = retainDays * DAY;
    let jobFiles = [];
    try {
      jobFiles = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
    } catch {}

    for (const file of jobFiles) {
      const full = path.join(JOBS_DIR, file);
      let job = null;
      try {
        job = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {}
      // Never delete work that is still in flight.
      if (job && (job.status === "queued" || job.status === "processing")) continue;

      const created = job && job.createdAt ? Date.parse(job.createdAt) : NaN;
      const age = Number.isFinite(created) ? Date.now() - created : ageOf(full);
      if (age < maxAge) continue;

      const id = file.replace(/\.json$/, "");
      const clipDir = path.join(CLIPS_DIR, id);
      removed.bytes += dirSize(clipDir);
      if (rm(clipDir)) removed.clipFolders++;
      if (rm(full)) removed.jobs++;
    }

    // Clip folders whose job record is already gone.
    try {
      for (const dir of fs.readdirSync(CLIPS_DIR)) {
        const full = path.join(CLIPS_DIR, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        if (fs.existsSync(path.join(JOBS_DIR, `${dir}.json`))) continue;
        if (ageOf(full) < maxAge) continue;
        removed.bytes += dirSize(full);
        if (rm(full)) removed.clipFolders++;
      }
    } catch {}
  }

  // ---- source uploads: only needed while the job renders ----
  if (uploadHours > 0) {
    const maxAge = uploadHours * 60 * 60 * 1000;
    try {
      for (const f of fs.readdirSync(UPLOADS_DIR)) {
        if (f === ".gitkeep") continue;
        const full = path.join(UPLOADS_DIR, f);
        if (ageOf(full) < maxAge) continue;
        const size = fs.statSync(full).isDirectory() ? dirSize(full) : fs.statSync(full).size;
        if (rm(full)) {
          removed.uploads++;
          removed.bytes += size;
        }
      }
    } catch {}
  }

  // ---- scratch files ----
  try {
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (f === ".gitkeep") continue;
      const full = path.join(TMP_DIR, f);
      if (ageOf(full) < 2 * 60 * 60 * 1000) continue;
      if (rm(full)) removed.tmp++;
    }
  } catch {}

  // ---- expired sessions ----
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    if (Array.isArray(sessions)) {
      const live = sessions.filter((s) => !s.expires || s.expires > Date.now());
      if (live.length !== sessions.length) {
        removed.sessions = sessions.length - live.length;
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(live, null, 2));
      }
    }
  } catch {}

  const touched = removed.jobs + removed.clipFolders + removed.uploads + removed.tmp + removed.sessions;
  if (touched && !opts.quiet) {
    console.log(
      `[cleanup] removed ${removed.jobs} old job(s), ${removed.clipFolders} clip folder(s), ` +
        `${removed.uploads} upload(s), ${removed.tmp} temp file(s), ${removed.sessions} dead session(s) ` +
        `- freed ${mb(removed.bytes)} MB`
    );
  }
  return removed;
}

/**
 * Jobs that were mid-render when the process died would otherwise sit at
 * "processing" forever and spin the progress bar for the user.
 */
function recoverStuckJobs() {
  let fixed = 0;
  try {
    for (const file of fs.readdirSync(JOBS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(JOBS_DIR, file);
      let job;
      try {
        job = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      if (job.status !== "processing" && job.status !== "queued") continue;
      job.status = "error";
      job.stage = "stopped";
      job.progress = 0;
      job.error = "The server restarted while this video was being processed. Start it again.";
      fs.writeFileSync(full, JSON.stringify(job, null, 2));
      fixed++;
    }
  } catch {}
  if (fixed) console.log(`[cleanup] ${fixed} job(s) were interrupted by a restart - marked as failed`);
  return fixed;
}

/** Run at boot, then every few hours. */
function start() {
  const hours = num("CLIPERY_CLEANUP_HOURS", 6);
  const retain = num("CLIPERY_RETENTION_DAYS", 30);
  recoverStuckJobs();
  sweep();
  if (hours > 0) {
    const timer = setInterval(() => sweep(), hours * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  console.log(
    retain > 0
      ? `[cleanup] keeping clips for ${retain} day(s), sweeping every ${hours}h`
      : "[cleanup] retention disabled - clips are kept forever"
  );
}

module.exports = { sweep, recoverStuckJobs, start, dirSize };
