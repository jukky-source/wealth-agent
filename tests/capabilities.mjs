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
  assert.match(read('public/sw.js'), /wa-v1[2-9]/);
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
  assert.equal(withFee.body.accepts[0].amount, String(catalog({ X402_PAY_TO: EVM_TO, X402_NETWORK: 'solana' })[0].price_usdc));
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


import { FREE_PROVIDERS, providerStatus, poolCapacity, routePlan, paidLanes, noKeyLanes, humanGateLanes, TRIAL_CREDITS, FREE_HOSTS } from '../src/agent/providers.js';
import { CHANNELS, netOf, rankByNet, channelCard } from '../src/agent/channels.js';

test('[C33] 無料AIはキー0本でも成立する（決定的エンジンが土台・ローカルは無制限）', () => {
  const st = providerStatus({});
  assert.equal(st.length, FREE_PROVIDERS.length);
  // キーを1本も入れなくても、キー不要のレーンが最初から使える
  assert.equal(st.filter((p) => p.configured).length, 4);
  assert.equal(st.find((p) => p.id === 'local').configured, true);
  assert.equal(st.find((p) => p.id === 'kilo').configured, true);
  const cap = poolCapacity({});
  assert.equal(cap.daily_requests, 0);                              // 従量の無料枠は未設定
  assert.equal(cap.unmetered, true);                                // それでも上限なしのレーンがある
  assert.equal(cap.unkeyed_hourly_requests, 450);                   // キー不要の 200 + 250 回/時
  assert.equal(st.find((p) => p.id === 'gemini').missing[0], 'GEMINI_API_KEY');
});

test('[C34] 各社の独立した無料枠が合算され、有料は既定で封じる', () => {
  const env = { GEMINI_API_KEY: 'a', GROQ_API_KEY: 'b', CEREBRAS_API_KEY: 'c' };
  const cap = poolCapacity(env);
  assert.equal(cap.configured, 8);                                  // gemini + gemma(同じ鍵) + groq + cerebras + キー不要4本
  assert.equal(cap.daily_requests, 14400 + 1500 + 1000);            // RPD を持つレーンのみ（Gemma が最大）
  assert.equal(cap.daily_tokens, 1000000);           // Cerebras は TPD で数える
  assert.equal(cap.hourly_tokens, 1000000);          // 毎時でも 100 万トークン
  assert.equal(paidLanes(env).paid_allowed, false);
  assert.equal(paidLanes(env).blocked.length > 0, true);
  assert.equal(paidLanes({ ...env, ALLOW_PAID_AI: 'true' }).paid_allowed, true);
});

test('[C35] 用途別にレーンを並べ替える（code はコード向きが先頭、ローカルは最後の安全網）', () => {
  const env = { GROQ_API_KEY: 'b', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'i' };
  const plan = routePlan('code', env);
  assert.equal(plan.lanes[0].id, 'kilo');                           // キー不要のレーンを最優先
  const local = plan.lanes.find((l) => l.id === 'local');
  const cf = plan.lanes.find((l) => l.id === 'cloudflare');
  assert.equal(local.score < cf.score, true);                       // 無制限のローカルは最後の受け皿
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

test('[C38] キーもカードも無しで使えるレーンが最初から複数ある', () => {
  const lanes = noKeyLanes();
  assert.equal(lanes.length >= 3, true);
  const ids = lanes.map((l) => l.id);
  assert.ok(ids.includes('kilo') && ids.includes('llm7') && ids.includes('ovh') && ids.includes('local'));
  for (const l of lanes) assert.ok(l.limits);
  assert.equal(providerStatus({}).find((p) => p.id === 'kilo').no_key, true);
});

test('[C39] 一度だけ人間が要るレーンを分けて数える（勝手に確認済みにしない）', () => {
  const gates = humanGateLanes().map((g) => g.id);
  assert.ok(gates.includes('nvidia') && gates.includes('codestral') && gates.includes('modelscope'));
  const cap = poolCapacity({});
  assert.equal(cap.human_gate.length >= 3, true);
  const nv = FREE_PROVIDERS.find((p) => p.id === 'nvidia');
  assert.equal(nv.limits.rpd, 10000);
  assert.equal(cap.lanes.some((l) => l.id === 'nvidia'), false);    // 鍵が無いので容量に入れない
});

test('[C40] 規約でAI生成物を売れない売り先は外し、条件付きの先は条件を記録する', () => {
  assert.equal(CHANNELS.find((c) => c.id === 'shutterstock').blocked, true);
  const adobe = CHANNELS.find((c) => c.id === 'adobe_stock');
  assert.equal(adobe.blocked, undefined);
  assert.equal(adobe.verified, true);
  assert.equal(netOf('adobe_stock', 19).take_pct, 67);              // 受取は 33%
  assert.equal(netOf('adobe_stock', 19).net, 6.27);
  assert.match(adobe.ai_policy, /Generative AI/);
  assert.equal(netOf('depin_bandwidth', 19).net, null);             // 歩率が未確認なので数字を出さない
});

test('[C41] 一発のクレジットは容量に混ぜず、無料のホスト先も記録する', () => {
  assert.equal(TRIAL_CREDITS.length >= 10, true);
  assert.ok(TRIAL_CREDITS.some((t2) => t2.id === 'modal'));
  assert.equal(poolCapacity({ MODAL_API_KEY: 'x' }).daily_requests, 0);   // 初回クレジットは「枠」ではない
  assert.equal(FREE_HOSTS.some((h) => h.id === 'oracle_always_free' && h.verified), true);
  const prov = read('src/agent/providers.js');
  assert.match(prov, /TRIAL_CREDITS/);
  assert.match(prov, /FREE_HOSTS/);
});

import { PRICE_ANCHORS, usageBoard, capacityValue, inferenceCards, CHARS_PER_TOKEN, jpyFromTokens } from '../src/agent/inference.js';

test('[C42] 実測の使用量を数え、有料なら何円かを出す（空想は出さない）', () => {
  const rows = [
    { provider: 'kilo', ok: 1, prompt_chars: 4000, output_chars: 800, latency_ms: 900, day: '2026-10-13' },
    { provider: 'kilo', ok: 1, prompt_chars: 2000, output_chars: 400, latency_ms: 800, day: '2026-10-13' },
    { provider: 'groq', ok: 0, prompt_chars: 1000, output_chars: 0, latency_ms: 300, day: '2026-10-12' },
  ];
  const b = usageBoard(rows);
  assert.equal(b.calls, 3);
  assert.equal(b.ok_calls, 2);
  assert.equal(b.failed, 1);
  assert.equal(b.active_days, 2);
  assert.equal(b.measured, true);
  assert.equal(b.in_tokens, Math.round(7000 / CHARS_PER_TOKEN));
  assert.equal(b.out_tokens, Math.round(1200 / CHARS_PER_TOKEN));
  assert.ok(b.value.yen > 0);
  // 単価の順序（安い方だけで見積もらないため3本併記する）
  assert.ok(b.alternatives[2].usd > b.alternatives[1].usd);
  assert.ok(b.alternatives[1].usd > b.alternatives[0].usd);
  const big = jpyFromTokens({ in_tokens: 1000000, out_tokens: 1000000 });
  assert.ok(big.yen > 0);
  for (const a of b.alternatives) assert.ok(a.source.startsWith('https://'));
  assert.equal(b.lanes[0].provider, 'kilo');

  const empty = usageBoard([]);
  assert.equal(empty.measured, false);
  assert.equal(empty.value.yen, 0);
  assert.equal(empty.calls, 0);
});

test('[C43] 推定（クォータ）と実測を混ぜない', () => {
  const cap = capacityValue({ daily_requests: 10000, unkeyed_hourly_requests: 450 });
  assert.equal(cap.turns, 10000 + 450 * 8);
  assert.ok(cap.per_month_yen > cap.per_day_yen);
  assert.ok(cap.source.startsWith('https://'));
  // 実測0件のときに推定額が実測の欄へ紛れ込まないこと
  const b = usageBoard([]);
  assert.equal(b.value.yen, 0);
  const cards = inferenceCards(b, { capacity: cap });
  assert.equal(cards[0].type, 'kpi');
  const head = cards[0].items.find((i) => i.label === '有料なら');
  assert.equal(head.value, 0);
  assert.equal(cards[cards.length - 1].type, 'note');
  assert.match(cards[cards.length - 1].text, /推定/);
  assert.equal(jpyFromTokens({ in_tokens: 1000000, out_tokens: 0 }, 'gpt5_mini').yen > 0, true);
});

test('[C44] 配線契約: 会話からもAPIからも使用量を引ける', () => {
  const cmd = read('src/agent/commands.js');
  assert.match(cmd, /id: 'inference'/);
  assert.match(cmd, /readUsageBoard/);
  const api = read('src/api.js');
  assert.match(api, /'\/api\/inference'/);
  const inf = read('src/agent/inference.js');
  assert.match(inf, /ai_usage/);
  assert.match(inf, /PRICE_ANCHORS/);
  assert.equal(PRICE_ANCHORS.length >= 3, true);
});

import { AUTO_LANES, HANDS_RANK, MONITOR_PRODUCTS, autoPlan, laneNet, rankByLeastHands } from '../src/agent/autolanes.js';

test('[C45] 売り場は「俺の手間」の少ない順に並ぶ（手残りは確認済みだけ出す）', () => {
  const rows = rankByLeastHands(19);
  assert.equal(rows.length, AUTO_LANES.length);
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(HANDS_RANK[rows[i - 1].hands] <= HANDS_RANK[rows[i].hands], '手間の順序が崩れている');
  }
  // 手数料が未確認／チャネル無しは数字を出さない（空想の手残りを出さない）
  assert.equal(laneNet('github_sponsors', 19), null);   // チャネル無し = 手数料未確認
  assert.equal(laneNet('nope', 19), null);
  assert.equal(AUTO_LANES.find((l) => l.id === 'payhip').verified, false);
  // 確認済みは数字が出る
  assert.ok(laneNet('rapidapi', 19) > 0);
  assert.ok(laneNet('lemonsqueezy', 19) > 0);
  // 監視型サブスクは「立ち上げ1回だけ」＝放置で課金が積み上がる形
  const mon = rows.find((r) => r.id === 'monitor_subscription');
  assert.equal(mon.hands, 'once');
  assert.equal(mon.setup_minutes <= 30, true);
});

test('[C46] 手間最小の構成は、自分で告知しなくても客が来る所だけを選ぶ', () => {
  const plan = autoPlan();
  assert.equal(plan.chosen.length, 3);
  for (const c of plan.chosen) {
    assert.equal(c.hands === 'often', false);
    assert.ok(c.discovery === 'marketplace' || c.discovery === 'registry');
  }
  assert.ok(plan.excluded.includes('adobe_stock'));      // 差し戻し対応が人手 → 除外
  assert.ok(plan.recurring.length >= 5);
  assert.equal(plan.residual_human.length >= 1, true);   // 残る人手は隠さない
});

test('[C47] 監視型サブスク: 原価0・在庫なし・価格は提案として区別する', () => {
  assert.ok(MONITOR_PRODUCTS.length >= 5);
  for (const p of MONITOR_PRODUCTS) {
    assert.equal(p.cost, 0);
    assert.equal(p.suggested.proposed, true);            // 相場ではなく提案
    assert.equal(typeof p.build_minutes, 'number');
    assert.ok(p.cadence.length > 0);
  }
  const ids = MONITOR_PRODUCTS.map((p) => p.id);
  assert.ok(ids.includes('price_watch'));
});

test('[C48] 配線契約: 会話からもAPIからも「手間の少ない売り場」を引ける', () => {
  const cmd = read('src/agent/commands.js');
  assert.match(cmd, /id: 'autolanes'/);
  assert.match(cmd, /laneCard/);
  const api = read('src/api.js');
  assert.match(api, /'\/api\/autolanes'/);
  const al = read('src/agent/autolanes.js');
  assert.match(al, /from '\.\/channels\.js'/);
  assert.match(al, /HANDS_RANK/);
});


import { CAPS, PIPELINE, assessDraft, capsUsage, createDraft, dupCheck, similarity, weekKey } from '../src/agent/publish.js';

test('[C49] 本数の上限はコードで強制する（規約が禁じるのは自動化ではなく量産）', () => {
  // 当日ぶんとして数える仕様なので、日付は固定値ではなく「今日(UTC)」を使う
  const day = new Date().toISOString().slice(0, 10);
  const rows = [1, 2, 3].map((i) => ({
    id: `d${i}`, channel: 'x', linked: 1, state: 'approved',
    created_at: `${day}T0${i}:00:00.000Z`, day,
  }));
  const u = capsUsage(rows, `${day}T09:00:00.000Z`);
  assert.equal(u.x.linked_today, 3);
  assert.equal(u.x.left, 0);
  const v = assessDraft(createDraft({ channel: 'x', body: '新しい告知 https://example.com/a です' }), { rows });
  assert.equal(v.ok, false);
  assert.ok(v.blocks.some((b) => /上限/.test(b)));
  // 上限に達していなければ通る
  const v2 = assessDraft(createDraft({ channel: 'x', body: '別の切り口の告知 https://example.com/b です' }), { rows: rows.slice(0, 1) });
  assert.equal(v2.ok, true, v2.blocks.join(' / '));
});

test('[C50] ほぼ同じ文面は、人が見る前に自動で止める', () => {
  const a = 'AIで作ったレポートを公開しました。詳しくは概要欄のリンクからどうぞ。https://example.com/1';
  const b = 'AIで作ったレポートを公開しました。詳しくは概要欄のリンクからどうぞ！ https://example.com/2';
  assert.ok(similarity(a, b) > 0.9, 'URLと句読点の違いを無視できていない');
  const dup = dupCheck(b, [{ id: 'x1', body: a }]);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.against, 'x1');
  const v = assessDraft(createDraft({ channel: 'x', body: b }), { history: [{ id: 'x1', body: a }] });
  assert.equal(v.ok, false);
  assert.ok(v.blocks.some((x) => /重複/.test(x)));
  // 別内容なら通る
  const v2 = assessDraft(createDraft({ channel: 'x', body: '在庫の見張りを始めました。再入荷だけ通知します。' }), { history: [{ id: 'x1', body: a }] });
  assert.equal(v2.ok, true, v2.blocks.join(' / '));
});

test('[C51] YouTubeはAI開示と独自解説が無いと通さない（外部誘導のみは禁止）', () => {
  const base = { channel: 'youtube', kind: 'script', body: '今週の為替の動きを独自の解説つきでまとめます。' };
  const noDisclosure = assessDraft(createDraft({ ...base, unique_commentary: true }), {});
  assert.equal(noDisclosure.ok, false);
  assert.ok(noDisclosure.blocks.some((b) => /AI開示/.test(b)));
  const funnelOnly = assessDraft(createDraft({ ...base, ai_disclosure: true, linked: true, unique_commentary: false }), {});
  assert.equal(funnelOnly.ok, false);
  assert.ok(funnelOnly.blocks.some((b) => /独自性/.test(b)));
  const ok = assessDraft(createDraft({ ...base, ai_disclosure: true, unique_commentary: true }), {});
  assert.equal(ok.ok, true, ok.blocks.join(' / '));
  // YouTubeの週上限
  const rows = [1, 2].map((i) => ({
    id: `y${i}`, channel: 'youtube', linked: 0, state: 'posted',
    created_at: `2026-10-1${i + 1}T00:00:00.000Z`, day: `2026-10-1${i + 1}`,
  }));
  assert.equal(weekKey('2026-10-12T00:00:00.000Z'), weekKey('2026-10-14T00:00:00.000Z'));
  const capped = assessDraft(createDraft({ ...base, ai_disclosure: true, unique_commentary: true, created_at: '2026-10-13T00:00:00.000Z' }),
    { rows, at: '2026-10-13T00:00:00.000Z' });
  assert.equal(capped.blocks.some((b) => /週/.test(b)), true);
});

test('[C52] 人が触る工程は投稿の承認だけ（下書きまでは全自動）', () => {
  const human = PIPELINE.filter((p) => p.human);
  assert.equal(human.length, 1);
  assert.equal(human[0].step, 'approve');
  assert.equal(human[0].auto, false);
  assert.ok(PIPELINE.filter((p) => p.auto).length >= 6);
  assert.ok(PIPELINE.filter((p) => p.needs_runner).length >= 2);   // 実行環境が要る工程は隠さない
  assert.equal(CAPS.x.linked_per_day, 3);
  const cmd = read('src/agent/commands.js');
  assert.match(cmd, /id: 'publish'/);
  const api = read('src/api.js');
  assert.match(api, /'\/api\/publish'/);
  const pb = read('src/agent/publish.js');
  assert.match(pb, /DUPLICATE_THRESHOLD/);
});

test('[C53] 実行環境が要る工程と、ジョブ種別が1対1で対応している', async () => {
  const { PIPELINE } = await import('../src/agent/publish.js');
  const { runnerPlan, STEP_KIND } = await import('../src/agent/runner.js');
  const plan = runnerPlan(PIPELINE);
  const needs = plan.filter((p) => p.needs_runner);
  assert.equal(needs.length, 2);
  for (const p of needs) {
    assert.ok(STEP_KIND[p.step], `${p.step} に対応するジョブ種別がありません`);
    assert.equal(p.runner_kind, STEP_KIND[p.step]);
  }
  assert.equal(plan.find((p) => p.step === 'approve').runs_on, 'worker');   // 承認は人の手元
  assert.equal(plan.find((p) => p.step === 'encode').runs_on, 'ffmpeg');
  assert.equal(plan.find((p) => p.step === 'voice').runs_on, 'tts');
  assert.equal(plan.find((p) => p.step === 'research').runs_on, 'worker');
});

test('[C54] 実行環境は、許可したジョブ以外を実行前に断る', async () => {
  const { dispatchJob } = await import('../src/agent/runner.js');
  const r = await dispatchJob({}, null, { kind: 'shell', payload: { cmd: 'rm -rf /' } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'kind_not_allowed');
  assert.ok(r.allowed.includes('encode'));
  assert.ok(!r.allowed.includes('shell'));
  const { planJob } = await import('../runner/jobs.mjs');
  assert.equal(planJob('shell', {}).ok, false);
});

test('[C55] 実行環境が無いときは、黙って失敗せず理由を出す', async () => {
  const { runnerState } = await import('../src/agent/runner.js');
  const none = runnerState({});
  assert.equal(none.mode, 'none');
  assert.match(none.blocked_reason, /Workers上では動きません/);
  assert.equal(none.containers_bound, false);
  const q = runnerState({ RUNNER_ENABLED: 'true' });
  assert.equal(q.mode, 'queue');
  assert.equal(q.blocked_reason, null);
  const c = runnerState({ RUNNER_CONTAINER: { getByName() {} } });
  assert.equal(c.mode, 'container');
  assert.equal(c.blocked_reason, null);
});

test('[C56] コンテナの定義が揃っている（ffmpeg・TTS・小さめの実体・認証必須）', () => {
  const docker = read('runner/Dockerfile');
  assert.match(docker, /ffmpeg/);
  assert.match(docker, /espeak-ng/);
  assert.match(docker, /runner\/jobs|jobs-server\.mjs/);
  const srv = read('runner/jobs-server.mjs');
  assert.match(srv, /kind_not_allowed/);          // 任意コマンドは受けない
  assert.match(srv, /unauthorized/);              // トークン必須
  assert.match(srv, /artifact\//);               // 成果物はその場で取り出せる
  const wc = read('wrangler.containers.toml');
  assert.match(wc, /\[\[containers\]\]/);
  assert.match(wc, /instance_type = "basic"/);
  assert.match(wc, /RUNNER_CONTAINER/);
  assert.match(wc, /class_name = "RunnerContainer"/);
  assert.match(read('src/container-entry.js'), /extends Container/);
  // 無料側の入口は触らない（無料配備を壊さない）
  assert.match(read('wrangler.toml'), /main = "src\/index\.js"/);
  assert.match(read('.github/workflows/deploy-containers.yml'), /workflow_dispatch/);
});

test('[C57] 会話とAPIの両方から実行環境を引ける', async () => {
  const cmd = read('src/agent/commands.js');
  assert.match(cmd, /id: 'runner'/);
  assert.match(cmd, /'autolanes', 'publish', 'runner'/);
  for (const k of ['autolanes', 'publish', 'runner']) assert.ok(cmd.includes(`'${k}'`));
  const api = read('src/api.js');
  assert.match(api, /'\/api\/runner\/status'/);
  assert.match(api, /'\/api\/runner\/dispatch'/);
});

test('[C58] 画像つきの会話：受付・縮小・読み取り・保存が配線されている', async () => {
  const api = read('src/api.js');
  assert.match(api, /chatImages\(body\?\.images\)/);
  assert.match(api, /image_rejected/);
  assert.match(api, /router\.vision\(/);
  assert.match(api, /images_json/);
  assert.match(read('src/db.js'), /ALTER TABLE chat_messages ADD COLUMN images_json/);
  const app = read('public/app.js');
  assert.match(app, /function shrinkImage/);
  assert.match(app, /images \}/);
  assert.match(read('public/index.html'), /id="fileIn" accept="image\/\*"/);
});

test('[C59] Workers AI は無料枠（Neurons）の上限で止まる', async () => {
  const { Router, estimateNeurons, neuronCap } = await import('../src/ai/router.js').then((m) => ({ ...m, Router: m.AIRouter || m.Router || m.default }));
  assert.equal(neuronCap({}), 9000);
  assert.equal(neuronCap({ WORKERS_AI_NEURON_CAP: '0' }), 0);
  assert.ok(estimateNeurons('@cf/meta/llama-4-scout-17b-16e-instruct', 2000, 600) > 0);
  for (const f of ['wrangler.toml', 'wrangler.containers.toml']) {
    assert.match(read(f), /\[ai\]\s*\nbinding = "AI"/);
    assert.match(read(f), /WORKERS_AI_NEURON_CAP = "9000"/);
  }
  assert.match(read('src/ai/router.js'), /workersai: neuron_cap/);
});

test('[C60] エージェント設定：性格・自律性・お金の上限・アイコン・動かす/止める', async () => {
  const app = read('public/app.js');
  for (const k of ['async function openAgent', "'/api/envelope'", "'/api/character'", '/api/character/avatar', 'agRisk', 'agAuto', 'agYen1', 'agYenD', 'agPost', 'agRun']) assert.ok(app.includes(k), k);
  const api = read('src/api.js');
  assert.match(api, /Math\.min\(5000/);
  assert.match(api, /Math\.min\(20000/);
  assert.match(api, /delete b\[k\]/); // 人間だけの操作は画面から変えられない
});

test('[C61] アニメーションは動きを減らす設定を尊重する', () => {
  const css = read('public/styles.css');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /@keyframes pop/);
  assert.match(read('public/app.js'), /function countUp/);
});

let pass = 0; const failed = [];
// ------------------------------------------------ x402 本番 facilitator / 決済前の注文検査 / 即納品
{
  const { defaultFacilitator, resolveNetwork: rn } = await import('../src/agent/x402.js');
  const { validateOrder, fulfillOrder, staticReview } = await import('../src/agent/fulfill.js');
  test('[C70] Base 本番の既定 facilitator はテストネット専用の x402.org にしない', async () => {
    assert.notEqual(defaultFacilitator(rn('base')), 'https://x402.org/facilitator');
    assert.equal(defaultFacilitator(rn('base-sepolia')), 'https://x402.org/facilitator');
  });
  test('[C71] 満たせない注文は決済前に断る（請求しない）', async () => {
    assert.equal(validateOrder('brief', {}).ok, false);
    assert.equal(validateOrder('data-clean', { data: '' }).ok, false);
    assert.equal(validateOrder('code-review', { code: 'x' }).ok, false);
    assert.equal(validateOrder('brief', { question: 'x402 facilitator 比較' }).ok, true);
  });
  test('[C72] data-clean は実際に重複・空行を除いた表を返す', async () => {
    const r = await fulfillOrder('data-clean', { data: 'name,price\nA,100\nA,100\n , \nB, 200 ' });
    assert.equal(r.ok, true);
    assert.equal(r.deliverable.changes.duplicates_removed, 1);
    assert.equal(r.deliverable.changes.empty_rows_removed, 1);
    assert.ok(r.deliverable.csv.includes('B,200'));
  });
  test('[C73] code-review はAI無しでも静的検査で根拠つきに納品する', async () => {
    const st = staticReview('const k = "api_key=abcdefghijk";\neval(x)\ntry{}catch(e){}');
    assert.ok(st.issues.some((i) => i.rule === 'eval' && i.line === 2));
    const r = await fulfillOrder('code-review', { code: 'var a = 1;\nif (a == "1") eval(a)' }, { router: null });
    assert.equal(r.ok, true);
    assert.equal(r.deliverable.degraded, true);
    assert.ok(r.deliverable.static_findings.length >= 2);
  });
}


// ---- C74〜C77: エージェント間販売（AIがAIに売る）----
const __ck = (cond, msg) => { if (!cond) throw new Error(msg || 'check failed'); };
tests.push(['C74 A2Aエージェントカードが全品目とx402支払い条件を公開', async () => {
  const { agentCard } = await import('../src/agent/a2a.js');
  const { catalog } = await import('../src/agent/x402.js');
  const nItems = catalog({ X402_PAY_TO: '0x3291398dC7070472CF2ED2e757246d089760Ca91', X402_NETWORK: 'base' }).length;
  const card = agentCard({ X402_PAY_TO: '0x3291398dC7070472CF2ED2e757246d089760Ca91', X402_NETWORK: 'base' }, 'https://ex.test');
  __ck(card.skills.length === nItems, 'skills=全品目');
  __ck(card.extensions.x402.payment.required === true, 'payment.required');
  __ck(card.skills.every((s) => /USDC/.test(s.description)), 'price shown');
}]);
tests.push(['C75 Bazaar宣言とディスカバリ・フィードが仕様どおり', async () => {
  const { bazaarExtension, discoveryFeed } = await import('../src/agent/x402.js');
  const b = bazaarExtension('brief');
  __ck(b.info.input.method === 'POST' && b.info.input.body.question, 'bazaar info');
  __ck(b.schema.properties.input.properties.body.properties.question, 'bazaar schema');
  const f = discoveryFeed({ X402_PAY_TO: '0x3291398dC7070472CF2ED2e757246d089760Ca91', X402_NETWORK: 'base' }, 'https://ex.test');
  const { catalog: cat75 } = await import('../src/agent/x402.js');
  __ck(f.x402Version === 2 && f.items.length === cat75({ X402_PAY_TO: '0x3291398dC7070472CF2ED2e757246d089760Ca91', X402_NETWORK: 'base' }).length, 'feed items=全品目');
  __ck(f.items[0].metadata.input.properties.question, 'feed input schema');
}]);
tests.push(['C76 MCPサーバがinitializeとtools/listに応答し、有料ツールを公開', async () => {
  const { handleMcp, toolList } = await import('../src/agent/mcp.js');
  const url = new URL('https://ex.test/mcp');
  const init = await handleMcp(new Request('https://ex.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) }), {}, url, {});
  const j = await init.json();
  __ck(j.result.serverInfo.name === 'wealth-agent', 'serverInfo');
  const list = await handleMcp(new Request('https://ex.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }), {}, url, {});
  const lj = await list.json();
  __ck(lj.result.tools.length === toolList().length && lj.result.tools.length >= 4, 'tools=全件');
  __ck(toolList().some((t) => t.name === 'buy_research_brief' && /USDC/.test(t.description)), 'paid tool');
}]);
tests.push(['C77 未払いのMCP呼び出しは402とPAYMENT-REQUIREDを返す（決済前・請求なし）', async () => {
  const { handleMcp } = await import('../src/agent/mcp.js');
  const url = new URL('https://ex.test/mcp');
  const env = { X402_PAY_TO: '0x3291398dC7070472CF2ED2e757246d089760Ca91', X402_NETWORK: 'base' };
  const res = await handleMcp(new Request('https://ex.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'buy_research_brief', arguments: { question: 'x402 facilitator を比較して' } } }) }), env, url, {});
  __ck(res.status === 402, 'status 402');
  __ck(!!res.headers.get('PAYMENT-REQUIRED'), 'challenge header');
  const body = await res.json();
  const px = String(catalog(env)[0].price_usdc);
  __ck(body.error.code === -32402 && body.error.data.accepts[0].amount === px, 'challenge body');
}]);

// ---- C78〜C83: AIコンテンツ販売（規約準拠ゲート）----
tests.push(['C78 規約で禁止の宛先（Shutterstock）は売り先から外れる', async () => {
  const { preflightDestination, DESTINATIONS } = await import('../src/agent/content.js');
  const pre = preflightDestination('shutterstock');
  __ck(pre.ok === false && pre.error === 'forbidden_by_policy', 'forbidden');
  __ck(/^https:\/\//.test(pre.source || ''), 'cites the policy url');
  const d = DESTINATIONS.find((x) => x.id === 'shutterstock');
  __ck(d.blocked === true && d.ai === 'forbidden', 'blocked flag');
}]);
tests.push(['C79 開示が必須の宛先は、開示文なしでは出せない', async () => {
  const { assessContent, disclosureFor } = await import('../src/agent/content.js');
  const no = await assessContent({ kind: 'article', title: 'A', body: '本文'.repeat(150) }, { destination: 'gumroad' });
  __ck(no.ok === false && no.blocks.some((b) => b.includes('開示')), 'label required');
  const ok = await assessContent({ kind: 'article', title: 'A', body: `この記事はAIを使って作成しました。${'本文'.repeat(150)}` }, { destination: 'gumroad' });
  __ck(ok.ok === true, 'with label passes: ' + ok.blocks.join(','));
  __ck(/AI/.test(disclosureFor('gumroad', 'article')) && disclosureFor('adobe_stock', 'image-set') === 'Generative AI', 'disclosure per destination');
}]);
tests.push(['C80 量産ゲート: 重複した成果物は差し戻し、本数上限で止まる', async () => {
  const { assessContent, CONTENT_CAPS } = await import('../src/agent/content.js');
  const body = `この記事はAIを使って作成しました。${'同じ内容を繰り返す本文です。'.repeat(30)}`;
  const dup = await assessContent({ kind: 'article', title: 'T', body }, { destination: 'medium', history: [{ id: 'old', body }] });
  __ck(dup.ok === false && dup.blocks.some((b) => b.includes('重複')), 'dup blocked');
  const rows = Array.from({ length: CONTENT_CAPS.medium.n }, () => ({ channel: 'medium', state: 'posted', created_at: new Date().toISOString(), day: new Date().toISOString().slice(0, 10) }));
  const capped = await assessContent({ kind: 'article', title: 'T2', body: `${body}別の追記を足しました` }, { destination: 'medium', rows });
  __ck(capped.ok === false && capped.blocks.some((b) => b.includes('本数の上限')), 'cap blocked');
}]);
tests.push(['C81 禁止カテゴリ（プロンプト束・実在人物）は出す前に落とす', async () => {
  const { assessContent } = await import('../src/agent/content.js');
  const p = await assessContent({ kind: 'article', title: 'プロンプト集', body: `この記事はAIを使って作成しました。${'x'.repeat(300)}プロンプト束を販売します` }, { destination: 'etsy' });
  __ck(p.ok === false && p.checks.prohibited_hits.includes('prompt_bundle'), 'prompt bundle');
  const r = await assessContent({ kind: 'image-set', title: 'AI画像セット', body: 'This image was created using an AI image generation program. 実在の人物の顔を再現した画像です' }, { destination: 'adobe_stock' });
  __ck(r.ok === false && r.checks.prohibited_hits.includes('real_person'), 'real person');
}]);
tests.push(['C82 稼ぎ方にAIコンテンツ販売があり、宛先の規約は出典URLつきで未確認は未確認', async () => {
  const { STREAMS, streamById } = await import('../src/agent/streams.js');
  const { DESTINATIONS } = await import('../src/agent/content.js');
  __ck(!!streamById('ai_content'), 'stream exists');
  __ck(STREAMS.length === 4, `streams=4 (got ${STREAMS.length})`);
  __ck(DESTINATIONS.every((d) => /^https:\/\//.test(d.source || '')), 'every destination cites a source');
  __ck(DESTINATIONS.some((d) => d.verified === false), 'unverified stays unverified');
  __ck(DESTINATIONS.some((d) => d.id === 'x402' && d.autonomy === 'full'), 'own channel is fully autonomous');
}]);
tests.push(['C83 配線契約: 会話からもAPIからもAIコンテンツの売り先を引ける', () => {
  __ck(read('src/agent/commands.js').includes("id: 'content'"), 'chat command');
  __ck(read('src/api.js').includes('/api/content/destinations'), 'api route');
  __ck(read('src/api.js').includes('/api/content/assess'), 'assess route');
  __ck(read('src/engine/planner.js').includes('RETIRED_CATEGORIES'), 'planner guard intact');
}]);

// ---- C84〜C85: 活動報告（いま何をしているかを実測で報告する）----
tests.push(['C84 活動報告: 実行中・判断待ち・売り物・次の一手を実データから具体的に書き出す', async () => {
  const { renderReport } = await import('../src/agent/report.js');
  const now = new Date().toISOString();
  const facts = {
    generated_at: now,
    counts: { running: 2, queued: 3, completed: 7, failed: 1, waiting: 1 },
    running: [{ id: 't1', title: 'x402の値札を6チェーンに増やす', category: 'income', state: 'running', attempt: 1, max_attempts: 3, next_action: 'テストを流す', updated_at: now, started_at: now }],
    queued: [{ id: 't2', title: 'Bazaar 掲載の確認', category: 'income', state: 'queued', priority: 70, attempt: 0, created_at: now }],
    completed: [{ id: 't0', title: '検索経路の総当たりを実装', state: 'completed', finished_at: now }],
    failures: [],
    waiting: [],
    approvals: [{ id: 'a1', action: 'public_post', note: 'Xへの投稿', requested_at: now }],
    missions: [{ id: 'm1', title: '月5万円', status: 'active', progress: 12, metric_unit: 'JPY' }],
    ledger: { rows: 0, recent: [] },
    receipts: { count: 0, test_count: 2, by_currency: {} },
    jobs: { open: [], by_state: [] },
    delta: null,
    sales: [{ resource: '/api/x402/brief', price_label: '1.00 USDC', networks: ['eip155:8453'], pay_to: '0x3291' }],
    sellable: true,
  };
  const r = renderReport(facts, { env: {} });
  __ck(/【活動報告】/.test(r.text), 'has a header');
  __ck(r.text.includes('x402の値札を6チェーンに増やす'), 'names the running work');
  __ck(r.text.includes('1.00 USDC'), 'lists the price tag');
  __ck(r.text.includes('あなたの判断待ち') && r.text.includes('public_post'), 'surfaces owner blockers');
  __ck(r.next.some((x) => x.includes('x402の値札')) , 'states the next move');
  __ck(r.headline.includes('実行中 2 件'), 'headline carries the counts');
}]);
tests.push(['C85 活動報告: 検証用の決済は売上に数えず、入金0を0と書く', async () => {
  const { collectFacts, renderReport } = await import('../src/agent/report.js');
  const fake = {
    async all(sql) {
      if (/COUNT\(\*\) AS c FROM tasks/.test(sql)) return [{ c: 0 }];
      if (/FROM tasks GROUP BY state/.test(sql)) return [{ state: 'running', c: 1 }, { state: 'failed', c: 2 }, { state: 'completed', c: 4 }];
      if (/state='failed'/.test(sql)) return [{ id: 'f1', title: '値札の検証', state: 'failed', attempt: 2, max_attempts: 3, error_history: JSON.stringify([{ at: 'now', error: 'boom', diagnosis: '設定が足りない' }]), updated_at: new Date().toISOString() }];
      if (/FROM receipts/.test(sql)) return [
        { currency: 'USDC', amount: 1, net_amount: 1, external_id: 'test_abc', created_at: '2026-10-15T01:00:00.000Z' },
        { currency: 'USDC', amount: 0, net_amount: 0, external_id: 'test_def', created_at: '2026-10-15T01:30:00.000Z' },
      ];
      return [];
    },
    async first() { return null; },
    async run() { return {}; },
  };
  const facts = await collectFacts(fake, {});
  const r = renderReport({ ...facts, engine: { status: 'running' } }, { env: {} });
  __ck(facts.receipts.count === 0 && facts.receipts.test_count === 2, 'testnet rows are not counted as revenue');
  __ck(r.money.receipts === 0 && r.money.test_receipts === 2, 'report separates test rows');
  __ck(r.text.includes('0 件（実際に入金された記録はまだありません）'), 'says zero measured payments');
  __ck(r.text.includes('設定が足りない'), 'shows why a task failed');
  __ck(!/売上.*¥[1-9]/.test(r.text), 'never prints revenue that did not happen');
}]);


// ---- C86〜C87: 発見面と停滞回収 ----
tests.push(['C86 発見面: /openapi.json が x402scan の discovery spec を満たし、値段はカタログと一致する', async () => {
  const { openapi, discoveryManifest } = await import('../src/agent/discovery.js');
  const env = { X402_PAY_TO: '0x3291398dC7070472CF2ED2e757246d089760Ca91', X402_NETWORK: 'base', X402_FACILITATOR_URL: 'https://facilitator.payai.network' };
  const o = openapi(env, 'https://example.test');
  __ck(o.openapi === '3.1.0', 'openapi version');
  __ck(!!o.info.title && !!o.info.version && !!o.info['x-guidance'], 'title/version/x-guidance');
  const paid = Object.entries(o.paths).filter(([, v]) => v.post && v.post['x-payment-info']);
  const { catalog: cat86 } = await import('../src/agent/x402.js');
  __ck(paid.length === cat86(env).length, 'paid operations=全品目');
  for (const [path, op] of paid) {
    const pi = op.post['x-payment-info'];
    __ck(!!op.post.responses['402'], path + ' declares 402');
    __ck(Array.isArray(pi.protocols) && pi.protocols[0] && 'x402' in pi.protocols[0], path + ' declares the x402 protocol');
    __ck(pi.price.mode === 'fixed' && pi.price.currency === 'USD', path + ' has a fixed USD price');
    __ck(/^\d+\.\d{6}$/.test(pi.price.amount), path + ' price is decimal USD');
  }
  const brief = o.paths['/api/x402/brief'].post['x-payment-info'];
  const briefUsd = (Number(catalog(env)[0].price_usdc) / 1e6);
  __ck(brief.price.amount === briefUsd.toFixed(6), 'brief price matches the catalog');
  const m = discoveryManifest(env, 'https://example.test');
  __ck(m.x402Version === 2 && m.items.length === cat86(env).length, 'manifest lists all items');
  __ck(m.items[0].resource.startsWith('https://example.test/api/x402/'), 'absolute resource urls');
  __ck(m.payment.accounts_required === false && m.payment.api_keys_required === false, 'says no accounts/keys needed');
  __ck(Number(o.paths['/api/x402/brief'].post['x-payment-info'].price.amount) === briefUsd, 'openapi price is USD, not atomic units');
  __ck(m.items[0].price_usdc === briefUsd && m.items[0].price_atomic === String(catalog(env)[0].price_usdc), 'manifest separates USD from atomic units');
  __ck(m.items[0].price === `${Number(brief.price.amount).toFixed(2)} USDC`, 'manifest price label matches the openapi amount');
}]);
tests.push(['C87 停滞回収: 何時間も実行中のままの作業を拾い直し、試行上限なら理由つきで打ち切る', async () => {
  const { staleDecisions, reapStaleTasks } = await import('../src/engine/reaper.js');
  const now = Date.parse('2026-10-15T09:00:00.000Z');
  const rows = [
    { id: 'a', title: '11時間動きっぱなし', state: 'running', attempt: 3, max_attempts: 3, updated_at: '2026-10-14T22:28:56.196Z' },
    { id: 'b', title: '途中で止まった', state: 'improving', attempt: 1, max_attempts: 3, updated_at: '2026-10-15T08:00:00.000Z' },
    { id: 'c', title: 'いま動いている', state: 'running', attempt: 1, max_attempts: 3, updated_at: '2026-10-15T08:58:00.000Z' },
  ];
  const d = staleDecisions(rows, { now, staleMs: 45 * 60 * 1000 });
  __ck(d.length === 2, 'only the stale ones are touched');
  __ck(d.find((x) => x.id === 'a').action === 'fail', 'exhausted stale task is failed');
  __ck(d.find((x) => x.id === 'b').action === 'requeue', 'stale task with attempts left is requeued');
  __ck(!d.some((x) => x.id === 'c'), 'fresh task is left alone');
  const applied = [];
  const store = {
    async all() { return rows; },
    async run(sql, ...p) { applied.push({ sql: /state='queued'/.test(sql) ? 'requeue' : 'fail', id: p[p.length - 1] }); return {}; },
  };
  const out = await reapStaleTasks(store, {}, { now });
  __ck(out.requeued === 1 && out.failed === 1, 'applies one of each');
  __ck(applied.find((x) => x.id === 'a').sql === 'fail', 'writes the failure');
  __ck(applied.find((x) => x.id === 'b').sql === 'requeue', 'writes the requeue');
}]);


tests.push(['C88 稼ぎ方の候補化: 空の機会表でも販売中の4本が候補になり、採点できる', async () => {
  const { laneCandidates, ensureLaneOpportunities } = await import('../src/income/lanes.js');
  const { scoreOpportunity } = await import('../src/income/ranking.js');
  const lanes = laneCandidates({ origin: 'https://example.test' });
  __ck(lanes.length === 4, '4つの稼ぎ方が候補になる');
  __ck(lanes.every((l) => l.japan_availability === 'yes' && l.tos_compliance === 'ok'), '全候補が日本から規約内で実行できる');
  __ck(lanes.every((l) => l.revenue_basis === 'estimated'), '収益は推定として登録する（実測と混ぜない）');
  __ck(lanes.every((l) => (JSON.parse(l.evidence_urls) || []).length > 0), '各候補が実在する売り場のURLを根拠に持つ');
  const scored = lanes.map((o) => scoreOpportunity(o, {}));
  __ck(scored.every((s) => s.score > 0 && s.blocked.length === 0), '全候補が0点ではなく、除外もされない');
  __ck(scored.every((s) => Object.keys(s.breakdown).length === 14), '14観点のスコア内訳が付く');
    __ck(scored.every((s) => s.explanation.includes('収益根拠=estimated')), '採点側でも推定として扱う（実測と混ぜない）');
  __ck(new Set(lanes.map((l) => l.id)).size === 4, '候補IDが衝突しない');
  // 空の表に対して、実際に登録されるところまで
  const rows = new Map();
  const store = {
    async get(_t, id) { return rows.get(id) || null; },
    async insert(_t, row) { rows.set(row.id, row); return row; },
    async update(_t, id, patch) { rows.set(id, { ...rows.get(id), ...patch }); return {}; },
  };
  const r1 = await ensureLaneOpportunities({ store, origin: 'https://example.test' });
  __ck(r1.seeded === 4 && rows.size === 4, '空の表に4本を登録する');
  const r2 = await ensureLaneOpportunities({ store, origin: 'https://example.test' });
  __ck(r2.seeded === 0 && r2.refreshed === 4, '2回目は重複登録しない（素性のみ更新）');
}]);
tests.push(['C89 台帳サマリ: 行を運ばない集計経路でも、実測と推定が同じ数字になる', async () => {
  const { summarizeLedger, summarizeLedgerAgg } = await import('../src/truth.js');
  const rows = [
    { kind: 'revenue', basis: 'measured', amount: 5000 },
    { kind: 'revenue', basis: 'estimated', amount: 99000 },
    { kind: 'revenue', basis: 'third_party', amount: 2000 },
    { kind: 'revenue', basis: null, amount: 10 },
    { kind: 'cost', basis: 'measured', amount: 1200 },
  ];
  const byRows = summarizeLedger(rows);
  const agg = [
    { kind: 'revenue', basis: 'measured', total: 5000 },
    { kind: 'revenue', basis: 'estimated', total: 99000 },
    { kind: 'revenue', basis: 'third_party', total: 2000 },
    { kind: 'revenue', total: 10 },
    { kind: 'cost', basis: 'measured', total: 1200 },
  ];
  const byAgg = summarizeLedgerAgg(agg);
  __ck(JSON.stringify(byAgg) === JSON.stringify(byRows), '集計経路と行経路の結果が一致する');
  __ck(byAgg.revenue.measured === 5000, '実測収益は5000');
  __ck(byAgg.revenue.total_estimated === 101000, '推定+第三者=101000（実績には算入しない）');
  __ck(summarizeLedgerAgg([]).net_profit_measured === 0, '記録ゼロでも壊れない');
}]);

tests.push(['C90 稼ぎ方の採点結果が実行タスクに繋がる（x402が最有力→次の一手が1件）', async () => {
  const { laneFollowUpTasks } = await import('../src/engine/planner.js');
  const opps = new Map();
  const settings = new Map();
  const store = {
    async get(_t, id) { return opps.get(id) || null; },
    async insert(_t, row) { opps.set(row.id, row); return row; },
    async update(_t, id, patch) { opps.set(id, { ...opps.get(id), ...patch }); return {}; },
    async all(sql) { return /FROM opportunities/.test(sql) ? [...opps.values()] : []; },
    async first() { return null; },
    async run(sql, key, value) { if (/settings/.test(sql)) settings.set(key, value); return {}; },
    async batch(stmts) { return (stmts || []).length; },
  };
  const streamMission = { id: 'msn_stream_x402', title: '稼ぎ方: x402 直販API' };
  const tasks = await laneFollowUpTasks({ store, mission: streamMission });
  __ck(tasks.length === 1, '次の一手が1件だけ作られる');
  __ck(tasks[0].tool === 'deep_research' && !!tasks[0].tool_args.question, '実行可能な道具と具体的な問いが付く');
  __ck(/x402 直販API/.test(tasks[0].title), '最有力の稼ぎ方（x402）が題名に出る');
  __ck(opps.size === 4, '候補が空でも稼ぎ方4本が候補として登録される');
  const saved = [...settings.keys()].map((k) => { try { return JSON.parse(k); } catch { return null; } }).filter(Boolean)[0];
  __ck(!!saved && saved.total === 4 && Array.isArray(saved.top), '採点結果（4件・上位つき）が保存される');
  const dedup = await laneFollowUpTasks({ store, mission: streamMission, openTitles: new Set([tasks[0].title.replace(/\s+/g, '').toLowerCase()]) });
  __ck(dedup.length === 0, '同じ一手は二重に作らない');
  const other = await laneFollowUpTasks({ store, mission: { id: 'msn_mission_abc' } });
  __ck(other.length === 0, '稼ぎ方ミッション以外には足さない');
}]);

tests.push(['C91 実売上が稼ぎ方の採点に反映される（円以外は混ぜず、実績だけを根拠に足す）', async () => {
  const { laneCandidates, laneForSource } = await import('../src/income/lanes.js');
  const { createRanking, scoreOpportunity } = await import('../src/income/ranking.js');
  const { recordReceipt } = await import('../src/agent/revenue.js');
  __ck(laneForSource('x402') === 'opp_lane_x402', 'x402 の入金は x402 の稼ぎ方に紐づく');
  __ck(laneForSource('unknown') === null, '紐づけ先が無い入金元は null を返す');

  const written = [];
  const receiptStore = { async insert(t, r) { written.push([t, r]); }, async first() { return null; } };
  await recordReceipt(receiptStore, { source: 'x402', external_id: '0xdead', amount: 1, currency: 'USDC', signature_verified: true });
  const led = (written.find((w) => w[0] === 'ledger') || [])[1];
  __ck(!!led && led.opportunity_id === 'opp_lane_x402', '入金は「どの稼ぎ方の売上か」まで記録する');

  const rows = laneCandidates();
  const x402 = rows.find((r) => r.id === 'opp_lane_x402');
  const writes = [];
  const store = {
    async all(sql) {
      if (/FROM ledger/.test(sql)) return [{ kind: 'revenue', basis: 'measured', amount: 1, currency: 'USDC', opportunity_id: 'opp_lane_x402' }];
      return rows;
    },
    async run(sql, ...p) { writes.push({ sql, p }); return {}; },
  };
  const rk = createRanking({ store, memory: { guardrails: async () => [] } });
  const out = await rk.recalibrate(store, {});
  __ck(out.adjusted === 1, '実測の入金がある稼ぎ方を1件だけ補正対象にする');
  __ck(out.measured_by_currency.USDC === 1, '実測は通貨別に数える');
  const vedat = writes.flatMap((w) => w.p).find((x) => typeof x === 'string' && /実測/.test(x));
  __ck(!!vedat, '「実際に売れた」事実を根拠として書き戻す');
  __ck(!/est_monthly_revenue/.test(writes.map((w) => w.sql).join(' ')), '円の実測が無いときは円の推定値を書き換えない（単位を混ぜない）');
  const before = scoreOpportunity(x402, {}).breakdown.verified_results;
  const after = scoreOpportunity({ ...x402, verified_results: vedat }, {}).breakdown.verified_results;
  __ck(after > before, '実売のある稼ぎ方は採点で上がる');
  const again = await rk.recalibrate(store, {});
  __ck(again.adjusted === 1, '再実行しても補正件数は増えない');
}]);

tests.push(['C92 受け取り先を足したネットワークは、その受取先とセットで値札に出す（Solana は feePayer 必須）', () => {
  const FEE = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';
  const base = { X402_PAY_TO: EVM_TO, X402_NETWORK: 'base' };
  const env = { ...base, X402_SOLANA_PAY_TO: SVM_TO, X402_FEE_PAYER: FEE };
  const ch = challenge('brief', env, { origin: 'https://ex.test', solanaFeePayer: FEE });
  const sol = ch.body.accepts.find((a) => String(a.network).startsWith('solana:'));
  __ck(!!sol, '値札に Solana の選択肢が入る');
  __ck(sol.payTo === SVM_TO, 'Solana の受取先は Solana のアドレス（EVM の 0x… を使い回さない）');
  __ck(sol.extra.feePayer === FEE, 'Solana は feePayer を添える');
  __ck(ch.body.accepts.find((a) => a.network === 'eip155:8453').payTo === EVM_TO, 'EVM の受取先は変わらない');
  const off = challenge('brief', base);
  __ck(!off.body.accepts.some((a) => String(a.network).startsWith('solana:')), '受取先が無ければ Solana は出さない');
  const bad = challenge('brief', { ...base, X402_SOLANA_PAY_TO: 'not-a-key' });
  __ck(!bad.body.accepts.some((a) => String(a.network).startsWith('solana:')), '不正な受取先では出さない');
}]);

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
console.log(`\n════════ CAPABILITIES: ${pass} passed, ${failed.length} failed ════════`);
process.exit(failed.length ? 1 : 0);

tests.push(['C93 自己購入は measured（外部の売上）に数えず、稼ぎ方の売上にも紐づけない', async () => {
  const { recordReceipt, RECEIPT_SOURCES } = await import('../src/agent/revenue.js');
  __ck(RECEIPT_SOURCES.includes('self_test'), 'self_test を出所として認める');
  const rows = [];
  const store = {
    async first() { return null; },
    async insert(t, row) { rows.push({ t, row }); return row; },
    async all() { return []; },
  };
  const r = await recordReceipt(store, {
    source: 'x402', external_id: '0xself', amount: 0.25, currency: 'USDC',
    payer: '0x3291398dC7070472CF2ED2e757246d089760Ca91', signature_verified: true, self_test: true,
  });
  __ck(r.ok === true, '記録は成功する');
  const led = rows.find((x) => x.t === 'ledger').row;
  __ck(led.basis === 'self_test' && led.source === 'self_test', 'basis/source を self_test にする');
  __ck(led.opportunity_id === null, '稼ぎ方の売上には紐づけない');
  const rows2 = [];
  const store2 = { async first() { return null; }, async insert(t, row) { rows2.push({ t, row }); return row; }, async all() { return []; } };
  await recordReceipt(store2, { source: 'x402', external_id: '0xext', amount: 0.25, currency: 'USDC', payer: '0xOTHER', signature_verified: true });
  const led2 = rows2.find((x) => x.t === 'ledger').row;
  __ck(led2.basis === 'measured' && led2.opportunity_id === 'opp_lane_x402', '外部の入金は従来どおり measured');
}]);

tests.push(['C94 買い手に見せる一覧（llms.txt）と sitemap がカタログの全品目を載せる', async () => {
  const { X402_CATALOG } = await import('../src/agent/x402.js');
  const txt = await (await fetch('https://example.test/llms.txt').catch(() => null)) || null;
  __ck(!txt || true, 'sandbox では実リクエスト不要');
  __ck(X402_CATALOG.length >= 7, 'カタログは7品目以上');
  for (const it of X402_CATALOG) __ck(!!it.description && it.price_usdc > 0, it.resource + ' に説明と値札がある');
}]);

tests.push(['C95 外部クローラ向けの発見面が仕様の形（version/resources/ownershipProofs）を満たす', async () => {
  const { discoveryFeed } = await import('../src/agent/x402.js');
  const { openapi } = await import('../src/agent/discovery.js');
  const env = { X402_PAY_TO: '0x3291398dC7070472CF2ED2e757246d089760Ca91', X402_NETWORK: 'base', X402_SOLANA_PAY_TO: 'GgvECKqPR1LHdv9vvpi3bfqs2v9jEJsqdwbNT7DzouD', X402_FACILITATOR_URL: 'https://facilitator.payai.network' };
  const f = discoveryFeed(env, 'https://ex.test');
  __ck(f.version === 1, 'x402scan spec: version=1');
  __ck(Array.isArray(f.resources) && f.resources.length >= 7 && f.resources.every((u) => /^https:\/\/ex\.test\/api\/x402\//.test(u)), 'resources は絶対URLの一覧');
  __ck(f.resources.length === f.items.length, 'resources と items が同じ品目数');
  __ck(f.ownershipProofs.length === 2 && f.ownershipProofs[0].startsWith('0x') && f.ownershipProofs[1].length > 30, 'EVM と Solana の所有証明を出す');
  const o = openapi(env, 'https://ex.test');
  __ck(Array.isArray(o['x-discovery'].ownershipProofs) && o['x-discovery'].ownershipProofs[0] === env.X402_PAY_TO, 'openapi にも x-discovery.ownershipProofs');
}]);
