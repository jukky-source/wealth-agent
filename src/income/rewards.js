// Rewards & Passive Income Agent (ポイ活・報酬・放置型収益)
// Japan-first verification. A service is only registered as a *candidate* with
// japan_availability='yes' when the evidence supports it; otherwise it is
// recorded as 'unknown'/'conditional' with the reason. Nothing is invented:
// if the search yields no verifiable candidate, the agent reports the gap and
// changes its search angle instead of fabricating a payout.

import { id as newId, nowIso, j, truncate, hash, safeJson } from '../util.js';
import { BASIS } from '../truth.js';
import { asUntrusted } from '../safety.js';

export const VERIFICATION_FIELDS = [
  'japan_availability', 'signup_conditions', 'supported_devices', 'required_actions',
  'min_payout', 'payout_methods', 'payout_fees', 'payout_conditions',
  'tos_compliance', 'time_cost', 'evidence_urls',
];

export function createRewards({ store, router, research: researchEngine, memory }) {
  /**
   * @returns {{candidates:Array, rejected:Array, searched:number, sources:Array, notes:Array}}
   */
  async function research({ topic, limit = 6, mission = null, character = null }) {
    const scope = mission ? `mission:${mission.id}` : 'global';
    const rejectedRows = await memory.byKinds(['rejected'], scope, 200);
    const rejectedNames = new Set(rejectedRows.map((r) => (safeJson(r.data_json, {})?.name || '').toLowerCase()).filter(Boolean));

    const queries = buildQueries(topic);
    const pool = [];
    for (const q of queries) {
      const s = await researchEngine.search(q, { limit: 5 });
      for (const src of s.sources) pool.push({ ...src, query: q });
    }
    const sources = dedupe(pool);

    // Official/informative pages get fetched so条件 can be read from the source.
    const evidence = [];
    for (const s of sources.slice(0, 8)) {
      if (!/go\.jp|or\.jp|\.jp\/|official|公式|利用規約|terms/i.test(`${s.url} ${s.title} ${s.snippet}`)) continue;
      const p = await researchEngine.fetch(s.url, { store });
      if (!p.ok || p.text.length < 300) continue;
      evidence.push({ url: s.url, title: p.title || s.title, text: truncate(p.text, 4000) });
    }

    let extracted = null;
    if (router?.availableProviders().length && (sources.length || evidence.length)) {
      const block = [
        ...sources.slice(0, 8).map((s, i) => `[検索${i + 1}] ${s.title} | ${s.url}\n${truncate(s.snippet, 220)}`),
        ...evidence.map((e, i) => asUntrusted(`公式/規約ページ_${i + 1}: ${e.url}`, e.text, 2200).block),
      ].join('\n---\n');
      const r = await router.complete({
        role: 'researcher',
        system: 'あなたは日本のポイ活・報酬サービスの実務リサーチャーです。確認できた事実のみを記録し、不明な項目は必ず "unknown" とします。存在しないサービス・存在しない換金実績を絶対に創作しません。',
        user: `調査テーマ: ${topic}

# 既に却下された候補（再提案しない）
${rejectedNames.size ? [...rejectedNames].join(', ') : 'なし'}

# 取得した情報
${block}

# 指示
日本から実際に利用できる候補のみを抽出してください。確認できない項目は "unknown" にしてください。
収益見込みは必ず basis を明示（measured=自分の実測 / third_party=第三者報告 / estimated=推定 / unverified=未確認）。
換金実績の報告が見つからない場合は basis を unverified としてください。捏造は禁止です。

JSONのみ:
{"candidates":[{"name":"...","summary":"...","initial_cost":0,"recurring_cost":0,"hours_per_week":0,"automation":0,"time_to_revenue_days":0,"est_monthly_revenue":0,"revenue_basis":"unverified","evidence_urls":["https://..."],"risk":"...","durability":"...","cashability":"...","japan_availability":"yes|no|conditional|unknown","tos_compliance":"ok|risky|violation|unknown","verified_results":"...","min_payout":"...","payout_methods":"...","payout_fees":"...","payout_conditions":"...","signup_conditions":"...","supported_devices":"...","required_actions":"...","reject_reason":null}],
"notes":["確認できなかった点"],
"searched_summary":"..."}`,
        json: true, schema: ['candidates', 'notes', 'searched_summary'], maxTokens: 2200, temperature: 0.2,
      });
      extracted = r.json;
    }

    // ---- deterministic fallback: build candidates from retrieved sources ----
    if (!extracted?.candidates?.length) {
      extracted = { candidates: deterministicCandidates(topic, sources, evidence), notes: [], searched_summary: '' };
      extracted.notes.push('AIキー未設定のため、取得した出典から機械的に候補を抽出しました（条件の確定は未実施）。');
    }

    const saved = [];
    for (const c of (extracted.candidates || []).slice(0, limit)) {
      if (!c?.name) continue;
      const key = String(c.name).toLowerCase();
      if (rejectedNames.has(key)) { continue; }
      const urls = (c.evidence_urls || []).filter((u) => /^https?:\/\//.test(u));

      // Hard rule: 'yes' availability and 'measured' revenue both require evidence.
      let availability = ['yes', 'no', 'conditional', 'unknown'].includes(c.japan_availability) ? c.japan_availability : 'unknown';
      if (availability === 'yes' && !urls.length) availability = 'unknown';
      let basis = ['measured', 'third_party', 'estimated', 'unverified'].includes(c.revenue_basis) ? c.revenue_basis : 'unverified';
      if (basis === 'measured' && !urls.length) basis = 'unverified';

      const row = {
        id: newId('opp'), domain: 'rewards', name: String(c.name).slice(0, 120),
        summary: truncate(c.summary || '', 700),
        initial_cost: num(c.initial_cost), recurring_cost: num(c.recurring_cost),
        hours_per_week: num(c.hours_per_week), automation: clampInt(c.automation),
        time_to_revenue_days: num(c.time_to_revenue_days),
        est_monthly_revenue: num(c.est_monthly_revenue),
        revenue_basis: basis,
        evidence_urls: j(urls),
        risk: truncate(c.risk || '未評価', 300),
        durability: truncate(c.durability || '不明', 200),
        cashability: truncate(c.cashability || '不明', 200),
        japan_availability: availability,
        tos_compliance: ['ok', 'risky', 'violation', 'unknown'].includes(c.tos_compliance) ? c.tos_compliance : 'unknown',
        verified_results: truncate(c.verified_results || '未確認', 500),
        status: availability === 'no' ? 'rejected' : 'candidate',
        rejection_reason: availability === 'no' ? '日本から利用不可' : (c.reject_reason || null),
        score: 0, score_breakdown: null,
        created_at: nowIso(), updated_at: nowIso(),
      };
      // Attach the verification detail (kept in summary fields to avoid schema churn)
      row.summary = `${row.summary}\n最低換金: ${c.min_payout || 'unknown'} / 換金方法: ${c.payout_methods || 'unknown'} / 手数料: ${c.payout_fees || 'unknown'} / 条件: ${c.payout_conditions || 'unknown'} / 登録条件: ${c.signup_conditions || 'unknown'} / 端末: ${c.supported_devices || 'unknown'} / 必要操作: ${c.required_actions || 'unknown'}`;

      const existing = await store.first('SELECT * FROM opportunities WHERE domain=? AND name=?', 'rewards', row.name);
      if (existing) {
        await store.update('opportunities', existing.id, { ...row, id: undefined, created_at: undefined });
        saved.push({ ...existing, ...row });
      } else {
        await store.insert('opportunities', row);
        saved.push(row);
      }
    }

    // Try to find real payout reports (third-party evidence), never invent them.
    for (const c of saved) {
      if (c.revenue_basis === 'unverified') {
        const rp = await researchEngine.search(`${c.name} 換金 実際 受け取った 報告`, { limit: 4 });
        const report = rp.sources.filter((s) => !/公式|official/.test(s.title));
        if (report.length) {
          const urls = safeJson(c.evidence_urls, []);
          await store.update('opportunities', c.id, {
            evidence_urls: j(dedupe([...urls, ...report.map((r) => r.url)]).slice(0, 6)),
            verified_results: truncate(`第三者による換金報告と思われる記述が ${report.length} 件見つかりました（内容は未精査・未確認）: ${report.map((r) => r.title).join(' / ')}`, 500),
            updated_at: nowIso(),
          });
        }
      }
    }

    await memory.write({
      kind: 'experience', scope: mission ? `mission:${mission.id}` : 'global',
      key: `rewards:${hash(topic)}`,
      text: `ポイ活調査「${truncate(topic, 60)}」: 候補${saved.length}件 / 出典${sources.length}件。確認できない条件は未確認として記録。`,
      evidence: 'third_party', importance: 50,
    });

    return { candidates: saved, rejected: rejectedRows.map((r) => ({ name: safeJson(r.data_json, {})?.name, reason: r.text })), searched: sources.length, sources, notes: extracted.notes || [], summary: extracted.searched_summary || '' };
  }

  /** Reject a candidate with a reason — recorded so it is never re-proposed. */
  async function reject(store2, { opportunityId, reason, name }) {
    await store2.run('UPDATE opportunities SET status=?, rejection_reason=?, updated_at=? WHERE id=?', 'rejected', reason, nowIso(), opportunityId);
    await memory.write({
      kind: 'rejected', key: `rejected:${String(name || opportunityId).toLowerCase()}`,
      text: `候補「${name || opportunityId}」を却下: ${reason}`, evidence: 'measured', importance: 65,
      data: { name },
    });
    return { ok: true };
  }

  async function list(store2, { limit = 100 } = {}) {
    const rows = await store2.all(`SELECT * FROM opportunities WHERE domain='rewards' ORDER BY score DESC, created_at DESC LIMIT ?`, limit);
    return rows.map((r) => ({ ...r, evidence_urls: safeJson(r.evidence_urls, []) }));
  }

  return { research, reject, list };
}

function buildQueries(topic) {
  const base = String(topic || 'ポイ活').slice(0, 80);
  return [
    `${base} 公式 換金 条件`,
    `${base} 2026 おすすめ 比較 換金実績`,
    `${base} 最低換金額 手数料 出金方法`,
    `${base} 利用規約 禁止事項 複数アカウント`,
    `ポイ活 ポイント 自動 積立 放置 稼ぐ 日本`,
  ];
}

function deterministicCandidates(topic, sources, evidence) {
  // Group sources by domain and emit one candidate per domain we actually saw.
  const groups = new Map();
  for (const s of sources) {
    let host = '';
    try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(s);
  }
  const out = [];
  for (const [host, items] of groups) {
    const ev = evidence.find((e) => { try { return new URL(e.url).hostname.replace(/^www\./, '') === host; } catch { return false; } });
    out.push({
      name: items[0].title ? truncate(items[0].title, 80) : host,
      summary: truncate(items.map((i) => i.snippet).filter(Boolean).join(' / '), 6000) || `${host} に関する情報`,
      hours_per_week: null, automation: 0, time_to_revenue_days: null, est_monthly_revenue: null,
      revenue_basis: 'unverified',
      evidence_urls: items.map((i) => i.url).slice(0, 3),
      japan_availability: /\.jp$|\.jp\/|日本|円/.test(`${host} ${items[0].snippet}`) ? 'conditional' : 'unknown',
      tos_compliance: 'unknown',
      verified_results: ev ? '規約/公式ページを取得済み（内容の精査は未実施）' : '未確認',
      risk: '未評価（AI抽出なし）', durability: '不明', cashability: '不明',
    });
  }
  return out.slice(0, 6);
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const clampInt = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
function dedupe(arr) { const m = new Map(); for (const x of arr) if (x?.url && !m.has(x.url)) m.set(x.url, x); return [...m.values()]; }
