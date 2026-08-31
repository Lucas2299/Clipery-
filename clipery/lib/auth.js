/**
 * Clipery accounts - register / login / sessions.
 *
 * Zero dependencies on purpose (the whole project runs on plain Node):
 *  - users live in data/users.json
 *  - passwords are scrypt hashes with a per-user random salt (never plain text)
 *  - sessions live in data/sessions.json and are carried by an HttpOnly cookie
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

const COOKIE = "clipery_sid";
const SESSION_DAYS = 30;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const [file, seed] of [
  [USERS_FILE, { users: [] }],
  [SESSIONS_FILE, { sessions: [] }],
]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(seed, null, 2));
}

/* ---------------------------------- store --------------------------------- */

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function readUsers() {
  const d = readJson(USERS_FILE, { users: [] });
  return Array.isArray(d.users) ? d.users : [];
}
function writeUsers(users) {
  writeJson(USERS_FILE, { users });
}
function readSessions() {
  const d = readJson(SESSIONS_FILE, { sessions: [] });
  const now = Date.now();
  const live = (Array.isArray(d.sessions) ? d.sessions : []).filter((s) => s.expires > now);
  if (live.length !== (d.sessions || []).length) writeJson(SESSIONS_FILE, { sessions: live });
  return live;
}
function writeSessions(sessions) {
  writeJson(SESSIONS_FILE, { sessions });
}

/* -------------------------------- passwords -------------------------------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const known = Buffer.from(String(hash), "hex");
    return known.length === candidate.length && crypto.timingSafeEqual(known, candidate);
  } catch {
    return false;
  }
}

/* --------------------------------- helpers --------------------------------- */

const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(e));

/** What the browser is allowed to know about an account. */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    createdAt: u.createdAt,
    plan: u.plan || "free",
    providers: u.providers || (u.hash ? ["password"] : []),
  };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  const bits = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  return bits.join("; ");
}

/* --------------------------------- accounts -------------------------------- */

function findUserByEmail(email) {
  const target = normalizeEmail(email);
  return readUsers().find((u) => normalizeEmail(u.email) === target) || null;
}

function registerUser({ email, password, name }) {
  const mail = normalizeEmail(email);
  if (!isValidEmail(mail)) return { ok: false, status: 400, error: "Enter a valid email address." };
  if (String(password || "").length < 8)
    return { ok: false, status: 400, error: "Password must be at least 8 characters." };
  if (findUserByEmail(mail))
    return { ok: false, status: 409, error: "That email already has an account. Log in instead." };

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomBytes(8).toString("hex"),
    email: mail,
    name: String(name || "").trim().slice(0, 60),
    salt,
    hash,
    plan: "free",
    createdAt: new Date().toISOString(),
  };
  const users = readUsers();
  users.push(user);
  writeUsers(users);
  return { ok: true, user };
}

/**
 * Log in (or transparently sign up) via Google / Apple.
 * Matching is by email, so signing in with Google to an address that already
 * has a password account simply logs into that same account.
 */
function upsertSocialUser({ email, name, provider }) {
  const mail = normalizeEmail(email);
  if (!isValidEmail(mail)) return { ok: false, status: 400, error: "That account has no usable email." };

  const users = readUsers();
  const existing = users.find((u) => normalizeEmail(u.email) === mail);
  if (existing) {
    const known = existing.providers || (existing.hash ? ["password"] : []);
    existing.providers = Array.from(new Set([...known, provider]));
    if (!existing.name && name) existing.name = String(name).slice(0, 60);
    writeUsers(users);
    return { ok: true, user: existing, created: false };
  }

  const user = {
    id: crypto.randomBytes(8).toString("hex"),
    email: mail,
    name: String(name || "").trim().slice(0, 60),
    salt: "",
    hash: "", // social-only account: no password to guess
    providers: [provider],
    plan: "free",
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  return { ok: true, user, created: true };
}

function loginUser({ email, password }) {
  const user = findUserByEmail(email);
  if (user && !user.hash) {
    const via = (user.providers || []).includes("apple") ? "Apple" : "Google";
    return { ok: false, status: 401, error: `This account uses Sign in with ${via}.` };
  }
  // Same message either way so nobody can probe which emails exist.
  if (!user || !verifyPassword(password, user.salt, user.hash))
    return { ok: false, status: 401, error: "Wrong email or password." };
  return { ok: true, user };
}

/* --------------------------------- sessions -------------------------------- */

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const maxAgeSec = SESSION_DAYS * 24 * 60 * 60;
  const sessions = readSessions();
  sessions.push({
    token,
    userId,
    createdAt: new Date().toISOString(),
    expires: Date.now() + maxAgeSec * 1000,
  });
  writeSessions(sessions);
  return { token, cookie: sessionCookie(token, maxAgeSec) };
}

function destroySession(token) {
  if (!token) return;
  writeSessions(readSessions().filter((s) => s.token !== token));
}

/** The logged-in user for this request, or null. */
function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const session = readSessions().find((s) => s.token === token);
  if (!session) return null;
  const user = readUsers().find((u) => u.id === session.userId);
  return user || null;
}

const clearCookie = () => sessionCookie("", 0);


/* ---------------------------------- plans ---------------------------------- */

/**
 * What each plan may do per calendar month. "videos" is how many jobs the
 * account can start (uploads, links, ranking videos - anything that renders).
 * The owner can change a plan or hand out bonus videos from the dashboard.
 */
const PLANS = {
  // videos     - long-form sources you may run per month
  // maxMinutes - how long each source video may be
  // maxClips   - how many clips we cut out of ONE source video
  free: { id: "free", label: "Free", videos: 3, maxMinutes: 20, maxClips: 3 },
  plus: { id: "plus", label: "Plus", videos: 50, maxMinutes: 60, maxClips: 8 },
  pro: { id: "pro", label: "Pro", videos: 200, maxMinutes: 180, maxClips: 10 },
  unlimited: { id: "unlimited", label: "Unlimited", videos: Infinity, maxMinutes: 240, maxClips: 10 },
};

const currentMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

function planOf(user) {
  return PLANS[(user && user.plan) || "free"] || PLANS.free;
}

/** Usage for this month, reset automatically when the month rolls over. */
function usageOf(user) {
  const month = currentMonth();
  if (!user.usage || user.usage.month !== month) {
    user.usage = { month, videos: 0 };
  }
  return user.usage;
}

/** How many videos this account may still make right now. */
function remainingVideos(user) {
  if (!user) return 0;
  const limit = planOf(user).videos + (Number(user.bonusVideos) || 0);
  const used = usageOf(user).videos;
  return limit === Infinity ? Infinity : Math.max(0, limit - used);
}

/** Count one rendered video against the account. Returns false when out. */
function consumeVideo(userId) {
  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return { ok: false, error: "Account not found." };
  if (remainingVideos(user) <= 0) {
    return {
      ok: false,
      status: 402,
      error: `You have used all ${planOf(user).videos + (Number(user.bonusVideos) || 0)} videos on the ${planOf(user).label} plan this month.`,
    };
  }
  usageOf(user).videos += 1;
  writeUsers(users);
  return { ok: true, remaining: remainingVideos(user) };
}

/* ---------------------------------- owner ---------------------------------- */

/**
 * Who runs this install. Either listed in ADMIN_EMAILS, or - so a fresh
 * install is never locked out - the very first account created.
 */
function isAdmin(user) {
  if (!user) return false;
  if (user.role === "owner") return true;
  const list = String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (list.includes(normalizeEmail(user.email))) return true;
  const users = readUsers();
  return users.length > 0 && users[0].id === user.id;
}

/** Everyone, with the numbers the dashboard needs. */
function listUsers() {
  return readUsers().map((u) => {
    const limit = planOf(u).videos + (Number(u.bonusVideos) || 0);
    return {
      ...publicUser(u),
      role: isAdmin(u) ? "owner" : "member",
      bonusVideos: Number(u.bonusVideos) || 0,
      planLabel: planOf(u).label,
      maxMinutes: planOf(u).maxMinutes,
      maxClips: planOf(u).maxClips,
      used: usageOf(u).videos,
      limit: limit === Infinity ? null : limit,
      remaining: remainingVideos(u) === Infinity ? null : remainingVideos(u),
    };
  });
}

/** Owner action: move somebody to another plan. */
function setPlan(userId, plan) {
  if (!PLANS[plan]) return { ok: false, status: 400, error: "Unknown plan." };
  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return { ok: false, status: 404, error: "Account not found." };
  user.plan = plan;
  writeUsers(users);
  return { ok: true, user: publicUser(user) };
}

/** Owner action: hand out extra videos on top of the plan. */
function addBonusVideos(userId, amount) {
  const n = Math.round(Number(amount) || 0);
  if (!n) return { ok: false, status: 400, error: "Give a number of videos." };
  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return { ok: false, status: 404, error: "Account not found." };
  user.bonusVideos = Math.max(0, (Number(user.bonusVideos) || 0) + n);
  writeUsers(users);
  return { ok: true, bonusVideos: user.bonusVideos };
}

/** Owner action: wipe this month's usage for one account. */
function resetUsage(userId) {
  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return { ok: false, status: 404, error: "Account not found." };
  user.usage = { month: currentMonth(), videos: 0 };
  writeUsers(users);
  return { ok: true };
}

function findUserById(id) {
  return readUsers().find((u) => u.id === id) || null;
}

module.exports = {
  COOKIE,
  registerUser,
  loginUser,
  upsertSocialUser,
  createSession,
  destroySession,
  currentUser,
  publicUser,
  parseCookies,
  clearCookie,
  isValidEmail,
  PLANS,
  planOf,
  remainingVideos,
  consumeVideo,
  isAdmin,
  listUsers,
  setPlan,
  addBonusVideos,
  resetUsage,
  findUserById,
};
