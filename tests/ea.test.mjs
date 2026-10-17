// EA（自動売買）のテスト。
// 旧テストは存在しない関数（PROFILES / simulateAccount / analyzeEA）を import していて、
// SyntaxError で即死していた（＝一度も走っていなかった）。ここは実際にある機能だけを試す。
//   * 既知の型（ema_cross）の MQL5 書き出しが、コンパイルに必要な要素を持つこと
//   * Logic space（合成論理）から MQL5 を書き出せること（今回追加）
//   * 未対応の特徴量・出口では「作らない」と明示されること（黙って壊れたEAを出さない）
import assert from 'node:assert/strict';
import { generateMql5, lintMql5, eaStrategyKeys, eaHelp, logicEaSpec } from '../src/income/ea.js';
import { materialize, exitParams, ATOMS } from '../src/income/grammar.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

function structureOk(code) {
  assert.ok(code.includes('#include <Trade\\Trade.mqh>'), 'Trade.mqh を取り込む');
  assert.ok(/int\s+OnInit\s*\(/.test(code), 'OnInit がある');
  assert.ok(/void\s+OnTick\s*\(/.test(code), 'OnTick がある');
  assert.ok(/void\s+OnDeinit\s*\(/.test(code), 'OnDeinit がある');
  const o = (code.match(/\{/g) || []).length, c = (code.match(/\}/g) || []).length;
  assert.equal(o, c, `ブレースの数が合う（${o} 対 ${c}）`);
  assert.ok(!code.includes('undefined'), 'undefined が混ざっていない');
  assert.ok(!code.includes('NaN'), 'NaN が混ざっていない');
}

const atomIdx = (f, op, th) => ATOMS.findIndex((a) => a.f === f && a.op === op && a.th === th);
const mkRule = (over = {}) => ({
  v: 1, tier: 'rule', idx: null, symbol: 'USDJPY', tf: '1d', filter: 'none',
  exit: 'balanced', dir: 'both',
  base: { kind: 'rule', a: atomIdx('rsi14', 'lt', 30), b: atomIdx('cci20', 'lt', -100), comb: 'and' },
  ...over,
});

await t('既知の型（ema_cross）: MQL5 が出て、構造が揃っている', async () => {
  const g = generateMql5({ strategyKey: 'ema_cross', params: { fast: 12, slow: 48 }, symbol: 'USDJPY' });
  assert.ok(g, '生成される');
  structureOk(g.mq5_code);
  assert.ok(g.mq5_code.includes('InpFast'), '入力パラメータが入っている');
  assert.ok(g.set_code.includes('InpFast='), '.set ファイルも出る');
});

await t('既知の型: 自己点検（lint）で構造の誤りが無い', async () => {
  const g = generateMql5({ strategyKey: 'rsi_meanrev', params: {}, symbol: 'EURUSD' });
  const r = lintMql5(g.mq5_code);
  const checks = Array.isArray(r) ? r : (r.checks || []);
  const bad = checks.filter((c) => !c.ok);
  assert.equal(bad.length, 0, `失敗した点検: ${bad.map((b) => b.id).join(', ')}`);
});

await t('合成論理: 部品（RSI/CCI）から MQL5 が生成でき、条件式が入る', async () => {
  const spec = mkRule();
  const key = materialize(spec);
  const g = generateMql5({ strategyKey: key, params: { ...exitParams(spec), logic: spec, symbol: 'USDJPY' } });
  assert.ok(g, '合成論理のEAが出る');
  structureOk(g.mq5_code);
  assert.ok(g.mq5_code.includes('double F_rsi14(const int sh)'), 'RSIの値を読む関数がある');
  assert.ok(g.mq5_code.includes('double F_cci20(const int sh)'), 'CCIの値を読む関数がある');
  assert.ok(g.mq5_code.includes('iRSI(_Symbol') && g.mq5_code.includes('iCCI(_Symbol'), '指標ハンドルを作っている');
  assert.ok(g.mq5_code.includes('goShort && !goLong'), '売り条件も入っている（方向=両方）');
  assert.ok(g.mq5_code.includes('IndicatorRelease(hRsiL)'), 'ハンドルを解放している');
  assert.ok(g.set_code.includes('InpAtrStopMult='), '.set に出口の設定が入る');
});

await t('合成論理: 方向の指定（買いのみ／売りのみ）がEAに反映される', async () => {
  const spec = mkRule({ dir: 'long' });
  const g = generateMql5({ strategyKey: materialize(spec), params: { ...exitParams(spec), logic: spec, symbol: 'USDJPY' } });
  structureOk(g.mq5_code);
  assert.ok(!g.mq5_code.includes('else if(goShort && !goLong)'), '売りの分岐が無い（買いのみ）');
});

await t('未対応の特徴量（スーパートレンド方向）では生成せず、理由を返す', async () => {
  const spec = mkRule({ base: { kind: 'rule', a: atomIdx('st_dir', 'gt', 0), b: null, comb: 'and' } });
  const s = logicEaSpec(materialize(spec), { logic: spec });
  assert.ok(s && typeof s.unsupported === 'string' && s.unsupported.length > 0, '理由が返る');
  const g = generateMql5({ strategyKey: materialize(spec), params: { logic: spec } });
  assert.equal(g, null, '壊れたEAを出さない（null）');
});

await t('未対応の出口（トレーリング）でも生成せず、理由を返す', async () => {
  const spec = mkRule({ exit: 'trail' });
  const s = logicEaSpec(materialize(spec), { logic: spec });
  assert.ok(s && /出口/.test(s.unsupported || ''), '出口の理由が返る');
  assert.equal(generateMql5({ strategyKey: materialize(spec), params: { logic: spec } }), null);
});

await t('一覧とヘルプが取れる', async () => {
  const keys = eaStrategyKeys();
  assert.ok(keys.length >= 8, `既知の型が8本以上（実際 ${keys.length}）`);
  assert.ok(keys.includes('ema_cross'), 'ema_cross が一覧にある');
  const h = eaHelp();
  assert.ok(typeof h === 'string' && h.length > 100, 'ヘルプが文字列で返る');
  assert.ok(h.includes('.mq5'), 'ヘルプに .mq5 の説明がある');
});

await t('EAの注意書きに「過去の成績は保証しない」とデモ推奨が入っている', async () => {
  const g = generateMql5({ strategyKey: 'ema_cross', params: {} });
  assert.ok(g.mq5_code.includes('デモ'), 'デモ口座での確認を促している');
  assert.ok(g.mq5_code.includes('保証しません'), '保証しない旨が入っている');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
