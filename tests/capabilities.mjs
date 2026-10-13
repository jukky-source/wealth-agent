// Capability suite — the reverse-engineered capabilities, verified on their own:
// judge / watch parsing / goal-as-completion-condition / rework loop / modes, plus
// the contract that the files really carry them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judgeOutcome, reworkTask, reworkTargetOf, POLICY } from '../src/agent/judge.js';
import { parseWatch, goalProgress, WATCH_METRICS } from '../src/agent/watch.js';
import { BUILTIN_MODES, parseModeRequest, defaultChips, modeCard } from '../src/agent/modes.js';

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
  assert.equal(w.hold, false);
});

test('[C7] 件数の条件と「以下」も解釈できる', () => {
  const a = parseWatch('失敗した作業が5件になったら知らせて');
  assert.equal(a.metric, 'failed_tasks');
  assert.equal(a.threshold, 5);
  const b = parseWatch('承認待ちが0件以下になったら教えて');
  assert.equal(b.metric, 'pending_approvals');
  assert.equal(b.op, '<=');
});

test('[C8] 条件の無い雑談は見張りとして登録しない（指標は8種）', () => {
  assert.equal(parseWatch('今日はいい天気ですね'), null);
  assert.equal(parseWatch('実測収益がいくらか教えて'), null);
  assert.equal(Object.keys(WATCH_METRICS).length, 8);
});

test('[C9] 見張りテーブルが schema.sql と ensureSchema の両方にある', () => {
  assert.match(read('schema.sql'), /CREATE TABLE IF NOT EXISTS watch_rules/);
  assert.match(read('src/db.js'), /watch_rules/);
  assert.match(read('schema.sql'), /CREATE TABLE IF NOT EXISTS modes/);
  assert.match(read('src/db.js'), /CREATE TABLE IF NOT EXISTS modes/);
});

test('[C10] 途中再開・見張り・判定のAPIが配線されている', () => {
  const api = read('src/api.js');
  assert.match(api, /case 'resume'/);
  assert.match(api, /case 'rework'/);
  assert.match(api, /\/api\/watches/);
  assert.match(api, /\/api\/mode/);
  assert.match(read('src/scheduler.js'), /checkWatches/);
  assert.match(read('src/scheduler.js'), /goal/);
  assert.match(read('public/app.js'), /data-do/);
  assert.match(read('public/app.js'), /openWatch/);
  assert.match(read('public/app.js'), /openMode/);
  assert.match(read('src/agent/commands.js'), /judgeOutcome/);
  assert.match(read('public/sw.js'), /wa-v9/);
});

// ------------------------------------------------- 完了条件としての見張り（hold）
test('[C11] 「〜するまで続けて」は完了条件（hold）として登録される', () => {
  const w = parseWatch('実測収益が5万円に届くまで続けて');
  assert.equal(w.hold, true);
  assert.equal(w.metric, 'measured_revenue');
  assert.equal(w.threshold, 50000);
  const off = parseWatch('実測収益が5万円を超えたら教えて');
  assert.equal(off.hold, false);
});

test('[C12] 稼ぐ以外の用途でも見張れる（調べた件数・覚えていること）', () => {
  const r = parseWatch('調べたレポートが10件になったら知らせて');
  assert.equal(r.metric, 'research_reports');
  assert.equal(r.threshold, 10);
  const n = parseWatch('覚えていることが50件を超えたら教えて');
  assert.equal(n.metric, 'notes');
});

test('[C13] 目標までの残りを実データから数える', () => {
  const p = goalProgress({ op: '>=', threshold: 30000 }, 12000);
  assert.equal(p.remain, 18000);
  assert.equal(p.pct, 40);
  assert.equal(p.done, false);
  const done = goalProgress({ op: '>=', threshold: 30000 }, 31000);
  assert.equal(done.remain, 0);
  assert.equal(done.pct, 100);
  assert.equal(done.done, true);
});

// --------------------------------------------------------- 差し戻し → 作り直し
test('[C14] 差し戻しの対象は返答のカードから特定する', () => {
  const out = { reply: '確認します。', cards: [{ type: 'list', items: [{ act: 'resume:tsk_abc' }] }] };
  assert.equal(reworkTargetOf(out), 'tsk_abc');
  assert.equal(reworkTargetOf({ reply: 'なし', cards: [] }), null);
});

test('[C15] 判定に落ちた返答は作り直しの対象つきで返る', () => {
  const out = {
    reply: '実測収益は ¥99,999 です。',
    cards: [{ type: 'list', items: [{ act: 'resume:tsk_abc' }] }],
  };
  const v = judgeOutcome(out, { ledger: { revenue: { measured: 0 } } });
  assert.equal(v.ok, false);
  assert.equal(v.rework.task_id, 'tsk_abc');
  assert.ok(v.rework.reason);
});

test('[C16] お金を動かす作業は作り直さず承認に回す', async () => {
  const store = {
    async get() { return { id: 'tsk_risky', title: '実口座で購入する', attempt: 1, last_success_step: null }; },
    async run() { throw new Error('should not run'); },
    async insert() { throw new Error('should not insert'); },
  };
  const r = await reworkTask(store, 'tsk_risky', { reason: '数字の裏づけ' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'approval_required');
});

test('[C17] 作り直しは試行回数を引き継いで improving に戻す', async () => {
  const calls = [];
  const store = {
    async get() { return { id: 'tsk_ok', title: '候補を並べ直す', attempt: 2, last_success_step: '下書き' }; },
    async run(sql, ...p) { calls.push({ sql, p }); },
    async insert(_t, o) { calls.push({ sql: 'insert', o }); },
  };
  const r = await reworkTask(store, 'tsk_ok', { reason: '数字の裏づけ' });
  assert.equal(r.ok, true);
  assert.equal(r.attempt, 3);
  assert.ok(calls.some((c) => /state='improving'/.test(c.sql) && c.p.includes(3)));
  assert.ok(calls.some((c) => c.sql === 'insert' && c.o.scope === 'task:tsk_ok'));
});

// ------------------------------------------------------------------ モード（用途）
test('[C18] 組み込みモードに稼ぐ以外の用途がある', () => {
  const ids = Object.keys(BUILTIN_MODES);
  assert.ok(ids.length >= 5);
  assert.ok(ids.includes('money') && ids.includes('research') && ids.includes('write'));
  assert.match(BUILTIN_MODES.research.chips.join(' '), /調べ|足あと/);
  assert.equal(defaultChips({ chips: ['a', 'b', 'c', 'd', 'e', 'f'] }).length, 5);
});

test('[C19] 「調べるモードにして」「◯◯モードを追加して」を読み分ける', () => {
  const sw = parseModeRequest('調べるモードにして');
  assert.equal(sw.action, 'switch');
  assert.equal(sw.label, '調べる');
  const cr = parseModeRequest('筋トレ日記モードを追加して。目的は 週3回の記録を続ける');
  assert.equal(cr.action, 'create');
  assert.equal(cr.label, '筋トレ日記');
  assert.match(cr.goal, /週3回/);
  const list = parseModeRequest('モードを見せて');
  assert.equal(list.action, 'list');
});

test('[C20] モードカードは今のモードを示し、他は切り替えボタンになる', () => {
  const card = modeCard([BUILTIN_MODES.money, BUILTIN_MODES.write], 'money');
  assert.equal(card.items[0].badge, 'いま');
  assert.equal(card.items[0].act, null);
  assert.equal(card.items[1].act, 'mode:write');
});

let pass = 0; const failed = [];
for (const [name, fn] of tests) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log(`\n════════ CAPABILITIES: ${pass} passed, ${failed.length} failed ════════`);
process.exit(failed.length ? 1 : 0);
