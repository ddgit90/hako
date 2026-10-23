'use strict';
/* ===== HAKO : UI helpers ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtSize(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return (b < 10 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
}
function fmtTime(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
const fmtDur = s => (isFinite(s) && s > 0) ? fmtTime(s) : '';
function fmtDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } }
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const COLORS = ['#8b7cff', '#ff7aa8', '#4fd1c5', '#f6ad55', '#63b3ed', '#68d391', '#fc8181', '#b794f4', '#f6e05e', '#a0aec0'];
const pickColor = i => COLORS[i % COLORS.length];

/* ----- icons (stroke) ----- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  gear: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  star: '<path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor"/>',
  next: '<path d="M6 6v12l9-6z" fill="currentColor"/><path d="M18 6v12"/>',
  prevt: '<path d="M18 6v12l-9-6z" fill="currentColor"/><path d="M6 6v12"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9.5l5-5 5 5M5 20h14"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  tag: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6A3.8 3.8 0 0 1 17.5 18.5z"/><path d="M12 11v5M9.8 14l2.2 2.2 2.2-2.2"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5.5-5.5 4 4 2.5-2.5 4.5 4.5"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/>',
  share: '<path d="M12 15V4M8 7.5l4-4 4 4"/><path d="M6 11v8.5h12V11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor"/>',
  shield: '<path d="M12 3.5 5 6.5v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9v-5z"/><path d="m9 12 2 2 4-4"/>',
  wifi: '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/>',
  wifioff: '<path d="M3 3l18 18M9 16.5a4 4 0 0 1 6 0M6 13a8.5 8.5 0 0 1 5-2.4M3 9.5a13 13 0 0 1 4.5-3M13.5 6.6A13 13 0 0 1 21 9.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  compress: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  select: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12 3 3 5-5.5"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="14" width="4" height="6" rx="1.5"/><rect x="16.5" y="14" width="4" height="6" rx="1.5"/>',
  note: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5"/>',
  face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0"/>',
  box: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  layers: '<path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>',
  speed: '<path d="M4.6 17.5a8.5 8.5 0 1 1 14.8 0"/><path d="m12 13.5 4-4.5"/><circle cx="12" cy="13.5" r="1.2" fill="currentColor"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
};
const ic = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

/* ----- toast ----- */
function toast(msg, opt = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (opt.action) {
    const b = el(`<button>${esc(opt.action.label)}</button>`);
    b.onclick = () => { t.classList.remove('show'); opt.action.fn(); };
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), opt.ms || (opt.action ? 5000 : 2800));
}

/* ----- progress HUD ----- */
const HUD = {
  show(text, frac = null) {
    const h = $('#hud'); h.hidden = false;
    $('.hud-text', h).textContent = text;
    const bar = $('.bar', h); bar.classList.toggle('indet', frac == null);
    if (frac != null) $('i', bar).style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  },
  hide() { $('#hud').hidden = true; }
};

/* ----- bottom sheet ----- */
function sheet({ title = '', body = '', actions = [], onClose, tall = false, cls = '' }) {
  const w = el(`<div class="sheet-wrap"><div class="sheet ${tall ? 'tall' : ''} ${cls}" role="dialog" aria-modal="true">
    <div class="sheet-grab"></div>
    <div class="sheet-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="閉じる">${ic('x')}</button></div>
    <div class="sheet-body"></div><div class="sheet-foot"></div></div></div>`);
  const bodyEl = $('.sheet-body', w), foot = $('.sheet-foot', w);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  let closed = false;
  const api = {
    el: w, body: bodyEl,
    close() {
      if (closed) return; closed = true;
      w.classList.remove('open');
      setTimeout(() => w.remove(), 240);
      onClose && onClose();
    }
  };
  actions.forEach(a => {
    const b = el(`<button class="btn ${a.kind || ''}">${a.icon ? ic(a.icon) : ''}<span>${esc(a.label)}</span></button>`);
    b.onclick = async () => {
      if (b.disabled) return;
      b.disabled = true;
      try { const r = a.onClick ? await a.onClick(api) : undefined; if (r !== false && !a.keep) api.close(); }
      finally { b.disabled = false; }
    };
    foot.append(b);
  });
  if (!actions.length) foot.remove();
  w.addEventListener('click', e => { if (e.target === w || e.target.closest('[data-close]')) api.close(); });
  $('#sheets').append(w);
  requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add('open')));
  return api;
}

function ask(title, msg, buttons) {
  return new Promise(res => {
    let done = false;
    sheet({
      title, body: `<p class="muted pre">${esc(msg)}</p>`,
      actions: buttons.map(b => ({ label: b.label, kind: b.kind, onClick: () => { done = true; res(b.value); } })),
      onClose: () => { if (!done) res(null); }
    });
  });
}
const confirmDlg = (title, msg, ok = 'OK', danger = false) =>
  ask(title, msg, [{ label: 'キャンセル', value: false }, { label: ok, value: true, kind: danger ? 'danger' : 'primary' }]).then(v => !!v);

function promptDlg(title, value = '', placeholder = '', ok = '決定', type = 'text') {
  return new Promise(res => {
    let done = false;
    const body = el(`<div><input class="field" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></div>`);
    const inp = $('input', body);
    const s = sheet({
      title, body,
      actions: [
        { label: 'キャンセル', onClick: () => { done = true; res(null); } },
        { label: ok, kind: 'primary', onClick: () => { done = true; res(inp.value.trim()); } }
      ],
      onClose: () => { if (!done) res(null); }
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done = true; res(inp.value.trim()); s.close(); } });
    setTimeout(() => inp.focus(), 280);
  });
}

/* menu sheet: rows = [[icon,label,fn,cls]] ; fn runs synchronously in the tap (keeps file pickers allowed) */
function menuSheet(title, rows) {
  const body = el(`<div class="menu-list">${rows.filter(Boolean).map((r, i) => `<button class="mi ${r[3] || ''}" data-i="${i}">${ic(r[0])}<span>${esc(r[1])}</span></button>`).join('')}</div>`);
  const list = rows.filter(Boolean);
  const s = sheet({ title, body });
  body.addEventListener('click', e => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    const r = list[+b.dataset.i];
    s.close(); r[2]();
  });
  return s;
}

/* delegated long-press */
function longPress(root, selector, fn, ms = 480) {
  let timer = null, sx = 0, sy = 0, fired = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  root.addEventListener('pointerdown', e => {
    const t = e.target.closest(selector); if (!t || !root.contains(t)) return;
    fired = false; sx = e.clientX; sy = e.clientY; clear();
    timer = setTimeout(() => { fired = true; timer = null; navigator.vibrate && navigator.vibrate(12); fn(t, e); }, ms);
  });
  root.addEventListener('pointermove', e => { if (timer && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) clear(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => root.addEventListener(t, clear));
  root.addEventListener('click', e => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } }, true);
  root.addEventListener('contextmenu', e => { if (e.target.closest(selector)) e.preventDefault(); });
}
