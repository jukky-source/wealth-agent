// lab.js — バックテスト作業台（Forex Tester 相当の機能を、このエージェントの中で）
//
// ここが要点:
//   * 2つのモードを1つのエンジンで回す。
//       own = 自己資金モード（円建て・複利・撤退ライン・目標倍率の前線）
//       e8  = E8 One モード（選考の規則で合否・失格理由・支払いまで）
//   * 「試行錯誤」は探索として実行し、候補を D1 の fx_experiments に
//     tag='lab:own' / 'lab:e8' で積む。UI（/lab.html）はそこから順位表を作る。
//   * 原価0: データは無料の日足（Yahoo Finance / ECB）だけ。有料APIは呼ばない。
//   * 日足終値ベース。ザラ場の含み損・スワップ・週末窓・約定拒否は含まない（隠さず返す）。
//
// 既存の計器との関係:
//   backtest.js   … 約定・費用・破産判定のエンジン（これをそのまま使う）
//   grammar.js    … 論理空間（コア層＝既知ロジック×設定、合成層＝部品2つをAND/OR）
//   prop.js       … 選考の規則（simulateChallenge / bootstrapPass / fundedPayouts / 自己資金）
//   robust.js     … 曲線当てはめの検証11項目（deepValidate）
//   optimizer.js  … 有料バックテスター相当の進化探索（この作業台の「探索」はその軽量版）
//
// このファイルは「見るための作業台」であって、自律ループ（scheduler）からは labTick を呼ぶ。

import { nowIso, j, safeJson, round, clamp, seededRandom, id as newId } from '../util.js';
import { DEFAULT_COST_MODEL, STRATEGIES, backtest, walkForward, orderRobustness } from './backtest.js';
import { fetchMarketData, buildCurrencyConverter } from './fx.js';
import { deepValidate } from './robust.js';
import {
  SYMBOLS, TIMEFRAMES, FILTERS, EXITS, DIRECTIONS, FEATURES, OPS, ATOMS,
  basePresets, coreSize, ruleSize, materialize, describeLogic, exitParams, randomRule, atomText,
} from './grammar.js';
import { T, ensureLabTable } from './fxLab.js';
import {
  dailyReturns, simulateChallenge, bootstrapPass, fundedPayouts,
  ownCapitalOutcome, ownFrontier, marginCheck, quantile, OWN_CAPITAL_DEFAULT,
} from './prop.js';

export const LAB_VERSION = 'lab-1.0';
export const LAB_STATS_KEY = 'lab:stats';
export const LAB_BOARD_KEY = 'lab:board';
export const LAB_PROJECT_PREFIX = 'lab:project:';
export const LAB_MODES = ['e8', 'own'];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pct = (v, d = 2) => round(Number(v || 0), d);

// describeLogic は「行（文字列）」と「分解した部品（オブジェクト）」の両方を返しうる。
// 表示に使うのは行のほう。オブジェクトをそのまま返すと画面が [object Object] になる（実害が出た）。
export function specLabel(spec) {
  const d = describeLogic(spec);
  if (d && typeof d === 'object') return d.line || d.base || JSON.stringify(d);
  return String(d == null ? '' : d);
}

// ---------------------------------------------------------------------------
// 前提（誇張しないための線引き）。UIにもそのまま出す。
// ---------------------------------------------------------------------------
export const LAB_ASSUMPTIONS = [
  '約定は「確定したバーの終値で判断 → 翌バーの始値で約定」。未来の値は使わない（先読みなし）。',
  '費用はスプレッド＋スリッページ＋手数料を毎取引で控除。既定はスプレッド0.3pip・スリッページ0.2pip。',
  '同時に複数条件が成立した場合は不利側（損切り優先）で約定する。',
  '同時保有は1ポジション。建玉量は固定（自己資金モードはリスク倍率で増減）。',
  '破産判定は含み損込みの資金が床を割ったとき。床は初期資金10万円基準（自己資金モード）。',
  'E8 One モードでは破産判定を切る（選考は破産ではなく違反で終わるため）。',
  '含まれないもの: ザラ場の含み損、スワップ、週末の窓、スプレッドの時間帯変動、約定拒否、税。',
  'データは無料の日足OHLC（Yahoo Finance / ECB）。ティック精度ではない。',
];

// ---------------------------------------------------------------------------
// E8 One の規格（一次情報で確認した数字: 最大損失と目標は1.5倍、日次は損失の0.53倍）
//   p4  最大損失4%  目標6%   日次3%
//   p6  最大損失6%  目標9%   日次4%
//   p8  最大損失8%  目標12%  日次5.3%
//   p10 最大損失10% 目標15%  日次6.6%
//   p14 最大損失14% 目標21%  日次9.2%
// 全体の床は動的（軌跡が下にあるときだけ下がる）、最低取引日数なし、期限なし。
// 実行部（e8Runner.js）と同じ規則を使う。食い違ったら実行部側を正とする。
// ---------------------------------------------------------------------------
export const LAB_E8_PROFILES = {
  p4: { key: 'p4', label: 'E8 One 最大損失4%', maxLossPct: 4, targetPct: 6, dailyLossPct: 3 },
  p6: { key: 'p6', label: 'E8 One 最大損失6%', maxLossPct: 6, targetPct: 9, dailyLossPct: 4 },
  p8: { key: 'p8', label: 'E8 One 最大損失8%', maxLossPct: 8, targetPct: 12, dailyLossPct: 5.3 },
  p10: { key: 'p10', label: 'E8 One 最大損失10%', maxLossPct: 10, targetPct: 15, dailyLossPct: 6.6 },
  p14: { key: 'p14', label: 'E8 One 最大損失14%', maxLossPct: 14, targetPct: 21, dailyLossPct: 9.2 },
};

/** 実行部（e8Runner.js）の規格と突き合わせる。形が違っても壊れないようにキー名を探して重ねる。 */
export function overlayE8Profiles(profiles = null) {
  const src = profiles || LAB_E8_PROFILES;
  const vals = Array.isArray(src) ? src : Object.values(src || {});
  for (const key of Object.keys(LAB_E8_PROFILES)) {
    const base = LAB_E8_PROFILES[key];
    const hit = vals.find((v) => v && num(v.maxLossPct ?? v.max_loss_pct ?? v.maxLoss, undefined) === base.maxLossPct);
    if (!hit) continue;
    LAB_E8_PROFILES[key] = {
      ...base,
      label: hit.label || base.label,
      maxLossPct: num(hit.maxLossPct ?? hit.max_loss_pct, base.maxLossPct),
      targetPct: num(hit.targetPct ?? hit.target_pct ?? hit.profitTargetPct, base.targetPct),
      dailyLossPct: num(hit.dailyLossPct ?? hit.daily_loss_pct, base.dailyLossPct),
      minDays: num(hit.minDays ?? hit.min_trading_days, 0),
      timeLimitDays: hit.timeLimitDays ?? hit.time_limit_days ?? null,
      dailyBase: hit.dailyBase || hit.daily_base || 'initial',
    };
  }
  return LAB_E8_PROFILES;
}
export function e8ProfileOf(key) {
  const k = LAB_E8_PROFILES[key] ? key : 'p10';
  return LAB_E8_PROFILES[k];
}

/** 選考の規則を prop.js の plan の形にする（simulateChallenge / bootstrapPass がそのまま食える）。 */
export function labE8Plan(profileKey, settings = {}) {
  const p = e8ProfileOf(profileKey);
  return {
    id: `e8one:${p.key}`,
    firm: 'E8 Markets',
    plan: `E8 One（最大損失${p.maxLossPct}%を選択）`,
    phases: [{ targetPct: p.targetPct, minDays: p.minDays || 0 }],
    dailyLossPct: num(settings.dailyLossPct, p.dailyLossPct),
    dailyBase: settings.dailyBase === 'balance' ? 'balance' : (p.dailyBase || 'initial'),
    maxLossPct: num(settings.maxLossPct, p.maxLossPct),
    maxLossType: 'trailing',          // E8 One の全体の床は動的
    timeLimitDays: p.timeLimitDays ?? null,
    minDays: p.minDays || 0,
    payoutSharePct: num(settings.payoutSharePct, 80),
    minPayoutPctOfDailyDd: num(settings.minPayoutPctOfDailyDd, 50),
    bestDayLimitPct: num(settings.bestDayLimitPct, 40),
    accountSize: num(settings.accountSize, 100000),
  };
}

export const LAB_E8_PAY_RULES = {
  sharePct: 80,
  minPayoutPctOfDailyDd: 50,
  bestDayLimitPct: 40,
  note: '随時請求。純益が「日次許容損失の50%」を超えたら請求でき、支払いは純益の80%。'
    + '資金提供後は「最大の1日の利益 ≤ 純益の40%」も満たす必要がある（40%ベストデイルール）。',
};

// ---------------------------------------------------------------------------
// 費用モデル
// ---------------------------------------------------------------------------
export function labCost(base = DEFAULT_COST_MODEL, o = {}) {
  const c = { ...(base || {}) };
  if (o.spreadPips != null) c.spreadPips = num(o.spreadPips, c.spreadPips);
  if (o.slippagePips != null) c.slippagePips = num(o.slippagePips, c.slippagePips);
  if (o.commissionJPY != null) c.commissionJPY = num(o.commissionJPY, c.commissionJPY);
  if (o.initialCapitalJPY != null) c.initialCapitalJPY = num(o.initialCapitalJPY, c.initialCapitalJPY);
  if (o.units != null) c.units = num(o.units, c.units);
  const m = num(o.stressMult, 1);
  if (m !== 1 && m > 0) {
    c.spreadPips = num(c.spreadPips, 0) * m;
    c.slippagePips = num(c.slippagePips, 0) * m;
    c.commissionJPY = num(c.commissionJPY, 0) * m;
  }
  return c;
}

// ---------------------------------------------------------------------------
// 論理（spec）の組み立て — 手で作る（コア層）と、無作為・変異させる（合成層）
// ---------------------------------------------------------------------------
export function labSpec({
  symbol, tf = '1d', strategy, variant = 0, params = {}, filter = 'none', exit = 'balanced', dir = 'both',
} = {}) {
  const sym = SYMBOLS.includes(symbol) ? symbol : SYMBOLS[0];
  const presets = basePresets();
  const preset = presets.find((p) => p.key === strategy && Number(p.variant) === Number(variant))
    || presets.find((p) => p.key === strategy) || presets[0];
  return {
    v: 1,
    tier: 'core',
    symbol: sym,
    tf: TIMEFRAMES.some((t) => t.key === tf) ? tf : '1d',
    filter: FILTERS.some((f) => f.key === filter) ? filter : 'none',
    exit: EXITS.some((e) => e.key === exit) ? exit : 'balanced',
    dir: DIRECTIONS.some((d) => d.key === dir) ? dir : 'both',
    base: { kind: 'strategy', key: preset.key, variant: preset.variant, params: { ...preset.params, ...(params || {}) } },
  };
}

export function labRuleSpec(rnd, { symbol, feature = null, mutateFrom = null, tf = null, exit = null, dir = null, filter = null } = {}) {
  const sym = SYMBOLS.includes(symbol) ? symbol : SYMBOLS[0];
  const s = randomRule(rnd, [sym], { mutateFrom, features: feature ? [feature] : null });
  const out = { ...s };
  if (tf && TIMEFRAMES.some((t) => t.key === tf)) out.tf = tf;
  if (exit && EXITS.some((e) => e.key === exit)) out.exit = exit;
  if (dir && DIRECTIONS.some((d) => d.key === dir)) out.dir = dir;
  if (filter && FILTERS.some((f) => f.key === filter)) out.filter = filter;
  return out;
}

/** 行（UIの1行）から spec を作る。合成層は spec をそのまま受ける。 */
export function specFromRow(row, rnd) {
  if (row && row.spec && typeof row.spec === 'object') {
    const s = { ...row.spec };
    if (row.symbol && SYMBOLS.includes(row.symbol)) s.symbol = row.symbol;
    return s;
  }
  if (row && row.kind === 'rule') {
    return labRuleSpec(rnd, { symbol: row.symbol, feature: row.feature || null, tf: row.tf || null, exit: row.exit || null, dir: row.dir || null, filter: row.filter || null });
  }
  return labSpec(row || {});
}

// ---------------------------------------------------------------------------
// 1つの論理を走らせる
// ---------------------------------------------------------------------------
export function trimMetrics(m = {}) {
  const keys = [
    'trades', 'wins', 'losses', 'winRate', 'profitFactor', 'expectancy', 'netProfitJPY', 'netProfitPct',
    'avgWinJPY', 'avgLossJPY', 'maxDrawdownPct', 'maxDrawdownPctMtm', 'maxDrawdownJPY', 'sharpe', 'cagrPct',
    'barsTested', 'yearsCovered', 'finalEquityJPY', 'returnPerYearJPY', 'ruined', 'ruinDate', 'stoppedEarly',
  ];
  const out = {};
  for (const k of keys) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

export async function runMember({ store, spec, env = {}, ctx = {}, opts = {} }) {
  const sym = spec.symbol;
  if (!ctx.mdCache) ctx.mdCache = new Map();
  if (!ctx.fxCache) ctx.fxCache = new Map();
  const days = clamp(num(opts.days, 1600), 300, 3000);
  let md = ctx.mdCache.get(`${sym}:${days}`);
  if (!md) { md = await fetchMarketData(store, sym, { days }); ctx.mdCache.set(`${sym}:${days}`, md); }
  if (!md || !md.bars || md.bars.length < 250) {
    return { ok: false, symbol: sym, label: specLabel(spec), error: 'insufficient_market_data', bars: (md && md.bars) ? md.bars.length : 0 };
  }
  const cost = labCost(DEFAULT_COST_MODEL, opts);
  let fx = ctx.fxCache.get(sym);
  if (fx === undefined) { fx = await buildCurrencyConverter(store, sym).catch(() => null); ctx.fxCache.set(sym, fx); }
  if (fx) cost.fx = fx;

  const key = materialize(spec);
  const params = { ...exitParams(spec), logic: spec, symbol: sym, noRuinStop: !!opts.noRuinStop };
  const bt = backtest(md.bars, { strategyKey: key, params, cost });
  return {
    ok: true,
    symbol: sym, key, label: specLabel(spec), spec, tf: spec.tf || '1d',
    strategy: (spec.base && spec.base.key) || null, tier: spec.tier || 'core',
    bars: md.bars.length, source: md.source || null, from: md.bars[0].date, to: md.bars[md.bars.length - 1].date,
    metrics: trimMetrics(bt.metrics), ruined: !!bt.metrics.ruined,
    daily: dailyReturns(bt.equity), equity: bt.equity, trades: bt.trades, cost: bt.cost || cost,
  };
}

// ---------------------------------------------------------------------------
// 束ねる（ポートフォリオ）と、その統計
// ---------------------------------------------------------------------------
export function weightedEnsemble(members = []) {
  const byDate = new Map();
  for (const m of members) {
    if (m.excludedFromEnsemble) continue;      // 破産した構成員は束に入れない（E8の実行部と同じ規則）
    const w = num(m.weight, 1) || 1;
    for (const d of m.daily || []) {
      if (!isFinite(d.r)) continue;
      // 1日で元本を超えて失うことはない（資金がマイナスに振り切れた構成員が、
      // 束の平均を -541% のような非現実的な値にしてしまうのを止める）。実害が出たので上限を置く。
      const r = clamp(Number(d.r), -0.9999, 10);
      if (!byDate.has(d.date)) byDate.set(d.date, { sum: 0, w: 0 });
      const cell = byDate.get(d.date);
      cell.sum += w * r;
      cell.w += w;
    }
  }
  return [...byDate.keys()].sort().map((date) => {
    const c = byDate.get(date);
    return { date, r: c.w > 0 ? c.sum / c.w : 0, n: c.w };
  });
}

export function equityCurve(daily = [], start = 100) {
  let eq = num(start, 100);
  const out = [{ date: daily.length ? daily[0].date : null, equity: eq, pct: 0 }];
  for (const d of daily) {
    eq = eq * (1 + (isFinite(d.r) ? d.r : 0));
    out.push({ date: d.date, equity: round(eq, 2), pct: round((eq / num(start, 100) - 1) * 100, 2) });
  }
  return out;
}

export function drawdownSeries(curve = []) {
  let peak = curve.length ? curve[0].equity : 0;
  return curve.map((p) => {
    peak = Math.max(peak, p.equity);
    return { date: p.date, ddPct: peak > 0 ? round(((peak - p.equity) / peak) * 100, 2) : 0 };
  });
}

export function monthlyReturns(daily = []) {
  const by = new Map();
  for (const d of daily) {
    const k = String(d.date).slice(0, 7);
    if (!by.has(k)) by.set(k, { month: k, ret: 1, n: 0 });
    const c = by.get(k);
    c.ret *= (1 + (isFinite(d.r) ? d.r : 0));
    c.n++;
  }
  return [...by.values()].map((c) => ({ month: c.month, returnPct: round((c.ret - 1) * 100, 2), days: c.n }));
}

export function portfolioStats(daily = [], { initial = 100 } = {}) {
  const r = daily.map((d) => d.r).filter((v) => isFinite(v));
  if (!r.length) return { n: 0, from: null, to: null };
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, r.length - 1));
  let eq = 1; let peak = 1; let maxDd = 0;
  for (const v of r) { eq *= (1 + v); peak = Math.max(peak, eq); maxDd = Math.max(maxDd, (peak - eq) / peak); }
  const sorted = [...r].sort((a, b) => a - b);
  const down = r.filter((v) => v < 0);
  const sdDown = down.length ? Math.sqrt(down.reduce((s, v) => s + v * v, 0) / down.length) : 0;
  return {
    n: r.length,
    from: daily.length ? daily[0].date : null,
    to: daily.length ? daily[daily.length - 1].date : null,
    meanDailyPct: round(mean * 100, 4),
    sdDailyPct: round(sd * 100, 4),
    annSharpe: sd > 0 ? round((mean / sd) * Math.sqrt(252), 2) : 0,
    sortino: sdDown > 0 ? round((mean / sdDown) * Math.sqrt(252), 2) : null,
    maxDrawdownPct: round(maxDd * 100, 2),
    totalReturnPct: round((eq - 1) * 100, 2),
    worstDayPct: round(sorted[0] * 100, 2),
    bestDayPct: round(sorted[sorted.length - 1] * 100, 2),
    var95Pct: round((quantile(sorted, 0.05) || 0) * 100, 2),
  };
}

export function thin(arr = [], max = 400) {
  if (!Array.isArray(arr) || arr.length <= max) return arr || [];
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// ---------------------------------------------------------------------------
// E8 One モード: 選考の再生（日ごとに残高・許容損失・床を出す）
// ---------------------------------------------------------------------------
export function challengeReplay(daily = [], plan = {}, { initialBalance = 100000, scale = 1, maxHorizonDays = 504 } = {}) {
  const rule = (plan.phases && plan.phases[0]) || { targetPct: 10, minDays: 0 };
  const initial = num(initialBalance, 100000);
  const sc = num(scale, 1);
  const target = initial * (1 + num(rule.targetPct, 10) / 100);
  const floorStatic = initial * (1 - num(plan.maxLossPct, 10) / 100);
  let bal = initial; let peak = initial; let days = 0; let tradingDays = 0;
  let passed = false; let breach = null;
  const series = [];
  for (const d of daily) {
    const r = num(d.r, 0) * sc;
    if (!isFinite(r)) continue;
    days++;
    const dayStart = bal;
    const eq = dayStart * (1 + r);
    const dayLoss = Math.max(0, dayStart - eq);
    const lossBase = plan.dailyBase === 'initial' ? initial : dayStart;
    const carried = plan.dailyBase === 'initial' ? Math.max(0, dayStart - initial) : 0;
    const allow = lossBase * (num(plan.dailyLossPct, 5) / 100) + carried;
    const floor = plan.maxLossType === 'trailing'
      ? Math.min(peak, initial) - initial * (num(plan.maxLossPct, 10) / 100)
      : floorStatic;
    series.push({
      date: d.date, balance: round(eq, 2), dayPct: round(r * 100, 3),
      allow: round(allow, 2), floor: round(floor, 2), dayLossPct: round((dayLoss / Math.max(1, dayStart)) * 100, 2),
    });
    if (dayLoss > allow) { bal = eq; breach = { type: 'daily_loss', date: d.date, pct: round((dayLoss / Math.max(1, dayStart)) * 100, 2) }; break; }
    if (eq < floor) { bal = eq; breach = { type: 'max_loss', date: d.date, pct: round(((initial - eq) / initial) * 100, 2) }; break; }
    peak = Math.max(peak, eq);
    bal = eq;
    if (Math.abs(r) > 1e-12) tradingDays++;
    if (bal >= target && tradingDays >= num(rule.minDays, 0)) { passed = true; break; }
    if (plan.timeLimitDays && days >= plan.timeLimitDays) { breach = { type: 'time_limit', date: d.date }; break; }
    if (days >= maxHorizonDays) { breach = { type: 'horizon', date: d.date }; break; }
  }
  const floorNow = plan.maxLossType === 'trailing'
    ? Math.min(peak, initial) - initial * (num(plan.maxLossPct, 10) / 100)
    : floorStatic;
  return {
    passed, days, tradingDays, balance: round(bal, 2), peak: round(peak, 2),
    target: round(target, 2), floor: round(floorNow, 2),
    progressPct: round(((bal - initial) / Math.max(1, target - initial)) * 100, 2),
    toTargetPct: round(((target - bal) / Math.max(1, bal)) * 100, 2),
    toFloorPct: round(((bal - floorNow) / Math.max(1, bal)) * 100, 2),
    breach,
    series: thin(series, 400),
  };
}

export function labE8Result({ daily = [], settings = {} } = {}) {
  const plan = labE8Plan(settings.profile, settings);
  const accountSize = num(settings.accountSize, 100000);
  const scale = num(settings.scale, 0.75);
  const trials = clamp(num(settings.trials, 300), 40, 600);
  const replay = challengeReplay(daily, plan, { initialBalance: accountSize, scale });
  const boot = bootstrapPass(daily, plan, {
    trials, blockDays: 5, maxHorizonDays: 252, seed: `lab-e8-${plan.id}`, scale, initialBalance: accountSize,
  });
  const pay = fundedPayouts(daily, plan, {
    accountSize, months: num(settings.months, 12), trials: clamp(Math.round(trials / 2), 40, 300),
    blockDays: 5, seed: `lab-e8-pay-${plan.id}`, scale,
  });
  const alerts = [];
  const near = (replay.series || []).filter((d) => d.allow > 0 && d.dayLossPct > 0).sort((a, b) => b.dayLossPct - a.dayLossPct).slice(0, 8);
  for (const d of near) alerts.push({ date: d.date, kind: 'worst_day', dayLossPct: d.dayLossPct, allowPct: round((d.allow / Math.max(1, d.balance)) * 100, 2) });
  if (replay.breach) alerts.unshift({ date: replay.breach.date, kind: replay.breach.type, pct: replay.breach.pct ?? null });
  const evIndex = boot.passRatePct > 0 && pay && pay.medianMonthly
    ? round((boot.passRatePct / 100) * num(pay.medianMonthly, 0), 0) : 0;
  return {
    plan: { ...plan, label: e8ProfileOf(plan.id.replace('e8one:', '')).label },
    payRules: LAB_E8_PAY_RULES, scale, accountSize,
    replay, bootstrap: boot, payouts: pay || null,
    evIndexUSD: evIndex,
    evIndexJPY: round(evIndex * 158, 0),
    alerts,
    note: '再生は日足終値ベース。ザラ場の含み損を見ていないので、実際の違反はもっと早く来る可能性がある。',
  };
}

// ---------------------------------------------------------------------------
// 自己資金モード: 円建て・複利・撤退ライン・目標倍率の前線
// ---------------------------------------------------------------------------
export function labOwnResult({ daily = [], settings = {} } = {}) {
  const capitalJPY = num(settings.capitalJPY, OWN_CAPITAL_DEFAULT);
  const riskMultiple = num(settings.riskMultiple, 1);
  const months = clamp(num(settings.months, 12), 1, 36);
  const ruinFloorPct = num(settings.ruinFloorPct, 10);
  const trials = clamp(num(settings.trials, 300), 40, 600);
  const scaled = daily.map((d) => ({ date: d.date, r: num(d.r, 0) * riskMultiple }));
  const curve = equityCurve(scaled, capitalJPY);
  const dd = drawdownSeries(curve);
  const ruinEvents = [];
  let peak = capitalJPY;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    if (p.equity <= capitalJPY * (ruinFloorPct / 100)) ruinEvents.push({ date: p.date, equity: p.equity, ddPct: round(((peak - p.equity) / peak) * 100, 2) });
  }
  const targets = Array.isArray(settings.targets) && settings.targets.length ? settings.targets : [1.5, 2, 3, 5];
  const outcomes = targets.map((t) => ownCapitalOutcome(daily, {
    capitalJPY, riskMultiple, targetMultiple: t - 1, months, ruinFloorPct,
    trials: Math.round(trials / 2), blockDays: 5, seed: `lab-own-${capitalJPY}-${riskMultiple}-${t}`,
  }));
  const frontier = settings.frontier === false ? null : ownFrontier(daily, {
    capitalJPY, riskMultiples: [0.5, 1, 1.5, 2, 3, 4], targets: [1.5, 2, 3, 5],
    months, ruinFloorPct, trials: clamp(Math.round(trials / 4), 30, 150), blockDays: 5, seed: 'lab-own-frontier',
  });
  const margin = marginCheck({ capitalJPY, units: num(settings.units, 5000) * riskMultiple, rate: num(settings.rate, 158), leverage: num(settings.leverage, 1000) });
  return {
    capitalJPY, riskMultiple, months, ruinFloorPct,
    curve: thin(curve, 400), drawdown: thin(dd, 400),
    lastEquityJPY: curve.length ? curve[curve.length - 1].equity : capitalJPY,
    multiple: curve.length ? round(curve[curve.length - 1].equity / capitalJPY, 2) : 1,
    ruinEvents: ruinEvents.slice(0, 30), ruinEventCount: ruinEvents.length,
    outcomes, frontier, margin,
    note: '複利（建玉を残高比例）で回したときの数字。撤退ラインは元本の' + ruinFloorPct + '%を割った時点。',
  };
}

// ---------------------------------------------------------------------------
// 探索の採点（モードごとの目的関数）。UIにも式をそのまま出す。
// ---------------------------------------------------------------------------
export const LAB_OBJECTIVES = {
  own: 'score = 中央値倍率 × (1 − 撤退率) × (0.5 + 2倍到達率/200)。「増えたか」と「生き残ったか」の積。',
  e8: 'score = 合格率(%) × (1/100) × 生存補正。生存補正は含み損込み最大DDが35%超で 1−(DD−35)/65。',
};

export function labOwnScore(o = {}) {
  const mult = num(o.medianMultiple, 1);
  const reach = num(o.reachPct, 0);
  const ruin = num(o.ruinPct, 0);
  return round(mult * (1 - ruin / 100) * (0.5 + reach / 100), 4);
}

export function labE8Score(boot = {}, metrics = {}) {
  const pr = num(boot.passRatePct, 0);
  const dd = num(metrics.maxDrawdownPctMtm ?? metrics.maxDrawdownPct, 0);
  const adj = dd <= 35 ? 1 : Math.max(0.05, 1 - (dd - 35) / 65);
  return round((pr / 100) * adj, 4);
}

// ---------------------------------------------------------------------------
// IS/OOS 分割の評価（探索の門）
// ---------------------------------------------------------------------------
export function evalGates(m = {}, { minTrades = 15, minOosTrades = 6, maxDd = 40, maxOosDd = 45 } = {}) {
  const reasons = [];
  const isM = m.is || {}; const oosM = m.oos || {};
  if (num(isM.trades, 0) < minTrades) reasons.push(`ISの取引が少ない（${num(isM.trades, 0)}<${minTrades}）`);
  if (num(oosM.trades, 0) < minOosTrades) reasons.push(`OOSの取引が少ない（${num(oosM.trades, 0)}<${minOosTrades}）`);
  const dd = num(oosM.maxDrawdownPctMtm ?? oosM.maxDrawdownPct, 0);
  if (dd > maxOosDd) reasons.push(`OOSの含み損込みDDが大きい（${round(dd, 1)}%>${maxOosDd}%）`);
  const idd = num(isM.maxDrawdownPctMtm ?? isM.maxDrawdownPct, 0);
  if (idd > maxDd) reasons.push(`ISの含み損込みDDが大きい（${round(idd, 1)}%>${maxDd}%）`);
  if (num(oosM.netProfitPct, 0) <= 0) reasons.push('OOSの純益がマイナス');
  if (isM.ruined === true || oosM.ruined === true) reasons.push('資金が尽きた（破産判定）');
  return { pass: reasons.length === 0, reasons };
}

async function evalSpecISOS({ store, spec, env = {}, ctx = {}, opts = {} }) {
  const sym = spec.symbol;
  const days = clamp(num(opts.days, 1600), 400, 3000);
  if (!ctx.mdCache) ctx.mdCache = new Map();
  if (!ctx.fxCache) ctx.fxCache = new Map();
  let md = ctx.mdCache.get(`${sym}:${days}`);
  if (!md) { md = await fetchMarketData(store, sym, { days }); ctx.mdCache.set(`${sym}:${days}`, md); }
  if (!md || !md.bars || md.bars.length < 400) return { ok: false, error: 'insufficient_market_data', symbol: sym, bars: (md && md.bars ? md.bars.length : 0) };
  const cost = labCost(DEFAULT_COST_MODEL, opts);
  let fx = ctx.fxCache.get(sym);
  if (fx === undefined) { fx = await buildCurrencyConverter(store, sym).catch(() => null); ctx.fxCache.set(sym, fx); }
  if (fx) cost.fx = fx;
  const key = materialize(spec);
  const params = { ...exitParams(spec), logic: spec, symbol: sym, noRuinStop: !!opts.noRuinStop };
  const bars = md.bars;
  const oosFrac = clamp(num(opts.oosFrac, 0.3), 0.15, 0.5);
  const cut = Math.max(200, Math.floor(bars.length * (1 - oosFrac)));
  const isBt = backtest(bars.slice(0, cut), { strategyKey: key, params, cost });
  const oosBt = backtest(bars.slice(cut), { strategyKey: key, params, cost });
  const full = backtest(bars, { strategyKey: key, params, cost });
  const metrics = { is: trimMetrics(isBt.metrics), oos: trimMetrics(oosBt.metrics), full: trimMetrics(full.metrics) };
  const gates = evalGates(metrics);
  return {
    ok: true, symbol: sym, key, label: specLabel(spec), spec, tf: spec.tf || '1d',
    tier: spec.tier || 'core', strategy: (spec.base && spec.base.key) || null,
    bars: bars.length, isBars: cut, oosBars: bars.length - cut, source: md.source || null,
    from: bars[0].date, to: bars[bars.length - 1].date,
    metrics, gates, daily: dailyReturns(full.equity),
  };
}

// ---------------------------------------------------------------------------
// 候補づくり（試行錯誤の1手）
// ---------------------------------------------------------------------------
export function candidateSpecs(rnd, { symbols = SYMBOLS, count = 12, features = null } = {}) {
  const out = []; const seen = new Set();
  const presets = basePresets();
  const feats = features && features.length ? features : Object.keys(FEATURES);
  let guard = 0;
  while (out.length < count && guard++ < count * 8) {
    const sym = symbols[Math.floor(rnd() * symbols.length)];
    const useRule = rnd() < 0.45;
    const tf = rnd() < 0.7 ? '1d' : '1w';
    const exit = EXITS[Math.floor(rnd() * EXITS.length)].key;
    const dir = DIRECTIONS[Math.floor(rnd() * DIRECTIONS.length)].key;
    const filter = rnd() < 0.5 ? 'none' : FILTERS[Math.floor(rnd() * FILTERS.length)].key;
    let spec;
    if (useRule) {
      spec = labRuleSpec(rnd, { symbol: sym, feature: feats[out.length % feats.length], tf, exit, dir, filter });
    } else {
      const base = presets[Math.floor(rnd() * presets.length)];
      spec = labSpec({ symbol: sym, tf, strategy: base.key, variant: base.variant, filter, exit, dir });
    }
    const k = `${spec.symbol}|${spec.tf}|${spec.exit}|${spec.dir}|${spec.filter}|${JSON.stringify(spec.base)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(spec);
  }
  return out;
}

export function labHeatmap(rows = []) {
  const agg = (key) => {
    const by = new Map();
    for (const r of rows) {
      const name = r[key] == null ? 'その他' : String(r[key]);
      const cur = by.get(name) || { name, best: null, n: 0, sum: 0 };
      cur.n++;
      cur.sum += num(r.score, 0);
      cur.best = cur.best == null ? num(r.score, 0) : Math.max(cur.best, num(r.score, 0));
      by.set(name, cur);
    }
    return [...by.values()].map((c) => ({ name: c.name, best: round(c.best, 4), mean: round(c.sum / Math.max(1, c.n), 4), n: c.n })).sort((a, b) => b.best - a.best);
  };
  const gridMap = new Map();
  for (const r of rows) {
    const k = `${r.symbol}|${r.tf}`;
    const cur = gridMap.get(k) || { symbol: r.symbol, tf: r.tf, best: null, n: 0 };
    cur.n++;
    cur.best = cur.best == null ? num(r.score, 0) : Math.max(cur.best, num(r.score, 0));
    gridMap.set(k, cur);
  }
  return {
    bySymbol: agg('symbol'), byTimeframe: agg('tf'), byExit: agg('exit'),
    byDirection: agg('dir'), byFilter: agg('filter'), byStrategy: agg('strategyLabel'),
    grid: [...gridMap.values()].map((g) => ({ ...g, best: round(g.best, 4) })).sort((a, b) => b.best - a.best),
  };
}

// ---------------------------------------------------------------------------
// 探索（試行錯誤）— 候補を作り、IS/OOSで門を通し、モードの目的関数で順位をつける
// ---------------------------------------------------------------------------
export async function labSearch({
  store, mode = 'own', env = {}, n = 12, opts = {}, settings = {}, ctx = {}, at = null, persist = true, budgetMs = null, features = null,
} = {}) {
  await ensureLabTable(store);
  const now = at || nowIso();
  const t0 = Date.now();
  const budget = Math.max(4000, num(budgetMs, env.LAB_BUDGET_MS || 15000));
  const rnd = seededRandom(`lab-${mode}-${now}-${n}`);
  const specs = candidateSpecs(rnd, { count: clamp(num(n, 12), 1, 40), features });
  const rows = [];
  const errors = [];
  let stopped = false;

  for (const spec of specs) {
    if (Date.now() - t0 > budget) { stopped = true; break; }
    try {
      const ev = await evalSpecISOS({ store, spec, env, ctx, opts: { ...opts, noRuinStop: mode === 'e8' ? true : false } });
      if (!ev.ok) { errors.push({ symbol: spec.symbol, error: ev.error, bars: ev.bars }); continue; }
      let score = null; let objective = null;
      if (mode === 'e8') {
        const boot = bootstrapPass(ev.daily, labE8Plan(settings.profile, settings), {
          trials: clamp(num(settings.trials, 120), 40, 400), blockDays: 5, maxHorizonDays: 252,
          seed: `lab-search-e8-${ev.key}`, scale: num(settings.scale, 0.75), initialBalance: num(settings.accountSize, 100000),
        });
        score = labE8Score(boot, ev.metrics.oos);
        objective = { passRatePct: boot.passRatePct, medianDays: boot.medianDays, p25Days: boot.p25Days, p75Days: boot.p75Days, breaches: boot.breaches };
      } else {
        const o = ownCapitalOutcome(ev.daily, {
          capitalJPY: num(settings.capitalJPY, OWN_CAPITAL_DEFAULT), riskMultiple: num(settings.riskMultiple, 1),
          targetMultiple: num(settings.targetMultiple, 1), months: num(settings.months, 12),
          ruinFloorPct: num(settings.ruinFloorPct, 10), trials: clamp(num(settings.trials, 120), 40, 400),
          blockDays: 5, seed: `lab-search-own-${ev.key}`,
        });
        score = labOwnScore(o);
        objective = { medianMultiple: o.medianMultiple, reachPct: o.reachPct, ruinPct: o.ruinPct, medianFinalJPY: o.medianFinalJPY, p10FinalJPY: o.p10FinalJPY };
      }
      const row = {
        symbol: ev.symbol, tf: ev.tf, exit: (spec.exit || null), dir: (spec.dir || null), filter: (spec.filter || null),
        strategyLabel: (spec.base && spec.base.key) || null, tier: ev.tier, key: ev.key, label: ev.label,
        score, objective, gates: ev.gates, metrics: { oos: ev.metrics.oos, is: ev.metrics.is }, spec,
        bars: ev.bars, from: ev.from, to: ev.to, source: ev.source, evaluatedAt: now,
      };
      rows.push(row);
      if (persist) {
        await store.insert(T, {
          id: newId('fxl_'), symbol: ev.symbol, strategy_key: ev.key, params_json: j({ spec, settings, mode }),
          metrics_json: j({ ...ev.metrics.oos, is: ev.metrics.is, oos: ev.metrics.oos, objective, score, mode, basis: 'oos' }),
          fitness: num(score, 0), verdict: ev.gates.pass ? 'pass' : 'fail', gates_json: j(ev.gates.reasons),
          walkforward_json: j({ isBars: ev.isBars, oosBars: ev.oosBars, oosFrac: num(opts.oosFrac, 0.3) }),
          parent_id: null, mutation: mode === 'e8' ? 'lab:search:e8' : 'lab:search:own',
          tag: `lab:${mode}`, bars: ev.bars, data_source: ev.source || null,
          date_from: ev.from, date_to: ev.to, promoted: 0, created_at: now,
        }).catch(() => {});
      }
    } catch (e) {
      errors.push({ symbol: spec.symbol, error: String((e && e.message) || e).slice(0, 160) });
    }
  }

  rows.sort((a, b) => num(b.score, 0) - num(a.score, 0));
  const scores = rows.map((r) => num(r.score, 0));
  const summary = {
    at: now, mode, evaluated: rows.length, requested: specs.length, stopped, errors,
    best: rows[0] ? { symbol: rows[0].symbol, tf: rows[0].tf, label: rows[0].label, score: rows[0].score, objective: rows[0].objective } : null,
    passedGates: rows.filter((r) => r.gates.pass).length,
    distribution: scores.length ? {
      p25: round(quantile(scores, 0.25), 4), median: round(quantile(scores, 0.5), 4),
      p75: round(quantile(scores, 0.75), 4), max: round(Math.max(...scores), 4), min: round(Math.min(...scores), 4),
    } : null,
    objective: LAB_OBJECTIVES[mode] || null,
    ms: Date.now() - t0,
  };
  return { summary, rows, heatmap: labHeatmap(rows), settings, opts };
}

// ---------------------------------------------------------------------------
// Exit Optimizer — 出口（損切り・利確・保有日数）を振って最良を探す
// ---------------------------------------------------------------------------
export function exitGrid({ stops = [1.0, 1.5, 2.0, 2.5, 3.0], targets = [1.5, 2.0, 3.0, 4.0], holds = [0, 5, 30, 60] } = {}) {
  const out = [];
  for (const s of stops) for (const t of targets) for (const h of holds) out.push({ atrStopMult: s, atrTargetMult: t, maxHoldBars: h, trailAtrMult: 0 });
  return out;
}

export async function exitOptimize({ store, spec, env = {}, ctx = {}, opts = {}, grid = null, limit = 24 } = {}) {
  const sym = spec.symbol;
  if (!ctx.mdCache) ctx.mdCache = new Map();
  if (!ctx.fxCache) ctx.fxCache = new Map();
  const days = clamp(num(opts.days, 1600), 400, 3000);
  let md = ctx.mdCache.get(`${sym}:${days}`);
  if (!md) { md = await fetchMarketData(store, sym, { days }); ctx.mdCache.set(`${sym}:${days}`, md); }
  if (!md || !md.bars || md.bars.length < 400) return { ok: false, error: 'insufficient_market_data', symbol: sym };
  const cost = labCost(DEFAULT_COST_MODEL, opts);
  let fx = ctx.fxCache.get(sym);
  if (fx === undefined) { fx = await buildCurrencyConverter(store, sym).catch(() => null); ctx.fxCache.set(sym, fx); }
  if (fx) cost.fx = fx;
  const key = materialize(spec);
  const base = { ...exitParams(spec), logic: spec, symbol: sym, noRuinStop: !!opts.noRuinStop };
  const combos = (grid || exitGrid(opts.grid || {})).slice(0, clamp(num(limit, 24), 4, 120));
  const rows = [];
  let applied = true; let first = null;
  for (const combo of combos) {
    const bt = backtest(md.bars, { strategyKey: key, params: { ...base, ...combo }, cost });
    const m = trimMetrics(bt.metrics);
    const sig = `${m.trades}|${m.netProfitJPY}|${m.maxDrawdownPct}`;
    if (first == null) first = sig; else if (sig === first) applied = false;
    const dd = num(m.maxDrawdownPctMtm ?? m.maxDrawdownPct, 0);
    rows.push({
      ...combo, netPct: m.netProfitPct, pf: m.profitFactor, trades: m.trades, winRate: m.winRate,
      ddMtmPct: dd, sharpe: m.sharpe, expectancy: m.expectancy,
      score: round(num(m.netProfitPct, 0) * (1 - clamp(dd, 0, 100) / 100), 3),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return {
    ok: true, symbol: sym, key, label: specLabel(spec), bars: md.bars.length, evaluated: rows.length,
    rows, best: rows[0] || null,
    applied,
    note: applied
      ? '出口パラメータの上書きが効いている（同じ結果の行が混ざっていれば効いていない）。'
      : '上書きが効いていない疑い（全行が同じ結果）。出口は spec の exit から作り直す必要がある。これはこの作業台の実装上の限界として隠さず返す。',
  };
}

// ---------------------------------------------------------------------------
// 1回の実行（UIの「走らせる」）— モードごとの結論まで出す
// ---------------------------------------------------------------------------
export async function labRun({ store, env = {}, body = {}, ctx = {} }) {
  const mode = LAB_MODES.includes(body.mode) ? body.mode : 'own';
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 8) : [];
  const opts = { ...(body.options || {}) };
  const settings = { ...(body.settings || {}) };
  const withOpts = { replay: true, robust: false, tradeLimit: 200, ...(body.with || {}) };
  if (mode === 'e8') { opts.noRuinStop = true; settings.accountSize = num(settings.accountSize, 100000); }
  const rnd = seededRandom(`lab-run-${nowIso()}-${rows.length}`);
  const known = new Set(basePresets().map((p) => p.key));
  const errors = [];
  const warnings = [];
  const specs = [];
  for (const r of rows) {
    // 知らないロジック名は黙って別のロジックに差し替えない（実害が出た: donchian を指定したのに
    // 先頭のロジックで走っていた）。走らせずに、理由を返す。
    if (r && r.strategy && !r.spec && r.kind !== 'rule' && !known.has(r.strategy)) {
      errors.push({ symbol: r.symbol || null, error: 'unknown_strategy', strategy: r.strategy, known: [...known].slice(0, 24) });
      continue;
    }
    specs.push({ spec: specFromRow(r, rnd), weight: num(r.weight, 1) || 1 });
  }
  const members = [];
  for (const s of specs) {
    const m = await runMember({ store, spec: s.spec, env, ctx, opts });
    if (m.ok) members.push({ ...m, weight: s.weight });
    else errors.push({ symbol: s.spec.symbol, error: m.error, bars: m.bars });
  }
  if (!members.length) return { ok: false, mode, error: 'no_member_ran', errors, warnings, assumptions: LAB_ASSUMPTIONS };

  // E8モードでは、破産した構成員を束から外す（実行部 e8Runner.js の splitViable と同じ規則）。
  // 資金がマイナスに振り切れた構成員をそのまま平均すると、束が非現実的な値になる。
  if (mode === 'e8') {
    for (const m of members) {
      const broke = m.ruined === true || num(m.metrics.netProfitPct, 0) <= -100;
      if (broke) {
        m.excludedFromEnsemble = true;
        warnings.push(`${String(m.label).slice(0, 48)}… は資金が尽きた（純益 ${num(m.metrics.netProfitPct, 0)}%）ので束から外しました`);
      }
    }
  }
  const usable = members.filter((m) => !m.excludedFromEnsemble);
  if (!usable.length) {
    return { ok: false, mode, error: 'all_members_ruined', errors, warnings, members: members.map((m) => ({ symbol: m.symbol, label: m.label, metrics: m.metrics, excludedFromEnsemble: !!m.excludedFromEnsemble })), assumptions: LAB_ASSUMPTIONS };
  }

  const daily = weightedEnsemble(usable);
  const stats = portfolioStats(daily, { initial: 100 });
  const startCapital = mode === 'e8' ? num(settings.accountSize, 100000) : num(settings.capitalJPY, OWN_CAPITAL_DEFAULT);
  const scaledDaily = mode === 'own'
    ? daily.map((d) => ({ date: d.date, r: d.r * num(settings.riskMultiple, 1) }))
    : daily.map((d) => ({ date: d.date, r: d.r * num(settings.scale, 0.75) }));
  const curve = thin(equityCurve(scaledDaily, startCapital), 400);
  const ddSeries = thin(drawdownSeries(curve), 400);
  const monthly = monthlyReturns(scaledDaily);

  const modeResult = mode === 'e8'
    ? labE8Result({ daily, settings })
    : labOwnResult({ daily, settings });

  let replay = null;
  if (withOpts.replay && usable.length) {
    const primary = usable.slice().sort((a, b) => num(b.metrics.netProfitPct, 0) - num(a.metrics.netProfitPct, 0))[0];
    const md = ctx.mdCache.get(`${primary.symbol}:${clamp(num(opts.days, 1600), 300, 3000)}`) || null;
    const bars = md && md.bars ? md.bars.slice(-420) : [];
    const from = bars.length ? bars[0].date : null;
    const eqByDate = new Map(primary.equity.map((e) => [e.date, num(e.equityMtm ?? e.equity, 0)]));
    const startEq = bars.length ? (eqByDate.get(bars[0].date) ?? null) : null;
    replay = {
      symbol: primary.symbol, label: primary.label, tf: primary.tf,
      bars: bars.map((b) => ({ date: b.date, o: b.open, h: b.high, l: b.low, c: b.close })),
      equity: bars.map((b) => ({ date: b.date, equity: eqByDate.get(b.date) ?? null })),
      startEquity: startEq,
      trades: (primary.trades || []).filter((t) => !from || t.entryDate >= from).slice(-withOpts.tradeLimit).map((t) => ({
        entryDate: t.entryDate, exitDate: t.exitDate, dir: t.dir, entry: t.entryPrice, exit: t.exitPrice,
        pnlJPY: t.pnlJPY, reason: t.reason, barsHeld: t.barsHeld,
      })),
    };
  }

  let extras = null;
  if (withOpts.robust && usable.length) {
    const primary = usable[0];
    try {
      const md = ctx.mdCache.get(`${primary.symbol}:${clamp(num(opts.days, 1600), 400, 3000)}`);
      const cost = labCost(DEFAULT_COST_MODEL, opts);
      const fx = ctx.fxCache.get(primary.symbol);
      if (fx) cost.fx = fx;
      const full = backtest(md.bars, { strategyKey: primary.key, params: { ...exitParams(primary.spec), logic: primary.spec, symbol: primary.symbol, noRuinStop: !!opts.noRuinStop }, cost });
      const wf = walkForward(md.bars, { strategyKey: primary.key, params: { ...exitParams(primary.spec), logic: primary.spec, symbol: primary.symbol }, cost }, 4);
      const mc = orderRobustness(full.trades, 300, `lab-${primary.key}`);
      const stressed = labCost(DEFAULT_COST_MODEL, { ...opts, stressMult: 1.5 });
      if (fx) stressed.fx = fx;
      const stress = backtest(md.bars, { strategyKey: primary.key, params: { ...exitParams(primary.spec), logic: primary.spec, symbol: primary.symbol, noRuinStop: !!opts.noRuinStop }, cost: stressed });
      let robust = null;
      try {
        robust = deepValidate(md.bars, {
          symbol: primary.symbol, strategyKey: primary.key,
          params: { ...exitParams(primary.spec), logic: primary.spec, symbol: primary.symbol }, cost, source: md.source,
          trials: 1, trialSharpes: [], seed: `lab-${primary.key}`, budgetMs: num(body.robustBudgetMs, 10000),
        });
      } catch (e) { robust = { ok: false, reason: String((e && e.message) || e).slice(0, 160) }; }
      extras = {
        symbol: primary.symbol, label: primary.label,
        walkforward: { consistent: wf.consistent, positive: wf.netPositiveFolds, folds: wf.totalFolds, worstPf: wf.worstProfitFactor, medianPf: wf.medianProfitFactor },
        montecarlo: mc,
        costStress: { netProfitPct: stress.metrics.netProfitPct, profitFactor: stress.metrics.profitFactor, mult: 1.5 },
        robust: robust ? { ok: robust.ok, pass: robust.gates && robust.gates.pass === true, score: robust.score ?? null, reasons: (robust.gates && robust.gates.reasons) || [] } : null,
      };
    } catch (e) { extras = { error: String((e && e.message) || e).slice(0, 200) }; }
  }

  const out = {
    ok: true, mode, version: LAB_VERSION, ranAt: nowIso(),
    settings, options: opts,
    members: members.map((m) => ({
      symbol: m.symbol, label: m.label, tf: m.tf, key: m.key, weight: m.weight, tier: m.tier,
      excludedFromEnsemble: !!m.excludedFromEnsemble,
      bars: m.bars, from: m.from, to: m.to, source: m.source, metrics: m.metrics,
      tradeCount: (m.trades || []).length,
      trades: (m.trades || []).slice(-withOpts.tradeLimit).map((t) => ({
        entryDate: t.entryDate, exitDate: t.exitDate, dir: t.dir, entry: t.entryPrice, exit: t.exitPrice,
        pnlJPY: t.pnlJPY, reason: t.reason, barsHeld: t.barsHeld,
      })),
    })),
    errors,
    warnings,
    portfolio: {
      stats, curve, drawdown: ddSeries, monthly,
      trades: usable.flatMap((m) => (m.trades || []).map((t) => ({ ...t, symbol: m.symbol })))
        .sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate))).slice(-withOpts.tradeLimit),
      memberCount: members.length,
    },
    modeResult,
    replay,
    extras,
    assumptions: LAB_ASSUMPTIONS,
  };
  return out;
}

// ---------------------------------------------------------------------------
// カタログ（UIがプルダウンを作るための材料）
// ---------------------------------------------------------------------------
export function labCatalog(env = {}) {
  const presets = basePresets();
  const byKey = new Map();
  for (const p of presets) {
    const s = STRATEGIES[p.key] || {};
    if (!byKey.has(p.key)) byKey.set(p.key, { key: p.key, label: s.label || p.key, variants: [] });
    byKey.get(p.key).variants.push({ variant: p.variant, params: p.params });
  }
  return {
    version: LAB_VERSION,
    modes: [
      { key: 'e8', label: 'E8モード', blurb: 'E8 One の選考（最大損失・日次・目標）を、選んだロジックで再生する。' },
      { key: 'own', label: '自己資金モード', blurb: '自分の資金を複利で回す。増えたか・生き残ったかで測る。' },
    ],
    symbols: SYMBOLS,
    timeframes: TIMEFRAMES.map((t) => ({ key: t.key, label: t.label })),
    filters: FILTERS.map((f) => ({ key: f.key, label: f.label })),
    exits: EXITS.map((e) => ({ key: e.key, label: e.label, atrStopMult: e.atrStopMult, atrTargetMult: e.atrTargetMult, maxHoldBars: e.maxHoldBars })),
    directions: DIRECTIONS.map((d) => ({ key: d.key, label: d.label })),
    features: Object.entries(FEATURES).map(([key, f]) => ({ key, label: f.label, th: f.th })),
    ops: OPS,
    atoms: ATOMS.length,
    strategies: [...byKey.values()],
    space: { core: coreSize(), rule: ruleSize(), total: coreSize() + ruleSize() },
    cost: { defaults: { ...DEFAULT_COST_MODEL } },
    data: { days: clamp(num(env.LAB_DAYS, 1600), 400, 3000), symbols: SYMBOLS.length },
    e8: {
      profiles: Object.values(LAB_E8_PROFILES),
      defaults: { profile: env.E8_PROFILE || 'p10', accountSize: num(env.E8_ACCOUNT, 100000), scale: num(env.E8_SCALE, 0.75), months: 12, trials: 300, dailyBase: 'initial' },
      pay: LAB_E8_PAY_RULES,
    },
    own: {
      defaults: { capitalJPY: OWN_CAPITAL_DEFAULT, riskMultiple: 1, targetMultiple: 2, months: 12, ruinFloorPct: 10, leverage: 1000, units: 5000, rate: 158, targets: [1.5, 2, 3, 5] },
    },
    gates: { minTrades: 15, minOosTrades: 6, maxDd: 40, maxOosDd: 45 },
    objectives: LAB_OBJECTIVES,
    assumptions: LAB_ASSUMPTIONS,
    notIncluded: [
      'ティック精度（手元にあるのは日足OHLCだけ）',
      '指標92種（この作業台はエンジン内の指標のみ。自作指標の取り込みは未実装）',
      '銘柄283（無料データが引ける20銘柄）',
      'ニュース/経済指標の履歴フィルタ',
      '手動裁量の売買（この作業台は機械的なロジックのみ）',
      'スクリーンショット・日誌（Forex Tester の Journal 相当）',
    ],
    search: { every_minutes: num(env.LAB_EVERY_MINUTES, 15), per_tick: num(env.LAB_SEARCH_N, 6), budget_ms: num(env.LAB_BUDGET_MS, 15000) },
  };
}

// ---------------------------------------------------------------------------
// 保存した作品（プロジェクト）
// ---------------------------------------------------------------------------
const slug = (s) => String(s || '').trim().slice(0, 60).replace(/[^0-9A-Za-zぁ-んァ-ヶ一-龠ー_\- ]/g, '').replace(/\s+/g, '-') || 'untitled';

export async function labSaveProject(store, name, payload) {
  const key = LAB_PROJECT_PREFIX + slug(name);
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    key, j({ name, savedAt: nowIso(), payload }), nowIso());
  return { ok: true, name, key };
}

export async function labLoadProject(store, name) {
  const key = LAB_PROJECT_PREFIX + slug(name);
  const row = await store.first(`SELECT value FROM settings WHERE key=?`, key).catch(() => null);
  const v = safeJson(row && row.value, null);
  return v || { ok: false, error: 'not_found', name };
}

export async function labProjects(store) {
  const rows = await store.all(`SELECT key,value,updated_at FROM settings WHERE key LIKE ? ORDER BY updated_at DESC LIMIT 50`, LAB_PROJECT_PREFIX + '%').catch(() => []);
  return rows.map((r) => {
    const v = safeJson(r.value, {}) || {};
    return { name: v.name || r.key.slice(LAB_PROJECT_PREFIX.length), savedAt: v.savedAt || r.updated_at, rows: (v.payload && v.payload.rows ? v.payload.rows.length : null), mode: (v.payload && v.payload.mode) || null };
  });
}

export async function labDeleteProject(store, name) {
  await store.run(`DELETE FROM settings WHERE key=?`, LAB_PROJECT_PREFIX + slug(name)).catch(() => {});
  return { ok: true, deleted: name };
}

// ---------------------------------------------------------------------------
// 順位表（D1 に積んだ候補から作る）
// ---------------------------------------------------------------------------
export async function labBoard(store, { mode = 'own', limit = 30 } = {}) {
  const rows = await store.all(`SELECT symbol,strategy_key,metrics_json,fitness,verdict,gates_json,tag,date_from,date_to,bars,created_at
    FROM ${T} WHERE tag=? ORDER BY fitness DESC LIMIT ?`, `lab:${mode}`, clamp(num(limit, 30), 1, 200)).catch(() => []);
  return rows.map((r) => {
    const m = safeJson(r.metrics_json, {}) || {};
    return {
      symbol: r.symbol, key: r.strategy_key, fitness: r.fitness, verdict: r.verdict,
      reasons: safeJson(r.gates_json, []) || [], at: r.created_at, bars: r.bars, from: r.date_from, to: r.date_to,
      oosNetPct: (m.oos && m.oos.netProfitPct) ?? m.netProfitPct ?? null,
      oosDdMtmPct: (m.oos && (m.oos.maxDrawdownPctMtm ?? m.oos.maxDrawdownPct)) ?? null,
      objective: m.objective || null, mode: m.mode || mode,
      label: m.label || (m.spec ? specLabel(m.spec) : null) || null,
    };
  });
}

export async function labTick({ store, env = {}, now = null } = {}) {
  const at = now || nowIso();
  await ensureLabTable(store);
  const n = clamp(num(env.LAB_SEARCH_N, 6), 1, 24);
  const budget = num(env.LAB_BUDGET_MS, 15000);
  const ctx = { mdCache: new Map(), fxCache: new Map() };
  const out = { at, own: null, e8: null };
  try {
    const own = await labSearch({ store, mode: 'own', env, n, ctx, at, budgetMs: Math.round(budget * 0.5), settings: { capitalJPY: OWN_CAPITAL_DEFAULT, riskMultiple: 1, targetMultiple: 1, months: 12, ruinFloorPct: 10, trials: 120 } });
    out.own = own.summary;
  } catch (e) { out.own = { error: String((e && e.message) || e).slice(0, 160) }; }
  try {
    const e8 = await labSearch({ store, mode: 'e8', env, n, ctx, at, budgetMs: Math.round(budget * 0.5), settings: { profile: env.E8_PROFILE || 'p10', accountSize: num(env.E8_ACCOUNT, 100000), scale: num(env.E8_SCALE, 0.75), trials: 120 } });
    out.e8 = e8.summary;
  } catch (e) { out.e8 = { error: String((e && e.message) || e).slice(0, 160) }; }
  const stats = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LAB_STATS_KEY).catch(() => null))?.value, null)
    || { ticks: 0, own_searched: 0, e8_searched: 0, startedAt: at };
  stats.ticks = num(stats.ticks, 0) + 1;
  stats.own_searched = num(stats.own_searched, 0) + num(out.own && out.own.evaluated, 0);
  stats.e8_searched = num(stats.e8_searched, 0) + num(out.e8 && out.e8.evaluated, 0);
  stats.lastAt = at;
  stats.lastOwn = out.own; stats.lastE8 = out.e8;
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    LAB_STATS_KEY, j(stats), at).catch(() => {});
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    LAB_BOARD_KEY, j({ at, own: out.own, e8: out.e8 }), at).catch(() => {});
  out.stats = stats;
  return out;
}

export async function labStatus(store, env = {}) {
  const stats = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LAB_STATS_KEY).catch(() => null))?.value, null);
  const board = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LAB_BOARD_KEY).catch(() => null))?.value, null);
  const [ownTop, e8Top] = await Promise.all([
    labBoard(store, { mode: 'own', limit: 10 }).catch(() => []),
    labBoard(store, { mode: 'e8', limit: 10 }).catch(() => []),
  ]);
  return {
    version: LAB_VERSION, stats, board, ownTop, e8Top,
    config: { everyMinutes: num(env.LAB_EVERY_MINUTES, 15), perTick: num(env.LAB_SEARCH_N, 6), budgetMs: num(env.LAB_BUDGET_MS, 15000), days: num(env.LAB_DAYS, 1600) },
    objectives: LAB_OBJECTIVES, assumptions: LAB_ASSUMPTIONS,
  };
}

export function labText(st = {}) {
  const L = [];
  L.push(`【バックテスト作業台】${LAB_VERSION}`);
  L.push(`探索: ${st.config ? `1tick ${st.config.perTick}件・${st.config.everyMinutes}分ごと（予算 ${st.config.budgetMs}ms）` : '—'}`);
  if (st.stats) L.push(`累計: tick ${st.stats.ticks || 0}回 / 自己資金 ${st.stats.own_searched || 0}件 / E8 ${st.stats.e8_searched || 0}件（最終 ${st.stats.lastAt || '—'}）`);
  const line = (r) => {
    const obj = r.objective || {};
    const bits = [];
    if (obj.passRatePct != null) bits.push(`合格率${obj.passRatePct}%`);
    if (obj.medianDays != null) bits.push(`中央値${obj.medianDays}日`);
    if (obj.medianMultiple != null) bits.push(`中央値${obj.medianMultiple}倍`);
    if (obj.reachPct != null) bits.push(`到達${obj.reachPct}%`);
    if (obj.ruinPct != null) bits.push(`撤退${obj.ruinPct}%`);
    if (r.oosNetPct != null) bits.push(`OOS ${r.oosNetPct}%`);
    if (r.oosDdMtmPct != null) bits.push(`DD ${r.oosDdMtmPct}%`);
    return `  ${round(r.fitness, 4)}  ${r.symbol} ${r.key.slice(0, 18)} … ${bits.join(' / ')}`;
  };
  L.push('自己資金モードの上位:');
  if ((st.ownTop || []).length) for (const r of st.ownTop.slice(0, 5)) L.push(line(r)); else L.push('  （まだ無し）');
  L.push('E8モードの上位:');
  if ((st.e8Top || []).length) for (const r of st.e8Top.slice(0, 5)) L.push(line(r)); else L.push('  （まだ無し）');
  L.push(`採点: 自己資金 = ${LAB_OBJECTIVES.own}`);
  L.push(`採点: E8 = ${LAB_OBJECTIVES.e8}`);
  L.push('画面: /lab.html（2つのタブ）');
  L.push('注意: 日足終値ベース。ザラ場の含み損・スワップ・約定拒否は含まない。');
  return L.join('\n');
}

export function labHelp() {
  return [
    `バックテスト作業台（lab.js / ${LAB_VERSION}）— 2つのモードを1つのエンジンで回す`,
    '使い方:',
    '  GET  /api/lab               … 状態（探索の累計・順位表）',
    '  GET  /api/lab?format=text   … 人が読む形',
    '  GET  /api/lab/catalog       … 銘柄・時間軸・論理・出口・費用・E8規格の一覧',
    '  POST /api/lab/run           … {mode:"own"|"e8", rows:[...], options:{...}, settings:{...}, with:{robust:true}}',
    '  POST /api/lab/search        … {mode, n} 候補を無作為に作って試行錯誤（順位・ヒートマップを返す）',
    '  POST /api/lab/exit          … {row:{...}} 出口（損切り/利確/保有日数）を振って最良を探す',
    '  POST /api/lab/project       … {action:"save"|"load"|"list"|"delete", name, payload}',
    '  POST /api/lab/tick          … 背景ループをその場で1回回す',
    '  GET  /api/lab/data?symbol=USDJPY … チャート用の日足',
    '  GET  /api/lab/board?mode=own … D1 に積んだ候補の順位表',
    '画面: /lab.html',
    'モード: e8 = E8 One の選考、own = 自己資金（円建て・複利・撤退ライン）',
  ];
}

export { atomText };
