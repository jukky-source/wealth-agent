// opt.test.mjs — 最適化探索器の純関数テスト（ネットワークを使わない）
import {
  canonicalSpec, specKey, randomGenome, mutateGenome, crossoverGenomes, evalGates, optScore,
  isDominated, paretoFront, pearsonOnDates, pickUncorrelated, portfolioStats, summarizeBoard,
  optText, optHelp, optSearchPlan, OPT_VERSION,
} from '../src/income/optimizer.js';
import { coreAt, SYMBOLS } from '../src/income/grammar.js';
import { seededRandom } from '../src/util.js';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const near = (a, b, tol = 1e-9) => Math.abs(Number(a) - Number(b)) <= tol;

console.log('最適ロジック探索');

// 1) 正準形: idx を落として「同じ論理＝同じ鍵」にする
{
  const a = coreAt(5);
  const b = { ...coreAt(5), idx: null };
  ok('canonicalSpec が idx を落とす', canonicalSpec(a).idx === undefined);
  ok('同じ論理は同じ鍵', specKey(a) === specKey(b), `${specKey(a)} vs ${specKey(b)}`);
  ok('違う論理は違う鍵', specKey(coreAt(5)) !== specKey(coreAt(6)));
  ok('鍵は g_ で始まる', specKey(a).startsWith('g_'));
}

// 2) 無作為生成
{
  const rnd = seededRandom('opt-seed');
  for (let i = 0; i < 30; i++) {
    const g = randomGenome(rnd, SYMBOLS, { preferCore: i % 2 === 0, index: i });
    const s = g.spec;
    const good = SYMBOLS.includes(s.symbol) && ['1d', '1w'].includes(s.tf)
      && ['tight', 'balanced', 'wide', 'trail', 'flip', 'timebox'].includes(s.exit)
      && ['both', 'long', 'short'].includes(s.dir)
      && s.base && (s.base.kind === 'strategy' ? !!s.base.key : Number.isInteger(s.base.a));
    if (!good) { ok(`無作為生成 #${i} が正しい形`, false, JSON.stringify(s)); break; }
  }
  ok('無作為生成 30回すべて正しい形（コア／合成の両方）', true);
}

// 3) 変異: 何かが変わり、形は保たれる
{
  const rnd = seededRandom('opt-mut');
  const parents = Array.from({ length: 12 }, (_, i) => randomGenome(rnd, SYMBOLS, { preferCore: true, index: i * 7 }));
  let changed = 0;
  for (const p of parents) {
    const m = mutateGenome(rnd, p, SYMBOLS);
    if (m.key !== p.key) changed++;
    const s = m.spec;
    if (!SYMBOLS.includes(s.symbol) || !['1d', '1w'].includes(s.tf) || !s.base) { changed = -1; break; }
    if (s.base.kind === 'rule' && s.filter !== 'none') { changed = -2; break; }
  }
  ok('変異で鍵が変わる（12回中10回以上）', changed >= 10, String(changed));
}

// 4) 交叉: 両親の遺伝子が混ざる
{
  const rnd = seededRandom('opt-cross');
  const a = randomGenome(rnd, SYMBOLS, { preferCore: true, index: 3 });
  const b = { ...randomGenome(rnd, SYMBOLS, { preferCore: true, index: 900 }), spec: { ...randomGenome(rnd, SYMBOLS, { preferCore: true, index: 900 }).spec, symbol: 'GOLD', tf: '1w', exit: 'trail', dir: 'short' } };
  let mixed = 0;
  for (let i = 0; i < 20; i++) {
    const c = crossoverGenomes(rnd, a, b, SYMBOLS);
    const fromB = c.spec.symbol === b.spec.symbol || c.spec.tf === b.spec.tf || c.spec.exit === b.spec.exit || c.spec.dir === b.spec.dir;
    const fromA = c.spec.symbol === a.spec.symbol || c.spec.tf === a.spec.tf || c.spec.exit === a.spec.exit || c.spec.dir === a.spec.dir;
    if (fromA && fromB) mixed++;
    if (c.parents.length !== 2) { mixed = -1; break; }
  }
  ok('交叉の子は両親の遺伝子を持つ（20回中15回以上）', mixed >= 15, String(mixed));
}

// 5) 門と点
{
  const good = { is: { trades: 60, maxDrawdownPct: 18, netProfitPct: 40, profitFactor: 1.8, sharpe: 1.2, ruined: false }, oos: { trades: 25, maxDrawdownPct: 20, netProfitPct: 12, profitFactor: 1.4, sharpe: 0.9, ruined: false } };
  const thin = { is: { ...good.is, trades: 5 }, oos: { ...good.oos, trades: 2 } };
  const ruined = { is: { ...good.is, ruined: true }, oos: good.oos };
  const badOos = { is: good.is, oos: { ...good.oos, netProfitPct: -3, profitFactor: 0.8 } };
  ok('良い個体は門を通る', evalGates(good).pass === true, JSON.stringify(evalGates(good).reasons));
  ok('取引が少ないと落ちる', evalGates(thin).pass === false && evalGates(thin).reasons.length >= 2);
  ok('破産は落ちる', evalGates(ruined).pass === false && evalGates(ruined).reasons.some((r) => r.includes('尽きた')));
  ok('OOSがマイナスなら落ちる', evalGates(badOos).pass === false && evalGates(badOos).reasons.some((r) => r.includes('純益')));
  const sg = optScore(good); const sb = optScore(badOos); const st = optScore(thin);
  ok('良い個体の点が高い', sg.score > sb.score && sg.score > st.score, `${sg.score} / ${sb.score} / ${st.score}`);
  ok('点の内訳が返る', !!sg.parts && typeof sg.parts.sharpeOos === 'number');
  const better = { is: good.is, oos: { ...good.oos, sharpe: 2.0, netProfitPct: 25 } };
  ok('OOSが良いほど点が上がる', optScore(better).score > sg.score);
}

// 6) パレート前線
{
  const A = { score: 1, metrics: { oos: { netProfitPct: 30, maxDrawdownPct: 20, sharpe: 1 } } };
  const B = { score: 2, metrics: { oos: { netProfitPct: 20, maxDrawdownPct: 10, sharpe: 1.2 } } };
  const C = { score: 3, metrics: { oos: { netProfitPct: 15, maxDrawdownPct: 25, sharpe: 0.5 } } };
  ok('BはAを支配しない（DDが小さい）', isDominated(A, B) === false);
  ok('CはAに支配される', isDominated(C, A) === true);
  const front = paretoFront([A, B, C]);
  ok('前線にAとBが残りCは落ちる', front.length === 2 && !front.includes(C));
}

// 7) 相関と集合づくり
{
  const dates = Array.from({ length: 120 }, (_, i) => ({ date: `d${String(i).padStart(3, '0')}` }));
  const mk = (f) => dates.map((d, i) => ({ date: d.date, r: f(i) }));
  const a = mk((i) => Math.sin(i / 5) * 0.01);
  const b = mk((i) => Math.sin(i / 5) * 0.02 + 0.0001);
  const c = mk((i) => Math.cos(i / 3) * 0.01);
  ok('同じ形は強い正の相関', pearsonOnDates(a, b).r > 0.95, String(pearsonOnDates(a, b).r));
  ok('逆向きは負の相関', pearsonOnDates(a, mk((i) => -Math.sin(i / 5) * 0.01)).r < -0.95);
  ok('重なりが30日未満なら判定しない', pearsonOnDates(a.slice(0, 10), b.slice(0, 10)).r === null);
  const { selected, skipped } = pickUncorrelated(
    [{ name: 'A', rets: a }, { name: 'B', rets: b }, { name: 'C', rets: c }],
    { maxMembers: 6, maxCorr: 0.6 },
  );
  ok('相関の高いBは落ちる', selected.length === 2 && skipped.some((s) => s.name === 'B'), JSON.stringify(skipped));
  ok('選ばれた相関を記録している', selected[1] && typeof selected[1].maxAbsCorrWithSelected === 'number');
  const stats = portfolioStats(selected.map((s) => ({ weight: 1 / selected.length, rets: s.rets })));
  ok('集合の統計が出る', stats && stats.n > 100 && typeof stats.annSharpe === 'number', JSON.stringify(stats));
}

// 8) 集計（偽のD1）
{
  const rows = [
    { symbol: 'GOLD', strategy_key: 'g_aaa', params_json: JSON.stringify({ logic: { tf: '1d', exit: 'wide', dir: 'long', base: { kind: 'strategy', key: 'donchian_breakout' } } }), metrics_json: JSON.stringify({ oos: { netProfitPct: 30, maxDrawdownPct: 12, profitFactor: 1.7, trades: 40, sharpe: 1.1 } }), fitness: 2.5, tag: 'opt:g3', created_at: 'x' },
    { symbol: 'USDJPY', strategy_key: 'g_bbb', params_json: JSON.stringify({ logic: { tf: '1w', exit: 'trail', dir: 'short', base: { kind: 'strategy', key: 'ema_cross' } } }), metrics_json: JSON.stringify({ oos: { netProfitPct: 10, maxDrawdownPct: 18, profitFactor: 1.3, trades: 22, sharpe: 0.6 } }), fitness: 1.2, tag: 'opt:g3', created_at: 'x' },
  ];
  const stored = [];
  const store = {
    async all() { return rows; },
    async run(sql, ...p) { stored.push(p[1]); return {}; },
  };
  const board = await summarizeBoard(store);
  ok('集計: 最良はGOLD', board.bySymbol[0].name === 'GOLD', JSON.stringify(board.bySymbol[0]));
  ok('集計: 時間足ごとに出る', board.byTimeframe.length === 2 && board.byTimeframe[0].name === '1d');
  ok('集計: 論理ごとに出る', board.byLogic.some((x) => x.name === 'donchian_breakout'));
  ok('集計: 出口ごとに出る', board.byExit.length === 2);
  ok('集計はD1に残す', stored.length === 1);
}

// 9) 表示
{
  const plan = optSearchPlan({});
  ok('探索計画に空間の広さが入る', plan.space_size > 0 && plan.per_day > 0, JSON.stringify(plan).slice(0, 120));
  ok('全列挙しないことを明記', plan.note.includes('全列挙はしない'));
  const txt = optText({
    stats: { gen: 7, evaluated: 42, pop: 20 },
    plan,
    champion: null,
    board: { evaluated: 42, bySymbol: [{ name: 'GOLD', best: 2.5, n: 10 }], byTimeframe: [{ name: '1d', best: 2.5, n: 30 }], byLogic: [{ name: 'donchian_breakout', best: 2.5, n: 8 }], byExit: [{ name: 'wide', best: 2.5, n: 8 }] },
    collection: null,
    top: [{ score: 2.5, symbol: 'GOLD', tf: '1d', kind: 'strategy', base: 'donchian_breakout', exit: 'wide', oosNetPct: 30, oosDdPct: 12, oosPf: 1.7, oosTrades: 40, pass: true, gates: [] }],
  });
  ok('テキストに世代と評価数が出る', txt.includes('7世代') && txt.includes('42個体'));
  ok('テキストに集計が出る', txt.includes('GOLD') && txt.includes('1d'));
  const h = optHelp();
  ok('help に対応表がある', !!h.features && !!h.features.portfolio, JSON.stringify(Object.keys(h.features || {})));
  ok('help に正直な前提がある', Array.isArray(h.honesty) && h.honesty.length >= 3);
  ok('版が付いている', OPT_VERSION === 'opt-1.0');
}

console.log(`\nOPT: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
