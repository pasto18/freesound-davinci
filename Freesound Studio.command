#!/bin/bash
# Abre Freesound Studio standalone desde el código fuente (sin compilar, sin DaVinci).
cd "$(dirname "$0")"
git pull --ff-only >/dev/null 2>&1 || true   # trae actualizaciones de GitHub (si hay)
ABLETON=1 exec ./node_modules/.bin/electron . >/dev/null 2>&1
