// 自浄作用（self-heal）と試行錯誤ループ — 「なぜ収益0なのか」を毎回測り、
// ボトルネックの段に手を打ち、効かなければ手を変えて再試行し、上限で見切る。
//
// 段（ファネル）: 拾う → 試す → 生きていると確認 → 売り物になる → 置き場に出る → 人が来る → 払う
// 原価0の制約は変えない。人が要る段（掲載・受け取り）は「1タップで済む形」まで自動で用意して記録する。
import { runProbe } from './playbook.js';

export const LT = 'loop_runs';
export const LOOP_VERSION = '1.0';
export const MAX_TRIES = 3;

const nowIso = () => new Date().toISOString();
const id = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
async function q1(store, sql, ...a) { try { const r = await store.first(sql, ...a); return r ? Number(Object.values(r)[0] || 0) : 0; } catch { return 0; } }
async function qa(store, sql, ...a) { try { return (await store.all(sql, ...a)) || []; } catch { return []; } }

export async function ensureLoopTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${LT} (
    id TEXT PRIMARY KEY, kind TEXT, subject TEXT, action TEXT, level TEXT,
    state TEXT, evidence_json TEXT, at TEXT)`);
  await store.run(`CREATE INDEX IF NOT EXISTS ${LT}_kind ON ${LT}(kind, at)`);
}

// ---------------------------------------------------------------------------
// 1) ファネルを実測して、いちばん詰まっている段を名指しする
// ---------------------------------------------------------------------------
const ALIVE_RE = /'(alive|claimable|mentions_free_or_money|works)'/;

/** 外部の決済リクエストだけを数える。自己テストを混ぜない（区別できない環境では null）。 */
async function countExternal(store) {
  for (const sql of [
    "SELECT COUNT(*) FROM ledger WHERE kind = 'revenue' AND basis <> 'self_test'",
    "SELECT COUNT(*) FROM receipts WHERE COALESCE(is_test,0) = 0",
  ]) {
    try { const r = await store.first(sql); return Number(Object.values(r)[0] || 0); } catch { /* 列が無ければ次を試す */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1-b) 掲載の生死を実際に見に行く（「提出した」と「載った」を分けて数える）
// ---------------------------------------------------------------------------
export const LISTINGS = [
  {
    key: 'awesome-remote-mcp-servers',
    name: 'awesome-remote-mcp-servers',
    url: 'https://raw.githubusercontent.com/punkpeye/awesome-remote-mcp-servers/main/README.md',
    needle: 'wealth-agent.wealthagent-app.workers.dev/mcp',
  },
  {
    key: 'glama',
    name: 'glama.ai connectors',
    url: 'https://glama.ai/mcp/connectors/io.github.jukky-source/wealth-agent',
    needle: 'wealth-agent',
  },
  {
    // 提出しただけでは数えない。審査を通って実際に載ったら、ここが live になる。
    key: 'x402-list',
    name: 'x402-list（$1 審査待ち）',
    url: 'https://x402-list.com/api/v1/services?q=wealth-agent',
    needle: 'wealth-agent.wealthagent-app.workers.dev',
  },
];

/** 掲載面を実際に取得して、自分のエンドポイントが載っているかを確かめる。 */
export async function verifyListings({ fetchImpl = fetch, now = null, listings = LISTINGS } = {}) {
  const at = now || nowIso();
  const out = [];
  for (const l of listings) {
    const row = { key: l.key, name: l.name, url: l.url, at, live: false, status: 0, note: '' };
    try {
      const res = await fetchImpl(l.url, { headers: { 'user-agent': 'wealth-agent/1.0 (+https://wealth-agent.wealthagent-app.workers.dev)' } });
      row.status = res.status;
      if (res.ok) {
        const body = String((await res.text()) || '').slice(0, 400000);
        row.live = body.includes(l.needle);
        row.note = row.live ? '掲載を確認' : '取得できたが自分の記載が見つからない';
      } else {
        row.note = `取得失敗 HTTP ${res.status}`;
      }
    } catch (e) { row.note = `取得失敗 ${String((e && e.message) || e).slice(0, 80)}`; }
    out.push(row);
  }
  const live = out.filter((r) => r.live);
  return { at, checked: out.length, live: live.length, listings: out, live_keys: live.map((r) => r.key) };
}

export async function funnel(store, { env = null } = {}) {
  const discovered = await q1(store, `SELECT COUNT(*) FROM playbooks`);
  const tried = await q1(store, `SELECT COUNT(*) FROM playbooks WHERE COALESCE(tries,0) > 0`);
  const alive = await q1(store, `SELECT COUNT(*) FROM playbooks WHERE COALESCE(tries,0) > 0 AND (result_json LIKE '%"alive"%' OR result_json LIKE '%"claimable"%' OR result_json LIKE '%"mentions_free_or_money"%' OR status = 'works')`);
  let products = 0;
  try { const { X402_CATALOG } = await import('./x402.js'); products = (X402_CATALOG || []).length; } catch { products = 0; }
  const distributed = await q1(store, `SELECT COUNT(*) FROM ${LT} WHERE kind = 'distribute' AND state = 'done'`);
  const reachedAll = await q1(store, `SELECT COUNT(*) FROM receipts`);
  const reachedExt = await countExternal(store);
  const reached = reachedExt == null ? reachedAll : reachedExt;
  const revenueUsd = await q1(store, `SELECT COALESCE(SUM(amount),0) FROM ledger WHERE kind = 'revenue' AND basis <> 'self_test'`);
  const selfTestUsd = await q1(store, `SELECT COALESCE(SUM(amount),0) FROM ledger WHERE basis = 'self_test'`);
  const reaAnalyzed = await q1(store, `SELECT COUNT(*) FROM rea_targets WHERE status IN ('analyzed','handoff')`).catch(() => 0);

  const stages = [
    { stage: '拾う', key: 'discovered', n: discovered, note: 'ネタ帳に積まれた件数（X / Reddit / scout / perks から自動）' },
    { stage: '試す', key: 'tried', n: tried, note: '読み取りで1回以上試した件数' },
    { stage: '生きていると確認', key: 'alive', n: alive, note: '到達できた／募集中と確認できた件数' },
    { stage: '売り物になる', key: 'products', n: products, note: '値札を付けて出せる品目（x402 カタログ）' },
    { stage: '置き場に出る', key: 'distributed', n: distributed, note: '買い手が見る場所に実際に載った件数（掲載は人の1タップ）' },
    { stage: '人が来る', key: 'reached', n: reached, note: `外部からの決済リクエスト（自己テスト ${Math.max(0, reachedAll - reached)} 件は除く）` },
    { stage: '払う', key: 'paid', n: revenueUsd, unit: 'USD', note: '実売上（自己テストを除く）' },
  ];

  // 落ち込みを全部拾い、そのうち「支払いにいちばん近い段」を詰まりとして名指しする。
  // （手前の段の停滞も breaks として残すので、両方見える）
  const breaks = [];
  for (let i = 1; i < stages.length; i += 1) {
    const prev = stages[i - 1].n, cur = stages[i].n;
    if (prev > 0 && cur < Math.max(1, Math.floor(prev * 0.5))) breaks.push({ from: stages[i - 1].key, stage: stages[i].key, from_n: prev, n: cur });
  }
  let bottleneck = breaks.length ? stages.find((s) => s.key === breaks[breaks.length - 1].stage) : null;
  if (!bottleneck) bottleneck = stages[stages.length - 1];

  const FIX = {
    tried: { why: '拾っただけで試していない。ネタが「読むだけ」で止まっている', fix: 'キューを消化して読み取り試行を回す', level: 'allow' },
    alive: { why: '試したが到達できない。URL か入口が違う', fix: '入口を変えて再試行（自動・上限3回）', level: 'allow' },
    products: { why: '到達できたが、値札を付けた売り物になっていない', fix: '検証済みの入口をカタログの品目に変換する', level: 'allow' },
    distributed: { why: '売り物はあるのに、買い手が見る場所に1つも載っていない（掲載は人の1タップで止まっている）', fix: '掲載エントリを自動で用意し、置き場の生死を確かめて、押すだけの状態にする', level: 'approve' },
    reached: { why: '載ったが誰も来ない（発見可能性の問題）', fix: '掲載面の説明と見出しを、検索される語に合わせて書き換える', level: 'approve' },
    paid: { why: '来たが払われていない（値付けか402応答の説明の問題）', fix: '価格と支払い手順の説明を、呼ぶ側の目線で書き直す', level: 'approve' },
  }[bottleneck.key] || { why: '段の数え方が足りない', fix: '観測を増やす', level: 'allow' };

  return {
    at: nowIso(), stages, breaks, bottleneck: { ...bottleneck, ...FIX },
    money: { revenue_usd: revenueUsd, self_test_usd: selfTestUsd },
    receipts: { all: reachedAll, external: reached, separable: reachedExt != null },
    rea_analyzed: reaAnalyzed,
    verdict: revenueUsd > 0
      ? `実売上 $${revenueUsd}。次の詰まりは「${bottleneck.stage}」`
      : `実売上はまだ 0。詰まっているのは「${bottleneck.stage}」— ${FIX.why}`,
  };
}

// ---------------------------------------------------------------------------
// 2) 手を変えて再試行する（同じ失敗を繰り返さない）
// ---------------------------------------------------------------------------
export function urlVariants(url = '') {
  const u = String(url || '');
  const out = [];
  try {
    const x = new URL(u);
    if (x.host.startsWith('www.')) out.push(u.replace('://www.', '://'));
    else out.push(u.replace('://', '://www.'));
    out.push(`${x.origin}/`);
  } catch { /* URL でなければ変異できない */ }
  return [...new Set(out)].filter((v) => v && v !== u);
}

/** 試行回数に応じて「変え方」を変える。3回で見切る（無限に回さない）。 */
export function mutateAttempt(pb = {}) {
  const tries = Number(pb.tries || 0);
  if (tries >= MAX_TRIES) return { ...pb, mutation: 'none', give_up: true, note: '3回試して到達できず。別の入口を探す' };
  if (tries === 0) return { ...pb, mutation: 'first', note: '初回' };
  if (tries === 1) {
    const v = urlVariants(pb.url);
    return v.length ? { ...pb, url: v[0], mutation: 'entry', note: '入口を変えて再試行' } : { ...pb, probe: pb.probe === 'free_tier' ? 'http' : 'free_tier', mutation: 'probe', note: '読み方を変えて再試行' };
  }
  return { ...pb, probe: pb.probe === 'free_tier' ? 'http' : 'free_tier', mutation: 'probe', note: '読み方を変えて再試行' };
}

export const SUCCESS_VERDICTS = ['alive', 'claimable', 'mentions_free_or_money'];

export async function retryPlaybook(store, pb = {}, { fetchImpl = fetch, now = null } = {}) {
  const at = now || nowIso();
  const m = mutateAttempt(pb);
  if (m.give_up) {
    await store.run(`UPDATE playbooks SET status = 'dead', result_json = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify({ at, verdict: 'gave_up', note: m.note }), at, pb.id);
    return { id: pb.id, action: 'give_up', status: 'dead', note: m.note };
  }
  let res = null;
  try { res = await runProbe(m, { fetchImpl, now: at }); }
  catch (e) { res = { at, probe: m.probe, ok: false, evidence: {}, verdict: 'error', next: String((e && e.message) || e).slice(0, 120) }; }
  const tries = Number(pb.tries || 0) + 1;
  const good = SUCCESS_VERDICTS.includes(res.verdict);
  const status = good ? (res.verdict === 'claimable' || res.verdict === 'mentions_free_or_money' ? 'works' : 'trying')
    : (tries >= MAX_TRIES ? 'dead' : 'trying');
  await store.run(`UPDATE playbooks SET status = ?, tries = ?, last_try_at = ?, result_json = ?, updated_at = ? WHERE id = ?`,
    status, tries, at, JSON.stringify({ at, probe: res.probe, verdict: res.verdict, evidence: res.evidence, next: res.next, mutation: m.mutation, mutation_note: m.note, tried_url: m.url || pb.url }), at, pb.id);
  return { id: pb.id, action: 'retry', mutation: m.mutation, verdict: res.verdict, status, tries, note: m.note, next: res.next };
}

// ---------------------------------------------------------------------------
// 3) 自己点検（自浄作用）— 見つけた異常は、許されている範囲でその場で直す
// ---------------------------------------------------------------------------
export async function selfHeal(store, { fetchImpl = fetch, now = null, env = null, maxRetry = 3, maxAgeH = 6 } = {}) {
  const at = now || nowIso();
  await ensureLoopTable(store);
  const actions = [];
  const record = async (kind, subject, action, level, state, evidence = {}) => {
    const row = { id: id('lp'), kind, subject: String(subject || '').slice(0, 140), action, level, state, evidence_json: JSON.stringify(evidence).slice(0, 2000), at };
    try { await store.run(`INSERT INTO ${LT} (id,kind,subject,action,level,state,evidence_json,at) VALUES (?,?,?,?,?,?,?,?)`,
      row.id, row.kind, row.subject, row.action, row.level, row.state, row.evidence_json, row.at); } catch { /* noop */ }
    actions.push({ kind, subject: row.subject, action, level, state });
  };

  // 3-a) 詰まった「trying」を、手を変えて再試行する
  const stuck = await qa(store, `SELECT * FROM playbooks WHERE status = 'trying' AND COALESCE(tries,0) < ? ORDER BY COALESCE(last_try_at, updated_at) ASC LIMIT ?`, MAX_TRIES, maxRetry);
  for (const pb of stuck) {
    const ageH = pb.last_try_at ? (Date.now() - new Date(pb.last_try_at).getTime()) / 3600000 : 99;
    if (ageH < 1) continue;
    try {
      const r = await retryPlaybook(store, pb, { fetchImpl, now: at });
      await record('retry', pb.title || pb.url, r.action, 'allow', r.status === 'dead' ? 'closed' : 'done', { mutation: r.mutation, verdict: r.verdict, next: r.next, tried_url: pb.url });
    } catch (e) { await record('retry', pb.title || pb.url, 'retry', 'allow', 'failed', { error: String((e && e.message) || e).slice(0, 140) }); }
  }

  // 3-b) 3回未満で死んだ印が付いたものを、1回だけ掘り起こす
  const dead = await qa(store, `SELECT * FROM playbooks WHERE status = 'dead' AND COALESCE(tries,0) < ? ORDER BY updated_at DESC LIMIT 2`, MAX_TRIES);
  for (const pb of dead) {
    try {
      const r = await retryPlaybook(store, pb, { fetchImpl, now: at });
      await record('revive', pb.title || pb.url, 'retry', 'allow', r.status === 'dead' ? 'closed' : 'done', { mutation: r.mutation, verdict: r.verdict });
    } catch (e) { await record('revive', pb.title || pb.url, 'retry', 'allow', 'failed', { error: String((e && e.message) || e).slice(0, 140) }); }
  }

  // 3-c) キューが枯れていたら、いま持っている外部情報から積み直す
  try {
    const { enqueueFromFindings, queueSummary } = await import('./reaQueue.js');
    const qs = await queueSummary(store);
    if (qs.queued === 0 && qs.total > 0) {
      const r = await enqueueFromFindings(store, { limit: 12 });
      await record('refill', 'rea_queue', 'enqueue', 'allow', r.inserted > 0 ? 'done' : 'noop', { inserted: r.inserted, scanned: r.scanned });
    } else if (qs.total === 0) {
      const r = await enqueueFromFindings(store, { limit: 12 });
      await record('refill', 'rea_queue', 'enqueue', 'allow', r.inserted > 0 ? 'done' : 'noop', { inserted: r.inserted, scanned: r.scanned, note: '初回投入' });
    }
  } catch (e) { await record('refill', 'rea_queue', 'enqueue', 'allow', 'failed', { error: String((e && e.message) || e).slice(0, 140) }); }

  // 3-d) 収集が止まっていないか（設定の最終時刻が古すぎないか）
  for (const [key, maxH] of [['playbook:ingest_at', 3], ['twitter:last_run_at', 6], ['perks:last_run_at', 12]]) {
    try {
      const row = await store.first(`SELECT value FROM settings WHERE key = ? LIMIT 1`, key);
      const raw = row ? row.value : null;
      let v = raw;
      if (typeof raw === 'string') { try { const p = JSON.parse(raw); v = (p && typeof p === 'object' && 'value' in p) ? p.value : raw; } catch { v = raw; } }
      const t = v ? new Date(v).getTime() : 0;
      const ageH = t ? (Date.now() - t) / 3600000 : 999;
      if (ageH > maxH) await record('stale', key, 'refill_due', 'allow', 'flagged', { age_h: Number(ageH.toFixed(1)), max_h: maxH });
    } catch { /* 設定が読めない環境は飛ばす */ }
  }

  // 3-e) 掲載の生死を実際に見に行く（提出しただけで「載った」ことにしない）
  let listings = null;
  try {
    listings = await verifyListings({ fetchImpl, now: at });
    try {
      await store.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)`, 'loop:listings', JSON.stringify(listings), at);
    } catch {
      try { await store.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)`, 'loop:listings', JSON.stringify(listings)); } catch { /* noop */ }
    }
    const d0 = await q1(store, `SELECT COUNT(*) FROM ${LT} WHERE kind = 'distribute' AND state = 'done'`);
    if (listings.live > 0 && d0 === 0) {
      for (const r of listings.listings.filter((x) => x.live)) {
        await record('distribute', r.name, 'verify_listing', 'allow', 'done', { url: r.url, status: r.status, note: r.note });
      }
    }
  } catch (e) { await record('distribute', 'listings', 'verify_listing', 'allow', 'failed', { error: String((e && e.message) || e).slice(0, 140) }); }

  // 3-f) 置き場に出ていないなら、押すだけで出せる掲載エントリを用意して記録する
  const f = await funnel(store, { env });
  if (f.bottleneck.key === 'distributed') {
    const entry = {
      name: 'wealth-agent',
      endpoint: 'https://wealth-agent.wealthagent-app.workers.dev/mcp',
      homepage: 'https://wealth-agent.wealthagent-app.workers.dev/',
      listing_line: 'Money-earning agent API: surface/REA inspection, data cleaning, code review, research briefs — paid per call over x402 (USDC on Base).',
      where: ['awesome-remote-mcp-servers（PR #1989 マージ済み）', 'glama.ai connectors（掲載済み）', 'x402 のディレクトリ（要1タップ）'],
    };
    await record('distribute', 'wealth-agent', 'prepare_listing', 'approve', 'ready', { entry, reason: f.bottleneck.why });
  }
  if (f.money.revenue_usd === 0) {
    await record('diagnose', 'revenue', 'measure', 'allow', 'flagged', { bottleneck: f.bottleneck.stage, why: f.bottleneck.why, fix: f.bottleneck.fix, stages: f.stages.map((s) => `${s.key}=${s.n}`) });
  }

  return { at, actions, bottleneck: f.bottleneck, funnel: f };
}

export async function loopSummary(store, { env = null } = {}) {
  await ensureLoopTable(store);
  const f = await funnel(store, { env });
  const byKind = {};
  for (const r of await qa(store, `SELECT kind, COUNT(*) AS n FROM ${LT} GROUP BY kind`)) byKind[r.kind || 'other'] = r.n;
  const recent = await qa(store, `SELECT kind, subject, action, level, state, at FROM ${LT} ORDER BY at DESC LIMIT 12`);
  let listings = null;
  try {
    const row = await store.first(`SELECT value FROM settings WHERE key = ? LIMIT 1`, 'loop:listings');
    if (row && row.value) listings = JSON.parse(row.value);
  } catch { /* noop */ }
  return { ...f, runs: await q1(store, `SELECT COUNT(*) FROM ${LT}`), by_kind: byKind, recent, listings };
}

export function loopText(s = {}) {
  const L = [`自己修復ループ v${LOOP_VERSION} — ${s.verdict || ''}`];
  for (const st of s.stages || []) L.push(`  ${st.stage}: ${st.n}${st.unit ? ' ' + st.unit : ''}  ${st.note || ''}`);
  if (s.bottleneck) L.push(`\n詰まり: ${s.bottleneck.stage} — ${s.bottleneck.why}\n打ち手: ${s.bottleneck.fix}（${s.bottleneck.level}）`);
  if (s.recent && s.recent.length) L.push('\n直近の動き\n' + s.recent.map((r) => `  [${r.state}] ${r.kind} ${r.subject} → ${r.action} (${r.level})`).join('\n'));
  return L.join('\n');
}

export function loopHelp() {
  return [
    `自己修復ループ v${LOOP_VERSION} — 収益0の原因を毎回測り、詰まった段に手を打つ`,
    '  GET  /api/loop           ファネル・詰まり・直近の動き',
    '  GET  /api/loop/public    公開版（要約）',
    '  自動: cron が「試行のやり直し（手を変える）／見切り／キュー補充／掲載エントリの用意」を回す',
    `  見切り: 同じネタは ${MAX_TRIES} 回で dead にする（無限に回さない）`,
    '  人の操作が要る段（掲載・受け取り）は、押すだけの形に整えて記録する（勝手に提出・送信はしない）',
  ].join('\n');
}
