'use strict';
/* ===== HAKO : ZIP (無圧縮) 書き出し / 読み込み。外部ライブラリなし ===== */
const Zip = (() => {
  const T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  async function crcBlob(blob, onProg) {
    let c = 0xFFFFFFFF; const step = 4 * 1024 * 1024;
    for (let o = 0; o < blob.size; o += step) {
      const u = new Uint8Array(await blob.slice(o, o + step).arrayBuffer());
      for (let i = 0; i < u.length; i++) c = T[(c ^ u[i]) & 0xFF] ^ (c >>> 8);
      onProg && onProg(Math.min(o + step, blob.size));
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function dos(d) {
    const y = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function uniqueName(name, used) {
    let n = String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '') || 'file';
    if (!used.has(n.toLowerCase())) { used.add(n.toLowerCase()); return n; }
    const m = /^(.*?)(\.[^.]{1,6})?$/.exec(n); let i = 2, c;
    do { c = `${m[1]} (${i++})${m[2] || ''}`; } while (used.has(c.toLowerCase()));
    used.add(c.toLowerCase()); return c;
  }
  async function build(entries, onProg) {
    const te = new TextEncoder(), parts = [], central = [], used = new Set();
    const total = entries.reduce((a, e) => a + e.blob.size, 0) || 1;
    if (total > 0xFFFFFFFF - 1e7) throw new Error('ZIPが4GBを超える。分けて書き出して');
    if (entries.length > 65000) throw new Error('ファイル数が多すぎる。分けて書き出して');
    let offset = 0, done = 0;
    for (const e of entries) {
      const nb = te.encode(uniqueName(e.name, used));
      const size = e.blob.size;
      const crc = await crcBlob(e.blob, p => onProg && onProg((done + p) / total));
      const { time, date } = dos(e.date || new Date());
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, nb, e.blob);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, nb.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, nb);
      offset += 30 + nb.length + size; done += size;
    }
    const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
    return new Blob([...parts, ...central, eo.buffer], { type: 'application/zip' });
  }
  async function read(file) {
    const tailLen = Math.min(file.size, 65557);
    const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
    let p = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
    if (p < 0) throw new Error('ZIPファイルじゃない');
    const n = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const td = new TextDecoder(), entries = new Map(); let q = 0;
    for (let k = 0; k < n; k++) {
      if (cd.getUint32(q, true) !== 0x02014b50) throw new Error('ZIPが壊れている');
      const method = cd.getUint16(q + 10, true), size = cd.getUint32(q + 20, true);
      const nl = cd.getUint16(q + 28, true), xl = cd.getUint16(q + 30, true), cl = cd.getUint16(q + 32, true), off = cd.getUint32(q + 42, true);
      const name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + q + 46, nl));
      entries.set(name, { name, method, size, off });
      q += 46 + nl + xl + cl;
    }
    return {
      entries,
      async blob(name) {
        const e = entries.get(name); if (!e) return null;
        if (e.method !== 0) throw new Error('この圧縮形式には未対応');
        const lh = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer());
        const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        return file.slice(start, start + e.size);
      }
    };
  }
  return { build, read, crcBlob, uniqueName };
})();
