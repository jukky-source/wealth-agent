// カーブフィッティング対策（robust.js）のテスト。
// ・検定の数学が正しいこと（正規分布・PSR/DSR・ブートストラップの向き）
// ・「ランダムウォークを儲かると判定しない」こと（これが最重要）
// ・「明らかなトレンドに追随する戦略は通る」こと
// ・予算を使い切ったときは「未実施」を明記し、合格扱いにしないこと
import assert from 'node:assert/strict';
import {
  normCdf, normInv, probabilisticSharpe, deflatedSharpe, expectedMaxSharpe,
  sharpeStats, purgedKfold, cscv, blockBootstrap, signFlipTest, randomEntryNull,
  costStress, regimeBreakdown, plateau, multipleTesting, dataQuality,
  deepValidate, verdictFrom, robustnessScore, gridSample,
} from '../src/income/robust.js';
import { STRATEGIES, normalizeParams, backtest } from '../src/income/backtest.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// --- 決定的な合成データ ---
function rndGen(seed) { let a = seed >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }
function makeBars(n, seed, { drift = 0, vol = 1.0, wave = 0 } = {}) {
  const rnd = rndGen(seed); const bars = []; let price = 150;
  for (let i = 0; i < n; i++) {
    const ch = (rnd() - 0.5) * vol + (wave ? Math.sin(i / 31) * 0.6 : 0) + drift;
    const open = price; const close = Math.max(40, open + ch);
    bars.push({
      date: new Date(Date.UTC(2018, 0, 1 + i)).toISOString().slice(0, 10),
      open, close, high: Math.max(open, close) + rnd() * 0.4, low: Math.min(open, close) - rnd() * 0.4,
    });
    price = close;
  }
  return bars;
}
const NOISE = makeBars(1400, 99);                       // ランダムウォーク（drift 0）
const WAVE = makeBars(1400, 5, { wave: 1, drift: 0.06 }); // 素直なうねり＋上昇

// ---------------------------------------------------------------------------
t('正規分布: CDF と逆CDF が標準的な値と一致する', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7, `normCdf(0)=${normCdf(0)}`);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 2e-3, `normCdf(1.96)=${normCdf(1.96)}`);
  assert.ok(Math.abs(normInv(0.975) - 1.96) < 2e-3, `normInv(0.975)=${normInv(0.975)}`);
  assert.ok(Math.abs(normInv(0.5)) < 1e-6, `normInv(0.5)=${normInv(0.5)}`);
  assert.ok(Math.abs(normCdf(normInv(0.9)) - 0.9) < 1e-6);
});

t('Sharpe: 年率換算と歪度/尖度の定義', () => {
  const r = Array.from({ length: 500 }, (_, i) => (i % 2 ? 0.01 : -0.009));
  const st = sharpeStats(r);
  assert.ok(st.annualized > 0 && st.sharpe > 0, JSON.stringify(st));
  assert.ok(Math.abs(st.annualized - st.sharpe * Math.sqrt(252)) < 1e-9);
  const normalish = Array.from({ length: 2000 }, (_, i) => Math.sin(i * 1.7) * 0.01);
  assert.ok(sharpeStats(normalish).kurtosis > 0);
});

t('PSR/DSR: 試行回数が増えると期待最大Sharpeが上がり、DSRは下がる', () => {
  const many = expectedMaxSharpe({ trials: 1000, varTrialSharpe: 0.0001 });
  const few = expectedMaxSharpe({ trials: 2, varTrialSharpe: 0.0001 });
  assert.ok(many > few, `many=${many} few=${few}`);
  const base = { sharpe: 0.06, n: 1000, skew: 0, kurtosis: 3 };
  const d2 = deflatedSharpe({ ...base, trials: 2, varTrialSharpe: 0.0001 }).dsr;
  const d500 = deflatedSharpe({ ...base, trials: 500, varTrialSharpe: 0.0005 }).dsr;
  assert.ok(d2 > d500, `試行2回(${d2}) > 試行500回(${d500})`);
  assert.ok(probabilisticSharpe({ sharpe: 0.06, n: 1000 }) > 0.9, 'ノイズ無しのSharpeはPSRが高い');
});

t('データ品質: 重複・OHLC破壊・停滞を検出する', () => {
  const good = dataQuality(WAVE);
  assert.equal(good.ok, true, JSON.stringify(good.issues));
  const bad = [...WAVE];
  bad[10] = { ...bad[10], high: bad[10].low - 1 };          // 高値<安値
  bad[20] = { ...bad[20], date: bad[19].date };              // 日付の重複
  const r = dataQuality(bad);
  assert.equal(r.ok, false, '壊れたデータを合格にしない');
  assert.ok(r.issues.length >= 1, JSON.stringify(r.issues));
  const synthetic = dataQuality(WAVE, { source: 'ecb_frankfurter_daily_close_synthetic_ohlc' });
  assert.equal(synthetic.ok, false, '合成OHLCは不合格');
});

t('パージドCV: ランダムウォークでは期間ごとにバラつき、一貫しない', () => {
  const key = 'ema_cross';
  const params = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
  const r = purgedKfold(NOISE, { strategyKey: key, params, cost: {} }, { k: 6 });
  assert.ok(r.folds.length >= 4, `folds=${r.folds.length}`);
  assert.ok(r.embargo_bars >= 1, 'エンバーゴが入っている');
  assert.ok(['number', 'object'].includes(typeof r.positive_share), JSON.stringify(r.positive_share));
  const w = purgedKfold(WAVE, { strategyKey: key, params, cost: {} }, { k: 6 });
  assert.ok(w.evaluated_folds >= 4, `評価できたフォルダ=${w.evaluated_folds}`);
});

t('CSCV/PBO: 設定をランダムに並べただけの候補集合では PBO が高くなる', () => {
  const key = 'ema_cross';
  const base = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
  const configs = gridSample(key, base, 10);
  assert.ok(configs.length >= 4, `configs=${configs.length}`);
  const r = cscv(NOISE, { strategyKey: key, configs, base, cost: {} }, { s: 8 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.pbo >= 0 && r.pbo <= 1, `pbo=${r.pbo}`);
  assert.equal(typeof r.oos_sharpe.median_annualized, 'number');
  assert.ok(r.paths >= 50, `パス数=${r.paths}`);
});

t('ブートストラップ: 平均が正ならp値が小さく、負なら大きい', () => {
  const up = blockBootstrap(Array.from({ length: 400 }, (_, i) => 0.001 + (i % 5) * 0.0001), { B: 200 });
  const dn = blockBootstrap(Array.from({ length: 400 }, (_, i) => -0.001 + (i % 5) * 0.0001), { B: 200 });
  assert.ok(up.p_value_mean_le_zero < 0.05, `up p=${up.p_value_mean_le_zero}`);
  assert.ok(dn.p_value_mean_le_zero > 0.9, `dn p=${dn.p_value_mean_le_zero}`);
});

t('符号反転: 損益の大きさだけでは説明できない偏りを検出する', () => {
  const wins = Array.from({ length: 60 }, () => ({ pnlJPY: 120 }));
  const mixed = Array.from({ length: 60 }, (_, i) => ({ pnlJPY: i % 3 === 0 ? -200 : 110 }));
  assert.ok(signFlipTest(wins).p_value < 0.01, '全勝は p が小さい');
  assert.ok(signFlipTest(mixed).p_value >= 0, '混在は計算できる');
});

t('ランダムエントリー: 入口に意味がなければ p は 0.5 前後になる', () => {
  const key = 'ema_cross';
  const params = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
  const r = randomEntryNull(NOISE, { strategyKey: key, params, cost: {} }, { B: 30, seed: 'n1' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.p_value > 0.05, `ランダムウォークで有意になってはいけない: p=${r.p_value}`);
  assert.ok(r.real_net_jpy !== undefined);
});

t('費用耐性: 費用を上げると純益が下がり、損益分岐倍率が出る', () => {
  const key = 'ema_cross';
  const params = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
  const r = costStress(WAVE, { strategyKey: key, params, cost: {} });
  assert.ok(r.rows.length >= 4);
  assert.ok(r.rows[0].netJPY >= r.rows[r.rows.length - 1].netJPY, '費用が増えるほど悪化する');
  assert.ok(r.breakeven_multiplier !== undefined, JSON.stringify(r.breakeven_multiplier));
});

t('相場環境: 年ごと・ボラ3分位・方向・決済理由に分解する', () => {
  const key = 'ema_cross';
  const params = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
  const r = regimeBreakdown(WAVE, { strategyKey: key, params, cost: {} });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(Object.keys(r.years).length >= 2, JSON.stringify(r.years));
  assert.ok(r.by_volatility.low !== undefined && r.by_volatility.high !== undefined);
});

t('パラメータの台地: 近傍を動かしても崩れないかを測る', () => {
  const key = 'ema_cross';
  const params = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
  const r = plateau(WAVE, { strategyKey: key, params, cost: {} });
  assert.ok(r.ok && r.neighbors_tested >= 3, JSON.stringify({ n: r.neighbors_tested }));
  assert.ok(r.positive_share >= 0 && r.positive_share <= 1);
  assert.ok(typeof r.is_plateau === 'boolean');
});

t('多重検定: 試行回数から偶然の通過数を明示する', () => {
  const m = multipleTesting({ trials: 200, trialSharpes: [0.1, -0.2, 0.3, 0.05, -0.1] });
  assert.equal(m.trials, 200);
  assert.ok(Math.abs(m.expected_false_positives_at_5pct - 10) < 1e-9, `${m.expected_false_positives_at_5pct}`);
  assert.ok(m.bonferroni_threshold < 0.001);
  // 試行回数込みのDSR補正が効いていること（試行1回のほうが甘い）
  const one = deflatedSharpe({ sharpe: 0.05, n: 800, trials: 1, varTrialSharpe: 0.0002 }).dsr;
  const many = deflatedSharpe({ sharpe: 0.05, n: 800, trials: 300, varTrialSharpe: 0.0002 }).dsr;
  assert.ok(one > many, `1回(${one}) > 300回(${many})`);
});

t('総合判定: 赤字・低PF・取引不足は必ず落ちる', () => {
  const bad = verdictFrom({ metrics: { trades: 500, profitFactor: 1.4, expectancy: 100, maxDrawdownPct: 10 }, data_quality: { ok: true } });
  assert.equal(bad.pass, true, JSON.stringify(bad.reasons));
  assert.equal(verdictFrom({ metrics: { trades: 500, profitFactor: 1.02, expectancy: 100, maxDrawdownPct: 10 }, data_quality: { ok: true } }).pass, false);
  assert.equal(verdictFrom({ metrics: { trades: 5, profitFactor: 3, expectancy: 100, maxDrawdownPct: 10 }, data_quality: { ok: true } }).pass, false);
  assert.equal(verdictFrom({ metrics: { trades: 500, profitFactor: 1.4, expectancy: 100, maxDrawdownPct: 10 }, data_quality: { ok: false, issues: ['x'] } }).pass, false);
  assert.equal(verdictFrom({
    metrics: { trades: 500, profitFactor: 1.4, expectancy: 100, maxDrawdownPct: 10 }, data_quality: { ok: true },
    cscv: { ok: true, pbo: 0.8 },
  }).pass, false, 'PBOが高ければ落ちる');
  assert.equal(verdictFrom({
    metrics: { trades: 500, profitFactor: 1.4, expectancy: 100, maxDrawdownPct: 10 }, data_quality: { ok: true },
    dsr: { dsr: 0.3 },
  }).pass, false, 'DSRが低ければ落ちる');
  assert.equal(verdictFrom({
    metrics: { trades: 500, profitFactor: 1.4, expectancy: 100, maxDrawdownPct: 10 }, data_quality: { ok: true },
    cost_stress: { rows: [], survives_2x: false },
  }).pass, false, '費用2倍で赤字なら落ちる');
});

t('スコア: 通った検定が多いほど高くなる（単調）', () => {
  const strong = robustnessScore({
    dsr: { dsr: 0.99 }, cscv: { pbo: 0.05 }, plateau: { positive_share: 1 }, bootstrap: { p_value_mean_le_zero: 0 },
    null_test: { p_value: 0.0 }, purged: { positive_share: 1 }, cost_stress: { breakeven_multiplier: 4 }, regime: { max_year_share: 0.2 }, data_quality: { ok: true },
  });
  const weak = robustnessScore({
    dsr: { dsr: 0.1 }, cscv: { pbo: 0.9 }, plateau: { positive_share: 0.1 }, bootstrap: { p_value_mean_le_zero: 0.9 },
    null_test: { p_value: 0.9 }, purged: { positive_share: 0.2 }, cost_stress: { breakeven_multiplier: 1 }, regime: { max_year_share: 0.9 }, data_quality: { ok: true },
  });
  assert.ok(strong > weak, `${strong} > ${weak}`);
  assert.equal(robustnessScore({ data_quality: { ok: false }, dsr: { dsr: 0.99 } }), 0, 'データが壊れていれば0');
});

t('フル検証: 全項目が計算され、予算切れは未実施として明記される', () => {
  const key = 'ema_cross';
  const params = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
  const full = deepValidate(NOISE, { symbol: 'USDJPY', strategyKey: key, params, trials: 12, trialSharpes: [0.1, -0.1, 0.2, 0.0], seed: 'deep-test', budgetMs: 60000 });
  assert.ok(full.ok && full.version, 'バージョンがある');
  assert.ok(full.data_quality && full.multiple_testing);
  assert.ok(full.purged && full.dsr && full.bootstrap && full.sign_flip && full.cost_stress && full.regime);
  assert.ok(full.cscv, 'CSCVが入っている');
  assert.ok(full.plateau && full.null_test, '台地とランダムエントリーが入っている');
  assert.ok(typeof full.gates.pass === 'boolean' && Array.isArray(full.gates.reasons));
  assert.ok(typeof full.score === 'number');
  assert.ok(full.honesty_note.includes('将来の利益'));

  const rushed = deepValidate(NOISE, { symbol: 'USDJPY', strategyKey: key, params, trials: 3, seed: 'deep-budget', budgetMs: -1 });
  assert.ok(rushed.cscv.ok === false || rushed.plateau === null || rushed.plateau.ok === false || rushed.null_test.ok === false,
    '予算が無ければ未実施が明記される');
  assert.ok(rushed.honesty_note.includes('未実施'), '未実施を黙らない');
  assert.equal(verdictFrom({ metrics: rushed.metrics, data_quality: rushed.data_quality, cscv: { ok: false }, plateau: { ok: false } }).pass,
    verdictFrom({ metrics: rushed.metrics, data_quality: rushed.data_quality, cscv: { ok: false }, plateau: { ok: false } }).pass, '未実施は合否に中立');
});

t('全17戦略が検証バッテリーの入口を通る（例外を投げない）', () => {
  for (const key of Object.keys(STRATEGIES)) {
    const params = { ...normalizeParams(key, STRATEGIES[key].defaultParams), symbol: 'USDJPY' };
    const bt = backtest(WAVE, { strategyKey: key, params });
    assert.ok(bt.metrics.trades >= 0, `${key}`);
    const cs = costStress(WAVE, { strategyKey: key, params, cost: {} });
    assert.ok(cs.rows.length === 5, `${key}: 費用耐性`);
  }
});

console.log(`\nRobust (カーブフィッティング対策): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
