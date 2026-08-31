# How to make "Continue with Google" work

You need two secret strings from Google — a **Client ID** and a **Client secret**.
They are free. The whole thing takes about 5 minutes.

---

## 1. Open Google Cloud Console

Go to **https://console.cloud.google.com/**

Sign in with the Google account you want to own the app (your normal Gmail is fine).

## 2. Make a project

Top-left, click the project dropdown → **New project**.

- Name: `Clipery`
- Click **Create**, then make sure the project dropdown shows **Clipery**.

## 3. Fill the consent screen

Left menu → **APIs & Services** → **OAuth consent screen**.

- User type: **External** → **Create**
- App name: `Clipery`
- User support email: your email
- Developer contact email: your email
- **Save and continue** through *Scopes* (change nothing)
- On **Test users** → **Add users** → type your own Gmail address → **Save**

> While the app is in "Testing" mode, only the emails listed as test users can log
> in. Add yourself, or anyone else you want to try it. Later you can press
> **Publish app** to open it to everybody.

## 4. Create the credentials

Left menu → **APIs & Services** → **Credentials** → **+ Create credentials** →
**OAuth client ID**.

- Application type: **Web application**
- Name: `Clipery web`
- Under **Authorised redirect URIs** click **+ Add URI** and paste exactly:

```
http://localhost:3000/api/auth/google/callback
```

If you also run Clipery on a real domain, add that one too:

```
https://YOUR-DOMAIN.com/api/auth/google/callback
```

Click **Create**. A popup shows:

- **Client ID** — looks like `812345678901-abc123def456.apps.googleusercontent.com`
- **Client secret** — looks like `GOCSPX-aBcD1234EfGh5678`

Copy both (you can reopen them any time from the Credentials list).

## 5. Put them in Clipery

In your Clipery folder there is a file `clipery/.env.example`. Copy it to
`clipery/.env` and paste your two values:

```bash
cd ~/Desktop/Clipery/clipery
cp .env.example .env
```

Then edit `.env` so it looks like this (no quotes, no spaces around `=`):

```
GOOGLE_CLIENT_ID=812345678901-abc123def456.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-aBcD1234EfGh5678
```

`.env` is in `.gitignore`, so your secret never gets pushed to GitHub.

## 6. Restart the server

```bash
cd ~/Desktop/Clipery/clipery
npm start
```

You should see this line in the terminal:

```
[env] loaded clipery/.env
```

Open **http://localhost:3000/login** — the white **Continue with Google** button
is there. Click it, pick your Google account, and you land in the Studio,
already logged in.

---

## If something goes wrong

| What you see | What it means | Fix |
|---|---|---|
| No Google button at all | The server has no keys | `.env` is missing, in the wrong folder, or the server wasn't restarted. It must be at `clipery/.env`, next to `server.js`. Look for `[env] loaded clipery/.env` on start. |
| `Error 400: redirect_uri_mismatch` | The URI in Google ≠ the URI Clipery sent | Copy the URI from the error message and add it to your Google credentials, character for character. Most often it's `http` vs `https`, or a missing `/api/auth/google/callback`. |
| `Error 403: access_denied` | Your app is in Testing mode and this Gmail isn't a test user | OAuth consent screen → Test users → add that address (or Publish the app). |
| `Sign-in expired. Please try again.` | The 10-minute state cookie ran out, or cookies are blocked | Just click the button again. |
| Works on localhost, fails on your domain | The live URL isn't registered | Add `https://YOUR-DOMAIN.com/api/auth/google/callback` in Google, and set `BASE_URL=https://YOUR-DOMAIN.com` in `.env`. |

---

## Apple (optional, later)

Sign in with Apple needs a paid Apple Developer account ($99/year), a Services
ID, and a downloaded `.p8` key — and Apple refuses `http://localhost`, so it can
only be tested on a real HTTPS domain. Everything is already coded; you just fill
in `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID` and
`APPLE_PRIVATE_KEY_FILE` in the same `.env` when you're ready.
