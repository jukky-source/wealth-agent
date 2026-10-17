// カーブフィッティング（過剰最適化）対策の本体。
//
// なぜ要るか:
//   バックテストは「儲かった」と言うのが仕事ではない。過去のデータに合わせ込んだだけの
//   偶然を、将来も続く実力と勘違いさせるのが一番危険な失敗だから。
//
// ここで入れる防御（それぞれ、防ぐ対象が違う）:
//   1. purgedKfold      — 期間をまたいだ情報の漏れ（保有中の建玉・境界の重なり）を断つ
//   2. cscv (PBO/CPCV)  — 「たくさん試して一番良いものを選ぶ」こと自体が生む過大評価を測る
//                        （同時に、単一の成績ではなくバックテスト結果の“分布”を出す）
//   3. deflatedSharpe   — 試行回数Nを織り込み、Sharpe を「N回試した中の最大値」として割り引く
//   4. blockBootstrap   — 日次リターンの自己相関を壊さずに、純益とSharpeの信頼区間・p値
//   5. signFlipTest     — 同じ取引サイズで損益の符号だけを入れ替える帰無検定
//   6. randomEntryNull  — 同じルール・同じ回数のランダムエントリーと比べ、入口が効いているか
//   7. costStress       — スプレッド/スリッページを増やしても残るか（=実行後も利益が出るか）
//   8. regimeBreakdown  — 1つの年・1つの相場環境だけで稼いでいないか（集中度）
//   9. plateau          — 最適点が「尖った峰」か「広い台地」か（パラメータの余裕）
//  10. dataQuality      — 穴・重複・停滞・外れ値。データが汚いと上の全部が無意味になる
//  11. multipleTesting  — 実験をN回まわした時に、p<0.05で「たまたま通過する」数の期待値
//
// 方針: すべて決定論的（乱数はシード固定）。外部通信なし。原価0。
// 出力は常に「過去の成績」であり、将来の利益ではありません。

import { mean, stdev, round, seededRandom } from '../util.js';
import {
  simulateFromIntent, normalizeParams, atr, sma, stdevRolling, highest, lowest,
  STRATEGIES, PAIRS, DEFAULT_COST_MODEL,
} from './backtest.js';

export const ROBUST_VERSION = 'robust-1.0';

// ---------------------------------------------------------------------------
// 正規分布（DSR/PSR で使う）。外部ライブラリなしで十分な精度を出す。
// ---------------------------------------------------------------------------
function erf(x) {
  // Abramowitz & Stegun 7.1.26（|誤差| < 1.5e-7）
  const s = x < 0 ? -1 : 1; const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return s * (1 - poly * Math.exp(-ax * ax));
}
export function normCdf(x) { return 0.5 * (1 + erf(Number(x) / Math.SQRT2)); }
export function normInv(p) {
  // Acklam の近似（相対誤差 1.15e-9）
  const pp = Math.min(Math.max(Number(p), 1e-12), 1 - 1e-12);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (pp < pl) { const q = Math.sqrt(-2 * Math.log(pp)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (pp > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - pp)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = pp - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------------------------------------------------------------------------
// リターン系列の要約（Sharpe の単位は「1期間あたり＝日次」で統一する）
// 年率換算が必要な箇所だけ ×sqrt(252) する（単位を混ぜると式が壊れる）。
// ---------------------------------------------------------------------------
export function sharpeStats(returns = []) {
  const r = returns.filter((v) => Number.isFinite(v));
  const n = r.length;
  if (n < 20) return { n, sharpe: 0, annualized: 0, skew: 0, kurtosis: 3, mean: 0, sd: 0 };
  const m = mean(r); const sd = stdev(r);
  if (!(sd > 0)) return { n, sharpe: 0, annualized: 0, skew: 0, kurtosis: 3, mean: m, sd: 0 };
  let m3 = 0; let m4 = 0;
  for (const v of r) { const d = v - m; m3 += d ** 3; m4 += d ** 4; }
  const skew = (m3 / n) / sd ** 3;
  const kurtosis = (m4 / n) / sd ** 4;         // 正規分布なら 3（超過尖度ではない）
  const sr = m / sd;
  return { n, sharpe: sr, annualized: sr * Math.sqrt(252), skew, kurtosis, mean: m, sd };
}

/** PSR — 推定Sharpeが基準watermarkを上回っている確率（Bailey & López de Prado 2012）。 */
export function probabilisticSharpe({ sharpe, n, skew = 0, kurtosis = 3, benchmark = 0 } = {}) {
  if (!(n > 1)) return 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2));
  return normCdf(((sharpe - benchmark) * Math.sqrt(n - 1)) / denom);
}

/** 試行回数Nのときの「偶然でも出てしまう最大Sharpe」の期待値（年率換算前の日次単位）。 */
export function expectedMaxSharpe({ trials = 1, varTrialSharpe = 0 } = {}) {
  const N = Math.max(2, Number(trials) || 1);
  const g = 0.5772156649015329;                 // オイラー・ガンマ
  const e = Math.E;
  const z1 = normInv(1 - 1 / N);
  const z2 = normInv(1 - 1 / (N * e));
  return Math.sqrt(Math.max(0, varTrialSharpe)) * ((1 - g) * z1 + g * z2);
}

/**
 * DSR — 多数試行（N回のうちの最大値）と非正規性の両方を織り込んだ割引後のSharpe確率。
 * > 0.95 なら「N回試してなお、偶然の最高値ではない」と言える水準。
 */
export function deflatedSharpe({ sharpe, n, skew = 0, kurtosis = 3, trials = 1, varTrialSharpe = 0 } = {}) {
  const sr0 = expectedMaxSharpe({ trials, varTrialSharpe });
  const psr = probabilisticSharpe({ sharpe, n, skew, kurtosis, benchmark: sr0 });
  return { dsr: round(psr, 4), sr0Daily: round(sr0, 5), sr0Annualized: round(sr0 * Math.sqrt(252), 3), benchmarkUsed: 'N回試行の最大Sharpe期待値' };
}

// ---------------------------------------------------------------------------
// 11. データ品質 — ここが汚いと、この後の検定はすべて意味を失う。
// ---------------------------------------------------------------------------
export function dataQuality(bars = [], { source = null } = {}) {
  const issues = [];
  if (!bars.length) return { ok: false, issues: ['データが空'], bars: 0 };
  let dup = 0; let nonMonotonic = 0; let badOhlc = 0; let zeroRange = 0; let stale = 0; let bigGap = 0; let outliers = 0;
  const seen = new Set();
  let prev = null; let sameClose = 1; let maxSameClose = 1; let weekendBars = 0;
  for (const b of bars) {
    if (seen.has(b.date)) dup++; else seen.add(b.date);
    if (prev && String(b.date) <= String(prev.date)) nonMonotonic++;
    if (!(b.high >= b.low) || !(b.high >= b.open) || !(b.high >= b.close) || !(b.low <= b.open) || !(b.low <= b.close)) badOhlc++;
    if (b.high === b.low) zeroRange++;
    if (prev) {
      const days = (new Date(b.date) - new Date(prev.date)) / 86400e3;
      if (days > 7) bigGap++;
      if (days < 1) bigGap++;
      const ret = prev.close > 0 ? Math.abs(b.close / prev.close - 1) : 0;
      if (ret > 0.10) outliers++;
      if (b.close === prev.close) { sameClose++; maxSameClose = Math.max(maxSameClose, sameClose); } else sameClose = 1;
    }
    const dow = new Date(`${b.date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) weekendBars++;
    prev = b;
  }
  if (dup) issues.push(`日付の重複が ${dup} 件`);
  if (nonMonotonic) issues.push(`日付の順序が逆転 ${nonMonotonic} 件`);
  if (badOhlc) issues.push(`OHLCの整合が壊れている ${badOhlc} 件（高値<安値 など）`);
  if (zeroRange > bars.length * 0.05) issues.push(`値幅ゼロのバーが ${zeroRange} 件（動いていない＝約定できない）`);
  if (maxSameClose >= 5) issues.push(`終値が ${maxSameClose} 日連続で同一（価格が停滞＝合成データの疑い）`);
  if (bigGap > bars.length * 0.05) issues.push(`日付の間隔異常が ${bigGap} 件`);
  if (outliers > 3) issues.push(`1日で10%超の変動が ${outliers} 件（データ誤りの可能性）`);
  if (String(source || '').startsWith('ecb')) issues.push('高値/安値が合成（終値のみのデータ）＝値幅を使うロジックは信用できない');
  const synthetic = String(source || '').startsWith('ecb');
  const ok = !synthetic && badOhlc === 0 && dup === 0 && nonMonotonic === 0 && zeroRange <= bars.length * 0.05;
  return {
    ok, issues, source,
    bars: bars.length, from: bars[0].date, to: bars[bars.length - 1].date,
    weekend_bars: weekendBars, max_stale_run: maxSameClose, gaps: bigGap, outliers,
    note: ok ? '構造的な問題は見つかりませんでした（欠測・重複・OHLC整合を検査）' : '問題あり: この後の検定結果は参考値として扱ってください',
  };
}

// ---------------------------------------------------------------------------
// 日次損益の系列（設定をまたいで長さが揃うので、そのまま行列として比較できる）
// ---------------------------------------------------------------------------
function pnlSeries(bars, { strategyKey, params, cost }) {
  const p = normalizeParams(strategyKey, params);
  const intent = STRATEGIES[strategyKey].intent(bars, p);
  const r = simulateFromIntent(bars, intent, { params: p, cost, symbol: p.symbol });
  const eq = r.equity;
  const n = bars.length - 1;
  const pnl = new Array(n).fill(0);
  let prevEq = r.cost.initialCapitalJPY;
  for (let i = 0; i < n && i < eq.length; i++) { pnl[i] = eq[i].equity - prevEq; prevEq = eq[i].equity; }
  return { pnl, result: r, params: p };
}

// ---------------------------------------------------------------------------
// 1. purged K-fold（逐次・パージ＋エンバーゴ）
//    パラメータは固定なので「学習」はしない。ここで測るのは
//    「期間を分けても同じ実力が出るか」＝ 成績が一時期への依存でないか。
//    各フォルダの前にはウォームアップとして直前のバーだけを渡す（未来は渡さない）。
// ---------------------------------------------------------------------------
export function purgedKfold(bars, { strategyKey, params, cost }, { k = 6, warmup = 250, embargoPct = 0.01 } = {}) {
  const p = normalizeParams(strategyKey, params);
  const n = bars.length;
  const size = Math.floor(n / k);
  const embargo = Math.max(1, Math.floor(size * embargoPct));
  const folds = [];
  for (let f = 0; f < k; f++) {
    const testFrom = f * size;
    const testTo = f === k - 1 ? n : (f + 1) * size;
    // エンバーゴ: 境界の直後を評価から外す（境界をまたいだ建玉の影響を消す）
    const evalFrom = f === 0 ? testFrom : testFrom + embargo;
    if (testTo - evalFrom < 60) continue;
    const slice = bars.slice(Math.max(0, evalFrom - warmup), testTo).map((b) => ({ ...b }));
    const inFold = new Set(bars.slice(evalFrom, testTo).map((b) => b.date));
    const r0 = simulateFromIntent(slice, STRATEGIES[strategyKey].intent(slice, p), { params: p, cost, symbol: p.symbol });
    const trades = r0.trades.filter((t) => inFold.has(t.entryDate));
    const init = Number(cost?.initialCapitalJPY || DEFAULT_COST_MODEL.initialCapitalJPY);
    const gross = trades.filter((t) => t.pnlJPY > 0).reduce((s, t) => s + t.pnlJPY, 0);
    const loss = Math.abs(trades.filter((t) => t.pnlJPY <= 0).reduce((s, t) => s + t.pnlJPY, 0));
    const net = gross - loss;
    // フォルダ内の損益は評価対象日だけを取り出す（ウォームアップ期間の損益は捨てる）
    const pnl = [];
    let prevEq = init;
    for (const e of r0.equity) { if (inFold.has(e.date)) pnl.push(e.equity - prevEq); prevEq = e.equity; }
    const st = sharpeStats(pnl);
    folds.push({
      fold: f + 1, from: bars[evalFrom]?.date, to: bars[testTo - 1]?.date, bars: testTo - evalFrom,
      trades: trades.length, netJPY: round(net, 1),
      netPctOfCapital: round((net / init) * 100, 2),
      profitFactor: loss > 0 ? round(gross / loss, 3) : (gross > 0 ? null : 0),
      sharpeAnnualized: round(st.annualized, 3),
    });
  }
  const withTrades = folds.filter((f) => f.trades >= 5);
  const positive = withTrades.filter((f) => f.netJPY > 0).length;
  const nets = withTrades.map((f) => f.netPctOfCapital);
  return {
    k, embargo_bars: embargo, folds,
    evaluated_folds: withTrades.length,
    positive_folds: positive,
    positive_share: withTrades.length ? round(positive / withTrades.length, 3) : 0,
    mean_net_pct: nets.length ? round(mean(nets), 2) : null,
    worst_net_pct: nets.length ? round(Math.min(...nets), 2) : null,
    median_sharpe_annualized: withTrades.length ? round(median(withTrades.map((f) => f.sharpeAnnualized)), 3) : null,
    consistent: withTrades.length >= 3 && positive >= Math.ceil(withTrades.length * 0.7),
    note: '固定パラメータでの期間分割検証。各フォルダは直前のバーだけをウォームアップに使い、境界直後をエンバーゴで除外（保有中の建玉が境界をまたぐ影響を消す）。',
  };
}

// ---------------------------------------------------------------------------
// 2. CSCV / PBO + CPCV（バックテスト結果の“分布”）
//    N通りの設定を期間ブロックに分割し、「同じ半分を学習、残り半分を検証」を
//    全組み合わせで繰り返す。学習側で最良の設定が検証側で中央値以下に落ちる確率が PBO。
// ---------------------------------------------------------------------------
export function cscv(bars, { strategyKey, configs = [], base = {}, cost }, { s = 8, seed = 'cscv' } = {}) {
  const n = bars.length;
  if (configs.length < 3 || n < 400) {
    return { ok: false, reason: '設定数3以上・バー400本以上が必要', pbo: null };
  }
  const rows = configs.map((c) => pnlSeries(bars, { strategyKey, params: { ...base, ...c, symbol: base.symbol }, cost }));
  const total = bars.length - 1;
  const chunk = Math.floor(total / s);
  const embargo = Math.max(1, Math.floor(chunk * 0.01));
  // 各設定×各ブロックの Sharpe（ブロック内の日次損益から）
  const blockSharpe = rows.map((r) => {
    const out = [];
    for (let b = 0; b < s; b++) {
      const from = b * chunk + (b === 0 ? 0 : embargo);
      const to = b === s - 1 ? total : (b + 1) * chunk;
      out.push(sharpeStats(r.pnl.slice(from, to)).annualized);
    }
    return out;
  });
  const half = Math.floor(s / 2);
  const combos = kCombinations(s, half);
  const logits = []; const oosSharpes = []; const selected = [];
  let below = 0;
  for (const combo of combos) {
    const isSet = new Set(combo);
    const isSharpe = rows.map((_, ci) => mean(combo.map((b) => blockSharpe[ci][b])));
    let best = 0;
    for (let ci = 1; ci < rows.length; ci++) if (isSharpe[ci] > isSharpe[best]) best = ci;
    const oosBlocks = [...Array(s).keys()].filter((b) => !isSet.has(b));
    const oos = rows.map((_, ci) => mean(oosBlocks.map((b) => blockSharpe[ci][b])));
    const rank = oos.filter((v) => v < oos[best]).length;
    const omega = (rank + 0.5) / rows.length;        // 順位を (0,1) に収める
    const logit = Math.log(omega / (1 - omega));
    logits.push(logit);
    oosSharpes.push(oos[best]);
    selected.push(best);
    if (logit < 0) below++;
  }
  const pbo = combos.length ? below / combos.length : null;
  const sh = sharpeStats(oosSharpes.map((v) => v / Math.sqrt(252)));   // 年率→日次に戻して要約
  const netPct = oosSharpes.map((v) => v);                             // 検証側Sharpeの分布
  return {
    ok: true, s, configs: rows.length, paths: combos.length, pbo: round(pbo, 3),
    oos_sharpe: {
      mean_annualized: round(mean(oosSharpes), 3),
      median_annualized: round(median(oosSharpes), 3),
      worst_annualized: round(Math.min(...oosSharpes), 3),
      best_annualized: round(Math.max(...oosSharpes), 3),
      negative_share: round(oosSharpes.filter((v) => v < 0).length / oosSharpes.length, 3),
      stdev: round(stdev(oosSharpes), 3),
    },
    oos_sharpe_series: netPct.map((v) => round(v, 3)).slice(0, 120),
    median_logit: round(median(logits), 3),
    distinct_selected: new Set(selected).size,
    note: `期間を${s}ブロックに分け、${half}ブロックを「学習」・残りを「検証」とする全${combos.length}通りの組み合わせを評価。PBO = 学習側で最良だった設定が検証側で中央値以下に落ちた割合（0.5超は過剰最適化の疑いが濃い）。単一の成績ではなく検証側の分布を見ます。`,
    interpretation: pbo == null ? '' : pbo <= 0.2 ? '過剰最適化の兆候は小さい' : pbo <= 0.5 ? '注意（軽度の過剰最適化）' : '危険（学習に合わせ込んでいる）',
  };
}

function kCombinations(n, k) {
  const out = [];
  const cur = [];
  const rec = (start) => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1); cur.pop(); }
  };
  rec(0);
  return out;
}

// ---------------------------------------------------------------------------
// 4. ブロック・ブートストラップ（日次リターンの自己相関を壊さずに再標本化）
// ---------------------------------------------------------------------------
export function blockBootstrap(returns = [], { B = 500, block = 10, seed = 'boot' } = {}) {
  const r = returns.filter((v) => Number.isFinite(v));
  if (r.length < 60) return { ok: false, reason: 'リターン60点以上が必要', p_value: null };
  const rnd = seededRandom(String(seed));
  const n = r.length;
  const means = []; const sharpes = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    while (sample.length < n) {
      const start = Math.floor(rnd() * (n - block));
      for (let i = 0; i < block && sample.length < n; i++) sample.push(r[start + i]);
    }
    const st = sharpeStats(sample);
    means.push(st.mean); sharpes.push(st.annualized);
  }
  means.sort((a, b2) => a - b2); sharpes.sort((a, b2) => a - b2);
  const pNeg = means.filter((v) => v <= 0).length / B;
  return {
    ok: true, B, block_length: block, observations: n,
    mean_daily_return_pct: round(mean(r) * 100, 4),
    ci95_daily_return_pct: [round(means[Math.floor(B * 0.025)] * 100, 4), round(means[Math.floor(B * 0.975)] * 100, 4)],
    ci95_sharpe_annualized: [round(sharpes[Math.floor(B * 0.025)], 3), round(sharpes[Math.floor(B * 0.975)], 3)],
    p_value_mean_le_zero: round(pNeg, 4),
    note: `連続${block}日のブロック単位で再標本化（${B}回）。日次リターンの並びの偏りを保ったまま「この成績が偶然でも出るか」を見る。p値は平均日次リターンが0以下になる割合。`,
  };
}

// ---------------------------------------------------------------------------
// 5. 符号反転検定（同じ取引の損益符号だけをランダム化）
// ---------------------------------------------------------------------------
export function signFlipTest(trades = [], { B = 1000, seed = 'sign' } = {}) {
  const pnls = trades.map((t) => t.pnlJPY).filter((v) => Number.isFinite(v));
  if (pnls.length < 20) return { ok: false, reason: '取引20件以上が必要', p_value: null };
  const rnd = seededRandom(String(seed));
  const actual = mean(pnls);
  const sizes = pnls.map((v) => Math.abs(v));
  let beats = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < sizes.length; i++) s += (rnd() < 0.5 ? -1 : 1) * sizes[i];
    if (s / sizes.length >= actual) beats++;
  }
  return {
    ok: true, B, trades: pnls.length, expectancy_jpy: round(actual, 1),
    p_value: round(beats / B, 4),
    note: '損益の大きさ（絶対値）はそのままに、勝ち/負けの符号だけを無作為化した帰無分布と比較。期待値が「大きさの偏り」だけで説明できないかを見る。',
  };
}

// ---------------------------------------------------------------------------
// 6. ランダムエントリー帰無検定（入口が効いているか）
//    「同じルール・同じ取引回数で、入口だけを無作為にした場合」より良いかを測る。
//    これが最重要の検定のひとつ。入口が無意味なら、ここで負ける。
// ---------------------------------------------------------------------------
export function randomEntryNull(bars, { strategyKey, params, cost }, { B = 60, seed = 'null' } = {}) {
  const p = normalizeParams(strategyKey, params);
  const real = pnlSeries(bars, { strategyKey, params: p, cost });
  const realTrades = real.result.trades.length;
  if (realTrades < 15) return { ok: false, reason: '取引15件以上が必要', p_value: null };
  const targetRate = Math.min(0.95, realTrades / Math.max(1, bars.length - 2));
  const rnd = seededRandom(String(seed));
  const nets = [];
  for (let b = 0; b < B; b++) {
    const intent = bars.map(() => 0);
    for (let i = 1; i < bars.length - 1; i++) {
      if (rnd() < targetRate) intent[i] = rnd() < 0.5 ? 1 : -1;
    }
    const sim = simulateFromIntent(bars, intent, { params: p, cost, symbol: p.symbol });
    nets.push(sim.metrics.netProfitJPY);
  }
  nets.sort((a, b) => a - b);
  const realNet = real.result.metrics.netProfitJPY;
  const better = nets.filter((v) => v >= realNet).length;
  return {
    ok: true, B, real_trades: realTrades, entry_probability_used: round(targetRate, 4),
    real_net_jpy: round(realNet, 1),
    random_median_net_jpy: round(nets[Math.floor(B / 2)], 1),
    random_p95_net_jpy: round(nets[Math.floor(B * 0.95)], 1),
    random_best_net_jpy: round(nets[B - 1], 1),
    p_value: round(better / B, 4),
    edge_vs_random_jpy: round(realNet - nets[Math.floor(B / 2)], 1),
    note: `入口だけを無作為（同じ確率${round(targetRate * 100, 2)}%で売買）にした${B}回と比較し、損切り・利確・費用は実物と同一。p値はランダム側が実物以上になった割合。入口に意味がなければ0.5前後になります。`,
  };
}

// ---------------------------------------------------------------------------
// 7. コスト耐性（スプレッド/スリッページを増やしても残るか）
// ---------------------------------------------------------------------------
export function costStress(bars, { strategyKey, params, cost }, { multipliers = [1, 1.5, 2, 3, 5] } = {}) {
  const C = { ...DEFAULT_COST_MODEL, ...(cost || {}) };
  const rows = multipliers.map((m) => {
    const c = { ...C, spreadPips: C.spreadPips * m, slippagePips: C.slippagePips * m, commissionJPY: C.commissionJPY * m };
    const p = normalizeParams(strategyKey, params);
    const sim = simulateFromIntent(bars, STRATEGIES[strategyKey].intent(bars, p), { params: p, cost: c, symbol: p.symbol });
    return { multiplier: m, netJPY: sim.metrics.netProfitJPY, netPct: sim.metrics.netProfitPct, trades: sim.metrics.trades, pf: sim.metrics.profitFactor };
  });
  // 純益が0になる費用倍率（線形補間）
  let breakeven = null;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].netJPY > 0 && rows[i].netJPY <= 0) {
      const t = rows[i - 1].netJPY / (rows[i - 1].netJPY - rows[i].netJPY);
      breakeven = round(rows[i - 1].multiplier + t * (rows[i].multiplier - rows[i - 1].multiplier), 2);
      break;
    }
    if (rows[i].netJPY > 0) breakeven = rows[i].multiplier;
  }
  return {
    rows, breakeven_multiplier: breakeven ?? (rows[0].netJPY > 0 ? '>' + multipliers[multipliers.length - 1] : '<' + multipliers[0]),
    survives_2x: rows.some((r) => r.multiplier === 2 && r.netJPY > 0),
    note: `費用を${multipliers.join('/')}倍にしたときの純益。実口座は検証より悪い条件になり得るので、2倍でも残ることが最低条件。損益分岐の費用倍率も出します。`,
  };
}

// ---------------------------------------------------------------------------
// 8. 相場環境・期間への集中度（1つの年/1つのボラ環境で稼いでいないか）
// ---------------------------------------------------------------------------
export function regimeBreakdown(bars, { strategyKey, params, cost }, { source = null } = {}) {
  const p = normalizeParams(strategyKey, params);
  const sim = simulateFromIntent(bars, STRATEGIES[strategyKey].intent(bars, p), { params: p, cost, symbol: p.symbol });
  const trades = sim.trades;
  if (!trades.length) return { ok: false, reason: '取引がありません' };
  const a = atr(bars, 14);
  const byDate = new Map(bars.map((b, i) => [b.date, { i, atr: a[i] }]));
  const vols = bars.map((b, i) => (i < 20 ? null : stdevRolling(bars.map((x) => x.close), 20)[i])).filter((v) => v != null);
  const volTerciles = [quantile(vols, 1 / 3), quantile(vols, 2 / 3)];
  const volOf = (i) => (i < 20 ? 0 : stdevRolling(bars.map((x) => x.close), 20)[i] || 0);

  const byYear = {}; const byVol = { low: 0, mid: 0, high: 0 }; const byDir = { long: 0, short: 0 }; const byReason = {};
  for (const t of trades) {
    const y = String(t.entryDate).slice(0, 4);
    byYear[y] = round((byYear[y] || 0) + t.pnlJPY, 1);
    const idx = byDate.get(t.entryDate)?.i ?? 0;
    const v = volOf(idx);
    byVol[v <= volTerciles[0] ? 'low' : v <= volTerciles[1] ? 'mid' : 'high'] += t.pnlJPY;
    byDir[t.dir === 1 ? 'long' : 'short'] += t.pnlJPY;
    byReason[t.reason] = round((byReason[t.reason] || 0) + t.pnlJPY, 1);
  }
  const posYears = Object.entries(byYear).map(([y, v]) => [y, round(v, 1)]);
  const totalPositive = posYears.reduce((s, [, v]) => s + Math.max(0, v), 0);
  const maxYear = posYears.reduce((best, cur) => (Math.max(0, cur[1]) > Math.max(0, best[1]) ? cur : best), ['-', 0]);
  const maxYearShare = totalPositive > 0 ? round(Math.max(0, maxYear[1]) / totalPositive, 3) : null;
  const profitableYears = posYears.filter(([, v]) => v > 0).length;
  return {
    ok: true,
    years: Object.fromEntries(posYears.sort(([a2], [b2]) => a2.localeCompare(b2))),
    years_count: posYears.length, profitable_years: profitableYears,
    by_volatility: Object.fromEntries(Object.entries(byVol).map(([k, v]) => [k, round(v, 1)])),
    by_side: Object.fromEntries(Object.entries(byDir).map(([k, v]) => [k, round(v, 1)])),
    by_exit_reason: byReason,
    max_year: maxYear[0], max_year_share: maxYearShare,
    note: `年ごと・ボラティリティ3分位・売買方向・決済理由に分解。max_year_share は「最も稼いだ年の利益が、プラス年の合計に占める割合」。1年だけが突出している戦略は、その年の特殊要因に依存している可能性があります（目安: 0.6以下）。`,
  };
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// ---------------------------------------------------------------------------
// 9. パラメータの台地/尖り（近傍を1歩ずつ動かして、崩れないか見る）
// ---------------------------------------------------------------------------
export function plateau(bars, { strategyKey, params, cost }, { maxNeighbors = 24 } = {}) {
  const s = STRATEGIES[strategyKey];
  const base = normalizeParams(strategyKey, params);
  const grid = s.grid || {};
  const keys = Object.keys(grid).filter((k) => Array.isArray(grid[k]) && grid[k].length > 1);
  const center = pnlSeries(bars, { strategyKey, params: base, cost });
  const centerNet = center.result.metrics.netProfitPct;
  const neighbors = [];
  for (const k of keys) {
    const vals = grid[k];
    const cur = base[k];
    const idx = vals.findIndex((v) => v === cur);
    const candidates = idx < 0 ? vals : [vals[idx - 1], vals[idx + 1]].filter((v) => v !== undefined);
    for (const v of candidates) {
      if (neighbors.length >= maxNeighbors) break;
      const p2 = { ...base, [k]: v };
      const r = pnlSeries(bars, { strategyKey, params: p2, cost });
      neighbors.push({
        changed: k, from: cur, to: v,
        netPct: r.result.metrics.netProfitPct, pf: r.result.metrics.profitFactor, trades: r.result.metrics.trades,
      });
    }
  }
  // atrStopMult はグリッド外で連続に動かす（探索と同じ扱い）
  for (const v of [Math.max(1, Number(base.atrStopMult || 2) - 0.5), Number(base.atrStopMult || 2) + 0.5]) {
    if (neighbors.length >= maxNeighbors + 2) break;
    const r = pnlSeries(bars, { strategyKey, params: { ...base, atrStopMult: round(v, 1) }, cost });
    neighbors.push({ changed: 'atrStopMult', from: base.atrStopMult, to: round(v, 1), netPct: r.result.metrics.netProfitPct, pf: r.result.metrics.profitFactor, trades: r.result.metrics.trades });
  }
  const positive = neighbors.filter((n) => n.netPct > 0).length;
  const share = neighbors.length ? round(positive / neighbors.length, 3) : null;
  const worst = neighbors.length ? Math.min(...neighbors.map((n) => n.netPct)) : null;
  const sens = {};
  for (const n of neighbors) (sens[n.changed] = sens[n.changed] || []).push(n.netPct);
  const sensitivity = Object.fromEntries(Object.entries(sens).map(([k, v]) => [k, {
    min: round(Math.min(...v), 2), max: round(Math.max(...v), 2), mean: round(mean(v), 2),
  }]));
  return {
    ok: neighbors.length > 0,
    center_net_pct: round(centerNet, 2),
    neighbors_tested: neighbors.length,
    positive_share: share,
    worst_neighbor_net_pct: worst === null ? null : round(worst, 2),
    best_neighbor_net_pct: neighbors.length ? round(Math.max(...neighbors.map((n) => n.netPct)), 2) : null,
    neighbors: neighbors.slice(0, 30).map((n) => ({ ...n, netPct: round(n.netPct, 2) })),
    sensitivity,
    is_plateau: share != null && share >= 0.7,
    note: '各パラメータを1歩だけ動かした近傍を評価。shareが高く worst もプラス圏なら「広い台地」（頑健）。1点だけ突出していると、パラメータを少し変えただけで崩れます。',
  };
}

// ---------------------------------------------------------------------------
// 11. 多重検定の補正 — N回試せば、p<0.05 は 0.05N 回「たまたま」通過する。
// ---------------------------------------------------------------------------
export function multipleTesting({ trials = 1, trialSharpes = [], pValue = null } = {}) {
  const N = Math.max(1, Number(trials) || 1);
  const sh = trialSharpes.filter((v) => Number.isFinite(v));
  const varTrialSharpe = sh.length >= 3 ? variance(sh) : 0;
  const expectedFalsePositives = round(0.05 * N, 2);
  return {
    trials: N,
    trial_sharpe_count: sh.length,
    trial_sharpe_variance: round(varTrialSharpe, 6),
    trial_sharpe_max: sh.length ? round(Math.max(...sh), 3) : null,
    expected_false_positives_at_5pct: expectedFalsePositives,
    bonferroni_threshold: round(0.05 / N, 6),
    bh_note: `実験が${N}件あるので、素の p<0.05 は約${expectedFalsePositives}件が偶然でも通過します。判定には Bonferroni 水準（${round(0.05 / N, 6)}）とDSR（試行回数込みの割引）を併用します。`,
    p_value_adjusted: pValue == null ? null : round(Math.min(1, pValue * N), 4),
  };
}

function variance(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// 総合判定 — 上の検定をまとめて1つの結論にする（人が見るのはここ）
// ---------------------------------------------------------------------------
export function verdictFrom(report = {}) {
  const reasons = []; const warnings = [];
  let pass = true;
  const m = report.metrics || {};
  const q = report.data_quality || {};
  if (q.ok === false) { pass = false; reasons.push(`データ品質に問題: ${(q.issues || []).join(' / ')}`); }
  if (Number(m.trades || 0) < 30) { pass = false; reasons.push(`取引回数が少なすぎる (${m.trades ?? 0} < 30)`); }
  if (m.profitFactor !== null && Number(m.profitFactor) < 1.15) { pass = false; reasons.push(`プロフィットファクター不足 (${m.profitFactor} < 1.15)`); }
  if (Number(m.expectancy || 0) <= 0) { pass = false; reasons.push('期待値がプラスでない'); }
  if (Number(m.maxDrawdownPct || 0) > 35) { pass = false; reasons.push(`最大DDが大きすぎる (${m.maxDrawdownPct}% > 35%)`); }

  const pf = report.purged || {};
  if (pf.ok !== false && pf.positive_share != null) {
    if (pf.positive_share < 0.7) { pass = false; reasons.push(`期間を分けると崩れる（プラス ${pf.positive_folds}/${pf.evaluated_folds} フォルダ）`); }
  }
  const cscvR = report.cscv || {};
  if (cscvR.ok && cscvR.pbo != null) {
    if (cscvR.pbo > 0.5) { pass = false; reasons.push(`過剰最適化の疑いが濃い（PBO ${cscvR.pbo} > 0.5）`); }
    else if (cscvR.pbo > 0.2) warnings.push(`軽度の過剰最適化（PBO ${cscvR.pbo}）`);
  }
  const dsr = report.dsr || {};
  if (dsr.dsr != null) {
    if (dsr.dsr < 0.9) { pass = false; reasons.push(`試行回数を織り込むと偶然と区別できない（DSR ${dsr.dsr} < 0.90, 期待最大Sharpe ${dsr.sr0Annualized}）`); }
    else if (dsr.dsr < 0.95) warnings.push(`DSR ${dsr.dsr}（0.95未満なので様子見）`);
  }
  const bs = report.bootstrap || {};
  if (bs.ok && bs.p_value_mean_le_zero != null && bs.p_value_mean_le_zero > 0.05) {
    pass = false; reasons.push(`ブロック・ブートストラップで平均リターンが0以下になる確率が高い（${bs.p_value_mean_le_zero}）`);
  }
  const nullT = report.null_test || {};
  if (nullT.ok && nullT.p_value != null && nullT.p_value > 0.5) {
    warnings.push(`ランダムエントリーに勝てていない（p ${nullT.p_value}）`);
  }
  const cs = report.cost_stress || {};
  if (cs.rows && cs.survives_2x === false) { pass = false; reasons.push('費用を2倍にすると赤字（実行後の余裕がない）'); }
  const rg = report.regime || {};
  if (rg.ok && rg.max_year_share != null && rg.max_year_share > 0.6 && rg.years_count >= 3) {
    warnings.push(`利益が${rg.max_year}年に偏っている（プラス年の合計の${round(rg.max_year_share * 100, 0)}%）`);
  }
  const pl = report.plateau || {};
  if (pl.ok && pl.positive_share != null && pl.positive_share < 0.55) {
    pass = false; reasons.push(`パラメータ近傍で崩れる（近傍のプラス率 ${(pl.positive_share * 100).toFixed(0)}%）`);
  }
  return { pass, reasons, warnings };
}

/** 総合スコア（大きいほど「偶然でなく、崩れにくい」）。順位付けはこの値で。 */
export function robustnessScore(report = {}) {
  const dsr = report.dsr?.dsr ?? 0;
  const pbo = report.cscv?.pbo ?? 0.5;
  const plateauShare = report.plateau?.positive_share ?? 0;
  const boot = report.bootstrap?.p_value_mean_le_zero ?? 1;
  const nullP = report.null_test?.p_value ?? 1;
  const purged = report.purged?.positive_share ?? 0;
  const costMult = typeof report.cost_stress?.breakeven_multiplier === 'number' ? report.cost_stress.breakeven_multiplier : 1;
  const regimeShare = report.regime?.max_year_share ?? 1;
  const dq = report.data_quality?.ok === false ? 0 : 1;
  const raw = dsr * 40 + (1 - pbo) * 20 + plateauShare * 10 + (1 - boot) * 10 + (1 - nullP) * 5
    + purged * 10 + Math.min(1, costMult / 3) * 5 + (1 - regimeShare) * 5;
  return round(raw * dq, 2);
}

/**
 * フル検証 — 1つの候補に対して、上の検定をまとめて実行する。
 * CPUを使うので、昇格候補（門を通り王者を上回ったもの）だけに走らせる。
 * budgetMs を超えたら残りは null にして「未実施」を明記する（黙って省略しない）。
 */
export function deepValidate(bars, {
  symbol, strategyKey, params, cost = null, trials = 1, trialSharpes = [], source = null,
  seed = 'deep', budgetMs = 18000, configs = null, s = 8, B_null = 40, B_boot = 400,
} = {}) {
  const t0 = Date.now();
  const p = normalizeParams(strategyKey, params);
  const C = { ...DEFAULT_COST_MODEL, ...(cost || {}) };
  const base = pnlSeries(bars, { strategyKey, params: p, cost: C });
  const returns = base.pnl.map((v) => (base.result.cost.initialCapitalJPY > 0 ? v / base.result.cost.initialCapitalJPY : 0));
  const st = sharpeStats(returns);
  const mt = multipleTesting({ trials, trialSharpes });
  const report = {
    version: ROBUST_VERSION, ok: true, symbol, strategy_key: strategyKey, params: p, bars: bars.length,
    from: bars[0]?.date, to: bars[bars.length - 1]?.date, data_source: source, cost: C,
    metrics: base.result.metrics,
    data_quality: dataQuality(bars, { source }),
    multiple_testing: mt,
  };
  const elapsed = () => Date.now() - t0;
  const budgetLeft = (need) => elapsed() + need < budgetMs;

  report.purged = (() => { try { return purgedKfold(bars, { strategyKey, params: p, cost: C }, { k: 6 }); } catch (e) { return { ok: false, reason: e.message }; } })();
  report.dsr = deflatedSharpe({ sharpe: st.sharpe, n: st.n, skew: st.skew, kurtosis: st.kurtosis, trials: mt.trials, varTrialSharpe: mt.trial_sharpe_variance });
  report.psr = round(probabilisticSharpe({ sharpe: st.sharpe, n: st.n, skew: st.skew, kurtosis: st.kurtosis, benchmark: 0 }), 4);
  report.bootstrap = blockBootstrap(returns, { B: B_boot, block: 10, seed: `${seed}-boot` });
  report.sign_flip = signFlipTest(base.result.trades, { B: 600, seed: `${seed}-sign` });
  report.cost_stress = costStress(bars, { strategyKey, params: p, cost: C });
  report.regime = regimeBreakdown(bars, { strategyKey, params: p, cost: C }, { source });

  // 設定の候補（CSCV 用）— グリッドから決定的に選ぶ。渡されればそれを使う。
  const cfgList = configs || gridSample(strategyKey, p, 10);
  report.cscv = cfgList.length >= 3 && budgetLeft(300)
    ? cscv(bars, { strategyKey, configs: cfgList, base: { ...p }, cost: C }, { s, seed: `${seed}-cscv` })
    : { ok: false, reason: 'budget_or_configs', pbo: null };

  report.plateau = budgetLeft(400)
    ? plateau(bars, { strategyKey, params: p, cost: C })
    : { ok: false, reason: 'budget_exhausted' };
  report.null_test = budgetLeft(300)
    ? randomEntryNull(bars, { strategyKey, params: p, cost: C }, { B: B_null, seed: `${seed}-null` })
    : { ok: false, reason: 'budget_exhausted' };

  report.elapsed_ms = elapsed();
  report.budget_ms = budgetMs;
  report.sharpe_stats = { daily: round(st.sharpe, 5), annualized: round(st.annualized, 3), skew: round(st.skew, 3), kurtosis: round(st.kurtosis, 3), observations: st.n };
  const v = verdictFrom(report);
  report.gates = v;
  report.score = robustnessScore(report);
  report.honesty_note = [
    '過去データでの検証結果であり、将来の利益を約束しません。',
    '単一の通貨ペア・日足・1ポジション・固定数量という前提です。実口座はスワップ・週末の窓・約定拒否が別途効きます。',
    budgetLeft(0) ? '' : 'CPU予算の都合で一部の検定が未実施です（null の項目）。未実施を「合格」とは扱いません。',
  ].filter(Boolean).join(' ');
  return report;
}

/** グリッドから決定的にN通り選ぶ（CSCV の入力＝試した設定の集合） */
export function gridSample(strategyKey, params, n = 10) {
  const s = STRATEGIES[strategyKey];
  const grid = s?.grid || {};
  const keys = Object.keys(grid).filter((k) => Array.isArray(grid[k]) && grid[k].length > 1);
  const base = normalizeParams(strategyKey, params);
  const out = [];
  for (const k of keys) {
    for (const v of grid[k]) {
      if (v === base[k]) continue;
      out.push({ [k]: v });
      if (out.length >= n - 1) break;
    }
    if (out.length >= n - 1) break;
  }
  // パラメータを変えない（＝王者そのもの）を必ず入れる
  return [{}, ...out];
}

export { mean, stdev, round, sma, stdevRolling, highest, lowest, atr, PAIRS, DEFAULT_COST_MODEL };
