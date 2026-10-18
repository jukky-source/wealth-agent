// 「今日なにを拾い、何を試し、何が分かったか」だけを1画面ぶんのデータにする。
// 数字は必ず出典（どのテーブルから数えたか）と一緒に返す。取れなかった項目は null のまま返し、0 と区別する。
export async function todayDigest(store, { now = null, publicOnly = false } = {}) {
  const at = now || new Date().toISOString();
  const q1 = async (sql, ...a) => { try { const r = await store.first(sql, ...a); return r ? Number(Object.values(r)[0] || 0) : null; } catch { return null; } };
  const qa = async (sql, ...a) => { try { return (await store.all(sql, ...a)) || []; } catch { return []; } };
  const mod = async (p, f, ...a) => { try { const m = await import(p); return await m[f](...a); } catch (e) { return { error: String((e && e.message) || e).slice(0, 140) }; } };
  const [tw, pk, pb, lastRun, ingestAt] = await Promise.all([
    mod('./twitter.js', 'twitterSummary', store),
    mod('./perks.js', 'perkSummary', store),
    mod('./playbook.js', 'playbookSummary', store),
    mod('./../db.js', 'setting', store, 'playbook:last_run_at', null),
    mod('./../db.js', 'setting', store, 'playbook:ingest_at', null),
  ]);
  const fromFindings = await qa("SELECT kind, status, title, tries, substr(COALESCE(result,''),1,300) result FROM playbooks WHERE key LIKE 'f_%' ORDER BY rowid DESC LIMIT 20");
  const triedRows = await qa("SELECT title, tries, substr(COALESCE(result,''),1,240) result FROM playbooks WHERE tries > 0 ORDER BY rowid DESC LIMIT 10");
  const body = {
    ok: true, at, day: at.slice(0, 10),
    picked: {
      from_findings: fromFindings.length,
      by_kind: fromFindings.reduce((m, r) => { const k = r.kind || 'other'; m[k] = (m[k] || 0) + 1; return m; }, {}),
      titles: fromFindings.slice(0, 8).map((r) => ({ title: String(r.title || '').slice(0, 90), kind: r.kind, status: r.status })),
      sources: { x_posts: tw && tw.total != null ? tw.total : null, x_by_topic: (tw && tw.by_topic) || null, perks: pk && pk.total != null ? pk.total : null, perks_primary: (pk && pk.primary) || null },
      note: 'from_findings = 拾った情報から作られたネタ帳の件数（自動）。sources は累計。',
    },
    tried: {
      count: await q1('SELECT COUNT(*) FROM playbooks WHERE tries > 0'),
      last_run_at: (lastRun && lastRun.value) || null,
      last_ingest_at: (ingestAt && ingestAt.value) || null,
      rows: triedRows.map((r) => ({ title: String(r.title || '').slice(0, 90), tries: r.tries, result: r.result })),
    },
    learned: (pb && pb.by_status) || null,
    money: { revenue_usd: await q1('SELECT COALESCE(SUM(amount_usd),0) FROM ledger'), rows: await q1('SELECT COUNT(*) FROM ledger') },
    gaps: [
      '収益はまだ0（ledger が空）',
      '報酬の受け取りは人間の1タップが必要',
      'X の巡回は無料の非公式APIに依存（消えたら自前ホストへ）',
      'Reddit は読み取り専用。投稿・返信は自動化しない',
    ],
  };
  if (publicOnly) { body.tried.rows = (body.tried.rows || []).map((r) => ({ title: r.title, tries: r.tries })); body.public = true; }
  return body;
}

export function todayText(d = {}) {
  const p = d.picked || {}, t = d.tried || {}, m = d.money || {};
  return [
    `今日（${d.day || '?'}）`,
    `拾った: ${p.from_findings}件 ${JSON.stringify(p.by_kind || {})}`,
    `試した: ${t.count}件（最終 ${t.last_run_at || '-'} / 取込 ${t.last_ingest_at || '-'}）`,
    `分かった: ${JSON.stringify(d.learned)}`,
    `お金: $${m.revenue_usd}（記録 ${m.rows}行）`,
  ].join('\n');
}
