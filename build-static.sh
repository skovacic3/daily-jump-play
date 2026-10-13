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
# Before the game starts, find the live server: the address in ../url.json, if it answers
# /api/config and allows this site (CORS).  Otherwise none: offline mode.
python3 - "$P/game/index.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
tag = '<script src="game.js"></script>'
assert s.count(tag) == 1
s = s.replace(tag, """<script>
    // Which server to play with: the live one, if it answers and allows this site.
    (async () => {
      try {
        const { url } = await (await fetch('../url.json?' + Date.now(), { cache: 'no-store' })).json();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        const cfg = await (await fetch(url + '/api/config', { signal: ctl.signal })).json();
        clearTimeout(timer);
        window.DJ_API = cfg && cfg.cors ? url : null;
      } catch {
        window.DJ_API = null; // away (or not yet allowing this site): offline mode
      }
      const g = document.createElement('script');
      g.src = 'game.js';
      document.body.appendChild(g);
    })();
  </script>""")
open(p, 'w').write(s)
PY

echo "static copy refreshed in $P/game"
