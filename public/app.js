'use strict';
// ===================== Estado y utilidades =====================
let S = { content: [], screens: [], groups: [] };
const view = document.getElementById('view');
const ui = { sort: 'recent', type: 'all', status: 'all', q: '' };
let dirty = false; // cambios sin guardar en una lista

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

async function api(path, opts = {}) {
  const o = Object.assign({ headers: {} }, opts);
  if (o.body && typeof o.body === 'object' && !(o.body instanceof Blob)) { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}
async function refresh() { S = await api('/state'); }

function toast(msg, err) {
  const t = h(`<div class="toast ${err ? 'err' : ''}">${esc(msg)}</div>`);
  document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
}
function ago(iso) {
  if (!iso) return 'nunca';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'hace unos segundos';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} días`;
}
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}
function fmtTotal(sec) {
  sec = Math.round(sec); if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60; return s ? `${m} min ${s} s` : `${m} min`;
}
const toLocalInput = iso => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fromLocalInput = v => v ? new Date(v).toISOString() : null;
const TYPE_LABEL = { image: 'Imagen', video: 'Video', web: 'Sitio web' };
const ORI_LABEL = { landscape: 'horizontal', portrait: 'vertical' };
const byId = (arr, id) => arr.find(x => x.id === id);

function thumbHTML(c, small) {
  if (c.type === 'image') return `<img src="/media/${esc(c.file)}" alt="" loading="lazy">`;
  if (c.type === 'video') return `<video src="/media/${esc(c.file)}#t=1" preload="metadata" muted playsinline></video>`;
  let host = c.url; try { host = new URL(c.url).hostname; } catch (e) {}
  return small ? `<div class="web">WEB</div>` : `<div class="web"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>${esc(host)}</div>`;
}
function statusBadge(c) {
  const st = Schedule.contentStatus(c);
  if (st === 'scheduled') return `<span class="badge status scheduled">Programado</span>`;
  if (st === 'expired') return `<span class="badge status expired">Vencido</span>`;
  return '';
}

// ===================== Diálogos =====================
function dialog({ title, body, wide, buttons }) {
  const d = h(`<dialog class="${wide ? 'wide' : ''}"><div class="dlg-head"><h3>${esc(title)}</h3><button class="btn ghost" data-close aria-label="Cerrar">✕</button></div><div class="dlg-body"></div><div class="dlg-foot"></div></dialog>`);
  const b = d.querySelector('.dlg-body');
  if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
  const foot = d.querySelector('.dlg-foot');
  (buttons || []).forEach(bt => {
    const el = h(`<button class="btn ${bt.cls || ''}">${esc(bt.label)}</button>`);
    if (bt.left) el.style.marginRight = 'auto';
    el.onclick = async () => { try { el.disabled = true; const r = await bt.onClick(d); if (r !== false) d.close(); } catch (e) { toast(e.message, true); } finally { el.disabled = false; } };
    foot.appendChild(el);
  });
  if (!foot.children.length) foot.remove();
  d.querySelector('[data-close]').onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d); d.showModal();
  return d;
}
function confirmDlg(msg, label = 'Eliminar') {
  return new Promise(res => dialog({ title: 'Confirmar', body: `<p>${esc(msg)}</p>`, buttons: [
    { label: 'Cancelar', onClick: () => res(false) }, { label, cls: 'primary', onClick: () => res(true) }] }).addEventListener('close', () => res(false)));
}

// ===================== Subida de archivos =====================
function readMeta(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const done = (w, hgt, dur) => { URL.revokeObjectURL(url); resolve({ orientation: hgt > w ? 'portrait' : 'landscape', duration: dur }); };
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => done(v.videoWidth, v.videoHeight, Math.round(v.duration) || 15);
      v.onerror = () => done(16, 9, 15); v.src = url;
    } else {
      const i = new Image(); i.onload = () => done(i.naturalWidth, i.naturalHeight, 10); i.onerror = () => done(16, 9, 10); i.src = url;
    }
  });
}
function uploadOne(file, onProgress) {
  return readMeta(file).then(meta => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload');
    x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    x.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    x.setRequestHeader('X-Orientation', meta.orientation);
    x.setRequestHeader('X-Duration', meta.duration);
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} x.status < 300 ? resolve(j) : reject(new Error(j.error || 'Error al subir')); };
    x.onerror = () => reject(new Error('Error de red al subir'));
    x.send(file);
  }));
}
async function uploadFiles(files) {
  files = [...files].filter(f => /^(image|video)\//.test(f.type));
  if (!files.length) return toast('Solo se aceptan imágenes y videos', true);
  const body = h(`<div></div>`);
  const rows = files.map(f => { const r = h(`<div style="margin-bottom:10px"><div style="font-size:14px">${esc(f.name)}</div><div class="progress"><div></div></div></div>`); body.appendChild(r); return r; });
  const d = dialog({ title: `Subiendo ${files.length} archivo(s)`, body });
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    const bar = rows[i].querySelector('.progress > div');
    try { await uploadOne(files[i], p => bar.style.width = (p * 100) + '%'); bar.style.width = '100%'; ok++; }
    catch (e) { bar.style.background = 'var(--danger)'; rows[i].insertAdjacentHTML('beforeend', `<div style="color:var(--danger);font-size:13px">${esc(e.message)}</div>`); }
  }
  await refresh();
  if (ok === files.length) d.close();
  toast(`${ok} de ${files.length} archivo(s) subidos`);
  render();
}
const fileInput = document.getElementById('fileInput');
fileInput.onchange = () => { uploadFiles(fileInput.files); fileInput.value = ''; };

// ===================== Detalle de un contenido =====================
function openMedia(c) {
  let tags = [...(c.tags || [])];
  const preview = c.type === 'image' ? `<img src="/media/${esc(c.file)}" alt="">`
    : c.type === 'video' ? `<video src="/media/${esc(c.file)}" controls muted playsinline></video>`
    : `<iframe src="${esc(c.url)}" referrerpolicy="no-referrer"></iframe>`;
  const usedIn = [...S.screens.filter(s => (s.playlist || []).some(e => e.contentId === c.id)).map(s => s.name),
                  ...S.groups.filter(g => (g.playlist || []).some(e => e.contentId === c.id)).map(g => 'Grupo ' + g.name)];
  const body = h(`<div class="media-grid">
    <div>
      <div class="preview">${preview}</div>
      <div class="sub" style="color:var(--muted);font-size:13px">${TYPE_LABEL[c.type]} · ${ORI_LABEL[c.orientation] || ''} · subido ${ago(c.createdAt)}${c.size ? ' · ' + (c.size / 1048576).toFixed(1) + ' MB' : ''}</div>
      <div style="font-size:13px;margin-top:6px;color:var(--muted)">${usedIn.length ? 'En uso en: ' + esc(usedIn.join(', ')) : 'No está en ninguna lista.'}</div>
    </div>
    <div>
      <label class="field"><span>Título</span><input type="text" name="name" value="${esc(c.name)}"></label>
      ${c.type === 'web' ? `<label class="field"><span>URL</span><input type="url" name="url" value="${esc(c.url)}"></label>` : ''}
      <label class="field"><span>Descripción</span><textarea name="description">${esc(c.description)}</textarea></label>
      <div class="field"><span>Etiquetas</span><div class="chip-input"><input type="text" placeholder="Escribe y pulsa Enter"></div></div>
      <label class="field"><span>Duración por defecto (segundos)</span><input type="number" min="1" name="duration" value="${c.duration}"></label>
      <div class="field-row">
        <label class="field"><span>Mostrar desde</span><input type="datetime-local" name="startAt" value="${toLocalInput(c.startAt)}"></label>
        <label class="field"><span>Ocultar desde (vence)</span><input type="datetime-local" name="endAt" value="${toLocalInput(c.endAt)}"></label>
      </div>
      <div class="help">Fuera de este periodo el contenido no se muestra en ninguna pantalla. Déjalo vacío para mostrarlo siempre.</div>
    </div></div>`);
  const chipBox = body.querySelector('.chip-input'), chipIn = chipBox.querySelector('input');
  const drawTags = () => { chipBox.querySelectorAll('.chip').forEach(x => x.remove()); tags.forEach((t, i) => { const ch = h(`<span class="chip">${esc(t)}<button aria-label="Quitar">✕</button></span>`); ch.querySelector('button').onclick = () => { tags.splice(i, 1); drawTags(); }; chipBox.insertBefore(ch, chipIn); }); };
  chipIn.onkeydown = e => { if ((e.key === 'Enter' || e.key === ',') && chipIn.value.trim()) { e.preventDefault(); tags.push(chipIn.value.trim()); chipIn.value = ''; drawTags(); } };
  drawTags();
  dialog({ title: 'Detalles del contenido', body, wide: true, buttons: [
    { label: 'Eliminar', cls: 'danger', left: true, onClick: async () => {
      if (!await confirmDlg(`¿Eliminar "${c.name}"? Se quitará de todas las listas.`)) return false;
      await api('/content/' + c.id, { method: 'DELETE' }); await refresh(); render(); toast('Contenido eliminado'); } },
    { label: 'Cancelar', onClick: () => {} },
    { label: 'Guardar cambios', cls: 'primary', onClick: async () => {
      const q = n => body.querySelector(`[name=${n}]`);
      if (chipIn.value.trim()) tags.push(chipIn.value.trim());
      const patch = { name: q('name').value.trim() || c.name, description: q('description').value, tags,
        duration: Math.max(1, parseInt(q('duration').value, 10) || c.duration),
        startAt: fromLocalInput(q('startAt').value), endAt: fromLocalInput(q('endAt').value) };
      if (patch.startAt && patch.endAt && patch.endAt <= patch.startAt) throw new Error('La fecha de vencimiento debe ser posterior al inicio');
      if (c.type === 'web') { if (!/^https?:\/\//i.test(q('url').value)) throw new Error('URL no válida'); patch.url = q('url').value.trim(); }
      await api('/content/' + c.id, { method: 'PATCH', body: patch }); await refresh(); render(); toast('Cambios guardados'); } },
  ] });
}

// ===================== Vista: Biblioteca de contenido =====================
function filteredContent(onlyWeb) {
  let list = S.content.filter(c => onlyWeb === undefined ? true : onlyWeb ? c.type === 'web' : c.type !== 'web');
  if (ui.type !== 'all') list = list.filter(c => c.type === ui.type);
  if (ui.status !== 'all') list = list.filter(c => Schedule.contentStatus(c) === ui.status);
  if (ui.q) { const q = ui.q.toLowerCase(); list = list.filter(c => (c.name + ' ' + (c.tags || []).join(' ') + ' ' + (c.description || '') + ' ' + (c.url || '')).toLowerCase().includes(q)); }
  const sorters = { recent: (a, b) => b.createdAt.localeCompare(a.createdAt), name: (a, b) => a.name.localeCompare(b.name, 'es'), duration: (a, b) => b.duration - a.duration };
  return list.sort(sorters[ui.sort]);
}
function contentCard(c) {
  const el = h(`<div class="card"><div class="thumb">${thumbHTML(c)}${statusBadge(c)}<span class="badge dur">${c.type === 'image' ? '🖼 ' : ''}${fmtDur(c.duration)}</span></div>
    <div class="meta"><div class="name" title="${esc(c.name)}">${esc(c.name)}</div><div class="sub">${TYPE_LABEL[c.type]} · ${ORI_LABEL[c.orientation] || ''} · ${ago(c.createdAt)}</div></div></div>`);
  el.onclick = () => openMedia(c);
  return el;
}
function renderContent() {
  view.innerHTML = '';
  const tb = h(`<div class="toolbar"><h1>Biblioteca</h1><button class="btn primary" id="up">⬆ Subir archivos</button><span class="spacer"></span>
    <select id="sort" aria-label="Ordenar"><option value="recent">Más recientes</option><option value="name">Nombre</option><option value="duration">Duración</option></select>
    <select id="type" aria-label="Tipo"><option value="all">Todos los tipos</option><option value="image">Imágenes</option><option value="video">Videos</option></select>
    <select id="status" aria-label="Estado"><option value="all">Cualquier estado</option><option value="active">Activos</option><option value="scheduled">Programados</option><option value="expired">Vencidos</option></select>
    <input type="search" id="q" placeholder="Buscar…" value="${esc(ui.q)}"></div>`);
  view.appendChild(tb);
  ['sort', 'type', 'status'].forEach(k => { const s = tb.querySelector('#' + k); s.value = ui[k]; s.onchange = () => { ui[k] = s.value; drawGrid(); }; });
  tb.querySelector('#q').oninput = e => { ui.q = e.target.value; drawGrid(); };
  tb.querySelector('#up').onclick = () => fileInput.click();
  const zone = h(`<div class="dropzone"></div>`); view.appendChild(zone);
  function drawGrid() {
    const list = filteredContent(false);
    zone.innerHTML = '';
    if (!S.content.some(c => c.type !== 'web')) { zone.appendChild(h(`<div class="empty"><b>Tu biblioteca está vacía</b>Arrastra aquí imágenes o videos, o pulsa "Subir archivos".</div>`)); return; }
    if (!list.length) { zone.appendChild(h(`<div class="empty">No hay resultados con esos filtros.</div>`)); return; }
    const g = h(`<div class="grid"></div>`); list.forEach(c => g.appendChild(contentCard(c))); zone.appendChild(g);
  }
  drawGrid();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave = () => zone.classList.remove('drag');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('drag'); uploadFiles(e.dataTransfer.files); };
}

// ===================== Vista: Sitios web =====================
function addWebsiteDlg() {
  dialog({ title: 'Añadir sitio web', body: `
    <label class="field"><span>Nombre</span><input type="text" name="name" placeholder="Menú del día"></label>
    <label class="field"><span>URL</span><input type="url" name="url" placeholder="https://…"></label>
    <label class="field"><span>Duración por defecto (segundos)</span><input type="number" name="duration" value="30" min="1"></label>
    <div class="help">Algunos sitios no permiten mostrarse dentro de otra página. Si se ve en blanco, prueba otra URL (por ejemplo, la versión para insertar o "embed").</div>`,
    buttons: [{ label: 'Cancelar', onClick: () => {} }, { label: 'Añadir', cls: 'primary', onClick: async d => {
      const q = n => d.querySelector(`[name=${n}]`).value.trim();
      await api('/websites', { method: 'POST', body: { name: q('name'), url: q('url'), duration: Number(q('duration')) } });
      await refresh(); render(); toast('Sitio web añadido'); } }] });
}
function renderWebsites() {
  view.innerHTML = '';
  const tb = h(`<div class="toolbar"><h1>Sitios web</h1><button class="btn primary">＋ Añadir sitio web</button><span class="spacer"></span><input type="search" placeholder="Buscar…" value="${esc(ui.q)}"></div>`);
  tb.querySelector('button').onclick = addWebsiteDlg;
  view.appendChild(tb);
  const zone = h(`<div></div>`); view.appendChild(zone);
  const draw = () => {
    const list = filteredContent(true); zone.innerHTML = '';
    if (!list.length) { zone.appendChild(h(`<div class="empty"><b>No hay sitios web</b>Añade páginas como menús, redes sociales, paneles o el clima para mostrarlas en tus pantallas.</div>`)); return; }
    const g = h(`<div class="grid"></div>`); list.forEach(c => g.appendChild(contentCard(c))); zone.appendChild(g);
  };
  tb.querySelector('input').oninput = e => { ui.q = e.target.value; draw(); };
  draw();
}

// ===================== Editor de lista de reproducción =====================
// owner: pantalla o grupo; save(playlist) guarda
function playlistEditor(owner, save) {
  let pl = JSON.parse(JSON.stringify(owner.playlist || []));
  dirty = false;
  const wrap = h(`<div class="columns">
    <section class="panel"><div class="panel-head"><h2>Lista de reproducción</h2><button class="btn sm" id="preview" title="Vista previa">▶ Vista previa</button><span class="spacer"></span><span class="unsaved" hidden>Cambios sin guardar</span><button class="btn primary" id="save">Guardar cambios</button></div>
      <div class="summary"></div><div class="items"></div></section>
    <section class="panel"><div class="panel-head"><h2>Añadir contenido</h2><span class="spacer"></span><input type="search" placeholder="Buscar…" style="width:160px"></div>
      <div class="subtabs"><button data-k="media" class="active">Imágenes y videos</button><button data-k="web">Sitios web</button></div>
      <div class="lib-list"></div></section></div>`);
  const itemsEl = wrap.querySelector('.items'), lib = wrap.querySelector('.lib-list');
  const unsaved = wrap.querySelector('.unsaved');
  const mark = () => { dirty = true; unsaved.hidden = false; };
  let libKind = 'media', libQ = '';

  function draw() {
    const total = pl.reduce((a, e) => a + (Number(e.duration) || 0), 0);
    wrap.querySelector('.summary').textContent = `${pl.length} elemento${pl.length === 1 ? '' : 's'} · ${fmtTotal(total)}`;
    itemsEl.innerHTML = '';
    if (!pl.length) itemsEl.appendChild(h(`<div class="empty" style="padding:30px">Añade contenido desde la columna de la derecha.</div>`));
    pl.forEach((e, i) => {
      const c = byId(S.content, e.contentId); if (!c) return;
      const st = Schedule.contentStatus(c);
      const row = h(`<div class="row" draggable="true"><span class="handle" title="Arrastra para reordenar">⋮⋮</span><div class="mini">${thumbHTML(c, true)}</div>
        <div class="info"><div class="name">${esc(c.name)}</div><div class="sub">${TYPE_LABEL[c.type]} · ${ORI_LABEL[c.orientation] || ''}${st !== 'active' ? ` · <b style="color:${st === 'expired' ? 'var(--danger)' : 'var(--ok)'}">${st === 'expired' ? 'Vencido' : 'Programado'}</b>` : ''}${e.recur && e.recur.enabled ? `<span class="recur-tag">⟳ ${esc(Schedule.describeRecur(e.recur))}</span>` : ''}</div></div>
        <label class="dur"><input type="number" min="1" value="${e.duration}"> s</label>
        <button class="btn ghost sm" data-a="recur" title="Visualización periódica">📅</button>
        <button class="btn ghost sm" data-a="del" title="Quitar">✕</button></div>`);
      row.querySelector('input').oninput = ev => { e.duration = Math.max(1, parseInt(ev.target.value, 10) || 1); mark(); wrap.querySelector('.summary').textContent = `${pl.length} elementos · ${fmtTotal(pl.reduce((a, x) => a + (Number(x.duration) || 0), 0))}`; };
      row.querySelector('[data-a=del]').onclick = () => { pl.splice(i, 1); mark(); draw(); };
      row.querySelector('[data-a=recur]').onclick = () => recurDlg(e, c, () => { mark(); draw(); });
      row.ondragstart = ev => { row.classList.add('dragging'); ev.dataTransfer.setData('text/plain', i); };
      row.ondragend = () => row.classList.remove('dragging');
      row.ondragover = ev => ev.preventDefault();
      row.ondrop = ev => { ev.preventDefault(); const from = Number(ev.dataTransfer.getData('text/plain')); if (isNaN(from) || from === i) return; const [m] = pl.splice(from, 1); pl.splice(i, 0, m); mark(); draw(); };
      itemsEl.appendChild(row);
    });
  }
  function drawLib() {
    lib.innerHTML = '';
    const list = S.content.filter(c => (libKind === 'web') === (c.type === 'web'))
      .filter(c => !libQ || (c.name + ' ' + (c.tags || []).join(' ')).toLowerCase().includes(libQ.toLowerCase()));
    if (!list.length) lib.appendChild(h(`<div class="empty" style="padding:24px">${libKind === 'web' ? 'No hay sitios web. Añádelos en la pestaña "Sitios web".' : 'No hay archivos. Súbelos en "Contenido".'}</div>`));
    list.forEach(c => {
      const st = Schedule.contentStatus(c);
      const row = h(`<div class="row"><div class="mini">${thumbHTML(c, true)}</div><div class="info"><div class="name">${esc(c.name)}</div><div class="sub">${TYPE_LABEL[c.type]} · ${fmtDur(c.duration)}${st !== 'active' ? ' · ' + (st === 'expired' ? 'Vencido' : 'Programado') : ''}</div></div><button class="btn sm">＋ Añadir</button></div>`);
      row.querySelector('button').onclick = () => { pl.push({ contentId: c.id, duration: c.duration }); mark(); draw(); itemsEl.lastElementChild?.scrollIntoView({ block: 'nearest' }); };
      lib.appendChild(row);
    });
  }
  wrap.querySelectorAll('.subtabs button').forEach(b => b.onclick = () => { wrap.querySelectorAll('.subtabs button').forEach(x => x.classList.toggle('active', x === b)); libKind = b.dataset.k; drawLib(); });
  wrap.querySelector('input[type=search]').oninput = e => { libQ = e.target.value; drawLib(); };
  wrap.querySelector('#save').onclick = async () => { try { await save(pl); dirty = false; unsaved.hidden = true; toast('Lista guardada. Las pantallas se actualizan en unos segundos.'); } catch (e) { toast(e.message, true); } };
  wrap.querySelector('#preview').onclick = () => previewDlg(pl);
  draw(); drawLib();
  return wrap;
}

function previewDlg(pl) {
  const items = pl.map(e => ({ e, c: byId(S.content, e.contentId) })).filter(x => x.c);
  if (!items.length) return toast('La lista está vacía');
  const box = h(`<div><div class="preview" style="margin:0"></div><div style="text-align:center;margin-top:8px;color:var(--muted);font-size:13px" class="cap"></div></div>`);
  const d = dialog({ title: 'Vista previa', body: box, wide: true });
  let i = 0, t;
  const step = () => {
    if (!d.open) return;
    const { e, c } = items[i % items.length];
    box.querySelector('.preview').innerHTML = c.type === 'image' ? `<img src="/media/${esc(c.file)}">` : c.type === 'video' ? `<video src="/media/${esc(c.file)}" autoplay muted loop playsinline></video>` : `<iframe src="${esc(c.url)}" referrerpolicy="no-referrer"></iframe>`;
    box.querySelector('.cap').textContent = `${i % items.length + 1} / ${items.length} · ${c.name} · ${e.duration} s`;
    i++; t = setTimeout(step, Math.min(e.duration, 8) * 1000);
  };
  d.addEventListener('close', () => clearTimeout(t));
  step();
}

// Diálogo de visualización periódica
function recurDlg(entry, c, onDone) {
  const r = Object.assign({ enabled: false, start: '', end: '', repeat: 'none', every: 1, monthlyMode: 'date' }, entry.recur || {});
  if (!r.start) { const s = new Date(); s.setMinutes(0, 0, 0); r.start = s.toISOString(); r.end = new Date(s.getTime() + 3600000).toISOString(); }
  const body = h(`<div>
    <p style="margin-top:0">Muestra <b>${esc(c.name)}</b> solo en ciertos periodos. Fuera de ellos, se salta en la lista.</p>
    <label class="switch" style="margin-bottom:14px"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Activar visualización periódica</label>
    <div class="opts">
      <div class="field-row">
        <label class="field"><span>Desde</span><input type="datetime-local" name="start" value="${toLocalInput(r.start)}"></label>
        <label class="field"><span>Hasta</span><input type="datetime-local" name="end" value="${toLocalInput(r.end)}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Repetir</span><select name="repeat"><option value="none">No repetir</option><option value="daily">Cada día</option><option value="weekly">Cada semana</option><option value="monthly">Cada mes</option></select></label>
        <label class="field every"><span>Cada cuántos</span><input type="number" name="every" min="1" value="${r.every}"></label>
      </div>
      <div class="field monthly radio-list"><span>En el mes</span>
        <label><input type="radio" name="monthlyMode" value="date"> <span class="lbl-date"></span></label>
        <label><input type="radio" name="monthlyMode" value="nth"> <span class="lbl-nth"></span></label>
      </div>
      <div class="help sumtxt"></div>
    </div></div>`);
  const q = n => body.querySelector(`[name=${n}]`);
  q('repeat').value = r.repeat;
  body.querySelector(`[name=monthlyMode][value=${r.monthlyMode}]`).checked = true;
  const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const ORD = ['', 'primer', 'segundo', 'tercer', 'cuarto', 'último'];
  function sync() {
    body.querySelector('.opts').style.opacity = q('enabled').checked ? 1 : .45;
    const rep = q('repeat').value;
    body.querySelector('.every').style.display = rep === 'none' ? 'none' : '';
    body.querySelector('.monthly').style.display = rep === 'monthly' ? '' : 'none';
    const s = q('start').value ? new Date(q('start').value) : new Date();
    const n = Math.ceil(s.getDate() / 7);
    body.querySelector('.lbl-date').textContent = `El día ${s.getDate()} de cada mes`;
    body.querySelector('.lbl-nth').textContent = `El ${ORD[n > 4 ? 5 : n]} ${DAYS[s.getDay()]} del mes`;
    const unit = { daily: 'día(s)', weekly: 'semana(s)', monthly: 'mes(es)' }[rep];
    body.querySelector('.sumtxt').textContent = rep === 'none' ? 'Se muestra una sola vez, entre esas dos fechas.' : `Se repite cada ${q('every').value || 1} ${unit}, con la misma hora y duración que el primer periodo.`;
  }
  body.addEventListener('input', sync); body.addEventListener('change', sync); sync();
  dialog({ title: 'Visualización periódica', body, buttons: [
    { label: 'Cancelar', onClick: () => {} },
    { label: 'Aplicar', cls: 'primary', onClick: () => {
      const nr = { enabled: q('enabled').checked, start: fromLocalInput(q('start').value), end: fromLocalInput(q('end').value), repeat: q('repeat').value,
        every: Math.max(1, parseInt(q('every').value, 10) || 1), monthlyMode: body.querySelector('[name=monthlyMode]:checked').value };
      if (nr.enabled && (!nr.start || !nr.end || nr.end <= nr.start)) throw new Error('El final debe ser posterior al inicio');
      entry.recur = nr; onDone(); } }] });
}

// Diálogo de transiciones (pantalla o grupo)
function transitionDlg(owner, path) {
  const t = Object.assign({ type: 'fade', speed: 800, web: true }, owner.transition || {});
  const types = [['none', 'Sin transición'], ['fade', 'Fundido'], ['slide-left', 'Deslizar desde la derecha'], ['slide-up', 'Deslizar desde abajo'], ['zoom', 'Acercar'], ['reveal-tl', 'Revelar desde la esquina superior izquierda'], ['reveal-br', 'Revelar desde la esquina inferior derecha'], ['wipe', 'Barrido'], ['random', 'Aleatoria']];
  const body = h(`<div>
    <label class="field"><span>Tipo de transición</span><select name="type">${types.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <label class="field"><span>Velocidad</span><select name="speed"><option value="400">Rápida</option><option value="800">Normal</option><option value="1500">Lenta</option></select></label>
    <label class="switch"><input type="checkbox" name="web" ${t.web ? 'checked' : ''}> Aplicar también a sitios web</label></div>`);
  body.querySelector('[name=type]').value = t.type;
  body.querySelector('[name=speed]').value = [400, 800, 1500].includes(Number(t.speed)) ? String(t.speed) : '800';
  dialog({ title: 'Transiciones', body, buttons: [{ label: 'Cancelar', onClick: () => {} }, { label: 'Guardar', cls: 'primary', onClick: async () => {
    await api(path, { method: 'PATCH', body: { transition: { type: body.querySelector('[name=type]').value, speed: Number(body.querySelector('[name=speed]').value), web: body.querySelector('[name=web]').checked } } });
    await refresh(); toast('Transiciones guardadas'); } }] });
}

// ===================== Vista: Pantallas =====================
function pairDlg() {
  dialog({ title: 'Añadir pantalla', body: `
    <ol style="margin-top:0;padding-left:20px;line-height:1.7">
      <li>En la TV o el dispositivo, abre el navegador y entra en <b>${esc(location.origin)}/player</b></li>
      <li>Aparecerá un código de 6 caracteres. Escríbelo aquí.</li></ol>
    <label class="field"><span>Código de la pantalla</span><input type="text" name="code" maxlength="8" style="font-size:22px;letter-spacing:.15em;text-transform:uppercase" placeholder="ABC123"></label>
    <label class="field"><span>Nombre</span><input type="text" name="name" placeholder="Recepción, Vitrina, Comedor…"></label>`,
    buttons: [{ label: 'Cancelar', onClick: () => {} }, { label: 'Vincular', cls: 'primary', onClick: async d => {
      const s = await api('/screens/pair', { method: 'POST', body: { code: d.querySelector('[name=code]').value, name: d.querySelector('[name=name]').value.trim() } });
      await refresh(); toast('Pantalla vinculada'); location.hash = '#/screens/' + s.id; } }] });
}
function renderScreens() {
  view.innerHTML = '';
  const tb = h(`<div class="toolbar"><h1>Pantallas</h1><button class="btn primary">＋ Añadir pantalla</button></div>`);
  tb.querySelector('button').onclick = pairDlg; view.appendChild(tb);
  if (!S.screens.length) { view.appendChild(h(`<div class="empty"><b>Aún no hay pantallas</b>Abre <code>${esc(location.origin)}/player</code> en la TV y pulsa "Añadir pantalla" para vincularla con el código que aparece.</div>`)); return; }
  const g = h(`<div class="grid"></div>`);
  S.screens.forEach(s => {
    const pl = s.groupId ? (byId(S.groups, s.groupId) || {}).playlist || [] : s.playlist || [];
    const first = pl.map(e => byId(S.content, e.contentId)).find(Boolean);
    const el = h(`<div class="card"><div class="thumb">${first ? thumbHTML(first) : '<div class="web" style="color:var(--muted)">Sin contenido</div>'}<span class="badge status" style="background:${s.online ? 'var(--ok)' : '#6b7c82'}">${s.online ? 'En línea' : 'Desconectada'}</span></div>
      <div class="meta"><div class="name">${esc(s.name)}</div><div class="sub">${s.groupName ? 'Grupo: ' + esc(s.groupName) + ' · ' : ''}${pl.length} elementos · visto ${ago(s.lastSeen)}</div></div></div>`);
    el.onclick = () => location.hash = '#/screens/' + s.id;
    g.appendChild(el);
  });
  view.appendChild(g);
}
function hoursDlg(s) {
  const hrs = JSON.parse(JSON.stringify(s.hours || { mode: 'always', days: [] }));
  const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  for (let d = 0; d < 7; d++) if (!hrs.days.find(x => x.day === d)) hrs.days.push({ day: d, on: true, open: '08:00', close: '22:00' });
  const order = [1, 2, 3, 4, 5, 6, 0];
  const body = h(`<div>
    <div class="radio-list"><label><input type="radio" name="mode" value="always"> Encendida siempre (24 h)</label><label><input type="radio" name="mode" value="custom"> Solo en este horario</label></div>
    <table class="hours-table" style="margin-top:10px">${order.map(d => { const x = hrs.days.find(y => y.day === d); return `<tr data-d="${d}"><td><label class="switch"><input type="checkbox" ${x.on ? 'checked' : ''}> ${DAYS[d]}</label></td><td><input type="time" value="${x.open}"></td><td>a</td><td><input type="time" value="${x.close}"></td></tr>`; }).join('')}</table>
    <div class="help" style="margin-top:10px">Fuera del horario la pantalla se queda en negro. Si el cierre es anterior a la apertura (por ejemplo 18:00 a 02:00), el horario cruza la medianoche.</div></div>`);
  body.querySelector(`[name=mode][value=${hrs.mode}]`).checked = true;
  const sync = () => body.querySelector('table').style.opacity = body.querySelector('[name=mode]:checked').value === 'custom' ? 1 : .45;
  body.addEventListener('change', sync); sync();
  dialog({ title: 'Horario de funcionamiento', body, buttons: [{ label: 'Cancelar', onClick: () => {} }, { label: 'Guardar', cls: 'primary', onClick: async () => {
    const out = { mode: body.querySelector('[name=mode]:checked').value, days: [...body.querySelectorAll('tr')].map(tr => { const ins = tr.querySelectorAll('input'); return { day: Number(tr.dataset.d), on: ins[0].checked, open: ins[1].value || '00:00', close: ins[2].value || '23:59' }; }) };
    await api('/screens/' + s.id, { method: 'PATCH', body: { hours: out } }); await refresh(); render(); toast('Horario guardado'); } }] });
}
function screenSettingsDlg(s) {
  const body = h(`<div>
    <label class="field"><span>Nombre</span><input type="text" name="name" value="${esc(s.name)}"></label>
    <label class="field"><span>Descripción</span><textarea name="description">${esc(s.description)}</textarea></label>
    <label class="field"><span>Orientación</span><select name="orientation"><option value="landscape">Horizontal</option><option value="portrait">Vertical (gira el contenido 90°)</option></select></label>
    <label class="field"><span>Grupo</span><select name="groupId"><option value="">Sin grupo (lista propia)</option>${S.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
    <div class="help">Si la pantalla está en un grupo, muestra la lista y las transiciones del grupo.</div></div>`);
  body.querySelector('[name=orientation]').value = s.orientation;
  body.querySelector('[name=groupId]').value = s.groupId || '';
  dialog({ title: 'Ajustes de la pantalla', body, buttons: [
    { label: 'Desvincular pantalla', cls: 'danger', left: true, onClick: async () => {
      if (!await confirmDlg(`¿Desvincular "${s.name}"? El dispositivo volverá a mostrar un código nuevo.`, 'Desvincular')) return false;
      await api('/screens/' + s.id, { method: 'DELETE' }); await refresh(); location.hash = '#/screens'; } },
    { label: 'Cancelar', onClick: () => {} },
    { label: 'Guardar', cls: 'primary', onClick: async () => {
      const q = n => body.querySelector(`[name=${n}]`).value;
      await api('/screens/' + s.id, { method: 'PATCH', body: { name: q('name').trim() || s.name, description: q('description'), orientation: q('orientation'), groupId: q('groupId') || null } });
      await refresh(); render(); toast('Ajustes guardados'); } }] });
}
function renderScreen(id) {
  const s = byId(S.screens, id);
  if (!s) { view.innerHTML = '<div class="empty"><b>Pantalla no encontrada</b><a href="#/screens">Volver a pantallas</a></div>'; return; }
  view.innerHTML = '';
  const hoursTxt = !s.hours || s.hours.mode !== 'custom' ? '24 h' : 'Horario personalizado';
  const hero = h(`<div class="hero">
    <div><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><a href="#/screens" class="btn ghost sm">← Pantallas</a><h1>${esc(s.name)}</h1><span class="pill ${s.online ? 'on' : ''}"><span class="dot ${s.online ? 'on' : ''}"></span>${s.online ? 'En línea' : 'Desconectada'}</span></div>
      <div class="desc">${esc(s.description || 'Sin descripción')}</div>
      <div style="font-size:13px;color:var(--muted)">Visto por última vez ${ago(s.lastSeen)}${s.resolution ? ' · ' + esc(s.resolution) : ''} · ${s.orientation === 'portrait' ? 'Vertical' : 'Horizontal'} · ${hoursTxt}</div></div>
    <div class="actions"><button class="btn" data-a="settings">⚙ Ajustes</button><button class="btn" data-a="hours">🕒 Horario</button>${s.groupId ? '' : '<button class="btn" data-a="tr">✨ Transiciones</button>'}</div></div>`);
  hero.querySelector('[data-a=settings]').onclick = () => screenSettingsDlg(s);
  hero.querySelector('[data-a=hours]').onclick = () => hoursDlg(s);
  const trb = hero.querySelector('[data-a=tr]'); if (trb) trb.onclick = () => transitionDlg(s, '/screens/' + s.id);
  view.appendChild(hero);
  if (s.groupId) {
    const g = byId(S.groups, s.groupId);
    view.appendChild(h(`<div class="notice">Esta pantalla pertenece al grupo <b>${esc(g ? g.name : '')}</b> y muestra su lista. <a href="#/groups/${esc(s.groupId)}">Editar la lista del grupo</a> o quítala del grupo en Ajustes.</div>`));
    return;
  }
  view.appendChild(playlistEditor(s, async pl => { await api('/screens/' + s.id, { method: 'PATCH', body: { playlist: pl } }); await refresh(); }));
}

// ===================== Vista: Grupos =====================
function renderGroups() {
  view.innerHTML = '';
  const tb = h(`<div class="toolbar"><h1>Grupos</h1><button class="btn primary">＋ Nuevo grupo</button></div>`);
  tb.querySelector('button').onclick = () => dialog({ title: 'Nuevo grupo', body: `<label class="field"><span>Nombre</span><input type="text" name="name" placeholder="Sucursal centro, Todas las cajas…"></label><div class="help">Las pantallas de un grupo comparten la misma lista de reproducción.</div>`,
    buttons: [{ label: 'Cancelar', onClick: () => {} }, { label: 'Crear', cls: 'primary', onClick: async d => { const g = await api('/groups', { method: 'POST', body: { name: d.querySelector('[name=name]').value.trim() } }); await refresh(); location.hash = '#/groups/' + g.id; } }] });
  view.appendChild(tb);
  if (!S.groups.length) { view.appendChild(h(`<div class="empty"><b>No hay grupos</b>Crea un grupo para enviar el mismo contenido a varias pantallas a la vez.</div>`)); return; }
  const g = h(`<div class="grid"></div>`);
  S.groups.forEach(gr => {
    const n = S.screens.filter(s => s.groupId === gr.id), on = n.filter(s => s.online).length;
    const first = (gr.playlist || []).map(e => byId(S.content, e.contentId)).find(Boolean);
    const el = h(`<div class="card"><div class="thumb">${first ? thumbHTML(first) : '<div class="web" style="color:var(--muted)">Sin contenido</div>'}</div><div class="meta"><div class="name">${esc(gr.name)}</div><div class="sub">${n.length} pantalla(s) · ${on} en línea · ${(gr.playlist || []).length} elementos</div></div></div>`);
    el.onclick = () => location.hash = '#/groups/' + gr.id; g.appendChild(el);
  });
  view.appendChild(g);
}
function renderGroup(id) {
  const g = byId(S.groups, id);
  if (!g) { view.innerHTML = '<div class="empty"><b>Grupo no encontrado</b><a href="#/groups">Volver a grupos</a></div>'; return; }
  view.innerHTML = '';
  const members = S.screens.filter(s => s.groupId === g.id);
  const hero = h(`<div class="hero"><div><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><a href="#/groups" class="btn ghost sm">← Grupos</a><h1>${esc(g.name)}</h1></div>
    <div style="font-size:13px;color:var(--muted)">${members.length ? members.map(s => `<span class="dot ${s.online ? 'on' : ''}"></span>${esc(s.name)}`).join(' &nbsp; ') : 'Sin pantallas'}</div></div>
    <div class="actions"><button class="btn" data-a="screens">🖥 Pantallas del grupo</button><button class="btn" data-a="tr">✨ Transiciones</button><button class="btn" data-a="settings">⚙ Ajustes</button></div></div>`);
  hero.querySelector('[data-a=tr]').onclick = () => transitionDlg(g, '/groups/' + g.id);
  hero.querySelector('[data-a=screens]').onclick = () => {
    const body = h(`<div>${S.screens.length ? `<div class="check-list">${S.screens.map(s => `<label><input type="checkbox" value="${s.id}" ${s.groupId === g.id ? 'checked' : ''}> ${esc(s.name)} ${s.groupId && s.groupId !== g.id ? `<span style="color:var(--muted);font-size:12px">(ahora en ${esc(s.groupName)})</span>` : ''}</label>`).join('')}</div>` : '<p>No hay pantallas vinculadas todavía.</p>'}</div>`);
    dialog({ title: 'Pantallas del grupo', body, buttons: [{ label: 'Cancelar', onClick: () => {} }, { label: 'Guardar', cls: 'primary', onClick: async () => {
      await api('/groups/' + g.id, { method: 'PATCH', body: { screenIds: [...body.querySelectorAll('input:checked')].map(i => i.value) } }); await refresh(); render(); toast('Grupo actualizado'); } }] });
  };
  hero.querySelector('[data-a=settings]').onclick = () => dialog({ title: 'Ajustes del grupo', body: `<label class="field"><span>Nombre</span><input type="text" name="name" value="${esc(g.name)}"></label>`, buttons: [
    { label: 'Eliminar grupo', cls: 'danger', left: true, onClick: async () => { if (!await confirmDlg(`¿Eliminar el grupo "${g.name}"? Sus pantallas volverán a su lista propia.`)) return false; await api('/groups/' + g.id, { method: 'DELETE' }); await refresh(); location.hash = '#/groups'; } },
    { label: 'Cancelar', onClick: () => {} },
    { label: 'Guardar', cls: 'primary', onClick: async d => { await api('/groups/' + g.id, { method: 'PATCH', body: { name: d.querySelector('[name=name]').value.trim() || g.name } }); await refresh(); render(); } }] });
  view.appendChild(hero);
  view.appendChild(playlistEditor(g, async pl => { await api('/groups/' + g.id, { method: 'PATCH', body: { playlist: pl } }); await refresh(); }));
}

// ===================== Router =====================
let lastHash = location.hash;
function render() {
  const [, tab = 'content', id] = (location.hash || '#/content').split('/');
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (tab === 'screens') return id ? renderScreen(id) : renderScreens();
  if (tab === 'groups') return id ? renderGroup(id) : renderGroups();
  if (tab === 'websites') return renderWebsites();
  return renderContent();
}
addEventListener('hashchange', () => {
  if (dirty && !confirm('Hay cambios sin guardar en la lista. ¿Salir sin guardar?')) { history.replaceState(null, '', lastHash); return; }
  dirty = false; lastHash = location.hash; ui.q = ''; render();
});
addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// Refresca el estado en línea de las pantallas sin perder lo que se está editando
setInterval(async () => {
  if (dirty || document.querySelector('dialog[open]')) return;
  const [, tab = 'content', id] = (location.hash || '#/content').split('/');
  if (tab !== 'screens' && tab !== 'groups') return;
  try { await refresh(); if (!id || tab === 'screens') render(); } catch (e) {}
}, 20000);

refresh().then(render).catch(e => { view.innerHTML = `<div class="empty"><b>No se pudo conectar con el servidor</b>${esc(e.message)}</div>`; });
