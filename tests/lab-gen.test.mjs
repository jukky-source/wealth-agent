// 候補生成が「測れる候補」に寄っているかを確認する。
// 本番実測でE8の門通過が0だった律速は「取引回数が足りない」（IS 5〜10回 < 15）だったため、
// 生成側の重み（時間軸・出口・方向・絞り込み・部品の種類）を検査する。門は緩めていない。
import { candidateSpecs, labRuleSpec } from '../src/income/lab.js';
import { ATOMS } from '../src/income/grammar.js';
import { seededRandom } from '../src/util.js';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

const specs = candidateSpecs(seededRandom('gen-check-1'), { count: 120 });
ok('候補が作れる', specs.length === 120, String(specs.length));

const weekly = specs.filter((s) => s.tf === '1w').length;
const daily = specs.filter((s) => s.tf === '1d').length;
ok('週足は少数派（週足は取引回数が出にくい）', weekly <= 30, `${weekly}/120`);
ok('日足が多数派', daily >= 90, `${daily}/120`);

const ruleSpecs = specs.filter((s) => s.base && s.base.kind === 'rule');
ok('合成論理が混ざる', ruleSpecs.length > 20, String(ruleSpecs.length));

let state = 0; let cross = 0; let twoAnd = 0;
for (const s of ruleSpecs) {
  for (const idx of [s.base.a, s.base.b]) {
    const a = idx == null ? null : ATOMS[idx];
    if (!a) continue;
    if (a.op === 'gt' || a.op === 'lt') state++; else cross++;
  }
  if (s.base.b != null && s.base.comb === 'and') twoAnd++;
}
ok('状態条件（gt/lt）が交差条件（xup/xdn）より多い', state > cross, `state ${state} / cross ${cross}`);
ok('ANDの2部品は少数（取引回数を削る）', twoAnd <= ruleSpecs.length * 0.5, `${twoAnd}/${ruleSpecs.length}`);

const both = specs.filter((s) => s.dir === 'both').length;
ok('両方向が多数派', both >= 60, `${both}/120`);
const none = specs.filter((s) => s.filter === 'none').length;
ok('絞り込みなしが多数派', none >= 75, `${none}/120`);

const flip = specs.filter((s) => s.exit === 'flip').length;
const fast = specs.filter((s) => s.exit === 'timebox' || s.exit === 'tight').length;
ok('flip（逆シグナルまで保有）は薄い', flip < fast, `flip ${flip} / tight+timebox ${fast}`);

let mutated = 0;
for (let i = 0; i < 60; i++) {
  const s = labRuleSpec(seededRandom(`mut-${i}`), { symbol: 'USDJPY', feature: 'atr_pct', mutateFrom: ruleSpecs[i % ruleSpecs.length] });
  if (s && s.base && s.base.kind === 'rule') mutated++;
}
ok('変異も動く', mutated === 60, String(mutated));

console.log(`lab-gen: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
