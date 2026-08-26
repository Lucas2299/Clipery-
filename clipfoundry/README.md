# Clipery

Full working AI clip studio:

- **Studio** — upload or sample → Viral clips **or** Ranking analysis
- **Rank links** — paste TikTok/short URLs → scored board + playbook
- **Library / Job pages** — every job saved, clips playable & downloadable
- **Pricing + Waitlist**

## Run

```bash
cd clipfoundry

# Optional: auto-subtitles (TikTok-style captions, on/off per job in Studio)
# needs Python + the PocketSphinx speech engine on the server:
pip install pocketsphinx
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
