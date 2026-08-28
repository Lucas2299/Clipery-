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

echo "== 2/4 Video tools (ffmpeg, ffprobe) =="
apt-get update && apt-get install -y ffmpeg python3 python3-pip

echo "== 3/4 Downloader + subtitle engine (yt-dlp, PocketSphinx) =="
pip3 install --break-system-packages yt-dlp pocketsphinx 2>/dev/null \
  || pip3 install yt-dlp pocketsphinx

echo "== 4/4 Done =="
echo ""
echo "Now run your site:"
echo "  cd clipery"
echo "  npm start        # or: PORT=80 npm start"
echo "Then open http://localhost:3000 (or your server address)"
