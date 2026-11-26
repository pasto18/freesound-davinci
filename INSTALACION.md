# Instalar Freesound + GIFs en DaVinci Resolve (Mac)

Guía paso a paso. No hace falta saber programar. Tiempo: ~10 minutos.

## Qué necesitás
- Una Mac con **DaVinci Resolve Studio** (la versión paga). Los plugins "Workflow Integration" **no funcionan en la versión gratuita**.
- Una cuenta gratis en Freesound y otra en Giphy (los pasos de abajo te dicen cómo sacar las claves).
- La carpeta del plugin que te pasó tu amigo (`freesound-davinci.zip`).

---

## Paso 1: Sacar tus claves (gratis)

### 1A. Freesound
1. Creá una cuenta en https://freesound.org (si no tenés) e iniciá sesión.
2. Andá a https://freesound.org/apiv2/apply y completá el formulario:
   - **Name**: lo que quieras (ej. "Mi DaVinci")
   - **Description**: cualquier cosa (ej. "Buscar sonidos para editar")
   - **Callback URL**: copiá EXACTAMENTE esto: `http://localhost:8765/callback`
3. Al enviar te muestra dos datos. **Copialos en un bloc de notas**:
   - **Client id**
   - **Client secret / API key** (la clave larga)

> Si ya creaste la app, la encontrás en https://freesound.org/apiv2/apply (lista de "Your API credentials"). Verificá que el Callback URL sea el de arriba.

### 1B. Giphy (para los GIFs)
1. Entrá a https://developers.giphy.com/dashboard e iniciá sesión / creá cuenta.
2. **Create an App** → elegí **API** (no SDK) → poné un nombre → aceptá.
3. Copiá la **API Key** que aparece.

---

## Paso 2: Descomprimir el plugin
1. Poné `freesound-davinci.zip` en el Escritorio y hacé doble clic para descomprimir.
2. Te queda una carpeta `freesound-davinci` en el Escritorio.

## Paso 3: Instalar (automático)
1. Abrí la app **Terminal** (Cmd + Espacio, escribí "Terminal", Enter).
2. Escribí `cd ` (con un espacio al final), **arrastrá la carpeta `freesound-davinci` a la ventana de Terminal** y apretá Enter.
3. Pegá este comando y apretá Enter:
   ```
   ./install.sh
   ```
   - Si dice "permission denied", primero ejecutá `chmod +x install.sh` y repetí.
   - Si macOS dice que no puede verificar `WorkflowIntegration.node`, andá al Paso 6 (Problemas).
4. Te pide la **contraseña de tu Mac** (al escribirla no se ve nada; es normal). Enter.
5. Después te hace estas preguntas (pegá cada dato y Enter; lo que está entre `[ ]` es el valor por defecto si apretás solo Enter):
   - **Freesound Client ID** → pegá el del paso 1A
   - **Freesound Client Secret** → pegá el del paso 1A
   - **Giphy API key** → pegá la del paso 1B
   - **Carpeta donde se descargan los SONIDOS** → escribí la ruta que quieras (ver abajo)
   - **Carpeta donde se descargan los GIFs** → ídem

> **Tip para la ruta de carpeta:** creá la carpeta en Finder, arrastrala a la Terminal en el momento de la pregunta y se escribe sola su ruta. Ejemplo: `/Users/tunombre/Desktop/Sonidos`.

Cuando termina dice "Listo".

## Paso 4: Abrir en DaVinci Resolve
1. **Cerrá DaVinci Resolve por completo** (Cmd + Q) y volvé a abrirlo.
2. Abrí tu proyecto y andá a la página **Edit** (Montaje).
3. Menú superior: **Workspace → Workflow Integrations → Freesound**.
4. Se abre el panel. La primera vez tocá **"Iniciar sesión en Freesound"**: se abre el navegador, aceptá "Authorize", y volvé a Resolve. Se hace una sola vez.

## Paso 5: Usarlo
- **Sonidos**: buscá, escuchá el preview, tocá descargar/insertar. Se baja a tu carpeta de sonidos y se inserta en la timeline en la posición del playhead.
- **GIFs**: pestaña de Giphy. Se bajan como MP4 (sin audio) a tu carpeta de GIFs y se insertan en una pista de video.
- **Local**: navega los archivos que ya descargaste.
- Los créditos (autor, licencia, link) quedan en `~/.freesound-davinci/credits.json`.

---

## Actualizar el plugin
Cuando haya una versión nueva, al abrir el panel aparece arriba una barra verde: **"Nueva versión disponible"**. Tocá **Actualizar**, esperá el mensaje "Listo" y reiniciá DaVinci Resolve (Cmd + Q y volver a abrirlo). Tus claves y carpetas no se tocan. (Necesita internet.)

---

## Cambiar las carpetas después
Las carpetas se guardan en un archivo de texto:

1. En Finder: menú **Ir → Ir a la carpeta…** (Cmd + Shift + G).
2. Pegá `~/.freesound-davinci` y Enter.
3. Abrí `config.json` con TextEdit (clic derecho → Abrir con → TextEdit).
4. Cambiá estas líneas (mantené las comillas y la coma al final):
   ```
   "downloadDir": "/Users/tunombre/Desktop/Sonidos",
   "localDir": "/Users/tunombre/Desktop/Sonidos",
   "gifDir": "/Users/tunombre/Desktop/GIFs",
   ```
   - `downloadDir`: donde se descargan los sonidos
   - `localDir`: carpeta que muestra la pestaña "Local" (normalmente la misma)
   - `gifDir`: donde se descargan los GIFs
5. Guardá (Cmd + S) y reiniciá Resolve.

> Si TextEdit guarda formato raro: Formato → "Convertir a texto plano" antes de guardar.

---

## Paso 6: Problemas comunes

| Síntoma | Solución |
|---|---|
| **No aparece Workflow Integrations** en el menú Workspace | Necesitás Resolve **Studio**. Reiniciá Resolve. Verificá que exista la carpeta `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.lisi.freesound` |
| **Aparece Workflow Integrations pero no "Freesound"** | El install.sh no terminó bien. Volvé a correrlo. |
| macOS bloquea `WorkflowIntegration.node` ("no se puede verificar") | Terminal: `sudo xattr -dr com.apple.quarantine "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.lisi.freesound"` y reiniciá Resolve. También conviene correr `xattr -dr com.apple.quarantine ~/Desktop/freesound-davinci` antes del Paso 3. |
| Dice "Falta config.json" | Corré `./install.sh` otra vez, o creá `~/.freesound-davinci/config.json` a mano (ver `config.example.json`). |
| "Iniciar sesión" falla / error de redirect | En https://freesound.org/apiv2/apply el Callback URL debe ser exactamente `http://localhost:8765/callback`. |
| Los GIFs dan error | Revisá `giphyApiKey` en `config.json`. |
| "No se pudo inicializar la API de Resolve" | En Resolve: **DaVinci Resolve → Preferences → System → General → External scripting using: Local**. Reiniciá Resolve. |
| Cambié el config y no pasa nada | Cerrá el panel y reiniciá Resolve. |

## Desinstalar
```
sudo rm -rf "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.lisi.freesound"
rm -rf ~/.freesound-davinci
```

---

# Para quien comparte (Lisi): publicar una actualización
El código está en https://github.com/pasto18/freesound-davinci. Para que a tu amigo le aparezca el botón:

```
cd ~/Desktop/APPs/freesound-davinci
# 1. Subí el número "version" en package.json (ej. 1.0.1 -> 1.0.2)
git add -A && git commit -m "Descripción del cambio" && git push
```
Sin subir la versión no aparece el aviso. Para instalarlo en tu Resolve: `./install.sh`.

La primera vez, tu amigo instala con el zip (Paso 2 en adelante); desde ahí se actualiza solo con el botón. El zip no debe llevar `node_modules`, `dist` ni `config.json` (claves personales):

```
cd ~/Desktop/APPs && rm -f freesound-davinci.zip && zip -qr freesound-davinci.zip freesound-davinci -x "*/node_modules/*" "*/dist/*" "*/.DS_Store" "*/config.json" "*/.git/*"
```
