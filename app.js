'use strict';
/* ===== HAKO : app ===== */
const DEFAULTS = {
  theme: 'dark', accent: '#8b7cff', grid: 3, names: false, sort: 'added_desc', siteSort: 'added_desc',
  autolock: 5, blurOnHide: true, saveDest: 'app', offline: false, concurrency: 3,
  proxy: '', proxyKey: '', favicons: false, imgMax: 2560, imgQ: 0.82, hideHomeTip: false, stripMeta: true, autoNumber: true,
  dupSkip: true, privacy: false, stripTrack: true, autoUpdate: true, rate: 1, slideSec: 3, backupRemind: 14, albums: false
};
const ACCENTS = ['#8b7cff', '#5b8cff', '#2fc6b4', '#3ddc97', '#f6ad55', '#ff7a59', '#ff6b9a', '#c084fc'];
const KIND_ICON = { image: 'image', video: 'film', audio: 'music', file: 'file' };
const KIND_LABEL = { image: '写真', video: '動画', audio: '音声', file: 'ファイル' };
const KINDS = [['all', 'すべて'], ['visual', '写真・動画'], ['image', '写真'], ['video', '動画'], ['audio', '音声'], ['file', 'ファイル'], ['offl', '再DL待ち']];
const SORTS = [['added_desc', '追加が新しい順'], ['added_asc', '追加が古い順'], ['name_asc', '名前順（1→9・あ→ん・A→Z）'], ['name_desc', '名前の逆順'], ['updated_desc', '更新が新しい順'], ['size_desc', 'サイズが大きい順'], ['size_asc', 'サイズが小さい順'], ['created_desc', '作成日（撮影日）が新しい順'], ['created_asc', '作成日（撮影日）が古い順'], ['kind', '種類ごと'], ['custom', '自分で決めた順']];
const SITE_SORTS = [['added_desc', '追加が新しい順'], ['added_asc', '追加が古い順'], ['name_asc', '名前順'], ['fav', 'お気に入りを上に']];
const isStandalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

const S = {
  key: null, items: new Map(), conf: null, view: 'lib', setup: false, hasBio: false,
  f: { genre: 'all', folder: 'all', kind: 'all', tags: [], q: '', trash: false, sort: 'added_desc', albums: false },
  sel: new Set(), selecting: false, list: [], shown: 0, thumbs: new Map(),
  hiddenAt: 0, noLockUntil: 0, detailRefresh: null
};
const coll = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/* ================= 保管庫 / ロック ================= */
async function createVault(pw) {
  const salt = Crypto.rand(16);
  const kek = await Crypto.kekFromPassword(pw, salt);
  const master = await Crypto.newMaster();
  const wrapped = await Crypto.wrap(master, kek);
  await DB.put('meta', { k: 'vault', v: 1, salt, iter: Crypto.ITER, wrapped, created: Date.now() });
  return master;
}
async function unlockWithPassword(pw) {
  const v = await DB.get('meta', 'vault'); if (!v) return null;
  const kek = await Crypto.kekFromPassword(pw, v.salt, v.iter);
  try { return await Crypto.unwrap(v.wrapped, kek); } catch { return null; }
}
async function bioPRF(credId, salt) {
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: Crypto.rand(32), rpId: location.hostname, timeout: 60000, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: credId }],
      extensions: { prf: { eval: { first: salt } } }
    }
  });
  const ext = a.getClientExtensionResults ? a.getClientExtensionResults() : {};
  return (ext.prf && ext.prf.results && ext.prf.results.first) || null;
}
async function unlockWithBio() {
  const b = await DB.get('meta', 'bio'); if (!b) throw new Error('未設定');
  const out = await bioPRF(b.credId, b.prfSalt);
  if (!out) throw new Error('この端末は非対応');
  const kek = await Crypto.kekFromBytes(out, 'hako-bio');
  try { return await Crypto.unwrap(b.wrapped, kek); } catch { throw new Error('鍵が合わない'); }
}
async function bioEnable() {
  if (!window.PublicKeyCredential) { toast('このブラウザはパスキー非対応'); return; }
  try {
    const prfSalt = Crypto.rand(32);
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'HAKO', id: location.hostname },
        user: { id: Crypto.rand(16), name: 'HAKO', displayName: 'HAKO 保管庫' },
        challenge: Crypto.rand(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        timeout: 60000, extensions: { prf: { eval: { first: prfSalt } } }
      }
    });
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    if (ext.prf && ext.prf.enabled === false) throw new Error('この端末はパスキーから鍵を作る機能（PRF）に非対応');
    const credId = new Uint8Array(cred.rawId);
    let out = ext.prf && ext.prf.results && ext.prf.results.first;
    if (!out) { toast('確認のためもう一度Face ID'); out = await bioPRF(credId, prfSalt); }
    if (!out) throw new Error('PRFの結果が取れなかった（非対応の可能性）');
    const kek = await Crypto.kekFromBytes(out, 'hako-bio');
    await DB.put('meta', { k: 'bio', credId, prfSalt, wrapped: await Crypto.wrap(S.key, kek) });
    S.hasBio = true; toast('Face IDで開けるようにした'); render();
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'キャンセルされた' : '設定できなかった: ' + e.message, { ms: 5000 });
  }
}
async function bioDisable() {
  if (!(await confirmDlg('Face IDをオフ', 'パスワードだけで開くようにする。iPhoneの「パスワード」アプリに残ったHAKOのパスキーは手動で消してOK。', 'オフにする', true))) return;
  await DB.del('meta', 'bio'); S.hasBio = false; render();
}

function failState() { try { return JSON.parse(localStorage.getItem('hako-fail')) || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } }
function saveFail(f) { try { localStorage.setItem('hako-fail', JSON.stringify(f)); } catch { } }
function readUI() { try { return JSON.parse(localStorage.getItem('hako-ui')) || {}; } catch { return {}; } }
async function setupLock() {
  const vault = await DB.get('meta', 'vault');
  const bio = vault ? await DB.get('meta', 'bio') : null;
  S.setup = !vault;
  const pw = $('#pw'), pw2 = $('#pw2');
  $('#lock').hidden = false; $('#app').hidden = true;
  pw.value = ''; pw2.value = '';
  if (S.setup) {
    $('#lockMsg').textContent = '最初にパスワードを決めて';
    pw.setAttribute('autocomplete', 'new-password'); pw.placeholder = 'パスワード（6文字以上）';
    pw2.hidden = false; $('#lockBtn').textContent = 'はじめる';
    $('#lockNote').textContent = 'このパスワードで中身を全部暗号化する。忘れると自分も含めて誰も開けない（復元手段なし）。iPhoneの「パスワード」アプリに保存しておけばFace IDで入力できる。';
    $('#restoreFirst').hidden = false; $('#bioBtn').hidden = true;
  } else {
    $('#lockMsg').textContent = 'パスワードで開く';
    pw.setAttribute('autocomplete', 'current-password'); pw.placeholder = 'パスワード';
    pw2.hidden = true; $('#lockBtn').textContent = '開く';
    $('#lockNote').textContent = '';
    $('#restoreFirst').hidden = true; $('#bioBtn').hidden = !bio;
  }
}
function bindLock() {
  $('#lockForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('#pw').value, btn = $('#lockBtn');
    if (!pw) return;
    btn.disabled = true;
    try {
      if (S.setup) {
        if (pw.length < 6) throw new Error('6文字以上にして');
        if (pw !== $('#pw2').value) throw new Error('2回目が一致しない');
        $('#lockMsg').textContent = '保管庫を作ってる…';
        S.key = await createVault(pw);
      } else {
        const f = failState();
        if (Date.now() < f.until) throw new Error(`間違いが続いたので、あと${Math.ceil((f.until - Date.now()) / 1000)}秒待って`);
        $('#lockMsg').textContent = '確認中…';
        const k = await unlockWithPassword(pw);
        if (!k) {
          f.n++; if (f.n >= 5) f.until = Date.now() + Math.min(3600, 30 * 2 ** (f.n - 5)) * 1000;
          saveFail(f);
          throw new Error(f.n >= 5 ? `パスワードが違う（${f.n}回目。しばらく待たないと試せない）` : 'パスワードが違う');
        }
        saveFail({ n: 0, until: 0 });
        S.key = k;
      }
      await enterApp();
    } catch (err) {
      $('#lockMsg').textContent = err.message;
      const c = $('.lock-card'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake');
    } finally { btn.disabled = false; }
  });
  $('#bioBtn').addEventListener('click', async () => {
    try { $('#lockMsg').textContent = 'Face IDで確認中…'; S.key = await unlockWithBio(); await enterApp(); }
    catch (e) { $('#lockMsg').textContent = e.name === 'NotAllowedError' ? 'キャンセルされた。パスワードでも開ける' : 'Face IDで開けなかった: ' + e.message; }
  });
  $('#restoreFirst').addEventListener('click', () => {
    pickFiles('', false, async fs => {
      try {
        const r = await importBackup(fs[0], true);
        await setupLock();
        $('#lockMsg').textContent = `${r.added}件を復元した。バックアップを作った時のパスワードで開いて`;
      } catch (e) { await DB.clear().catch(() => { }); await setupLock(); $('#lockMsg').textContent = '復元できなかった: ' + e.message; }
    });
  });
}
function normalizeConf(c) {
  c = c || {};
  ['genres', 'folders', 'tags', 'sites'].forEach(k => { if (!Array.isArray(c[k])) c[k] = []; });
  c.settings = Object.assign({}, DEFAULTS, c.settings || {});
  return c;
}
async function enterApp() {
  HUD.show('読み込み中…');
  const c = await DB.get('meta', 'conf');
  S.conf = normalizeConf(c ? await Crypto.decJSON(S.key, c) : null);
  const recs = await DB.all('items'); S.items.clear(); let bad = 0;
  for (let i = 0; i < recs.length; i += 64) {
    const part = await Promise.all(recs.slice(i, i + 64).map(r => Crypto.decJSON(S.key, r).catch(() => { bad++; return null; })));
    part.forEach(m => m && S.items.set(m.id, m));
  }
  S.hasBio = !!(await DB.get('meta', 'bio'));
  HUD.hide();
  $('#pw').value = ''; $('#pw2').value = '';
  $('#lock').hidden = true; $('#app').hidden = false;
  S.f.sort = S.conf.settings.sort;
  applyTheme();
  if (!c) await saveConfNow();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  S.f.albums = !!S.conf.settings.albums;
  SW.sendKey(); SW.flags();
  if (!S.conf.created) { S.conf.created = Date.now(); saveConf(); }
  go(S.view || 'lib');
  const rd = S.conf.settings.backupRemind;
  if (rd > 0 && S.items.size >= 5) {
    const days = Math.floor((Date.now() - (S.conf.lastBackup || S.conf.created)) / 86400000);
    if (days >= rd) setTimeout(() => toast(S.conf.lastBackup ? `最後のバックアップから${days}日たった` : 'まだバックアップを取ってない', { action: { label: '今する', fn: () => exportBackup(null) }, ms: 7000 }), 1500);
  }
  if (bad) toast(`${bad}件のデータを読めなかった（消してはいない）`, { ms: 5000 });
}
function lock() {
  if (!S.key) return;
  saveConfNow().catch(() => { });
  SW.lock();
  S.key = null; closeViewer(); $('#sheets').innerHTML = ''; HUD.hide();
  for (const p of S.thumbs.values()) p.then(u => u && URL.revokeObjectURL(u));
  S.thumbs.clear(); S.items.clear(); S.conf = null; exitSelect(); S.detailRefresh = null;
  $('#main').innerHTML = '';
  setupLock();
}
let confTimer = null;
function saveConf() { clearTimeout(confTimer); confTimer = setTimeout(() => saveConfNow().catch(e => toast('設定を保存できなかった: ' + e.message)), 250); }
async function saveConfNow() {
  clearTimeout(confTimer);
  if (!S.key || !S.conf) return;
  const r = await Crypto.encJSON(S.key, S.conf);
  await DB.put('meta', { k: 'conf', iv: r.iv, data: r.data });
}

/* ================= テーマ ================= */
function applyTheme() {
  const st = S.conf ? S.conf.settings : Object.assign({}, DEFAULTS, readUI());
  let t = st.theme;
  if (t === 'auto') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const r = document.documentElement;
  r.dataset.theme = t;
  r.style.setProperty('--acc', st.accent);
  r.style.setProperty('--cols', st.grid || 3);
  const m = $('meta[name=theme-color]'); if (m) m.content = t === 'light' ? '#f4f4f7' : '#0c0c0f';
  try { localStorage.setItem('hako-ui', JSON.stringify({ theme: st.theme, accent: st.accent })); } catch { }
}

/* ================= 共通 ================= */
const genreName = id => (S.conf.genres.find(x => x.id === id) || {}).name || '';
const folderName = id => (S.conf.folders.find(x => x.id === id) || {}).name || '';
const tagOf = id => S.conf.tags.find(x => x.id === id);
const tagChips = ids => (ids || []).map(tagOf).filter(Boolean).map(t => `<span class="chip sm" style="--tc:${t.color}"><i class="dot"></i>${esc(t.name)}</span>`).join('');

function pickFiles(accept, multiple, cb) {
  const inp = $('#fileIn');
  inp.value = '';
  if (accept) inp.setAttribute('accept', accept); else inp.removeAttribute('accept');
  inp.multiple = !!multiple;
  S.noLockUntil = Date.now() + 15 * 60000;
  inp.onchange = () => { S.noLockUntil = 0; const fs = Array.from(inp.files || []); inp.value = ''; if (fs.length) cb(fs); };
  inp.click();
}
function pickOne(title, opts, cur, { none = 'なし', newLabel = null } = {}) {
  return new Promise(res => {
    let done = false; cur = cur || '';
    const body = el(`<div class="picklist">${[{ id: '', name: none }, ...opts].map(o =>
      `<button class="pick ${cur === o.id ? 'on' : ''}" data-id="${o.id}"><span>${esc(o.name)}</span>${cur === o.id ? ic('check') : ''}</button>`).join('')}
      ${newLabel ? `<button class="pick new" data-new>${ic('plus')}<span>${esc(newLabel)}</span></button>` : ''}</div>`);
    const s = sheet({ title, body, tall: opts.length > 7, onClose: () => { if (!done) res(null); } });
    body.addEventListener('click', async e => {
      const b = e.target.closest('[data-id]');
      if (b) { done = true; res(b.dataset.id); s.close(); return; }
      if (e.target.closest('[data-new]')) {
        done = true; s.close();
        const n = await promptDlg(newLabel, '', '名前');
        res(n ? { new: n } : null);
      }
    });
  });
}
async function chooseIn(kind, cur, title) {
  const lab = kind === 'folders' ? 'フォルダ' : 'ジャンル';
  const r = await pickOne(title || lab + 'を選ぶ', S.conf[kind], cur, { none: kind === 'folders' ? '未分類' : 'なし', newLabel: `新しい${lab}を作る` });
  if (r == null) return null;
  if (typeof r === 'object') { const x = { id: uid(), name: r.new }; S.conf[kind].push(x); saveConf(); return x.id; }
  return r;
}
function pickTags(initial = [], { title = 'タグ', bulk = false } = {}) {
  return new Promise(res => {
    const sel = new Set(initial); let mode = 'add', done = false;
    const body = el(`<div class="tagpick">
      ${bulk ? `<div class="seg" style="margin-bottom:12px"><button class="on" data-m="add">付ける</button><button data-m="remove">外す</button></div>` : ''}
      <div class="chips wrap" data-list></div>
      <div class="row" style="margin-top:14px"><input class="field" placeholder="新しいタグ名" maxlength="30"><button class="btn primary" data-new>${ic('plus')}</button></div></div>`);
    const draw = () => {
      $('[data-list]', body).innerHTML = S.conf.tags.length
        ? S.conf.tags.map(t => `<button class="chip ${sel.has(t.id) ? 'on' : ''}" data-t="${t.id}" style="--tc:${t.color}"><i class="dot"></i>${esc(t.name)}</button>`).join('')
        : '<p class="muted small">まだタグがない。下で作れる。</p>';
    };
    const inp = $('input', body);
    const addNew = () => {
      const n = inp.value.trim(); if (!n) return;
      let t = S.conf.tags.find(x => x.name === n);
      if (!t) { t = { id: uid(), name: n, color: pickColor(S.conf.tags.length) }; S.conf.tags.push(t); saveConf(); }
      sel.add(t.id); inp.value = ''; draw();
    };
    draw();
    body.addEventListener('click', e => {
      const t = e.target.closest('[data-t]');
      if (t) { const id = t.dataset.t; sel.has(id) ? sel.delete(id) : sel.add(id); draw(); return; }
      const mb = e.target.closest('[data-m]');
      if (mb) { mode = mb.dataset.m; $$('[data-m]', body).forEach(b => b.classList.toggle('on', b === mb)); return; }
      if (e.target.closest('[data-new]')) addNew();
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } });
    sheet({
      title, body, tall: true,
      actions: [{ label: 'キャンセル', onClick: () => { done = true; res(null); } }, { label: '決定', kind: 'primary', onClick: () => { done = true; res({ tags: [...sel], mode }); } }],
      onClose: () => { if (!done) res(null); }
    });
  });
}

/* ================= 画面遷移 ================= */
function go(view) {
  if (!S.key) return;
  if (view !== 'lib') { exitSelect(); S.f.trash = false; }
  if (view === 'lib' && S.view === 'lib' && S.f.trash) { exitSelect(); S.f.trash = false; }
  S.view = view;
  $$('#bottomNav [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  render(); window.scrollTo(0, 0);
}
function render() {
  if (!S.key || !S.conf) return;
  const v = S.view;
  $('#viewTitle').textContent = { lib: S.f.trash ? 'ゴミ箱' : 'ライブラリ', sites: 'サイト', queue: '転送', settings: '設定' }[v];
  const showTabs = (v === 'lib' && !S.f.trash) || v === 'sites';
  $('#genreTabs').hidden = !showTabs;
  $('#searchBtn').hidden = !(v === 'lib' || v === 'sites');
  $('#selectBtn').hidden = v !== 'lib';
  if (!(v === 'lib' || v === 'sites')) $('#searchRow').hidden = true;
  renderNet();
  if (showTabs) renderTabs();
  if (v === 'lib') renderLib();
  else if (v === 'sites') { renderSites(); fixFavicons(); }
  else if (v === 'queue') renderQueue();
  else renderSettings();
  updateBadge();
}
const refresh = () => render();
let refreshT = null;
const refreshSoon = () => { clearTimeout(refreshT); refreshT = setTimeout(() => { if (S.view === 'lib') { const y = scrollY; render(); scrollTo(0, y); } }, 400); };

function renderNet() {
  const off = S.conf && S.conf.settings.offline, on = navigator.onLine, p = $('#netPill');
  p.className = 'pill ' + (off ? 'off' : on ? 'on' : 'warn');
  p.innerHTML = (off || !on ? ic('wifioff') : ic('wifi')) + `<span>${off ? 'オフライン' : on ? 'オンライン' : '圏外'}</span>`;
}
function renderTabs() {
  const cur = S.f.genre;
  const tabs = [['all', 'すべて'], ['fav', '★ お気に入り'], ...S.conf.genres.map(x => [x.id, x.name])];
  $('#genreTabs').innerHTML = tabs.map(([id, n]) => `<button class="tab ${cur === id ? 'on' : ''}" data-genre="${id}">${esc(n)}</button>`).join('')
    + `<button class="tab add" data-genre-add aria-label="ジャンルを追加">${ic('plus')}</button>`;
  const on = $('#genreTabs .tab.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function updateBadge() {
  const n = Q.jobs.filter(j => j.status === 'wait' || j.status === 'run').length;
  const b = $('#qBadge'); b.hidden = !n; b.textContent = n;
}
let qRaf = 0;
function onQueueChange() {
  if (qRaf) return;
  qRaf = requestAnimationFrame(() => { qRaf = 0; updateBadge(); if (S.view === 'queue' && S.key) renderQueue(); });
}

/* ================= ライブラリ ================= */
function filteredItems() {
  const f = S.f, q = f.q.trim().toLowerCase();
  let arr = [...S.items.values()].filter(m => f.trash ? m.trashed : !m.trashed);
  if (!f.trash) {
    if (f.genre === 'fav') arr = arr.filter(m => m.fav);
    else if (f.genre !== 'all') arr = arr.filter(m => m.genre === f.genre);
    if (f.folder === 'none') arr = arr.filter(m => !m.folder);
    else if (f.folder !== 'all') arr = arr.filter(m => m.folder === f.folder);
    if (f.kind === 'visual') arr = arr.filter(m => m.kind === 'image' || m.kind === 'video');
    else if (f.kind === 'offl') arr = arr.filter(m => m.offloaded);
    else if (f.kind !== 'all') arr = arr.filter(m => m.kind === f.kind);
    if (f.tags.length) arr = arr.filter(m => f.tags.every(t => (m.tags || []).includes(t)));
  }
  if (q) arr = arr.filter(m => (m.name + ' ' + (m.memo || '') + ' ' + (m.tags || []).map(t => (tagOf(t) || {}).name || '').join(' ')).toLowerCase().includes(q));
  const by = {
    added_desc: (a, b) => b.added - a.added, added_asc: (a, b) => a.added - b.added,
    created_desc: (a, b) => (b.created || b.added) - (a.created || a.added), created_asc: (a, b) => (a.created || a.added) - (b.created || b.added),
    name_asc: (a, b) => coll.compare(a.name, b.name), name_desc: (a, b) => coll.compare(b.name, a.name),
    updated_desc: (a, b) => (b.updated || 0) - (a.updated || 0),
    size_desc: (a, b) => (b.size || 0) - (a.size || 0), size_asc: (a, b) => (a.size || 0) - (b.size || 0),
    kind: (a, b) => a.kind.localeCompare(b.kind) || b.added - a.added,
    custom: (a, b) => orderKey(a) - orderKey(b)
  };
  return arr.sort(by[f.sort] || by.added_desc);
}
const orderKey = m => m.order != null ? m.order : -m.added;
function renderLib() {
  const f = S.f, list = filteredItems();
  S.list = list.map(m => m.id);
  const total = list.reduce((a, m) => a + (m.offloaded ? 0 : m.size || 0), 0);
  let head;
  if (f.trash) {
    head = `<div class="trash-head"><button class="btn sm ghost" data-act="exit-trash">${ic('left')}<span>戻る</span></button><span class="muted small">${list.length}件・自動では消えない</span><div class="sp"></div>
      ${list.length ? `<button class="btn sm danger" data-act="empty-trash">${ic('trash')}<span>空にする</span></button>` : ''}</div>`;
  } else {
    const folders = [['all', 'すべて'], ['none', '未分類'], ...S.conf.folders.map(x => [x.id, x.name])];
    const sortLabel = (SORTS.find(s => s[0] === f.sort) || SORTS[0])[1].replace(/（.*）/, '');
    head = `
      ${!isStandalone && !S.conf.settings.hideHomeTip ? `<div class="banner">${ic('info')}<div><b>ホーム画面に追加して使うのがおすすめ</b><br>Safariのタブのまま使うと、しばらく開かなかった時にiOSがデータを消すことがある。共有ボタン →「ホーム画面に追加」。<button class="link" data-act="hide-tip">閉じる</button></div></div>` : ''}
      <div class="row-scroll chips">${folders.map(([id, n]) => `<button class="chip ${f.folder === id ? 'on' : ''}" data-folder="${id}">${id !== 'all' && id !== 'none' ? ic('folder') : ''}${esc(n)}</button>`).join('')}
        <button class="chip ghost" data-act="add-folder">${ic('plus')}フォルダ</button></div>
      <div class="row-scroll chips">${KINDS.map(([id, n]) => `<button class="chip sm ${f.kind === id ? 'on' : ''}" data-kind="${id}">${n}</button>`).join('')}</div>
      <div class="toolrow"><span class="muted small">${list.length}件・${fmtSize(total)}</span><div class="sp"></div>
        <button class="btn sm ghost" data-act="tagfilter">${ic('tag')}<span>タグ${f.tags.length ? '(' + f.tags.length + ')' : ''}</span></button>
        <button class="btn sm ghost ${f.albums ? 'on' : ''}" data-act="albums">${ic('layers')}<span>アルバム</span></button>
        <button class="btn sm ghost" data-act="sort">${ic('sort')}<span>${esc(sortLabel)}</span></button></div>
      ${f.tags.length ? `<div class="chips wrap" style="margin-bottom:10px">${f.tags.map(tagOf).filter(Boolean).map(t => `<button class="chip sm on" data-untag="${t.id}">${esc(t.name)} ${ic('x')}</button>`).join('')}</div>` : ''}`;
  }
  if (!f.trash && f.albums && f.folder === 'all') {
    $('#main').innerHTML = `<section class="lib">${head}<div class="albums">${albumHTML(list)}</div></section>`;
    observeThumbs($('#main')); return;
  }
  const empty = list.length ? '' : `<div class="empty">${ic(f.trash ? 'trash' : 'box')}<p>${f.trash ? 'ゴミ箱は空' : S.items.size ? 'この条件に合うものはない' : 'まだ何もない。下の＋から写真・動画・URLを追加'}</p></div>`;
  $('#main').innerHTML = `<section class="lib">${head}<div class="grid ${S.conf.settings.names ? 'names' : ''}" id="grid"></div>${empty}<div id="more"></div></section>`;
  S.shown = 0; renderMoreTiles();
}
function albumHTML(list) {
  const known = new Set(S.conf.folders.map(f => f.id)), groups = new Map();
  list.forEach(m => { const k = m.folder && known.has(m.folder) ? m.folder : 'none'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
  const cards = [...S.conf.folders.map(f => f.id), 'none'].filter(k => groups.has(k)).map(k => {
    const arr = groups.get(k), f = S.conf.folders.find(x => x.id === k);
    const cover = f && f.cover && arr.some(m => m.id === f.cover && m.hasThumb) ? f.cover : (arr.find(m => m.hasThumb) || {}).id;
    return `<button class="album" data-folder="${k}"><div class="album-cover">${ic('folder', 'lg')}${cover ? `<img alt="" data-thumb="${cover}">` : ''}<span class="album-n">${arr.length}</span></div>
      <b>${esc(f ? f.name : '未分類')}</b><small>${fmtSize(arr.reduce((a, m) => a + (m.offloaded ? 0 : m.size || 0), 0))}</small></button>`;
  });
  return cards.join('') || `<div class="empty">${ic('folder')}<p>この条件に合うものはない</p></div>`;
}
const PAGE = 240;
function renderMoreTiles() {
  const grid = $('#grid'); if (!grid) return;
  const ids = S.list.slice(S.shown, S.shown + PAGE);
  S.shown += ids.length;
  grid.insertAdjacentHTML('beforeend', ids.map(tileHTML).join(''));
  observeThumbs(grid);
  if (S.shown < S.list.length) moreObs.observe($('#more'));
}
const moreObs = new IntersectionObserver(es => { es.forEach(e => { if (e.isIntersecting) { moreObs.unobserve(e.target); renderMoreTiles(); } }); }, { rootMargin: '900px' });
const thumbObs = new IntersectionObserver(es => {
  es.forEach(e => {
    if (!e.isIntersecting) return;
    const img = e.target; thumbObs.unobserve(img);
    const id = img.dataset.thumb;
    thumbURL(id).then(u => { if (u) { img.onload = () => img.classList.add('ok'); img.src = u; } });
  });
}, { rootMargin: '600px' });
function observeThumbs(root) { $$('img[data-thumb]:not([src])', root).forEach(i => { if (i.dataset.thumb) thumbObs.observe(i); }); }
function tileHTML(id) {
  const m = S.items.get(id); if (!m) return '';
  return `<div class="tile k-${m.kind} ${S.sel.has(id) ? 'sel' : ''}" data-id="${id}">
    <div class="ph">${ic(KIND_ICON[m.kind])}</div>
    ${m.hasThumb ? `<img alt="" data-thumb="${id}">` : ''}
    <div class="badges">${m.quarantine ? `<span class="b-q" title="隔離中">${ic('shield')}</span>` : ''}${m.broken ? `<span class="b-bad" title="${esc(m.broken)}">×</span>` : ''}${m.warn ? `<span class="b-warn" title="${esc(m.warn)}">!</span>` : ''}${m.fav ? `<span class="b-fav">${ic('star', 'fill')}</span>` : ''}${m.offloaded ? `<span class="b-off" title="再ダウンロード待ち">${ic('cloud')}</span>` : ''}</div>
    ${m.kind === 'video' || m.kind === 'audio' ? `<span class="b-dur">${m.kind === 'audio' ? ic('music') : ic('play')}${fmtDur(m.dur)}</span>` : ''}
    ${m.kind === 'file' ? `<span class="b-ext">${esc((extOf(m.name) || 'file').toUpperCase())}</span>` : ''}
    <span class="check">${ic('check')}</span>
    ${S.conf.settings.names ? `<div class="tname">${esc(m.name)}</div>` : ''}</div>`;
}
function updateTile(id) {
  const t = $(`#grid .tile[data-id="${id}"]`); if (!t) return;
  const n = el(tileHTML(id)); if (!n) { t.remove(); return; }
  t.replaceWith(n); observeThumbs(n.parentNode || document);
}

/* ----- 選択モード ----- */
function enterSelect() { S.selecting = true; document.body.classList.add('selecting'); renderSelbar(); }
function exitSelect() {
  S.selecting = false; S.sel.clear(); document.body.classList.remove('selecting');
  const sb = $('#selbar'); if (sb) sb.hidden = true;
  $$('.tile.sel').forEach(t => t.classList.remove('sel'));
}
function toggleSel(id) {
  S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id);
  const t = $(`#grid .tile[data-id="${id}"]`); if (t) t.classList.toggle('sel', S.sel.has(id));
  renderSelbar();
}
const SEL_ACTS = [['export', 'share', '書き出す'], ['each', 'image', '個別に保存'], ['folder', 'folder', 'フォルダ'], ['tags', 'tag', 'タグ'], ['genre', 'grid', 'ジャンル'], ['fav', 'star', 'お気に入り'],
['top', 'up', '先頭へ'], ['bottom', 'down', '末尾へ'], ['rename', 'edit', '連番で名前'], ['offload', 'cloud', '容量を空ける'], ['redl', 'restore', '再DL'], ['compress', 'compress', '画像を軽く'], ['backup', 'lock', 'バックアップ'], ['trash', 'trash', 'ゴミ箱へ']];
function renderSelbar() {
  const bar = $('#selbar'); bar.hidden = false;
  const n = S.sel.size, all = n && n === S.list.length;
  const acts = S.f.trash ? [['untrash', 'restore', '元に戻す'], ['purge', 'trash', '完全に削除']] : SEL_ACTS;
  bar.innerHTML = `<div class="selbar-top"><b>${n}件を選択中</b><button class="btn sm ghost" data-sel="all">${all ? '全解除' : '全選択'}</button><button class="btn sm primary" data-sel="done">完了</button></div>
    <div class="row-scroll selacts">${acts.map(([k, i, l]) => `<button class="sa ${k === 'trash' || k === 'purge' ? 'danger' : ''}" data-sel="${k}" ${n ? '' : 'disabled'}>${ic(i)}<span>${l}</span></button>`).join('')}</div>`;
}
async function onSelAction(k) {
  const ids = [...S.sel];
  if (k === 'done') { exitSelect(); return; }
  if (k === 'all') { if (S.sel.size === S.list.length) S.sel.clear(); else S.list.forEach(id => S.sel.add(id)); renderLib(); renderSelbar(); return; }
  if (!ids.length) return;
  const ms = ids.map(id => S.items.get(id)).filter(Boolean);
  switch (k) {
    case 'export': await exportItems(ids, 'zip'); break;
    case 'each': await exportItems(ids, 'each'); break;
    case 'folder': {
      const f = await chooseIn('folders', null, `${ids.length}件をフォルダへ移動`); if (f == null) return;
      for (const m of ms) { m.folder = f || null; await saveItem(m); }
      toast(`${ids.length}件を「${folderName(f) || '未分類'}」へ`); break;
    }
    case 'genre': {
      const g = await chooseIn('genres', null, `${ids.length}件のジャンル`); if (g == null) return;
      for (const m of ms) { m.genre = g || null; await saveItem(m); }
      toast(`${ids.length}件を「${genreName(g) || 'なし'}」に`); break;
    }
    case 'tags': {
      const r = await pickTags([], { title: `${ids.length}件のタグ`, bulk: true }); if (!r) return;
      for (const m of ms) {
        const t = new Set(m.tags || []);
        r.tags.forEach(x => r.mode === 'add' ? t.add(x) : t.delete(x));
        m.tags = [...t]; await saveItem(m);
      }
      toast(r.mode === 'add' ? 'タグを付けた' : 'タグを外した'); break;
    }
    case 'fav': { const v = !ms.every(m => m.fav); for (const m of ms) { m.fav = v; await saveItem(m); } toast(v ? 'お気に入りにした' : 'お気に入りから外した'); break; }
    case 'offload': await offloadItems(ids); break;
    case 'redl': await restoreItems(ids); break;
    case 'compress': await compressImages(ids); break;
    case 'backup': await exportBackup(ids); break;
    case 'top': case 'bottom': {
      const keys = [...S.items.values()].map(orderKey);
      const ordered = S.list.filter(id => S.sel.has(id));
      if (k === 'top') { const min = Math.min(...keys); for (let i = 0; i < ordered.length; i++) { const m = S.items.get(ordered[i]); m.order = min - ordered.length + i; await saveItem(m, false); } }
      else { const max = Math.max(...keys); for (let i = 0; i < ordered.length; i++) { const m = S.items.get(ordered[i]); m.order = max + 1 + i; await saveItem(m, false); } }
      if (S.f.sort !== 'custom') { S.f.sort = 'custom'; toast('並び順を「自分で決めた順」にした'); } break;
    }
    case 'rename': {
      const ordered = S.list.filter(id => S.sel.has(id)), first = S.items.get(ordered[0]);
      const def = folderName(first.folder) || first.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\s-]*\d+$/, '') || 'HAKO';
      const base = await promptDlg(`${ordered.length}件を連番で名前変更`, def, '例：旅行 → 旅行_001.jpg');
      if (!base) return;
      const w = Math.max(3, String(ordered.length).length);
      for (let i = 0; i < ordered.length; i++) { const m = S.items.get(ordered[i]); const ext = extOf(m.name); m.name = `${base}_${String(i + 1).padStart(w, '0')}${ext ? '.' + ext : ''}`; await saveItem(m); }
      toast('名前を変えた（今の並び順で番号を付けた）'); break;
    }
    case 'trash': trashItems(ids); break;
    case 'untrash': untrashItems(ids); break;
    case 'purge': await purgeItems(ids); break;
  }
  exitSelect(); refresh();
}
async function trashItems(ids) {
  for (const id of ids) { const m = S.items.get(id); if (m) { m.trashed = Date.now(); await saveItem(m); } }
  if (Player.id && ids.includes(Player.id)) Player.stop();
  refresh();
  toast(`${ids.length}件をゴミ箱へ`, { action: { label: '元に戻す', fn: () => untrashItems(ids) } });
}
async function untrashItems(ids) {
  for (const id of ids) { const m = S.items.get(id); if (m) { delete m.trashed; await saveItem(m); } }
  refresh(); toast(`${ids.length}件を戻した`);
}
async function purgeItems(ids) {
  if (!(await confirmDlg('完全に削除', `${ids.length}件を完全に消す。元には戻せない。`, '完全に削除', true))) return false;
  for (const id of ids) {
    if (Player.id === id) Player.stop();
    await DB.delChunks(id); await DB.del('thumbs', id); await DB.del('items', id);
    dropThumbCache(id); S.items.delete(id);
  }
  refresh(); toast(`${ids.length}件を削除した`); return true;
}

async function moveOne(id, dir) {
  const i = S.list.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= S.list.length) return;
  const a = S.items.get(id), b = S.items.get(S.list[j]), ka = orderKey(a), kb = orderKey(b);
  a.order = kb; b.order = ka === kb ? kb - dir : ka;
  await saveItem(a, false); await saveItem(b, false); refresh();
}
/* ----- 長押しメニュー ----- */
function itemMenu(id) {
  const m = S.items.get(id); if (!m) return;
  menuSheet(m.name, [
    ['select', '選択する', () => { enterSelect(); toggleSel(id); }],
    S.f.sort === 'custom' ? ['up', '1つ前へ', () => moveOne(id, -1)] : null,
    S.f.sort === 'custom' ? ['down', '1つ後へ', () => moveOne(id, 1)] : null,
    ['info', '詳細・名前・メモ・タグ', () => openDetail(id)],
    m.offloaded
      ? (m.sourceUrl ? ['cloud', '再ダウンロードして戻す', () => restoreItems([id])] : ['upload', 'ファイルを選んで戻す', () => pickFileFor(m)])
      : ['cloud', '容量を空ける（再ダウンロード待ちにする）', () => offloadItems([id])],
    ['star', m.fav ? 'お気に入りから外す' : 'お気に入りにする', async () => { m.fav = !m.fav; await saveItem(m); updateTile(id); }],
    m.folder && m.hasThumb && S.conf.folders.some(f => f.id === m.folder) ? ['layers', 'このフォルダの表紙にする', () => { const f = S.conf.folders.find(x => x.id === m.folder); f.cover = m.id; saveConf(); toast(`「${f.name}」の表紙にした`); }] : null,
    m.offloaded ? null : ['share', 'iPhoneに書き出す', () => exportItems([id])],
    m.trashed ? ['restore', 'ゴミ箱から戻す', () => untrashItems([id])] : ['trash', 'ゴミ箱へ', () => trashItems([id]), 'danger'],
    m.trashed ? ['trash', '完全に削除', () => purgeItems([id]), 'danger'] : null
  ]);
}

/* ----- 詳細 ----- */
function detailHTML(m) {
  return `<div class="detail">
    <div class="d-hero"><div class="d-thumb">${ic(KIND_ICON[m.kind], 'lg')}${m.hasThumb ? '<img alt="">' : ''}</div>
      <div class="d-meta"><span class="kind-pill">${KIND_LABEL[m.kind]}</span>
        <span>${m.offloaded ? '再ダウンロード待ち（サムネは保持）' : fmtSize(m.size)}</span>
        ${m.w ? `<span>${m.w} × ${m.h}</span>` : ''}${m.dur ? `<span>${fmtTime(m.dur)}</span>` : ''}
        <span>追加 ${fmtDate(m.added)}</span>${m.created ? `<span>作成 ${fmtDate(m.created)}</span>` : ''}${m.compressed ? '<span>軽量化済み</span>' : ''}</div></div>
    ${m.quarantine ? `<div class="banner bad">${ic('shield')}<div><b>隔離中</b><br>${esc(m.quarantine)}。HAKOの中では実行も表示もしない（中身はテキストとしてだけ見られる）。書き出す時は確認が出る</div></div>` : ''}
    ${m.warn ? `<div class="banner">${ic('info')}<div><b>中身チェック</b><br>${esc(m.warn)}</div></div>` : ''}
    ${m.gps ? `<div class="banner">${ic('info')}<div><b>位置情報が入ってる写真</b><br>${S.conf.settings.stripMeta ? '書き出す時は位置情報・機種・撮影日時の情報を消してから出す（HAKOの中の元データはそのまま）' : '書き出すと位置情報もそのまま出る（設定 → 保存 で消せる）'}</div></div>` : ''}
    ${m.broken ? `<div class="banner bad">${ic('info')}<div><b>点検で問題あり</b><br>${esc(m.broken)}。URLから入れたものは再ダウンロード、それ以外はファイルかバックアップから戻せる</div></div>` : ''}
    <label class="lbl">名前</label><input class="field" data-f="name" value="${esc(m.name)}">
    <label class="lbl">メモ・説明</label><textarea class="field" data-f="memo" rows="3" placeholder="説明やメモを自由に">${esc(m.memo || '')}</textarea>
    <div class="kv"><span>ジャンル</span><button class="btn sm ghost" data-d="genre">${esc(genreName(m.genre) || 'なし')} ${ic('right')}</button></div>
    <div class="kv"><span>フォルダ</span><button class="btn sm ghost" data-d="folder">${esc(folderName(m.folder) || '未分類')} ${ic('right')}</button></div>
    <div class="kv col"><span>タグ</span><div class="chips wrap">${tagChips(m.tags)}<button class="chip ghost" data-d="tags">${ic('tag')}編集</button></div></div>
    <div class="kv"><span>お気に入り</span><button class="switch ${m.fav ? 'on' : ''}" data-d="fav" aria-label="お気に入り"></button></div>
    ${m.sourceUrl ? `<div class="kv col"><span>入手元URL</span><div class="url-row"><code>${esc(m.sourceUrl)}</code><button class="btn sm ghost" data-d="copyurl">${ic('copy')}</button></div></div>` : ''}
    <div class="d-actions">
      ${m.kind === 'video' ? `<button class="btn" data-d="pickthumb">${ic('image')}<span>サムネを選ぶ</span></button>` : ''}
      ${m.kind === 'audio' ? `<button class="btn" data-d="cover">${ic('image')}<span>カバー画像</span></button>` : ''}
      ${!m.hasThumb && !m.offloaded && (m.kind === 'image' || m.kind === 'video') ? `<button class="btn" data-d="mkthumb">${ic('image')}<span>サムネを作る</span></button>` : ''}
      ${m.kind === 'image' && !m.offloaded ? `<button class="btn" data-d="compress">${ic('compress')}<span>画像を軽く</span></button>` : ''}
      ${m.offloaded
      ? `${m.sourceUrl ? `<button class="btn primary" data-d="restore">${ic('cloud')}<span>再ダウンロード</span></button>` : ''}<button class="btn" data-d="pickfile">${ic('upload')}<span>ファイルを選んで戻す</span></button>`
      : `<button class="btn" data-d="offload">${ic('cloud')}<span>容量を空ける</span></button><button class="btn" data-d="export">${ic('share')}<span>iPhoneに書き出す</span></button>`}
      ${m.trashed ? `<button class="btn" data-d="untrash">${ic('restore')}<span>ゴミ箱から戻す</span></button><button class="btn danger" data-d="purge">${ic('trash')}<span>完全に削除</span></button>`
      : `<button class="btn danger ghost" data-d="trash">${ic('trash')}<span>ゴミ箱へ</span></button>`}
    </div></div>`;
}
function openDetail(id) {
  const m = S.items.get(id); if (!m) return;
  const s = sheet({ title: '詳細', body: '', tall: true, onClose: () => { if (S.detailRefresh === draw) S.detailRefresh = null; updateTile(id); } });
  const draw = () => {
    if (!S.items.has(id)) { s.close(); return; }
    s.body.innerHTML = detailHTML(m);
    if (m.hasThumb) thumbURL(id).then(u => { const i = $('.d-thumb img', s.body); if (i && u) i.src = u; });
  };
  S.detailRefresh = draw; draw();
  s.body.addEventListener('change', async e => {
    const f = e.target.dataset.f; if (!f) return;
    const v = e.target.value;
    if (f === 'name') { if (!v.trim()) { e.target.value = m.name; return; } m.name = v.trim(); }
    else m.memo = v;
    await saveItem(m);
  });
  s.body.addEventListener('click', async e => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    switch (b.dataset.d) {
      case 'genre': { const g = await chooseIn('genres', m.genre); if (g != null) { m.genre = g || null; await saveItem(m); draw(); } break; }
      case 'folder': { const f = await chooseIn('folders', m.folder); if (f != null) { m.folder = f || null; await saveItem(m); draw(); } break; }
      case 'tags': { const r = await pickTags(m.tags || []); if (r) { m.tags = r.tags; await saveItem(m); draw(); } break; }
      case 'fav': m.fav = !m.fav; await saveItem(m); draw(); break;
      case 'copyurl': try { await navigator.clipboard.writeText(m.sourceUrl); toast('コピーした'); } catch { toast('コピーできなかった'); } break;
      case 'pickthumb': pickVideoThumb(m); break;
      case 'cover': pickCover(m); break;
      case 'mkthumb': {
        HUD.show('サムネを作ってる…'); const blob = await loadBody(m);
        if (blob) { await makeThumbFor(m, blob); await saveItem(m); }
        HUD.hide(); toast(m.hasThumb ? 'サムネを作った' : 'この形式はサムネを作れなかった'); draw(); break;
      }
      case 'compress': await compressImages([id]); draw(); break;
      case 'offload': await offloadItems([id]); draw(); break;
      case 'restore': await restoreItems([id]); draw(); break;
      case 'pickfile': pickFileFor(m); break;
      case 'export': exportItems([id]); break;
      case 'trash': s.close(); trashItems([id]); break;
      case 'untrash': await untrashItems([id]); draw(); break;
      case 'purge': if (await purgeItems([id])) { s.close(); closeViewer(); } break;
    }
  });
}
async function pickVideoThumb(m) {
  if (m.offloaded) { toast('再ダウンロード待ちの間は選べない（今のサムネはそのまま）'); return; }
  HUD.show('動画を準備中…');
  const blob = await loadBody(m, p => HUD.show('動画を準備中…', p)); HUD.hide();
  if (!blob) { toast('本体が見つからない'); return; }
  const url = URL.createObjectURL(blob);
  const body = el(`<div class="thumbpick"><video playsinline muted preload="auto" src="${url}"></video>
    <input type="range" min="0" max="1000" value="0" class="range" aria-label="場面">
    <div class="tp-row"><button class="btn sm ghost" data-tp="-1">−1秒</button><button class="btn sm ghost" data-tp="-0.1">−0.1</button><span class="muted" data-time>0:00</span><button class="btn sm ghost" data-tp="0.1">+0.1</button><button class="btn sm ghost" data-tp="1">+1秒</button></div>
    <p class="muted small">スライダーで気になった場面を探して「この場面にする」。再ダウンロードや容量を空けてもサムネは変わらない。</p></div>`);
  const v = $('video', body), r = $('input', body), tl = $('[data-time]', body);
  const show = () => { tl.textContent = fmtTime(v.currentTime); if (v.duration) r.value = v.currentTime / v.duration * 1000; };
  v.addEventListener('loadedmetadata', () => { const p = v.play(); if (p) p.then(() => v.pause()).catch(() => { }); try { v.currentTime = m.thumbTime || 0; } catch { } });
  v.addEventListener('seeked', show); v.addEventListener('timeupdate', show);
  r.addEventListener('input', () => { if (v.duration) v.currentTime = r.value / 1000 * v.duration; });
  body.addEventListener('click', e => { const b = e.target.closest('[data-tp]'); if (b && v.duration) v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + parseFloat(b.dataset.tp))); });
  sheet({
    title: 'サムネを選ぶ', body, tall: true,
    onClose: () => { v.pause(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); },
    actions: [{ label: 'キャンセル' }, {
      label: 'この場面にする', kind: 'primary', onClick: async () => {
        try {
          const b = await frameToThumb(v, v.videoWidth, v.videoHeight, 480);
          await saveThumb(m.id, b); m.hasThumb = true; m.thumbTime = v.currentTime; m.customThumb = true;
          await saveItem(m); toast('サムネを変えた'); S.detailRefresh && S.detailRefresh(); updateTile(m.id);
        } catch (e) { toast('取れなかった: ' + e.message); return false; }
      }
    }]
  });
}
function pickCover(m) {
  const imgs = [...S.items.values()].filter(x => x.kind === 'image' && x.hasThumb && !x.trashed).sort((a, b) => b.added - a.added);
  const body = el(`<div>
    <button class="btn block" data-cv="file">${ic('upload')}<span>iPhoneの写真・ファイルから選ぶ</span></button>
    <p class="muted small" style="margin:14px 0 8px">HAKOに保存してある画像から選ぶ：</p>
    ${imgs.length ? `<div class="grid mini-grid">${imgs.map(x => `<div class="tile" data-cv-id="${x.id}"><div class="ph">${ic('image')}</div><img alt="" data-thumb="${x.id}"></div>`).join('')}</div>` : '<p class="muted">画像がまだない</p>'}
    ${m.hasThumb ? `<button class="btn ghost danger block" style="margin-top:14px" data-cv="none">カバーを外す</button>` : ''}</div>`);
  const s = sheet({ title: 'カバー画像', body, tall: true });
  observeThumbs(body);
  const done = async () => { await saveItem(m); s.close(); toast('カバーを設定した'); S.detailRefresh && S.detailRefresh(); updateTile(m.id); if (Player.id === m.id) Player.ui(); };
  body.addEventListener('click', async e => {
    const t = e.target.closest('[data-cv-id]');
    if (t) {
      const r = await DB.get('thumbs', t.dataset.cvId); if (!r) return;
      await DB.put('thumbs', { ...r, id: m.id }); dropThumbCache(m.id);
      m.hasThumb = true; m.coverFrom = t.dataset.cvId; await done(); return;
    }
    const b = e.target.closest('[data-cv]'); if (!b) return;
    if (b.dataset.cv === 'file') pickFiles('image/*', false, async fs => {
      try { const r = await imageThumb(fs[0], 640); await saveThumb(m.id, r.thumb); m.hasThumb = true; await done(); }
      catch (err) { toast('読み込めなかった: ' + err.message); }
    });
    if (b.dataset.cv === 'none') { await DB.del('thumbs', m.id); dropThumbCache(m.id); m.hasThumb = false; await saveItem(m); s.close(); S.detailRefresh && S.detailRefresh(); updateTile(m.id); }
  });
}

/* ================= 追加 ================= */
function openAdd() {
  if (S.view === 'sites') { editSite(null); return; }
  const st = S.conf.settings;
  const o = {
    dest: st.saveDest,
    folder: S.f.folder !== 'all' && S.f.folder !== 'none' ? S.f.folder : null,
    genre: S.f.genre !== 'all' && S.f.genre !== 'fav' ? S.f.genre : null,
    tags: []
  };
  const body = el(`<div class="addsheet">
    <button class="big-opt" data-add="photos">${ic('image', 'lg')}<span><b>写真ライブラリから</b><small>複数まとめてOK（iOSが形式を変換することがある）</small></span></button>
    <button class="big-opt" data-add="files">${ic('file', 'lg')}<span><b>ファイルアプリから</b><small>動画・音声・PDFなど何でも。元のまま入る</small></span></button>
    <div class="lbl">URLから（1行に1つ・複数同時OK）</div>
    <textarea class="field" rows="3" placeholder="https://… を貼り付け" data-urls></textarea>
    <div class="row"><button class="btn sm ghost" data-add="paste">${ic('copy')}<span>貼り付け</span></button><div class="sp"></div><button class="btn sm primary" data-add="url">${ic('download')}<span>ダウンロード</span></button></div>
    <p class="muted small">画像・動画のURLならすぐ開始。ページのURLなら中の画像・動画を探して一覧にする（チェックで選べる）。ブックマークレットでコピーした一覧もここに貼れる。</p>
    <div class="lbl">URLからの保存先</div>
    <div class="seg" data-dest><button data-v="app">${ic('lock')}HAKOの中（暗号化）</button><button data-v="device">${ic('file')}iPhoneのファイルへ</button></div>
    <div class="lbl">入れる場所（任意）</div>
    <div class="row wrap"><button class="btn sm ghost" data-add="folder">${ic('folder')}<span data-lab="folder"></span></button><button class="btn sm ghost" data-add="genre">${ic('grid')}<span data-lab="genre"></span></button><button class="btn sm ghost" data-add="tags">${ic('tag')}<span data-lab="tags"></span></button></div>
  </div>`);
  const labels = () => {
    $('[data-lab=folder]', body).textContent = folderName(o.folder) || 'フォルダ: 未分類';
    $('[data-lab=genre]', body).textContent = genreName(o.genre) || 'ジャンル: なし';
    $('[data-lab=tags]', body).textContent = o.tags.length ? 'タグ ' + o.tags.length + '個' : 'タグ: なし';
    $$('[data-dest] button', body).forEach(b => b.classList.toggle('on', b.dataset.v === o.dest));
  };
  labels();
  const s = sheet({ title: '追加', body, tall: true });
  const ta = $('[data-urls]', body);
  const afterImport = r => {
    toast([r.out.length ? `${r.out.length}件を追加した` : '', r.filled ? `${r.filled}件は容量を空けてあった同じものに本体を戻した` : '', r.dup ? `${r.dup}件は同じものがあるのでスキップ` : '', r.fail ? `${r.fail}件失敗` : ''].filter(Boolean).join('・'), { ms: 4000 });
    const warned = r.out.filter(m => m.warn).length;
    if (warned) setTimeout(() => toast(`${warned}件は中身が拡張子と違う（「!」マーク）。詳細で確認できる`, { ms: 5000 }), 4200);
    if (S.view !== 'lib') go('lib'); else refresh();
  };
  body.addEventListener('click', async e => {
    const d = e.target.closest('[data-v]');
    if (d && d.closest('[data-dest]')) { o.dest = d.dataset.v; labels(); return; }
    const b = e.target.closest('[data-add]'); if (!b) return;
    switch (b.dataset.add) {
      case 'photos': pickFiles('image/*,video/*', true, async fs => { s.close(); afterImport(await importFiles(fs, o)); }); break;
      case 'files': pickFiles('', true, async fs => { s.close(); afterImport(await importFiles(fs, o)); }); break;
      case 'paste':
        try { ta.value = (ta.value ? ta.value + '\n' : '') + await navigator.clipboard.readText(); }
        catch { toast('貼り付けできなかった。欄を長押しして「ペースト」して'); ta.focus(); }
        break;
      case 'url': if (startFromText(ta.value, o)) s.close(); break;
      case 'folder': { const f = await chooseIn('folders', o.folder); if (f != null) { o.folder = f || null; labels(); } break; }
      case 'genre': { const g = await chooseIn('genres', o.genre); if (g != null) { o.genre = g || null; labels(); } break; }
      case 'tags': { const r = await pickTags(o.tags); if (r) { o.tags = r.tags; labels(); } break; }
    }
  });
}
function startFromText(text, o) {
  if (S.conf.settings.offline) { toast('オフラインモード中。上の「オフライン」を押すとオンラインに戻る'); return false; }
  let lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean), title = '';
  if (lines[0] === 'HAKO-LIST') { title = lines[1] || ''; lines = lines.slice(2); }
  const urls = [...new Set(lines.join('\n').match(/https?:\/\/[^\s"'<>]+/g) || [])];
  if (!urls.length) { toast('URLが見つからない'); return false; }
  if (urls.length === 1 && !title) {
    enqueue(urls, { ...o });
    toast('ダウンロード開始', { action: { label: '転送を見る', fn: () => go('queue') } });
    return true;
  }
  openPicker(urls, { ...o, title });
  return true;
}
/* 見つかった画像・動画をチェックして選ぶ */
function openPicker(urls, meta = {}) {
  urls = [...new Set(urls)].filter(u => /^https?:/i.test(u));
  if (!urls.length) { toast('画像・動画が見つからなかった（JavaScriptで表示するサイトはブックマークレットを使って）', { ms: 5000 }); return; }
  const on = new Set(urls.map((_, i) => i));
  let dest = meta.dest || S.conf.settings.saveDest;
  const defName = (meta.title || hostOf(meta.page || urls[0]) || 'まとめ').slice(0, 60);
  const body = el(`<div class="picker">
    <div class="pk-head"><b data-count></b><div class="sp"></div><button class="btn sm ghost" data-pk="all">全選択</button><button class="btn sm ghost" data-pk="none">全解除</button><button class="btn sm ghost" data-pk="small">小さい画像を外す</button></div>
    <div class="seg" data-pkdest style="margin:8px 0"><button data-v="app">${ic('lock')}HAKOの中</button><button data-v="device">${ic('file')}iPhoneのファイルへ（1つのZIP）</button></div>
    <label class="check-row"><input type="checkbox" data-group ${urls.length > 1 ? 'checked' : ''}><span>新しいフォルダにまとめる</span></label>
    <input class="field" data-gname value="${esc(defName)}" placeholder="フォルダ名 / ZIP名">
    <label class="check-row"><input type="checkbox" data-num ${urls.length > 1 ? 'checked' : ''}><span>ページの順番で番号をつける（001_…）</span></label>
    <p class="muted small">タップでチェックを入れたり外したり。100px未満のアイコン類は最初から外してある。</p>
    <div class="pk-grid">${urls.map((u, i) => {
      const isV = VIDEO_RE.test(u), isA = AUDIO_RE.test(u);
      return `<div class="pk on" data-i="${i}">${isV || isA ? `<div class="pk-v">${ic(isV ? 'film' : 'music', 'lg')}<small>${esc(fileNameFromUrl(u))}</small></div>` : (proxyImg(u) ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(proxyImg(u))}" alt="">` : `<div class="pk-v">${ic('shield', 'lg')}<small>IP保護中のためプレビューなし<br>${esc(fileNameFromUrl(u))}</small></div>`)}<span class="pk-n">${i + 1}</span><span class="pk-c">${ic('check')}</span><span class="pk-sz"></span></div>`;
    }).join('')}</div></div>`);
  const count = () => { $('[data-count]', body).textContent = `${on.size} / ${urls.length} 選択`; $$('.pk', body).forEach(p => p.classList.toggle('on', on.has(+p.dataset.i))); };
  const dlab = () => $$('[data-pkdest] button', body).forEach(b => b.classList.toggle('on', b.dataset.v === dest));
  $$('.pk img', body).forEach(img => {
    const p = img.closest('.pk'), i = +p.dataset.i;
    img.addEventListener('load', () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      $('.pk-sz', p).textContent = `${w}×${h}`;
      if (Math.max(w, h) < 100) { p.dataset.small = '1'; on.delete(i); count(); } else if (Math.max(w, h) < 300) p.dataset.small = '1';
    });
    img.addEventListener('error', () => { $('.pk-sz', p).textContent = 'プレビュー不可'; img.remove(); p.insertAdjacentHTML('afterbegin', `<div class="pk-v">${ic('file', 'lg')}<small>${esc(fileNameFromUrl(urls[i]))}</small></div>`); });
  });
  count(); dlab();
  body.addEventListener('click', e => {
    const p = e.target.closest('.pk');
    if (p) { const i = +p.dataset.i; on.has(i) ? on.delete(i) : on.add(i); count(); return; }
    const b = e.target.closest('[data-pk]');
    if (b) {
      if (b.dataset.pk === 'all') urls.forEach((_, i) => on.add(i));
      if (b.dataset.pk === 'none') on.clear();
      if (b.dataset.pk === 'small') $$('.pk[data-small]', body).forEach(x => on.delete(+x.dataset.i));
      count(); return;
    }
    const d = e.target.closest('[data-v]'); if (d) { dest = d.dataset.v; dlab(); }
  });
  sheet({
    title: meta.title ? `見つかった：${meta.title}` : 'ダウンロードするものを選ぶ', body, tall: true,
    actions: [{ label: 'キャンセル' }, {
      label: 'ダウンロード', kind: 'primary', icon: 'download', onClick: () => {
        const sel = urls.filter((_, i) => on.has(i));
        if (!sel.length) { toast('1つも選ばれてない'); return false; }
        const group = $('[data-group]', body).checked, gname = $('[data-gname]', body).value.trim() || defName;
        let folder = meta.folder || null;
        if (group && dest === 'app') { const f = { id: uid(), name: gname }; S.conf.folders.push(f); saveConf(); folder = f.id; }
        enqueue(sel, { dest, folder, genre: meta.genre, tags: meta.tags, title: gname, number: $('[data-num]', body).checked });
        toast(`${sel.length}件のダウンロード開始`, { action: { label: '転送を見る', fn: () => go('queue') } });
      }
    }]
  });
}

/* ================= 転送 ================= */
function renderQueue() {
  const jobs = Q.jobs.slice().reverse();
  const run = Q.jobs.filter(j => j.status === 'run').length, wait = Q.jobs.filter(j => j.status === 'wait').length;
  const st = { wait: ['待ち', 'download'], run: ['ダウンロード中', 'download'], done: ['完了', 'check'], ready: ['保存待ち', 'share'], err: ['失敗', 'info'], cancel: ['キャンセル', 'x'] };
  $('#main').innerHTML = `<section class="queue">
    <div class="toolrow"><span class="muted small">実行中 ${run}・待ち ${wait}・同時 ${S.conf.settings.concurrency}件</span><div class="sp"></div>
      <button class="btn sm ghost" data-act="q-retry">${ic('restore')}<span>失敗を再試行</span></button><button class="btn sm ghost" data-act="q-clear">${ic('x')}<span>終わったのを消す</span></button></div>
    ${jobs.length ? jobs.map(j => `<div class="qitem s-${j.status}">
      <div class="qicon">${ic(st[j.status][1])}</div>
      <div class="qbody"><div class="qname">${esc(j.name || fileNameFromUrl(j.url))}</div>
        <div class="qsub">${st[j.status][0]}${j.status === 'run' && j.got ? '・' + fmtSize(j.got) : ''}${j.via === 'proxy' ? '・プロキシ経由' : ''}${j.note ? '・' + esc(j.note) : ''}　${esc(hostOf(j.url))}</div>
        ${j.status === 'run' ? `<div class="bar ${j.prog ? '' : 'indet'}"><i style="width:${Math.round(j.prog * 100)}%"></i></div>` : ''}
        ${j.err ? `<div class="qerr">${esc(j.err)}</div>` : ''}</div>
      ${j.status === 'wait' || j.status === 'run' ? `<button class="icon-btn" data-q-cancel="${j.id}" aria-label="キャンセル">${ic('x')}</button>` : ''}
      ${j.status === 'err' || j.status === 'cancel' ? `<button class="icon-btn" data-q-retry="${j.id}" aria-label="再試行">${ic('restore')}</button>` : ''}
      ${j.status === 'done' && j.itemId && S.items.has(j.itemId) ? `<button class="icon-btn" data-q-open="${j.itemId}" aria-label="開く">${ic('right')}</button>` : ''}
    </div>`).join('') : `<div class="empty">${ic('download')}<p>まだ何もない。＋ からURLを貼るとここに出る</p></div>`}
    <details class="info-card"><summary>${ic('info')}ダウンロードできない時</summary><div class="muted small">
      <p>多くのサイトは、他のサイト（HAKO）から直接ファイルを取ることをブラウザの仕組み（CORS）で禁止してる。その場合は「直接ダウンロードを許可していない」と出る。</p>
      <p>対策は3つ：①自分用プロキシ（同梱の proxy-worker.js を自分のCloudflareに置く）を設定に入れる ②iPhoneの「ショートカット」で直接保存して「ファイルアプリから」取り込む（手順は設定の下のほう） ③Safariで一度保存してから取り込む。</p>
      <p>「Webページが返ってきた」と出るのは、直リンク禁止・ログインが必要・期限切れのURLのどれか。変なファイルを入れないように、中身を確かめてから保存してる。YouTubeなどの配信型（ストリーミング）動画は対象外。</p></div></details>
  </section>`;
}

/* ================= サイト ================= */
function renderSites() {
  const f = S.f, q = f.q.trim().toLowerCase(), st = S.conf.settings;
  let arr = S.conf.sites.slice();
  if (f.genre === 'fav') arr = arr.filter(s => s.fav); else if (f.genre !== 'all') arr = arr.filter(s => s.genre === f.genre);
  if (f.tags.length) arr = arr.filter(s => f.tags.every(t => (s.tags || []).includes(t)));
  if (q) arr = arr.filter(s => [s.title, s.url, s.memo || '', ...(s.tags || []).map(t => (tagOf(t) || {}).name || '')].join(' ').toLowerCase().includes(q));
  const by = { added_desc: (a, b) => b.added - a.added, added_asc: (a, b) => a.added - b.added, name_asc: (a, b) => coll.compare(a.title || a.url, b.title || b.url), fav: (a, b) => (b.fav - a.fav) || b.added - a.added };
  arr.sort(by[st.siteSort] || by.added_desc);
  const icons = st.favicons && !st.offline && (!st.privacy || (st.proxy || '').trim());
  $('#main').innerHTML = `<section class="sites">
    <div class="toolrow"><span class="muted small">${arr.length}件</span><div class="sp"></div>
      <button class="btn sm ghost" data-act="tagfilter">${ic('tag')}<span>タグ${f.tags.length ? '(' + f.tags.length + ')' : ''}</span></button>
      <button class="btn sm ghost" data-act="sitesort">${ic('sort')}<span>${esc((SITE_SORTS.find(x => x[0] === st.siteSort) || SITE_SORTS[0])[1])}</span></button></div>
    ${f.tags.length ? `<div class="chips wrap" style="margin-bottom:10px">${f.tags.map(tagOf).filter(Boolean).map(t => `<button class="chip sm on" data-untag="${t.id}">${esc(t.name)} ${ic('x')}</button>`).join('')}</div>` : ''}
    <div class="site-list">${arr.map(s => {
      const h = hostOf(s.url);
      return `<div class="site" data-site="${s.id}">
        <a class="site-main" href="${esc(cleanUrl(s.url))}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
          <span class="av" style="--h:${hue(h)}">${esc((s.title || h).slice(0, 1).toUpperCase())}${icons ? `<img src="${esc(proxyImg('https://' + h + '/favicon.ico'))}" referrerpolicy="no-referrer" alt="" data-fav>` : ''}</span>
          <span class="site-txt"><b>${s.fav ? '<i class="star">★</i>' : ''}${esc(s.title || h)}</b><small>${esc(h)}${s.genre ? '・' + esc(genreName(s.genre)) : ''}</small>${s.memo ? `<em>${esc(s.memo)}</em>` : ''}${s.tags && s.tags.length ? `<span class="chips wrap mini">${tagChips(s.tags)}</span>` : ''}</span></a>
        <button class="icon-btn" data-site-edit="${s.id}" aria-label="編集">${ic('more')}</button></div>`;
    }).join('') || `<div class="empty">${ic('globe')}<p>${S.conf.sites.length ? 'この条件に合うサイトはない' : '気になったサイトを ＋ から登録'}</p></div>`}</div>
    <details class="info-card" data-favfix><summary>${ic('shield')}広告ブロック・プライバシーについて</summary><div class="muted small">
      <p>HAKOは他のサイトの中身を書き換えられない（ブラウザの安全上の仕組み）から、広告ブロックはHAKOの中では実装できない。サイトはSafariで開く。</p>
      <p>広告ブロックは iPhoneの設定 → アプリ → Safari → 拡張機能 で、コンテンツブロッカー（AdGuard・1Blockerなど）を入れるのが一番効く。iCloud+のプライベートリレーを使うとIPも隠せる。</p>
      <p>HAKOがやってること：登録したサイト一覧は暗号化して端末にだけ保存。リンクは参照元（リファラ）を送らずに開く。サイトのアイコン取得は初期オフ。</p></div></details>
  </section>`;
}
function fixFavicons() { $$('img[data-fav]').forEach(i => i.addEventListener('error', () => i.remove(), { once: true })); }
function editSite(id) {
  const ex = id ? S.conf.sites.find(x => x.id === id) : null;
  const s0 = ex ? { ...ex, tags: [...(ex.tags || [])] } : { id: uid(), url: '', title: '', genre: S.f.genre !== 'all' && S.f.genre !== 'fav' ? S.f.genre : null, tags: [], memo: '', fav: false, added: Date.now() };
  const body = el(`<div>
    <label class="lbl">URL</label><input class="field" type="url" data-u value="${esc(s0.url)}" placeholder="https://example.com" autocomplete="off" autocapitalize="off">
    <label class="lbl">名前</label><input class="field" data-t value="${esc(s0.title)}" placeholder="空ならドメイン名">
    <label class="lbl">メモ・説明</label><textarea class="field" data-m rows="2">${esc(s0.memo || '')}</textarea>
    <div class="kv"><span>ジャンル（タブ）</span><button class="btn sm ghost" data-e="genre"></button></div>
    <div class="kv col"><span>タグ</span><div class="chips wrap" data-tags></div></div>
    <div class="kv"><span>お気に入り</span><button class="switch" data-e="fav"></button></div></div>`);
  const draw = () => {
    $('[data-e=genre]', body).innerHTML = `${esc(genreName(s0.genre) || 'なし')} ${ic('right')}`;
    $('[data-tags]', body).innerHTML = tagChips(s0.tags) + `<button class="chip ghost" data-e="tags">${ic('tag')}編集</button>`;
    $('[data-e=fav]', body).classList.toggle('on', !!s0.fav);
  };
  draw();
  body.addEventListener('click', async e => {
    const b = e.target.closest('[data-e]'); if (!b) return;
    if (b.dataset.e === 'genre') { const g = await chooseIn('genres', s0.genre); if (g != null) { s0.genre = g || null; draw(); } }
    if (b.dataset.e === 'tags') { const r = await pickTags(s0.tags); if (r) { s0.tags = r.tags; draw(); } }
    if (b.dataset.e === 'fav') { s0.fav = !s0.fav; draw(); }
  });
  const acts = [];
  if (ex) acts.push({
    label: '削除', kind: 'danger ghost', onClick: async () => {
      if (!(await confirmDlg('サイトを削除', `「${ex.title || hostOf(ex.url)}」を一覧から消す？`, '削除', true))) return false;
      S.conf.sites = S.conf.sites.filter(x => x.id !== ex.id); saveConf(); render();
    }
  });
  acts.push({ label: 'キャンセル' }, {
    label: '保存', kind: 'primary', onClick: () => {
      let u = $('[data-u]', body).value.trim();
      if (!u) { toast('URLを入れて'); return false; }
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      u = cleanUrl(u);
      try { new URL(u); } catch { toast('URLの形が正しくない'); return false; }
      Object.assign(s0, { url: u, title: $('[data-t]', body).value.trim(), memo: $('[data-m]', body).value.trim() });
      if (ex) Object.assign(ex, s0); else S.conf.sites.push(s0);
      saveConf(); render(); toast(ex ? '更新した' : '登録した');
    }
  });
  sheet({ title: ex ? 'サイトを編集' : 'サイトを登録', body, tall: true, actions: acts });
  if (!ex) setTimeout(() => $('[data-u]', body).focus(), 300);
}

/* ================= 設定 ================= */
const seg = (k, opts, cur) => `<div class="seg">${opts.map(([v, l]) => `<button class="${String(cur) === String(v) ? 'on' : ''}" data-seg="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
const swc = (k, v) => `<button class="switch ${v ? 'on' : ''}" data-sw="${k}" aria-label="${k}"></button>`;
const sel = (k, opts, cur) => `<select class="field sel" data-set="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const srow = (label, ctl, note = '', col = false) => `<div class="srow ${col ? 'col' : ''}"><div class="sl"><b>${label}</b>${note ? `<small>${note}</small>` : ''}</div>${ctl}</div>`;
const group = (t, rows) => `<div class="group"><h4>${t}</h4><div class="gcard">${rows.join('')}</div></div>`;
function bookmarkletCode() {
  const f = function () {
    var s = new Set(); var A = function (u) { try { if (u && !/^(data|blob):/.test(u)) s.add(new URL(u.trim(), location.href).href); } catch (e) { } };
    document.querySelectorAll('img').forEach(function (i) { var b = i.currentSrc || i.src, m = -1; var ss = i.getAttribute('srcset') || i.getAttribute('data-srcset'); if (ss) ss.split(',').forEach(function (p) { var q = p.trim().split(/\s+/); var n = parseFloat(q[1]) || 1; if (q[0] && n > m) { m = n; b = q[0]; } }); A(i.getAttribute('data-src') || i.getAttribute('data-original') || i.getAttribute('data-lazy-src') || b); });
    document.querySelectorAll('video,video source,audio,audio source').forEach(function (v) { A(v.currentSrc || v.src); });
    document.querySelectorAll('a[href]').forEach(function (a) { if (/\.(jpe?g|png|gif|webp|avif|heic|mp4|mov|m4v|webm|mp3|m4a|wav|aac|flac|ogg)([?#]|$)/i.test(a.href)) A(a.href); });
    var t = 'HAKO-LIST\n' + document.title + '\n' + Array.from(s).join('\n');
    var ok = function () { alert(s.size + '件のURLをコピーした。HAKOの＋→URL欄に貼り付けて'); };
    var ng = function () { prompt('全部選んでコピーして', t); };
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(ok, ng); else ng();
  };
  return 'javascript:(' + f.toString().replace(/\n\s*/g, ' ') + ')()';
}
async function renderSettings() {
  const st = S.conf.settings, c = S.conf;
  const nTrash = [...S.items.values()].filter(m => m.trashed).length;
  const body = [...S.items.values()].reduce((a, m) => a + (m.offloaded ? 0 : m.size || 0), 0);
  $('#main').innerHTML = `<section class="settings">
  ${group('表示', [
    srow('テーマ', seg('theme', [['dark', 'ダーク'], ['light', 'ライト'], ['auto', '自動（端末に合わせる）']], st.theme), '', true),
    srow('アクセント色', `<div class="swatches">${ACCENTS.map(a => `<button class="sw ${a === st.accent ? 'on' : ''}" style="--c:${a}" data-accent="${a}" aria-label="${a}"></button>`).join('')}</div>`, '', true),
    srow('グリッドの列', seg('grid', [[2, '2'], [3, '3'], [4, '4'], [5, '5']], st.grid)),
    srow('サムネに名前を表示', swc('names', st.names)),
    srow('ライブラリの並び順（初期）', sel('sort', SORTS, st.sort)),
    srow('再生速度', sel('rate', [[0.75, '0.75x'], [1, '1x'], [1.25, '1.25x'], [1.5, '1.5x'], [2, '2x']], st.rate), '動画・音声。ビューアのボタンでも変えられる'),
    srow('スライドショーの間隔', sel('slideSec', [[2, '2秒'], [3, '3秒'], [5, '5秒'], [8, '8秒']], st.slideSec)),
  ])}
  ${group('保存', [
    srow('URLからの保存先（初期）', seg('saveDest', [['app', 'HAKOの中（暗号化）'], ['device', 'iPhoneのファイルへ']], st.saveDest), '', true),
    srow('画像を軽くする：長辺', sel('imgMax', [[1600, '1600px'], [2048, '2048px'], [2560, '2560px'], [3840, '3840px']], st.imgMax)),
    srow('画像を軽くする：画質', sel('imgQ', [[0.7, '70%'], [0.82, '82%'], [0.9, '90%']], st.imgQ)),
    srow('同じものは取り込まない', swc('dupSkip', st.dupSkip), '中身が同じファイル・同じURLはスキップする'),
    srow('書き出す写真から位置情報を消す', swc('stripMeta', st.stripMeta), 'JPEGの位置情報・機種・撮影日時などを消してから書き出す（向きは保つ）。HAKOの中の元データとバックアップはそのまま'),
    srow('同じ名前は番号を付ける', swc('autoNumber', st.autoNumber), '中身が違うのに名前が同じものは、後から入ったほうを「名前 (2).jpg」にする'),
    srow('今ある同じ名前を整理', `<button class="btn sm ghost" data-act="fixnames">${ic('edit')}<span>整理</span></button>`, '既に同じ名前で並んでるものに番号を付ける（一番古いものはそのまま）'),
    srow('重複を探す', `<button class="btn sm ghost" data-act="dups">${ic('copy')}<span>探す</span></button>`, '既に入ってる中から、中身が同じものを見つけて選択する'),
  ])}
  ${group('ネット', [
    srow('オフラインモード', swc('offline', st.offline), 'ONの間、HAKOは一切通信しない（ダウンロード・再DL・アイコン取得も止まる）。見るだけならオフラインで十分'),
    srow('IPを相手サイトに見せない', swc('privacy', st.privacy), 'ONにすると、ダウンロードもプレビューもアイコンも必ず自分用プロキシ経由。相手に見えるのはCloudflareのIP。プロキシ未設定の間は取りに行かない'),
    srow('追跡用パラメータを消す', swc('stripTrack', st.stripTrack), '登録するサイトのURLから utm_〜 や fbclid などの追跡用の部分を消す'),
    srow('アプリの自動更新確認', swc('autoUpdate', st.autoUpdate), 'OFFにすると開くたびにGitHubへ問い合わせない（下のボタンで手動更新）。ただしブラウザ自体が1日1回ほどsw.jsを確認することはある'),
    srow('今すぐ更新を確認', `<button class="btn sm ghost" data-act="update">${ic('restore')}<span>確認</span></button>`),
    srow('同時ダウンロード数', seg('concurrency', [[1, '1'], [2, '2'], [3, '3'], [5, '5']], st.concurrency)),
    srow('サイトのアイコンを表示', swc('favicons', st.favicons), 'ONにすると各サイトにアイコンを取りに行く（そのサイトに通信が届く）'),
    srow('自分用プロキシURL（任意）', `<input class="field" data-set="proxy" value="${esc(st.proxy)}" placeholder="https://hako-proxy.○○.workers.dev" autocapitalize="off">`, '直接ダウンロードを断るサイト用。同梱の proxy-worker.js を自分のCloudflareに置いた時だけ使う', true),
    srow('プロキシのキー', `<input class="field" type="password" data-set="proxyKey" value="${esc(st.proxyKey)}" autocomplete="off">`, '', true),
  ])}
  ${group('セキュリティ', [
    srow('自動ロック', sel('autolock', [[0, '離れたらすぐ'], [1, '1分後'], [5, '5分後'], [15, '15分後'], [60, '1時間後'], [-1, 'しない']], st.autolock), 'アプリを離れてから戻った時にロック'),
    srow('アプリ切替時に画面を隠す', swc('blurOnHide', st.blurOnHide)),
    srow('Face ID で開く', `<button class="btn sm ${S.hasBio ? 'danger ghost' : 'primary'}" data-act="${S.hasBio ? 'bio-off' : 'bio-on'}">${S.hasBio ? 'オフにする' : 'オンにする'}</button>`, 'パスキーで鍵を守る方式（iOS 18以降が目安）。非対応なら、パスワードを「パスワード」アプリに保存すればFace IDで自動入力できる'),
    srow('パスワードを変える', `<button class="btn sm ghost" data-act="chpw">${ic('key')}<span>変更</span></button>`),
    srow('今すぐロック', `<button class="btn sm ghost" data-act="lock">${ic('lock')}<span>ロック</span></button>`),
  ])}
  ${group('整理', [
    srow('ジャンル（タブ）', `<button class="btn sm ghost" data-act="manage" data-list="genres">${c.genres.length}個 ${ic('right')}</button>`, '名前変更・並べ替え・削除'),
    srow('フォルダ', `<button class="btn sm ghost" data-act="manage" data-list="folders">${c.folders.length}個 ${ic('right')}</button>`),
    srow('タグ', `<button class="btn sm ghost" data-act="manage" data-list="tags">${c.tags.length}個 ${ic('right')}</button>`, '色も変えられる'),
    srow('ゴミ箱', `<button class="btn sm ghost" data-act="open-trash">${nTrash}件 ${ic('right')}</button>`, '自分で空にするまで消えない'),
  ])}
  ${group('データ', [
    srow('使用量', `<span class="muted small" data-storage>計算中…</span>`, `HAKOの中身 ${fmtSize(body)}・${S.items.size}件（サムネ・メタ情報を除く）`),
    srow('消されにくくする', `<span class="muted small" data-persist>確認中</span>`, 'iOSに「勝手に消さないで」と頼む（永続ストレージ）。ホーム画面アプリだと通りやすい'),
    srow('バックアップを書き出す', `<button class="btn sm primary" data-act="backup">${ic('download')}<span>全部</span></button>`, '暗号化されたまま1つのZIPに。iCloud Driveに置けば別の端末へ移せる。大きい時はライブラリで選択→「バックアップ」で分けて'),
    srow('バックアップを読み込む', `<button class="btn sm ghost" data-act="restore">${ic('upload')}<span>読み込む</span></button>`, '足りないものだけ追加する（今あるものは上書きしない）'),
    srow('最後のバックアップ', `<span class="muted small">${S.conf.lastBackup ? fmtDate(S.conf.lastBackup) : 'まだ'}</span>`),
    srow('バックアップのお知らせ', sel('backupRemind', [[7, '7日ごと'], [14, '14日ごと'], [30, '30日ごと'], [0, 'しない']], st.backupRemind)),
    srow('データを点検', `<button class="btn sm ghost" data-act="check">${ic('shield')}<span>点検</span></button>`, '本体が全部そろってるか、ちゃんと復号できるかを確かめる。問題があれば印を付ける（消さない）'),
  ])}
  ${group('ウイルス・変なファイル対策', [srow('', `<ul class="limits">
    <li><b>中で実行しない</b>：HAKOは保存したファイルを実行しない。写真・動画・音声は表示・再生するだけ。それ以外は暗号化された「ただのデータ」としてしまっておく</li>
    <li><b>中身で判定</b>：拡張子じゃなく中身を見る。「.jpgなのに中身はWebページ」は保存しないで理由を出す。拡張子と違えば「!」マーク</li>
    <li><b>隔離</b>：実行ファイル・スクリプト・Webページ・マクロ付きOffice・ディスクイメージなどは🛡マークで隔離。HAKOの中ではテキストとしてしか見られない。書き出す時は警告が出る</li>
    <li><b>ブラウザの守り</b>：HAKOのページは自分のファイル以外のスクリプトを一切読み込まない設定（CSP）。保存データを流す時も「解釈しない・実行しない」指定を付けてる</li>
    <li><b>iPhoneの守り</b>：iPhoneはアプリが互いに隔離されてて、App Store以外のアプリは入らない。Windows用やAndroid用のウイルスはiPhoneでは動かない</li>
    <li><b>注意</b>：隔離ファイルをパソコンに書き出して開く時は、そのパソコンで危なくなりうる。必要な時だけにして、ウイルス対策ソフトのあるパソコンで</li></ul>`, '', true)])}
  ${group('IP・ログを残したくない時', [srow('', `<ul class="limits">
    <li><b>相手サイト</b>：取りに行く通信は必ず相手に届く。直接だと自分のIPが相手のログに残る。「IPを相手サイトに見せない」をONにすると、相手に残るのはCloudflareのIPだけ</li>
    <li><b>Cloudflare（自分用プロキシ）</b>：中継するので通信は通る。proxy-worker.jsはログを書かない。ダッシュボードの「Logs / Observability」はOFFのままにしておく。Workerの名前（○○.workers.dev）は相手に伝わることがあるので、本名やIDを入れない適当な名前に</li>
    <li><b>GitHub</b>：アプリを開く・更新する時にGitHubに通信が行く。「自動更新確認」をOFFにすると最小限になる。写真や動画のデータは一切行かない</li>
    <li><b>HAKO自体</b>：サーバーがないので、どこにも履歴は送らない。中身は全部端末の中で暗号化</li>
    <li><b>サイトを開く時（Safari）</b>：HAKOからは隠せない。VPNアプリ（例：Proton VPN など、ログを残さない方針で無料プランがあるもの）をONにすると、Safariも含めて端末の通信全部のIPが隠れる。Alohaの内蔵VPNと同じ役割</li></ul>`, '', true)])}
  ${group('Alohaみたいに直接保存したい時（ショートカット）', [srow('', `<p class="muted small" style="margin:0">Alohaはアプリ本体がブラウザだから制限なく直接落とせる。HAKOはSafariの中で動くWebアプリなので、他のサイトから直接取るのをブラウザが止める（だからプロキシが要る）。iPhoneの「ショートカット」アプリを使うと、プロキシなしで直接保存できる：</p>
    <ol class="steps"><li>ショートカットアプリ → ＋ → 「共有シートに表示」をON、受け取る種類を「SafariのWebページ」「URL」に</li>
    <li>アクション「入力から画像を取得」（ページ内の画像をまとめて取る）→「ファイルを保存」（保存先：ファイルアプリに作ったフォルダ「HAKO受け取り」など、「保存先を尋ねる」はOFF）</li>
    <li>動画など直リンクを落とすなら「URLの内容を取得」→「ファイルを保存」</li>
    <li>Safariで共有 → そのショートカット → 保存されたら、HAKOの＋ →「ファイルアプリから」でフォルダの中を全部選んで取り込む（取り込んだあと元ファイルは消してOK）</li></ol>
    <p class="muted small">アクション名はiOSのバージョンで少し違うことがある。ショートカットは端末から直接取りに行くので、IPを隠すならVPNと一緒に使う。</p>`, '', true)])}
  ${group('ブックマークレット（ページの画像・動画をまとめて拾う）', [
    srow('', `<div class="bm"><code>${esc(bookmarkletCode().slice(0, 70))}…</code><button class="btn sm primary" data-act="bm-copy">${ic('copy')}<span>コピー</span></button></div>
    <ol class="steps"><li>上の「コピー」を押す</li><li>Safariで何かのページをブックマーク（名前は「HAKOで拾う」など）</li><li>ブックマークを編集して、URL欄を全部消してペーストして保存</li><li>拾いたいページを開いて（画像が全部出るまで下までスクロールしておくと確実）、そのブックマークをタップ</li><li>「コピーした」と出たら、HAKOの＋ → URL欄に貼り付け → 一覧でチェックしてダウンロード</li></ol>`, '', true)
  ])}
  ${group('できないこと（正直なところ）', [srow('', `<ul class="limits">
    <li>他のサイトの中に広告ブロックを入れる／サイトのダウンロードボタンを横取りする（ブラウザが禁止）→ Safariのコンテンツブロッカーとブックマークレットで代わりにする</li>
    <li>写真アプリやファイルアプリの元データを消す（Webアプリには権限がない）→ 取り込んだあと自分で消す</li>
    <li>YouTubeなどの配信型動画、ログインが必要なページの画像の取得</li>
    <li>相手サイトに一切記録を残さない保証（取得の通信は相手に届く。Cookieと参照元は送らない。プロキシ経由ならIPはCloudflareのもの）</li>
    <li>端末をまたいだ自動同期（サーバーを置かない設計なので、バックアップZIPで移す）</li>
    <li>iPhoneが再生できない形式（mkv・aviなど）の再生。保存と書き出しはできる</li>
    <li>動画の圧縮（ブラウザだと実用的な速度と画質で作れない）</li>
    <li>大きい動画は「必要な部分だけ復号して流す」方式で再生・書き出しするけど、iPhone実機での速さは端末次第（未検証）。うまくいかない時は自動で通常の方式に切り替える</li>
    <li>1つのZIPは4GBまで（超える分は自動で分ける）</li></ul>`, '', true)])}
  ${group('危険ゾーン', [srow('全データを消す', `<button class="btn sm danger" data-act="wipe">全部消す</button>`, '保管庫ごと消える。元には戻せない')])}
  <p class="ver muted small">HAKO v1.2.1 ・ ${isStandalone ? 'ホーム画面アプリで動作中' : 'ブラウザで動作中（ホーム画面に追加推奨）'} ・ 外部サーバーなし</p>
  </section>`;
  try {
    const e = await navigator.storage.estimate();
    const s1 = $('[data-storage]'); if (s1) s1.textContent = `${fmtSize(e.usage)} / 上限目安 ${fmtSize(e.quota)}`;
    const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const s2 = $('[data-persist]'); if (s2) s2.innerHTML = p ? `<b style="color:var(--ok)">OK</b>` : `<button class="btn sm ghost" data-act="persist">頼む</button>`;
  } catch { const s1 = $('[data-storage]'); if (s1) s1.textContent = '取得できない'; }
}
function setSetting(k, v) {
  const d = DEFAULTS[k];
  if (typeof d === 'number') v = Number(v);
  else if (typeof d === 'boolean') v = v === true || v === 'true';
  S.conf.settings[k] = v; saveConf();
  if (['theme', 'accent', 'grid'].includes(k)) applyTheme();
  if (k === 'sort') S.f.sort = v;
  if (k === 'offline') toast(v ? 'オフラインモードにした' : 'オンラインにした');
  if (k === 'autoUpdate') SW.flags();
  if (k === 'privacy' && v && !(S.conf.settings.proxy || '').trim()) toast('プロキシが未設定だから、今はダウンロードできない状態。設定 → ネットでプロキシを入れて', { ms: 5000 });
  const y = scrollY; render(); scrollTo(0, y);
}
function manageList(kind) {
  const label = { genres: 'ジャンル', folders: 'フォルダ', tags: 'タグ' }[kind];
  const used = id => kind === 'genres'
    ? [...S.items.values()].filter(m => m.genre === id).length + S.conf.sites.filter(s => s.genre === id).length
    : kind === 'folders' ? [...S.items.values()].filter(m => m.folder === id).length
      : [...S.items.values()].filter(m => (m.tags || []).includes(id)).length + S.conf.sites.filter(s => (s.tags || []).includes(id)).length;
  const body = el('<div class="manage"></div>');
  const draw = () => {
    const arr = S.conf[kind];
    body.innerHTML = (arr.map((x, i) => `<div class="mrow" data-id="${x.id}">
      ${kind === 'tags' ? `<button class="dot big" style="--tc:${x.color}" data-m="color" aria-label="色"></button>` : ic(kind === 'folders' ? 'folder' : 'grid')}
      <span class="mname">${esc(x.name)}</span><small class="muted">${used(x.id)}件</small>
      <button class="icon-btn" data-m="up" ${i ? '' : 'disabled'} aria-label="上へ">${ic('up')}</button>
      <button class="icon-btn" data-m="rename" aria-label="名前変更">${ic('edit')}</button>
      <button class="icon-btn" data-m="del" aria-label="削除">${ic('trash')}</button></div>`).join('') || `<p class="muted">まだない</p>`)
      + `<button class="btn block" style="margin-top:14px" data-m="add">${ic('plus')}<span>${label}を追加</span></button>`;
  };
  draw();
  sheet({ title: label + 'の管理', body, tall: true, onClose: () => render() });
  body.addEventListener('click', async e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const arr = S.conf[kind], row = b.closest('[data-id]'), idx = row ? arr.findIndex(y => y.id === row.dataset.id) : -1, x = arr[idx];
    switch (b.dataset.m) {
      case 'add': { const n = await promptDlg(label + 'を追加', '', '名前'); if (n) { arr.push(kind === 'tags' ? { id: uid(), name: n, color: pickColor(arr.length) } : { id: uid(), name: n }); saveConf(); } break; }
      case 'rename': { const n = await promptDlg('名前を変える', x.name); if (n) { x.name = n; saveConf(); } break; }
      case 'up': if (idx > 0) { arr.splice(idx - 1, 0, arr.splice(idx, 1)[0]); saveConf(); } break;
      case 'color': x.color = COLORS[(COLORS.indexOf(x.color) + 1) % COLORS.length]; saveConf(); break;
      case 'del': {
        if (!(await confirmDlg(`${label}を削除`, `「${x.name}」を消す？\n${kind === 'folders' ? '中身は消えずに「未分類」へ移る。' : '付いているものから外れるだけで、中身は消えない。'}`, '削除', true))) return;
        arr.splice(idx, 1);
        for (const m of S.items.values()) {
          let ch = false;
          if (kind === 'genres' && m.genre === x.id) { m.genre = null; ch = true; }
          if (kind === 'folders' && m.folder === x.id) { m.folder = null; ch = true; }
          if (kind === 'tags' && (m.tags || []).includes(x.id)) { m.tags = m.tags.filter(t => t !== x.id); ch = true; }
          if (ch) await saveItem(m);
        }
        S.conf.sites.forEach(s => { if (kind === 'genres' && s.genre === x.id) s.genre = null; if (kind === 'tags') s.tags = (s.tags || []).filter(t => t !== x.id); });
        if (S.f.genre === x.id) S.f.genre = 'all'; if (S.f.folder === x.id) S.f.folder = 'all'; S.f.tags = S.f.tags.filter(t => t !== x.id);
        saveConf(); break;
      }
    }
    draw();
  });
}
function changePassword() {
  const body = el(`<form><input type="text" name="username" autocomplete="username" value="HAKO" class="vh" tabindex="-1">
    <input class="field" type="password" autocomplete="current-password" placeholder="今のパスワード" data-o style="margin-bottom:10px">
    <input class="field" type="password" autocomplete="new-password" placeholder="新しいパスワード（6文字以上）" data-n style="margin-bottom:10px">
    <input class="field" type="password" autocomplete="new-password" placeholder="新しいパスワードをもう一度" data-n2>
    <p class="muted small">中身の暗号鍵はそのままで、鍵の包み方だけ変える（すぐ終わる）。前に作ったバックアップは前のパスワードで開く。</p></form>`);
  body.addEventListener('submit', e => e.preventDefault());
  sheet({
    title: 'パスワードを変える', body, actions: [{ label: 'キャンセル' }, {
      label: '変更', kind: 'primary', onClick: async () => {
        const o = $('[data-o]', body).value, n = $('[data-n]', body).value, n2 = $('[data-n2]', body).value;
        if (n.length < 6) { toast('6文字以上にして'); return false; }
        if (n !== n2) { toast('新しいパスワードが一致しない'); return false; }
        if (!(await unlockWithPassword(o))) { toast('今のパスワードが違う'); return false; }
        const salt = Crypto.rand(16), kek = await Crypto.kekFromPassword(n, salt);
        const v = await DB.get('meta', 'vault');
        await DB.put('meta', { ...v, salt, iter: Crypto.ITER, wrapped: await Crypto.wrap(S.key, kek) });
        toast('変更した。パスワードアプリの保存内容も更新しておいて', { ms: 4500 });
      }
    }]
  });
}
async function doAct(a, elx) {
  switch (a) {
    case 'add-folder': { const n = await promptDlg('新しいフォルダ', '', 'フォルダ名'); if (n) { const f = { id: uid(), name: n }; S.conf.folders.push(f); saveConf(); S.f.folder = f.id; render(); } break; }
    case 'albums': S.f.albums = !S.f.albums; S.conf.settings.albums = S.f.albums; saveConf(); if (S.f.albums) S.f.folder = 'all'; render(); break;
    case 'check': checkData(); break;
    case 'dups': findDups(); break;
    case 'fixnames': {
      const g = new Map();
      [...S.items.values()].filter(m => !m.trashed).sort((a, b) => a.added - b.added).forEach(m => { const k = m.name.toLowerCase(); if (!g.has(k)) g.set(k, []); g.get(k).push(m); });
      let n = 0; const was = S.conf.settings.autoNumber; S.conf.settings.autoNumber = true;
      for (const arr of g.values()) for (const m of arr.slice(1)) { m.name = uniqueItemName(m.name, m.id); releaseName(m.name); await saveItem(m); n++; }
      S.conf.settings.autoNumber = was;
      toast(n ? `${n}件に番号を付けた` : '同じ名前のものはなかった'); render(); break;
    }
    case 'update': {
      HUD.show('更新を確認中…');
      try { const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration(); if (reg) { await reg.update().catch(() => { }); await SW.post({ type: 'refresh' }, 20000); } } finally { HUD.hide(); }
      if (await confirmDlg('更新を確認した', '新しい版があれば、再読み込みで反映される。今すぐ再読み込みする？（ロックされる）', '再読み込み')) location.reload();
      break;
    }
    case 'hide-tip': S.conf.settings.hideHomeTip = true; saveConf(); render(); break;
    case 'exit-trash': S.f.trash = false; exitSelect(); render(); break;
    case 'open-trash': S.f.trash = true; S.view = 'lib'; $$('#bottomNav [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === 'lib')); render(); scrollTo(0, 0); break;
    case 'empty-trash': await purgeItems([...S.items.values()].filter(m => m.trashed).map(m => m.id)); break;
    case 'tagfilter': { const r = await pickTags(S.f.tags, { title: 'タグで絞り込む（全部含むもの）' }); if (r) { S.f.tags = r.tags; render(); } break; }
    case 'sort': { const r = await pickOne('並び順', SORTS.map(([id, name]) => ({ id, name })), S.f.sort, { none: '追加が新しい順（標準）' }); if (r != null) { S.f.sort = r || 'added_desc'; render(); } break; }
    case 'sitesort': { const r = await pickOne('並び順', SITE_SORTS.map(([id, name]) => ({ id, name })), S.conf.settings.siteSort, { none: '追加が新しい順（標準）' }); if (r != null) setSetting('siteSort', r || 'added_desc'); break; }
    case 'q-clear': Q.jobs = Q.jobs.filter(j => j.status === 'wait' || j.status === 'run' || j.status === 'ready'); renderQueue(); updateBadge(); break;
    case 'q-retry': Q.jobs.filter(j => j.status === 'err' || j.status === 'cancel').forEach(j => retryJob(j.id)); break;
    case 'bio-on': bioEnable(); break;
    case 'bio-off': bioDisable(); break;
    case 'chpw': changePassword(); break;
    case 'lock': lock(); break;
    case 'manage': manageList(elx.dataset.list); break;
    case 'persist': { const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; toast(ok ? '永続化された' : 'iOSに断られた。ホーム画面に追加してから試して'); render(); break; }
    case 'backup': exportBackup(null); break;
    case 'restore': pickFiles('', false, async fs => {
      try { const r = await importBackup(fs[0], false); if (r) { toast([`追加 ${r.added}件`, `本体を戻した ${r.restored}件`, r.skipped ? `既にあった ${r.skipped}件` : '', r.dupSkipped ? `中身が同じで飛ばした ${r.dupSkipped}件` : '', r.unselected ? `選ばなかった ${r.unselected}件` : ''].filter(Boolean).join('・') + '。バックアップのZIPはもう消してもOK（また容量を空けたい時のために、PCには残しておくと楽）', { ms: 7000 }); render(); } }
      catch (e) { toast('読み込めなかった: ' + e.message, { ms: 5000 }); }
    }); break;
    case 'bm-copy': try { await navigator.clipboard.writeText(bookmarkletCode()); toast('コピーした。手順どおりブックマークのURLに貼って'); } catch { promptDlg('全部選んでコピーして', bookmarkletCode()); } break;
    case 'wipe': {
      if (!(await confirmDlg('全部消す', '保管庫・写真・動画・サイト・設定、全部消える。バックアップがないと戻せない。', '次へ', true))) return;
      const t = await promptDlg('確認', '', '「けす」と入力', '消す');
      if (t !== 'けす') { toast('やめておいた'); return; }
      Player.stop(); await DB.clear(); try { localStorage.removeItem('hako-ui'); } catch { } location.reload(); break;
    }
  }
}

async function findDups() {
  const ms = [...S.items.values()].filter(m => !m.trashed);
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]; if (m.fp || m.offloaded) continue;
    if (i % 5 === 0) HUD.show(`調べてる ${i + 1}/${ms.length}`, i / ms.length);
    try { const keys = await DB.chunkKeys(m.id); if (!keys.length) continue; const c0 = new Uint8Array(await Crypto.dec(S.key, await DB.get('chunks', keys[0]))); m.fp = await fingerprint(c0.subarray(0, FP_LEN), m.size || 0); await saveItem(m, false); } catch { }
  }
  HUD.hide();
  const g = new Map(); ms.forEach(m => { if (!m.fp) return; if (!g.has(m.fp)) g.set(m.fp, []); g.get(m.fp).push(m); });
  const extra = []; let sets = 0;
  g.forEach(arr => { if (arr.length < 2) return; sets++; arr.sort((a, b) => a.added - b.added).slice(1).forEach(m => extra.push(m.id)); });
  if (!extra.length) { toast('重複は見つからなかった'); return; }
  Object.assign(S.f, { trash: false, genre: 'all', folder: 'all', kind: 'all', tags: [], q: '', albums: false });
  go('lib'); enterSelect(); extra.forEach(id => S.sel.add(id)); renderLib(); renderSelbar();
  toast(`${sets}組の重複。一番古いものは残して、あとから入った${extra.length}件を選択した。消すなら「ゴミ箱へ」`, { ms: 6000 });
}
async function checkData() {
  const ms = [...S.items.values()]; let ok = 0, offl = 0, thumbFix = 0; const bad = [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (i % 5 === 0) HUD.show(`点検中 ${i + 1}/${ms.length}`, i / Math.max(1, ms.length));
    try {
      if (m.hasThumb && !(await DB.get('thumbs', m.id))) { m.hasThumb = false; thumbFix++; await saveItem(m, false); }
      if (m.offloaded) { offl++; continue; }
      const keys = await DB.chunkKeys(m.id), need = Math.max(1, Math.ceil((m.size || 0) / (m.cs || CHUNK)));
      if (keys.length !== need) throw new Error(`本体の一部が欠けてる（${keys.length}/${need}）`);
      await Crypto.dec(S.key, await DB.get('chunks', keys[0]));
      if (keys.length > 1) await Crypto.dec(S.key, await DB.get('chunks', keys[keys.length - 1]));
      if (!m.fp) { const c0 = new Uint8Array(await Crypto.dec(S.key, await DB.get('chunks', keys[0]))); m.fp = await fingerprint(c0.subarray(0, FP_LEN), m.size || 0); if (!m.real) m.real = sniff(c0.subarray(0, 1024)); await saveItem(m, false); }
      if (m.broken) { delete m.broken; await saveItem(m, false); }
      ok++;
    } catch (e) {
      m.broken = e.message || '読めない'; m.offloaded = true; bad.push(m);
      await saveItem(m, false).catch(() => { });
    }
  }
  HUD.hide();
  sheet({
    title: 'データ点検の結果',
    body: `<p><b style="color:var(--ok)">正常 ${ok}件</b>・再DL待ち ${offl}件${thumbFix ? `・サムネ情報を${thumbFix}件修正` : ''}</p>
      ${bad.length ? `<p style="color:var(--danger)"><b>問題あり ${bad.length}件</b>（消してはいない。サムネは残る）</p><ul class="limits">${bad.slice(0, 50).map(m => `<li>${esc(m.name)}：${esc(m.broken)}</li>`).join('')}</ul>
      <p class="muted small">「再ダウンロード待ち」扱いにした。URLから入れたものは「再DL」、それ以外はファイルかバックアップから戻せる。</p>` : '<p class="muted small">全部そろってて、ちゃんと復号できた。</p>'}`,
    actions: bad.length ? [{ label: '問題ありを選択する', kind: 'primary', onClick: () => { Object.assign(S.f, { trash: false, genre: 'all', folder: 'all', kind: 'all', tags: [], q: '', albums: false }); go('lib'); enterSelect(); bad.forEach(m => S.sel.add(m.id)); renderLib(); renderSelbar(); } }] : []
  });
  refresh();
}

/* ================= ビューア ================= */
const V = { ids: [], i: 0, urls: new Map(), token: 0, tapT: null, lastTap: 0 };
function openViewer(ids, i) {
  if (i < 0) return;
  V.ids = ids.slice(); V.i = i;
  const v = $('#viewer'); v.hidden = false; v.classList.remove('nochrome');
  document.body.classList.add('noscroll');
  drawViewer();
}
function stopSlide() { if (V.slide) { clearInterval(V.slide); V.slide = null; } }
function toggleSlide() {
  if (V.slide) { stopSlide(); toast('スライドショーを止めた'); }
  else {
    const sec = S.conf.settings.slideSec || 3;
    V.slide = setInterval(() => { if (V.i < V.ids.length - 1) { V.i++; drawViewer(); } else { stopSlide(); drawViewer(); toast('最後まで見た'); } }, sec * 1000);
    toast(`${sec}秒ごとに次へ`);
  }
  const b = $('#viewer [data-v=slide]'); if (b) { b.classList.toggle('on', !!V.slide); b.innerHTML = ic(V.slide ? 'pause' : 'play') + `<span>${V.slide ? '止める' : 'スライド'}</span>`; }
}
function wireMedia(el, m, stage, tok) {
  el.playbackRate = S.conf.settings.rate || 1; el.defaultPlaybackRate = el.playbackRate;
  attachResume(el, m);
  const p = el.play(); if (p) p.catch(() => { });
  el.addEventListener('error', async () => {
    const u = el.currentSrc || el.src || '';
    if (u.includes('/__hako/s/') && m.size < 400 * 1024 * 1024) {
      try { const b = await loadBody(m); if (tok !== V.token || !b) return; const bu = URL.createObjectURL(b); V.urls.set(m.id, bu); el.src = bu; const q = el.play(); if (q) q.catch(() => { }); return; } catch { }
    }
    if (tok === V.token) stage.insertAdjacentHTML('beforeend', `<div class="v-err small-err">${m.kind === 'video' ? 'この動画' : 'この音声'}の形式はこの端末で再生できないかも。「書き出す」で他のアプリなら開けることがある</div>`);
  }, { once: true });
}
function attachResume(el, m) {
  let last = 0;
  el.addEventListener('loadedmetadata', () => {
    const d = el.duration;
    if (m.pos && isFinite(d) && d > 60 && m.pos > 5 && m.pos < d - 5) {
      try { el.currentTime = m.pos; } catch { }
      toast(`${fmtTime(m.pos)} の続きから`, { action: { label: '最初から', fn: () => { el.currentTime = 0; } } });
    }
  }, { once: true });
  const save = () => {
    if (!S.key || !S.items.has(m.id)) return;
    const d = el.duration; if (!isFinite(d) || d <= 60) return;
    m.pos = el.ended || el.currentTime > d - 5 ? 0 : el.currentTime; saveItem(m, false).catch(() => { });
  };
  el.addEventListener('timeupdate', () => { const n = Date.now(); if (n - last > 10000) { last = n; save(); } });
  el.addEventListener('pause', save); el.addEventListener('ended', save);
}
function closeViewer() {
  stopSlide();
  const v = $('#viewer'); if (!v || v.hidden) return;
  $$('video,audio', v).forEach(x => { try { x.pause(); } catch { } });
  v.hidden = true; v.innerHTML = '';
  document.body.classList.remove('noscroll');
  for (const u of V.urls.values()) revokeURL(u);
  V.urls.clear(); V.token++;
}
function trimViewerCache() {
  const keep = new Set([V.ids[V.i - 1], V.ids[V.i], V.ids[V.i + 1]]);
  for (const [id, u] of V.urls) if (!keep.has(id)) { revokeURL(u); V.urls.delete(id); }
}
async function drawViewer() {
  const v = $('#viewer'), id = V.ids[V.i], m = S.items.get(id);
  if (!m) { closeViewer(); return; }
  const tok = ++V.token;
  $$('video,audio', v).forEach(x => { try { x.pause(); } catch { } });
  const av = m.kind === 'video' || m.kind === 'audio';
  v.innerHTML = `<div class="v-top"><button class="icon-btn glass" data-v="close" aria-label="閉じる">${ic('x')}</button>
      <div class="v-title"><b>${esc(m.name)}</b><span>${V.i + 1} / ${V.ids.length}</span></div>
      <button class="icon-btn glass" data-v="info" aria-label="詳細">${ic('info')}</button></div>
    <div class="v-stage" data-kind="${m.kind}"><div class="v-load"><div class="spin"></div><span class="v-prog"></span></div></div>
    ${V.ids.length > 1 ? `<button class="v-nav prev glass" data-v="prev" ${V.i ? '' : 'disabled'} aria-label="前へ">${ic('left')}</button><button class="v-nav next glass" data-v="next" ${V.i < V.ids.length - 1 ? '' : 'disabled'} aria-label="次へ">${ic('right')}</button>` : ''}
    <div class="v-bottom">
      <button class="vb" data-v="fav">${ic('star', m.fav ? 'fill' : '')}<span>お気に入り</span></button>
      <button class="vb" data-v="export" ${m.offloaded ? 'disabled' : ''}>${ic('share')}<span>書き出す</span></button>
      ${av ? `<button class="vb" data-v="bg" ${m.offloaded ? 'disabled' : ''}>${ic('headphones')}<span>閉じても再生</span></button><button class="vb" data-v="rate">${ic('speed')}<span>${S.conf.settings.rate || 1}x</span></button>` : ''}
      ${m.kind === 'image' && V.ids.length > 1 ? `<button class="vb ${V.slide ? 'on' : ''}" data-v="slide">${ic(V.slide ? 'pause' : 'play')}<span>${V.slide ? '止める' : 'スライド'}</span></button>` : ''}
      ${m.kind === 'video' ? `<button class="vb" data-v="pip" ${m.offloaded ? 'disabled' : ''}>${ic('pip')}<span>PiP</span></button><button class="vb" data-v="frame" ${m.offloaded ? 'disabled' : ''}>${ic('image')}<span>この場面をサムネに</span></button>` : ''}
      <button class="vb" data-v="menu">${ic('more')}<span>その他</span></button></div>`;
  const stage = $('.v-stage', v);
  const tu = m.hasThumb ? await thumbURL(id) : null;
  if (tok !== V.token) return;
  if (tu) { const l = $('.v-load', stage); if (l) l.style.backgroundImage = `url("${tu}")`; }
  if (m.offloaded) {
    stage.innerHTML = `<div class="v-off">${tu ? `<img src="${tu}" alt="">` : `<div class="v-off-ph">${ic(KIND_ICON[m.kind], 'lg')}</div>`}
      <div class="v-off-card">${ic('cloud', 'lg')}<b>再ダウンロード待ち</b><span>容量を空けてある。サムネ・名前・タグはそのまま。</span>
      ${m.sourceUrl ? `<button class="btn primary" data-v="restore">${ic('download')}<span>再ダウンロード</span></button>` : ''}
      <button class="btn" data-v="pickfile">${ic('upload')}<span>ファイルを選んで戻す</span></button></div></div>`;
    return;
  }
  if ((m.kind === 'video' || m.kind === 'audio') && SW.ok() && m.size > STREAM_MIN && !V.urls.has(id)) V.urls.set(id, streamURL(m));
  let url = V.urls.get(id);
  if (!url) {
    try {
      const blob = await loadBody(m, p => { if (tok === V.token) { const e = $('.v-prog', v); if (e) e.textContent = Math.round(p * 100) + '%'; } });
      if (!blob) throw new Error('本体が見つからない');
      if (tok !== V.token) return;
      url = URL.createObjectURL(blob); V.urls.set(id, url); trimViewerCache();
    } catch (e) {
      if (tok === V.token) stage.innerHTML = `<div class="v-err">${ic('info', 'lg')}<b>開けなかった</b><span>${esc(e.message)}</span></div>`;
      return;
    }
  }
  if (tok !== V.token) return;
  if (m.kind === 'image') {
    const tall = m.w && m.h && m.h / m.w > 1.9;
    stage.innerHTML = `<div class="v-scroll ${tall ? 'tall' : ''}"><img src="${url}" alt="" draggable="false"></div>`;
  } else if (m.kind === 'video') {
    stage.innerHTML = `<video src="${url}" controls playsinline webkit-playsinline ${tu ? `poster="${tu}"` : ''}></video>`;
    wireMedia($('video', stage), m, stage, tok);
  } else if (m.kind === 'audio') {
    stage.innerHTML = `<div class="v-audio"><div class="cover">${tu ? `<img src="${tu}" alt="">` : ic('music', 'lg')}</div><b>${esc(m.name)}</b><audio src="${url}" controls></audio></div>`;
    wireMedia($('audio', stage), m, stage, tok);
  } else {
    const isText = (/^text\/|json|xml|javascript/.test(m.mime || '') || m.quarantine) && m.size < 2 * 1024 * 1024;
    const isPdf = m.real === 'application/pdf' && !m.quarantine;
    stage.innerHTML = `<div class="v-file">${m.quarantine ? `<div class="q-card">${ic('shield', 'lg')}<b>隔離中（実行・表示しない）</b><span>${esc(m.quarantine)}</span></div>` : ''}${isText ? '<pre class="v-text">読み込み中…</pre>' : isPdf ? `<iframe src="${url}" title="PDF"></iframe>` : `${ic('file', 'lg')}<b>${esc(m.name)}</b><span>${fmtSize(m.size)}</span>`}
      <button class="btn primary" data-v="export">${ic('share')}<span>書き出して他のアプリで開く</span></button></div>`;
    if (isText) fetch(url).then(r => r.text()).then(t => { const p = $('.v-text', stage); if (p) p.textContent = t; }).catch(() => { });
  }
  const nx = S.items.get(V.ids[V.i + 1]);
  if (nx && nx.kind === 'image' && !nx.offloaded && !V.urls.has(nx.id)) {
    loadBody(nx).then(b => { if (b && tok === V.token && !V.urls.has(nx.id)) V.urls.set(nx.id, URL.createObjectURL(b)); }).catch(() => { });
  }
}
const vNext = () => { if (V.i < V.ids.length - 1) { V.i++; drawViewer(); } };
const vPrev = () => { if (V.i > 0) { V.i--; drawViewer(); } };
async function viewerAction(k) {
  const id = V.ids[V.i], m = S.items.get(id); if (!m) return;
  const media = $('#viewer .v-stage video, #viewer .v-stage audio');
  switch (k) {
    case 'close': closeViewer(); break;
    case 'prev': vPrev(); break;
    case 'next': vNext(); break;
    case 'info': openDetail(id); break;
    case 'menu': itemMenu(id); break;
    case 'fav': m.fav = !m.fav; await saveItem(m); $('#viewer [data-v=fav]').innerHTML = ic('star', m.fav ? 'fill' : '') + '<span>お気に入り</span>'; updateTile(id); break;
    case 'export': exportItems([id]); break;
    case 'rate': {
      const R = [0.75, 1, 1.25, 1.5, 2], cur = S.conf.settings.rate || 1, nx = R[(R.indexOf(cur) + 1) % R.length] || 1;
      S.conf.settings.rate = nx; saveConf();
      if (media) media.playbackRate = nx;
      if (Player.id) Player.el.playbackRate = nx;
      $('#viewer [data-v=rate] span').textContent = nx + 'x'; break;
    }
    case 'slide': toggleSlide(); break;
    case 'restore': await restoreItems([id]); drawViewer(); break;
    case 'pickfile': pickFileFor(m); break;
    case 'bg': {
      const url = V.urls.get(id);
      if (!media || !url) { toast('読み込みが終わってから押して'); return; }
      const t = media.currentTime; media.pause();
      V.urls.delete(id);
      const q = V.ids.filter(x => { const y = S.items.get(x); return y && (y.kind === 'audio' || y.kind === 'video') && !y.offloaded; });
      Player.start(m, url, t, q);
      closeViewer();
      toast('ミニプレーヤーで再生中。アプリ内を移動しても止まらない');
      break;
    }
    case 'pip': {
      if (!media) return;
      try {
        if (media.webkitSupportsPresentationMode && media.webkitSupportsPresentationMode('picture-in-picture')) media.webkitSetPresentationMode('picture-in-picture');
        else if (document.pictureInPictureEnabled) await media.requestPictureInPicture();
        else toast('この端末ではPiPが使えない');
      } catch (e) { toast('PiPできなかった: ' + e.message); }
      break;
    }
    case 'frame': {
      if (!media || !media.videoWidth) { toast('動画の読み込みを待って'); return; }
      try {
        const b = await frameToThumb(media, media.videoWidth, media.videoHeight, 480);
        await saveThumb(id, b); m.hasThumb = true; m.thumbTime = media.currentTime; m.customThumb = true;
        await saveItem(m); updateTile(id); toast(`${fmtTime(media.currentTime)} の場面をサムネにした`);
      } catch (e) { toast('取れなかった: ' + e.message); }
      break;
    }
  }
}
function bindViewer() {
  const v = $('#viewer'); let sx = 0, sy = 0, st = 0, multi = false;
  v.addEventListener('touchstart', e => {
    if (e.touches.length > 1) { multi = true; return; }
    multi = false; sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
  }, { passive: true });
  v.addEventListener('touchend', e => {
    if (multi || e.touches.length) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    const stage = e.target.closest('.v-stage'); if (!stage) return;
    if (e.target.closest('button,video,audio,a,input,iframe,pre')) {
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2 && e.target.closest('video,audio')) { dx < 0 ? vNext() : vPrev(); }
      return;
    }
    if (window.visualViewport && visualViewport.scale > 1.05) return;
    const zoom = $('.v-scroll.zoom', stage);
    if (!zoom && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) { dx < 0 ? vNext() : vPrev(); return; }
    if (!zoom && stage.dataset.kind === 'image' && !$('.v-scroll.tall', stage) && dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) { closeViewer(); return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - st < 350) {
      const w = innerWidth;
      if (!zoom && t.clientX < w * 0.28) { vPrev(); return; }
      if (!zoom && t.clientX > w * 0.72) { vNext(); return; }
      const now = Date.now();
      if (now - V.lastTap < 300) {
        clearTimeout(V.tapT); V.lastTap = 0;
        const sc = $('.v-scroll', stage); if (sc) sc.classList.toggle('zoom');
      } else {
        V.lastTap = now;
        V.tapT = setTimeout(() => v.classList.toggle('nochrome'), 300);
      }
    }
  }, { passive: true });
  v.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b && !b.disabled) viewerAction(b.dataset.v); });
  document.addEventListener('keydown', e => {
    if (v.hidden) return;
    if (e.key === 'ArrowRight') vNext(); else if (e.key === 'ArrowLeft') vPrev(); else if (e.key === 'Escape' && !$('#sheets').children.length) closeViewer();
  });
}

/* ================= ミニプレーヤー（閉じても再生） ================= */
const Player = {
  id: null, url: null, queue: [], kind: null,
  get el() { return this.kind === 'video' ? $('#pv') : $('#pa'); },
  init() {
    ['#pv', '#pa'].forEach(s => {
      const e = $(s);
      e.addEventListener('ended', () => this.next(true));
      e.addEventListener('timeupdate', () => this.prog());
      e.addEventListener('play', () => this.ui());
      e.addEventListener('pause', () => this.ui());
    });
  },
  start(m, url, t = 0, queue = []) {
    const other = m.kind === 'video' ? $('#pa') : $('#pv');
    try { other.pause(); other.removeAttribute('src'); other.load(); } catch { }
    if (this.url && this.url !== url) revokeURL(this.url);
    this.id = m.id; this.url = url; this.kind = m.kind === 'video' ? 'video' : 'audio';
    this.queue = queue.length ? queue : [m.id];
    if (!t && m.pos && m.dur > 60 && m.pos < m.dur - 5) t = m.pos;
    const e = this.el; e.src = url;
    e.playbackRate = (S.conf && S.conf.settings.rate) || 1; e.defaultPlaybackRate = e.playbackRate;
    const seek = () => { try { if (t) e.currentTime = t; } catch { } };
    if (e.readyState >= 1) seek(); else e.addEventListener('loadedmetadata', seek, { once: true });
    const p = e.play(); if (p) p.catch(() => { });
    const mini = $('#mini'); mini.hidden = false; mini.classList.toggle('is-video', this.kind === 'video');
    document.body.classList.add('has-mini');
    this.ui(); this.session(m);
  },
  async playId(id) {
    const m = S.items.get(id); if (!m || !S.key || m.offloaded) return false;
    if (SW.ok() && m.size > STREAM_MIN) { this.start(m, streamURL(m), 0, this.queue); return true; }
    const b = await loadBody(m); if (!b) return false;
    this.start(m, URL.createObjectURL(b), 0, this.queue); return true;
  },
  async next(auto) {
    const i = this.queue.indexOf(this.id);
    for (let k = i + 1; k < this.queue.length; k++) if (await this.playId(this.queue[k])) return;
    if (!auto) toast('次はない');
    this.ui();
  },
  async prev() {
    if (this.el.currentTime > 3) { this.el.currentTime = 0; return; }
    const i = this.queue.indexOf(this.id);
    for (let k = i - 1; k >= 0; k--) if (await this.playId(this.queue[k])) return;
  },
  toggle() { const e = this.el; if (e.paused) { const p = e.play(); if (p) p.catch(() => { }); } else e.pause(); },
  stop() {
    ['#pv', '#pa'].forEach(s => { const e = $(s); try { e.pause(); e.removeAttribute('src'); e.load(); } catch { } });
    if (this.url) revokeURL(this.url);
    this.url = null; this.id = null;
    $('#mini').hidden = true; document.body.classList.remove('has-mini');
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  },
  pip() {
    const e = $('#pv');
    if (this.kind !== 'video') { toast('PiPは動画だけ'); return; }
    try {
      if (e.webkitSupportsPresentationMode && e.webkitSupportsPresentationMode('picture-in-picture')) e.webkitSetPresentationMode(e.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      else if (document.pictureInPictureEnabled) (document.pictureInPictureElement ? document.exitPictureInPicture() : e.requestPictureInPicture()).catch(err => toast('PiPできない: ' + err.message));
      else toast('この端末ではPiPが使えない');
    } catch (err) { toast('PiPできない: ' + err.message); }
  },
  ui() {
    if (!this.id) return;
    const m = S.items.get(this.id);
    $('#miniTitle').textContent = m ? m.name : '再生中';
    $('#miniPlay').innerHTML = ic(this.el.paused ? 'play' : 'pause');
    const cov = $('#miniCover');
    if (this.kind === 'audio' && m && m.hasThumb) thumbURL(m.id).then(u => { cov.src = u || ''; cov.hidden = !u; });
    else cov.hidden = true;
  },
  prog() {
    const e = this.el; $('#miniBar').style.width = e.duration ? (e.currentTime / e.duration * 100) + '%' : '0';
    const m = S.items.get(this.id);
    if (m && S.key && e.duration > 60 && Date.now() - (this._ls || 0) > 10000) { this._ls = Date.now(); m.pos = e.currentTime > e.duration - 5 ? 0 : e.currentTime; saveItem(m, false).catch(() => { }); }
  },
  session(m) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    (m.hasThumb ? thumbURL(m.id) : Promise.resolve(null)).then(u => {
      try { ms.metadata = new MediaMetadata({ title: m.name, artist: 'HAKO', artwork: u ? [{ src: u, sizes: '480x480', type: 'image/jpeg' }] : [] }); } catch { }
    });
    try {
      ms.setActionHandler('play', () => this.el.play());
      ms.setActionHandler('pause', () => this.el.pause());
      ms.setActionHandler('nexttrack', () => this.next());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('seekto', d => { this.el.currentTime = d.seekTime; });
    } catch { }
  }
};

/* ================= イベント ================= */
function bindGlobal() {
  $('#bottomNav').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b || !S.key) return;
    if (b.dataset.view === 'add') openAdd(); else go(b.dataset.view);
  });
  $('#netPill').addEventListener('click', () => { if (S.conf) setSetting('offline', !S.conf.settings.offline); });
  $('#lockNow').addEventListener('click', lock);
  $('#selectBtn').addEventListener('click', () => { if (S.selecting) exitSelect(); else enterSelect(); });
  $('#searchBtn').addEventListener('click', () => {
    const r = $('#searchRow'); r.hidden = !r.hidden;
    if (!r.hidden) $('#q').focus(); else if (S.f.q) { S.f.q = ''; $('#q').value = ''; render(); }
  });
  let qt; $('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.f.q = e.target.value; render(); }, 200); });

  const tabs = $('#genreTabs');
  tabs.addEventListener('click', async e => {
    if (e.target.closest('[data-genre-add]')) {
      const n = await promptDlg('新しいジャンル（タブ）', '', '例：イラスト、音楽、資料');
      if (n) { const g = { id: uid(), name: n }; S.conf.genres.push(g); saveConf(); S.f.genre = g.id; render(); }
      return;
    }
    const t = e.target.closest('[data-genre]'); if (t) { S.f.genre = t.dataset.genre; render(); }
  });
  longPress(tabs, '.tab[data-genre]', t => {
    const id = t.dataset.genre; if (id === 'all' || id === 'fav') return;
    const g = S.conf.genres.find(x => x.id === id); if (!g) return;
    menuSheet(g.name, [
      ['edit', '名前を変える', async () => { const n = await promptDlg('名前を変える', g.name); if (n) { g.name = n; saveConf(); render(); } }],
      ['layers', 'ジャンルの管理（並べ替え・削除）', () => manageList('genres')]
    ]);
  });

  const main = $('#main');
  main.addEventListener('click', e => {
    const t = e.target;
    const tile = t.closest('#grid .tile[data-id]');
    if (tile) { const id = tile.dataset.id; if (S.selecting) toggleSel(id); else openViewer(S.list, S.list.indexOf(id)); return; }
    const fo = t.closest('[data-folder]'); if (fo) { S.f.folder = fo.dataset.folder; render(); return; }
    const kd = t.closest('[data-kind]'); if (kd) { S.f.kind = kd.dataset.kind; render(); return; }
    const se = t.closest('[data-site-edit]'); if (se) { editSite(se.dataset.siteEdit); return; }
    const ut = t.closest('[data-untag]'); if (ut) { S.f.tags = S.f.tags.filter(x => x !== ut.dataset.untag); render(); return; }
    const qc = t.closest('[data-q-cancel]'); if (qc) { cancelJob(qc.dataset.qCancel); return; }
    const qr = t.closest('[data-q-retry]'); if (qr) { retryJob(qr.dataset.qRetry); return; }
    const qo = t.closest('[data-q-open]'); if (qo) { const id = qo.dataset.qOpen; openViewer([id], 0); return; }
    const sg = t.closest('[data-seg]'); if (sg) { setSetting(sg.dataset.seg, sg.dataset.v); return; }
    const sw = t.closest('[data-sw]'); if (sw) { setSetting(sw.dataset.sw, !S.conf.settings[sw.dataset.sw]); return; }
    const ac = t.closest('[data-accent]'); if (ac) { setSetting('accent', ac.dataset.accent); return; }
    const a = t.closest('[data-act]'); if (a) { doAct(a.dataset.act, a); return; }
  });
  main.addEventListener('change', e => { const k = e.target.dataset.set; if (k) setSetting(k, e.target.value); });
  longPress(main, '#grid .tile[data-id]', t => { if (S.selecting) { toggleSel(t.dataset.id); return; } itemMenu(t.dataset.id); });
  longPress(main, '.site[data-site]', t => editSite(t.dataset.site));
  longPress(main, '.chip[data-folder]', t => {
    const id = t.dataset.folder; if (id === 'all' || id === 'none') return;
    const f = S.conf.folders.find(x => x.id === id); if (!f) return;
    menuSheet(f.name, [
      ['select', 'このフォルダを全部選択', () => { S.f.folder = id; render(); enterSelect(); S.list.forEach(x => S.sel.add(x)); renderLib(); renderSelbar(); }],
      ['share', 'このフォルダを1つのZIPで書き出す', () => exportItems([...S.items.values()].filter(m => m.folder === id && !m.trashed).map(m => m.id))],
      ['edit', '名前を変える', async () => { const n = await promptDlg('名前を変える', f.name); if (n) { f.name = n; saveConf(); render(); } }],
      ['layers', 'フォルダの管理', () => manageList('folders')]
    ]);
  });

  $('#selbar').addEventListener('click', e => { const b = e.target.closest('[data-sel]'); if (b && !b.disabled) onSelAction(b.dataset.sel); });

  $('#miniPlay').addEventListener('click', () => Player.toggle());
  $('#miniNext').addEventListener('click', () => Player.next());
  $('#miniPip').addEventListener('click', () => Player.pip());
  $('#miniClose').addEventListener('click', () => Player.stop());
  $('#miniMedia').addEventListener('click', () => { const e = $('#pv'); if (Player.kind === 'video' && e.webkitEnterFullscreen) e.webkitEnterFullscreen(); else if (Player.kind === 'video' && e.requestFullscreen) e.requestFullscreen().catch(() => { }); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      S.hiddenAt = Date.now();
      if (S.key && S.conf && S.conf.settings.blurOnHide) document.body.classList.add('veil');
      saveConfNow().catch(() => { });
    } else {
      document.body.classList.remove('veil');
      if (S.key && S.conf && Date.now() > S.noLockUntil) {
        const a = S.conf.settings.autolock;
        if (a >= 0 && Date.now() - S.hiddenAt >= a * 60000) lock();
      }
    }
  });
  addEventListener('online', renderNet); addEventListener('offline', renderNet);
  if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme());
  addEventListener('beforeunload', e => { if (Q.jobs.some(j => j.status === 'run' || j.status === 'wait')) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { const s = $('#sheets .sheet-wrap:last-child'); if (s) s.click(); } });
}

async function boot() {
  applyTheme();
  try { await DB.open(); }
  catch (e) { $('#lockMsg').textContent = 'データベースを開けない: ' + e.message; return; }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
  bindLock(); bindGlobal(); bindViewer(); Player.init();
  await setupLock();
}
document.addEventListener('DOMContentLoaded', boot);
