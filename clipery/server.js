// Settings from clipery/.env must land in process.env before anything else
// is loaded, so this require stays first.
require("./lib/env");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const {
  processVideo,
  readJob,
  listJobs,
  createLinkBoard,
  getLinkBoard,
  readLinkBoards,
  MODES,
  UPLOADS,
} = require("./lib/clipEngine");
const {
  processMultiRank,
  processLinksToRankingVideo,
  downloadUrl,
} = require("./lib/linkVideoEngine");
const { normalizeSubStyle } = require("./lib/subtitles");
const auth = require("./lib/auth");
const oauth = require("./lib/oauth");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const WAITLIST_FILE = path.join(DATA_DIR, "waitlist.json");
const JOBS_DIR = path.join(DATA_DIR, "jobs");

for (const d of [DATA_DIR, UPLOADS, JOBS_DIR, path.join(PUBLIC, "clips")]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
if (!fs.existsSync(WAITLIST_FILE)) {
  fs.writeFileSync(WAITLIST_FILE, JSON.stringify({ signups: [] }, null, 2));
}

// Only heavy MEDIA files may live in the browser cache. Code files (.js/.css/.html/.json...)
// must always be fresh - otherwise an updated site runs on stale scripts and UI buttons die.
const CACHEABLE_EXT = new Set([
  ".mp4", ".webm", ".mov", ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".svg", ".ico", ".woff", ".woff2", ".ass",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff2": "font/woff2",
};

// Pretty routes -> static files
const ROUTES = {
  "/": "index.html",
  "/studio": "studio.html",
  "/studio.html": "studio.html",
  "/rank": "rank.html",
  "/rank.html": "rank.html",
  "/library": "library.html",
  "/library.html": "library.html",
  "/pricing": "pricing.html",
  "/pricing.html": "pricing.html",
  "/waitlist": "waitlist.html",
  "/waitlist.html": "waitlist.html",
  "/job": "job.html",
  "/job.html": "job.html",
  "/admin": "admin.html",
  "/admin.html": "admin.html",
  "/login": "login.html",
  "/login.html": "login.html",
  "/register": "login.html",
  "/register.html": "login.html",
};

// Pages that require an account. Everything else stays public.
const PROTECTED_PAGES = [
  "/studio",
  "/studio.html",
  "/library",
  "/library.html",
  "/rank",
  "/rank.html",
  "/job",
  "/job.html",
];
const PROTECTED_API = [
  "/api/clip/upload",
  "/api/clip/from-url",
  "/api/clip/sample",
  "/api/rank/video/links",
  "/api/rank/video/upload",
  "/api/rank/links",
  "/api/jobs",
];

// Guarded by FILE, not by URL spelling: whatever path a request uses, if it
// ends up serving one of these it must belong to a logged-in account.
const PROTECTED_FILES = new Set(["studio.html", "library.html", "rank.html", "job.html"]);
// The dashboard is owner-only, a stricter club than the members pages.
const OWNER_FILES = new Set(["admin.html"]);
const CLIPS_DIR = path.join(PUBLIC, "clips");

/** Collapse "//studio", "/./studio.html", "%2e", backslashes, trailing "/" ... */
function normalizePath(raw) {
  let clean = String(raw || "/").split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {}
  clean = clean.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  clean = path.posix.normalize(clean);
  if (clean.length > 1) clean = clean.replace(/\/+$/, "");
  return clean.startsWith("/") ? clean : "/" + clean;
}

function isProtectedPage(pathname) {
  if (PROTECTED_PAGES.includes(pathname)) return true;
  if (/^\/job\/[a-f0-9]+$/i.test(pathname)) return true;
  if (/^\/board\/[a-f0-9]+$/i.test(pathname)) return true;
  return false;
}
function isProtectedApi(pathname, method) {
  if (pathname === "/api/rank/links" && method === "GET") return true;
  if (pathname === "/api/jobs" && method === "GET") return true;
  return PROTECTED_API.includes(pathname) && method === "POST";
}

let busy = false;
const queue = [];
// One render at a time by default: ffmpeg plus whisper will happily eat every
// core on a small server. Raise it only on a machine with room to spare.
const MAX_QUEUE = Math.max(1, Number(process.env.CLIPERY_MAX_QUEUE) || 20);

function readWaitlist() {
  try {
    const data = JSON.parse(fs.readFileSync(WAITLIST_FILE, "utf8"));
    if (!data || !Array.isArray(data.signups)) return { signups: [] };
    return data;
  } catch {
    return { signups: [] };
  }
}

function writeWaitlist(data) {
  fs.writeFileSync(WAITLIST_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": headers["Content-Type"] || "application/json; charset=utf-8",
    "Cache-Control": headers["Cache-Control"] || "no-store",
    ...headers,
  });
  res.end(payload);
}

function parseBody(req, max = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("Missing multipart boundary");
  const boundary = m[1] || m[2];
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buf.indexOf(sep) + sep.length;
  while (start < buf.length) {
    if (buf[start] === 45 && buf[start + 1] === 45) break;
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
    const next = buf.indexOf(sep, start);
    if (next < 0) break;
    const part = buf.subarray(start, next - 2);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      start = next + sep.length;
      continue;
    }
    const header = part.subarray(0, headerEnd).toString("utf8");
    const body = part.subarray(headerEnd + 4);
    const nameMatch = /name="([^"]+)"/i.exec(header);
    const fileMatch = /filename="([^"]*)"/i.exec(header);
    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: fileMatch ? fileMatch[1] : null,
      body,
    });
    start = next + sep.length;
  }
  return parts;
}

function serveFile(req, res, fullPath) {
  // Last line of defence - every page and every clip funnels through here.
  // Matching on the resolved FILE name means no URL spelling gets around it
  // (including Windows' case-insensitive "/STUDIO.HTML").
  const base = path.basename(fullPath).toLowerCase();
  const membersOnly = PROTECTED_FILES.has(base) || OWNER_FILES.has(base);
  if (OWNER_FILES.has(base) && !auth.isAdmin(auth.currentUser(req))) {
    const me = auth.currentUser(req);
    console.log(`[gate] ${me ? me.email : "guest"} blocked from the owner dashboard`);
    const next = encodeURIComponent(req.url || "/admin");
    res.writeHead(302, {
      Location: me ? "/studio" : `/login?next=${next}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }
  if (membersOnly && !auth.currentUser(req)) {
    console.log(`[gate] guest blocked from ${req.url} - sent to /login`);
    const next = encodeURIComponent(req.url || "/studio");
    res.writeHead(302, { Location: `/login?next=${next}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (!canSeeClipFile(req, fullPath)) {
    console.log(`[gate] blocked clip request ${req.url}`);
    send(res, 404, { error: "Not found" });
    return;
  }

  fs.stat(fullPath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA-ish fallback for unknown paths -> 404 page
      const notFound = path.join(PUBLIC, "404.html");
      if (fs.existsSync(notFound) && !fullPath.endsWith("404.html")) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(notFound).pipe(res);
        return;
      }
      send(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const range = req.headers.range;
    if (range && (ext === ".mp4" || ext === ".webm" || ext === ".mov")) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        const chunk = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${st.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunk,
          "Content-Type": type,
          "Cache-Control": "public, max-age=3600",
        });
        fs.createReadStream(fullPath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": st.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": membersOnly
        ? "no-store, must-revalidate"
        : CACHEABLE_EXT.has(ext)
        ? "public, max-age=3600"
        : "no-cache",
    });
    fs.createReadStream(fullPath).pipe(res);
  });
}

/**
 * Rendered clips live in public/clips/<jobId>/... so ffmpeg can write them and
 * <video> can stream them - but the URL must not be a public back door.
 * Checked on the RESOLVED file path, so "//clips/..." or "/a/../clips/..." can't
 * sneak around it. Your clips, your eyes only; anyone else gets a 404.
 */
function canSeeClipFile(req, fullPath) {
  const rel = path.relative(CLIPS_DIR, fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true; // not a clip
  const jobId = rel.split(path.sep)[0];
  if (!jobId) return true;
  const me = auth.currentUser(req);
  if (!me) return false;
  const job = readJob(jobId);
  if (!job) return false;
  // The owner can watch anything - that is the point of the dashboard.
  return job.userId === me.id || auth.isAdmin(me);
}

function serveStatic(req, res, pathname, search) {
  // One canonical form, so "//studio" and "/studio" take the same road
  const clean = normalizePath(pathname);

  // Studio & co. are members-only - bounce guests to the login page and
  // remember where they were headed so we can send them back after login.
  if (isProtectedPage(clean) && !auth.currentUser(req)) {
    const next = encodeURIComponent(clean + (search || ""));
    res.writeHead(302, { Location: `/login?next=${next}`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  // Already signed in? The login page has nothing to offer.
  if ((clean === "/login" || clean === "/register") && auth.currentUser(req)) {
    res.writeHead(302, { Location: "/studio", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  // Studio is the hub - Rank video lives under Studio
  if (clean === "/rank" || clean === "/rank.html") {
    res.writeHead(302, { Location: "/studio?tool=rank", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (ROUTES[clean]) {
    return serveFile(req, res, path.join(PUBLIC, ROUTES[clean]));
  }
  // /job/abc -> job.html (client reads id)
  if (/^\/job\/[a-f0-9]+$/i.test(clean)) {
    return serveFile(req, res, path.join(PUBLIC, "job.html"));
  }
  if (/^\/board\/[a-f0-9]+$/i.test(clean)) {
    return serveFile(req, res, path.join(PUBLIC, "rank.html"));
  }

  let filePath = clean === "/" ? "/index.html" : clean;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC, filePath);
  if (!full.startsWith(PUBLIC)) {
    send(res, 403, { error: "Forbidden" });
    return;
  }
  serveFile(req, res, full);
}


/**
 * Take one video off the account's monthly allowance. Replies 402 with a clear
 * message when the plan is used up, so the Studio can tell them what to do.
 */
function chargeVideo(req, res) {
  const me = auth.currentUser(req);
  if (!me) {
    send(res, 401, { ok: false, error: "Please log in.", login: "/login" });
    return null;
  }
  const charged = auth.consumeVideo(me.id);
  if (!charged.ok) {
    send(res, charged.status || 402, {
      ok: false,
      error: charged.error,
      upgrade: true,
      plan: auth.planOf(me).id,
    });
    return null;
  }
  me.planLimits = {
    planLabel: auth.planOf(me).label,
    maxMinutes: auth.planOf(me).maxMinutes,
    maxClips: auth.planOf(me).maxClips,
  };
  return me;
}

function seedJob(jobId, extra = {}) {
  const jobSeed = {
    id: jobId,
    userId: extra.userId || null, // who this belongs to - nobody else may see it
    status: "queued",
    stage: "queued",
    progress: 1,
    mode: extra.mode || "viral",
    createdAt: new Date().toISOString(),
    sourceName: extra.sourceName || "video",
    clips: [],
    rankings: [],
    error: null,
    ...extra,
  };
  fs.writeFileSync(
    path.join(JOBS_DIR, `${jobId}.json`),
    JSON.stringify(jobSeed, null, 2)
  );
  return jobSeed;
}

async function runQueueItem(item) {
  busy = true;
  try {
    if (item.type === "multi-rank") {
      await processMultiRank(item.sources, item.meta);
    } else if (item.type === "link-rank-video") {
      await processLinksToRankingVideo(item.links, item.meta);
    } else if (item.type === "from-url") {
      const { writeJob, readJob } = require("./lib/clipEngine");
      let job = readJob(item.meta.jobId);
      if (job) {
        job.status = "processing";
        job.stage = "downloading";
        job.progress = 5;
        writeJob(job);
      }
      const outBase = path.join(UPLOADS, `${item.meta.jobId}-src`);
      const got = await downloadUrl(item.url, outBase);
      if (job) {
        job = readJob(item.meta.jobId) || job;
        job.sourceName = got.title || item.url;
        writeJob(job);
      }
      await processVideo(got.file, {
        ...item.meta,
        sourceName: got.title || item.meta.sourceName || "video",
      });
    } else {
      await processVideo(item.sourcePath, item.meta);
    }
  } catch (e) {
    console.error("Job failed:", e.message);
    try {
      const { writeJob, readJob } = require("./lib/clipEngine");
      const id = item.meta && item.meta.jobId;
      if (id) {
        const job = readJob(id);
        if (job && job.status !== "done") {
          job.status = "error";
          job.error = e.message || String(e);
          job.progress = 0;
          writeJob(job);
        }
      }
    } catch (_) {}
  } finally {
    busy = false;
    if (queue.length) {
      const next = queue.shift();
      runQueueItem(next);
    }
  }
}

function enqueue(sourcePath, meta) {
  return enqueueItem({ type: "single", sourcePath, meta });
}

function enqueueItem(item) {
  if (busy) {
    if (queue.length >= MAX_QUEUE) {
      const err = new Error("The render queue is full. Try again in a few minutes.");
      err.busy = true;
      throw err;
    }
    queue.push(item);
    return { queued: true, position: queue.length };
  }
  runQueueItem(item);
  return { queued: false, position: 0 };
}

function normalizeMode(m) {
  const mode = String(m || "viral").toLowerCase();
  return MODES[mode] ? mode : "viral";
}

function wantSubtitles(v) {
  return v === true || ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase().trim());
}

// get is a lookup: (fieldName) => string value (multipart part or JSON field)
function readSubStyle(get) {
  return normalizeSubStyle({
    color: get("subColor"),
    size: get("subSize"),
    pos: get("subPos"),
    style: get("subStyle"),
    words: get("subWords"),
  });
}

// user-supplied trend keywords: lowercase word list, max 12 - boosts hooks & ranking
function readTrends(get) {
  const raw = String(get("trends") || "").toLowerCase();
  const list = raw
    .split(/[\s,;]+/)
    .map((w) => w.replace(/[^a-z0-9']/g, ""))
    .filter(Boolean);
  return [...new Set(list)].slice(0, 12);
}

// hook title option: enabled toggle + "intro" (first seconds) | "full" (whole clip)
function readHook(get) {
  return {
    enabled: wantSubtitles(get("hook")),
    mode: String(get("hookMode") || "").toLowerCase() === "full" ? "full" : "intro",
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    /* ------------------------------ accounts ------------------------------ */
    // Which social buttons to show (a provider without keys stays hidden)
    if (pathname === "/api/auth/providers" && req.method === "GET") {
      return send(res, 200, { ok: true, providers: oauth.providers() });
    }

    // Kick off Google / Apple sign-in
    if ((pathname === "/api/auth/google" || pathname === "/api/auth/apple") && req.method === "GET") {
      const provider = pathname.endsWith("google") ? "google" : "apple";
      const on = provider === "google" ? oauth.googleConfigured() : oauth.appleConfigured();
      if (!on) {
        return send(res, 503, {
          ok: false,
          error: `Sign in with ${provider === "google" ? "Google" : "Apple"} is not configured on this server.`,
        });
      }
      const state = oauth.makeState(url.searchParams.get("next"));
      const target =
        provider === "google"
          ? oauth.googleAuthUrl(req, state.token)
          : oauth.appleAuthUrl(req, state.token);
      res.writeHead(302, { Location: target, "Set-Cookie": state.cookie, "Cache-Control": "no-store" });
      return res.end();
    }

    // Come back from the provider (Google redirects with GET, Apple posts a form)
    if (
      (pathname === "/api/auth/google/callback" && req.method === "GET") ||
      (pathname === "/api/auth/apple/callback" && (req.method === "POST" || req.method === "GET"))
    ) {
      const provider = pathname.includes("google") ? "google" : "apple";
      let params = url.searchParams;
      let appleUserJson = null;
      if (req.method === "POST") {
        const raw = (await parseBody(req, 256 * 1024)).toString("utf8");
        params = new URLSearchParams(raw);
        appleUserJson = params.get("user");
      }

      const fail = (message) => {
        res.writeHead(302, {
          Location: `/login?error=${encodeURIComponent(message)}`,
          "Set-Cookie": oauth.clearState(),
          "Cache-Control": "no-store",
        });
        res.end();
      };

      if (params.get("error")) return fail("Sign-in was cancelled.");

      const cookies = auth.parseCookies(req);
      const state = oauth.readState(cookies[oauth.STATE_COOKIE], params.get("state"));
      if (!state.ok) return fail("Sign-in expired. Please try again.");

      try {
        const profile =
          provider === "google"
            ? await oauth.googleProfile(req, params.get("code"))
            : await oauth.appleProfile(req, params.get("code"), params.get("id_token"), appleUserJson);

        const result = auth.upsertSocialUser(profile);
        if (!result.ok) return fail(result.error || "Sign-in failed.");

        const { cookie } = auth.createSession(result.user.id, req);
        res.writeHead(302, {
          Location: state.next || "/studio",
          "Set-Cookie": [cookie, oauth.clearState()],
          "Cache-Control": "no-store",
        });
        return res.end();
      } catch (e) {
        console.error(`[oauth:${provider}]`, e.message);
        return fail(e.message || "Sign-in failed.");
      }
    }

    if (pathname === "/api/auth/register" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse((await parseBody(req, 64 * 1024)).toString("utf8") || "{}");
      } catch {
        return send(res, 400, { ok: false, error: "Invalid request." });
      }
      const result = auth.registerUser(body);
      if (!result.ok) return send(res, result.status || 400, { ok: false, error: result.error });
      const { cookie } = auth.createSession(result.user.id, req);
      return send(res, 201, { ok: true, user: auth.publicUser(result.user) }, { "Set-Cookie": cookie });
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse((await parseBody(req, 64 * 1024)).toString("utf8") || "{}");
      } catch {
        return send(res, 400, { ok: false, error: "Invalid request." });
      }
      const result = auth.loginUser(body);
      if (!result.ok) return send(res, result.status || 401, { ok: false, error: result.error });
      const { cookie } = auth.createSession(result.user.id, req);
      return send(res, 200, { ok: true, user: auth.publicUser(result.user) }, { "Set-Cookie": cookie });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      auth.destroySession(auth.parseCookies(req)[auth.COOKIE]);
      return send(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie(req) });
    }

    if (pathname === "/api/auth/me" && req.method === "GET") {
      const user = auth.currentUser(req);
      if (!user) return send(res, 200, { ok: true, user: null });
      const left = auth.remainingVideos(user);
      return send(res, 200, {
        ok: true,
        user: {
          ...auth.publicUser(user),
          isOwner: auth.isAdmin(user),
          planLabel: auth.planOf(user).label,
          videosLeft: left === Infinity ? null : left,
          maxMinutes: auth.planOf(user).maxMinutes,
          maxClipsPerVideo: auth.planOf(user).maxClips,
        },
      });
    }

    /* ---------------------------- owner dashboard ---------------------------- */
    if (pathname.startsWith("/api/admin/")) {
      const boss = auth.currentUser(req);
      if (!auth.isAdmin(boss)) {
        return send(res, 403, { ok: false, error: "Owner only." });
      }

      // Everyone, with plan + usage
      if (pathname === "/api/admin/users" && req.method === "GET") {
        return send(res, 200, { ok: true, users: auth.listUsers(), plans: Object.values(auth.PLANS).map((p) => ({ id: p.id, label: p.label, videos: p.videos === Infinity ? null : p.videos })) });
      }

      // Every job on the install, newest first, with its owner
      if (pathname === "/api/admin/jobs" && req.method === "GET") {
        const people = new Map(auth.listUsers().map((u) => [u.id, u]));
        const jobs = listJobs(200).map((j) => {
          const owner = people.get(j.userId);
          return {
            id: j.id,
            status: j.status,
            stage: j.stage,
            progress: j.progress,
            mode: j.mode,
            sourceName: j.sourceName,
            createdAt: j.createdAt,
            duration: j.duration,
            error: j.error,
            clipCount: (j.clips || []).length,
            clips: (j.clips || []).map((c) => ({ url: c.url, score: c.score, title: c.title })),
            compilation: j.compilation && j.compilation.url ? j.compilation.url : null,
            ownerId: j.userId || null,
            ownerEmail: owner ? owner.email : j.userId ? "(deleted account)" : "(no owner)",
          };
        });
        return send(res, 200, { ok: true, jobs });
      }

      // Move somebody to another plan
      if (pathname === "/api/admin/plan" && req.method === "POST") {
        const body = JSON.parse((await parseBody(req, 64 * 1024)).toString("utf8") || "{}");
        const r = auth.setPlan(body.userId, body.plan);
        return send(res, r.ok ? 200 : r.status || 400, r);
      }

      // Hand out extra videos on top of the plan
      if (pathname === "/api/admin/bonus" && req.method === "POST") {
        const body = JSON.parse((await parseBody(req, 64 * 1024)).toString("utf8") || "{}");
        const r = auth.addBonusVideos(body.userId, body.videos);
        return send(res, r.ok ? 200 : r.status || 400, r);
      }

      // Clear this month's usage
      if (pathname === "/api/admin/reset-usage" && req.method === "POST") {
        const body = JSON.parse((await parseBody(req, 64 * 1024)).toString("utf8") || "{}");
        const r = auth.resetUsage(body.userId);
        return send(res, r.ok ? 200 : r.status || 400, r);
      }

      return send(res, 404, { ok: false, error: "Unknown admin endpoint." });
    }

    // Locked API: no account, no clipping.
    if (isProtectedApi(pathname, req.method) && !auth.currentUser(req)) {
      return send(res, 401, { ok: false, error: "Please log in to use the Studio.", login: "/login" });
    }

    // Health
    if (pathname === "/api/health" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        service: "clipery",
        modes: Object.keys(MODES),
        busy,
        queue: queue.length,
        jobs: listJobs(5).length,
      });
    }

    // Modes
    if (pathname === "/api/modes" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        modes: Object.values(MODES).map((m) => ({
          id: m.id,
          label: m.label,
          description: m.description,
          targetMin: m.targetMin,
          targetMax: m.targetMax,
          maxClips: m.maxClips,
        })),
      });
    }

    // Waitlist
    if (pathname === "/api/waitlist" && req.method === "GET") {
      const data = readWaitlist();
      return send(res, 200, {
        count: data.signups.length,
        recent: data.signups.slice(-8).map((s) => ({
          name: s.name ? s.name.split(" ")[0] : "Creator",
          role: s.role || "creator",
          at: s.createdAt,
        })),
      });
    }

    if (pathname === "/api/waitlist" && req.method === "POST") {
      const buf = await parseBody(req, 1e6);
      const body = JSON.parse(buf.toString("utf8") || "{}");
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      const name = String(body.name || "").trim().slice(0, 80);
      const role = String(body.role || "creator").trim().slice(0, 40);
      const source = String(body.source || "landing").trim().slice(0, 40);
      const interest = String(body.interest || "").trim().slice(0, 200);

      if (!isValidEmail(email)) {
        return send(res, 400, { ok: false, error: "Please enter a valid email." });
      }

      const data = readWaitlist();
      const existing = data.signups.find((s) => s.email === email);
      if (existing) {
        return send(res, 200, {
          ok: true,
          already: true,
          position: data.signups.findIndex((s) => s.email === email) + 1,
          count: data.signups.length,
          message: "You're already on the list.",
        });
      }
      data.signups.push({
        email,
        name,
        role,
        source,
        interest,
        createdAt: new Date().toISOString(),
      });
      writeWaitlist(data);
      return send(res, 201, {
        ok: true,
        already: false,
        position: data.signups.length,
        count: data.signups.length,
        message: "You're on the list.",
      });
    }

    // List jobs
    if (pathname === "/api/jobs" && req.method === "GET") {
      const me = auth.currentUser(req);
      const jobs = listJobs(40, me.id).map((j) => ({
        id: j.id,
        status: j.status,
        mode: j.mode,
        modeLabel: j.modeLabel,
        sourceName: j.sourceName,
        progress: j.progress,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
        clipCount: (j.clips || []).length,
        duration: j.duration,
        error: j.error,
        hasCompilation: !!(j.compilation && j.compilation.url),
        topScore: j.clips?.[0]?.score || j.rankings?.[0]?.score || null,
      }));
      return send(res, 200, { ok: true, jobs });
    }

    // Sample clip
    if (pathname === "/api/clip/sample" && req.method === "POST") {
      return send(res, 410, {
        ok: false,
        error: "Demo videos removed. Upload your own video in Studio.",
      });
      const buf = await parseBody(req, 1e6);
      let body = {};
      try {
        body = JSON.parse(buf.toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const mode = normalizeMode(body.mode || url.searchParams.get("mode"));
      const sample = path.join(PUBLIC, "samples", "demo-podcast.mp4");
      if (!fs.existsSync(sample)) {
        return send(res, 410, { ok: false, error: "Demo videos removed. Upload your own video." });
      }
      const jobId = crypto.randomBytes(6).toString("hex");
      const owner = chargeVideo(req, res);
      if (!owner) return;
      const dest = path.join(UPLOADS, `${jobId}-sample.mp4`);
      fs.copyFileSync(sample, dest);
      seedJob(jobId, { userId: owner && owner.id, ...owner.planLimits,
        mode,
        sourceName: `demo-podcast.mp4 (${mode})`,
      });
      const q = enqueue(dest, {
        jobId,
        sourceName: `demo-podcast.mp4 (${mode})`,
        mode,
      });
      return send(res, 202, {
        ok: true,
        jobId,
        mode,
        ...q,
        message: "Clipping sample...",
        jobUrl: `/job/${jobId}`,
      });
    }

    // Upload clip
    if (pathname === "/api/clip/upload" && req.method === "POST") {
      const ct = req.headers["content-type"] || "";
      if (!ct.includes("multipart/form-data")) {
        return send(res, 400, {
          ok: false,
          error: "Send multipart form with field 'video'.",
        });
      }
      const buf = await parseBody(req);
      const parts = parseMultipart(buf, ct);
      const filePart = parts.find(
        (p) =>
          (p.name === "video" || p.name === "videos" || p.name === "file") &&
          p.body &&
          p.body.length > 1000
      );
      const modePart = parts.find((p) => p.name === "mode");
      const mode = normalizeMode(
        modePart ? modePart.body.toString("utf8") : "viral"
      );

      if (!filePart || !filePart.body?.length) {
        console.error("Single upload parts:", parts.map((p) => ({ name: p.name, filename: p.filename, len: p.body?.length })));
        return send(res, 400, { ok: false, error: "No video file received. Choose a file first." });
      }
      if (filePart.body.length > 100 * 1024 * 1024) {
        return send(res, 400, { ok: false, error: "Max upload size is 100MB." });
      }

      const orig = filePart.filename || "upload.mp4";
      let ext = path.extname(orig).toLowerCase() || ".mp4";
      const allowed = [".mp4", ".mov", ".webm", ".mkv", ".m4v", ""];
      if (ext && !allowed.includes(ext)) {
        // still accept if browser sent odd name - sniff not available, default mp4
        ext = ".mp4";
      }
      if (!ext) ext = ".mp4";

      const subsPart = parts.find((p) => p.name === "subtitles");
      const subtitles = wantSubtitles(subsPart ? subsPart.body.toString("utf8") : "");
      const subStyle = readSubStyle((n) => {
        const p = parts.find((x) => x.name === n);
        return p ? p.body.toString("utf8") : "";
      });
      const hookOpts = readHook((n) => {
        const p = parts.find((x) => x.name === n);
        return p ? p.body.toString("utf8") : "";
      });
      const trends = readTrends((n) => {
        const p = parts.find((x) => x.name === n);
        return p ? p.body.toString("utf8") : "";
      });

      const jobId = crypto.randomBytes(6).toString("hex");
      const owner = chargeVideo(req, res);
      if (!owner) return;
      const dest = path.join(UPLOADS, `${jobId}${ext}`);
      fs.writeFileSync(dest, filePart.body);
      seedJob(jobId, { userId: owner && owner.id, ...owner.planLimits, mode, sourceName: orig, subtitles, subStyle, hook: hookOpts.enabled, hookMode: hookOpts.mode, trends });
      const q = enqueue(dest, {
        userId: owner && owner.id,
        ...owner.planLimits,
        jobId, sourceName: orig, mode, subtitles, subStyle,
        hook: hookOpts.enabled, hookMode: hookOpts.mode, trends,
      });
      return send(res, 202, {
        ok: true,
        jobId,
        mode,
        ...q,
        message: "Upload received. Processing...",
        jobUrl: `/job/${jobId}`,
      });
    }

    // Long-form from URL (YouTube etc.)
    if (pathname === "/api/clip/from-url" && req.method === "POST") {
      const buf = await parseBody(req, 1e6);
      let body = {};
      try {
        body = JSON.parse(buf.toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const videoUrl = String(body.url || "").trim();
      const mode = normalizeMode(body.mode || "viral");
      if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
        return send(res, 400, { ok: false, error: "Paste a valid video link (YouTube works best)." });
      }
      const subtitles = wantSubtitles(body.subtitles);
      const subStyle = readSubStyle((n) => body[n]);
      const hookOpts = readHook((n) => body[n]);
      const trends = readTrends((n) => body[n]);
      const jobId = crypto.randomBytes(6).toString("hex");
      const owner = chargeVideo(req, res);
      if (!owner) return;
      seedJob(jobId, { userId: owner && owner.id, ...owner.planLimits,
        mode,
        sourceName: videoUrl.slice(0, 80),
        subtitles,
        subStyle,
        hook: hookOpts.enabled,
        hookMode: hookOpts.mode,
        trends,
      });
      const q = enqueueItem({
        type: "from-url",
        url: videoUrl,
        meta: {
          userId: owner && owner.id,
          ...owner.planLimits,
          jobId, sourceName: videoUrl.slice(0, 120), mode, subtitles, subStyle,
          hook: hookOpts.enabled, hookMode: hookOpts.mode, trends,
        },
      });
      return send(res, 202, {
        ok: true,
        jobId,
        mode,
        ...q,
        message: "Downloading and clipping...",
        jobUrl: `/job/${jobId}`,
      });
    }

    // Job status
    if (pathname.startsWith("/api/clip/status/") && req.method === "GET") {
      const id = pathname.split("/").pop();
      if (!/^[a-f0-9]+$/i.test(id || "")) {
        return send(res, 400, { ok: false, error: "Bad job id" });
      }
      const job = readJob(id);
      const me = auth.currentUser(req);
      if (!job || !me || (job.userId !== me.id && !auth.isAdmin(me))) {
        return send(res, 404, { ok: false, error: "Job not found" });
      }
      return send(res, 200, { ok: true, job });
    }

    // Link ranking boards
    if (pathname === "/api/rank/links" && req.method === "GET") {
      const me = auth.currentUser(req);
      const boards = readLinkBoards()
        .filter((b) => b.userId && me && b.userId === me.id)
        .map((b) => ({
        id: b.id,
        name: b.name,
        niche: b.niche,
        createdAt: b.createdAt,
        summary: b.summary,
      }));
      return send(res, 200, { ok: true, boards });
    }

    if (pathname === "/api/rank/links" && req.method === "POST") {
      const buf = await parseBody(req, 2e6);
      const body = JSON.parse(buf.toString("utf8") || "{}");
      let links = body.links;
      // Allow paste blob: one URL per line, optional "url | hook | views | duration"
      if ((!links || !links.length) && body.paste) {
        links = String(body.paste)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const bits = line.split("|").map((s) => s.trim());
            return {
              url: bits[0],
              hook: bits[1] || "",
              views: bits[2] ? Number(String(bits[2]).replace(/[^\d.]/g, "")) : 0,
              durationSec: bits[3] ? Number(bits[3]) : 0,
              notes: bits[4] || "",
            };
          });
      }
      if (!links || !links.length) {
        return send(res, 400, {
          ok: false,
          error: "Add at least one TikTok / short-form link.",
        });
      }
      if (links.length > 40) {
        return send(res, 400, { ok: false, error: "Max 40 links per board." });
      }
      const boardOwner = auth.currentUser(req);
      const board = createLinkBoard({
        name: body.name || "Link ranking",
        niche: body.niche || "general",
        links,
        userId: boardOwner && boardOwner.id,
      });
      return send(res, 201, {
        ok: true,
        board,
        boardUrl: `/rank?board=${board.id}`,
      });
    }

    if (pathname.startsWith("/api/rank/links/") && req.method === "GET") {
      const id = pathname.split("/").pop();
      const viewer = auth.currentUser(req);
      const board = getLinkBoard(id);
      if (!board || !viewer || board.userId !== viewer.id) {
        return send(res, 404, { ok: false, error: "Board not found" });
      }
      return send(res, 200, { ok: true, board });
    }


    // ---- Multi-link -> ranking VIDEO ----
    if (pathname === "/api/rank/video/links" && req.method === "POST") {
      const buf = await parseBody(req, 2e6);
      const body = JSON.parse(buf.toString("utf8") || "{}");
      let links = body.links;
      if ((!links || !links.length) && body.paste) {
        links = String(body.paste)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const bits = line.split("|").map((s) => s.trim());
            return {
              url: bits[0],
              hook: bits[1] || "",
              views: bits[2] ? Number(String(bits[2]).replace(/[^\d.]/g, "")) : 0,
              durationSec: bits[3] ? Number(bits[3]) : 0,
              notes: bits[4] || "",
            };
          });
      }
      // sample pack shortcut
      if (body.useSamplePack) {
        return send(res, 410, {
          ok: false,
          error: "Demo pack removed. Upload your videos or paste real links.",
        });
      }
      if (!links || links.length < 2) {
        return send(res, 400, { ok: false, error: "Add 2-5 video links." });
      }
      if (links.length > 5) {
        return send(res, 400, { ok: false, error: "Maximum 5 links." });
      }
      const subtitles = wantSubtitles(body.subtitles);
      const subStyle = readSubStyle((n) => body[n]);
      const hookOpts = readHook((n) => body[n]);
      const trends = readTrends((n) => body[n]);
      const jobId = crypto.randomBytes(6).toString("hex");
      const owner = chargeVideo(req, res);
      if (!owner) return;
      seedJob(jobId, { userId: owner && owner.id, ...owner.planLimits,
        mode: "link-rank-video",
        modeLabel: "Link ranking video",
        sourceName: body.name || `${links.length} links -> ranking video`,
        subtitles,
        subStyle,
        hook: hookOpts.enabled,
        hookMode: hookOpts.mode,
        trends,
      });
      const boardTitle = String(body.boardTitle || body.name || "Top Videos").trim().slice(0, 28) || "Top Videos";
      const q = enqueueItem({
        type: "link-rank-video",
        links,
        meta: {
          userId: owner && owner.id,
          ...owner.planLimits,
          jobId,
          sourceName: boardTitle,
          boardTitle,
          subtitles,
          subStyle,
          hook: hookOpts.enabled,
          hookMode: hookOpts.mode,
          trends,
        },
      });
      return send(res, 202, {
        ok: true,
        jobId,
        ...q,
        message: "Building ranking video from links...",
        jobUrl: `/job/${jobId}`,
      });
    }

    // Multi-file upload -> ranking video
    if (pathname === "/api/rank/video/upload" && req.method === "POST") {
      const ct = req.headers["content-type"] || "";
      if (!ct.includes("multipart/form-data")) {
        return send(res, 400, { ok: false, error: "Send multipart with videos[] files." });
      }
      const buf = await parseBody(req, 200 * 1024 * 1024);
      const parts = parseMultipart(buf, ct);
      const files = parts.filter((p) => {
        const n = String(p.name || "");
        const isVideoField =
          n === "videos" ||
          n === "videos[]" ||
          n === "video" ||
          n.startsWith("videos");
        return isVideoField && p.body && p.body.length > 1000;
      });
      if (files.length < 2) {
        return send(res, 400, {
          ok: false,
          error: files.length ? "Add at least 2 videos (max 5)." : "No video file received.",
        });
      }
      if (files.length > 5) {
        return send(res, 400, { ok: false, error: "Maximum 5 videos." });
      }
      const jobId = crypto.randomBytes(6).toString("hex");
      const owner = chargeVideo(req, res);
      if (!owner) return;
      const sources = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.body.length > 40 * 1024 * 1024) {
          return send(res, 400, { ok: false, error: `File too large: ${f.filename} (max 40MB each)` });
        }
        const rawName = f.filename || `video-${i + 1}.mp4`;
        let ext = path.extname(rawName).toLowerCase() || ".mp4";
        if (![".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext)) ext = ".mp4";
        const dest = path.join(UPLOADS, `${jobId}-${i}${ext}`);
        fs.writeFileSync(dest, f.body);
        const labelPart = parts.find((p) => p.name === `label_${i}`);
        const customLabel = labelPart
          ? String(labelPart.body.toString("utf8") || "").trim().slice(0, 40)
          : "";
        sources.push({
          path: dest,
          label:
            customLabel ||
            path.basename(rawName, path.extname(rawName)) ||
            `video-${i + 1}`,
          url: null,
        });
      }
      const titlePart = parts.find((p) => p.name === "title");
      const boardTitle = String(titlePart ? titlePart.body.toString("utf8") : "Top Videos")
        .trim()
        .slice(0, 28) || "Top Videos";
      const subsPartUpload = parts.find((p) => p.name === "subtitles");
      const subtitles = wantSubtitles(subsPartUpload ? subsPartUpload.body.toString("utf8") : "");
      const subStyle = readSubStyle((n) => {
        const p = parts.find((x) => x.name === n);
        return p ? p.body.toString("utf8") : "";
      });
      const hookOptsUp = readHook((n) => {
        const p = parts.find((x) => x.name === n);
        return p ? p.body.toString("utf8") : "";
      });
      const trendsUp = readTrends((n) => {
        const p = parts.find((x) => x.name === n);
        return p ? p.body.toString("utf8") : "";
      });
      seedJob(jobId, { userId: owner && owner.id, ...owner.planLimits,
        mode: "link-rank-video",
        modeLabel: "Link ranking video",
        sourceName: boardTitle,
        subtitles,
        subStyle,
        hook: hookOptsUp.enabled,
        hookMode: hookOptsUp.mode,
        trends: trendsUp,
      });
      const q = enqueueItem({
        type: "multi-rank",
        sources,
        meta: {
          userId: owner && owner.id,
          ...owner.planLimits,
          jobId, sourceName: boardTitle, boardTitle, subtitles, subStyle,
          hook: hookOptsUp.enabled, hookMode: hookOptsUp.mode, trends: trendsUp,
        },
      });
      return send(res, 202, {
        ok: true,
        jobId,
        ...q,
        message: "Building ranking video from uploads...",
        jobUrl: `/job/${jobId}`,
      });
    }

    serveStatic(req, res, pathname, url.search);
  } catch (e) {
    // A full render queue is not a crash - tell the user to come back shortly.
    if (e && e.busy) return send(res, 503, { ok: false, error: e.message, retry: true });
    console.error(e);
    send(res, 500, { ok: false, error: e.message || "Server error" });
  }
});

// Mark jobs killed by a restart as failed, then keep the disk from filling up.
require("./lib/cleanup").start();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Clipery running on http://0.0.0.0:${PORT}`);
  if (process.env.BASE_URL) console.log(`Public address: ${process.env.BASE_URL}`);
});
