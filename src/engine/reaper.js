// 停滞タスクの回収 — 何時間も「実行中」のまま残った作業を自動で拾い直す。
//
// Why: the engine had tasks sitting in `running` for 11 hours because a task
// that never reports back has nothing to move it. That silently eats the
// engine's whole capacity: new work never starts, and the report shows a
// zombie as "いま実行中". Recovering them is the difference between an agent
// that looks busy and one that actually earns.

export const DEFAULT_STALE_MINUTES = 45;

/** 停滞判定（純粋関数）。updated_at が古すぎる実行中タスクに対して、どう扱うかを決める。 */
export function staleDecisions(rows = [], { now = Date.now(), staleMs = DEFAULT_STALE_MINUTES * 60 * 1000 } = {}) {
  return rows.map((t) => {
    const from = t.updated_at || t.started_at || null;
    const at = from ? new Date(from).getTime() : NaN;
    const age = isFinite(at) ? now - at : Infinity;
    const stale = age > staleMs;
    const attempt = Number(t.attempt || 0);
    const max = Number(t.max_attempts || 3);
    const exhausted = attempt >= max;
    return {
      id: t.id, title: t.title, state: t.state, attempt, max_attempts: max,
      age_ms: isFinite(age) ? age : null, stale,
      action: !stale ? 'keep' : (exhausted ? 'fail' : 'requeue'),
      reason: !stale ? null : (exhausted ? '停滞（試行上限）' : '停滞から復帰'),
    };
  }).filter((d) => d.action !== 'keep');
}

/** 停滞タスクを実際に戻す（戻せないものは理由つきで失敗に落とす＝見えない停滞を残さない）。 */
export async function reapStaleTasks(store, env = {}, { now = Date.now() } = {}) {
  const staleMs = Number(env.STALE_TASK_MINUTES || DEFAULT_STALE_MINUTES) * 60 * 1000;
  const rows = await store.all(
    `SELECT id, title, state, attempt, max_attempts, strategy_switches, error_history, started_at, updated_at
       FROM tasks WHERE state IN ('running','planning','testing','verifying','improving')`,
  ).catch(() => []);
  const decisions = staleDecisions(rows, { now, staleMs });
  const out = { checked: rows.length, requeued: 0, failed: 0, details: [] };
  for (const d of decisions) {
    const iso = new Date(now).toISOString();
    const row = rows.find((r) => r.id === d.id) || {};
    let history;
    try {
      const h = JSON.parse(row.error_history || '[]');
      h.push({ at: iso, error: d.action === 'requeue' ? 'stalled_recovered' : 'stalled_exhausted', diagnosis: { summary: d.reason, retryable: d.action === 'requeue', kind: 'stall' } });
      history = JSON.stringify(h.slice(-8));
    } catch { history = row.error_history || '[]'; }
    try {
      if (d.action === 'requeue') {
        await store.run(
          `UPDATE tasks SET state='queued', strategy_switches=COALESCE(strategy_switches,0)+1, next_action=?, error_history=?, updated_at=? WHERE id=?`,
          '停滞から復帰（自動）。条件を変えて再実行', history, iso, d.id,
        );
        out.requeued++;
      } else {
        await store.run(
          `UPDATE tasks SET state='failed', next_action=?, error_history=?, updated_at=?, finished_at=? WHERE id=?`,
          '停滞のまま試行上限に到達（自動で打ち切り）', history, iso, iso, d.id,
        );
        out.failed++;
      }
      out.details.push({ id: d.id, title: String(d.title || '').slice(0, 80), action: d.action, minutes: d.age_ms ? Math.round(d.age_ms / 60000) : null });
    } catch (e) {
      out.details.push({ id: d.id, title: String(d.title || '').slice(0, 80), action: 'error', error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  return out;
}
