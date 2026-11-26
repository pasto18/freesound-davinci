# Freesound para DaVinci Resolve Studio

Workflow Integration Plugin: busca en Freesound, preview con waveform, descarga el original a una carpeta fija e inserta el sonido en el playhead de la timeline activa.

## Setup
1. Registrá una app en https://freesound.org/apiv2/apply y poné como Callback URL: `http://localhost:8765/callback`
2. `./install.sh` (copia el plugin a Resolve y crea `~/.freesound-davinci/config.json`; guía completa en INSTALACION.md)
3. Editá `~/.freesound-davinci/config.json` con `clientId`, `clientSecret` y `downloadDir`
4. Reiniciá Resolve > Workspace > Workflow Integrations > Freesound
5. En el panel: "Iniciar sesión en Freesound" (una vez)

Créditos (autor/licencia/link) de lo descargado: `~/.freesound-davinci/credits.json`.

## Audio IA (ElevenLabs)
1. Poné `elevenlabsApiKey` en `~/.freesound-davinci/config.json` (la clave se crea en elevenlabs.io → Developers → API Keys; si la restringís, habilitá Text to Speech, Sound Effects y Voices read).
2. Pestaña **Audio IA**: elegí **Voz** (texto + voz + modelo) o **Efecto de sonido** (descripción, duración opcional) y tocá **Generar**.
3. Los audios se guardan en `elevenlabsDir` (por defecto `~/Sounds/ElevenLabs`) y quedan en la lista: preview, arrastrar a la timeline o "Insertar en playhead". Cada generación gasta créditos de tu plan.

## YouTube
1. Necesita `yt-dlp` y `ffmpeg`: en Terminal, `brew install yt-dlp ffmpeg`.
2. Pestaña **YouTube**: buscá por texto o pegá un enlace. La miniatura se reproduce en baja calidad; **⤢ Ampliar** abre una ventana más grande.
3. Seleccioná un trozo con la barra (arrastrá los marcadores azul/verde) o con **⟦ Entrada / Salida ⟧** en el momento actual del video.
4. **Descargar** el video completo o solo la selección (H.264/AAC, hasta 1080p). Se guarda en la carpeta `youtubeDir` (por defecto `~/Sounds/YouTube`, editable en ⚙ Configuración). Después arrastrá el archivo a la timeline o usá "Insertar en playhead" (video + audio en la misma pista).
5. Selector **Descargar** (junto a la pista, siempre visible en esta pestaña): **Video + audio**, **Solo video** (sin audio) o **Solo audio** (M4A/AAC). Vale para el video completo y para la selección, y lo inserta en la pista de video o de audio según corresponda.
6. Teclado: **barra espaciadora** = pausa/reproducir; **← / →** = un fotograma atrás/adelante (con **Shift**, 10 fotogramas). Actúa sobre la ventana ampliada si está abierta, o si no sobre el último video reproducido.
7. La barra propia del programa (con la línea roja) se puede **arrastrar**: el video muestra los fotogramas mientras pasas. Si estaba reproduciendo, sigue al soltar. Sobre una miniatura que aún no se reprodujo, la carga en pausa en ese fotograma.
8. Selector **Calidad mín.** (junto a "Descargar"): solo muestra videos que tengan al menos esa calidad.
   - **720p (HD)** y **2160p (4K)** usan los filtros de YouTube: instantáneo y exacto.
   - **1080p, 1440p y 8K** filtran con HD/4K y luego comprueban la resolución real de cada video, de a pocos y con las tarjetas apareciendo a medida que se verifican (muchas comprobaciones seguidas hacen que YouTube pida confirmar que no sos un robot).
   - **144p a 480p** no filtran (YouTube no tiene ese filtro y casi todos los videos los alcanzan).
   Cada tarjeta muestra la calidad máxima encontrada (HD, 4K, 1080p...).
9. Descargar de YouTube puede ir contra sus condiciones de uso y contra los derechos de autor: usalo solo con material que tengas derecho a usar.

## GIFs (Giphy)
1. Creá una app en https://developers.giphy.com/dashboard (API key gratis) y poné `giphyApiKey` en `~/.freesound-davinci/config.json`.
2. `gifDir` es la carpeta donde se guardan los GIFs descargados (por defecto, `GIFs` junto a `downloadDir`) y donde busca "Local".
3. Los GIFs de Giphy se descargan como MP4 (sin audio) y se insertan en una pista de video; los `.gif` locales dependen de que tu versión de Resolve los importe.

## SVG (SVG Repo)
SVG Repo no tiene API ni key: la app lee el sitio con una ventana oculta de Chromium. Pestaña **SVG** con los filtros de estilo (Monocolor, Multicolor, Duotone, Outlined, Filled, Icon, Glyph, Rounded, Sharp).
- `svgDir` (por defecto `SVG` junto a `downloadDir`) es donde se guardan y donde busca "Local".
- Arrastrá la tarjeta a Affinity/Finder para llevar el `.svg`. El botón **PNG** genera un PNG transparente de 1024 px junto al SVG.
- En Resolve, **Insertar** convierte a PNG y lo pone en el playhead (pista de video).
- Licencia/autor de cada SVG en `credits.json`.

## App independiente (Sonidos + GIFs + SVG, sin Resolve)
`./build-ableton.sh` genera `dist/Freesound Studio-darwin-*/Freesound Studio.app`. Se usa arrastrando archivos a Ableton, Affinity, etc.

## Modo dev (trabajar la interfaz sin Resolve)
```
npm install   # solo la primera vez
npm run dev
```
Abre el panel como app independiente, con búsqueda real (Freesound, Giphy, Local) y DevTools. "Insertar" no hace nada real, solo simula el resultado. Los cambios en css se aplican solos al guardar; index.html y renderer.js recargan la ventana solos. main.js/preload.js requieren reiniciar `npm run dev`.
