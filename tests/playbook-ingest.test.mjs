import assert from 'node:assert/strict';
import { findingKind, findingToPlaybook, ingestFindings } from '../src/agent/playbook.js';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('ok  ' + n); } catch (e) { fail++; console.log('NG  ' + n + ' :: ' + e.message); } };
const ta = async (n, f) => { try { await f(); pass++; console.log('ok  ' + n); } catch (e) { fail++; console.log('NG  ' + n + ' :: ' + e.message); } };

t('github の issue URL は賞金ネタとして扱う', () => {
  assert.equal(findingKind({ url: 'https://github.com/acme/lib/issues/42' }), 'bounty');
});
t('Opire / Algora の URL も賞金ネタ', () => {
  assert.equal(findingKind({ url: 'https://opire.dev/home' }), 'bounty');
  assert.equal(findingKind({ url: 'https://x.com/a/status/1', title: 'algora で $500 の bounty' }), 'bounty');
});
t('github のリポジトリは検証ネタ（content）', () => {
  assert.equal(findingKind({ url: 'https://github.com/mem0ai/mem0' }), 'content');
});
t('topic=perk は特典ネタ', () => {
  assert.equal(findingKind({ url: 'https://example.com/cp', topic: 'perk' }), 'perk');
});
t('URL が無い情報からはネタを作らない（出典なしを残さない）', () => {
  assert.equal(findingToPlaybook({ title: 'url なし' }), null);
});
t('作ったネタは必ず原価0・未試行・probeつき', () => {
  const pb = findingToPlaybook({ url: 'https://github.com/a/b', title: 'x', score: 9, source: 'tom_doerr' });
  assert.equal(pb.cost_jpy, 0);
  assert.equal(pb.tries, 0);
  assert.equal(pb.status, 'new');
  assert.equal(pb.probe, 'http');
  assert.equal(pb.source_id, 'tom_doerr');
  assert.ok(pb.key.startsWith('f_'));
});

function fakeStore({ x = [], s = [], dup = false } = {}) {
  const runs = [];
  return {
    runs,
    all: async (sql) => (String(sql).includes('twitter_posts') ? x : s),
    first: async () => (dup ? { id: 'x' } : null),
    run: async (...a) => { runs.push(a); return { success: true }; },
  };
}

await ta('集めた情報が無ければ何も作らない', async () => {
  const r = await ingestFindings(fakeStore());
  assert.equal(r.scanned, 0);
  assert.equal(r.inserted, 0);
});
await ta('X の高得点投稿がネタとして保存される', async () => {
  const st = fakeStore({ x: [{ url: 'https://github.com/a/b', title: 'AI repo', score: 9, topic: 'ai', source: 'h' }] });
  const r = await ingestFindings(st);
  assert.equal(r.scanned, 1);
  assert.equal(r.inserted, 1);
  assert.equal(st.runs.length, 1);
});
await ta('同じ URL は二度入れない', async () => {
  const st = fakeStore({ x: [{ url: 'https://github.com/a/b', title: 'AI repo', score: 9 }], dup: true });
  const r = await ingestFindings(st);
  assert.equal(r.inserted, 0);
  assert.equal(r.skipped, 1);
});

console.log('\nplaybook-ingest: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
