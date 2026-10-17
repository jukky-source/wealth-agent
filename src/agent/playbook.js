// ---------------------------------------------------------------------------
// ネタ帳 (playbook) — 「このサイト / この仕組みを使うと、こうやれば稼げる」を
// 1件のレコードにして、実際に小さく試し、結果を残す。営業・売り込みの下書きは作らない。
//
// 設計上の約束（原価0の制約を最優先）:
//   - 先にお金が要る手順はネタにしない（cost_jpy は必ず 0。例外はオンチェーン登録のガス代のみ）。
//   - 試すのは「読み取り」と「自分の持ち物への書き込み」だけ。他人への投稿・DM・売り込みは自動化しない。
//   - 人の1タップが要る手順は human に列挙して、勝手に進めない。
//   - 試したら必ず結果を残す（tries / result）。成功も失敗も次の判定材料にする。
// ---------------------------------------------------------------------------

import { capabilityFit } from './scout.js';
import { nowIso, id, safeJson } from '../util.js';

export const T = 'playbooks';

/** ネタの種類。probe = 自動で試せる検証の種類。 */
export const KINDS = [
  { id: 'bounty', label: '賞金・報奨金（成果を出して受け取る）', probe: 'gh_issue', cost_jpy: 0 },
  { id: 'free_tier', label: '無料枠・紹介・本人確認ボーナス（登録するだけで貰える）', probe: 'free_tier', cost_jpy: 0 },
  { id: 'perk', label: '特典・無料コード（契約・購入・応募で受け取る）', probe: 'free_tier', cost_jpy: 0 },
  { id: 'points', label: 'ポイ活・ポイント還元（条件を満たして貯める）', probe: 'free_tier', cost_jpy: 0 },
  { id: 'marketplace', label: '売り場に出品する（置くだけで売れる）', probe: 'http', cost_jpy: 0 },
  { id: 'api', label: 'API に値札を付けて直販する', probe: 'http', cost_jpy: 0 },
  { id: 'monitor', label: '監視・通知を売る（毎日見張って差分を渡す）', probe: 'http', cost_jpy: 0 },
  { id: 'demand', label: '困っている人を見つけて道具を当てる', probe: 'http', cost_jpy: 0 },
  { id: 'content', label: '検証結果を記事・データにして売る', probe: 'http', cost_jpy: 0 },
];
export const KIND_IDS = KINDS.map((k) => k.id);
export const kindById = (k) => KINDS.find((x) => x.id === k) || null;

export const STATUSES = ['new', 'trying', 'works', 'dead', 'blocked_human'];

// ---------------------------------------------------------------------------
// 種（seed）— すでに一次情報で裏が取れているネタ。scout が拾う前にここから始める。
// ---------------------------------------------------------------------------
export const SEED_PLAYBOOKS = [
  {
    kind: 'bounty',
    title: 'GitHub の賞金付き Issue を拾って PR を出す（Algora / Opire / IssueHunt）',
    site: 'algora.io',
    url: 'https://algora.io/bounties',
    why_money: 'マージされると賞金がそのまま入る。原価は0で、払うのは自分の時間だけ。1件 $50〜$500 の帯が多い。',
    how: [
      '賞金付きの open issue を一覧から拾う（ラベルに bounty / 金額が書いてある）',
      '再現手順と受け入れ条件を読む（ここを飛ばすと無駄になる）',
      '自分のリポジトリで再現 → 修正 → テスト',
      'PR を出す（公開書き込みなので人の1タップが要る）',
      'マージされたら支払いを受ける（初回は本人確認あり）',
    ],
    first_step: 'open な賞金 Issue を3件ひろって、再現できるかどうかだけ確かめる',
    human: ['PR の提出（公開書き込み）', '初回の支払い受け取り設定'],
    probe: 'gh_issue',
  },
  {
    kind: 'free_tier',
    title: 'AgentHansa の Reddit 本人確認（最大 $14.50）',
    site: 'agenthansa.com',
    url: 'https://www.agenthansa.com/',
    why_money: 'Reddit アカウントの本人確認だけで最大 $14.50。API も原価も要らない、いま取れる確定現金。',
    how: [
      'サイトで Reddit の本人確認タスクを開く',
      '自分の Reddit アカウントで確認を通す（5分程度）',
      'X も併せて確認すると +$0.50',
    ],
    first_step: 'Reddit の本人確認を開いて、いくらになるか実額を確認する',
    human: ['本人確認の操作そのもの'],
    probe: 'free_tier',
  },
  {
    kind: 'api',
    title: '自前 API に x402 で値札を付けて直販する',
    site: 'x402.org',
    url: 'https://www.x402.org/',
    why_money: '1リクエストごとに USDC が入る。在庫も原価も無い（Cloudflare の無料枠で動く）。',
    how: [
      '既に持っている API に値札を付ける（0.01〜0.75 USDC）',
      'x402 の索引に載せて、買う側のエージェントから見えるようにする',
      '呼ばれた回数を receipts で数える（自己申告は数えない）',
    ],
    first_step: '自分のカタログが外から引けるか確認し、値札の一覧を出す',
    human: [],
    probe: 'http',
  },
  {
    kind: 'bounty',
    title: 'Superteam Earn の暗号通貨バウンティ（参加無料）',
    site: 'earn.superteam.fun',
    url: 'https://earn.superteam.fun/',
    why_money: '参加費0。記事・デザイン・ツールの小さな賞金が常時100件以上出ていて、締切が短い。',
    how: [
      '募集中のバウンティを締切順に拾う',
      '求められている成果物と提出形式を確認する',
      '出せるものを1件だけ作って出す（落ちても失うのは時間だけ）',
    ],
    first_step: '締切が7日以内で、自分の既存コードで出せそうなものを3件ひろう',
    human: ['提出（公開書き込み）'],
    probe: 'http',
  },
];

// ---------------------------------------------------------------------------
// 種別の判定
// ---------------------------------------------------------------------------
const RULES = [
  { kind: 'bounty', re: /(bounty|賞金|報奨|懸賞|algora|issuehunt|opire|superteam|gitcoin)/i },
  { kind: 'perk', re: /(特典|perk|ギフトコード|プレゼント|もれなく|付帯|無料コード|優待)/i },
  { kind: 'points', re: /(ポイント|ponta|dポイント|楽天ポイント|paypay|マイル|スタンプ|還元)/i },
  { kind: 'free_tier', re: /(free tier|無料枠|free credit|クレジット|紹介|referral|verif|本人確認|airdrop(?!.*hype))/i },
  { kind: 'marketplace', re: /(marketplace|registry|ディレクトリ|掲載|listing|出品)/i },
  { kind: 'monitor', re: /(monitor|watch|alert|通知|監視|差分|再入荷|値下げ)/i },
  { kind: 'api', re: /(x402|api|endpoint|sdk|webhook|mcp)/i },
  { kind: 'demand', re: /(looking for|is there a|recommend|探して|困って|代替|alternative to|willing to pay)/i },
];

export function classify(item = {}) {
  const hay = `${item.title || ''} ${item.excerpt || ''} ${item.url || ''}`;
  for (const r of RULES) if (r.re.test(hay)) return r.kind;
  const fits = capabilityFit(item);
  if (fits.includes('monitor')) return 'monitor';
  if (fits.includes('x402') || fits.includes('mcp')) return 'api';
  return 'content';
}

function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; }
}

function keyOf(o) {
  const s = `${o.kind}|${o.site || ''}|${o.url || ''}|${(o.title || '').slice(0, 60)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'pb_' + (h >>> 0).toString(36);
}

/** 種類ごとの「こうやれば稼げる」手順。原価0の手順しか入れない。 */
export function stepsFor(kind, item = {}) {
  const t = (item.title || '').slice(0, 90);
  switch (kind) {
    case 'bounty':
      return [
        `「${t}」が本当にまだ募集中か、締切と受入条件を確認する`,
        '再現手順を自分の環境でなぞって、直せる範囲かを判定する',
        '直せたら PR を出す（公開書き込みなので人の1タップ）',
        'マージされたら支払いを受け取る',
      ];
    case 'free_tier':
      return [
        `「${t}」の無料枠・ボーナスの実額と条件を公式ページで確認する`,
        '自分で登録して受け取れるか試す（原価0・払うのは時間だけ）',
        '受け取れた額を記録して、次の判断材料にする',
      ];
    case 'perk':
      return [
        `「${t}」の対象条件・実額・期限を公式ページで確認する`,
        '自分が条件を満たしているか（対象外条件）を先に確認する',
        '受け取る（人の1タップ）。受け取った額を記録する',
      ];
    case 'points':
      return [
        `「${t}」の還元率と、必要な条件（カード提示・応募・スタンプ数）を確認する`,
        '出費が要る場合は先に払う額を確かめて、損しないかを判断する',
        '応募・受け取りは人が行い、結果を記録する',
      ];
    case 'marketplace':
      return [
        `「${t}」の出品条件（手数料・本人確認・掲載資格）を確認する`,
        '既に持っている成果物をそのまま置けるか判定する',
        '置けたら、閲覧数ではなく「買われた数」で判定する',
      ];
    case 'monitor':
      return [
        `「${t}」で、人が毎回手で見に行っている対象を特定する`,
        '差分だけを渡す小さな監視を作る（無料枠で動かす）',
        '通知1件あたりの値段を付けて、呼ばれた回数で判定する',
      ];
    case 'api':
      return [
        `「${t}」を自前 API として出せる形に切り出す`,
        '値札（USDC）を付けて索引に載せる',
        '呼ばれた回数を receipts で数える（自己申告は数えない）',
      ];
    case 'demand':
      return [
        `「${t}」で困っている人の具体的な作業を1つに絞る`,
        'その作業を自動でやる道具を、既存コードの組み替えで作る',
        'まず無料で1件通して、手間が減ったことを示す',
      ];
    default:
      return [
        `「${t}」を自分の検証で確かめて、数字を出す`,
        '数字を記事・データにして置く（無料の置き場でよい）',
        '反応（読まれた数ではなく、買われた数・問い合わせ数）で判定する',
      ];
  }
}

/** scout の1件（または任意の種）からネタを作る。 */
export function playbookFrom(item = {}, { now = null } = {}) {
  const kind = item.kind && KIND_IDS.includes(item.kind) ? item.kind : classify(item);
  const url = item.url || null;
  const site = item.site || hostOf(url) || null;
  const pb = {
    key: keyOf({ kind, site, url, title: item.title }),
    kind,
    title: (item.title || '').trim().slice(0, 180) || kindById(kind).label,
    site,
    url,
    why_money: item.why_money || '',
    how: Array.isArray(item.how) && item.how.length ? item.how : stepsFor(kind, item),
    first_step: item.first_step || stepsFor(kind, item)[0],
    cost_jpy: 0,
    human: item.human || (kind === 'bounty' ? ['公開書き込み'] : []),
    probe: item.probe || (kindById(kind) || {}).probe || 'http',
    score: Number.isFinite(item.score) ? item.score : null,
    source_id: item.source_id || (item.seed ? 'seed' : null),
    status: 'new',
    tries: 0,
    result: null,
    created_at: now || nowIso(),
  };
  return pb;
}

/** scout の1件から、重複を除いたネタ候補を作る（最大 max 件）。 */
export function derivePlaybooks(item = {}, { max = 2 } = {}) {
  const fits = capabilityFit(item);
  const out = [];
  const push = (k) => {
    const pb = playbookFrom({ ...item, kind: k });
    if (!out.some((x) => x.key === pb.key)) out.push(pb);
  };
  push(classify(item));
  for (const f of fits) {
    const map = { x402: 'api', mcp: 'marketplace', monitor: 'monitor', content: 'content' };
    if (map[f]) push(map[f]);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// 試す — 読み取りだけ。原価0。ここで「動くか / まだ生きているか」を確かめる。
// ---------------------------------------------------------------------------
const q1 = async (store, sql, ...args) => {
  if (typeof store.first === 'function') return store.first(sql, ...args);
  if (typeof store['get'] === 'function') return store['get'](sql, ...args);
  const rows = await store.all(sql, ...args);
  return (rows && rows[0]) || null;
};

const UA = 'wealth-agent-playbook/1.0 (+https://wealth-agent.wealthagent-app.workers.dev)';

async function httpGet(url, fetchImpl, ms = 12000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.5', 'user-agent': UA },
      signal: ctl ? ctl.signal : undefined,
      redirect: 'follow',
    });
    const text = (await res.text()).slice(0, 60000);
    return { status: res.status, ok: res.ok, text };
  } finally { if (timer) clearTimeout(timer); }
}

const FREE_WORDS = /(free tier|free plan|no cost|no subscription|無料枠|無料プラン|free credits|grant|bounty|reward|賞金|報酬|\$\d)/i;

export function ghParts(url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/** 1件を試す。読み取りのみ・原価0。結果は {ok, evidence, verdict, next}。 */
export async function runProbe(pb = {}, { fetchImpl = fetch, now = null } = {}) {
  const at = now || nowIso();
  const probe = pb.probe || (kindById(pb.kind) || {}).probe || 'http';

  if (probe === 'gh_issue') {
    const p = ghParts(pb.url);
    if (!p) {
      // 一覧ページしか無い場合は、一覧が生きているかだけ見る。
      const r = await httpGet(pb.url || 'https://algora.io/bounties', fetchImpl);
      return { at, probe, ok: r.ok, evidence: { url: pb.url, http: r.status }, verdict: r.ok ? 'alive' : 'unreachable',
        next: r.ok ? '一覧は生きている。個別の Issue URL を1本確保して再試行' : 'URL を確認' };
    }
    const api = `https://api.github.com/repos/${p.owner}/${p.repo}/issues/${p.number}`;
    const r = await httpGet(api, fetchImpl);
    if (!r.ok) return { at, probe, ok: false, evidence: { api, http: r.status }, verdict: 'unreachable', next: 'API が引けない（レート制限の可能性）' };
    let d = {};
    try { d = JSON.parse(r.text); } catch { /* noop */ }
    const labels = (d.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
    const bounty = labels.find((l) => /bounty|\$|usd/i.test(l)) || null;
    const open = d.state === 'open' && !d.closed_at;
    return {
      at, probe, ok: true,
      evidence: { api, state: d.state, comments: d.comments, labels, bounty, updated_at: d.updated_at, title: (d.title || '').slice(0, 120) },
      verdict: open ? 'claimable' : 'closed',
      next: open ? 'まだ募集中。再現できるか確認して、できれば PR まで進める（PR は人の1タップ）' : '既に閉じている。別の Issue に差し替える',
    };
  }

  if (probe === 'free_tier') {
    if (!pb.url) return { at, probe, ok: false, evidence: {}, verdict: 'no_url', next: '公式ページの URL を入れる' };
    const r = await httpGet(pb.url, fetchImpl);
    const m = r.text.match(FREE_WORDS);
    return {
      at, probe, ok: r.ok,
      evidence: { url: pb.url, http: r.status, matched: m ? m[0] : null },
      verdict: r.ok ? (m ? 'mentions_free_or_money' : 'alive_no_keyword') : 'unreachable',
      next: r.ok ? 'ページは生きている。実額と条件を目で確認して、人の1タップで受け取る' : 'URL を確認',
    };
  }

  // http（既定）
  if (!pb.url) return { at, probe: 'http', ok: false, evidence: {}, verdict: 'no_url', next: 'URL を入れる' };
  const r = await httpGet(pb.url, fetchImpl);
  return {
    at, probe: 'http', ok: r.ok,
    evidence: { url: pb.url, http: r.status, bytes: r.text.length },
    verdict: r.ok ? 'alive' : 'unreachable',
    next: r.ok ? '生きている。次は「置く / 値札を付ける」の自分の側の作業に進む' : 'URL か到達性を確認',
  };
}

// ---------------------------------------------------------------------------
// 保存 — D1
// ---------------------------------------------------------------------------
export async function ensurePlaybookTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${T} (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, title TEXT,
    site TEXT, url TEXT, why_money TEXT, how_json TEXT DEFAULT '[]',
    first_step TEXT, cost_jpy INTEGER DEFAULT 0, human_json TEXT DEFAULT '[]',
    probe TEXT, score INTEGER, source_id TEXT, status TEXT DEFAULT 'new',
    tries INTEGER DEFAULT 0, last_try_at TEXT, result_json TEXT,
    created_at TEXT, updated_at TEXT)`);
  await store.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${T}_key ON ${T}(key)`);
  await store.run(`CREATE INDEX IF NOT EXISTS ${T}_status ON ${T}(status, kind)`);
}

function rowToPb(r = {}) {
  return {
    id: r.id, key: r.key, kind: r.kind, title: r.title, site: r.site, url: r.url,
    why_money: r.why_money || '', how: safeJson(r.how_json, []), first_step: r.first_step,
    cost_jpy: r.cost_jpy || 0, human: safeJson(r.human_json, []), probe: r.probe,
    score: r.score, source_id: r.source_id, status: r.status || 'new',
    tries: r.tries || 0, last_try_at: r.last_try_at || null,
    result: r.result_json ? safeJson(r.result_json, null) : null,
    created_at: r.created_at, updated_at: r.updated_at || null,
  };
}

/** ネタを保存する。既にあれば何もしない（重複を増やさない）。 */
export async function savePlaybook(store, pb, { now = null } = {}) {
  const at = now || nowIso();
  const existing = await q1(store, `SELECT id FROM ${T} WHERE key = ?`, pb.key);
  if (existing) return { inserted: false, id: existing.id };
  const pid = id('pb');
  await store.run(
    `INSERT INTO ${T} (id,key,kind,title,site,url,why_money,how_json,first_step,cost_jpy,human_json,probe,score,source_id,status,tries,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, pb.key, pb.kind, pb.title, pb.site, pb.url, pb.why_money, JSON.stringify(pb.how || []),
    pb.first_step, pb.cost_jpy || 0, JSON.stringify(pb.human || []), pb.probe, pb.score,
    pb.source_id, pb.status || 'new', 0, pb.created_at || at, at,
  );
  return { inserted: true, id: pid };
}

export async function seedPlaybooks(store, { now = null } = {}) {
  let inserted = 0;
  for (const s of SEED_PLAYBOOKS) {
    const pb = playbookFrom({ ...s, seed: true });
    const r = await savePlaybook(store, pb, { now });
    if (r.inserted) inserted++;
  }
  return { inserted, total: SEED_PLAYBOOKS.length };
}

export async function listPlaybooks(store, { limit = 50, status = null, kind = null } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(limit);
  const rows = await store.all(
    `SELECT * FROM ${T} ${w} ORDER BY CASE status WHEN 'works' THEN 0 WHEN 'trying' THEN 1 WHEN 'blocked_human' THEN 2 WHEN 'new' THEN 3 ELSE 4 END,
     COALESCE(score,0) DESC, created_at DESC LIMIT ?`, ...args);
  return (rows || []).map(rowToPb);
}

export async function getPlaybook(store, pidOrKey) {
  const r = await q1(store, `SELECT * FROM ${T} WHERE id = ? OR key = ?`, pidOrKey, pidOrKey);
  return r ? rowToPb(r) : null;
}

/** 未試行のネタを試して、結果を残す。原価0・読み取りのみ。 */
export async function tryPlaybooks(store, { limit = 2, fetchImpl = fetch, now = null, status = 'new' } = {}) {
  const at = now || nowIso();
  const rows = await store.all(
    `SELECT * FROM ${T} WHERE status = ? ORDER BY COALESCE(score,0) DESC, created_at ASC LIMIT ?`, status, limit);
  const out = [];
  for (const r of rows || []) {
    const pb = rowToPb(r);
    let res;
    try { res = await runProbe(pb, { fetchImpl, now: at }); }
    catch (e) { res = { at, probe: pb.probe, ok: false, evidence: { error: e.message }, verdict: 'error', next: '次tickで再試行' }; }
    const nextStatus = res.verdict === 'claimable' || res.verdict === 'alive' || res.verdict === 'mentions_free_or_money'
      ? 'trying' : (res.verdict === 'closed' || res.verdict === 'unreachable' ? 'dead' : pb.status);
    await store.run(
      `UPDATE ${T} SET status = ?, tries = COALESCE(tries,0) + 1, last_try_at = ?, result_json = ?, updated_at = ? WHERE id = ?`,
      nextStatus, at, JSON.stringify(res), at, pb.id);
    out.push({ id: pb.id, kind: pb.kind, title: pb.title, verdict: res.verdict, next_status: nextStatus, evidence: res.evidence, next: res.next });
  }
  return { at, tried: out.length, rows: out };
}

export async function playbookSummary(store) {
  const byKind = await store.all(`SELECT kind, status, COUNT(*) AS n FROM ${T} GROUP BY kind, status`);
  const total = await q1(store, `SELECT COUNT(*) AS n FROM ${T}`);
  const tried = await q1(store, `SELECT COUNT(*) AS n FROM ${T} WHERE tries > 0`);
  const works = await q1(store, `SELECT COUNT(*) AS n FROM ${T} WHERE status = 'works'`);
  const cells = {};
  for (const r of byKind || []) { cells[`${r.kind}:${r.status}`] = r.n; }
  return {
    total: total ? total.n : 0,
    tried: tried ? tried.n : 0,
    works: works ? works.n : 0,
    by_kind_status: cells,
    note: 'ネタは「置く・試す」まで。受け取る・提出するは人の1タップ（原価0を守るため自動化しない）。',
  };
}

export function playbookText(rows = []) {
  const L = [];
  L.push('ネタ帳（このサイト/仕組みを使うと、こうやれば稼げる）');
  if (!rows.length) { L.push('  まだ無い。POST /api/playbook/seed で種を入れる。'); return L.join('\n'); }
  for (const p of rows) {
    L.push('');
    L.push(`[${p.status}] ${p.kind} | ${p.title}`);
    if (p.site) L.push(`  場所: ${p.site}  ${p.url || ''}`);
    if (p.why_money) L.push(`  なぜ金になるか: ${p.why_money}`);
    L.push(`  最初の1手: ${p.first_step}`);
    L.push(`  原価: ${p.cost_jpy}円  試行: ${p.tries}回  人の操作: ${(p.human || []).join(' / ') || 'なし'}`);
    if (p.result) L.push(`  試した結果: ${p.result.verdict} ${JSON.stringify(p.result.evidence).slice(0, 220)}`);
    if (p.result && p.result.next) L.push(`  次の一手: ${p.result.next}`);
  }
  return L.join('\n');
}

export function playbookHelp() {
  return [
    'ネタ帳 — 「有益な情報 → 実際に試す」を回すための台帳。営業・売り込みの下書きは作らない。',
    '',
    'GET  /api/playbook              : 一覧（?format=text / ?kind= / ?status=）',
    'GET  /api/playbook/help         : この説明',
    'POST /api/playbook/seed         : 一次情報で裏が取れている種を入れる（原価0のものだけ）',
    'POST /api/playbook/derive       : scout が拾った実データからネタを作る（本文は無料ソースのみ）',
    'POST /api/playbook/try          : 未試行のネタを実際に試す（読み取りのみ・原価0・?limit=N）',
    '',
    '種類: ' + KINDS.map((k) => `${k.id}(${k.label})`).join(' / '),
    '試し方(probe): gh_issue=賞金Issueがまだ募集中か / free_tier=無料枠・実額の記載があるか / http=到達性',
    '',
    '守っていること: 先にお金が要る手順は入れない（cost_jpy は必ず0）。他人への投稿・DM・売り込みは自動化しない。',
  ].join('\n');
}

export function playbookLoopNote() {
  return 'ネタ帳: scout の実データから「こうやれば稼げる」を作り、読み取りだけで試して結果を残す（原価0）。';
}
