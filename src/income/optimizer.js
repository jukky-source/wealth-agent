// optimizer.js — 「有料のバックテスター」がやっていることを、機能水準から作り直す実行部。
//
// 何を参考にしたか（公開ドキュメントに書かれている機能。内部実装は見ていない）:
//   * EA Studio: 無作為生成 → 遺伝的進化（突然変異・交叉）→ Walk Forward / Monte Carlo / Portfolio
//     https://forexsb.com/wiki/eas-guide/walk-forward
//   * StrategyQuant X: 無作為生成を土台にした遺伝的探索、Builder/Retester の Cross checks（堅牢性検定）、
//     Monte Carlo（取引の並べ替え）、高精度での再検証、相関を見たポートフォリオ
//     https://strategyquant.com/doc/strategyquant/genetic-options/
//     https://strategyquant.com/doc/strategyquant/cross-checks-robustness-tests/
//     https://strategyquant.com/features/
//
// 対応表（向こうの機能 → ここでの実装）:
//   無作為生成（seed固定）           → randomGenome()
//   遺伝的進化（突然変異・交叉）       → mutateGenome() / crossoverGenomes()
//   エリート保存・トーナメント選択      → nextPopulation()
//   In-Sample / Out-of-Sample 分割    → evaluateGenome()（前半70%で作り、後半30%で確かめる）
//   Walk Forward                     → walkForward()（既存）
//   Monte Carlo（取引順序の並べ替え）   → orderRobustness()（既存）
//   高精度での再検証（コスト増し）      → costStress()
//   Cross checks（堅牢性検定11項目）   → deepValidate()（既存 robust.js）
//   ポートフォリオ（相関の低い集合）     → buildCollection()
//   最適な通貨・時間足・論理の集計      → summarizeBoard()
//
// 原価0（無料の日足データ＋自作エンジン）。1tickは少数だけ進め、CPU予算を超えたら次tickへ回す。
// 昇格は既存の fx_strategies 経路（＝EA書き出しの対象）に乗せる。フル検証を通ったときだけ。

import { nowIso, j, safeJson, round, clamp, seededRandom, id as newId } from '../util.js';
import { STRATEGIES, DEFAULT_COST_MODEL, backtest, walkForward, orderRobustness } from './backtest.js';
import { fetchMarketData, buildCurrencyConverter } from './fx.js';
import { deepValidate } from './robust.js';
import { logicPine } from './logic.js';
import { T, ensureLabTable, promote, storeValidation } from './fxLab.js';
import {
  SYMBOLS, coreAt, coreSize, randomRule, materialize, describeLogic, exitParams, logicKey,
  TIMEFRAMES, spaceSize, ruleSize,
} from './grammar.js';

export const OPT_VERSION = 'opt-1.0';
export const OPT_POP_KEY = 'opt:pop';
export const OPT_STATS_KEY = 'opt:stats';
export const OPT_BOARD_KEY = 'opt:board';
export const OPT_CHAMPION_KEY = 'opt:champion';
export const OPT_COLLECTION_KEY = 'opt:collection';
export const OPT_FRONT_KEY = 'opt:front';
export const OPT_LASTVAL_KEY = 'opt:last_validation';

export const OPT_ASSUMPTIONS = [
  '前半70%で作り、後半30%（OOS）で確かめる。OOSの数字を評価に使う（自分の答案を自分で採点しない）。',
  '1tickで進むのは少数。CPU予算を超えたら次tickへ回す（黙って落とさない）。',
  '含まないもの: スワップ、週末の窓、スプレッドの時間帯変動、約定拒否、税。日足のみ（分足は扱わない）。',
  '「最適」は過去データに対する最適であって、未来の保証ではない。だからOOS・Walk Forward・Monte Carlo・コスト増し・フル検証を通す。',
  'フル検証（11項目）を通ったものだけを fx_strategies へ昇格する（＝EA書き出しの対象）。',
];

function coreKeys() { return Object.keys(STRATEGIES).filter((k) => !k.startsWith('g_')); }

// ---------------------------------------------------------------------------
// 遺伝子（＝論理）の正準形。idx は落として「同じ論理は同じ鍵」にする。
// ---------------------------------------------------------------------------
export function canonicalSpec(spec = {}) {
  return {
    v: 1,
    tier: spec.tier || 'core',
    symbol: spec.symbol,
    tf: spec.tf || '1d',
    filter: (spec.base && spec.base.kind === 'rule') ? 'none' : (spec.filter || 'none'),
    exit: spec.exit || 'balanced',
    dir: spec.dir || 'both',
    base: spec.base,
  };
}
export function specKey(spec) { return logicKey(canonicalSpec(spec)); }

/** 人に見せる1行 */
export function genomeLabel(genome) {
  const d = describeLogic(genome.spec);
  return `${genome.spec.symbol} ${d.line}`;
}

// ---------------------------------------------------------------------------
// 生成（random generation）と、進化（突然変異・交叉）
// ---------------------------------------------------------------------------
export function randomGenome(rnd, symbols = SYMBOLS, { preferCore = false, index = null, mutateFrom = null, features = null, gen = 0 } = {}) {
  const wantCore = mutateFrom
    ? (mutateFrom.spec?.tier !== 'rule')
    : (preferCore ? rnd() < 0.7 : rnd() < 0.5);
  let spec;
  if (wantCore) {
    const i = index != null ? index : Math.floor(rnd() * coreSize(symbols));
    spec = coreAt(i, symbols);
  } else {
    spec = randomRule(rnd, symbols, { mutateFrom: mutateFrom?.spec?.tier === 'rule' ? mutateFrom.spec : null, features });
  }
  const cs = canonicalSpec(spec);
  return { key: specKey(cs), spec: cs, origin: mutateFrom ? 'mut' : 'random', gen, parents: mutateFrom ? [mutateFrom.key] : [] };
}

function jitterParams(base, rnd) {
  if (!base || base.kind !== 'strategy' || !base.params) return base;
  const out = { ...base.params };
  for (const k of Object.keys(out)) {
    const v = Number(out[k]);
    if (!isFinite(v)) continue;
    const w = 0.7 + rnd() * 0.6;       // ±30%
    let nv = v * w;
    if (Math.abs(v) >= 5) nv = Math.round(nv); else if (Math.abs(v) >= 1) nv = Math.round(nv * 10) / 10; else nv = Math.round(nv * 100) / 100;
    if (nv !== 0) out[k] = nv;
  }
  return { ...base, params: out };
}

export function mutateGenome(rnd, genome, symbols = SYMBOLS) {
  const s = canonicalSpec(genome.spec);
  const ops = ['param', 'exit', 'filter', 'dir', 'tf', 'symbol', 'base', 'atom'];
  const rounds = 1 + Math.floor(rnd() * 2.4);      // 1〜3個の遺伝子を触る
  const used = [];
  for (let i = 0; i < rounds; i++) {
    const op = ops[Math.floor(rnd() * ops.length)];
    used.push(op);
    if (op === 'param' && s.base?.kind === 'strategy') s.base = jitterParams(s.base, rnd);
    else if (op === 'atom' && s.base?.kind === 'rule') {
      const A = randomRule(rnd, [s.symbol], { mutateFrom: s });
      s.base = A.base;
    } else if (op === 'exit') s.exit = TIMEFRAMES && pickKey(rnd, ['tight', 'balanced', 'wide', 'trail', 'flip', 'timebox'], s.exit);
    else if (op === 'filter') s.filter = (s.base?.kind === 'rule') ? 'none' : pickKey(rnd, ['none', 'trend_up', 'trend_dn', 'adx20', 'adx30', 'vol_low', 'vol_high', 'dow_mon', 'dow_tue', 'dow_wed', 'dow_thu', 'month_turn', 'squeeze'], s.filter);
    else if (op === 'dir') s.dir = pickKey(rnd, ['both', 'long', 'short'], s.dir);
    else if (op === 'tf') s.tf = pickKey(rnd, TIMEFRAMES.map((t) => t.key), s.tf);
    else if (op === 'symbol') s.symbol = pickKey(rnd, symbols, s.symbol);
    else if (op === 'base') {
      if (s.base?.kind === 'rule' || rnd() < 0.3) {
        const spec = randomRule(rnd, [s.symbol], {});
        s.base = spec.base; s.filter = 'none';
      } else {
        const keys = coreKeys();
        s.base = { kind: 'strategy', key: pickKey(rnd, keys, s.base?.key), variant: 0, params: { ...(STRATEGIES[pickKey(rnd, keys, s.base?.key)]?.defaultParams || {}) } };
      }
    }
  }
  const cs = canonicalSpec(s);
  return { key: specKey(cs), spec: cs, origin: 'mut', gen: Number(genome.gen || 0) + 1, parents: [genome.key], ops: used };
}

function pickKey(rnd, arr, avoid) {
  const list = arr.filter((x) => x !== avoid);
  if (!list.length) return avoid;
  return list[Math.floor(rnd() * list.length)];
}

export function crossoverGenomes(rnd, a, b, symbols = SYMBOLS) {
  const sa = canonicalSpec(a.spec); const sb = canonicalSpec(b.spec);
  const ruleBase = rnd() < 0.5 ? sa.base?.kind === 'rule' : sb.base?.kind === 'rule';
  const out = {
    v: 1, tier: ruleBase ? 'rule' : 'core',
    symbol: rnd() < 0.5 ? sa.symbol : sb.symbol,
    tf: rnd() < 0.5 ? sa.tf : sb.tf,
    filter: 'none',
    exit: rnd() < 0.5 ? sa.exit : sb.exit,
    dir: rnd() < 0.5 ? sa.dir : sb.dir,
    base: sa.base?.kind === 'rule' ? (rnd() < 0.5 ? sa.base : sb.base) : (rnd() < 0.5 ? sa.base : sb.base),
  };
  if (out.base?.kind !== 'rule') out.filter = rnd() < 0.5 ? sa.filter : sb.filter;
  const cs = canonicalSpec(out);
  return { key: specKey(cs), spec: cs, origin: 'cross', gen: Math.max(Number(a.gen || 0), Number(b.gen || 0)) + 1, parents: [a.key, b.key] };
}

/** トーナメント選択（向こうの "genetic options" 相当）。 */
export function tournament(rnd, pop, k = 3) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = pop[Math.floor(rnd() * pop.length)];
    if (!c) continue;
    if (!best || Number(c.score || -999) > Number(best.score || -999)) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 評価（IS / OOS 分割 + 硬い門 + 複合点）
// ---------------------------------------------------------------------------
export function evalGates(m = {}, { minTrades = 20, minOosTrades = 8, maxDd = 35, maxOosDd = 40 } = {}) {
  const is = m.is || {}; const oos = m.oos || {};
  const reasons = [];
  if (Number(is.trades || 0) < minTrades) reasons.push(`IS取引が少ない (${is.trades ?? 0} < ${minTrades})`);
  if (Number(oos.trades || 0) < minOosTrades) reasons.push(`OOS取引が少ない (${oos.trades ?? 0} < ${minOosTrades})`);
  if (is.ruined === true) reasons.push('ISで資金が尽きた');
  if (oos.ruined === true) reasons.push('OOSで資金が尽きた');
  const isDd = Number(is.maxDrawdownPctMtm ?? is.maxDrawdownPct ?? 0);
  const oosDd = Number(oos.maxDrawdownPctMtm ?? oos.maxDrawdownPct ?? 0);
  if (isDd > maxDd) reasons.push(`ISのDDが大きい (${round(isDd, 1)}% > ${maxDd}%)`);
  if (oosDd > maxOosDd) reasons.push(`OOSのDDが大きい (${round(oosDd, 1)}% > ${maxOosDd}%)`);
  if (Number(oos.netProfitPct || 0) <= 0) reasons.push(`OOSの純益がプラスでない (${round(Number(oos.netProfitPct || 0), 2)}%)`);
  if (Number(oos.profitFactor || 0) < 1.0) reasons.push(`OOSのPFが1未満 (${round(Number(oos.profitFactor || 0), 2)})`);
  return { pass: reasons.length === 0, reasons };
}

/** 複合点。OOSを主、ISを従にし、「ISでだけ良かった」候補を減点する。 */
export function optScore(m = {}) {
  const is = m.is || {}; const oos = m.oos || {};
  const sOos = clamp(Number(oos.sharpe || 0), -3, 4);
  const sIs = clamp(Number(is.sharpe || 0), -3, 4);
  const ddOos = Math.max(1, Number(oos.maxDrawdownPctMtm ?? oos.maxDrawdownPct ?? 1));
  const retDd = clamp(Number(oos.netProfitPct || 0) / ddOos, -3, 5);
  const pf = clamp(Number(oos.profitFactor || 0), 0, 4);
  const trades = Number(oos.trades || 0);
  const parts = {
    sharpeOos: round(2.0 * (sOos / 3), 4),
    retDdOos: round(1.2 * (retDd / 4), 4),
    pfOos: round(0.6 * (pf / 3), 4),
    sharpeIs: round(0.5 * (sIs / 3), 4),
    stabilityPenalty: round(-0.5 * (Math.abs(sIs - sOos) / 3), 4),
    tradeBonus: round(0.4 * Math.min(1, trades / 25), 4),
  };
  let score = Object.values(parts).reduce((a, b) => a + b, 0);
  const gates = evalGates(m);
  if (!gates.pass) score -= 2 + 0.2 * gates.reasons.length;
  return { score: round(score, 4), gates, parts };
}

function trimMetrics(m = {}) {
  const dd = m.maxDrawdownPctMtm ?? m.maxDrawdownPct ?? null;
  return {
    netProfitPct: m.netProfitPct ?? null, maxDrawdownPct: dd, profitFactor: m.profitFactor ?? null,
    trades: m.trades ?? null, winRate: m.winRate ?? null, sharpe: m.sharpe ?? null,
    expectancy: m.expectancy ?? null, ruined: m.ruined === true ? true : false, ruinDate: m.ruinDate || null,
  };
}

// ---------------------------------------------------------------------------
// 1個体の評価（IS 70% / OOS 30%）。D1 に積む（負けた個体も消さない）。
// ---------------------------------------------------------------------------
export async function evaluateGenome({ store, genome, env = {}, ctx = {}, at = null, gen = 0 } = {}) {
  const now = at || nowIso();
  const mdCache = ctx.mdCache || new Map();
  const fxCache = ctx.fxCache || new Map();
  const oosFrac = clamp(Number(env.OPT_OOS_FRAC || 0.3), 0.15, 0.5);
  const days = Math.max(400, Math.min(2600, Number(env.OPT_DAYS || 1600)));
  const sym = genome.spec.symbol;
  let md = mdCache.get(sym);
  if (!md) { md = await fetchMarketData(store, sym, { days }); mdCache.set(sym, md); }
  if (!md.bars || md.bars.length < 400) return { ...genome, ok: false, error: 'insufficient_market_data', bars: md.bars?.length || 0 };

  const cost = { ...DEFAULT_COST_MODEL };
  let fx = fxCache.get(sym);
  if (fx === undefined) { fx = await buildCurrencyConverter(store, sym).catch(() => null); fxCache.set(sym, fx); }
  if (fx) cost.fx = fx;

  const key = materialize(genome.spec);
  const params = { ...exitParams(genome.spec), logic: genome.spec, symbol: sym, noRuinStop: false };
  const bars = md.bars;
  const cut = Math.max(150, Math.floor(bars.length * (1 - oosFrac)));
  const isBars = bars.slice(0, cut);
  const oosBars = bars.slice(cut);

  const isBt = backtest(isBars, { strategyKey: key, params, cost });
  const oosBt = backtest(oosBars, { strategyKey: key, params, cost });
  const metrics = { is: trimMetrics(isBt.metrics), oos: trimMetrics(oosBt.metrics) };
  const sc = optScore(metrics);
  const enriched = {
    ...genome, ok: true, key, params, score: sc.score, gates: sc.gates, parts: sc.parts, metrics,
    bars: bars.length, isBars: isBars.length, oosBars: oosBars.length, dataFrom: bars[0].date, dataTo: bars[bars.length - 1].date,
    dataSource: md.source || null, evaluatedAt: now, gen,
  };

  await store.insert(T, {
    id: newId('fxl_'), symbol: sym, strategy_key: key, params_json: j(params),
    metrics_json: j({ ...metrics.oos, is: metrics.is, oos: metrics.oos, basis: 'oos', score: sc.score }),
    fitness: sc.score, verdict: sc.gates.pass ? 'pass' : 'fail', gates_json: j(sc.gates.reasons),
    walkforward_json: j({ isBars: isBars.length, oosBars: oosBars.length, oosFrac }),
    parent_id: (genome.parents || [])[0] || null, mutation: (genome.ops || []).join('+') || genome.origin,
    tag: `opt:g${gen}`, bars: bars.length, data_source: md.source || null,
    date_from: bars[0].date, date_to: bars[bars.length - 1].date, promoted: 0, created_at: now,
  }).catch(() => {});

  return enriched;
}

// ---------------------------------------------------------------------------
// 最終候補の検証: Walk Forward → Monte Carlo（取引順序）→ コスト増し → フル検証11項目
// ---------------------------------------------------------------------------
export async function validateFinalist({ store, genome, env = {}, ctx = {}, at = null, budgetMs = 12000 } = {}) {
  const now = at || nowIso();
  const mdCache = ctx.mdCache || new Map();
  const fxCache = ctx.fxCache || new Map();
  const sym = genome.spec.symbol;
  let md = mdCache.get(sym);
  if (!md) { md = await fetchMarketData(store, sym, { days: Math.max(800, Math.min(2600, Number(env.OPT_DAYS || 1600))) }); mdCache.set(sym, md); }
  const cost = { ...DEFAULT_COST_MODEL };
  let fx = fxCache.get(sym);
  if (fx === undefined) { fx = await buildCurrencyConverter(store, sym).catch(() => null); fxCache.set(sym, fx); }
  if (fx) cost.fx = fx;

  const key = genome.key || materialize(genome.spec);
  const params = genome.params || { ...exitParams(genome.spec), logic: genome.spec, symbol: sym };

  const full = backtest(md.bars, { strategyKey: key, params, cost });
  const mc = orderRobustness(full.trades, 300, `opt-${now}-${key}`);
  const wf = walkForward(md.bars, { strategyKey: key, params, cost }, 4);

  // 高精度での再検証: コスト（スプレッド＋スリッページ）を1.5倍にして尚プラスか
  const stressed = {
    ...DEFAULT_COST_MODEL,
    spreadPips: Number(DEFAULT_COST_MODEL.spreadPips || 0.3) * 1.5,
    slippagePips: Number(DEFAULT_COST_MODEL.slippagePips || 0.2) * 1.5,
  };
  if (fx) stressed.fx = fx;
  const stress = backtest(md.bars, { strategyKey: key, params, cost: stressed });
  const costStress = {
    netProfitPct: stress.metrics.netProfitPct, profitFactor: stress.metrics.profitFactor,
    ok: Number(stress.metrics.netProfitPct || 0) > 0 && Number(stress.metrics.profitFactor || 0) >= 1.0,
  };

  const trialCount = Math.max(1, Number((await store.first(`SELECT COUNT(*) AS n FROM ${T} WHERE tag LIKE 'opt:%'`).catch(() => null))?.n || 1));
  const shRows = await store.all(`SELECT metrics_json FROM ${T} WHERE tag LIKE 'opt:%' ORDER BY created_at DESC LIMIT 300`).catch(() => []);
  const trialSharpes = shRows.map((r) => Number(safeJson(r.metrics_json, {})?.oos?.sharpe ?? safeJson(r.metrics_json, {})?.sharpe)).filter((v) => Number.isFinite(v));

  let robust = null;
  try {
    robust = deepValidate(md.bars, {
      symbol: sym, strategyKey: key, params, cost, source: md.source, trials: trialCount, trialSharpes,
      seed: `opt-${now}`, budgetMs,
    });
  } catch (e) { robust = { ok: false, reason: `deep_validate_error: ${String((e && e.message) || e)}` }; }

  const vrow = await storeValidation({ store, symbol: sym, strategyKey: key, params, robust, expId: null, at: now }).catch(() => null);
  const pass = robust?.ok === true && robust.gates?.pass === true
    && wf.consistent === true && costStress.ok === true && Number(mc.probabilityNetNegative ?? 100) <= 15;

  const record = {
    at: now, key, symbol: sym, label: genomeLabel(genome), score: genome.score,
    walkforward: { consistent: wf.consistent, positive: wf.netPositiveFolds, folds: wf.totalFolds, worstPf: wf.worstProfitFactor, medianPf: wf.medianProfitFactor },
    montecarlo: mc, costStress,
    robust: robust ? { ok: robust.ok, pass: robust.gates?.pass === true, score: robust.score ?? null, pbo: robust.cscv?.pbo ?? null, dsr: robust.dsr?.dsr ?? null, randomEntryP: robust.null_test?.p_value ?? null, reasons: (robust.gates?.reasons || []).slice(0, 5), validation_id: vrow?.id || null } : null,
    pass,
  };

  if (pass) {
    let pine = null;
    try {
      pine = genome.spec.base?.kind === 'rule'
        ? logicPine(genome.spec, { ...params, symbol: sym }, { symbol: sym, version: 'v6' })
        : null;
    } catch { pine = null; }
    const prom = await promote({
      store,
      exp: { id: genome.exp_id || null, strategy_key: key, symbol: sym, params_json: j(params), metrics_json: j(genome.metrics?.oos || {}) },
      pine,
      note: `最適化探索（${genome.origin}）から / OOS純益 ${round(Number(genome.metrics?.oos?.netProfitPct || 0), 2)}% / WF ${wf.netPositiveFolds}/${wf.totalFolds} / コスト1.5倍 ${round(Number(costStress.netProfitPct || 0), 2)}% / MC逆転 ${mc.probabilityNetNegative}%`,
    }).catch((e) => ({ error: String((e && e.message) || e) }));
    record.promoted = prom;
  }

  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, OPT_LASTVAL_KEY, j(record), now).catch(() => {});
  return record;
}

// ---------------------------------------------------------------------------
// 相関（ポートフォリオ）。日付で突き合わせる。
// ---------------------------------------------------------------------------
export function pearsonOnDates(a = [], b = []) {
  const ma = new Map(a.map((d) => [d.date, Number(d.r)]));
  const xs = []; const ys = [];
  for (const d of b) {
    const v = ma.get(d.date);
    if (v == null || !isFinite(v) || !isFinite(Number(d.r))) continue;
    xs.push(v); ys.push(Number(d.r));
  }
  if (xs.length < 30) return { r: null, n: xs.length };
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < xs.length; i++) { const u = xs[i] - mx; const v = ys[i] - my; num += u * v; dx += u * u; dy += v * v; }
  if (dx <= 0 || dy <= 0) return { r: 0, n: xs.length };
  return { r: round(num / Math.sqrt(dx * dy), 4), n: xs.length };
}

export function pickUncorrelated(cands = [], { maxMembers = 6, maxCorr = 0.6 } = {}) {
  const sel = [];
  const skipped = [];
  for (const c of cands) {
    let worst = 0; let worstName = null;
    for (const s of sel) {
      const { r } = pearsonOnDates(c.rets, s.rets);
      const abs = r == null ? 0 : Math.abs(r);
      if (abs > worst) { worst = abs; worstName = s.name; }
    }
    if (sel.length && worst >= maxCorr) { skipped.push({ name: c.name, why: 'correlated', withName: worstName, absCorr: round(worst, 3) }); continue; }
    sel.push({ ...c, maxAbsCorrWithSelected: round(worst, 3) });
    if (sel.length >= maxMembers) break;
  }
  return { selected: sel, skipped };
}

export function portfolioStats(members = []) {
  if (!members.length) return null;
  const byDate = new Map();
  for (const m of members) {
    for (const d of m.rets || []) {
      const k = String(d.date).slice(0, 10);
      if (!byDate.has(k)) byDate.set(k, { sum: 0, w: 0 });
      const cell = byDate.get(k);
      cell.sum += Number(d.r) * Number(m.weight || 1);
      cell.w += Number(m.weight || 1);
    }
  }
  const rets = [...byDate.entries()].map(([date, c]) => ({ date, r: c.sum / Math.max(1e-9, c.w) })).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rets.length < 30) return { n: rets.length };
  const arr = rets.map((d) => d.r);
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, arr.length - 1));
  let peak = 1; let eq = 1; let dd = 0;
  for (const r of arr) { eq *= (1 + r); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  return {
    n: rets.length, from: rets[0].date, to: rets[rets.length - 1].date,
    meanDailyPct: round(mean * 100, 4), sdDailyPct: round(sd * 100, 4),
    annSharpe: sd > 0 ? round((mean / sd) * Math.sqrt(252), 2) : null,
    maxDrawdownPct: round(dd * 100, 2), totalReturnPct: round((eq - 1) * 100, 2),
  };
}

// ---------------------------------------------------------------------------
// 相関の低い集合（＝向こうの Portfolio / Collections 相当）を作る
// ---------------------------------------------------------------------------
export async function buildCollection({ store, env = {}, pop = [], ctx = {}, at = null, gen = 0 } = {}) {
  const now = at || nowIso();
  const mdCache = ctx.mdCache || new Map();
  const fxCache = ctx.fxCache || new Map();
  const maxMembers = Math.max(2, Math.min(8, Number(env.OPT_COLLECTION_SIZE || 6)));
  const maxCorr = clamp(Number(env.OPT_MAX_CORR || 0.6), 0.1, 0.95);
  const sorted = [...pop].sort((a, b) => Number(b.score || -999) - Number(a.score || -999));
  const passers = sorted.filter((g) => g.gates?.pass);
  const cands = (passers.length >= 2 ? passers : sorted).slice(0, 12);

  const prepared = [];
  const errors = [];
  for (const g of cands) {
    try {
      const sym = g.spec.symbol;
      let md = mdCache.get(sym);
      if (!md) { md = await fetchMarketData(store, sym, { days: Math.max(600, Math.min(2600, Number(env.OPT_DAYS || 1600))) }); mdCache.set(sym, md); }
      const cost = { ...DEFAULT_COST_MODEL };
      let fx = fxCache.get(sym);
      if (fx === undefined) { fx = await buildCurrencyConverter(store, sym).catch(() => null); fxCache.set(sym, fx); }
      if (fx) cost.fx = fx;
      const key = materialize(g.spec);
      const bt = backtest(md.bars, { strategyKey: key, params: { ...exitParams(g.spec), logic: g.spec, symbol: sym }, cost });
      const clean = (bt.equity || []).slice(1).map((e, i) => {
        const prev = bt.equity[i];
        const a = Number(prev.equityMtm ?? prev.equity); const b = Number(e.equityMtm ?? e.equity);
        return a > 0 ? { date: e.date, r: (b - a) / a } : null;
      }).filter((x) => x && isFinite(x.r));
      prepared.push({
        name: `${sym} ${describeLogic(g.spec).line}`.slice(0, 90),
        symbol: sym, key, params: { ...exitParams(g.spec), logic: g.spec, symbol: sym },
        label: `${sym} / ${describeLogic(g.spec).base.slice(0, 46)} / ${g.spec.tf} / ${g.spec.exit}`,
        score: g.score, gates: g.gates, metrics: g.metrics, origin: g.origin,
        rets: clean,
      });
    } catch (e) {
      errors.push({ key: g.key, symbol: g.spec?.symbol, error: String((e && e.message) || e).slice(0, 160) });
    }
  }

  const { selected, skipped } = pickUncorrelated(prepared, { maxMembers, maxCorr });
  // 重み: 逆ボラ（ばらつきの小さいものに厚く）
  const vols = selected.map((m) => {
    const arr = m.rets.map((d) => d.r);
    const mean = arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
    return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, arr.length - 1)) || 1e-6;
  });
  const invSum = vols.reduce((s, v) => s + 1 / v, 0) || 1;
  const members = selected.map((m, i) => ({
    symbol: m.symbol, key: m.key, params: m.params, label: m.label, score: m.score, origin: m.origin,
    weight: round((1 / vols[i]) / invSum, 4), sdDailyPct: round(vols[i] * 100, 4),
    oosNetPct: m.metrics?.oos?.netProfitPct ?? null, oosDdPct: m.metrics?.oos?.maxDrawdownPct ?? null,
    maxAbsCorrWithSelected: m.maxAbsCorrWithSelected,
  }));
  const stats = portfolioStats(members.map((m, i) => ({ weight: m.weight, rets: selected[i].rets })));
  const out = {
    v: OPT_VERSION, builtAt: now, gen, maxCorr, members, stats,
    skipped, errors, candidates: prepared.length,
    note: 'スコア上位から、互いの日次損益率の相関が閾値未満のものを貪欲に選んだ集合（＝有料ツールの「ポートフォリオ／コレクション」相当）。重みは逆ボラ。この集合がE8実行部のロジックになる。',
  };
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, OPT_COLLECTION_KEY, j(out), now).catch(() => {});
  return out;
}
function arr0() { return 0; }
void arr0;

// ---------------------------------------------------------------------------
// 集計: どの通貨・どの時間足・どの論理が良かったか（D1の蓄積から）
// ---------------------------------------------------------------------------
export async function summarizeBoard(store, { limit = 1500 } = {}) {
  const rows = await store.all(`SELECT symbol, strategy_key, params_json, metrics_json, fitness, tag, created_at FROM ${T} WHERE tag LIKE 'opt:%' ORDER BY fitness DESC LIMIT ${Math.max(50, Math.min(4000, limit))}`).catch(() => []);
  const acc = { bySymbol: {}, byTimeframe: {}, byLogic: {}, byExit: {}, byDirection: {}, byKind: {} };
  const put = (obj, name, item) => {
    if (!name) return;
    const cur = obj[name] || { n: 0, sum: 0, best: -1e9, bestItem: null };
    cur.n += 1; cur.sum += Number(item.score || 0);
    if (Number(item.score || 0) > cur.best) { cur.best = Number(item.score || 0); cur.bestItem = item; }
    obj[name] = cur;
  };
  for (const r of rows) {
    const params = safeJson(r.params_json, {}) || {};
    const logic = params.logic || null;
    const m = safeJson(r.metrics_json, {}) || {};
    const oos = m.oos || m;
    const item = {
      symbol: r.symbol, key: r.strategy_key, tf: logic?.tf || '1d',
      exit: logic?.exit || null, dir: logic?.dir || null, filter: logic?.filter || null,
      kind: logic?.base?.kind || 'strategy', base: logic?.base?.key || r.strategy_key,
      score: round(Number(r.fitness || 0), 4),
      netPct: oos.netProfitPct ?? null, ddPct: oos.maxDrawdownPct ?? null,
      pf: oos.profitFactor ?? null, trades: oos.trades ?? null, sharpe: oos.sharpe ?? null,
      tag: r.tag, at: r.created_at,
    };
    put(acc.bySymbol, item.symbol, item);
    put(acc.byTimeframe, item.tf, item);
    put(acc.byLogic, item.base, item);
    put(acc.byExit, item.exit, item);
    put(acc.byDirection, item.dir, item);
    put(acc.byKind, item.kind, item);
  }
  const top = (o, k = 8) => Object.entries(o).map(([name, v]) => ({
    name, n: v.n, best: round(v.best, 4), avg: round(v.sum / Math.max(1, v.n), 4), bestItem: v.bestItem,
  })).sort((a, b) => b.best - a.best).slice(0, k);
  const best = rows[0] ? {
    symbol: rows[0].symbol, key: rows[0].strategy_key, score: round(Number(rows[0].fitness || 0), 4),
    tag: rows[0].tag, params: safeJson(rows[0].params_json, {}), metrics: safeJson(rows[0].metrics_json, {}),
  } : null;
  const out = {
    evaluated: rows.length, generatedAt: nowIso(), best,
    bySymbol: top(acc.bySymbol), byTimeframe: top(acc.byTimeframe, 4), byLogic: top(acc.byLogic),
    byExit: top(acc.byExit), byDirection: top(acc.byDirection, 4), byKind: top(acc.byKind, 3),
    note: 'D1に積んだ最適化の試行（tag=opt:%）を、通貨・時間足・論理・出口・方向で集計したもの。点はOOS基準の複合点。件数が少ないうちは参考値。',
  };
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, OPT_BOARD_KEY, j(out), out.generatedAt).catch(() => {});
  return out;
}

// ---------------------------------------------------------------------------
// 支配関係（パレート前線）: OOS純益は大きいほど、OOSのDDは小さいほど良い
// ---------------------------------------------------------------------------
export function isDominated(a, b) {
  const na = Number(a?.metrics?.oos?.netProfitPct ?? -1e9); const nb = Number(b?.metrics?.oos?.netProfitPct ?? -1e9);
  const da = Number(a?.metrics?.oos?.maxDrawdownPct ?? 1e9); const db = Number(b?.metrics?.oos?.maxDrawdownPct ?? 1e9);
  const sa = Number(a?.metrics?.oos?.sharpe ?? -1e9); const sb = Number(b?.metrics?.oos?.sharpe ?? -1e9);
  const betterOrEqual = nb >= na && db <= da && sb >= sa;
  const strictly = nb > na || db < da || sb > sa;
  return betterOrEqual && strictly;
}
export function paretoFront(list = [], k = 8) {
  const out = [];
  for (const a of list) {
    if (!list.some((b) => b !== a && isDominated(a, b))) out.push(a);
  }
  return out.sort((x, y) => Number(y.score || 0) - Number(x.score || 0)).slice(0, k);
}

// ---------------------------------------------------------------------------
// 1tick — 世代を1つ進める
// ---------------------------------------------------------------------------
export async function optTick({ store, env = {}, n = 2, budgetMs = null, now = null } = {}) {
  const at = now || nowIso();
  await ensureLabTable(store);
  const t0 = Date.now();
  const budget = Math.max(4000, Number(budgetMs || env.OPT_BUDGET_MS || 20000));
  const popSize = Math.max(8, Math.min(80, Number(env.OPT_POP || 40)));
  const seedSize = Math.max(4, Math.min(popSize, Number(env.OPT_SEED || 24)));
  const deepLimit = Math.max(0, Number(env.OPT_DEEP_PER_TICK ?? 1));
  const collectionEvery = Math.max(1, Number(env.OPT_COLLECTION_EVERY || 3));

  const [stRow, popRow, chRow] = await Promise.all([
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_STATS_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_POP_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_CHAMPION_KEY).catch(() => null),
  ]);
  const stats = safeJson(stRow?.value, null) || { gen: 0, evaluated: 0, startedAt: at, lastAt: null };
  let pop = safeJson(popRow?.value, null) || [];
  let champion = safeJson(chRow?.value, null);
  const seen = new Set(pop.map((g) => g.key));
  const rnd = seededRandom(`opt-${at}-${stats.gen}-${stats.evaluated}`);
  const symbols = (env.OPT_SYMBOLS ? String(env.OPT_SYMBOLS).split(',').map((s) => s.trim().toUpperCase()).filter((s) => SYMBOLS.includes(s)) : SYMBOLS);
  const ctx = { mdCache: new Map(), fxCache: new Map() };

  const report = {
    at, gen: stats.gen, ran: 0, evaluated: stats.evaluated, experiments: [], budget_exhausted: false,
    pop: pop.length, mode: pop.length < seedSize ? 'seeding' : 'evolving', deep: null, collection: null, board: null, champion: null,
  };

  // 何を評価するか: 母集団が薄ければ無作為生成（探索の種まき）、厚ければ進化
  const todo = [];
  if (pop.length < seedSize) {
    const k = Math.max(1, Math.min(n, seedSize - pop.length));
    for (let i = 0; i < k; i++) todo.push(randomGenome(rnd, symbols, { preferCore: rnd() < 0.6, index: stats.evaluated + i, gen: stats.gen }));
  } else {
    for (let i = 0; i < Math.max(1, n); i++) {
      const a = tournament(rnd, pop, 3); const b = tournament(rnd, pop, 3);
      const roll = rnd();
      let child;
      if (!a) child = randomGenome(rnd, symbols, { preferCore: true, gen: stats.gen });
      else if (roll < 0.35 && b && b.key !== a.key) child = crossoverGenomes(rnd, a, b, symbols);
      else if (roll < 0.9) child = mutateGenome(rnd, a, symbols);
      else child = randomGenome(rnd, symbols, { preferCore: rnd() < 0.5, gen: stats.gen });   // 無作為生成も混ぜる（局所解から出る）
      child.gen = stats.gen;
      todo.push(child);
    }
  }

  for (const g of todo) {
    if (Date.now() - t0 > budget) { report.budget_exhausted = true; report.budget_note = `CPU予算 ${budget}ms を使い切ったため、残りは次tickへ`; break; }
    if (seen.has(g.key)) continue;
    seen.add(g.key);
    let ev;
    try { ev = await evaluateGenome({ store, genome: g, env, ctx, at, gen: stats.gen }); } catch (e) {
      report.experiments.push({ key: g.key, error: String((e && e.message) || e).slice(0, 120) });
      continue;
    }
    stats.evaluated = Number(stats.evaluated || 0) + 1;
    if (!ev.ok) { report.experiments.push({ key: g.key, error: ev.error }); continue; }
    report.ran++;
    pop.push(ev);
    report.experiments.push({
      key: ev.key, symbol: ev.spec.symbol, tf: ev.spec.tf, origin: ev.origin, score: ev.score,
      pass: ev.gates.pass, oosNet: ev.metrics.oos.netProfitPct, oosDd: ev.metrics.oos.maxDrawdownPct,
      oosPf: ev.metrics.oos.profitFactor, oosTrades: ev.metrics.oos.trades, gates: ev.gates.reasons.slice(0, 3),
    });
  }

  // 選抜（エリート保存）
  pop.sort((a, b) => Number(b.score || -1e9) - Number(a.score || -1e9));
  pop = pop.slice(0, popSize);
  const front = paretoFront(pop, 8);

  // 王者の検証と昇格（1tickで最大 deepLimit 件）
  const top = pop.find((g) => g.gates?.pass);
  if (top && deepLimit > 0 && (!champion || Number(top.score || 0) > Number(champion.score || 0) * 1.02)) {
    const rec = await validateFinalist({ store, genome: top, env, ctx, at, budgetMs: Number(env.OPT_DEEP_BUDGET_MS || 12000) }).catch((e) => ({ pass: false, error: String((e && e.message) || e) }));
    report.deep = rec;
    if (rec.pass) {
      champion = {
        at, gen: stats.gen, key: top.key, symbol: top.spec.symbol, tf: top.spec.tf, exit: top.spec.exit, dir: top.spec.dir,
        score: top.score, gates: top.gates, metrics: top.metrics, spec: top.spec, params: top.params, label: genomeLabel(top),
        walkforward: rec.walkforward, montecarlo: rec.montecarlo, costStress: rec.costStress, robust: rec.robust,
        promoted_to: rec.promoted?.id || null, promoted_name: rec.promoted?.name || null,
      };
      await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, OPT_CHAMPION_KEY, j(champion), at).catch(() => {});
    }
  } else if (top && deepLimit === 0) {
    report.deep = { skipped: 'デプス検証の上限（1tickあたり0件）に設定されている' };
  }

  // 世代を進め、集計し、相関の低い集合をときどき作り直す
  stats.gen = Number(stats.gen || 0) + 1;
  stats.lastAt = at;
  stats.pop = pop.length;
  stats.best = pop[0] ? { key: pop[0].key, symbol: pop[0].spec?.symbol, score: pop[0].score } : null;
  report.gen = stats.gen;
  report.evaluated = stats.evaluated;

  const board = await summarizeBoard(store).catch(() => null);
  report.board = board ? { evaluated: board.evaluated, bestSymbol: board.bySymbol?.[0]?.name || null, bestTf: board.byTimeframe?.[0]?.name || null, bestLogic: board.byLogic?.[0]?.name || null } : null;

  if (stats.gen % collectionEvery === 0 || !(safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, OPT_COLLECTION_KEY).catch(() => null))?.value, null))) {
    const col = await buildCollection({ store, env, pop, ctx, at, gen: stats.gen }).catch((e) => ({ error: String((e && e.message) || e) }));
    report.collection = col && !col.error ? { members: col.members.length, stats: col.stats, maxCorr: col.maxCorr, skipped: col.skipped.length } : { error: col?.error || 'unknown' };
  }

  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, OPT_POP_KEY, j(pop), at).catch(() => {});
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, OPT_FRONT_KEY, j(front.map((f) => ({ key: f.key, symbol: f.spec?.symbol, tf: f.spec?.tf, score: f.score, oosNet: f.metrics?.oos?.netProfitPct, oosDd: f.metrics?.oos?.maxDrawdownPct, sharpe: f.metrics?.oos?.sharpe }))), at).catch(() => {});
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, OPT_STATS_KEY, j(stats), at).catch(() => {});

  report.best = pop[0] ? { symbol: pop[0].spec.symbol, tf: pop[0].spec.tf, score: pop[0].score, label: genomeLabel(pop[0]) } : null;
  report.champion = champion ? { symbol: champion.symbol, tf: champion.tf, score: champion.score, label: champion.label } : null;
  report.pop = pop.length;
  return report;
}

// ---------------------------------------------------------------------------
// 見せる（エージェントの中・API・チャット）
// ---------------------------------------------------------------------------
export function optSearchPlan(env = {}) {
  const per = Math.max(1, Number(env.OPT_PER_TICK || 2));
  const every = Math.max(5, Number(env.OPT_EVERY_MINUTES || 15));
  const perDay = per * Math.floor((24 * 60) / every);
  const space = spaceSize(SYMBOLS);
  const core = coreSize();
  const rule = ruleSize();
  return {
    space_size: space, core_size: core, rule_size: rule,
    per_tick: per, every_minutes: every, per_day: perDay,
    note: `1tick ${per}個体・${every}分間隔なら1日 ${perDay}個体。空間は ${space.toLocaleString('en-US')} 通り（コア ${core.toLocaleString('en-US')} ＋合成 ${rule.toLocaleString('en-US')}）で全列挙はしない。`
      + '無作為生成で種をまき、良い個体の近傍を変異・交叉させて世代を進める（有料ツールの遺伝的探索と同じ考え方）。原価0。',
  };
}

export async function optStatus(store, env = {}) {
  const [stRow, popRow, chRow, colRow, boardRow, valRow, frontRow] = await Promise.all([
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_STATS_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_POP_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_CHAMPION_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_COLLECTION_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_BOARD_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_LASTVAL_KEY).catch(() => null),
    store.first(`SELECT value FROM settings WHERE key=?`, OPT_FRONT_KEY).catch(() => null),
  ]);
  const stats = safeJson(stRow?.value, null) || { gen: 0, evaluated: 0 };
  const pop = safeJson(popRow?.value, null) || [];
  const champion = safeJson(chRow?.value, null);
  const collection = safeJson(colRow?.value, null);
  const board = safeJson(boardRow?.value, null);
  const lastValidation = safeJson(valRow?.value, null);
  const front = safeJson(frontRow?.value, null) || [];
  const top = [...pop].sort((a, b) => Number(b.score || -1e9) - Number(a.score || -1e9)).slice(0, 10).map((g) => ({
    key: g.key, symbol: g.spec?.symbol, tf: g.spec?.tf, exit: g.spec?.exit, dir: g.spec?.dir,
    kind: g.spec?.base?.kind, base: g.spec?.base?.key, origin: g.origin, gen: g.gen, score: g.score,
    pass: g.gates?.pass === true, gates: (g.gates?.reasons || []).slice(0, 3),
    oosNetPct: g.metrics?.oos?.netProfitPct ?? null, oosDdPct: g.metrics?.oos?.maxDrawdownPct ?? null,
    oosPf: g.metrics?.oos?.profitFactor ?? null, oosTrades: g.metrics?.oos?.trades ?? null,
    sharpe: g.metrics?.oos?.sharpe ?? null, label: g.spec ? genomeLabel(g) : null,
  }));

  return {
    version: OPT_VERSION,
    assumption: '有料のバックテスター（EA Studio / StrategyQuant X）の公開機能を、機能水準で作り直したもの。中身のコードは見ていない。過去データに対する最適であって、未来の保証ではない。',
    plan: optSearchPlan(env),
    config: {
      enabled: String(env.OPT_ENABLED ?? '') === 'true',
      everyMinutes: Number(env.OPT_EVERY_MINUTES || 15),
      perTick: Number(env.OPT_PER_TICK || 2),
      pop: Number(env.OPT_POP || 40),
      oosFrac: Number(env.OPT_OOS_FRAC || 0.3),
      maxCorr: Number(env.OPT_MAX_CORR || 0.6),
      deepPerTick: Number(env.OPT_DEEP_PER_TICK ?? 1),
    },
    stats: { gen: stats.gen || 0, evaluated: stats.evaluated || 0, pop: pop.length, startedAt: stats.startedAt || null, lastAt: stats.lastAt || null, best: stats.best || null },
    top,
    front,
    champion: champion ? {
      at: champion.at, symbol: champion.symbol, tf: champion.tf, exit: champion.exit, dir: champion.dir, score: champion.score,
      label: champion.label, metrics: champion.metrics, walkforward: champion.walkforward, montecarlo: champion.montecarlo,
      costStress: champion.costStress, robust: champion.robust, promoted_to: champion.promoted_to, promoted_name: champion.promoted_name,
    } : null,
    lastValidation,
    collection: collection ? {
      builtAt: collection.builtAt, gen: collection.gen, maxCorr: collection.maxCorr, stats: collection.stats,
      members: (collection.members || []).map((m) => ({ label: m.label, weight: m.weight, score: m.score, sdDailyPct: m.sdDailyPct, oosNetPct: m.oosNetPct, oosDdPct: m.oosDdPct, maxAbsCorrWithSelected: m.maxAbsCorrWithSelected })),
      skipped: collection.skipped || [], note: collection.note,
      feedsE8: true,
    } : null,
    board,
    featureMap: [
      ['無作為生成（seed固定）', 'randomGenome()', 'done'],
      ['遺伝的進化（突然変異・交叉）', 'mutateGenome() / crossoverGenomes()', 'done'],
      ['エリート保存・トーナメント選択', 'nextPopulation（optTick内）', 'done'],
      ['In-Sample / Out-of-Sample 分割', 'evaluateGenome()（70/30）', 'done'],
      ['Walk Forward', 'walkForward()', 'done'],
      ['Monte Carlo（取引順序の並べ替え）', 'orderRobustness()', 'done'],
      ['高精度での再検証（コスト増し）', 'costStress()（スプレッド・スリッページ1.5倍）', 'done'],
      ['Cross checks（堅牢性検定11項目）', 'deepValidate()', 'done'],
      ['ポートフォリオ（相関の低い集合）', 'buildCollection()', 'done'],
      ['最適な通貨・時間足・論理の集計', 'summarizeBoard()', 'done'],
      ['分足・複数同時保有・自動売買の発注', '意図的に未実装（日足・同時1ポジション・発注しない）', 'not_planned'],
    ],
    honesty: OPT_ASSUMPTIONS,
  };
}

export function optText(st = {}) {
  const L = [];
  L.push(`【最適ロジック探索】${st.stats?.gen ?? 0}世代 / 評価 ${st.stats?.evaluated ?? 0}個体 / 母集団 ${st.stats?.pop ?? 0}`);
  L.push(st.plan?.note || '');
  const ch = st.champion;
  L.push(ch
    ? `いまの最良（フル検証通過）: ${ch.symbol} / ${ch.tf} / スコア ${ch.score} — ${ch.promoted_name ? `EA候補として昇格済（${ch.promoted_name}）` : '昇格は未了'}`
    : 'いまの最良: まだフル検証を通った個体がありません（門を通った個体だけが王者になります）');
  const b = st.board;
  if (b && b.evaluated) {
    L.push('');
    L.push(`―― 蓄積した試行 ${b.evaluated} 件の集計 ――`);
    if (b.bySymbol?.length) L.push(`通貨: ${b.bySymbol.slice(0, 4).map((x) => `${x.name}(最良${x.best})`).join(' / ')}`);
    if (b.byTimeframe?.length) L.push(`時間足: ${b.byTimeframe.map((x) => `${x.name}(最良${x.best}, ${x.n}件)`).join(' / ')}`);
    if (b.byLogic?.length) L.push(`論理: ${b.byLogic.slice(0, 5).map((x) => `${x.name}(最良${x.best})`).join(' / ')}`);
    if (b.byExit?.length) L.push(`出口: ${b.byExit.slice(0, 4).map((x) => `${x.name}(最良${x.best})`).join(' / ')}`);
  }
  if (st.collection) {
    L.push('');
    L.push(`―― 相関の低い集合（E8実行部のロジックになる）――`);
    L.push(`集合の統計: 年率シャープ ${st.collection.stats?.annSharpe ?? 'n/a'} / 日次平均 ${st.collection.stats?.meanDailyPct ?? 'n/a'}% / 最大DD ${st.collection.stats?.maxDrawdownPct ?? 'n/a'}% / 期間 ${st.collection.stats?.from || '?'}〜${st.collection.stats?.to || '?'}`);
    for (const m of st.collection.members || []) L.push(`  ${m.weight} × ${m.label}（OOS ${m.oosNetPct}% / DD ${m.oosDdPct}% / 相関 ${m.maxAbsCorrWithSelected}）`);
  }
  if (st.top?.length) {
    L.push('');
    L.push('上位個体:');
    for (const g of st.top.slice(0, 5)) L.push(`  ${g.score} ${g.symbol} ${g.tf} ${g.kind === 'rule' ? '合成' : g.base} ${g.exit} 出口 — OOS純益 ${g.oosNetPct}% / DD ${g.oosDdPct}% / PF ${g.oosPf} / ${g.oosTrades}取引${g.pass ? '' : '（門: ' + g.gates.join('; ') + '）'}`);
  }
  L.push('');
  L.push('※ 1tickで数個体ずつ。CPU予算を超えた分は次tickへ回します。昇格はフル検証（11項目）を通ったときだけ。');
  return L.join('\n');
}

export function optHelp() {
  return {
    version: OPT_VERSION,
    what: '最適なロジック・時間足・通貨を、エージェントの中で探し続ける実行部（遺伝的探索）。結果はD1に残り、相関の低い集合がE8実行部のロジックになる。',
    how: 'Cron（OPT_ENABLED=true）が OPT_EVERY_MINUTES おきに OPT_PER_TICK 個体を評価。POST /api/opt で即時実行（{n} で個数、{reset:true} で初期化）。',
    features: {
      generation: '無作為生成（seed固定）→ 突然変異・交叉 → エリート保存',
      validation: 'IS/OOS分割(70/30) → Walk Forward(4分割) → Monte Carlo(取引順序300回) → コスト1.5倍で再検証 → フル検証11項目',
      promotion: 'フル検証を通った個体だけ fx_strategies へ昇格（＝EA書き出しの対象）',
      portfolio: '相関の低い集合（逆ボラ重み）を作り、E8実行部の入力にする',
      board: '通貨・時間足・論理・出口・方向ごとの最良を集計（/api/opt?view=board）',
    },
    params: {
      perTick: 'OPT_PER_TICK（既定2）', pop: 'OPT_POP（既定40）', oosFrac: 'OPT_OOS_FRAC（既定0.3）',
      maxCorr: 'OPT_MAX_CORR（既定0.6）', size: 'OPT_COLLECTION_SIZE（既定6）',
      deep: 'OPT_DEEP_PER_TICK（既定1）', collectionEvery: 'OPT_COLLECTION_EVERY（既定3世代）',
    },
    endpoints: { get: '/api/opt （?format=text / ?help=1 / ?view=board / ?view=collection）', post: '/api/opt {n,reset}' },
    honesty: OPT_ASSUMPTIONS,
  };
}
