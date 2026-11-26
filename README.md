# Freesound para DaVinci Resolve Studio

Workflow Integration Plugin: busca en Freesound, preview con waveform, descarga el original a una carpeta fija e inserta el sonido en el playhead de la timeline activa.

## Setup
1. Registrá una app en https://freesound.org/apiv2/apply y poné como Callback URL: `http://localhost:8765/callback`
2. `./install.sh` (copia el plugin a Resolve y crea `~/.freesound-davinci/config.json`; guía completa en INSTALACION.md)
3. Editá `~/.freesound-davinci/config.json` con `clientId`, `clientSecret` y `downloadDir`
4. Reiniciá Resolve > Workspace > Workflow Integrations > Freesound
5. En el panel: "Iniciar sesión en Freesound" (una vez)

Créditos (autor/licencia/link) de lo descargado: `~/.freesound-davinci/credits.json`.

## GIFs (Giphy)
1. Creá una app en https://developers.giphy.com/dashboard (API key gratis) y poné `giphyApiKey` en `~/.freesound-davinci/config.json`.
2. `gifDir` es la carpeta donde se guardan los GIFs descargados (por defecto, `GIFs` junto a `downloadDir`) y donde busca "Local".
3. Los GIFs de Giphy se descargan como MP4 (sin audio) y se insertan en una pista de video; los `.gif` locales dependen de que tu versión de Resolve los importe.

## Modo dev (trabajar la interfaz sin Resolve)
```
npm install   # solo la primera vez
npm run dev
```
Abre el panel como app independiente, con búsqueda real (Freesound, Giphy, Local) y DevTools. "Insertar" no hace nada real, solo simula el resultado. Los cambios en css se aplican solos al guardar; index.html y renderer.js recargan la ventana solos. main.js/preload.js requieren reiniciar `npm run dev`.
