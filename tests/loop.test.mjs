// 「集める → 試す計画 → 実行 → 結果の書き戻し」の輪と、EA書き出しの検査。
// D1 の代わりに、必要なクエリだけを解釈する小さなメモリ内ストアを使う。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  COCONALA_OFFERS, templateCoconala, recordOutcome, outcomeBoard, findingFeedback,
  applyDecidedPrice, refillQueue, OUTCOMES, outcomeById,
} from '../src/agent/social.js';
import { shapeFinding, scoutFindings, trialPlan, CAPABILITIES } from '../src/agent/scout.js';
import { EA_SPECS, eaStrategyKeys, generateMql5, lintMql5, buildEa } from '../src/income/ea.js';

function makeStore(seed = {}) {
  const T = { publish_drafts: [], scout_findings: [], social_outcomes: [], fx_strategies: [], fx_ea_exports: [], settings: [] };
  for (const [k, v] of Object.entries(seed)) T[k] = v.slice();
  const tableOf = (sql) => Object.keys(T).find((k) => String(sql).includes(k));
  return {
    _t: T,
    async run(sql, ...args) {
      if (/CREATE|INDEX/i.test(sql)) return { ok: true };
      const t = tableOf(sql);
      if (t === 'scout_findings' && /UPDATE/i.test(sql)) {
        const [status, , id] = args; const r = T.scout_findings.find((x) => x.id === id); if (r) r.status = status; return { ok: true };
      }
      if (t === 'publish_drafts' && /UPDATE/i.test(sql)) {
        const [body, , id] = args; const r = T.publish_drafts.find((x) => x.id === id); if (r) r.body = body; return { ok: true };
      }
      if (t === 'settings' && /INSERT/i.test(sql)) {
        const [key, value] = args; const r = T.settings.find((x) => x.key === key);
        if (r) r.value = value; else T.settings.push({ key, value }); return { ok: true };
      }
      return { ok: true };
    },
    async all(sql, ...args) {
      const t = tableOf(sql); if (!t) return [];
      let rows = T[t].slice();
      if (t === 'scout_findings' && /score >=/.test(sql)) rows = rows.filter((r) => Number(r.score) >= Number(args[0]));
      const nums = args.filter((a) => typeof a === 'number');
      const lim = nums.length ? nums[nums.length - 1] : null;
      if (lim) rows = rows.slice(0, lim);
      return rows;
    },
    async first(sql, ...args) {
      if (/COUNT/.test(sql)) return { n: (T[tableOf(sql)] || []).length };
      if (/FROM settings/.test(sql)) return T.settings.find((s) => s.key === args[0]) || null;
      const t = tableOf(sql); return (T[t] || [])[0] || null;
    },
    async get(t, id) { return (T[t] || []).find((r) => r.id === id) || null; },
    async insert(t, row) { (T[t] = T[t] || []).push(row); return { ok: true }; },
  };
}

const finding = (over = {}) => ({
  id: 'f1', key: 'k1', source_id: 'hn_show', title: 'テスト候補', url: 'https://example.com/a',
  excerpt: 'x402 で課金するAPIの話', tags_json: '[]', score: 50, fresh: 12, engage: 3, age_hours: 5,
  signals_json: '["bounty"]', money_json: '["bounty"]', fits_json: '["x402"]',
  trial_json: JSON.stringify(trialPlan({ title: 'テスト候補' }, ['x402'])),
  status: 'new', note: null, created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z', ...over,
});
const draft = (over = {}) => ({
  id: 'd1', thread_id: null, kind: 'post', channel: 'coconala', title: 'CSV・Excelの整理します',
  body: '【価格】\n案: 1,000円（あなたが決めてください）\n', lang: 'ja', ai_disclosure: 0,
  unique_commentary: 0, linked: 0, state: 'queued', blocks_json: '[]', scheduled_for: null,
  posted_url: null, approved_at: null, posted_at: null, created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z', day: '2026-10-16', ...over,
});

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n     ${e.message}`); }
};

await t('価格: ココナラの7品目はすべて980円で出る（案のままだと安く見られる）', async () => {
  assert.equal(COCONALA_OFFERS.length, 7);
  for (const o of COCONALA_OFFERS) assert.equal(o.jpy_hint, 980);
  const tpl = templateCoconala(COCONALA_OFFERS[0]);
  assert.ok(tpl.body.includes('980円'), tpl.body);
  assert.ok(!tpl.body.includes('案: '), '案表記が残っている');
});

await t('価格: すでに作った下書きの価格も980円に直せる（書き戻し）', async () => {
  const store = makeStore({ publish_drafts: [draft(), draft({ id: 'd2', channel: 'x', body: '案: 500円（あなたが決めてください）' })] });
  const r = await applyDecidedPrice(store, { jpy: 980 });
  assert.equal(r.updated, 1, JSON.stringify(r));
  assert.ok(store._t.publish_drafts[0].body.includes('980円'));
  assert.ok(store._t.publish_drafts[0].body.includes('変更できます'));
  assert.ok(store._t.publish_drafts[1].body.includes('案: 500円'), 'ココナラ以外は触らない');
});

await t('価格: 下書きをそろえると、古い価格のズレも自動で直る', async () => {
  const store = makeStore({ publish_drafts: [draft({ id: 'old1', body: '【価格】\n案: 1,000円（あなたが決めてください）\n' })] });
  const r = await refillQueue({ store, limit: 1, channels: ['coconala'] });
  assert.ok(r.price_aligned >= 1, JSON.stringify(r));
  assert.ok(store._t.publish_drafts.find((d) => d.id === 'old1').body.includes('980円'), '古い下書きの価格が直っていない');
});

await t('計画: 「試す計画」に費用のある手順が1つも入らない（原価0の強制）', async () => {
  const plan = trialPlan({ title: 'x402 の課金APIの話' }, ['x402', 'content']);
  assert.equal(plan.money_at_risk_jpy, 0);
  for (const s of plan.steps) assert.equal(s.cost_jpy, 0, JSON.stringify(s));
  assert.ok(plan.steps.some((s) => s.capability === 'measure'), '結果の記録ステップが無い');
  assert.ok(CAPABILITIES.every((c) => c.cost === 0));
});

await t('一覧: 拾った候補と試す計画が外から読める形になる', async () => {
  const store = makeStore({ scout_findings: [finding(), finding({ id: 'f2', key: 'k2', title: '安い候補', score: 20 })] });
  const rows = await scoutFindings(store, { limit: 20, minScore: 30 });
  assert.equal(rows.length, 1, 'しきい値で絞れていない');
  const r = rows[0];
  assert.equal(r.id, 'f1');
  assert.ok(Array.isArray(r.trial.steps) && r.trial.steps.length >= 2);
  assert.equal(r.trial_cost_jpy, 0);
  assert.ok(r.source_label, '媒体名が空');
  assert.equal(shapeFinding({ trial_json: '{壊れたJSON' }).trial_cost_jpy, 0);
});

await t('輪: 結果を記録すると次に効く（売れた＝重み+20が候補に戻る）', async () => {
  const store = makeStore({ scout_findings: [finding()], publish_drafts: [draft({ thread_id: 'f1' })] });
  const rec = await recordOutcome(store, { draft_id: 'd1', outcome: 'sold', note: '980円で1件' });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.finding_id, 'f1');
  const board = await outcomeBoard(store);
  assert.equal(board.recorded, 1);
  assert.equal(board.sold, 1);
  assert.equal(store._t.scout_findings[0].status, 'won', '候補に書き戻していない');
  const fb = await findingFeedback(store);
  assert.equal(fb.f1, 20, JSON.stringify(fb));
  assert.equal(outcomeById('unknown'), null);
  assert.equal((await recordOutcome(store, { outcome: 'でたらめ' })).ok, false);
});

await t('輪: 反応なしは負の重みで記録され、同じ手を繰り返さない判断に使える', async () => {
  const store = makeStore({ scout_findings: [finding()], publish_drafts: [draft({ thread_id: 'f1' })] });
  const rec = await recordOutcome(store, { draft_id: 'd1', outcome: 'no_reaction' });
  assert.ok(rec.recorded.weight < 0);
  assert.equal(store._t.scout_findings[0].status, 'cold');
  const fb = await findingFeedback(store);
  assert.ok(fb.f1 < 0, JSON.stringify(fb));
  assert.equal(OUTCOMES.length, 5);
});

await t('輪: 過去に売れた候補は、点数が低くても次に優先される（並び替えが実際に効く）', async () => {
  const store = makeStore({
    scout_findings: [finding({ id: 'fa', key: 'ka', title: '点が高いだけの候補', score: 50 }), finding({ id: 'fb', key: 'kb', title: '売れた候補', score: 45, url: 'https://example.com/b' })],
    publications: [],
    publish_drafts: [],
  });
  await recordOutcome(store, { channel: 'x', outcome: 'sold', note: null });
  const rec = store._t.social_outcomes[0];
  rec.finding_id = 'fb';
  await recordOutcome(store, { draft_id: null, channel: 'x', outcome: 'no_reaction' });
  const rep = await refillQueue({ store, limit: 1, minScore: 30, channels: ['x'] });
  assert.equal(rep.created.length, 1, JSON.stringify(rep));
  assert.equal(rep.created[0].from, '売れた候補', `並び替えが効いていない: ${JSON.stringify(rep.created)}`);
  assert.ok(rep.feedback && rep.feedback.recorded >= 1, JSON.stringify(rep.feedback));
});

await t('EA: 対応する戦略すべてで .mq5 が生成され、構造の自己点検を通る', async () => {
  assert.ok(eaStrategyKeys().length >= 4, `EA対応の戦略が ${eaStrategyKeys().length} 本`);
  for (const k of eaStrategyKeys()) {
    const g = generateMql5({ strategyKey: k, params: {}, symbol: 'USDJPY' });
    const l = lintMql5(g.mq5_code);
    assert.ok(l.ok, `${k}: ${JSON.stringify(l.failed)}`);
    assert.ok(g.filename.endsWith('.mq5'));
    assert.ok(g.set_code.includes('InpLots=0.10'));
    assert.ok(g.mq5_code.includes('CopyBuffer('));
    assert.ok(!g.mq5_code.includes('OrderSend('));
    assert.ok(EA_SPECS[k].label);
  }
});

await t('EA: 王者から書き出せる（成績・注意書きつき）', async () => {
  const params = { strategyKey: 'ema_cross', fast: 12, slow: 48, atrStopMult: 2.0, atrTargetMult: 3.0, trendFilter: 200, allowShort: true };
  const store = makeStore({
    settings: [{ key: 'fxlab:champion', value: JSON.stringify({ symbol: 'USDJPY', strategy_key: 'ema_cross', params, promoted_to: 'fxs_1', metrics: { netProfitPct: 293.85, profitFactor: 1.4, maxDrawdownPct: 33.41, trades: 120 } }) }],
    fx_strategies: [{ id: 'fxs_1', name: 'EMAクロス (USDJPY) v1', symbol: 'USDJPY', params_json: JSON.stringify(params), created_at: '2026-10-16T00:00:00Z' }],
  });
  const r = await buildEa(store, {});
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.source, 'champion');
  assert.equal(r.timeframe, 'PERIOD_D1');
  assert.ok(r.lint.ok, JSON.stringify(r.lint.failed));
  assert.ok(r.mq5_code.includes('InpFast          = 12'));
  assert.ok(r.mq5_code.includes('293.85'), '成績がコードに書かれていない');
  assert.ok(r.caveats.length >= 3);
  assert.equal(store._t.fx_ea_exports.length, 1);
  assert.ok(/^[A-Za-z0-9_]+\.mq5$/.test(r.filename), r.filename);
  assert.ok(r.filename.includes('ema_cross_USDJPY'), r.filename);
});

await t('EA: 王者がまだ無いときは、はっきり断る（黙って空を返さない）', async () => {
  const store = makeStore({});
  const r = await buildEa(store, {});
  assert.equal(r.ok, false);
  assert.ok(r.summary.includes('まだありません'));
});

await t('コピーできない端末にも逃げ道がある（1タップ・長押し・別タブ）', async () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('function copySmart'), 'copySmart がある');
  assert.ok(app.includes('function execCopy'), '同期コピーがある');
  assert.ok(app.includes("localStorage.setItem('wa_copybox'"), '控えを残す');
  assert.ok(app.includes('data-helper'), '別タブの逃げ道');
  assert.ok(app.includes('data-body='), '長押しできる枠');
  const helper = fs.readFileSync(new URL('../public/copy.html', import.meta.url), 'utf8');
  assert.ok(helper.includes("localStorage.getItem('wa_copybox')"), 'copy.html が同じ控えを読む');
  assert.ok(helper.includes('全選択'), '長押しの案内がある');
});

await t('売り場に置く入口がある（/v1・合鍵・OpenAPI・原価0のまま）', async () => {
  const idx = fs.readFileSync('src/index.js', 'utf8');
  assert.match(idx, /url\.pathname\.startsWith\('\/v1\/'\)/, '/v1 の入口が無い');
  assert.match(idx, /RAPIDAPI_PROXY_SECRET/, '売り場の合鍵照合が無い');
  assert.match(idx, /X-RapidAPI-Proxy-Secret/, '売り場ヘッダを見ていない');
  const conf = fs.readFileSync('wrangler.containers.toml', 'utf8');
  assert.match(conf, /"\/v1\/\*"/, 'run_worker_first に /v1/* が無い（404ではなくHTMLが返る）');
});

console.log(`\nLOOP: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

