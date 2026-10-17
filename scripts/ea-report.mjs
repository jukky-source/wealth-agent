// EA検証ランナー（ローカル実行用）。
//   node scripts/ea-report.mjs
// 実データ（ECB Frankfurter の日足終値 / 合成H-L）で、全戦略 × 2プロファイル ×
// 全規約を回し、結果を dist/ea-results.json に書き出す。
// 数字はすべて実測（このスクリプトの出力）。推測値は入れない。
import fs from 'node:fs';
import path from 'node:path';
import { STRATEGIES, DEFAULT_COST_MODEL } from '../src/income/backtest.js';
import { simulateAccount, compareFirms, generateMQL5, PROP_FIRMS, PROFILES } from '../src/income/ea.js';

const DATA = '/tmp/fxdata.json';
if (!fs.existsSync(DATA)) { console.error(`missing ${DATA} — fetch data first`); process.exit(1); }
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

const out = { at: new Date().toISOString(), pairs: {}, raw: {}, prop: {}, aggressive: {}, mql5: {}, compare: {} };

for (const [pair, meta] of Object.entries(data)) {
  const bars = meta.bars;
  const base = { symbol: pair };
  const cost = { ...DEFAULT_COST_MODEL, initialCapitalJPY: 100000 };

  for (const key of Object.keys(STRATEGIES)) {
    // --- プロップ: 低リスク・非複利。規約は FTMO 2-Step と FundingPips 2-Step Standard ---
    for (const firmId of ['ftmo_2step', 'fundingpips_2step_standard']) {
      const r = simulateAccount(bars, { strategyKey: key, params: base, profile: 'prop', firm: firmId, cost });
      const k = `${pair}/${key}/${firmId}`;
      out.prop[k] = {
        verdict: r.verdict, trades: r.metrics.trades, netPct: r.metrics.netProfitPct,
        pf: r.metrics.profitFactor, maxDDPct: r.metrics.maxDrawdownPct,
        worstDayPct: r.rules?.worst_day_loss_pct, consistencyPct: r.consistencyPct,
        targetHit: r.targetHit, weeksToTarget: null,
        breaches: r.breaches.map((b) => `${b.type}@${b.date}(${b.pct}%)`),
        hypotheses: r.hypotheses,
      };
    }
    // --- 爆益: 高リスク・複利 -------------------------------------------------
    const agg = simulateAccount(bars, { strategyKey: key, params: base, profile: 'aggressive', firm: null, cost });
    const eq = agg.equity.map((e) => e.equity);
    out.aggressive[`${pair}/${key}`] = {
      verdict: agg.verdict, trades: agg.metrics.trades,
      netPct: agg.metrics.netProfitPct, cagrPct: agg.metrics.cagrPct,
      pf: agg.metrics.profitFactor, maxDDPct: agg.metrics.maxDrawdownPct,
      finalEquity: agg.metrics.finalEquityJPY, years: agg.metrics.yearsCovered,
      multiple: agg.metrics.yearsCovered ? Number((agg.metrics.finalEquityJPY / 100000).toFixed(2)) : null,
      hardStop: agg.breaches.filter((b) => b.type === 'hard_stop').length,
      hypotheses: agg.hypotheses,
    };
  }

  // --- 規約の比較（ema_cross 固定で、どの規約なら通るか）---------------------
  out.compare[pair] = compareFirms(bars, { strategyKey: 'ema_cross', params: base, cost, profiles: ['prop', 'aggressive'] });

  // --- MQL5 書き出し ---------------------------------------------------------
  for (const [mode, profile, firm] of [['prop', 'prop', 'ftmo_2step'], ['aggressive', 'aggressive', null]]) {
    const g = generateMQL5('ema_cross', { symbol: pair }, { profile, firm });
    const dir = path.join('dist', 'ea');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, g.filename), g.code);
    out.mql5[`${pair}/${mode}`] = { filename: g.filename, lines: g.lines, mode: g.checks.mode, risk: g.checks.risk_per_trade_pct, missing: g.checks.required, nonRepaint: g.checks.non_repaint };
  }

  out.pairs[pair] = { source: meta.source, quality: meta.quality, bars: bars.length, from: bars[0].date, to: bars[bars.length - 1].date };
}

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/ea-results.json', JSON.stringify(out, null, 2));

// --- 要約を標準出力（レポートはこの数字だけを使う）--------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log('\n=== プロップ（低リスク・非複利）: 上位 ===');
const propRows = Object.entries(out.prop).map(([k, v]) => ({ k, ...v })).sort((a, b) => (b.netPct || 0) - (a.netPct || 0));
for (const r of propRows.slice(0, 12)) {
  console.log(`${pad(r.k, 52)} ${pad(r.verdict, 7)} net ${pad(r.netPct + '%', 9)} PF ${pad(r.pf, 7)} DD ${pad(r.maxDDPct + '%', 8)} worstDay ${pad((r.worstDayPct ?? '-') + '%', 8)} trades ${pad(r.trades, 5)} [${r.breaches.join(' ')}]`);
}
console.log('\n=== 爆益（高リスク・複利） ===');
for (const [k, v] of Object.entries(out.aggressive).sort((a, b) => (b[1].netPct || 0) - (a[1].netPct || 0))) {
  console.log(`${pad(k, 24)} ${pad(v.verdict, 8)} net ${pad(v.netPct + '%', 11)} final ¥${pad(v.finalEquity, 11)} PF ${pad(v.pf, 7)} DD ${pad(v.maxDDPct + '%', 8)} hardStop ${v.hardStop}`);
}
console.log('\n=== 規約比較（ema_cross） ===');
for (const [pair, c] of Object.entries(out.compare)) {
  console.log(`-- ${pair}: pass=${c.pass.join(',') || 'なし'}`);
  for (const r of c.rows) console.log(`   ${pad(r.firm, 30)} ${pad(r.profile, 11)} ${pad(r.verdict, 7)} net ${pad(r.netPct + '%', 9)} worstDay ${pad((r.worstDayPct ?? '-') + '%', 8)} ${r.breaches.join(',')}`);
}
console.log('\nwrote dist/ea-results.json and dist/ea/*.mq5');
