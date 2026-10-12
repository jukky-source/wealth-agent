// Capability suite — the five reverse-engineered capabilities, verified on their
// own (judge / watch parsing / the contract that the files really carry them).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judgeOutcome, POLICY } from '../src/agent/judge.js';
import { parseWatch, WATCH_METRICS } from '../src/agent/watch.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ------------------------------------------------------------------ 判定（Judge）
test('[C1] カードにある数字だけを使った返答は判定を通る', () => {
  const out = { reply: '実測収益は ¥3,000 です。', cards: [{ type: 'kpi', items: [{ label: '実測収益', value: 3000 }] }] };
  const v = judgeOutcome(out, { ledger: { revenue: { measured: 3000, total_estimated: 0 } } });
  assert.equal(v.ok, true, v.line);
});

test('[C2] 台帳にもカードにも無い数字は「要確認」になる', () => {
  const out = { reply: '実測収益は ¥99,999 です。', cards: [{ type: 'kpi', items: [{ value: 3000 }] }] };
  const v = judgeOutcome(out, { ledger: { revenue: { measured: 3000 } } });
  assert.equal(v.ok, false);
  assert.match(v.line, /数字の裏づけ/);
});

test('[C3] 実測0円なのに「実測」と書いたら差し戻す', () => {
  const out = { reply: '実測の収益が入っています。', cards: [] };
  const v = judgeOutcome(out, { ledger: { revenue: { measured: 0, total_estimated: 12000 } } });
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => c.label === '実測と推定の区別' && !c.ok));
});

test('[C4] 危険な操作に触れて承認の一言が無ければ差し戻す', () => {
  const risky = judgeOutcome({ reply: '実口座で購入します。', cards: [] }, {});
  assert.equal(risky.ok, false);
  const ok = judgeOutcome({ reply: '実口座の購入はあなたの承認を待ちます。', cards: [] }, {});
  assert.equal(ok.ok, true);
});

test('[C5] できこと/承認/やらないこと の3区分と鍵の分離が定義されている', () => {
  assert.ok(POLICY.autonomous.length >= 5);
  assert.ok(POLICY.approval_required.includes('実口座での売買'));
  assert.ok(POLICY.never.length >= 3);
  assert.match(POLICY.keys, /モデルには渡していません/);
});

// ------------------------------------------------------------------ 見張り（Watch）
test('[C6] 「実測収益が3万円を超えたら教えて」を条件に変換する', () => {
  const w = parseWatch('実測収益が3万円を超えたら教えて');
  assert.equal(w.metric, 'measured_revenue');
  assert.equal(w.op, '>=');
  assert.equal(w.threshold, 30000);
});

test('[C7] 件数の条件と「以下」も解釈できる', () => {
  const a = parseWatch('失敗した作業が5件になったら知らせて');
  assert.equal(a.metric, 'failed_tasks');
  assert.equal(a.threshold, 5);
  const b = parseWatch('承認待ちが0件以下になったら教えて');
  assert.equal(b.metric, 'pending_approvals');
  assert.equal(b.op, '<=');
});

test('[C8] 条件の無い雑談は見張りとして登録しない', () => {
  assert.equal(parseWatch('今日はいい天気ですね'), null);
  assert.equal(Object.keys(WATCH_METRICS).length, 4);
});

// ------------------------------------------------------------------ 実装の契約
test('[C9] 見張りテーブルが schema.sql と ensureSchema の両方にある', () => {
  assert.match(read('schema.sql'), /CREATE TABLE IF NOT EXISTS watch_rules/);
  assert.match(read('src/db.js'), /watch_rules/);
});

test('[C10] 途中再開と見張りのAPIが配線されている', () => {
  const api = read('src/api.js');
  assert.match(api, /case 'resume'/);
  assert.match(api, /\/api\/watches/);
  assert.match(read('src/scheduler.js'), /checkWatches/);
  assert.match(read('public/app.js'), /data-do/);
  assert.match(read('public/app.js'), /openWatch/);
  assert.match(read('src/agent/commands.js'), /judgeOutcome/);
  assert.match(read('public/sw.js'), /wa-v8/);
});

let pass = 0; const failed = [];
for (const [name, fn] of tests) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log(`\n════════ CAPABILITIES: ${pass} passed, ${failed.length} failed ════════`);
process.exit(failed.length ? 1 : 0);
