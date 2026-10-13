// 実行ジョブ — 「手足」が動かす重い処理の、唯一の定義。
//
// 同じコードが2か所で動きます：
//   1) Cloudflare Containers（runner/jobs-server.mjs がこのファイルを import）
//   2) 手元PC・クラウドPC（node runner/jobs.mjs encode --payload '{...}'）
//
// なぜ分けるのか：Cloudflare Workers の上では ffmpeg が動きません。頭脳（Worker）は
// 24時間そこに置いたまま、重い処理だけがここへ落ちます。原価は0円
// （自前のエンコード・自前のTTS。外部APIを一切呼びません）。

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKDIR_DEFAULT = '/tmp/wa-jobs';

export const JOB_KINDS = {
  probe: { label: '疎通確認', needs: [], timeout_s: 30 },
  voice: { label: '音声（TTS）', needs: ['espeak-ng'], timeout_s: 180 },
  encode: { label: '動画の合成（エンコード）', needs: ['ffmpeg'], timeout_s: 900 },
};

// 上限はすべてコード側で握る。実行環境に渡すものは常に「上限つき」。
export const LIMITS = {
  seconds_each: [1, 30, 4],
  images: 300,
  fps: [10, 60, 30],
  width: [240, 1920, 1080],
  height: [240, 1920, 1080],
  rate: [80, 450, 175],
  text_chars: 20000,
};

// ------------------------------------------------------------------ 小さな道具
function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function clampInt(v, min, max, dflt) { return Math.round(clampNum(v, min, max, dflt)); }

/** ファイル名は常に無害化する（`..` も `/` も通さない）。 */
export function safeName(s, fallback = 'out') {
  const t = String(s || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 80);
  if (!t || t === '.' || t === '..' || /^[._-]+$/.test(t)) return fallback;
  return t;
}

/** 拡張子を差し替える（`x.mp4` と `x` の両方を受ける）。 */
export function withExt(name, ext) {
  const base = safeName(name).replace(/\.[A-Za-z0-9]{1,6}$/, '');
  return `${base}.${ext}`;
}

// ------------------------------------------------------------------ 計画（副作用なし）
// 計画と実行を分けているのは、計画側を「実行なしでテストできる」ようにするため。

export function planVoice(payload = {}) {
  const text = String(payload.text || '').slice(0, LIMITS.text_chars).trim();
  const lang = ['ja', 'en', 'ko', 'zh'].includes(payload.lang) ? payload.lang : 'ja';
  const rate = clampInt(payload.rate, ...LIMITS.rate);
  return {
    kind: 'voice',
    text,
    lang,
    rate,
    chars: text.length,
    name: withExt(payload.name || 'voice', 'wav'),
    ok: text.length > 0,
    reason: text.length ? null : 'テキストが空です',
  };
}

/** espeak-ng はオープンソースのTTS。APIキーも従量課金も無しで音声が出ます。 */
export function buildVoiceArgs(plan) {
  return ['-v', plan.lang, '-s', String(plan.rate), '-w', plan.name, '--stdin'];
}

export function planEncode(payload = {}) {
  const images = (Array.isArray(payload.images) ? payload.images : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .slice(0, LIMITS.images);
  const audio = typeof payload.audio === 'string' && payload.audio.trim() ? payload.audio.trim() : null;
  return {
    kind: 'encode',
    images,
    audio,
    seconds_each: clampNum(payload.seconds_each, ...LIMITS.seconds_each),
    fps: clampInt(payload.fps, ...LIMITS.fps),
    width: clampInt(payload.width, ...LIMITS.width),
    height: clampInt(payload.height, ...LIMITS.height),
    name: withExt(payload.name || 'video', 'mp4'),
    ok: images.length > 0,
    reason: images.length ? null : '画像が1枚もありません（サムネイル生成の工程が先です）',
  };
}

/** concat デマルチプレクサ用の目録。最後の1枚を繰り返すのが仕様です。 */
export function buildConcatList(plan, imageNames) {
  const lines = [];
  let last = null;
  for (const n of imageNames) {
    lines.push(`file '${n}'`);
    lines.push(`duration ${plan.seconds_each}`);
    last = n;
  }
  if (last) lines.push(`file '${last}'`);
  return `${lines.join('\n')}\n`;
}

/**
 * ffmpeg の引数を組み立てる（実行はしない）。
 * 音声が無いときは anullsrc で無音を足す — 音声トラックが無いmp4を
 * プラットフォームに投げると弾かれる／無音で通しても再生器によっては無音表示が
 * 出ないため、常に音声トラックを持つ形に揃えます。
 */
export function buildEncodeArgs(plan, listName) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listName];
  if (plan.audio) args.push('-i', plan.audio);
  else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  const vf = [
    `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease`,
    `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2`,
    'format=yuv420p',
  ].join(',');
  args.push('-vf', vf, '-r', String(plan.fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-shortest', '-movflags', '+faststart', plan.name);
  return args;
}

export function planJob(kind, payload = {}) {
  if (kind === 'voice') return planVoice(payload);
  if (kind === 'encode') return planEncode(payload);
  if (kind === 'probe') return { kind: 'probe', ok: true, reason: null };
  return { kind: String(kind || ''), ok: false, reason: `未知のジョブ種別です: ${kind}` };
}

// ------------------------------------------------------------------ 実行
function run(cmd, args, { cwd, timeoutMs, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const cap = 20000;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* noop */ } }
    }, Math.max(1000, timeoutMs || 60000));
    child.stdout.on('data', (d) => { if (out.length < cap) out += d.toString(); });
    child.stderr.on('data', (d) => { if (err.length < cap) err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e), ms: Date.now() - started }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      log(`${cmd} 終了 code=${code} (${ms}ms)`);
      resolve({ code, out: out.trim(), err: err.trim(), ms });
    });
  });
}

/** 入力を手元に持ってくる（ローカルパスでも https URL でも受ける）。 */
async function materialize(src, workdir, log) {
  const s = String(src);
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    const name = safeName(path.basename(u.pathname) || 'dl', 'dl');
    const res = await fetch(s, { redirect: 'follow' });
    if (!res.ok) throw new Error(`入力の取得に失敗しました: ${res.status} ${s}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const p = path.join(workdir, name);
    await writeFile(p, buf);
    log(`取得 ${name} ${buf.length} bytes`);
    return name;
  }
  const name = safeName(path.basename(s), 'in');
  const p = path.isAbsolute(s) ? s : path.join(workdir, name);
  await stat(p); // 無ければここで落ちる
  if (p === path.join(workdir, name)) return name;
  const buf = await readFile(p);
  await writeFile(path.join(workdir, name), buf);
  return name;
}

async function sha256(file) {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * ジョブを実行して成果物を返す。成果物は workdir に残ります（Worker が
 * GET /artifact/<name> で取り出し、そのまま投稿APIへ流します — mp4を別ストレージに
 * 置かないので、保存量も転送量も増えません）。
 */
export async function runJob(kind, payload = {}, opts = {}) {
  const workdir = opts.workdir || process.env.WORKDIR || WORKDIR_DEFAULT;
  const log = opts.log || (() => {});
  const started = Date.now();
  await mkdir(workdir, { recursive: true });

  if (kind === 'probe') {
    const ff = await run('ffmpeg', ['-version'], { timeoutMs: 10000, log });
    const es = await run('espeak-ng', ['--version'], { timeoutMs: 10000, log });
    return { ok: true, kind, ms: Date.now() - started, workdir,
      tools: { ffmpeg: ff.code === 0 ? (ff.out.split('\n')[0] || 'ok') : null, espeak: es.code === 0 ? (es.out.split('\n')[0] || 'ok') : null },
      artifacts: [], log: [ff.out, es.out].filter(Boolean).join(' / ') };
  }

  const plan = planJob(kind, payload);
  if (!plan.ok) return { ok: false, kind, ms: Date.now() - started, workdir, error: 'plan_rejected', detail: plan.reason, artifacts: [] };

  if (kind === 'voice') {
    await writeFile(path.join(workdir, `${plan.name}.txt`), plan.text, 'utf-8');
    const r = await run('espeak-ng', buildVoiceArgs(plan), { cwd: workdir, timeoutMs: 180000, log });
    if (r.code !== 0) return { ok: false, kind, ms: Date.now() - started, error: 'tts_failed', detail: r.err || r.out, artifacts: [] };
    const st = await stat(path.join(workdir, plan.name));
    return { ok: true, kind, ms: Date.now() - started, workdir,
      artifacts: [{ name: plan.name, bytes: st.size, sha256: await sha256(path.join(workdir, plan.name)) }],
      log: r.err };
  }

  if (kind === 'encode') {
    const names = [];
    for (const src of plan.images) names.push(await materialize(src, workdir, log));
    let audioName = null;
    if (plan.audio) audioName = await materialize(plan.audio, workdir, log);
    const listName = withExt(plan.name, 'txt');
    await writeFile(path.join(workdir, listName), buildConcatList(plan, names), 'utf-8');
    const args = buildEncodeArgs({ ...plan, audio: audioName }, listName);
    const r = await run('ffmpeg', args, { cwd: workdir, timeoutMs: 900000, log });
    if (r.code !== 0) return { ok: false, kind, ms: Date.now() - started, error: 'encode_failed', detail: r.err || r.out, artifacts: [] };
    const p = path.join(workdir, plan.name);
    const st = await stat(p);
    return { ok: true, kind, ms: Date.now() - started, workdir,
      artifacts: [{ name: plan.name, bytes: st.size, sha256: await sha256(p) }],
      seconds: Math.round((plan.seconds_each * Math.max(1, names.length)) * 10) / 10,
      log: r.err };
  }

  return { ok: false, kind, ms: Date.now() - started, error: 'unknown_kind', artifacts: [] };
}

/** workdir の成果物一覧（ジョブサーバーの GET /artifacts 用）。 */
export async function listArtifacts(workdir = process.env.WORKDIR || WORKDIR_DEFAULT) {
  try {
    const names = await readdir(workdir);
    const out = [];
    for (const n of names) {
      if (!/\.(mp4|wav|mp3|png|jpg|jpeg|webm)$/i.test(n)) continue;
      const st = await stat(path.join(workdir, n));
      out.push({ name: n, bytes: st.size });
    }
    return out;
  } catch { return []; }
}

// ------------------------------------------------------------------ CLI
// クラウドPC側は「シェルジョブ」としてこれを叩きます：
//   node runner/jobs.mjs encode --payload '{"images":[...],"audio":"..."}'
function parseArgs(argv) {
  const out = { kind: argv[2] || 'probe', payload: null, workdir: null, outJson: false };
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--payload') out.payload = argv[++i];
    else if (a === '--payload-file') out.payloadFile = argv[++i];
    else if (a === '--payload-b64') out.payloadB64 = argv[++i];
    else if (a === '--workdir') out.workdir = argv[++i];
    else if (a === '--json') out.outJson = true;
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv);
  let payload = {};
  const raw = a.payloadFile ? await readFile(a.payloadFile, 'utf-8')
    : (a.payloadB64 ? Buffer.from(a.payloadB64, 'base64').toString('utf-8') : a.payload);
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: 'payload_not_json', detail: String(e.message) })); process.exit(2); }
  }
  const res = await runJob(a.kind, payload, a.workdir ? { workdir: a.workdir } : {});
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => { console.log(JSON.stringify({ ok: false, error: 'crash', detail: String(e && e.message || e) })); process.exit(1); });
