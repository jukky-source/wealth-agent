// e8Runner.js — E8 One の選考と資金提供口座を、エージェントの中で回し続ける実行部。
//
// 何をするか:
//   * E8 One の規格（利益目標・日次損失・動的な最大損失・分配・随時請求）を「口座」として持ち、
//     選んだロジック集合の日次損益を1日ずつ当てて、選考 → 資金提供 → 支払い までを前へ進める。
//   * 状態は D1 の settings に置く。Cron が回る限り、サンドボックスが消えても続く。
//   * 合格・失格・支払いはイベントとして残し、失格したら次の挑戦へ自動で移る。
//     （実口座の再購入は人間の操作が要る。ここは紙上の検証。発注も資金移動もしない）
//   * 起動時に直近 E8_BACKFILL_DAYS を再生して「現在地」を作る。これは過去の再生であることを
//     状態に明示する（backfilledBars / backfillFrom）。黙って水増ししない。
//
// 規格の出典: prop.js の PROP_FIRMS（e8one_6 / e8one_10 は一次情報で確認済み）。
// 判定式は prop.js の simulateChallenge / fundedPayouts と同じ形にしてある
// （計器（合格率の推計）と実行部（実際に1本走らせる）で数字が食い違わないように）。
//
// 含まないもの（誇張しないための明示）: ザラ場の含み損（日足終値ベース）、スワップ、週末の窓、
// スプレッドの時間帯変動、約定拒否、手数料、税。E8 の 40%ベストデイルールは支払い判定の近似。

import { nowIso, j, safeJson, round, clamp } from '../util.js';
import { DEFAULT_COST_MODEL, backtest, STRATEGIES } from './backtest.js';
import { fetchMarketData, buildCurrencyConverter } from './fx.js';
import { dailyReturns, ensembleReturns, PROP_FIRMS } from './prop.js';
import { materialize, describeLogic, exitParams } from './grammar.js';

export const E8_VERSION = 'e8-1.0';
export const E8_STATE_KEY = 'e8:state';
export const E8_STATS_KEY = 'e8:stats';
export const E8_EVENTS_KEY = 'e8:events';

// E8 One は「最大損失 / 利益目標 / 日次損失」を選択制。目標は最大損失の1.5倍で揃っている。
export const E8_ONE_PROFILES = {
  p4: { id: 'p4', maxLossPct: 4, targetPct: 6, dailyLossPct: 3 },
  p6: { id: 'p6', maxLossPct: 6, targetPct: 9, dailyLossPct: 4 },
  p8: { id: 'p8', maxLossPct: 8, targetPct: 12, dailyLossPct: 5.3 },
  p10: { id: 'p10', maxLossPct: 10, targetPct: 15, dailyLossPct: 6.6 },
  p14: { id: 'p14', maxLossPct: 14, targetPct: 21, dailyLossPct: 9.2 },
};

/** 規格を1つに解決する（既定は最大損失10%＝実測で期待値が最も高かった選択肢）。 */
export function e8Profile(key) {
  const p = E8_ONE_PROFILES[String(key || 'p10')] || E8_ONE_PROFILES.p10;
  const base = PROP_FIRMS.e8one_10;
  return {
    ...p,
    firm: 'E8 Markets', plan: `E8 One（最大損失${p.maxLossPct}%を選択）`,
    verified: true, source: base.source,
    dailyBase: base.dailyBase, maxLossType: base.maxLossType,
    splitPct: base.splitPct, payoutCycleDays: 0,
    minPayoutPctOfDailyDd: base.minPayoutPctOfDailyDd, bestDayCapPct: base.bestDayCapPct,
    timeLimitDays: null,
    firstPayoutNote: base.firstPayoutNote,
  };
}

// ---------------------------------------------------------------------------
// どのロジックを走らせるか
//   1) env.E8_LOGICS（明示: "USDJPY:donchian_breakout,GOLD:ema_cross"）
//   2) 探索器（optimizer.js）が選んだ「相関の低い集合」= opt:collection
//   3) 既定（過去10年を生き残った5本の等加重）
// ---------------------------------------------------------------------------
export const E8_DEFAULT_LOGICS = [
  { symbol: 'USDJPY', want: 'donchian' },
  { symbol: 'USDJPY', want: 'bollinger' },
  { symbol: 'GOLD', want: 'donchian' },
  { symbol: 'GOLD', want: 'ema_cross' },
  { symbol: 'EURJPY', want: 'bollinger' },
];

function resolveKey(want, symbol) {
  if (STRATEGIES[want]) return want;
  const keys = Object.keys(STRATEGIES).filter((k) => !k.startsWith('g_'));
  return keys.find((k) => k.includes(want) && (!symbol || true)) || null;
}

export function parseLogoics(str) {
  return String(str || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [symbol, want] = pair.split(':');
    return { symbol: String(symbol || 'USDJPY').toUpperCase(), want: String(want || 'donchian') };
  });
}

export async function e8Members({ store, env = {} } = {}) {
  const out = [];
  const push = (m) => {
    if (!m.key || !m.symbol) return;
    if (out.some((x) => x.symbol === m.symbol && x.key === m.key)) return;
    out.push(m);
  };

  if (env.E8_LOGICS && String(env.E8_LOGICS).trim()) {
    for (const spec of parseLogoics(env.E8_LOGICS)) {
      const key = resolveKey(spec.want, spec.symbol);
      push({ symbol: spec.symbol, key, params: { symbol: spec.symbol }, label: `${spec.symbol} / ${STRATEGIES[key]?.label || key}`, from: 'env' });
    }
  }
  if (!out.length) {
    const col = safeJson((await store.first(`SELECT value FROM settings WHERE key='opt:collection'`).catch(() => null))?.value, null);
    for (const m of (col && col.members) || []) {
      push({ symbol: m.symbol, key: m.key, params: m.params || { symbol: m.symbol }, weight: m.weight ?? null, label: m.label || `${m.symbol} / ${m.key}`, from: 'collection' });
    }
  }
  if (!out.length) {
    for (const d of E8_DEFAULT_LOGICS) {
      const key = resolveKey(d.want, d.symbol);
      push({ symbol: d.symbol, key, params: { symbol: d.symbol }, label: `${d.symbol} / ${STRATEGIES[key]?.label || key}`, from: 'default' });
    }
  }
  return out.slice(0, Math.max(1, Math.min(8, Number(env.E8_MAX_LOGICS || 6))));
}

/** 破産した構成員（そのままでは運用できないロジック）は束から外す。外した事実は返して隠さない。 */
export function splitViable(all = []) {
  const viable = all.filter((s) => !s.ruined);
  const excluded = all.filter((s) => s.ruined).map((s) => `${s.symbol}/${s.strategy}`);
  return { used: viable, excluded };
}

/** ロジック集合から「1日あたりの損益率」の束を作る（口座比率の前提は prop.js と同じ）。 */
export async function e8Series({ store, members, days = 700 }) {
  const mdCache = new Map();
  const all = [];
  const detail = [];
  for (const m of members) {
    try {
      let md = mdCache.get(m.symbol);
      if (!md) { md = await fetchMarketData(store, m.symbol, { days }); mdCache.set(m.symbol, md); }
      if (!md.bars || md.bars.length < 250) { detail.push({ ...m, error: 'insufficient_bars', bars: md.bars?.length || 0 }); continue; }
      const cost = { ...DEFAULT_COST_MODEL };
      const fx = await buildCurrencyConverter(store, m.symbol).catch(() => null);
      if (fx) cost.fx = fx;
      const bt = backtest(md.bars, { strategyKey: m.key, params: { ...(m.params || {}), symbol: m.symbol }, cost });
      const rets = dailyReturns(bt.equity);
      const ruined = !!bt.metrics.ruined;
      all.push({ symbol: m.symbol, strategy: m.key, weight: m.weight ?? null, returns: rets, ruined });
      detail.push({
        symbol: m.symbol, key: m.key, label: m.label, from: m.from || null, weight: m.weight ?? null,
        bars: md.bars.length, source: md.source || null, trades: bt.metrics.trades,
        netPct: bt.metrics.netProfitPct, ddMtmPct: bt.metrics.maxDrawdownPctMtm, ruined,
        excludedFromEnsemble: ruined, lastBar: md.bars[md.bars.length - 1].date,
      });
    } catch (e) {
      detail.push({ ...m, error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  const { used, excluded } = splitViable(all);
  return { series: used, all, detail, excluded, degraded: used.length < 3 };
}

// ---------------------------------------------------------------------------
// 1日の処理（prop.js の simulateChallenge / fundedPayouts と同じ式）
// ---------------------------------------------------------------------------
export function e8Floor(state, rules) {
  const initial = state.startBalance;
  // prop.js と同じ: 軌跡が下にあるときは床も下がる（min(peak, initial)）、上げてからは初期残高基準で固定。
  return Math.min(state.peak, initial) - initial * (rules.maxLossPct / 100);
}

export function e8ApplyDay(state, bar, { rules, scale = 1, accountSize = 100000 } = {}) {
  const r = Number(bar.r) * Number(scale || 1);
  const out = { date: bar.date, r: round(r * 100, 4) };
  if (!isFinite(r)) return { ...out, skipped: 'non_finite_return' };
  const initial = state.startBalance;
  const dayStart = state.balance;
  const eq = dayStart * (1 + r);
  const dayLoss = Math.max(0, dayStart - eq);
  const lossBase = state.dailyBase === 'initial' ? initial : dayStart;
  const carried = state.dailyBase === 'initial' ? Math.max(0, dayStart - initial) : 0;
  const allow = lossBase * (rules.dailyLossPct / 100) + carried;
  const floor = e8Floor(state, rules);

  let breached = null;
  if (dayLoss > allow) breached = { type: 'daily_loss', pct: round((dayLoss / dayStart) * 100, 2), limitPct: rules.dailyLossPct };
  else if (eq < floor) breached = { type: 'max_loss', pct: round(((initial - eq) / initial) * 100, 2), floor: round(floor, 2) };

  state.days = (state.days || 0) + 1;
  state.lastBarDate = bar.date;
  state.dayStartEquity = dayStart;
  state.allowToday = round(allow, 2);
  state.floor = round(floor, 2);

  if (breached) {
    // prop.js と同じ扱い: 違反日は残高を進めない（＝その日の損失は反映せず、規約で止められた前提）。
    state.equityAtBreach = round(eq, 2);
    return { ...out, breached, dayPct: round(((eq - dayStart) / dayStart) * 100, 2) };
  }

  if (Math.abs(r) > 1e-12) state.tradingDays = (state.tradingDays || 0) + 1;
  state.balance = eq;
  state.peak = Math.max(state.peak, eq);
  state.equityMtm = round(eq, 2);
  state.pending = [...(state.pending || []), { d: bar.date, p: round(eq - dayStart, 4) }].slice(-90);

  const target = initial * (1 + rules.targetPct / 100);
  state.target = round(target, 2);
  state.progressPct = round(clamp((100 * (state.balance - initial)) / Math.max(1, target - initial), -999, 999), 2);

  // 合格 → 資金提供口座へ
  if (state.status === 'challenge' && state.balance >= target) {
    state.status = 'funded';
    state.fundedAt = bar.date;
    state.payoutBase = state.balance;
    state.pending = [];
    state.fundedBalance = round(state.balance, 2);
    return { ...out, dayPct: round(((eq - dayStart) / dayStart) * 100, 2), passed: true, fundedBalance: round(state.balance, 2) };
  }

  // 資金提供口座: 純益が日次許容の50%を超えたら随時請求できる（40%ベストデイルールを近似で適用）
  if (state.status === 'funded') {
    const profit = state.balance - (state.payoutBase ?? state.balance);
    const need = accountSize * (rules.dailyLossPct / 100) * (rules.minPayoutPctOfDailyDd / 100);
    const gains = (state.pending || []).filter((x) => x.p > 0);
    const sumGains = gains.reduce((s, x) => s + x.p, 0);
    const bestShare = sumGains > 0 ? Math.max(...gains.map((x) => x.p)) / sumGains : 1;
    if (profit >= need && bestShare <= rules.bestDayCapPct / 100) {
      let pay = profit * (rules.splitPct / 100);
      // 請求後も翌日の許容と床を残す（引き出しすぎて翌日に落ちる事故を防ぐ安全側の丸め）
      const keepAbove = e8Floor(state, rules) + dayStart * (rules.dailyLossPct / 100);
      pay = Math.max(0, Math.min(pay, state.balance - keepAbove));
      if (pay > 0) {
        state.payouts = [...(state.payouts || []), { date: bar.date, amount: round(pay, 2), profit: round(profit, 2), balanceBefore: round(state.balance, 2), bestDaySharePct: round(bestShare * 100, 1) }].slice(-40);
        state.balance = state.balance - pay;
        state.payoutBase = state.balance;
        state.pending = [];
        state.totalPaid = round((state.totalPaid || 0) + pay, 2);
        return { ...out, dayPct: round(((eq - dayStart) / dayStart) * 100, 2), payout: round(pay, 2), needsPct: round((need / accountSize) * 100, 2) };
      }
    }
    if (profit > 0) {
      out.payoutWatch = {
        profit: round(profit, 2),
        need: round(need, 2),
        pctOfNeed: round((profit / Math.max(1, need)) * 100, 1),
        bestDaySharePct: round(bestShare * 100, 1),
        blockedBy: bestShare > rules.bestDayCapPct / 100 ? 'best_day_rule' : (profit < need ? 'below_threshold' : null),
      };
    }
  }

  return { ...out, dayPct: round(((eq - dayStart) / dayStart) * 100, 2) };
}

// ---------------------------------------------------------------------------
// 状態の生成・再挑戦
// ---------------------------------------------------------------------------
function blankStats() {
  return { attempts: 0, passed: 0, failed: 0, failReasons: {}, daysToPass: [], fundedDays: 0, totalPaid: 0, startedAt: null, lastAt: null };
}

function newState({ at, rules, accountSize, scale, members, lastBarDate }) {
  return {
    v: E8_VERSION,
    startedAt: at,
    ruleset: { id: rules.id, plan: rules.plan, maxLossPct: rules.maxLossPct, targetPct: rules.targetPct, dailyLossPct: rules.dailyLossPct, splitPct: rules.splitPct, source: rules.source },
    attempt: 1, status: 'challenge',
    accountSize, currency: 'USD', scale,
    startBalance: accountSize, balance: accountSize, peak: accountSize, equityMtm: accountSize,
    dailyBase: rules.dailyBase, maxLossType: rules.maxLossType,
    target: round(accountSize * (1 + rules.targetPct / 100), 2),
    floor: round(accountSize * (1 - rules.maxLossPct / 100), 2),
    progressPct: 0, days: 0, tradingDays: 0,
    lastBarDate: lastBarDate || null, attemptStartedAt: at,
    members: members.map((m) => ({ symbol: m.symbol, key: m.key, label: m.label, from: m.from || null })),
    history: [], events: [], payouts: [], attemptHistory: [], pending: [],
    totalPaid: 0,
  };
}

function newAttempt(prev, { at, rules, accountSize }) {
  return {
    ...prev,
    attempt: Number(prev.attempt || 1) + 1,
    status: 'challenge',
    startBalance: accountSize, balance: accountSize, peak: accountSize, equityMtm: accountSize,
    target: round(accountSize * (1 + rules.targetPct / 100), 2),
    floor: round(accountSize * (1 - rules.maxLossPct / 100), 2),
    progressPct: 0, days: 0, tradingDays: 0,
    attemptStartedAt: at, fundedAt: null, fundedBalance: null, payoutBase: null,
    dayStartEquity: null, allowToday: null, equityAtBreach: null,
    pending: [],
    history: [],
  };
}

// ---------------------------------------------------------------------------
// 1tick — 新しいバーを1日ずつ口座に当てる
// ---------------------------------------------------------------------------
export async function e8Step({
  store, env = {}, now = null, members = null, days = null, applyBackfill = null,
} = {}) {
  const at = now || nowIso();
  const rules = e8Profile(env.E8_PROFILE || 'p10');
  const scale = Math.max(0.05, Math.min(3, Number(env.E8_SCALE || 0.75)));
  const accountSize = Math.max(1000, Number(env.E8_ACCOUNT || 100000));
  const autoRestart = String(env.E8_AUTO_RESTART ?? 'true') !== 'false';
  const backfillDays = applyBackfill == null
    ? Math.max(0, Math.min(500, Number(env.E8_BACKFILL_DAYS ?? 120)))
    : Math.max(0, Number(applyBackfill));

  const mem = members && members.length ? members : await e8Members({ store, env });
  const win = Math.max(300, Math.min(2600, Number(days || env.E8_DAYS || 700)));

  const [stRow, statsRow, evRow] = await Promise.all([
    store.first(`SELECT value FROM settings WHERE key=?`, E8_STATE_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, E8_STATS_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, E8_EVENTS_KEY).catch(() => null),
  ]);
  let state = safeJson(stRow?.value, null);
  const stats = safeJson(statsRow?.value, null) || blankStats();
  const events = safeJson(evRow?.value, null) || [];

  const { series, detail, excluded, degraded } = await e8Series({ store, members: mem, days: win });
  if (!series.length) {
    return { at, ran: 0, error: 'no_series', members: detail, excluded, state_status: state?.status || null };
  }
  const ensemble = ensembleReturns(series);   // 日付で突き合わせ、その日に存在する構成員だけの等加重

  // 初回は直近 backfillDays を再生して現在地を作る（再生であることを状態に残す）
  if (!state || state.v !== E8_VERSION) {
    const start = Math.max(0, ensemble.length - 1 - backfillDays);
    state = newState({ at, rules, accountSize, scale, members: mem, lastBarDate: ensemble[start]?.date || null });
    state.backfill = { bars: Math.max(0, ensemble.length - 1 - start), from: ensemble[start]?.date || null, note: '起動時に直近を再生して現在地を作った（過去の再生であって、未来の実績ではない）' };
    state.attemptStartedAt = at;
  } else {
    // 規格や建玉倍率を変えた場合は、その事実を残して作り直す（黙って設定を差し替えない）
    const changed = state.ruleset?.id !== rules.id || Number(state.scale) !== scale || Number(state.accountSize) !== accountSize;
    if (changed) {
      const note = `設定変更（規格 ${state.ruleset?.id}→${rules.id} / 倍率 ${state.scale}→${scale} / 口座 ${state.accountSize}→${accountSize}）のため新しい口座で開始`;
      events.push({ at, kind: 'reset', note });
      state = newState({ at, rules, accountSize, scale, members: mem, lastBarDate: state.lastBarDate || ensemble[Math.max(0, ensemble.length - 1 - backfillDays)]?.date || null });
      state.attempt = 1;
      state.backfill = { bars: 0, from: state.lastBarDate, note };
    } else {
      state.scale = scale;
      state.members = mem.map((m) => ({ symbol: m.symbol, key: m.key, label: m.label, from: m.from || null }));
    }
  }

  const startIdx = state.lastBarDate ? ensemble.findIndex((d) => d.date > state.lastBarDate) : 0;
  const pending = startIdx >= 0 ? ensemble.slice(startIdx) : [];
  const ran = [];
  let passedNow = 0; let failedNow = 0; let paidNow = 0;

  for (const bar of pending) {
    const res = e8ApplyDay(state, bar, { rules, scale, accountSize });
    if (res.breached) {
      failedNow++;
      stats.attempts = (stats.attempts || 0) + 1;
      stats.failed = (stats.failed || 0) + 1;
      stats.failReasons = stats.failReasons || {};
      stats.failReasons[res.breached.type] = (stats.failReasons[res.breached.type] || 0) + 1;
      const rec = {
        n: state.attempt, outcome: 'failed', reason: res.breached.type, date: bar.date,
        days: state.days, tradingDays: state.tradingDays, peakPct: round(((state.peak - state.startBalance) / state.startBalance) * 100, 2),
      };
      state.attemptHistory = [...(state.attemptHistory || []), rec].slice(-30);
      events.push({ at, kind: 'failed', ...rec, detail: res.breached });
      ran.push({ date: bar.date, dayPct: res.dayPct, status: 'failed', reason: res.breached.type });
      if (!autoRestart) { state.status = 'failed'; break; }
      state = newAttempt(state, { at, rules, accountSize });
      continue;
    }
    if (res.passed) {
      passedNow++;
      stats.passed = (stats.passed || 0) + 1;
      stats.daysToPass = [...(stats.daysToPass || []), state.days].slice(-50);
      events.push({ at, kind: 'passed', date: bar.date, days: state.days, tradingDays: state.tradingDays, balance: round(state.balance, 2), fundedBalance: res.fundedBalance });
    }
    if (res.payout) {
      paidNow++;
      stats.totalPaid = round((stats.totalPaid || 0) + res.payout, 2);
      events.push({ at, kind: 'payout', date: bar.date, amount: res.payout, balance: round(state.balance, 2), needsPct: res.needsPct });
    }
    state.history = [...(state.history || []), {
      date: bar.date, dayPct: res.dayPct, balance: round(state.balance, 2), floor: state.floor,
      target: state.target, status: state.status, attempt: state.attempt,
      payoutWatch: res.payoutWatch || null,
    }].slice(-90);
    ran.push({ date: bar.date, dayPct: res.dayPct, status: state.status, balance: round(state.balance, 2) });
  }

  state.daysTotal = (state.daysTotal || 0) + ran.length;
  state.lastAt = at;
  state.updatedAt = at;
  state.ensembleBasis = { members: series.length, dates: ensemble.length, from: ensemble[0]?.date || null, to: ensemble[ensemble.length - 1]?.date || null, excluded, degraded };
  stats.lastAt = at;
  stats.startedAt = stats.startedAt || at;
  if (state.status === 'funded') stats.fundedDays = (stats.fundedDays || 0) + Math.max(0, ran.length);

  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, E8_STATE_KEY, j(state), at);
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, E8_STATS_KEY, j(stats), at);
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, E8_EVENTS_KEY, j(events.slice(-40)), at);

  return {
    at, ran: ran.length, status: state.status, attempt: state.attempt,
    balance: round(state.balance, 2), progressPct: state.progressPct,
    passed: passedNow, failed: failedNow, payouts: paidNow,
    backfill: ran.length && !state.history?.length ? null : (state.backfill?.bars ? state.backfill.bars : 0),
    lastBarDate: state.lastBarDate,
    members: detail,
    excluded, degraded,
    events: ran.filter((x) => x.status === 'failed' || x.status === 'funded').slice(-5),
  };
}

// ---------------------------------------------------------------------------
// 見せる（エージェントの中・API・チャット）
// ---------------------------------------------------------------------------
export async function e8Status(store, env = {}) {
  const [stRow, statsRow, evRow, colRow] = await Promise.all([
    store.first(`SELECT value FROM settings WHERE key=?`, E8_STATE_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, E8_STATS_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, E8_EVENTS_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key='opt:collection'`).catch(() => null),
  ]);
  const state = safeJson(stRow?.value, null);
  const stats = safeJson(statsRow?.value, null) || blankStats();
  const events = safeJson(evRow?.value, null) || [];
  const collection = safeJson(colRow?.value, null);
  const rules = state?.ruleset || e8Profile(env.E8_PROFILE || 'p10');
  const target = state?.startBalance ? state.startBalance * (1 + rules.targetPct / 100) : null;
  const floor = state ? e8Floor(state, rules) : null;
  const days = stats.daysToPass || [];
  const medianDays = days.length ? [...days].sort((a, b) => a - b)[Math.floor(days.length / 2)] : null;
  const lastHist = (state?.history || []).slice(-30);
  const last = lastHist[lastHist.length - 1] || null;

  return {
    version: E8_VERSION,
    assumption: 'E8 One を「エージェントの中で回す」ための紙上の実行部。日足終値ベース。発注も資金移動もしない。',
    plan: { firm: rules.firm || 'E8 Markets', plan: rules.plan, verified: rules.verified !== false, source: rules.source || null },
    rules,
    config: {
      profile: rules.id || env.E8_PROFILE || 'p10',
      scale: state?.scale ?? Number(env.E8_SCALE || 0.75),
      accountSize: state?.accountSize ?? Number(env.E8_ACCOUNT || 100000),
      enabled: String(env.E8_ENABLED ?? '') === 'true',
      everyMinutes: Number(env.E8_EVERY_MINUTES || 15),
      autoRestart: String(env.E8_AUTO_RESTART ?? 'true') !== 'false',
    },
    state: state ? {
      attempt: state.attempt, status: state.status,
      startBalance: state.startBalance, balance: round(state.balance, 2), peak: round(state.peak, 2),
      equityMtm: state.equityMtm, target: round(target, 2), floor: round(floor, 2),
      progressPct: state.progressPct,
      toTargetPct: round(((target - state.balance) / state.startBalance) * 100, 2),
      toFloorPct: round(((state.balance - floor) / state.startBalance) * 100, 2),
      dayPct: last?.dayPct ?? null,
      days: state.days, tradingDays: state.tradingDays, daysTotal: state.daysTotal || 0,
      lastBarDate: state.lastBarDate, attemptStartedAt: state.attemptStartedAt, fundedAt: state.fundedAt || null,
      fundedBalance: state.fundedBalance || null,
      payoutBase: state.payoutBase ?? null,
      totalPaid: round(state.totalPaid || 0, 2),
      payouts: (state.payouts || []).slice(-10),
      members: state.members || [],
      backfill: state.backfill || null,
      ensembleBasis: state.ensembleBasis || null,
      ensembleExcluded: state.ensembleBasis?.excluded || [],
      ensembleDegraded: state.ensembleBasis?.degraded === true,
    } : null,
    progress: state ? {
      statusJa: state.status === 'challenge' ? `選考${state.attempt}回目` : (state.status === 'funded' ? '資金提供口座' : '失格'),
      targetJa: `残り ${round((target - state.balance) / state.startBalance * 100, 2)}%で合格ライン（目標 +${rules.targetPct}%）`,
      floorJa: `床まで ${round((state.balance - floor) / state.startBalance * 100, 2)}%（全体 ${rules.maxLossPct}% / 日次 ${rules.dailyLossPct}%）`,
      todayAllowJa: state.allowToday != null ? `本日の許容損失 ${state.allowToday}（残高の${rules.dailyLossPct}%）` : null,
    } : null,
    stats: {
      ...stats,
      medianDaysToPass: medianDays,
      attempts: stats.attempts || 0,
      passRatePctMeasured: stats.attempts ? round((100 * (stats.passed || 0)) / stats.attempts, 1) : null,
      failReasons: stats.failReasons || {},
      totalPaidUSD: round(stats.totalPaid || 0, 2),
    },
    history: lastHist,
    events: events.slice(-20),
    collection: collection ? { builtAt: collection.builtAt, gen: collection.gen, members: collection.members?.length || 0, stats: collection.stats || null, maxAbsCorr: collection.maxAbsCorr ?? null } : null,
    expectation: {
      source: 'サンドボックスでの実測（prop.js / POST /api/diag/prop、400経路・口座$100k）',
      note: '参考値: 建玉0.75倍で合格60.0%・中央値82日・合格後 $1,277/月・12ヶ月生存55.5%（最大損失10%選択時）。ここは実際に1本走らせている数字であり、上の参考値とは別物。',
    },
  };
}

export function e8Text(st = {}) {
  const s = st.state || {};
  const L = [];
  L.push(`【E8 One 実行部】${st.plan?.plan || ''}${st.plan?.verified ? '（規格は一次情報で確認済み）' : ''}`);
  if (!s || !s.startBalance) {
    L.push('まだ口座がありません。次のCron（または POST /api/e8）で起動し、直近を再生して現在地を作ります。');
    return L.join('\n');
  }
  L.push(`状態: ${st.progress?.statusJa} / 残高 $${s.balance}（開始 $${s.startBalance} / ピーク $${s.peak}）`);
  L.push(`合格ライン $${s.target}（達成率 ${s.progressPct}%）・床 $${s.floor}`);
  L.push(st.progress?.targetJa || '');
  L.push(st.progress?.floorJa || '');
  if (s.status === 'funded') {
    const paid = (s.payouts || []).reduce((a, p) => a + Number(p.amount || 0), 0);
    L.push(`資金提供口座: 支払い累計 $${round(st.stats?.totalPaidUSD || paid, 2)}（${(s.payouts || []).length}回）`);
  }
  L.push(`日数: 挑戦中 ${s.days}日（累計 ${s.daysTotal}日）・最終バー ${s.lastBarDate}${s.backfill?.bars ? ` / 起動時再生 ${s.backfill.bars}本` : ''}`);
  L.push(`ロジック: ${(s.members || []).map((m) => m.label || `${m.symbol}/${m.key}`).join(' ＋ ')}`);
  const f = st.stats?.failReasons || {};
  const fk = Object.keys(f).map((k) => `${k}:${f[k]}`).join(' ');
  L.push(`通算: 挑戦 ${st.stats?.attempts || 0}回 / 合格 ${st.stats?.passed || 0}回 / 失格 ${st.stats?.failed || 0}回${fk ? `（内訳 ${fk}）` : ''} / 支払い累計 $${st.stats?.totalPaidUSD ?? 0}`);
  if (st.stats?.medianDaysToPass) L.push(`合格までの日数（実測の中央値）: ${st.stats.medianDaysToPass}日`);
  if ((st.events || []).length) {
    L.push('最近の出来事:');
    for (const e of st.events.slice(-6)) L.push(`  ${e.at?.slice(0, 16) || ''} ${e.kind}${e.reason ? `(${e.reason})` : ''}${e.amount ? ` $${e.amount}` : ''}${e.days ? ` ${e.days}日` : ''}`);
  }
  L.push('※ 日足終値ベースの紙上実行。ザラ場の含み損・スワップ・週末窓・約定拒否は含まない。');
  return L.join('\n');
}

export function e8Help() {
  return {
    version: E8_VERSION,
    what: 'E8 One の選考と資金提供口座を、エージェント（Worker）の中で前へ進める実行部。状態は D1 に残る。',
    how: 'Cron（E8_ENABLED=true）が E8_EVERY_MINUTES おきに新しい日足バーを1日ずつ口座に当てる。POST /api/e8 で即時実行。',
    rules: {
      profiles: Object.values(E8_ONE_PROFILES).map((p) => ({ id: p.id, maxLossPct: p.maxLossPct, targetPct: p.targetPct, dailyLossPct: p.dailyLossPct })),
      splitPct: 80,
      payout: '随時請求（純益が日次許容の50%超から）／40%ベストデイルールを近似で適用',
      source: PROP_FIRMS.e8one_10.source,
    },
    params: {
      profile: 'E8_PROFILE（p4/p6/p8/p10/p14、既定 p10）',
      scale: 'E8_SCALE（建玉倍率、既定 0.75。1.0は基準の建玉）',
      accountSize: 'E8_ACCOUNT（既定 100000 USD）',
      days: 'E8_DAYS（データ本数、既定700）',
      logics: 'E8_LOGICS（"USDJPY:donchian_breakout,GOLD:ema_cross"）／未指定なら探索器の集合→既定5本',
      backfill: 'E8_BACKFILL_DAYS（起動時に再生する本数、既定120）',
    },
    endpoints: { get: '/api/e8 （?format=text / ?help=1）', post: '/api/e8 {profile,scale,accountSize,days,reset:true}' },
    honesty: [
      '日足終値ベース。ザラ場の含み損は見ていない（実際の選考はもっと厳しい）。',
      '違反日は残高を進めない（規約で止められた前提）。prop.js の計器と同じ扱い。',
      '実口座の購入（挑戦料の支払い）は人間の操作。ここは紙上。',
    ],
  };
}
