'use strict';
/* ===== HAKO : encryption (AES-256-GCM, PBKDF2-SHA256) =====
   ・ランダムなマスター鍵で全データを暗号化
   ・マスター鍵はパスワード由来の鍵（PBKDF2 31万回）で包んで保存
   ・パスワード変更は包み直すだけ（中身の再暗号化は不要） */
const Crypto = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const ITER = 310000;
  const rand = n => crypto.getRandomValues(new Uint8Array(n));

  async function kekFromPassword(pw, salt, iter = ITER) {
    const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }
  async function kekFromBytes(bytes, info) {
    const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) },
      base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }
  const newMaster = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  async function wrap(master, kek) {
    const iv = rand(12);
    const data = await crypto.subtle.wrapKey('raw', master, kek, { name: 'AES-GCM', iv });
    return { iv, data };
  }
  const unwrap = (w, kek) => crypto.subtle.unwrapKey('raw', w.data, kek, { name: 'AES-GCM', iv: w.iv },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  async function enc(key, data) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { iv, data: ct };
  }
  const dec = (key, r) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv }, key, r.data);
  const encJSON = (key, o) => enc(key, te.encode(JSON.stringify(o)));
  const decJSON = async (key, r) => JSON.parse(td.decode(await dec(key, r)));

  function b64(u8) {
    u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  return { ITER, rand, kekFromPassword, kekFromBytes, newMaster, wrap, unwrap, enc, dec, encJSON, decJSON, b64, ub64 };
})();
