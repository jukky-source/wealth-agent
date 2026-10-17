// EA（自動売買）検証のテスト。
// ・プロップファームのルール判定（日次損失・最大損失・目標到達・整合性）
// ・複利（自己資金）モードの枚数設計
// ・MQL5 の書き出しが「実際にコンパイル可能な形」の必須要素を持つこと
// ・負け分析から改善仮説が出ること
import assert from 'node:assert/strict';
import {
  PROP_FIRMS, PROFILES, firmById, simulateAccount, generateMQL5, analyzeEA,
} from '../src/income/ea.js';
import { STRATEGIES } from '../src/income/backtest.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// --- 決定的な合成データ（外部通信なし。値動きが無いと取引が生まれないので波を入れる）---
function makeBars(n = 700, seed = 42) {
  let a = seed; const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  const bars = []; let price = 150;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 35) * 0.55;
    const ch = (rnd() - 0.5) * 1.4 + drift * 0.18;
    const open = price; const close = Math.max(40, open + ch);
    const high = Math.max(open, close) + rnd() * 0.6;
    const low = Math.min(open, close) - rnd() * 0.6;
    bars.push({ date: new Date(Date.UTC(2022, 0, 3 + i)).toISOString().slice(0, 10), open, high, low, close });
    price = close;
  }
  return bars;
}
const BARS = makeBars();

await t('台帳: プロップファームは検証済み／未確認を区別して持つ', () => {
  assert.ok(PROP_FIRMS.length >= 4, `firms=${PROP_FIRMS.length}`);
  for (const f of PROP_FIRMS) {
    assert.ok(f.id && f.label, 'id/label が必要');
    assert.ok(typeof f.max_daily_loss_pct === 'number', `${f.id}: 日次損失上限が数値`);
    assert.ok(typeof f.max_total_loss_pct === 'number', `${f.id}: 最大損失上限が数値`);
    assert.ok(typeof f.profit_target_pct === 'number', `${f.id}: 目標が数値`);
    assert.ok(f.source && f.source.startsWith('http'), `${f.id}: 出典URL`);
    assert.equal(typeof f.verified, 'boolean', `${f.id}: verified は真偽値`);
  }
  assert.ok(firmById(PROP_FIRMS[0].id));
  assert.equal(firmById('nope'), null);
});

await t('プロファイル: prop は小さく、aggressive は大きいリスク', () => {
  assert.ok(PROFILES.prop.riskPerTradePct > 0 && PROFILES.prop.riskPerTradePct <= 1.5,
    `prop risk=${PROFILES.prop.riskPerTradePct}`);
  assert.ok(PROFILES.aggressive.riskPerTradePct >= 2, `aggressive risk=${PROFILES.aggressive.riskPerTradePct}`);
  assert.ok(PROFILES.prop.riskPerTradePct < PROFILES.aggressive.riskPerTradePct);
  assert.equal(PROFILES.aggressive.compound, true, 'aggressive は複利');
});

await t('simulateAccount: 指標と日次記録を返す', () => {
  const r = simulateAccount(BARS, { strategyKey: 'ema_cross', params: { symbol: 'USDJPY' }, profile: 'prop', firm: PROP_FIRMS[0].id });
  assert.equal(r.ok, true);
  assert.ok(r.metrics.trades > 0, `trades=${r.metrics.trades}`);
  assert.ok(Array.isArray(r.equity) && r.equity.length > 100);
  assert.ok(Array.isArray(r.breaches));
  assert.ok(['pass', 'fail', 'breach'].includes(r.verdict), `verdict=${r.verdict}`);
  assert.ok(r.rules && typeof r.rules.max_daily_loss_pct === 'number');
  assert.ok(typeof r.assumptions === 'string' && r.assumptions.length > 20);
});

await t('simulateAccount: 日次損失の上限を破ったら breach に記録する', () => {
  const strict = { ...PROP_FIRMS[0], id: 'test_strict', max_daily_loss_pct: 0.5, max_total_loss_pct: 99, profit_target_pct: 99 };
  const r = simulateAccount(BARS, { strategyKey: 'ema_cross', params: { symbol: 'USDJPY' }, profile: 'aggressive', firm: strict });
  assert.ok(r.trades.length > 0, '取引が生まれていること');
  assert.ok(r.breaches.some((b) => b.type === 'daily_loss'),
    `breaches=${JSON.stringify(r.breaches.map((b) => b.type))}`);
  assert.equal(r.verdict, 'breach');
});

await t('simulateAccount: 非複利はリスク額が一定、複利は資金に連動する', () => {
  const fixed = simulateAccount(BARS, { strategyKey: 'ema_cross', params: { symbol: 'USDJPY' }, profile: { ...PROFILES.prop, compound: false }, firm: PROP_FIRMS[0].id });
  const risks = fixed.trades.map((x) => x.riskJPY);
  assert.ok(risks.length > 3, `trades=${risks.length}`);
  assert.equal(new Set(risks.map((r) => r.toFixed(2))).size, 1,
    `非複利なのにリスク額が揺れている: ${[...new Set(risks)].slice(0, 5)}`);
  const comp = simulateAccount(BARS, { strategyKey: 'ema_cross', params: { symbol: 'USDJPY' }, profile: { ...PROFILES.aggressive, compound: true }, firm: PROP_FIRMS[0].id });
  const crisks = comp.trades.map((x) => x.riskJPY);
  assert.ok(new Set(crisks.map((r) => r.toFixed(2))).size > 1, '複利なのにリスク額が一定');
});

await t('simulateAccount: レバレッジ上限を超えない', () => {
  const r = simulateAccount(BARS, { strategyKey: 'rsi_meanrev', params: { symbol: 'USDJPY' }, profile: 'aggressive', firm: PROP_FIRMS[0].id });
  const cap = PROFILES.aggressive.maxLeverage;
  for (const x of r.trades.slice(0, 50)) {
    const notional = x.units * x.entryPrice;
    assert.ok(notional <= cap * x.equityAtEntry * 1.02, `notional=${notional} cap=${cap * x.equityAtEntry}`);
  }
});

await t('MQL5: 必須要素を持つ（MT5 でコンパイルできる形）', () => {
  const g = generateMQL5('ema_cross', { symbol: 'USDJPY', fast: 12, slow: 48 }, { profile: 'prop', firm: PROP_FIRMS[0].id });
  const c = g.code;
  for (const needle of ['#property', 'OnInit', 'OnTick', 'OnDeinit', 'input double', 'input int', 'iATR', 'iMA', 'OrderSend', 'TRADE_ACTION_DEAL', 'DailyLoss', 'MaxDrawdown']) {
    assert.ok(c.includes(needle), `MQL5 に ${needle} がありません`);
  }
  assert.ok(g.filename.endsWith('.mq5'), g.filename);
  assert.ok(g.lines > 120, `lines=${g.lines}`);
  assert.ok(/new bar|NewBar|iTime/.test(c), '確定足のみで判定する記述（非リペイント）が必要');
});

await t('MQL5: プロップ用は目標と日次ストップを含む', () => {
  const g = generateMQL5('donchian_breakout', { symbol: 'USDJPY' }, { profile: 'prop', firm: PROP_FIRMS[0].id });
  assert.ok(/ProfitTarget/i.test(g.code), '目標到達で停止する記述が必要');
  assert.ok(/DailyLossLimit/i.test(g.code), '日次損失ガードが必要');
  assert.equal(g.checks.mode, 'prop');
  assert.ok(g.checks.rules.max_daily_loss_pct > 0);
});

await t('MQL5: 爆益用は複利と高リスクを含む', () => {
  const g = generateMQL5('ema_cross', { symbol: 'EURUSD' }, { profile: 'aggressive' });
  assert.equal(g.checks.mode, 'aggressive');
  assert.ok(g.checks.risk_per_trade_pct >= 2);
  assert.ok(/Compound/i.test(g.code) || /compound/i.test(g.code), '複利の記述が必要');
});

await t('analyzeEA: 改善仮説を返す（空にならない）', () => {
  const r = simulateAccount(BARS, { strategyKey: 'ema_cross', params: { symbol: 'USDJPY' }, profile: 'aggressive', firm: PROP_FIRMS[0].id });
  const a = analyzeEA({ result: r, firm: firmById(PROP_FIRMS[0].id), profile: PROFILES.aggressive });
  assert.ok(Array.isArray(a.hypotheses) && a.hypotheses.length >= 1, JSON.stringify(a.hypotheses));
  assert.ok(a.hypotheses.every((h) => typeof h === 'string' && h.length > 8));
});

await t('全戦略で破綻せず走る（4手法 × 2プロファイル）', () => {
  for (const k of Object.keys(STRATEGIES)) {
    for (const p of ['prop', 'aggressive']) {
      const r = simulateAccount(BARS, { strategyKey: k, params: { symbol: 'USDJPY' }, profile: p, firm: PROP_FIRMS[0].id });
      assert.equal(r.ok, true, `${k}/${p}`);
      assert.ok(Number.isFinite(r.metrics.finalEquityJPY), `${k}/${p} finalEquityJPY=${r.metrics.finalEquityJPY}`);
    }
  }
});

console.log(`\nEA tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
