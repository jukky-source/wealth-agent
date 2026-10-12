// Backtesting core — a real, deterministic, look-ahead-free simulator.
//
// Rules that make the results trustworthy:
//  * Signals are computed from bar i using bars <= i ONLY.
//  * Orders fill at bar i+1 OPEN (never at the signal bar's close).
//  * Spread, slippage and commission are charged on every trade.
//  * Stops/targets are evaluated on the *next* bar's high/low, conservatively
//    (if both could trigger in one bar, the STOP wins — pessimistic fill).
//  * Nothing here forecasts. Past performance is reported as past performance.

import { mean, stdev, round, safeJson } from '../util.js';

export const PAIRS = {
  USDJPY: { pip: 0.01, quote: 'JPY', usdBase: true },
  EURUSD: { pip: 0.0001, quote: 'USD', usdBase: false },
  GBPUSD: { pip: 0.0001, quote: 'USD', usdBase: false },
  USDCAD: { pip: 0.0001, quote: 'CAD', usdBase: true },
  GOLD: { pip: 0.1, quote: 'USD', usdBase: true },
};

export const DEFAULT_COST_MODEL = {
  spreadPips: 0.3,
  slippagePips: 0.2,
  commissionJPY: 0,
  units: 10000,          // mini lot (10,000 base-currency units)
  initialCapitalJPY: 100000,
};

// ---------------------------------------------------------------------------
// Indicators (all causal — index i uses data up to i only)
// ---------------------------------------------------------------------------
export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let gain = 0; let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const g = Math.max(0, ch); const l = Math.max(0, -ch);
    if (i <= period) { gain += g / period; loss += l / period; if (i === period) out[i] = 100 - 100 / (1 + (loss === 0 ? 1e9 : gain / loss)); continue; }
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + (loss === 0 ? 1e9 : gain / loss));
  }
  return out;
}

export function atr(bars, period = 14) {
  const tr = bars.map((b, i) => i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  return sma(tr, period);
}

export function stdevRolling(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    out[i] = stdev(values.slice(i - period + 1, i + 1));
  }
  return out;
}

export function highest(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) out[i] = Math.max(...values.slice(i - period + 1, i + 1));
  return out;
}
export function lowest(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) out[i] = Math.min(...values.slice(i - period + 1, i + 1));
  return out;
}

// ---------------------------------------------------------------------------
// Strategy catalog — each returns an intent per bar: +1 long, -1 short, 0 flat
// Computed with data up to bar i only (strictly causal).
// ---------------------------------------------------------------------------
export const STRATEGIES = {
  ema_cross: {
    label: 'EMAクロス（トレンドフォロー）',
    defaultParams: { fast: 12, slow: 48, atrStopMult: 2.0, atrTargetMult: 3.0, allowShort: true, trendFilter: 200 },
    grid: { fast: [8, 12, 21], slow: [34, 48, 89], atrStopMult: [1.5, 2.0, 2.5] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const f = ema(close, p.fast); const s = ema(close, p.slow);
      const tf = sma(close, p.trendFilter);
      return bars.map((_, i) => {
        if (i < Math.max(p.slow, p.trendFilter) + 1) return 0;
        if (f[i] > s[i] && close[i] > (tf[i] ?? -Infinity)) return 1;
        if (p.allowShort && f[i] < s[i] && close[i] < (tf[i] ?? Infinity)) return -1;
        return 0;
      });
    },
  },
  rsi_meanrev: {
    label: 'RSI平均回帰',
    defaultParams: { period: 14, oversold: 30, overbought: 70, exitLevel: 50, atrStopMult: 2.5, allowShort: true },
    grid: { period: [10, 14, 21], oversold: [25, 30, 35], exitLevel: [45, 50, 55] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const r = rsi(close, p.period);
      return bars.map((_, i) => {
        if (i < p.period + 1 || r[i] === null) return 0;
        if (r[i] < p.oversold) return 1;
        if (p.allowShort && r[i] > p.overbought) return -1;
        return 0;
      });
    },
  },
  bollinger_fade: {
    label: 'ボリンジャー逆張り',
    defaultParams: { period: 20, mult: 2.0, atrStopMult: 2.5, allowShort: true },
    grid: { period: [15, 20, 30], mult: [1.8, 2.0, 2.5] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const mid = sma(close, p.period); const sd = stdevRolling(close, p.period);
      return bars.map((_, i) => {
        if (mid[i] === null || sd[i] === null || sd[i] === 0) return 0;
        const upper = mid[i] + p.mult * sd[i]; const lower = mid[i] - p.mult * sd[i];
        if (close[i] < lower) return 1;
        if (p.allowShort && close[i] > upper) return -1;
        return 0;
      });
    },
  },
  donchian_breakout: {
    label: 'ドンチャン・ブレイクアウト',
    defaultParams: { entry: 55, exit: 20, atrStopMult: 2.0, allowShort: true },
    grid: { entry: [20, 40, 55], exit: [10, 20, 30], atrStopMult: [1.5, 2.0, 3.0] },
    intent(bars, p) {
      const high = bars.map((b) => b.high); const low = bars.map((b) => b.low);
      const hh = highest(high.map((v, i) => (i >= 1 ? Math.max(...high.slice(Math.max(0, i - 1), i)) : v)), p.entry);
      const ll = lowest(low, p.exit);
      const hhPrev = highest(high, p.entry);
      return bars.map((_, i) => {
        if (i < p.entry + 2) return 0;
        // previous N-bar extreme, excluding the signal bar (causal, non-repainting)
        const hiN = Math.max(...high.slice(i - p.entry, i));
        const loN = Math.min(...low.slice(i - p.entry, i));
        if (bars[i].close > hiN) return 1;
        if (p.allowShort && bars[i].close < loN) return -1;
        return 0;
      });
    },
  },
};

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------
export function backtest(bars, { strategyKey, params, cost = {} } = {}) {
  const strat = STRATEGIES[strategyKey];
  if (!strat) throw new Error(`unknown strategy: ${strategyKey}`);
  const p = { ...strat.defaultParams, ...(params || {}) };
  const C = { ...DEFAULT_COST_MODEL, ...cost };
  const intent = strat.intent(bars, p);
  const a = atr(bars, 14);
  const meta = PAIRS[params?.symbol] || PAIRS.USDJPY;
  const costPrice = (C.spreadPips + C.slippagePips) * meta.pip;

  const trades = [];
  const equity = [];
  let pos = null;
  let cum = 0;
  const equityStart = C.initialCapitalJPY;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];

    // 1) manage open position using THIS bar's range (stop-first, pessimistic)
    if (pos) {
      let exitPrice = null; let exitReason = null;
      const stopHit = pos.dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const targetHit = pos.dir === 1 ? bar.high >= pos.target : bar.low <= pos.target;
      if (stopHit) { exitPrice = pos.stop; exitReason = 'stop'; }
      else if (targetHit) { exitPrice = pos.target; exitReason = 'target'; }

      // signal flip → exit at this bar's close
      const flipped = intent[i] !== 0 && intent[i] !== pos.dir;
      if (!exitPrice && flipped) { exitPrice = bar.close; exitReason = 'flip'; }
      if (!exitPrice && pos.barsHeld >= p.maxHoldBars) { exitPrice = bar.close; exitReason = 'time'; }

      if (exitPrice !== null) {
        const pnlPrice = (exitPrice - pos.entryPrice) * pos.dir;
        const pnlJPY = pnlPrice * C.units - pos.entryCostJPY - costPrice * C.units - C.commissionJPY;
        cum += pnlJPY;
        trades.push({
          entryDate: pos.entryDate, exitDate: bar.date, dir: pos.dir,
          entryPrice: round(pos.entryPrice, 5), exitPrice: round(exitPrice, 5),
          pnlJPY: round(pnlJPY, 1), reason: exitReason, barsHeld: pos.barsHeld + 1,
          signalContext: pos.context,
        });
        pos = null;
      } else {
        pos.barsHeld++;
      }
    }

    // 2) new entry — filled at NEXT bar open, based on this bar's signal
    if (!pos && i + 1 < bars.length) {
      const sig = intent[i];
      if (sig !== 0) {
        const next = bars[i + 1];
        const entryPrice = next.open + (sig === 1 ? costPrice : -costPrice); // pay the spread/slippage
        const stopDist = (p.atrStopMult || 2.0) * (a[i] || Math.abs(next.open * 0.005));
        const targetDist = (p.atrTargetMult || 2.5) * stopDist;
        pos = {
          dir: sig, entryPrice, entryDate: next.date, barsHeld: 0,
          stop: sig === 1 ? entryPrice - stopDist : entryPrice + stopDist,
          target: sig === 1 ? entryPrice + targetDist : entryPrice - targetDist,
          entryCostJPY: costPrice * C.units,
          context: { signalBar: bars[i].date, atr: round(a[i] || 0, 5), params: p },
        };
      }
    }

    equity.push({ date: bar.date, equity: round(equityStart + cum, 1), pnl: round(cum, 1) });
  }

  // close any dangling position at the last close (marked, not hidden)
  if (pos) {
    const last = bars[bars.length - 1];
    const pnlPrice = (last.close - pos.entryPrice) * pos.dir;
    const pnlJPY = pnlPrice * C.units - pos.entryCostJPY - costPrice * C.units - C.commissionJPY;
    cum += pnlJPY;
    trades.push({ entryDate: pos.entryDate, exitDate: last.date, dir: pos.dir,
      entryPrice: round(pos.entryPrice, 5), exitPrice: round(last.close, 5), pnlJPY: round(pnlJPY, 1),
      reason: 'open_at_end', barsHeld: pos.barsHeld, signalContext: pos.context });
    equity.push({ date: last.date, equity: round(equityStart + cum, 1), pnl: round(cum, 1) });
  }

  const metrics = computeMetrics(trades, equity, C.initialCapitalJPY, bars);
  return { trades, equity, metrics, params: p, cost: C, strategyKey, symbol: p.symbol || 'USDJPY' };
}

export function computeMetrics(trades, equity, initialCapital, bars = []) {
  const wins = trades.filter((t) => t.pnlJPY > 0);
  const losses = trades.filter((t) => t.pnlJPY <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlJPY, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlJPY, 0));
  const net = grossWin - grossLoss;

  let peak = initialCapital; let maxDD = 0; let maxDDPct = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.equity);
    const dd = peak - e.equity;
    if (dd > maxDD) { maxDD = dd; maxDDPct = (dd / peak) * 100; }
  }

  const dailyReturns = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equity;
    if (prev > 0) dailyReturns.push((equity[i].equity - prev) / prev);
  }
  const sd = stdev(dailyReturns);
  const sharpe = sd > 0 ? (mean(dailyReturns) / sd) * Math.sqrt(252) : 0;

  const years = bars.length > 1
    ? (new Date(bars[bars.length - 1].date) - new Date(bars[0].date)) / (365.25 * 24 * 3600e3)
    : 0;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round((wins.length / trades.length) * 100, 2) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : (grossWin > 0 ? null : 0),
    expectancy: trades.length ? round(net / trades.length, 1) : 0,
    grossWinJPY: round(grossWin, 1),
    grossLossJPY: round(grossLoss, 1),
    netProfitJPY: round(net, 1),
    netProfitPct: round((net / initialCapital) * 100, 2),
    avgWinJPY: wins.length ? round(grossWin / wins.length, 1) : 0,
    avgLossJPY: losses.length ? round(-grossLoss / losses.length, 1) : 0,
    maxDrawdownJPY: round(maxDD, 1),
    maxDrawdownPct: round(maxDDPct, 2),
    sharpe: round(sharpe, 2),
    cagrPct: years > 0.2 ? round(((initialCapital + net) / initialCapital) ** (1 / years) * 100 - 100, 2) : null,
    barsTested: bars.length,
    yearsCovered: round(years, 2),
    finalEquityJPY: round(initialCapital + net, 1),
    returnPerYearJPY: years > 0.2 ? round(net / years, 0) : null,
    assumptions: 'シグナルは当該バーの終値時点のみ使用、約定は翌バー始値。スプレッド・スリッページ・手数料を毎取引で控除。同時に複数条件が成立する場合は不利側（ストップ優先）で約定。',
  };
}

// ---------------------------------------------------------------------------
// Walk-forward validation: sequential, non-overlapping folds, fixed params.
// ---------------------------------------------------------------------------
export function walkForward(bars, opts, folds = 4) {
  const strat = STRATEGIES[opts.strategyKey];
  const p = { ...strat.defaultParams, ...(opts.params || {}) };
  const maxHold = Math.max(
    Math.max(...(strat.grid.atrStopMult || [2])) * 10,
    60,
  );
  const size = Math.floor(bars.length / folds);
  const out = [];
  for (let f = 0; f < folds; f++) {
    const slice = bars.slice(f * size, f === folds - 1 ? bars.length : (f + 1) * size + 1).map((b) => ({ ...b }));
    if (slice.length < 80) continue;
    const r = backtest(slice, { strategyKey: opts.strategyKey, params: { ...p, maxHoldBars: opts.params?.maxHoldBars || 90 }, cost: opts.cost });
    out.push({
      fold: f + 1, from: slice[0].date, to: slice[slice.length - 1].date, bars: slice.length,
      profitFactor: r.metrics.profitFactor, winRate: r.metrics.winRate,
      netProfitJPY: r.metrics.netProfitJPY, trades: r.metrics.trades, maxDrawdownPct: r.metrics.maxDrawdownPct,
    });
  }
  const pfs = out.map((o) => o.profitFactor).filter((v) => v !== null && v !== undefined && isFinite(v));
  const positives = out.filter((o) => o.netProfitJPY > 0).length;
  return {
    folds: out,
    consistent: out.length > 0 && positives >= Math.ceil(out.length * 0.75),
    medianProfitFactor: pfs.length ? round(median(pfs), 3) : null,
    worstProfitFactor: pfs.length ? round(Math.min(...pfs), 3) : null,
    netPositiveFolds: positives,
    totalFolds: out.length,
    note: '各フォルダはパラメータ再最適化なしの逐次検証。全フォルダでプラスであることが頑健性の必要条件（十分条件ではない）。',
  };
}

// ---------------------------------------------------------------------------
// Overfitting detection: in-sample optimisation vs out-of-sample behaviour
// ---------------------------------------------------------------------------
export function overfitCheck(bars, opts, cost) {
  const strat = STRATEGIES[opts.strategyKey];
  const isEnd = Math.floor(bars.length * 0.7);
  const isBars = bars.slice(0, isEnd);
  const oosBars = bars.slice(isEnd);

  const grid = strat.grid || {};
  const combos = cartesian(grid).slice(0, 27);
  const results = combos.map((combo) => {
    const params = { ...strat.defaultParams, ...(opts.params || {}), ...combo };
    const r = backtest(isBars, { strategyKey: opts.strategyKey, params, cost });
    return { combo, pf: r.metrics.profitFactor ?? 0, net: r.metrics.netProfitJPY };
  }).filter((r) => isFinite(r.pf));

  if (!results.length) return { verdict: 'insufficient_data', note: 'グリッド評価ができませんでした' };

  results.sort((a, b) => b.net - a.net);
  const best = results[0];
  const pfs = results.map((r) => r.pf).sort((a, b) => a - b);
  const medPF = median(pfs);

  const oos = backtest(oosBars, { strategyKey: opts.strategyKey, params: { ...strat.defaultParams, ...(opts.params || {}), ...best.combo }, cost });

  const isNet = best.net;
  const oosNet = oos.metrics.netProfitJPY;
  const degradation = isNet > 0 ? round((1 - oosNet / isNet) * 100, 1) : null;
  const dispersion = medPF > 0 ? round((best.pf - medPF) / medPF, 3) : null;

  let verdict = 'ok';
  if (oosNet <= 0) verdict = 'overfit_high';
  else if (degradation !== null && degradation > 60) verdict = 'overfit_high';
  else if (degradation !== null && degradation > 35) verdict = 'moderate';
  if (dispersion !== null && dispersion > 0.8 && verdict === 'ok') verdict = 'parameter_sensitive';

  return {
    verdict,
    isPeriod: { from: isBars[0]?.date, to: isBars[isBars.length - 1]?.date, netJPY: round(isNet, 1), pf: best.pf, params: { ...strat.defaultParams, ...(opts.params || {}), ...best.combo } },
    oosPeriod: { from: oosBars[0]?.date, to: oosBars[oosBars.length - 1]?.date, netJPY: oosNet, pf: oos.metrics.profitFactor, trades: oos.metrics.trades },
    degradationPct: degradation,
    parameterDispersion: dispersion,
    combinationsTested: results.length,
    note: 'IS(70%)でパラメータを選択し、OOS(30%)で挙動を確認。OOSで赤字、または劣化が大きい場合は過剰最適化と判定。',
  };
}

function cartesian(grid) {
  const keys = Object.keys(grid);
  if (!keys.length) return [{}];
  let acc = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of acc) for (const v of grid[k]) next.push({ ...base, [k]: v });
    acc = next;
  }
  return acc;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Analyse losers to produce the next hypothesis (feeds the improvement loop). */
export function analyzeLosers(trades, limit = 8) {
  const losers = trades.filter((t) => t.pnlJPY <= 0);
  const byReason = {};
  const bySide = { long: { n: 0, pnl: 0 }, short: { n: 0, pnl: 0 } };
  const byHold = { short: { n: 0, loss: 0 }, medium: { n: 0, loss: 0 }, long: { n: 0, loss: 0 } };
  for (const t of losers) {
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
    const side = t.dir === 1 ? 'long' : 'short';
    bySide[side].n++; bySide[side].pnl += t.pnlJPY;
    const bucket = t.barsHeld <= 3 ? 'short' : t.barsHeld <= 15 ? 'medium' : 'long';
    byHold[bucket].n++; byHold[bucket].loss += t.pnlJPY;
  }
  const hypotheses = [];
  const stopShare = (byReason.stop || 0) / Math.max(1, losers.length);
  if (stopShare > 0.55) hypotheses.push('ストップ到達が損失の大半を占める → 損切り幅(ATR倍率)を広げる、またはエントリー条件を絞る');
  if (byHold.short.n / Math.max(1, losers.length) > 0.45) hypotheses.push('短期で切られている負けが多い → ノイズ回避のため時間足/フィルタ追加');
  if (bySide.short.pnl < bySide.long.pnl && bySide.short.n >= 5) hypotheses.push('ショート側の成績が劣る → ロングのみ、またはショート条件を厳格化');
  if ((byReason.flip || 0) / Math.max(1, losers.length) > 0.35) hypotheses.push('シグナル反転での決済が多い → トレンドフォロー/平均回帰の方向性を見直す');
  if (!hypotheses.length) hypotheses.push('大きな偏りは無し → フィルタ追加やパラメータ安定性の改善を検討');

  return {
    losses: losers.length,
    totalTrades: trades.length,
    lossRatePct: round((losers.length / Math.max(1, trades.length)) * 100, 1),
    byExitReason: byReason,
    bySide,
    worstTrades: [...losers].sort((a, b) => a.pnlJPY - b.pnlJPY).slice(0, limit).map((t) => ({
      exitDate: t.exitDate, dir: t.dir === 1 ? 'long' : 'short', pnlJPY: t.pnlJPY, reason: t.reason, barsHeld: t.barsHeld,
    })),
    hypotheses,
  };
}

/** Monte-Carlo style robustness: trade-order shuffling to test reliance on luck. */
export function orderRobustness(trades, trials = 200, seed = 'fx') {
  if (trades.length < 10) return { verdict: 'insufficient_trades' };
  const pnls = trades.map((t) => t.pnlJPY);
  let worse = 0; let maxDDs = [];
  const rnd = mulberry(seed);
  for (let t = 0; t < trials; t++) {
    const shuffled = [...pnls].sort(() => rnd() - 0.5);
    let cum = 0; let peak = 0; let dd = 0;
    for (const v of shuffled) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    maxDDs.push(dd);
    if (cum <= 0) worse++;
  }
  maxDDs.sort((a, b) => a - b);
  return {
    trials,
    probabilityNetNegative: round((worse / trials) * 100, 1),
    medianMaxDrawdown: round(maxDDs[Math.floor(trials / 2)], 1),
    p95MaxDrawdown: round(maxDDs[Math.floor(trials * 0.95)], 1),
    note: '取引順序をランダム化してもネット収益が正であり続けるかを確認（運への依存度）。',
  };
}

function mulberry(seed) {
  let a = 0;
  for (let i = 0; i < String(seed).length; i++) a = (a + String(seed).charCodeAt(i)) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
