// 実行ジョブの実機テスト。
//
// これは「書いた」ではなく「動いた」を確かめるためのテストです：
//   1) 計画（ffmpeg の引数組み立て）が正しいか — 実行せずに検査
//   2) ジョブサーバーの認証が閉じているか — トークン無しは401
//   3) 音声ジョブが実際に wav を作るか — espeak-ng
//   4) 動画ジョブが実際に mp4 を作るか — ffmpeg（画像3枚＋音声）
// ffmpeg / espeak-ng が無い環境では、その部分だけ SKIP として正直に出します。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { buildEncodeArgs, buildConcatList, planEncode, planJob, planVoice, runJob, safeName, withExt } =
  await import('../runner/jobs.mjs');

let pass = 0; const failed = []; const skipped = [];
const test = (name, fn) => { tests.push([name, fn]); };
const tests = [];

function has(cmd) {
  return new Promise((resolve) => {
    const c = spawn(cmd, ['--version'], { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0 || code === 1));
  });
}

// ------------------------------------------------------------------ 1) 計画
test('[J1] ファイル名は無害化される（`..` も `/` も通さない）', () => {
  assert.equal(safeName('../../etc/passwd'), '.._.._etc_passwd'.replace(/\.{2,}/g, '_'));
  assert.equal(safeName(''), 'out');
  assert.equal(safeName('..'), 'out');
  assert.equal(safeName('a/b c.mp4'), 'a_b_c.mp4');
  assert.equal(withExt('x.mp4', 'wav'), 'x.wav');
});

test('[J2] 空の計画は実行前に拒否される', () => {
  const v = planVoice({ text: '   ' });
  assert.equal(v.ok, false);
  const e = planEncode({ images: [] });
  assert.equal(e.ok, false);
  assert.match(e.reason, /画像/);
});

test('[J3] 上限はコード側で握る（秒数・解像度・fps）', () => {
  const e = planEncode({ images: ['a.png'], seconds_each: 9999, width: 99999, height: 1, fps: 999 });
  assert.equal(e.seconds_each, 30);
  assert.equal(e.width, 1920);
  assert.equal(e.height, 240);
  assert.equal(e.fps, 60);
});

test('[J4] ffmpeg の引数に、音声が無くても音声トラックを作る指定が入る', () => {
  const plan = planEncode({ images: ['a.png'], audio: null, width: 1080, height: 1920 });
  const args = buildEncodeArgs(plan, 'list.txt');
  assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=44100'));
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('+faststart'));
  assert.ok(args.some((x) => x.startsWith('scale=1080:1920')));
  assert.equal(args[args.length - 1], 'video.mp4');
  const plan2 = planEncode({ images: ['a.png'], audio: 'voice.wav' });
  const args2 = buildEncodeArgs(plan2, 'list.txt');
  assert.ok(args2.includes('voice.wav'));
  assert.ok(!args2.some((x) => String(x).includes('anullsrc')));
});

test('[J5] 目録は最後の1枚を繰り返す（concat の仕様）', () => {
  const plan = planEncode({ images: ['a.png', 'b.png'], seconds_each: 4 });
  const list = buildConcatList(plan, ['a.png', 'b.png']);
  assert.equal(list.trim().split('\n').filter((l) => l.startsWith('file ')).length, 3);
  assert.ok(list.endsWith("file 'b.png'\n"));
});

test('[J6] 未知の種別は実行せずに断る', () => {
  const p = planJob('rm -rf /', {});
  assert.equal(p.ok, false);
  assert.match(p.reason, /未知/);
});

// ------------------------------------------------------------------ 2) 認証
test('[J7] ジョブサーバーは、トークンが無ければ何も実行しない', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-auth-'));
  const srv = spawn(process.execPath, ['runner/jobs-server.mjs'], {
    env: { ...process.env, PORT: '8231', RUNNER_TOKEN: 'secret-test', WORKDIR: dir },
    stdio: 'ignore',
  });
  try {
    await new Promise((r) => setTimeout(r, 600));
    const noTok = await fetch('http://127.0.0.1:8231/job', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"kind":"probe"}' });
    assert.equal(noTok.status, 401);
    const health = await fetch('http://127.0.0.1:8231/health');
    assert.equal(health.status, 200);
    const tok = await fetch('http://127.0.0.1:8231/job', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-token': 'secret-test' }, body: '{"kind":"probe"}',
    });
    assert.equal(tok.status, 200);
    const bad = await fetch('http://127.0.0.1:8231/job', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-token': 'secret-test' }, body: '{"kind":"shell"}',
    });
    assert.equal(bad.status, 400);
  } finally {
    srv.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 3) 実機
test('[J8] 音声ジョブが実際に wav を作る（espeak-ng）', async () => {
  if (!(await has('espeak-ng'))) { skipped.push('espeak-ng が無いので音声の実機テストは飛ばしました'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-voice-'));
  try {
    const r = await runJob('voice', { text: 'これは実行環境の確認です。', lang: 'ja', name: 'v' }, { workdir: dir });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.artifacts[0].name, 'v.wav');
    assert.ok(r.artifacts[0].bytes > 1000, `wav が小さすぎます: ${r.artifacts[0].bytes}`);
    assert.match(r.artifacts[0].sha256, /^[0-9a-f]{16}$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('[J9] 動画ジョブが実際に mp4 を作る（ffmpeg・画像3枚＋音声）', async () => {
  if (!(await has('ffmpeg'))) { skipped.push('ffmpeg が無いので動画の実機テストは飛ばしました'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wa-enc-'));
  try {
    // 3枚の絵を ffmpeg で作る（入力はどれも1080x1920の縦）
    for (const [i, c] of ['0x222244', '0x224422', '0x442222'].entries()) {
      const g = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=1080x1920`, '-frames:v', '1', path.join(dir, `p${i}.png`)]);
      const code = await new Promise((r) => g.on('close', r));
      assert.equal(code, 0);
    }
    const r = await runJob('encode', {
      images: ['p0.png', 'p1.png', 'p2.png'], seconds_each: 1, width: 1080, height: 1920, fps: 24, name: 'demo',
    }, { workdir: dir });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.artifacts[0].name, 'demo.mp4');
    assert.ok(r.artifacts[0].bytes > 5000, `mp4 が小さすぎます: ${r.artifacts[0].bytes}`);
    const st = await stat(path.join(dir, 'demo.mp4'));
    assert.equal(st.size, r.artifacts[0].bytes);
    assert.equal(r.seconds, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [name, fn] of tests) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push([name, e]); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
for (const s of skipped) console.log(`  – SKIP: ${s}`);
console.log(`\n════════ RUNNER JOBS: ${pass} passed, ${failed.length} failed, ${skipped.length} skipped ════════`);
process.exit(failed.length ? 1 : 0);
