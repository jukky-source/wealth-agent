// lab.test.mjs — バックテスト作業台の純関数テスト（ネットワークを使わない）
import { seededRandom } from '../src/util.js';
import {
  LAB_VERSION, LAB_E8_PROFILES, LAB_E8_PAY_RULES, LAB_OBJECTIVES,
  labE8Plan, e8ProfileOf, labSpec, labRuleSpec, labCost,
  weightedEnsemble, equityCurve, drawdownSeries, monthlyReturns, portfolioStats, thin,
  challengeReplay, labOwnScore, labE8Score, evalGates, candidateSpecs, labHeatmap, labCatalog, trimMetrics,
  pickChampion, labCollectionFrom, labAuto, LAB_AUTO_KEY, LAB_COLLECTION_KEY,
} from '../src/income/lab.js';

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol;
const days = (n, r, start = '2024-01-01') => {
  const out = [];
  const t0 = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) out.push({ date: new Date(t0 + i * 86400e3).toISOString().slice(0, 10), r });
  return out;
};

console.log('バックテスト作業台（lab）');

// 1) 規格
{
  ok('版が入っている', LAB_VERSION === 'lab-1.1', LAB_VERSION);
  ok('E8規格は5種類', Object.keys(LAB_E8_PROFILES).length === 5);
  const p = e8ProfileOf('p10');
  ok('p10 は 10/15/6.6', p.maxLossPct === 10 && p.targetPct === 15 && p.dailyLossPct === 6.6, JSON.stringify(p));
  ok('未知名は p10 に落ちる', e8ProfileOf('nope').key === 'p10');
  const plan = labE8Plan('p10', { accountSize: 100000 });
  ok('plan の目標は15%', plan.phases[0].targetPct === 15);
  ok('plan の全体は動的（trailing）', plan.maxLossType === 'trailing');
  ok('plan は期限なし', plan.timeLimitDays === null);
  ok('支払いは純益の80%', plan.payoutSharePct === 80);
  ok('随時請求の下限は日次の50%', plan.minPayoutPctOfDailyDd === 50);
  ok('40%ベストデイルールを持つ', LAB_E8_PAY_RULES.bestDayLimitPct === 40);
  const p6 = labE8Plan('p6');
  ok('p6 は目標9% / 日次4%', p6.phases[0].targetPct === 9 && p6.dailyLossPct === 4);
}

// 2) 論理（spec）の組み立て
{
  const s = labSpec({ symbol: 'USDJPY', tf: '1d', strategy: 'donchian', variant: 0, exit: 'tight', dir: 'long' });
  ok('spec はコア層', s.tier === 'core' && s.base.kind === 'strategy');
  ok('出口と方向が入る', s.exit === 'tight' && s.dir === 'long');
  ok('未知の銘柄は先頭に落ちる', labSpec({ symbol: 'NOPE' }).symbol === labSpec({}).symbol);
  ok('未知の時間軸は1dに落ちる', labSpec({ symbol: 'USDJPY', tf: '5m' }).tf === '1d');
  ok('未知の出口は balanced に落ちる', labSpec({ symbol: 'USDJPY', exit: 'nope' }).exit === 'balanced');
  const withParams = labSpec({ symbol: 'USDJPY', strategy: 'donchian', variant: 0, params: { period: 99 } });
  ok('params が上書きされる', withParams.base.params.period === 99, JSON.stringify(withParams.base.params));
  const r = labRuleSpec(seededRandom('lab-test'), { symbol: 'USDJPY', feature: 'rsi14', tf: '1w', exit: 'timebox' });
  ok('合成論理は rule 層', r.tier === 'rule', JSON.stringify(r.tier));
  ok('時間軸と出口の指定が効く', r.tf === '1w' && r.exit === 'timebox');
}

// 3) 費用
{
  const base = labCost({ spreadPips: 0.3, slippagePips: 0.2, commissionJPY: 0 }, {});
  ok('既定はそのまま', near(base.spreadPips, 0.3));
  const st = labCost(base, { stressMult: 2 });
  ok('ストレス2倍でスプレッドも2倍', near(st.spreadPips, 0.6), String(st.spreadPips));
  ok('ストレス2倍でスリッページも2倍', near(st.slippagePips, 0.4));
  const ov = labCost(base, { spreadPips: 1.5, commissionJPY: 50 });
  ok('上書きが効く', near(ov.spreadPips, 1.5) && near(ov.commissionJPY, 50));
}

// 4) 束ねる・曲線・月次
{
  const a = { weight: 1, daily: [{ date: '2024-01-01', r: 0.01 }, { date: '2024-01-02', r: -0.01 }] };
  const b = { weight: 3, daily: [{ date: '2024-01-01', r: 0.03 }, { date: '2024-01-02', r: 0.03 }] };
  const e = weightedEnsemble([a, b]);
  ok('重み付きの平均になる', near(e[0].r, (1 * 0.01 + 3 * 0.03) / 4, 1e-9), JSON.stringify(e));
  ok('日付が揃う', e.length === 2 && e[1].date === '2024-01-02');
  const one = weightedEnsemble([{ weight: 1, daily: [{ date: '2024-01-02', r: 0.02 }] }, { weight: 1, daily: [{ date: '2024-01-01', r: 0.05 }] }]);
  ok('片方に無い日は片方だけで平均', one[0].date === '2024-01-01' && near(one[0].r, 0.05));
  const curve = equityCurve([{ date: '2024-01-01', r: 0.1 }, { date: '2024-01-02', r: -0.1 }], 100);
  ok('曲線は複利（100→110→99）', near(curve[1].equity, 110) && near(curve[2].equity, 99), JSON.stringify(curve));
  const dd = drawdownSeries([{ date: 'a', equity: 100 }, { date: 'b', equity: 120 }, { date: 'c', equity: 90 }]);
  ok('DDはピークから測る（120→90 = 25%）', near(dd[2].ddPct, 25), JSON.stringify(dd[2]));
  const mo = monthlyReturns([{ date: '2024-01-10', r: 0.1 }, { date: '2024-01-20', r: 0.1 }, { date: '2024-02-01', r: -0.5 }]);
  ok('月ごとにまとまる', mo.length === 2 && near(mo[0].returnPct, 21), JSON.stringify(mo));
  const st = portfolioStats([{ date: '2024-01-01', r: 0.01 }, { date: '2024-01-02', r: -0.03 }, { date: '2024-01-03', r: 0.02 }]);
  ok('最悪の1日を拾う', near(st.worstDayPct, -3), JSON.stringify(st.worstDayPct));
  ok('最大DDを出す', st.maxDrawdownPct > 0);
  const t = thin(Array.from({ length: 1000 }, (_, i) => i), 100);
  ok('間引いても末尾は残る', t.length <= 110 && t[t.length - 1] === 999, String(t.length));
}

// 5) E8の選考再生
{
  const plan = labE8Plan('p10', { accountSize: 100000 });
  const win = challengeReplay(days(120, 0.002), plan, { initialBalance: 100000, scale: 1 });
  ok('毎日+0.2%なら合格する', win.passed === true, JSON.stringify(win.breach));
  ok('合格までの日数は60〜80日', win.days >= 60 && win.days <= 80, String(win.days));
  ok('合格ラインは115000', near(win.target, 115000), String(win.target));
  ok('床は90000（動的でも初期は-10%）', near(win.floor, 90000), String(win.floor));
  const lose = challengeReplay([...days(5, 0.001), { date: '2024-01-06', r: -0.2 }], plan, { initialBalance: 100000, scale: 1 });
  ok('1日-20%で日次違反', lose.breach && lose.breach.type === 'daily_loss', JSON.stringify(lose.breach));
  const hard = labE8Plan('p10', { accountSize: 100000, dailyLossPct: 50 });
  const hit = challengeReplay([{ date: '2024-01-02', r: -0.11 }], hard, { initialBalance: 100000, scale: 1 });
  ok('11%の下落で全体の床を割る', hit.breach && hit.breach.type === 'max_loss', JSON.stringify(hit.breach));
  const scaled = challengeReplay(days(60, 0.002), plan, { initialBalance: 100000, scale: 2 });
  ok('建玉倍率2倍なら早く着く', scaled.passed === true && scaled.days < win.days, `${scaled.days} < ${win.days}`);
  const thinRep = challengeReplay(days(900, 0.0005), plan, { initialBalance: 100000, scale: 1 });
  ok('長い経路でも系列は間引かれる', thinRep.series.length <= 410, String(thinRep.series.length));
  ok('残高と床の関係が返る', typeof thinRep.toFloorPct === 'number');
}

// 6) 採点
{
  ok('自己資金: 倍率が高いほど高い', labOwnScore({ medianMultiple: 3, reachPct: 40, ruinPct: 10 }) > labOwnScore({ medianMultiple: 1, reachPct: 40, ruinPct: 10 }));
  ok('自己資金: 全滅なら0', near(labOwnScore({ medianMultiple: 5, reachPct: 0, ruinPct: 100 }), 0));
  ok('E8: DDが小さいほど高い', labE8Score({ passRatePct: 60 }, { maxDrawdownPctMtm: 20 }) > labE8Score({ passRatePct: 60 }, { maxDrawdownPctMtm: 80 }));
  ok('E8: 合格率0なら0', near(labE8Score({ passRatePct: 0 }, { maxDrawdownPctMtm: 10 }), 0));
  ok('採点の式が明文化されている', typeof LAB_OBJECTIVES.own === 'string' && typeof LAB_OBJECTIVES.e8 === 'string');
}

// 7) 門
{
  const good = evalGates({ is: { trades: 40, maxDrawdownPctMtm: 20, netProfitPct: 30 }, oos: { trades: 15, maxDrawdownPctMtm: 25, netProfitPct: 12 } });
  ok('良い個体は門を通る', good.pass === true, JSON.stringify(good.reasons));
  const few = evalGates({ is: { trades: 3 }, oos: { trades: 1, netProfitPct: 1 } });
  ok('取引が少ないと落ちる', few.pass === false && few.reasons.length >= 2, JSON.stringify(few.reasons));
  const neg = evalGates({ is: { trades: 40 }, oos: { trades: 20, netProfitPct: -5 } });
  ok('OOSがマイナスなら落ちる', neg.reasons.some((r) => r.includes('OOSの純益')));
  const ruined = evalGates({ is: { trades: 40 }, oos: { trades: 20, netProfitPct: 10, ruined: true } });
  ok('破産は落ちる', ruined.reasons.some((r) => r.includes('破産')));
}

// 8) 候補づくり・地図
{
  const a = candidateSpecs(seededRandom('seed-x'), { count: 6 });
  const b = candidateSpecs(seededRandom('seed-x'), { count: 6 });
  ok('件数どおり作る', a.length === 6, String(a.length));
  ok('同じ種なら同じ候補（決定論的）', JSON.stringify(a[0].base) === JSON.stringify(b[0].base));
  ok('銘柄は既知のものだけ', a.every((s) => typeof s.symbol === 'string' && s.symbol.length >= 6));
  ok('コアと合成が混ざる', new Set(a.map((s) => s.tier)).size >= 1);
  const h = labHeatmap([
    { symbol: 'USDJPY', tf: '1d', exit: 'tight', dir: 'both', filter: 'none', strategyLabel: 'ema_cross', score: 0.2 },
    { symbol: 'USDJPY', tf: '1w', exit: 'wide', dir: 'long', filter: 'none', strategyLabel: 'donchian', score: 0.9 },
    { symbol: 'GOLD', tf: '1d', exit: 'tight', dir: 'both', filter: 'none', strategyLabel: 'ema_cross', score: 0.5 },
  ]);
  ok('通貨ごとの最良を拾う', h.bySymbol.find((x) => x.name === 'USDJPY').best === 0.9, JSON.stringify(h.bySymbol));
  ok('時間軸ごとの最良を拾う', h.byTimeframe.find((x) => x.name === '1d').best === 0.5);
  ok('通貨×時間軸の格子が出る', h.grid.length === 3 && h.grid[0].best === 0.9, JSON.stringify(h.grid[0]));
  ok('出口ごとの集計が出る', h.byExit.length === 2);
}

// 9) カタログ
{
  const c = labCatalog({});
  ok('モードは2つ（E8 / 自己資金）', c.modes.length === 2 && c.modes[0].key === 'e8' && c.modes[1].key === 'own');
  ok('銘柄20', c.symbols.length === 20, String(c.symbols.length));
  ok('時間軸は日足と週足', c.timeframes.length === 2);
  ok('出口は6通り', c.exits.length === 6);
  ok('論理空間の広さを出す', c.space.core > 100000 && c.space.total > c.space.core, JSON.stringify(c.space));
  ok('前提と入っていないものを隠さない', c.assumptions.length >= 5 && c.notIncluded.length >= 4);
  ok('採点の式を持つ', typeof c.objectives.own === 'string');
  ok('費用の既定を返す', c.cost.defaults && c.cost.defaults.spreadPips != null);
  ok('E8の支払い規則を返す', c.e8.pay.sharePct === 80);
  const tm = trimMetrics({ trades: 5, netProfitPct: 3, sharpe: 1.2, nonsense: 9 });
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

  // labBoard は D1 の行（params_json / metrics_json / gates_json）を読む。テストも同じ形で渡す。
  const d1 = (r) => ({
    symbol: r.symbol, strategy_key: r.key, fitness: r.fitness, verdict: r.verdict, created_at: '2026-10-17T09:00:00.000Z',
    bars: 1600, date_from: '2020-01-01', date_to: '2026-10-16',
    params_json: JSON.stringify({ spec: r.spec, settings: {}, mode: 'e8' }),
    metrics_json: JSON.stringify({ oos: { netProfitPct: r.oosNetPct, maxDrawdownPctMtm: r.oosDdMtmPct }, objective: r.objective, label: r.label, mode: 'e8' }),
    gates_json: JSON.stringify(r.reasons || []),
  });
  const e8rows = [...good, ...bad].map(d1);
  const mkStore = (seed) => ({
    _s: new Map(seed || []),
    async first(sql, ...p) { return this._s.has(p[0]) ? { value: this._s.get(p[0]) } : null; },
    async run(sql, key, value) { this._s.set(key, value); },
    async all() { return e8rows; },
    async insert() {},
  });
  const store = mkStore();
  const auto = await labAuto({ store, env: {}, now: '2026-10-17T09:00:00.000Z' });
  ok('引き渡しを記録する', /lab:collection/.test(auto.handoff), auto.handoff);
  ok('集合を settings に書く', store._s.has(LAB_COLLECTION_KEY) && JSON.parse(store._s.get(LAB_COLLECTION_KEY)).members.length === 2);
  ok('台帳を残す', store._s.has(LAB_AUTO_KEY) && JSON.parse(store._s.get(LAB_AUTO_KEY)).ticks === 1);
  ok('何本通ったかを残す', auto.e8.passed === 2 && auto.e8.candidates === 3, JSON.stringify(auto.e8));
  ok('最良と集合の中身を残す', auto.e8.champion.symbol === 'USDJPY' && auto.e8.collection.keys.length === 2);

  const store2 = mkStore([[LAB_COLLECTION_KEY, JSON.stringify({ members: [{ symbol: 'USDJPY', key: 'g_aaa1' }, { symbol: 'GOLD', key: 'ema_cross' }] })]]);
  const auto2 = await labAuto({ store: store2, env: {}, now: '2026-10-17T09:05:00.000Z' });
  ok('同じ集合なら「更新した」と言わない', auto2.e8.collection.changed === false, auto2.handoff);

  const store3 = {
    _s: new Map(),
    async first() { return null; },
    async run() {},
    async all() { return bad.map(d1); },
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
  ok('支払いが出る個体は合格率の水準まで戻る（上限は合格率）', near(fatPay, noPay, 1e-6) && fatPay <= 0.6, `${fatPay} vs ${noPay}`);
  ok('DDが大きい個体はさらに沈む', labE8Score({ passRatePct: 60 }, { maxDrawdownPctMtm: 80 }, null) < noPay);
}

console.log(`\nlab: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
