/**
 * Load clipery/.env (KEY=value per line) into process.env.
 *
 * This MUST be the very first require in server.js: the other modules read
 * settings like CLIPERY_FAST the moment they are loaded, so anything read
 * from the file after that point would simply be ignored.
 *
 * Real environment variables always win over the file, so
 * `CLIPERY_FAST=1 npm start` still overrides what the file says.
 */
const fs = require("fs");
const path = require("path");

function loadDotEnv(file) {
  const target = file || path.join(__dirname, "..", ".env");
  try {
    if (!fs.existsSync(target)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(target, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
      if (!(key in process.env)) {
        process.env[key] = value;
        n++;
      }
    }
    console.log(`[env] loaded clipery/.env (${n} settings)`);
    return n;
  } catch (e) {
    console.warn("[env] could not read .env:", e.message);
    return 0;
  }
}

// Loading on require is the point of this module.
loadDotEnv();

module.exports = { loadDotEnv };
