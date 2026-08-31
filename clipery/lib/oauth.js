/**
 * Clipery social login — Sign in with Google + Sign in with Apple.
 *
 * Still zero dependencies: Node 18's global fetch does the token exchange and
 * crypto signs Apple's ES256 client secret.
 *
 * Configure with environment variables (see README). Any provider whose keys
 * are missing is simply hidden from the login page — the site keeps working
 * with email + password only.
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   APPLE_CLIENT_ID (Services ID), APPLE_TEAM_ID, APPLE_KEY_ID,
 *   APPLE_PRIVATE_KEY (contents of the .p8) or APPLE_PRIVATE_KEY_FILE (path)
 *   BASE_URL (e.g. https://clipery.com) — optional, otherwise taken from the request
 */
const crypto = require("crypto");
const fs = require("fs");

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const APPLE_AUTH = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN = "https://appleid.apple.com/auth/token";

const STATE_COOKIE = "clipery_oauth";

/* --------------------------------- config --------------------------------- */

function applePrivateKey() {
  if (process.env.APPLE_PRIVATE_KEY) return process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const file = process.env.APPLE_PRIVATE_KEY_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  return "";
}

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function appleConfigured() {
  return Boolean(
    process.env.APPLE_CLIENT_ID &&
      process.env.APPLE_TEAM_ID &&
      process.env.APPLE_KEY_ID &&
      applePrivateKey()
  );
}
/** Which buttons the login page should show. */
function providers() {
  return { google: googleConfigured(), apple: appleConfigured() };
}

/** Public origin of this install (honours proxies, falls back to the Host header). */
function baseUrl(req) {
  if (process.env.BASE_URL) return String(process.env.BASE_URL).replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}
const redirectUri = (req, provider) => `${baseUrl(req)}/api/auth/${provider}/callback`;

/* ---------------------------------- jwt ----------------------------------- */

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Read a JWT payload. Safe here: the token comes straight from the provider's
 *  token endpoint over TLS, so there is no untrusted hop to forge it. */
function decodeJwt(token) {
  try {
    const part = String(token).split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Apple wants a short-lived ES256 JWT instead of a static client secret. */
function appleClientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: process.env.APPLE_KEY_ID, typ: "JWT" };
  const payload = {
    iss: process.env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 60 * 30,
    aud: "https://appleid.apple.com",
    sub: process.env.APPLE_CLIENT_ID,
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign("SHA256")
    .update(data)
    .sign({ key: applePrivateKey(), dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(signature)}`;
}

/* ------------------------------ state cookie ------------------------------ */

/** CSRF token + the page the visitor wanted, parked in a short-lived cookie. */
function makeState(next) {
  const token = crypto.randomBytes(16).toString("hex");
  const safeNext = typeof next === "string" && /^\/[^/]/.test(next) ? next : "/studio";
  const value = `${token}|${Buffer.from(safeNext).toString("base64")}`;
  const cookie = `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`;
  return { token, cookie, next: safeNext };
}
function readState(cookieValue, stateFromProvider) {
  if (!cookieValue) return { ok: false, next: "/studio" };
  const [token, encodedNext] = String(cookieValue).split("|");
  const next = encodedNext ? Buffer.from(encodedNext, "base64").toString("utf8") : "/studio";
  if (!token || token !== stateFromProvider) return { ok: false, next };
  return { ok: true, next };
}
const clearState = () => `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/* --------------------------------- google --------------------------------- */

function googleAuthUrl(req, state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req, "google"),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH}?${params}`;
}

async function googleProfile(req, code) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req, "google"),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(data.error_description || "Google sign-in failed.");
  const claims = decodeJwt(data.id_token);
  if (!claims || !claims.email) throw new Error("Google did not share an email address.");
  if (claims.email_verified === false) throw new Error("Please verify your Google email first.");
  return { email: claims.email, name: claims.name || claims.given_name || "", provider: "google" };
}

/* ---------------------------------- apple --------------------------------- */

function appleAuthUrl(req, state) {
  const params = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID,
    redirect_uri: redirectUri(req, "apple"),
    response_type: "code id_token",
    scope: "name email",
    response_mode: "form_post", // Apple posts the result back to us
    state,
  });
  return `${APPLE_AUTH}?${params}`;
}

async function appleProfile(req, code, idTokenFromForm, userJson) {
  let claims = idTokenFromForm ? decodeJwt(idTokenFromForm) : null;
  if (!claims && code) {
    const res = await fetch(APPLE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.APPLE_CLIENT_ID,
        client_secret: appleClientSecret(),
        redirect_uri: redirectUri(req, "apple"),
        grant_type: "authorization_code",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id_token) throw new Error(data.error_description || data.error || "Apple sign-in failed.");
    claims = decodeJwt(data.id_token);
  }
  if (!claims || !claims.email) throw new Error("Apple did not share an email address.");

  // Apple sends the display name once, on the very first authorisation only.
  let name = "";
  try {
    const parsed = typeof userJson === "string" ? JSON.parse(userJson) : userJson;
    if (parsed && parsed.name) name = [parsed.name.firstName, parsed.name.lastName].filter(Boolean).join(" ");
  } catch {}

  return { email: claims.email, name, provider: "apple" };
}

module.exports = {
  STATE_COOKIE,
  providers,
  googleConfigured,
  appleConfigured,
  googleAuthUrl,
  googleProfile,
  appleAuthUrl,
  appleProfile,
  makeState,
  readState,
  clearState,
  baseUrl,
  redirectUri,
};
