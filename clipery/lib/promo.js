/**
 * Promo board - paid members post their YouTube / TikTok / Instagram once a
 * week. Studio accounts are listed first, then Pro, then Starter. Free plan
 * can look but not post. Lives in data/promos.json.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const FILE = path.join(DATA_DIR, "promos.json");
const WEEK = 7 * 24 * 60 * 60 * 1000;

// Higher = shown first
const TIER = { studio: 3, pro: 2, starter: 1, free: 0 };

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readAll() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(d.promos) ? d.promos : [];
  } catch (_) {
    return [];
  }
}
function writeAll(promos) {
  fs.writeFileSync(FILE, JSON.stringify({ promos }, null, 2));
}

function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
}

/** "@name", "name" or a full URL -> a full https URL on the right site, or "" */
function normalizeLink(kind, value) {
  let v = clean(value, 200);
  if (!v) return "";
  const hosts = {
    youtube: ["youtube.com", "youtu.be"],
    tiktok: ["tiktok.com"],
    instagram: ["instagram.com"],
  }[kind];
  if (!/^https?:\/\//i.test(v)) {
    // Bare "domain.com/x" style input is not a handle - ask for a real URL.
    if (/[\/\s]/.test(v) || /\.(com|net|org|io|tv|me|co)(\b|$)/i.test(v)) return null;
    const handle = v.replace(/^@/, "").replace(/[^\w.\-]/g, "");
    if (!handle) return null;
    if (kind === "youtube") return "https://www.youtube.com/@" + handle;
    if (kind === "tiktok") return "https://www.tiktok.com/@" + handle;
    return "https://www.instagram.com/" + handle;
  }
  try {
    const u = new URL(v);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (!hosts.some((h) => host === h || host.endsWith("." + h))) return null;
    u.protocol = "https:";
    return u.toString();
  } catch (_) {
    return null;
  }
}

function tierOf(planId) {
  return TIER[planId] || 0;
}

/** When may this user post next? (null = now) */
function nextAllowedAt(userId) {
  const mine = readAll().filter((p) => p.userId === userId).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!mine) return null;
  const next = mine.createdAt + WEEK;
  return next > Date.now() ? next : null;
}

/**
 * Create (or replace) this user's promo. `plan` is the resolved plan id.
 * Returns {ok, status, error} or {ok:true, promo}.
 */
function post(user, plan, body) {
  if (!user) return { ok: false, status: 401, error: "Please log in." };
  if (tierOf(plan) === 0) {
    return { ok: false, status: 402, error: "The promo board is for paid plans. Upgrade to Starter, Pro or Studio to post." };
  }
  const wait = nextAllowedAt(user.id);
  if (wait) {
    const days = Math.ceil((wait - Date.now()) / (24 * 60 * 60 * 1000));
    return { ok: false, status: 429, error: `You can post once a week. Next post in ${days} day${days === 1 ? "" : "s"}.`, nextAllowedAt: wait };
  }
  const name = clean(body.name || user.name || "", 40) || (user.email || "").split("@")[0];
  const tagline = clean(body.tagline, 120);
  const links = {};
  for (const k of ["youtube", "tiktok", "instagram"]) {
    const v = normalizeLink(k, body[k]);
    if (v === null) return { ok: false, status: 400, error: `That ${k === "youtube" ? "YouTube" : k === "tiktok" ? "TikTok" : "Instagram"} link does not look right. Paste the channel/profile URL or your @handle.` };
    if (v) links[k] = v;
  }
  if (!Object.keys(links).length) return { ok: false, status: 400, error: "Add at least one channel link." };

  const promos = readAll().filter((p) => p.userId !== user.id);
  const promo = {
    id: crypto.randomBytes(6).toString("hex"),
    userId: user.id,
    name,
    tagline,
    ...links,
    createdAt: Date.now(),
  };
  promos.push(promo);
  writeAll(promos);
  return { ok: true, promo };
}

/**
 * Board for display. `planOfUserId(id)` returns the CURRENT plan id so people
 * who downgraded to Free drop off and upgrades move up straight away.
 */
function board(planOfUserId, viewerId) {
  const rows = [];
  for (const p of readAll()) {
    const plan = planOfUserId(p.userId);
    const tier = tierOf(plan);
    if (tier === 0) continue;
    rows.push({
      id: p.id,
      name: p.name,
      tagline: p.tagline || "",
      youtube: p.youtube || null,
      tiktok: p.tiktok || null,
      instagram: p.instagram || null,
      plan,
      tier,
      createdAt: p.createdAt,
      mine: !!viewerId && p.userId === viewerId,
    });
  }
  rows.sort((a, b) => b.tier - a.tier || b.createdAt - a.createdAt);
  return rows;
}

function remove(id, user, isOwner) {
  const promos = readAll();
  const p = promos.find((x) => x.id === id);
  if (!p) return { ok: false, status: 404, error: "Not found." };
  if (!isOwner && (!user || p.userId !== user.id)) return { ok: false, status: 403, error: "Not yours." };
  writeAll(promos.filter((x) => x.id !== id));
  return { ok: true };
}

module.exports = { post, board, remove, nextAllowedAt, normalizeLink, tierOf, WEEK };
