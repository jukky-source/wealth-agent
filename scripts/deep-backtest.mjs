// サンドボックスで走る「本気の」バックテスト。
//
// 目的: 実データ（Yahoo Finance、無料・鍵不要）で
//   1) 全戦略 × 全銘柄を総当たりし、素点の分布を見る
//   2) 各組み合わせでグリッドを探索し、「選んだ1点」ではなく選抜そのものを評価する
//   3) 上位候補にフル検証バッテリー（カーブフィッティング対策11項目）をかける
//   4) 人が読めるレポートと、機械が読めるJSONを書き出す
//
// 原価0（無料データ＋自作エンジン＋ローカル計算のみ）。
//
//   node scripts/deep-backtest.mjs [--days 2600] [--top 6]
//
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fetchMarketData, buildCurrencyConverter } from '../src/income/fx.js';
import { backtest, STRATEGIES, DEFAULT_COST_MODEL, PAIRS, normalizeParams } from '../src/income/backtest.js';
import { deepValidate, gridSample, robustnessScore } from '../src/income/robust.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const DAYS = Number(opt('days', 2600));
const TOP = Number(opt('top', 6));
const SYMBOLS = ['USDJPY', 'EURUSD', 'GBPUSD', 'USDCAD', 'GOLD'];
const MIN_TRADES = 30;

// D1 の代わりになる最小のストア（市場データのキャッシュだけ持つ）
const mem = new Map();
const store = {
  first: async (_sql, ...a) => {
    const v = mem.get(a[0]);
    return v ? { key: a[0], value: v } : null;
  },
  run: async (sql, ...a) => {
    if (/INSERT INTO settings/i.test(sql) && a.length >= 2) mem.set(a[0], a[1]);
    return {};
  },
  insert: async () => ({}),
  all: async () => [],
  get: async () => null,
};

function gridCombos(strategyKey, base, cap = 24) {
  const g = STRATEGIES[strategyKey].grid || {};
  const keys = Object.keys(g);
  let acc = [{ ...base }];
  for (const k of keys) {
    const next = [];
    for (const b of acc) for (const v of g[k]) next.push({ ...b, [k]: v });
    acc = next;
  }
  acc = acc.filter((p) => normalizeParams(strategyKey, p));
  if (acc.length <= cap) return acc;
  const step = acc.length / cap;
  return Array.from({ length: cap }, (_, i) => acc[Math.floor(i * step)]);
}

const t0 = Date.now();
const out = { generated_at: new Date().toISOString(), days: DAYS, symbols: [], combos: [], ranked: [], deep: [], trials: 0, env: {} };

console.log(`[1/4] 市場データを取得（${DAYS}営業日ぶん）...`);
for (const symbol of SYMBOLS) {
  const md = await fetchMarketData(store, symbol, { days: DAYS });
  const fx = await buildCurrencyConverter(store, symbol);
  out.symbols.push({ symbol, bars: md.bars.length, from: md.bars[0]?.date, to: md.bars[md.bars.length - 1]?.date, source: md.source, quality: md.quality, fx: { quote: fx.quote, source: fx.source, note: fx.note } });
  console.log(`  ${symbol}: ${md.bars.length}本 ${md.bars[0]?.date}→${md.bars[md.bars.length - 1]?.date} / ${md.source} / 換算=${fx.quote}`);
}

console.log(`[2/4] 全戦略 × 全銘柄を総当たり（17戦略 × ${SYMBOLS.length}銘柄、グリッド探索込み）...`);
const barsCache = {};
const fxCache = {};
for (const symbol of SYMBOLS) {
  barsCache[symbol] = (await fetchMarketData(store, symbol, { days: DAYS })).bars;
  fxCache[symbol] = await buildCurrencyConverter(store, symbol);
}

for (const symbol of SYMBOLS) {
  const bars = barsCache[symbol];
  const cost = { ...DEFAULT_COST_MODEL, fx: fxCache[symbol] };
  for (const strategyKey of Object.keys(STRATEGIES)) {
    const base = { ...normalizeParams(strategyKey, STRATEGIES[strategyKey].defaultParams), symbol };
    const combos = gridCombos(strategyKey, base);
    let best = null; let tried = 0;
    for (const p of combos) {
      let r;
      try { r = backtest(bars, { strategyKey, params: p, cost }); } catch { continue; }
      tried++;
      const m = r.metrics;
      const score = (Number(m.netProfitPct) || 0) * Math.min(1, (Number(m.trades) || 0) / 60) - (Number(m.maxDrawdownPct) || 0) * 1.2 + Math.min(6, Math.max(0, (Number(m.profitFactor) || 0) - 1) * 8);
      if (!best || score > best.score) best = { score, params: p, metrics: m, trades: r.trades.length };
    }
    out.trials += tried;
    if (!best) continue;
    out.combos.push({
      symbol, strategy_key: strategyKey, tried, score: Number(best.score.toFixed(3)),
      params: best.params, metrics: best.metrics,
    });
  }
}
out.combos.sort((a, b) => b.score - a.score);
console.log(`  試した設定: ${out.trials} 通り / 組み合わせ: ${out.combos.length}`);

console.log(`[3/4] 素点の上位を表示...`);
for (const c of out.combos.slice(0, 12)) {
  console.log(`  ${String(c.score).padStart(8)} | ${c.symbol.padEnd(7)} ${c.strategy_key.padEnd(20)} net=${String(c.metrics.netProfitPct).padStart(8)}% PF=${String(c.metrics.profitFactor).padStart(6)} 取引=${String(c.metrics.trades).padStart(4)} DD=${String(c.metrics.maxDrawdownPct).padStart(6)}%`);
}

// フル検証は「門（取引回数・PF・期待値・DD）」を通ったものから上位へ
const candidates = out.combos
  .filter((c) => (c.metrics.trades || 0) >= MIN_TRADES && (Number(c.metrics.profitFactor) || 0) >= 1.15 && (Number(c.metrics.expectancy) || 0) > 0 && (Number(c.metrics.maxDrawdownPct) || 0) <= 35)
  .slice(0, TOP);
if (!candidates.length) {
  console.log('  門（取引30回以上 / PF1.15以上 / 期待値プラス / DD35%以下）を通った候補がありません。');
  for (const c of out.combos.slice(0, TOP)) candidates.push(c);
}

console.log(`[4/4] フル検証バッテリー（${candidates.length}件 × 11項目）...`);
const trialSharpes = out.combos.map((c) => Number(c.metrics.sharpe)).filter((v) => Number.isFinite(v));
for (const c of candidates) {
  const bars = barsCache[c.symbol];
  const cost = { ...DEFAULT_COST_MODEL, fx: fxCache[c.symbol] };
  const t = Date.now();
  const rep = deepValidate(bars, {
    symbol: c.symbol, strategyKey: c.strategy_key, params: c.params, cost,
    source: out.symbols.find((s) => s.symbol === c.symbol)?.source,
    trials: out.trials, trialSharpes, seed: `deep-${c.symbol}-${c.strategy_key}`, budgetMs: 120000,
  });
  out.deep.push({
    symbol: c.symbol, strategyKey: c.strategy_key, params: c.params,
    score: rep.score, gates: rep.gates, metrics: rep.metrics, sharpe_stats: rep.sharpe_stats,
    data_quality: rep.data_quality, purged: rep.purged, dsr: rep.dsr, psr: rep.psr,
    bootstrap: rep.bootstrap, sign_flip: rep.sign_flip,
    cscv: rep.cscv ? { ok: rep.cscv.ok, pbo: rep.cscv.pbo, paths: rep.cscv.paths, oos_sharpe: rep.cscv.oos_sharpe, interpretation: rep.cscv.interpretation } : null,
    cost_stress: rep.cost_stress, regime: rep.regime,
    plateau: rep.plateau ? { ok: rep.plateau.ok, positive_share: rep.plateau.positive_share, neighbors_tested: rep.plateau.neighbors_tested, worst_neighbor_net_pct: rep.plateau.worst_neighbor_net_pct, is_plateau: rep.plateau.is_plateau, sensitivity: rep.plateau.sensitivity } : null,
    null_test: rep.null_test, honesty_note: rep.honesty_note,
    equity: (() => { const r = backtest(bars, { strategyKey: c.strategy_key, params: c.params, cost }); return { dates: r.equity.map((e) => e.date), equity: r.equity.map((e) => e.equity) }; })(),
    trades_count: rep.metrics.trades,
  });
  console.log(`  ${c.symbol.padEnd(7)} ${c.strategy_key.padEnd(20)} score=${String(rep.score).padStart(7)} 合格=${rep.gates.pass} PBO=${rep.cscv?.pbo ?? '-'} DSR=${rep.dsr?.dsr ?? '-'} ランダムp=${rep.null_test?.p_value ?? '-'} (${Date.now() - t}ms)`);
}

out.ranked = out.combos.map((c) => ({
  symbol: c.symbol, strategy_key: c.strategy_key, tried: c.tried, metric_score: c.score,
  net: c.metrics.netProfitPct, pf: c.metrics.profitFactor, trades: c.metrics.trades, dd: c.metrics.maxDrawdownPct, sharpe: c.metrics.sharpe, params: c.params,
}));
out.elapsed_ms = Date.now() - t0;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/deep-backtest.json', JSON.stringify(out, null, 1));
console.log(`\n完了: dist/deep-backtest.json（${(JSON.stringify(out).length / 1024).toFixed(0)}KB, ${(out.elapsed_ms / 1000).toFixed(1)}秒）`);
const passed = out.deep.filter((d) => d.gates.pass).length;
console.log(`フル検証を通った候補: ${passed} / ${out.deep.length}`);
