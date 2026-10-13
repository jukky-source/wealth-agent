// Capability suite — the reverse-engineered capabilities, verified on their own:
// judge / watch parsing / goal-as-completion-condition / rework loop / modes, plus
// the contract that the files really carry them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judgeOutcome, reworkTask, reworkTargetOf, POLICY } from '../src/agent/judge.js';
import { parseWatch, goalProgress, WATCH_METRICS } from '../src/agent/watch.js';
import { BUILTIN_MODES, parseModeRequest, defaultChips, modeCard } from '../src/agent/modes.js';
import { DEFAULT_ENVELOPE, checkEnvelope, parseEnvelopeRequest } from '../src/agent/envelope.js';
import { recordReceipt, revenueSummary, revenueLine, createJob, advanceJob } from '../src/agent/revenue.js';
import { catalog, challenge, preflight, isEvmAddress, isSolanaAddress, resolveNetwork, verifyAndSettle, x402Enabled } from '../src/agent/x402.js';

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

test('[C8] 条件の無い雑談は見張りとして登録しない（指標は8種以上）', () => {
  assert.equal(parseWatch('今日はいい天気ですね'), null);
  assert.equal(parseWatch('実測収益がいくらか教えて'), null);
  assert.ok(Object.keys(WATCH_METRICS).length >= 8)
  assert.ok(WATCH_METRICS.verified_revenue && WATCH_METRICS.net_profit);
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
  assert.match(read('public/sw.js'), /wa-v10/);
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


// ------------------------------------------------ 自律の範囲 / 案件 / 入金 / x402
function memStore() {
  const t = { ledger: [], receipts: [], jobs: [] };
  return {
    t,
    async all(sql) {
      if (/FROM\s+ledger/.test(sql)) return t.ledger;
      if (/FROM\s+jobs/.test(sql)) {
        const g = {};
        for (const j of t.jobs) { g[j.state] = g[j.state] || { state: j.state, c: 0, amount: 0 }; g[j.state].c += 1; g[j.state].amount += Number(j.price || 0); }
        return Object.values(g);
      }
      if (/FROM\s+receipts/.test(sql)) return t.receipts;
      return [];
    },
    async first(sql, ...p) {
      if (/FROM\s+receipts\s+WHERE\s+source/.test(sql)) return t.receipts.find((r) => r.source === p[0] && r.external_id === p[1]) || null;
      if (/SUM\(amount\)/.test(sql)) {
        return { n: t.receipts.length, gross: t.receipts.reduce((a, r) => a + r.amount, 0), fee: t.receipts.reduce((a, r) => a + r.fee, 0), net: t.receipts.reduce((a, r) => a + r.net_amount, 0) };
      }
      return null;
    },
    async insert(table, obj) { t[table] = t[table] || []; t[table].push(obj); return obj; },
    async get(table, id) { return (t[table] || []).find((r) => r.id === id) || null; },
    async update(table, id, patch) { const row = (t[table] || []).find((r) => r.id === id); if (row) Object.assign(row, patch); },
    async run() {}, async batch() {}, async exec() {},
  };
}

test('[C21] 署名を確認していない入金は記録できない（自己申告は実測にならない）', async () => {
  const s = memStore();
  const bad = await recordReceipt(s, { source: 'stripe', external_id: 'evt_1', amount: 5000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unverified');
  assert.equal(s.t.receipts.length, 0);
  const noSrc = await recordReceipt(s, { source: 'somewhere', external_id: 'e2', amount: 100, signature_verified: true });
  assert.equal(noSrc.error, 'bad_source');
  const ok = await recordReceipt(s, { source: 'stripe', external_id: 'evt_1', amount: 5000, signature_verified: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.receipt.net_amount, 5000);
});

test('[C22] 同じ決済通知を二重に数えない', async () => {
  const s = memStore();
  await recordReceipt(s, { source: 'x402', external_id: 'tx_abc', amount: 1000, signature_verified: true });
  const dup = await recordReceipt(s, { source: 'x402', external_id: 'tx_abc', amount: 1000, signature_verified: true });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate');
  assert.equal(s.t.receipts.length, 1);
});

test('[C23] 純益とAMRを出し、推定収益は算入しない', async () => {
  const s = memStore();
  await recordReceipt(s, { source: 'stripe', external_id: 'a', amount: 10000, fee: 500, currency: 'JPY', signature_verified: true });
  await recordReceipt(s, { source: 'x402', external_id: 'b', amount: 5000, fee: 0, currency: 'JPY', signature_verified: true });
  s.t.ledger.push({ kind: 'cost', amount: 2000, basis: 'measured' }, { kind: 'revenue', amount: 90000, basis: 'estimated' });
  const r = await revenueSummary(s);
  assert.equal(r.receipts.verified, 14500);
  assert.equal(r.receipts.fee, 500);
  assert.equal(r.cost, 2500);
  assert.equal(r.net, 12000);
  assert.equal(r.amr, 82.8);
  assert.equal(r.estimated_revenue, 90000);
  assert.ok(r.net < r.estimated_revenue, '推定は純益に混ざらない');
});

test('[C24] 案件は納品まで自動で進み、入金の確定だけは承認待ちになる', async () => {
  const s = memStore();
  const job = await createJob(s, { title: 'データ整理', price: 5000 });
  assert.equal(job.state, 'candidate');
  for (const want of ['proposed', 'approved', 'in_progress', 'delivered', 'invoiced']) {
    const r = await advanceJob(s, job.id);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.to, want);
  }
  const blocked = await advanceJob(s, job.id, { to: 'settled' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'approval_required');
  assert.equal((await s.get('jobs', job.id)).state, 'invoiced');
});

test('[C25] 自律の範囲は既定で最小、上限を超える支出は承認待ちになる', async () => {
  const env = { ...DEFAULT_ENVELOPE };
  assert.equal(env.auto_max_yen_per_action, 0);
  assert.equal(checkEnvelope(env, { action: 'spend', amount_yen: 100 }).allowed, false);
  assert.equal(checkEnvelope(env, { action: 'spend', amount_yen: 100 }).requires, 'approval');
  assert.equal(checkEnvelope(env, { action: 'external_signature' }).requires, 'human_only');
  assert.equal(checkEnvelope(env, { action: 'account_creation' }).requires, 'human_only');
  const wide = { ...env, auto_max_yen_per_action: 500, auto_max_yen_per_day: 1000 };
  assert.equal(checkEnvelope(wide, { action: 'spend', amount_yen: 300 }).allowed, true);
  assert.equal(checkEnvelope(wide, { action: 'spend', amount_yen: 300, spent_today_yen: 900 }).allowed, false);
  assert.equal(checkEnvelope(env, { action: 'publish' }).requires, 'approval');
  const p = parseEnvelopeRequest('自律の範囲で、1回の上限を500円にして');
  assert.equal(p.auto_max_yen_per_action, 500);
});

const EVM_TO = '0x1111111111111111111111111111111111111111';
const SVM_TO = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('[C26] x402 は受け取り先が未設定なら売りに出さず、入金の見張りは入金済みを見る', () => {
  assert.equal(x402Enabled({}), false);
  assert.equal(catalog({})[0].pay_to, null);
  assert.equal(challenge('brief', {}).configured, false);
  assert.equal(challenge('unknown', { X402_PAY_TO: EVM_TO }), null);
  const ch = challenge('brief', { X402_PAY_TO: EVM_TO });
  assert.equal(ch.configured, true);
  assert.equal(ch.body.accepts[0].payTo, EVM_TO);
  assert.equal(ch.body.accepts[0].scheme, 'exact');
  assert.ok(ch.body.accepts[0].maxAmountRequired);
  assert.ok(ch.body.accepts[0].amount);
  const w = parseWatch('入金が3万円に達したら教えて');
  assert.equal(w.metric, 'verified_revenue');
});

test('[C29] ネットワークは CAIP-2 で扱い、形式の違う受け取り先は売りに出さない', () => {
  assert.equal(resolveNetwork('base').caip2, 'eip155:8453');
  assert.equal(resolveNetwork('solana').caip2, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(resolveNetwork('solana-devnet').asset, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  assert.equal(resolveNetwork('nope'), null);
  assert.equal(isSolanaAddress(SVM_TO), true);
  assert.equal(isSolanaAddress(EVM_TO), false);
  assert.equal(isEvmAddress('0xabc'), false);
  // Solana に EVM のアドレスを渡したら、値札を出さず理由も言う
  const bad = { X402_PAY_TO: EVM_TO, X402_NETWORK: 'solana' };
  assert.equal(x402Enabled(bad), false);
  assert.match(catalog(bad)[0].blocked_reason, /形式/);
  assert.equal(challenge('brief', bad).configured, false);
  // Solana で正しい形式なら、feePayer が無い限り値札は出さない（extra.feePayer が必須のため）
  const svm = { X402_PAY_TO: SVM_TO, X402_NETWORK: 'solana' };
  assert.equal(x402Enabled(svm), true);
  assert.equal(challenge('brief', svm).configured, false);
  const withFee = challenge('brief', svm, { feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd' });
  assert.equal(withFee.configured, true);
  assert.equal(withFee.body.accepts[0].network, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  assert.equal(withFee.body.accepts[0].asset, SVM_TO);
  assert.equal(withFee.body.accepts[0].amount, '1000000');
  assert.equal(withFee.body.accepts[0].extra.feePayer, 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd');
});

test('[C30] facilitator が対応を確認できないネットワークでは売らない', async () => {
  const env = { X402_PAY_TO: SVM_TO, X402_NETWORK: 'solana' };
  const svmKind = { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', extra: { feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd' } };
  const ok = (kinds) => async () => ({ ok: true, json: async () => ({ kinds }) });
  const bad = await preflight(env, { fetchImpl: ok([{ scheme: 'exact', network: 'eip155:8453' }]), useCache: false });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'facilitator_unsupported');
  const down = await preflight(env, { fetchImpl: async () => { throw new Error('boom'); }, useCache: false });
  assert.equal(down.error, 'facilitator_unreachable');
  const good = await preflight(env, { fetchImpl: ok([svmKind]), useCache: false });
  assert.equal(good.ok, true);
  assert.equal(good.feePayer, 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd');
  // Solana なのに facilitator が feePayer を返さないなら売らない
  const noFee = await preflight(env, { fetchImpl: ok([{ scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }]), useCache: false });
  assert.equal(noFee.error, 'fee_payer_unavailable');
  // 形式が違う受け取り先も facilitator に問い合わせる前に止める
  const mismatch = await preflight({ X402_PAY_TO: EVM_TO, X402_NETWORK: 'solana' }, { fetchImpl: ok([svmKind]), useCache: false });
  assert.equal(mismatch.error, 'payto_network_mismatch');
});

test('[C31] 金額を読めない支払いは自前で判定せず、facilitator に委ねる（保留なら中身を渡さない）', async () => {
  const env = { X402_PAY_TO: EVM_TO, X402_NETWORK: 'base' };
  // EVM: 値段を下回る署名は facilitator に投げる前に弾く
  let called = 0;
  const under = await verifyAndSettle({
    env, resource: 'brief', fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({}) }; },
    paymentHeader: Buffer.from(JSON.stringify({ payload: { authorization: { value: '10' } } })).toString('base64'),
  });
  assert.equal(under.error, 'underpaid');
  assert.equal(called, 0);
  // Solana: 金額は取引の中にあり読めないので、facilitator の判定に任せる
  const svmEnv = { X402_PAY_TO: SVM_TO, X402_NETWORK: 'solana' };
  const seq = [
    { ok: true, json: async () => ({ isValid: true, payer: 'PayerPubkey111111111111111111111111111111' }) },
    { ok: true, json: async () => ({ success: false, errorReason: 'settlement_pending', transaction: 'SIG123' }) },
  ];
  const pend = await verifyAndSettle({
    env: svmEnv, resource: 'brief', feePayer: 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd',
    fetchImpl: async () => seq.shift(),
    paymentHeader: Buffer.from(JSON.stringify({ accepted: { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }, payload: { transaction: 'AAAA' } })).toString('base64'),
  });
  assert.equal(pend.ok, false);
  assert.equal(pend.error, 'settlement_pending');
  assert.equal(pend.tx, 'SIG123');
  assert.match(pend.note, /確定/);
});

test('[C32] x402 の事前確認と Solana の設定が実際に配線されている', () => {
  const idx = read('src/index.js');
  assert.match(idx, /await preflight\(env\)/);
  assert.match(idx, /feePayer: pf\.feePayer/);
  const loc = read('server/local.mjs');
  assert.match(loc, /X402_FEE_PAYER/);
  assert.match(loc, /X402_MAX_TIMEOUT/);
  const x = read('src/agent/x402.js');
  assert.match(x, /solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/);
  assert.match(x, /EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/);
});

test('[C27] 実行レイヤがデータ層とAPIに実際に配線されている', () => {
  const db = read('src/db.js');
  assert.match(db, /CREATE TABLE IF NOT EXISTS jobs/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS receipts/);
  assert.match(db, /idx_receipts_ext/);
  const sql = read('schema.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS receipts/);
  const api = read('src/api.js');
  assert.match(api, /'\/api\/webhooks\/x402'/);
  assert.match(api, /'\/api\/webhooks\/stripe'/);
  assert.match(api, /'\/api\/envelope'/);
  assert.match(api, /'\/api\/jobs'/);
  assert.match(api, /'\/api\/revenue'/);
  const idx = read('src/index.js');
  assert.match(idx, /PAYMENT-REQUIRED/);
  assert.match(idx, /isWebhook/);
  const cmd = read('src/agent/commands.js');
  assert.match(cmd, /id: 'envelope'/);
  assert.match(cmd, /id: 'jobs'/);
  assert.match(cmd, /id: 'revenue'/);
  // receipts を書けるのは revenue.js の recordReceipt だけ（webhook 以外の入口を作らない）
  const rev = read('src/agent/revenue.js');
  assert.match(rev, /insert\('receipts'/);
  const watch = read('src/agent/watch.js');
  assert.match(watch, /verified_revenue/);
  assert.match(watch, /net_profit/);
});

test('[C28] 通貨をまたいで足さない（円換算できない入金は純益に混ぜない）', async () => {
  const s = memStore();
  await recordReceipt(s, { source: 'stripe', external_id: 'j1', amount: 10000, currency: 'JPY', signature_verified: true });
  await recordReceipt(s, { source: 'x402', external_id: 'u1', amount: 1.5, currency: 'USDC', signature_verified: true });
  const r = await revenueSummary(s);
  assert.equal(r.receipts.count, 2);
  assert.equal(r.receipts.verified, 10000);
  assert.equal(r.net, 10000);
  assert.equal(r.receipts.unconverted[0].currency, 'USDC');
  assert.equal(r.receipts.unconverted[0].verified, 1.5);
  assert.match(revenueLine(r), /円換算せず/);
});


import { FREE_PROVIDERS, providerStatus, poolCapacity, routePlan, paidLanes } from '../src/agent/providers.js';
import { CHANNELS, netOf, rankByNet, channelCard } from '../src/agent/channels.js';

test('[C33] 無料AIはキー0本でも成立する（決定的エンジンが土台・ローカルは無制限）', () => {
  const st = providerStatus({});
  assert.equal(st.length, FREE_PROVIDERS.length);
  assert.equal(st.filter((p) => p.configured).length, 1);           // ローカル推論のみ
  assert.equal(st.find((p) => p.id === 'local').configured, true);
  const cap = poolCapacity({});
  assert.equal(cap.daily_requests, 0);                              // 従量の無料枠は未設定
  assert.equal(cap.unmetered, true);                                // それでも上限なしのレーンがある
  assert.equal(st.find((p) => p.id === 'gemini').missing[0], 'GEMINI_API_KEY');
});

test('[C34] 各社の独立した無料枠が合算され、有料は既定で封じる', () => {
  const env = { GEMINI_API_KEY: 'a', GROQ_API_KEY: 'b', CEREBRAS_API_KEY: 'c' };
  const cap = poolCapacity(env);
  assert.equal(cap.configured, 4);                                  // 3社 + ローカル
  assert.equal(cap.daily_requests, 1500 + 1000);     // RPD を持つレーンのみ
  assert.equal(cap.daily_tokens, 1000000);           // Cerebras は TPD で数える
  assert.equal(paidLanes(env).paid_allowed, false);
  assert.equal(paidLanes(env).blocked.length > 0, true);
  assert.equal(paidLanes({ ...env, ALLOW_PAID_AI: 'true' }).paid_allowed, true);
});

test('[C35] 用途別にレーンを並べ替える（code はコード向きが先頭、ローカルは最後の安全網）', () => {
  const env = { GROQ_API_KEY: 'b', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'i' };
  const plan = routePlan('code', env);
  assert.equal(plan.lanes[0].id === 'groq' || plan.lanes[0].id === 'cloudflare', true);
  assert.equal(plan.fallback, 'deterministic');
  const long = routePlan('long', env);
  assert.equal(long.lanes.length >= 2, true);
});

test('[C36] 売り先は手残り順に並び、規約で不可のチャネルは候補から外れる', () => {
  const envato = CHANNELS.find((c) => c.id === 'envato');
  assert.equal(envato.blocked, true);
  assert.equal(netOf('envato', 19).blocked, true);
  assert.equal(netOf('x402', 19).take_pct, 0);                      // 直販は手数料ゼロ
  assert.equal(netOf('coconala', 19).net, null);                    // 未確認を手数料0扱いしない
  assert.equal(netOf('x402', 19).net, 19);
  assert.equal(netOf('gumroad', 19).exact, true);                   // 公式ページで確認済み
  assert.equal(netOf('gumroad', 19).take_pct > 10, true);
  const ranked = rankByNet(19);
  assert.equal(ranked[0].id, 'x402');
  assert.equal(ranked.some((r) => r.id === 'envato'), false);
  const card = channelCard(19);
  assert.equal(card.blocked.includes('Envato (Market/Elements)'), true);
});

test('[C37] 配線契約: 会話からもAPIからも引ける', () => {
  const cmd = read('src/agent/commands.js');
  assert.match(cmd, /id: 'providers'/);
  assert.match(cmd, /id: 'channels'/);
  const api = read('src/api.js');
  assert.match(api, /'\/api\/providers'/);
  assert.match(api, /'\/api\/channels'/);
  const prov = read('src/agent/providers.js');
  assert.match(prov, /ALLOW_PAID_AI/);
  const ch = read('src/agent/channels.js');
  assert.match(ch, /autonomy/);
});

let pass = 0; const failed = [];
for (const [name, fn] of tests) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log(`\n════════ CAPABILITIES: ${pass} passed, ${failed.length} failed ════════`);
process.exit(failed.length ? 1 : 0);
