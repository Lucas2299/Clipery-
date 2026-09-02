# Putting Clipery on the internet

You do not install ffmpeg, Python or anything else on the server. The
Dockerfile builds an image that already contains all of it. The host reads that
file and does the work.

## What the machine needs

| Thing | Minimum | Why |
| --- | --- | --- |
| RAM | 2 GB | whisper + ffmpeg together need roughly 1.5 GB while a video renders |
| Disk | 20 GB | rendered clips add up; the cleanup keeps 30 days by default |
| CPU | 2 cores | a 10 minute video takes a few minutes of solid CPU |

A 512 MB free tier will crash in the middle of the first job. Vercel and
Netlify cannot run this at all: no ffmpeg, no background work, no disk.

## Storage that survives a deploy

Accounts and clips are files on disk:

    data/            accounts, sessions, job records
    public/clips/    the rendered videos

Most hosts wipe the filesystem on every deploy. Attach a volume to BOTH paths
or every account and every clip disappears the next time you push. In
docker-compose this is already done; on Railway/Render you add them in the
dashboard.

## Settings to fill in

Set these as environment variables on the host (not in a file you commit):

    BASE_URL=https://yourdomain.com     your public address
    ADMIN_EMAILS=you@example.com        who gets the owner dashboard
    GOOGLE_CLIENT_ID=...                only if you use Google sign-in
    GOOGLE_CLIENT_SECRET=...
    CLIPERY_RETENTION_DAYS=30           delete clips older than this (0 = never)

BASE_URL matters more than it looks: it fixes the Google redirect URI and
switches the login cookie to Secure.

If you use Google sign-in, add this to the Google Cloud console under
Credentials -> your OAuth client -> Authorised redirect URIs:

    https://yourdomain.com/api/auth/google/callback

## Deploying

Docker host (Railway, Render, Fly, Coolify, Dokku):

1. Point it at this repository. It finds `clipery/Dockerfile` on its own.
2. Set the environment variables above.
3. Add volumes for `/app/data` and `/app/public/clips`.
4. Deploy. The first build takes several minutes (it bakes in the speech model).

Plain VPS (Hetzner, DigitalOcean, Contabo):

    git clone <your repo> && cd Clipery
    sudo bash clipery/setup.sh      # installs node, ffmpeg, the python brains
    cd clipery && npm start

Then put nginx or Caddy in front for HTTPS. Caddy is two lines and gets you a
certificate automatically.

## After it is live

    node scripts/doctor.js      # is everything installed?
    curl https://yourdomain.com/api/health

Housekeeping runs by itself: old clips are deleted, dead sessions are purged,
and any job that was interrupted by a restart is marked failed instead of
spinning forever.

## Known limits

- One video renders at a time. Others wait in line; past 20 waiting, new
  uploads are turned away with a clear message. Raise CLIPERY_MAX_QUEUE only
  if the machine can take it.
- Accounts live in JSON files, which is fine for hundreds of users, not
  hundreds of thousands.
- There is no payment integration. Plans are set by hand from the owner
  dashboard.
