// 試行錯誤の自浄ループ（lab loop）
// 人が指示しなくても、エージェント自身が「測る → 壁を名指しする → 手を変える → 結果を残す」を回す。
// 使うのは原価0の資源だけ（Yahoo Finance の日足・D1・cron）。門（15/6/40/45）は緩めない。
//
// なぜ要るか（2026-10-18 の実測）:
//   * 順位表が fitness DESC だけで並んでいたため、同点が挿入順で固定され、
//     何度回しても同じ顔ぶれが上に居座っていた（XAGUSD の同一論理が 88件・103件 重複）。
//   * 門を通る個体が集合に入ると、同じ個体が毎tick 選び直され「入れ替わらない」。
//   * どこで止まっているのか（取引数 / DD / OOS / 破産 / 分散）を誰も数えていなかった。
// このループは、その3つを毎回の計測として残す。
import { nowIso, j, safeJson, round, clamp, seededRandom } from '../util.js';
const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

// ラウンドID。util に採番ヘルパが無いのでここで作る。
const rid = () => `lbr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
import { labBoardRanked, labPassBoard, pickChampion, labSearch, labCatalog, labAuto } from './lab.js';

export const LAB_LOOP_VERSION = 'labloop-1.0';
export const LR = 'lab_rounds';
export const LL_KEY = 'lab:loop';
export const LL_MAX = 40;
export const STALL_LIMIT = 3;

// 門で止まる理由ごとに「なぜ止まるか」と「次にどう手を変えるか」を1対1で持つ。
export const WALLS = {
  trades: {
    key: 'trades', label: '取引回数が足りない',
    why: '門の取引数（IS15 / OOS6）に届かず、成績以前に落ちている',
    fix: '出口を広げて保有を伸ばし、フィルタを外して回数を増やす',
    action: 'widen_exit', level: 'allow',
  },
  dd: {
    key: 'dd', label: 'DDが深い',
    why: '成績は出ているが最大DDが門（40 / OOS45）を超えている',
    fix: '損切りを詰め、低ボラの時間帯に寄せて振れ幅を下げる',
    action: 'tighten_exit', level: 'allow',
  },
  oos_net: {
    key: 'oos_net', label: 'OOSで負ける',
    why: 'ISでは勝つが、検証側（OOS）で純益がマイナス＝過剰適合',
    fix: '方向とレジームのフィルタを変え、当てはめを削る',
    action: 'reshape_regime', level: 'allow',
  },
  ruin: {
    key: 'ruin', label: '破産経路がある',
    why: '資金が床を割る経路がある',
    fix: '出口を詰め、リスクを下げて破産経路を消す',
    action: 'derisk', level: 'allow',
  },
  structure: {
    key: 'structure', label: '中身が同じ',
    why: '出口違いの同一論理が並び、分散が効かない',
    fix: '銘柄と時間足を回して別の系統を持ってくる',
    action: 'rotate_market', level: 'allow',
  },
  correlation: {
    key: 'correlation', label: '相関が高い',
    why: '既に採った個体と値動きが似ていて、集合の意味が薄い',
    fix: '別の銘柄・別の時間足へ回す',
    action: 'rotate_market', level: 'allow',
  },
  none_pass: {
    key: 'none_pass', label: '門を通る個体が無い',
    why: '候補は出ているが1本も門を通らない',
    fix: '惜しい個体を親に替え、出口を振り直して門に寄せる',
    action: 'mutate_near_miss', level: 'allow',
  },
  plateau: {
    key: 'plateau', label: '伸びが止まった',
    why: '同じ王者の周りを回っていて改善しない',
    fix: '種を捨てて広く探索する',
    action: 'explore_broaden', level: 'allow',
  },
};

const HYPOTHESIS = {
  widen_exit: '保有を伸ばしてフィルタを外せば、取引数が門に届く',
  tighten_exit: '損切りを詰めれば、DDが門の内側に入る',
  reshape_regime: '方向とレジームフィルタを変えれば、OOSの負けが減る',
  derisk: '出口を詰めれば、破産経路が消える',
  rotate_market: '銘柄と時間足を替えれば、分散が効いて門も通りやすい',
  mutate_near_miss: '惜しい個体を親にすれば、門に届く',
  explore_broaden: '広く探索すれば、いまの系統の外に新しい系統が見つかる',
};

export async function ensureLoopTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${LR} (id TEXT PRIMARY KEY, at TEXT, mode TEXT, wall TEXT, wall_why TEXT, action TEXT, hypothesis TEXT, before_json TEXT, after_json TEXT, result_json TEXT, verdict TEXT, delta REAL, note TEXT)`).catch(() => {});
}

/** 門で止まった理由を数えて、いちばん効いている壁を1つ名指しする。 */
export function gateWall(rows = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const pass = list.filter((r) => r.gatesPass).length;
  const counts = { trades: 0, dd: 0, oos_net: 0, ruin: 0, other: 0 };
  for (const r of list) {
    if (r.gatesPass) continue;
    const reasons = (r.reasons || []).map(String);
    if (!reasons.length) { counts.other++; continue; }
    let hit = false;
    for (const t of reasons) {
      if (/取引|trade/i.test(t)) { counts.trades++; hit = true; }
      else if (/DD|drawdown|ドローダウン/i.test(t)) { counts.dd++; hit = true; }
      else if (/純益|net|profit|PF|利益/i.test(t)) { counts.oos_net++; hit = true; }
      else if (/破産|ruin|床/i.test(t)) { counts.ruin++; hit = true; }
    }
    if (!hit) counts.other++;
  }
  const fails = list.length - pass;
  let key = 'none_pass';
  const top = Object.entries(counts).filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1])[0];
  if (pass > 0) key = top && top[1] > 0 ? top[0] : 'plateau';
  else key = top && top[1] > 0 ? top[0] : 'none_pass';
  const w = WALLS[key] || WALLS.none_pass;
  return { ...w, key, counts, pass, fails, total: list.length, dominant: top && top[1] ? top[0] : null };
}

/** 壁に対する打ち手。同じ無変化が続いたら種を捨てて広く探索する（見切りをつける）。 */
export function wallFix(wall, { stall = 0 } = {}) {
  const base = WALLS[(wall && wall.key) || 'none_pass'] || WALLS.none_pass;
  if (num(stall, 0) >= STALL_LIMIT) {
    return {
      key: 'explore_broaden', of: base.key, level: 'allow',
      why: `${STALL_LIMIT}回続けて改善が無い（${base.label}）`,
      note: '種を捨てて広く探索する', hypothesis: HYPOTHESIS.explore_broaden, escalated: true,
    };
  }
  return { key: base.action, of: base.key, level: base.level, why: base.why, note: base.fix, hypothesis: HYPOTHESIS[base.action] || '', escalated: false };
}

const FALLBACK_SYMBOLS = ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCHF', 'USDCAD', 'XAUUSD', 'XAGUSD', 'BTCUSD', 'ETHUSD'];

function symbolList(env = {}, rows = []) {
  try {
    const cat = labCatalog(env) || {};
    const list = (cat.symbols || []).map((x) => (typeof x === 'string' ? x : x && (x.key || x.symbol))).filter(Boolean);
    if (list.length >= 4) return list;
  } catch (e) { /* 一覧が読めないときは下の候補で回す */ }
  const seen = [...new Set(rows.map((r) => r && r.symbol).filter(Boolean))];
  return seen.length >= 4 ? seen : FALLBACK_SYMBOLS;
}

/** 打ち手に合わせて種（親の変異体）を作る。空配列なら無作為探索に任せる。 */
export function targetedSeeds(mode, action, rows = [], rnd = Math.random, env = {}) {
  const act = (action && action.key) || 'explore_broaden';
  if (act === 'explore_broaden') return [];
  const withSpec = (Array.isArray(rows) ? rows : []).filter((r) => r && r.spec);
  const champ = pickChampion(rows, mode) || withSpec.sort((a, b) => num(b.fitness, 0) - num(a.fitness, 0))[0] || null;
  if (!champ || !champ.spec) return [];
  const s = champ.spec;
  const syms = symbolList(env, rows);
  const i = syms.indexOf(s.symbol);
  const nextSym = syms[(i + 1 + syms.length) % syms.length];
  const clone = (patch) => ({ ...s, ...patch, __seed: true, __from: `labloop:${act}` });
  const out = [];
  if (act === 'widen_exit') out.push(clone({ exit: 'wide' }), clone({ exit: 'trail' }), clone({ exit: 'timebox', filter: 'none' }));
  else if (act === 'tighten_exit') out.push(clone({ exit: 'tight' }), clone({ exit: 'trail', filter: 'vol_low' }));
  else if (act === 'reshape_regime') out.push(clone({ filter: 'trend_up' }), clone({ filter: 'adx20' }), clone({ dir: s.dir === 'long' ? 'short' : 'long' }));
  else if (act === 'derisk') out.push(clone({ exit: 'tight' }), clone({ exit: 'tight', filter: 'vol_low' }));
  else if (act === 'rotate_market') out.push(clone({ symbol: nextSym }), clone({ tf: s.tf === '1d' ? '1w' : '1d' }), clone({ symbol: nextSym, exit: 'balanced' }));
  else if (act === 'mutate_near_miss') out.push(clone({ exit: 'wide' }), clone({ exit: 'timebox' }));
  void rnd;
  return out.slice(0, clamp(num(env.LAB_LOOP_SEEDS, 3), 0, 6));
}

const brief = (r) => (r ? { symbol: r.symbol, key: r.key, label: r.label, score: round(num(r.fitness, 0), 4), at: r.at || null } : null);

/**
 * 1ラウンド。測る → 壁を名指しする → 手を変えて走らせる → 引き渡し → 判定を残す。
 * 戻り値はそのまま D1 の lab_rounds に入る（あとから「何を試して何が起きたか」を追える）。
 */
export async function labLoopRound({ store, env = {}, mode = 'own', now = null } = {}) {
  await ensureLoopTable(store);
  const at = now || nowIso();
  const before = await labBoardRanked(store, { mode, limit: 12 }).catch(() => ({ rows: [], distinct: 0, raw: 0 }));
  // 門を通った個体は fitness 順の上位に居るとは限らない（実測: own の合格は最大1.65、不合格は2.37まで）。
  // 合格だけの順位表を別に引かないと「王者が居ない」と誤認する。
  const passBefore = await labPassBoard(store, { mode, limit: 12 }).catch(() => []);
  const champBefore = pickChampion(passBefore, mode) || pickChampion(before.rows, mode);
  const wall = gateWall(before.rows);
  const hist = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LL_KEY).catch(() => null))?.value, null) || { rounds: 0, stall: 0, byWall: {} };
  const action = wallFix(wall, { stall: num(hist.stall, 0) });
  const rnd = seededRandom(`labloop-${mode}-${String(at).slice(0, 16)}`);
  const seeds = targetedSeeds(mode, action, [...passBefore, ...before.rows], rnd, env);
  const n = clamp(num(env.LAB_LOOP_N, num(env.LAB_SEARCH_N, 6)), 1, 12);
  const settings = mode === 'e8'
    ? { profile: env.E8_PROFILE || 'p10', accountSize: num(env.E8_ACCOUNT, 100000), scale: num(env.E8_SCALE, 0.75), trials: 120 }
    : { capitalJPY: num(env.LAB_CAPITAL_JPY, 100000), riskMultiple: 1, targetMultiple: 1, months: 12, ruinFloorPct: 10, trials: 120 };
  let run = null;
  let error = null;
  try {
    run = await labSearch({
      store, env, mode, n, at, seeds,
      ctx: { mdCache: new Map(), fxCache: new Map() },
      budgetMs: num(env.LAB_LOOP_BUDGET_MS, num(env.LAB_BUDGET_MS, 15000)),
      settings,
    });
  } catch (e) { error = String((e && e.message) || e).slice(0, 200); }
  // 走らせた結果を、そのまま置き場（E8実行部の集合）へ引き渡す。ここまで人が押さない。
  let auto = null;
  try { auto = await labAuto({ store, env, now: at }); } catch (e) { auto = { error: String((e && e.message) || e).slice(0, 200) }; }
  const after = await labBoardRanked(store, { mode, limit: 12 }).catch(() => ({ rows: [], distinct: 0, raw: 0 }));
  const passAfter = await labPassBoard(store, { mode, limit: 12 }).catch(() => []);
  const champAfter = pickChampion(passAfter, mode) || pickChampion(after.rows, mode);
  const fb = champBefore ? num(champBefore.fitness, -1e9) : -1e9;
  const fa = champAfter ? num(champAfter.fitness, -1e9) : -1e9;
  const beforeKeys = before.rows.map((r) => `${r.symbol}|${r.key}`);
  const fresh = after.rows.map((r) => `${r.symbol}|${r.key}`).filter((k) => !beforeKeys.includes(k));
  const wallAfter = gateWall(after.rows);
  const improved = fa > fb + 1e-9;
  const regressed = fa < fb - 1e-9;
  const verdict = improved ? 'improved' : (regressed ? 'regressed' : (fresh.length ? 'new_entrants' : 'no_change'));
  const moved = wallAfter.key !== wall.key;
  const record = {
    id: rid(), at, mode,
    wall: wall.key, wall_why: wall.why,
    action: action.key, action_of: action.of, escalated: !!action.escalated,
    hypothesis: action.hypothesis,
    before: { champion: brief(champBefore), distinct: before.distinct, raw: before.raw, pass: wall.pass, fails: wall.fails, wall: wall.key, passRows: passBefore.length },
    after: { champion: brief(champAfter), distinct: after.distinct, raw: after.raw, pass: wallAfter.pass, fails: wallAfter.fails, wall: wallAfter.key, passRows: passAfter.length },
    result: {
      evaluated: run ? run.summary.evaluated : 0, passed: run ? run.summary.passedGates : 0,
      seeds: seeds.length, best: run && run.summary.best ? run.summary.best : null,
      wall_counts: wall.counts, wall_after_counts: wallAfter.counts,
      handoff: auto && auto.handoff ? auto.handoff : null,
      entered: (auto && auto.e8 && auto.e8.collection && auto.e8.collection.entered) || [],
      left: (auto && auto.e8 && auto.e8.collection && auto.e8.collection.left) || [],
    },
    verdict, delta: round(fa - fb, 4), fresh: fresh.slice(0, 6),
    note: error
      ? `走らせられなかった（${error}）`
      : `『${wall.label}』なので『${action.note}』を試した → ${improved ? '王者を更新' : regressed ? '悪化' : fresh.length ? `新しい顔ぶれ ${fresh.length}本` : '変化なし'}${moved ? `（壁が『${wallAfter.label}』へ移った）` : ''}`,
  };
  await store.run(
    `INSERT INTO ${LR} (id,at,mode,wall,wall_why,action,hypothesis,before_json,after_json,result_json,verdict,delta,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    record.id, record.at, record.mode, record.wall, record.wall_why, record.action, record.hypothesis,
    j(record.before), j(record.after), j(record.result), record.verdict, num(record.delta, 0), record.note,
  ).catch(() => {});
  const byWall = { ...(hist.byWall || {}) };
  byWall[wall.key] = num(byWall[wall.key], 0) + 1;
  const stall = (verdict === 'no_change' || verdict === 'regressed') ? num(hist.stall, 0) + 1 : 0;
  const payload = {
    version: LAB_LOOP_VERSION, at, last: record, stall,
    rounds: num(hist.rounds, 0) + 1, byWall,
    history: [record, ...((hist.history) || [])].slice(0, 12),
  };
  await store.run(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    LL_KEY, j(payload), at,
  ).catch(() => {});
  return record;
}

export async function labLoopStatus(store, env = {}) {
  const hist = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, LL_KEY).catch(() => null))?.value, null) || {};
  let rows = [];
  try { rows = await store.all(`SELECT * FROM ${LR} ORDER BY at DESC LIMIT 12`).catch(() => []) || []; } catch (e) { rows = []; }
  const recent = (rows || []).map((r) => ({
    at: r.at, mode: r.mode, wall: r.wall, action: r.action, verdict: r.verdict, delta: r.delta,
    note: r.note, escalated: /explore_broaden/.test(String(r.action || '')),
    before: safeJson(r.before_json, null), after: safeJson(r.after_json, null), result: safeJson(r.result_json, null),
  }));
  return {
    version: LAB_LOOP_VERSION,
    rounds: num(hist.rounds, 0), stall: num(hist.stall, 0), byWall: hist.byWall || {},
    last: hist.last || recent[0] || null,
    history: (hist.history || []).slice(0, 6),
    recent,
    walls: Object.values(WALLS).map((w) => ({ key: w.key, label: w.label, why: w.why, fix: w.fix, action: w.action, level: w.level })),
    config: {
      everyMinutes: num(env.LAB_LOOP_EVERY_MINUTES, 15), perRound: num(env.LAB_LOOP_N, num(env.LAB_SEARCH_N, 6)),
      seeds: num(env.LAB_LOOP_SEEDS, 3), budgetMs: num(env.LAB_LOOP_BUDGET_MS, num(env.LAB_BUDGET_MS, 15000)), stallLimit: STALL_LIMIT,
    },
  };
}

export function labLoopText(st = {}) {
  const L = [];
  L.push(`【試行錯誤の自浄ループ】${st.version || LAB_LOOP_VERSION} — 累計 ${num(st.rounds, 0)} ラウンド / 無変化 ${num(st.stall, 0)} 連続`);
  const walls = st.byWall || {};
  const top = Object.entries(walls).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) {
    const name = (k) => (WALLS[k] ? WALLS[k].label : k);
    L.push(`よく当たる壁: ${top.map(([k, n]) => `${name(k)}×${n}`).join(' / ')}`);
  }
  const r = st.last;
  if (r) {
    L.push(`直近: [${r.mode}] 壁=『${(WALLS[r.wall] || {}).label || r.wall}』 → 打ち手=『${r.action}』 → ${r.verdict}${num(r.delta, 0) ? `（${num(r.delta, 0) > 0 ? '+' : ''}${num(r.delta, 0)}）` : ''}`);
    if (r.note) L.push(`  ${r.note}`);
    if (r.hypothesis) L.push(`  仮説: ${r.hypothesis}`);
    const b = r.before && r.before.champion; const a = r.after && r.after.champion;
    if (b || a) L.push(`  王者: ${b ? `${b.symbol}/${b.key} ${b.score}` : 'なし'} → ${a ? `${a.symbol}/${a.key} ${a.score}` : 'なし'}`);
    if (r.result && r.result.handoff) L.push(`  引き渡し: ${r.result.handoff}`);
  } else {
    L.push('まだ1ラウンドも回っていない（POST /api/lab/loop か cron で回る）。');
  }
  const recent = (st.recent || []).slice(0, 5);
  if (recent.length > 1) {
    L.push('直近のラウンド:');
    for (const x of recent.slice(1)) L.push(`  ${String(x.at).slice(5, 16)} [${x.mode}] ${(WALLS[x.wall] || {}).label || x.wall} → ${x.action} = ${x.verdict}`);
  }
  L.push('門（15/6/40/45）は緩めない。手を変えるのは探索側だけ。');
  return L.join('\n');
}

export function labLoopHelp() {
  return {
    version: LAB_LOOP_VERSION,
    what: 'エージェント自身が回すFX論理の試行錯誤。毎ラウンド: 順位表を実測 → 門で止まっている壁を名指し → 壁に応じて手を変えた種を作って走らせる → 置き場（E8の集合）へ引き渡す → 判定を lab_rounds に残す。',
    endpoints: { status: 'GET /api/lab/loop', public: 'GET /api/lab/loop/public', run: 'POST /api/lab/loop?mode=own|e8' },
    walls: Object.values(WALLS),
    stall: `${STALL_LIMIT}回続けて改善が無いと、種を捨てて広く探索する（explore_broaden）。`,
    cost: '原価0（Yahoo Finance の日足・D1・cron のみ）。',
  };
}
