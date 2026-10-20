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
import { parseSource } from './attribution.js';

export const KPI_VERSION = 'kpi-1.2';
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

/** 決済行の source タグ（x402:<venue>:<resource>）から販路別・商品別に分ける。 */
function byTag(rows, kind) {
  const m = new Map();
  for (const r of rows) {
    const t = parseSource(r.source);
    const key = kind === 'venue' ? (t.venue || 'unknown') : (t.resource || t.channel || 'unknown');
    const cur = m.get(key) || { key, transactions: 0, amount_usdc: 0 };
    cur.transactions += 1; cur.amount_usdc += Number(r.amount) || 0;
    m.set(key, cur);
  }
  return [...m.values()].map((x) => ({ ...x, amount_usdc: Number(x.amount_usdc.toFixed(6)) }));
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
    by_venue: byTag(external, 'venue'),
    by_resource: byTag(external, 'resource'),
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

  // 発見 → 値札(402)の提示 → 決済 のどこで落ちるかを数える。需要の計器であって売上ではない。
  // 自分の呼び出し（UA=wealthagent）と自己テストは除く。
  // クローラー・観測所・bazaar の巡回は「買い手」ではない。sales.js と同じ除外基準を使う
  // （UA 文字列ベースなので過小評価はあっても過大評価はしない向きに倒す）。
  const EXCL = "COALESCE(note,'') <> 'self_test' AND instr(lower(COALESCE(ua,'')),'wealthagent') = 0"
    + " AND instr(lower(COALESCE(ua,'')),'bot') = 0 AND instr(lower(COALESCE(ua,'')),'crawler') = 0"
    + " AND instr(lower(COALESCE(ua,'')),'observer') = 0 AND instr(lower(COALESCE(ua,'')),'probe') = 0"
    + " AND instr(lower(COALESCE(ua,'')),'bazaar') = 0 AND instr(lower(COALESCE(ua,'')),'python-requests') = 0"
    + " AND instr(lower(COALESCE(ua,'')),'curl') = 0 AND instr(lower(COALESCE(ua,'')),'wget') = 0";
  const hk = await qa(store, `SELECT kind, COUNT(*) AS n, COUNT(DISTINCT caller) AS callers FROM x402_hits WHERE ${EXCL} GROUP BY kind`);
  const hfree = await qa(store, `SELECT resource, COUNT(*) AS n, COUNT(DISTINCT caller) AS callers FROM x402_hits WHERE ${EXCL} AND kind='free' GROUP BY resource ORDER BY n DESC LIMIT 12`);
  const hres = await qa(store, `SELECT resource, COUNT(*) AS n, SUM(CASE WHEN CAST(status AS TEXT)='402' THEN 1 ELSE 0 END) AS quotes FROM x402_hits WHERE ${EXCL} GROUP BY resource ORDER BY n DESC LIMIT 20`);
  const hven = await qa(store, `SELECT venue, COUNT(*) AS n FROM x402_hits WHERE ${EXCL} AND COALESCE(venue,'') <> '' GROUP BY venue ORDER BY n DESC LIMIT 20`);
  const kindN = (k) => { const r = (hk || []).find((x) => String(x.kind) === k); return r ? (num(r.n) || 0) : 0; };
  out.funnel = hk === null ? UNMEASURED : {
    source: 'x402_hits（到達の計器。売上には数えない）',
    challenge_402: kindN('challenge'),
    free_samples: kindN('free'),
    rejected: kindN('rejected'),
    paid: kindN('paid'),
    free_to_paid: (kindN('paid') + kindN('rejected')) > 0 && kindN('free') > 0
      ? { paid_or_tried_paid: kindN('paid') + kindN('rejected'), free_samples: kindN('free'), note: '無料体験（kind=free）から有料へ動いた数。転換の下限（denominator は無料体験全体ではない）。' }
      : null,
    unique_callers: (hk || []).reduce((a, x) => a + (num(x.callers) || 0), 0),
    by_resource: hres === null ? UNMEASURED : (hres || []).map((x) => ({ resource: x.resource, hits: num(x.n) || 0, quotes_402: num(x.quotes) || 0 })),
    by_venue: hven === null ? UNMEASURED : (hven || []).map((x) => ({ venue: x.venue, hits: num(x.n) || 0 })),
    by_free_resource: hfree === null ? UNMEASURED : (hfree || []).map((x) => ({ resource: x.resource, uses: num(x.n) || 0, callers: num(x.callers) || 0 })),
    note: '外部の買い手が値札を見た数。ここが 0 なら、商品ではなく発見（売り場に人が来ない）の問題。',
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
    gap('買い手側ディレクトリへの実掲載数', '/api/discwatch が CDP 審査（validate・鍵不要）と index.active を日次で記録済み。スナップショットは /api/discwatch/public'),
    gap('検索結果での順位', '/api/discwatch が discovery/search に一般語で問い合わせ、順位を日次記録済み（順位は直近30日の実利用で6時間ごとに再計算される）'),
    gap('有料経路の end-to-end 実決済', '実資金で $1 の diligence-pack を1件購入し、指定どおりの納品が返ることを確かめる（承認が必要）'),
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
