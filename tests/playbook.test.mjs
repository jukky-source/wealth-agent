// ネタ帳（playbook）のテスト。外部通信はしない（fetch を差し替える）。
// 確かめること:
//  ・「有益な情報 → こうやれば稼げる」が、原価0の手順だけになること
//  ・試行(probe)が「まだ募集中 / 閉じた / 生きている / 落ちている」を正しく分けること
//  ・試した結果が必ず残り、状態が進むこと（成功も失敗も次の材料にする）
//  ・同じネタを二度積まないこと
import assert from 'node:assert/strict';
import {
  KINDS, KIND_IDS, SEED_PLAYBOOKS, classify, stepsFor, playbookFrom, derivePlaybooks,
  runProbe, ghParts, ensurePlaybookTable, savePlaybook, seedPlaybooks, listPlaybooks,
  getPlaybook, tryPlaybooks, playbookSummary, playbookText, playbookHelp,
} from '../src/agent/playbook.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

// --- 記憶だけの store 差し替え（playbooks テーブルだけ） ----------------------
function memStore() {
  const rows = [];
  const colsOf = (sql) => {
    const m = sql.match(/INSERT INTO playbooks \(([^)]+)\)/i);
    return m ? m[1].split(',').map((s) => s.trim()) : null;
  };
  const filter = (sql, a) => {
    let i = 0; let out = rows.slice();
    if (/WHERE status = \?/.test(sql)) { const v = a[i++]; out = out.filter((r) => r.status === v); }
    if (/(WHERE|AND) kind = \?/.test(sql)) { const v = a[i++]; out = out.filter((r) => r.kind === v); }
    return { out, i };
  };
  const rank = { works: 0, trying: 1, blocked_human: 2, new: 3 };
  return {
    _rows: rows,
    async run(sql, ...a) {
      if (/CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(sql)) return {};
      const cols = colsOf(sql);
      if (cols) {
        const o = {}; cols.forEach((k, i) => { o[k] = a[i]; });
        if (rows.some((r) => r.key === o.key)) throw new Error('UNIQUE constraint failed');
        rows.push(o); return {};
      }
      if (/UPDATE playbooks SET status/i.test(sql)) {
        const [status, lastTryAt, resJson, upd, pid] = a;
        const r = rows.find((x) => x.id === pid);
        if (r) { r.status = status; r.tries = (r.tries || 0) + 1; r.last_try_at = lastTryAt; r.result_json = resJson; r.updated_at = upd; }
        return {};
      }
      return {};
    },
    async get(sql, ...a) {
      if (/COUNT\(\*\) AS n/.test(sql)) {
        if (/tries > 0/.test(sql)) return { n: rows.filter((r) => (r.tries || 0) > 0).length };
        if (/status = 'works'/.test(sql)) return { n: rows.filter((r) => r.status === 'works').length };
        return { n: rows.length };
      }
      if (/SELECT id FROM playbooks WHERE key = \?/.test(sql)) { const r = rows.find((x) => x.key === a[0]); return r ? { id: r.id } : null; }
      if (/SELECT \* FROM playbooks WHERE id = \?/.test(sql)) return rows.find((x) => x.id === a[0] || x.key === a[1]) || null;
      return null;
    },
    async all(sql, ...a) {
      if (/GROUP BY kind, status/.test(sql)) {
        const m = {};
        for (const r of rows) { const k = `${r.kind}:${r.status}`; m[k] = (m[k] || 0) + 1; }
        return Object.entries(m).map(([k, n]) => ({ kind: k.split(':')[0], status: k.split(':')[1], n }));
      }
      if (/FROM playbooks/i.test(sql)) {
        const { out, i } = filter(sql, a);
        const lim = /LIMIT \?/.test(sql) ? a[a.length - 1] : out.length;
        const sorted = /ORDER BY CASE status/.test(sql)
          ? out.slice().sort((x, y) => (rank[x.status] ?? 4) - (rank[y.status] ?? 4) || (y.score || 0) - (x.score || 0))
          : out.slice();
        return sorted.slice(0, lim);
      }
      return [];
    },
  };
}

const okRes = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => body });

await t('種別の判定: 賞金・API・監視・需要をそれぞれ正しく分ける', () => {
  assert.equal(classify({ title: 'Bounty: fix the parser', excerpt: 'we pay $200' }), 'bounty');
  assert.equal(classify({ title: 'x402 endpoint for agents', excerpt: 'monetize your API' }), 'api');
  assert.equal(classify({ title: 'watch a page and alert me', excerpt: 'monitor 通知' }), 'monitor');
  assert.equal(classify({ title: 'is there a tool for this', excerpt: 'looking for a service' }), 'demand');
  assert.ok(KIND_IDS.includes(classify({ title: 'nondescript thing' })));
});

await t('原価0の門: どんなネタでも cost_jpy は 0（先にお金が要る手順を入れない）', () => {
  for (const k of KIND_IDS) {
    const pb = playbookFrom({ title: `sample ${k}`, url: `https://example.com/${k}` });
    assert.equal(pb.cost_jpy, 0, `${k} の原価が0でない`);
    assert.ok(pb.how.length >= 3, `${k} の手順が薄い`);
    assert.ok(pb.first_step && pb.first_step.length > 5, `${k} に最初の1手が無い`);
  }
  for (const s of SEED_PLAYBOOKS) {
    const pb = playbookFrom({ ...s, seed: true });
    assert.equal(pb.cost_jpy, 0, `seed ${s.title} の原価が0でない`);
    assert.ok(pb.first_step, `seed ${s.title} に最初の1手が無い`);
  }
  assert.equal(KINDS.every((k) => k.cost_jpy === 0), true);
});

await t('同じネタは二度積まない（derive の重複排除と max の尊重）', () => {
  const item = { title: 'x402 + MCP + monitor 全部入り', url: 'https://example.com/a', excerpt: 'monitor alert API x402' };
  const a = derivePlaybooks(item, { max: 2 });
  assert.ok(a.length <= 2);
  const keys = new Set(a.map((x) => x.key));
  assert.equal(keys.size, a.length);
  const b = derivePlaybooks(item, { max: 2 });
  assert.deepEqual(a.map((x) => x.key), b.map((x) => x.key), '同じ入力で同じ鍵にならない');
});

await t('ghParts: GitHub の Issue URL から owner/repo/number を取れる', () => {
  const p = ghParts('https://github.com/acme/tool/issues/123');
  assert.deepEqual(p, { owner: 'acme', repo: 'tool', number: 123 });
  assert.equal(ghParts('https://algora.io/bounties'), null);
});

await t('試行(gh_issue): 募集中なら claimable、閉じていたら dead 判定', async () => {
  const open = await runProbe(
    { kind: 'bounty', probe: 'gh_issue', url: 'https://github.com/acme/tool/issues/1' },
    { fetchImpl: okRes(JSON.stringify({ state: 'open', closed_at: null, comments: 4, labels: [{ name: 'bounty $200' }], title: 'Fix it' })) },
  );
  assert.equal(open.verdict, 'claimable');
  assert.equal(open.evidence.bounty, 'bounty $200');

  const closed = await runProbe(
    { kind: 'bounty', probe: 'gh_issue', url: 'https://github.com/acme/tool/issues/1' },
    { fetchImpl: okRes(JSON.stringify({ state: 'closed', closed_at: '2026-01-01T00:00:00Z', labels: [] })) },
  );
  assert.equal(closed.verdict, 'closed');
});

await t('試行(free_tier): 無料枠・実額の記載を見つけると mentions_free_or_money', async () => {
  const r = await runProbe({ kind: 'free_tier', probe: 'free_tier', url: 'https://example.com/x' },
    { fetchImpl: okRes('<html>Join free and get $14.50 reward</html>') });
  assert.equal(r.verdict, 'mentions_free_or_money');
  assert.match(String(r.evidence.matched), /free|\$/i);
});

await t('試行(http): 生きていれば alive、落ちていれば unreachable', async () => {
  const a = await runProbe({ kind: 'api', probe: 'http', url: 'https://example.com/a' }, { fetchImpl: okRes('hello') });
  assert.equal(a.verdict, 'alive');
  const b = await runProbe({ kind: 'api', probe: 'http', url: 'https://example.com/a' }, { fetchImpl: okRes('boom', 503) });
  assert.equal(b.verdict, 'unreachable');
  const c = await runProbe({ kind: 'api', probe: 'http', url: null }, { fetchImpl: okRes('') });
  assert.equal(c.verdict, 'no_url');
});

await t('保存と一覧: 種を入れ、重複は増えず、種類で絞れる', async () => {
  const store = memStore();
  await ensurePlaybookTable(store);
  const s1 = await seedPlaybooks(store);
  assert.equal(s1.inserted, SEED_PLAYBOOKS.length);
  const s2 = await seedPlaybooks(store);
  assert.equal(s2.inserted, 0, '二度目で増えている');
  const all = await listPlaybooks(store, { limit: 50 });
  assert.equal(all.length, SEED_PLAYBOOKS.length);
  const b = await listPlaybooks(store, { limit: 50, kind: 'bounty' });
  assert.ok(b.length >= 1 && b.every((x) => x.kind === 'bounty'));
  const one = await getPlaybook(store, all[0].key);
  assert.equal(one.key, all[0].key);
});

await t('試す: 状態が new → trying（生きている）/ dead（落ちている）へ進み、結果が残る', async () => {
  const store = memStore();
  await ensurePlaybookTable(store);
  await savePlaybook(store, playbookFrom({ kind: 'api', title: '生きている売り場', url: 'https://a.example.com', probe: 'http' }));
  await savePlaybook(store, playbookFrom({ kind: 'api', title: '落ちている売り場', url: 'https://b.example.com', probe: 'http' }));
  const alive = async (u) => (String(u).includes('a.example.com') ? { ok: true, status: 200, text: async () => 'ok' } : { ok: false, status: 500, text: async () => 'boom' });
  const r = await tryPlaybooks(store, { limit: 5, fetchImpl: alive });
  assert.equal(r.tried, 2);
  const rows = await listPlaybooks(store, { limit: 10 });
  const a = rows.find((x) => x.title === '生きている売り場');
  const b = rows.find((x) => x.title === '落ちている売り場');
  assert.equal(a.status, 'trying');
  assert.equal(b.status, 'dead');
  assert.equal(a.tries, 1);
  assert.ok(a.result && a.result.verdict === 'alive');
  assert.ok(a.result.next, '次の一手が残っていない');
  const sum = await playbookSummary(store);
  assert.equal(sum.tried, 2);
  assert.ok(sum.total >= 2);
});

await t('失敗しても止まらない: fetch が例外でも記録して次へ進む', async () => {
  const store = memStore();
  await ensurePlaybookTable(store);
  await savePlaybook(store, playbookFrom({ kind: 'monitor', title: '例外を投げる先', url: 'https://c.example.com' }));
  const boom = async () => { throw new Error('network down'); };
  const r = await tryPlaybooks(store, { limit: 3, fetchImpl: boom });
  assert.equal(r.tried, 1);
  assert.equal(r.rows[0].verdict, 'error');
  const rows = await listPlaybooks(store, { limit: 5 });
  assert.equal(rows[0].tries, 1);
});

await t('読み物: 一覧のテキストと説明が、原価0の約束を明記している', () => {
  const pb = playbookFrom({ kind: 'bounty', title: 'テスト賞金', url: 'https://github.com/a/b/issues/9' });
  const txt = playbookText([pb]);
  assert.match(txt, /テスト賞金/);
  assert.match(txt, /原価: 0円/);
  const help = playbookHelp();
  assert.match(help, /原価0/);
  assert.match(help, /売り込みは自動化しない/);
});

await t('手順(stepsFor): 賞金は「まだ募集中か確かめる」から始まる', () => {
  const s = stepsFor('bounty', { title: 'X を直す' });
  assert.match(s[0], /募集中/);
  const f = stepsFor('free_tier', { title: 'Y に登録' });
  assert.match(f[0], /実額/);
});

console.log(`\n════════ PLAYBOOK: ${pass} passed, ${fail} failed ════════`);
if (fail) process.exit(1);
