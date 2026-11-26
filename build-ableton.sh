#!/bin/bash
# Genera "Freesound Studio.app" (Sonidos + GIFs + SVG, app independiente sin Resolve) en ./dist
set -e
cd "$(dirname "$0")"
STAGE="$(mktemp -d)/app"
mkdir -p "$STAGE"
for f in main.js preload.js renderer.js index.html css img; do cp -R "$f" "$STAGE/"; done
touch "$STAGE/ableton.flag"
VERSION=$(node -p "require('./package.json').version")
cat > "$STAGE/package.json" <<JSON
{ "name": "freesound-studio", "version": "$VERSION", "main": "main.js" }
JSON
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] || ARCH=x64
npx --yes @electron/packager "$STAGE" "Freesound Studio" --platform=darwin --arch=$ARCH --out dist --overwrite --no-asar \
  --electron-version="$(node -p "require('./node_modules/electron/package.json').version")"
echo "Listo: dist/Freesound Studio-darwin-$ARCH/Freesound Studio.app"
