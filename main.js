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
const CLIPS_DIR = path.join(DATA_DIR, 'clips'); // trimmed copies made by the panel

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
        svgDir: expandHome(cfg.svgDir || path.join(expandHome(cfg.downloadDir || '~/Sounds/Freesound'), '..', 'SVG')),
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
    gif: new Set(['.gif', '.mp4', '.mov', '.webm', '.m4v']),
    svg: new Set(['.svg'])
};
const MAX_WAVE_BYTES = 80 * 1024 * 1024;
const localIndex = {};

function kindDir(cfg, kind) { return path.resolve(kind === 'gif' ? cfg.gifDir : kind === 'svg' ? cfg.svgDir : cfg.localDir); }

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
    kind = kind === 'gif' || kind === 'svg' ? kind : 'sfx';
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    const root = kindDir(cfg, kind);
    const base = localResolve(cfg, dir, kind);
    if (!fs.existsSync(base)) {
        if (kind === 'svg' && !dir) return { root, folders: [], total: 0, sounds: [] }; // nothing downloaded yet
        throw new Error('No existe la carpeta: ' + root);
    }
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

async function giphySearch(event, { query, page, stickers }) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    if (!cfg.giphyApiKey) throw new Error('Falta giphyApiKey en config.json');
    const limit = 24;
    const q = new URLSearchParams({ api_key: cfg.giphyApiKey, limit: String(limit), offset: String(((page || 1) - 1) * limit), rating: cfg.giphyRating });
    let url;
    const base = stickers ? GIPHY.replace('/gifs', '/stickers') : GIPHY;
    if (query) { q.set('q', query); url = `${base}/search?${q}`; } else { url = `${base}/trending?${q}`; }
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
            // Stickers: the MP4 has no alpha, so keep the transparent GIF instead.
            sticker: !!stickers,
            gifUrl: stickers ? orig.url : undefined,
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
    const src = gif.sticker ? gif.gifUrl : gif.mp4;
    if (!src || !/^https:\/\/[\w.-]*giphy\.com\//.test(src)) throw new Error('Este GIF no tiene archivo descargable');
    const dest = path.join(cfg.gifDir, `${gif.sticker ? 'sticker_' : ''}${gif.id}_${sanitize(gif.name) || 'gif'}.${gif.sticker ? 'gif' : 'mp4'}`);
    if (fs.existsSync(dest)) return dest;
    const res = await net.fetch(src);
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

// ---------- settings (API keys / folders, edited from the panel) ----------
const SECRET_FIELDS = ['clientId', 'clientSecret', 'giphyApiKey', 'elevenlabsApiKey'];
const PATH_FIELDS = ['downloadDir', 'gifDir', 'elevenlabsDir', 'youtubeDir'];
const YT_QUALITY_VALUES = ['720', '1080', '1440', '2160', 'max'];

function maskSecret(v) {
    v = String(v || '');
    if (!v || v.startsWith('TU_')) return '';
    return v.length <= 8 ? '••••' : v.slice(0, 3) + '••••' + v.slice(-3);
}

// Secrets never reach the renderer: it only gets a masked hint to show what is already saved.
async function configGet() {
    const cfg = readJson(CONFIG_PATH, {}) || {};
    const out = { path: CONFIG_PATH, secrets: {}, paths: {} };
    SECRET_FIELDS.forEach((k) => { out.secrets[k] = maskSecret(cfg[k]); });
    PATH_FIELDS.forEach((k) => { out.paths[k] = cfg[k] || ''; });
    out.youtube = { quality: String(cfg.youtubeQuality || '1080'), convert: cfg.youtubeConvert !== false };
    return out;
}

// values: { field: string }. Secrets left empty keep their saved value; paths left empty are removed (defaults apply).
async function configSet(event, values) {
    if (!values || typeof values !== 'object') throw new Error('Datos inválidos');
    const cur = readJson(CONFIG_PATH, null);
    if (fs.existsSync(CONFIG_PATH) && !cur) throw new Error('config.json tiene un error de formato; corregilo a mano antes de guardar desde acá');
    const cfg = cur || {};
    for (const k of SECRET_FIELDS) {
        const v = typeof values[k] === 'string' ? values[k].trim() : '';
        if (v) cfg[k] = v;
    }
    for (const k of PATH_FIELDS) {
        if (typeof values[k] !== 'string') continue;
        const v = values[k].trim();
        if (v) cfg[k] = v; else delete cfg[k];
    }
    if (values.youtubeQuality != null) {
        const q = String(values.youtubeQuality);
        if (!YT_QUALITY_VALUES.includes(q)) throw new Error('Calidad de YouTube inválida');
        cfg.youtubeQuality = q;
    }
    if (typeof values.youtubeConvert === 'boolean') cfg.youtubeConvert = values.youtubeConvert;
    if (!cfg.redirectPort) cfg.redirectPort = 8765;
    writeJson(CONFIG_PATH, cfg);
    return configGet();
}

// ---------- elevenlabs (text-to-speech + sound effects) ----------
const ELEVEN = 'https://api.elevenlabs.io/v1';
const ELEVEN_AUDIO = /\.(mp3|wav)$/i;

// Independent from the Freesound credentials: only needs elevenlabsApiKey.
function getEleven() {
    const cfg = readJson(CONFIG_PATH, null) || readJson(path.join(__dirname, 'config.json'), null) || {};
    const key = cfg.elevenlabsApiKey;
    return {
        key: key && !String(key).startsWith('TU_') ? String(key) : null,
        dir: path.resolve(expandHome(cfg.elevenlabsDir || '~/Sounds/ElevenLabs'))
    };
}

async function elevenFetch(url, opts) {
    const el = getEleven();
    if (!el.key) throw new Error('Falta elevenlabsApiKey en config.json');
    const res = await net.fetch(`${ELEVEN}${url}`, { ...opts, headers: { 'xi-api-key': el.key, ...(opts && opts.headers) } });
    if (!res.ok) {
        let msg = await res.text();
        try { const j = JSON.parse(msg); msg = (j.detail && (j.detail.message || (typeof j.detail === 'string' ? j.detail : ''))) || msg; } catch (e) { /* plain text */ }
        throw new Error(`ElevenLabs ${res.status}: ${String(msg).slice(0, 300)}`);
    }
    return res;
}

async function elevenSave(res, kind, text) {
    const el = getEleven();
    fs.mkdirSync(el.dir, { recursive: true });
    const dest = path.join(el.dir, `${Date.now()}_${kind}_${sanitize(text).slice(0, 40) || kind}.mp3`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
}

// Voices saved by ID (e.g. clones or library voices that the API listing does not return).
function customVoices() {
    const cfg = readJson(CONFIG_PATH, {}) || {};
    return Array.isArray(cfg.customVoices) ? cfg.customVoices.filter((v) => v && v.id) : [];
}

const GROUP_ORDER = ['mine', 'library', 'premade'];

async function elevenVoices() {
    const custom = customVoices().map((v) => ({ id: v.id, name: v.name || v.id, group: 'custom' }));
    let listed = [], warning = '';
    try {
        const json = await (await elevenFetch('/voices')).json();
        listed = (json.voices || []).map((v) => ({
            id: v.voice_id, name: v.name,
            group: ['cloned', 'generated'].includes(v.category) ? 'mine' : ['professional', 'famous'].includes(v.category) ? 'library' : 'premade'
        }));
    } catch (e) { warning = e.message; }
    const seen = new Set(custom.map((v) => v.id));
    const byName = (a, b) => a.name.localeCompare(b.name);
    const voices = [...custom, ...listed.filter((v) => !seen.has(v.id)).sort((a, b) => (a.group === b.group ? byName(a, b) : GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)))];
    return { voices, warning };
}

async function elevenAddVoice(event, { id, name }) {
    id = String(id || '').trim();
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new Error('El ID de voz no parece válido');
    name = String(name || '').trim();
    if (!name) { // try to learn the name from ElevenLabs; fall back to the ID if the key can't read voices
        try { name = (await (await elevenFetch(`/voices/${encodeURIComponent(id)}`)).json()).name || ''; } catch (e) { /* keep id */ }
    }
    const cfg = readJson(CONFIG_PATH, {}) || {};
    const list = (Array.isArray(cfg.customVoices) ? cfg.customVoices : []).filter((v) => v && v.id !== id);
    list.push({ id, name: name || id });
    cfg.customVoices = list;
    writeJson(CONFIG_PATH, cfg);
    return { id, name: name || id };
}

async function elevenRemoveVoice(event, id) {
    const cfg = readJson(CONFIG_PATH, {}) || {};
    cfg.customVoices = (Array.isArray(cfg.customVoices) ? cfg.customVoices : []).filter((v) => v && v.id !== id);
    writeJson(CONFIG_PATH, cfg);
    return true;
}

async function elevenModels() {
    const list = await (await elevenFetch('/models')).json();
    return list.filter((m) => m.can_do_text_to_speech).map((m) => ({ id: m.model_id, name: m.name || m.model_id }));
}

async function elevenTts(event, { text, voiceId, modelId }) {
    text = String(text || '').trim();
    if (!text) throw new Error('Escribí el texto');
    if (!voiceId) throw new Error('Elegí una voz');
    const res = await elevenFetch(`/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: modelId || 'eleven_multilingual_v2' })
    });
    return elevenSave(res, 'voz', text);
}

async function elevenSfx(event, { text, duration, influence }) {
    text = String(text || '').trim();
    if (!text) throw new Error('Describí el sonido');
    const body = { text, prompt_influence: Math.min(1, Math.max(0, Number(influence) || 0.3)) };
    const d = Number(duration);
    if (d > 0) body.duration_seconds = Math.min(30, Math.max(0.5, d)); // omitted = ElevenLabs decides
    const res = await elevenFetch('/sound-generation?output_format=mp3_44100_128', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return elevenSave(res, 'sfx', text);
}

async function elevenList() {
    const el = getEleven();
    if (!fs.existsSync(el.dir)) return [];
    return fs.readdirSync(el.dir).filter((n) => !n.startsWith('.') && ELEVEN_AUDIO.test(n)).map((n) => {
        const p = path.join(el.dir, n);
        return { path: p, name: n.replace(/^\d+_/, '').replace(/\.[^.]+$/, ''), kind: /^\d+_voz_/.test(n) ? 'voz' : 'sfx', mtime: fs.statSync(p).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 100);
}

// ---------- youtube (search + stream preview + download of full video or a section, via yt-dlp) ----------
const YT_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const YT_ID = /^[\w-]{11}$/;
const ytStreamCache = new Map();
const ytStreamPending = new Map();

function findBin(name) {
    for (const d of YT_BIN_DIRS) { const f = path.join(d, name); if (fs.existsSync(f)) return f; }
    return null;
}

function ytDir() {
    const cfg = readJson(CONFIG_PATH, null) || readJson(path.join(__dirname, 'config.json'), null) || {};
    return path.resolve(expandHome(cfg.youtubeDir || '~/Sounds/YouTube'));
}

function ytTools() { return { ytdlp: !!findBin('yt-dlp'), ffmpeg: !!findBin('ffmpeg') }; }

// Runs yt-dlp; resolves with stdout. onLine gets each stdout line (progress).
function runYt(args, onLine, procs) {
    const bin = findBin('yt-dlp');
    if (!bin) return Promise.reject(new Error('Falta yt-dlp. Instalalo con: brew install yt-dlp ffmpeg'));
    return new Promise((resolve, reject) => {
        const env = { ...process.env, PATH: YT_BIN_DIRS.join(':') + ':' + (process.env.PATH || '') };
        const child = require('child_process').spawn(bin, ['--ignore-config', ...args], { env }); // the user's own yt-dlp.conf must not change our output
        if (procs) { procs.add(child); child.on('close', () => procs.delete(child)); }
        let out = '', err = '', buf = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('yt-dlp tardó demasiado')); }, 15 * 60 * 1000);
        child.stdout.on('data', (d) => {
            out += d;
            if (onLine) { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); }
        });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) return resolve(out);
            const line = err.split('\n').filter((l) => /ERROR/.test(l)).pop() || err.trim().split('\n').pop() || 'yt-dlp falló';
            reject(new Error(line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 300)));
        });
    });
}

function ytItem(j) {
    return {
        kind: 'yt', id: j.id, title: j.title || j.id, channel: j.channel || j.uploader || '',
        duration: Number(j.duration) > 0 ? Number(j.duration) : 0,
        views: j.view_count || 0,
        res: j.res || 0,
        tag: j.tag || '',
        thumb: `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${j.id}`
    };
}

// ---- minimum-quality search: YouTube's own HD / 4K filter narrows the candidates, then the real resolution of each is checked ----
const YT_SP = { hd: 'EgIgAQ%253D%253D', uhd: 'EgJwAQ%253D%253D' };
const ytSizeCache = new Map(); // id -> short side in px (0 = unknown)
const ytInfoProcs = new Set();
let ytSearchSeq = 0;

async function ytShortSide(id) {
    if (ytSizeCache.has(id)) return ytSizeCache.get(id);
    let side = 0;
    try {
        const out = await runYt(['-f', 'bv*', '--print', '%(width)s %(height)s', '--no-playlist', '--no-warnings', `https://www.youtube.com/watch?v=${id}`], null, ytInfoProcs);
        const [w, h] = out.trim().split(/\s+/).map(Number);
        if (w > 0 && h > 0) side = Math.min(w, h);
    } catch (e) { return /confirm you.re not a bot|HTTP Error 429/i.test(e.message) ? -2 : -1; } // -2: YouTube is throttling us; -1: cancelled/failed (not cached)
    ytSizeCache.set(id, side);
    return side;
}

async function ytSearch(event, { query, page, minHeight, token }) {
    query = String(query || '').trim();
    if (!query) throw new Error('Escribí qué buscar o pegá un enlace de YouTube');
    page = Math.max(1, Number(page) || 1);
    const seq = ++ytSearchSeq;
    ytInfoProcs.forEach((c) => c.kill()); // a newer search makes the previous checks pointless
    const PAGE = 18;
    if (/^https?:\/\/((www|m|music)\.)?(youtube\.com|youtu\.be)\//i.test(query)) {
        const out = await runYt(['--dump-json', '--no-playlist', '--no-warnings', query]);
        const j = JSON.parse(out.split('\n').filter(Boolean)[0]);
        return { count: 1, results: [ytItem(j)], next: false };
    }
    // 144-480p: YouTube has no such filter and virtually every video reaches them, so they behave like "any".
    const minH = Math.max(0, Number(minHeight) || 0);
    if (minH <= 480) {
        const out = await runYt(['--flat-playlist', '--dump-json', '--no-warnings', `ytsearch${PAGE * page}:${query}`]);
        const all = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((j) => YT_ID.test(j.id || ''));
        return { count: all.length, results: all.slice((page - 1) * PAGE).map(ytItem), next: all.length >= PAGE * page };
    }

    // 720p = YouTube's "HD" filter and 2160p = its "4K" filter: exact, one request, no per-video checks.
    // 1080p / 1440p / 8K: pre-filtered by HD / 4K, then the real resolution is checked a few videos at a time
    // (many parallel checks make YouTube ask for a sign-in "not a bot" confirmation).
    const trusted = minH === 720 || minH === 2160;
    const want = PAGE * page;
    const cand = trusted ? want : Math.min(120, want * 2 + 12);
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${minH >= 2160 ? YT_SP.uhd : YT_SP.hd}`;
    const out = await runYt(['--flat-playlist', '--dump-json', '--no-warnings', '--playlist-end', String(cand), url]);
    const list = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((j) => YT_ID.test(j.id || ''));
    if (trusted) {
        const tag = minH === 2160 ? '4K' : 'HD';
        return { count: list.length, results: list.slice((page - 1) * PAGE).map((j) => ytItem({ ...j, tag })), next: list.length >= want };
    }

    const pass = [];
    let examined = 0, throttled = false;
    const BATCH = 4, BUDGET = 48; // checks per search
    const send = (items) => { if (page === 1 && items.length && event && event.sender) { try { event.sender.send('yt:partial', { token, results: items.map(ytItem) }); } catch (e) { /* window closed */ } } };
    for (let i = 0; i < list.length && i < BUDGET && pass.length < want; i += BATCH) {
        if (seq !== ytSearchSeq) throw new Error('Búsqueda cancelada');
        const chunk = list.slice(i, i + BATCH);
        const sides = await Promise.all(chunk.map((j) => ytShortSide(j.id)));
        if (seq !== ytSearchSeq) throw new Error('Búsqueda cancelada');
        if (sides.includes(-2)) { throttled = true; break; }
        const fresh = [];
        chunk.forEach((j, k) => { if (sides[k] >= minH * 0.93) fresh.push({ ...j, res: sides[k] }); }); // small tolerance: 1920x1040 still counts as 1080p
        send(fresh.slice(0, Math.max(0, PAGE - pass.length)));
        pass.push(...fresh);
        examined = i + chunk.length;
    }
    return {
        count: pass.length,
        results: pass.slice((page - 1) * PAGE, page * PAGE).map(ytItem),
        next: pass.length > page * PAGE || (pass.length >= want && examined < list.length),
        note: throttled ? 'YouTube pidió verificación anti-bots y se pausó la comprobación de calidad; probá de nuevo en unos minutos.' : ''
    };
}

// Direct low-quality URL(s) for in-panel playback (small preview) or a bigger one (popup).
// Returns { video, audio }: audio is set only when the video has no muxed progressive format (played as two synced elements).
async function ytStream(event, { id, big, audio }) {
    if (!YT_ID.test(String(id))) throw new Error('ID de video inválido');
    const key = id + (big ? ':b' : ':s') + (audio && !big ? 'a' : '');
    const hit = ytStreamCache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.urls;
    if (ytStreamPending.has(key)) return ytStreamPending.get(key); // same request already running (hover prefetch + click)
    const job = ytStreamResolve(id, big, key, !!audio);
    ytStreamPending.set(key, job);
    job.then(() => ytStreamPending.delete(key), () => ytStreamPending.delete(key));
    return job;
}

async function ytStreamResolve(id, big, key, audio) {
    const h = big ? 720 : 360;
    const muxed = `b[height<=${h}][protocol=https][acodec!=none][vcodec!=none]`;
    // small preview: smallest video-only stream (~144p, no audio) for the fastest load; popup keeps audio
    const fmt = big ? `22/${muxed}/bv*[height<=${h}][protocol=https]+ba[protocol=https]`
        : audio ? `18/${muxed}/wv[protocol=https][vcodec!=none]+wa[protocol=https]`
        : `wv[protocol=https][vcodec!=none]/18/${muxed}`;
    const out = await runYt(['-f', fmt, '--print', '%(fps)s', '--print', 'urls', '--no-playlist', '--no-warnings', `https://www.youtube.com/watch?v=${id}`]);
    const all = out.split('\n').filter(Boolean);
    const fps = Number(all[0]) > 0 ? Number(all[0]) : 30; // used by the panel to step one frame at a time
    const lines = all.slice(1);
    if (!lines.length || !lines.every((u) => /^https:\/\//.test(u))) throw new Error('No se pudo obtener el video para previsualizar');
    const urls = { video: lines[0], audio: lines[1] || null, fps };
    ytStreamCache.set(key, { urls, at: Date.now() });
    return urls;
}

function ytRange({ start, end }) {
    const a = Math.round(Number(start) * 10) / 10, b = Math.round(Number(end) * 10) / 10; // 0.1 s grid: same range -> same file name
    return b > a && a >= 0 ? { start: a, end: b } : null;
}

const YT_QUALITIES = ['720', '1080', '1440', '2160', 'max'];

function ytSettings() {
    const cfg = readJson(CONFIG_PATH, null) || readJson(path.join(__dirname, 'config.json'), null) || {};
    const q = String(cfg.youtubeQuality || '1080');
    return { quality: YT_QUALITIES.includes(q) ? q : '1080', convert: cfg.youtubeConvert !== false };
}

// Up to 1080p H.264 (avc1) exists natively; above that YouTube only offers VP9/AV1, which Resolve on Mac plays badly.
function ytFormat(quality, videoOnly) {
    const h = quality === 'max' ? '' : `[height<=${quality}]`;
    const hi = quality === 'max' || Number(quality) > 1080;
    if (videoOnly) return `${hi ? '' : `bv*[vcodec^=avc1]${h}/`}bv*${h}/bv*`;
    return `${hi ? '' : `bv*[vcodec^=avc1]${h}+ba[ext=m4a]/`}bv*${h}+ba[ext=m4a]/bv*${h}+ba/b${h}/b`;
}

function ytDest({ id, title, start, end, media }) {
    if (!YT_ID.test(String(id))) throw new Error('ID de video inválido');
    const r = ytRange({ start, end });
    const set = ytSettings();
    media = media === 'audio' || media === 'video' ? media : 'both';
    const hi = set.quality === 'max' || Number(set.quality) > 1080;
    const q = media === 'audio' ? 'audio' : (set.quality === 'max' ? 'max' : set.quality + 'p') + (hi ? (set.convert ? '-h264' : '-nativo') : '') + (media === 'video' ? ' solo-video' : '');
    const tag = ` [${q}]` + (r ? ` [${r.start.toFixed(1)}-${r.end.toFixed(1)}]` : '');
    return { dest: path.join(ytDir(), `${sanitize(String(title || id)).slice(0, 60)} [${id}]${tag}.${media === 'audio' ? 'm4a' : 'mp4'}`), range: r, set, media };
}

async function ytExists(event, opts) {
    const { dest } = ytDest(opts);
    return fs.existsSync(dest) ? dest : null;
}

function runBin(bin, args, onLine, procs) {
    return new Promise((resolve, reject) => {
        const child = require('child_process').spawn(bin, args);
        if (procs) { procs.add(child); child.on('close', () => procs.delete(child)); }
        let out = '', err = '', buf = '';
        child.stdout.on('data', (d) => { out += d; if (onLine) { buf += d; const l = buf.split(/\r?\n/); buf = l.pop(); l.forEach(onLine); } });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || 'ffmpeg falló'))));
    });
}

async function ytProbe(file) {
    const ffprobe = findBin('ffprobe');
    if (!ffprobe) return { codec: '', height: 0, duration: 0 };
    const v = (await runBin(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,height', '-of', 'csv=p=0', file])).trim().split(',');
    const d = (await runBin(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])).trim();
    return { codec: v[0] || '', height: Number(v[1]) || 0, duration: Number(d) || 0 };
}

const YT_CODEC_NAMES = { h264: 'H.264', vp9: 'VP9', av1: 'AV1', hevc: 'HEVC' };

// Audio only: best AAC (m4a) track, cut exactly when a section is selected.
async function ytDownloadAudio(event, opts, dest, range, job) {
    const base = dest.replace(/\.m4a$/, '.dl');
    const args = ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0', '--no-playlist', '--no-warnings', '--newline', '--force-overwrites', '-o', base + '.%(ext)s'];
    if (range) args.push('--download-sections', `*${range.start}-${range.end}`, '--force-keyframes-at-cuts');
    args.push(`https://www.youtube.com/watch?v=${opts.id}`);
    const send = (p) => { try { event.sender.send('yt:progress', { job: opts.job, ...p }); } catch (e) { /* window closed */ } };
    await runYt(args, (line) => {
        const m = /\[download\]\s+([\d.]+)%/.exec(line);
        if (m) send({ phase: 'download', pct: Number(m[1]) });
    }, job.procs);
    const tmp = base + '.m4a';
    if (!fs.existsSync(tmp)) throw new Error('La descarga no generó el archivo');
    fs.renameSync(tmp, dest);
    send({ phase: 'done', info: 'audio M4A (AAC)' });
    return dest;
}

// Running downloads by job id, so the panel can cancel one: kill its yt-dlp / ffmpeg and drop the partial files.
const ytDownloadJobs = new Map();

async function ytDownload(event, opts) {
    const { dest } = ytDest(opts);
    if (fs.existsSync(dest)) return dest;
    const job = { cancelled: false, procs: new Set() };
    if (opts.job) ytDownloadJobs.set(opts.job, job);
    try { return await ytDownloadRun(event, opts, job); }
    catch (e) { if (job.cancelled) throw new Error('Cancelado'); throw e; }
    finally {
        if (opts.job) ytDownloadJobs.delete(opts.job);
        if (job.cancelled) ytCleanPartial(dest);
    }
}

function ytCancel(event, jobId) {
    const job = ytDownloadJobs.get(jobId);
    if (!job) return false;
    job.cancelled = true;
    job.procs.forEach((c) => c.kill());
    return true;
}

// Temp files of an unfinished download: <name>.dl* (yt-dlp) and <name>.cv.mp4 (ffmpeg conversion).
function ytCleanPartial(dest) {
    const dir = path.dirname(dest), stem = path.basename(dest).replace(/\.(mp4|m4a)$/, '');
    try {
        for (const f of fs.readdirSync(dir)) if (f.startsWith(stem + '.dl') || f.startsWith(stem + '.cv')) fs.rmSync(path.join(dir, f), { force: true });
    } catch (e) { /* folder gone */ }
}

async function ytDownloadRun(event, opts, job) {
    const { dest, range, set, media } = ytDest(opts);
    if (!ytTools().ffmpeg) throw new Error('Falta ffmpeg. Instalalo con: brew install ffmpeg');
    fs.mkdirSync(ytDir(), { recursive: true });
    if (media === 'audio') return ytDownloadAudio(event, opts, dest, range, job);
    const tmp = dest.replace(/\.mp4$/, '.dl.mp4');
    const args = [
        '-f', ytFormat(set.quality, media === 'video'),
        '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings', '--newline', '--force-overwrites',
        '-o', tmp
    ];
    if (media === 'video') args.push('--remux-video', 'mp4'); // a single video-only stream may come as webm
    if (range) {
        args.push('--download-sections', `*${range.start}-${range.end}`);
        // Exact cuts re-encode the clip to H.264. Without conversion above 1080p the clip keeps VP9/AV1, cut at the nearest keyframe.
        const hi = set.quality === 'max' || Number(set.quality) > 1080;
        if (set.convert || !hi) args.push('--force-keyframes-at-cuts');
    }
    args.push(`https://www.youtube.com/watch?v=${opts.id}`);
    const send = (p) => { try { event.sender.send('yt:progress', { job: opts.job, ...p }); } catch (e) { /* window closed */ } };
    await runYt(args, (line) => {
        const m = /\[download\]\s+([\d.]+)%/.exec(line);
        if (m) send({ phase: 'download', pct: Number(m[1]) });
    }, job.procs);
    if (!fs.existsSync(tmp)) throw new Error('La descarga no generó el archivo');

    let info = await ytProbe(tmp);
    const from = YT_CODEC_NAMES[info.codec] || info.codec || '?';
    let converted = false;
    if (set.convert && info.codec && info.codec !== 'h264') {
        const out = dest.replace(/\.mp4$/, '.cv.mp4');
        send({ phase: 'convert', pct: 0 });
        await runBin(findBin('ffmpeg'), ['-y', '-v', 'error', '-i', tmp, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out], (line) => {
            const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
            if (m && info.duration) send({ phase: 'convert', pct: Math.min(99, (Number(m[1]) / 1e6 / info.duration) * 100) });
        }, job.procs);
        fs.rmSync(tmp, { force: true });
        fs.renameSync(out, tmp);
        converted = true;
    }
    fs.renameSync(tmp, dest);
    send({ phase: 'done', info: `${info.height || '?'}p ${from}${converted ? ' → H.264' : ''}` });
    return dest;
}

// Files the panel may hand to Resolve / drag out.
function ytFileCheck(file) {
    if (typeof file !== 'string') throw new Error('Ruta no permitida');
    const abs = path.resolve(file);
    if (!abs.startsWith(ytDir() + path.sep) || !fs.existsSync(abs)) throw new Error('Ruta no permitida');
    return abs;
}

// ---------- google fonts (public catalog JSON + css2 API with an old UA, which answers with .ttf urls) ----------
const GF_PAGE = 40;
const GF_UA = 'Mozilla/5.0';
let gfCatalog = null;

function httpGet(url, binary) {
    return new Promise((resolve, reject) => {
        require('https').get(url, { headers: { 'User-Agent': GF_UA } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(httpGet(new URL(res.headers.location, url).href, binary));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Google Fonts: ${res.statusCode}`)); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const b = Buffer.concat(chunks); resolve(binary ? b : b.toString('utf8')); });
        }).on('error', reject);
    });
}

async function gfLoad() {
    if (gfCatalog) return gfCatalog;
    const data = JSON.parse(await httpGet('https://fonts.google.com/metadata/fonts'));
    gfCatalog = data.familyMetadataList.slice().sort((a, b) => a.popularity - b.popularity);
    return gfCatalog;
}

function fontsDir() {
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts');
    if (process.platform === 'linux') return path.join(os.homedir(), '.local', 'share', 'fonts');
    return path.join(os.homedir(), 'Library', 'Fonts');
}

async function fontsSearch(event, { query, category, page }) {
    page = Math.max(1, Number(page) || 1);
    const q = String(query || '').trim().toLowerCase();
    const list = (await gfLoad()).filter((f) => (!category || category === 'all' || f.category === category) && (!q || f.family.toLowerCase().includes(q)));
    const results = list.slice((page - 1) * GF_PAGE, page * GF_PAGE).map((f) => ({
        kind: 'font', id: f.family, name: f.family, category: f.category, designer: (f.designers || [])[0] || '',
        styles: Object.keys(f.fonts).length
    }));
    return { count: list.length, results, next: page * GF_PAGE < list.length };
}

async function fontsInstall(event, { family }) {
    const meta = (await gfLoad()).find((f) => f.family === family);
    if (!meta) throw new Error('Fuente desconocida');
    const pairs = Object.keys(meta.fonts).map((k) => ({ ital: k.endsWith('i') ? 1 : 0, wght: parseInt(k, 10) }))
        .sort((a, b) => a.ital - b.ital || a.wght - b.wght);
    const fam = encodeURIComponent(family).replace(/%20/g, '+');
    const css = await httpGet(`https://fonts.googleapis.com/css2?family=${fam}:ital,wght@${pairs.map((p) => p.ital + ',' + p.wght).join(';')}`);
    const faces = [];
    for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
        const url = (m[1].match(/url\((https:[^)]+)\)/) || [])[1];
        if (!url) continue;
        faces.push({ url, italic: /font-style:\s*italic/.test(m[1]), weight: (m[1].match(/font-weight:\s*(\d+)/) || [])[1] || '400' });
    }
    if (!faces.length) throw new Error('Google Fonts no devolvió archivos');
    const byUrl = new Map();
    faces.forEach((f) => { const k = f.url; if (!byUrl.has(k)) byUrl.set(k, []); byUrl.get(k).push(f); });
    const dir = fontsDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = family.replace(/\s+/g, '');
    const files = [];
    let installed = 0;
    for (const [url, group] of byUrl) {
        const f = group[0];
        const ext = path.extname(new URL(url).pathname) || '.ttf';
        const name = group.length > 1
            ? `${base}${f.italic ? '-Italic' : ''}-Variable${ext}`
            : `${base}-${f.weight}${f.italic ? 'Italic' : ''}${ext}`;
        const dest = path.join(dir, name);
        files.push(dest);
        if (fs.existsSync(dest)) continue;
        const buf = await httpGet(url, true);
        const magic = buf.subarray(0, 4).toString('latin1');
        if (!(magic === 'OTTO' || magic === 'true' || buf.readUInt32BE(0) === 0x00010000)) throw new Error('Archivo de fuente inválido');
        fs.writeFileSync(dest + '.part', buf);
        fs.renameSync(dest + '.part', dest);
        installed++;
    }
    return { dir, files: files.length, installed };
}

// Apply a font to the Text+ in the timeline item under the playhead (Resolve only sees fonts that were installed before it started).
// First through the plugin's own Resolve object, verified by reading the font back; if that does not take, through
// Resolve's Python scripting (needs Preferences > General > External scripting using: Local).
const FONT_PY = `
import sys, json
sys.path.append("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules")
import DaVinciResolveScript as dvr
family, style = sys.argv[1], sys.argv[2]
r = dvr.scriptapp("Resolve")
if not r: raise SystemExit("no se pudo conectar a Resolve por scripting externo")
tl = r.GetProjectManager().GetCurrentProject().GetCurrentTimeline()
it = tl.GetCurrentVideoItem() if tl else None
if not it: raise SystemExit("No hay ningún clip de video bajo el cursor")
n = 0
for i in range(1, (it.GetFusionCompCount() or 0) + 1):
    comp = it.GetFusionCompByIndex(i)
    for t in (comp.GetToolList(False, "TextPlus") or {}).values():
        t.SetInput("Font", family)
        t.SetInput("Style", style)
        if t.GetInput("Font") == family: n += 1
print(json.dumps({"item": it.GetName(), "tools": n}))
`;

function fontsApplyPython(family, style) {
    return new Promise((resolve, reject) => {
        require('child_process').execFile('/usr/bin/python3', ['-I', '-c', FONT_PY, family, style], { timeout: 20000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop()));
            try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch (e) { reject(new Error('Respuesta inesperada de Python')); }
        });
    });
}

async function fontsApply(event, { family, style }) {
    if (DEV) return { item: '(dev)', tools: 1 };
    if (!/^[\w \-.&']{1,80}$/.test(String(family))) throw new Error('Fuente inválida');
    style = style || 'Regular';
    let jsError = '';
    try {
        const resolve = await getResolve();
        const project = await (await resolve.GetProjectManager()).GetCurrentProject();
        const timeline = project && (await project.GetCurrentTimeline());
        if (!timeline) throw new Error('No hay timeline activa');
        const item = await timeline.GetCurrentVideoItem();
        if (!item) throw new Error('No hay ningún clip de video bajo el cursor');
        let tools = 0;
        for (let i = 1; i <= ((await item.GetFusionCompCount()) || 0); i++) {
            const comp = await item.GetFusionCompByIndex(i);
            const list = (comp && typeof comp.GetToolList === 'function' && (await comp.GetToolList(false, 'TextPlus'))) || {};
            for (const tool of Array.isArray(list) ? list : Object.values(list)) {
                if (typeof tool.SetInput !== 'function' || typeof tool.GetInput !== 'function') continue;
                await tool.SetInput('Font', family);
                await tool.SetInput('Style', style);
                if ((await tool.GetInput('Font')) === family) tools++;
            }
        }
        if (tools) return { item: await item.GetName(), tools };
        jsError = 'la API del plugin no expone las herramientas de Fusion';
    } catch (e) { jsError = e.message; }
    try {
        return await fontsApplyPython(family, style);
    } catch (e) {
        throw new Error(`${e.message} (plugin: ${jsError})`);
    }
}

// ---------- svgrepo (no public API: a hidden browser window passes the site's bot check) ----------
const SVGREPO = 'https://www.svgrepo.com';
const SVG_STYLES = new Set(['monocolor', 'multicolor', 'duotone', 'outlined', 'filled', 'icon', 'glyph', 'rounded', 'sharp']);
const SVG_PAGE = 50;
let svgWin = null;
let svgQueue = Promise.resolve();

async function svgReady(force) {
    if (svgWin && !svgWin.isDestroyed() && !force) return svgWin;
    if (!svgWin || svgWin.isDestroyed()) {
        svgWin = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:svgrepo', sandbox: true } });
    }
    svgWin.loadURL(`${SVGREPO}/vectors/fire/`).catch(() => {});
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (svgWin.isDestroyed()) break;
        let ok = false;
        try { ok = await svgWin.webContents.executeJavaScript("document.title.includes('SVG Repo') && !!document.querySelector('a[href*=\"/svg/\"]')"); } catch (e) { /* still loading */ }
        if (ok) return svgWin;
    }
    throw new Error('SVG Repo no respondió (¿bloqueo anti-bot o sin internet?)');
}

// Runs fn(win) serialized; retries once with a fresh bot-check pass if the page looks blocked.
function svgRun(fn) {
    const job = svgQueue.then(async () => {
        try { return await fn(await svgReady(false)); }
        catch (e) { return await fn(await svgReady(true)); }
    });
    svgQueue = job.catch(() => {});
    return job;
}

async function svgSearch(event, { query, style, page }) {
    page = Math.max(1, Number(page) || 1);
    const slug = String(query || '').toLowerCase().trim().replace(/\s+/g, '-');
    if (!slug) throw new Error('Escribí qué buscar en SVG Repo');
    const pathPart = `/vectors/${encodeURIComponent(slug)}/` + (SVG_STYLES.has(style) ? style + '/' : '') + (page > 1 ? page : '');
    const data = await svgRun((win) => win.webContents.executeJavaScript(`(async (path, page) => {
        const r = await fetch(path);
        const t = await r.text();
        if (!r.ok) throw new Error('SVG Repo: ' + r.status);
        const d = new DOMParser().parseFromString(t, 'text/html');
        if (/Security Checkpoint/.test(d.title)) throw new Error('checkpoint');
        const seen = new Set(), results = [];
        d.querySelectorAll('a[href*="/svg/"]').forEach((a) => {
            const m = (a.getAttribute('href') || '').match(/^\\/svg\\/(\\d+)\\/([\\w-]+)/);
            if (!m || seen.has(m[1])) return;
            seen.add(m[1]);
            results.push({ id: m[1], slug: m[2] });
        });
        const re = new RegExp('/vectors/[^"]*/' + (page + 1) + '/?$');
        const next = [...d.querySelectorAll('a')].some((a) => re.test(a.getAttribute('href') || ''));
        return { results, next };
    })(${JSON.stringify(pathPart)}, ${page})`));
    const results = data.results.map((r) => ({
        id: r.id,
        slug: r.slug,
        kind: 'svg',
        name: r.slug.replace(/-/g, ' '),
        preview: `${SVGREPO}/show/${r.id}/${r.slug}.svg`,
        url: `${SVGREPO}/svg/${r.id}/${r.slug}`
    }));
    const next = data.next || results.length >= SVG_PAGE;
    return { count: (page - 1) * SVG_PAGE + results.length + (next ? '+' : ''), results, next };
}

async function svgDownload(event, svg) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    if (!/^\d+$/.test(String(svg.id)) || !/^[\w-]+$/.test(String(svg.slug))) throw new Error('SVG inválido');
    const dest = path.join(cfg.svgDir, `${svg.id}_${svg.slug}.svg`);
    if (fs.existsSync(dest)) return dest;
    const got = await svgRun((win) => win.webContents.executeJavaScript(`(async () => {
        const r = await fetch('/show/${svg.id}/${svg.slug}.svg');
        const text = await r.text();
        if (!r.ok || !/<svg/i.test(text)) throw new Error('SVG Repo: ' + r.status);
        let detail = '';
        try { detail = await (await fetch('/svg/${svg.id}/${svg.slug}')).text(); } catch (e) { /* license is best-effort */ }
        return { text, detail };
    })()`));
    fs.mkdirSync(cfg.svgDir, { recursive: true });
    const tmp = dest + '.part';
    fs.writeFileSync(tmp, got.text);
    fs.renameSync(tmp, dest);
    const lic = (got.detail.match(/"copyrightNotice":"([^"]+)"/) || [])[1] || '';
    const author = (got.detail.match(/"creditText":"([^"]+)"/) || [])[1] || '';
    const credits = readJson(CREDITS_PATH, {});
    credits['svgrepo:' + svg.id] = { name: svg.name, author, license: lic, url: `${SVGREPO}/svg/${svg.id}/${svg.slug}`, file: dest };
    writeJson(CREDITS_PATH, credits);
    return dest;
}

function svgFileCheck(file, ext) {
    const cfg = getConfig();
    if (!cfg) throw new Error('Falta config.json');
    const abs = path.resolve(String(file));
    if (!abs.startsWith(path.resolve(cfg.svgDir) + path.sep) || path.extname(abs).toLowerCase() !== ext) throw new Error('Archivo fuera de la carpeta SVG');
    return abs;
}

async function svgText(event, file) {
    return fs.readFileSync(svgFileCheck(file, '.svg'), 'utf8');
}

// The renderer rasterizes the SVG (transparent PNG) so Resolve, which can't import SVG, can use it.
async function svgSavePng(event, file, dataUrl) {
    const abs = svgFileCheck(file, '.svg');
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
    if (!m) throw new Error('PNG inválido');
    const dest = abs.replace(/\.svg$/i, '.png');
    fs.writeFileSync(dest, Buffer.from(m[1], 'base64'));
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

// Source audio the panel may read (to build trimmed copies) / trimmed copies it may hand to Resolve.
function audioFileCheck(file) {
    const cfg = getConfig();
    if (typeof file !== 'string') throw new Error('Ruta no permitida');
    const abs = path.resolve(file);
    const ok = [cfg && cfg.downloadDir, cfg && cfg.localDir, CLIPS_DIR, getEleven().dir].filter(Boolean).map((d) => path.resolve(d)).some((d) => abs.startsWith(d + path.sep));
    if (!ok || !fs.existsSync(abs)) throw new Error('Ruta no permitida');
    return abs;
}

ipcMain.handle('clip:read', wrap(async (e, file) => fs.readFileSync(audioFileCheck(file))));
ipcMain.handle('clip:save', wrap(async (e, name, bytes) => {
    const dest = path.join(CLIPS_DIR, path.basename(String(name)).replace(/[^\w\-. ]+/g, '_'));
    fs.mkdirSync(CLIPS_DIR, { recursive: true });
    fs.writeFileSync(dest, Buffer.from(bytes));
    return dest;
}));
ipcMain.handle('clip:exists', wrap(async (e, name) => {
    const dest = path.join(CLIPS_DIR, path.basename(String(name)).replace(/[^\w\-. ]+/g, '_'));
    return fs.existsSync(dest) ? dest : null;
}));

async function insert(event, sound, trackIndex, clipFile) {
    if (DEV) {
        await new Promise((r) => setTimeout(r, 400));
        return { tc: '01:00:00:00', track: Math.max(1, Number(trackIndex) || 1), trackType: sound.kind === 'sfx' ? 'audio' : 'video', file: '(dev)' };
    }
    const isYt = sound.kind === 'yt'; // video + its audio, linked (or audio only)
    const ytAudio = isYt && sound.audio === true;
    const ytVideoOnly = isYt && sound.videoOnly === true;
    const isGif = (sound.kind === 'gif' || sound.kind === 'svg' || isYt) && !ytAudio; // all go on a video track except audio-only
    const binName = isYt ? 'YouTube' : sound.kind === 'svg' ? 'SVG' : isGif ? 'GIFs' : 'Freesound';
    let filePath;
    if (isYt) {
        filePath = ytFileCheck(sound.file);
    } else if (sound.kind === 'svg') {
        filePath = svgFileCheck(String(sound.png).replace(/\.png$/i, '.svg'), '.svg').replace(/\.svg$/i, '.png');
        if (!fs.existsSync(filePath)) throw new Error('Falta generar el PNG');
    } else if (clipFile) {
        filePath = audioFileCheck(clipFile);
    } else if (sound.local) {
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
    const mediaType = isYt && !ytAudio && !ytVideoOnly ? undefined : isGif ? 1 : 2; // undefined = both video and audio
    const track = Math.max(1, Number(trackIndex) || 1);
    let count = await timeline.GetTrackCount(trackType);
    while (count < track) {
        const added = isGif ? await timeline.AddTrack('video') : await timeline.AddTrack('audio', 'stereo');
        if (!added) break;
        count = await timeline.GetTrackCount(trackType);
    }
    if (isYt && !ytAudio && !ytVideoOnly) {
        let aCount = await timeline.GetTrackCount('audio');
        while (aCount < track) {
            if (!(await timeline.AddTrack('audio', 'stereo'))) break;
            aCount = await timeline.GetTrackCount('audio');
        }
    }
    const clipInfo = (extra) => ({ mediaPoolItem: item, ...(mediaType ? { mediaType } : {}), trackIndex: track, recordFrame, ...extra });

    let placed = await mediaPool.AppendToTimeline([clipInfo()]);
    if (!placed || placed.length === 0) {
        const frames = parseInt(await item.GetClipProperty('Frames'), 10);
        if (frames > 0) placed = await mediaPool.AppendToTimeline([clipInfo({ startFrame: 0, endFrame: frames - 1 })]);
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
// Resolve plugin or packaged standalone app; never overwrite the project folder (dev / running from source).
const UPDATABLE = !DEV && (!ABLETON || app.isPackaged);
const APP_FILES = ['main.js', 'preload.js', 'renderer.js', 'index.html', 'css', 'img'];
const RESOLVE_FILES = ['manifest.xml', 'WorkflowIntegration.node'];

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
    return { available: isNewer(latest, current), current, latest, canRestart: ABLETON };
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
        const files = ABLETON ? APP_FILES : [...APP_FILES, ...RESOLVE_FILES];
        const missing = [...files, 'package.json'].find((f) => !fs.existsSync(path.join(root, f)));
        if (missing) throw new Error(`La descarga está incompleta (falta ${missing})`);
        try {
            for (const f of files) {
                const src = path.join(root, f), dest = path.join(__dirname, f);
                if (f.endsWith('.node')) { // a loaded native module must not be overwritten in place
                    if (fs.existsSync(dest) && fs.readFileSync(src).equals(fs.readFileSync(dest))) continue;
                    fs.rmSync(dest, { force: true });
                }
                fs.cpSync(src, dest, { recursive: true, force: true });
            }
            // package.json goes last: if anything above failed, the update is offered again.
            // The standalone app keeps its own name (it decides where its settings live).
            const pkgPath = path.join(__dirname, 'package.json');
            const next = readJson(path.join(root, 'package.json'), {});
            writeJson(pkgPath, ABLETON ? { ...readJson(pkgPath, {}), version: next.version } : next);
            fs.chmodSync(pkgPath, 0o644);
        } catch (e) {
            if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(ABLETON ? 'Sin permisos para actualizar. Mové la app a la carpeta Aplicaciones.' : 'Sin permisos para actualizar. Volvé a correr ./install.sh una vez.');
            throw e;
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
    return { configured: !!cfg, loggedIn: !!(cfg && (await getToken(cfg))), downloadDir: cfg && cfg.downloadDir, localDir: cfg && cfg.localDir, gifDir: cfg && cfg.gifDir, svgDir: cfg && cfg.svgDir, hasGiphy: !!(cfg && cfg.giphyApiKey), hasEleven: !!getEleven().key, yt: ytTools(), ableton: ABLETON, configPath: CONFIG_PATH };
}));
ipcMain.handle('update:check', wrap(checkUpdate));
ipcMain.handle('update:apply', wrap(applyUpdate));
ipcMain.handle('update:restart', wrap(() => { app.relaunch(); app.quit(); return true; }));
ipcMain.handle('fs:login', wrap(login));
ipcMain.handle('fs:logout', wrap(async () => { fs.rmSync(TOKEN_PATH, { force: true }); return true; }));
ipcMain.handle('fs:search', wrap(search));
ipcMain.handle('fs:download', wrap((e, s) => (s.kind === 'gif' ? giphyDownload(e, s) : s.kind === 'svg' ? svgDownload(e, s) : download(e, s))));
ipcMain.handle('local:search', wrap(localSearch));
ipcMain.handle('local:read', wrap(localRead));
ipcMain.handle('giphy:search', wrap(giphySearch));
ipcMain.handle('config:get', wrap(configGet));
ipcMain.handle('config:set', wrap(configSet));
ipcMain.handle('yt:search', wrap(ytSearch));
ipcMain.handle('yt:stream', wrap(ytStream));
ipcMain.handle('yt:exists', wrap(ytExists));
ipcMain.handle('yt:download', wrap(ytDownload));
ipcMain.handle('yt:cancel', wrap(ytCancel));
ipcMain.handle('eleven:voices', wrap(elevenVoices));
ipcMain.handle('eleven:addVoice', wrap(elevenAddVoice));
ipcMain.handle('eleven:removeVoice', wrap(elevenRemoveVoice));
ipcMain.handle('eleven:models', wrap(elevenModels));
ipcMain.handle('eleven:tts', wrap(elevenTts));
ipcMain.handle('eleven:sfx', wrap(elevenSfx));
ipcMain.handle('eleven:list', wrap(elevenList));
ipcMain.handle('svg:search', wrap(svgSearch));
ipcMain.handle('fonts:search', wrap(fontsSearch));
ipcMain.handle('fonts:install', wrap(fontsInstall));
ipcMain.handle('fonts:apply', wrap(fontsApply));
ipcMain.handle('svg:text', wrap(svgText));
ipcMain.handle('svg:savePng', wrap(svgSavePng));
ipcMain.handle('resolve:insert', wrap(insert));
ipcMain.on('drag:start', (event, file) => {
    const cfg = getConfig() || {};
    if (typeof file !== 'string') return;
    const abs = path.resolve(file);
    const allowed = [cfg.downloadDir, cfg.localDir, cfg.gifDir, cfg.svgDir, CLIPS_DIR, getEleven().dir, ytDir()].filter(Boolean).map((d) => path.resolve(d));
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
        title: ABLETON ? 'Freesound Studio' : 'Freesound',
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
