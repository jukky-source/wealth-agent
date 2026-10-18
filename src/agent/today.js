// 「今日なにを拾い、何を試し、何が分かったか」だけを1画面ぶんのデータにする。
// 実スキーマに合わせる: playbooks.result_json / last_try_at、ledger.amount・currency・basis。
// お金は「自己テスト(self_test)」を売上から除いて別枠で出す（実際の売上と混ぜない）。
import { twitterSummary } from './twitter.js';
import { perkSummary } from './perks.js';
import { playbookSummary } from './playbook.js';
import { loopSummary } from './loop.js';
import { setting } from './../db.js';

export async function todayDigest(store, { now = null, publicOnly = false } = {}) {
  const at = now || new Date().toISOString();
  const q1 = async (sql, ...a) => { try { const r = await store.first(sql, ...a); return r ? Number(Object.values(r)[0] || 0) : null; } catch { return null; } };
  const qa = async (sql, ...a) => { try { return (await store.all(sql, ...a)) || []; } catch { return []; } };
  const mod = async (p, f, ...a) => { try { const m = await import(p); return await m[f](...a); } catch (e) { return { error: String((e && e.message) || e).slice(0, 140) }; } };
  const [tw, pk, pb, lastRun, ingestAt] = await Promise.all([
    twitterSummary(store),
    perkSummary(store),
    playbookSummary(store),
    setting(store, 'playbook:last_run_at', null),
    setting(store, 'playbook:ingest_at', null),
  ]);
  const fromFindings = await qa("SELECT kind, status, title, tries, last_try_at, substr(COALESCE(result_json,''),1,300) AS result FROM playbooks WHERE key LIKE 'f_%' ORDER BY created_at DESC LIMIT 20");
  const triedRows = await qa("SELECT title, tries, last_try_at, substr(COALESCE(result_json,''),1,240) AS result FROM playbooks WHERE tries > 0 ORDER BY COALESCE(last_try_at, updated_at) DESC LIMIT 10");
  const s1 = async (sql, ...a) => { try { const r = await store.first(sql, ...a); return r ? Object.values(r)[0] : null; } catch { return null; } };
  const settingVal = (x) => (x && typeof x === 'object' && 'value' in x) ? x.value : (typeof x === 'string' ? x : null);
  const learned = {};
  for (const r of await qa('SELECT status, COUNT(*) AS n FROM playbooks GROUP BY status')) learned[r.status || 'other'] = r.n;
  const lastRunAt = settingVal(lastRun) || (await s1('SELECT MAX(updated_at) FROM playbooks WHERE tries > 0'));
  const lastIngestAt = settingVal(ingestAt) || (await s1("SELECT MAX(created_at) FROM playbooks WHERE key LIKE 'f_%'"));
  const money = {
    revenue_usd: await q1("SELECT COALESCE(SUM(amount),0) FROM ledger WHERE kind='revenue' AND currency='USDC' AND basis != 'self_test'"),
    self_test_usd: await q1("SELECT COALESCE(SUM(amount),0) FROM ledger WHERE basis = 'self_test'"),
    rows: await q1('SELECT COUNT(*) FROM ledger'),
  };
  const loop = await loopSummary(store, { env: null });
  const whyZeroErr = loop && loop.error ? String(loop.error).slice(0, 200) : null;
  const whyZero = loop && loop.bottleneck ? {
    stage: loop.bottleneck.stage, key: loop.bottleneck.key, why: loop.bottleneck.why,
    fix: loop.bottleneck.fix, level: loop.bottleneck.level,
    stages: (loop.stages || []).map((s) => ({ stage: s.stage, key: s.key, n: s.n })),
  } : null;
  const body = {
    ok: true, at, day: at.slice(0, 10),
    picked: {
      from_findings: fromFindings.length,
      by_kind: fromFindings.reduce((m, r) => { const k = r.kind || 'other'; m[k] = (m[k] || 0) + 1; return m; }, {}),
      titles: fromFindings.slice(0, 8).map((r) => ({ title: String(r.title || '').slice(0, 90), kind: r.kind, status: r.status })),
      sources: { x_posts: tw && tw.total != null ? tw.total : null, x_by_topic: (tw && tw.by_topic) || null, perks: pk && pk.total != null ? pk.total : null, perks_primary: (pk && pk.primary) || null },
      note: 'from_findings = 拾った情報から自動で作られたネタ帳の件数。sources は累計。',
    },
    tried: {
      count: await q1('SELECT COUNT(*) FROM playbooks WHERE tries > 0'),
      last_run_at: lastRunAt || null,
      last_ingest_at: lastIngestAt || null,
      rows: triedRows.map((r) => ({ title: String(r.title || '').slice(0, 90), tries: r.tries, at: r.last_try_at || null, result: r.result || null })),
    },
    learned,
    money,
    why_zero: whyZero,
    why_zero_error: whyZeroErr,
    gaps: [
      '実際の売上は 0（ledger の入金行はすべて自己テスト basis=self_test）',
      '報酬の受け取りは人間の1タップが必要（自動化しない）',
      'X の巡回は無料の非公式APIに依存（消えたら自前ホストへ）',
      'Reddit は読み取り専用。投稿・返信は自動化しない',
      'ネタの試行は「読み取り1回」まで。申込・購入・提出は人',
    ],
  };
  if (publicOnly) { body.tried.rows = (body.tried.rows || []).map((r) => ({ title: r.title, tries: r.tries, at: r.at })); body.public = true; }
  return body;
}

export function todayText(d = {}) {
  const p = d.picked || {}, t = d.tried || {}, m = d.money || {};
  return [
    `今日（${d.day || '?'}）`,
    `拾った: ${p.from_findings}件 ${JSON.stringify(p.by_kind || {})}`,
    `試した: ${t.count}件（最終 ${t.last_run_at || '-'} / 取込 ${t.last_ingest_at || '-'}）`,
    `分かった: ${JSON.stringify(d.learned || {})}`,
    `お金: 売上 $${m.revenue_usd}（自己テスト $${m.self_test_usd} は別枠・記録 ${m.rows}行）`,
    d.why_zero ? `詰まり: ${d.why_zero.stage} — ${d.why_zero.why}` : null,
  ].filter(Boolean).join('\n');
}
