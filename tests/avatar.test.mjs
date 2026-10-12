// Avatar tests — pure functions plus the generation router with fake providers.
import assert from 'node:assert/strict';
import { createImageGen, localAvatarSvg, composePrompt, monogram, AVATAR_STYLES } from '../src/ai/imagegen.js';

let pass = 0; const fails = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('ok   -', name); }
  catch (e) { fails.push(name); console.log('FAIL -', name, '::', e.message); }
}

const INSTR = '落ち着いた雰囲気の女性アドバイザー。ネイビー基調で知的。';

await t('local engine is deterministic for the same instruction', () => {
  const a = localAvatarSvg({ instruction: INSTR, name: 'アテナ', style: 'flat' });
  const b = localAvatarSvg({ instruction: INSTR, name: 'アテナ', style: 'flat' });
  assert.equal(a, b);
  assert.match(a, /^<svg xmlns/);
  assert.match(a, /<\/svg>$/);
});

await t('local engine varies with the instruction', () => {
  assert.notEqual(
    localAvatarSvg({ instruction: INSTR, name: 'アテナ' }),
    localAvatarSvg({ instruction: 'まったく別の指示', name: 'アテナ' }),
  );
});

await t('local SVG carries a monogram and no script/emoji', () => {
  const s = localAvatarSvg({ instruction: INSTR, name: 'アテナ' });
  assert.match(s, />アテ</);
  assert.ok(!/<script/i.test(s));
  assert.equal(monogram('🦉アテナ'), 'アテ');
  assert.equal(monogram(''), '');
});

await t('composePrompt folds in instruction, style words and the negative list', () => {
  const p = composePrompt({ instruction: INSTR, style: AVATAR_STYLES[0], character: { name: 'アテナ', description: '収益を追う' } });
  assert.ok(p.includes(INSTR));
  assert.ok(p.includes('flat vector illustration'));
  assert.ok(p.includes('no text'));
  assert.ok(p.includes('アテナ'));
});

await t('every style has a unique key and label', () => {
  const keys = AVATAR_STYLES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(AVATAR_STYLES.every((s) => s.label && s.words));
});

await t('no keys at all → local engine, never an error', async () => {
  const g = createImageGen({ env: {}, store: null, router: null });
  const r = await g.generate({ instruction: INSTR, style: 'flat', character: { name: 'アテナ' } });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'local');
  assert.equal(r.mime, 'image/svg+xml');
  assert.ok(r.data_url.startsWith('data:image/svg+xml,'));
  assert.ok(r.note.includes('AI'));
  assert.equal(g.options().engines.find((e) => e.key === 'local').available, true);
});

await t('empty instruction is rejected with a hint', async () => {
  const g = createImageGen({ env: {} });
  const r = await g.generate({ instruction: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'instruction_required');
  assert.ok(r.hint.length > 0);
});

await t('workersai binding is used first and yields a jpeg data URL', async () => {
  const seen = [];
  const g = createImageGen({ env: { AI: { run: async (m, o) => { seen.push(m); return { image: 'QUJD' }; } } } });
  const r = await g.generate({ instruction: INSTR, character: { name: 'アテナ' } });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'workersai');
  assert.equal(r.data_url, 'data:image/jpeg;base64,QUJD');
  assert.equal(seen[0], '@cf/black-forest-labs/flux-1-schnell');
});

await t('a failing AI engine degrades to the local engine and reports why', async () => {
  const g = createImageGen({ env: { AI: { run: async () => { throw new Error('quota exhausted'); } } } });
  const r = await g.generate({ instruction: INSTR, character: { name: 'アテナ' } });
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'local');
  assert.ok(r.errors.join(' ').includes('quota exhausted'));
});

await t('gemini is used when a key exists and the response is parsed', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    assert.equal(JSON.parse(init.body).model, 'gemini-nano-banana-2.1');
    return { ok: true, json: async () => ({ output_image: { data: 'QUJD', mime_type: 'image/png' } }) };
  };
  try {
    const g = createImageGen({ env: { GEMINI_API_KEY: 'x' } });
    const r = await g.generate({ instruction: INSTR });
    assert.equal(r.engine, 'gemini');
    assert.equal(r.data_url, 'data:image/png;base64,QUJD');
  } finally { globalThis.fetch = realFetch; }
});

await t('gemini retries without response_format when the model rejects it', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (calls === 1) return { ok: false, status: 400, text: async () => 'unsupported field' };
    assert.equal('response_format' in JSON.parse(init.body), false);
    return { ok: true, json: async () => ({ output_image: { data: 'QQ==', mime_type: 'image/jpeg' } }) };
  };
  try {
    const g = createImageGen({ env: { GEMINI_API_KEY: 'x' } });
    const r = await g.generate({ instruction: INSTR });
    assert.equal(r.engine, 'gemini');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = realFetch; }
});

await t('instruction is truncated to the documented maximum', async () => {
  const realFetch = globalThis.fetch;
  let sent = '';
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body).input[0].text; return { ok: true, json: async () => ({ output_image: { data: 'QQ==', mime_type: 'image/png' } }) }; };
  try {
    const g = createImageGen({ env: { GEMINI_API_KEY: 'x' } });
    const r = await g.generate({ instruction: 'あ'.repeat(900) });
    assert.ok(r.instruction.length <= 400);
    assert.ok(sent.length < 1200);
  } finally { globalThis.fetch = realFetch; }
});

console.log(`\navatar tests: ${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log('failed:', fails.join(', ')); process.exit(1); }
