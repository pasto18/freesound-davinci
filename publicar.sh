#!/bin/bash
# Publica una actualización: sube la versión, hace commit y push. Uso: ./publicar.sh "qué cambió"
set -e
cd "$(dirname "$0")"
[ -n "$1" ] || { echo 'Uso: ./publicar.sh "descripción del cambio"'; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { echo "Tenés que estar en la rama main."; exit 1; }
for f in main.js preload.js renderer.js; do node --check "$f"; done
VERSION=$(npm version patch --no-git-tag-version)
git add -A
git commit -q -m "$1 ($VERSION)"
git push -q origin main
echo "Publicada la versión $VERSION. A tu socio le aparece el aviso al abrir la app (puede tardar unos 5 minutos)."
