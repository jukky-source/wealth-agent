// Logic space を「エージェントの中で回し続ける」ための実行部。
//
// ここが要点:
//   * 手元（サンドボックス）でバックテストを走らせない。Cron から呼ばれる Worker の中で、
//     論理空間を番号順に踏破し、結果を D1 に積む。サンドボックスが消えても続く。
//   * 1tickは少数（既定3件）。CPU予算を超えたら次tickへ回す（黙って落とさない）。
//   * 原価0（無料の日足データ＋自作エンジン）。有料APIは呼ばない。
//   * 昇格はフル検証（robust.js の11項目）を全部通ったときだけ。通らなければ「暫定」として記録だけ。
//   * 記録は既存の fx_experiments に tag='logic:core' / 'logic:rule' で積む（別テーブルを作らない）。

import { nowIso, j, safeJson, round, seededRandom } from '../util.js';
import { DEFAULT_COST_MODEL } from './backtest.js';
import { fetchMarketData, buildCurrencyConverter } from './fx.js';
import { deepValidate } from './robust.js';
import { generatePine } from './pine.js';
import {
  SYMBOLS, coreSize, ruleSize, spaceSize, coreAt, randomRule, materialize, describeLogic,
  exitParams, vocabulary, NOT_INCLUDED, FEATURES, TIMEFRAMES, FILTERS, EXITS, DIRECTIONS, ATOMS,
  basketFor, featureKeys,
} from './grammar.js';
import {
  T, ensureLabTable, runExperiment, promote, storeValidation, CHAMPION_KEY, ROBUST_CHECKS,
} from './fxLab.js';

export const LOGIC_STATS_KEY = 'fxlab:logic_stats';
export const LOGIC_PROVISIONAL_KEY = 'fxlab:logic_provisional';
const CORE_WEIGHT = 0.7;   // コア層の踏破に7割、合成層の探索に3割

// ---------------------------------------------------------------------------
// 「どれくらいの広さを、どのくらいの速さで見ているか」— 誇張しないための算数
// ---------------------------------------------------------------------------
export function spaceReport(env = {}) {
  const per = Math.max(1, Number(env.FX_LAB_LOGIC_PER_TICK || 3));
  const every = Math.max(5, Number(env.FX_LAB_LOGIC_EVERY_MINUTES || 5));
  const perDay = per * Math.floor((24 * 60) / every);
  const core = coreSize();
  const rule = ruleSize();
  const corePerDay = Math.max(1, Math.round(perDay * CORE_WEIGHT));
  const rulePerDay = Math.max(0, perDay - corePerDay);
  return {
    core_size: core,
    rule_size: rule,
    space_size: core + rule,
    mode: String(env.FX_LAB_LOGIC_SHARED ?? 'true') !== 'false' ? 'shared' : 'single',
    basket: Math.max(1, Number(env.FX_LAB_LOGIC_BASKET || 3)),
    hypothesis: String(env.FX_LAB_LOGIC_HYPOTHESIS ?? 'true') !== 'false',
    per_tick: per,
    every_minutes: every,
    per_day: perDay,
    core_per_day: corePerDay,
    rule_per_day: rulePerDay,
    core_days: Math.ceil(core / corePerDay),
    rule_days: rulePerDay > 0 ? Math.ceil(rule / rulePerDay) : null,
    note: `1tick ${per}件・${every}分間隔なら 1日 ${perDay}件。コア層 ${core.toLocaleString('en-US')} 通りは約 ${Math.ceil(core / corePerDay)} 日で全通り、`
      + `合成層 ${rule.toLocaleString('en-US')} 通りは全列挙が非現実的なので無作為＋王者近傍の変異で探索します（原価0）。`
      + `コア層は同じ設定を最大 ${Math.max(1, Number(env.FX_LAB_LOGIC_BASKET || 3))} 銘柄に同時に当て、過半で通ったときだけ候補にします（1本だけの偶然を昇格させないため）。`,
  };
}

// ---------------------------------------------------------------------------
// 1tick — 番号順の踏破（コア層）と、無作為＋変異（合成層）
// ---------------------------------------------------------------------------
export async function logicTick({
  store, env = {}, n = 3, symbols = null, now = null, budgetMs = null,
  deepPerTick = null, deepBudgetMs = null,
} = {}) {
  const at = now || nowIso();
  await ensureLabTable(store);
  const syms = symbols && symbols.length ? symbols : SYMBOLS;
  const core = coreSize(syms);

  const stats = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LOGIC_STATS_KEY).catch(() => null))?.value, null)
    || { core_cursor: 0, core_rounds: 0, evaluated: 0, evaluated_core: 0, evaluated_rule: 0 };
  const champion = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, CHAMPION_KEY).catch(() => null))?.value, null);

  // 合成層の変異元（いま一番良い合成論理）
  const bestRuleRow = await store.first(`SELECT params_json, fitness FROM ${T} WHERE tag='logic:rule' ORDER BY fitness DESC LIMIT 1`).catch(() => null);
  const bestRule = safeJson(bestRuleRow?.params_json, null)?.logic || null;

  // 多重検定の補正に使う「これまで何回試したか」と「試行のSharpeのばらつき」
  const trialCountRow = await store.first(`SELECT COUNT(*) AS n FROM ${T}`).catch(() => null);
  const trialCount = Math.max(1, Number(trialCountRow?.n || 1));
  const sharpeRows = await store.all(`SELECT metrics_json FROM ${T} ORDER BY created_at DESC LIMIT 300`).catch(() => []);
  const trialSharpes = sharpeRows.map((r) => Number(safeJson(r.metrics_json, {})?.sharpe)).filter((v) => Number.isFinite(v));

  const seen = new Set();
  const priorRows = await store.all(`SELECT symbol, strategy_key, params_json FROM ${T} ORDER BY created_at DESC LIMIT 400`).catch(() => []);
  for (const r of priorRows) seen.add(`${r.symbol}|${r.strategy_key}|${r.params_json}`);

  const t0 = Date.now();
  const budget = Math.max(2000, Number(budgetMs || env.FX_LAB_LOGIC_BUDGET_MS || 9000));
  const deepLimit = deepPerTick == null ? Math.max(0, Number(env.FX_LAB_LOGIC_DEEP_PER_TICK ?? 1)) : deepPerTick;
  const deepBudget = Math.max(3000, Number(deepBudgetMs || env.FX_LAB_DEEP_BUDGET_MS || 12000));

  // 探索の設計: コア層は「同じ設定を複数銘柄に同時に当てる」、合成層は「仮説を1つに絞る」。
  const shareEnabled = String(env.FX_LAB_LOGIC_SHARED ?? 'true') !== 'false';
  const basketSize = Math.max(1, Math.min(syms.length, Number(env.FX_LAB_LOGIC_BASKET || 3)));
  const hypoEnabled = String(env.FX_LAB_LOGIC_HYPOTHESIS ?? 'true') !== 'false';

  const rnd = seededRandom(`logic-${at}-${stats.core_cursor}`);
  const mdCache = new Map();
  const report = {
    at, ran: 0, tier: null, experiments: [], improved: false, promoted: null,
    deep_validations: 0, skipped: 0, cursor_before: stats.core_cursor,
    mode: shareEnabled ? 'shared' : 'single', basket: shareEnabled ? basketSize : 1,
  };
  let deepUsed = 0;
  let championLocal = champion;

  for (let i = 0; i < Math.max(1, n); i++) {
    if (Date.now() - t0 > budget) {
      report.budget_exhausted = true;
      report.budget_note = `CPU予算 ${budget}ms を使い切ったため、残りは次tickへ回します`;
      break;
    }
    // 7割はコア層（番号順）、3割は合成層（無作為＋変異）
    const useCore = rnd() < CORE_WEIGHT || !bestRule;
    let spec; let members = null;
    if (useCore) {
      if (stats.core_cursor >= core) { stats.core_rounds = (stats.core_rounds || 0) + 1; stats.core_cursor = 0; }
      spec = coreAt(stats.core_cursor, syms);
      // 共有パラメータ制約: 同じ設定を同時に複数の銘柄へ（過半で通ったときだけ候補）
      members = shareEnabled ? basketFor(stats.core_cursor, syms, basketSize) : [spec.symbol];
      stats.core_cursor += 1;
    } else {
      // 仮説を1本に絞る: その周回で扱う特徴量を1つに固定し、的を絞って探索する
      const fams = featureKeys();
      const fam = hypoEnabled ? [fams[(stats.evaluated_rule || 0) % fams.length]] : null;
      spec = randomRule(rnd, syms, { mutateFrom: bestRule, features: fam });
      if (fam) report.hypothesis = fam[0];
    }
    report.tier = spec.tier;

    const key = materialize(spec);
    const d = describeLogic(spec);
    const group = members && members.length ? members : [spec.symbol];
    const results = [];

    for (const sym of group) {
      if (Date.now() - t0 > budget) { report.budget_exhausted = true; report.budget_note = `CPU予算 ${budget}ms を使い切った（バスケットの途中まで）`; break; }
      const specSym = { ...spec, symbol: sym };
      const paramsSym = { ...exitParams(specSym), logic: specSym, logic_round: stats.core_rounds || 0, symbol: sym };
      const dedupKey = `${sym}|${key}|${j(paramsSym)}`;
      if (seen.has(dedupKey)) { report.skipped++; continue; }
      seen.add(dedupKey);
      let e2;
      try {
        e2 = await runExperiment({
          store, symbol: sym, strategyKey: key, params: paramsSym,
          tag: `logic:${spec.tier}`, mutation: d.line, now: at, mdCache,
        });
      } catch (e) {
        report.experiments.push({ symbol: sym, tier: spec.tier, error: String(e.message || e) });
        continue;
      }
      if (!e2 || !e2.ok) {
        report.experiments.push({ symbol: sym, tier: spec.tier, error: e2?.error || 'unknown', bars: e2?.bars });
        continue;
      }
      report.ran++;
      if (spec.tier === 'core') stats.evaluated_core = (stats.evaluated_core || 0) + 1;
      else stats.evaluated_rule = (stats.evaluated_rule || 0) + 1;
      stats.evaluated = (stats.evaluated || 0) + 1;
      report.experiments.push({
        id: e2.id, symbol: sym, tier: spec.tier, key, logic: d.line,
        fitness: e2.fitness, pass: e2.gates.pass,
        net: e2.metrics.netProfitPct, dd: e2.metrics.maxDrawdownPctMtm ?? e2.metrics.maxDrawdownPct,
        pf: e2.metrics.profitFactor, trades: e2.metrics.trades,
        gates: e2.gates.reasons, data_source: e2.data_source,
      });
      results.push({ sym, exp: e2, params: paramsSym });
    }
    if (!results.length) continue;

    // 共有パラメータ制約: 過半の銘柄で門を通ったときだけ「候補」にする
    const need = results.length > 1 ? Math.ceil(results.length * 0.6) : 1;
    const passers = results.filter((r) => r.exp.gates.pass);
    report.shared = { members: results.length, passed: passers.length, required: need, ok: passers.length >= need };
    if (passers.length < need) continue;

    // 通った銘柄のうち、最も良いものを代表として深掘りする
    const win = passers.slice().sort((a, b) => Number(b.exp.fitness || 0) - Number(a.exp.fitness || 0))[0];
    spec = { ...spec, symbol: win.sym };
    const exp = win.exp;
    const params = win.params;

    // 現王者を上回ったときだけフル検証へ（王者＝EAの対象候補）
    const beats = !championLocal || Number(exp.fitness || 0) > Number(championLocal.fitness || 0);
    if (!beats) continue;
    if (deepUsed >= deepLimit) {
      report.experiments.push({ id: exp.id, note: `フル検証の上限（1tickあたり${deepLimit}件）に達したため、検証は次tickへ` });
      continue;
    }
    deepUsed++;
    report.deep_validations = (report.deep_validations || 0) + 1;

    const md = mdCache.get(spec.symbol) || await fetchMarketData(store, spec.symbol, { days: 1996 });
    mdCache.set(spec.symbol, md);
    const cost = { ...DEFAULT_COST_MODEL };
    const fx = await buildCurrencyConverter(store, spec.symbol).catch(() => null);
    if (fx) cost.fx = fx;
    let robust = null;
    try {
      robust = deepValidate(md.bars, {
        symbol: spec.symbol, strategyKey: key, params: { ...params, symbol: spec.symbol }, cost,
        source: md.source, trials: trialCount, trialSharpes, seed: `${at}-${exp.id}`, budgetMs: deepBudget,
      });
    } catch (e) {
      robust = { ok: false, reason: `deep_validate_error: ${String(e.message || e)}` };
    }
    const vrow = await storeValidation({
      store, symbol: spec.symbol, strategyKey: key, params: { ...params, symbol: spec.symbol }, robust, expId: exp.id, at,
    }).catch(() => null);
    const robustPass = robust?.ok === true && robust.gates?.pass === true;
    report.robust = {
      validation_id: vrow?.id || null, score: robust?.score ?? null,
      pbo: robust?.cscv?.pbo ?? null, dsr: robust?.dsr?.dsr ?? null,
      random_entry_p: robust?.null_test?.p_value ?? null,
      pass: robustPass, reasons: (robust?.gates?.reasons || []).slice(0, 5),
    };

    if (robustPass) {
      const expRow = await store.first(`SELECT * FROM ${T} WHERE id=?`, exp.id).catch(() => null);
      const fidelity = spec.base.kind === 'rule' ? 'exact' : (spec.filter === 'none' && spec.tf === '1d' ? 'exact' : 'partial');
      let pineCode = null;
      try { pineCode = logicPine(spec, { ...params, symbol: spec.symbol }, { symbol: spec.symbol, version: 'v6' }); } catch { pineCode = null; }
      const prom = await promote({
        store,
        exp: expRow || { ...exp, params_json: j(params), metrics_json: j(exp.metrics) },
        pine: pineCode,
        note: `論理空間の番号${spec.tier === 'core' ? ` ${spec.idx}` : ''}から（フル検証通過 / Pine忠実度: ${fidelity}）`,
      }).catch((e) => ({ error: String(e.message || e) }));
      championLocal = {
        exp_id: exp.id, symbol: spec.symbol, strategy_key: key, params: { ...params, symbol: spec.symbol },
        fitness: exp.fitness, metrics: exp.metrics, gates: exp.gates, verified: true,
        logic: spec, logic_line: d.line, pine_fidelity: fidelity,
        robustness: report.robust, promoted_to: prom?.id || null, since: at,
      };
      await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        CHAMPION_KEY, j(championLocal), at);
      report.improved = true;
      report.promoted = prom;
    } else {
      const provisional = {
        exp_id: exp.id, symbol: spec.symbol, strategy_key: key, params: { ...params, symbol: spec.symbol },
        fitness: exp.fitness, metrics: exp.metrics, logic: spec, logic_line: d.line, verified: false,
        robustness: report.robust, since: at,
        note: 'フル検証を通っていないため、王者にもEAにもしない（記録のみ）',
      };
      await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        LOGIC_PROVISIONAL_KEY, j(provisional), at);
      report.experiments.push({
        id: exp.id, tag: 'provisional', logic: d.line,
        note: 'フル検証を通らないため昇格せず（暫定として記録）',
        robust_reasons: (robust?.gates?.reasons || [robust?.reason || '検証できず']).slice(0, 4),
        robust_score: robust?.score ?? null,
      });
    }
  }

  stats.last_at = at;
  stats.core_size = core;
  stats.rule_size = ruleSize(syms);
  stats.space_size = core + stats.rule_size;
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    LOGIC_STATS_KEY, j(stats), at);
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES ('fxlab:logic_last_run',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    j({
      at, ran: report.ran, tier: report.tier, cursor: stats.core_cursor, rounds: stats.core_rounds || 0,
      improved: report.improved, mode: report.mode, basket: report.basket,
      shared: report.shared || null, hypothesis: report.hypothesis || null,
      experiments: report.experiments.map((e) => `${e.symbol}/${e.tier}:${e.fitness ?? e.error ?? '?'}`),
    }), at);

  report.champion = championLocal;
  report.cursor = stats.core_cursor;
  report.core_rounds = stats.core_rounds || 0;
  report.coverage_pct = round((100 * Math.min(stats.evaluated_core || 0, core)) / core, 4);
  return report;
}

// ---------------------------------------------------------------------------
// 見せる（チャット・API）
// ---------------------------------------------------------------------------
export async function logicSpaceInfo(store, env = {}) {
  await ensureLabTable(store);
  const stats = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LOGIC_STATS_KEY).catch(() => null))?.value, null) || {};
  const champion = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, CHAMPION_KEY).catch(() => null))?.value, null);
  const provisional = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LOGIC_PROVISIONAL_KEY).catch(() => null))?.value, null);
  const core = coreSize();
  const rule = ruleSize();
  const count = async (where) => Number((await store.first(`SELECT COUNT(*) AS n FROM ${T} WHERE ${where}`).catch(() => null))?.n || 0);
  const evaluated_core = await count(`tag='logic:core'`);
  const evaluated_rule = await count(`tag='logic:rule'`);
  const passed = await count(`tag LIKE 'logic:%' AND verdict='pass'`);
  const rows = await store.all(`SELECT * FROM ${T} WHERE tag LIKE 'logic:%' ORDER BY fitness DESC LIMIT 8`).catch(() => []);
  const top = rows.map((r) => {
    const p = safeJson(r.params_json, {}) || {};
    const m = safeJson(r.metrics_json, {}) || {};
    return {
      id: r.id, symbol: r.symbol, tier: String(r.tag || '').replace('logic:', ''), fitness: r.fitness,
      verdict: r.verdict, promoted: Number(r.promoted) === 1,
      logic: p.logic ? describeLogic(p.logic).line : (r.mutation || ''),
      net: m.netProfitPct, dd: m.maxDrawdownPct, pf: m.profitFactor, trades: m.trades,
      created_at: r.created_at,
    };
  });
  return {
    plan: spaceReport(env),
    mode: spaceReport(env).mode,
    basket: spaceReport(env).basket,
    core_size: core,
    rule_size: rule,
    space_size: core + rule,
    evaluated_core,
    evaluated_rule,
    evaluated_total: evaluated_core + evaluated_rule,
    coverage_pct_core: round((100 * Math.min(evaluated_core, core)) / core, 4),
    core_rounds: stats.core_rounds || 0,
    core_cursor: stats.core_cursor || 0,
    passed,
    pass_rate_pct: evaluated_core + evaluated_rule ? round((100 * passed) / (evaluated_core + evaluated_rule), 2) : null,
    last_at: stats.last_at || null,
    champion: champion || null,
    provisional: provisional || null,
    top,
    checks: ROBUST_CHECKS,
    vocabulary: vocabulary(),
    not_included: NOT_INCLUDED,
    cost: '0円（無料の日足データ＋自作エンジン。有料APIは呼びません）',
    where_it_runs: 'Cloudflare の Cron（Workerの中）。手元のサンドボックスでは走りません。',
  };
}

export function logicSpaceCard(info = {}) {
  const p = info.plan || spaceReport({});
  const kpi = {
    type: 'kpi', title: 'Logic space（論理空間の踏破）',
    items: [
      { label: '空間の広さ', value: (info.space_size || 0).toLocaleString('en-US'), unit: `通り（コア ${(p.core_size || 0).toLocaleString('en-US')} + 合成 ${(p.rule_size || 0).toLocaleString('en-US')}）` },
      { label: 'コア層の踏破', value: `${info.evaluated_core || 0}`, unit: `/${p.core_size || 0} 通り（${info.coverage_pct_core || 0}%）` },
      { label: '合成層の探索', value: info.evaluated_rule || 0, unit: '件（無作為＋王者近傍の変異）' },
      { label: 'フル検証を通過', value: info.passed || 0, unit: '件（EA候補になり得るもの）' },
      { label: '1日の消化', value: p.per_day || 0, unit: `件（${p.every_minutes}分ごと × ${p.per_tick}件）` },
      { label: 'コア全通りまで', value: p.core_days || '—', unit: '日（この速度のままなら）' },
    ],
  };
  const list = {
    type: 'list', title: 'いま上位の論理（試した順ではなく、点数の順）',
    items: (info.top || []).slice(0, 5).map((t) => ({
      label: `${t.symbol}｜${t.logic}`,
      value: `fitness ${t.fitness}`,
      unit: `純益 ${t.net ?? '?'}% / DD ${t.dd ?? '?'}% / PF ${t.pf ?? '?'} / ${t.trades ?? '?'}取引${t.promoted ? ' / 昇格済' : ''}`,
    })),
  };
  const note = { type: 'note', text: `${info.cost || ''} ${info.where_it_runs || ''} 空間に入っていないもの: ${(info.not_included || []).slice(0, 4).join(' / ')} ほか。` };
  return [kpi, list, note];
}

export function logicHelp() {
  return [
    '「この世に存在しうるロジック」を全部列挙することは原理的にできません（語彙が無限に増えるため）。そこで、語彙を固定した文法（文法＝指標 × しきい値 × 演算子 × 絞り込み × 出口 × 方向 × 時間軸 × 銘柄）を作り、その中で作れる論理に番号を振って数え上げます。番号が振れる＝「どこまで見たか」を数字で言える、ということです。',
    '空間は2層です。コア層（既知の17ロジック×パラメータ×絞り込み×出口×方向×時間軸×銘柄）は番号順に全通り踏破します。合成層（指標の条件を2つ AND/OR で組む論理）は広大なので、無作為に引きつつ、伸びている論理の近傍を変異させて探索します。',
    'このループは Cloudflare の Cron（Workerの中）で回ります。手元のパソコンやサンドボックスは使いません。1tickあたり少数だけ回し、CPU予算を使い切ったら残りは次tickへ回すので、途中で黙って落ちることはありません。結果はD1に積み上がり、失敗も消しません。',
    '昇格（＝EAやPineの対象になること）の条件は変えていません。門（取引30回以上・PF1.15以上・期待値プラス・DD35%以下）を通り、さらにフル検証11項目（データ品質／パージドCV／PBO／DSR／ブートストラップ／符号反転／ランダムエントリー比較／費用耐性／相場環境／パラメータ台地／多重検定補正）を全部通った論理だけです。通らないものは「暫定」として記録だけ残します。',
    'なので探索の設計を変えました。(1) コア層は同じ設定を複数の銘柄に同時に当て、過半の銘柄で門を通ったときだけ候補にします（1つの銘柄だけで偶然よく見えた設定を昇格させない）。(2) 合成層は仮説を1つの指標に絞ってから探索します（的を絞って試行の質を上げる）。(3) 検証に「破産判定」と「含み損込みの最大DD」を入れました（実現損益だけのDDは、含みで深く沈む危険を見落とすため）。',
    'なぜ簡単に通らないかも正直に書きます。試した回数が増えるほど「偶然の1位」が出やすくなるので、DSR（試行回数を織り込んだSharpe）が厳しくなります。つまり、たくさん試すこと自体が合格を難しくします。これは欠陥ではなく、過剰最適化を防ぐための設計です。',
    'この空間に入っていないもの（＝ここでは検証しないもの）: ' + NOT_INCLUDED.join(' / ') + '。',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Pine 出力 — 昇格した論理を、そのまま TradingView で確認できる形にする。
//   忠実度を明示する: 合成層（部品の組合せ）は完全一致（exact）。
//   既知ロジックの型を使う場合は、絞り込み条件と週足指定までは再現しない（partial）。
// ---------------------------------------------------------------------------
const PINE_PRELUDE = {
  __MACD__: { lines: ['macdLine = ta.ema(close, 12) - ta.ema(close, 26)', 'macdSig = ta.ema(macdLine, 9)', 'macdHistN = (macdLine - macdSig) / ta.atr(14)'], expr: 'macdHistN' },
  __ADX__: { lines: ['[diPlus, diMinus, adxVal] = ta.dmi(14, 14)'], expr: 'adxVal', group: 'dmi' },
  __DIDIFF__: { lines: ['[diPlus, diMinus, adxVal] = ta.dmi(14, 14)'], expr: '(diPlus - diMinus)', group: 'dmi' },
  __STDIR__: { lines: ['[stLine, stDir] = ta.supertrend(3, 10)'], expr: 'stDir' },
  __BWRATIO__: { lines: ['bbBw = (2 * ta.stdev(close, 20)) / ta.sma(close, 20)', 'bbBwAvg = ta.sma(bbBw, 120)', 'bwRatio = bbBw / bbBwAvg'], expr: 'bwRatio' },
  __MONTHTURN__: { lines: ['mtNextM = month == 12 ? 1 : month + 1', 'mtNextY = month == 12 ? year + 1 : year', 'mtLastDom = dayofmonth(timestamp(mtNextY, mtNextM, 1) - 86400000)', 'mtInWindow = dayofmonth >= mtLastDom - 2 or dayofmonth <= 3'], expr: 'mtInWindow' },
};

function pineVarsFor(featureKeys) {
  const lines = [];
  const vars = {};
  const groups = new Set();
  for (const f of featureKeys) {
    const pre = FEATURES[f]?.pine || 'na';
    if (pre.startsWith('__') && PINE_PRELUDE[pre]) {
      const def = PINE_PRELUDE[pre];
      if (def.group) {
        if (!groups.has(def.group)) { lines.push(...def.lines); groups.add(def.group); }
      } else lines.push(...def.lines);
      vars[f] = def.expr;
    } else {
      vars[f] = `v_${f}`;
      lines.push(`v_${f} = ${pre}`);
    }
  }
  return { lines, vars };
}

function pineAtom(atom, vars) {
  const v = vars[atom.f] || 'close';
  if (atom.op === 'gt') return `(${v} > ${atom.th})`;
  if (atom.op === 'lt') return `(${v} < ${atom.th})`;
  if (atom.op === 'xup') return `(${v} > ${atom.th} and ${v}[1] <= ${atom.th})`;
  return `(${v} < ${atom.th} and ${v}[1] >= ${atom.th})`;
}

function pineAtomNot(atom, vars) {
  const v = vars[atom.f] || 'close';
  if (atom.op === 'gt') return `(${v} <= ${atom.th})`;
  if (atom.op === 'lt') return `(${v} >= ${atom.th})`;
  if (atom.op === 'xup') return `not (${v} > ${atom.th} and ${v}[1] <= ${atom.th})`;
  return `not (${v} < ${atom.th} and ${v}[1] >= ${atom.th})`;
}

export function logicPine(spec, params = {}, { symbol = 'USDJPY', version = 'v6' } = {}) {
  const d = describeLogic(spec);
  const e = exitParams(spec);
  const stopMult = Number(params.atrStopMult ?? e.atrStopMult);
  const tpMult = Number(params.atrTargetMult ?? e.atrTargetMult);
  const hold = Number(params.maxHoldBars ?? e.maxHoldBars);
  const trail = Number(params.trailAtrMult ?? e.trailAtrMult);
  const head = `${d.line}`;
  const notice = `// --- Logic space から昇格した論理 ---
// 論理: ${head}
// 出口: 損切 ${stopMult}×ATR / 利確 ${tpMult > 0 ? `${tpMult}×ATR` : 'なし'} / 最大保有 ${hold > 0 ? `${hold}バー` : 'なし'} / トレーリング ${trail > 0 ? `${trail}×ATR` : 'なし'}
// 約束しないこと: 過去データの成績は将来の利益を保証しません。まずデモ（またはペーパー）で前向きに確認してください。`;

  // 既知ロジックの型を使う場合は、その型のテンプレートを土台にする（忠実度: partial）
  if (spec.base?.kind === 'strategy') {
    const baseParams = {
      ...(spec.base.params || {}),
      atrStopMult: stopMult,
      atrTargetMult: tpMult > 0 ? tpMult : 0,
      allowShort: e.allowShort,
      trendFilter: (spec.base.params || {}).trendFilter ?? undefined,
    };
    let code = null;
    try { code = generatePine(spec.base.key, baseParams, { version, symbol }); } catch { code = null; }
    if (code) {
      const nl = code.indexOf('\n');
      const first = nl >= 0 ? code.slice(0, nl) : code;
      const rest = nl >= 0 ? code.slice(nl + 1) : '';
      const caveat = spec.tf === '1w'
        ? `// 忠実度: partial — 週足の指定を再現していません。週足チャートに載せ替えて使ってください。`
        : `// 忠実度: partial — 絞り込み条件（${FILTERS.find((f) => f.key === spec.filter)?.label || spec.filter}）はこのテンプレートに含まれていません。`;
      return `${first}\n${notice}\n${caveat}\n${rest}`;
    }
  }

  const usedFeatures = new Set();
  const atoms = [];
  if (spec.base?.kind === 'rule') {
    const A = ATOMS[spec.base.a];
    const B = spec.base.b == null ? null : ATOMS[spec.base.b];
    if (A) { atoms.push(A); usedFeatures.add(A.f); }
    if (B) { atoms.push(B); usedFeatures.add(B.f); }
  }
  const filterKey = spec.filter;
  const filterDef = FILTERS.find((f) => f.key === filterKey) || FILTERS[0];
  const marker = String(filterDef.pine || 'true').match(/__[A-Z]+__/g);
  if (filterKey === 'month_turn') usedFeatures.add('__monthturn__');
  const { lines: preLines, vars } = pineVarsFor([...usedFeatures].filter((f) => FEATURES[f]));

  const longParts = atoms.map((a) => pineAtom(a, vars));
  const shortParts = atoms.map((a) => pineAtomNot(a, vars));
  const comb = spec.base?.comb === 'or' ? ' or ' : ' and ';
  const longExpr = longParts.length ? `(${longParts.join(comb)})` : 'false';
  const shortExpr = shortParts.length ? `(${shortParts.join(comb)})` : 'false';

  let filterExpr = String(filterDef.pine || 'true');
  for (const mk of (marker || [])) {
    const def = PINE_PRELUDE[mk];
    if (def) { filterExpr = filterExpr.split(mk).join(def.expr); for (const ln of def.lines) if (!preLines.includes(ln)) preLines.push(ln); }
    else if (mk === '__MONTHTURN__') filterExpr = filterExpr.split(mk).join('mtInWindow');
  }

  const dirLong = spec.dir !== 'short';
  const dirShort = spec.dir !== 'long';
  const tfNote = spec.tf === '1w'
    ? `\n// 週足の論理です。週足チャートに載せ替えて使ってください（日足で再計算すると別物になります）。`
    : '';
  const tfSuffix = spec.tf === '1w' ? ' (Weekly)' : '';

  const script = `//@version=${version === 'v5' ? '5' : '6'}
strategy("WealthAgent ${spec.tier}${spec.idx != null ? ` #${spec.idx}` : ''} ${symbol}${tfSuffix}", overlay=true, initial_capital=100000, currency=currency.JPY, commission_type=strategy.commission.cash_per_order, commission_value=0, slippage=2, process_orders_on_close=false)
${notice}
// 忠実度: exact — バックテストと同じ条件（合成層は完全一致）
// 空間に入っていないものは再現しません（分足・板・ニュース・ML等）。${tfNote}
${preLines.join('\n')}

longCond = ${longExpr}
shortCond = ${shortExpr}
filterOk = ${filterExpr}

rawLong = longCond and filterOk
rawShort = shortCond and filterOk
enterLong = ${dirLong ? 'barstate.isconfirmed and rawLong and not rawLong[1]' : 'false'}
enterShort = ${dirShort ? 'barstate.isconfirmed and rawShort and not rawShort[1]' : 'false'}

if enterLong
    strategy.entry("L", strategy.long)
if enterShort
    strategy.entry("S", strategy.short)

stopMult = ${stopMult}
tpMult = ${tpMult}
holdBars = ${hold}
trailMult = ${trail}
a = ta.atr(14)

if strategy.position_size != 0 and holdBars > 0 and strategy.opentrades > 0 and bar_index - strategy.opentrades.entry_bar_index(0) >= holdBars
    strategy.close_all()

if strategy.position_size > 0
    strategy.exit("L-exit", from_entry="L", stop=strategy.position_avg_price - a * stopMult, limit=tpMult > 0 ? strategy.position_avg_price + a * stopMult * tpMult : na, trail_points=trailMult > 0 ? (a * trailMult) / syminfo.mintick : na, trail_offset=trailMult > 0 ? 1 : na)
if strategy.position_size < 0
    strategy.exit("S-exit", from_entry="S", stop=strategy.position_avg_price + a * stopMult, limit=tpMult > 0 ? strategy.position_avg_price - a * stopMult * tpMult : na, trail_points=trailMult > 0 ? (a * trailMult) / syminfo.mintick : na, trail_offset=trailMult > 0 ? 1 : na)
`;
  return script;
}
