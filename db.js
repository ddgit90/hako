'use strict';
/* ===== HAKO : IndexedDB storage =====
   meta   : vault（鍵情報）/ conf（暗号化した設定・ジャンル・タグ・サイト）/ bio
   items  : 暗号化したメタデータ
   chunks : 暗号化した本体（4MBごと）
   thumbs : 暗号化したサムネイル（本体とは別。容量を空けても消えない） */
const DB = (() => {
  let db = null;
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('hako', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['id', 'i'] });
        if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs', { keyPath: 'id' });
      };
      r.onsuccess = () => { db = r.result; db.onversionchange = () => { db.close(); location.reload(); }; res(db); };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('別のタブでHAKOが開いている。閉じてからもう一度'));
    });
  }
  function req(store, mode, fn) {
    return new Promise((res, rej) => {
      let t;
      try { t = db.transaction(store, mode); } catch (e) { rej(e); return; }
      const r = fn(t.objectStore(store)); let out;
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('保存が中断された'));
    });
  }
  const range = id => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  return {
    open,
    get: (s, k) => req(s, 'readonly', st => st.get(k)),
    put: (s, v) => req(s, 'readwrite', st => st.put(v)),
    putMany: (s, arr) => new Promise((res, rej) => {
      let t; try { t = db.transaction(s, 'readwrite'); } catch (e) { rej(e); return; }
      const st = t.objectStore(s); arr.forEach(v => st.put(v));
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('保存が中断された'));
    }),
    del: (s, k) => req(s, 'readwrite', st => st.delete(k)),
    all: s => req(s, 'readonly', st => st.getAll()),
    keys: s => req(s, 'readonly', st => st.getAllKeys()),
    chunkKeys: id => req('chunks', 'readonly', st => st.getAllKeys(range(id))),
    delChunks: id => req('chunks', 'readwrite', st => st.delete(range(id))),
    async clear() { for (const s of ['meta', 'items', 'chunks', 'thumbs']) await req(s, 'readwrite', st => st.clear()); }
  };
})();
