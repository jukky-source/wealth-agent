// kpi.js — 収益の計器（kpi-1.0）。
//
// 原則（このファイルの存在理由）:
//   売上は「外部の買い手が実際に決済した事実」だけを数える。自分のテスト購入・内部リクエスト・
//   クローラー・未決済リクエストは売上ではない。出典は receipts（署名検証つきの決済の事実）と
//   ledger（revenue|cost）に限る。x402_hits のような到達カウンタは需要の計器であって売上ではない。
//
// もう一つの原則: 測れない値は推定で埋めない。'未測定' と、どうすれば測れるかを必ず返す。
//   捏造した数字は、無い数字より悪い（判断を誤らせる）。
export const KPI_VERSION = 'kpi-1.0';
export const UNMEASURED = '未測定';

const sum = (rows, k) => (Array.isArray(rows) ? rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) : null);
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
    counts_as_revenue: '外部の買い手が決済した行のみ（自己的購入・内部・クローラ・未決済は除外）',
    revenue: {}, costs: {}, demand: {}, efficiency: {}, unmeasured: [],
  };

  // ---- 売上（外部の決済の事実）
  const recWin = await qa(store, 'SELECT source, COUNT(*) AS n, SUM(amount) AS amount, SUM(COALESCE(fee,0)) AS fee, SUM(COALESCE(net_amount,0)) AS net, COUNT(DISTINCT payer) AS payers FROM receipts WHERE occurred_on >= ? GROUP BY source', since);
  const recAll = await q1(store, 'SELECT COUNT(*) AS n, SUM(amount) AS amount, SUM(COALESCE(fee,0)) AS fee, COUNT(DISTINCT payer) AS payers, MIN(occurred_on) AS first_on, MAX(occurred_on) AS last_on FROM receipts');
  const measured = recAll !== null;
  out.revenue = {
    all_time: measured ? {
      transactions: num(recAll.n) || 0,
      total: num(recAll.amount) || 0,
      fees: num(recAll.fee) || 0,
      unique_payers: num(recAll.payers) || 0,
      first_paid_on: recAll.first_on || null, last_paid_on: recAll.last_on || null,
    } : { total: UNMEASURED, why: 'receipts を読めませんでした（DB 未接続 or テーブル未作成）' },
    window: recWin !== null ? {
      transactions: sum(recWin, 'n'),
      total: sum(recWin, 'amount'),
      fees: sum(recWin, 'fee'),
      net: sum(recWin, 'net'),
      unique_payers: recWin.reduce((a, r) => a + (Number(r.payers) || 0), 0),
      by_source: recWin.map((r) => ({ source: r.source, transactions: Number(r.n) || 0, amount: Number(r.amount) || 0 })),
    } : { total: UNMEASURED, why: 'receipts を読めませんでした（DB 未接続 or テーブル未作成）' },
  };
  // 商品別の売上（資源名＝source）
  out.revenue.by_product = recWin !== null
    ? recWin.map((r) => ({ product: r.source, transactions: Number(r.n) || 0, amount_usdc: Number(r.amount) || 0 }))
    : UNMEASURED;

  // ---- リピート（同じ payer が2回以上）
  const rep = await q1(store, 'SELECT COUNT(*) AS repeat_payers FROM (SELECT payer FROM receipts WHERE payer IS NOT NULL GROUP BY payer HAVING COUNT(*) >= 2)');
  out.revenue.repeat_payers = rep !== null ? (num(rep.repeat_payers) || 0) : UNMEASURED;

  // ---- 決済の明細（txid は external_id）
  const tx = await qa(store, 'SELECT occurred_on, source, amount, currency, payer, external_id, COALESCE(fee,0) AS fee FROM receipts ORDER BY occurred_on DESC LIMIT 20');
  out.revenue.recent_payments = tx !== null
    ? tx.map((r) => ({ on: r.occurred_on, product: r.source, amount: Number(r.amount) || 0, currency: r.currency || 'USDC', payer: r.payer || null, tx_id: r.external_id || null, fee: Number(r.fee) || 0 }))
    : UNMEASURED;

  // ---- コストと純利益（手数料・原価）
  const cost = await qa(store, "SELECT source, SUM(amount) AS amount FROM ledger WHERE kind='cost' AND occurred_on >= ? GROUP BY source", since);
  const fees = out.revenue.all_time && num(out.revenue.all_time.fees) != null ? num(out.revenue.all_time.fees) : 0;
  const gross = out.revenue.all_time && num(out.revenue.all_time.total) != null ? num(out.revenue.all_time.total) : null;
  const hardCost = cost !== null ? sum(cost, 'amount') : null;
  out.costs = {
    payment_fees_all_time: fees,
    other_costs_window: hardCost === null ? UNMEASURED : hardCost,
    by_source: cost === null ? UNMEASURED : cost.map((r) => ({ source: r.source, amount: Number(r.amount) || 0 })),
    note: 'x402 の決済は買い手が gas と送金を負担し、こちらは受領のみなので原価は 0（登録ガス代のみ例外）。',
  };
  out.net_profit = (gross == null || hardCost === null) ? UNMEASURED : Number((gross - fees - hardCost).toFixed(6));

  // ---- 需要の計器（売上ではない。無料枠の利用数）
  const free = await qa(store, "SELECT key, value FROM settings WHERE key LIKE 'freehits:%'");
  out.demand = {
    free_samples_used: free === null ? UNMEASURED : free.map((r) => ({ day: String(r.key).replace('freehits:', ''), uses: Number(r.value) || 0 })),
    free_samples_total: free === null ? UNMEASURED : free.reduce((a, r) => a + (Number(r.value) || 0), 0),
    note: '無料枠はモデルを使わない決定的品目のみ。売上には計上しない（需要の計器）。',
  };

  // ---- 効率（AI 利用量・実行）
  const ai = await q1(store, 'SELECT COUNT(*) AS calls, SUM(COALESCE(neurons,0)) AS neurons FROM ai_usage WHERE day >= ?', since);
  out.efficiency = {
    ai_calls_window: ai ? (num(ai.calls) || 0) : UNMEASURED,
    ai_neurons_window: ai ? (num(ai.neurons) || 0) : UNMEASURED,
    ai_daily_call_budget: 'AI_DAILY_CALL_BUDGET（既定300）で上限。超過時は budgetGuard が推論を止める。',
  };

  // ---- 測れないもの（正直に列挙し、測り方を書く）
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
  L.push('■ 売上（外部の決済のみ）');
  if (at && typeof at.total === 'number') {
    L.push(`  累計: ${at.total} / ${at.transactions}件 / 買い手 ${at.unique_payers}人 / 手数料 ${at.fees}`);
    L.push(`  初回 ${at.first_paid_on || '-'} → 直近 ${at.last_paid_on || '-'}`);
  } else L.push(`  累計: ${UNMEASURED}`);
  L.push(`  純利益: ${k.net_profit === UNMEASURED ? UNMEASURED : k.net_profit}`);
  L.push('');
  L.push(`■ 測れていないもの（${k.unmeasured.length}件）`);
  for (const u of k.unmeasured) L.push(`  - ${u.name}: ${u.how_to_measure}`);
  return L.join('\n');
}
