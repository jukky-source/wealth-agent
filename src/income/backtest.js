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

// units = 1取引あたりの通貨量（リスク量を決める）。quote = 損益が建つ通貨。
// quote が JPY 以外のときは、決済日レートで円に換算する（換算表はコストモデルの fx として渡す）。
export const PAIRS = {
  USDJPY: { pip: 0.01, quote: 'JPY', units: 10000, label: '米ドル/円' },
  EURUSD: { pip: 0.0001, quote: 'USD', units: 10000, label: 'ユーロ/米ドル' },
  GBPUSD: { pip: 0.0001, quote: 'USD', units: 10000, label: '英ポンド/米ドル' },
  USDCAD: { pip: 0.0001, quote: 'CAD', units: 10000, label: '米ドル/カナダドル' },
  GOLD: { pip: 0.1, quote: 'USD', units: 1, label: '金（1オンス）' },
  USDCHF: { pip: 0.0001, quote: 'CHF', units: 10000, label: '米ドル/スイスフラン' },
  AUDUSD: { pip: 0.0001, quote: 'USD', units: 10000, label: '豪ドル/米ドル' },
  NZDUSD: { pip: 0.0001, quote: 'USD', units: 10000, label: 'ニュージーランドドル/米ドル' },
  EURJPY: { pip: 0.01, quote: 'JPY', units: 10000, label: 'ユーロ/円' },
  GBPJPY: { pip: 0.01, quote: 'JPY', units: 10000, label: '英ポンド/円' },
  AUDJPY: { pip: 0.01, quote: 'JPY', units: 10000, label: '豪ドル/円' },
  CADJPY: { pip: 0.01, quote: 'JPY', units: 10000, label: 'カナダドル/円' },
  CHFJPY: { pip: 0.01, quote: 'JPY', units: 10000, label: 'スイスフラン/円' },
  NZDJPY: { pip: 0.01, quote: 'JPY', units: 10000, label: 'ニュージーランドドル/円' },
  EURGBP: { pip: 0.0001, quote: 'GBP', units: 10000, label: 'ユーロ/英ポンド' },
  EURCHF: { pip: 0.0001, quote: 'CHF', units: 10000, label: 'ユーロ/スイスフラン' },
  EURAUD: { pip: 0.0001, quote: 'AUD', units: 10000, label: 'ユーロ/豪ドル' },
  GBPCHF: { pip: 0.0001, quote: 'CHF', units: 10000, label: '英ポンド/スイスフラン' },
  USDMXN: { pip: 0.0001, quote: 'MXN', units: 10000, label: '米ドル/メキシコペソ' },
  XAGUSD: { pip: 0.01, quote: 'USD', units: 100, label: '銀（100オンス）' },
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

// 単調デックで O(n)。件数が増えても実験1回の費用が増えないようにしてある。
export function highest(values, period) {
  const out = new Array(values.length).fill(null);
  const dq = []; let head = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { dq.length = 0; head = 0; continue; }
    while (dq.length > head && values[dq[dq.length - 1]] <= v) dq.pop();
    dq.push(i);
    while (dq[head] <= i - period) head++;
    if (i >= period - 1) out[i] = values[dq[head]];
  }
  return out;
}
export function lowest(values, period) {
  const out = new Array(values.length).fill(null);
  const dq = []; let head = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { dq.length = 0; head = 0; continue; }
    while (dq.length > head && values[dq[dq.length - 1]] >= v) dq.pop();
    dq.push(i);
    while (dq[head] <= i - period) head++;
    if (i >= period - 1) out[i] = values[dq[head]];
  }
  return out;
}

// --- 追加インジケータ（すべて因果的: 添字 i は i 以前のデータのみ） ---

/** MACD — 速いEMAと遅いEMAの差、シグナル線、ヒストグラム */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(values, fast); const es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const sig = ema(line.map((v) => (v == null ? 0 : v)), signalPeriod);
  return { line, signal: sig, hist: line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i])) };
}

/** ワイルダーの ADX / +DI / -DI（平滑化は Wilder の方法） */
export function wilderADX(bars, period = 14) {
  const n = bars.length;
  const plusDI = new Array(n).fill(null); const minusDI = new Array(n).fill(null); const adxOut = new Array(n).fill(null);
  let trS = 0; let pS = 0; let mS = 0;
  const dxQueue = [];
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    const plusDM = up > dn && up > 0 ? up : 0;
    const minusDM = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    if (i <= period) { trS += tr; pS += plusDM; mS += minusDM; }
    else { trS = trS - trS / period + tr; pS = pS - pS / period + plusDM; mS = mS - mS / period + minusDM; }
    if (i >= period) {
      const pdi = trS > 0 ? (pS / trS) * 100 : 0;
      const mdi = trS > 0 ? (mS / trS) * 100 : 0;
      plusDI[i] = pdi; minusDI[i] = mdi;
      const dx = (pdi + mdi) > 0 ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0;
      if (adxOut[i - 1] == null) {
        dxQueue.push(dx);
        if (dxQueue.length >= period) adxOut[i] = dxQueue.slice(-period).reduce((a, b) => a + b, 0) / period;
      } else {
        adxOut[i] = ((adxOut[i - 1] * (period - 1)) + dx) / period;
      }
    }
  }
  return { adx: adxOut, plusDI, minusDI };
}

/** ストキャスティクス %K / %D */
export function stoch(bars, period = 14, smoothK = 3, smoothD = 3) {
  const hh = highest(bars.map((b) => b.high), period);
  const ll = lowest(bars.map((b) => b.low), period);
  const raw = bars.map((b, i) => (hh[i] == null || ll[i] == null || hh[i] === ll[i] ? null : ((b.close - ll[i]) / (hh[i] - ll[i])) * 100));
  const filled = raw.map((v) => (v == null ? 50 : v));   // ウォームアップ中は中立（信号は出さない）
  const k = sma(filled, smoothK);
  const d = sma(k, smoothD);
  return { k: raw.map((v, i) => (v == null ? null : k[i])), d: raw.map((v, i) => (v == null ? null : d[i])) };
}

/** CCI（平均偏差からの乖離） */
export function cci(bars, period = 20) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const m = sma(tp, period);
  return bars.map((_, i) => {
    if (i < period - 1 || m[i] == null) return null;
    let dev = 0;
    for (let k2 = i - period + 1; k2 <= i; k2++) dev += Math.abs(tp[k2] - m[i]);
    const md = dev / period;
    return md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  });
}

/** 変化率（%） */
export function roc(values, period = 20) {
  return values.map((v, i) => (i < period || !values[i - period] ? null : ((v - values[i - period]) / values[i - period]) * 100));
}

/** 終値のzスコア（移動平均と標準偏差からの乖離） */
export function zscore(values, period = 20) {
  const m = sma(values, period); const sd = stdevRolling(values, period);
  return values.map((_, i) => (m[i] == null || sd[i] == null || sd[i] === 0 ? null : (values[i] - m[i]) / sd[i]));
}

/** ケルトナーチャネル（EMA ± ATR×倍率） */
export function keltner(bars, period = 20, mult = 2, atrPeriod = 14) {
  const close = bars.map((b) => b.close);
  const mid = ema(close, period); const a = atr(bars, atrPeriod);
  return {
    mid,
    upper: close.map((_, i) => (mid[i] == null || a[i] == null ? null : mid[i] + mult * a[i])),
    lower: close.map((_, i) => (mid[i] == null || a[i] == null ? null : mid[i] - mult * a[i])),
  };
}

/** スーパートレンド（ATRのトレーリングで方向を決める。代表的な実装のひとつ） */
export function supertrend(bars, period = 10, mult = 3) {
  const n = bars.length; const a = atr(bars, period);
  const dir = new Array(n).fill(0); const line = new Array(n).fill(null);
  let prevUpper = null; let prevLower = null; let prevDir = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) { dir[i] = 0; continue; }
    const mid = (bars[i].high + bars[i].low) / 2;
    let upper = mid + mult * a[i];
    let lower = mid - mult * a[i];
    if (prevUpper != null) {
      upper = (upper < prevUpper || bars[i - 1].close > prevUpper) ? upper : prevUpper;
      lower = (lower > prevLower || bars[i - 1].close < prevLower) ? lower : prevLower;
    }
    let d = prevDir;
    if (bars[i].close > prevUpper) d = 1; else if (bars[i].close < prevLower) d = -1;
    dir[i] = d; line[i] = d === 1 ? lower : upper;
    prevUpper = upper; prevLower = lower; prevDir = d;
  }
  return { dir, line };
}

/** 一目均衡表の中点（基準線・転換線）。(最高値+最安値)/2 */
export function midpoint(bars, period) {
  const hh = highest(bars.map((b) => b.high), period);
  const ll = lowest(bars.map((b) => b.low), period);
  return hh.map((h, i) => (h == null || ll[i] == null ? null : (h + ll[i]) / 2));
}

/** 曜日（0=日曜 ... 6=土曜, UTC基準） */
export function weekdayOf(dateStr) { return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); }
/** 月内の日（1-31, UTC基準） */
export function dayOfMonth(dateStr) { return new Date(`${dateStr}T00:00:00Z`).getUTCDate(); }

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
      // 直前までの高値/安値（シグナルバーを含めない＝未来参照なし・非リペイント）
      const hiPrev = highest(high, p.entry);
      const loPrev = lowest(low, p.entry);
      return bars.map((_, i) => {
        if (i < p.entry + 2) return 0;
        const hiN = hiPrev[i - 1]; const loN = loPrev[i - 1];
        if (hiN == null || loN == null) return 0;
        if (bars[i].close > hiN) return 1;
        if (p.allowShort && bars[i].close < loN) return -1;
        return 0;
      });
    },
  },

  // ===== ここから追加ロジック（FXで公開されている手法の主要な型を網羅する） =====

  macd_trend: {
    label: 'MACDトレンド',
    defaultParams: { fast: 12, slow: 26, signal: 9, trendFilter: 200, atrStopMult: 2.5, atrTargetMult: 3.0, allowShort: true },
    grid: { fast: [8, 12, 16], slow: [21, 26, 34], signal: [7, 9] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const m = macd(close, p.fast, p.slow, p.signal);
      const tf = Number(p.trendFilter) > 0 ? sma(close, p.trendFilter) : null;
      const warm = Math.max(Number(p.slow) + Number(p.signal), Number(p.trendFilter) || 0) + 1;
      return bars.map((_, i) => {
        if (i < warm || m.hist[i] == null) return 0;
        const ok = (dir) => !tf || tf[i] == null || (dir > 0 ? close[i] > tf[i] : close[i] < tf[i]);
        if (m.hist[i] > 0 && m.line[i] > m.signal[i] && ok(1)) return 1;
        if (p.allowShort && m.hist[i] < 0 && m.line[i] < m.signal[i] && ok(-1)) return -1;
        return 0;
      });
    },
  },
  adx_di_trend: {
    label: 'ADX/DIトレンド',
    defaultParams: { period: 14, threshold: 20, atrStopMult: 3.0, atrTargetMult: 4.0, maxHoldBars: 120, allowShort: true },
    grid: { period: [10, 14, 21], threshold: [18, 25, 32] },
    intent(bars, p) {
      const { adx: adxArr, plusDI, minusDI } = wilderADX(bars, p.period);
      const warm = Number(p.period) * 3;
      return bars.map((_, i) => {
        if (i < warm) return 0;
        const a = adxArr[i];
        if (a == null || plusDI[i] == null || minusDI[i] == null || a < p.threshold) return 0;
        if (plusDI[i] > minusDI[i]) return 1;
        if (p.allowShort && minusDI[i] > plusDI[i]) return -1;
        return 0;
      });
    },
  },
  stoch_reversal: {
    label: 'ストキャス逆張り',
    defaultParams: { period: 14, smoothK: 3, smoothD: 3, oversold: 20, overbought: 80, atrStopMult: 2.5, allowShort: true },
    grid: { period: [9, 14, 21], oversold: [15, 20, 25], overbought: [75, 80, 85] },
    intent(bars, p) {
      const s = stoch(bars, p.period, p.smoothK, p.smoothD);
      const warm = Number(p.period) + Number(p.smoothK) + 2;
      return bars.map((_, i) => {
        if (i < warm) return 0;
        const k1 = s.k[i - 1]; const k0 = s.k[i];
        if (k1 == null || k0 == null) return 0;
        if (k1 <= p.oversold && k0 > p.oversold) return 1;
        if (p.allowShort && k1 >= p.overbought && k0 < p.overbought) return -1;
        return 0;
      });
    },
  },
  cci_reversal: {
    label: 'CCI逆張り',
    defaultParams: { period: 20, threshold: 100, atrStopMult: 2.5, allowShort: true },
    grid: { period: [14, 20, 30], threshold: [80, 100, 150] },
    intent(bars, p) {
      const c = cci(bars, p.period);
      return bars.map((_, i) => {
        if (i < Number(p.period) + 1 || c[i] == null) return 0;
        if (c[i] < -Math.abs(p.threshold)) return 1;
        if (p.allowShort && c[i] > Math.abs(p.threshold)) return -1;
        return 0;
      });
    },
  },
  keltner_breakout: {
    label: 'ケルトナーブレイクアウト',
    defaultParams: { period: 20, mult: 2.0, atrPeriod: 14, atrStopMult: 2.0, atrTargetMult: 3.0, allowShort: true },
    grid: { period: [15, 20, 30], mult: [1.5, 2.0, 2.5] },
    intent(bars, p) {
      const k = keltner(bars, p.period, p.mult, p.atrPeriod);
      const warm = Number(p.period) + Number(p.atrPeriod) + 1;
      return bars.map((b, i) => {
        if (i < warm || k.upper[i] == null) return 0;
        if (b.close > k.upper[i]) return 1;
        if (p.allowShort && b.close < k.lower[i]) return -1;
        return 0;
      });
    },
  },
  squeeze_breakout: {
    label: 'スクイーズ・ブレイクアウト',
    defaultParams: { period: 20, mult: 2.0, squeezeLookback: 120, squeezePct: 0.35, breakoutBars: 20, atrStopMult: 2.5, allowShort: true },
    grid: { period: [15, 20, 30], squeezePct: [0.25, 0.35, 0.5], breakoutBars: [10, 20, 40] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const mid = sma(close, p.period); const sd = stdevRolling(close, p.period);
      const bw = close.map((_, i) => (mid[i] == null || sd[i] == null || mid[i] === 0 ? null : (2 * p.mult * sd[i]) / mid[i]));
      const bwSma = sma(bw.map((v) => (v == null ? 0 : v)), p.squeezeLookback);
      const squeeze = bw.map((v, i) => (v == null || bwSma[i] == null ? false : v <= bwSma[i] * p.squeezePct));
      const hi = highest(close, p.breakoutBars); const lo = lowest(close, p.breakoutBars);
      const warm = Math.max(Number(p.period), Number(p.squeezeLookback), Number(p.breakoutBars)) + 3;
      return bars.map((_, i) => {
        if (i < warm) return 0;
        const wasSqueezed = squeeze[i - 1] || squeeze[i - 2] || squeeze[i - 3];
        if (!wasSqueezed) return 0;
        if (hi[i - 1] != null && close[i] > hi[i - 1]) return 1;
        if (p.allowShort && lo[i - 1] != null && close[i] < lo[i - 1]) return -1;
        return 0;
      });
    },
  },
  supertrend_atr: {
    label: 'スーパートレンド（ATRトレーリング）',
    defaultParams: { period: 10, mult: 3.0, atrStopMult: 0.0, allowShort: true },
    grid: { period: [7, 10, 14, 20], mult: [2.0, 3.0, 4.0] },
    intent(bars, p) {
      const st = supertrend(bars, p.period, p.mult);
      const warm = Number(p.period) * 2 + 1;
      return bars.map((_, i) => {
        if (i < warm || st.dir[i] === 0) return 0;
        if (st.dir[i] === 1) return 1;
        return p.allowShort ? -1 : 0;
      });
    },
  },
  roc_momentum: {
    label: 'モメンタム（変化率）',
    defaultParams: { period: 20, threshold: 1.5, maFilter: 100, atrStopMult: 2.5, atrTargetMult: 3.0, allowShort: true },
    grid: { period: [10, 20, 60], threshold: [0.5, 1.5, 3.0] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const r = roc(close, p.period);
      const maf = Number(p.maFilter) > 0 ? sma(close, p.maFilter) : null;
      const warm = Number(p.period) + (Number(p.maFilter) || 0) + 1;
      return bars.map((_, i) => {
        if (i < warm || r[i] == null) return 0;
        const okUp = !maf || maf[i] == null || close[i] > maf[i];
        const okDn = !maf || maf[i] == null || close[i] < maf[i];
        if (r[i] > Math.abs(p.threshold) && okUp) return 1;
        if (p.allowShort && r[i] < -Math.abs(p.threshold) && okDn) return -1;
        return 0;
      });
    },
  },
  zscore_meanrev: {
    label: 'zスコア平均回帰',
    defaultParams: { period: 20, entryZ: 2.0, exitZ: 0.5, atrStopMult: 2.5, allowShort: true },
    grid: { period: [15, 20, 50], entryZ: [1.5, 2.0, 2.5] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const z = zscore(close, p.period);
      return bars.map((_, i) => {
        if (i < Number(p.period) + 1 || z[i] == null) return 0;
        if (z[i] < -Math.abs(p.entryZ)) return 1;
        if (p.allowShort && z[i] > Math.abs(p.entryZ)) return -1;
        return 0;
      });
    },
  },
  ichimoku_trend: {
    label: '一目均衡表トレンド',
    defaultParams: { tenkan: 9, kijun: 26, atrStopMult: 2.5, atrTargetMult: 3.0, allowShort: true },
    grid: { tenkan: [9, 12], kijun: [26, 52] },
    intent(bars, p) {
      const close = bars.map((b) => b.close);
      const ten = midpoint(bars, p.tenkan); const kij = midpoint(bars, p.kijun);
      const warm = Number(p.kijun) + 2;
      return bars.map((_, i) => {
        if (i < warm || ten[i] == null || kij[i] == null) return 0;
        if (close[i] > kij[i] && ten[i] > kij[i]) return 1;
        if (p.allowShort && close[i] < kij[i] && ten[i] < kij[i]) return -1;
        return 0;
      });
    },
  },
  dual_thrust: {
    label: 'デュアルスラスト（レンジブレイク）',
    defaultParams: { lookback: 5, k1: 0.5, k2: 0.5, atrStopMult: 2.0, maxHoldBars: 6, allowShort: true },
    grid: { lookback: [3, 5, 10], k1: [0.4, 0.5, 0.7], k2: [0.4, 0.5, 0.7] },
    intent(bars, p) {
      const n = bars.length;
      const hh = highest(bars.map((b) => b.high), p.lookback);
      const ll = lowest(bars.map((b) => b.low), p.lookback);
      const hc = highest(bars.map((b) => b.close), p.lookback);
      const lc = lowest(bars.map((b) => b.close), p.lookback);
      return bars.map((b, i) => {
        if (i < Number(p.lookback) + 1) return 0;
        const a = hh[i - 1]; const b2 = lc[i - 1]; const c = hc[i - 1]; const d = ll[i - 1];
        if ([a, b2, c, d].some((v) => v == null)) return 0;
        const range = Math.max(a - b2, c - d);
        if (!(range > 0)) return 0;
        const upper = b.open + p.k1 * range;
        const lower = b.open - p.k2 * range;
        if (b.close > upper) return 1;
        if (p.allowShort && b.close < lower) return -1;
        return 0;
      });
    },
  },
  weekday_seasonality: {
    label: '曜日効果（カレンダー）',
    defaultParams: { weekday: 1, side: 1, hold: 2, atrStopMult: 3.0, atrTargetMult: 0, allowShort: false },
    grid: { weekday: [1, 2, 3, 4], side: [1, -1], hold: [1, 2, 3] },
    normalize: (p) => ({ ...p, maxHoldBars: Math.max(1, Math.min(5, Number(p.hold) || 2)) }),
    intent(bars, p) {
      const d = Number(p.weekday);
      const side = Number(p.side) < 0 ? -1 : 1;
      return bars.map((b) => (weekdayOf(b.date) === d ? side : 0));
    },
  },
  turn_of_month: {
    label: '月末・月初効果（カレンダー）',
    defaultParams: { before: 2, after: 3, side: 1, atrStopMult: 3.0, atrTargetMult: 0, allowShort: false },
    grid: { before: [1, 2, 3], after: [1, 3, 5], side: [1, -1] },
    normalize: (p) => ({ ...p, maxHoldBars: Math.max(2, Math.min(10, (Number(p.before) || 2) + (Number(p.after) || 3))) }),
    intent(bars, p) {
      const side = Number(p.side) < 0 ? -1 : 1;
      const dim = bars.map((b) => new Date(`${b.date}T00:00:00Z`).getUTCDate());
      const lastDom = bars.map((b) => {
        const y = Number(String(b.date).slice(0, 4)); const m = Number(String(b.date).slice(5, 7));
        return new Date(Date.UTC(y, m, 0)).getUTCDate();
      });
      return bars.map((_, i) => {
        const dom = dim[i]; const last = lastDom[i];
        const inWindow = dom > last - (Number(p.before) || 2) || dom <= (Number(p.after) || 3);
        return inWindow ? side : 0;
      });
    },
  },
};

/** 戦略のパラメータを既定値で埋め、戦略固有の正規化（時間ストップ等）を適用する。 */
export function normalizeParams(strategyKey, params = {}) {
  const s = STRATEGIES[strategyKey];
  const p = { ...(s?.defaultParams || {}), ...(params || {}) };
  return s?.normalize ? s.normalize(p) : p;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------
/**
 * 意図（+1買い/-1売り/0待ち）の配列を受け取って約定を再現する中核。
 * 戦略の判定（intent）と約定・費用の計算を分けておくことで、
 * 「入口だけランダム」などの検定でもまったく同じ約定ルールを使える。
 */
/**
 * 意図（+1買い/-1売り/0待ち）の配列を受け取って約定を再現する中核。
 * 戦略の判定（intent）と約定・費用・通貨換算を分けておくことで、
 * 「入口だけランダム」などの検定でもまったく同じ約定ルールを使える。
 *
 * 通貨: 損益は quote 通貨で計算し、コストモデルの fx.rateAt(日付) で円に換算する
 *       （未指定なら1＝円建て通貨ペアとして扱う。誤った換算を無言でしないこと）。
 */
export function simulateFromIntent(bars, intent, { params = {}, cost = {}, symbol = 'USDJPY' } = {}) {
  const p = { ...(params || {}) };
  const C = { ...DEFAULT_COST_MODEL, ...cost };
  const a = atr(bars, 14);
  const meta = PAIRS[symbol] || PAIRS.USDJPY;
  const units = Number(meta.units || C.units);
  const costPrice = (C.spreadPips + C.slippagePips) * meta.pip;
  const cvAt = (d) => (C.fx && typeof C.fx.rateAt === 'function' ? (Number(C.fx.rateAt(d)) || 1) : 1);

  const trades = [];
  const equity = [];
  let pos = null;
  let cum = 0;
  const equityStart = C.initialCapitalJPY;

  // 破産判定: 資金が尽きたら（含み損を含めて）取引を止める。
  // 以前はこれが無く、含み損が資金を超えても建玉を持ち続けたため「DD 100%超」が出ていた。
  const ruinEnabled = p.noRuinStop !== true;
  const ruinFloorJPY = (Number(p.ruinFloorPct ?? 0) / 100) * equityStart;
  let ruined = false; let ruinDate = null; let stoppedEarly = false;

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];

    // 1) manage open position using THIS bar's range (stop-first, pessimistic)
    if (pos) {
      let exitPrice = null; let exitReason = null;
      // ATRトレーリング: 前バーまでの情報だけでストップを詰める（未来参照なし）
      if (Number(p.trailAtrMult) > 0 && i >= 1 && a[i - 1] != null) {
        const cand = pos.dir === 1
          ? bars[i - 1].close - Number(p.trailAtrMult) * a[i - 1]
          : bars[i - 1].close + Number(p.trailAtrMult) * a[i - 1];
        pos.stop = pos.dir === 1 ? Math.max(pos.stop, cand) : Math.min(pos.stop, cand);
      }
      const stopHit = pos.dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const targetHit = pos.target != null && (pos.dir === 1 ? bar.high >= pos.target : bar.low <= pos.target);
      if (stopHit) { exitPrice = pos.stop; exitReason = 'stop'; }
      else if (targetHit) { exitPrice = pos.target; exitReason = 'target'; }

      // signal flip → exit at this bar's close
      const flipped = intent[i] !== 0 && intent[i] !== pos.dir;
      if (!exitPrice && flipped) { exitPrice = bar.close; exitReason = 'flip'; }
      if (!exitPrice && Number(p.maxHoldBars) > 0 && pos.barsHeld >= Number(p.maxHoldBars)) { exitPrice = bar.close; exitReason = 'time'; }

      if (exitPrice !== null) {
        const cv = cvAt(bar.date);
        const pnlPrice = (exitPrice - pos.entryPrice) * pos.dir;
        const pnlJPY = (pnlPrice - pos.entryCostPrice - costPrice) * units * cv - C.commissionJPY;
        cum += pnlJPY;
        trades.push({
          entryDate: pos.entryDate, exitDate: bar.date, dir: pos.dir,
          entryPrice: round(pos.entryPrice, 5), exitPrice: round(exitPrice, 5),
          pnlJPY: round(pnlJPY, 1), reason: exitReason, barsHeld: pos.barsHeld + 1,
          fxRate: round(cv, 4), signalContext: pos.context,
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
        // 利確0 = 利確なし（以前は 0 を 2.5 と解釈し、さらに 0倍なら建値で即決済になる不具合があった）
        const targetMult = p.atrTargetMult == null ? 2.5 : Number(p.atrTargetMult);
        const targetDist = targetMult > 0 ? targetMult * stopDist : 0;
        pos = {
          dir: sig, entryPrice, entryDate: next.date, barsHeld: 0,
          stop: sig === 1 ? entryPrice - stopDist : entryPrice + stopDist,
          target: targetDist > 0 ? (sig === 1 ? entryPrice + targetDist : entryPrice - targetDist) : null,
          entryCostPrice: costPrice,
          context: { signalBar: bars[i].date, atr: round(a[i] || 0, 5), params: p },
        };
      }
    }

    // 含み損も資金に反映する（実現損益だけを見ると、含みのDDを見落とす）
    const cvNow = cvAt(bar.date);
    const unreal = pos ? (bar.close - pos.entryPrice) * pos.dir * units * cvNow : 0;
    const mtm = equityStart + cum + unreal;
    equity.push({ date: bar.date, equity: round(equityStart + cum, 1), equityMtm: round(mtm, 1), openMtm: round(unreal, 1), pnl: round(cum, 1) });

    // 破産: この時点の資金（含み損込み）が床を割ったら、建玉を引けて止める
    if (ruinEnabled && !ruined && mtm <= ruinFloorJPY) {
      ruined = true; ruinDate = bar.date; stoppedEarly = true;
      if (pos) {
        const cv2 = cvAt(bar.date);
        const pnlPrice2 = (bar.close - pos.entryPrice) * pos.dir;
        const pnlJPY2 = (pnlPrice2 - pos.entryCostPrice - costPrice) * units * cv2 - C.commissionJPY;
        cum += pnlJPY2;
        trades.push({ entryDate: pos.entryDate, exitDate: bar.date, dir: pos.dir,
          entryPrice: round(pos.entryPrice, 5), exitPrice: round(bar.close, 5), pnlJPY: round(pnlJPY2, 1),
          reason: 'ruin_stop', barsHeld: pos.barsHeld, fxRate: round(cv2, 4), signalContext: pos.context });
        pos = null;
      }
      break;   // 以降は新規建てしない
    }
  }

  // close any dangling position at the last close (marked, not hidden)
  if (pos) {
    const last = bars[bars.length - 1];
    const cv = cvAt(last.date);
    const pnlPrice = (last.close - pos.entryPrice) * pos.dir;
    const pnlJPY = (pnlPrice - pos.entryCostPrice - costPrice) * units * cv - C.commissionJPY;
    cum += pnlJPY;
    trades.push({ entryDate: pos.entryDate, exitDate: last.date, dir: pos.dir,
      entryPrice: round(pos.entryPrice, 5), exitPrice: round(last.close, 5), pnlJPY: round(pnlJPY, 1),
      reason: 'open_at_end', barsHeld: pos.barsHeld, fxRate: round(cv, 4), signalContext: pos.context });
    equity.push({ date: last.date, equity: round(equityStart + cum, 1), pnl: round(cum, 1) });
  }

  const metrics = computeMetrics(trades, equity, C.initialCapitalJPY, bars, { ruined, ruinDate, stoppedEarly });
  return { trades, equity, metrics, params: p, cost: C, symbol, ruined, ruinDate, stoppedEarly };
}

export function backtest(bars, { strategyKey, params, cost = {} } = {}) {
  const strat = STRATEGIES[strategyKey];
  if (!strat) throw new Error(`unknown strategy: ${strategyKey}`);
  const p = normalizeParams(strategyKey, params);
  const intent = strat.intent(bars, p);
  return { ...simulateFromIntent(bars, intent, { params: p, cost, symbol: p.symbol || 'USDJPY' }), strategyKey };
}

export function computeMetrics(trades, equity, initialCapital, bars = [], meta = {}) {
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
  // 含み損を含めた最大DD（実現損益だけのDDはリスクを過小に見せる）。
  // 検証のゲートはこちらを使う（厳しい方を採用する）。
  let peakM = initialCapital; let maxDDM = 0; let maxDDPctM = 0;
  for (const e of equity) {
    const v = (e.equityMtm == null) ? e.equity : e.equityMtm;
    peakM = Math.max(peakM, v);
    const dd = peakM - v;
    if (dd > maxDDM) { maxDDM = dd; maxDDPctM = peakM > 0 ? (dd / peakM) * 100 : 100; }
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
    maxDrawdownJPYMtm: round(maxDDM, 1),
    maxDrawdownPctMtm: round(maxDDPctM, 2),
    ruined: !!meta.ruined,
    ruinDate: meta.ruinDate || null,
    stoppedEarly: !!meta.stoppedEarly,
    sharpe: round(sharpe, 2),
    cagrPct: years > 0.2 ? round(((initialCapital + net) / initialCapital) ** (1 / years) * 100 - 100, 2) : null,
    barsTested: bars.length,
    yearsCovered: round(years, 2),
    finalEquityJPY: round(initialCapital + net, 1),
    returnPerYearJPY: years > 0.2 ? round(net / years, 0) : null,
    assumptions: 'シグナルは当該バーの終値時点のみ使用、約定は翌バー始値。スプレッド・スリッページ・手数料を毎取引で控除。同時に複数条件が成立する場合は不利側（ストップ優先）で約定。資金（含み損込み）が0以下になったら取引を止める（破産判定）。maxDrawdownPct は実現損益ベース、maxDrawdownPctMtm は含み損込みで、ゲートは厳しい方（Mtm）を使う。',
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
