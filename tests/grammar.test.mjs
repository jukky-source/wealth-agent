// Logic space（論理空間）のテスト。
// ・空間は数え上げられる（番号→論理が決定論的、住所が衝突しない）
// ・因果性（未来参照なし）: 途中までのデータで計算した意図が、後ろのデータで変わらない
// ・週足のシグナルは「その週が終わってから」しか使わない
// ・エージェント内（Worker）で回る: 1tickで実験を積み、カーソルが進み、記録が残る
// ・外部通信はしない（fetch を差し替える）。無料ホスト以外を叩かないことも機械で検査する
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store, ensureSchema } from '../src/db.js';
import {
  SYMBOLS, coreSize, coreAxes, ruleSize, spaceSize, coreAt, randomRule, materialize,
  logicKey, describeLogic, exitParams, logicIntent, resampleWeekly, mapWeeklyToDaily,
  ATOMS, FEATURES, TIMEFRAMES, NOT_INCLUDED,
} from '../src/income/grammar.js';
import { T, ensureLabTable } from '../src/income/fxLab.js';
import { STRATEGIES, backtest, DEFAULT_COST_MODEL } from '../src/income/backtest.js';
import { logicTick, logicSpaceInfo, spaceReport, LOGIC_STATS_KEY } from '../src/income/logic.js';
import { deepValidate } from '../src/income/robust.js';
import { seededRandom } from '../src/util.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

function makeDb() {
  const db = new DatabaseSync(':memory:');
  const prepare = (sql) => {
    const st = db.prepare(sql);
    return {
      bind: (...p) => ({
        all: () => ({ results: st.all(...p) }),
        first: () => st.get(...p) ?? null,
        run: () => st.run(...p),
      }),
      all: () => ({ results: st.all() }),
      first: () => st.get() ?? null,
      run: () => st.run(),
    };
  };
  return { exec: (s) => db.exec(s), prepare };
}

// 波のある合成データ（値動きが無いと取引が生まれない）
function makeBars(n = 700, seed = 11) {
  let a = seed; const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  const bars = []; let price = 150;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 31) * 0.6;
    const ch = (rnd() - 0.5) * 1.3 + drift * 0.2;
    const open = price; const close = Math.max(40, open + ch);
    bars.push({
      date: new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10),
      open, close, high: Math.max(open, close) + rnd() * 0.6, low: Math.min(open, close) - rnd() * 0.6,
    });
    price = close;
  }
  return bars;
}
const BARS = makeBars();

const FREE_HOSTS = ['https://query1.finance.yahoo.com/', 'https://api.frankfurter.app/'];
const hitUrls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  hitUrls.push(u);
  return {
    ok: true, status: 200,
    json: async () => ({
      chart: { result: [{
        timestamp: BARS.map((b, i) => Math.floor(Date.UTC(2023, 0, 2 + i) / 1000)),
        indicators: { quote: [{ open: BARS.map((b) => b.open), high: BARS.map((b) => b.high), low: BARS.map((b) => b.low), close: BARS.map((b) => b.close) }] },
      }] },
    }),
    text: async () => '{}',
  };
};

// ---------------------------------------------------------------------------
await t('空間: 数え上げが定義どおり（軸の積＝全体、合成層は100万件超）', () => {
  const axes = coreAxes(SYMBOLS);
  const product = axes.reduce((a, b) => a * b, 1);
  assert.equal(coreSize(SYMBOLS), product, 'コア層は軸の積');
  assert.ok(product > 50000, `コア層が小さすぎる: ${product}`);
  const rule = ruleSize(SYMBOLS);
  assert.ok(rule > 1000000, `合成層が小さすぎる: ${rule}`);
  assert.equal(spaceSize(SYMBOLS), product + rule, '全体＝コア＋合成');
  const plan = spaceReport({ FX_LAB_LOGIC_PER_TICK: '3', FX_LAB_LOGIC_EVERY_MINUTES: '5' });
  assert.equal(plan.per_day, 3 * 288, '1日あたりの消化数');
  assert.ok(plan.core_days > 0, 'コア全通りまでの日数が出る');
});

await t('番号: 同じ番号は同じ論理、違う番号は違う住所（衝突しない）', () => {
  const a1 = JSON.stringify(coreAt(1234));
  const a2 = JSON.stringify(coreAt(1234));
  assert.equal(a1, a2, '決定論的');
  const seen = new Map();
  let dup = 0;
  for (let i = 0; i < 2000; i++) {
    const spec = coreAt(i);
    const k = logicKey(spec);
    if (seen.has(k)) dup++;
    else seen.set(k, i);
    assert.equal(spec.idx, i, '番号が保たれている');
  }
  assert.ok(dup <= 2, `住所の衝突が多すぎる: ${dup}`);
  assert.equal(coreAt(coreSize(SYMBOLS)).idx, coreSize(SYMBOLS), '番号は周回する（1周目に戻る）');
});

await t('網羅: コア層は全ての軸の値を一通り含む（偏りなく踏破できる）', () => {
  const total = coreSize(SYMBOLS);
  const seen = { symbol: new Set(), tf: new Set(), filter: new Set(), exit: new Set(), dir: new Set(), strategy: new Set() };
  for (let i = 0; i < total; i++) {
    const s = coreAt(i);
    seen.symbol.add(s.symbol); seen.tf.add(s.tf); seen.filter.add(s.filter);
    seen.exit.add(s.exit); seen.dir.add(s.dir); seen.strategy.add(`${s.base.key}#${s.base.variant}`);
  }
  assert.equal(seen.symbol.size, SYMBOLS.length);
  assert.equal(seen.tf.size, TIMEFRAMES.length);
  assert.equal(seen.exit.size, 6);
  assert.equal(seen.dir.size, 3);
  assert.ok(seen.filter.size >= 13, `絞り込みの種類: ${seen.filter.size}`);
  assert.ok(seen.strategy.size >= 51, `戦略presetの数: ${seen.strategy.size}`);
});

await t('因果性: 途中までのデータで計算した意図が、後ろのデータで変わらない', () => {
  const specs = [
    { v: 1, tier: 'core', symbol: 'USDJPY', tf: '1d', filter: 'none', exit: 'balanced', dir: 'both', base: { kind: 'strategy', key: 'ema_cross', variant: 0, params: { ...STRATEGIES.ema_cross.defaultParams } } },
    { v: 1, tier: 'core', symbol: 'USDJPY', tf: '1w', filter: 'squeeze', exit: 'trail', dir: 'both', base: { kind: 'rule', a: 3, b: 40, comb: 'and' } },
    { v: 1, tier: 'rule', symbol: 'GOLD', tf: '1d', filter: 'none', exit: 'flip', dir: 'long', base: { kind: 'rule', a: 12, b: null, comb: 'and' } },
  ];
  for (const spec of specs) {
    const full = logicIntent(BARS, spec, {});
    const cut = 420;
    const partial = logicIntent(BARS.slice(0, cut), spec, {});
    assert.equal(partial.length, cut, '長さが合う');
    for (let i = 0; i < cut; i++) assert.equal(partial[i], full[i], `spec ${spec.tf}/${spec.base.kind}: 添字 ${i} が未来参照で変わった`);
  }
});

await t('方向: 買いのみ／売りのみが守られる', () => {
  const baseSpec = { v: 1, tier: 'rule', symbol: 'USDJPY', tf: '1d', filter: 'none', exit: 'balanced', base: { kind: 'rule', a: 20, b: 80, comb: 'or' } };
  const longOnly = logicIntent(BARS, { ...baseSpec, dir: 'long' }, {});
  const shortOnly = logicIntent(BARS, { ...baseSpec, dir: 'short' }, {});
  assert.ok(longOnly.every((v) => v >= 0), '買いのみ: 売りが混ざらない');
  assert.ok(shortOnly.every((v) => v <= 0), '売りのみ: 買いが混ざらない');
  assert.ok(longOnly.some((v) => v === 1) || shortOnly.some((v) => v === -1), 'どちらかはシグナルが出る');
});

await t('週足: その週が終わるまでシグナルを使わない（未来参照なし）', () => {
  const wk = resampleWeekly(BARS);
  assert.ok(wk.length >= 99 && wk.length < BARS.length, `週足に集約: ${wk.length} / 日足 ${BARS.length}`);
  for (const b of wk) assert.ok(b.endDate >= b.date, 'endDate が入っている');
  const raw = new Array(wk.length).fill(1);   // 常に買い
  const mapped = mapWeeklyToDaily(BARS, wk, raw);
  // 最初の週が終わるまでは 0
  const firstEnd = wk[0].endDate;
  for (let i = 0; i < BARS.length; i++) {
    if (BARS[i].date <= firstEnd) assert.equal(mapped[i], 0, `${BARS[i].date} は最初の週の内側なので 0`);
  }
  assert.equal(mapped[BARS.length - 1], 1, '最後はシグナルが入る');
});

await t('実行: 合成論理を登録して、既存エンジンでバックテストできる', () => {
  const rnd = seededRandom('bt');
  let ran = 0;
  for (let i = 0; i < 6; i++) {
    const spec = randomRule(rnd, ['USDJPY']);
    const key = materialize(spec);
    assert.ok(STRATEGIES[key], `${key} が登録された`);
    const r = backtest(BARS, { strategyKey: key, params: { ...exitParams(spec), symbol: spec.symbol, logic: spec }, cost: { ...DEFAULT_COST_MODEL } });
    assert.ok(r.metrics && typeof r.metrics.netProfitPct === 'number', '指標が出る');
    assert.equal(r.trades.length, r.metrics.trades);
    ran++;
  }
  assert.equal(ran, 6);
});

await t('出口: 週足はATR倍率を広げ、上限（丸め）で潰れない', () => {
  const daily = exitParams({ exit: 'flip', tf: '1d', dir: 'both' });
  const weekly = exitParams({ exit: 'flip', tf: '1w', dir: 'both' });
  assert.ok(weekly.atrStopMult > daily.atrStopMult, `週足の方が広い: ${weekly.atrStopMult} > ${daily.atrStopMult}`);
  assert.ok(weekly.atrStopMult <= 8, `丸めの上限内: ${weekly.atrStopMult}`);
  const spec = { v: 1, tier: 'core', symbol: 'USDJPY', tf: '1w', filter: 'none', exit: 'flip', dir: 'both', base: { kind: 'rule', a: 1, b: null, comb: 'and' } };
  const key = materialize(spec);
  const p = STRATEGIES[key].defaultParams;
  assert.equal(p.atrStopMult, weekly.atrStopMult, '既定値にも同じ倍率が入る');
});

await t('検証: 既存のフル検証（11項目）にそのまま乗る', () => {
  const spec = { v: 1, tier: 'rule', symbol: 'USDJPY', tf: '1d', filter: 'none', exit: 'balanced', dir: 'both', base: { kind: 'rule', a: 30, b: 100, comb: 'and' } };
  const key = materialize(spec);
  const r = deepValidate(BARS, {
    symbol: 'USDJPY', strategyKey: key, params: { ...exitParams(spec), symbol: 'USDJPY', logic: spec },
    cost: { ...DEFAULT_COST_MODEL }, source: 'synthetic', trials: 12, trialSharpes: [1, 2, 3], seed: 'gtest',
    budgetMs: 20000, B_null: 5, B_boot: 50, s: 4,
  });
  assert.equal(r.ok, true, `検証が走る: ${r.reason || ''}`);
  assert.ok(r.gates && typeof r.gates.pass === 'boolean', '合否が出る');
  assert.ok(r.dsr && typeof r.dsr.dsr === 'number', 'DSRが出る');
  assert.ok(r.null_test, 'ランダムエントリー比較が出る');
});

await t('1tick: 番号順に積み、カーソルと記録が残る（負けも消さない）', async () => {
  const store = new Store(makeDb());
  await ensureSchema(store);
  const r1 = await logicTick({ store, env: { FX_LAB_LOGIC_PER_TICK: '2', FX_LAB_LOGIC_BUDGET_MS: '15000' }, n: 2, symbols: ['USDJPY'] });
  assert.ok(r1.ran >= 1, `実験が回った: ran=${r1.ran} skipped=${r1.skipped}`);
  const rows = await store.all(`SELECT * FROM ${T} WHERE tag LIKE 'logic:%'`);
  assert.equal(rows.length, r1.ran, '記録件数が実行件数と一致');
  const stats = JSON.parse((await store.first(`SELECT value FROM settings WHERE key=?`, LOGIC_STATS_KEY)).value);
  assert.ok(stats.core_cursor >= 1, `カーソルが進んだ: ${stats.core_cursor}`);
  assert.equal(stats.evaluated, stats.evaluated_core + stats.evaluated_rule, '内訳が合う');

  const r2 = await logicTick({ store, env: { FX_LAB_LOGIC_PER_TICK: '2' }, n: 2, symbols: ['USDJPY'] });
  const stats2 = JSON.parse((await store.first(`SELECT value FROM settings WHERE key=?`, LOGIC_STATS_KEY)).value);
  assert.ok(stats2.core_cursor > stats.core_cursor, '2回目もカーソルが進む');

  const info = await logicSpaceInfo(store, {});
  assert.equal(info.evaluated_core + info.evaluated_rule, stats2.evaluated, '集計が一致');
  assert.ok(info.coverage_pct_core > 0, '踏破率が出る');
  assert.ok(Array.isArray(info.not_included) && info.not_included.length >= 5, '空間に入っていないものを明示する');
  assert.equal(info.not_included.length, NOT_INCLUDED.length);
  assert.ok(r2.experiments.length >= 1, '何を試したかが返る');
});

await t('原価0: 無料ホスト以外を叩かない', () => {
  const bad = hitUrls.filter((u) => !FREE_HOSTS.some((h) => u.startsWith(h)));
  assert.equal(bad.length, 0, `無料以外の通信: ${bad.slice(0, 3).join(' / ')}`);
  assert.ok(hitUrls.length > 0, '市場データは取得している');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
