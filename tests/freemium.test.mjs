// 無料枠（フリーミアム）の検査。
//   * 対象は決定的な4品目だけ（AI を使う品目は原価が売価を食うので無料にしない）
//   * 上限は IPごと・UTC日ごと。url-meta だけは外向き取得があるので別枠で小さい
//   * 上限に達したら 402（x402 の入口）に切り替わる
//   * 台帳（receipts）には一切触れない ＝ 売上の測定を濁さない
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  freeTierResources, freeTierEnabled, freeQuotaFor, freeTierScope,
  consumeFreeQuota, handleFree, clientIp, dayKey,
} from '../src/agent/freemium.js';
import { X402_CATALOG } from '../src/agent/x402.js';

function makeStore(seed = []) {
  const T = { settings: seed.slice() };
  return {
    _t: T,
    async first(sql, ...args) {
      if (/INSERT INTO settings/i.test(sql) && /RETURNING/i.test(sql)) {
        const key = args[0];
        const r = T.settings.find((x) => x.key === key);
        const n = (Number(r && r.value) || 0) + 1;
        if (r) r.value = String(n); else T.settings.push({ key, value: String(n) });
        return { value: String(n) };
      }
      if (/FROM settings/i.test(sql)) return T.settings.find((x) => x.key === args[0]) || null;
      return null;
    },
    async run() { return { ok: true }; },
  };
}

const req = (path, init) => new Request(`https://wa.test${path}`, init);
const ipReq = (path, init = {}) => req(path, { ...init, headers: { 'CF-Connecting-IP': '203.0.113.9', ...(init.headers || {}) } });

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n     ${e.message}`); }
};

await t('無料枠の対象は決定的な4品目だけ（AI を使う品目は有料のまま）', async () => {
  const list = freeTierResources();
  assert.deepEqual(list.sort(), ['csv-json', 'diff', 'regex', 'url-meta']);
  for (const r of ['brief', 'data-clean', 'code-review']) assert.ok(!list.includes(r), `${r} が無料になっている`);
  // カタログが唯一の出典になっている（別の場所に一覧を書いていない）
  assert.equal(X402_CATALOG.filter((i) => i.free_tier).length, 4);
});

await t('上限は IPごと・UTC日ごとに数え、超えたら枠を閉じる', async () => {
  const store = makeStore();
  const env = { FREE_DAILY_LIMIT: '2' };
  const a = await consumeFreeQuota(store, { ip: '1.1.1.1', resource: 'regex', env });
  const b = await consumeFreeQuota(store, { ip: '1.1.1.1', resource: 'diff', env });
  const c = await consumeFreeQuota(store, { ip: '1.1.1.1', resource: 'regex', env });
  assert.equal(a.ok, true); assert.equal(a.used, 1);
  assert.equal(b.ok, true, 'regex と diff は同じ枠を共有する');
  assert.equal(c.ok, false, '3回目で閉じていない');
  assert.equal(c.remaining, 0);
  const other = await consumeFreeQuota(store, { ip: '2.2.2.2', resource: 'regex', env });
  assert.equal(other.ok, true, 'IP が違えば別枠');
  assert.equal(dayKey() , new Date().toISOString().slice(0, 10));
});

await t('url-meta は外向き取得があるので別枠で小さく数える', async () => {
  const store = makeStore();
  const env = { FREE_DAILY_LIMIT: '25', FREE_URL_META_DAILY_LIMIT: '2' };
  assert.equal(freeQuotaFor(env, 'url-meta'), 2);
  assert.equal(freeQuotaFor(env, 'regex'), 25);
  assert.equal(freeTierScope('url-meta'), 'url-meta');
  assert.equal(freeTierScope('regex'), 'all');
  assert.equal((await consumeFreeQuota(store, { ip: '9.9.9.9', resource: 'url-meta', env })).ok, true);
  assert.equal((await consumeFreeQuota(store, { ip: '9.9.9.9', resource: 'url-meta', env })).ok, true);
  assert.equal((await consumeFreeQuota(store, { ip: '9.9.9.9', resource: 'url-meta', env })).ok, false);
  // url-meta の枠を使い切っても、他の3品目はまだ使える
  assert.equal((await consumeFreeQuota(store, { ip: '9.9.9.9', resource: 'regex', env })).ok, true);
});

await t('無料の呼び出しは台帳に触れない（売上の測定を濁さない）', async () => {
  const store = makeStore();
  const res = await handleFree(ipReq('/api/free/regex?pattern=ERROR%20(%5Cw%2B)&text=ERROR%20timeout&flags=g'), {}, new URL('https://wa.test/api/free/regex?pattern=ERROR%20(%5Cw%2B)&text=ERROR%20timeout&flags=g'), { store });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.via, 'free');
  assert.equal(body.price_usdc, 0);
  assert.equal(body.result.count, 1, JSON.stringify(body.result));
  assert.equal(body.receipt_id, undefined, '無料なのにレシートを発行している');
  assert.equal(store._t.settings.some((s) => String(s.key).startsWith('receipt')), false);
  assert.ok(String(res.headers.get('X-FREE-TIER') || '').startsWith('1/'), res.headers.get('X-FREE-TIER'));
  // 利用数は需要の計器としてだけ数える
  assert.ok(store._t.settings.some((s) => String(s.key).startsWith('freehits:')), JSON.stringify(store._t.settings));
});

await t('上限に達したら 402 に切り替わる（門を閉じず、有料の入口にする）', async () => {
  const store = makeStore();
  const env = { FREE_DAILY_LIMIT: '1' };
  const u = new URL('https://wa.test/api/free/diff?a=a&b=b');
  const first = await handleFree(ipReq('/api/free/diff?a=a&b=b'), env, u, { store });
  assert.equal(first.status, 200);
  const second = await handleFree(ipReq('/api/free/diff?a=a&b=b'), env, u, { store });
  const body = await second.json();
  assert.equal(second.status, 402, JSON.stringify(body));
  assert.equal(body.error, 'free_quota_exhausted');
  assert.ok(body.paid && body.paid.url.includes('/api/x402/diff'), JSON.stringify(body.paid));
  assert.equal(body.free.limit, 1);
});

await t('無料でない品目・不正な入力・無効化を、それぞれ区別して断る', async () => {
  const store = makeStore();
  const notFree = await handleFree(ipReq('/api/free/brief'), {}, new URL('https://wa.test/api/free/brief'), { store });
  assert.equal(notFree.status, 404);
  assert.equal((await notFree.json()).error, 'not_free');
  const bad = await handleFree(ipReq('/api/free/regex?pattern=(&text=x'), {}, new URL('https://wa.test/api/free/regex?pattern=(&text=x'), { store });
  assert.equal(bad.status, 400, JSON.stringify(await bad.json()));
  assert.equal(store._t.settings.length, 0, '不正な入力で枠を消費している');
  const off = await handleFree(ipReq('/api/free/regex?pattern=a&text=a'), { FREE_TIER_ENABLED: '0' }, new URL('https://wa.test/api/free/regex?pattern=a&text=a'), { store });
  assert.equal(off.status, 503);
  assert.equal(freeTierEnabled({}), true, '既定は有効');
  assert.equal(freeTierEnabled({ FREE_TIER_ENABLED: '0' }), false);
});

await t('一覧は機械がそのまま叩けるURL付きで返る', async () => {
  const store = makeStore([{ key: `freehits:${dayKey()}`, value: '7' }]);
  const res = await handleFree(req('/api/free'), {}, new URL('https://wa.test/api/free'), { store });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.free_resources.length, 4);
  assert.equal(body.hits_today, 7);
  for (const r of body.free_resources) {
    assert.ok(r.example_url.startsWith('https://wa.test/api/free/'), r.example_url);
    assert.ok(r.example_url.includes('?'), `${r.resource} に例が無い`);
  }
  const regex = body.free_resources.find((r) => r.resource === 'regex');
  assert.ok(regex.example_url.includes('pattern='), regex.example_url);
});

await t('呼び出し元IPと1日1回の通知の配線が index.js にある', async () => {
  assert.equal(clientIp(req('/', { headers: { 'CF-Connecting-IP': '198.51.100.7' } })), '198.51.100.7');
  assert.equal(clientIp(req('/', { headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' } })), '8.8.8.8');
  const idx = fs.readFileSync('src/index.js', 'utf8');
  assert.match(idx, /url\.pathname\.startsWith\('\/api\/free\/'\)/, '無料枠の入口が無い');
  assert.match(idx, /isFreeTier/, '認証の外に置かれていない（買い手が入れない）');
  assert.match(idx, /api\/free/, 'llms.txt に無料枠の案内が無い');
  const now = fs.readFileSync('src/agent/indexnow.js', 'utf8');
  assert.match(now, /'\/api\/free'/, 'IndexNow に無料枠の入口が入っていない');
});

console.log(`\nFREE: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
