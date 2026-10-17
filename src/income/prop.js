// prop.js — プロップファームの選考ルールと、自己資金の少額運用（5万円以下）を、
//            実際の戦略の損益列に当てて評価する計器。
//
// ここでやること:
//   1) 各社のルール（利益目標・日次損失・最大損失・最低取引日数・報酬分配・支払い周期）を
//      実際の日次損益率（含み損込み）に当てて、合格率 / 合格までの日数 / 合格後の月あたり期待報酬を出す。
//   2) 自己資金5万円以下を海外FXで複利運用したときの、目標到達率と破産率を出す。
//
// 前提（誇張しないための明示）:
//   * 損益列は実際のバックテストの日次損益率。ブートストラップでブロック抽出して多数の経路を作る
//     （1本の経路を繰り返すだけにしない）。
//   * 建玉は口座残高に比例させる前提（＝同じリスク率で張る）。だから損益率をそのまま当てられる。
//   * そのため「リスク倍率（scale）」を 0.25〜1.0 で振ると、口座のルールに合わせて
//     建玉を落としたときの合格率が出る。ここが実務の分岐点。
//   * 含まないもの: スワップ、週末の窓、スプレッドの時間帯変動、約定拒否、手数料、税。
//   * 過去データの再現であって予測ではない。発注も資金移動もしない。

import { round } from '../util.js';

export const PROP_VERSION = 'prop-1.0';

// ---------------------------------------------------------------------------
// 各社のルールセット（verified: true は一次情報で確認した値）
// ---------------------------------------------------------------------------
export const PROP_FIRMS = {
  fundednext_2step: {
    id: 'fundednext_2step', firm: 'FundedNext', plan: 'Stellar 2-Step', verified: true,
    source: 'https://tradetanto.com/learn/fundednext-rules-a-complete-guide-for-cfd-traders',
    currency: 'USD', accountSizes: [6000, 15000, 25000, 50000, 100000, 200000],
    phases: [{ targetPct: 8, minDays: 5 }, { targetPct: 5, minDays: 5 }],
    dailyLossPct: 5, dailyBase: 'initial', maxLossPct: 10, maxLossType: 'static',
    splitPct: 80, payoutCycleDays: 14, firstPayoutNote: '資金提供後21日で初回、以降2週間ごと',
    timeLimitDays: null, feeUSD: null,
  },
  fundednext_1step: {
    id: 'fundednext_1step', firm: 'FundedNext', plan: 'Stellar 1-Step', verified: true,
    source: 'https://tradetanto.com/learn/fundednext-rules-a-complete-guide-for-cfd-traders',
    currency: 'USD', accountSizes: [6000, 15000, 25000, 50000, 100000, 200000],
    phases: [{ targetPct: 10, minDays: 2 }],
    dailyLossPct: 3, dailyBase: 'initial', maxLossPct: 6, maxLossType: 'static',
    splitPct: 80, payoutCycleDays: 14, firstPayoutNote: '資金提供後5営業日で初回',
    timeLimitDays: null, feeUSD: null,
  },
  e8one_6: {
    id: 'e8one_6', firm: 'E8 Markets', plan: 'E8 One（最大損失6%を選択）', verified: true,
    source: 'https://tradetanto.com/learn/e8-markets-rules',
    currency: 'USD', accountSizes: [5000, 10000, 25000, 50000, 100000, 200000, 400000, 500000],
    phases: [{ targetPct: 9, minDays: 0 }],
    dailyLossPct: 4, dailyBase: 'day_start_equity', maxLossPct: 6, maxLossType: 'trailing',
    splitPct: 80, payoutCycleDays: 0, firstPayoutNote: '随時請求（純益が日次許容の50%超から）',
    minPayoutPctOfDailyDd: 50, bestDayCapPct: 40, timeLimitDays: null, feeUSD: null,
  },
  e8one_10: {
    id: 'e8one_10', firm: 'E8 Markets', plan: 'E8 One（最大損失10%を選択）', verified: true,
    source: 'https://tradetanto.com/learn/e8-markets-rules',
    currency: 'USD', accountSizes: [5000, 10000, 25000, 50000, 100000, 200000, 400000, 500000],
    phases: [{ targetPct: 15, minDays: 0 }],
    dailyLossPct: 6.6, dailyBase: 'day_start_equity', maxLossPct: 10, maxLossType: 'trailing',
    splitPct: 80, payoutCycleDays: 0, firstPayoutNote: '随時請求（純益が日次許容の50%超から）',
    minPayoutPctOfDailyDd: 50, bestDayCapPct: 40, timeLimitDays: null, feeUSD: null,
  },
  fintokei_swift: {
    id: 'fintokei_swift', firm: 'Fintokei', plan: '速攻プロ（1ステップ）', verified: true,
    source: 'https://fx.suitablism.com/fintokei-swifttrader/',
    currency: 'JPY', accountSizes: [1000000, 2000000, 5000000, 10000000, 20000000, 35000000],
    phases: [{ targetPct: 6, minDays: 3 }],
    dailyLossPct: 2, dailyBase: 'day_start_equity', maxLossPct: 3, maxLossType: 'static',
    splitPct: 90, payoutCycleDays: 30, firstPayoutNote: '支払いごとに新たに+3%の利益が必要',
    payoutStepPct: 3, maxLeverage: 25, timeLimitDays: 60, feeJPY: [9800, 17800, 29800, 54800, 93800, 179800],
  },
  fintokei_protrader: {
    id: 'fintokei_protrader', firm: 'Fintokei', plan: 'プロトレーダー（2ステップ）', verified: false,
    source: 'https://www.fintokei.com/jp/protrader/',
    currency: 'JPY', accountSizes: [1000000, 2000000, 5000000, 10000000, 20000000, 35000000, 50000000],
    phases: [{ targetPct: 8, minDays: 3 }, { targetPct: 5, minDays: 3 }],
    dailyLossPct: 5, dailyBase: 'day_start_equity', maxLossPct: 10, maxLossType: 'static',
    splitPct: 80, payoutCycleDays: 30, firstPayoutNote: '要確認（公式の数値が画像のため二次情報）',
    timeLimitDays: null, feeJPY: null,
  },
};

export const PROP_ASSUMPTIONS = [
  '損益率は実際のバックテストの日次損益率（含み損込み）。建玉は口座残高に比例させる前提。',
  '日次損失の判定は日次終値ベース（ザラ場の最悪値は見ていない＝実際より甘い）。',
  'ブートストラップ（移動ブロック）で日次リターンを抽出し、多数の経路を作って合格率を出す。',
  '含まないもの: スワップ、週末の窓、スプレッドの時間帯変動、約定拒否、手数料、税。',
  '報酬は「合格後、資金提供口座で同じロジックを回したときの支払い合計」から月平均を出している。',
];

// ---------------------------------------------------------------------------
// 乱数（seed 固定で再現できる）
// ---------------------------------------------------------------------------
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a) {
  let x = a >>> 0;
  return function () {
    x = (x + 0x6D2B79F5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function quantile(arr, q) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// ---------------------------------------------------------------------------
// 損益列の組み立て
// ---------------------------------------------------------------------------
// バックテストの equity（equityMtm があればそちら）から日次損益率を取り出す。
export function dailyReturns(equity = []) {
  const out = [];
  if (!equity.length) return out;
  let prev = Number(equity[0].equityMtm ?? equity[0].equity);
  for (let i = 1; i < equity.length; i++) {
    const cur = Number(equity[i].equityMtm ?? equity[i].equity);
    if (!isFinite(prev) || !isFinite(cur) || prev <= 0) { prev = cur; continue; }
    out.push({ date: equity[i].date, r: (cur - prev) / prev });
    prev = cur;
  }
  return out;
}

// 複数（銘柄×戦略）の日次損益率を等加重で束ねる。日付で突き合わせ、その日に存在する構成員だけで平均する。
export function ensembleReturns(members = []) {
  if (!members.length) return [];
  const byDate = new Map();
  for (const m of members) {
    for (const d of m.returns || []) {
      if (!byDate.has(d.date)) byDate.set(d.date, []);
      byDate.get(d.date).push(d.r);
    }
  }
  const dates = [...byDate.keys()].sort();
  return dates.map((date) => {
    const arr = byDate.get(date);
    return { date, r: arr.reduce((s, v) => s + v, 0) / arr.length, n: arr.length };
  });
}

// ---------------------------------------------------------------------------
// 選考のシミュレーション（1経路）
// ---------------------------------------------------------------------------
export function simulateChallenge(returns, plan, { initialBalance = 100000, maxHorizonDays = 504 } = {}) {
  let idx = 0;
  let totalDays = 0;
  const phases = [];
  for (let ph = 0; ph < plan.phases.length; ph++) {
    const rule = plan.phases[ph];
    const target = initialBalance * (1 + rule.targetPct / 100);
    const floorStatic = initialBalance * (1 - plan.maxLossPct / 100);
    let bal = initialBalance; let peak = initialBalance;
    let tradingDays = 0; let days = 0;
    let passed = false; let breach = null;
    let worstDailyLossPct = 0; let worstDdPct = 0;

    for (; idx < returns.length; idx++) {
      const bar = returns[idx];
      days++;
      const dayStart = bal;
      const eq = dayStart * (1 + bar.r);
      const dayLoss = Math.max(0, dayStart - eq);
      const lossBase = plan.dailyBase === 'initial' ? initialBalance : dayStart;
      const carried = plan.dailyBase === 'initial' ? Math.max(0, dayStart - initialBalance) : 0;
      const allow = lossBase * (plan.dailyLossPct / 100) + carried;
      const floor = plan.maxLossType === 'trailing'
        ? Math.min(peak, initialBalance) - initialBalance * (plan.maxLossPct / 100)
        : floorStatic;

      if (bal > 0) worstDailyLossPct = Math.max(worstDailyLossPct, (dayLoss / bal) * 100);
      const ddPct = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
      worstDdPct = Math.max(worstDdPct, ddPct);

      if (dayLoss > allow) { breach = { type: 'daily_loss', phase: ph + 1, day: bar.date, pct: round((dayLoss / dayStart) * 100, 2) }; break; }
      if (eq < floor) { breach = { type: 'max_loss', phase: ph + 1, day: bar.date, pct: round(((initialBalance - eq) / initialBalance) * 100, 2) }; break; }
      peak = Math.max(peak, eq);
      bal = eq;
      if (Math.abs(bar.r) > 1e-12) tradingDays++;
      if (bal >= target && tradingDays >= (rule.minDays || 0)) { passed = true; break; }
      if (plan.timeLimitDays && days >= plan.timeLimitDays) { breach = { type: 'time_limit', phase: ph + 1, day: bar.date }; break; }
      if (days >= maxHorizonDays) { breach = { type: 'horizon', phase: ph + 1, day: bar.date }; break; }
    }
    if (!passed) {
      if (!breach) breach = { type: 'data_end', phase: ph + 1 };
      totalDays += days;
      return { passed: false, days: totalDays, exitProfitPct: 0, breach, phases, worstDailyLossPct: round(worstDailyLossPct, 2), worstDdPct: round(worstDdPct, 2) };
    }
    totalDays += days;
    phases.push({ phase: ph + 1, days, tradingDays, profitPct: rule.targetPct });
    idx++;                                  // 次フェーズは翌日から（合格の翌日にリセット）
    if (idx >= returns.length) break;
  }
  return { passed: true, days: totalDays, exitProfitPct: 0, breach: null, phases, worstDailyLossPct: null, worstDdPct: null };
}

// ---------------------------------------------------------------------------
// 合格率（ブートストラップ）
// ---------------------------------------------------------------------------
export function bootstrapPass(returns, plan, {
  trials = 400, blockDays = 5, maxHorizonDays = 252, seed = 'prop', scale = 1, initialBalance = 100000,
} = {}) {
  const r = (returns || []).map((d) => d.r * scale).filter((v) => isFinite(v));
  const out = { trials, passed: 0, passRatePct: 0, days: [], breaches: {}, scale, medianDays: null, p25Days: null, p75Days: null };
  if (r.length < 30) return out;
  const rnd = mulberry32(hashSeed(`${seed}|${plan.id}|${scale}`));
  const path = new Array(maxHorizonDays);
  for (let t = 0; t < trials; t++) {
    let filled = 0;
    while (filled < maxHorizonDays) {
      const start = Math.floor(rnd() * r.length);
      for (let k = 0; k < blockDays && filled < maxHorizonDays; k++) path[filled++] = { date: `b${filled}`, r: r[(start + k) % r.length] };
    }
    const res = simulateChallenge(path, plan, { initialBalance, maxHorizonDays });
    if (res.passed) { out.passed++; out.days.push(res.days); }
    else { const k = (res.breach && res.breach.type) || 'unknown'; out.breaches[k] = (out.breaches[k] || 0) + 1; }
  }
  out.passRatePct = round((out.passed / trials) * 100, 2);
  out.medianDays = out.days.length ? round(quantile(out.days, 0.5), 0) : null;
  out.p25Days = out.days.length ? round(quantile(out.days, 0.25), 0) : null;
  out.p75Days = out.days.length ? round(quantile(out.days, 0.75), 0) : null;
  return out;
}

// ---------------------------------------------------------------------------
// 資金提供口座（合格後）の報酬。同じロジックを回し続けたときの支払い合計。
// ---------------------------------------------------------------------------
export function fundedPayouts(returns, plan, {
  accountSize = 100000, months = 12, trials = 300, blockDays = 5, seed = 'prop', scale = 1,
} = {}) {
  const r = (returns || []).map((d) => d.r * scale).filter((v) => isFinite(v));
  const horizonDays = Math.round(months * 21);
  const rnd = mulberry32(hashSeed(`${seed}|funded|${plan.id}|${scale}`));
  const totals = []; const monthlies = []; let survived = 0;
  const cycleDays = plan.payoutCycleDays && plan.payoutCycleDays > 0 ? Math.max(1, Math.round(plan.payoutCycleDays * (21 / 30))) : 1;  // 随時請求は毎日判定
  if (r.length < 30) return { trials, medianTotal: null, medianMonthly: null, survivorPct: 0, p10: null, p90: null };
  for (let t = 0; t < trials; t++) {
    const path = new Array(horizonDays);
    let filled = 0;
    while (filled < horizonDays) {
      const start = Math.floor(rnd() * r.length);
      for (let k = 0; k < blockDays && filled < horizonDays; k++) path[filled++] = { date: `f${filled}`, r: r[(start + k) % r.length] };
    }
    let bal = accountSize; let peak = accountSize; let paid = 0; let cycleStart = accountSize; let ok = true;
    const floorStatic = accountSize * (1 - plan.maxLossPct / 100);
    for (let i = 0; i < path.length; i++) {
      const dayStart = bal;
      const eq = dayStart * (1 + path[i].r);
      const dayLoss = Math.max(0, dayStart - eq);
      const lossBase = plan.dailyBase === 'initial' ? accountSize : dayStart;
      const floor = plan.maxLossType === 'trailing'
        ? Math.min(peak, accountSize) - accountSize * (plan.maxLossPct / 100)
        : floorStatic;
      if (dayLoss > lossBase * (plan.dailyLossPct / 100) || eq < floor) { ok = false; break; }
      peak = Math.max(peak, eq); bal = eq;
      if ((i + 1) % cycleDays === 0) {
        const profit = bal - cycleStart;
        const need = plan.payoutStepPct ? accountSize * (plan.payoutStepPct / 100) : (plan.minPayoutPctOfDailyDd ? accountSize * (plan.dailyLossPct / 100) * (plan.minPayoutPctOfDailyDd / 100) : 0);
        if (profit > 0 && profit >= need) { paid += profit * (plan.splitPct / 100); cycleStart = bal; }
      }
    }
    if (ok) survived++;
    totals.push(paid); monthlies.push(paid / months);
  }
  return {
    trials, survivorPct: round((survived / trials) * 100, 1),
    medianTotal: round(quantile(totals, 0.5), 0),
    medianMonthly: round(quantile(monthlies, 0.5), 0),
    meanMonthly: round(monthlies.reduce((s, v) => s + v, 0) / monthlies.length, 0),
    p10Monthly: round(quantile(monthlies, 0.1), 0),
    p90Monthly: round(quantile(monthlies, 0.9), 0),
    months, scale,
  };
}

// 合格率 × 合格後の月次報酬（期待値の指数）。手数料は未取得なので含めない。
export function propSweep({ returns, plan, scales = [0.25, 0.5, 0.75, 1], trials = 300, accountSize = 100000, months = 12, seed = 'prop' }) {
  const rows = [];
  for (const scale of scales) {
    const pass = bootstrapPass(returns, plan, { trials, seed, scale, initialBalance: accountSize });
    const pay = fundedPayouts(returns, plan, { trials: Math.min(trials, 200), seed, scale, accountSize, months });
    rows.push({
      scale,
      passRatePct: pass.passRatePct,
      medianDays: pass.medianDays,
      p25Days: pass.p25Days, p75Days: pass.p75Days,
      breaches: pass.breaches,
      survivorPct: pay.survivorPct,
      monthlyMedian: pay.medianMonthly,
      monthlyP10: pay.p10Monthly, monthlyP90: pay.p90Monthly,
      evIndex: pass.passRatePct > 0 && pay.medianMonthly ? round((pass.passRatePct / 100) * pay.medianMonthly, 0) : 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 自己資金の少額運用（5万円以下）: 複利 + 高いリスク倍率
// ---------------------------------------------------------------------------
export const OWN_CAPITAL_DEFAULT = 50000;

// 損益率をそのまま複利で掛ける（建玉は残高比例）。
// riskMultiple は「基準ロジックの建玉に対する倍率」。目標到達率と破産率のトレードオフを見る。
export function ownCapitalOutcome(returns, {
  capitalJPY = OWN_CAPITAL_DEFAULT, riskMultiple = 1, targetMultiple = 3, months = 12,
  ruinFloorPct = 0, trials = 400, blockDays = 5, seed = 'own',
} = {}) {
  const r = (returns || []).map((d) => d.r * riskMultiple).filter((v) => isFinite(v));
  const horizonDays = Math.round(months * 21);
  const capital = Number(capitalJPY) || OWN_CAPITAL_DEFAULT;
  const floor = capital * (1 - ruinFloorPct / 100);
  const target = capital * (1 + targetMultiple);
  const out = {
    capitalJPY: capital, riskMultiple, targetMultiple, months, ruinFloorPct,
    reached: 0, ruined: 0, neither: 0, reachMonths: [], finals: [],
  };
  if (r.length < 30) return out;
  const rnd = mulberry32(hashSeed(`${seed}|${capital}|${riskMultiple}|${targetMultiple}`));
  const path = new Array(horizonDays);
  for (let t = 0; t < trials; t++) {
    let filled = 0;
    while (filled < horizonDays) {
      const start = Math.floor(rnd() * r.length);
      for (let k = 0; k < blockDays && filled < horizonDays; k++) path[filled++] = r[(start + k) % r.length];
    }
    let eq = capital; let done = false;
    for (let i = 0; i < horizonDays; i++) {
      eq *= (1 + path[i]);
      if (eq <= floor) { out.ruined++; done = true; break; }
      if (eq >= target) { out.reached++; out.reachMonths.push(i / 21); done = true; break; }
    }
    if (!done) out.neither++;
    out.finals.push(eq);
  }
  out.reachPct = round((out.reached / trials) * 100, 2);
  out.ruinPct = round((out.ruined / trials) * 100, 2);
  out.neitherPct = round((out.neither / trials) * 100, 2);
  out.medianReachMonths = out.reachMonths.length ? round(quantile(out.reachMonths, 0.5), 1) : null;
  out.medianFinalJPY = round(quantile(out.finals, 0.5), 0);
  out.p10FinalJPY = round(quantile(out.finals, 0.1), 0);
  out.p90FinalJPY = round(quantile(out.finals, 0.9), 0);
  out.medianMultiple = round((out.medianFinalJPY || 0) / capital, 2);
  return out;
}

// 証拠金の確認（海外FX。1:1000の業者がある／業者により無制限）。
export function marginCheck({ capitalJPY = OWN_CAPITAL_DEFAULT, units = 5000, rate = 158, leverage = 1000 } = {}) {
  const notionalJPY = units * rate;
  const marginJPY = notionalJPY / leverage;
  return {
    units, notionalJPY: round(notionalJPY, 0), leverage,
    marginJPY: round(marginJPY, 0),
    marginPctOfCapital: round((marginJPY / capitalJPY) * 100, 1),
    fits: marginJPY < capitalJPY * 0.5,
    marginCallDistancePips: round((capitalJPY - marginJPY) / (units / 10000 * 100), 0),
  };
}

export function propHelp() {
  return [
    'プロップファーム選考と自己資金運用の計器（prop.js）',
    `版: ${PROP_VERSION}`,
    '対応: FundedNext（Stellar 2-Step / 1-Step）、E8 Markets（E8 One 6% / 10%）、Fintokei（速攻プロ / プロトレーダー）',
    '使い方: POST /api/diag/prop?symbols=USDJPY,EURUSD,GOLD&trials=300',
    '  戦略は fitness 上位から自動選択（明示するなら strategies=ema_cross,...）',
    '出るもの: リスク倍率ごとの 合格率 / 合格までの日数 / 合格後の月次報酬 / 期待値指数、自己資金5万円の到達率と破産率',
    '注意: 過去データの再現であり予測ではない。手数料・スワップ・税は含まない。',
  ];
}
