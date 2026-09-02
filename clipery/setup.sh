#!/usr/bin/env bash
# Clipery one-time server setup (Ubuntu/Debian/Mint).
# Run once on a fresh server:  sudo bash setup.sh
set -e

echo "== 1/4 Node.js 20 =="
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== 2/4 Video tools (ffmpeg, ffprobe, fonts) =="
apt-get update && apt-get install -y ffmpeg python3 python3-pip \
  fonts-dejavu-core fontconfig libglib2.0-0

echo "== 3/4 Brains (yt-dlp, whisper transcript, OpenCV face tracking) =="
# faster-whisper       -> transcript: hooks, story beats, payoff, captions
# opencv-python-headless -> smart reframing: the crop follows the speaker
# yt-dlp               -> paste-a-link downloads
# pocketsphinx         -> tiny fallback if whisper is unavailable
# opencv pinned below 5: OpenCV 5 removed the face cascade we track with
PKGS="yt-dlp faster-whisper opencv-python-headless<5 pocketsphinx"
pip3 install --break-system-packages $PKGS 2>/dev/null \
  || pip3 install $PKGS

echo "== 4/4 Checking what made it =="
node clipery/scripts/doctor.js 2>/dev/null || node scripts/doctor.js 2>/dev/null || true
echo ""
echo "Now run your site:"
echo "  cd clipery"
echo "  npm start        # or: PORT=80 npm start"
echo "Then open http://localhost:3000 (or your server address)"
