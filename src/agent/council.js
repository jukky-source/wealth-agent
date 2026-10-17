// 議会（Council）— 異なる立場のAI同士を議論させ、合意点へ収束させる。
//
// なぜ効くのか（キー無しでも効果がある理由）:
//  * 同じ無料モデルでも、system プロンプトで立場を分けると見落としが変わる。
//    1つの回答を鵜呑みにするより、攻め・守り・検証・調整の視点を突き合わせた方が
//    結論の質が上がる。モデルを増やさずに多様性を出すのが要点。
//  * 事実の裏づけが無い主張は verifier 役が落とす（楽観的な数字を残さない）。
//  * 合意できなければ「決めない」も正しい結論として返す（無理に丸めない）。
//
// 節約:
//  * 各席はキャッシュ対象（同一テーマの再審議はAIを呼ばない）。
//  * 予算が尽きたら各席は決定的ルーブリックで議論を続ける（止めない）。

import { nowIso, truncate, j, safeJson, id as newId } from '../util.js';
import { characterSystemPrompt } from '../ai/prompts.js';

/** 議席（立場）。stance が違うほど議論が噛み合う。 */
export const SEATS = {
  proposer: {
    label: '攻め役',
    mission: '最も期待値の高い一点を選び、実行可能な提案として出す。機会損失を最小化する。',
    bias: '強気。ただし根拠のない数字は書かない。',
  },
  critic: {
    label: '守り役',
    mission: '提案の弱点・隠れた前提・失敗したときの損失を突く。反対の立場から最善を尽くす。',
    bias: '懐疑的。楽観を許さない。',
  },
  verifier: {
    label: '検証役',
    mission: '証拠の有無だけで判定する。検証できない主張は「未検証」として明示する。',
    bias: '実測主義。推定と実測を混同しない。',
  },
  chair: {
    label: '調整役',
    mission: '各席の意見を突き合わせ、いま取る行動を一つに決める。反対意見は消さずに添える。',
    bias: '中立。合意できない点は「合意できない」と書く。',
  },
};

export const DEFAULT_SEATS = ['proposer', 'critic', 'verifier'];

/** 決定的ルーブリック（予算が尽きたときの各席の代弁者）。 */
function deterministicSeat(seat, topic, context) {
  const text = `${topic}\n${context || ''}`;
  const hasUrl = /https?:\/\//.test(text);
  const hasNum = /\d/.test(text);
  if (seat === 'critic') {
    return {
      stance: 'revise',
      points: [
        !hasUrl ? '一次情報の出典が本文に無い（このまま実行しない）' : null,
        !hasNum ? '効果の定量化が無く、達成判定ができない' : null,
        '失敗したときの損失額と戻し方が書かれていない',
      ].filter(Boolean),
      risk: 'medium', confidence: 'low', mode: 'deterministic',
    };
  }
  if (seat === 'verifier') {
    return {
      stance: hasUrl ? 'approved_with_evidence' : 'unverified',
      evidence_gaps: hasUrl ? [] : ['主張を裏づける出典・計測記録が無い'],
      confidence: 'low', mode: 'deterministic',
    };
  }
  return {
    stance: 'propose',
    points: ['最小の検証から始め、結果で広げる（小口・短期で判断できる形にする）'],
    confidence: 'low', mode: 'deterministic',
  };
}

async function seatOpinion({ router, character, seat, topic, context, evidenceBlock = '', avoid = [] }) {
  const s = SEATS[seat];
  const system = `${characterSystemPrompt(character, { role: seat === 'critic' ? 'critic' : seat === 'verifier' ? 'verifier' : seat === 'chair' ? 'optimizer' : 'planner' })}
あなたの議席: ${s.label}
役割: ${s.mission}
姿勢: ${s.bias}
他の議席の仕事を奪わない。${seat === 'verifier' ? '証拠が無ければ必ず未検証と書く。' : ''}`;

  const user = `# 議題
${truncate(topic, 1200)}

# 材料（台帳・証拠・制約）
${truncate(evidenceBlock || context || '（なし）', 2200)}
${avoid.length ? `\n# これまでの指摘（繰り返さない）\n${avoid.slice(0, 6).map((a) => `- ${a}`).join('\n')}` : ''}

JSONのみ:
{"stance":"propose|revise|reject|unverified|approved_with_evidence|decide","summary":"一言で","points":["...","..."],"evidence_gaps":["..."],"risk":"high|medium|low","confidence":"high|medium|low"}`;

  const r = await router.complete({
    role: seat === 'chair' ? 'optimizer' : seat === 'verifier' ? 'verifier' : seat === 'critic' ? 'critic' : 'planner',
    system, user, json: true,
    schema: ['stance', 'summary', 'points', 'evidence_gaps', 'risk', 'confidence'],
    maxTokens: 700, temperature: seat === 'proposer' ? 0.7 : 0.3,
  });
  if (r.json) return { seat, label: s.label, ...r.json, provider: r.provider, model: r.model, fallback: !!r.fallback, cached: !!r.cached };
  return { seat, label: s.label, ...deterministicSeat(seat, topic, evidenceBlock || context), provider: r.provider, fallback: true };
}

/**
 * 議会を1回開く。攻め・守り・検証が意見を出し、調整役が合意点を決める。
 * @returns {{decision:{action,direction,confidence,dissent,blockers}, opinions:Array, cost:Object, consensus:Object}}
 */
export async function convene({ router, character, topic, context = '', evidenceBlock = '', seats = DEFAULT_SEATS, log = null }) {
  const opinions = [];

  // 第1ラウンド: 立場ごとに独立して意見を出す（同じモデルでも立場が違えば見落としが変わる）
  let avoid = [];
  for (const seat of seats) {
    const o = await seatOpinion({ router, character, seat, topic, context, evidenceBlock, avoid });
    opinions.push(o);
    avoid = avoid.concat((o.points || []).map((p) => `${SEATS[seat].label}: ${p}`)).slice(0, 8);
  }

  // 第2ラウンド: 調整役が突き合わせて、いま取る一つを決める
  const digest = opinions.map((o) => `## ${o.label}（${o.stance}）\n${o.summary || ''}\n${(o.points || []).map((p) => `- ${p}`).join('\n')}${(o.evidence_gaps || []).length ? `\n未検証: ${o.evidence_gaps.join(' / ')}` : ''}`).join('\n\n');
  const chair = await seatOpinion({
    router, character, seat: 'chair', topic,
    context: `${context}\n\n# 各席の意見\n${digest}`,
    evidenceBlock: `${evidenceBlock}\n\n# 各席の意見\n${digest}`,
  });
  opinions.push(chair);

  // 合意の決定的な要約（AIの言い回しに依存させない）
  const gaps = [...new Set(opinions.flatMap((o) => o.evidence_gaps || []))];
  const highRisk = opinions.some((o) => o.risk === 'high');
  const rejects = opinions.filter((o) => o.stance === 'reject').length;
  const unverified = opinions.filter((o) => o.stance === 'unverified').length;

  const verdict = rejects ? 'hold' : (gaps.length || unverified) ? 'verify_first' : 'proceed';
  const result = {
    at: nowIso(),
    topic: truncate(topic, 200),
    verdict,
    direction: chair.summary || (opinions[0]?.summary || null),
    blockers: gaps,
    dissent: opinions.filter((o) => ['revise', 'reject'].includes(o.stance)).map((o) => ({ seat: o.label, stance: o.stance, points: (o.points || []).slice(0, 3) })),
    confidence: chair.confidence || 'low',
    risk: highRisk ? 'high' : (opinions.some((o) => o.risk === 'medium') ? 'medium' : 'low'),
    note: verdict === 'proceed'
      ? '異議なく進められます（証拠は推定を含みます）。'
      : verdict === 'verify_first'
        ? '先に証拠を取るべき項目があります。取れるまで大きな支出はしません。'
        : '反対意見があるため、いまは進めません（保留）。',
  };
  const cost = { seats: opinions.length, allFallback: opinions.every((o) => o.fallback), cached: opinions.filter((o) => o.cached).length };

  if (log) await log(result).catch(() => {});
  return { decision: result, opinions, consensus: result, cost };
}

/** 議会の結論を保存する（後から「なぜそう決めたか」を辿れるように）。 */
export async function saveDecision(store, result, { missionId = null, source = 'council' } = {}) {
  const row = {
    id: newId('dec'), mission_id: missionId, source,
    topic: result.topic, verdict: result.verdict, direction: result.direction,
    confidence: result.confidence, risk: result.risk,
    dissent_json: j(result.dissent || []), blockers_json: j(result.blockers || []),
    note: result.note || null, created_at: result.at || nowIso(),
  };
  await store.insert('decisions', row).catch(() => {});
  return row;
}

/** 議題を自動で選ぶ（いま最も判断が要る一点）。AIを使わない＝無料。 */
export async function pickTopic(store) {
  const mission = await store.first(`SELECT id,title,goal FROM missions WHERE status='active' ORDER BY priority DESC LIMIT 1`).catch(() => null);
  if (!mission) return null;
  const task = await store.first(`SELECT id,title,state,next_action FROM tasks WHERE mission_id=? AND state NOT IN ('completed','failed','abandoned') ORDER BY COALESCE(score,0) DESC, priority DESC LIMIT 1`, mission.id).catch(() => null);
  const approval = await store.first(`SELECT id,title FROM approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 1`).catch(() => null);
  if (approval) return { topic: `承認待ちの判断: ${approval.title}`, mission_id: mission.id, task_id: null };
  if (task) return { topic: `${mission.title} — 次にやる「${task.title}」で最も期待値の高い一手は何か`, mission_id: mission.id, task_id: task.id };
  return { topic: `${mission.title} — 目標「${truncate(mission.goal || '', 120)}」を最短で前進させる次の一手`, mission_id: mission.id, task_id: null };
}
