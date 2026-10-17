// prop.js / propReport.js の検証。合成データのみ（外部通信なし）。
import assert from 'node:assert/strict';
import {
  PROP_FIRMS, dailyReturns, ensembleReturns, simulateChallenge, bootstrapPass,
  fundedPayouts, propSweep, ownCapitalOutcome, marginCheck, quantile, propHelp, PROP_VERSION,
} from '../src/income/prop.js';

let pass = 0; let fail = 0;
const t = (name, fn) => { try { fn(); console.log(`  ok  ${name}`); pass++; } catch (e) { console.log(`  NG  ${name}: ${e.message}`); fail++; } };

// 推計器は30本未満の標本では動かない（短すぎる標本で確率を語らないための門）。
// パターンを繰り返して十分な長さの系列を作る。
const R = (pattern, n = 60) => Array.from({ length: n }, (_, i) => ({
  date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, r: pattern[i % pattern.length],
}));

console.log(`prop tests (${PROP_VERSION})`);

t('ルールセットが揃っている', () => {
  const ids = Object.keys(PROP_FIRMS);
  assert.ok(ids.length >= 5, '少なくとも5プラン');
  for (const id of ids) {
    const p = PROP_FIRMS[id];
    assert.ok(p.firm && p.plan, `${id}: 名前`);
    assert.ok(p.phases.length >= 1, `${id}: フェーズ`);
    for (const ph of p.phases) assert.ok(ph.targetPct > 0 && ph.minDays >= 0, `${id}: 目標と最低日数`);
    assert.ok(p.dailyLossPct > 0 && p.maxLossPct > 0, `${id}: 損失制限`);
    assert.ok(['static', 'trailing'].includes(p.maxLossType), `${id}: 最大損失の型`);
    assert.ok(p.splitPct > 0 && p.splitPct <= 100, `${id}: 分配率`);
    assert.ok(p.source && p.source.startsWith('http'), `${id}: 出典`);
  }
});

t('dailyReturns: 前日比で率を取る（含み損込み）', () => {
  const eq = [{ date: 'a', equity: 100000, equityMtm: 100000 }, { date: 'b', equity: 101000, equityMtm: 102000 }, { date: 'c', equity: 99000, equityMtm: 101000 }];
  const out = dailyReturns(eq);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].r - 0.02) < 1e-9, 'equityMtm を使う');
  assert.ok(out[1].r < 0, '下落');
});

t('ensembleReturns: 日付で突き合わせて等加重', () => {
  const e = ensembleReturns([
    { returns: [{ date: 'a', r: 0.01 }, { date: 'b', r: -0.01 }] },
    { returns: [{ date: 'a', r: 0.03 }] },
  ]);
  assert.equal(e.length, 2);
  assert.ok(Math.abs(e[0].r - 0.02) < 1e-9, '2構成員の平均');
  assert.equal(e[0].n, 2);
  assert.equal(e[1].n, 1);
});

t('simulateChallenge: 目標に届けば合格・最低取引日数を守る', () => {
  const plan = PROP_FIRMS.fundednext_1step;
  const r = simulateChallenge(R([0.02, 0.02, 0.02, 0.02, 0.02, 0.02]), plan, { initialBalance: 100000 });
  assert.equal(r.passed, true);
  assert.ok(r.days >= 2, '最低2日');
});

t('simulateChallenge: 日次損失で失格', () => {
  const plan = PROP_FIRMS.fundednext_1step;   // 日次3%
  const r = simulateChallenge(R([0.001, -0.05, 0.02]), plan, { initialBalance: 100000 });
  assert.equal(r.passed, false);
  assert.equal(r.breach.type, 'daily_loss');
});

t('simulateChallenge: 最大損失（固定床）で失格', () => {
  const plan = PROP_FIRMS.fundednext_2step;   // 日次5% / 全体10%
  const r = simulateChallenge(R([-0.04, -0.04, -0.04]), plan, { initialBalance: 100000 });
  assert.equal(r.passed, false);
  assert.ok(['daily_loss', 'max_loss'].includes(r.breach.type));
});

t('simulateChallenge: Fintokei 速攻プロは60日で期限切れ', () => {
  const plan = PROP_FIRMS.fintokei_swift;
  const r = simulateChallenge(R([0.0005], 70), plan, { initialBalance: 1000000, maxHorizonDays: 120 });
  assert.equal(r.passed, false);
  assert.equal(r.breach.type, 'time_limit');
});

t('bootstrapPass: 建玉を落とす（scale↓）ほど合格率は上がる', () => {
  const rets = R([0.012, -0.006, 0.009, -0.004, 0.011, -0.005, 0.008, -0.003]);
  const plan = PROP_FIRMS.fundednext_2step;
  const hi = bootstrapPass(rets, plan, { trials: 120, seed: 'x', scale: 1 });
  const lo = bootstrapPass(rets, plan, { trials: 120, seed: 'x', scale: 0.25 });
  assert.ok(lo.passRatePct >= hi.passRatePct, `scale小の方が高い (${lo.passRatePct} >= ${hi.passRatePct})`);
  assert.ok(hi.passRatePct <= 100 && hi.passRatePct >= 0);
});

t('bootstrapPass: 増えすぎた損失列では合格0・失格理由が集計される', () => {
  const rets = R([-0.05, -0.05, -0.05, -0.05]);
  const out = bootstrapPass(rets, PROP_FIRMS.fundednext_2step, { trials: 50, seed: 'y', scale: 1 });
  assert.equal(out.passRatePct, 0);
  assert.ok(Object.keys(out.breaches).length > 0);
});

t('fundedPayouts: 勝ち続ける系列なら支払いが出る／生存率100%', () => {
  const rets = R([0.004, 0.003, 0.004, 0.002, 0.003, 0.004, 0.002, 0.003]);
  const out = fundedPayouts(rets, PROP_FIRMS.fundednext_2step, { accountSize: 100000, months: 12, trials: 40, seed: 'z', scale: 1 });
  assert.equal(out.survivorPct, 100);
  assert.ok(out.medianMonthly > 0, '月次報酬が正');
});

t('fundedPayouts: 荒い系列なら資金提供口座は壊れる', () => {
  const rets = R([-0.06, 0.05, -0.06, 0.05]);
  const out = fundedPayouts(rets, PROP_FIRMS.fundednext_1step, { accountSize: 100000, months: 12, trials: 40, seed: 'w', scale: 1 });
  assert.ok(out.survivorPct < 100, '生存率が下がる');
});

t('propSweep: 各行に合格率・日数・月次報酬・期待値指数が入る', () => {
  const rets = R([0.006, -0.004, 0.005, -0.003, 0.007, -0.002]);
  const rows = propSweep({ returns: rets, plan: PROP_FIRMS.e8one_6, scales: [0.5, 1], trials: 60, accountSize: 100000, seed: 's' });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(typeof r.passRatePct === 'number');
    assert.ok('medianDays' in r && 'monthlyMedian' in r && 'evIndex' in r);
  }
});

t('ownCapitalOutcome: リスク倍率を上げると破産率が上がる', () => {
  const rets = R([0.01, -0.012, 0.008, -0.015, 0.009, -0.01, 0.011, -0.014]);
  const safe = ownCapitalOutcome(rets, { capitalJPY: 50000, riskMultiple: 1, targetMultiple: 2, trials: 200, seed: 'o' });
  const wild = ownCapitalOutcome(rets, { capitalJPY: 50000, riskMultiple: 8, targetMultiple: 20, trials: 200, seed: 'o' });
  assert.ok(wild.ruinPct >= safe.ruinPct, `破産率 ${wild.ruinPct} >= ${safe.ruinPct}`);
  assert.equal(safe.capitalJPY, 50000);
  assert.ok(safe.reachPct + safe.ruinPct + safe.neitherPct > 99 && safe.reachPct + safe.ruinPct + safe.neitherPct < 101, '3区分の合計が100%');
});

t('ownCapitalOutcome: 目標到達で「到達」に数える', () => {
  const rets = R([0.03, 0.03, 0.03, 0.03]);
  const out = ownCapitalOutcome(rets, { capitalJPY: 50000, riskMultiple: 1, targetMultiple: 1, months: 3, trials: 30, seed: 'p' });
  assert.ok(out.reachPct > 90, `到達率が高い (${out.reachPct})`);
  assert.ok(out.medianReachMonths !== null);
});

t('marginCheck: 5万円・5千通貨・1:1000 は収まる', () => {
  const m = marginCheck({ capitalJPY: 50000, units: 5000, rate: 158, leverage: 1000 });
  assert.ok(Math.abs(m.marginJPY - 790) < 30, `必要証拠金 ≒790円 (${m.marginJPY})`);
  assert.equal(m.fits, true);
  assert.ok(m.marginCallDistancePips > 0);
});

t('quantile: 中央値と端', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.9), 5);
  assert.equal(quantile([], 0.5), null);
});

t('help に使い方と注意が出る', () => {
  const h = propHelp().join('\n');
  assert.ok(h.includes('FundedNext') && h.includes('E8') && h.includes('Fintokei'));
  assert.ok(h.includes('予測ではない'));
});

console.log(`prop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
