#!/bin/bash
# Refreshes the static copy of the game in game/ (served by GitHub Pages as the permanent
# link's fallback while the server is away: offline mode — rooms built in the browser,
# results kept on the device, no leaderboards).  Browser files only: no server code.
set -eu
P="$(cd "$(dirname "$0")" && pwd)"
G=/Users/svenkovacic/Projects/daily-game
BASE=https://skovacic3.github.io/daily-jump-play
mkdir -p "$P/game"
for f in game.js rooms-worker.js sw.js manifest.webmanifest favicon.svg icon-192.png icon-512.png apple-touch-icon.png og.jpg; do cp "$G/$f" "$P/game/$f"; done
sed -e "s|%ORIGIN%|$BASE/game|g" -e "s|%SHARE_URL%|$BASE/|g" "$G/index.html" > "$P/game/index.html"
grep -q '%ORIGIN%\|%SHARE_URL%' "$P/game/index.html" && { echo "placeholder left in index.html"; exit 1; }
echo "static copy refreshed in $P/game"
