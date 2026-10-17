// 今回追加した「リスクの見方」と「探索の設計」のテスト。
//   * 破産判定（資金が尽きたら止める）と、含み損込みの最大DD
//   * 銘柄 5 → 20 の裏取り（値幅・建て通貨・単位が全銘柄にある）
//   * 共有パラメータ制約（同じ設定を複数銘柄に当てる）と仮説の絞り込み
import assert from 'node:assert/strict';
import { simulateFromIntent, PAIRS } from '../src/income/backtest.js';
import { SUPPORTED_SYMBOLS } from '../src/income/fx.js';
import { basketFor, randomRule, ATOMS, featureKeys, SYMBOLS } from '../src/income/grammar.js';
import { seededRandom } from '../src/util.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

function barsFromCloses(closes) {
  const d0 = new Date('2015-01-05T00:00:00Z');
  return closes.map((c, i) => {
    const d = new Date(d0.getTime() + i * 86400000);
    const o = i === 0 ? c : closes[i - 1];
    return { date: d.toISOString().slice(0, 10), open: o, high: Math.max(o, c) * 1.0002, low: Math.min(o, c) * 0.9998, close: c };
  });
}
const falling = (n = 400) => barsFromCloses(Array.from({ length: n }, (_, i) => 100 * Math.pow(0.995, i)));
const alwaysLong = (n) => new Array(n).fill(1);

await t('破産: 資金が尽きたら取引を止め、ruin_stop で引ける', async () => {
  const bars = falling();
  const r = simulateFromIntent(bars, alwaysLong(bars.length), {
    params: { atrStopMult: 1000, atrTargetMult: 0 }, symbol: 'USDJPY',
    cost: { initialCapitalJPY: 10000 },
  });
  assert.equal(r.metrics.ruined, true, '破産と判定される');
  assert.ok(r.metrics.ruinDate, '破産した日付が残る');
  assert.equal(r.metrics.stoppedEarly, true, '途中で止めたことが分かる');
  assert.ok(r.trades.some((x) => x.reason === 'ruin_stop'), 'ruin_stop で引けている');
  const after = r.trades.filter((x) => x.exitDate > r.metrics.ruinDate);
  assert.equal(after.length, 0, '破産後は取引しない');
});

await t('破産: 資金が十分なら止めない（誤作動しない）', async () => {
  const bars = falling();
  const r = simulateFromIntent(bars, alwaysLong(bars.length), {
    params: { atrStopMult: 1000, atrTargetMult: 0 }, symbol: 'USDJPY',
    cost: { initialCapitalJPY: 50000000 },
  });
  assert.equal(r.metrics.ruined, false);
  assert.equal(r.metrics.stoppedEarly, false);
});

await t('破産: 明示的に切れる（noRuinStop）', async () => {
  const bars = falling();
  const r = simulateFromIntent(bars, alwaysLong(bars.length), {
    params: { atrStopMult: 1000, atrTargetMult: 0, noRuinStop: true }, symbol: 'USDJPY',
    cost: { initialCapitalJPY: 10000 },
  });
  assert.equal(r.metrics.ruined, false, '判定を切ると破産にしない');
});

await t('含み損込みDD: 実現損益だけのDDより大きい（深く沈む危険を見える化）', async () => {
  const closes = [];
  for (let i = 0; i < 120; i++) closes.push(100 + i);          // 上げ
  for (let i = 0; i < 120; i++) closes.push(220 - i * 1.4);    // 大きく沈む（建玉は持ち続ける）
  for (let i = 0; i < 120; i++) closes.push(52 + i * 1.4);     // 戻す
  const bars = barsFromCloses(closes);
  const r = simulateFromIntent(bars, alwaysLong(bars.length), {
    params: { atrStopMult: 1000, atrTargetMult: 0 }, symbol: 'USDJPY',
    cost: { initialCapitalJPY: 5000000 },
  });
  assert.equal(r.metrics.ruined, false, '破産はしない額（含み損は資金の内側）');
  assert.ok(r.metrics.maxDrawdownPctMtm >= 10, `含み損込みDDが計測される（${r.metrics.maxDrawdownPctMtm}%）`);
  assert.ok(r.metrics.maxDrawdownPctMtm > r.metrics.maxDrawdownPct, '実現損益だけのDDより大きい');
});

await t('銘柄: 20本すべてに値幅・建て通貨・単位がある', async () => {
  const keys = Object.keys(PAIRS);
  assert.equal(keys.length, 20, `20銘柄（実際 ${keys.length}）`);
  for (const k of keys) {
    const m = PAIRS[k];
    assert.ok(m.pip > 0, `${k}: pip`);
    assert.ok(m.quote && m.quote.length === 3, `${k}: 建て通貨`);
    assert.ok(m.units > 0, `${k}: 単位`);
    assert.ok(m.label, `${k}: 名前`);
  }
  assert.ok(SUPPORTED_SYMBOLS.includes('EURJPY') && SUPPORTED_SYMBOLS.includes('XAGUSD'), '追加銘柄が有効');
  assert.deepEqual(SUPPORTED_SYMBOLS.slice().sort(), keys.slice().sort(), '一覧が一致する');
});

await t('共有パラメータ制約: 同じ設定を3銘柄に当て、組が回る', async () => {
  const b0 = basketFor(0, SYMBOLS, 3);
  const b1 = basketFor(1, SYMBOLS, 3);
  assert.equal(b0.length, 3);
  assert.equal(new Set(b0).size, 3, '重複なし');
  assert.ok(b0.every((s) => SYMBOLS.includes(s)));
  assert.notDeepEqual(b0, b1, '番号が進むと組が変わる');
  assert.equal(basketFor(0, SYMBOLS, 1).length, 1);
});

await t('仮説の絞り込み: 指定した特徴量の部品しか使わない', async () => {
  const rnd = seededRandom('risk-test-hypothesis');
  const fam = featureKeys()[0];
  assert.ok(fam, '特徴量がある');
  for (let i = 0; i < 300; i++) {
    const spec = randomRule(rnd, SYMBOLS, { features: [fam] });
    const A = ATOMS[spec.base.a];
    assert.equal(A.f, fam, `使った特徴量: ${A.f} / 期待 ${fam}`);
    if (spec.base.b != null) assert.equal(ATOMS[spec.base.b].f, fam);
  }
});

await t('絞り込みなしなら、複数の特徴量が現れる（探索が狭まりすぎていない）', async () => {
  const rnd = seededRandom('risk-test-free');
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(ATOMS[randomRule(rnd, SYMBOLS, {}).base.a].f);
  assert.ok(seen.size >= 8, `使われた特徴量の種類: ${seen.size}`);
});

await t('原価0: 追加銘柄も同じ無料データ経路（有料APIの文字列が混ざっていない）', async () => {
  const raw = await import('node:fs').then((fs) => fs.readFileSync('src/income/fx.js', 'utf8'));
  const bad = ['api_key', 'apikey', 'polygon.io', 'alphavantage', 'twelvedata'];
  for (const b of bad) assert.ok(!raw.toLowerCase().includes(b), `有料の痕跡: ${b}`);
  assert.ok(raw.includes('query1.finance.yahoo.com'), 'Yahoo の無料経路を使っている');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
