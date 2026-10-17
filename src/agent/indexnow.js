// IndexNow — Bing / Yandex / Naver / Seznam に無料・口座開設なしでURLを通知する。
// 原価0が設計制約なので、外部口座が要る配布チャネル（売り場・SNS）とは別に
// 「口座を作らずに検索面へ出る」唯一の自動経路として持つ。
// 仕様: キーは https://<host>/<key>.txt で配信されることが必須（public/<key>.txt）。

const ENDPOINT = 'https://api.indexnow.org/indexnow';

// 公開してよい面だけを送る。/api/* と /v1/<品目> は合鍵・402 なので送らない
// （402 は課金面でインデックス対象ではない。発見は /openapi.json と /llms.txt が担う）。
export const PUBLIC_PATHS = [
  '/',
  '/llms.txt',
  '/openapi.json',
  '/v1/openapi.json',
  '/sitemap.xml',
  '/.well-known/x402.json',
  '/server.json',
  '/copy',
  // 無料枠（支払い不要で実際に叩ける面）。ここは 402 ではないので検索面に出してよい。
  '/api/free',
  '/api/free/regex',
  '/api/free/diff',
  '/api/free/csv-json',
  '/api/free/url-meta',
];

export function indexNowKey(env) {
  return String((env && env.INDEXNOW_KEY) || '').trim();
}

export function indexNowHost(env) {
  return String((env && env.PUBLIC_HOST) || 'wealth-agent.wealthagent-app.workers.dev')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

// 1日1回だけ送る。同じURLの再送は各エンジンが重複排除するが、
// 毎tick送るのは礼儀に反するので settings テーブルで当日分を抑止する。
export async function pingIndexNow(env, deps, { force = false } = {}) {
  const key = indexNowKey(env);
  if (!key) return { ok: false, error: 'no_indexnow_key' };

  const store = deps && deps.store;
  const day = new Date().toISOString().slice(0, 10);

  if (store && !force) {
    try {
      const row = await store.first("SELECT value FROM settings WHERE key='indexnow:last'");
      if (row && String(row.value || '').slice(0, 10) === day) {
        return { ok: true, skipped: true, reason: 'already_pinged_today', last: row.value };
      }
    } catch { /* テーブルが無くても送信は続行する */ }
  }

  const host = indexNowHost(env);
  const urlList = PUBLIC_PATHS.map((p) => `https://${host}${p}`);

  let status = 0;
  let error = null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList }),
    });
    status = res.status;
  } catch (e) {
    error = String((e && e.message) || e);
  }

  const ok = status >= 200 && status < 300;

  if (ok && store) {
    try {
      await store.run(
        "INSERT INTO settings (key,value,updated_at) VALUES ('indexnow:last',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        `${day}T00:00:00Z`,
        new Date().toISOString()
      );
    } catch { /* 記録失敗は送信成功を打ち消さない */ }
  }

  return { ok, status, sent: urlList.length, host, error };
}
