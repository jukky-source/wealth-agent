// AI Peer Review — role separation without paying for five frontier models.
// Planner / Executor / Critic / Verifier / Optimizer each get a distinct system
// prompt and are routed to whichever free provider fits the job. With no key at
// all, a deterministic rubric reviewer still produces a usable critique.

import { truncate, safeJson, round } from '../util.js';
import { characterSystemPrompt } from '../ai/prompts.js';

export const ROLES = {
  planner: '計画を作成する。実行可能な最小ステップに分解し、依存関係と優先順位を明示する。',
  executor: 'タスクを実行する。与えられた道具と制約の中で最大の成果を出す。',
  critic: '計画や成果物を批判的に評価する。楽観的な前提、根拠のない数値、見落としを指摘する。',
  verifier: 'テストと根拠を確認する。証拠がなければ不合格とする。',
  optimizer: '改善案を作成する。効果が計測可能な、具体的で小さな変更に限る。',
};

/**
 * Run a multi-role review over an artifact (plan, report, strategy, code).
 * @returns {{reviews:Array, consensus:{verdict,score,blockers}, cost:{calls,providers}}}
 */
export async function runPeerReview({ router, character, artifact, artifactType = 'plan', question = null, roles = ['critic', 'verifier', 'optimizer'] }) {
  const reviews = [];
  const calls = [];
  const payload = typeof artifact === 'string' ? artifact : JSON.stringify(artifact);
  const clipped = truncate(payload, 5000);

  for (const role of roles) {
    const system = `${characterSystemPrompt(character, { role })}
あなたの役割: ${ROLES[role]}
他の役割の仕事を奪わないこと。${role === 'verifier' ? '証拠の有無だけで判定すること。' : ''}`;

    const user = `# 評価対象 (${artifactType})
${clipped}
${question ? `\n# 元の問い\n${question}` : ''}

JSONのみ:
{"verdict":"approve|revise|reject","score":0-100,"strengths":["..."],"issues":[{"severity":"high|medium|low","issue":"...","fix":"..."}],"evidence_gaps":["..."],"confidence":"high|medium|low"}`;

    const r = await router.complete({ role: role === 'verifier' ? 'verifier' : role, system, user, json: true,
      schema: ['verdict', 'score', 'strengths', 'issues', 'evidence_gaps', 'confidence'], maxTokens: 900, temperature: 0.3 });

    const j = r.json;
    if (j) {
      reviews.push({ role, ...j, provider: r.provider, model: r.model, fallback: !!r.fallback });
    } else {
      reviews.push({ ...deterministicReview(role, artifact, artifactType), provider: r.provider, fallback: true });
    }
    calls.push({ role, provider: r.provider, fallback: !!r.fallback });
  }

  const issues = reviews.flatMap((r) => (r.issues || []).map((i) => ({ ...i, role: r.role })));
  const high = issues.filter((i) => i.severity === 'high');
  const scores = reviews.map((r) => Number(r.score)).filter((n) => isFinite(n));
  const score = scores.length ? round(scores.reduce((s, v) => s + v, 0) / scores.length, 1) : null;
  const rejects = reviews.filter((r) => r.verdict === 'reject').length;

  const verdict = rejects ? 'reject' : high.length ? 'revise' : 'approve';
  return {
    reviews,
    consensus: {
      verdict, score,
      blockers: high,
      totalIssues: issues.length,
      evidenceGaps: [...new Set(reviews.flatMap((r) => r.evidence_gaps || []))],
      note: verdict === 'approve'
        ? '重大な指摘はありませんでした（検証は推定ベースであり、実測の保証ではありません）。'
        : '修正が必要な指摘があります。修正後に再レビューしてください。',
    },
    cost: { calls: calls.length, providers: [...new Set(calls.map((c) => c.provider))], allFallback: calls.every((c) => c.fallback) },
  };
}

/** Deterministic rubric — used with no AI budget, and as a safety net when a
 *  provider returns unusable output. It never claims more than it checks. */
export function deterministicReview(role, artifact, type) {
  const text = typeof artifact === 'string' ? artifact : JSON.stringify(artifact);
  const issues = [];
  const gaps = [];

  const hasNumbers = /\d/.test(text);
  const hasSources = /https?:\/\//.test(text);
  const hasUnverified = /未確認|unverified|推定/.test(text);
  const hasMeasuredClaim = /measured|実測/.test(text);
  const length = text.length;

  if (length < 200) issues.push({ severity: 'medium', issue: '内容が短すぎて判断根拠として不十分です', fix: '一次情報の追記と具体化' });
  if (hasMeasuredClaim && !hasSources) {
    issues.push({ severity: 'high', issue: '実測と主張しているが証拠URLがありません', fix: '出典または計測記録を添付するか、basis を unverified に変更' });
    gaps.push('実測主張の裏付け');
  }
  if (type === 'income' && !hasUnverified && hasNumbers) {
    issues.push({ severity: 'medium', issue: '収益数値の basis（実測/第三者/推定/未確認）が明示されていません', fix: '各数値に区分を付与' });
  }
  if (!hasNumbers) issues.push({ severity: 'low', issue: '定量的な裏付けがありません', fix: '可能な範囲で計測値を追加' });
  if (/必ず|確実に|絶対/.test(text)) issues.push({ severity: 'medium', issue: '断定表現があります', fix: '確率・条件付き表現に修正' });

  const score = Math.max(20, 85 - issues.reduce((s, i) => s + ({ high: 25, medium: 12, low: 5 }[i.severity] || 5), 0));
  return {
    verdict: issues.some((i) => i.severity === 'high') ? 'revise' : 'approve',
    score, strengths: [hasSources ? '出典URLが含まれている' : '構造化されている'].filter(Boolean),
    issues, evidence_gaps: gaps, confidence: 'low',
    mode: 'deterministic_rubric',
    note: 'AIキー未設定のためルールベースのレビューを実施しました（内容そのものの真偽は検証していません）。',
  };
}
