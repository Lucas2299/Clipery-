# Clipery — all-in-one image: Node.js + video tools + subtitle engine.
# A hosting platform (Railway, Render, Fly.io, any Docker host) builds this
# automatically on every deploy — no manual installs, ever.

FROM node:20-bookworm-slim

# System tools the app calls from the command line:
#   ffmpeg/ffprobe -> clip cutting, scene detection, caption burning
#   yt-dlp         -> "paste a link" downloads
#   fonts-dejavu   -> drawtext needs a real font file for labels and captions
#   libglib2.0-0   -> OpenCV runtime dependency
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip ca-certificates curl \
       fonts-dejavu-core fontconfig libglib2.0-0 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Python brains:
#   faster-whisper           -> the transcript. Everything smart depends on it:
#                               hook scoring, story beats, payoff detection,
#                               karaoke captions.
#   opencv-python-headless   -> face tracking for smart reframing, so the 9:16
#                               crop follows the speaker instead of the centre.
#                               Pinned below 5: OpenCV 5 removed the classic
#                               face cascade the tracker uses.
#   yt-dlp                   -> downloads from a pasted link.
#   pocketsphinx             -> tiny offline fallback when whisper is disabled.
RUN pip3 install --no-cache-dir --break-system-packages \
      faster-whisper \
      "opencv-python-headless<5" \
      yt-dlp \
      pocketsphinx \
  || pip3 install --no-cache-dir faster-whisper "opencv-python-headless<5" yt-dlp pocketsphinx

# Bake the speech model into the image. Without this the FIRST clip of every
# fresh container stalls for a minute downloading ~150MB, and a read-only or
# offline host fails outright. Build arg lets you pick tiny|base|small.
ARG WHISPER_MODEL=base
ENV CLIPERY_WHISPER_MODEL=${WHISPER_MODEL}
ENV HF_HOME=/models
RUN mkdir -p /models \
  && python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')" \
  || echo "model prefetch skipped - it will download on first use"

WORKDIR /app
COPY . .

# Clip files, jobs and accounts live here. Mount a volume on this path or a
# redeploy wipes every user's library.
VOLUME ["/app/data", "/app/public/clips"]

ENV PORT=3000
ENV PYTHON=python3
EXPOSE 3000

# Fail the container if the site stops answering, so hosts restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
