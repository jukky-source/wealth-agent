// propReport.js — 実際の市場データと戦略の損益列を組み立て、prop.js の計器に流す統合役。
// Cloudflare Worker 上で走らせる（サンドボックスでFXのバックテストは回さない運用に合わせる）。

import { fetchMarketData, buildCurrencyConverter, SUPPORTED_SYMBOLS } from './fx.js';
import { backtest, STRATEGIES } from './backtest.js';
import { safeJson, round } from '../util.js';
import {
  PROP_VERSION, PROP_FIRMS, PROP_ASSUMPTIONS,
  dailyReturns, ensembleReturns, propSweep, ownCapitalOutcome, marginCheck, quantile, propHelp,
} from './prop.js';

export { propHelp };

function pick(list, n) { return (list || []).slice(0, n); }

// 戦略の選び方: 明示指定 > 実測の fitness 上位 > 既定の顔ぶれ。
async function pickStrategies(store, requested) {
  if (requested && requested.length) return requested.filter((k) => STRATEGIES[k]).slice(0, 6);
  const out = [];
  try {
    const rows = await store.all('SELECT * FROM fx_experiments ORDER BY fitness DESC LIMIT 300');
    for (const r of rows || []) {
      const k = r.strategy_key || r.strategyKey || r.strategy;
      if (k && STRATEGIES[k] && !out.includes(k)) out.push(k);
      if (out.length >= 3) break;
    }
  } catch { /* 表が無い環境でも既定で動く */ }
  const keys = Object.keys(STRATEGIES);
  for (const pref of ['ema_cross', 'donchian', 'rsi', 'bb', 'macd', 'breakout']) {
    if (out.length >= 3) break;
    const hit = keys.find((k) => k.includes(pref) && !out.includes(k));
    if (hit) out.push(hit);
  }
  for (const k of keys) { if (out.length >= 3) break; if (!out.includes(k)) out.push(k); }
  return out.slice(0, 3);
}

function seriesStats(rets = []) {
  if (!rets.length) return { n: 0 };
  const arr = rets.map((d) => d.r).filter((v) => isFinite(v));
  const abs = arr.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, arr.length - 1));
  return {
    n: arr.length,
    from: rets[0].date, to: rets[rets.length - 1].date,
    meanDailyPct: round(mean * 100, 3),
    sdDailyPct: round(sd * 100, 3),
    medianAbsDailyPct: round(quantile(abs, 0.5) * 100, 3),
    p95AbsDailyPct: round(quantile(abs, 0.95) * 100, 3),
    maxDailyLossPct: round(Math.min(...arr) * 100, 2),
    maxDailyGainPct: round(Math.max(...arr) * 100, 2),
    annSharpe: sd > 0 ? round((mean / sd) * Math.sqrt(252), 2) : null,
  };
}

export async function buildPropReport({ store, env, params = {} } = {}) {
  const symbols = String(params.symbols || 'USDJPY,EURUSD,GOLD,GBPJPY,EURJPY')
    .split(',').map((s) => s.trim().toUpperCase()).filter((s) => SUPPORTED_SYMBOLS.includes(s)).slice(0, 6);
  const trials = Math.max(60, Math.min(600, Number(params.trials || 250)));
  const scales = String(params.scales || '0.25,0.5,0.75,1')
    .split(',').map(Number).filter((v) => v > 0 && v <= 3).slice(0, 6);
  const days = Math.max(600, Math.min(2600, Number(params.days || 2600)));
  const strategies = await pickStrategies(store, params.strategies ? String(params.strategies).split(',') : null);

  // --- 実データ + 実バックテスト → 日次損益率を束ねる ---
  const members = [];
  const perMember = [];
  for (const symbol of symbols) {
    try {
      const md = await fetchMarketData(store, symbol, { days });
      const bars = md.bars || [];
      if (bars.length < 250) { perMember.push({ symbol, error: 'insufficient_bars', bars: bars.length }); continue; }
      const conv = await buildCurrencyConverter(store, symbol);
      for (const key of strategies) {
        try {
          const bt = backtest(bars, { strategyKey: key, params: {}, cost: { fx: conv } });
          const rets = dailyReturns(bt.equity);
          members.push({ symbol, strategy: key, returns: rets });
          perMember.push({
            symbol, strategy: key, bars: bars.length, source: md.source || null, cached: !!md.cached,
            trades: bt.metrics.trades, netPct: bt.metrics.netProfitPct,
            ddMtmPct: bt.metrics.maxDrawdownPctMtm, ruined: bt.metrics.ruined,
            stats: seriesStats(rets),
          });
        } catch (e) { perMember.push({ symbol, strategy: key, error: String((e && e.message) || e).slice(0, 120) }); }
      }
    } catch (e) { perMember.push({ symbol, error: String((e && e.message) || e).slice(0, 120) }); }
  }

  const ensemble = ensembleReturns(members);
  const ensStats = seriesStats(ensemble);

  // 為替レート（自己資金タブの証拠金計算に使う）
  let usdJpy = 158;
  try {
    const j = await fetchMarketData(store, 'USDJPY', { days: 30 });
    const last = (j.bars || []).slice(-1)[0];
    if (last && last.close > 50) usdJpy = round(last.close, 3);
  } catch { /* 既定値のまま */ }

  // --- プロップファーム別 ---
  const firms = Object.values(PROP_FIRMS).map((plan) => {
    const accountSize = plan.currency === 'JPY' ? 10000000 : 100000;
    const rows = propSweep({ returns: ensemble, plan, scales, trials, accountSize, months: 12, seed: 'prop' });
    const best = rows.slice().sort((a, b) => (b.evIndex || 0) - (a.evIndex || 0))[0] || null;
    return {
      id: plan.id, firm: plan.firm, plan: plan.plan, verified: plan.verified, source: plan.source,
      currency: plan.currency, accountSize,
      feeJPY: plan.feeJPY ? plan.feeJPY[plan.accountSizes.indexOf(accountSize)] ?? null : null,
      feeUSD: plan.feeUSD ?? null,
      rules: {
        phases: plan.phases, dailyLossPct: plan.dailyLossPct, dailyBase: plan.dailyBase,
        maxLossPct: plan.maxLossPct, maxLossType: plan.maxLossType,
        splitPct: plan.splitPct, payoutCycleDays: plan.payoutCycleDays,
        firstPayoutNote: plan.firstPayoutNote, timeLimitDays: plan.timeLimitDays,
        maxLeverage: plan.maxLeverage || null,
      },
      rows,
      bestScale: best ? best.scale : null,
      bestEvIndexJPY: best ? (plan.currency === 'JPY' ? best.evIndex : Math.round((best.evIndex || 0) * usdJpy)) : null,
    };
  });

  // --- 自己資金（5万円以下）---
  const ownPlans = [
    { name: '堅実', riskMultiple: 1, targetMultiple: 2, ruinFloorPct: 30 },
    { name: '標準', riskMultiple: 2, targetMultiple: 3, ruinFloorPct: 20 },
    { name: '爆益', riskMultiple: 4, targetMultiple: 10, ruinFloorPct: 0 },
    { name: '超爆益', riskMultiple: 8, targetMultiple: 20, ruinFloorPct: 0 },
  ];
  const own = ownPlans.map((p) => ({
    ...p,
    ...ownCapitalOutcome(ensemble, { capitalJPY: 50000, months: 12, trials, seed: 'own', ...p }),
    units: 5000 * p.riskMultiple,
    margin: marginCheck({ capitalJPY: 50000, units: 5000 * p.riskMultiple, rate: usdJpy, leverage: 1000 }),
  }));

  return {
    version: PROP_VERSION,
    generatedAt: new Date().toISOString(),
    symbols, strategies, days, trials, scales,
    members: members.length,
    perMember,
    ensembleStats: ensStats,
    usdJpy,
    firms,
    ownCapital: { capitalJPY: 50000, leverageAssumed: 1000, plans: own },
    assumptions: PROP_ASSUMPTIONS,
    note: '過去データの再現。合格率はブートストラップによる推計であり、予測ではない。発注も資金移動もしない。',
  };
}
