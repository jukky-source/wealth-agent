// 全般の改善ループのテスト。D1 は使わず、記憶ストアで回す。
import { improveRound, improveTick, improveStatus, improveText, improveHelp, laneByKey, laneKeys, LANES, pickMode, ensureImproveTable, IR, STALL_LIMIT } from '../src/agent/improve.js';
import { labPassBoard } from '../src/income/lab.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('  x ' + name + (extra ? ' — ' + extra : '')); } };

function memStore() {
  const S = new Map(); const rows = [];
  return {
    S, rows,
    async run(sql, ...a) {
      const s = String(sql);
      if (/INSERT INTO improve_rounds/i.test(s)) { rows.push(a); return { success: true }; }
      if (/settings/i.test(s)) { S.set(a[0], a[1]); return { success: true }; }
      return { success: true };
    },
    async first(sql, ...a) {
      const s = String(sql);
      if (/FROM settings/i.test(s)) return S.has(a[0]) ? { value: S.get(a[0]) } : null;
      return null;
    },
    async all(sql) { return /improve_rounds/i.test(String(sql)) ? rows.slice(-40) : []; },
  };
}

const fakeLane = (key, scores, extra = {}) => ({
  key, label: key, what: 'test', fallback: 'w',
  walls: { w: { label: '壁', why: 'w', fix: 'f', action: 'a', level: 'allow' }, other: { label: '壁2', why: 'w2', fix: 'f2', action: 'a2', level: 'allow' } },
  async measure() { return { score: scores[0], before: { n: 1 }, wall: 'w', wall_why: 'why', hypothesis: 'h' }; },
  async act() { return { score: scores[1], after: { n: 2 }, action: 'a', note: 'done', ...extra }; },
});

// --- レーンの定義 ---
ok('レーンが7つ', laneKeys().length === 7, String(laneKeys().length));
ok('レーンのキーが一意', new Set(laneKeys()).size === laneKeys().length);
for (const l of LANES) {
  ok('レーン ' + l.key + ' が measure/act を持つ', typeof l.measure === 'function' && typeof l.act === 'function');
  ok('レーン ' + l.key + ' に壁がある', Object.keys(l.walls).length > 0);
  ok('レーン ' + l.key + ' の fallback が実在', !!l.walls[l.fallback], l.fallback);
  for (const w of Object.values(l.walls)) ok('壁 ' + l.key + '/' + w.key + ' に打ち手と level', !!w.action && !!w.level && !!w.label);
}
ok('未知のキーは null', laneByKey('nope') === null);
ok('既知のキーは引ける', laneByKey('funnel').key === 'funnel');
ok('収益に近い段でレーンが並ぶ', laneKeys().slice(0, 2).join(',') === 'fx,funnel');

// --- モードの選び方 ---
ok('記録が無ければ own', pickMode({}) === 'own');
ok('own だけなら e8', pickMode({ recent: [{ mode: 'own', at: '2026-10-18T00:00:00Z' }] }) === 'e8');
ok('古い方を選ぶ', pickMode({ recent: [{ mode: 'own', at: '2026-10-18T00:00:00Z' }, { mode: 'e8', at: '2026-10-18T01:00:00Z' }] }) === 'own');
ok('逆なら e8', pickMode({ recent: [{ mode: 'own', at: '2026-10-18T02:00:00Z' }, { mode: 'e8', at: '2026-10-18T01:00:00Z' }] }) === 'e8');

// --- 1ラウンド ---
{
  const store = memStore();
  await ensureImproveTable(store);
  const r = await improveRound({ store, env: {}, lane: fakeLane('t1', [10, 12]) });
  ok('改善を検出', r.verdict === 'improved', r.verdict);
  ok('差分を記録', r.delta === 2, String(r.delta));
  ok('行が入る', store.rows.length === 1);
  ok('壁と打ち手が残る', r.wall === 'w' && r.action === 'a');
  const st = await improveStatus(store, {});
  ok('状態に反映', st.rounds === 1 && st.by_verdict.improved === 1);
  ok('レーン別の状態', st.lanes.find((l) => l.key === 't1').stall === 0);
}
{
  const store = memStore();
  const r = await improveRound({ store, env: {}, lane: fakeLane('t2', [10, 10]) });
  ok('変化なしを検出', r.verdict === 'no_change', r.verdict);
  const st = await improveStatus(store, {});
  ok('無変化で stall が増える', st.lanes.find((l) => l.key === 't2').stall === 1);
}
{
  const store = memStore();
  for (let i = 0; i < STALL_LIMIT; i++) await improveRound({ store, env: {}, lane: fakeLane('t3', [10, 10]) });
  const r = await improveRound({ store, env: {}, lane: fakeLane('t3', [10, 10]) });
  ok('3連続の無変化で見切りが付く', String(r.action).includes('broaden'), r.action);
  ok('判定は変化なしのまま', r.verdict === 'no_change', r.verdict);
}
{
  const store = memStore();
  const r = await improveRound({ store, env: {}, lane: fakeLane('t4', [10, 10], { blocked: true, level: 'approve' }) });
  ok('人の操作待ちを記録', r.verdict === 'blocked_human', r.verdict);
  const st = await improveStatus(store, {});
  ok('人の操作待ちも stall に数える', st.lanes.find((l) => l.key === 't4').stall === 1);
}
{
  const store = memStore();
  const lane = { key: 't5', label: 't5', what: 'x', fallback: 'w', walls: { w: { label: '壁', action: 'a', level: 'allow' } }, async measure() { throw new Error('boom'); }, async act() { return { score: 0 }; } };
  const r = await improveRound({ store, env: {}, lane });
  ok('測れない時は error', r.verdict === 'error', r.verdict);
  ok('理由が残る', String(r.wall_why).includes('boom'), r.wall_why);
}
{
  const store = memStore();
  const lane = { key: 't6', label: 't6', what: 'x', fallback: 'w', walls: { w: { label: '壁', action: 'a', level: 'allow' } }, async measure() { return { score: 1, before: {}, wall: 'w' }; }, async act() { throw new Error('nope'); } };
  const r = await improveRound({ store, env: {}, lane });
  ok('打ち手が失敗しても記録する', r.verdict === 'error' && String(r.note).includes('nope'), r.note);
}
{
  const store = memStore();
  const r = await improveRound({ store, env: {}, lane: fakeLane('t7', [10, 20], { verdict: 'acted' }) });
  ok('レーンの判定が優先される', r.verdict === 'acted', r.verdict);
}
{
  const store = memStore();
  const r = await improveRound({ store, env: {}, lane: fakeLane('t8', [10, 8]) });
  ok('後退も検出', r.verdict === 'regressed', r.verdict);
  ok('負の差分', r.delta === -2, String(r.delta));
}

// --- tick（カーソルで順に回る） ---
{
  const store = memStore();
  const mk = (k) => ({ key: k, label: k, what: 'x', fallback: 'w', walls: { w: { label: '壁', action: 'a', level: 'allow' } }, async measure() { return { score: 1, before: {}, wall: 'w' }; }, async act() { return { score: 1, after: {} }; } });
  const lanes = [mk('a1'), mk('a2'), mk('a3')];
  const r1 = await improveTick({ store, env: {}, n: 2, lanes });
  ok('tick が n 本回す', r1.length === 2, String(r1.length));
  ok('1回目は先頭から', r1[0].lane === 'a1' && r1[1].lane === 'a2', r1.map((r) => r.lane).join(','));
  const r2 = await improveTick({ store, env: {}, n: 2, lanes });
  ok('2回目は続きから', r2[0].lane === 'a3' && r2[1].lane === 'a1', r2.map((r) => r.lane).join(','));
  ok('tick の記録が積まれる', store.rows.length === 4, String(store.rows.length));
}

// --- 表示 ---
{
  const store = memStore();
  await improveRound({ store, env: {}, lane: fakeLane('t9', [10, 12]) });
  const st = await improveStatus(store, {});
  const t = improveText(st);
  ok('text にレーンが出る', t.includes('レーンごとの今') && t.includes('判定:'));
  ok('text に壁と打ち手が出る', t.includes('壁=') && t.includes('打ち手='));
  const h = improveHelp();
  ok('help に7レーン', (h.lanes || []).length === 7);
  ok('help に原価0の但し書き', String(h.cost).includes('原価0'));
  ok('status に設定が出る', st.config.stallLimit === STALL_LIMIT && st.config.perTick >= 1);
}

// --- 実物の labPassBoard が配列を返す（fx レーンが依存） ---
{
  const stub = { async all() { return []; }, async first() { return null; }, async run() { return { success: true }; } };
  const out = await labPassBoard(stub, { mode: 'own', limit: 5 });
  ok('labPassBoard は配列を返す', Array.isArray(out), typeof out);
}

console.log(`\n════════ IMPROVE: ${pass} passed, ${fail} failed ════════`);
if (fail) process.exit(1);
