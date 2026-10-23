'use strict';
/* ===== HAKO : 保存・サムネ・ダウンロード・書き出し・バックアップ ===== */
const CHUNK = 4 * 1024 * 1024;
const MEDIA_RE = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|mp4|mov|m4v|webm|mkv|mp3|m4a|aac|wav|flac|ogg|opus)([?#]|$)/i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)([?#]|$)/i;
const AUDIO_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus)([?#]|$)/i;
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', zip: 'application/zip', json: 'application/json'
};
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'application/pdf': 'pdf'
};
const extOf = n => { const m = /\.([a-z0-9]{1,5})$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; };
const mimeOf = n => EXT_MIME[extOf(n)] || '';
function kindOf(mime, name) {
  mime = mime || ''; const e = extOf(name);
  if (mime.startsWith('image/') || /^(jpe?g|png|gif|webp|avif|heic|heif|bmp|svg)$/.test(e)) return 'image';
  if (mime.startsWith('video/') || /^(mp4|mov|m4v|webm|mkv)$/.test(e)) return 'video';
  if (mime.startsWith('audio/') || /^(mp3|m4a|aac|wav|flac|ogg|opus|aiff?)$/.test(e)) return 'audio';
  return 'file';
}
const isQuota = e => e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));

const GENERIC = /^(application|binary)\/octet-stream$/;
const FP_LEN = 1024 * 1024;
let BIG = 200 * 1024 * 1024, PART = 3.5 * 1024 * 1024 * 1024, STREAM_MIN = 24 * 1024 * 1024;
const HTML_ERR = '画像・動画じゃなくWebページが返ってきた（直リンク禁止・ログインが必要・期限切れURLのどれか）';
const revokeURL = u => { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); };

/* ---------- Service Worker（大きいファイルの再生・書き出し） ---------- */
const SW = {
  ok() { return !!(navigator.serviceWorker && navigator.serviceWorker.controller && S.key); },
  post(msg, wait = 2500) {
    return new Promise(res => {
      const c = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!c) { res(false); return; }
      const ch = new MessageChannel(), t = setTimeout(() => res(false), wait);
      ch.port1.onmessage = e => { clearTimeout(t); res(e.data || true); };
      try { c.postMessage(msg, [ch.port2]); } catch { clearTimeout(t); res(false); }
    });
  },
  sendKey() { return S.key ? this.post({ type: 'key', key: S.key }) : Promise.resolve(false); },
  lock() { return this.post({ type: 'lock' }); },
  flags() { return S.conf ? this.post({ type: 'flags', flags: { noUpdate: !S.conf.settings.autoUpdate } }) : Promise.resolve(false); },
  async job(job) { const token = uid() + uid(); return (await this.post({ type: 'job', token, job })) ? `__hako/d/${token}/${encodeURIComponent(job.name)}` : null; }
};
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'need-key' && e.ports[0]) e.ports[0].postMessage({ key: S.key || null });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { SW.sendKey(); SW.flags(); });
}
const streamURL = (m, dl = false) => `__hako/s/${m.id}/${encodeURIComponent(m.name)}?z=${m.size || 0}&c=${m.cs || CHUNK}&t=${encodeURIComponent(m.mime || 'application/octet-stream')}${dl ? '&dl=1' : ''}`;
function partition(arr, sizeOf, cap, maxCount = 60000) {
  const out = []; let cur = [], sz = 0;
  for (const x of arr) {
    const s = sizeOf(x);
    if (cur.length && (sz + s > cap || cur.length >= maxCount)) { out.push(cur); cur = []; sz = 0; }
    cur.push(x); sz += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

/* ---------- 中身チェック（拡張子ではなく中身で判定） ---------- */
function sniff(u8) {
  if (!u8 || u8.length < 4) return '';
  const at = (o, str) => { for (let i = 0; i < str.length; i++) if (u8[o + i] !== str.charCodeAt(i)) return false; return true; };
  if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image/jpeg';
  if (u8[0] === 0x89 && at(1, 'PNG')) return 'image/png';
  if (at(0, 'GIF8')) return 'image/gif';
  if (at(0, 'RIFF')) { if (at(8, 'WEBP')) return 'image/webp'; if (at(8, 'WAVE')) return 'audio/wav'; if (at(8, 'AVI ')) return 'video/x-msvideo'; }
  if (at(4, 'ftyp')) {
    const b = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(b)) return 'image/heic';
    if (/^avi[fs]$/.test(b)) return 'image/avif';
    if (b === 'qt  ') return 'video/quicktime';
    if (/^M4[AB] $/.test(b)) return 'audio/mp4';
    return 'video/mp4';
  }
  if (u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) return 'video/webm';
  if (at(0, 'ID3')) return 'audio/mpeg';
  if (u8[0] === 0xFF && (u8[1] & 0xF6) === 0xF0) return 'audio/aac';
  if (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0) return 'audio/mpeg';
  if (at(0, 'fLaC')) return 'audio/flac';
  if (at(0, 'OggS')) return 'audio/ogg';
  if (at(0, '%PDF')) return 'application/pdf';
  if (at(0, 'PK') && u8[2] === 3 && u8[3] === 4) return 'application/zip';
  if (at(0, 'MZ')) return 'application/x-msdownload';
  const head = new TextDecoder().decode(u8.subarray(0, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /^<(head|body|meta|title|script|div)\b/.test(head)) return 'text/html';
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return '';
}
const REAL_LABEL = { 'application/pdf': 'PDF', 'application/zip': 'ZIP', 'application/x-msdownload': 'Windowsの実行ファイル（iPhoneでは動かないので開いても害はない）', 'text/html': 'Webページ' };
function judge(mime, name, real) {
  const claimed = kindOf(mime, name), generic = !mime || GENERIC.test(mime);
  const out = { mime, kind: claimed, warn: '', fixed: false };
  if (!real) return out;
  const rk = kindOf(real, '');
  if (real === 'text/html') { if (claimed !== 'file') { out.html = true; out.warn = '中身はWebページ（画像・動画じゃない）'; out.kind = 'file'; out.mime = 'text/html'; out.fixed = true; } return out; }
  if (rk !== 'file') { if (generic || claimed !== 'file') { if (real !== mime) { out.mime = real; out.kind = rk; out.fixed = true; } } return out; }
  if (claimed !== 'file') { out.warn = `中身は${REAL_LABEL[real] || real}（拡張子と違う）`; out.mime = real; out.kind = 'file'; out.fixed = true; }
  else if (generic) { out.mime = real; }
  if (real === 'application/x-msdownload') out.warn = '中身は' + REAL_LABEL[real];
  return out;
}

/* ---------- ウイルス対策：危ない種類は「隔離」して、HAKOの中では絶対に実行・表示しない ---------- */
const RISKY_EXT = /\.(exe|msi|bat|cmd|com|scr|pif|cpl|vbs|vbe|js|mjs|jse|wsf|wsh|ps1|psm1|sh|bash|zsh|command|app|apk|aab|ipa|dmg|pkg|deb|rpm|jar|class|lnk|reg|hta|html?|xhtml|mhtml?|xml|svgz|docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|iso|img|vhdx?|torrent|mobileconfig)$/i;
const RISKY_REAL = { 'text/html': 'Webページ（スクリプトが入りうる）', 'application/x-msdownload': 'Windowsの実行ファイル' };
function riskOf(name, real) {
  if (RISKY_REAL[real]) return RISKY_REAL[real];
  const m = RISKY_EXT.exec(name || '');
  return m ? `実行・自動処理される可能性がある種類（.${m[1].toLowerCase()}）` : '';
}
/* ---------- 写真の位置情報（EXIF）：書き出し時に消す ---------- */
function tiffWalk(t, fn) {
  if (t.length < 8) return;
  const le = t[0] === 0x49, u16 = o => le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1];
  const u32 = o => le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0 : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0;
  const ifd = u32(4); if (ifd + 2 > t.length) return;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (e + 12 > t.length) break; fn(u16(e), u16(e + 8)); }
}
function jpegMeta(u8) {
  const out = { gps: false, orient: 1, exif: false };
  if (!(u8[0] === 0xFF && u8[1] === 0xD8)) return out;
  let p = 2;
  while (p + 4 <= u8.length && u8[p] === 0xFF) {
    const mk = u8[p + 1];
    if (mk === 0xDA || mk === 0xD9) break;
    if ((mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (mk === 0xE1 && u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) {
      out.exif = true;
      tiffWalk(u8.subarray(p + 10, p + 2 + len), (tag, v) => { if (tag === 0x8825) out.gps = true; if (tag === 0x0112) out.orient = v || 1; });
    }
    p += 2 + len;
  }
  return out;
}
/* Exif（位置情報・機種・日時）とXMP・IPTCを消す。向きと色プロファイルは残す */
function stripJpeg(u8) {
  if (!(u8[0] === 0xFF && u8[1] === 0xD8)) return u8;
  const keep = [], meta = jpegMeta(u8); let p = 2;
  while (p + 4 <= u8.length && u8[p] === 0xFF) {
    const mk = u8[p + 1];
    if (mk === 0xDA || mk === 0xD9) break;
    if ((mk >= 0xD0 && mk <= 0xD7) || mk === 0x01) { keep.push(u8.subarray(p, p + 2)); p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (!(mk === 0xE1 || mk === 0xED)) keep.push(u8.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  const parts = [u8.subarray(0, 2)];
  if (meta.orient !== 1) {
    const a = new Uint8Array(36), d = new DataView(a.buffer);
    a.set([0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2A, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0]);
    d.setUint16(28, meta.orient, true);
    parts.push(a);
  }
  return concatU8([...parts, ...keep, u8.subarray(p)]);
}
function concatU8(arr) { const n = arr.reduce((a, x) => a + x.length, 0), o = new Uint8Array(n); let p = 0; arr.forEach(x => { o.set(x, p); p += x.length; }); return o; }
const isJpeg = m => m.kind === 'image' && (m.real === 'image/jpeg' || (!m.real && /jpe?g/.test(m.mime || '')));
async function exportBlobFor(m, b) {
  if (S.conf.settings.stripMeta && isJpeg(m) && b.size < 64 * 1024 * 1024) {
    const u8 = new Uint8Array(await b.arrayBuffer());
    if (jpegMeta(u8).exif) return new Blob([stripJpeg(u8)], { type: 'image/jpeg' });
  }
  return b;
}

/* ---------- 重複チェック ---------- */
async function fingerprint(head, size) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', head));
  return size.toString(36) + ':' + Array.from(h.slice(0, 12), b => b.toString(16).padStart(2, '0')).join('');
}
const INFLIGHT = new Map(); /* 同時ダウンロード中の同じ中身もぶつけない */
function findDup(fp) { for (const m of S.items.values()) if (m.fp === fp && !m.trashed) return m; return INFLIGHT.has(fp) ? { name: INFLIGHT.get(fp), inflight: true } : null; }
function dupError(d) { const e = new Error('中身が同じものが既にある（' + d.name + '）'); e.dup = d; return e; }
/* 容量を空けてあるものと中身が同じなら、新しく増やさずにその本体として戻す */
async function fillBody(d, blob, onProg) {
  await storeBody(d.id, blob, onProg);
  d.size = blob.size; d.cs = CHUNK; d.offloaded = false; delete d.broken; await saveItem(d);
}
async function moveChunks(from, to) {
  await DB.delChunks(to);
  const keys = await DB.chunkKeys(from); let buf = [];
  for (const k of keys) { const r = await DB.get('chunks', k); buf.push({ ...r, id: to }); if (buf.length >= 4) await DB.putMany('chunks', buf.splice(0)); }
  if (buf.length) await DB.putMany('chunks', buf);
  await DB.delChunks(from);
}
/* 同じ名前は自動で「名前 (2).拡張子」にする（同時ダウンロードでもぶつからないよう予約する） */
const RESERVED = new Set();
function uniqueItemName(name, selfId = null) {
  name = name || 'untitled';
  if (!S.conf.settings.autoNumber) return name;
  const taken = new Set(RESERVED);
  for (const m of S.items.values()) if (!m.trashed && m.id !== selfId) taken.add(m.name.toLowerCase());
  let out = name;
  if (taken.has(name.toLowerCase())) {
    const mm = /^(.*?)(\.[a-z0-9]{1,6})?$/i.exec(name); let base = mm[1]; const ext = mm[2] || '';
    const b2 = /^(.*) \((\d+)\)$/.exec(base); if (b2) base = b2[1];
    let n = 2; do { out = `${base} (${n++})${ext}`; } while (taken.has(out.toLowerCase()));
  }
  RESERVED.add(out.toLowerCase());
  return out;
}
const releaseName = n => RESERVED.delete(String(n || '').toLowerCase());

/* ---------- URLからの保存：届いた分から順に暗号化して保存（GBでもメモリを食わない） ---------- */
async function streamToStore(res, id, onProg) {
  const total = +res.headers.get('content-length') || 0;
  let i = 0, got = 0, fill = 0, buf = new Uint8Array(CHUNK), head = null;
  const pending = [];
  const flush = async u8 => {
    if (!head) head = u8.slice(0, FP_LEN);
    const r = await Crypto.enc(S.key, u8);
    pending.push({ id, i: i++, iv: r.iv, data: r.data });
    if (pending.length >= 4) await DB.putMany('chunks', pending.splice(0));
  };
  try {
    if (!res.body || !res.body.getReader) {
      const b = await res.blob(); got = b.size;
      for (let o = 0; o < Math.max(1, b.size); o += CHUNK) await flush(new Uint8Array(await b.slice(o, o + CHUNK).arrayBuffer()));
    } else {
      const reader = res.body.getReader();
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length; let off = 0;
        while (off < value.length) {
          const take = Math.min(CHUNK - fill, value.length - off);
          buf.set(value.subarray(off, off + take), fill); fill += take; off += take;
          if (fill === CHUNK) { await flush(buf); buf = new Uint8Array(CHUNK); fill = 0; }
        }
        onProg && onProg(total ? Math.min(1, got / total) : 0, got);
      }
      if (fill || i === 0) await flush(buf.slice(0, fill));
    }
    if (pending.length) await DB.putMany('chunks', pending.splice(0));
  } catch (e) { await DB.delChunks(id).catch(() => { }); throw e; }
  return { size: got, head: head || new Uint8Array(0) };
}
async function addFromResponse(res, o) {
  const id = uid();
  const r = await streamToStore(res, id, o.onProg);
  const drop = async e => { await DB.delChunks(id).catch(() => { }); await DB.del('thumbs', id).catch(() => { }); S.items.delete(id); throw e; };
  const fp = await fingerprint(r.head, r.size);
  const real = sniff(r.head.subarray(0, 1024));
  const j = judge(o.mime, o.name, real);
  if (j.html) await drop(new Error(HTML_ERR));
  if (S.conf.settings.dupSkip) {
    const d = findDup(fp);
    if (d) {
      if (d.offloaded && !d.inflight) { await moveChunks(id, d.id); d.size = r.size; d.cs = CHUNK; d.offloaded = false; delete d.broken; await saveItem(d); const e = dupError(d); e.filled = true; throw e; }
      await drop(dupError(d));
    }
  }
  let mime = j.mime || '';
  if (!mime || GENERIC.test(mime)) mime = mimeOf(o.name) || 'application/octet-stream';
  let name = o.name; if (!extOf(name) && MIME_EXT[mime]) name += '.' + MIME_EXT[mime];
  name = uniqueItemName(name);
  if (S.conf.settings.dupSkip) INFLIGHT.set(fp, name);
  const now = Date.now();
  const m = {
    id, kind: j.fixed ? j.kind : kindOf(mime, name), name, mime, size: r.size, cs: CHUNK, fp,
    added: o.added || now, updated: now, created: o.created || null,
    folder: o.folder || null, genre: o.genre || null, tags: [...(o.tags || [])], fav: false, memo: '',
    sourceUrl: o.sourceUrl || null, offloaded: false, hasThumb: false, warn: j.warn || '',
    real: real || '', quarantine: riskOf(name, real), gps: real === 'image/jpeg' ? jpegMeta(r.head).gps : false
  };
  if (m.quarantine) m.kind = 'file';
  else try { await thumbFromStore(m); } catch (e) { console.warn(e); }
  try { await saveItem(m, false); } catch (e) { releaseName(name); INFLIGHT.delete(fp); await drop(e); }
  releaseName(name); INFLIGHT.delete(fp);
  return m;
}
/* 保存済みの本体からサムネを作る。大きい動画はストリームで先頭だけ読む */
async function thumbFromStore(m) {
  if (m.kind === 'image') { if (m.size < 80 * 1024 * 1024) { const b = await loadBody(m); if (b) await makeThumbFor(m, b); } return; }
  if (m.kind !== 'video' && m.kind !== 'audio') return;
  if (SW.ok() && m.size > STREAM_MIN) { await makeThumbFor(m, streamURL(m)); return; }
  if (m.size < 400 * 1024 * 1024) { const b = await loadBody(m); if (b) await makeThumbFor(m, b); }
}

/* ---------- IP保護 ---------- */
function proxyImg(u) {
  const st = S.conf.settings, p = (st.proxy || '').trim().replace(/\/+$/, '');
  if (!st.privacy) return u;
  return p ? `${p}/?url=${encodeURIComponent(u)}&key=${encodeURIComponent(st.proxyKey || '')}` : '';
}
const TRACK_RE = /^(utm_[a-z]+|fbclid|gclid|dclid|gbraid|wbraid|yclid|msclkid|igshid|igsh|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|twclid|ttclid|li_fat_id|spm)$/i;
function cleanUrl(u) {
  if (!S.conf || !S.conf.settings.stripTrack) return u;
  try { const x = new URL(u); [...x.searchParams.keys()].forEach(k => { if (TRACK_RE.test(k)) x.searchParams.delete(k); }); return x.href; } catch { return u; }
}

/* ---------- 大きいファイルの書き出し（タップでダウンロード） ---------- */
function offerLinks(links, note = '') {
  return new Promise(res => {
    let done = false;
    const body = el(`<div>
      ${links.map((l, i) => `<a class="save-card dl" href="${l.url}" data-i="${i}">${ic(l.name.endsWith('.zip') ? 'layers' : 'file', 'lg')}<div><b>${esc(l.name)}</b><span class="muted small">${fmtSize(l.size)}${links.length > 1 ? `・${i + 1}/${links.length}` : ''}</span></div>${ic('download')}</a>`).join('')}
      ${note ? `<p class="muted small">${esc(note)}</p>` : ''}
      <p class="muted small">タップするとダウンロード開始。メモリに溜めずに少しずつ作るから、GB単位でも大丈夫なように作ってある。iPhoneでは「ダウンロード」→ ファイルアプリの「ダウンロード」フォルダに入る。ダウンロード中はHAKOを閉じないで。</p></div>`);
    body.addEventListener('click', e => {
      const a = e.target.closest('a.dl'); if (!a) return;
      a.classList.add('done'); done = true;
      S.noLockUntil = Date.now() + 30 * 60000;
      setTimeout(() => toast('ダウンロード開始'), 300);
    });
    sheet({ title: links.length > 1 ? `${links.length}つに分けて書き出す` : '書き出す準備ができた', body, onClose: () => res(done) });
  });
}

/* ---------- 保存（すべて暗号化） ---------- */
async function saveItem(m, touch = true) {
  if (touch) m.updated = Date.now();
  const r = await Crypto.encJSON(S.key, m);
  await DB.put('items', { id: m.id, iv: r.iv, data: r.data });
  S.items.set(m.id, m);
}
async function saveThumb(id, blob) {
  const r = await Crypto.enc(S.key, await blob.arrayBuffer());
  await DB.put('thumbs', { id, mime: blob.type || 'image/jpeg', iv: r.iv, data: r.data });
  dropThumbCache(id);
}
function dropThumbCache(id) {
  const p = S.thumbs.get(id);
  if (p) { p.then(u => u && URL.revokeObjectURL(u)); S.thumbs.delete(id); }
}
function thumbURL(id) {
  if (S.thumbs.has(id)) return S.thumbs.get(id);
  const p = (async () => {
    if (!S.key) return null;
    const r = await DB.get('thumbs', id); if (!r) return null;
    const buf = await Crypto.dec(S.key, r);
    return URL.createObjectURL(new Blob([buf], { type: r.mime || 'image/jpeg' }));
  })().catch(() => null);
  S.thumbs.set(id, p);
  return p;
}
async function storeBody(id, blob, onProg) {
  await DB.delChunks(id);
  const n = Math.max(1, Math.ceil(blob.size / CHUNK)), PAR = 4;
  try {
    for (let i = 0; i < n; i += PAR) {
      const recs = await Promise.all(Array.from({ length: Math.min(PAR, n - i) }, async (_, k) => {
        const idx = i + k;
        const r = await Crypto.enc(S.key, await blob.slice(idx * CHUNK, (idx + 1) * CHUNK).arrayBuffer());
        return { id, i: idx, iv: r.iv, data: r.data };
      }));
      await DB.putMany('chunks', recs);
      onProg && onProg(Math.min(1, (i + recs.length) / n));
    }
  } catch (e) { await DB.delChunks(id).catch(() => { }); throw e; }
}
async function loadBody(m, onProg) {
  const keys = await DB.chunkKeys(m.id);
  if (!keys.length) return null;
  const parts = [];
  for (let k = 0; k < keys.length; k++) {
    const r = await DB.get('chunks', keys[k]);
    parts.push(new Blob([await Crypto.dec(S.key, r)]));
    onProg && onProg((k + 1) / keys.length);
  }
  return new Blob(parts, { type: m.mime || mimeOf(m.name) || 'application/octet-stream' });
}

/* ---------- サムネ生成 ---------- */
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image(); i.decoding = 'async';
    i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めない'));
    i.src = src;
  });
}
const canvasBlob = (c, type = 'image/jpeg', q = 0.82) =>
  new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('変換に失敗')), type, q));
/* 縦長は上側、横長は中央を切り出す */
function frameToThumb(src, sw, sh, max = 440) {
  let cw = sw, ch = sh, cx = 0, cy = 0;
  if (sh / sw > 1.6) ch = sw * 1.6;
  else if (sw / sh > 1.6) { cw = sh * 1.6; cx = (sw - cw) / 2; }
  const sc = Math.min(1, max / Math.min(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * sc)); c.height = Math.max(1, Math.round(ch * sc));
  const g = c.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, cx, cy, cw, ch, 0, 0, c.width, c.height);
  return canvasBlob(c, 'image/jpeg', 0.8);
}
async function imageThumb(blob, max = 440) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    return { thumb: await frameToThumb(img, w, h, max), w, h };
  } finally { URL.revokeObjectURL(url); }
}
function videoInfo(src, at = null) {
  return new Promise(res => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    const own = typeof src !== 'string', url = own ? URL.createObjectURL(src) : src;
    let done = false;
    const dur = () => (isFinite(v.duration) ? v.duration : 0);
    const fin = r => {
      if (done) return; done = true; clearTimeout(to);
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { }
      v.remove(); if (own) URL.revokeObjectURL(url); res(r);
    };
    const to = setTimeout(() => fin({ thumb: null, dur: dur() }), 15000);
    v.addEventListener('loadedmetadata', () => {
      const d = dur(), t = at != null ? at : Math.min(1.5, d * 0.1);
      const p = v.play(); if (p) p.then(() => v.pause()).catch(() => { });
      try { v.currentTime = Math.max(0.05, t); } catch { }
    }, { once: true });
    v.addEventListener('seeked', async () => {
      try {
        if (!v.videoWidth) return fin({ thumb: null, dur: dur() });
        await new Promise(r => { if (v.requestVideoFrameCallback) { v.requestVideoFrameCallback(() => r()); setTimeout(r, 400); } else setTimeout(r, 120); });
        const thumb = await frameToThumb(v, v.videoWidth, v.videoHeight, 480);
        fin({ thumb, dur: dur(), w: v.videoWidth, h: v.videoHeight, t: v.currentTime });
      } catch { fin({ thumb: null, dur: dur() }); }
    }, { once: true });
    v.addEventListener('error', () => fin({ thumb: null, dur: 0 }), { once: true });
    v.src = url;
  });
}
function mediaDuration(src) {
  return new Promise(res => {
    const a = document.createElement('audio'); a.preload = 'metadata';
    const own = typeof src !== 'string', u = own ? URL.createObjectURL(src) : src; let done = false;
    const fin = d => { if (done) return; done = true; if (own) URL.revokeObjectURL(u); res(isFinite(d) ? d : 0); };
    a.onloadedmetadata = () => fin(a.duration); a.onerror = () => fin(0);
    setTimeout(() => fin(a.duration || 0), 8000);
    a.src = u;
  });
}
async function makeThumbFor(m, blob) {
  try {
    if (m.kind === 'image') {
      const r = await imageThumb(blob);
      await saveThumb(m.id, r.thumb); m.hasThumb = true; m.w = r.w; m.h = r.h;
    } else if (m.kind === 'video') {
      const r = await videoInfo(blob);
      if (r.thumb) { await saveThumb(m.id, r.thumb); m.hasThumb = true; m.thumbTime = r.t || 0; }
      m.dur = r.dur || m.dur; if (r.w) { m.w = r.w; m.h = r.h; }
    } else if (m.kind === 'audio') {
      m.dur = await mediaDuration(blob);
    }
  } catch (e) { console.warn('thumb', e); }
}

/* ---------- 追加 ---------- */
async function addBlob(blob, o = {}) {
  const orig = o.name || 'untitled';
  const head = new Uint8Array(await blob.slice(0, FP_LEN).arrayBuffer());
  const fp = await fingerprint(head, blob.size);
  if (S.conf.settings.dupSkip && !o.allowDup) {
    const d = findDup(fp);
    if (d) { const e = dupError(d); if (d.offloaded && !d.inflight) { await fillBody(d, blob, o.onProg); e.filled = true; } throw e; }
  }
  const name = uniqueItemName(orig);
  if (S.conf.settings.dupSkip) INFLIGHT.set(fp, name);
  const real = sniff(head.subarray(0, 1024));
  const j = judge(o.mime || blob.type || '', name, real);
  let mime = j.mime;
  if (!mime || GENERIC.test(mime)) mime = mimeOf(name) || mime || 'application/octet-stream';
  const id = uid(), now = Date.now();
  const m = {
    id, kind: j.fixed ? j.kind : kindOf(mime, name), name, mime, size: blob.size, cs: CHUNK, fp,
    added: o.added || now, updated: now, created: o.created || null,
    folder: o.folder || null, genre: o.genre || null, tags: [...(o.tags || [])], fav: false, memo: '',
    sourceUrl: o.sourceUrl || null, offloaded: false, hasThumb: false, warn: j.warn || '',
    real: real || '', quarantine: riskOf(name, real), gps: real === 'image/jpeg' ? jpegMeta(head).gps : false
  };
  if (m.quarantine) m.kind = 'file';
  try {
    if (!m.quarantine) await makeThumbFor(m, blob);
    await storeBody(id, blob, o.onProg);
    await saveItem(m, false);
  } catch (e) {
    await DB.delChunks(id).catch(() => { }); await DB.del('thumbs', id).catch(() => { });
    S.items.delete(id); throw e;
  } finally { releaseName(name); INFLIGHT.delete(fp); }
  return m;
}
async function importFiles(files, opts = {}) {
  files = Array.from(files); const out = []; let fail = 0, dup = 0, filled = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i], label = `取り込み中 ${i + 1}/${files.length}　${f.name}`;
    HUD.show(label, i / files.length);
    try {
      out.push(await addBlob(f, { ...opts, name: f.name, mime: f.type, added: Date.now() + i, created: f.lastModified || null, onProg: p => HUD.show(label, (i + p) / files.length) }));
    } catch (e) {
      if (e.dup) { e.filled ? filled++ : dup++; continue; }
      fail++; console.error(e);
      if (isQuota(e)) { toast('容量が足りない。空きを作ってからもう一度'); break; }
    }
  }
  HUD.hide();
  return { out, fail, dup, filled };
}

/* ---------- ネット ---------- */
function netGuard() {
  if (S.conf.settings.offline) throw new Error('オフラインモード中');
  if (!navigator.onLine) throw new Error('ネットにつながってない');
}
async function netFetch(url, signal) {
  netGuard();
  const st = S.conf.settings, proxy = (st.proxy || '').trim().replace(/\/+$/, '');
  const opt = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal };
  const viaProxy = async () => {
    let res;
    try { res = await fetch(proxy + '/?url=' + encodeURIComponent(url), { ...opt, headers: { 'X-Hako-Key': st.proxyKey || '' } }); }
    catch (e2) { if (e2.name === 'AbortError') throw e2; throw new Error('プロキシにつながらない'); }
    if (res.status === 403) throw new Error('プロキシのキーが違う');
    if (!res.ok) throw new Error(`プロキシ経由でも失敗（HTTP ${res.status}）`);
    return { res, via: 'proxy' };
  };
  if (st.privacy) {
    if (!proxy) throw new Error('IP保護モード中：自分用プロキシが未設定（設定 → ネット）。直接は取りに行かない');
    return viaProxy();
  }
  try {
    const res = await fetch(url, { ...opt, mode: 'cors' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { res, via: 'direct' };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    if (!proxy) throw new Error(/^HTTP/.test(e.message) ? `サイトに断られた（${e.message}）` : '取得できなかった：サイトが直接ダウンロードを許可していない・URLが間違っている・通信が切れた のどれか（プロキシ未設定）');
    return viaProxy();
  }
}
async function readWithProgress(res, onProg) {
  const total = +res.headers.get('content-length') || 0;
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!res.body || !res.body.getReader) { const b = await res.blob(); onProg && onProg(1, b.size); return b; }
  const reader = res.body.getReader(); const parts = []; let buf = [], bufLen = 0, got = 0;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.push(value); bufLen += value.length; got += value.length;
    if (bufLen > CHUNK) { parts.push(new Blob(buf)); buf = []; bufLen = 0; }
    onProg && onProg(total ? got / total : 0, got);
  }
  if (buf.length) parts.push(new Blob(buf));
  return new Blob(parts, { type });
}
function nameFromResponse(res, url, ct) {
  let n = '';
  const cd = res.headers.get('content-disposition') || '';
  let m = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (m) { try { n = decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch { } }
  if (!n) { m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd); if (m) n = m[1]; }
  if (!n) n = fileNameFromUrl(url);
  n = (n || 'download').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  if (!extOf(n) && MIME_EXT[ct]) n += '.' + MIME_EXT[ct];
  return n;
}
function fileNameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '') || hostOf(url); }
  catch { return 'download'; }
}
function parseMediaFromHTML(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const set = new Set();
  const add = u => {
    if (!u) return; u = u.trim();
    if (!u || /^(data|blob|javascript):/i.test(u)) return;
    try { set.add(new URL(u, base).href); } catch { }
  };
  doc.querySelectorAll('img').forEach(img => {
    const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    let best = null, bw = -1;
    if (ss) ss.split(',').forEach(p => { const [a, b] = p.trim().split(/\s+/); const w = parseFloat(b) || 1; if (a && w > bw) { bw = w; best = a; } });
    add(img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || best || img.getAttribute('src'));
  });
  doc.querySelectorAll('video[src],video source[src],audio[src],audio source[src]').forEach(v => add(v.getAttribute('src')));
  doc.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (MEDIA_RE.test(h)) add(h); });
  doc.querySelectorAll('meta[property="og:image"],meta[property="og:video"],meta[name="twitter:image"]').forEach(m => add(m.getAttribute('content')));
  return { title: (doc.title || '').trim(), urls: [...set] };
}

/* ---------- ダウンロードキュー（同時実行） ---------- */
const Q = { jobs: [], running: 0, batches: new Map() };
function enqueue(urls, o = {}) {
  const b = {
    id: uid(), title: o.title || '', dest: o.dest || S.conf.settings.saveDest, folder: o.folder || null,
    genre: o.genre || null, tags: o.tags || [], number: !!o.number, total: urls.length, start: Date.now(), finished: false
  };
  Q.batches.set(b.id, b);
  urls.forEach((url, i) => Q.jobs.push({ id: uid(), batch: b.id, url, idx: i, status: 'wait', prog: 0, got: 0, err: '', name: '' }));
  pump(); onQueueChange();
  return b;
}
function pump() {
  const max = (S.conf && S.conf.settings.concurrency) || 3;
  while (Q.running < max) {
    const j = Q.jobs.find(x => x.status === 'wait'); if (!j) break;
    Q.running++; j.status = 'run';
    runJob(j).finally(() => { Q.running--; pump(); checkBatch(j.batch); onQueueChange(); });
  }
}
async function runJob(j) {
  const b = Q.batches.get(j.batch);
  j.ctrl = new AbortController(); j.err = ''; j.note = '';
  try {
    if (b.dest === 'app' && S.conf.settings.dupSkip) {
      const ex = [...S.items.values()].find(m => m.sourceUrl === j.url && !m.trashed);
      if (ex && !ex.offloaded) { j.status = 'done'; j.itemId = ex.id; j.name = ex.name; j.note = '既にあるのでスキップ'; j.skipped = true; return; }
      if (ex) j.fillId = ex.id;
    }
    const { res, via } = await netFetch(j.url, j.ctrl.signal);
    j.via = via;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct === 'text/html' || ct === 'application/xhtml+xml') {
      const html = await res.text();
      if (b.total === 1) {
        const found = parseMediaFromHTML(html, res.headers.get('x-final-url') || res.url || j.url);
        j.status = 'done'; j.name = 'ページを解析した'; j.note = `${found.urls.length}件見つかった`;
        openPicker(found.urls, { title: found.title || hostOf(j.url), page: j.url, dest: b.dest, folder: b.folder, genre: b.genre, tags: b.tags });
      } else { j.status = 'err'; j.err = 'ページのURL（画像・動画じゃない）'; }
      return;
    }
    let name = nameFromResponse(res, j.url, ct);
    if (b.number && b.total > 1) name = String(j.idx + 1).padStart(3, '0') + '_' + name;
    j.name = name;
    const created = Date.parse(res.headers.get('last-modified') || '') || null;
    const prog = (p, got) => { j.prog = p; j.got = got; onQueueChange(); };
    if (b.dest === 'device') {
      const blob = await readWithProgress(res, prog);
      const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
      if (sniff(head) === 'text/html' && kindOf(ct, name) !== 'file') throw new Error(HTML_ERR);
      j.blob = blob; j.status = 'ready';
    } else if (j.fillId && S.items.has(j.fillId)) {
      const ex = S.items.get(j.fillId);
      await DB.delChunks(ex.id);
      const r = await streamToStore(res, ex.id, prog);
      if (sniff(r.head.subarray(0, 1024)) === 'text/html' && ex.kind !== 'file') { await DB.delChunks(ex.id); throw new Error(HTML_ERR); }
      ex.size = r.size; ex.cs = CHUNK; ex.offloaded = false; delete ex.broken; await saveItem(ex);
      j.itemId = ex.id; j.name = ex.name; j.status = 'done'; j.filled = true; j.note = '容量を空けてあったものに本体を戻した';
      if (S.view === 'lib') refreshSoon();
    } else {
      const m = await addFromResponse(res, { name, mime: ct, sourceUrl: j.url, folder: b.folder, genre: b.genre, tags: b.tags, added: b.start + j.idx, created, onProg: prog });
      j.itemId = m.id; j.name = m.name; j.status = 'done'; if (m.warn) j.note = '⚠ ' + m.warn;
      if (S.view === 'lib') refreshSoon();
    }
  } catch (e) {
    if (e.name === 'AbortError') { j.status = 'cancel'; j.err = 'キャンセルした'; }
    else if (e.dup) { j.status = 'done'; j.itemId = e.dup.id; if (e.filled) { j.filled = true; j.note = '容量を空けてあった同じものに本体を戻した'; } else { j.skipped = true; j.note = '中身が同じものが既にあるのでスキップ'; } }
    else { j.status = 'err'; j.err = isQuota(e) ? '容量が足りない' : (e.message || String(e)); }
  }
}
function cancelJob(id) {
  const j = Q.jobs.find(x => x.id === id); if (!j) return;
  if (j.status === 'wait') { j.status = 'cancel'; j.err = 'キャンセルした'; checkBatch(j.batch); }
  else if (j.status === 'run') j.ctrl && j.ctrl.abort();
  onQueueChange();
}
function retryJob(id) {
  const j = Q.jobs.find(x => x.id === id); if (!j) return;
  const b = Q.batches.get(j.batch); if (b) b.finished = false;
  j.status = 'wait'; j.prog = 0; j.err = ''; pump(); onQueueChange();
}
async function checkBatch(bid) {
  const b = Q.batches.get(bid); if (!b || b.finished) return;
  const js = Q.jobs.filter(j => j.batch === bid);
  if (js.some(j => j.status === 'wait' || j.status === 'run')) return;
  b.finished = true;
  const sk = js.filter(j => j.skipped).length, fl = js.filter(j => j.filled).length;
  const ok = js.filter(j => (j.status === 'done' || j.status === 'ready') && !j.skipped && !j.filled).length;
  const ng = js.filter(j => j.status === 'err').length;
  if (b.dest === 'device') {
    const ready = js.filter(j => j.status === 'ready' && j.blob);
    if (!ready.length) { if (ng) toast(`${ng}件失敗（転送で理由を確認できる）`, { action: { label: '転送', fn: () => go('queue') } }); return; }
    let blob, name;
    if (ready.length === 1) { blob = ready[0].blob; name = ready[0].name; }
    else {
      try { blob = await Zip.build(ready.map(j => ({ name: j.name, blob: j.blob })), p => HUD.show('ZIPにまとめ中', p)); }
      catch (e) { HUD.hide(); toast('まとめられなかった: ' + e.message); return; }
      HUD.hide(); name = `${(b.title || 'HAKO').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}_${stamp()}.zip`;
    }
    await offerSave(blob, name, ng ? `${ng}件は失敗したので入ってない` : '');
    ready.forEach(j => { j.blob = null; j.status = 'done'; j.note = 'iPhoneへ書き出し'; });
    onQueueChange();
  } else if (b.total > 1 || ng) {
    const msg = [ok ? `${ok}件をライブラリに追加` : '', fl ? `${fl}件は空けてあったものに本体を戻した` : '', sk ? `${sk}件は既にあるのでスキップ` : '', ng ? `${ng}件失敗` : ''].filter(Boolean).join('・') || '終わった';
    toast(msg, ng ? { action: { label: '理由を見る', fn: () => go('queue') } } : {});
  } else if (ok) toast('ライブラリに追加した');
  else if (fl) toast('容量を空けてあったものに本体を戻した');
  else if (sk) toast('既にあるのでスキップした');
}

/* ---------- iPhoneへ書き出し ---------- */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}
function offerSave(blob, name, note = '') {
  return new Promise(res => {
    const file = new File([blob], name, { type: blob.type || mimeOf(name) || 'application/octet-stream' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    let done = false;
    sheet({
      title: '書き出す準備ができた',
      body: `<div class="save-card">${ic(name.endsWith('.zip') ? 'layers' : 'file', 'lg')}<div><b>${esc(name)}</b><span class="muted small">${fmtSize(blob.size)}</span></div></div>
        ${note ? `<p class="muted small">${esc(note)}</p>` : ''}
        <p class="muted small">「共有・保存」→「"ファイル"に保存」でiPhoneのファイルアプリへ。写真や動画1つなら「画像を保存/ビデオを保存」で写真アプリにも入れられる。</p>`,
      actions: [
        { label: 'ダウンロード', icon: 'download', onClick: () => { downloadBlob(blob, name); done = true; res(true); } },
        ...(canShare ? [{
          label: '共有・保存', icon: 'share', kind: 'primary', keep: true, onClick: async api => {
            S.noLockUntil = Date.now() + 10 * 60000;
            try { await navigator.share({ files: [file] }); done = true; res(true); api.close(); }
            catch (e) { if (e.name !== 'AbortError') toast('共有できなかった: ' + e.message); }
            finally { S.noLockUntil = 0; }
          }
        }] : [])
      ],
      onClose: () => { if (!done) res(false); }
    });
  });
}
function offerShareMany(files) {
  return new Promise(res => {
    if (!(navigator.canShare && navigator.canShare({ files }))) { toast('この端末では個別共有ができない。ZIPで書き出して'); res(false); return; }
    let done = false;
    sheet({
      title: `${files.length}件を個別に書き出す`,
      body: `<p class="muted small">共有シートで「${files.length}項目を保存」を選ぶと写真アプリに、「"ファイル"に保存」でファイルアプリに入る。</p>`,
      actions: [{
        label: '共有・保存', icon: 'share', kind: 'primary', keep: true, onClick: async api => {
          S.noLockUntil = Date.now() + 10 * 60000;
          try { await navigator.share({ files }); done = true; res(true); api.close(); }
          catch (e) { if (e.name !== 'AbortError') toast('共有できなかった: ' + e.message); }
          finally { S.noLockUntil = 0; }
        }
      }],
      onClose: () => { if (!done) res(false); }
    });
  });
}
async function exportItems(ids, mode = 'zip') {
  const ms = ids.map(id => S.items.get(id)).filter(Boolean);
  const ready = ms.filter(m => !m.offloaded), skipped = ms.length - ready.length;
  if (!ready.length) { toast('書き出せるものがない（再ダウンロード待ちだけ）'); return false; }
  const risky = ready.filter(m => m.quarantine);
  if (risky.length && !(await confirmDlg('隔離中のファイルが入ってる', `${risky.length}件は危ないかもしれない種類（${risky[0].quarantine}）。\nHAKOの外で開くと実行される可能性がある。iPhoneではほぼ動かないけど、パソコンに移す時は特に注意。それでも書き出す？`, '書き出す', true))) return false;
  const total = ready.reduce((a, m) => a + (m.size || 0), 0);
  if (skipped) setTimeout(() => toast(`${skipped}件は再ダウンロード待ちだから入れてない`), 400);
  /* 大きいときは、メモリに溜めずに少しずつ書き出す */
  if (SW.ok() && (total > BIG || ready.some(m => m.size > BIG))) {
    try {
      if (ready.length === 1 && !(S.conf.settings.stripMeta && isJpeg(ready[0]))) return await offerLinks([{ url: streamURL(ready[0], true), name: ready[0].name, size: ready[0].size }]);
      const groups = partition(ready, m => (m.size || 0) + 512, PART, 60000);
      const links = [];
      for (let p = 0; p < groups.length; p++) {
        const used = new Set(), name = `HAKO_${stamp()}${groups.length > 1 ? `_${p + 1}of${groups.length}` : ''}.zip`;
        const url = await SW.job({ name, entries: groups[p].map(m => ({ name: Zip.uniqueName(m.name, used), id: m.id, size: m.size, cs: m.cs || CHUNK, date: m.added, strip: !!(S.conf.settings.stripMeta && isJpeg(m) && m.size < 64 * 1024 * 1024) })) });
        if (!url) throw new Error('書き出し担当（Service Worker）が応答しない');
        links.push({ url, name, size: groups[p].reduce((a, m) => a + (m.size || 0), 0) });
      }
      return await offerLinks(links, groups.length > 1 ? '4GBを超えないように分けてある。全部ダウンロードして' : (mode === 'each' ? '大きいので、個別共有の代わりに1つのZIPにした' : ''));
    } catch (e) { toast('書き出し失敗: ' + e.message); return false; }
  }
  if (total > 900 * 1024 * 1024 && !(await confirmDlg('かなり大きい', `合計 ${fmtSize(total)}。この環境だとメモリに一度読み込むから、iPhoneだと失敗することがある。分けるほうが安全。続ける？`, '続ける'))) return false;
  try {
    const files = [];
    for (let i = 0; i < ready.length; i++) {
      const m = ready[i];
      HUD.show(`準備中 ${i + 1}/${ready.length}`, i / ready.length);
      const b = await loadBody(m, p => HUD.show(`準備中 ${i + 1}/${ready.length}`, (i + p) / ready.length));
      if (b) files.push({ name: m.name, blob: await exportBlobFor(m, b), date: new Date(m.added) });
    }
    HUD.hide();
    if (files.length === 1) return await offerSave(files[0].blob, files[0].name);
    if (mode === 'each') return await offerShareMany(files.map(f => new File([f.blob], f.name, { type: f.blob.type })));
    const zip = await Zip.build(files, p => HUD.show('ZIPにまとめ中', p));
    HUD.hide();
    return await offerSave(zip, `HAKO_${stamp()}.zip`);
  } catch (e) { HUD.hide(); toast('書き出し失敗: ' + e.message); return false; }
}

/* ---------- 容量を空ける / 戻す ---------- */
async function offloadItems(ids) {
  const ms = ids.map(id => S.items.get(id)).filter(m => m && !m.offloaded);
  if (!ms.length) { toast('もう空けてある'); return; }
  const noSrc = ms.filter(m => !m.sourceUrl);
  if (noSrc.length) {
    const r = await ask('自動で戻せないものがある',
      `${noSrc.length}件はURLから入れたものじゃないから、自動の再ダウンロードができない。\n空けたあと戻すには「ファイルを選んで戻す」か「バックアップを読み込む」が必要。\n\nサムネ・名前・タグ・メモはどれも残る。`,
      [{ label: 'キャンセル', value: null }, { label: 'そのまま空ける', value: 'plain', kind: 'danger' }, { label: '先に書き出してから', value: 'export', kind: 'primary' }]);
    if (!r) return;
    if (r === 'export') {
      const ok = await exportItems(noSrc.map(m => m.id));
      if (!ok) { toast('書き出してないから、空けるのはやめておいた'); return; }
    }
  }
  let freed = 0;
  for (const m of ms) {
    await DB.delChunks(m.id);
    freed += m.size || 0; m.offloaded = true;
    await saveItem(m);
  }
  toast(`${fmtSize(freed)} 空けた（サムネはそのまま）`);
  refresh();
}
async function restoreItems(ids) {
  const ms = ids.map(id => S.items.get(id)).filter(m => m && m.offloaded);
  const withUrl = ms.filter(m => m.sourceUrl), without = ms.filter(m => !m.sourceUrl);
  if (without.length === 1 && !withUrl.length) { pickFileFor(without[0]); return; }
  let ok = 0, ng = 0, lastErr = '';
  for (let i = 0; i < withUrl.length; i++) {
    const m = withUrl[i], label = `再ダウンロード ${i + 1}/${withUrl.length}`;
    HUD.show(label, i / withUrl.length);
    try {
      const { res } = await netFetch(m.sourceUrl);
      await DB.delChunks(m.id);
      const r = await streamToStore(res, m.id, p => HUD.show(label, (i + p) / withUrl.length));
      if (sniff(r.head.subarray(0, 1024)) === 'text/html' && m.kind !== 'file') { await DB.delChunks(m.id); throw new Error(HTML_ERR); }
      m.size = r.size; m.cs = CHUNK; m.offloaded = false; await saveItem(m); ok++;
    } catch (e) { ng++; lastErr = e.message; }
  }
  HUD.hide();
  if (withUrl.length) toast(`${ok}件戻した${ng ? `・${ng}件失敗（${lastErr}）` : ''}`);
  if (without.length) setTimeout(() => toast(`${without.length}件は元URLがない。詳細の「ファイルを選んで戻す」で戻せる`), withUrl.length ? 3000 : 0);
  refresh();
}
function pickFileFor(m) {
  pickFiles(m.mime && m.mime !== 'application/octet-stream' ? m.mime : '', false, async fs => {
    const f = fs[0]; if (!f) return;
    if (kindOf(f.type, f.name) !== m.kind && !(await confirmDlg('種類が違うかも', `「${m.name}」（${m.kind}）に「${f.name}」を入れようとしてる。このまま戻す？`, '戻す'))) return;
    try {
      HUD.show('戻してる…');
      await storeBody(m.id, f, p => HUD.show('戻してる…', p));
      m.size = f.size; m.offloaded = false; if (f.type) m.mime = f.type;
      await saveItem(m); HUD.hide(); toast('戻した（サムネはそのまま）'); refresh(); S.detailRefresh && S.detailRefresh();
    } catch (e) { HUD.hide(); toast('戻せなかった: ' + e.message); }
  });
}

/* ---------- 画像を軽くする ---------- */
async function compressImages(ids) {
  const ms = ids.map(id => S.items.get(id)).filter(m => m && m.kind === 'image' && !m.offloaded && !/gif|svg/.test(m.mime));
  if (!ms.length) { toast('軽くできる画像がない（GIF・再DL待ちは対象外）'); return; }
  const { imgMax, imgQ } = S.conf.settings;
  if (!(await confirmDlg('画像を軽くする', `${ms.length}件を 長辺${imgMax}px・画質${Math.round(imgQ * 100)}% のJPEGにする。\n縦長の連続画像は横幅1080pxまで。\n元の画質には戻せない（URLから入れたものは再ダウンロードで戻せる）。`, '軽くする'))) return;
  let before = 0, after = 0, n = 0;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    HUD.show(`軽くしてる ${i + 1}/${ms.length}`, i / ms.length);
    try {
      const src = await loadBody(m); if (!src) continue;
      const url = URL.createObjectURL(src); let img;
      try { img = await loadImage(url); } finally { URL.revokeObjectURL(url); }
      const w = img.naturalWidth, h = img.naturalHeight;
      let sc = (h / w > 3 || w / h > 3) ? Math.min(1, 1080 / Math.min(w, h)) : Math.min(1, imgMax / Math.max(w, h));
      const cap = 16000000; if (w * h * sc * sc > cap) sc = Math.sqrt(cap / (w * h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      const out = await canvasBlob(c, 'image/jpeg', imgQ);
      if (out.size >= src.size * 0.95) continue;
      await storeBody(m.id, out);
      before += src.size; after += out.size; n++;
      m.size = out.size; m.mime = 'image/jpeg'; m.w = c.width; m.h = c.height; m.compressed = true;
      if (!/\.jpe?g$/i.test(m.name)) m.name = m.name.replace(/\.[a-z0-9]{1,5}$/i, '') + '.jpg';
      await saveItem(m);
    } catch (e) { console.warn(e); }
  }
  HUD.hide();
  toast(n ? `${n}件 ${fmtSize(before)} → ${fmtSize(after)}` : '小さくならなかったからそのまま');
  refresh();
}

/* ---------- バックアップ（暗号化されたまま） ---------- */
async function exportBackupLegacy(ids = null) {
  const vault = await DB.get('meta', 'vault'), conf = await DB.get('meta', 'conf');
  let items = await DB.all('items');
  if (ids) { const set = new Set(ids); items = items.filter(r => set.has(r.id)); }
  const idset = new Set(items.map(r => r.id));
  const chunkKeys = (await DB.keys('chunks')).filter(k => idset.has(k[0]));
  const thumbKeys = (await DB.keys('thumbs')).filter(k => idset.has(k));
  const est = [...idset].reduce((a, id) => { const m = S.items.get(id); return a + (m && !m.offloaded ? m.size || 0 : 0); }, 0);
  if (est > 900 * 1024 * 1024 && !(await confirmDlg('バックアップが大きい', `中身が約 ${fmtSize(est)}。iPhoneだとメモリ不足で失敗することがある。フォルダごとに選択して「バックアップ」するほうが安全。続ける？`, '続ける'))) return;
  const B = Crypto.b64, rec = r => ({ iv: B(r.iv), data: B(r.data) });
  try {
    const manifest = {
      format: 'hako-backup', v: 1, created: Date.now(), partial: !!ids,
      vault: { salt: B(vault.salt), iter: vault.iter, wrapped: rec(vault.wrapped) },
      conf: conf ? rec(conf) : null,
      items: items.map(r => ({ id: r.id, ...rec(r) })),
      thumbs: thumbKeys, chunks: chunkKeys.map(k => k[0] + ':' + k[1])
    };
    const files = [{ name: 'hako-backup.json', blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }) }];
    for (let i = 0; i < thumbKeys.length; i++) {
      const r = await DB.get('thumbs', thumbKeys[i]);
      files.push({ name: `t_${r.id}.bin`, blob: new Blob([r.iv, r.data]) });
      if (i % 20 === 0) HUD.show('バックアップ準備中（サムネ）', i / Math.max(1, thumbKeys.length) * 0.2);
    }
    for (let i = 0; i < chunkKeys.length; i++) {
      const k = chunkKeys[i], r = await DB.get('chunks', k);
      files.push({ name: `c_${k[0]}_${k[1]}.bin`, blob: new Blob([r.iv, r.data]) });
      HUD.show('バックアップ準備中（本体）', 0.2 + i / Math.max(1, chunkKeys.length) * 0.3);
    }
    const zip = await Zip.build(files, p => HUD.show('バックアップをまとめ中', 0.5 + p * 0.5));
    HUD.hide();
    if (await offerSave(zip, `HAKO-backup_${stamp()}${ids ? '_part' : ''}.zip`, '中身は暗号化されたまま。開くにはこの保管庫のパスワードが必要。')) { S.conf.lastBackup = Date.now(); saveConf(); }
  } catch (e) { HUD.hide(); toast('バックアップ失敗: ' + e.message); }
}
async function exportBackup(ids = null) {
  if (!SW.ok()) return exportBackupLegacy(ids);
  try {
    HUD.show('バックアップを準備中…');
    const vault = await DB.get('meta', 'vault'), conf = await DB.get('meta', 'conf');
    let items = await DB.all('items');
    if (ids) { const set = new Set(ids); items = items.filter(r => set.has(r.id)); }
    const allChunks = await DB.keys('chunks'), allThumbs = new Set(await DB.keys('thumbs'));
    const byItem = new Map(); allChunks.forEach(k => { if (!byItem.has(k[0])) byItem.set(k[0], []); byItem.get(k[0]).push(k); });
    const B = Crypto.b64, rec = r => ({ iv: B(r.iv), data: B(r.data) });
    const sizeOf = r => { const m = S.items.get(r.id); return (m && !m.offloaded ? (m.size || 0) : 0) + 70000; };
    const groups = partition(items, sizeOf, PART, 20000);
    const links = [];
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g], ck = [], tk = [];
      grp.forEach(r => { (byItem.get(r.id) || []).forEach(k => ck.push(k)); if (allThumbs.has(r.id)) tk.push(r.id); });
      const manifest = {
        format: 'hako-backup', v: 1, created: Date.now(), partial: !!ids || groups.length > 1, part: g + 1, parts: groups.length,
        vault: { salt: B(vault.salt), iter: vault.iter, wrapped: rec(vault.wrapped) }, conf: conf ? rec(conf) : null,
        items: grp.map(r => ({ id: r.id, ...rec(r) })), thumbs: tk, chunks: ck.map(k => k[0] + ':' + k[1])
      };
      const name = `HAKO-backup_${stamp()}${ids ? '_sel' : ''}${groups.length > 1 ? `_${g + 1}of${groups.length}` : ''}.zip`;
      const url = await SW.job({ name, entries: [{ name: 'hako-backup.json', text: JSON.stringify(manifest) }, ...tk.map(id => ({ name: `t_${id}.bin`, raw: 'thumbs', key: id })), ...ck.map(k => ({ name: `c_${k[0]}_${k[1]}.bin`, raw: 'chunks', key: k }))] });
      if (!url) throw new Error('書き出し担当（Service Worker）が応答しない');
      links.push({ url, name, size: grp.reduce((a, r) => a + sizeOf(r), 0) });
    }
    HUD.hide();
    const ok = await offerLinks(links, '中身は暗号化されたまま（開くにはこの保管庫のパスワードが必要）。iCloud Driveなどに置いておけば、新しい端末の最初の画面から復元できる。' + (links.length > 1 ? ' 分かれたものは1つ目で復元したあと、残りを設定 →「バックアップを読み込む」で足す。' : ''));
    if (ok) { S.conf.lastBackup = Date.now(); saveConf(); }
  } catch (e) { HUD.hide(); toast('バックアップ失敗: ' + e.message); }
}
/* バックアップから戻すものを選ぶ（フォルダ単位） */
function chooseRestore(metas, bconf, chunkMap) {
  return new Promise(res => {
    const fname = id => ((bconf.folders || []).find(f => f.id === id) || S.conf.folders.find(f => f.id === id) || {}).name;
    const groups = new Map();
    metas.forEach(m => { const k = m.folder && fname(m.folder) ? m.folder : 'none'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
    const state = m => {
      const has = (chunkMap.get(m.id) || []).length > 0;
      const ex = S.items.get(m.id) || (S.conf.settings.dupSkip && m.fp ? findDup(m.fp) : null);
      return !ex ? 'new' : ex.offloaded && has ? 'body' : 'have';
    };
    const rows = [...groups.entries()].map(([k, arr]) => {
      const nw = arr.filter(m => state(m) === 'new').length, bd = arr.filter(m => state(m) === 'body').length;
      const size = arr.filter(m => state(m) !== 'have' && (chunkMap.get(m.id) || []).length).reduce((a, m) => a + (m.size || 0), 0);
      return { k, name: k === 'none' ? '未分類' : fname(k), arr, nw, bd, size, on: nw + bd > 0 };
    });
    let done = false;
    const body = el(`<div><p class="muted small">戻すフォルダを選ぶ。HAKOに既にあるものは上書きしない。「本体を戻す」は、容量を空けてあるものの中身を戻すこと。</p>
      <div class="picklist">${rows.map((r, i) => `<label class="check-row rrow"><input type="checkbox" data-r="${i}" ${r.on ? 'checked' : ''} ${r.nw + r.bd ? '' : 'disabled'}>
        <span><b>${esc(r.name)}</b><small class="muted">　${r.arr.length}件 ／ 新しく追加 ${r.nw}・本体を戻す ${r.bd}${r.size ? '・約' + fmtSize(r.size) : ''}</small></span></label>`).join('')}</div></div>`);
    sheet({
      title: 'バックアップから戻す', body, tall: rows.length > 6,
      actions: [{ label: 'キャンセル', onClick: () => { done = true; res(null); } }, {
        label: '選んだものを戻す', kind: 'primary', onClick: () => {
          const set = new Set();
          $$('[data-r]', body).forEach(c => { if (c.checked) rows[+c.dataset.r].arr.forEach(m => set.add(m.id)); });
          if (!set.size) { toast('1つも選ばれてない'); return false; }
          done = true; res(set);
        }
      }],
      onClose: () => { if (!done) res(null); }
    });
  });
}
function mergeConf(bc) {
  for (const k of ['genres', 'folders', 'tags', 'sites']) {
    const cur = S.conf[k], ids = new Set(cur.map(x => x.id));
    (bc[k] || []).forEach(x => { if (!ids.has(x.id)) cur.push(x); });
  }
}
/* fresh=true : 新しい端末で、バックアップの保管庫をそのまま使う */
async function importBackup(file, fresh = false) {
  HUD.show('バックアップを読んでる…');
  try {
    const z = await Zip.read(file);
    const mb = await z.blob('hako-backup.json');
    if (!mb) throw new Error('HAKOのバックアップじゃない');
    const man = JSON.parse(await mb.text());
    if (man.format !== 'hako-backup') throw new Error('HAKOのバックアップじゃない');
    const U = Crypto.ub64, rec = r => ({ iv: U(r.iv), data: U(r.data).buffer });
    const readBin = async name => {
      const b = await z.blob(name); if (!b) return null;
      const u = new Uint8Array(await b.arrayBuffer());
      return { iv: u.slice(0, 12), data: u.slice(12).buffer };
    };
    const chunkMap = new Map();
    man.chunks.forEach(s => { const [id, i] = s.split(':'); if (!chunkMap.has(id)) chunkMap.set(id, []); chunkMap.get(id).push(+i); });
    const thumbSet = new Set(man.thumbs);
    const total = man.items.length || 1;

    if (fresh) {
      await DB.put('meta', { k: 'vault', v: 1, salt: U(man.vault.salt), iter: man.vault.iter, wrapped: rec(man.vault.wrapped), created: Date.now() });
      if (man.conf) await DB.put('meta', { k: 'conf', ...rec(man.conf) });
      for (let n = 0; n < man.items.length; n++) {
        const r = man.items[n];
        HUD.show(`復元中 ${n + 1}/${total}`, n / total);
        if (thumbSet.has(r.id)) { const t = await readBin(`t_${r.id}.bin`); if (t) await DB.put('thumbs', { id: r.id, mime: 'image/jpeg', ...t }); }
        for (const i of (chunkMap.get(r.id) || [])) { const c = await readBin(`c_${r.id}_${i}.bin`); if (c) await DB.put('chunks', { id: r.id, i, ...c }); }
        await DB.put('items', { id: r.id, ...rec(r) });
      }
      HUD.hide();
      return { added: man.items.length };
    }

    HUD.hide();
    const cur = await DB.get('meta', 'vault');
    const same = Crypto.b64(cur.salt) === man.vault.salt;
    let bkey = S.key;
    if (!same) {
      const pw = await promptDlg('バックアップのパスワード', '', 'バックアップを作った時のパスワード', '開く', 'password');
      if (pw == null) return null;
      HUD.show('確認中…');
      const kek = await Crypto.kekFromPassword(pw, U(man.vault.salt), man.vault.iter);
      try { bkey = await Crypto.unwrap(rec(man.vault.wrapped), kek); }
      catch { HUD.hide(); throw new Error('パスワードが違う'); }
    }
    const recode = async r => same ? r : await Crypto.enc(S.key, await Crypto.dec(bkey, r));
    HUD.show('中身を確認中…');
    const bconf = man.conf ? await Crypto.decJSON(bkey, rec(man.conf)) : {};
    const metas = [];
    for (const r of man.items) metas.push(await Crypto.decJSON(bkey, rec(r)));
    HUD.hide();
    const pick = await chooseRestore(metas, bconf, chunkMap);
    if (!pick) return null;
    if (man.conf) { mergeConf(bconf); await saveConfNow(); }
    let added = 0, restored = 0, skipped = 0, dupSkipped = 0;
    const putChunks = async (target, chunks, srcId) => {
      await DB.delChunks(target); let buf = [];
      for (const i of chunks) { const c = await readBin(`c_${srcId}_${i}.bin`); const e = await recode(c); buf.push({ id: target, i, iv: e.iv, data: e.data }); if (buf.length >= 4) await DB.putMany('chunks', buf.splice(0)); }
      if (buf.length) await DB.putMany('chunks', buf);
    };
    const todo = metas.filter(bm => pick.has(bm.id)), tn = todo.length || 1;
    for (let n = 0; n < todo.length; n++) {
      const bm = todo[n];
      HUD.show(`読み込み中 ${n + 1}/${tn}`, n / tn);
      const ex = S.items.get(bm.id);
      const chunks = chunkMap.get(bm.id) || [];
      if (ex && !(ex.offloaded && chunks.length)) { skipped++; continue; }
      if (!ex && S.conf.settings.dupSkip && bm.fp) {
        const d = findDup(bm.fp);
        if (d) {
          if (d.offloaded && !d.inflight && chunks.length) { await putChunks(d.id, chunks, bm.id); d.size = bm.size; d.cs = bm.cs || CHUNK; d.offloaded = false; delete d.broken; await saveItem(d); restored++; }
          else dupSkipped++;
          continue;
        }
      }
      if (chunks.length) {
        await DB.delChunks(bm.id);
        let buf = [];
        for (const i of chunks) { const c = await readBin(`c_${bm.id}_${i}.bin`); const e = await recode(c); buf.push({ id: bm.id, i, iv: e.iv, data: e.data }); if (buf.length >= 4) await DB.putMany('chunks', buf.splice(0)); }
        if (buf.length) await DB.putMany('chunks', buf);
      }
      if (!ex) {
        if (thumbSet.has(bm.id)) { const t = await readBin(`t_${bm.id}.bin`); if (t) { const e = await recode(t); await DB.put('thumbs', { id: bm.id, mime: 'image/jpeg', iv: e.iv, data: e.data }); } }
        bm.offloaded = !chunks.length;
        bm.name = uniqueItemName(bm.name, bm.id);
        await saveItem(bm, false); releaseName(bm.name); added++;
      } else { ex.offloaded = false; delete ex.broken; await saveItem(ex); restored++; }
    }
    HUD.hide();
    return { added, restored, skipped, dupSkipped, unselected: metas.length - todo.length };
  } catch (e) { HUD.hide(); throw e; }
}
