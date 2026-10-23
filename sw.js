/* HAKO service worker
   1) アプリ本体をキャッシュしてオフラインでも開けるようにする
   2) 大きい動画・音声を「必要な部分だけ」その場で復号して流す（GB級でもメモリを食わない）
   3) 大きい書き出し・バックアップのZIPを、メモリに溜めずに少しずつ作って流す
   データ本体は IndexedDB に暗号化されたまま。鍵はメモリ上にだけ持ち、ロックで消える。 */
const VERSION = 'hako-v1.2.1';
const SHELL = ['./', 'index.html', 'style.css', 'ui.js', 'crypto.js', 'db.js', 'zip.js', 'media.js', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const FLAGS = 'hako-flags';
const RANGE_CAP = 8 * 1024 * 1024;
let KEY = null;
const JOBS = new Map();

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== FLAGS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

/* ---------- ページとのやりとり ---------- */
self.addEventListener('message', e => {
  const d = e.data || {}, port = e.ports && e.ports[0];
  const done = v => port && port.postMessage(v || { ok: true });
  if (d.type === 'key') { KEY = d.key; done(); }
  else if (d.type === 'lock') { KEY = null; JOBS.clear(); done(); }
  else if (d.type === 'job') { JOBS.set(d.token, d.job); done(); }
  else if (d.type === 'flags') { e.waitUntil(caches.open(FLAGS).then(c => c.put('flags', new Response(JSON.stringify(d.flags)))).then(() => done())); }
  else if (d.type === 'refresh') {
    e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(s => fetch(s, { cache: 'reload' }).then(r => r.ok && c.put(s, r)).catch(() => { }))))
      .then(() => done({ ok: true })));
  }
});
async function flags() {
  try { const c = await caches.open(FLAGS); const r = await c.match('flags'); return r ? await r.json() : {}; } catch { return {}; }
}
async function ensureKey() {
  if (KEY) return KEY;
  const cs = await self.clients.matchAll({ type: 'window' });
  for (const c of cs) {
    const k = await new Promise(res => {
      const ch = new MessageChannel(); const t = setTimeout(() => res(null), 1500);
      ch.port1.onmessage = ev => { clearTimeout(t); res((ev.data && ev.data.key) || null); };
      c.postMessage({ type: 'need-key' }, [ch.port2]);
    });
    if (k) { KEY = k; return k; }
  }
  return null;
}

/* ---------- IndexedDB（読むだけ） ---------- */
let DBP = null;
function db() {
  if (DBP) return DBP;
  DBP = new Promise((res, rej) => {
    const r = indexedDB.open('hako');
    r.onupgradeneeded = () => r.transaction.abort();
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); DBP = null; }; res(d); };
    r.onerror = () => { DBP = null; rej(r.error); };
  });
  return DBP;
}
const get = (store, key) => db().then(d => new Promise((res, rej) => {
  const r = d.transaction(store).objectStore(store).get(key);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
async function plainChunk(id, i) {
  const r = await get('chunks', [id, i]);
  if (!r) throw new Error('データの一部が見つからない');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv }, KEY, r.data));
}
const SAFE = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer' };
const cd = name => `attachment; filename="${String(name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/* ---------- 大きい動画・音声のストリーム再生（Range対応） ---------- */
async function serveStream(req, u, parts) {
  const id = parts[1], name = decodeURIComponent(parts[2] || 'file');
  const size = +u.searchParams.get('z') || 0, cs = +u.searchParams.get('c') || 4194304;
  const dl = u.searchParams.has('dl');
  let type = u.searchParams.get('t') || 'application/octet-stream';
  /* 安全のため、動画・音声・画像（SVG以外）以外は中身を解釈させない */
  if (!/^(video|audio)\/|^image\/(?!svg)/.test(type)) type = 'application/octet-stream';
  if (!(await ensureKey())) return new Response('locked', { status: 403 });
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...SAFE };
  if (dl) h['Content-Disposition'] = cd(name);
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && size) {
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2] || 0)); end = size - 1; }
    else { start = Number(m[1]); end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1; }
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    if (!dl) end = Math.min(end, start + RANGE_CAP - 1);
    const out = new Uint8Array(end - start + 1); let pos = 0;
    for (let i = Math.floor(start / cs); i <= Math.floor(end / cs); i++) {
      const c = await plainChunk(id, i), base = i * cs;
      const a = Math.max(start, base) - base, b = Math.min(end + 1, base + c.length) - base;
      out.set(c.subarray(a, b), pos); pos += b - a;
    }
    return new Response(out, { status: 206, headers: { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(out.length) } });
  }
  const n = Math.max(1, Math.ceil(size / cs)); let i = 0;
  const body = new ReadableStream({
    async pull(c) { if (i >= n) { c.close(); return; } try { c.enqueue(await plainChunk(id, i++)); } catch (e) { c.error(e); } }
  });
  return new Response(body, { status: 200, headers: { ...h, 'Content-Length': String(size) } });
}

/* ---------- ZIPをその場で作って流す（データディスクリプタ方式） ---------- */
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crcUp(c, u8) { for (let i = 0; i < u8.length; i++) c = T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return c; }
function dos(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
async function* entryData(e) {
  if (e.text != null) { yield new TextEncoder().encode(e.text); return; }
  if (e.raw) {
    const r = await get(e.raw, e.key);
    if (!r) throw new Error('データの一部が見つからない');
    yield (r.iv instanceof Uint8Array ? r.iv : new Uint8Array(r.iv));
    yield new Uint8Array(r.data);
    return;
  }
  const n = Math.max(1, Math.ceil((e.size || 0) / (e.cs || 4194304)));
  if (e.strip) { const parts = []; for (let i = 0; i < n; i++) parts.push(await plainChunk(e.id, i)); yield stripJpeg(concatU8(parts)); return; }
  for (let i = 0; i < n; i++) yield await plainChunk(e.id, i);
}
/* 写真の位置情報など（Exif・XMP・IPTC）を消す。向きと色プロファイルは残す（media.jsと同じ処理） */
function concatU8(arr) { const n = arr.reduce((a, x) => a + x.length, 0), o = new Uint8Array(n); let p = 0; arr.forEach(x => { o.set(x, p); p += x.length; }); return o; }
function jpegOrient(u8) {
  let p = 2, orient = 1;
  while (p + 4 <= u8.length && u8[p] === 0xFF) {
    const mk = u8[p + 1]; if (mk === 0xDA || mk === 0xD9) break;
    if ((mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (mk === 0xE1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) {
      const t = u8.subarray(p + 10, p + 2 + len), le = t[0] === 0x49;
      const u16 = o => le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1];
      const u32 = o => le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0;
      if (t.length >= 8) { const ifd = u32(4); if (ifd + 2 <= t.length) { const c = u16(ifd); for (let k = 0; k < c; k++) { const e = ifd + 2 + k * 12; if (e + 12 > t.length) break; if (u16(e) === 0x0112) orient = u16(e + 8) || 1; } } }
    }
    p += 2 + len;
  }
  return orient;
}
function stripJpeg(u8) {
  if (!(u8[0] === 0xFF && u8[1] === 0xD8)) return u8;
  const orient = jpegOrient(u8), keep = []; let p = 2;
  while (p + 4 <= u8.length && u8[p] === 0xFF) {
    const mk = u8[p + 1]; if (mk === 0xDA || mk === 0xD9) break;
    if ((mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { keep.push(u8.subarray(p, p + 2)); p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (!(mk === 0xE1 || mk === 0xED)) keep.push(u8.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  const parts = [u8.subarray(0, 2)];
  if (orient !== 1) {
    const a = new Uint8Array(36);
    a.set([0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2A, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0]);
    new DataView(a.buffer).setUint16(28, orient, true); parts.push(a);
  }
  return concatU8([...parts, ...keep, u8.subarray(p)]);
}
async function* zipGen(job) {
  const te = new TextEncoder(), central = []; let offset = 0;
  for (const e of job.entries) {
    const nb = te.encode(e.name), { time, date } = dos(new Date(e.date || Date.now()));
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0808, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint16(26, nb.length, true);
    yield new Uint8Array(lh.buffer); yield nb;
    let crc = 0xFFFFFFFF, size = 0;
    for await (const part of entryData(e)) { crc = crcUp(crc, part); size += part.length; yield part; }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const dd = new DataView(new ArrayBuffer(16));
    dd.setUint32(0, 0x08074b50, true); dd.setUint32(4, crc, true); dd.setUint32(8, size, true); dd.setUint32(12, size, true);
    yield new Uint8Array(dd.buffer);
    central.push({ nb, crc, size, time, date, offset });
    offset += 30 + nb.length + size + 16;
    if (offset > 0xFFFFFFFF) throw new Error('4GBを超えた');
  }
  let cdSize = 0;
  for (const c of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0808, true);
    ch.setUint16(12, c.time, true); ch.setUint16(14, c.date, true); ch.setUint32(16, c.crc, true);
    ch.setUint32(20, c.size, true); ch.setUint32(24, c.size, true); ch.setUint16(28, c.nb.length, true); ch.setUint32(42, c.offset, true);
    yield new Uint8Array(ch.buffer); yield c.nb; cdSize += 46 + c.nb.length;
  }
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, central.length, true); eo.setUint16(10, central.length, true);
  eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
  yield new Uint8Array(eo.buffer);
}
async function serveJob(token) {
  const job = JOBS.get(token);
  if (!job) return new Response('このダウンロードは期限切れ。HAKOでもう一度書き出して', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (job.entries.some(e => !e.raw && e.text == null) && !(await ensureKey())) return new Response('locked', { status: 403 });
  const it = zipGen(job);
  const body = new ReadableStream({
    async pull(c) {
      try { const { value, done } = await it.next(); if (done) { c.close(); JOBS.delete(token); } else c.enqueue(value); }
      catch (e) { c.error(e); }
    },
    cancel() { it.return && it.return(); }
  });
  return new Response(body, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': cd(job.name), 'Cache-Control': 'no-store', ...SAFE } });
}

/* ---------- fetch ---------- */
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return; // 外部への通信は触らない
  const k = u.pathname.indexOf('/__hako/');
  if (k >= 0) {
    const parts = u.pathname.slice(k + 8).split('/');
    if (parts[0] === 's') e.respondWith(serveStream(req, u, parts).catch(err => new Response(String(err.message || err), { status: 500 })));
    else if (parts[0] === 'd') e.respondWith(serveJob(parts[1]));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : null);
    const f = await flags();
    if (hit && f.noUpdate) return hit; // 自動更新オフ：GitHubに問い合わせない
    const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
