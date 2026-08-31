# Clipery

Full working AI clip studio:

- **Studio** — upload or sample → Viral clips **or** Ranking analysis
- **Rank links** — paste TikTok/short URLs → scored board + playbook
- **Library / Job pages** — every job saved, clips playable & downloadable
- **Pricing + Waitlist**

## Run

```bash
cd clipery

# Optional: auto-subtitles (TikTok-style captions, on/off per job in Studio)
# needs Python + the PocketSphinx speech engine on the server:
pip install pocketsphinx

## Deploying

- **Docker hosting (Railway / Render / Fly.io):** connect the repo — the included
  `Dockerfile` installs Node, ffmpeg, yt-dlp and the subtitle engine automatically
  on every deploy. Nothing else to do.
- **Plain VPS (Ubuntu/Debian):** run once: `sudo bash setup.sh`, then `npm start`.
npm start
```

Open http://localhost:3000

## Routes

| Path | Page |
|------|------|
| `/` | Landing |
| `/studio` | Clip engine (mode switcher) |
| `/rank` | TikTok link ranking |
| `/library` | All jobs |
| `/job/:id` | Job detail + live progress |
| `/pricing` | Packages |
| `/waitlist` | Founding waitlist |

## API

- `GET /api/health`
- `GET /api/modes`
- `POST /api/clip/sample` `{ mode: "viral"|"ranking" }`
- `POST /api/clip/upload` multipart `video` + `mode`
- `GET /api/clip/status/:id`
- `GET /api/jobs`
- `GET/POST /api/rank/links`
- `GET /api/rank/links/:id`
- `GET/POST /api/waitlist`

## Sign in with Google / Apple (optional)

Email + password works out of the box. To switch on the social buttons, set
these environment variables before `npm start` — any provider you leave unset
is simply hidden on the login page.

```bash
# Google — https://console.cloud.google.com/apis/credentials
# Create an "OAuth client ID" (Web application) and add this redirect URI:
#   https://YOUR-DOMAIN/api/auth/google/callback
export GOOGLE_CLIENT_ID="....apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="...."

# Apple — https://developer.apple.com/account/resources/identifiers
# Needs a Services ID + a Sign in with Apple key (.p8). Return URL:
#   https://YOUR-DOMAIN/api/auth/apple/callback
export APPLE_CLIENT_ID="com.yourcompany.clipery.web"   # the Services ID
export APPLE_TEAM_ID="ABCDE12345"
export APPLE_KEY_ID="XYZ9876543"
export APPLE_PRIVATE_KEY_FILE="/path/to/AuthKey_XYZ9876543.p8"

# Only needed behind a proxy/CDN so the redirect URI is built correctly
export BASE_URL="https://YOUR-DOMAIN"
```

Apple requires HTTPS for the return URL, so Apple sign-in cannot be tested on
plain `http://localhost` — Google can.
