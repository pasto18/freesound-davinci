const $ = (id) => document.getElementById(id);
let page = 1;
let ABLETON = false;
let mode = 'sfx'; // 'sfx' | 'gif'
const modes = {
    sfx: { remote: true, local: true, dir: '', remoteLabel: 'Freesound', placeholder: 'Buscar sonidos (ej. whoosh, rain, door)...', root: 'Local' },
    gif: { remote: true, local: true, dir: '', remoteLabel: 'Giphy', placeholder: 'Buscar GIFs (vacío = tendencias)...', root: 'Local' }
};
const M = () => modes[mode];
let current = null; // { audio, card }

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
    if (!st.configured) {
        banner.hidden = false;
        banner.innerHTML = 'Falta configurar. Creá <code>' + st.configPath + '</code> con clientId, clientSecret y downloadDir (ver config.example.json).';
    } else {
        banner.hidden = true;
    }
    if (st.configured && !st.hasGiphy && !st.ableton) {
        banner.hidden = false;
        banner.innerHTML = 'Para GIFs agregá <code>giphyApiKey</code> a <code>' + st.configPath + '</code> (clave gratis en developers.giphy.com).';
    }
    if (st.ableton && !ABLETON) {
        ABLETON = true;
        document.querySelector('.tabs').hidden = true;
        $('lblTrackA').hidden = true;
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

function applyMode() {
    const cfg = M();
    $('tabSfx').classList.toggle('on', mode === 'sfx');
    $('tabGif').classList.toggle('on', mode === 'gif');
    $('srcRemote').textContent = cfg.remoteLabel;
    $('srcRemote').classList.toggle('on', cfg.remote);
    $('srcLocal').classList.toggle('on', cfg.local);
    $('query').placeholder = cfg.placeholder;
    $('sfxFilters').hidden = mode !== 'sfx';
    $('lblTrackA').hidden = mode !== 'sfx' || ABLETON;
    $('lblTrackV').hidden = mode !== 'gif';
    $('giphyCredit').hidden = !(mode === 'gif' && cfg.remote);
    $('results').classList.toggle('grid', mode === 'gif');
    stopPlayback();
    runSearch(false);
}
function setMode(next) {
    if (next === mode) return;
    mode = next;
    applyMode();
}
$('tabSfx').addEventListener('click', () => setMode('sfx'));
$('tabGif').addEventListener('click', () => setMode('gif'));

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
    if (!append) { page = 1; $('results').innerHTML = ''; $('more').hidden = true; }
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
                data.sounds.forEach((s) => $('results').appendChild(s.kind === 'gif' ? renderGifCard(s) : renderCard(s)));
                parts.push(data.total + ' locales' + (data.total > data.sounds.length ? ' (mostrando ' + data.sounds.length + ')' : ''));
            } catch (e) { errors.push('Local: ' + e.message); }
        }
        if (M().remote) {
            try {
                const data = kind === 'gif'
                    ? await call(window.api.giphySearch({ query, page }))
                    : await call(window.api.search({
                        query,
                        maxDuration: $('maxDuration').value,
                        license: $('license').value,
                        sort: $('sort').value,
                        page
                    }));
                if (token !== searchToken || kind !== mode) return;
                data.results.forEach((s) => $('results').appendChild(kind === 'gif' ? renderGifCard(s) : renderCard(s)));
                $('more').hidden = !data.next;
                parts.push(data.count + ' en ' + M().remoteLabel);
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
    waveEl.addEventListener('dragstart', (ev) => {
        ev.preventDefault();
        if (file) window.api.startDrag(file);
        else ensureFile();
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
            const r = await call(window.api.insert(s, $('trackA').value));
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
    card.querySelector('.ins').addEventListener('click', async (ev) => {
        const b = ev.currentTarget; b.disabled = true; setState('Insertando...');
        try {
            const r = await call(window.api.insert(g, $('trackV').value));
            setState('Insertado en V' + r.track + ' @ ' + r.tc);
        } catch (e) { setState(e.message, true); }
        b.disabled = false;
    });
    return card;
}

function stopPlayback() { audio.pause(); setPlaying(null); }

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

window.addEventListener('beforeunload', () => window.api.cleanup());
refreshStatus().then((st) => { if (st.configured) runSearch(false); });

// ---------- updates ----------
(async function checkForUpdate() {
    try {
        const u = await call(window.api.checkUpdate());
        if (!u.available) return;
        $('updateMsg').textContent = `Nueva versión disponible (${u.current} → ${u.latest})`;
        $('updateBar').hidden = false;
        $('updateBtn').addEventListener('click', async () => {
            $('updateBtn').disabled = true;
            $('updateMsg').textContent = 'Actualizando...';
            try {
                await call(window.api.applyUpdate());
                $('updateMsg').textContent = 'Listo. Cerrá este panel y reiniciá DaVinci Resolve (Cmd+Q y abrirlo de nuevo).';
                $('updateBtn').hidden = true;
            } catch (e) {
                $('updateMsg').textContent = 'Error: ' + e.message;
                $('updateBtn').disabled = false;
            }
        });
    } catch (e) { /* sin internet o repo no disponible: silencioso */ }
})();
