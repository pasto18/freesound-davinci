#!/bin/bash
# Genera "Freesound Ableton.app" (app independiente, sin Resolve) en ./dist
set -e
cd "$(dirname "$0")"
STAGE="$(mktemp -d)/app"
mkdir -p "$STAGE"
for f in main.js preload.js renderer.js index.html css img; do cp -R "$f" "$STAGE/"; done
touch "$STAGE/ableton.flag"
cat > "$STAGE/package.json" <<'JSON'
{ "name": "freesound-ableton", "version": "1.0.0", "main": "main.js" }
JSON
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
npx --yes @electron/packager "$STAGE" "Freesound Ableton" --platform=darwin --arch=$ARCH --out dist --overwrite \
  --electron-version="$(node -p "require('./node_modules/electron/package.json').version")"
echo "Listo: dist/Freesound Ableton-darwin-$ARCH/Freesound Ableton.app"
