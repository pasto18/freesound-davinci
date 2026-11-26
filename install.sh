#!/bin/bash
# Instala el plugin Freesound/GIFs en DaVinci Resolve y crea la configuración.
set -e
cd "$(dirname "$0")"

PLUGIN_DIR="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.lisi.freesound"
DATA_DIR="$HOME/.freesound-davinci"
CONFIG="$DATA_DIR/config.json"

echo "== 1/2  Copiando el plugin a DaVinci Resolve (te va a pedir la contraseña de tu Mac) =="
sudo mkdir -p "$PLUGIN_DIR"
sudo cp -R main.js preload.js renderer.js index.html manifest.xml package.json WorkflowIntegration.node css img "$PLUGIN_DIR/"
sudo chown -R "$(id -un)" "$PLUGIN_DIR"   # permite que el botón Actualizar funcione sin contraseña
sudo chmod -R a+rX "$PLUGIN_DIR"
echo "OK: plugin instalado."

echo
echo "== 2/2  Configuración =="
mkdir -p "$DATA_DIR"
if [ -f "$CONFIG" ]; then
    echo "Ya existe $CONFIG, no lo toco. Editalo a mano si querés cambiar algo."
    exit 0
fi

ask() { # ask "pregunta" "valor por defecto"
    local r; read -r -p "$1 [$2]: " r; echo "${r:-$2}"
}
CLIENT_ID=$(ask "Freesound Client ID" "")
CLIENT_SECRET=$(ask "Freesound Client Secret (API key)" "")
GIPHY=$(ask "Giphy API key (Enter para saltear)" "")
SOUNDS=$(ask "Carpeta donde se descargan los SONIDOS" "$HOME/Desktop/Sonidos")
GIFS=$(ask "Carpeta donde se descargan los GIFs" "$HOME/Desktop/GIFs")
mkdir -p "$SOUNDS" "$GIFS"

cat > "$CONFIG" <<JSON
{
    "clientId": "$CLIENT_ID",
    "clientSecret": "$CLIENT_SECRET",
    "redirectPort": 8765,
    "downloadDir": "$SOUNDS",
    "localDir": "$SOUNDS",
    "giphyApiKey": "$GIPHY",
    "gifDir": "$GIFS",
    "giphyRating": "pg-13"
}
JSON
chmod 600 "$CONFIG"
echo
echo "Listo. Config guardada en $CONFIG"
echo "Ahora abrí (o reiniciá) DaVinci Resolve > Workspace > Workflow Integrations > Freesound"
