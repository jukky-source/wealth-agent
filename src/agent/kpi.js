// kpi.js — 収益の計器（kpi-1.1）。
//
// 原則（このファイルの存在理由）:
//   売上は「外部の買い手が実際に決済した事実」だけを数える。自分のテスト購入・内部リクエスト・
//   クローラー・未決済リクエストは売上ではない。出典は receipts（署名検証つきの決済の事実）と
//   ledger（revenue|cost）に限る。x402_hits のような到達カウンタは需要の計器であって売上ではない。
//
// kpi-1.1 の修正（実測で見つかった自分の誤り）:
//   1.0 は receipts をそのまま合計し、**自己テスト購入（$7.182 / 25件）を売上に混ぜていた**。
//   ユーザーが明示的に禁じた数え方であり、実装が規律に違反していた。
//   自己テストは source='self_test' の行と、既知の自己テスト wallet からの行で除外する。
//   外部と自己テストは必ず分けて出し、混ぜた数字を返さない。
//
// もう一つの原則: 測れない値は推定で埋めない。'未測定' と、どうすれば測れるかを必ず返す。
export const KPI_VERSION = 'kpi-1.1';
export const UNMEASURED = '未測定';

/** 自己テスト（外部の買い手ではない）と判定する wallet。実測で特定した自前のテスト wallet。 */
export const SELF_TEST_PAYERS = ['0x7f06190a3bb8ff63587dc6469f25c6078e648009'];
/** 自己テストと分かっている source。 */
export const SELF_TEST_SOURCES = ['self_test', 'selftest', 'self-test'];

/** この決済行は外部の買い手によるものか。false なら売上に数えない。 */
export function isSelfTest(row = {}) {
  const src = String(row.source || '').trim().toLowerCase();
  if (SELF_TEST_SOURCES.includes(src) || src.includes('self_test') || src.includes('selftest')) return true;
  const payer = String(row.payer || '').trim().toLowerCase();
  if (payer && SELF_TEST_PAYERS.includes(payer)) return true;
  return false;
}

/** 行を外部 / 自己テストに分ける（唯一の分割点。ここを通さない集計をしない）。 */
export function splitReceipts(rows = []) {
  const external = []; const selfTest = [];
  for (const r of rows || []) (isSelfTest(r) ? selfTest : external).push(r);
  return { external, selfTest };
}

const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

async function qa(store, sql, ...args) {
  if (!store || typeof store.all !== 'function') return null;
  try { return await store.all(sql, ...args); } catch { return null; }
}
async function q1(store, sql, ...args) {
  if (!store || typeof store.first !== 'function') return null;
  try { return await store.first(sql, ...args); } catch { return null; }
}

/** 未測定の指標に「どうすれば測れるか」を必ず添える。 */
const gap = (name, how_to_measure, why = null) => ({ name, status: UNMEASURED, how_to_measure, why });

export async function kpiReport(store, { days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);
  const out = {
    ok: true, version: KPI_VERSION, at: now.toISOString(),
    window: { days, since },
    source_of_truth: 'receipts（決済の事実）+ ledger（revenue/cost）。到達カウンタは売上ではない。',
    counts_as_revenue: '外部の買い手が決済した行のみ。自己テスト購入（source=self_test / 既知の自己テスト wallet）・内部リクエスト・クローラ・未決済は除外。',
    self_test_excluded_payers: SELF_TEST_PAYERS,
    revenue: {}, costs: {}, demand: {}, efficiency: {}, unmeasured: [],
  };

  const rows = await qa(store, 'SELECT occurred_on, source, amount, currency, fee, net_amount, payer, external_id FROM receipts ORDER BY occurred_on DESC');
  const measured = rows !== null;
  const { external, selfTest } = splitReceipts(rows || []);
  const win = external.filter((r) => String(r.occurred_on || '') >= since);

  const agg = (list) => ({
    transactions: list.length,
    total: Number(sum(list, 'amount').toFixed(6)),
    fees: Number(sum(list, 'fee').toFixed(6)),
    unique_payers: new Set(list.map((r) => r.payer).filter(Boolean)).size,
    first_paid_on: list.map((r) => r.occurred_on).filter(Boolean).sort()[0] || null,
    last_paid_on: list.map((r) => r.occurred_on).filter(Boolean).sort().slice(-1)[0] || null,
  });
  const repeatOf = (list) => {
    const c = {}; for (const r of list) if (r.payer) c[r.payer] = (c[r.payer] || 0) + 1;
    return Object.values(c).filter((n) => n >= 2).length;
  };

  out.revenue = measured ? {
    all_time: agg(external),
    window: Object.assign(agg(win), { by_source: Object.entries(win.reduce((a, r) => { a[r.source] = (a[r.source] || 0) + (Number(r.amount) || 0); return a; }, {})).map(([s, a]) => ({ source: s, amount: Number(a.toFixed(6)) })) }),
    by_product: Object.entries(external.reduce((a, r) => { const k = r.source || 'unknown'; a[k] = a[k] || { n: 0, amt: 0 }; a[k].n++; a[k].amt += Number(r.amount) || 0; return a; }, {})).map(([k, v]) => ({ product: k, transactions: v.n, amount_usdc: Number(v.amt.toFixed(6)) })),
    repeat_payers: repeatOf(external),
    recent_payments: external.slice(0, 20).map((r) => ({ on: r.occurred_on, product: r.source, amount: Number(r.amount) || 0, currency: r.currency || 'USDC', payer: r.payer || null, tx_id: r.external_id || null, fee: Number(r.fee) || 0 })),
    self_test: Object.assign(agg(selfTest), { note: '売上に数えない（我々自身のテスト購入）。ここに分離して出す。' }),
  } : { all_time: { total: UNMEASURED, why: 'receipts を読めませんでした（DB 未接続 or テーブル未作成）' }, window: { total: UNMEASURED }, by_product: UNMEASURED, recent_payments: UNMEASURED };

  // 台帳（basis）との突き合わせ。独立した2経路が一致しなければ、どちらかが間違っている。
  const led = await q1(store, "SELECT SUM(CASE WHEN basis='self_test' THEN 1 ELSE 0 END) AS st_n, SUM(CASE WHEN basis='self_test' THEN amount ELSE 0 END) AS st_amt, SUM(CASE WHEN basis<>'self_test' THEN 1 ELSE 0 END) AS ex_n, SUM(CASE WHEN basis<>'self_test' THEN amount ELSE 0 END) AS ex_amt FROM ledger WHERE kind='revenue'");
  out.cross_check = led ? {
    ledger_external: { transactions: num(led.ex_n) || 0, total: Number((num(led.ex_amt) || 0).toFixed(6)) },
    ledger_self_test: { transactions: num(led.st_n) || 0, total: Number((num(led.st_amt) || 0).toFixed(6)) },
    agree: measured ? ((num(led.ex_amt) || 0) === (out.revenue.all_time.total || 0)) : UNMEASURED,
    note: 'receipts と ledger の外部合計が一致すれば二重の裏取り。食い違ったら receipts を正としつつ原因を調べる。',
  } : UNMEASURED;

  const fees = (measured && out.revenue.all_time.fees) || 0;
  const gross = measured ? out.revenue.all_time.total : null;
  const cost = await qa(store, "SELECT source, SUM(amount) AS amount FROM ledger WHERE kind='cost' AND occurred_on >= ? GROUP BY source", since);
  const hardCost = cost !== null ? Number(sum(cost, 'amount').toFixed(6)) : null;
  out.costs = {
    payment_fees_all_time: fees,
    other_costs_window: hardCost === null ? UNMEASURED : hardCost,
    by_source: cost === null ? UNMEASURED : cost.map((r) => ({ source: r.source, amount: Number(r.amount) || 0 })),
    note: 'x402 の決済は買い手が gas と送金を負担し、こちらは受領のみなので原価は 0（登録ガス代のみ例外）。',
  };
  out.net_profit = (gross == null || hardCost === null) ? UNMEASURED : Number((gross - fees - hardCost).toFixed(6));

  const free = await qa(store, "SELECT key, value FROM settings WHERE key LIKE 'freehits:%'");
  out.demand = {
    free_samples_used: free === null ? UNMEASURED : free.map((r) => ({ day: String(r.key).replace('freehits:', ''), uses: Number(r.value) || 0 })),
    free_samples_total: free === null ? UNMEASURED : free.reduce((a, r) => a + (Number(r.value) || 0), 0),
    note: '無料枠はモデルを使わない決定的品目のみ。売上には計上しない（需要の計器）。',
  };

  const ai = await q1(store, 'SELECT COUNT(*) AS calls, SUM(COALESCE(neurons,0)) AS neurons FROM ai_usage WHERE day >= ?', since);
  out.efficiency = {
    ai_calls_window: ai ? (num(ai.calls) || 0) : UNMEASURED,
    ai_neurons_window: ai ? (num(ai.neurons) || 0) : UNMEASURED,
    ai_daily_call_budget: 'AI_DAILY_CALL_BUDGET（既定300）で上限。超過時は budgetGuard が推論を止める。',
  };

  out.unmeasured = [
    gap('外部からの商品発見数', 'CDP Bazaar / agentic.market / Agent402 の discovery を日次で検索し、自ホストのヒット数を記録する'),
    gap('外部からの適格な訪問数', 'Cloudflare Analytics（GraphQL）で /api/x402/* と /api/free/* のユニーク訪問を日次で取得する（未接続）'),
    gap('有料購入の開始数（402 challenge の提示数）', '402 を返した回数を資源別に settings へ加算する（未実装）'),
    gap('販路別の売上', '決済の source に販路IDを載せる（例: x402:<venue>:<resource>）。現状の receipts.source は資源名のみ'),
    gap('施策ごとの実行コストと成果', 'grow の各レバー実行時に before/after の売上・発見数を runs に記録する（未実装）'),
    gap('人手待ちの工程数', 'approvals と venues の human_queue を数える（/api/venues/public と /api/approvals で参照可能）'),
  ];
  if (!measured) out.unmeasured.unshift(gap('売上（全体）', 'receipts テーブルを読める状態にする（D1 接続の確認）', 'DB を読めませんでした'));

  return out;
}

/** 人が読む1画面。数字は kpiReport と同じ出典で、未測定はそのまま出す。 */
export function kpiText(k) {
  const L = [];
  const at = k.revenue && k.revenue.all_time;
  L.push(`Wealth Agent KPI (${k.version}) ${k.at}`);
  L.push(`窓: 直近${k.window.days}日（${k.window.since} 以降）`);
  L.push('');
  L.push('■ 売上（外部の買い手の決済のみ）');
  if (at && typeof at.total === 'number') {
    L.push(`  累計: ${at.total} / ${at.transactions}件 / 買い手 ${at.unique_payers}人 / 手数料 ${at.fees}`);
    L.push(`  初回 ${at.first_paid_on || '-'} → 直近 ${at.last_paid_on || '-'}`);
  } else L.push(`  累計: ${UNMEASURED}`);
  const st = k.revenue && k.revenue.self_test;
  if (st) L.push(`  自己テスト（売上に数えない）: ${st.total} / ${st.transactions}件`);
  L.push(`  純利益: ${k.net_profit === UNMEASURED ? UNMEASURED : k.net_profit}`);
  L.push('');
  L.push(`■ 測れていないもの（${k.unmeasured.length}件）`);
  for (const u of k.unmeasured) L.push(`  - ${u.name}: ${u.how_to_measure}`);
  return L.join('\n');
}
