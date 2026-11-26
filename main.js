const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
// DEV=1 (npm run dev): run standalone for UI work, without Resolve.
const DEV = process.env.DEV === '1';
// Ableton edition: standalone window, drag files into Live (no Resolve API).
// Enabled by ABLETON=1 (npm run ableton) or by an ableton.flag file next to main.js (packaged app).
const ABLETON = process.env.ABLETON === '1' || require('fs').existsSync(require('path').join(__dirname, 'ableton.flag'));
const WorkflowIntegration = (DEV || ABLETON) ? null : require('./WorkflowIntegration.node');

const PLUGIN_ID = 'com.lisi.freesound';
const API = 'https://freesound.org/apiv2';
const DATA_DIR = path.join(os.homedir(), '.freesound-davinci');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TOKEN_PATH = path.join(DATA_DIR, 'token.json');
const CREDITS_PATH = path.join(DATA_DIR, 'credits.json');

let mainWindow = null;

// ---------- config / tokens ----------
function expandHome(p) {
    return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function getConfig() {
    // config.json in ~/.freesound-davinci wins; the plugin folder copy is a fallback.
    const cfg = readJson(CONFIG_PATH, null) || readJson(path.join(__dirname, 'config.json'), null);
    if (!cfg || !cfg.clientId || !cfg.clientSecret || cfg.clientId.startsWith('TU_')) return null;
    return {
        redirectPort: 8765,
        ...cfg,
        downloadDir: expandHome(cfg.downloadDir || '~/Sounds/Freesound'),
        localDir: expandHome(cfg.localDir || cfg.downloadDir || '~/Sounds/Freesound'),
        gifDir: expandHome(cfg.gifDir || path.join(expandHome(cfg.downloadDir || '~/Sounds/Freesound'), '..', 'GIFs')),
        giphyRating: cfg.giphyRating || 'pg-13'
    };
}

function authHeaders(cfg, token) {
    return { Authorization: token ? `Bearer ${token.access_token}` : `Token ${cfg.clientSecret}` };
}

// ---------- freesound ----------
async function tokenRequest(cfg, params) {
    const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params });
    const res = await net.fetch(`${API}/oauth2/access_token/`, { method: 'POST', body });
    if (!res.ok) throw new Error(`OAuth: ${res.status} ${await res.text()}`);
    const t = await res.json();
    t.obtained_at = Date.now();
    writeJson(TOKEN_PATH, t);
    return t;
}

async function getToken(cfg) {
    const t = readJson(TOKEN_PATH, null);
    if (!t) return null;
    const expiresAt = t.obtained_at + (t.expires_in || 0) * 1000 - 60000;
    if (Date.now() < expiresAt) return t;
    try {
        return await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
    } catch (e) {
        fs.rmSync(TOKEN_PATH, { force: true });
        return null;
    }
}

function login() {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    return new Promise((resolve, reject) => {
        const redirectUri = `http://localhost:${cfg.redirectPort}/callback`;
        const state = Math.random().toString(36).slice(2);
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, redirectUri);
            if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
            const code = url.searchParams.get('code');
            const ok = code && url.searchParams.get('state') === state;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ok ? '<h3>Listo, ya podés volver a DaVinci Resolve.</h3>' : '<h3>Autorización cancelada.</h3>');
            server.close();
            if (!ok) return reject(new Error('Autorización cancelada'));
            try {
                await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
                resolve(true);
            } catch (e) { reject(e); }
        });
        server.on('error', reject);
        server.listen(cfg.redirectPort, '127.0.0.1', () => {
            const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', state, redirect_uri: redirectUri });
            shell.openExternal(`${API}/oauth2/authorize/?${q}`);
        });
        setTimeout(() => { server.close(); reject(new Error('Tiempo de login agotado')); }, 5 * 60 * 1000);
    });
}

async function search(event, { query, maxDuration, license, sort, page }) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    const filters = [];
    if (maxDuration) filters.push(`duration:[0 TO ${Number(maxDuration)}]`);
    if (license === 'cc0') filters.push('license:"Creative Commons 0"');
    if (license === 'commercial') filters.push('license:("Creative Commons 0" OR "Attribution")');
    const q = new URLSearchParams({
        query: query || '',
        page: String(page || 1),
        page_size: '24',
        sort: sort || 'score',
        fields: 'id,name,username,duration,license,type,filesize,tags,previews,images,url'
    });
    if (filters.length) q.set('filter', filters.join(' '));
    const token = await getToken(cfg);
    const res = await net.fetch(`${API}/search/text/?${q}`, { headers: authHeaders(cfg, token) });
    if (!res.ok) throw new Error(`Freesound: ${res.status} ${await res.text()}`);
    return await res.json();
}

function sanitize(name) {
    return name.replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function localPath(cfg, sound) {
    const ext = (sound.type || 'wav').toLowerCase();
    return path.join(cfg.downloadDir, `${sound.id}_${sanitize(path.parse(sound.name).name)}.${ext}`);
}

async function download(event, sound) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    const dest = localPath(cfg, sound);
    if (fs.existsSync(dest)) return dest;
    const token = await getToken(cfg);
    if (!token) throw new Error('Para descargar el original hay que iniciar sesión en Freesound');
    const res = await net.fetch(`${API}/sounds/${sound.id}/download/`, { headers: authHeaders(cfg, token) });
    if (!res.ok) throw new Error(`Descarga: ${res.status} ${await res.text()}`);
    fs.mkdirSync(cfg.downloadDir, { recursive: true });
    const tmp = dest + '.part';
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
    const credits = readJson(CREDITS_PATH, {});
    credits[sound.id] = { name: sound.name, author: sound.username, license: sound.license, url: sound.url, file: dest };
    writeJson(CREDITS_PATH, credits);
    return dest;
}


// ---------- local library (kind: 'sfx' | 'gif') ----------
const EXTS = {
    sfx: new Set(['.wav', '.mp3', '.flac', '.ogg', '.aif', '.aiff', '.m4a', '.aac']),
    gif: new Set(['.gif', '.mp4', '.mov', '.webm', '.m4v'])
};
const MAX_WAVE_BYTES = 80 * 1024 * 1024;
const localIndex = {};

function kindDir(cfg, kind) { return path.resolve(kind === 'gif' ? cfg.gifDir : cfg.localDir); }

// Resolves a path relative to the kind's root, refusing anything that escapes it.
function localResolve(cfg, rel, kind) {
    const root = kindDir(cfg, kind);
    const abs = path.resolve(root, rel || '');
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Ruta fuera de la carpeta local');
    return abs;
}

function localSound(cfg, abs, kind) {
    const rel = path.relative(kindDir(cfg, kind), abs);
    return { local: true, kind, id: 'local:' + rel, name: path.basename(abs), path: abs, rel, dir: path.dirname(rel) === '.' ? '' : path.dirname(rel), type: path.extname(abs).slice(1).toLowerCase() };
}

function scanLocal(root, kind) {
    const out = [];
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile() && EXTS[kind].has(path.extname(e.name).toLowerCase())) out.push(full);
        }
    };
    walk(root);
    return out;
}

function getLocalIndex(cfg, kind, force) {
    const root = kindDir(cfg, kind);
    const idx = localIndex[kind];
    if (force || !idx || idx.root !== root || Date.now() - idx.at > 30000) {
        localIndex[kind] = { at: Date.now(), root, files: scanLocal(root, kind) };
    }
    return localIndex[kind].files;
}

// Empty query: browse one folder. With a query: search recursively inside the current folder.
async function localSearch(event, { kind, query, dir, refresh }) {
    kind = kind === 'gif' ? 'gif' : 'sfx';
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    const root = kindDir(cfg, kind);
    const base = localResolve(cfg, dir, kind);
    if (!fs.existsSync(base)) throw new Error('No existe la carpeta: ' + root);
    const terms = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
    let folders = [];
    let files;
    if (terms.length === 0) {
        const entries = fs.readdirSync(base, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
        folders = entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, rel: path.relative(root, path.join(base, e.name)) }));
        files = entries.filter((e) => e.isFile() && EXTS[kind].has(path.extname(e.name).toLowerCase())).map((e) => path.join(base, e.name));
    } else {
        files = getLocalIndex(cfg, kind, refresh).filter((f) => {
            if (f !== base && !f.startsWith(base + path.sep)) return false;
            const rel = path.relative(root, f).toLowerCase();
            return terms.every((t) => rel.includes(t));
        });
    }
    files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
    const total = files.length;
    return { root, folders, total, sounds: files.slice(0, 300).map((f) => localSound(cfg, f, kind)) };
}

async function localRead(event, rel) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    const abs = localResolve(cfg, rel, 'sfx');
    if (fs.statSync(abs).size > MAX_WAVE_BYTES) return null;
    return fs.readFileSync(abs);
}

// ---------- giphy ----------
const GIPHY = 'https://api.giphy.com/v1/gifs';

async function giphySearch(event, { query, page }) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    if (!cfg.giphyApiKey) throw new Error('Falta giphyApiKey en config.json');
    const limit = 24;
    const q = new URLSearchParams({ api_key: cfg.giphyApiKey, limit: String(limit), offset: String(((page || 1) - 1) * limit), rating: cfg.giphyRating });
    let url;
    if (query) { q.set('q', query); url = `${GIPHY}/search?${q}`; } else { url = `${GIPHY}/trending?${q}`; }
    const res = await net.fetch(url);
    if (!res.ok) throw new Error(`Giphy: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const results = (json.data || []).map((g) => {
        const im = g.images || {};
        const orig = im.original || {};
        return {
            id: g.id,
            kind: 'gif',
            name: g.title || g.slug || g.id,
            username: g.username || '',
            url: g.url,
            preview: (im.fixed_height && im.fixed_height.url) || orig.url,
            mp4: orig.mp4 || (im.hd && im.hd.mp4) || (im.looping && im.looping.mp4),
            width: Number(orig.width) || 0,
            height: Number(orig.height) || 0
        };
    });
    const total = (json.pagination && json.pagination.total_count) || results.length;
    return { count: total, results, next: (page || 1) * limit < total };
}

async function giphyDownload(event, gif) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    if (!gif.mp4 || !/^https:\/\/[\w.-]*giphy\.com\//.test(gif.mp4)) throw new Error('Este GIF no tiene MP4 descargable');
    const dest = path.join(cfg.gifDir, `${gif.id}_${sanitize(gif.name) || 'gif'}.mp4`);
    if (fs.existsSync(dest)) return dest;
    const res = await net.fetch(gif.mp4);
    if (!res.ok) throw new Error(`Descarga: ${res.status}`);
    fs.mkdirSync(cfg.gifDir, { recursive: true });
    const tmp = dest + '.part';
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, dest);
    const credits = readJson(CREDITS_PATH, {});
    credits['giphy:' + gif.id] = { name: gif.name, author: gif.username, url: gif.url, file: dest };
    writeJson(CREDITS_PATH, credits);
    return dest;
}

// ---------- resolve ----------
let resolveObj = null;

async function getResolve() {
    if (resolveObj) return resolveObj;
    if (!(await WorkflowIntegration.Initialize(PLUGIN_ID))) throw new Error('No se pudo inicializar la API de Resolve');
    resolveObj = await WorkflowIntegration.GetResolve();
    if (!resolveObj) throw new Error('No se pudo obtener Resolve');
    return resolveObj;
}

function tcToFrames(tc, fps, dropFrame) {
    const [h, m, s, f] = tc.split(/[:;]/).map(Number);
    const nominal = Math.round(fps);
    let frames = ((h * 60 + m) * 60 + s) * nominal + f;
    if (dropFrame) {
        const drop = Math.round(fps * 0.066666);
        const totalMinutes = h * 60 + m;
        frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
    }
    return frames;
}

async function insert(event, sound, trackIndex) {
    if (DEV) {
        await new Promise((r) => setTimeout(r, 400));
        return { tc: '01:00:00:00', track: Math.max(1, Number(trackIndex) || 1), trackType: sound.kind === 'gif' ? 'video' : 'audio', file: '(dev)' };
    }
    const isGif = sound.kind === 'gif';
    const binName = isGif ? 'GIFs' : 'Freesound';
    let filePath;
    if (sound.local) {
        const cfg = getConfig();
        if (!cfg) throw new Error('Falta config.json');
        filePath = localResolve(cfg, sound.rel, isGif ? 'gif' : 'sfx');
    } else {
        filePath = isGif ? await giphyDownload(null, sound) : await download(null, sound);
    }
    const resolve = await getResolve();
    const project = await (await resolve.GetProjectManager()).GetCurrentProject();
    if (!project) throw new Error('No hay proyecto abierto');
    const timeline = await project.GetCurrentTimeline();
    if (!timeline) throw new Error('No hay timeline activa');
    const mediaPool = await project.GetMediaPool();

    // Import into a "Freesound" / "GIFs" bin (created on demand), then restore the current bin.
    const root = await mediaPool.GetRootFolder();
    const prevFolder = await mediaPool.GetCurrentFolder();
    let bin = null;
    for (const f of (await root.GetSubFolderList()) || []) {
        if ((await f.GetName()) === binName) { bin = f; break; }
    }
    if (!bin) bin = await mediaPool.AddSubFolder(root, binName);
    if (bin) await mediaPool.SetCurrentFolder(bin);

    // Reuse the media pool item if this file was already imported.
    let item = null;
    for (const c of (bin ? await bin.GetClipList() : []) || []) {
        if ((await c.GetClipProperty('File Path')) === filePath) { item = c; break; }
    }
    if (!item) {
        const imported = await mediaPool.ImportMedia([filePath]);
        item = imported && imported[0];
    }
    if (prevFolder) await mediaPool.SetCurrentFolder(prevFolder);
    if (!item) throw new Error('Resolve no pudo importar el archivo');

    // Playhead -> absolute timeline frame.
    const fps = parseFloat(await project.GetSetting('timelineFrameRate')) || 24;
    const dropFrame = String(await project.GetSetting('timelineDropFrameTimecode')) === '1';
    const tc = await timeline.GetCurrentTimecode();
    const recordFrame = tcToFrames(tc, fps, dropFrame);

    // Make sure the target track exists.
    const trackType = isGif ? 'video' : 'audio';
    const mediaType = isGif ? 1 : 2;
    const track = Math.max(1, Number(trackIndex) || 1);
    let count = await timeline.GetTrackCount(trackType);
    while (count < track) {
        const added = isGif ? await timeline.AddTrack('video') : await timeline.AddTrack('audio', 'stereo');
        if (!added) break;
        count = await timeline.GetTrackCount(trackType);
    }

    let placed = await mediaPool.AppendToTimeline([{ mediaPoolItem: item, mediaType, trackIndex: track, recordFrame }]);
    if (!placed || placed.length === 0) {
        const frames = parseInt(await item.GetClipProperty('Frames'), 10);
        if (frames > 0) {
            placed = await mediaPool.AppendToTimeline([{
                mediaPoolItem: item, startFrame: 0, endFrame: frames - 1,
                mediaType, trackIndex: track, recordFrame
            }]);
        }
    }
    if (!placed || placed.length === 0) throw new Error('Resolve no pudo agregar el clip a la timeline');
    return { tc, track, trackType, file: filePath };
}

async function cleanup() {
    if (DEV) return true;
    resolveObj = null;
    return WorkflowIntegration.CleanUp();
}


// ---------- auto-update (GitHub) ----------
const REPO = 'pasto18/freesound-davinci';
const UPDATABLE = !DEV && !ABLETON; // never overwrite the project folder in dev

function isNewer(a, b) {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
    return false;
}

async function checkUpdate() {
    if (!UPDATABLE) return { available: false };
    const current = readJson(path.join(__dirname, 'package.json'), {}).version || '0.0.0';
    const res = await net.fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`GitHub: ${res.status}`);
    const latest = (await res.json()).version;
    return { available: isNewer(latest, current), current, latest };
}

async function applyUpdate() {
    if (!UPDATABLE) throw new Error('Actualización deshabilitada en modo dev');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-update-'));
    try {
        const res = await net.fetch(`https://codeload.github.com/${REPO}/zip/refs/heads/main`);
        if (!res.ok) throw new Error(`GitHub: ${res.status}`);
        const zip = path.join(tmp, 'update.zip');
        fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        const out = path.join(tmp, 'out');
        require('child_process').execFileSync('/usr/bin/ditto', ['-x', '-k', zip, out]);
        const root = path.join(out, fs.readdirSync(out).find((n) => fs.statSync(path.join(out, n)).isDirectory()));
        for (const f of ['main.js', 'preload.js', 'renderer.js', 'index.html', 'manifest.xml', 'css', 'img', 'WorkflowIntegration.node', 'package.json']) {
            if (!fs.existsSync(path.join(root, f))) continue;
            try { fs.cpSync(path.join(root, f), path.join(__dirname, f), { recursive: true, force: true }); }
            catch (e) {
                if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error('Sin permisos para actualizar. Volvé a correr ./install.sh una vez.');
                throw e;
            }
        }
        return true;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// ---------- ipc / window ----------
function wrap(fn) {
    return async (...args) => {
        try { return { ok: true, data: await fn(...args) }; }
        catch (e) { return { ok: false, error: e.message || String(e) }; }
    };
}

ipcMain.handle('app:status', wrap(async () => {
    const cfg = getConfig();
    return { configured: !!cfg, loggedIn: !!(cfg && (await getToken(cfg))), downloadDir: cfg && cfg.downloadDir, localDir: cfg && cfg.localDir, gifDir: cfg && cfg.gifDir, hasGiphy: !!(cfg && cfg.giphyApiKey), ableton: ABLETON, configPath: CONFIG_PATH };
}));
ipcMain.handle('update:check', wrap(checkUpdate));
ipcMain.handle('update:apply', wrap(applyUpdate));
ipcMain.handle('fs:login', wrap(login));
ipcMain.handle('fs:logout', wrap(async () => { fs.rmSync(TOKEN_PATH, { force: true }); return true; }));
ipcMain.handle('fs:search', wrap(search));
ipcMain.handle('fs:download', wrap((e, s) => (s.kind === 'gif' ? giphyDownload(e, s) : download(e, s))));
ipcMain.handle('local:search', wrap(localSearch));
ipcMain.handle('local:read', wrap(localRead));
ipcMain.handle('giphy:search', wrap(giphySearch));
ipcMain.handle('resolve:insert', wrap(insert));
ipcMain.on('drag:start', (event, file) => {
    const cfg = getConfig();
    if (!cfg || typeof file !== 'string') return;
    const abs = path.resolve(file);
    const allowed = [cfg.downloadDir, cfg.localDir, cfg.gifDir].filter(Boolean).map((d) => path.resolve(d));
    if (!allowed.some((d) => abs.startsWith(d + path.sep)) || !fs.existsSync(abs)) return;
    event.sender.startDrag({ file: abs, icon: path.join(__dirname, 'img', 'drag.png') });
});
ipcMain.handle('resolve:cleanup', wrap(cleanup));

// DEV only: CSS changes are swapped in place (no reload, keeps results);
// html/renderer.js changes reload the window.
function watchForChanges() {
    const debounce = (fn) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), 80); }; };
    const hotCss = debounce(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.executeJavaScript(
            "document.querySelectorAll('link[rel=stylesheet]').forEach(l => { l.href = l.href.split('?')[0] + '?t=' + Date.now(); })"
        );
    });
    const reload = debounce(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); });
    fs.watch(path.join(__dirname, 'css'), hotCss);
    fs.watch(__dirname, (evt, file) => { if (file === 'index.html' || file === 'renderer.js') reload(); });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 560,
        height: 780,
        title: ABLETON ? 'Freesound → Ableton' : 'Freesound',
        backgroundColor: '#1e1e1e',
        webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    mainWindow.on('close', () => app.quit());
    mainWindow.loadFile('index.html');
    if (DEV) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        watchForChanges();
    }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
