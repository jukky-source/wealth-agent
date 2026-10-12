// Opportunity Ranking Engine
// Scores every candidate on the 14 dimensions the brief requires, then allocates
// the agent's scarce resources (time + free-tier calls) to the best options.
// Weights shift with the character: an ambitious businessman favours upside and
// speed, a cold researcher favours evidence and risk.

import { nowIso, j, round, clamp, safeJson } from '../util.js';
import { BASIS } from '../truth.js';

export const DIMENSIONS = [
  'initial_cost', 'recurring_cost', 'time_cost', 'automation', 'time_to_revenue',
  'upside', 'evidence', 'risk', 'durability', 'cashability', 'japan', 'tos',
  'verified_results', 'strategic_fit',
];

export function scoreOpportunity(opp, { character, memories = [] } = {}) {
  const w = character?.priority_weights || { upside: 0.30, speed: 0.20, evidence: 0.25, risk: 0.15, cost: 0.10 };
  const d = {};
  const notes = [];

  // ---- cost (lower is better) ----
  const initial = Number(opp.initial_cost) || 0;
  const recurring = Number(opp.recurring_cost) || 0;
  d.initial_cost = initial <= 0 ? 1 : clamp(1 - initial / 100000, 0, 1);
  d.recurring_cost = recurring <= 0 ? 1 : clamp(1 - recurring / 30000, 0, 1);
  d.time_cost = opp.hours_per_week ? clamp(1 - (Number(opp.hours_per_week) - 2) / 38, 0.05, 1) : 0.5;

  // ---- automation / speed ----
  d.automation = clamp((Number(opp.automation) || 0) / 100, 0, 1);
  const ttr = Number(opp.time_to_revenue_days);
  d.time_to_revenue = isFinite(ttr) && ttr > 0 ? clamp(1 - ttr / 365, 0, 1) : 0.3;

  // ---- upside (log-scaled monthly revenue) ----
  const rev = Number(opp.est_monthly_revenue) || 0;
  d.upside = rev > 0 ? clamp(Math.log10(1 + rev / 1000) / Math.log10(1 + 1000), 0, 1) : 0.15;

  // ---- evidence quality ----
  const basisScore = { measured: 1, third_party: 0.7, estimated: 0.4, unverified: 0.15 }[opp.revenue_basis] ?? 0.15;
  const urlCount = (safeJson(opp.evidence_urls, []) || []).length;
  d.evidence = clamp(basisScore * 0.75 + Math.min(1, urlCount / 5) * 0.25, 0, 1);
  if (opp.revenue_basis === 'unverified') notes.push('収益根拠が未確認');
  if (!urlCount) notes.push('出典URLなし');

  // ---- risk (higher score = safer) ----
  const riskText = String(opp.risk || '');
  let riskPenalty = /高|重大|規約違反|violation|不可逆/.test(riskText) ? 0.7 : /中|medium/.test(riskText) ? 0.4 : 0.2;
  if (opp.tos_compliance === 'violation') riskPenalty = 1;
  else if (opp.tos_compliance === 'risky') riskPenalty = Math.max(riskPenalty, 0.6);
  d.risk = clamp(1 - riskPenalty, 0, 1);

  d.durability = /高|永続|継続|stock|資産/.test(String(opp.durability)) ? 0.85 : /低|一時/.test(String(opp.durability)) ? 0.3 : 0.5;
  d.cashability = /高|即|現金|出金可能/.test(String(opp.cashability)) ? 0.9 : /低|限定的/.test(String(opp.cashability)) ? 0.3 : 0.5;
  d.japan = { yes: 1, conditional: 0.6, unknown: 0.35, no: 0 }[opp.japan_availability] ?? 0.35;
  d.tos = { ok: 1, unknown: 0.5, risky: 0.25, violation: 0 }[opp.tos_compliance] ?? 0.5;
  d.verified_results = /計測値|実測/.test(String(opp.verified_results)) ? 0.9 : /未検証|未確認/.test(String(opp.verified_results)) ? 0.15 : 0.4;

  // ---- strategic fit: learn from rejections and failures ----
  const rejectedHit = memories.some((m) => m.kind === 'rejected' && (m.data?.name || '').toLowerCase() === String(opp.name).toLowerCase());
  d.strategic_fit = rejectedHit ? 0 : 0.75;

  // Hard blocks
  const blocked = [];
  if (opp.japan_availability === 'no') blocked.push('日本から利用不可');
  if (opp.tos_compliance === 'violation') blocked.push('利用規約違反');

  const groupWeight = (k) => {
    if (['initial_cost', 'recurring_cost', 'time_cost'].includes(k)) return w.cost;
    if (k === 'time_to_revenue') return w.speed;
    if (['evidence', 'verified_results'].includes(k)) return w.evidence;
    if (k === 'risk') return w.risk;
    if (k === 'upside') return w.upside;
    const rest = ['automation', 'durability', 'cashability', 'japan', 'tos', 'strategic_fit'];
    return (1 - (w.cost + w.speed + w.evidence + w.risk + w.upside)) / rest.length;
  };

  let raw = 0;
  let totalW = 0;
  for (const k of DIMENSIONS) {
    const ww = groupWeight(k);
    raw += d[k] * ww;
    totalW += ww;
  }
  let score = round((raw / (totalW || 1)) * 100, 2);
  if (blocked.length) score = 0;

  return {
    score,
    blocked,
    notes,
    breakdown: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round(v, 3)])),
    weights: w,
    explanation: `${d.evidence > 0.6 ? '証拠が比較的厚い' : '証拠が薄い'} / 収益根拠=${opp.revenue_basis} / 日本${opp.japan_availability} / 規約${opp.tos_compliance}`,
  };
}

export function createRanking({ store, memory }) {
  /**
   * Rank all opportunities, persist the scores, and return the allocation view:
   * which candidate should receive the next block of the agent's resources.
   */
  async function rank(storeRef, { domain = null, persist = true, character = null, limit = 50 } = {}) {
    const rows = domain
      ? await storeRef.all(`SELECT * FROM opportunities WHERE domain=? LIMIT ?`, domain, limit)
      : await storeRef.all(`SELECT * FROM opportunities LIMIT ?`, limit * 2);

    const memories = await memory.guardrails('global');
    const scored = rows.map((o) => {
      const s = scoreOpportunity(o, { character, memories });
      return { ...o, ...s };
    }).sort((a, b) => b.score - a.score);

    if (persist) {
      const stmts = scored.map((s) => ({
        sql: `UPDATE opportunities SET score=?, score_breakdown=?, updated_at=? WHERE id=?`,
        params: [s.score, j({ breakdown: s.breakdown, weights: s.weights, notes: s.notes, blocked: s.blocked, explanation: s.explanation }), nowIso(), s.id],
      }));
      if (stmts.length) await storeRef.batch(stmts);
      await storeRef.run(`INSERT INTO settings (key,value,updated_at) VALUES ('ranking:last',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        j({ at: nowIso(), total: scored.length, top: scored.slice(0, 5).map((s) => ({ id: s.id, name: s.name, score: s.score })) }), nowIso());
    }

    // Resource allocation: the top candidates that are actually actionable.
    const actionable = scored.filter((s) => !s.blocked.length && s.score > 0);
    const allocation = actionable.slice(0, 5).map((s, i) => ({
      opportunity_id: s.id, name: s.name, domain: s.domain, score: s.score,
      share: i === 0 ? 0.4 : i === 1 ? 0.25 : i === 2 ? 0.15 : 0.1,
      next_step: nextStepFor(s),
      rationale: s.explanation,
    }));

    return {
      total: scored.length,
      top: scored.slice(0, 10).map((s) => ({
        id: s.id, name: s.name, domain: s.domain, score: s.score,
        score_breakdown: s.breakdown, blocked: s.blocked, revenue_basis: s.revenue_basis,
        est_monthly_revenue: s.est_monthly_revenue,
      })),
      allocation,
      byDomain: summarizeByDomain(scored),
      blocked: scored.filter((s) => s.blocked.length).map((s) => ({ id: s.id, name: s.name, reasons: s.blocked })),
      disclaimer: 'スコアは推定に基づく優先度です。実際の収益ではありません（実測/推定は別管理）。',
    };
  }

  /** Recompute priorities after real outcomes are measured. */
  async function recalibrate(storeRef, { character = null } = {}) {
    const rows = await storeRef.all(`SELECT * FROM opportunities`);
    const ledger = await storeRef.all(`SELECT * FROM ledger WHERE kind='revenue'`);
    const measuredByOpp = {};
    for (const l of ledger) {
      if (l.basis !== 'measured' || !l.opportunity_id) continue;
      measuredByOpp[l.opportunity_id] = (measuredByOpp[l.opportunity_id] || 0) + l.amount;
    }
    const adjustments = [];
    for (const o of rows) {
      const measured = measuredByOpp[o.id];
      if (measured === undefined) continue;
      const predicted = Number(o.est_monthly_revenue) || 0;
      const error = predicted - measured;
      adjustments.push({ id: o.id, name: o.name, predicted, measured, error });
      // If we consistently over-predict, lower the estimate — but never turn an
      // estimate into a measured figure.
      await storeRef.run(`UPDATE opportunities SET est_monthly_revenue=?, verified_results=?, updated_at=? WHERE id=?`,
        Math.max(0, (predicted * 0.5 + measured * 0.5)),
        `${o.verified_results || ''} / 実測収益 ${measured} JPY を反映`.trim(), nowIso(), o.id);
    }
    return {
      adjusted: adjustments.length,
      adjustments,
      note: adjustments.length
        ? '推定値を実測で補正しました（推定は推定のまま、実測は実測として記録）。'
        : '実測収益がまだ無いため補正は行っていません。',
    };
  }

  return { rank, recalibrate, scoreOpportunity };
}

function nextStepFor(s) {
  const b = s.breakdown || {};
  if (b.evidence < 0.5) return '一次情報（公式/規約/実測報告）を追加取得して根拠を強化する';
  if (s.domain === 'fx') return 'バックテストと非リペイント検査を通過させ、デモ検証に進む';
  if (s.domain === 'rewards') return '換金条件と最低換金額を公式規約で確定し、実際の獲得額を計測する';
  if (s.domain === 'side_hustle') return 'MVPを作成し、公開して訪問→登録→成約の計測を開始する';
  return '検証計画を立てて実行する';
}

function summarizeByDomain(scored) {
  const out = {};
  for (const s of scored) {
    out[s.domain] = out[s.domain] || { count: 0, avgScore: 0, bestScore: 0, blocked: 0 };
    out[s.domain].count++;
    out[s.domain].avgScore += s.score;
    out[s.domain].bestScore = Math.max(out[s.domain].bestScore, s.score);
    if (s.blocked.length) out[s.domain].blocked++;
  }
  for (const k of Object.keys(out)) out[k].avgScore = round(out[k].avgScore / out[k].count, 1);
  return out;
}

export { BASIS };
