// 稼ぎ方（ストリーム）を「機会（opportunity）」として台帳に登録する。
//
// 背景: 稼ぎ方を x402直販API / API・自動化ツール出品 / AIコンテンツ販売 / AI代行サービス の
// 4本に一本化した際、FX・ポイ活・副業の候補を削除した結果 opportunities が空になった。
// そのため「収益機会を横断比較しランキングを更新」タスクが毎回 0 件を評価して検証に落ち、
// 改善→再試行を空回りさせていた（エンジンの稼働が収益作業に変わっていなかった）。
// 実際に売っている4本を候補として持たせ、スコアが「次にどこへ資源を寄せるか」を意味するようにする。
//
// 正直さの規律: 収益は必ず estimated（推定）。実測は receipts / ledger 側だけで扱う。

import { nowIso } from '../util.js';
import { STREAMS } from '../agent/streams.js';

// 本番の入口（このサービス自身のURL）。env で上書きできる。
export const DEFAULT_ORIGIN = 'https://wealth-agent.wealthagent-app.workers.dev';

/**
 * 入金の発生元（receipts.source）から、どの稼ぎ方の売上なのかを決める。
 * これが無いと、実際に売れても稼ぎ方の採点に反映されず、
 * 「売れているのに優先度が上がらない」状態になる。
 */
export const LANE_BY_SOURCE = { x402: 'opp_lane_x402' };
export function laneForSource(source) {
  return LANE_BY_SOURCE[String(source || '').toLowerCase()] || null;
}

// 各稼ぎ方の素性。手間・自動化率・回収までの日数は設計上の見積り（推定）。
const LANE_PROFILE = {
  x402: {
    summary: '自分の能力を HTTP 402 課金のAPIとして切り出し、呼ばれた分だけ売る。値札・検証・決済・納品・入金記録まで無人。',
    automation: 95, hours_per_week: 1, initial_cost: 0, recurring_cost: 0, time_to_revenue_days: 1,
    est_monthly_revenue: 30000, risk: '低（自作APIの直販・在庫なし）', durability: '高（従量課金が積み上がる）',
    cashability: '高（USDCで即時着金）', verified_results: '未検証（実測売上なし）',
  },
  api_market: {
    summary: '自作のAPI・自動化ツールを審査のあるマーケットに出品し、従量課金の継続収入にする。',
    automation: 75, hours_per_week: 3, initial_cost: 0, recurring_cost: 0, time_to_revenue_days: 21,
    est_monthly_revenue: 20000, risk: '中（出品先の審査・本人確認が必要）', durability: '高（継続課金）',
    cashability: '中（月次締め）', verified_results: '未検証（出品前）',
  },
  ai_content: {
    summary: 'AIで作った調査レポート・記事・画像を、規約がAI生成物の販売を認めている売り先にだけ流す。量産判定を避ける本数管理とAI開示を自動で入れる。',
    automation: 80, hours_per_week: 2, initial_cost: 0, recurring_cost: 0, time_to_revenue_days: 14,
    est_monthly_revenue: 12000, risk: '中（売り先規約と量産判定）', durability: '中（掲載の積み上げ次第）',
    cashability: '中', verified_results: '未検証（売上なし）',
  },
  auto_service: {
    summary: '「AIに任せたいが作れない」人の代わりに、監視・通知・定型業務を24時間回して月額を得る。',
    automation: 70, hours_per_week: 4, initial_cost: 0, recurring_cost: 0, time_to_revenue_days: 30,
    est_monthly_revenue: 25000, risk: '中（顧客ごとの合意形成）', durability: '高（月額）',
    cashability: '中', verified_results: '未検証（受注前）',
  },
};

/** 稼ぎ方の候補行（DBに触らない純関数。テストはこれを直接検証する）。 */
export function laneCandidates({ origin = null } = {}) {
  const o = String(origin || DEFAULT_ORIGIN).replace(/\/+$/, '');
  const at = nowIso();
  return STREAMS.map((st) => {
    const p = LANE_PROFILE[st.id] || {};
    return {
      id: `opp_lane_${st.id}`,
      domain: st.id,
      name: st.label,
      summary: p.summary || st.blurb || '',
      initial_cost: p.initial_cost ?? 0,
      recurring_cost: p.recurring_cost ?? 0,
      hours_per_week: p.hours_per_week ?? null,
      automation: p.automation ?? 0,
      time_to_revenue_days: p.time_to_revenue_days ?? null,
      est_monthly_revenue: p.est_monthly_revenue ?? 0,
      revenue_basis: 'estimated',
      // 根拠URLは「この売り場が実在すること」を示す自分の公開面（実測で200を確認済み）。
      evidence_urls: JSON.stringify([`${o}/openapi.json`, `${o}/.well-known/x402.json`]),
      risk: p.risk || '',
      durability: p.durability || '',
      cashability: p.cashability || '',
      japan_availability: 'yes',
      tos_compliance: 'ok',
      verified_results: p.verified_results || '未検証',
      status: 'candidate',
      score: 0,
      score_breakdown: null,
      created_at: at,
      updated_at: at,
    };
  });
}

/**
 * 機会表が空のとき（方針変更で候補を消した後など）に稼ぎ方4本を候補として登録する。
 * 既にあるものは素性だけ最新化する（スコアはランキング側が毎回計算する）。
 */
export async function ensureLaneOpportunities({ store, origin = null } = {}) {
  const lanes = laneCandidates({ origin });
  let seeded = 0;
  let refreshed = 0;
  for (const lane of lanes) {
    let existing = null;
    try { existing = await store.get('opportunities', lane.id); } catch { existing = null; }
    try {
      if (!existing) { await store.insert('opportunities', lane); seeded += 1; }
      else {
        const { id, created_at, score, score_breakdown, status, ...rest } = lane;
        await store.update('opportunities', lane.id, { ...rest, updated_at: nowIso() });
        refreshed += 1;
      }
    } catch { /* 1件失敗しても他は入れる */ }
  }
  return { lanes: lanes.length, seeded, refreshed };
}
