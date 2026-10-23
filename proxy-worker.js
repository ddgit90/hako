/* =========================================================
   HAKO 用・自分専用プロキシ（任意）  Cloudflare Workers に置く
   ---------------------------------------------------------
   直接ダウンロードを断るサイト（CORS制限）から取るためのもの。
   使わなくてもHAKOは動く。GitHubには置かなくていい。

   置き方（無料プランでOK）
   1. dash.cloudflare.com でアカウント作成
   2. Workers & Pages → 作成 → Worker を作成 → 名前を付けてデプロイ
   3. 「コードを編集」でこのファイルの中身を全部貼り付け
   4. 下の KEY を自分だけの長い文字列に変える → デプロイ
   5. HAKOの 設定 → ネット に WorkerのURL と KEY を入れる

   相手サイトから見えるのはCloudflareのIP。Cookieは送らない。
   KEYを知らない人は使えない。このWorkerはログを書かない。
   ・ダッシュボードの Logs / Observability はOFFのまま
   ・Workerの名前（○○.workers.dev）は相手に伝わることがあるので、本名やIDは入れない
   ・ALLOW_ORIGIN を自分のHAKOのURLにすると、他のサイトからは使えなくなる
   ========================================================= */
const KEY = 'ここを長いランダムな文字列に変える';
const ALLOW_ORIGIN = '*'; // 例: 'https://ddgit90.github.io' にすると自分のHAKOからしか使えない

export default {
  async fetch(req) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Headers': 'X-Hako-Key, Range, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition, X-Final-Url',
      'Referrer-Policy': 'no-referrer'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('method', { status: 405, headers: cors });
    const u = new URL(req.url);
    const given = req.headers.get('X-Hako-Key') || u.searchParams.get('key');
    if (!KEY || KEY.startsWith('ここを') || given !== KEY) return new Response('forbidden', { status: 403, headers: cors });
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) return new Response('bad url', { status: 400, headers: cors });
    const t = new URL(target);
    let r;
    try {
      r = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
          'Accept': '*/*',
          'Referer': t.origin + '/'
        }
      });
    } catch (e) {
      return new Response('fetch failed', { status: 502, headers: cors });
    }
    const h = new Headers();
    for (const k of ['content-type', 'content-length', 'content-disposition', 'last-modified']) { const v = r.headers.get(k); if (v) h.set(k, v); }
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    h.set('X-Final-Url', r.url);
    h.set('Cache-Control', 'no-store');
    return new Response(r.body, { status: r.status, headers: h });
  }
};
