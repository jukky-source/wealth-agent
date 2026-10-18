// labloop.test.mjs — 試行錯誤ループと順位表の純関数テスト（ネットワークを使わない）
import { rankLabRows, labRowCmp } from '../src/income/lab.js';
import { LAB_LOOP_VERSION, STALL_LIMIT, WALLS, gateWall, wallFix, targetedSeeds, labLoopText, labLoopHelp } from '../src/income/labLoop.js';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('試行錯誤の自浄ループ（labloop）');

// 1) 順位表: 同じ論理は1本に畳み、同点は新しい個体を上に置く
{
  const row = (symbol, key, fitness, at, extra = {}) => ({ symbol, key, fitness, gatesPass: false, reasons: [], at, spec: { symbol, tf: '1d', exit: 'balanced', dir: 'both', filter: 'none', base: { kind: 'strategy', key: 'ema_cross', variant: 0, params: {} } }, ...extra });
  const dup = [
    row('XAGUSD', 'g_aaa', 2.10, '2026-10-17T00:00:00Z'),
    row('XAGUSD', 'g_aaa', 2.10, '2026-10-18T00:00:00Z'),
    row('XAGUSD', 'g_aaa', 1.90, '2026-10-16T00:00:00Z'),
  ];
  const r1 = rankLabRows(dup, 10);
  ok('同じ論理は1本に畳まれる', r1.distinct === 1 && r1.rows.length === 1, JSON.stringify(r1.rows.length));
  ok('畳んだ本数を数えている', r1.rows[0].duplicates === 2, String(r1.rows[0].duplicates));
  ok('畳むときに強い方を残す', r1.rows[0].fitness === 2.10);
  ok('同点なら新しい方を残す（挿入順で固定しない）', r1.rows[0].at === '2026-10-18T00:00:00Z', r1.rows[0].at);

  const mixed = [
    row('XAGUSD', 'g_aaa', 1.5, '2026-10-18T00:00:00Z'),
    row('NZDUSD', 'g_bbb', 2.2, '2026-10-17T00:00:00Z'),
    row('USDJPY', 'g_ccc', 2.2, '2026-10-18T06:00:00Z'),
  ];
  const r2 = rankLabRows(mixed, 10);
  ok('別の論理は別の行として残る', r2.distinct === 3, String(r2.distinct));
  ok('強い順に並ぶ', r2.rows[0].fitness === 2.2);
  ok('同点の並びも新しい方が先', r2.rows[0].symbol === 'USDJPY', r2.rows[0].symbol);
  ok('比較関数は上位を負で返す', labRowCmp(r2.rows[0], r2.rows[1]) < 0);
}

// 2) 壁の名指し
{
  const fail = (reasons) => ({ gatesPass: false, reasons, fitness: 1 });
  const w1 = gateWall([fail(['IS取引 8 < 15']), fail(['OOS取引 3 < 6']), fail(['DD 52 > 40'])]);
  ok('取引回数の壁を名指しする', w1.key === 'trades', w1.key);
  ok('数えた内訳を残す', w1.counts.trades === 2 && w1.counts.dd === 1, JSON.stringify(w1.counts));
  ok('壁には必ず打ち手が付く', w1.action === 'widen_exit', w1.action);
  const w2 = gateWall([fail(['DD 52 > 40']), fail(['DD 61 > 45']), { gatesPass: true, reasons: [], fitness: 1 }]);
  ok('門を通る個体があっても、止まっている理由を名指しする', w2.key === 'dd' && w2.pass === 1, `${w2.key}/${w2.pass}`);
  const w3 = gateWall([{ gatesPass: true, reasons: [], fitness: 1 }]);
  ok('全通過なら「伸びが止まった」', w3.key === 'plateau', w3.key);
  const w4 = gateWall([]);
  ok('候補が無ければ「門を通る個体が無い」', w4.key === 'none_pass', w4.key);
}

// 3) 打ち手と見切り
{
  const w = gateWall([{ gatesPass: false, reasons: ['DD 52 > 40'], fitness: 1 }]);
  const f1 = wallFix(w, { stall: 0 });
  ok('壁に対応する打ち手を返す', f1.key === 'tighten_exit', f1.key);
  ok('仮説を言葉で持つ', !!f1.hypothesis);
  const f2 = wallFix(w, { stall: STALL_LIMIT });
  ok('同じ無変化が続いたら見切って広く探索する', f2.key === 'explore_broaden' && f2.escalated === true, f2.key);
  ok('壁の一覧はすべて打ち手を持つ', Object.values(WALLS).every((x) => x.action && x.why && x.fix));
}

// 4) 種づくり
{
  const spec = { symbol: 'USDJPY', tf: '1d', exit: 'balanced', dir: 'both', filter: 'none', base: { kind: 'strategy', key: 'ema_cross', variant: 0, params: {} } };
  const rows = [{ symbol: 'USDJPY', key: 'g_a', fitness: 1.2, gatesPass: true, reasons: [], at: '2026-10-18T00:00:00Z', spec }];
  const s1 = targetedSeeds('own', { key: 'widen_exit' }, rows, () => 0.5, {});
  ok('出口を広げる種を作る', s1.length >= 2 && s1.some((x) => x.exit === 'wide'), JSON.stringify(s1.map((x) => x.exit)));
  ok('種は親の銘柄を引き継ぐ', s1.every((x) => x.symbol === 'USDJPY'));
  ok('種だと印を付ける', s1.every((x) => x.__seed === true));
  const s2 = targetedSeeds('own', { key: 'rotate_market' }, rows, () => 0.5, {});
  ok('銘柄を回す種は別の銘柄になる', s2.some((x) => x.symbol !== 'USDJPY'), JSON.stringify(s2.map((x) => x.symbol)));
  const s3 = targetedSeeds('own', { key: 'explore_broaden' }, rows, () => 0.5, {});
  ok('見切ったときは種を渡さない（無作為探索に任せる）', s3.length === 0);
  const s4 = targetedSeeds('own', { key: 'widen_exit' }, [], () => 0.5, {});
  ok('親が無ければ種を作らない', s4.length === 0);
}

// 5) 表示とヘルプ
{
  ok('版が入っている', LAB_LOOP_VERSION === 'labloop-1.0', LAB_LOOP_VERSION);
  const t = labLoopText({ version: LAB_LOOP_VERSION, rounds: 3, stall: 1, byWall: { trades: 2, dd: 1 }, last: null, recent: [] });
  ok('状態を日本語で返す', /試行錯誤の自浄ループ/.test(t) && /取引回数/.test(t), t.slice(0, 60));
  const t2 = labLoopText({ rounds: 1, byWall: {}, last: { mode: 'own', wall: 'trades', action: 'widen_exit', verdict: 'improved', delta: 0.12, note: 'テスト', hypothesis: '仮説', before: { champion: { symbol: 'USDJPY', key: 'g_a', score: 1 } }, after: { champion: { symbol: 'USDJPY', key: 'g_a', score: 1.12 } } }, recent: [] });
  ok('直近ラウンドを1行で出す', /widen_exit/.test(t2) && /王者/.test(t2));
  const h = labLoopHelp();
  ok('ヘルプに入口がある', /api\/lab\/loop/.test(h.endpoints.run) && h.walls.length === Object.keys(WALLS).length);
}

console.log(`\n════════ LABLOOP: ${pass} passed, ${fail} failed ════════`);
if (fail) process.exit(1);
