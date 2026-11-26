const $ = (id) => document.getElementById(id);
let page = 1;
let ABLETON = false;
let mode = 'sfx'; // 'sfx' | 'gif' | 'svg' | 'font' | 'gen' | 'yt'
let fontCat = 'all';
const FONT_CATS = [['all', 'Todas'], ['Sans Serif', 'Sans Serif'], ['Serif', 'Serif'], ['Display', 'Display'], ['Handwriting', 'Handwriting'], ['Monospace', 'Monospace']];
let svgStyle = 'all';
const SVG_STYLES = [['all', 'All Styles'], ['monocolor', 'Monocolor'], ['multicolor', 'Multicolor'], ['duotone', 'Duotone'], ['outlined', 'Outlined'], ['filled', 'Filled'], ['icon', 'Icon'], ['glyph', 'Glyph'], ['rounded', 'Rounded'], ['sharp', 'Sharp']];
const modes = {
    sfx: { remote: true, local: true, dir: '', remoteLabel: 'Freesound', placeholder: 'Buscar sonidos (ej. whoosh, rain, door)...', root: 'Local' },
    gif: { remote: true, local: true, dir: '', remoteLabel: 'Giphy', placeholder: 'Buscar GIFs (vacío = tendencias)...', root: 'Local' },
    svg: { remote: true, local: true, dir: '', remoteLabel: 'SVG Repo', placeholder: 'Buscar SVG (ej. fire, arrow, camera)...', root: 'Local' },
    font: { remote: true, local: false, dir: '', remoteLabel: 'Google Fonts', placeholder: 'Buscar fuentes (vacío = más populares)...', root: 'Local' },
    yt: { remote: true, local: false, dir: '', remoteLabel: 'YouTube', placeholder: 'Buscar en YouTube o pegar un enlace...', root: 'Local' },
    gen: { remote: false, local: false, dir: '', remoteLabel: 'ElevenLabs', placeholder: '', root: 'Local' }
};
const M = () => modes[mode];
let current = null; // { audio, card }
let hasEleven = false;

const audio = new Audio();
audio.addEventListener('timeupdate', updateHead);
audio.addEventListener('ended', () => setPlaying(null));

function setStatus(msg) { $('status').textContent = msg || ''; }

function fmtDuration(s) { return s < 10 ? s.toFixed(2) + ' s' : Math.round(s) + ' s'; }

function shortLicense(l) {
    if (/zero|publicdomain/i.test(l)) return 'CC0';
    if (/by-nc/i.test(l)) return 'CC-BY-NC';
    if (/by\//i.test(l)) return 'CC-BY';
    return 'CC';
}

async function call(promise) {
    const r = await promise;
    if (!r.ok) throw new Error(r.error);
    return r.data;
}

async function refreshStatus() {
    const st = await call(window.api.getStatus());
    const banner = $('banner');
    hasEleven = !!st.hasEleven;
    const freesoundNeeded = mode !== 'yt' && !(mode === 'gen' && st.hasEleven);
    if (!st.configured && freesoundNeeded) {
        banner.hidden = false;
        banner.innerHTML = 'Falta configurar. Abrí <b>⚙ Configuración</b> (abajo) o creá <code>' + st.configPath + '</code> con clientId, clientSecret y downloadDir.';
    } else {
        banner.hidden = true;
    }
    if (mode === 'gen' && !st.hasEleven) {
        banner.hidden = false;
        banner.innerHTML = 'Para generar audio agregá tu clave de ElevenLabs en <b>⚙ Configuración</b> (abajo).';
    } else if (mode === 'yt' && st.yt && !(st.yt.ytdlp && st.yt.ffmpeg)) {
        banner.hidden = false;
        banner.innerHTML = 'Para YouTube hace falta instalar ' + [!st.yt.ytdlp && '<code>yt-dlp</code>', !st.yt.ffmpeg && '<code>ffmpeg</code>'].filter(Boolean).join(' y ') + ': en Terminal, <code>brew install yt-dlp ffmpeg</code>.';
    } else if (mode !== 'gen' && mode !== 'yt' && st.configured && !st.hasGiphy) {
        banner.hidden = false;
        banner.innerHTML = 'Para GIFs agregá tu clave de Giphy en <b>⚙ Configuración</b> (abajo; gratis en developers.giphy.com).';
    }
    if (st.ableton && !ABLETON) {
        ABLETON = true;
        $('lblTrackA').hidden = true;
        $('lblTrackV').hidden = true;
        document.body.classList.add('ableton');
    }
    $('auth').textContent = st.loggedIn ? 'Cerrar sesión' : 'Iniciar sesión en Freesound';
    $('auth').dataset.loggedIn = st.loggedIn ? '1' : '';
    $('auth').hidden = !st.configured;
    return st;
}

$('auth').addEventListener('click', async () => {
    try {
        if ($('auth').dataset.loggedIn) await call(window.api.logout());
        else { setStatus('Esperando autorización en el navegador...'); await call(window.api.login()); setStatus('Sesión iniciada'); }
    } catch (e) { setStatus(e.message); }
    refreshStatus();
});

function toggleSource(key, btn) {
    M()[key] = !M()[key];
    btn.classList.toggle('on', M()[key]);
    runSearch(false);
}
$('srcRemote').addEventListener('click', (e) => toggleSource('remote', e.currentTarget));
$('srcLocal').addEventListener('click', (e) => toggleSource('local', e.currentTarget));

// ---------- recorte al insertar/arrastrar (solo sonidos) ----------
const SILENCE = 0.005; // ~ -46 dBFS
function loadOpt(k, d) { try { const v = localStorage.getItem('fsd.' + k); return v === null ? d : v; } catch (e) { return d; } }
function saveOpt(k, v) { try { localStorage.setItem('fsd.' + k, v); } catch (e) { /* ignore */ } }
const clip = { trim: loadOpt('trim', '0') === '1', secsOn: loadOpt('secsOn', '0') === '1' };
$('optSecs').value = loadOpt('secs', '5');
function syncClipUi() {
    $('optTrim').classList.toggle('on', clip.trim);
    $('optSecsOn').classList.toggle('on', clip.secsOn);
}
$('optTrim').addEventListener('click', () => { clip.trim = !clip.trim; saveOpt('trim', clip.trim ? '1' : '0'); syncClipUi(); });
$('optSecsOn').addEventListener('click', () => { clip.secsOn = !clip.secsOn; saveOpt('secsOn', clip.secsOn ? '1' : '0'); syncClipUi(); });
$('optSecs').addEventListener('change', () => saveOpt('secs', $('optSecs').value));
syncClipUi();

function clipOpts() {
    const secs = parseFloat($('optSecs').value);
    return { trim: clip.trim, secs: clip.secsOn && secs > 0 ? secs : 0 };
}

// Pure: returns [startSample, endSample) to keep.
function clipRange(channels, sr, o) {
    const n = channels[0].length;
    let start = 0;
    if (o.trim) {
        outer: for (let i = 0; i < n; i++) {
            for (const ch of channels) if (Math.abs(ch[i]) > SILENCE) { start = i; break outer; }
            if (i === n - 1) start = 0; // all silent: leave as is
        }
    }
    let end = n;
    if (o.secs) end = Math.min(n, start + Math.round(o.secs * sr));
    return [start, end];
}

// 24-bit PCM WAV; a 10 ms fade-out when the end was cut avoids a click.
function encodeWav(channels, sr, start, end, fadeOut) {
    const len = end - start, nc = channels.length;
    const buf = new ArrayBuffer(44 + len * nc * 3);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + len * nc * 3, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 3, true); v.setUint16(32, nc * 3, true); v.setUint16(34, 24, true);
    str(36, 'data'); v.setUint32(40, len * nc * 3, true);
    const fade = fadeOut ? Math.min(len, Math.round(sr * 0.01)) : 0;
    let o = 44;
    for (let i = 0; i < len; i++) {
        const g = fade && i >= len - fade ? (len - i) / fade : 1;
        for (let c = 0; c < nc; c++) {
            const x = Math.max(-1, Math.min(1, channels[c][start + i] * g));
            const q = Math.round(x * 8388607);
            v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255);
            o += 3;
        }
    }
    return new Uint8Array(buf);
}

function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

const clipReady = new Map(); // key -> path of the trimmed copy
const clipJobs = new Map();  // key -> in-flight promise
function clipKey(file, o) { return file + '|' + o.trim + '|' + o.secs; }

// Returns the file to use: the original when no option is active, else a trimmed copy (cached on disk).
function prepareClip(file) {
    const o = clipOpts();
    if (!o.trim && !o.secs) return Promise.resolve(file);
    const key = clipKey(file, o);
    if (clipReady.has(key)) return Promise.resolve(clipReady.get(key));
    if (clipJobs.has(key)) return clipJobs.get(key);
    const job = (async () => {
        const base = file.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').slice(0, 60);
        const name = base + '_' + (o.trim ? 'ns' : 'ss') + (o.secs ? o.secs + 's' : '') + '_' + hashStr(key) + '.wav';
        let out = await call(window.api.clipExists(name));
        if (!out) {
            const bytes = await call(window.api.clipRead(file));
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            let dec;
            try { dec = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
            finally { ctx.close(); }
            const channels = Array.from({ length: dec.numberOfChannels }, (_, i) => dec.getChannelData(i));
            const [s, e] = clipRange(channels, dec.sampleRate, o);
            out = await call(window.api.clipSave(name, encodeWav(channels, dec.sampleRate, s, e, e < channels[0].length)));
        }
        clipReady.set(key, out);
        return out;
    })();
    clipJobs.set(key, job);
    job.then(() => clipJobs.delete(key), () => clipJobs.delete(key));
    return job;
}

function applyMode() {
    const cfg = M();
    $('tabSfx').classList.toggle('on', mode === 'sfx');
    $('tabGif').classList.toggle('on', mode === 'gif');
    $('tabSvg').classList.toggle('on', mode === 'svg');
    $('tabFont').classList.toggle('on', mode === 'font');
    $('tabGen').classList.toggle('on', mode === 'gen');
    $('tabYt').classList.toggle('on', mode === 'yt');
    $('results').classList.toggle('yt', mode === 'yt');
    $('genBar').hidden = mode !== 'gen';
    $('searchForm').hidden = mode === 'gen';
    $('svgStyles').hidden = mode !== 'svg';
    $('fontCats').hidden = mode !== 'font';
    $('fontText').hidden = mode !== 'font';
    $('sources').hidden = mode === 'font' || mode === 'gen' || mode === 'yt';
    $('trackBar').hidden = mode === 'font';
    $('srcRemote').textContent = cfg.remoteLabel;
    $('srcRemote').classList.toggle('on', cfg.remote);
    $('srcLocal').classList.toggle('on', cfg.local);
    $('query').placeholder = cfg.placeholder;
    $('sfxFilters').hidden = mode !== 'sfx';
    $('clipBar').hidden = mode !== 'sfx';
    $('lblTrackA').hidden = (mode !== 'sfx' && mode !== 'gen' && !(mode === 'yt' && ytMedia === 'audio')) || ABLETON;
    $('lblTrackV').hidden = mode === 'sfx' || mode === 'gen' || (mode === 'yt' && ytMedia === 'audio') || ABLETON;
    $('lblMedia').hidden = mode !== 'yt';
    $('lblMinQ').hidden = mode !== 'yt';
    $('lblPrevAudio').hidden = mode !== 'yt';
    $('optSticker').hidden = mode !== 'gif';
    $('giphyCredit').hidden = !(mode === 'gif' && cfg.remote);
    $('results').classList.toggle('grid', mode !== 'sfx' && mode !== 'gen');
    $('results').classList.toggle('svg', mode === 'svg');
    $('results').classList.toggle('fonts', mode === 'font');
    stopPlayback();
    refreshStatus().catch(() => {});
    runSearch(false);
}
function setMode(next) {
    if (next === mode) return;
    mode = next;
    applyMode();
}
$('tabSfx').addEventListener('click', () => setMode('sfx'));
$('tabGif').addEventListener('click', () => setMode('gif'));
$('optSticker').addEventListener('click', (ev) => { ev.currentTarget.classList.toggle('on'); runSearch(false); });
$('tabSvg').addEventListener('click', () => setMode('svg'));
$('tabFont').addEventListener('click', () => setMode('font'));
$('tabGen').addEventListener('click', () => setMode('gen'));
$('tabYt').addEventListener('click', () => setMode('yt'));
FONT_CATS.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('on', key === fontCat);
    b.addEventListener('click', () => {
        fontCat = key;
        $('fontCats').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        runSearch(false);
    });
    $('fontCats').appendChild(b);
});
SVG_STYLES.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.classList.toggle('on', key === svgStyle);
    b.addEventListener('click', () => {
        svgStyle = key;
        $('svgStyles').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        runSearch(false);
    });
    $('svgStyles').appendChild(b);
});

const cardFor = (s) => (s.kind === 'yt' ? renderYtCard(s) : s.kind === 'gif' ? renderGifCard(s) : s.kind === 'svg' ? renderSvgCard(s) : s.kind === 'font' ? renderFontCard(s) : renderCard(s));

function renderCrumbs() {
    const nav = $('crumbs');
    nav.hidden = !M().local;
    if (!M().local) return;
    nav.innerHTML = '';
    const add = (label, dir) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => { M().dir = dir; runSearch(false); });
        nav.appendChild(b);
    };
    add(M().root, '');
    let acc = '';
    M().dir.split('/').filter(Boolean).forEach((part) => {
        acc = acc ? acc + '/' + part : part;
        nav.appendChild(document.createTextNode(' / '));
        add(part, acc);
    });
}

let searchToken = 0;
async function runSearch(append) {
    const token = ++searchToken;
    if (!append) { page = 1; $('results').innerHTML = ''; $('more').hidden = true; ytStates.clear(); ytShown.clear(); if (ytActive) { ytActive.stop(); ytActive = null; } }
    if (mode === 'gen') { renderCrumbs(); return loadGenList(); }
    if (!M().remote && !M().local) { renderCrumbs(); setStatus('Activá Freesound y/o Local'); return; }
    setStatus('Buscando...');
    const query = $('query').value.trim();
    const kind = mode;
    const parts = [];
    const errors = [];
    try {
        if (M().local && !append) {
            try {
                const data = await call(window.api.localSearch({ kind, query, dir: M().dir, refresh: true }));
                if (token !== searchToken || kind !== mode) return;
                data.folders.forEach((f) => $('results').appendChild(renderFolder(f)));
                data.sounds.forEach((s) => $('results').appendChild(cardFor(s)));
                parts.push(data.total + ' locales' + (data.total > data.sounds.length ? ' (mostrando ' + data.sounds.length + ')' : ''));
            } catch (e) { errors.push('Local: ' + e.message); }
        }
        if (M().remote) {
            try {
                if ((kind === 'svg' || kind === 'yt') && !query) throw new Error('escribí qué buscar' + (kind === 'yt' ? ' o pegá un enlace' : ''));
                const data = kind === 'yt'
                    ? await call(window.api.ytSearch({ query, page, minHeight: Number($('ytMinQ').value) || 0, token }))
                    : kind === 'gif'
                    ? await call(window.api.giphySearch({ query, page, stickers: $('optSticker').classList.contains('on') }))
                    : kind === 'font'
                    ? await call(window.api.fontsSearch({ query, category: fontCat, page }))
                    : kind === 'svg'
                    ? await call(window.api.svgSearch({ query, style: svgStyle, page }))
                    : await call(window.api.search({
                        query,
                        maxDuration: $('maxDuration').value,
                        license: $('license').value,
                        sort: $('sort').value,
                        page
                    }));
                if (token !== searchToken || kind !== mode) return;
                data.results.filter((s) => !(kind === 'yt' && ytShown.has(s.id))).forEach((s) => $('results').appendChild(cardFor(s)));
                $('more').hidden = !data.next;
                parts.push(data.count + ' en ' + M().remoteLabel + (kind === 'yt' ? (Number($('ytMinQ').value) > 480 ? ' (≥ ' + qualityLabel(Number($('ytMinQ').value)) + ')' : Number($('ytMinQ').value) ? ' (hasta 480p no se filtra: casi todos los videos lo alcanzan)' : '') : ''));
                if (data.note) errors.push(data.note);
            } catch (e) { errors.push(M().remoteLabel + ': ' + e.message); }
        }
    } finally {
        if (token === searchToken && kind === mode) {
            renderCrumbs();
            setStatus(errors.length ? errors.join(' | ') : parts.join(' · '));
        }
    }
}

$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(false); });
$('more').addEventListener('click', () => { page++; runSearch(true); });

function renderFolder(f) {
    const el = document.createElement('div');
    el.className = 'folder';
    el.textContent = '📁 ' + f.name;
    el.addEventListener('click', () => { M().dir = f.rel.split('\\').join('/'); runSearch(false); });
    return el;
}

function fileUrl(p) {
    return 'file://' + encodeURI(p).replace(/[#?]/g, (c) => '%' + c.charCodeAt(0).toString(16));
}

const waveObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
        if (!en.isIntersecting) return;
        waveObserver.unobserve(en.target);
        drawLocalWave(en.target.closest('.card'));
    });
}, { root: $('results'), rootMargin: '200px' });

async function drawLocalWave(card) {
    const s = card._sound;
    const wave = card.querySelector('.wave');
    try {
        const buf = await call(window.api.localRead(s.rel));
        if (!buf) throw new Error('grande');
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await ctx.decodeAudioData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        ctx.close();
        card.querySelector('.dur').textContent = fmtDuration(decoded.duration);
        const canvas = document.createElement('canvas');
        const W = (canvas.width = 600), H = (canvas.height = 112);
        const g = canvas.getContext('2d');
        const ch = decoded.getChannelData(0);
        const step = Math.max(1, Math.floor(ch.length / W));
        g.fillStyle = '#6fa3ff';
        for (let x = 0; x < W; x++) {
            let max = 0;
            for (let i = x * step; i < Math.min(ch.length, (x + 1) * step); i += Math.ceil(step / 64)) max = Math.max(max, Math.abs(ch[i]));
            const h = Math.max(1, max * H);
            g.fillRect(x, (H - h) / 2, 1, h);
        }
        wave.insertBefore(canvas, wave.firstChild);
    } catch (e) {
        const msg = document.createElement('div');
        msg.className = 'empty';
        msg.textContent = 'sin waveform';
        wave.insertBefore(msg, wave.firstChild);
    }
}

function renderCard(s) {
    const card = document.createElement('div');
    card.className = 'card';
    const wave = s.images && (s.images.waveform_m || s.images.waveform_l);
    card.innerHTML =
        '<div class="top"><span class="name"></span><span class="dur"></span></div>' +
        '<div class="meta"></div>' +
        '<div class="wave">' + (s.local ? '' : '<img alt="">') + '<div class="head"></div></div>' +
        '<div class="actions">' +
        '<button class="play">▶ Preview</button>' +
        '<button class="dl">Descargar</button>' +
        '<button class="ins primary">Insertar en playhead</button>' +
        '<span class="state"></span></div>';
    card.querySelector('.name').textContent = s.name;
    card.querySelector('.name').title = s.name;
    card._sound = s;
    const meta = card.querySelector('.meta');
    const badge = document.createElement('span');
    badge.className = 'badge' + (s.local ? ' local' : '');
    badge.textContent = s.local ? 'Local' : 'Freesound';
    meta.appendChild(badge);
    if (s.local) {
        meta.appendChild(document.createTextNode((s.dir ? s.dir + ' · ' : '') + s.type));
        card.querySelector('.dl').remove();
        waveObserver.observe(card.querySelector('.wave'));
    } else {
        card.querySelector('.dur').textContent = fmtDuration(s.duration);
        meta.appendChild(document.createTextNode(s.username + ' · ' + shortLicense(s.license) + ' · ' + s.type));
        if (wave) card.querySelector('img').src = wave;
    }

    const state = card.querySelector('.state');
    const setState = (msg, err) => { state.textContent = msg; state.className = 'state' + (err ? ' err' : ''); };

    card.querySelector('.play').addEventListener('click', () => togglePlay(card));
    card.querySelector('.wave').addEventListener('click', (ev) => {
        const r = ev.currentTarget.getBoundingClientRect();
        togglePlay(card, (ev.clientX - r.left) / r.width);
    });
    const dl = card.querySelector('.dl');
    // Click the waveform to audition/seek, drag it out to a track (Ableton) or the Resolve timeline.
    // Local files are ready; Freesound ones are downloaded on the first drag attempt (not on click).
    let file = s.local ? s.path : null;
    const ensureFile = async () => {
        if (file) return file;
        setState('Descargando...');
        try { file = await call(window.api.download(s)); setState('Listo, arrastrá de nuevo'); }
        catch (e) { setState(e.message, true); }
        return file;
    };
    const waveEl = card.querySelector('.wave');
    waveEl.draggable = true;
    waveEl.title = 'Click: escuchar · Arrastrar: llevar a ' + (ABLETON ? 'Ableton' : 'la timeline');
    // The trimmed copy is built ahead of time (hover / mouse down) because startDrag must run synchronously.
    const warm = () => { if (file) prepareClip(file).catch(() => {}); };
    waveEl.addEventListener('mouseenter', warm);
    waveEl.addEventListener('mousedown', warm);
    waveEl.addEventListener('dragstart', (ev) => {
        ev.preventDefault();
        if (!file) { ensureFile(); return; }
        const o = clipOpts();
        const ready = (!o.trim && !o.secs) ? file : clipReady.get(clipKey(file, o));
        if (ready) window.api.startDrag(ready);
        else { setState('Preparando recorte... arrastrá de nuevo'); prepareClip(file).then(() => setState('Listo, arrastrá de nuevo')).catch((e) => setState(e.message, true)); }
    });
    if (ABLETON) {
        card.querySelector('.ins').remove();
        if (dl) dl.remove();
    } else if (dl) {
        dl.addEventListener('click', () => ensureFile());
    }
    const insBtn = card.querySelector('.ins');
    if (insBtn) insBtn.addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Insertando...');
        try {
            const o = clipOpts();
            let clipFile;
            if (o.trim || o.secs) {
                const src = file || (await ensureFile());
                if (!src) throw new Error('No se pudo descargar');
                clipFile = await prepareClip(src);
            }
            const r = await call(window.api.insert(s, $('trackA').value, clipFile));
            setState('Insertado en A' + r.track + ' @ ' + r.tc);
        } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    return card;
}

function renderGifCard(g) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
        '<div class="top"><span class="name"></span></div>' +
        '<div class="meta"></div>' +
        '<div class="gifwrap"></div>' +
        '<div class="actions">' +
        (g.local ? '' : '<button class="dl">Descargar</button>') +
        '<button class="ins primary">Insertar en playhead</button>' +
        '<span class="state"></span></div>';
    card.querySelector('.name').textContent = g.name;
    card.querySelector('.name').title = g.name;
    const meta = card.querySelector('.meta');
    const badge = document.createElement('span');
    badge.className = 'badge' + (g.local ? ' local' : '');
    badge.textContent = g.local ? 'Local' : 'Giphy';
    meta.appendChild(badge);
    meta.appendChild(document.createTextNode(g.local ? (g.dir ? g.dir + ' · ' : '') + g.type : (g.username ? '@' + g.username + ' · ' : '') + (g.width ? g.width + '×' + g.height : '')));
    const wrap = card.querySelector('.gifwrap');
    if (g.local && g.type !== 'gif') {
        const v = document.createElement('video');
        v.src = fileUrl(g.path);
        v.muted = true; v.loop = true; v.preload = 'metadata';
        v.addEventListener('mouseenter', () => v.play().catch(() => {}));
        v.addEventListener('mouseleave', () => v.pause());
        wrap.appendChild(v);
    } else {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = g.local ? fileUrl(g.path) : g.preview;
        wrap.appendChild(img);
    }
    const state = card.querySelector('.state');
    const setState = (msg, err) => { state.textContent = msg; state.className = 'state' + (err ? ' err' : ''); };
    const dl = card.querySelector('.dl');
    // Drag the GIF out to the timeline; Giphy ones are downloaded on the first drag attempt.
    let file = g.local ? g.path : null;
    const ensureFile = async () => {
        if (file) return file;
        setState('Descargando...');
        try { file = await call(window.api.download(g)); setState('Listo, arrastrá de nuevo'); }
        catch (e) { setState(e.message, true); }
        return file;
    };
    wrap.draggable = true;
    wrap.title = 'Arrastrar: llevar a la timeline';
    wrap.addEventListener('dragstart', (ev) => {
        ev.preventDefault();
        if (file) window.api.startDrag(file);
        else ensureFile();
    });
    if (dl) dl.addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true;
        await ensureFile();
        if (file) setState('Descargado');
        b.disabled = false;
    });
    if (ABLETON) card.querySelector('.ins').remove();
    else card.querySelector('.ins').addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Insertando...');
        try {
            const r = await call(window.api.insert(g, $('trackV').value));
            setState('Insertado en V' + r.track + ' @ ' + r.tc);
        } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    return card;
}

// Rasterizes SVG text to a transparent PNG data URL (long side = size px). Resolve can't import SVG.
async function rasterizeSvg(text, size) {
    const el = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    if (el.nodeName !== 'svg') throw new Error('SVG inválido');
    let w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height'));
    const vb = (el.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
    else if (!(w > 0 && h > 0)) { w = h = size; }
    if (vb.length !== 4) el.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    const k = size / Math.max(w, h);
    const W = Math.round(w * k), H = Math.round(h * k);
    el.setAttribute('width', W);
    el.setAttribute('height', H);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(el));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d').drawImage(img, 0, 0, W, H);
    return canvas.toDataURL('image/png');
}

function renderSvgCard(s) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
        '<div class="top"><span class="name"></span></div>' +
        '<div class="meta"></div>' +
        '<div class="svgwrap"><img alt=""></div>' +
        '<div class="actions">' +
        (s.local ? '' : '<button class="dl">SVG</button>') +
        '<button class="png">PNG</button>' +
        '<button class="ins primary">Insertar</button>' +
        '<span class="state"></span></div>';
    const name = s.local ? s.name.replace(/\.svg$/i, '').replace(/^\d+_/, '').replace(/[-_]/g, ' ') : s.name;
    card.querySelector('.name').textContent = name;
    card.querySelector('.name').title = name;
    const meta = card.querySelector('.meta');
    const badge = document.createElement('span');
    badge.className = 'badge' + (s.local ? ' local' : '');
    badge.textContent = s.local ? 'Local' : 'SVG Repo';
    meta.appendChild(badge);
    if (s.local && s.dir) meta.appendChild(document.createTextNode(s.dir));
    card.querySelector('img').src = s.local ? fileUrl(s.path) : s.preview;

    const state = card.querySelector('.state');
    const setState = (msg, err) => { state.textContent = msg; state.className = 'state' + (err ? ' err' : ''); };
    let file = s.local ? s.path : null;
    const ensureFile = async () => {
        if (file) return file;
        setState('Descargando...');
        try { file = await call(window.api.download(s)); setState('Guardado'); }
        catch (e) { setState(e.message, true); }
        return file;
    };
    // Drag the SVG out to Affinity / Finder / the timeline; Repo ones are saved on the first drag attempt.
    const wrap = card.querySelector('.svgwrap');
    wrap.draggable = true;
    wrap.title = 'Arrastrar: llevar el SVG a otra app';
    wrap.addEventListener('dragstart', (ev) => {
        ev.preventDefault();
        if (file) window.api.startDrag(file);
        else ensureFile();
    });
    const makePng = async () => {
        const svg = await ensureFile();
        if (!svg) throw new Error('No se pudo guardar el SVG');
        const text = await call(window.api.svgText(svg));
        return call(window.api.svgSavePng(svg, await rasterizeSvg(text, 1024)));
    };
    const dl = card.querySelector('.dl');
    if (dl) dl.addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true;
        if (await ensureFile()) setState('SVG guardado');
        b.disabled = false;
    });
    card.querySelector('.png').addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Generando PNG...');
        try { await makePng(); setState('PNG guardado junto al SVG'); } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    if (ABLETON) card.querySelector('.ins').remove();
    else card.querySelector('.ins').addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Insertando...');
        try {
            const png = await makePng();
            const r = await call(window.api.insert({ kind: 'svg', png }, $('trackV').value));
            setState('Insertado en V' + r.track + ' @ ' + r.tc);
        } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    return card;
}

const loadedFonts = new Set();
function renderFontCard(s) {
    if (!loadedFonts.has(s.id)) {
        loadedFonts.add(s.id);
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(s.id).replace(/%20/g, '+') + '&display=swap';
        document.head.appendChild(link);
    }
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
        '<div class="top"><span class="name"></span></div>' +
        '<div class="meta"></div>' +
        '<div class="fontsample"></div>' +
        '<div class="actions"><button class="ins primary">Instalar</button><button class="apply">Aplicar al título</button><span class="state"></span></div>';
    card.querySelector('.fontsample').textContent = $('fontText').value || s.name;
    card.querySelector('.name').textContent = s.name;
    card.querySelector('.name').title = s.name;
    card.querySelector('.fontsample').style.fontFamily = `"${s.id}", sans-serif`;
    const meta = card.querySelector('.meta');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = s.category;
    meta.appendChild(badge);
    meta.appendChild(document.createTextNode(`${s.styles} estilo${s.styles === 1 ? '' : 's'}` + (s.designer ? ' · ' + s.designer : '')));
    const state = card.querySelector('.state');
    const setState = (msg, err) => { state.textContent = msg; state.className = 'state' + (err ? ' err' : ''); };
    card.querySelector('.ins').addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Instalando...');
        try {
            const r = await call(window.api.fontsInstall({ family: s.id }));
            setState(r.installed ? 'Instalada. Reiniciá la app que la use.' : 'Ya estaba instalada');
        } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    if (ABLETON) card.querySelector('.apply').remove();
    else card.querySelector('.apply').addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Aplicando...');
        try {
            const r = await call(window.api.fontsApply({ family: s.id }));
            setState('Aplicada a "' + r.item + '"');
        } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    return card;
}

$('fontText').addEventListener('input', () => {
    const t = $('fontText').value;
    document.querySelectorAll('.fontsample').forEach((el) => { el.textContent = t || el.closest('.card').querySelector('.name').textContent; });
});

// ---------- generación de audio (ElevenLabs) ----------
let genType = 'voz';
let voicesLoaded = false;
let modelsLoaded = false;

function syncGenUi() {
    $('genType').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.type === genType));
    document.querySelectorAll('.genVoz').forEach((el) => { el.hidden = genType !== 'voz'; });
    document.querySelectorAll('.genSfx').forEach((el) => { el.hidden = genType !== 'sfx'; });
    $('genText').placeholder = genType === 'voz' ? 'Texto a locutar...' : 'Describí el efecto (ej. puerta de madera que cruje lentamente)...';
}
$('genType').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { genType = b.dataset.type; syncGenUi(); if (genType === 'voz') loadVoices(); }));
syncGenUi();

async function loadVoices(force) {
    if ((voicesLoaded && !force) || !hasEleven) return;
    const sel = $('genVoice');
    try {
        const { voices, warning } = await call(window.api.elevenVoices());
        const prev = sel.value || loadOpt('genVoice', '');
        sel.innerHTML = '';
        customIds = new Set();
        const groups = { custom: 'Mis IDs', mine: 'Mis voces (clonadas)', library: 'Biblioteca', premade: 'Predefinidas' };
        Object.entries(groups).forEach(([key, label]) => {
            const list = voices.filter((v) => v.group === key);
            if (!list.length) return;
            const og = document.createElement('optgroup');
            og.label = label;
            list.forEach((v) => {
                const o = document.createElement('option');
                o.value = v.id;
                o.textContent = v.name;
                og.appendChild(o);
                if (key === 'custom') customIds.add(v.id);
            });
            sel.appendChild(og);
        });
        if (!voices.length) sel.innerHTML = '<option value="">Sin voces: pegá un ID abajo</option>';
        else if (prev && voices.some((v) => v.id === prev)) sel.value = prev;
        syncDelBtn();
        voicesLoaded = true;
        if (warning) setStatus('No se pudo leer tu lista de voces (' + warning + '). Podés usar IDs.');
    } catch (e) { sel.innerHTML = '<option value="">Sin voces</option>'; setStatus(e.message); }
}
let customIds = new Set();
function syncDelBtn() { $('genDelVoice').hidden = !customIds.has($('genVoice').value); }
$('genVoice').addEventListener('change', syncDelBtn);
$('genAddVoice').addEventListener('click', async () => {
    const id = $('genVoiceId').value.trim();
    if (!id) { setStatus('Pegá un ID de voz'); return; }
    const b = $('genAddVoice'); b.disabled = true; setStatus('Añadiendo voz...');
    try {
        const v = await call(window.api.elevenAddVoice({ id, name: $('genVoiceName').value }));
        $('genVoiceId').value = ''; $('genVoiceName').value = '';
        saveOpt('genVoice', v.id);
        await loadVoices(true);
        $('genVoice').value = v.id; syncDelBtn();
        setStatus('Voz añadida: ' + v.name);
    } catch (e) { setStatus(e.message); }
    b.disabled = false;
});
$('genDelVoice').addEventListener('click', async () => {
    try { await call(window.api.elevenRemoveVoice($('genVoice').value)); saveOpt('genVoice', ''); await loadVoices(true); setStatus('Voz quitada de tu lista'); }
    catch (e) { setStatus(e.message); }
});
$('genVoice').addEventListener('change', () => saveOpt('genVoice', $('genVoice').value));
async function loadModels() {
    try {
        const models = await call(window.api.elevenModels());
        if (!models.length) return;
        const prev = $('genModel').value || loadOpt('genModel', 'eleven_multilingual_v2');
        $('genModel').innerHTML = '';
        models.forEach((m) => {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.name;
            $('genModel').appendChild(o);
        });
        if (models.some((m) => m.id === prev)) $('genModel').value = prev;
    } catch (e) { /* keep the built-in list */ }
}
$('genModel').value = loadOpt('genModel', 'eleven_multilingual_v2');
$('genModel').addEventListener('change', () => saveOpt('genModel', $('genModel').value));

let showOld = false;
async function loadGenList() {
    if (!hasEleven) { setStatus('Falta elevenlabsApiKey'); return; }
    loadVoices();
    if (!modelsLoaded) { modelsLoaded = true; loadModels(); }
    try {
        const items = await call(window.api.elevenList());
        if (mode !== 'gen') return;
        const box = $('results');
        box.innerHTML = '';
        if (items.length) box.appendChild(renderGenCard(items[0]));
        const older = items.slice(1);
        if (older.length) {
            const toggle = document.createElement('button');
            toggle.id = 'oldToggle';
            const list = document.createElement('div');
            list.id = 'oldList';
            older.forEach((it) => list.appendChild(renderGenCard(it)));
            const sync = () => {
                list.hidden = !showOld;
                toggle.textContent = (showOld ? '▾ Ocultar anteriores' : '▸ Ver anteriores') + ' (' + older.length + ')';
            };
            toggle.addEventListener('click', () => { showOld = !showOld; sync(); });
            sync();
            box.appendChild(toggle);
            box.appendChild(list);
        }
        setStatus(items.length ? items.length + ' audios generados' : 'Todavía no generaste audios');
    } catch (e) { setStatus(e.message); }
}

function growText() {
    const t = $('genText');
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 2 + 'px';
}
$('genText').addEventListener('input', growText);

$('genGo').addEventListener('click', async () => {
    const text = $('genText').value.trim();
    if (!text) { setStatus('Escribí un texto'); return; }
    const b = $('genGo');
    b.disabled = true; setStatus('Generando...');
    try {
        if (genType === 'voz') await call(window.api.elevenTts({ text, voiceId: $('genVoice').value, modelId: $('genModel').value }));
        else await call(window.api.elevenSfx({ text, duration: $('genDur').value, influence: $('genInfl').value }));
        await loadGenList();
        setStatus('Listo');
    } catch (e) { setStatus(e.message); }
    b.disabled = false;
});

function renderGenCard(it) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
        '<div class="top"><span class="name"></span><span class="dur"></span></div>' +
        '<div class="meta"></div>' +
        '<div class="wave" draggable="true" title="Arrastrar: llevar a la timeline"><div class="empty">arrastrá para llevar a la timeline</div></div>' +
        '<div class="actions">' +
        '<button class="play">▶ Preview</button>' +
        '<button class="ins primary">Insertar en playhead</button>' +
        '<span class="state"></span></div>';
    card.querySelector('.name').textContent = it.name;
    card.querySelector('.name').title = it.name;
    const badge = document.createElement('span');
    badge.className = 'badge local';
    badge.textContent = it.kind === 'voz' ? 'Voz' : 'SFX';
    card.querySelector('.meta').appendChild(badge);
    card.querySelector('.meta').appendChild(document.createTextNode(new Date(it.mtime).toLocaleString()));
    const state = card.querySelector('.state');
    const setState = (msg, err) => { state.textContent = msg; state.className = 'state' + (err ? ' err' : ''); };
    card._sound = { local: true, path: it.path };
    card.querySelector('.play').addEventListener('click', () => togglePlay(card));
    card.querySelector('.wave').addEventListener('dragstart', (ev) => { ev.preventDefault(); window.api.startDrag(it.path); });
    if (ABLETON) card.querySelector('.ins').remove();
    else card.querySelector('.ins').addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Insertando...');
        try {
            const r = await call(window.api.insert({ kind: 'sfx' }, $('trackA').value, it.path));
            setState('Insertado en A' + r.track + ' @ ' + r.tc);
        } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    return card;
}

// ---------- YouTube ----------
let ytActive = null; // the mini player currently playing
let ytMedia = loadOpt('ytMedia', loadOpt('ytAudio', '0') === '1' ? 'audio' : 'both'); // 'both' | 'video' | 'audio'
const ytStates = new Set(); // cards of the current search (to refresh their file rows when the toggle changes)
$('ytMedia').value = ytMedia;
$('ytMedia').addEventListener('change', () => {
    ytMedia = $('ytMedia').value;
    saveOpt('ytMedia', ytMedia);
    applyTrackLabels();
    ytStates.forEach((st) => st.commit());
});
function applyTrackLabels() {
    $('lblTrackA').hidden = (mode !== 'sfx' && mode !== 'gen' && !(mode === 'yt' && ytMedia === 'audio')) || ABLETON;
    $('lblTrackV').hidden = mode === 'sfx' || mode === 'gen' || (mode === 'yt' && ytMedia === 'audio') || ABLETON;
}
let ytModalClose = null;
let ytModalPlayer = null;
$('ytMinQ').value = loadOpt('ytMinQ', '0');
$('ytMinQ').addEventListener('change', () => {
    saveOpt('ytMinQ', $('ytMinQ').value);
    if ($('query').value.trim()) runSearch(false);
});
function qualityLabel(res) {
    const tier = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144].find((t) => res >= t * 0.93);
    return tier ? (tier === 4320 ? '8K' : tier === 2160 ? '4K' : tier + 'p') : '';
}
let ytPrefetching = 0;
let ytPrevAudio = loadOpt('ytPrevAudio', '0') === '1'; // preview with sound (slower to load) or silent (faster)
$('ytPrevAudio').checked = ytPrevAudio;
$('ytPrevAudio').addEventListener('change', () => {
    ytPrevAudio = $('ytPrevAudio').checked;
    saveOpt('ytPrevAudio', ytPrevAudio ? '1' : '0');
    setStatus(ytPrevAudio ? 'Vista previa con audio: tarda un poco más en cargar. Los videos ya cargados se actualizan al reproducirlos de nuevo.' : 'Vista previa sin audio: carga más rápido.');
});
const ytShown = new Set(); // ids already on screen thanks to partial results of the current search
window.api.onYtPartial(({ token, results }) => {
    if (token !== searchToken || mode !== 'yt') return;
    results.forEach((v) => { if (!ytShown.has(v.id)) { ytShown.add(v.id); $('results').appendChild(renderYtCard(v)); } });
    setStatus('Verificando calidad... ' + ytShown.size + ' encontrados');
});
const ytJobs = new Map();
window.api.onYtProgress((p) => { const cb = ytJobs.get(p.job); if (cb) cb(p); });

const ytUrlJobs = new Map(); // id:size -> promise (shared by hover prefetch and the actual play)
function ytStreamUrls(id, big) {
    const audio = !big && ytPrevAudio;
    const key = id + (big ? ':b' : ':s') + (audio ? 'a' : '');
    if (!ytUrlJobs.has(key)) {
        const job = call(window.api.ytStream({ id, big, audio }));
        job.catch(() => ytUrlJobs.delete(key));
        ytUrlJobs.set(key, job);
        setTimeout(() => ytUrlJobs.delete(key), 25 * 60 * 1000);
    }
    return ytUrlJobs.get(key);
}

function fmtT(sec) {
    sec = Math.max(0, sec || 0);
    const m = Math.floor(sec / 60), r = sec - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}
function fmtClock(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
}
const hasSel = (st) => st.start != null && st.end != null && st.end > st.start;

// Plays the low-quality stream. Some videos only have separate video/audio tracks: then a hidden <audio> follows the <video>.
function createYtPlayer(wrap, st, big) {
    const pl = { video: null, audio: null, loading: false };
    const msg = (t) => {
        let el = wrap.querySelector('.ytmsg');
        if (!t) { if (el) el.remove(); return; }
        if (!el) { el = document.createElement('div'); el.className = 'ytmsg'; wrap.appendChild(el); }
        el.textContent = t;
    };
    pl.urls = null;
    pl.epoch = 0; // bumped by stop/release: a start() that is still loading then drops out instead of playing
    pl.fps = 30;
    pl.resumeAt = 0;
    pl.released = false;
    let idleTimer = null;
    pl.time = () => (pl.video ? (pl.released ? pl.resumeAt : pl.video.currentTime) : 0);
    pl.seek = (t) => { if (pl.video && !pl.released) pl.video.currentTime = t; else pl.resumeAt = t; };
    pl.stop = () => { pl.epoch++; if (pl.video) pl.video.pause(); if (pl.audio) pl.audio.pause(); };
    // Scrubbing: always the latest requested time, one seek in flight at a time, so frames keep up with the pointer.
    pl.target = null;
    pl.seeking = false;
    let seekGuard = null;
    pl.pump = () => {
        const v = pl.video;
        if (!v || pl.target == null) return;
        const t = pl.target; pl.target = null;
        if (Math.abs(v.currentTime - t) < 0.001) return; // same spot: no 'seeked' would follow
        pl.seeking = true;
        clearTimeout(seekGuard); seekGuard = setTimeout(() => { pl.seeking = false; pl.pump(); }, 1500);
        v.currentTime = t;
    };
    pl.scrubTo = (t) => {
        pl.target = t;
        if (!pl.video || pl.released) { if (!pl.loading) pl.start(t, true); return; } // not loaded yet: load it paused at that frame
        pl.video.pause();
        if (!pl.seeking) pl.pump();
    };
    pl.toggle = () => {
        if (!pl.video || pl.released) return pl.start();
        if (pl.video.paused) pl.video.play().catch(() => {}); else pl.video.pause();
    };
    // Pauses and moves n frames (negative = back). Lands in the middle of the target frame so the seek is stable.
    pl.step = (n) => {
        const v = pl.video;
        if (!v || pl.released || !v.duration) return;
        v.pause();
        const frame = Math.floor(v.currentTime * pl.fps + 1e-6) + n;
        v.currentTime = Math.min(v.duration, Math.max(0, (frame + 0.5) / pl.fps));
    };
    // Closes the network connections (stops buffering) but remembers where we were; start() picks it back up.
    pl.release = () => {
        clearTimeout(idleTimer);
        pl.epoch++;
        if (!pl.loading && (!pl.video || pl.released)) return;
        if (!pl.video || pl.released) { msg(''); return; } // still resolving the URL: pl.epoch makes start() bail out
        pl.resumeAt = pl.video.currentTime;
        pl.video.pause();
        pl.video.removeAttribute('src'); pl.video.load();
        if (pl.audio) { pl.audio.pause(); pl.audio.removeAttribute('src'); pl.audio.load(); }
        pl.released = true;
        pl.video.hidden = true;
        wrap.querySelector('img').hidden = false;
        wrap.querySelector('.ytplay').hidden = false;
    };
    pl.start = async (at, paused) => {
        clearTimeout(idleTimer);
        if (pl.video && pl.released) {
            pl.released = false;
            if (at != null) pl.resumeAt = at;
            if (pl.urlsAudio !== (!big && ytPrevAudio)) { // audio setting changed since it loaded: rebuild the player
                pl.video.remove(); pl.video = null; pl.audio = null; pl.released = false; pl.urls = null;
                return pl.start(at != null ? at : pl.resumeAt, paused);
            }
            pl.video.src = pl.urls.video;
            if (pl.audio) pl.audio.src = pl.urls.audio;
            pl.video.hidden = false;
            wrap.querySelector('img').hidden = true;
            wrap.querySelector('.ytplay').hidden = true;
            pl.video.addEventListener('loadedmetadata', () => { pl.video.currentTime = pl.resumeAt; if (!paused) pl.video.play().catch(() => {}); }, { once: true });
            return;
        }
        if (pl.video) { if (at != null) pl.video.currentTime = at; if (!paused) pl.video.play().catch(() => {}); return; }
        if (pl.loading) return;
        pl.loading = true; msg('Cargando...');
        const epoch = ++pl.epoch;
        try {
            const urls = await ytStreamUrls(st.id, big);
            if (epoch !== pl.epoch) { pl.loading = false; msg(''); return; } // the user moved on while it was loading
            pl.urls = urls;
            pl.urlsAudio = !big && ytPrevAudio;
            pl.fps = urls.fps || 30;
            const v = document.createElement('video');
            v.controls = true; v.preload = 'auto'; v.playsInline = true;
            v.src = urls.video;
            if (urls.audio) {
                const a = new Audio(urls.audio);
                v.muted = true;
                const sync = () => { if (Math.abs(a.currentTime - v.currentTime) > 0.3) a.currentTime = v.currentTime; };
                v.addEventListener('play', () => { a.currentTime = v.currentTime; a.play().catch(() => {}); });
                v.addEventListener('playing', () => { sync(); a.play().catch(() => {}); });
                v.addEventListener('pause', () => a.pause());
                v.addEventListener('waiting', () => a.pause());
                v.addEventListener('seeked', () => { a.currentTime = v.currentTime; });
                v.addEventListener('ratechange', () => { a.playbackRate = v.playbackRate; });
                v.addEventListener('timeupdate', sync);
                pl.audio = a;
            }
            v.addEventListener('loadedmetadata', () => { if (!st.duration && isFinite(v.duration)) { st.duration = v.duration; st.draw(); } });
            v.addEventListener('timeupdate', () => {
                // loop inside the selection while auditioning it
                if (hasSel(st) && !v.paused && v.currentTime >= st.end && v.currentTime < st.end + 0.7) v.currentTime = st.start;
                st.tick(v.currentTime);
            });
            v.addEventListener('seeked', () => { clearTimeout(seekGuard); pl.seeking = false; if (pl.target != null) pl.pump(); });
            v.addEventListener('error', () => { if (!pl.released) msg('No se pudo reproducir este video'); });
            // a video left paused stops downloading after a while
            v.addEventListener('pause', () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => pl.release(), 20000); });
            v.addEventListener('play', () => clearTimeout(idleTimer));
            wrap.querySelector('img').hidden = true;
            wrap.querySelector('.ytplay').hidden = true;
            const dur = wrap.querySelector('.ytdur'); if (dur) dur.hidden = true;
            wrap.appendChild(v);
            pl.video = v;
            msg('');
            const first = pl.target != null ? pl.target : at; // a scrub may have asked for a frame while it was loading
            pl.target = null;
            if (first != null) v.currentTime = first;
            if (!paused) await v.play().catch(() => {});
        } catch (e) { msg(e.message); }
        pl.loading = false;
    };
    return pl;
}

// Range bar + "Entrada / Salida" buttons. Selection lives in st (shared between the card and the popup).
function makeSelUi(st, getPlayer) {
    const root = document.createElement('div');
    root.innerHTML =
        '<div class="rng"><div class="bar"></div><div class="sel"></div><div class="h in"></div><div class="h out"></div><div class="ph"></div></div>' +
        '<div class="ytsel"><button type="button" class="bin" title="Marcar el punto de entrada en el momento actual">⟦ Entrada</button>' +
        '<button type="button" class="bout" title="Marcar el punto de salida en el momento actual">Salida ⟧</button>' +
        '<button type="button" class="bclr">Borrar</button><span class="lbl"></span></div>';
    const rng = root.querySelector('.rng'), selEl = root.querySelector('.sel'), hIn = root.querySelector('.h.in'), hOut = root.querySelector('.h.out'), ph = root.querySelector('.ph'), lbl = root.querySelector('.lbl');
    const pct = (t) => (st.duration ? Math.min(100, (t / st.duration) * 100) : 0) + '%';
    const draw = () => {
        rng.classList.toggle('off', !(st.duration > 0));
        const on = hasSel(st);
        selEl.hidden = hIn.hidden = hOut.hidden = !on;
        if (on) {
            selEl.style.left = pct(st.start); selEl.style.width = (parseFloat(pct(st.end)) - parseFloat(pct(st.start))) + '%';
            hIn.style.left = pct(st.start); hOut.style.left = pct(st.end);
        }
        lbl.textContent = on ? fmtT(st.start) + ' → ' + fmtT(st.end) + ' (' + (st.end - st.start).toFixed(1) + ' s)' : 'Sin selección';
        root.querySelector('.bclr').hidden = !on;
    };
    const timeAt = (ev) => { const r = rng.getBoundingClientRect(); return Math.min(st.duration, Math.max(0, ((ev.clientX - r.left) / r.width) * st.duration)); };
    let drag = null;   // dragging the in/out marker
    let scrub = null;  // dragging the playhead / bar: the video follows frame by frame
    rng.addEventListener('pointerdown', (ev) => {
        if (!(st.duration > 0)) return;
        ev.preventDefault();
        const h = ev.target.classList.contains('in') ? 'start' : ev.target.classList.contains('out') ? 'end' : null;
        if (h) { drag = h; rng.setPointerCapture(ev.pointerId); return; }
        const p = getPlayer(); if (!p) return;
        scrub = { resume: !!(p.video && !p.released && !p.video.paused) }; // keep playing afterwards if it was playing
        rng.setPointerCapture(ev.pointerId);
        const t = timeAt(ev);
        st.tick(t); p.scrubTo(t);
    });
    rng.addEventListener('pointermove', (ev) => {
        if (!drag && !scrub) return;
        const t = timeAt(ev);
        const p = getPlayer();
        if (drag) {
            if (drag === 'start') st.start = Math.min(t, st.end - 0.1);
            else st.end = Math.max(t, st.start + 0.1);
            st.draw();
        }
        st.tick(t);
        if (p) p.scrubTo(t);
    });
    const endDrag = () => {
        if (drag) { drag = null; st.commit(); }
        if (scrub) {
            const p = getPlayer();
            if (scrub.resume && p && p.video && p.video.paused) p.video.play().catch(() => {});
            scrub = null;
        }
    };
    rng.addEventListener('pointerup', endDrag);
    rng.addEventListener('pointercancel', endDrag);
    const mark = (which) => {
        const p = getPlayer(), t = p ? p.time() : 0;
        if (st.start == null || st.end == null) { st.start = 0; st.end = st.duration || t; }
        if (which === 'start') { st.start = t; if (st.end <= t) st.end = st.duration || t + 1; }
        else { st.end = t; if (st.start >= t) st.start = 0; }
        st.draw(); st.commit();
    };
    root.querySelector('.bin').addEventListener('click', () => mark('start'));
    root.querySelector('.bout').addEventListener('click', () => mark('end'));
    root.querySelector('.bclr').addEventListener('click', () => { st.start = st.end = null; st.draw(); st.commit(); });
    st.drawers.push(draw);
    st.tickers.push((t) => { ph.style.left = pct(t); });
    draw();
    return root;
}

// "Video completo" / "Selección": download -> then drag it to the timeline or insert at the playhead.
function makeFileRow(st, label, isSel) {
    const row = document.createElement('div');
    row.className = 'frow';
    row.innerHTML = '<span class="fl"></span><button type="button" class="dl">Descargar</button><span class="dragchip" draggable="true" title="Arrastrar a la timeline" hidden>⠿ Arrastrar</span><button type="button" class="ins primary" hidden>Insertar en playhead</button><span class="fstate"></span>';
    const fl = row.querySelector('.fl'), dl = row.querySelector('.dl'), chip = row.querySelector('.dragchip'), ins = row.querySelector('.ins'), fs = row.querySelector('.fstate');
    const setState = (m, err) => { fs.textContent = m || ''; fs.className = 'fstate' + (err ? ' err' : ''); };
    let file = null, token = 0;
    const range = () => (isSel ? (hasSel(st) ? { start: st.start, end: st.end } : null) : {});
    const opts = (r) => ({ id: st.id, title: st.title, media: ytMedia, ...r });
    const refresh = async () => {
        const my = ++token;
        const r = range();
        const suffix = ytMedia === 'audio' ? ' (audio)' : ytMedia === 'video' ? ' (sin audio)' : '';
        fl.textContent = isSel ? 'Selección' + (r ? ' ' + fmtT(st.start) + '–' + fmtT(st.end) : '') + suffix : (ytMedia === 'audio' ? 'Audio completo' : label + suffix);
        if (!r) { file = null; dl.hidden = false; dl.disabled = true; chip.hidden = ins.hidden = true; setState(''); return; }
        dl.disabled = false;
        let p = null;
        try { p = await call(window.api.ytExists(opts(r))); } catch (e) { /* not downloaded */ }
        if (my !== token) return;
        file = p;
        dl.hidden = !!p; chip.hidden = !p; ins.hidden = !p || ABLETON;
        if (p) setState('');
    };
    let curJob = null;
    dl.addEventListener('click', async () => {
        if (curJob) { dl.disabled = true; setState('Cancelando...'); window.api.ytCancel(curJob); return; } // second click = cancel
        const r = range(); if (!r) return;
        const job = curJob = 'j' + Date.now() + Math.random().toString(36).slice(2, 6);
        let info = '';
        ytJobs.set(job, (p) => {
            if (p.phase === 'done') info = p.info;
            else setState((p.phase === 'convert' ? 'Convirtiendo a H.264 ' : 'Descargando ') + Math.round(p.pct) + '%');
        });
        dl.textContent = 'Cancelar'; setState('Descargando...');
        let cancelled = false;
        try { await call(window.api.ytDownload({ ...opts(r), job })); setState(info ? 'Listo · ' + info : 'Listo'); }
        catch (e) { cancelled = e.message === 'Cancelado'; setState(cancelled ? 'Cancelado' : e.message, !cancelled); }
        ytJobs.delete(job);
        curJob = null;
        dl.textContent = 'Descargar'; dl.disabled = false;
        refresh();
    });
    chip.addEventListener('dragstart', (ev) => { ev.preventDefault(); if (file) window.api.startDrag(file); });
    ins.addEventListener('click', async () => {
        ins.disabled = true; setState('Insertando...');
        try {
            const audio = ytMedia === 'audio';
            const r = await call(window.api.insert({ kind: 'yt', file, audio, videoOnly: ytMedia === 'video' }, audio ? $('trackA').value : $('trackV').value));
            setState('Insertado en ' + (audio ? 'A' : 'V') + r.track + ' @ ' + r.tc);
        }
        catch (e) { setState(e.message, true); }
        ins.disabled = false;
    });
    st.committers.push(refresh);
    refresh();
    return row;
}

function openYtModal(st, startAt) {
    if (ytModalClose) ytModalClose();
    if (ytActive) ytActive.stop();
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = '<div class="dialog wide"><div class="dlgtop"><h3></h3><button type="button" class="close">Cerrar</button></div><div class="ytwrap"><img alt=""><button type="button" class="ytplay">▶</button></div><div class="body"></div></div>';
    modal.querySelector('h3').textContent = st.title;
    modal.querySelector('img').src = st.thumb;
    const wrap = modal.querySelector('.ytwrap');
    const player = createYtPlayer(wrap, st, true);
    ytModalPlayer = player;
    wrap.querySelector('.ytplay').addEventListener('click', () => player.start());
    const mark = { d: st.drawers.length, t: st.tickers.length, c: st.committers.length };
    const body = modal.querySelector('.body');
    body.appendChild(makeSelUi(st, () => player));
    body.appendChild(makeFileRow(st, 'Video completo', false));
    body.appendChild(makeFileRow(st, '', true));
    const close = () => {
        player.release();
        player.stop();
        modal.remove();
        st.drawers.splice(mark.d); st.tickers.splice(mark.t); st.committers.splice(mark.c); // drop this popup's listeners
        ytModalClose = null; ytModalPlayer = null;
        st.draw(); st.commit();
    };
    modal.querySelector('.close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    ytModalClose = close;
    document.body.appendChild(modal);
    player.start(startAt || 0);
}

// Space = play/pause, ←/→ = one frame back/forward (Shift = 10 frames). Acts on the popup if open, else on the last video played.
document.addEventListener('keydown', (e) => {
    if (mode !== 'yt' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!['Space', 'ArrowLeft', 'ArrowRight'].includes(e.code)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!$('cfgModal').hidden) return;
    const p = ytModalPlayer || (ytActive && ytActive.player);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation(); // the native controls would toggle too
    if (e.code === 'Space') { if (!e.repeat) p.toggle(); }
    else p.step((e.code === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
}, true);

function renderYtCard(v) {
    const st = {
        id: v.id, title: v.title, thumb: v.thumb, duration: v.duration, start: null, end: null,
        drawers: [], tickers: [], committers: [],
        draw() { this.drawers.forEach((f) => f()); },
        tick(t) { this.tickers.forEach((f) => f(t)); },
        commit() { this.committers.forEach((f) => f()); }
    };
    ytStates.add(st);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
        '<div class="top"><span class="name"></span></div>' +
        '<div class="meta"></div>' +
        '<div class="ytwrap"><img alt="" loading="lazy"><button type="button" class="ytplay" title="Reproducir (baja calidad)">▶</button><span class="ytdur"></span></div>' +
        '<div class="sel"></div>' +
        '<div class="actions"><button type="button" class="big">⤢ Ampliar</button></div>' +
        '<div class="files"></div>';
    card.querySelector('.name').textContent = v.title;
    card.querySelector('.name').title = v.title;
    const meta = card.querySelector('.meta');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'YouTube';
    meta.appendChild(badge);
    if (v.res || v.tag) {
        const q = document.createElement('span');
        q.className = 'badge local';
        q.textContent = v.tag || qualityLabel(v.res);
        q.title = 'Calidad máxima disponible';
        meta.appendChild(q);
    }
    meta.appendChild(document.createTextNode(v.channel + (v.views ? ' · ' + Intl.NumberFormat('es').format(v.views) + ' vistas' : '')));
    card.querySelector('img').src = v.thumb;
    const dur = card.querySelector('.ytdur');
    if (v.duration) dur.textContent = fmtClock(v.duration); else dur.hidden = true;
    const wrap = card.querySelector('.ytwrap');
    const player = createYtPlayer(wrap, st, false);
    // starting another video closes this one's connection completely
    const stopper = { stop: () => player.release(), player };
    let hoverTimer = null;
    wrap.addEventListener('mouseenter', () => {
        hoverTimer = setTimeout(() => {
            if (ytPrefetching) return; // sweeping over many cards: one warm-up at a time so it never competes with a video you actually play
            ytPrefetching++;
            ytStreamUrls(st.id, false).catch(() => {}).finally(() => { ytPrefetching--; });
        }, 200);
    });
    wrap.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
    card.querySelector('.ytplay').addEventListener('click', () => {
        if (ytActive && ytActive !== stopper) ytActive.stop();
        ytActive = stopper;
        player.start();
    });
    wrap.addEventListener('play', () => { if (ytActive && ytActive !== stopper) ytActive.stop(); ytActive = stopper; }, true);
    card.querySelector('.sel').appendChild(makeSelUi(st, () => player));
    card.querySelector('.big').addEventListener('click', () => openYtModal(st, player.time()));
    const files = card.querySelector('.files');
    files.appendChild(makeFileRow(st, 'Video completo', false));
    files.appendChild(makeFileRow(st, '', true));
    return card;
}

function stopPlayback() { audio.pause(); setPlaying(null); if (ytActive) ytActive.stop(); }

function setPlaying(card) {
    if (current && current.card) current.card.querySelector('.play').textContent = '▶ Preview';
    current = card ? { card } : null;
    if (card) card.querySelector('.play').textContent = '■ Stop';
    else { document.querySelectorAll('.head').forEach((h) => (h.style.left = '0')); }
}

function togglePlay(card, seekRatio) {
    const s = card._sound;
    const sameCard = current && current.card === card;
    if (sameCard && seekRatio === undefined) { audio.pause(); setPlaying(null); return; }
    if (!sameCard) {
        audio.src = s.local ? fileUrl(s.path) : (s.previews['preview-hq-mp3'] || s.previews['preview-lq-mp3']);
        setPlaying(card);
    }
    const start = () => {
        if (seekRatio !== undefined && audio.duration) audio.currentTime = seekRatio * audio.duration;
        audio.play().catch((e) => setStatus(e.message));
    };
    if (audio.readyState >= 1) start(); else audio.addEventListener('loadedmetadata', start, { once: true });
}

function updateHead() {
    if (!current || !audio.duration) return;
    current.card.querySelector('.head').style.left = (audio.currentTime / audio.duration) * 100 + '%';
}

// ---------- configuración (claves de API) ----------
function setCfgState(msg, err) { $('cfgState').textContent = msg || ''; $('cfgState').className = err ? 'err' : ''; }

async function openConfig() {
    setCfgState('');
    try {
        const c = await call(window.api.configGet());
        $('cfgPath').textContent = c.path;
        document.querySelectorAll('#cfgForm [data-secret]').forEach((el) => {
            el.value = '';
            el.placeholder = c.secrets[el.dataset.secret] ? 'Guardada: ' + c.secrets[el.dataset.secret] : 'Sin configurar';
        });
        document.querySelectorAll('#cfgForm [data-path]').forEach((el) => { el.value = c.paths[el.dataset.path] || ''; });
        $('cfgYtQuality').value = c.youtube.quality;
        $('cfgYtConvert').checked = c.youtube.convert;
        $('cfgModal').hidden = false;
    } catch (e) { setStatus(e.message); }
}
function closeConfig() { $('cfgModal').hidden = true; }

$('cfgOpen').addEventListener('click', openConfig);
$('cfgCancel').addEventListener('click', closeConfig);
$('cfgModal').addEventListener('click', (e) => { if (e.target === $('cfgModal')) closeConfig(); });
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ytModalClose) ytModalClose();
    else if (!$('cfgModal').hidden) closeConfig();
});
$('cfgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    document.querySelectorAll('#cfgForm [data-secret]').forEach((el) => { values[el.dataset.secret] = el.value; });
    document.querySelectorAll('#cfgForm [data-path]').forEach((el) => { values[el.dataset.path] = el.value; });
    values.youtubeQuality = $('cfgYtQuality').value;
    values.youtubeConvert = $('cfgYtConvert').checked;
    $('cfgSave').disabled = true; setCfgState('Guardando...');
    try {
        await call(window.api.configSet(values));
        voicesLoaded = false; modelsLoaded = false;
        await refreshStatus();
        closeConfig();
        setStatus('Configuración guardada');
        runSearch(false);
    } catch (err) { setCfgState(err.message, true); }
    $('cfgSave').disabled = false;
});

window.addEventListener('beforeunload', () => window.api.cleanup());
refreshStatus().then((st) => { if (st.configured) runSearch(false); });

// ---------- updates ----------
// Checks on open and every hour. One button: the standalone app restarts by itself;
// the Resolve panel needs Resolve to be restarted.
async function checkForUpdate() {
    try {
        const u = await call(window.api.checkUpdate());
        if (!u.available) return;
        clearInterval(updateTimer);
        $('updateMsg').textContent = `Nueva versión disponible (${u.current} → ${u.latest})`;
        $('updateBar').hidden = false;
        $('updateBtn').onclick = async () => {
            $('updateBtn').disabled = true;
            $('updateMsg').textContent = 'Actualizando...';
            try {
                await call(window.api.applyUpdate());
                $('updateBtn').hidden = true;
                if (u.canRestart) {
                    $('updateMsg').textContent = 'Listo. Reiniciando...';
                    await call(window.api.restartApp());
                } else {
                    $('updateMsg').textContent = 'Listo. Cerrá este panel y reiniciá DaVinci Resolve (Cmd+Q y abrirlo de nuevo).';
                }
            } catch (e) {
                $('updateMsg').textContent = 'Error: ' + e.message;
                $('updateBtn').disabled = false;
            }
        };
    } catch (e) { /* sin internet o repo no disponible: silencioso */ }
}
const updateTimer = setInterval(checkForUpdate, 60 * 60 * 1000);
checkForUpdate();
