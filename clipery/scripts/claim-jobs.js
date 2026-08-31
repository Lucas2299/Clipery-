#!/usr/bin/env node
/**
 * Give old jobs an owner.
 *
 * Clips made before accounts existed have no userId, so they show up in
 * nobody's library. Run this once to hand them to your account:
 *
 *   node scripts/claim-jobs.js you@example.com
 *
 * Add --dry to see what would change without touching anything.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const USERS_FILE = path.join(ROOT, "data", "users.json");
const LINKS_FILE = path.join(ROOT, "data", "link-rankings.json");

const email = String(process.argv[2] || "").trim().toLowerCase();
const dry = process.argv.includes("--dry");

if (!email) {
  console.error("Usage: node scripts/claim-jobs.js you@example.com [--dry]");
  process.exit(1);
}

let users = [];
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")).users || [];
} catch {
  console.error("No accounts yet - register on the site first.");
  process.exit(1);
}

const user = users.find((u) => String(u.email).toLowerCase() === email);
if (!user) {
  console.error(`No account for ${email}. Accounts: ${users.map((u) => u.email).join(", ") || "(none)"}`);
  process.exit(1);
}

let claimed = 0;
let skipped = 0;
if (fs.existsSync(JOBS_DIR)) {
  for (const file of fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"))) {
    const full = path.join(JOBS_DIR, file);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    if (job.userId) {
      skipped++;
      continue;
    }
    job.userId = user.id;
    if (!dry) fs.writeFileSync(full, JSON.stringify(job, null, 2));
    claimed++;
  }
}

let boards = 0;
try {
  const data = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  for (const b of data.boards || []) {
    if (!b.userId) {
      b.userId = user.id;
      boards++;
    }
  }
  if (!dry && boards) fs.writeFileSync(LINKS_FILE, JSON.stringify(data, null, 2));
} catch {}

console.log(
  `${dry ? "[dry run] would claim" : "Claimed"} ${claimed} job(s) and ${boards} board(s) for ${user.email}` +
    (skipped ? ` - ${skipped} already owned` : "")
);
