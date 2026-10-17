// FX Lab — 「ここで完成させる」のではなく、エージェントに試行錯誤を回させ続けるループ。
//
// 設計の考え方:
//   * 1回で答えを出すのではなく、1tickにつき少数の実験を回し、結果をD1に積む。
//     tickは Cloudflare の Cron Trigger から呼ばれるので、サンドボックスが消えても残る。
//   * 探索と活用を交互に行う（explore はグリッドから無作為、exploit は現王者の近傍を変異）。
//   * 原価0 — 使うデータは無料・鍵不要（Yahoo Finance / ECB Frankfurter）だけで、
//     有料のAPIは呼ばない。バックテストは決定論的な自作エンジン。
//   * 負けた実験も必ず残す。失敗の記録が「次に試さないこと」を決める。
//   * 勝った候補（門を通過し、かつ現王者を上回ったもの）だけを fx_strategies へ昇格させ、
//     既存の Pine / MQL5 書き出しの流れに乗せる。EAはここから出てくる。
//
// CPU予算を守るための線引き: 通常の実験は backtest 1回だけ。昇格候補にだけ
// walkForward（4フォルダ）を追加で走らせて頑健性を確認する。

import { id as newId, nowIso, j, safeJson, round, seededRandom, truncate } from '../util.js';
import { backtest, walkForward, STRATEGIES, DEFAULT_COST_MODEL, PAIRS } from './backtest.js';
import { fetchMarketData, buildCurrencyConverter } from './fx.js';
import { deepValidate } from './robust.js';
import { generatePine, lintPine } from './pine.js';

export const T = 'fx_experiments';
export const LAB_SYMBOLS = Object.keys(PAIRS);
export const LAB_STRATEGIES = Object.keys(STRATEGIES);
export const CHAMPION_KEY = 'fxlab:champion';
export const STATS_KEY = 'fxlab:stats';

// ---------------------------------------------------------------------------
// 実験の置き場（D1）。既存の fx_strategies / fx_backtests とは別に、
// 「試行錯誤の記録」を専門に持つ。負けた実験も消さない。
// ---------------------------------------------------------------------------
export async function ensureLabTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${T} (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, strategy_key TEXT NOT NULL,
    params_json TEXT, metrics_json TEXT, fitness REAL DEFAULT 0,
    verdict TEXT DEFAULT 'fail', gates_json TEXT DEFAULT '[]',
    walkforward_json TEXT, parent_id TEXT, mutation TEXT, tag TEXT,
    bars INTEGER, data_source TEXT, date_from TEXT, date_to TEXT,
    promoted INTEGER DEFAULT 0, created_at TEXT NOT NULL
  )`).catch(() => {});
  await store.run(`CREATE INDEX IF NOT EXISTS ${T}_score ON ${T}(fitness DESC)`).catch(() => {});
  await store.run(`CREATE INDEX IF NOT EXISTS ${T}_combo ON ${T}(symbol, strategy_key)`).catch(() => {});
}

// ---------------------------------------------------------------------------
// 探索空間 — STRATEGIES[key].grid がそのまま探索範囲。推測で範囲を広げない。
// ---------------------------------------------------------------------------
export function candidateFromGrid(strategyKey, rnd) {
  const s = STRATEGIES[strategyKey];
  if (!s) return null;
  const p = { ...s.defaultParams };
  for (const [k, vals] of Object.entries(s.grid || {})) {
    if (Array.isArray(vals) && vals.length) p[k] = vals[Math.floor(rnd() * vals.length)];
  }
  p.atrStopMult = round(1.2 + rnd() * 2.6, 1);
  if (rnd() < 0.25) p.allowShort = !p.allowShort;
  return sanitize(strategyKey, p);
}

export function mutate(strategyKey, params = {}, rnd, strength = 1) {
  const s = STRATEGIES[strategyKey];
  if (!s) return null;
  const p = { ...s.defaultParams, ...params };
  const gridKeys = Object.keys(s.grid || {});
  for (let i = 0; i < strength; i++) {
    if (gridKeys.length && rnd() < 0.8) {
      const k = gridKeys[Math.floor(rnd() * gridKeys.length)];
      const vals = s.grid[k];
      if (Array.isArray(vals) && vals.length) p[k] = vals[Math.floor(rnd() * vals.length)];
    } else {
      p.atrStopMult = round(Math.max(1.0, Math.min(4.0, Number(p.atrStopMult || 2) + (rnd() - 0.5) * 0.8)), 1);
    }
  }
  if (rnd() < 0.15) p.allowShort = !p.allowShort;
  return sanitize(strategyKey, p);
}

/** パラメータの整合を取る（不正な組は捨てずに直す＝実験を無駄にしない）。 */
export function sanitize(strategyKey, params = {}) {
  const s = STRATEGIES[strategyKey];
  if (!s) return params;
  const p = { ...s.defaultParams, ...params };
  if (p.fast != null && p.slow != null && Number(p.fast) >= Number(p.slow)) {
    p.fast = Array.isArray(s.grid?.fast) ? s.grid.fast[0] : 12;
    p.slow = Array.isArray(s.grid?.slow) ? s.grid.slow[s.grid.slow.length - 1] : 48;
  }
  if (p.trendFilter != null && p.slow != null && Number(p.trendFilter) <= Number(p.slow)) p.trendFilter = Number(p.slow) + 50;
  if (p.oversold != null && p.exitLevel != null && Number(p.oversold) >= Number(p.exitLevel) - 5) {
    p.oversold = Math.max(20, Number(p.exitLevel) - 15);
  }
  if (p.oversold != null) p.oversold = Math.max(15, Math.min(40, Number(p.oversold)));
  if (p.overbought != null) p.overbought = Math.min(85, Math.max(60, Number(p.overbought)));
  if (p.atrStopMult != null) p.atrStopMult = round(Math.max(1.0, Math.min(Number(p.atrStopMax) || 4.0, Number(p.atrStopMult))), 1);
  if (p.exit != null && p.entry != null && Number(p.exit) >= Number(p.entry)) p.exit = Math.max(10, Number(p.entry) - 15);
  // 追加ロジック（17戦略）の整合
  if (p.oversold != null && p.overbought != null && Number(p.oversold) >= Number(p.overbought) - 10) p.oversold = Math.max(10, Number(p.overbought) - 30);
  if (p.tenkan != null && p.kijun != null && Number(p.tenkan) >= Number(p.kijun)) p.tenkan = Math.max(3, Number(p.kijun) - 5);
  if (p.side != null) p.side = Number(p.side) < 0 ? -1 : 1;
  if (p.weekday != null) p.weekday = Math.max(0, Math.min(6, Math.round(Number(p.weekday))));
  if (p.hold != null) p.hold = Math.max(1, Math.min(5, Math.round(Number(p.hold))));
  if (p.before != null) p.before = Math.max(1, Math.min(5, Math.round(Number(p.before))));
  if (p.after != null) p.after = Math.max(1, Math.min(7, Math.round(Number(p.after))));
  if (p.lookback != null) p.lookback = Math.max(2, Math.min(60, Math.round(Number(p.lookback))));
  if (p.entryZ != null) p.entryZ = Math.max(0.5, Math.min(4, Number(p.entryZ)));
  if (p.threshold != null) p.threshold = Math.max(0.1, Math.min(300, Number(p.threshold)));
  if (p.k1 != null) p.k1 = Math.max(0.1, Math.min(2, Number(p.k1)));
  if (p.k2 != null) p.k2 = Math.max(0.1, Math.min(2, Number(p.k2)));
  if (p.squeezePct != null) p.squeezePct = Math.max(0.1, Math.min(1.2, Number(p.squeezePct)));
  if (p.breakoutBars != null) p.breakoutBars = Math.max(5, Math.min(120, Math.round(Number(p.breakoutBars))));
  if (p.squeezeLookback != null) p.squeezeLookback = Math.max(30, Math.min(250, Math.round(Number(p.squeezeLookback))));
  return p;
}

// パラメータの同一性（無駄な再実験を避ける）
export function paramKey(symbol, strategyKey, params = {}) {
  const keys = Object.keys(params).sort();
  return `${symbol}|${strategyKey}|${keys.map((k) => `${k}=${params[k]}`).join(',')}`;
}

// ---------------------------------------------------------------------------
// 成績の評価 — 「儲かったか」だけでなく「信用できるか」を掛ける。
// 取引回数が少ない高成績は偶然なので減衰させ、DDは重く罰する。
// ---------------------------------------------------------------------------
export function fitness(metrics = {}, robust = null) {
  const net = Number(metrics.netProfitPct || 0);
  const dd = Number(metrics.maxDrawdownPct || 0);
  const trades = Number(metrics.trades || 0);
  const pf = Number(metrics.profitFactor || 0);
  const confidence = Math.min(1, trades / 60);
  let score = net * confidence - dd * 1.2 + Math.min(6, Math.max(0, pf - 1) * 8);
  // フル検証の結果があれば、点数を「偶然でない度合い」で増減させる。
  // 単に儲かった候補より、崩れにくい候補が上に来るようにする。
  if (robust && robust.ok !== false) {
    score += (robust.dsr?.dsr ?? 0) * 4;
    score -= Math.max(0, (robust.cscv?.pbo ?? 0.5) - 0.2) * 6;
    score += (robust.plateau?.positive_share ?? 0) * 3;
    if (typeof robust.cost_stress?.breakeven_multiplier === 'number' && robust.cost_stress.breakeven_multiplier < 1.5) score -= 3;
    if ((robust.regime?.max_year_share ?? 0) > 0.6) score -= 2;
  }
  return round(score, 3);
}

export function gates(metrics = {}, wf = null, robust = null) {
  const reasons = [];
  let pass = true;
  if (Number(metrics.trades || 0) < 30) { pass = false; reasons.push(`取引回数が少なすぎる (${metrics.trades ?? 0} < 30)`); }
  if (metrics.profitFactor !== null && Number(metrics.profitFactor) < 1.15) { pass = false; reasons.push(`プロフィットファクター不足 (${metrics.profitFactor} < 1.15)`); }
  if (Number(metrics.expectancy || 0) <= 0) { pass = false; reasons.push('期待値がプラスでない'); }
  if (Number(metrics.maxDrawdownPct || 0) > 35) { pass = false; reasons.push(`最大DDが大きすぎる (${metrics.maxDrawdownPct}% > 35%)`); }
  if (wf && !wf.consistent) { pass = false; reasons.push(`ウォークフォワード不安定 (${wf.netPositiveFolds}/${wf.totalFolds} フォルダでプラス)`); }
  // フル検証（カーブフィッティング対策）の結果。未実施（null）は合格扱いにしない＝判定を保留する。
  if (robust) {
    if (robust.ok === false) { pass = false; reasons.push(`フル検証が実行できなかった（${robust.reason || 'unknown'}）`); }
    else {
      for (const r of (robust.gates?.reasons || [])) reasons.push(r);
      if (robust.gates?.pass !== true) pass = false;
    }
  }
  return { pass, reasons };
}

// ---------------------------------------------------------------------------
// 1実験の実行（外部は無料の市場データだけ）
// ---------------------------------------------------------------------------
export async function runExperiment({
  store, symbol, strategyKey, params, parentId = null, mutation = null, tag = 'explore',
  days = 1996, validate = false, now = null, mdCache = null,
}) {
  const at = now || nowIso();
  const memo = mdCache && typeof mdCache.get === 'function' ? mdCache.get(symbol) : null;
  const md = memo || await fetchMarketData(store, symbol, { days });
  if (mdCache && typeof mdCache.set === 'function' && !memo) mdCache.set(symbol, md);
  if (!md.bars || md.bars.length < 250) {
    return { ok: false, error: 'insufficient_market_data', symbol, bars: md.bars?.length || 0, source: md.source };
  }
  const cost = { ...DEFAULT_COST_MODEL };
  const p = { ...sanitize(strategyKey, params), symbol };
  if (!cost.fx) {
    const fx = await buildCurrencyConverter(store, symbol).catch(() => null);
    if (fx) cost.fx = fx;
  }
  const bt = backtest(md.bars, { strategyKey, params: p, cost });
  const m = bt.metrics;

  let wf = null;
  if (validate) {
    wf = walkForward(md.bars, { strategyKey, params: p, cost }, 4);
  }
  const g = gates(m, wf);
  const score = fitness(m);

  const row = {
    id: newId('fxl_'), symbol, strategy_key: strategyKey,
    params_json: j(p), metrics_json: j(m), fitness: score,
    verdict: g.pass ? 'pass' : 'fail', gates_json: j(g.reasons),
    walkforward_json: wf ? j(wf) : null,
    parent_id: parentId, mutation, tag,
    bars: md.bars.length, data_source: md.source,
    date_from: md.bars[0].date, date_to: md.bars[md.bars.length - 1].date,
    promoted: 0, created_at: at,
  };
  await store.insert(T, row);
  return { ok: true, id: row.id, symbol, strategyKey, params: p, metrics: m, fitness: score, gates: g, walkforward: wf, data_source: md.source, bars: md.bars.length };
}

// ---------------------------------------------------------------------------
// 昇格 — 門を通過し、現王者を上回った候補を fx_strategies に書き、Pine を残す。
// ここに乗ったものだけが EA（MQL5）書き出しの対象になる。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// フル検証の記録（D1）。「どの候補が、どの検定で、どう落ちたか」まで残す。
// 負けた検証も消さない。同じ失敗を繰り返さないための材料になる。
// ---------------------------------------------------------------------------
export const VALIDATION_T = 'fx_validations';

export async function ensureValidationTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${VALIDATION_T} (
    id TEXT PRIMARY KEY, symbol TEXT, strategy_key TEXT NOT NULL, params_json TEXT,
    exp_id TEXT, score REAL DEFAULT 0, verdict TEXT DEFAULT 'fail',
    reasons_json TEXT DEFAULT '[]', robustness_json TEXT, elapsed_ms INTEGER,
    created_at TEXT NOT NULL
  )`).catch(() => {});
  await store.run(`CREATE INDEX IF NOT EXISTS ${VALIDATION_T}_score ON ${VALIDATION_T}(score DESC)`).catch(() => {});
}

/** D1に入れる前に要点だけ抜き出す（レポート全体は大きいので圧縮して保存する）。 */
export function compactRobust(r) {
  if (!r) return null;
  if (r.ok === false) return { ok: false, reason: r.reason || 'not_run' };
  return {
    ok: true, version: r.version, score: r.score, verdict: r.gates,
    metrics: r.metrics, sharpe_stats: r.sharpe_stats, data_quality: r.data_quality,
    multiple_testing: r.multiple_testing, purged: r.purged, dsr: r.dsr, psr: r.psr,
    bootstrap: r.bootstrap, sign_flip: r.sign_flip,
    cscv: r.cscv ? { ok: r.cscv.ok, pbo: r.cscv.pbo, paths: r.cscv.paths, oos_sharpe: r.cscv.oos_sharpe, interpretation: r.cscv.interpretation, note: r.cscv.note } : null,
    cost_stress: r.cost_stress, regime: r.regime,
    plateau: r.plateau ? { ok: r.plateau.ok, center_net_pct: r.plateau.center_net_pct, neighbors_tested: r.plateau.neighbors_tested, positive_share: r.plateau.positive_share, worst_neighbor_net_pct: r.plateau.worst_neighbor_net_pct, is_plateau: r.plateau.is_plateau, note: r.plateau.note } : null,
    null_test: r.null_test, elapsed_ms: r.elapsed_ms, budget_ms: r.budget_ms, honesty_note: r.honesty_note,
  };
}

export async function storeValidation({ store, symbol, strategyKey, params, robust, expId = null, at = null }) {
  await ensureValidationTable(store);
  const row = {
    id: newId('fxv_'), symbol, strategy_key: strategyKey, params_json: j(params || {}),
    exp_id: expId, score: Number(robust?.score || 0),
    verdict: (robust?.ok === true && robust.gates?.pass) ? 'pass' : 'fail',
    reasons_json: j(robust?.gates?.reasons || (robust?.reason ? [robust.reason] : [])),
    robustness_json: j(compactRobust(robust)), elapsed_ms: Number(robust?.elapsed_ms || 0),
    created_at: at || nowIso(),
  };
  await store.insert(VALIDATION_T, row);
  return row;
}

export async function latestValidation(store, champion = null) {
  await ensureValidationTable(store);
  const id = champion?.robustness?.validation_id;
  const row = id ? await store.get(VALIDATION_T, id).catch(() => null) : null;
  const r = row || await store.first(`SELECT * FROM ${VALIDATION_T} ORDER BY created_at DESC LIMIT 1`).catch(() => null);
  if (!r) return null;
  return {
    id: r.id, symbol: r.symbol, strategy_key: r.strategy_key, exp_id: r.exp_id,
    score: r.score, verdict: r.verdict, created_at: r.created_at,
    reasons: safeJson(r.reasons_json, []), report: safeJson(r.robustness_json, null),
  };
}

/** 「何を検定しているか」を人に見せる一覧 */
export const ROBUST_CHECKS = [
  { key: 'data_quality', what: 'データ品質', why: '欠測・重複・OHLCの破壊・価格の停滞を検査。ここが汚いと他の検定が無意味になる' },
  { key: 'purged', what: 'パージドCV（期間分割＋エンバーゴ）', why: '境界をまたぐ建玉の情報漏れを断ち、期間ごとに同じ実力が出るかを見る' },
  { key: 'cscv', what: 'CSCV / PBO（過剰最適化の確率）', why: '「多数試して最良を選ぶ」こと自体が生む過大評価を測る。単一の成績ではなく検証側の分布を見る' },
  { key: 'dsr', what: 'DSR（試行回数を織り込んだSharpe）', why: 'N回試した中の最大値という偶然を割り引く' },
  { key: 'bootstrap', what: 'ブロック・ブートストラップ', why: '日次リターンの並びの偏りを保ったまま、純益が偶然でも出るかを見る' },
  { key: 'sign_flip', what: '符号反転検定', why: '損益の大きさだけでは説明できない偏りかどうか' },
  { key: 'null_test', what: 'ランダムエントリー比較', why: '入口に意味があるか（最重要）' },
  { key: 'cost_stress', what: '費用耐性', why: 'スプレッド/スリッページを2倍にしても残るか' },
  { key: 'regime', what: '相場環境への集中度', why: '1つの年・1つのボラ環境だけで稼いでいないか' },
  { key: 'plateau', what: 'パラメータの台地', why: '少し動かしただけで崩れないか' },
  { key: 'multiple_testing', what: '多重検定の補正', why: 'N回試せば p<0.05 は 0.05N 件たまたま通過する' },
];

export async function promote({ store, exp, note = '', pine = null }) {
  const strategyKey = exp.strategy_key || exp.strategyKey;
  const symbol = exp.symbol;
  const params = safeJson(exp.params_json, null) || exp.params || {};
  const m = safeJson(exp.metrics_json, null) || exp.metrics || {};
  // 外から Pine を渡せる（論理空間から出た合成論理は logic.js が生成する）
  const pineCode = pine || generatePine(strategyKey, params, { version: 'v6', symbol });
  const lint = lintPine(pineCode);
  const prior = await store.all(`SELECT version FROM fx_strategies WHERE symbol=? ORDER BY version DESC LIMIT 1`, symbol).catch(() => []);
  const version = (Number(prior[0]?.version) || 0) + 1;
  const row = {
    id: newId('fxs_'),
    name: `${STRATEGIES[strategyKey]?.label || strategyKey} (${symbol}) v${version}`,
    symbol, version,
    hypothesis: `FX Lab の試行錯誤から昇格${note ? `（${note}）` : ''}: 純益 ${m.netProfitPct ?? 'n/a'}% / PF ${m.profitFactor ?? 'n/a'} / DD ${m.maxDrawdownPct ?? 'n/a'}% / ${m.trades ?? 'n/a'}取引。`,
    params_json: j({ ...params, strategyKey }),
    pine_code: pineCode, pine_version: 'v6',
    non_repaint: lint.nonRepaint ? 1 : 0, lint_json: j(lint),
    status: lint.nonRepaint ? 'draft' : 'rejected',
    created_at: nowIso(), updated_at: nowIso(),
  };
  await store.insert('fx_strategies', row);
  await store.run(`UPDATE ${T} SET promoted=1 WHERE id=?`, exp.id || exp.exp_id || '').catch(() => {});
  return { id: row.id, version, lint, name: row.name };
}

// ---------------------------------------------------------------------------
// 1tick — 探索と活用を交互に回し、王者を更新する。
// ---------------------------------------------------------------------------
export async function fxLabTick({
  store, env = {}, n = 2, symbols = null, seed = null, now = null, exploreEvery = 3,
} = {}) {
  const at = now || nowIso();
  await ensureLabTable(store);
  const report = { at, ran: 0, experiments: [], improved: false, promoted: null, champion: null, skipped: 0 };

  const syms = symbols && symbols.length ? symbols : LAB_SYMBOLS;
  const rnd = seededRandom(String(seed ?? env.FX_LAB_SEED ?? `fxlab-${at}`));

  let champion = await store.first(`SELECT value FROM settings WHERE key=?`, CHAMPION_KEY).catch(() => null);
  champion = safeJson(champion?.value, null);

  // 実験済みのパラメータ組（無駄な再実験を避ける）
  const seen = new Set();
  const priorRows = await store.all(`SELECT symbol, strategy_key, params_json, fitness FROM ${T} ORDER BY created_at DESC LIMIT 400`).catch(() => []);
  for (const r of priorRows) {
    const p = safeJson(r.params_json, {}) || {};
    seen.add(paramKey(r.symbol, r.strategy_key, p));
  }
  const totalSoFar = priorRows.length;

  // 多重検定の補正に使う「これまで何回試したか」と「試行のSharpeのばらつき」。
  const trialCountRow = await store.first(`SELECT COUNT(*) AS n FROM ${T}`).catch(() => null);
  const trialCount = Math.max(1, Number(trialCountRow?.n || totalSoFar || 1));
  const sharpeRows = await store.all(`SELECT metrics_json FROM ${T} ORDER BY created_at DESC LIMIT 300`).catch(() => []);
  const trialSharpes = sharpeRows.map((r) => Number(safeJson(r.metrics_json, {})?.sharpe)).filter((v) => Number.isFinite(v));

  // CPU予算 — Cloudflare の1回の実行には上限がある。使い切ったら次tickへ回す（黙って落とさない）。
  const t0 = Date.now();
  const budgetMs = Math.max(2000, Number(env.FX_LAB_CPU_BUDGET_MS || 20000));
  const deepBudget = Math.max(0, Number(env.FX_LAB_DEEP_PER_TICK ?? 1));
  const deepBudgetMs = Math.max(3000, Number(env.FX_LAB_DEEP_BUDGET_MS || 12000));
  let deepUsed = 0;

  for (let i = 0; i < Math.max(1, n); i++) {
    if (Date.now() - t0 > budgetMs) {
      report.budget_exhausted = true;
      report.budget_note = `CPU予算 ${budgetMs}ms を使い切ったため、残り ${Math.max(0, Math.max(1, n) - i)} 件は次tickへ回します`;
      break;
    }
    const slot = totalSoFar + i;
    const explore = !champion || slot % Math.max(2, exploreEvery) === 0;
    let symbol; let strategyKey; let params; let tag; let parentId = null; let mutation = null;

    if (explore) {
      symbol = syms[Math.floor(rnd() * syms.length)];
      strategyKey = LAB_STRATEGIES[Math.floor(rnd() * LAB_STRATEGIES.length)];
      params = candidateFromGrid(strategyKey, rnd);
      tag = 'explore';
    } else {
      symbol = champion.symbol;
      strategyKey = champion.strategy_key;
      params = mutate(strategyKey, champion.params, rnd, rnd() < 0.5 ? 1 : 2);
      tag = 'exploit';
      parentId = champion.exp_id || null;
      mutation = `現王者の近傍を変異（元: 純益 ${champion.metrics?.netProfitPct ?? 'n/a'}% / DD ${champion.metrics?.maxDrawdownPct ?? 'n/a'}%）`;
    }
    if (!params) { report.skipped++; continue; }

    const key = paramKey(symbol, strategyKey, { ...params, symbol });   // 保存側は symbol 込みなので合わせる
    if (seen.has(key)) { report.skipped++; continue; }
    seen.add(key);

    let exp;
    try {
      exp = await runExperiment({ store, symbol, strategyKey, params, parentId, mutation, tag, now: at });
    } catch (e) {
      report.experiments.push({ symbol, strategyKey, error: e.message });
      continue;
    }
    if (!exp.ok) { report.experiments.push({ symbol, strategyKey, error: exp.error, bars: exp.bars }); continue; }
    report.ran++;
    report.experiments.push({
      id: exp.id, symbol, strategyKey, tag, fitness: exp.fitness, pass: exp.gates.pass,
      net: exp.metrics.netProfitPct, dd: exp.metrics.maxDrawdownPct, pf: exp.metrics.profitFactor,
      trades: exp.metrics.trades, gates: exp.gates.reasons, data_source: exp.data_source,
    });

    // 王者判定: 門を通過し、fitness が現王者より高いときだけ。
    // 昇格の前に「フル検証」を回す（データ品質 / パージドCV / PBO / DSR / ブートストラップ /
    // 符号反転 / ランダムエントリー / 費用耐性 / 相場環境 / パラメータ台地 / 多重検定）。
    // 通ったものだけを王者にしてEAの対象にする。通らないものは「暫定」として記録だけ残す。
    const beats = exp.gates.pass && (!champion || exp.fitness > Number(champion.fitness || 0));
    if (beats) {
      if (deepUsed >= deepBudget) {
        report.experiments.push({ id: exp.id, note: `フル検証の上限（1tickあたり${deepBudget}件）に達したため、検証は次tickへ` });
      } else {
        deepUsed++;
        report.deep_validations = (report.deep_validations || 0) + 1;
        const md2 = await fetchMarketData(store, symbol, { days });
        const cost2 = { ...DEFAULT_COST_MODEL };
        const fx2 = await buildCurrencyConverter(store, symbol).catch(() => null);
        if (fx2) cost2.fx = fx2;
        let robust = null;
        try {
          robust = deepValidate(md2.bars, {
            symbol, strategyKey, params: { ...params, symbol }, cost: cost2, source: md2.source,
            trials: trialCount, trialSharpes, seed: `${at}-${exp.id}`, budgetMs: deepBudgetMs,
          });
        } catch (e) {
          robust = { ok: false, reason: `deep_validate_error: ${e.message}` };
        }
        const vrow = await storeValidation({ store, symbol, strategyKey, params: { ...params, symbol }, robust, expId: exp.id, at }).catch(() => null);
        const robustPass = robust?.ok === true && robust.gates?.pass === true;
        const wf = robust?.purged
          ? { consistent: robust.purged.consistent, netPositiveFolds: robust.purged.positive_folds, totalFolds: robust.purged.evaluated_folds, note: robust.purged.note }
          : null;
        report.robust = {
          validation_id: vrow?.id || null, score: robust?.score ?? null,
          pbo: robust?.cscv?.pbo ?? null, dsr: robust?.dsr?.dsr ?? null,
          random_entry_p: robust?.null_test?.p_value ?? null,
          plateau_share: robust?.plateau?.positive_share ?? null,
          cost_breakeven: robust?.cost_stress?.breakeven_multiplier ?? null,
          pass: robustPass, reasons: (robust?.gates?.reasons || []).slice(0, 5),
          elapsed_ms: robust?.elapsed_ms ?? null,
        };
        if (robustPass) {
          const expRow = await store.first(`SELECT * FROM ${T} WHERE id=?`, exp.id).catch(() => null);
          const prom = await promote({ store, exp: expRow || { ...exp, params_json: j(exp.params), metrics_json: j(exp.metrics) }, note: tag === 'exploit' ? '現王者の改良（フル検証通過）' : '新しい組み合わせ（フル検証通過）' }).catch((e) => ({ error: e.message }));
          champion = {
            exp_id: exp.id, symbol, strategy_key: strategyKey, params: { ...params, symbol },
            fitness: exp.fitness, metrics: exp.metrics, gates: exp.gates, walkforward: wf,
            verified: true,
            robustness: { validation_id: vrow?.id || null, score: robust.score, pbo: robust.cscv?.pbo ?? null, dsr: robust.dsr?.dsr ?? null, random_entry_p: robust.null_test?.p_value ?? null, plateau_share: robust.plateau?.positive_share ?? null, cost_breakeven: robust.cost_stress?.breakeven_multiplier ?? null },
            promoted_to: prom?.id || null, since: at,
          };
          await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            CHAMPION_KEY, j(champion), at);
          report.improved = true;
          report.promoted = prom;
        } else {
          const provisional = {
            exp_id: exp.id, symbol, strategy_key: strategyKey, params: { ...params, symbol },
            fitness: exp.fitness, metrics: exp.metrics, walkforward: wf, verified: false,
            robustness: report.robust, since: at,
            note: 'フル検証を通っていないため、王者にもEAにもしない（記録のみ）',
          };
          await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            'fxlab:provisional', j(provisional), at);
          report.experiments.push({
            id: exp.id, tag: 'provisional',
            note: 'フル検証を通らないため昇格せず（暫定として記録）',
            robust_reasons: (robust?.gates?.reasons || [robust?.reason || '検証できず']).slice(0, 4),
            robust_score: robust?.score ?? null,
          });
        }
      }
    }
  }

  report.champion = champion;
  const stats = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, STATS_KEY).catch(() => null))?.value, { runs: 0, experiments: 0, improvements: 0 }) || { runs: 0, experiments: 0, improvements: 0 };
  stats.runs = (stats.runs || 0) + 1;
  stats.experiments = (stats.experiments || 0) + report.ran;
  stats.improvements = (stats.improvements || 0) + (report.improved ? 1 : 0);
  stats.last_at = at;
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, STATS_KEY, j(stats), at);

  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES ('fxlab:last_run',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    j({ at, ran: report.ran, improved: report.improved, experiments: report.experiments.map((e) => `${e.symbol}/${e.strategyKey}:${e.fitness ?? e.error ?? '?'}`) }), at);

  return report;
}

// ---------------------------------------------------------------------------
// 次に試す予定（「エージェントが何を試そうとしているか」を人に見せる）
// ---------------------------------------------------------------------------
export function nextPlan({ champion = null, count = 3 } = {}) {
  const out = [];
  if (champion) {
    out.push({ tag: 'exploit', what: `現王者（${champion.symbol} / ${champion.strategy_key}）のパラメータ近傍を変異して再検証`, expected: '王者の更新' });
  }
  out.push({ tag: 'explore', what: `未試行の組み合わせ（${LAB_SYMBOLS.join(' / ')} × ${LAB_STRATEGIES.join(' / ')}）から無作為に選択`, expected: '新しい当たり筋の発見' });
  if (champion) {
    out.push({ tag: 'validate', what: '王者を上回った候補にフル検証（11項目）をかけ、すべて通れば fx_strategies へ昇格（＝EAとPineの対象になる）', expected: '頑健な候補だけが生き残る' });
  }
  return out.slice(0, count);
}

// ---------------------------------------------------------------------------
// 「どんなロジックを試しているか」を人に見せるための説明。
// 戦略の内部（backtest.js）に手を入れず、ここで日本語の説明だけを持つ。
// ---------------------------------------------------------------------------
export const STRATEGY_EXPLAIN = {
  ema_cross: {
    how: '短期EMAが長期EMAを上抜けたら買い、下抜けたら手仕舞い（順張り）',
    entry: 'EMAの交差', exit: '逆方向の交差／ATRストップ', why: 'トレンドが出ている局面でだけ乗る',
  },
  rsi_meanrev: {
    how: 'RSIが売られ過ぎまで下がったら買い、戻りで手仕舞い（逆張り）',
    entry: 'RSIの下限割れ', exit: 'RSIの回復水準／ATRストップ', why: '行き過ぎの戻りを取る',
  },
  bollinger_fade: {
    how: '価格がボリンジャーバンドの外に出たら逆方向に張る（逆張り）',
    entry: 'バンド外への逸脱', exit: '中心線への回帰／ATRストップ', why: '行き過ぎの反転を取る',
  },
  donchian_breakout: {
    how: '一定期間の高値を抜けたら買い、安値を割ったら手仕舞い（ブレイクアウト）',
    entry: 'チャネル突破', exit: '逆側のチャネル／ATRストップ', why: '大きな流れの初動を取る',
  },
};

/** 探索している範囲（グリッド）と、その組み合わせ数を返す。 */
export function strategyCatalog() {
  return LAB_STRATEGIES.map((k) => {
    const s = STRATEGIES[k] || {};
    const grid = s.grid || {};
    const combos = Object.values(grid).reduce((a, v) => a * (Array.isArray(v) && v.length ? v.length : 1), 1);
    const e = STRATEGY_EXPLAIN[k] || {};
    return {
      key: k, label: s.label || k,
      how: e.how || s.label || k, entry: e.entry || '', exit: e.exit || '', why: e.why || '',
      combo_count: combos, grid, default_params: s.defaultParams || {},
    };
  });
}

export async function fxLabSummary(store) {
  await ensureLabTable(store);
  const rows = await store.all(`SELECT * FROM ${T} ORDER BY fitness DESC LIMIT 60`).catch(() => []);
  const totalRow = await store.first(`SELECT COUNT(*) AS n FROM ${T}`).catch(() => null);
  const passRow = await store.first(`SELECT COUNT(*) AS n FROM ${T} WHERE verdict='pass'`).catch(() => null);
  const stats = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, STATS_KEY).catch(() => null))?.value, {}) || {};
  const champRaw = await store.first(`SELECT value FROM settings WHERE key=?`, CHAMPION_KEY).catch(() => null);
  const champion = safeJson(champRaw?.value, null);
  const provisional = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, 'fxlab:provisional').catch(() => null))?.value, null);
  const lastValidation = await latestValidation(store, champion).catch(() => null);
  const byStrategy = {};
  for (const r of rows) byStrategy[r.strategy_key] = (byStrategy[r.strategy_key] || 0) + 1;
  const total = Number(totalRow?.n || 0);
  const passed = Number(passRow?.n || 0);
  return {
    measured: total > 0,
    total_experiments: total,
    passed,
    pass_rate: total ? round((passed / total) * 100, 1) : null,
    stats,
    champion,
    provisional,
    robustness: lastValidation,
    checks: ROBUST_CHECKS,
    best: rows.slice(0, 8).map((r) => ({
      id: r.id, symbol: r.symbol, strategy_key: r.strategy_key, fitness: r.fitness,
      verdict: r.verdict, metrics: safeJson(r.metrics_json, {}), gates: safeJson(r.gates_json, []),
      params: safeJson(r.params_json, {}), tag: r.tag, promoted: Number(r.promoted) === 1, created_at: r.created_at,
    })),
    worst: rows.slice(-3).map((r) => ({ symbol: r.symbol, strategy_key: r.strategy_key, fitness: r.fitness, gates: safeJson(r.gates_json, []) })),
    by_strategy: byStrategy,
    strategies: strategyCatalog(),
    symbols: LAB_SYMBOLS.map((s) => ({ symbol: s, note: String((PAIRS[s] && (PAIRS[s].note || PAIRS[s].label || PAIRS[s].name)) || '') })),
    next: nextPlan({ champion }),
    cost: '0円（無料の市場データ＋自作のバックテストのみ。有料APIは呼びません）',
  };
}

export function fxLabCards(summary = {}) {
  const c = summary.champion;
  const kpi = {
    type: 'kpi', title: 'FX Lab（試行錯誤を回し続ける）',
    items: [
      { label: '試した組み合わせ', value: summary.total_experiments || 0, unit: '件（負けも残す）' },
      { label: '門を通過', value: summary.passed || 0, unit: summary.pass_rate == null ? '件' : `件（${summary.pass_rate}%）` },
      { label: 'いまの王者', value: c ? `${c.metrics?.netProfitPct ?? '?'}%` : '—', unit: c ? `${c.symbol} / ${c.strategy_key}` : 'まだ無し' },
      { label: '反復の回数', value: summary.stats?.runs || 0, unit: '回（Cronから自動）' },
      { label: '改善した回数', value: summary.stats?.improvements || 0, unit: '回' },
    ],
  };
  const list = {
    type: 'list', title: '次に試す予定（自動）',
    items: (summary.next || []).map((n) => ({ label: n.what, value: n.tag, unit: n.expected })),
  };
  const worst = (summary.worst || []).slice(0, 3);
  const note = {
    type: 'note',
    text: `${summary.cost || ''}${worst.length ? ` 直近で最も悪かった組み合わせ: ${worst.map((w) => `${w.symbol}/${w.strategy_key}(${w.fitness})`).join(' / ')} — 失敗の記録も残し、次に試さない判断に使います。` : ''}`,
  };
  return [kpi, list, note];
}

export function fxLabHelp() {
  return [
    'FXは「ここで完成させる」のではなく、エージェントが試行錯誤を回し続ける形にしています。Cron から数分おきに少数の実験だけを回し、結果をD1に積み上げます（サンドボックスが消えても記録は残ります）。',
    '1回の実験は「戦略 × 銘柄 × パラメータ」の組み合わせ1つです。探索（未試行の組み合わせ）と活用（いまの王者の近傍を変異）を交互に回します。',
    '使うデータは無料・鍵不要のものだけ（Yahoo Finance と ECB Frankfurter）で、バックテストは自作のエンジンなので原価は0円です。有料APIは呼びません。',
    '評価は「儲かったか」だけではなく「信用できるか」を掛けます。取引回数が少ない高成績は偶然なので減衰させ、最大ドローダウンは重く罰します。',
    '現王者を上回り、かつ門（取引30回以上・PF1.15以上・期待値プラス・DD35%以下）を通った候補には、さらにウォークフォワード検証をかけてから昇格させます。昇格したものだけが Pine / MQL5（EA）の対象になります。',
    '負けた実験も消しません。失敗の記録が「次に試さないこと」を決めるからです。',
    '昇格の前に「フル検証」を回します。データ品質 / パージドCV（期間分割＋エンバーゴ）/ CSCV（過剰最適化の確率PBO）/ DSR（試行回数を織り込んだSharpe）/ ブロック・ブートストラップ / 符号反転 / ランダムエントリー比較 / 費用耐性（2倍でも残るか）/ 相場環境への集中度 / パラメータの台地 / 多重検定の補正 — の11項目です。',
    'フル検証を通らなかった候補は、王者にもEAにもしません（「暫定」として記録だけ残します）。たくさん試すほど偶然の1位が出やすくなるので、試した回数そのものを減点に織り込んでいます。',
  ].join('\n\n');
}
