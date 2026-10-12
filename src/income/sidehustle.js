// Side Hustle Agent — affiliate, ads, micro-SaaS, digital products, web tools,
// content sites, automation services, work-without-interview online gigs.
// Focus: demand evidence + competition + cost + distribution + difficulty.
// Publishing a site is NOT revenue: the module records measurable funnels only
// (visits / signups / clicks / conversions / sales) and treats everything else
// as pre-revenue.

import { id as newId, nowIso, j, truncate, hash, safeJson } from '../util.js';
import { BASIS } from '../truth.js';
import { asUntrusted } from '../safety.js';

export const FUNNEL_METRICS = ['visits', 'signups', 'clicks', 'conversions', 'sales', 'revenue_measured'];

export function createSideHustle({ store, router, research: researchEngine, memory }) {
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
    const evidence = [];
    for (const s of sources.slice(0, 8)) {
      if (!/docs|公式|official|github|indiehackers|producthunt|stripe|note\.com|zenn/i.test(`${s.url} ${s.title}`)) continue;
      const p = await researchEngine.fetch(s.url, { store });
      if (p.ok && p.text.length > 300) evidence.push({ url: s.url, title: p.title || s.title, text: truncate(p.text, 3500) });
    }

    let extracted = null;
    if (router?.availableProviders().length && sources.length) {
      const block = [
        ...sources.slice(0, 10).map((s, i) => `[検索${i + 1}] ${s.title} | ${s.url}\n${truncate(s.snippet, 200)}`),
        ...evidence.map((e, i) => asUntrusted(`参考ページ_${i + 1}: ${e.url}`, e.text, 2000).block),
      ].join('\n---\n');
      const r = await router.complete({
        role: 'researcher',
        system: 'あなたは個人開発・ネット収益の実務リサーチャーです。需要・競合・コスト・集客経路・実行難易度を証拠ベースで評価します。収益は必ず basis を明示し、未確認の収益を実績として扱いません。',
        user: `テーマ: ${topic}
# 却下済み（再提案禁止）
${rejectedNames.size ? [...rejectedNames].join(', ') : 'なし'}
# 情報
${block}

JSONのみ:
{"candidates":[{"name":"...","summary":"...","initial_cost":0,"recurring_cost":0,"hours_per_week":0,"automation":0,"time_to_revenue_days":0,"est_monthly_revenue":0,"revenue_basis":"unverified","evidence_urls":[],"risk":"...","durability":"...","cashability":"...","japan_availability":"yes|conditional|unknown|no","tos_compliance":"ok|risky|unknown","demand_evidence":"...","competition":"...","distribution":"...","difficulty":"...","mvp_scope":"...","measurable_funnel":["visits","signups"]}],
"notes":[],"searched_summary":"..."}`,
        json: true, schema: ['candidates', 'notes', 'searched_summary'], maxTokens: 2400, temperature: 0.3,
      });
      extracted = r.json;
    }
    if (!extracted?.candidates?.length) {
      extracted = { candidates: deterministicCandidates(topic, sources), notes: ['AIキー未設定のため出典から機械的に抽出（需要・競合の評価は未実施）。'] };
    }

    const saved = [];
    for (const c of (extracted.candidates || []).slice(0, limit)) {
      if (!c?.name) continue;
      if (rejectedNames.has(String(c.name).toLowerCase())) continue;
      const urls = (c.evidence_urls || []).filter((u) => /^https?:\/\//.test(u));
      let basis = ['measured', 'third_party', 'estimated', 'unverified'].includes(c.revenue_basis) ? c.revenue_basis : 'unverified';
      if (basis === 'measured' && !urls.length) basis = 'unverified';

      const row = {
        id: newId('opp'), domain: 'side_hustle', name: String(c.name).slice(0, 120),
        summary: truncate(`${c.summary || ''}\n需要: ${c.demand_evidence || '未評価'} / 競合: ${c.competition || '未評価'} / 集客: ${c.distribution || '未評価'} / 難易度: ${c.difficulty || '未評価'} / MVP: ${c.mvp_scope || '未定義'} / 計測指標: ${(c.measurable_funnel || []).join(',') || '未定義'}`, 1200),
        initial_cost: num(c.initial_cost), recurring_cost: num(c.recurring_cost),
        hours_per_week: num(c.hours_per_week), automation: clampInt(c.automation),
        time_to_revenue_days: num(c.time_to_revenue_days),
        est_monthly_revenue: num(c.est_monthly_revenue), revenue_basis: basis,
        evidence_urls: j(urls),
        risk: truncate(c.risk || '未評価', 300),
        durability: truncate(c.durability || '不明', 200),
        cashability: truncate(c.cashability || '不明', 200),
        japan_availability: ['yes', 'no', 'conditional', 'unknown'].includes(c.japan_availability) ? c.japan_availability : 'unknown',
        tos_compliance: ['ok', 'risky', 'violation', 'unknown'].includes(c.tos_compliance) ? c.tos_compliance : 'unknown',
        verified_results: '未検証（公開・計測前。収益は発生していません）',
        status: 'candidate', rejection_reason: null, score: 0, score_breakdown: null,
        created_at: nowIso(), updated_at: nowIso(),
      };
      const existing = await store.first('SELECT * FROM opportunities WHERE domain=? AND name=?', 'side_hustle', row.name);
      if (existing) { await store.update('opportunities', existing.id, { ...row, id: undefined, created_at: undefined }); saved.push({ ...existing, ...row }); }
      else { await store.insert('opportunities', row); saved.push(row); }
    }

    await memory.write({
      kind: 'experience', scope: mission ? `mission:${mission.id}` : 'global',
      key: `sidehustle:${hash(topic)}`,
      text: `副業調査「${truncate(topic, 60)}」: 候補${saved.length}件 / 出典${sources.length}件。公開・計測前は収益ゼロとして扱う。`,
      evidence: 'third_party', importance: 50,
    });

    return { candidates: saved, rejected: rejectedRows.map((r) => ({ name: safeJson(r.data_json, {})?.name, reason: r.text })), sources, notes: extracted.notes || [], summary: extracted.searched_summary || '' };
  }

  /**
   * Record measurable funnel data for a shipped project. Only here can
   * measured revenue ever appear — and it requires a source/receipt.
   */
  async function recordFunnel({ opportunityId, metrics, source = null, occurredOn = null }) {
    const clean = {};
    for (const k of FUNNEL_METRICS) if (metrics?.[k] !== undefined) clean[k] = Number(metrics[k]) || 0;
    const revenue = clean.revenue_measured || 0;
    const basis = revenue > 0 ? (source ? BASIS.MEASURED : BASIS.UNVERIFIED) : BASIS.MEASURED;
    if (revenue > 0) {
      await store.insert('ledger', {
        id: newId('led'), kind: 'revenue', amount: revenue, currency: 'JPY', basis,
        source: source || null, opportunity_id: opportunityId,
        occurred_on: occurredOn || new Date().toISOString().slice(0, 10),
        note: `funnel: ${JSON.stringify(clean)}`, created_at: nowIso(),
      });
    }
    const opp = await store.get('opportunities', opportunityId);
    await store.update('opportunities', opportunityId, {
      verified_results: truncate(`計測値(${occurredOn || 'today'}): ${JSON.stringify(clean)}${revenue > 0 && source ? ` / 証拠: ${source}` : ''}`, 600),
      status: revenue > 0 && source ? 'running' : (opp?.status || 'candidate'),
      updated_at: nowIso(),
    });
    return { ok: true, metrics: clean, revenue_basis: basis, note: revenue > 0 && !source ? '証拠URLが無いため収益は未確認として記録しました' : null };
  }

  async function list({ limit = 100 } = {}) {
    const rows = await store.all(`SELECT * FROM opportunities WHERE domain='side_hustle' ORDER BY score DESC, created_at DESC LIMIT ?`, limit);
    return rows.map((r) => ({ ...r, evidence_urls: safeJson(r.evidence_urls, []) }));
  }

  return { research, recordFunnel, list };
}

function buildQueries(topic) {
  const base = String(topic || '副業').slice(0, 80);
  return [
    `${base} 収益 事例 実績 2026`,
    `${base} 需要 市場 データ 検索ボリューム`,
    `micro SaaS side project revenue report indie hackers`,
    `個人開発 Webツール マネタイズ 成功 事例 日本`,
    `online gig no interview flexible work worldwide`,
    `${base} 競合 比較 差別化`,
  ];
}

function deterministicCandidates(topic, sources) {
  const groups = new Map();
  for (const s of sources) {
    let host = '';
    try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(s);
  }
  const out = [];
  for (const [host, items] of groups) {
    out.push({
      name: truncate(items[0].title || host, 80),
      summary: truncate(items.map((i) => i.snippet).filter(Boolean).join(' / '), 900),
      revenue_basis: 'unverified', evidence_urls: items.map((i) => i.url).slice(0, 3),
      japan_availability: 'unknown', tos_compliance: 'unknown',
      automation: 0, difficulty: '未評価', demand_evidence: '未評価', competition: '未評価',
      distribution: '未評価', risk: '未評価', durability: '不明', cashability: '不明',
    });
  }
  return out.slice(0, 6);
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const clampInt = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
function dedupe(arr) { const m = new Map(); for (const x of arr) if (x?.url && !m.has(x.url)) m.set(x.url, x); return [...m.values()]; }
