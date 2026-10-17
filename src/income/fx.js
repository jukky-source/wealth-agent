// FX Research Agent
// Market data → hypothesis generation → Pine generation → non-repaint lint →
// backtest (costs included) → walk-forward → overfit detection → loser analysis
// → parameter improvement → re-test → versioned promotion.

import { id as newId, nowIso, j, safeJson, round, hash, truncate } from '../util.js';
import { BASIS } from '../truth.js';
import { backtest, walkForward, overfitCheck, analyzeLosers, orderRobustness, STRATEGIES, DEFAULT_COST_MODEL, PAIRS } from './backtest.js';
import { generatePine, lintPine } from './pine.js';

export const SUPPORTED_SYMBOLS = Object.keys(PAIRS);

// ---------------------------------------------------------------------------
// Market data: Yahoo Finance daily OHLC (primary), ECB via Frankfurter
// (fallback, close-only → synthetic OHLC flagged as lower quality).
// Results are cached in D1 so the free tier is not hammered.
// ---------------------------------------------------------------------------
const YAHOO_SYMBOL = {
  USDJPY: 'JPY=X', EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDCAD: 'USDCAD=X', GOLD: 'GC=F',
  USDCHF: 'USDCHF=X', AUDUSD: 'AUDUSD=X', NZDUSD: 'NZDUSD=X', EURJPY: 'EURJPY=X', GBPJPY: 'GBPJPY=X',
  AUDJPY: 'AUDJPY=X', CADJPY: 'CADJPY=X', CHFJPY: 'CHFJPY=X', NZDJPY: 'NZDJPY=X', EURGBP: 'EURGBP=X',
  EURCHF: 'EURCHF=X', EURAUD: 'EURAUD=X', GBPCHF: 'GBPCHF=X', USDMXN: 'USDMXN=X', XAGUSD: 'SI=F',
};

// quote通貨 → 円にするための近道。USD建ての通貨（AUD/NZD/EUR/GBP）は掛け、USDが基準の通貨（CAD/CHF/MXN）は割る。
const JPY_PER_QUOTE = {
  EUR: { symbol: 'EURUSD', mul: true }, GBP: { symbol: 'GBPUSD', mul: true },
  AUD: { symbol: 'AUDUSD', mul: true }, NZD: { symbol: 'NZDUSD', mul: true },
  CAD: { symbol: 'USDCAD', mul: false }, CHF: { symbol: 'USDCHF', mul: false },
  MXN: { symbol: 'USDMXN', mul: false },
};

export async function fetchMarketData(store, symbol, { days = 1500, force = false } = {}) {
  const cacheKey = `md:${symbol}:${days}`;
  if (!force) {
    const cached = await store.first(`SELECT * FROM settings WHERE key=?`, cacheKey);
    if (cached) {
      const parsed = safeJson(cached.value, null);
      const ageH = parsed?.fetchedAt ? (Date.now() - new Date(parsed.fetchedAt).getTime()) / 3600e3 : 1e9;
      if (parsed?.bars?.length && ageH < 12) return { ...parsed, cached: true };
    }
  }

  let bars = [];
  let source = null;
  let repairedOhlc = 0;

  // 1) Yahoo Finance chart API (free, no key)
  try {
    const r = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_SYMBOL[symbol] || symbol)}?interval=1d&range=${Math.min(20, Math.ceil(days / 252) + 1)}y`, 20000, { 'user-agent': 'Mozilla/5.0 (compatible; WealthAgent/1.0)' });
    if (r.ok) {
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      const ts = res?.timestamp || [];
      const q = res?.indicators?.quote?.[0] || {};
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i]; const h = q.high?.[i]; const l = q.low?.[i]; const c = q.close?.[i];
        if (![o, h, l, c].every((v) => typeof v === 'number' && isFinite(v))) continue;
        out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), open: o, high: h, low: l, close: c });
      }
      if (out.length > 100) { bars = out.slice(-days); source = 'yahoo_finance_daily_ohlc'; }
      // 無料データのOHLC不整合（高値が終値より低い等）を修復する。
      // 放置すると「安値に触れた」判定が誤って成立し、損切りが実際より多く刺さる。
      repairedOhlc = 0;
      for (const b of bars) {
        const hi = Math.max(b.high, b.open, b.close);
        const lo = Math.min(b.low, b.open, b.close);
        if (hi !== b.high || lo !== b.low) { b.high = hi; b.low = lo; repairedOhlc++; }
      }
    }
  } catch { /* fall through */ }

  // 2) Frankfurter / ECB (close-only fallback)
  if (!bars.length) {
    try {
      const base = symbol.slice(0, 3); const quote = symbol.slice(3);
      const from = new Date(Date.now() - days * 1.5 * 86400e3).toISOString().slice(0, 10);
      const r = await fetchWithTimeout(`https://api.frankfurter.app/${from}..?from=${base}&to=${quote}`, 20000);
      if (r.ok) {
        const d = await r.json();
        const entries = Object.entries(d.rates || {}).sort(([a], [b]) => a.localeCompare(b));
        bars = entries.map(([date, v], i) => ({
          date, open: i === 0 ? v[quote] : entries[i - 1][1][quote],
          high: Math.max(v[quote], i === 0 ? v[quote] : entries[i - 1][1][quote]) * 1.0005,
          low: Math.min(v[quote], i === 0 ? v[quote] : entries[i - 1][1][quote]) * 0.9995,
          close: v[quote],
        })).slice(-days);
        if (bars.length > 100) source = 'ecb_frankfurter_daily_close_synthetic_ohlc';
      }
    } catch { /* fall through */ }
  }

  const payload = { symbol, source, bars, fetchedAt: nowIso(), repairedOhlc,
    quality: (source?.startsWith('yahoo') ? 'high (real OHLC)' : 'medium (close-only, synthetic H/L)')
      + (repairedOhlc ? ` / OHLC不整合を${repairedOhlc}本修復（無料データの既知の癖）` : '') };
  if (bars.length) {
    await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      cacheKey, j(payload), nowIso());
  }
  return { ...payload, cached: false };
}

/**
 * 円換算器 — quote通貨建ての損益を円にする。
 *   JPY建て → 換算不要（1）
 *   USD建て → USDJPY の終値
 *   CAD建て → USDJPY / USDCAD
 * レートは決済日の終値（過去のデータのみ）。取れなければ 1 を返し、利用側で「換算できていない」と分かる形にする。
 * D1にキャッシュ済みの市場データを使うので、追加の通信は発生しない（原価0）。
 */
export async function buildCurrencyConverter(store, symbol) {
  const meta = PAIRS[symbol] || PAIRS.USDJPY;
  if (meta.quote === 'JPY') return { quote: 'JPY', rateAt: () => 1, source: 'not_needed', note: '円建て通貨ペア。換算は不要。' };
  const resolver = (bars) => {
    const rows = (bars || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return (dateISO) => {
      const d = String(dateISO || '');
      let lo = 0; let hi = rows.length - 1; let found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (String(rows[mid].date) <= d) { found = rows[mid].close; lo = mid + 1; } else hi = mid - 1;
      }
      return found ?? (rows.length ? rows[0].close : 1);
    };
  };
  try {
    const jpy = await fetchMarketData(store, 'USDJPY', { days: 2600 });
    const usdjpy = resolver(jpy.bars);
    if (meta.quote === 'USD') return { quote: 'USD', rateAt: usdjpy, source: 'yahoo_usdjpy_close', note: 'USD建ての損益を決済日のUSDJPY終値で円換算。' };
    const via = JPY_PER_QUOTE[meta.quote];
    if (via) {
      // 例: AUD建て → JPY per AUD = AUDUSD × USDJPY ／ CHF建て → JPY per CHF = USDJPY ÷ USDCHF
      const other = await fetchMarketData(store, via.symbol, { days: 2600 });
      const rate = resolver(other.bars);
      return {
        quote: meta.quote,
        rateAt: (d) => { const a = usdjpy(d) || 0; const b = rate(d) || 0; if (!(a > 0) || !(b > 0)) return 1; return via.mul ? a * b : a / b; },
        source: `yahoo_usdjpy_${via.mul ? 'times' : 'over'}_${via.symbol.toLowerCase()}_close`,
        note: `${meta.quote}建ての損益を USDJPY と ${via.symbol} の終値で円換算（決済日ベース）。`,
      };
    }
    return { quote: meta.quote, rateAt: usdjpy, source: 'yahoo_usdjpy_close', note: `${meta.quote}建てをUSDJPY終値で近似換算。` };
  } catch (e) {
    return { quote: meta.quote || '?', rateAt: () => 1, source: 'fallback_1', note: `換算レートを取得できず1で計算（誤差あり）: ${e.message}` };
  }
}

async function fetchWithTimeout(url, ms, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { headers, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// Hypothesis generation
// ---------------------------------------------------------------------------
const IDEA_CATALOG = [
  { key: 'ema_cross', label: 'EMAクロス + 長期トレンドフィルタ', why: 'トレンドフォローの基本形。長期EMAで方向を絞り、ダマシを減らす。' },
  { key: 'rsi_meanrev', label: 'RSI平均回帰', why: 'レンジ相場で過熱の反動を取る。トレンド相場では機能しにくい。' },
  { key: 'bollinger_fade', label: 'ボリンジャー逆張り', why: '標準偏差からの乖離を平均回帰で取る。ボラ拡大局面は危険。' },
  { key: 'donchian_breakout', label: 'ドンチャン・ブレイクアウト', why: '高値/安値更新でトレンド初動を捉える。レンジでは往復ビンタ。' },
];

export async function generateStrategy({ store, router, character, symbol = 'USDJPY', seedIdeas = null, avoid = [] }) {
  const prior = await store.all(`SELECT * FROM fx_strategies WHERE symbol=? ORDER BY version DESC LIMIT 20`, symbol);
  const triedKeys = prior.map((p) => safeJson(p.params_json, {})?.strategyKey).filter(Boolean);
  const avoidSet = new Set([...avoid, ...triedKeys]);

  let chosen = null; let hypothesis = null;
  const available = IDEA_CATALOG.filter((i) => !avoidSet.has(i.key) || seedIdeas?.includes(i.key));
  const pool = available.length ? available : IDEA_CATALOG;

  if (router.availableProviders().length) {
    const r = await router.complete({
      role: 'executor',
      system: 'あなたは定量的なFXリサーチャーです。非リペイントの原則（確定バーのみで判定、翌バー始値で約定、未来参照禁止）を厳守した仮説のみを提示します。',
      user: `銘柄: ${symbol}
既に試した戦略キー: ${triedKeys.join(', ') || 'なし'}
避けるべき手法: ${avoid.join(', ') || 'なし'}
利用可能な戦略エンジン: ${IDEA_CATALOG.map((i) => i.key).join(', ')}

次に検証すべき仮説を1つ選び、なぜ今それを試すのかを述べてください。
JSONのみ: {"strategyKey":"...","hypothesis":"...","params":{},"expectedEdge":"..."}`,
      json: true, schema: ['strategyKey', 'hypothesis', 'params', 'expectedEdge'], maxTokens: 700, temperature: 0.6,
    });
    const p = r.json;
    if (p?.strategyKey && STRATEGIES[p.strategyKey]) {
      chosen = IDEA_CATALOG.find((i) => i.key === p.strategyKey) || p;
      hypothesis = p.hypothesis || `LLM仮説: ${p.strategyKey}`;
    }
  }

  if (!chosen) {
    // Deterministic selection: least-recently-tried strategy, weighted by persona.
    const counts = {};
    for (const k of triedKeys) counts[k] = (counts[k] || 0) + 1;
    pool.sort((a, b) => (counts[a.key] || 0) - (counts[b.key] || 0));
    chosen = pool[0];
    hypothesis = `${chosen.why} 直近の試行回数が最も少ない手法として選択（人格: 慎重さ${character?.caution ?? 60}/創造性${character?.creativity ?? 60}）。`;
  }

  const params = { ...STRATEGIES[chosen.key].defaultParams, symbol, ...(seedIdeas ? {} : {}) };
  const version = (prior.filter((p) => safeJson(p.params_json, {})?.strategyKey === chosen.key).length || 0) + 1;
  const pineVersion = (character?.caution ?? 60) > 70 ? 'v6' : 'v6';
  const pine = generatePine(chosen.key, params, { version: pineVersion, symbol });
  const lint = lintPine(pine);

  const row = {
    id: newId('fxs'),
    name: `${chosen.label} (${symbol})`,
    symbol, version,
    hypothesis,
    params_json: j({ ...params, strategyKey: chosen.key, label: chosen.label }),
    pine_code: pine, pine_version: pineVersion,
    non_repaint: lint.nonRepaint ? 1 : 0, lint_json: j(lint),
    status: lint.nonRepaint ? 'draft' : 'rejected',
    created_at: nowIso(), updated_at: nowIso(),
  };
  await store.insert('fx_strategies', row);
  return { ...row, params, lint };
}

// ---------------------------------------------------------------------------
// Backtest a persisted strategy with full validation
// ---------------------------------------------------------------------------
export async function runBacktestForStrategy(store, { strategyId, symbol, days = 1500, costModel = null, overrides = null }) {
  const strat = strategyId
    ? await store.get('fx_strategies', strategyId)
    : (await store.first(`SELECT * FROM fx_strategies ORDER BY created_at DESC LIMIT 1`));
  if (!strat) return { ok: false, error: 'no_strategy', summary: '戦略が存在しません。先に仮説を生成してください。' };

  const params = { ...safeJson(strat.params_json, {}), ...(overrides || {}) };
  const sym = symbol || strat.symbol || 'USDJPY';
  const md = await fetchMarketData(store, sym, { days });
  if (md.bars.length < 250) {
    return { ok: false, error: 'insufficient_market_data', summary: `${sym} のデータが不足（${md.bars.length}本）`, data: { symbol: sym, bars: md.bars.length } };
  }

  const cost = { ...DEFAULT_COST_MODEL, ...(costModel || {}) };
  const bt = backtest(md.bars, { strategyKey: params.strategyKey, params, cost });
  const wf = walkForward(md.bars, { strategyKey: params.strategyKey, params, cost }, 4);
  const ol = overfitCheck(md.bars, { strategyKey: params.strategyKey, params }, cost);
  const losers = analyzeLosers(bt.trades);
  const robust = orderRobustness(bt.trades, 200, strat.id);

  const m = bt.metrics;
  const reasons = [];
  let pass = true;
  if ((m.trades || 0) < 30) { pass = false; reasons.push(`取引回数が少なすぎる (${m.trades})`); }
  if (m.profitFactor !== null && m.profitFactor < 1.15) { pass = false; reasons.push(`プロフィットファクター不足 (${m.profitFactor} < 1.15)`); }
  if (m.expectancy <= 0) { pass = false; reasons.push('期待値がプラスでない'); }
  if (!wf.consistent) { pass = false; reasons.push(`ウォークフォワード不安定 (${wf.netPositiveFolds}/${wf.totalFolds} フォルダでプラス)`); }
  if (ol.verdict === 'overfit_high') { pass = false; reasons.push('過剰最適化の疑いが高い'); }
  if (robust.probabilityNetNegative > 15) { pass = false; reasons.push(`取引順序への依存が高い (${robust.probabilityNetNegative}% で赤字)`); }

  const id = newId('fxb');
  await store.insert('fx_backtests', {
    id, strategy_id: strat.id, symbol: sym, timeframe: '1d',
    data_source: md.source, date_from: md.bars[0].date, date_to: md.bars[md.bars.length - 1].date,
    bars: md.bars.length,
    metrics_json: j({ ...m, dataQuality: md.quality }), equity_json: j(bt.equity),
    trades_json: j(bt.trades.slice(-400)),
    walkforward_json: j(wf), overfit_json: j(ol), cost_model_json: j(cost),
    pass: pass ? 1 : 0,
    notes: `${md.quality} / 損失分析仮説: ${losers.hypotheses.join(' | ')}`,
    created_at: nowIso(),
  });
  await store.run(`UPDATE fx_strategies SET status=?, updated_at=? WHERE id=?`, pass ? 'tested' : 'rejected', nowIso(), strat.id);

  return {
    ok: true, strategy: strat, symbol: sym, bars: md.bars.length, backtestId: id, cost,
    result: { metrics: m, trades: bt.trades, equity: bt.equity, walkforward: wf, overfit: ol, losers, robustness: robust, pass, reasons },
    summary: `${strat.name} ${sym}`,
  };
}

/**
 * Improvement loop: take the worst-performing aspect, propose a parameter
 * change, re-test. Returns the new strategy version.
 */
export async function improveStrategy(store, { strategyId, router, character }) {
  const prev = strategyId
    ? await store.get('fx_strategies', strategyId)
    : await store.first(`SELECT * FROM fx_strategies ORDER BY created_at DESC LIMIT 1`);
  if (!prev) return { ok: false, error: 'strategy_not_found' };
  const bt = await store.first(`SELECT * FROM fx_backtests WHERE strategy_id=? ORDER BY created_at DESC LIMIT 1`, strategyId);
  const m = safeJson(bt?.metrics_json, {}) || {};
  const losers = analyzeLosers(safeJson(bt?.trades_json, []) || []);
  const params = safeJson(prev.params_json, {}) || {};
  const cost = safeJson(bt?.cost_model_json, DEFAULT_COST_MODEL);

  const trials = [];
  for (const hyp of losers.hypotheses) {
    const variants = proposeVariants(params, hyp);
    for (const v of variants) {
      const md = await fetchMarketData(store, prev.symbol, { days: 1500 });
      const r = backtest(md.bars, { strategyKey: params.strategyKey, params: v, cost });
      trials.push({ params: v, hypothesis: hyp, metrics: r.metrics });
    }
  }
  trials.sort((a, b) => (b.metrics.netProfitJPY || 0) - (a.metrics.netProfitJPY || 0));
  const best = trials[0];
  if (!best) return { ok: false, error: 'no_variants' };

  const currentNet = m.netProfitJPY ?? 0;
  const improved = (best.metrics.netProfitJPY || 0) > currentNet;

  const pine = generatePine(params.strategyKey, best.params, { version: prev.pine_version, symbol: prev.symbol });
  const lint = lintPine(pine);
  const newId_ = newId('fxs');
  const row = {
    id: newId_, name: `${prev.name.replace(/ v\d+$/, '')} v${(prev.version || 1) + 1}`,
    symbol: prev.symbol, version: (prev.version || 1) + 1,
    hypothesis: `${prev.hypothesis}\n→ 改善: ${best.hypothesis} を反映（PF ${m.profitFactor ?? 'n/a'} → ${best.metrics.profitFactor ?? 'n/a'}）`,
    params_json: j(best.params), pine_code: pine, pine_version: prev.pine_version,
    non_repaint: lint.nonRepaint ? 1 : 0, lint_json: j(lint),
    status: lint.nonRepaint && improved ? 'draft' : 'rejected',
    created_at: nowIso(), updated_at: nowIso(),
  };
  await store.insert('fx_strategies', row);
  await store.run(`UPDATE fx_backtests SET notes = notes || ' / improved_to=' || ? WHERE id=?`, newId_, bt?.id || '');

  return {
    ok: true, improved, newStrategyId: newId_, previous: { net: currentNet, pf: m.profitFactor },
    best: { params: best.params, net: best.metrics.netProfitJPY, pf: best.metrics.profitFactor, hypothesis: best.hypothesis },
    trials: trials.length,
    summary: improved
      ? `改善版 v${row.version} を生成: 純益 ${currentNet} → ${best.metrics.netProfitJPY} JPY（仮説: ${best.hypothesis}）`
      : `改善案は元の成績を上回りませんでした（${trials.length}通りの検証）。手法そのものの見直しが必要です。`,
  };
}

function proposeVariants(params, hypothesis) {
  const v = [];
  const base = { ...params };
  if (/ストップ|損切り|ATR倍率/.test(hypothesis)) {
    for (const mult of [1.2, 1.5, 2.0, 2.5, 3.0, 4.0]) v.push({ ...base, atrStopMult: mult });
  }
  if (/ショート/.test(hypothesis)) v.push({ ...base, allowShort: false });
  if (/エントリー条件|絞る|フィルタ/.test(hypothesis)) {
    for (const fast of [8, 12, 21, 34]) v.push({ ...base, fast: Math.min(fast, (base.slow || 48) - 5) });
    for (const tf of [100, 200, 300]) v.push({ ...base, trendFilter: tf });
  }
  if (/時間足|ノイズ/.test(hypothesis)) {
    for (const period of [10, 14, 21, 30]) v.push({ ...base, period });
  }
  if (/方向性|トレンドフォロー|平均回帰/.test(hypothesis)) {
    v.push({ ...base, oversold: 25, overbought: 75 });
    v.push({ ...base, entry: (base.entry || 55) + 20 });
  }
  if (!v.length) {
    for (const mult of [1.5, 2.0, 2.5, 3.0]) v.push({ ...base, atrStopMult: mult });
    v.push({ ...base, allowShort: false });
  }
  return v.filter(validParams);
}

function validParams(p) {
  if (p.fast && p.slow && p.fast >= p.slow) return false;
  if (p.oversold && p.exitLevel && p.oversold >= p.exitLevel - 5) return false;
  if (p.oversold && (p.oversold <= 5 || p.oversold >= 45)) return false;
  return true;
}

export { STRATEGIES, IDEA_CATALOG };
