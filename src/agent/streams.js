// 稼ぎ方（ストリーム）— 目標を入力させず、稼ぎ方ごとにミッションを自動作成して
// 同時に進める。方針: 「AIエージェント自身が自律的に働いて稼ぐ」に一本化。
// 対象は、人間の関与が最小限（初回の設定だけ）で回る収益経路のみ。
// FX・ポイ活・個人開発副業・監視サブスク単体は廃止。
// ここでは AI を呼ばない（計画はエンジンのティックが予算内で行う）。

import { nowIso } from '../util.js';
import { setSetting } from '../db.js';

export const STREAMS = [
  { id: 'x402', label: 'x402 直販API', icon: 'bolt',
    blurb: '自分の能力（調査・整形・レビュー・実行）を、呼ばれた分だけ課金して売る。受け取り先を一度設定すれば以後は全自動。',
    goal: 'AIエージェント自身の能力を API として切り出し、x402（HTTP 402・USDC）で従量課金で販売する。買い手は不特定のエージェント/開発者。値札・検証・決済・納品・入金記録までを人手なしで回し、売上（検証済み入金）を積み上げる。受け取り先以外の人間操作は無し。',
    priority: 80 },
  { id: 'api_market', label: 'API・自動化ツール出品', icon: 'grid',
    blurb: '自作のAPI・自動化ツールをマーケットに出品し、従量課金で継続収入にする（RapidAPI / Apify 等）。',
    goal: '自作のAPI・自動化ツール（スクレイピング補助、データ整形、定型処理の自動化など）を、規約上AI出品が可能なマーケット（RapidAPI / Apify Store）に出品し、従量課金の継続収入にする。初回の本人確認だけ人間、以後の出品・更新・価格調整・サポートはエージェントが行う。',
    priority: 70 },
  { id: 'ai_content', label: 'AIコンテンツ販売（規約準拠）', icon: 'file',
    blurb: 'AIで作った記事・翻訳・画像を、規約が認めている売り先にだけ流す。量産と判定されない本数に絞り、AI開示を自動で入れる。',
    goal: 'AIで作ったコンテンツ（調査レポート・記事・SNS投稿セット・画像セット・翻訳）を、規約上AI生成物の販売を認めている売り先にだけ流して収益化する。各売り先の規約（開示の要否・禁止カテゴリ・量産の扱い）を機械で判定し、量産と判定されない本数・重複しない文面・AI開示文を自動で担保する。BANで入金経路ごと失うのを避けるため、規約違反の売り先（Shutterstock等）は候補から除外し、プロンプト束・実在人物・アカウント転売などの禁止カテゴリは出す前に落とす。',
    priority: 68 },
  { id: 'auto_service', label: 'AI代行サービス（監視・通知含む）', icon: 'bot',
    blurb: '「AIに任せたいが作れない」人の代わりに、監視・通知・定型業務を24時間無人で回して月額を得る。',
    goal: 'AIエージェントを導入したいが自分では作れない個人・小規模事業者の代わりに、目的に合ったエージェント（監視・異常検知・通知、定型業務の自動化、レポート自動生成など）を設計・実装・運用し、月額の運用費として継続収益にする。効果は実測で示す。',
    priority: 65 },
];

// 廃止した稼ぎ方（該当ミッションはアーカイブして、タスクを止める）
export const RETIRED_STREAMS = [
  { id: 'monitoring', label: '監視・通知サブスク' },
  { id: 'micro_saas', label: '自動化マイクロSaaS' },
  { id: 'agent_service', label: 'AIエージェント運用代行' },
  { id: 'fx', label: 'FX自動売買' },
  { id: 'rewards', label: 'ポイ活・ポイント' },
  { id: 'side_hustle', label: '個人開発・副業' },
];

export const streamById = (id) => STREAMS.find((s) => s.id === id) || null;
export const streamMissionId = (id) => `msn_stream_${id}`;

const MAP_KEY = 'streams:map';
const RETIRED_IDS = new Set(RETIRED_STREAMS.map((s) => s.id));
const RETIRED_ID_RE = /^msn_stream_(monitoring|micro_saas|agent_service|fx|rewards|side_hustle)$/;
const RETIRED_TITLE_RE = /^稼ぎ方:\s*(監視・通知サブスク|自動化マイクロSaaS|AIエージェント運用代行|FX自動売買|ポイ活・ポイント|個人開発・副業)$/;
const BROAD_RE = /(稼ぐ|収益|マネタイズ|収入|[0-9,\.]+\s*円\s*\/\s*月|月\s*[0-9,\.]+\s*円)/;

async function readMap(store) {
  try {
    const row = await store.first('SELECT value FROM settings WHERE key=?', MAP_KEY);
    const v = row && row.value ? JSON.parse(row.value) : {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    for (const id of Object.keys(v)) if (RETIRED_IDS.has(id)) delete v[id];
    return v;
  } catch { return {}; }
}

/** 稼ぎ方ごとのミッションを用意する（重複しない・目標入力は不要）。 */
export async function ensureStreams({ store, router, memory, engine }) {
  const map = await readMap(store);
  const character = await engine.getCharacter().catch(() => null);
  const created = [];
  let changed = false;

  for (const st of STREAMS) {
    const sid = streamMissionId(st.id);
    let mission = await store.get('missions', sid).catch(() => null);
    if (!mission && map[st.id]) mission = await store.get('missions', map[st.id]).catch(() => null);
    if (!mission) {
      const row = {
        id: sid, title: `稼ぎ方: ${st.label}`, goal: st.goal, constraints: '',
        success_metric: null, target_value: null, metric_unit: 'JPY',
        status: 'active', priority: st.priority, autonomy_level: character?.autonomy_level ?? 4,
        progress: 0, created_at: nowIso(), updated_at: nowIso(),
      };
      try { await store.insert('missions', row); } catch { /* 同時実行で既に居れば無視 */ }
      mission = await store.get('missions', sid).catch(() => null);
      if (mission) {
        await memory.write({ kind: 'goal', scope: `mission:${sid}`, key: `goal:${sid}`, evidence: 'measured', importance: 85,
          text: `稼ぎ方「${st.label}」: ${st.goal}`, data: { mission_id: sid, stream: st.id } }).catch(() => {});
        created.push(mission);
        // 作った瞬間に決定的な計画を立てる（AI枠を使わない）。最初の tick を待たずに「次の一手」が出る。
        try {
          const { planMission } = await import('../engine/planner.js');
          const noAi = { availableProviders: () => [], complete: async () => ({ ok: false }) };
          await planMission({ store, router: noAi, memory, character, mission, existingTasks: [] });
        } catch { /* 計画は次の tick でも立つので続行 */ }
      }
    } else if (mission.status !== 'active') {
      await store.update('missions', mission.id, { status: 'active', updated_at: nowIso() });
    }
    if (mission && map[st.id] !== mission.id) { map[st.id] = mission.id; changed = true; }
  }

  // 廃止した稼ぎ方のミッションはアーカイブしてタスクを止める
  try {
    const keep = new Set(Object.values(map));
    const actives = await store.all("SELECT * FROM missions WHERE status='active'");
    for (const m of actives) {
      if (keep.has(m.id)) continue;
      const retiredId = RETIRED_ID_RE.test(String(m.id || ''));
      const retiredTitle = RETIRED_TITLE_RE.test(String(m.title || ''));
      if (!retiredId && !retiredTitle) continue;
      await store.update('missions', m.id, { status: 'archived', updated_at: nowIso() });
      await store.run("UPDATE tasks SET state='abandoned', updated_at=? WHERE mission_id=? AND state NOT IN ('completed','failed','abandoned')", nowIso(), m.id).catch(() => {});
      await memory.write({ kind: 'checkpoint', scope: `mission:${m.id}`, evidence: 'measured', importance: 60,
        text: `稼ぎ方「${m.title}」は方針変更（AIが自律的に働いて稼ぐ経路＝x402直販・API出品・AI代行サービスへ一本化）により廃止しました。` }).catch(() => {});
    }
  } catch { /* 整理に失敗しても続行 */ }

  // 同じ稼ぎ方の重複ミッションは整理（残るのは map が指す1つだけ）
  try {
    const active = await store.all("SELECT * FROM missions WHERE status='active'");
    const keep = new Set(Object.values(map));
    for (const m of active) {
      if (keep.has(m.id)) continue;
      const dup = STREAMS.some((st) => String(m.title || '') === `稼ぎ方: ${st.label}`);
      const broad = BROAD_RE.test(`${m.title} ${m.goal || ''}`);
      if (!dup && !broad) continue;
      await store.update('missions', m.id, { status: 'archived', updated_at: nowIso() });
      await store.run("UPDATE tasks SET state='abandoned', updated_at=? WHERE mission_id=? AND state NOT IN ('completed','failed','abandoned')", nowIso(), m.id).catch(() => {});
      if (broad && !dup) {
        await memory.write({ kind: 'checkpoint', scope: `mission:${m.id}`, evidence: 'measured', importance: 50,
          text: `ミッション「${m.title}」は稼ぎ方ストリーム（x402直販API／API・自動化ツール出品／AI代行サービス）に分割しました。` }).catch(() => {});
      }
    }
  } catch { /* 整理に失敗しても続行 */ }

  // 廃止した稼ぎ方の調査候補（opportunities）は、古いデータが画面に出続けないよう削除する。
  try {
    await store.run("DELETE FROM opportunities WHERE domain IN ('fx','rewards','side_hustle')").catch(() => {});
  } catch { /* 削除に失敗しても、表示側のフィルタで隠れる */ }

  if (changed) await setSetting(store, MAP_KEY, JSON.stringify(map));
  return { created, map, changed };
}

/** ストリームごとの進行。止まっていても「いまどこか」が分かるようにする。 */
export async function streamProgress(store) {
  const map = await readMap(store);
  const out = [];
  for (const st of STREAMS) {
    const mid = map[st.id] || streamMissionId(st.id);
    const mission = await store.get('missions', mid).catch(() => null);
    const base = { id: st.id, label: st.label, blurb: st.blurb, icon: st.icon, goal: st.goal, mission_id: mid };
    if (!mission) {
      out.push({ ...base, status: 'not_started', total: 0, completed: 0, running: 0, queued: 0, failed: 0, waiting: 0, progress: 0, active: false, next_task: null, last_done: null });
      continue;
    }
    const rows = await store.all('SELECT state, COUNT(*) AS c FROM tasks WHERE mission_id=? GROUP BY state', mission.id).catch(() => []);
    const by = Object.fromEntries(rows.map((r) => [r.state, Number(r.c || 0)]));
    const total = rows.reduce((s, r) => s + Number(r.c || 0), 0);
    const completed = by.completed || 0;
    const running = (by.running || 0) + (by.planning || 0) + (by.testing || 0) + (by.verifying || 0) + (by.improving || 0);
    const failed = (by.failed || 0) + (by.abandoned || 0);
    const next = await store.first("SELECT title, state FROM tasks WHERE mission_id=? AND state NOT IN ('completed','failed','abandoned') ORDER BY COALESCE(score,0) DESC, updated_at DESC LIMIT 1", mission.id).catch(() => null);
    const done = await store.first("SELECT title, finished_at FROM tasks WHERE mission_id=? AND state='completed' ORDER BY finished_at DESC LIMIT 1", mission.id).catch(() => null);
    out.push({ ...base, status: mission.status, active: mission.status === 'active', total, completed, running, queued: by.queued || 0, failed,
      waiting: (by.waiting_for_approval || 0) + (by.waiting_for_quota || 0) + (by.waiting_for_user || 0),
      progress: total ? Math.round((completed / total) * 100) : 0,
      next_task: next ? { title: next.title, state: next.state } : null,
      last_done: done ? { title: done.title, at: done.finished_at } : null });
  }
  return out;
}
