# patch_lab_auto.py — 作業台を「見るだけ」から「エージェント側で勝手に回る」へ
# 変更点:
#   1) lab.js: 版を lab-1.1 に。E8の採点に「支払い補正」を入れる（合格率だけで選ばない）。
#   2) lab.js: 門を通した個体だけを E8 実行部へ渡す集合（lab:collection）と、その台帳（lab:auto）を作る。
#   3) lab.js: 前回の勝ち個体を変異させて次の探索の種にする（勾配の代わり）。
#   4) e8Runner.js: ロジック源の優先順に lab:collection を挟む。
#   5) scheduler / index.js / wrangler: 5分ごと・8件・自動引き渡しを有効に。
#   6) tests/lab.test.mjs: 追加分のテスト。
import io, sys

ROOT = "/home/user/workspace/wealth-agent/"

def patch(path, pairs):
    src = io.open(ROOT + path, encoding="utf-8").read()
    for i, (old, new) in enumerate(pairs):
        if old not in src:
            print("MISS %s #%d" % (path, i))
            print(old[:160])
            sys.exit(1)
        if src.count(old) != 1:
            print("AMBIGUOUS %s #%d (%d)" % (path, i, src.count(old)))
            sys.exit(1)
        src = src.replace(old, new, 1)
    io.open(ROOT + path, "w", encoding="utf-8").write(src)
    print("patched %s (%d)" % (path, len(pairs)))

# ---------------------------------------------------------------------------
# lab.js
# ---------------------------------------------------------------------------
lab = []

lab.append((
"""export const LAB_VERSION = 'lab-1.0';
export const LAB_STATS_KEY = 'lab:stats';""",
"""export const LAB_VERSION = 'lab-1.1';
export const LAB_STATS_KEY = 'lab:stats';
// 自律ループの台帳（lab:auto）と、E8実行部へ渡す自動選抜の集合（lab:collection）。
// 人が画面を開かなくても、エージェントが自分で選抜・引き渡し・記録まで進む。
export const LAB_AUTO_KEY = 'lab:auto';
export const LAB_COLLECTION_KEY = 'lab:collection';
export const LAB_AUTO_MAX_LOG = 24;"""))

lab.append((
"""  e8: 'score = 合格率(%) × (1/100) × 生存補正。生存補正は含み損込み最大DDが35%超で 1−(DD−35)/65。',""",
"""  e8: 'score = 合格率(%) × (1/100) × 生存補正 × 支払い補正。生存補正は含み損込み最大DDが35%超で 1−(DD−35)/65。'
    + '支払い補正は 0.5 + min(1, 期待値USD/2000)/2（支払いの中央値が出ない個体は半分に沈む）。'
    + 'つまり「選考に通るか」ではなく「資金提供後に払い出せるか」で選ぶ。',"""))

lab.append((
"""export function labE8Score(boot = {}, metrics = {}) {
  const pr = num(boot.passRatePct, 0);
  const dd = num(metrics.maxDrawdownPctMtm ?? metrics.maxDrawdownPct, 0);
  const adj = dd <= 35 ? 1 : Math.max(0.05, 1 - (dd - 35) / 65);
  return round((pr / 100) * adj, 4);
}""",
"""export function labE8Score(boot = {}, metrics = {}, pay = null) {
  const pr = num(boot.passRatePct, 0);
  const dd = num(metrics.maxDrawdownPctMtm ?? metrics.maxDrawdownPct, 0);
  const adj = dd <= 35 ? 1 : Math.max(0.05, 1 - (dd - 35) / 65);
  // 支払い補正: 支払いを計算していない個体は 1（＝合格率だけで採点）、
  // 計算した個体は期待値（合格率×月次支払い中央値）で 0.5〜1.0 に沈む／戻る。
  let evUSD = null;
  if (pay && (pay.medianMonthly != null || pay.evIndexUSD != null)) {
    evUSD = pay.evIndexUSD != null ? num(pay.evIndexUSD, 0) : round((pr / 100) * num(pay.medianMonthly, 0), 0);
  }
  const payAdj = evUSD == null ? 1 : round(0.5 + Math.min(1, Math.max(0, evUSD) / 2000) / 2, 4);
  return round((pr / 100) * adj * payAdj, 4);
}"""))

lab.append((
"""export async function labSearch({
  store, mode = 'own', env = {}, n = 12, opts = {}, settings = {}, ctx = {}, at = null, persist = true, budgetMs = null, features = null,
} = {}) {""",
"""export async function labSearch({
  store, mode = 'own', env = {}, n = 12, opts = {}, settings = {}, ctx = {}, at = null, persist = true, budgetMs = null, features = null, seeds = [],
} = {}) {"""))

lab.append((
"""  const specs = candidateSpecs(rnd, { count: clamp(num(n, 12), 1, 40), features });""",
"""  // 種（前回の勝ち個体を変異させたもの）を先に走らせる。無作為だけでなく勾配も混ぜる。
  const seedSpecs = (Array.isArray(seeds) ? seeds : []).filter((s) => s && typeof s === 'object');
  const specs = [...seedSpecs, ...candidateSpecs(rnd, { count: clamp(num(n, 12), 1, 40), features })];"""))

lab.append((
"""      if (mode === 'e8') {
        const boot = bootstrapPass(ev.daily, labE8Plan(settings.profile, settings), {
          trials: clamp(num(settings.trials, 120), 40, 400), blockDays: 5, maxHorizonDays: 252,
          seed: `lab-search-e8-${ev.key}`, scale: num(settings.scale, 0.75), initialBalance: num(settings.accountSize, 100000),
        });
        score = labE8Score(boot, ev.metrics.oos);
        objective = { passRatePct: boot.passRatePct, medianDays: boot.medianDays, p25Days: boot.p25Days, p75Days: boot.p75Days, breaches: boot.breaches };
      } else {""",
"""      if (mode === 'e8') {
        const boot = bootstrapPass(ev.daily, labE8Plan(settings.profile, settings), {
          trials: clamp(num(settings.trials, 120), 40, 400), blockDays: 5, maxHorizonDays: 252,
          seed: `lab-search-e8-${ev.key}`, scale: num(settings.scale, 0.75), initialBalance: num(settings.accountSize, 100000),
        });
        // 支払い（資金提供後）まで見る。合格率が低い個体に計算しても意味がないので、
        // 合格率40%以上かつ門を通った個体だけ、軽い試行数で計算する（予算は原価0の範囲）。
        let pay = null;
        if (boot.passRatePct >= 40 && ev.gates.pass) {
          try {
            pay = fundedPayouts(ev.daily, labE8Plan(settings.profile, settings), {
              accountSize: num(settings.accountSize, 100000), months: clamp(num(settings.months, 12), 1, 36),
              trials: clamp(Math.round(num(settings.trials, 120) / 2), 40, 120), blockDays: 5,
              seed: `lab-search-e8-pay-${ev.key}`, scale: num(settings.scale, 0.75),
            });
          } catch (e) { pay = null; }
        }
        score = labE8Score(boot, ev.metrics.oos, pay);
        objective = {
          passRatePct: boot.passRatePct, medianDays: boot.medianDays, p25Days: boot.p25Days, p75Days: boot.p75Days, breaches: boot.breaches,
          survivorPct: pay ? pay.survivorPct : null,
          medianMonthlyUSD: pay ? pay.medianMonthly : null,
          evIndexUSD: pay ? round((num(boot.passRatePct, 0) / 100) * num(pay.medianMonthly, 0), 0) : null,
        };
      } else {"""))

lab.append((
"""        score, objective, gates: ev.gates, metrics: { oos: ev.metrics.oos, is: ev.metrics.is }, spec,""",
"""        score, objective, gates: ev.gates, metrics: { oos: ev.metrics.oos, is: ev.metrics.is }, spec,
        origin: spec.__seed ? 'evolve' : 'random',"""))

lab.append((
"""export async function labBoard(store, { mode = 'own', limit = 30 } = {}) {
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
}""",
"""export async function labBoard(store, { mode = 'own', limit = 30 } = {}) {
  const rows = await store.all(`SELECT symbol,strategy_key,params_json,metrics_json,fitness,verdict,gates_json,tag,date_from,date_to,bars,created_at
    FROM ${T} WHERE tag=? ORDER BY fitness DESC LIMIT ?`, `lab:${mode}`, clamp(num(limit, 30), 1, 200)).catch(() => []);
  return rows.map((r) => {
    const m = safeJson(r.metrics_json, {}) || {};
    const p = safeJson(r.params_json, {}) || {};
    const spec = p.spec || null;
    return {
      symbol: r.symbol, key: r.strategy_key, fitness: r.fitness, verdict: r.verdict,
      gatesPass: r.verdict === 'pass',
      reasons: safeJson(r.gates_json, []) || [], at: r.created_at, bars: r.bars, from: r.date_from, to: r.date_to,
      oosNetPct: (m.oos && m.oos.netProfitPct) ?? m.netProfitPct ?? null,
      oosDdMtmPct: (m.oos && (m.oos.maxDrawdownPctMtm ?? m.oos.maxDrawdownPct)) ?? null,
      objective: m.objective || null, mode: m.mode || mode,
      label: m.label || (spec ? specLabel(spec) : null) || null,
      spec,
    };
  });
}

// ---------------------------------------------------------------------------
// 自律ループ: 門を通した個体だけを E8 実行部へ渡し、何をしたかを台帳に残す
// ---------------------------------------------------------------------------
/** 門を通った個体だけを集合にする。重みは素点の順位で薄く減衰させ、合計1に正規化する。 */
export function labCollectionFrom(rows = [], { max = 6 } = {}) {
  const seen = new Set(); const members = []; const skipped = [];
  const sorted = rows.filter((r) => r && r.gatesPass && r.spec).sort((a, b) => num(b.fitness, 0) - num(a.fitness, 0));
  for (const r of sorted) {
    if (members.length >= max) { skipped.push({ symbol: r.symbol, key: r.key, why: 'over_max' }); continue; }
    const k = `${r.symbol}|${r.key}`;
    if (seen.has(k)) { skipped.push({ symbol: r.symbol, key: r.key, why: 'duplicate' }); continue; }
    seen.add(k);
    members.push({
      symbol: r.symbol, key: r.key, from: 'lab:auto', label: r.label || `${r.symbol} / ${r.key}`,
      params: { ...exitParams(r.spec), logic: r.spec, symbol: r.symbol },
      score: num(r.fitness, 0), objective: r.objective || null,
      oosNetPct: r.oosNetPct ?? null, oosDdMtmPct: r.oosDdMtmPct ?? null,
    });
  }
  const raw = members.map((m, i) => 1 / (1 + i * 0.2));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  members.forEach((m, i) => { m.weight = round(raw[i] / sum, 4); });
  return { members, skipped };
}

/** いま一番良い個体。モードごとに床を変える（E8は支払い補正で沈むので低め）。 */
export function pickChampion(rows = [], mode = 'own', { minScore = null } = {}) {
  const floor = minScore == null ? (mode === 'e8' ? 0.3 : 0.8) : num(minScore, 0);
  const ok = rows.filter((r) => r && r.gatesPass && num(r.fitness, -1e9) >= floor).sort((a, b) => num(b.fitness, 0) - num(a.fitness, 0));
  return ok[0] || null;
}

/** 台帳と集合をまとめて更新する（1tickごと）。人が押さなくても呼ばれる。 */
export async function labAuto({ store, env = {}, now = null, rows = null } = {}) {
  const at = now || nowIso();
  const [own, e8] = rows && rows.own && rows.e8
    ? [rows.own, rows.e8]
    : await Promise.all([
      labBoard(store, { mode: 'own', limit: 60 }).catch(() => []),
      labBoard(store, { mode: 'e8', limit: 60 }).catch(() => []),
    ]);
  const ownChamp = pickChampion(own, 'own');
  const e8Champ = pickChampion(e8, 'e8');
  const { members, skipped } = labCollectionFrom(e8, { max: clamp(num(env.LAB_AUTO_MAX_MEMBERS, 6), 2, 8) });
  const prev = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LAB_COLLECTION_KEY).catch(() => null))?.value, null);
  const prevKeys = ((prev && prev.members) || []).map((m) => `${m.symbol}|${m.key}`);
  const newKeys = members.map((m) => `${m.symbol}|${m.key}`);
  const changed = JSON.stringify(prevKeys) !== JSON.stringify(newKeys);
  const minMembers = clamp(num(env.LAB_AUTO_MIN_MEMBERS, 2), 1, 8);
  const wrote = members.length >= minMembers;
  if (wrote) {
    const payload = {
      at, source: 'lab:auto', version: LAB_VERSION, mode: 'e8', members, skipped, keys: newKeys,
      objective: LAB_OBJECTIVES.e8,
      champion: e8Champ ? { symbol: e8Champ.symbol, key: e8Champ.key, label: e8Champ.label, score: e8Champ.fitness, objective: e8Champ.objective } : null,
      note: '作業台が門を通した個体だけを E8 実行部へ渡す。門を通る個体が足りないときは前の集合を残す（黙って既定に戻さない）。',
    };
    await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      LAB_COLLECTION_KEY, j(payload), at).catch(() => {});
  }
  const brief = (r) => (r ? { symbol: r.symbol, key: r.key, label: r.label, score: r.fitness, objective: r.objective || null } : null);
  const ledger = {
    at, version: LAB_VERSION,
    own: { candidates: own.length, passed: own.filter((r) => r.gatesPass).length, champion: brief(ownChamp) },
    e8: {
      candidates: e8.length, passed: e8.filter((r) => r.gatesPass).length, champion: brief(e8Champ),
      collection: { members: members.length, keys: newKeys, wrote, previous: prevKeys, changed, minMembers },
    },
    skipped: skipped.slice(0, 8),
    handoff: wrote
      ? (changed ? 'E8実行部のロジック源を更新した（lab:collection）' : 'E8実行部のロジック源は前回と同じ')
      : `門を通る個体が${members.length}本しか無いので前の集合を残した`,
  };
  const hist = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LAB_AUTO_KEY).catch(() => null))?.value, null) || { entries: [] };
  hist.entries = [ledger, ...(hist.entries || [])].slice(0, LAB_AUTO_MAX_LOG);
  hist.last = ledger;
  hist.ticks = num(hist.ticks, 0) + 1;
  await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    LAB_AUTO_KEY, j(hist), at).catch(() => {});
  return ledger;
}

export async function labAutoStatus(store) {
  const auto = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LAB_AUTO_KEY).catch(() => null))?.value, null);
  const col = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LAB_COLLECTION_KEY).catch(() => null))?.value, null);
  return { last: (auto && auto.last) || null, ticks: num(auto && auto.ticks, 0), entries: ((auto && auto.entries) || []).slice(0, 10), collection: col || null };
}

/** 前回の勝ち個体を少し変異させて、次の探索の種にする（勾配の代わり）。 */
export async function labEvolveSeeds(store, env = {}) {
  const out = { own: [], e8: [] };
  const count = clamp(num(env.LAB_SEED_MUTATIONS, 2), 0, 4);
  if (!count) return out;
  try {
    const { mutateGenome } = await import('./optimizer.js');
    const rnd = seededRandom(`lab-evolve-${nowIso().slice(0, 16)}`);
    for (const mode of ['own', 'e8']) {
      const board = await labBoard(store, { mode, limit: 12 }).catch(() => []);
      const champ = pickChampion(board, mode);
      if (!champ || !champ.spec) continue;
      for (let i = 0; i < count; i++) {
        try {
          const g = mutateGenome(rnd, { spec: champ.spec, key: champ.key }, SYMBOLS);
          if (g && g.spec) { g.spec.__seed = true; g.spec.__from = champ.key; out[mode].push(g.spec); }
        } catch (e) { /* 変異できない形なら種なしで進む（探索自体は回す） */ }
      }
    }
  } catch (e) { /* optimizer が読めない環境でも探索は回す */ }
  return out;
}"""))

lab.append((
"""  const n = clamp(num(env.LAB_SEARCH_N, 6), 1, 24);
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
  } catch (e) { out.e8 = { error: String((e && e.message) || e).slice(0, 160) }; }""",
"""  const n = clamp(num(env.LAB_SEARCH_N, 6), 1, 24);
  const budget = num(env.LAB_BUDGET_MS, 15000);
  const ctx = { mdCache: new Map(), fxCache: new Map() };
  const out = { at, own: null, e8: null, auto: null, seeds: null };
  // 前回の勝ち個体を変異させた種を混ぜる（無作為だけでなく勾配も回す）。
  const seeds = env.LAB_EVOLVE === 'false' ? { own: [], e8: [] } : await labEvolveSeeds(store, env);
  out.seeds = { own: seeds.own.length, e8: seeds.e8.length };
  try {
    const own = await labSearch({ store, mode: 'own', env, n, ctx, at, seeds: seeds.own, budgetMs: Math.round(budget * 0.5), settings: { capitalJPY: OWN_CAPITAL_DEFAULT, riskMultiple: 1, targetMultiple: 1, months: 12, ruinFloorPct: 10, trials: 120 } });
    out.own = own.summary;
  } catch (e) { out.own = { error: String((e && e.message) || e).slice(0, 160) }; }
  try {
    const e8 = await labSearch({ store, mode: 'e8', env, n, ctx, at, seeds: seeds.e8, budgetMs: Math.round(budget * 0.5), settings: { profile: env.E8_PROFILE || 'p10', accountSize: num(env.E8_ACCOUNT, 100000), scale: num(env.E8_SCALE, 0.75), trials: 120 } });
    out.e8 = e8.summary;
  } catch (e) { out.e8 = { error: String((e && e.message) || e).slice(0, 160) }; }
  // 門を通した個体を E8 実行部へ引き渡す（人が押さなくてもここで進む）。
  try {
    out.auto = await labAuto({ store, env, now: at });
  } catch (e) { out.auto = { error: String((e && e.message) || e).slice(0, 160) }; }"""))

lab.append((
"""  stats.lastOwn = out.own; stats.lastE8 = out.e8;""",
"""  stats.lastOwn = out.own; stats.lastE8 = out.e8; stats.lastAuto = out.auto;
  stats.auto_ticks = num(stats.auto_ticks, 0) + (out.auto && !out.auto.error ? 1 : 0);"""))

lab.append((
"""  const [ownTop, e8Top] = await Promise.all([
    labBoard(store, { mode: 'own', limit: 10 }).catch(() => []),
    labBoard(store, { mode: 'e8', limit: 10 }).catch(() => []),
  ]);
  return {
    version: LAB_VERSION, stats, board, ownTop, e8Top,""",
"""  const [ownTop, e8Top] = await Promise.all([
    labBoard(store, { mode: 'own', limit: 10 }).catch(() => []),
    labBoard(store, { mode: 'e8', limit: 10 }).catch(() => []),
  ]);
  const auto = await labAutoStatus(store).catch(() => null);
  return {
    version: LAB_VERSION, stats, board, ownTop, e8Top, auto,"""))

lab.append((
"""  L.push('画面: /lab.html（2つのタブ）');""",
"""  if (st.auto) {
    const a = st.auto.last;
    if (a) {
      const c = (x) => (x ? `${x.symbol} ${round(x.score, 4)}` : 'まだ無し');
      L.push(`自律ループ: 累計 ${st.auto.ticks || 0} tick / 自己資金の最良 ${c(a.own && a.own.champion)} / E8の最良 ${c(a.e8 && a.e8.champion)}`);
      L.push(`E8実行部への引き渡し: ${a.handoff}（集合 ${a.e8.collection.members}本 / 前回 ${a.e8.collection.previous.length}本 / 門通過 ${a.e8.passed}本）`);
      if (a.e8.collection.keys.length) L.push(`  集合の中身: ${a.e8.collection.keys.join(', ')}`);
    } else {
      L.push('自律ループ: まだ台帳が無い（次のtickで作られる）');
    }
  }
  L.push('画面: /lab.html（2つのタブ）');"""))


patch("src/income/lab.js", lab)

# ---------------------------------------------------------------------------
# e8Runner.js — ロジック源の優先順に lab:collection を挟む
# ---------------------------------------------------------------------------
e8 = []

e8.append((
"""//   1) env.E8_LOGICS（明示: "USDJPY:donchian_breakout,GOLD:ema_cross"）
//   2) 探索器（optimizer.js）が選んだ「相関の低い集合」= opt:collection
//   3) 既定（過去10年を生き残った5本の等加重）""",
"""//   1) env.E8_LOGICS（明示: "USDJPY:donchian_breakout,GOLD:ema_cross"）
//   2) 作業台（lab.js）が門を通した個体だけを渡してくる集合 = lab:collection（自律ループが更新する）
//   3) 探索器（optimizer.js）が選んだ「相関の低い集合」= opt:collection
//   4) 既定（過去10年を生き残った5本の等加重）"""))

e8.append((
"""  if (!out.length) {
    const col = safeJson((await store.first(`SELECT value FROM settings WHERE key='opt:collection'`).catch(() => null))?.value, null);""",
"""  if (!out.length) {
    // 作業台（/lab）が「門を通した個体だけ」で作った集合。人が押さなくても毎tick更新される。
    const lab = safeJson((await store.first(`SELECT value FROM settings WHERE key='lab:collection'`).catch(() => null))?.value, null);
    for (const m of (lab && lab.members) || []) {
      push({ symbol: m.symbol, key: m.key, params: m.params || { symbol: m.symbol }, weight: m.weight ?? null, label: m.label || `${m.symbol} / ${m.key}`, from: 'lab' });
    }
  }
  if (!out.length) {
    const col = safeJson((await store.first(`SELECT value FROM settings WHERE key='opt:collection'`).catch(() => null))?.value, null);"""))

e8.append((
"""      logics: 'E8_LOGICS（"USDJPY:donchian_breakout,GOLD:ema_cross"）／未指定なら探索器の集合→既定5本',""",
"""      logics: 'E8_LOGICS（"USDJPY:donchian_breakout,GOLD:ema_cross"）／未指定なら作業台の集合（lab:collection）→探索器の集合→既定5本',"""))

patch("src/income/e8Runner.js", e8)

# ---------------------------------------------------------------------------
# scheduler.js — 何を引き渡したかを報告に残す
# ---------------------------------------------------------------------------
sch = []

sch.append((
"""        const { labTick } = await import('./income/lab.js');
        const r = await labTick({ store, env });
        await setSetting(store, 'lab:last_run_at', nowIso());
        report.steps.push({
          step: 'lab',
          own: r.own ? { evaluated: r.own.evaluated, best: r.own.best ? `${r.own.best.symbol} score=${r.own.best.score}` : null, errors: (r.own.errors || []).length } : null,
          e8: r.e8 ? { evaluated: r.e8.evaluated, best: r.e8.best ? `${r.e8.best.symbol} score=${r.e8.best.score}` : null, errors: (r.e8.errors || []).length } : null,
        });""",
"""        const { labTick } = await import('./income/lab.js');
        const r = await labTick({ store, env });
        await setSetting(store, 'lab:last_run_at', nowIso());
        report.steps.push({
          step: 'lab',
          own: r.own ? { evaluated: r.own.evaluated, best: r.own.best ? `${r.own.best.symbol} score=${r.own.best.score}` : null, errors: (r.own.errors || []).length } : null,
          e8: r.e8 ? { evaluated: r.e8.evaluated, best: r.e8.best ? `${r.e8.best.symbol} score=${r.e8.best.score}` : null, errors: (r.e8.errors || []).length } : null,
          seeds: r.seeds || null,
          auto: r.auto ? { handoff: r.auto.handoff, members: r.auto.e8 ? r.auto.e8.collection.members : null, passed: r.auto.e8 ? r.e8.passed : null } : null,
        });"""))

patch("src/scheduler.js", sch)

# ---------------------------------------------------------------------------
# index.js — 引き渡しの単発実行と台帳の閲覧
# ---------------------------------------------------------------------------
idx = []

idx.append((
"""        if (url.searchParams.get('help') === '1') return json({ ok: true, help: lab.labHelp() });""",
"""        if (url.searchParams.get('help') === '1') return json({ ok: true, help: lab.labHelp() });
        if (request.method === 'GET' && url.searchParams.get('view') === 'auto') {
          return json({ ok: true, auto: await lab.labAutoStatus(deps.store) });
        }"""))

idx.append((
"""        if (sub === 'tick') return json({ ok: true, ...(await lab.labTick({ store: deps.store, env })) });""",
"""        if (sub === 'tick') return json({ ok: true, ...(await lab.labTick({ store: deps.store, env })) });
        if (sub === 'auto') return json({ ok: true, ...(await lab.labAuto({ store: deps.store, env })) });"""))

patch("src/index.js", idx)

# ---------------------------------------------------------------------------
# wrangler.containers.toml — 5分ごと・8件・自動引き渡し
# ---------------------------------------------------------------------------
toml = []

toml.append((
"""LAB_ENABLED = "true"
LAB_EVERY_MINUTES = "15"
LAB_SEARCH_N = "6"
LAB_BUDGET_MS = "15000"
LAB_DAYS = "1600\"""",
"""LAB_ENABLED = "true"
LAB_EVERY_MINUTES = "5"
LAB_SEARCH_N = "8"
LAB_BUDGET_MS = "20000"
LAB_DAYS = "1600"
LAB_AUTO = "true"
LAB_AUTO_MIN_MEMBERS = "2"
LAB_AUTO_MAX_MEMBERS = "6"
LAB_EVOLVE = "true"
LAB_SEED_MUTATIONS = "2\""""))

patch("wrangler.containers.toml", toml)

# ---------------------------------------------------------------------------
# tests/lab.test.mjs
# ---------------------------------------------------------------------------
t = []

t.append((
"""  challengeReplay, labOwnScore, labE8Score, evalGates, candidateSpecs, labHeatmap, labCatalog, trimMetrics,
} from '../src/income/lab.js';""",
"""  challengeReplay, labOwnScore, labE8Score, evalGates, candidateSpecs, labHeatmap, labCatalog, trimMetrics,
  pickChampion, labCollectionFrom, labAuto, LAB_AUTO_KEY, LAB_COLLECTION_KEY,
} from '../src/income/lab.js';"""))

t.append((
"""  ok('版が入っている', LAB_VERSION === 'lab-1.0', LAB_VERSION);""",
"""  ok('版が入っている', LAB_VERSION === 'lab-1.1', LAB_VERSION);"""))

t.append((
"""  const tm = trimMetrics({ trades: 5, netProfitPct: 3, sharpe: 1.2, nonsense: 9 });
  ok('指標は必要なものだけ返す', tm.trades === 5 && tm.nonsense === undefined);
}""",
"""  const tm = trimMetrics({ trades: 5, netProfitPct: 3, sharpe: 1.2, nonsense: 9 });
  ok('指標は必要なものだけ返す', tm.trades === 5 && tm.nonsense === undefined);
}

// 10) 自律ループ（門を通した個体だけを E8 実行部へ渡す）
{
  const specOf = (symbol, key, tier) => ({
    v: 1, tier, symbol, tf: '1d', filter: 'none', exit: 'tight', dir: 'both',
    base: tier === 'rule'
      ? { kind: 'rule', op: 'AND', parts: [] }
      : { kind: 'strategy', key: 'ema_cross', variant: 0, params: {} },
  });
  const row = (o) => ({
    symbol: o.symbol, key: o.key, fitness: o.fitness, verdict: o.pass ? 'pass' : 'fail',
    gatesPass: !!o.pass, reasons: o.pass ? [] : ['OOSの純益がマイナス'], label: `${o.symbol} / ${o.key}`,
    objective: o.objective || null, oosNetPct: 10, oosDdMtmPct: 20, spec: specOf(o.symbol, o.key, o.tier || 'rule'),
  });
  const good = [row({ symbol: 'USDJPY', key: 'g_aaa1', fitness: 0.62, pass: true, objective: { passRatePct: 60, medianMonthlyUSD: 900, survivorPct: 30 } }),
    row({ symbol: 'GOLD', key: 'ema_cross', fitness: 0.41, pass: true, tier: 'core' })];
  const bad = [row({ symbol: 'EURJPY', key: 'g_bbb2', fitness: 0.9, pass: false })];

  const col = labCollectionFrom([...good, ...bad], { max: 6 });
  ok('門を通った個体だけが集合に入る', col.members.length === 2, JSON.stringify(col.members.map((m) => m.key)));
  ok('門を通らなかった個体は理由つきで外れる', col.skipped.length === 0 && col.members.every((m) => m.key !== 'g_bbb2'));
  ok('重みは合計1に正規化される', near(col.members.reduce((a, m) => a + m.weight, 0), 1, 1e-3), JSON.stringify(col.members.map((m) => m.weight)));
  ok('重みは素点の順で減る', col.members[0].weight > col.members[1].weight);
  ok('実行部がそのまま食える params を作る', !!col.members[0].params.logic && col.members[0].params.symbol === 'USDJPY');
  ok('同じ銘柄と論理は重複しない', labCollectionFrom([...good, ...good]).members.length === 2);

  ok('最良は門を通った中から選ぶ', pickChampion([...good, ...bad], 'e8').symbol === 'USDJPY');
  ok('床に届かない個体は選ばない', pickChampion([row({ symbol: 'XAUUSD', key: 'g_c3', fitness: 0.05, pass: true })], 'e8') === null);

  const e8rows = [...good, ...bad];
  const store = {
    _s: new Map(),
    async first(sql, ...p) { return this._s.has(p[0]) ? { value: this._s.get(p[0]) } : null; },
    async run(sql, key, value) { this._s.set(key, value); },
    async all() { return e8rows; },
    async insert() {},
  };
  const auto = await labAuto({ store, env: {}, now: '2026-10-17T09:00:00.000Z' });
  ok('引き渡しを記録する', /lab:collection/.test(auto.handoff), auto.handoff);
  ok('集合を settings に書く', store._s.has(LAB_COLLECTION_KEY) && JSON.parse(store._s.get(LAB_COLLECTION_KEY)).members.length === 2);
  ok('台帳を残す', store._s.has(LAB_AUTO_KEY) && JSON.parse(store._s.get(LAB_AUTO_KEY)).ticks === 1);
  ok('何本通ったかを残す', auto.e8.passed === 2 && auto.e8.candidates === 3, JSON.stringify(auto.e8));
  ok('最良と集合の中身を残す', auto.e8.champion.symbol === 'USDJPY' && auto.e8.collection.keys.length === 2);

  const store2 = {
    _s: new Map([[LAB_COLLECTION_KEY, JSON.stringify({ members: [{ symbol: 'USDJPY', key: 'g_aaa1' }, { symbol: 'GOLD', key: 'ema_cross' }] })]]),
    async first(sql, ...p) { return this._s.has(p[0]) ? { value: this._s.get(p[0]) } : null; },
    async run(sql, key, value) { this._s.set(key, value); },
    async all() { return e8rows; },
    async insert() {},
  };
  const auto2 = await labAuto({ store: store2, env: {}, now: '2026-10-17T09:05:00.000Z' });
  ok('同じ集合なら「更新した」と言わない', auto2.e8.collection.changed === false, auto2.handoff);

  const store3 = {
    _s: new Map(),
    async first() { return null; },
    async run() {},
    async all() { return bad; },
    async insert() {},
  };
  const auto3 = await labAuto({ store: store3, env: {}, now: '2026-10-17T09:10:00.000Z' });
  ok('門を通る個体が無いときは前の集合を残す（黙って既定に戻さない）', auto3.e8.collection.wrote === false && /残した/.test(auto3.handoff), auto3.handoff);
}

// 11) E8の採点は「合格率」ではなく「払い出せるか」まで見る
{
  const dd = { maxDrawdownPctMtm: 20 };
  const noPay = labE8Score({ passRatePct: 60 }, dd, null);
  const thinPay = labE8Score({ passRatePct: 60 }, dd, { medianMonthly: 100 });
  const fatPay = labE8Score({ passRatePct: 60 }, dd, { medianMonthly: 20000 });
  ok('支払いを計算していない個体は合格率だけで採点', near(noPay, 0.6, 1e-6), String(noPay));
  ok('支払いが出ない個体は沈む', thinPay < noPay && thinPay > noPay * 0.4, `${thinPay} vs ${noPay}`);
  ok('支払いが出る個体は戻る（上限1.0）', fatPay > noPay && fatPay <= 0.6, `${fatPay} vs ${noPay}`);
  ok('DDが大きい個体はさらに沈む', labE8Score({ passRatePct: 60 }, { maxDrawdownPctMtm: 80 }, null) < noPay);
}"""))

patch("tests/lab.test.mjs", t)

print("ALL PATCHED")


# labHelp の1行は空白の数が揺れるので、行の頭で探して差し込む。
_lp = ROOT + "src/income/lab.js"
_src = io.open(_lp, encoding="utf-8").read()
_l = _src.split(chr(10))
_hit = [i for i, x in enumerate(_l) if "POST /api/lab/tick" in x]
assert len(_hit) == 1, _hit
_extra = [
    "    '  POST /api/lab/auto         ... 引き渡しだけを今すぐ1回（門を通した個体をE8実行部へ）',",
    "    '  GET  /api/lab?view=auto    ... 自律ループの台帳と、いまE8実行部に渡している集合',",
]
_l[_hit[0]] = _l[_hit[0]] + chr(10) + chr(10).join(_extra)
io.open(_lp, "w", encoding="utf-8").write(chr(10).join(_l))
print("patched labHelp")
