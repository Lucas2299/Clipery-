# Clipery — all-in-one image: Node.js + video tools + subtitle engine.
# A hosting platform (Railway, Render, Fly.io, any Docker host) builds this
# automatically on every deploy — no manual installs, ever.

FROM node:20-bookworm-slim

# System tools the app calls from the command line:
#   ffmpeg/ffprobe -> clip cutting, scene detection, caption burning
#   yt-dlp         -> "paste a link" downloads
#   pocketsphinx   -> subtitle speech-to-text engine
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip ca-certificates curl \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp pocketsphinx \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
