// 報奨金（バウンティ）レーン — 「AIが代わりに働いて現金をもらう」経路。
// 既存の scout が集めた GitHub issue（label:bounty 等）を採点し、着手候補を並べる。
// 送信・PR作成は人の承認（envelope: public_post=approval）を挟む。
//
// bounty-1.1: 「額面が大きいだけ」の候補を弾くための信頼性判定を追加。
//   根拠（2026-10-19 実測）: 上位6件はすべて同一リポジトリ oll4com/spaceapp。
//   ラベルの説明文は「💎 Bounty | Cash bounty paid after merge」だが、
//   closed になった bounty issue は 0 件・FUNDING.yml なし・支払い主体の記載なし。
//   （同時に、リポジトリ自体は実在し活発: 13★/71fork/151 open issue・当日もコミットあり）
//   ＝ 額面は着手判断に使えない。支払いの証拠（履歴・資金源・活動）を別軸で測る。
//   proof < PROOF_MIN の候補は verdict を unbacked に落とし、「着手推奨」にしない。
import { nowIso, safeJson } from '../util.js';
import { setting, setSetting } from '../db.js';

export const BOUNTY_VERSION = 'bounty-1.1';
export const BL = 'bounty_leads';
export const RR = 'bounty_repos';
export const MEDIAN_USD = 50;  // 金額不明のときの控えめな想定
export const PROOF_MIN = 40;   // これ未満は「着手推奨」にしない

const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
const key = (u) => 'bl_' + String(u || '').replace(/[^a-zA-Z0-9]/g, '').slice(-40);

export async function ensureBounty(store) {
  try {
    await store.run(`CREATE TABLE IF NOT EXISTS ${BL} (
      key TEXT PRIMARY KEY, url TEXT, title TEXT, repo TEXT, source TEXT,
      payout_usd REAL, score INTEGER, verdict TEXT, reason TEXT,
      state TEXT DEFAULT 'new', note TEXT, created_at TEXT, updated_at TEXT,
      proof INTEGER, flags TEXT, stars INTEGER, forks INTEGER, paid_closed INTEGER, funded INTEGER
    )`);
  } catch (e) { /* 既存 */ }
  // 既存テーブルへの列追加（既にあれば失敗するだけ）
  for (const c of ['proof INTEGER', 'flags TEXT', 'stars INTEGER', 'forks INTEGER', 'paid_closed INTEGER', 'funded INTEGER']) {
    try { await store.run(`ALTER TABLE ${BL} ADD COLUMN ${c}`); } catch (e) { /* 既にある */ }
  }
}

async function ensureRepos(store) {
  try {
    await store.run(`CREATE TABLE IF NOT EXISTS ${RR} (repo TEXT PRIMARY KEY, facts_json TEXT, checked_at TEXT)`);
  } catch (e) { /* 既存 */ }
}

const PAY = /\$\s?([0-9][0-9,]{1,7})(?:\.\d+)?/;
const FIT = ['javascript','typescript','node','python','api','worker','rest','cli','sdk','json','test','bug','fix','docs','readme'];
const CLEAR = ['acceptance','reproduc','steps to reproduce','expected','test case','regression','unit test'];

export function scoreLead(it = {}) {
  const text = `${it.title || ''}\n${it.excerpt || it.body || ''}`.toLowerCase();
  const m = PAY.exec(text);
  const payout = m ? Number(String(m[1]).replace(/,/g, '')) : null;
  const money = payout ? Math.min(40, Math.round((payout / 500) * 40)) : 6;

  const ageH = it.age_hours != null ? Number(it.age_hours) : null;
  const fresh = ageH == null ? 8 : ageH <= 72 ? 20 : ageH <= 336 ? 12 : 4;

  const clarity = CLEAR.reduce((a, k) => a + (text.includes(k) ? 1 : 0), 0) >= 2 ? 15 : text.length > 600 ? 9 : 4;
  const fits = FIT.reduce((a, k) => a + (text.includes(k) ? 1 : 0), 0);
  const fit = Math.min(25, fits * 4);
  const score = money + fresh + clarity + fit;

  const verdict = score >= 55 && payout ? 'pursue' : score >= 40 ? 'study' : 'skip';
  const reason = `${payout ? `金額$${payout}` : '金額不明'} / 鮮度${fresh} / 明確さ${clarity} / 相性${fit}${fits ? `(${fits})` : ''}`;
  return { payout, score, verdict, reason };
}

// ---------------------------------------------------------------------------
// 信頼性（本当に金が動く場所か）
// ---------------------------------------------------------------------------

/** GitHub の GET を 1 本。GITHUB_TOKEN があれば使う（無認証は 60 req/h なので実質必須）。 */
async function ghJson(url, env = null) {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'WealthAgent-Bounty/1.1' };
  const tok = env && env.GITHUB_TOKEN;
  if (tok) h.authorization = `Bearer ${tok}`;
  try {
    const res = await fetch(url, { headers: h });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

/** リポジトリの素性を実測する（支払いの証拠になりうる事実だけ）。 */
export async function repoFacts(repo, env = null) {
  const api = `https://api.github.com/repos/${repo}`;
  const r = await ghJson(api, env);
  if (!r || r.message) return null;
  const funding = !!(await ghJson(`${api}/contents/.github/FUNDING.yml`, env));
  // 「閉じた bounty issue」＝支払いが起きた最も強い証拠。search API は枠が狭いので
  // 通常の issues API で直近100件を1回だけ引き、ラベルに bount を含むものを数える。
  let paidClosed = 0;
  for (const q of ['bounty', encodeURIComponent('💎 Bounty')]) {
    const arr = await ghJson(`${api}/issues?state=closed&labels=${q}&per_page=100`, env);
    if (Array.isArray(arr)) { if (arr.length > paidClosed) paidClosed = arr.length; if (paidClosed > 0) break; }
  }
  const pushedDays = r.pushed_at ? (Date.now() - new Date(r.pushed_at).getTime()) / 86400000 : null;
  const createdDays = r.created_at ? (Date.now() - new Date(r.created_at).getTime()) / 86400000 : null;
  return {
    repo,
    stars: Number(r.stargazers_count || 0),
    forks: Number(r.forks_count || 0),
    open_issues: Number(r.open_issues_count || 0),
    archived: !!r.archived,
    funding,
    paid_closed: paidClosed,
    age_days: createdDays == null ? null : Math.round(createdDays),
    pushed_days: pushedDays == null ? null : Math.round(pushedDays),
  };
}

/** 実測した事実から 0〜100 の証拠点を作る。高いほど「本当に金が動く場所」。 */
export function assessProof(f = {}) {
  if (!f || f.repo == null) return { proof: 0, flags: 'no_repo_facts' };
  const flags = [];
  let p = 0;
  if (f.age_days != null && f.age_days >= 90) p += 10;
  if (f.stars >= 100) p += 15; else if (f.stars >= 20) p += 8; else if (f.stars >= 5) p += 4;
  if (f.paid_closed > 0) p += 30;              // 支払いが起きた唯一の強い証拠
  if (f.funding) p += 10;                      // 資金源の開示
  if (f.pushed_days != null && f.pushed_days <= 14) p += 10;
  const ratio = f.stars > 0 ? f.forks / f.stars : (f.forks > 0 ? 99 : 0);
  if (ratio > 5 && f.forks >= 30) { p -= 15; flags.push('fork_heavy'); }   // 星に対しフォーク過多＝PR投稿の量産
  if (f.open_issues >= 500) { p -= 10; flags.push('issue_flood'); }
  if (!f.paid_closed) flags.push('no_paid_history');
  if (!f.funding) flags.push('no_funding');
  if (f.archived) { p = 0; flags.push('archived'); }
  return { proof: Math.max(0, Math.min(100, p)), flags: flags.join(',') || null };
}

const RANK = { pursue: 3, study: 2, unbacked: 1, skip: 0 };

/** 事実を 24h キャッシュして取得（無認証の API 枠を無駄に使わない）。 */
export async function repoProof(store, repo, env = null, { ttlHours = 24 } = {}) {
  await ensureRepos(store);
  const cached = await store.first(`SELECT facts_json, checked_at FROM ${RR} WHERE repo=?`, repo).catch(() => null);
  const fresh = cached && cached.checked_at && (Date.now() - new Date(cached.checked_at).getTime() < ttlHours * 3600e3);
  if (fresh) return { ...safeJson(cached.facts_json, {}), cached: true };
  const f = await repoFacts(repo, env);
  if (!f) return cached ? { ...safeJson(cached.facts_json, {}), cached: true, stale: true } : null;
  await store.run(
    `INSERT INTO ${RR} (repo,facts_json,checked_at) VALUES (?,?,?)
     ON CONFLICT(repo) DO UPDATE SET facts_json=excluded.facts_json, checked_at=excluded.checked_at`,
    repo, JSON.stringify(f), nowIso()
  ).catch(() => {});
  return { ...f, cached: false };
}

export async function bountyScan({ store, env = null, live = true, reposMax = 12 } = {}) {
  await ensureBounty(store);
  const at = nowIso();
  const rows = [];

  // 1) 既に巡回済みの候補（無料・確実）
  try {
    const found = await store.all(
      `SELECT title,url,excerpt,age_hours,source_id,score FROM scout_findings
       WHERE instr(lower(COALESCE(source_id,'')||' '||COALESCE(title,'')||' '||COALESCE(tags_json,'')||' '||COALESCE(excerpt,'')), 'bounty') > 0
       ORDER BY score DESC LIMIT 60`
    );
    for (const r of found || []) rows.push({ ...r, source: `scout:${r.source_id || '?'}` });
  } catch (e) { /* 継続 */ }

  // 2) ライブの GitHub 検索（失敗しても致命的でない）
  const errors = [];
  if (live) {
    const qs = [
      'label:bounty state:open',
      'label:"help wanted" state:open bounty in:title,body',
    ];
    for (const q of qs) {
      try {
        const u = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=25`;
        const d = await ghJson(u, env);
        if (!d) { errors.push('search_failed'); continue; }
        if (d.message) { errors.push(String(d.message).slice(0, 60)); continue; }
        for (const it of (d.items || [])) {
          const age = it.created_at ? (Date.now() - new Date(it.created_at).getTime()) / 3600000 : null;
          rows.push({
            title: it.title, url: it.html_url, excerpt: String(it.body || '').slice(0, 800),
            age_hours: age, source_id: 'github_search', score: 30, source: 'github_search',
          });
        }
      } catch (e) { errors.push(String((e && e.message) || e).slice(0, 80)); }
    }
  }

  const seen = new Set();
  const leads = [];
  for (const r of rows) {
    const url = r.url || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const s = scoreLead(r);
    const repo = (String(url).match(/github\.com\/([^/]+\/[^/]+)/) || [])[1] || null;
    leads.push({
      key: key(url), url, title: String(r.title || '').slice(0, 200), repo,
      source: r.source || r.source_id || 'scout', ...s,
    });
  }

  // 3) 信頼性の実測 — 点の高い順にユニークなリポジトリだけを見る（API 枠の保護）
  //    挿入順で選ぶと、ライブ検索で後から入る高額候補が漏れる（実測 2026-10-19: spaceapp が漏れ、
  //    証拠0＝repo_unknown に落ちた）。採点順に並べてから選ぶ。
  leads.sort((a, b) => b.score - a.score);
  const repos = [...new Set(leads.map((l) => l.repo).filter(Boolean))].slice(0, Math.max(1, reposMax));
  const facts = {};
  for (const repo of repos) {
    try { facts[repo] = await repoProof(store, repo, env); } catch (e) { facts[repo] = null; }
  }
  let unbacked = 0;
  for (const l of leads) {
    const f = l.repo ? facts[l.repo] : null;
    const a = f ? assessProof(f) : { proof: 0, flags: 'repo_unknown' };
    l.proof = a.proof; l.flags = a.flags;
    l.stars = f ? f.stars : null; l.forks = f ? f.forks : null;
    l.paid_closed = f ? f.paid_closed : null; l.funded = f ? (f.funding ? 1 : 0) : null;
    // ゲート: 支払いの証拠が足りない候補は「着手推奨」のままにしない
    if (l.verdict === 'pursue' && l.proof < PROOF_MIN) { l.verdict = 'unbacked'; unbacked++; }
    l.reason = `${l.reason} / 証拠${l.proof}${l.flags ? `(${l.flags})` : ''}`;
  }
  leads.sort((a, b) => (RANK[b.verdict] || 0) - (RANK[a.verdict] || 0) || b.score - a.score);

  let saved = 0;
  for (const l of leads.slice(0, 120)) {
    try {
      await store.run(
        `INSERT INTO ${BL} (key,url,title,repo,source,payout_usd,score,verdict,reason,state,note,created_at,updated_at,proof,flags,stars,forks,paid_closed,funded)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET payout_usd=excluded.payout_usd, score=excluded.score,
           verdict=excluded.verdict, reason=excluded.reason, updated_at=excluded.updated_at,
           proof=excluded.proof, flags=excluded.flags, stars=excluded.stars, forks=excluded.forks,
           paid_closed=excluded.paid_closed, funded=excluded.funded`,
        l.key, l.url, l.title, l.repo, l.source, l.payout, l.score, l.verdict, l.reason,
        'new', null, at, at, l.proof, l.flags, l.stars, l.forks, l.paid_closed, l.funded
      );
      saved++;
    } catch (e) { /* 重複等は無視 */ }
  }
  await setSetting(store, 'bounty:last_scan_at', at).catch(() => {});
  const known = leads.filter((x) => x.payout).length;
  const pursue = leads.filter((x) => x.verdict === 'pursue');
  const est = pursue.reduce((a, x) => a + (x.payout || 0), 0);
  return {
    version: BOUNTY_VERSION, at, scanned: leads.length, saved,
    repos_checked: repos.length, repos_failed: repos.filter((r) => !facts[r]).length,
    with_payout: known,
    pursue: pursue.length,
    study: leads.filter((x) => x.verdict === 'study').length,
    unbacked,
    proven_usd: est, errors, top: leads.slice(0, 10),
  };
}

export async function bountyBoard(store, { limit = 30 } = {}) {
  await ensureBounty(store);
  const list = await store.all(
    `SELECT key,url,title,repo,source,payout_usd,score,verdict,reason,state,proof,flags,stars,paid_closed,funded,updated_at
     FROM ${BL} WHERE verdict <> 'skip' ORDER BY proof DESC, score DESC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 30))}`
  ).catch(() => []);
  const totals = await store.first(
    `SELECT COUNT(*) n, SUM(CASE WHEN payout_usd IS NOT NULL THEN 1 ELSE 0 END) paid,
            SUM(CASE WHEN verdict='pursue' THEN 1 ELSE 0 END) pursue,
            SUM(CASE WHEN verdict='unbacked' THEN 1 ELSE 0 END) unbacked,
            SUM(CASE WHEN verdict='pursue' THEN payout_usd ELSE 0 END) usd FROM ${BL}`
  ).catch(() => null);
  const last = await setting(store, 'bounty:last_scan_at', null).catch(() => null);
  return { version: BOUNTY_VERSION, last_scan_at: last, totals: totals || {}, leads: list || [] };
}

export function bountyText(b = {}) {
  const L = b.leads || [];
  const t = b.totals || {};
  const lines = [
    `報奨金レーン（バウンティ） 最終巡回 ${b.last_scan_at || '未実行'}`,
    `候補 ${t.n || 0} 件 / 金額が読めたもの ${t.paid || 0} / 着手推奨 ${t.pursue || 0} / 証拠不足 ${t.unbacked || 0}`,
    '',
  ];
  for (const l of L.slice(0, 20)) {
    lines.push(`${l.payout_usd ? `$${l.payout_usd}` : '   ?'} [${l.verdict}|点${l.score}|証拠${l.proof == null ? '-' : l.proof}] ${String(l.title || '').slice(0, 100)}`);
    lines.push(`      ${l.repo || ''} ${l.url || ''}${l.flags ? ` (${l.flags})` : ''}`);
  }
  return lines.join('\n');
}
