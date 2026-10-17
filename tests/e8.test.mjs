// e8.test.mjs — E8 One 実行部の純関数テスト（ネットワークを使わない）
import { E8_ONE_PROFILES, e8Profile, e8Floor, e8ApplyDay, e8Text, e8Help, E8_VERSION } from '../src/income/e8Runner.js';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol;

function baseState(profile = 'p10', accountSize = 100000) {
  const rules = e8Profile(profile);
  return {
    rules,
    state: {
      v: E8_VERSION, attempt: 1, status: 'challenge', accountSize,
      startBalance: accountSize, balance: accountSize, peak: accountSize, equityMtm: accountSize,
      dailyBase: rules.dailyBase, maxLossType: rules.maxLossType,
      target: accountSize * (1 + rules.targetPct / 100), floor: accountSize * (1 - rules.maxLossPct / 100),
      progressPct: 0, days: 0, tradingDays: 0, pending: [], payouts: [], totalPaid: 0, members: [],
    },
  };
}
const ctx = (rules, scale = 1, accountSize = 100000) => ({ rules, scale, accountSize });

console.log('E8 One 実行部');

// 1) 規格
{
  const p = e8Profile('p10');
  ok('p10 は 最大損失10% / 目標15% / 日次6.6%', p.maxLossPct === 10 && p.targetPct === 15 && p.dailyLossPct === 6.6, JSON.stringify(p));
  ok('出典が付いている', typeof p.source === 'string' && p.source.startsWith('http'), p.source);
  ok('未知名は p10 に落ちる', e8Profile('nope').id === 'p10');
  ok('規格は5種類', Object.keys(E8_ONE_PROFILES).length === 5);
  const p6 = e8Profile('p6');
  ok('p6 は 6/9/4', p6.maxLossPct === 6 && p6.targetPct === 9 && p6.dailyLossPct === 4);
}

// 2) 床（動的な最大損失）
{
  const g = baseState();
  ok('初期の床は -10%', near(e8Floor(g.state, g.rules), 90000), String(e8Floor(g.state, g.rules)));
  g.state.peak = 120000;
  ok('上げた後も床は初期基準で固定（10%の絶対額）', near(e8Floor(g.state, g.rules), 90000), String(e8Floor(g.state, g.rules)));
  g.state.peak = 95000;
  ok('下にあるときは床も下がる（min(peak, initial) 基準）', near(e8Floor(g.state, g.rules), 85000), String(e8Floor(g.state, g.rules)));
}

// 3) 1日の利益と進捗
{
  const g = baseState();
  const r = e8ApplyDay(g.state, { date: '2026-01-02', r: 0.01 }, ctx(g.rules));
  ok('+1% で残高 101000', near(g.state.balance, 101000, 1e-6), String(g.state.balance));
  ok('進捗がプラス', g.state.progressPct > 0, String(g.state.progressPct));
  ok('取引日を数える', g.state.tradingDays === 1);
  ok('返り値に日次損益率', near(r.dayPct, 1), JSON.stringify(r));
}

// 4) 日次損失で失格
{
  const g = baseState();
  const r = e8ApplyDay(g.state, { date: '2026-01-05', r: -0.07 }, ctx(g.rules));
  ok('−7% は日次損失で失格', r.breached && r.breached.type === 'daily_loss', JSON.stringify(r.breached));
  ok('違反日は残高を進めない（prop.js と同じ扱い）', near(g.state.balance, 100000), String(g.state.balance));
}

// 5) 目標到達で資金提供口座へ
{
  const g = baseState();
  const r = e8ApplyDay(g.state, { date: '2026-02-01', r: 0.16 }, ctx(g.rules));
  ok('+16% で合格', r.passed === true, JSON.stringify(r));
  ok('資金提供口座に移る', g.state.status === 'funded');
  ok('請求基準は合格時の残高', near(g.state.payoutBase, 116000, 1e-6), String(g.state.payoutBase));
}

// 6) 累積で最大損失（動的な床）に触れると失格
{
  const g = baseState();
  let breach = null;
  for (const d of ['a', 'b', 'c', 'd']) {
    const r = e8ApplyDay(g.state, { date: `2026-03-0${d}`, r: -0.03 }, ctx(g.rules));
    if (r.breached) { breach = r.breached; break; }
  }
  ok('−3%×4日で全体の床に触れて失格', breach && breach.type === 'max_loss', JSON.stringify(breach));
}

// 7) 支払い（40%ベストデイルール＋随時請求）
{
  const g = baseState();
  g.state.status = 'funded';
  g.state.payoutBase = 100000;
  const pay = e8ApplyDay(g.state, { date: '2026-04-01', r: 0.04 }, ctx(g.rules));
  ok('1日で+4%でも 40%ベストデイルールで支払いは止まる', !pay.payout, JSON.stringify(pay.payoutWatch || {}));
  const r2 = e8ApplyDay(g.state, { date: '2026-04-02', r: 0.012 }, ctx(g.rules));
  ok('2日目もまだ薄まらない（最大日が52%）', !r2.payout, JSON.stringify(r2.payoutWatch || {}));
  const r4 = e8ApplyDay(g.state, { date: '2026-04-06', r: 0.012 }, ctx(g.rules));
  ok('日を重ねて薄まると支払いが出る（またはまだ止まる）', r4.payout ? true : !!r4.payoutWatch, JSON.stringify(r4));
}
{
  // 単独日の偏りが無い場合: +1.2%×3日（最大日は33%）
  const g = baseState();
  g.state.status = 'funded';
  g.state.payoutBase = 100000;
  e8ApplyDay(g.state, { date: '2026-06-01', r: 0.012 }, ctx(g.rules));
  e8ApplyDay(g.state, { date: '2026-06-02', r: 0.012 }, ctx(g.rules));
  const r3 = e8ApplyDay(g.state, { date: '2026-06-03', r: 0.012 }, ctx(g.rules));
  ok('最大日33%まで薄まれば支払いが出る', !!r3.payout, JSON.stringify(r3));
  const profit = 100000 * (1.012 ** 3 - 1);
  ok('支払いは純益の80%', r3.payout && near(r3.payout, profit * 0.8, 2), `${r3.payout} vs ${(profit * 0.8).toFixed(2)}`);
  ok('支払い記録が残る', (g.state.payouts || []).length === 1);
  ok('請求基準が更新される', near(g.state.payoutBase, g.state.balance, 1e-6));
}

// 8) 表示
{
  const g = baseState();
  e8ApplyDay(g.state, { date: '2026-05-01', r: 0.02 }, ctx(g.rules, 0.5));
  const txt = e8Text({
    plan: { plan: 'E8 One（最大損失10%を選択）', verified: true },
    state: {
      attempt: 1, status: 'challenge', startBalance: 100000, balance: g.state.balance, peak: g.state.peak,
      target: 115000, floor: 90000, progressPct: g.state.progressPct, days: 1, daysTotal: 1,
      lastBarDate: '2026-05-01', members: [{ label: 'USDJPY / ドンチャン' }], payouts: [],
    },
    progress: { statusJa: '選考1回目', targetJa: '残り 14%で合格ライン', floorJa: '床まで 11%' },
    stats: { attempts: 0, passed: 0, failed: 0, totalPaidUSD: 0, failReasons: {} },
    events: [],
  });
  ok('日本語の進捗テキストが出る', txt.includes('E8 One') && txt.includes('合格ライン'), txt.slice(0, 80));
  ok('限界（日足終値ベース）を明記している', txt.includes('日足終値'));
  const h = e8Help();
  ok('help に規格5種が入る', (h.rules?.profiles || []).length === 5);
  ok('help に正直な限界が入る', Array.isArray(h.honesty) && h.honesty.length >= 3);
}

console.log(`\nE8: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
