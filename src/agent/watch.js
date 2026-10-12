// 見張り（先回り報告）— Vellum が Reddit で最も評価された点（"asks hourly and
// flags things you asked it to watch"）を、無料枠だけで回る形にしたもの。
// 条件は登録時に決めておき、cron のたびに保存済みの値と突き合わせ、満たしたら
// その会話にエージェントから自分で報告する。閾値は必ず実データから計算する。

import { summarizeLedger } from '../truth.js';
import { nowIso } from '../util.js';

export const WATCH_METRICS = {
  measured_revenue: { key: 'measured_revenue', label: '実測収益', unit: '円' },
  completed_tasks: { key: 'completed_tasks', label: '完了した作業', unit: '件' },
  failed_tasks: { key: 'failed_tasks', label: '失敗した作業', unit: '件' },
  pending_approvals: { key: 'pending_approvals', label: '承認待ち', unit: '件' },
};

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');

/** "実測収益が3万円を超えたら教えて" → {metric, op, threshold, note} */
export function parseWatch(text) {
  const s = String(text || '');
  const metric = /承認|許可待/.test(s) ? 'pending_approvals'
    : /失敗|エラー|つまず/.test(s) ? 'failed_tasks'
      : /完了|終わ/.test(s) ? 'completed_tasks'
        : /収益|売上|稼|利益|儲/.test(s) ? 'measured_revenue' : null;
  if (!metric) return null;
  const man = (s.match(/(\d[\d,]*(?:\.\d+)?)\s*万/) || [])[1];
  const en = (s.match(/(\d[\d,]*(?:\.\d+)?)\s*円/) || [])[1];
  const cnt = (s.match(/(\d[\d,]*)\s*(?:件|回|人|個|つ)/) || [])[1];
  const bare = (s.match(/(?:^|\s)(\d[\d,]{2,})(?:\s|$)/) || [])[1];
  const raw = man || en || cnt || bare;
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  const threshold = man ? Math.round(n * 10000) : Math.round(n);
  const op = /以下|下回|未満|を切った/.test(s) ? '<=' : '>=';
  return { metric, op, threshold, note: s.slice(0, 220) };
}

/** Read the metric's current value out of the store — never from memory. */
export async function metricValue(store, metric) {
  if (metric === 'measured_revenue') {
    const rows = await store.all(`SELECT kind, amount, basis FROM ledger`);
    return summarizeLedger(rows).revenue.measured;
  }
  const st = { completed_tasks: 'completed', failed_tasks: 'failed' }[metric];
  if (st) { const r = await store.first(`SELECT COUNT(*) AS c FROM tasks WHERE state=?`, st); return Number(r?.c || 0); }
  if (metric === 'pending_approvals') {
    const r = await store.first(`SELECT COUNT(*) AS c FROM approvals WHERE status='pending'`);
    return Number(r?.c || 0);
  }
  return 0;
}

export async function createWatch(store, { metric, op = '>=', threshold = 0, note = '', thread_id = null }) {
  const row = {
    id: rid('wch'), thread_id, metric, op, threshold: Number(threshold) || 0,
    note: String(note || '').slice(0, 300), status: 'active',
    last_value: null, last_checked_at: null, triggered_count: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
  await store.insert('watch_rules', row);
  return row;
}

export function watchCard(r, value) {
  const label = WATCH_METRICS[r.metric]?.label || r.metric;
  return {
    type: 'kpi',
    title: '見張りが条件に達しました',
    items: [
      { label, value, unit: WATCH_METRICS[r.metric]?.unit || '', hl: true },
      { label: `設定した条件（${r.op === '<=' ? 'これ以下' : 'これ以上'}）`, value: r.threshold, unit: WATCH_METRICS[r.metric]?.unit || '' },
    ],
  };
}

/**
 * Cron から毎回呼ばれる。条件を満たした見張りだけが報告し、報告済みは解除されるまで黙る
 * （毎回同じ通知を出さないため）。
 */
export async function checkWatches({ store, memory = null }, { limit = 25 } = {}) {
  const rules = await store.all(`SELECT * FROM watch_rules WHERE status IN ('active','triggered') ORDER BY created_at LIMIT ?`, limit).catch(() => []);
  const fired = [];
  for (const r of rules) {
    let value = null;
    try { value = await metricValue(store, r.metric); } catch { value = null; }
    if (value === null) continue;
    const hit = r.op === '<=' ? value <= Number(r.threshold) : value >= Number(r.threshold);
    await store.run(`UPDATE watch_rules SET last_value=?, last_checked_at=?, updated_at=? WHERE id=?`, value, nowIso(), nowIso(), r.id).catch(() => {});
    if (!hit || r.status === 'triggered') continue;
    const label = WATCH_METRICS[r.metric]?.label || r.metric;
    const text = `先回り報告です。${label} が ${fmt(r.threshold)}${WATCH_METRICS[r.metric]?.unit || ''} に達しました（いま ${fmt(value)}${WATCH_METRICS[r.metric]?.unit || ''}）。${r.note ? `\n登録時の指示: ${r.note}` : ''}`;
    await store.run(`UPDATE watch_rules SET status='triggered', triggered_count=triggered_count+1, updated_at=? WHERE id=?`, nowIso(), r.id).catch(() => {});
    if (r.thread_id) {
      await store.insert('chat_messages', {
        id: rid('msg'), thread_id: r.thread_id, role: 'agent', text,
        cards_json: JSON.stringify([watchCard(r, value)]), events_json: '[]', kind: 'watch', created_at: nowIso(),
      }).catch(() => {});
      await store.run(`UPDATE chat_threads SET updated_at=? WHERE id=?`, nowIso(), r.thread_id).catch(() => {});
    }
    if (memory) {
      await memory.write({
        kind: 'next_action', key: `watch:${r.id}`, evidence: 'measured', importance: 70,
        text: `先回り報告: ${label} が ${fmt(value)}${WATCH_METRICS[r.metric]?.unit || ''}（条件 ${r.op} ${fmt(r.threshold)}）`,
        data: { watch_id: r.id, metric: r.metric, value, threshold: r.threshold },
      }).catch(() => {});
    }
    fired.push({ id: r.id, metric: r.metric, value, threshold: r.threshold, thread_id: r.thread_id || null });
  }
  return { checked: rules.length, fired };
}
