// Scout（自動リサーチ）と Free stack（無料リソース台帳）のテスト。
// 外部通信はしない（fetch を差し替える）。ここで確かめるのは
// ・点数化が「金の話」を優先し、バズだけの話を上げないこと
// ・巡回先ごとに形の違う応答を共通の形へ落とせること
// ・原価0の制約（費用のある手順を計画に入れない）が守られること
// ・重複を二度拾わないこと
// ・無料リソースの実測プローブが「生きている/落ちている」を正しく分けること
import assert from 'node:assert/strict';
import {
  SOURCES, scoreItem, capabilityFit, trialPlan, dedupeKey, parseItems, parseRss,
  scoutTick, listFindings, scoutSummary, scoutCards, scoutHelp, ensureScoutTable,
} from '../src/agent/scout.js';
import {
  FREE_RESOURCES, PROBES, probeFreeStack, freeStackReport, freeStackCards, keylessFree, byId,
} from '../src/agent/freeStack.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// --- 記憶だけの store 差し替え -------------------------------------------------
function memStore() {
  const settings = {}; const findings = [];
  return {
    _findings: findings, _settings: settings,
    async run(sql, ...a) {
      if (/CREATE TABLE|CREATE UNIQUE INDEX/i.test(sql)) return {};
      if (/INSERT INTO scout_findings/i.test(sql)) {
        const key = a[1];
        if (findings.some((f) => f.key === key)) throw new Error('UNIQUE constraint failed');
        findings.push({ id: a[0], key, source_id: a[2], title: a[3], url: a[4], excerpt: a[5], tags_json: a[6], score: a[7], fresh: a[8], engage: a[9], age_hours: a[10], signals_json: a[11], money_json: a[12], fits_json: a[13], trial_json: a[14], status: a[15], note: a[16], created_at: a[17], updated_at: a[18] });
        return {};
      }
      if (/INSERT INTO settings/i.test(sql)) {
        if (sql.includes("'scout:idx'")) settings['scout:idx'] = a[0];
        if (sql.includes("'scout:last_run'")) settings['scout:last_run'] = a[0];
        return {};
      }
      return {};
    },
    async first(sql) { if (/FROM settings/i.test(sql)) return { value: settings['scout:idx'] ?? null }; return null; },
    async all(sql, ...a) {
      if (/FROM scout_findings/i.test(sql)) {
        const min = Number(a[0]) || 0;
        return findings.filter((f) => f.score >= min).sort((x, y) => y.score - x.score).slice(0, Number(a[1]) || 30);
      }
      return [];
    },
  };
}

const NOW = new Date();
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();

// --- 巡回先はすべて無料・鍵不要であること（原価0の前提）------------------------
await t('巡回先: すべて無料・APIキー不要である', () => {
  assert.ok(SOURCES.length >= 10, `sources=${SOURCES.length}`);
  for (const s of SOURCES) {
    assert.equal(s.free, true, `${s.id} が無料でない`);
    assert.equal(s.needs_key, false, `${s.id} が鍵を要求する`);
    assert.ok(s.source && s.source.startsWith('http'), `${s.id}: 出典URL`);
    assert.ok(typeof s.url === 'function', `${s.id}: url() が必要`);
  }
  assert.ok(SOURCES.every((s) => typeof s.url(5) === 'string' && s.url(5).startsWith('https://')),
    'url() は https の文字列を返すこと');
});

// --- 点数化 -------------------------------------------------------------------
await t('点数: 「金を払う」の直球が最上位になる', () => {
  const money = scoreItem({ title: 'Willing to pay $50/mo for an API that does this', excerpt: 'bounty', created_at: hoursAgo(2), points: 10, comments: 3 });
  const hype = scoreItem({ title: 'Crypto airdrop 100x to the moon', excerpt: '', created_at: hoursAgo(2), points: 900, comments: 400 });
  assert.ok(money.score > hype.score, `money=${money.score} hype=${hype.score}`);
  assert.ok(money.money.length >= 2, JSON.stringify(money.money));
  assert.ok(hype.signals.includes('crypto_hype'));
});

await t('点数: 古い情報は減点され、新しい情報が上がる', () => {
  const fresh = scoreItem({ title: 'x402 API bounty', created_at: hoursAgo(1) });
  const stale = scoreItem({ title: 'x402 API bounty', created_at: hoursAgo(24 * 30) });
  assert.ok(fresh.score > stale.score, `fresh=${fresh.score} stale=${stale.score}`);
});

await t('点数: 収益シグナルの語を正しく拾う', () => {
  const a = scoreItem({ title: '新しいAPIを有料で販売します', created_at: hoursAgo(3) });
  assert.ok(a.signals.includes('pay_intent') || a.signals.includes('price'), JSON.stringify(a.signals));
  const b = scoreItem({ title: '懸賞金つきのバグ報告を募集', created_at: hoursAgo(3) });
  assert.ok(b.signals.includes('bounty'), JSON.stringify(b.signals));
});

// --- 能力との相性 / 試し方 -----------------------------------------------------
await t('相性: 文面から載せ先を決める（必ず1つ以上返す）', () => {
  assert.deepEqual(capabilityFit({ title: 'x402 agent payment API' }).includes('x402'), true);
  assert.deepEqual(capabilityFit({ title: 'MCP server for scraping' }).includes('mcp'), true);
  const f = capabilityFit({ title: '普通の雑談' });
  assert.ok(f.length >= 1, JSON.stringify(f));
});

await t('試し方: 原価0の手順しか入れない（人のタップを明示する）', () => {
  const plan = trialPlan({ title: 'x' }, ['x402', 'content']);
  assert.ok(plan.steps.length >= 3);
  assert.equal(plan.money_at_risk_jpy, 0);
  assert.ok(plan.steps.every((s) => s.cost_jpy === 0), JSON.stringify(plan.steps));
  assert.ok(plan.human_taps.includes('投稿の1タップ'));
  assert.ok(plan.note.includes('原価0'));
});

// --- 解析 ---------------------------------------------------------------------
await t('解析: HN の JSON を共通の形に落とす', () => {
  const src = SOURCES.find((s) => s.id === 'hn_show');
  const json = JSON.stringify({ hits: [{ title: 'Show HN: paid API', url: 'https://x.test/a', objectID: '1', created_at: hoursAgo(2), points: 5, num_comments: 2, _tags: ['story'] }] });
  const items = parseItems(src, json);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://x.test/a');
  assert.equal(items[0].points, 5);
});

await t('解析: URL の無い HN 記事は HN 本体のURLに寄せる', () => {
  const src = SOURCES.find((s) => s.id === 'hn_ask');
  const json = JSON.stringify({ hits: [{ title: 'Ask HN: how do you price an API?', objectID: '42', created_at: hoursAgo(1) }] });
  const items = parseItems(src, json);
  assert.equal(items[0].url, 'https://news.ycombinator.com/item?id=42');
});

await t('解析: GitHub の issue と repo を別々に落とす', () => {
  const iss = parseItems(SOURCES.find((s) => s.id === 'gh_bounty'), JSON.stringify({ items: [{ title: 'Fix x', html_url: 'https://github.com/a/b/issues/1', body: 'bounty $200', created_at: hoursAgo(4), comments: 3, labels: [{ name: 'bounty' }] }] }));
  assert.equal(iss[0].tags[0], 'bounty');
  const rep = parseItems(SOURCES.find((s) => s.id === 'gh_new_tools'), JSON.stringify({ items: [{ full_name: 'a/b', description: 'paid api tool', html_url: 'https://github.com/a/b', created_at: hoursAgo(5), stargazers_count: 12, topics: ['api'] }] }));
  assert.equal(rep[0].title.startsWith('a/b'), true);
});

await t('解析: RSS / Atom の両方を読める', () => {
  const rss = '<rss><channel><item><title>T1</title><link>https://a.test/1</link><description>pay for api</description><pubDate>Tue, 14 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>';
  const a = parseRss(rss);
  assert.equal(a.length, 1); assert.equal(a[0].url, 'https://a.test/1');
  const atom = '<feed><entry><title>T2</title><link href="https://b.test/2"/><summary>bounty</summary><updated>2026-10-14T10:00:00Z</updated></entry></feed>';
  const b = parseRss(atom);
  assert.equal(b.length, 1); assert.equal(b[0].url, 'https://b.test/2');
});

await t('解析: 壊れた応答でも例外にしない（空を返す）', () => {
  assert.deepEqual(parseItems(SOURCES.find((s) => s.id === 'hn_show'), 'not json'), []);
});

// --- 巡回 ---------------------------------------------------------------------
await t('巡回: 点数以上のものだけ保存し、同じ物を二度拾わない', async () => {
  const store = memStore();
  await ensureScoutTable(store);
  const hit = { hits: [
    { title: 'Willing to pay for an MCP server that monitors pages', url: 'https://x.test/mcp', objectID: '1', created_at: hoursAgo(2), points: 30, num_comments: 12 },
    { title: 'Random weekend chatter', url: 'https://x.test/meh', objectID: '2', created_at: hoursAgo(2), points: 1, num_comments: 0 },
  ] };
  const fake = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(hit) });
  const r1 = await scoutTick({ store, fetchImpl: fake, maxSources: 1, perSource: 5, minScore: 30 });
  assert.ok(r1.inserted >= 1, `inserted=${r1.inserted}`);
  assert.ok(r1.top[0].score >= 30);
  const n1 = store._findings.length;
  const r2 = await scoutTick({ store, fetchImpl: fake, maxSources: 1, perSource: 5, minScore: 30 });
  assert.equal(store._findings.length, n1, '重複が増えている');
  assert.equal(r2.sources[0].kept, 0, '2回目は保存されないはず');
});

await t('巡回: 失敗した応答を例外にせず記録する', async () => {
  const store = memStore();
  const bad = async () => ({ ok: false, status: 429, text: async () => '' });
  const r = await scoutTick({ store, fetchImpl: bad, maxSources: 2, perSource: 3 });
  assert.equal(r.inserted, 0);
  assert.ok(r.sources.every((s) => s.status === 429 || s.error));
});

await t('巡回: 通信が落ちても止まらない（error を持つ）', async () => {
  const store = memStore();
  const boom = async () => { throw new Error('network down'); };
  const r = await scoutTick({ store, fetchImpl: boom, maxSources: 1, perSource: 2 });
  assert.equal(r.inserted, 0);
  assert.ok(r.sources[0].error.includes('network down'));
});

await t('巡回: 巡回先の順番が毎回進む（偏らない）', async () => {
  const store = memStore();
  const ok = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ hits: [] }) });
  await scoutTick({ store, fetchImpl: ok, maxSources: 3, perSource: 2 });
  assert.ok(store._settings['scout:idx'] != null);
  const first = JSON.parse(store._settings['scout:idx']);
  await scoutTick({ store, fetchImpl: ok, maxSources: 3, perSource: 2 });
  const second = JSON.parse(store._settings['scout:idx']);
  assert.notEqual(first, second, 'インデックスが進んでいない');
});

await t('まとめ: 保存が無くても落ちず、カードとヘルプを返す', async () => {
  const store = memStore();
  const s = await scoutSummary(store);
  assert.equal(s.measured, false);
  const cards = scoutCards(s);
  assert.ok(cards.length >= 3);
  assert.ok(scoutHelp().length > 50);
});

// --- 無料スタック -------------------------------------------------------------
await t('台帳: 無料とだけ書かれた情報を混ぜない（鍵の要否を持つ）', () => {
  assert.ok(FREE_RESOURCES.length >= 20, `n=${FREE_RESOURCES.length}`);
  for (const r of FREE_RESOURCES) {
    assert.ok(r.id && r.label && r.kind, 'id/label/kind');
    assert.equal(typeof r.needs_key, 'boolean', `${r.id}: needs_key`);
    assert.equal(r.paid, false, `${r.id}: 課金物を入れない`);
    assert.ok(r.source && r.source.startsWith('http'), `${r.id}: 出典URL`);
  }
  assert.ok(keylessFree().length >= 10, `keyless=${keylessFree().length}`);
  assert.ok(byId('hn_algolia'));
  assert.equal(byId('nope'), null);
});

await t('プローブ: 生きている/落ちている/タイムアウトを分ける', async () => {
  const probes = [
    { id: 'hn_algolia', url: 'https://a.test/ok', ok: [200] },
    { id: 'github_api', url: 'https://b.test/down', ok: [200] },
    { id: 'lobsters', url: 'https://c.test/slow', ok: [200] },
  ];
  const fake = async (url) => {
    if (url.includes('ok')) return { status: 200, ok: true };
    if (url.includes('down')) return { status: 503, ok: false };
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const r = await probeFreeStack({ fetchImpl: fake, probes });
  assert.equal(r.alive, 1);
  assert.equal(r.dead, 2);
  assert.equal(r.results[1].status, 503);
  assert.equal(r.results[2].error, 'timeout');
  assert.equal(r.results[0].alive, true);
});

await t('プローブ: 401 は「生きている」として扱う（鍵が要るだけ）', async () => {
  const fake = async () => ({ status: 401, ok: false });
  const r = await probeFreeStack({ fetchImpl: fake, probes: [{ id: 'cdp_supported', url: 'https://x.test', ok: [200, 401] }] });
  assert.equal(r.alive, 1);
  assert.ok(String(r.results[0].note || '').includes('認証'));
});

await t('レポート: 実測を台帳に結合し、カードを返す', () => {
  const probe = { at: 'now', total: 2, alive: 1, dead: 1, results: [{ id: 'hn_algolia', alive: true, status: 200, ms: 120 }] };
  const rep = freeStackReport({ probe });
  assert.ok(rep.total >= 20);
  assert.ok(rep.rows.some((r) => r.id === 'hn_algolia' && r.live === true));
  assert.ok(rep.by_kind.every((k) => k.total > 0));
  const cards = freeStackCards(rep);
  assert.ok(cards.length >= 2);
  assert.ok(Array.isArray(rep.needs_human_key));
});

await t('プローブ定義: URL と期待ステータスを持つ', () => {
  assert.ok(PROBES.length >= 15, `probes=${PROBES.length}`);
  for (const p of PROBES) {
    assert.ok(p.url.startsWith('http'), `${p.id}: url`);
    assert.ok(Array.isArray(p.ok) && p.ok.length, `${p.id}: ok`);
  }
});

console.log(`\nScout/FreeStack tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
