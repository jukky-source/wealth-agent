// FX Lab（試行錯誤ループ）のテスト。
// ・探索空間は STRATEGIES.grid から取り、不正な組は捨てずに直す
// ・評価は「取引回数の信用」を掛ける（少ない取引の高成績を信用しない）
// ・門（取引30回以上 / PF1.15以上 / 期待値プラス / DD35%以下）で判定する
// ・1tickで実験を積み、同じ組み合わせは二度試さない
// ・外部通信はしない（fetch を差し替える）。有料APIを呼ばないことも機械で検査する
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store, ensureSchema } from '../src/db.js';
import {
  T, candidateFromGrid, mutate, sanitize, paramKey, fitness, gates, nextPlan,
  fxLabTick, fxLabSummary, ensureLabTable, LAB_SYMBOLS, LAB_STRATEGIES,
} from '../src/income/fxLab.js';
import { STRATEGIES } from '../src/income/backtest.js';
import { seededRandom } from '../src/util.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// --- D1 互換の最小アダプタ（node:sqlite をそのまま使う。外部依存なし）---
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

// --- 決定的な合成データ（値動きが無いと取引が生まれないので波を入れる）---
function makeBars(n = 700, seed = 7) {
  let a = seed; const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  const bars = []; let price = 150;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 31) * 0.6;
    const ch = (rnd() - 0.5) * 1.3 + drift * 0.2;
    const open = price; const close = Math.max(40, open + ch);
    bars.push({
      date: new Date(Date.UTC(2022, 0, 3 + i)).toISOString().slice(0, 10),
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
        timestamp: BARS.map((b, i) => Math.floor(Date.UTC(2022, 0, 3 + i) / 1000)),
        indicators: { quote: [{ open: BARS.map((b) => b.open), high: BARS.map((b) => b.high), low: BARS.map((b) => b.low), close: BARS.map((b) => b.close) }] },
      }] },
    }),
    text: async () => '{}',
  };
};

// ---------------------------------------------------------------------------
await t('探索空間: グリッドから取り、既定値を壊さない', () => {
  const rnd = seededRandom('grid');
  for (const key of LAB_STRATEGIES) {
    const p = candidateFromGrid(key, rnd);
    assert.ok(p, `${key}: 候補が作れる`);
    for (const k of Object.keys(STRATEGIES[key].defaultParams)) {
      assert.ok(p[k] !== undefined, `${key}.${k}: 既定値が残っている`);
    }
  }
});

await t('整合: fast>=slow などの不正な組は捨てずに直す', () => {
  const fixed = sanitize('ema_cross', { fast: 89, slow: 34, atrStopMult: 99 });
  assert.ok(fixed.fast < fixed.slow, `fast=${fixed.fast} slow=${fixed.slow}`);
  assert.ok(fixed.atrStopMult <= 4, `atrStopMult=${fixed.atrStopMult}`);
  const r = sanitize('rsi_meanrev', { oversold: 90, exitLevel: 50 });
  assert.ok(r.oversold < r.exitLevel, `oversold=${r.oversold} exit=${r.exitLevel}`);
  const d = sanitize('donchian_breakout', { entry: 20, exit: 55 });
  assert.ok(d.exit < d.entry, `entry=${d.entry} exit=${d.exit}`);
});

await t('変異: 現王者の近傍を変えて、違う組み合わせを作る', () => {
  const rnd = seededRandom('mut');
  const base = { ...STRATEGIES.ema_cross.defaultParams };
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const m = mutate('ema_cross', base, rnd, 2);
    assert.ok(m && m.fast < m.slow, '整合が取れている');
    seen.add(paramKey('USDJPY', 'ema_cross', m));
  }
  assert.ok(seen.size > 1, `変異が単調でない（${seen.size}通り）`);
});

await t('評価: 儲けが増えれば上がり、DDは下がる。取引が少ない高成績は割り引く', () => {
  const a = fitness({ netProfitPct: 10, maxDrawdownPct: 5, trades: 60, profitFactor: 1.5 });
  const b = fitness({ netProfitPct: 20, maxDrawdownPct: 5, trades: 60, profitFactor: 1.5 });
  const c = fitness({ netProfitPct: 20, maxDrawdownPct: 20, trades: 60, profitFactor: 1.5 });
  const d = fitness({ netProfitPct: 20, maxDrawdownPct: 5, trades: 3, profitFactor: 1.5 });
  assert.ok(b > a, `${b} > ${a}`);
  assert.ok(b > c, `DDで下がる: ${b} > ${c}`);
  assert.ok(b > d, `取引が少ないと割り引く: ${b} > ${d}`);
});

await t('門: 取引回数・PF・期待値・DD・ウォークフォワードで判定する', () => {
  const good = gates({ trades: 60, profitFactor: 1.4, expectancy: 500, maxDrawdownPct: 12 });
  assert.ok(good.pass, JSON.stringify(good.reasons));
  assert.equal(gates({ trades: 10, profitFactor: 1.4, expectancy: 500, maxDrawdownPct: 12 }).pass, false);
  assert.equal(gates({ trades: 60, profitFactor: 1.02, expectancy: 500, maxDrawdownPct: 12 }).pass, false);
  assert.equal(gates({ trades: 60, profitFactor: 1.4, expectancy: -1, maxDrawdownPct: 12 }).pass, false);
  assert.equal(gates({ trades: 60, profitFactor: 1.4, expectancy: 500, maxDrawdownPct: 40 }).pass, false);
  assert.equal(gates({ trades: 60, profitFactor: 1.4, expectancy: 500, maxDrawdownPct: 12 }, { consistent: false, netPositiveFolds: 1, totalFolds: 4 }).pass, false);
});

await t('1tick: 実験を積み、記録が残る（負けも消さない）', async () => {
  const store = new Store(makeDb());
  await ensureSchema(store);
  const r = await fxLabTick({ store, n: 2, seed: 'tick-1', symbols: ['USDJPY'] });
  assert.ok(r.ran >= 1, `実験が回った: ran=${r.ran} skipped=${r.skipped}`);
  const rows = await store.all(`SELECT * FROM ${T}`);
  assert.equal(rows.length, r.ran, '記録された件数が実行件数と一致');
  for (const row of rows) assert.ok(['pass', 'fail'].includes(row.verdict), `verdict=${row.verdict}`);
  assert.ok(rows.every((x) => x.data_source), 'どのデータ源を使ったか記録している');
});

await t('重複防止: 同じ組み合わせは二度試さない', async () => {
  const store = new Store(makeDb());
  await ensureSchema(store);
  await fxLabTick({ store, n: 3, seed: 'dup', symbols: ['USDJPY'] });
  await fxLabTick({ store, n: 3, seed: 'dup', symbols: ['USDJPY'] });
  const rows = await store.all(`SELECT symbol, strategy_key, params_json FROM ${T}`);
  const keys = rows.map((r) => paramKey(r.symbol, r.strategy_key, JSON.parse(r.params_json || '{}')));
  assert.equal(new Set(keys).size, keys.length, `重複した組み合わせが ${keys.length - new Set(keys).size} 件`);
});

await t('原価0: 呼んだ外部は無料の市場データだけ（有料APIを呼ばない）', () => {
  assert.ok(hitUrls.length > 0, '市場データを取りに行っている');
  const bad = hitUrls.filter((u) => !FREE_HOSTS.some((h) => u.startsWith(h)));
  assert.equal(bad.length, 0, `無料ホスト以外を叩いた: ${bad.slice(0, 3).join(', ')}`);
});

await t('読み出し: 件数・通過率・次に試す予定を返す', async () => {
  const store = new Store(makeDb());
  await ensureSchema(store);
  await fxLabTick({ store, n: 2, seed: 'sum', symbols: ['USDJPY'] });
  const s = await fxLabSummary(store);
  assert.equal(s.measured, true);
  assert.ok(s.total_experiments >= 1, `total=${s.total_experiments}`);
  assert.ok(s.cost.includes('0円'), `cost=${s.cost}`);
  assert.ok(Array.isArray(s.next) && s.next.length >= 1, '次に試す予定がある');
  const plan = nextPlan({ champion: { symbol: 'USDJPY', strategy_key: 'ema_cross' } });
  assert.ok(plan.some((p) => p.tag === 'exploit'), '王者がいれば近傍の変異を計画する');
  assert.ok(plan.some((p) => p.tag === 'validate'), '昇格前の検証を計画する');
});

await t('探索範囲: 銘柄と戦略は実装にあるものだけを対象にする', () => {
  assert.ok(LAB_SYMBOLS.length >= 4, `symbols=${LAB_SYMBOLS.join(',')}`);
  assert.ok(LAB_STRATEGIES.length >= 4, `strategies=${LAB_STRATEGIES.join(',')}`);
  for (const s of LAB_STRATEGIES) assert.ok(STRATEGIES[s].grid, `${s}: 探索グリッドがある`);
});

await t('置き場: 実験テーブルを遅延作成する', async () => {
  const store = new Store(makeDb());
  await ensureLabTable(store);
  await store.insert(T, { id: 'x1', symbol: 'USDJPY', strategy_key: 'ema_cross', params_json: '{}', metrics_json: '{}', fitness: 1, created_at: new Date().toISOString() });
  const r = await store.first(`SELECT COUNT(*) AS n FROM ${T}`);
  assert.equal(Number(r.n), 1);
});

console.log(`\nFX Lab: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
