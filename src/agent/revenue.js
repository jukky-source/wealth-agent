// 稼ぐモードの実行レイヤ — 案件（jobs）と入金（receipts）。
//
// この二つは役割をはっきり分ける:
//   jobs    … 提案→着手→納品→請求 まで、エージェントが自分で進めてよい作業の流れ。
//   receipts … 実際にお金が動いた事実。**決済プロバイダの通知（webhook）からのみ**作る。
//
// receipts を自己申告で作れなくしてあることが重要。推定収益は永久に実測へ昇格せず、
// 「実測」は現金が実際に動いたイベントだけを指す。ここが崩れると台帳全体が嘘になる。
//
// 純益と AMR（(収益−原価)÷収益）を必ず同時に出すのも同じ理由で、収益だけを見た
// 達成判定は許さない。AI は限界費用がゼロにならないため、収益だけの達成は赤字を
// 見逃す。

import { nowIso } from '../util.js';
import { summarizeLedger } from '../truth.js';
import { laneForSource } from '../income/lanes.js';

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const yen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString('ja-JP')}`;

/** 案件の状態。エージェントが自動で進めてよいのは settled の手前まで。
 *  invoiced（請求）と settled（入金確定）の間には必ず人間の承認が入る。 */
export const JOB_STATES = ['candidate', 'proposed', 'approved', 'in_progress', 'delivered', 'invoiced', 'paid', 'settled', 'abandoned'];
export const JOB_LABEL = {
  candidate: '候補', proposed: '提案済み', approved: '着手', in_progress: '作業中', delivered: '納品済み',
  invoiced: '請求済み', paid: '入金あり', settled: '確定', abandoned: '見送り',
};
/** 自動で次へ進めてよい遷移。お金の確定（paid/settled）はここに入れない。 */
const AUTO_NEXT = { candidate: 'proposed', proposed: 'approved', approved: 'in_progress', in_progress: 'delivered', delivered: 'invoiced' };
/** 人間の承認が必要な遷移。 */
const HUMAN_ONLY = new Set(['paid', 'settled']);

/** webhook 以外から receipts を作れないようにするための許可元。 */
export const RECEIPT_SOURCES = ['stripe', 'x402', 'platform', 'bank', 'self_test'];

export async function createJob(store, { title, opportunity_id = null, platform = null, price = 0, cost_est = 0, due_on = null, thread_id = null, state = 'candidate', note = '' } = {}) {
  if (!title) return null;
  const row = {
    id: rid('job'), opportunity_id, title: String(title).slice(0, 200), platform,
    state: JOB_STATES.includes(state) ? state : 'candidate',
    price: Number(price) || 0, cost_est: Number(cost_est) || 0, cost_actual: 0,
    deliverable_ref: null, thread_id, due_on, note: String(note || '').slice(0, 300),
    created_at: nowIso(), updated_at: nowIso(),
  };
  await store.insert('jobs', row);
  return row;
}

export async function advanceJob(store, id, { to = null, note = '', deliverable_ref = null } = {}) {
  const job = await store.get('jobs', id);
  if (!job) return { ok: false, error: 'not_found' };
  const next = to || AUTO_NEXT[job.state];
  if (!next) return { ok: false, error: 'no_next_state', state: job.state };
  if (HUMAN_ONLY.has(next)) {
    return { ok: false, error: 'approval_required', state: job.state, note: '入金・確定はお金が動くので、人間の確認なしには進めません' };
  }
  if (!JOB_STATES.includes(next)) return { ok: false, error: 'bad_state', to: next };
  await store.update('jobs', id, { state: next, note: note || job.note, deliverable_ref: deliverable_ref || job.deliverable_ref, updated_at: nowIso() });
  return { ok: true, job: await store.get('jobs', id), from: job.state, to: next };
}

export function jobCard(job) {
  return {
    type: 'kpi', title: '案件',
    items: [
      { label: '状態', value: JOB_LABEL[job.state] || job.state, hl: true },
      { label: '金額', value: Number(job.price || 0), unit: '円' },
      { label: '見込み原価', value: Number(job.cost_est || 0), unit: '円' },
    ],
  };
}

/**
 * 入金の記録。**署名を確認した通知からのみ**呼ぶ。
 * 呼び出し側（webhook）が検証していない場合は verified=false になり、記録を拒否する。
 */
export async function recordReceipt(store, {
  source, external_id, amount, currency = 'USDC', fee = 0, job_id = null, thread_id = null,
  occurred_on = null, raw = null, signature_verified = false, payer = null, testnet = false,
  self_test = false,
} = {}) {
  // 自己購入（自分の財布で自分のAPIを買う動作確認）は「売上」ではない。
  // basis='measured' のまま台帳に入れると、稼ぎ方の採点と画面の実測収益が
  // 実力より高く出る（＝台帳が嘘になる）。basis='self_test' で必ず別枠にする。
  const isSelf = self_test === true;
  if (!signature_verified) return { ok: false, error: 'unverified', note: '検証済みの決済通知だけが入金として記録できます' };
  if (!RECEIPT_SOURCES.includes(String(source))) return { ok: false, error: 'bad_source', allowed: RECEIPT_SOURCES };
  const gross = Number(amount) || 0;
  // 実額の入金は 0 を認めない。テスト網（金額0）だけ例外にし、external_id に test_ を付けて
  // 本番の売上集計から必ず除外する（テストが台帳を汚さない）。
  if (!(gross > 0) && !testnet) return { ok: false, error: 'bad_amount' };
  const ext = String(external_id || '');
  if (!ext) return { ok: false, error: 'missing_external_id' };
  const finalExt = testnet && !ext.startsWith('test_') ? `test_${ext}` : ext;
  const dupe = await store.first(`SELECT id FROM receipts WHERE source=? AND external_id=?`, source, ext).catch(() => null);
  if (dupe) return { ok: false, error: 'duplicate', id: dupe.id };
  const f = Number(fee) || 0;
  const row = {
    id: rid('rcp'), source: String(source), external_id: finalExt, amount: gross, currency,
    fee: f, net_amount: gross - f, job_id, thread_id, payer,
    occurred_on: occurred_on || String(nowIso()).slice(0, 10),
    verified: 1, signature_verified: 1, raw_json: raw ? JSON.stringify(raw).slice(0, 4000) : null,
    created_at: nowIso(),
  };
  await store.insert('receipts', row);
  // 台帳（ledger）にも同じ事実を1行だけ書く。receipts は「決済事業者の通知」、
  // ledger は「現金が動いた記録」。x402 の売上が ledger に入らないと、画面の
  // 実測収益が 0 のままで、稼ぎ方の採点も売れ行きを学習できない。
  // テスト網（金額0・test_ 付き）は台帳に書かない — 台帳を汚さないため。
  if (!testnet && gross > 0) {
    await store.insert('ledger', {
      id: rid('led'), kind: 'revenue', amount: gross,
      currency: String(currency || 'USDC').toUpperCase(),
      basis: isSelf ? 'self_test' : 'measured', source: isSelf ? 'self_test' : String(source),
      opportunity_id: isSelf ? null : laneForSource(source),
      occurred_on: row.occurred_on,
      note: `${source} 入金 ${finalExt}${payer ? ` / payer ${payer}` : ''}${job_id ? ` / job ${job_id}` : ''}`,
      created_at: nowIso(),
    }).catch(() => {});
  }
  return { ok: true, receipt: row };
}

/** 収益・原価・純益・AMR を一箇所で数える。数字は必ずここから出す。 */
export async function revenueSummary(store) {
  const [ledgerRows, receiptRows, jobRows] = await Promise.all([
    store.all(`SELECT kind, amount, basis, currency FROM ledger`).catch(() => []),
    store.all(`SELECT currency, amount, fee, net_amount FROM receipts WHERE external_id NOT LIKE 'test\_%' ESCAPE '\\'`).catch(() => []),
    store.all(`SELECT state, COUNT(*) AS c, COALESCE(SUM(price),0) AS amount FROM jobs GROUP BY state`).catch(() => []),
  ]);
  const led = summarizeLedger(ledgerRows);
  // 通貨をまたいで足さない。為替レートの取得元が無いあいだ、円以外の入金は一覧には
  // 出すが純益・AMR には算入しない。混ぜると数字が意味を失い、台帳が嘘になる。
  const byCurrency = {};
  for (const r of receiptRows) {
    const cur = String(r.currency || 'JPY').toUpperCase();
    byCurrency[cur] = byCurrency[cur] || { count: 0, gross: 0, fee: 0, verified: 0 };
    byCurrency[cur].count += 1;
    byCurrency[cur].gross += Number(r.amount || 0);
    byCurrency[cur].fee += Number(r.fee || 0);
    byCurrency[cur].verified += Number(r.net_amount || 0);
  }
  const base = byCurrency.JPY || { count: 0, gross: 0, fee: 0, verified: 0 };
  const unconverted = Object.keys(byCurrency).filter((c) => c !== 'JPY')
    .map((c) => ({ currency: c, count: byCurrency[c].count, verified: byCurrency[c].verified }));
  const gross = base.gross;
  const fee = base.fee;
  const verified = base.verified;
  const cost = Number(led.cost.measured || 0) + fee;
  const net = verified - cost;
  const amr = verified > 0 ? Math.round((net / verified) * 1000) / 10 : null;
  const jobs = {};
  for (const r of jobRows) jobs[r.state] = { count: Number(r.c || 0), amount: Number(r.amount || 0) };
  const open = jobRows.filter((r) => !['settled', 'abandoned'].includes(r.state))
    .reduce((a, r) => a + Number(r.c || 0), 0);
  return {
    receipts: { count: receiptRows.length, count_jpy: base.count, gross, fee, verified, by_currency: byCurrency, unconverted },
    cost, net, amr,
    measured_revenue: Number(led.revenue.measured || 0),
    measured_by_currency: led.revenue.measured_by_currency || {},
    estimated_revenue: Number(led.revenue.total_estimated || 0),
    jobs, open_jobs: open,
    basis: 'receipts は決済プロバイダの検証済み通知のみ。ledger の推定は純益に算入しません。',
  };
}

export function revenueCard(r) {
  return {
    type: 'kpi', title: '入金済みの収支（決済通知で確認した分だけ）',
    items: [
      { label: '入金済み（純額）', value: r.receipts.verified, unit: '円', hl: true },
      { label: '手数料', value: r.receipts.fee, unit: '円' },
      { label: '原価', value: r.cost, unit: '円' },
      { label: '純益', value: r.net, unit: '円' },
      { label: 'AMR（粗利率）', value: r.amr == null ? '—' : r.amr, unit: '%' },
    ],
  };
}

export function revenueLine(r) {
  const amr = r.amr == null ? '入金がまだ無いので計算できません' : `${r.amr}%（(入金${r.receipts.verified} − 原価${r.cost}) ÷ 入金${r.receipts.verified}）`;
  const other = (r.receipts.unconverted || []).length
    ? `／円以外の入金も一覧にあります（${r.receipts.unconverted.map((u) => `${u.currency} ${u.verified}（${u.count}件）`).join('・')}）。レートの取得元が無いので円換算せず、純益とAMRには混ぜていません。`
    : '';
  return `入金済み ${yen(r.receipts.verified)}（${r.receipts.count_jpy}件）・原価 ${yen(r.cost)}・純益 ${yen(r.net)}・AMR ${amr}。動いている案件は ${r.open_jobs} 件です。${other}`;
}

/** 「案件: タイトル 5000円」のような登録を読む。 */
export function parseJobRequest(text) {
  const s = String(text || '');
  const m = s.match(/案件[：:]\s*(.+?)(?:\s*[、,]?\s*(\d[\d,]*(?:\.\d+)?)\s*(万)?\s*円)?\s*$/);
  if (!m) return null;
  const title = String(m[1] || '').trim();
  if (!title) return null;
  let price = 0;
  if (m[2]) { const n = Number(m[2].replace(/[^\d.]/g, '')); price = m[3] ? Math.round(n * 10000) : Math.round(n); }
  const platform = (s.match(/(クラウドワークス|ランサーズ|ココナラ|Fiverr|Upwork|X|note|メルカリ|KDP|YouTube|GitHub)/i) || [])[1] || null;
  return { title, price, platform };
}

/** 案件一覧の1行ずつの表示用。 */
export function jobListItems(rows) {
  return rows.map((j) => ({
    title: j.title, sub: `${JOB_LABEL[j.state] || j.state} · ${yen(j.price)}${j.platform ? ` · ${j.platform}` : ''}`,
    badge: JOB_LABEL[j.state] || j.state,
    tone: j.state === 'settled' ? 'ok' : j.state === 'abandoned' ? 'danger' : 'accent',
  }));
}

export const __test = { yen };
