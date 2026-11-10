// ZOECONNET Signage - servidor sin dependencias (solo Node.js 18+)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- Base de datos (archivo JSON) ----------
let db = { content: [], screens: [], groups: [], devices: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
  catch (e) { console.error('No se pudo leer db.json:', e.message); }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
}
const id = () => crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();

function pairCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (db.devices.some(d => d.code === c));
  return c;
}

const DEFAULT_HOURS = { mode: 'always', days: [0, 1, 2, 3, 4, 5, 6].map(d => ({ day: d, on: true, open: '08:00', close: '22:00' })) };

// ---------- Utilidades HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.json': 'application/json', '.ico': 'image/x-icon',
};
function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, Object.assign({ 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
}
function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'No encontrado');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (m && !m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
}
function safeJoin(base, p) {
  const full = path.normalize(path.join(base, p));
  return full.startsWith(base) ? full : null;
}
function authorized(req) {
  if (!ADMIN_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Lógica de reproducción ----------
function isOnline(screen) {
  return screen.lastSeen && (Date.now() - new Date(screen.lastSeen).getTime()) < 90 * 1000;
}
function resolvePlaylist(screen) {
  const group = screen.groupId ? db.groups.find(g => g.id === screen.groupId) : null;
  const list = group ? group.playlist : screen.playlist;
  return (list || []).map(entry => {
    const c = db.content.find(x => x.id === entry.contentId);
    if (!c) return null;
    return {
      id: c.id, type: c.type, name: c.name, url: c.type === 'web' ? c.url : `/media/${c.file}`,
      duration: Number(entry.duration) || c.duration || 10, startAt: c.startAt || null, endAt: c.endAt || null,
      orientation: c.orientation, recur: entry.recur && entry.recur.enabled ? entry.recur : null,
    };
  }).filter(Boolean);
}
const DEFAULT_TRANSITION = { type: 'fade', speed: 800, web: true };
function resolveTransition(screen) {
  const group = screen.groupId ? db.groups.find(g => g.id === screen.groupId) : null;
  return (group ? group.transition : screen.transition) || DEFAULT_TRANSITION;
}
function screenView(s) {
  const group = s.groupId ? db.groups.find(g => g.id === s.groupId) : null;
  return Object.assign({}, s, { online: isOnline(s), groupName: group ? group.name : null });
}

// ---------- Rutas ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // ---- Rutas del reproductor (sin contraseña) ----
  if (parts[1] === 'player') {
    if (method === 'POST' && parts[2] === 'register') {
      const dev = { id: id() + id(), code: pairCode(), createdAt: now(), screenId: null };
      db.devices.push(dev); save();
      return send(res, 200, { deviceId: dev.id, code: dev.code });
    }
    if (method === 'GET' && parts[2]) {
      const dev = db.devices.find(d => d.id === parts[2]);
      if (!dev) return send(res, 404, { error: 'Dispositivo desconocido' });
      const screen = dev.screenId && db.screens.find(s => s.id === dev.screenId);
      if (!screen) return send(res, 200, { paired: false, code: dev.code });
      screen.lastSeen = now();
      screen.resolution = url.searchParams.get('res') || screen.resolution;
      save();
      return send(res, 200, {
        paired: true, screen: { id: screen.id, name: screen.name, orientation: screen.orientation, hours: screen.hours || DEFAULT_HOURS, transition: resolveTransition(screen) },
        playlist: resolvePlaylist(screen), serverTime: now(),
      });
    }
    return send(res, 404, { error: 'Ruta no encontrada' });
  }

  if (!authorized(req)) return send(res, 401, { error: 'No autorizado' }, { 'WWW-Authenticate': 'Basic realm="ZOECONNET"' });

  // ---- Estado completo ----
  if (method === 'GET' && parts[1] === 'state') {
    return send(res, 200, { content: db.content, screens: db.screens.map(screenView), groups: db.groups });
  }

  // ---- Contenido ----
  if (parts[1] === 'upload' && method === 'POST') {
    const name = decodeURIComponent(req.headers['x-filename'] || 'archivo');
    const ext = path.extname(name).toLowerCase();
    const type = (req.headers['content-type'] || '').startsWith('video/') ? 'video' : 'image';
    if (!MIME[ext] || !/^(image|video)\//.test(MIME[ext])) return send(res, 400, { error: 'Formato no soportado. Usa JPG, PNG, GIF, WEBP, MP4, WEBM o MOV.' });
    const fileName = id() + ext;
    const dest = path.join(MEDIA_DIR, fileName);
    let size = 0, failed = false;
    const out = fs.createWriteStream(dest);
    req.on('data', c => { size += c.length; if (size > MAX_UPLOAD && !failed) { failed = true; req.destroy(); out.destroy(); fs.unlink(dest, () => {}); send(res, 413, { error: 'Archivo demasiado grande (máx. 1 GB)' }); } });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      const item = {
        id: id(), type, name: path.basename(name, ext), description: '', tags: [], file: fileName, size,
        orientation: req.headers['x-orientation'] === 'portrait' ? 'portrait' : 'landscape',
        duration: Math.max(1, Math.round(Number(req.headers['x-duration']) || (type === 'video' ? 15 : 10))),
        startAt: null, endAt: null, createdAt: now(),
      };
      db.content.unshift(item); save();
      send(res, 200, item);
    });
    out.on('error', e => { if (!failed) send(res, 500, { error: e.message }); });
    return;
  }
  if (parts[1] === 'websites' && method === 'POST') {
    const b = await readJSON(req);
    if (!/^https?:\/\//i.test(b.url || '')) return send(res, 400, { error: 'La URL debe empezar por http:// o https://' });
    const item = { id: id(), type: 'web', name: b.name || b.url, description: '', tags: [], url: b.url, orientation: 'landscape', duration: Number(b.duration) || 30, startAt: null, endAt: null, createdAt: now() };
    db.content.unshift(item); save();
    return send(res, 200, item);
  }
  if (parts[1] === 'content' && parts[2]) {
    const item = db.content.find(c => c.id === parts[2]);
    if (!item) return send(res, 404, { error: 'Contenido no encontrado' });
    if (method === 'PATCH') {
      const b = await readJSON(req);
      for (const k of ['name', 'description', 'tags', 'startAt', 'endAt', 'duration', 'orientation', 'url']) if (k in b) item[k] = b[k];
      save(); return send(res, 200, item);
    }
    if (method === 'DELETE') {
      db.content = db.content.filter(c => c.id !== item.id);
      for (const o of [...db.screens, ...db.groups]) o.playlist = (o.playlist || []).filter(e => e.contentId !== item.id);
      if (item.file) fs.unlink(path.join(MEDIA_DIR, item.file), () => {});
      save(); return send(res, 200, { ok: true });
    }
  }

  // ---- Pantallas ----
  if (parts[1] === 'screens') {
    if (method === 'POST' && parts[2] === 'pair') {
      const b = await readJSON(req);
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const dev = db.devices.find(d => d.code === code);
      if (!dev) return send(res, 404, { error: 'Código no válido. Revisa el código que aparece en la pantalla.' });
      if (dev.screenId) return send(res, 409, { error: 'Esta pantalla ya está vinculada.' });
      const screen = { id: id(), name: b.name || 'Nueva pantalla', description: '', orientation: 'landscape', hours: DEFAULT_HOURS, transition: DEFAULT_TRANSITION, playlist: [], groupId: null, deviceId: dev.id, createdAt: now(), lastSeen: null };
      dev.screenId = screen.id;
      db.screens.push(screen); save();
      return send(res, 200, screenView(screen));
    }
    const screen = parts[2] && db.screens.find(s => s.id === parts[2]);
    if (!screen) return send(res, 404, { error: 'Pantalla no encontrada' });
    if (method === 'PATCH') {
      const b = await readJSON(req);
      for (const k of ['name', 'description', 'orientation', 'hours', 'playlist', 'groupId', 'transition']) if (k in b) screen[k] = b[k];
      save(); return send(res, 200, screenView(screen));
    }
    if (method === 'DELETE') {
      db.screens = db.screens.filter(s => s.id !== screen.id);
      db.devices = db.devices.filter(d => d.id !== screen.deviceId);
      save(); return send(res, 200, { ok: true });
    }
  }

  // ---- Grupos ----
  if (parts[1] === 'groups') {
    if (method === 'POST' && !parts[2]) {
      const b = await readJSON(req);
      const g = { id: id(), name: b.name || 'Nuevo grupo', description: '', playlist: [], transition: DEFAULT_TRANSITION, createdAt: now() };
      db.groups.push(g); save();
      return send(res, 200, g);
    }
    const g = parts[2] && db.groups.find(x => x.id === parts[2]);
    if (!g) return send(res, 404, { error: 'Grupo no encontrado' });
    if (method === 'PATCH') {
      const b = await readJSON(req);
      for (const k of ['name', 'description', 'playlist', 'transition']) if (k in b) g[k] = b[k];
      if (Array.isArray(b.screenIds)) for (const s of db.screens) {
        if (b.screenIds.includes(s.id)) s.groupId = g.id; else if (s.groupId === g.id) s.groupId = null;
      }
      save(); return send(res, 200, g);
    }
    if (method === 'DELETE') {
      db.groups = db.groups.filter(x => x.id !== g.id);
      for (const s of db.screens) if (s.groupId === g.id) s.groupId = null;
      save(); return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'Ruta no encontrada' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (p.startsWith('/media/')) {
      const f = safeJoin(MEDIA_DIR, p.slice(7));
      return f ? serveFile(req, res, f) : send(res, 400, 'Ruta no válida');
    }
    if (p === '/player' || p === '/player/') return serveFile(req, res, path.join(PUBLIC_DIR, 'player.html'));
    if (p === '/' || p === '/index.html') {
      if (!authorized(req)) return send(res, 401, 'Se requiere contraseña', { 'WWW-Authenticate': 'Basic realm="ZOECONNET"' });
      return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
    const f = safeJoin(PUBLIC_DIR, p);
    return f ? serveFile(req, res, f) : send(res, 400, 'Ruta no válida');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`ZOECONNET Signage en http://localhost:${PORT}`);
  console.log(`Reproductor: http://localhost:${PORT}/player`);
  if (!ADMIN_PASSWORD) console.log('Aviso: sin ADMIN_PASSWORD, el panel está abierto a cualquiera en la red.');
});
