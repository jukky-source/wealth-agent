// 見張り（先回り報告）— Vellum が Reddit で最も評価された点（"asks hourly and
// flags things you asked it to watch"）を、無料枠だけで回る形にしたもの。
// 条件は登録時に決めておき、cron のたびに保存済みの値と突き合わせ、満たしたら
// その会話にエージェントから自分で報告する。閾値は必ず実データから計算する。
//
// さらに「見張りを仕事の完了条件にする」= hold（達成するまで止めない）を持つ。
// hold の条件が未達のあいだ、エージェントは作業を続け、あと何が必要かを自分で
// 数え直す。達成した瞬間にその会話へ報告し、条件を achieved として閉じる。

import { summarizeLedger } from '../truth.js';
import { nowIso } from '../util.js';

// 稼ぐモードだけでなく、調べる・書く・暮らしでも意味のある指標をそろえてある。
export const WATCH_METRICS = {
  measured_revenue: { key: 'measured_revenue', label: '実測収益', unit: '円' },
  verified_revenue: { key: 'verified_revenue', label: '入金済み', unit: '円' },
  net_profit: { key: 'net_profit', label: '純益（入金−原価）', unit: '円' },
  completed_tasks: { key: 'completed_tasks', label: '完了した作業', unit: '件' },
  failed_tasks: { key: 'failed_tasks', label: '失敗した作業', unit: '件' },
  pending_approvals: { key: 'pending_approvals', label: '承認待ち', unit: '件' },
  open_tasks: { key: 'open_tasks', label: '動いている作業', unit: '件' },
  research_reports: { key: 'research_reports', label: '調べた件数', unit: '件' },
  notes: { key: 'notes', label: '覚えていること', unit: '件' },
  total_steps: { key: 'total_steps', label: '通算ステップ', unit: '回' },
};

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');

const num = (rows, col = 'c') => Number(rows?.[0]?.[col] || 0);
const hasNum = (s) => /(\d[\d,]*(?:\.\d+)?)\s*(?:万|円|件|回|人|個|つ|本)/.test(s) || /(?:^|\s)(\d[\d,]{2,})(?:\s|$)/.test(s);

/**
 * "実測収益が3万円を超えたら教えて" → {metric, op, threshold, note, hold}
 * 「〜するまで続けて」が付いていれば hold（完了条件として使う）。
 */
export function parseWatch(text) {
  const s = String(text || '');
  const metric = /承認|許可待/.test(s) ? 'pending_approvals'
    : /失敗|エラー|つまず/.test(s) ? 'failed_tasks'
      : /レポート|調べた|調査し|リサーチし/.test(s) ? 'research_reports'
        : /メモ|記憶|覚え/.test(s) ? 'notes'
          : /ステップ|手を打|実行回/.test(s) ? 'total_steps'
            : /(完了|終わ|仕上げ|できあが)/.test(s) ? 'completed_tasks'
              : /入金|着金|振込/.test(s) ? 'verified_revenue'
              : /純益|粗利|手残り/.test(s) ? 'net_profit'
              : /収益|売上|稼|利益|儲/.test(s) ? 'measured_revenue'
                : /作業|タスク|キュー|手続き|用事/.test(s) ? 'open_tasks' : null;
  if (!metric) return null;
  if (!hasNum(s)) return null;
  const man = (s.match(/(\d[\d,]*(?:\.\d+)?)\s*万/) || [])[1];
  const en = (s.match(/(\d[\d,]*(?:\.\d+)?)\s*円/) || [])[1];
  const cnt = (s.match(/(\d[\d,]*)\s*(?:件|回|人|個|つ|本)/) || [])[1];
  const bare = (s.match(/(?:^|\s)(\d[\d,]{2,})(?:\s|$)/) || [])[1];
  const raw = man || en || cnt || bare;
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  const threshold = man ? Math.round(n * 10000) : Math.round(n);
  const op = /以下|下回|未満|を切った/.test(s) ? '<=' : '>=';
  // 「達成するまで」「〜まで続けて」= 仕事の完了条件として扱う。
  const hold = /(まで|続け|止まらな|止めるな|あきらめ|完走)/.test(s) && !/(解除|やめ|取り消)/.test(s);
  return { metric, op, threshold, note: s.slice(0, 220), hold };
}

/** Read the metric's current value out of the store — never from memory. */
export async function metricValue(store, metric) {
  if (metric === 'measured_revenue') {
    const rows = await store.all(`SELECT kind, amount, basis FROM ledger`);
    return summarizeLedger(rows).revenue.measured;
  }
  // 入金済み・純益は receipts（決済通知で確認した分）から数える。自己申告では動かない。
  if (metric === 'verified_revenue' || metric === 'net_profit') {
    const { revenueSummary } = await import('./revenue.js');
    const r = await revenueSummary(store);
    return metric === 'verified_revenue' ? r.receipts.verified : r.net;
  }
  const st = { completed_tasks: 'completed', failed_tasks: 'failed' }[metric];
  if (st) { const r = await store.first(`SELECT COUNT(*) AS c FROM tasks WHERE state=?`, st); return Number(r?.c || 0); }
  if (metric === 'pending_approvals') {
    const r = await store.first(`SELECT COUNT(*) AS c FROM approvals WHERE status='pending'`);
    return Number(r?.c || 0);
  }
  if (metric === 'open_tasks') {
    const r = await store.first(`SELECT COUNT(*) AS c FROM tasks WHERE state IN ('running','planning','testing','verifying','improving','queued')`);
    return Number(r?.c || 0);
  }
  if (metric === 'research_reports') {
    const r = await store.first(`SELECT COUNT(*) AS c FROM research_reports`);
    return Number(r?.c || 0);
  }
  if (metric === 'notes') {
    const r = await store.first(`SELECT COUNT(*) AS c FROM memories`);
    return Number(r?.c || 0);
  }
  if (metric === 'total_steps') {
    const r = await store.first(`SELECT COUNT(*) AS c FROM runs`);
    return Number(r?.c || 0);
  }
  return 0;
}

export async function createWatch(store, { metric, op = '>=', threshold = 0, note = '', thread_id = null, hold = false, stop_on_hit = false }) {
  const row = {
    id: rid('wch'), thread_id, metric, op, threshold: Number(threshold) || 0,
    note: String(note || '').slice(0, 300), status: 'active',
    hold: hold ? 1 : 0, stop_on_hit: stop_on_hit ? 1 : 0, achieved_value: null,
    last_value: null, last_checked_at: null, triggered_count: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
  await store.insert('watch_rules', row);
  return row;
}

/** 目標までの距離。hold（完了条件）の進み具合を必ず実データから数える。 */
export function goalProgress(rule, value) {
  const target = Number(rule?.threshold || 0);
  const current = Number(value || 0);
  const ratio = target > 0 ? current / target : (current > 0 ? 1 : 0);
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const remain = rule?.op === '<=' ? Math.max(0, current - target) : Math.max(0, target - current);
  return { current, target, pct, remain, done: remain <= 0 };
}

export function watchCard(r, value, extra = {}) {
  const label = WATCH_METRICS[r.metric]?.label || r.metric;
  const unit = WATCH_METRICS[r.metric]?.unit || '';
  const items = [
    { label, value, unit, hl: true },
    { label: `設定した条件（${r.op === '<=' ? 'これ以下' : 'これ以上'}）`, value: r.threshold, unit },
  ];
  if (extra.remain != null && extra.remain > 0) items.push({ label: 'あと', value: extra.remain, unit });
  return {
    type: 'kpi',
    title: r.hold ? '完了条件に達しました' : '見張りが条件に達しました',
    items,
  };
}

/** いまの目標（hold の見張り）と、その進み具合。 */
export async function activeGoal(store) {
  const r = await store.first(
    `SELECT * FROM watch_rules WHERE hold=1 AND status IN ('active','triggered','achieved') ORDER BY created_at DESC LIMIT 1`,
  ).catch(() => null);
  if (!r) return null;
  const value = await metricValue(store, r.metric).catch(() => 0);
  const p = goalProgress(r, value);
  return {
    id: r.id, metric: r.metric, metric_label: WATCH_METRICS[r.metric]?.label || r.metric,
    unit: WATCH_METRICS[r.metric]?.unit || '', op: r.op, status: r.status, note: r.note, ...p,
  };
}

/**
 * Cron から毎回呼ばれる。条件を満たした見張りだけが報告し、報告済みは解除されるまで黙る
 * （毎回同じ通知を出さないため）。hold の未達は holds として返し、呼び出し側が作業を続ける。
 */
export async function checkWatches({ store, memory = null }, { limit = 25 } = {}) {
  const rules = await store.all(`SELECT * FROM watch_rules WHERE status IN ('active','triggered') ORDER BY created_at LIMIT ?`, limit).catch(() => []);
  const fired = [];
  const holds = [];
  for (const r of rules) {
    let value = null;
    try { value = await metricValue(store, r.metric); } catch { value = null; }
    if (value === null) continue;
    const hit = r.op === '<=' ? value <= Number(r.threshold) : value >= Number(r.threshold);
    await store.run(`UPDATE watch_rules SET last_value=?, last_checked_at=?, updated_at=? WHERE id=?`, value, nowIso(), nowIso(), r.id).catch(() => {});
    if (!hit) {
      // 完了条件として立てた見張りが未達 → どこまで来たかを返す。
      if (r.hold) holds.push({ id: r.id, metric: r.metric, unit: WATCH_METRICS[r.metric]?.unit || '', ...goalProgress(r, value), thread_id: r.thread_id || null });
      continue;
    }
    const label = WATCH_METRICS[r.metric]?.label || r.metric;
    const unit = WATCH_METRICS[r.metric]?.unit || '';
    if (r.status === 'triggered') continue;
    if (r.hold && r.achieved_value != null && Number(r.achieved_value) === Number(value)) continue;
    const text = r.hold
      ? `完了条件を満たしました。${label} が ${fmt(r.threshold)}${unit} に到達しています（いま ${fmt(value)}${unit}）。${r.note ? `\n登録時の指示: ${r.note}` : ''}`
      : `先回り報告です。${label} が ${fmt(r.threshold)}${unit} に達しました（いま ${fmt(value)}${unit}）。${r.note ? `\n登録時の指示: ${r.note}` : ''}`;
    await store.run(
      `UPDATE watch_rules SET status=?, achieved_value=?, triggered_count=triggered_count+1, updated_at=? WHERE id=?`,
      r.hold ? 'achieved' : 'triggered', r.hold ? value : null, nowIso(), r.id,
    ).catch(() => {});
    if (r.thread_id) {
      await store.insert('chat_messages', {
        id: rid('msg'), thread_id: r.thread_id, role: 'agent', text,
        cards_json: JSON.stringify([watchCard(r, value)]), events_json: '[]',
        kind: r.hold ? 'achieved' : 'watch', created_at: nowIso(),
      }).catch(() => {});
      await store.run(`UPDATE chat_threads SET updated_at=? WHERE id=?`, nowIso(), r.thread_id).catch(() => {});
    }
    if (memory) {
      await memory.write({
        kind: 'next_action', key: `watch:${r.id}`, evidence: 'measured', importance: 70,
        text: `${r.hold ? '完了条件を達成' : '先回り報告'}: ${label} が ${fmt(value)}${unit}（条件 ${r.op} ${fmt(r.threshold)}）`,
        data: { watch_id: r.id, metric: r.metric, value, threshold: r.threshold, hold: !!r.hold },
      }).catch(() => {});
    }
    fired.push({ id: r.id, metric: r.metric, value, threshold: r.threshold, hold: !!r.hold, thread_id: r.thread_id || null });
  }
  return { checked: rules.length, fired, holds };
}

export const __test = { num, fmt };
