// 活動報告 — 「いま何をしているか」を、タスク・台帳・売り物から実測して組み立てる。
// 数字は必ず store から読み直す。記憶や推定を「実測」として書かない。
// チャット（commands.js の report コマンド）と API（GET /api/report）が同じものを使う。

import { setting, setSetting } from '../db.js';
import { catalog as x402Catalog, x402Enabled } from './x402.js';

const yen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString('ja-JP')}`;
const num = (n) => Number(n) || 0;
const pad = (n) => String(n).padStart(2, '0');

export function jst(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const t = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

export function ago(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

export function elapsed(fromIso, toMs = Date.now()) {
  const t = new Date(fromIso).getTime();
  if (!isFinite(t)) return null;
  const s = Math.max(0, Math.floor((toMs - t) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}時間${m}分` : `${m}分`;
}

function lastError(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    const e = Array.isArray(a) ? a[a.length - 1] : null;
    return e ? String(e.diagnosis || e.error || '').slice(0, 160) : null;
  } catch { return null; }
}

const RUNNING_STATES = ['running', 'planning', 'testing', 'verifying', 'improving'];

/** DB から「いま何が起きているか」を実測で集める。失敗した枝は空配列で返し、報告自体は落とさない。 */
export async function collectFacts(store, env = {}) {
  const q = (sql, ...p) => Promise.resolve().then(() => store.all(sql, ...p)).then((r) => (Array.isArray(r) ? r : [])).catch(() => []);
  const one = (sql, ...p) => Promise.resolve().then(() => store.first(sql, ...p)).catch(() => null);

  const lastAt = await one('SELECT value FROM settings WHERE key=?', 'last_report_at').catch(() => null);
  let since = null;
  if (lastAt && lastAt.value != null) { try { since = JSON.parse(String(lastAt.value)); } catch { since = String(lastAt.value); } }

  const [byState, running, queued, done, failed, waiting, missions, approvals, ledgerRows, receiptRows, jobs, jobStates] = await Promise.all([
    q(`SELECT state, COUNT(*) AS c FROM tasks GROUP BY state`),
    q(`SELECT id, title, category, state, attempt, max_attempts, next_action, updated_at, started_at FROM tasks WHERE state IN ('running','planning','testing','verifying','improving') ORDER BY updated_at DESC LIMIT 8`),
    q(`SELECT id, title, category, state, priority, attempt, next_action, created_at FROM tasks WHERE state='queued' ORDER BY priority DESC LIMIT 8`),
    q(`SELECT id, title, category, state, finished_at FROM tasks WHERE state='completed' ORDER BY finished_at DESC LIMIT 8`),
    q(`SELECT id, title, category, state, attempt, max_attempts, error_history, updated_at FROM tasks WHERE state='failed' ORDER BY updated_at DESC LIMIT 5`),
    q(`SELECT id, title, state, next_action, updated_at FROM tasks WHERE state IN ('waiting_for_approval','waiting_for_quota','waiting_for_user') ORDER BY updated_at DESC LIMIT 8`),
    q(`SELECT id, title, goal, status, progress, metric_unit, target_value, success_metric FROM missions WHERE status='active' ORDER BY priority DESC LIMIT 3`),
    q(`SELECT id, action, payload, note, requested_at FROM approvals WHERE status='pending' ORDER BY requested_at DESC LIMIT 10`),
    q(`SELECT kind, amount, basis, occurred_on FROM ledger ORDER BY occurred_on DESC LIMIT 200`),
    q(`SELECT currency, amount, fee, net_amount, external_id, created_at FROM receipts ORDER BY created_at DESC LIMIT 200`),
    q(`SELECT id, title, state, price, updated_at FROM jobs WHERE state NOT IN ('settled','abandoned') ORDER BY updated_at DESC LIMIT 10`),
    q(`SELECT state, COUNT(*) AS c, COALESCE(SUM(price),0) AS amount FROM jobs GROUP BY state`),
  ]);

  const c = (s) => num(byState.find((r) => r.state === s)?.c);
  const counts = {
    running: RUNNING_STATES.reduce((a, s) => a + c(s), 0),
    queued: c('queued'), completed: c('completed'), failed: c('failed'),
    waiting: c('waiting_for_approval') + c('waiting_for_quota') + c('waiting_for_user'),
  };

  // 決済レジストリは本番だけを実測に数える（testnet の検証行は external_id に test_ が付く）。
  const prodReceipts = receiptRows.filter((r) => !String(r.external_id || '').startsWith('test_'));
  const byCurrency = {};
  for (const r of prodReceipts) { const cur = r.currency || 'USDC'; byCurrency[cur] = (byCurrency[cur] || 0) + num(r.net_amount ?? r.amount); }

  let doneSince = null, receivedSince = null;
  if (since) {
    const [ds, rs] = await Promise.all([
      q(`SELECT COUNT(*) AS c FROM tasks WHERE state='completed' AND finished_at > ?`, since),
      q(`SELECT external_id, net_amount, amount, currency, created_at FROM receipts WHERE created_at > ?`, since),
    ]);
    doneSince = num(ds[0]?.c);
    const prodSince = rs.filter((r) => !String(r.external_id || '').startsWith('test_'));
    receivedSince = { count: prodSince.length, test: rs.length - prodSince.length };
  }

  let sales = [];
  try {
    sales = x402Catalog(env).map((it) => ({
      resource: it.resource, description: it.label_ja || it.description, price_label: it.price_label, price_usdc: it.price_usdc,
      networks: it.networks, sellable: it.sellable, blocked_reason: it.blocked_reason, pay_to: it.pay_to,
    }));
  } catch { sales = []; }

  return {
    generated_at: new Date().toISOString(),
    last_report_at: since,
    counts, running, queued, completed: done, failed, waiting, missions, approvals,
    ledger: { rows: ledgerRows.length, recent: ledgerRows.slice(0, 5) },
    receipts: { count: prodReceipts.length, test_count: receiptRows.length - prodReceipts.length, by_currency: byCurrency, recent: prodReceipts.slice(0, 5) },
    jobs: { open: jobs, by_state: jobStates },
    delta: since ? { since, completed: doneSince, received: receivedSince } : null,
    sales,
    sellable: (() => { try { return x402Enabled(env); } catch { return false; } })(),
    failures: failed.map((t) => ({ id: t.id, title: t.title, attempt: t.attempt, max_attempts: t.max_attempts, why: lastError(t.error_history), at: t.updated_at })),
  };
}

/** 外から見た状態（未払い402・Bazaar 掲載）を実測する。落ちても報告本体は返す。 */
export async function liveChecks(env = {}, origin = null, timeoutMs = 6000) {
  const out = { checked_at: new Date().toISOString(), origin: origin || null, unpaid_402: null, bazaar: null, errors: [] };
  const base = String(env.X402_FACILITATOR_URL || 'https://facilitator.payai.network').replace(/\/+$/, '');
  const payTo = env.X402_PAY_TO || null;
  const sig = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  if (origin) {
    try {
      const r = await fetch(`${origin}/api/x402/brief`, { method: 'HEAD', signal: sig() });
      out.unpaid_402 = { status: r.status, expected: 402, ok: r.status === 402 };
    } catch (e) { out.errors.push(`unpaid_402: ${String((e && e.message) || e).slice(0, 140)}`); }
  }
  try {
    const u = new URL(`${base}/discovery/resources`);
    u.searchParams.set('limit', '100');
    if (payTo) u.searchParams.set('payTo', payTo);
    const r = await fetch(u.toString(), { signal: sig() });
    const j = await r.json().catch(() => null);
    const items = (j && Array.isArray(j.items) ? j.items : []).map((x) => x && x.resource).filter(Boolean);
    out.bazaar = {
      status: r.status, total: j?.pagination?.total ?? items.length, resources: items.slice(0, 20),
      production_urls: items.filter((x) => x.includes('/api/x402/')).length,
    };
  } catch (e) { out.errors.push(`bazaar: ${String((e && e.message) || e).slice(0, 140)}`); }
  return out;
}

/** 集めた事実を、人に読める具体的な報告に組み立てる（ここは DB を触らない）。 */
export function renderReport(facts, { env = {} } = {}) {
  const now = Date.now();
  const generated = facts.generated_at || new Date().toISOString();
  const counts = facts.counts || { running: 0, queued: 0, completed: 0, failed: 0, waiting: 0 };
  const eng = facts.engine || null;
  const running = facts.running || [];
  const queued = facts.queued || [];
  const completed = facts.completed || [];
  const failures = facts.failures || [];
  const approvals = facts.approvals || [];
  const waiting = facts.waiting || [];
  const missions = facts.missions || [];
  const sales = facts.sales || [];
  const money = facts.receipts || { count: 0, by_currency: {}, test_count: 0 };
  const jobs = facts.jobs || { open: [], by_state: [] };

  const engineLabel = eng?.status === 'running' ? '稼働中' : eng?.status === 'paused' ? '一時停止中' : eng?.status ? `状態 ${eng.status}` : 'エンジンの状態は取得できていません';
  const lastDone = completed[0] || null;
  const blockers = approvals.length + counts.waiting;
  const missionLine = missions[0]
    ? `目標「${missions[0].title}」（進捗 ${missions[0].progress != null ? Math.round(num(missions[0].progress)) : 0}%${missions[0].metric_unit ? ` / 単位 ${missions[0].metric_unit}` : ''}）`
    : '進行中の目標はまだありません';

  const headline = `${engineLabel}。実行中 ${counts.running} 件・待ち ${counts.queued} 件・あなたの判断待ち ${blockers} 件。${lastDone ? `直近の完了は「${lastDone.title}」（${ago(lastDone.finished_at, now)}）` : 'まだ完了した作業はありません'}。`;

  const moneyLines = [];
  const cur = Object.entries(money.by_currency || {});
  moneyLines.push(cur.length
    ? `決済レジストリ（本番のみ）: ${money.count} 件 / ${cur.map(([k, v]) => `${v} ${k}`).join(' ・ ')}`
    : `決済レジストリ（本番のみ）: 0 件（実際に入金された記録はまだありません）`);
  if (money.test_count) moneyLines.push(`検証用の決済記録（testnet・売上に数えない）: ${money.test_count} 件`);
  moneyLines.push(`台帳: ${facts.ledger?.rows || 0} 行`);
  if (jobs.open.length) moneyLines.push(`進行中の案件: ${jobs.open.length} 件（先頭「${jobs.open[0].title || jobs.open[0].id}」/ 状態 ${jobs.open[0].state}）`);
  else moneyLines.push('進行中の案件: 0 件');

  const sections = [];
  sections.push({ title: `いま実行中（${counts.running}件）`, lines: running.length
    ? running.map((t) => `・${t.title}（${t.category || '分類なし'} / ${t.state} / ${ago(t.updated_at || t.started_at, now)}から${t.started_at ? `着手 ${elapsed(t.started_at, now)}` : '更新'}${t.next_action ? ` / 次の一手: ${t.next_action}` : ''}）`)
    : ['・（いま動いている作業はありません）'] });
  sections.push({ title: `待ち行列（${counts.queued}件）`, lines: queued.length
    ? queued.slice(0, 5).map((t) => `・${t.title}（優先度 ${Math.round(num(t.priority))}${t.next_action ? ` / ${t.next_action}` : ''}）`)
    : ['・（待ちはありません）'] });
  sections.push({ title: `直近に終わった（累計 ${counts.completed}件）`, lines: completed.length
    ? completed.slice(0, 5).map((t) => `・${t.title}（${ago(t.finished_at, now)}）`)
    : ['・（まだありません）'] });
  sections.push({ title: `うまくいっていない（失敗 ${counts.failed}件）`, lines: failures.length
    ? failures.map((t) => `・${t.title} — 試行 ${num(t.attempt)}/${num(t.max_attempts) || 3}${t.why ? `・理由: ${t.why}` : ''}（${ago(t.at, now)}）`)
    : ['・（失敗は記録されていません）'] });
  sections.push({ title: `あなたの判断待ち（${blockers}件）`, lines: (approvals.length || waiting.length)
    ? [...approvals.map((a) => `・${a.action}${a.note ? ` — ${String(a.note).slice(0, 120)}` : ''}（${ago(a.requested_at, now)}）`),
       ...waiting.map((t) => `・${t.title}（${t.state}${t.next_action ? ` / ${t.next_action}` : ''}）`)].slice(0, 8)
    : ['・（判断待ちはありません）'] });
  sections.push({ title: 'お金（実測のみ）', lines: moneyLines });
  sections.push({ title: `売り物（x402 ${facts.sellable ? '販売中' : '停止中'}）`, lines: sales.length
    ? sales.map((s) => `・${s.resource} — ${s.price_label}（${(s.networks || []).length}ネットワーク${s.blocked_reason ? ` / 停止理由: ${s.blocked_reason}` : ''}）`).concat([`・受け取り先: ${sales[0].pay_to || '未設定'}`])
    : ['・（値札を読めませんでした）'] });

  const deltaLines = [];
  if (facts.delta) {
    deltaLines.push(`前回の報告: ${jst(facts.delta.since)}（${elapsed(facts.delta.since, now)}前）`);
    deltaLines.push(`その間の完了: ${facts.delta.completed != null ? `+${facts.delta.completed} 件` : '集計できませんでした'} / 入金: ${facts.delta.received ? `${facts.delta.received.count} 件` : '集計できませんでした'}`);
  } else {
    deltaLines.push('前回の報告は記録されていません（これが最初の報告です）');
  }
  sections.push({ title: '前回の報告からの変化', lines: deltaLines });

  const nextLines = [];
  const topRun = running[0] || null;
  const topQueued = queued[0] || null;
  if (topRun) nextLines.push(`いま進めているのは「${topRun.title}」${topRun.next_action ? `。次は「${topRun.next_action}」` : ''}`);
  else if (topQueued) nextLines.push(`次に着手するのは「${topQueued.title}」${topQueued.next_action ? `（${topQueued.next_action}）` : ''}`);
  else nextLines.push('実行待ちが空です。目標を言ってもらえれば次の作業を組みます');
  if (approvals.length) nextLines.push(`あなたの承認待ちが ${approvals.length} 件あります（先頭: ${approvals[0].action}）`);
  if (waiting.length) nextLines.push(`環境待ち（あなたの設定待ち）が ${waiting.length} 件あります`);
  if (money.count === 0) nextLines.push('まだ実売上は0件です。買い手が付く条件（一覧への掲載・値段・発見面）の整備が最優先です');
  sections.push({ title: '次の一手', lines: nextLines });

  const ext = facts.external || null;
  if (ext) {
    const el = [];
    el.push(ext.unpaid_402 ? `・未払いの HEAD /api/x402/brief → ${ext.unpaid_402.status}${ext.unpaid_402.ok ? '（掲載の条件を満たしています）' : '（402 ではありません＝要対処）'}` : '・自分の402応答は測れませんでした');
    el.push(ext.bazaar ? `・Bazaar 掲載: ${ext.bazaar.total} 件（うち本番URL ${ext.bazaar.production_urls} 件）` : '・Bazaar の掲載は測れませんでした');
    for (const r of (ext.bazaar?.resources || []).slice(0, 5)) el.push(`  ・${r}`);
    for (const e of (ext.errors || [])) el.push(`・測れなかった項目: ${e}`);
    sections.push({ title: '外から見た状態（ライブ実測）', lines: el });
  }

  const honestyLines = [
    'この報告の数字はすべて保存済みの記録から読み直した実測です。見込み・推定は入れていません。',
  ];
  if (money.count === 0) honestyLines.push('決済0件は「まだ買い手が来ていない」という事実であって、需要がない証拠ではありません。');
  if (money.test_count) honestyLines.push(`検証用決済 ${money.test_count} 件は売上として数えていません。`);
  if (!eng) honestyLines.push('エンジンの稼働状態は取得できませんでした（記録は残っています）。');
  if (!sales.length) honestyLines.push('値札（x402 のカタログ）は読めませんでした。設定を確認する必要があります。');
  sections.push({ title: 'この報告で言えないこと', lines: honestyLines.map((h) => `・${h}`) });

  const header = `【活動報告】${jst(generated)} JST`;
  const text = [header, '', '■ 結論', headline, '']
    .concat(sections.flatMap((s) => [`■ ${s.title}`, ...s.lines, '']))
    .join('\n').trimEnd();

  return {
    generated_at: generated, last_report_at: facts.last_report_at || null, headline, engine: eng, counts,
    running, queued, completed, failures, approvals, waiting, missions,
    money: { ledger_rows: facts.ledger?.rows || 0, receipts: money.count, test_receipts: money.test_count, by_currency: money.by_currency || {}, jobs_open: jobs.open.length },
    sales, delta: facts.delta || null, external: ext, sections, next: nextLines, honesty: honestyLines, text,
  };
}

/** 報告を作る（DB 読み → 組み立て → 前回の報告時刻を更新）。 */
export async function activityReport(deps, { live = false, origin = null, env = null, mark = true } = {}) {
  const E = env || deps.env || {};
  const facts = await collectFacts(deps.store, E);
  let engine = null;
  try { engine = deps.engine && deps.engine.engineState ? await deps.engine.engineState() : null; } catch { engine = null; }
  let external = null;
  if (live) { try { external = await liveChecks(E, origin); } catch { external = null; } }
  const rep = renderReport({ ...facts, engine, external }, { env: E });
  if (mark) { try { await setSetting(deps.store, 'last_report_at', rep.generated_at); } catch { /* 記録できなくても報告は返す */ } }
  return rep;
}

/** 報告の数字をチャットカードにする（コマンド側の見せ方を1か所にまとめる）。 */
export function reportCards(rep) {
  const f = rep || {};
  const money = f.money || {};
  const sales = f.sales || [];
  const blockers = (f.approvals || []).length + ((f.counts && f.counts.waiting) || 0);
  const items = [
    { title: 'いま実行中', sub: f.counts?.running ? `${f.counts.running} 件（先頭「${f.running?.[0]?.title || '—'}」）` : '0 件', badge: '実行中', tone: 'accent' },
    { title: '待ち行列', sub: `${f.counts?.queued || 0} 件`, badge: '待ち', tone: 'muted' },
    { title: 'あなたの判断待ち', sub: `${blockers} 件`, badge: blockers ? '要対応' : 'なし', tone: blockers ? 'warn' : 'ok' },
    { title: '完了 / 失敗', sub: `${f.counts?.completed || 0} 件 / ${f.counts?.failed || 0} 件`, badge: '累計', tone: 'muted' },
    { title: '実測の入金', sub: money.receipts ? Object.entries(money.by_currency || {}).map(([k, v]) => `${v} ${k}`).join(' / ') : '0 件（まだ入金はありません）', badge: '本番のみ', tone: money.receipts ? 'ok' : 'muted' },
    { title: '売り物', sub: sales.length ? `${sales.length} 品目・${sales.map((x) => x.price_label).join(' / ')}` : '値札を読めませんでした', badge: sales.length ? 'x402' : '要設定', tone: sales.length ? 'ok' : 'warn' },
  ];
  return [
    { type: 'list', icon: 'list', title: '数字のまとめ（すべて実測）', items },
    { type: 'note', icon: 'key', title: 'この報告で言えないこと', text: (f.honesty || []).join('\n') },
  ];
}
