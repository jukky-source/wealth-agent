// ジョブサーバー — Cloudflare Containers の中で動く、唯一の入口。
//
// 設計：
//   * 認証は必須。RUNNER_TOKEN と一致するヘッダが無ければ何も実行しません。
//   * 実行できるのは runner/jobs.mjs の JOB_KINDS だけ。任意コマンドは受けません。
//     （シェルを受け付けると、コンテナの中身がそのまま外に出てしまうため）
//   * 成果物は作業ディスクに置き、GET /artifact/<name> で取り出せます。投稿の
//     1タップが押された瞬間に Worker がここから直接プラットフォームへ流すので、
//     mp4を別ストレージに複製しません。
//
// 起動（手元でも同じコードが動きます）：
//   RUNNER_TOKEN=test PORT=8123 node runner/jobs-server.mjs
//   curl -s -X POST localhost:8123/job -H 'x-runner-token: test' \
//     -H 'content-type: application/json' -d '{"kind":"probe"}'

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { JOB_KINDS, WORKDIR_DEFAULT, listArtifacts, runJob, safeName } from './jobs.mjs';

const PORT = Number(process.env.PORT || 8080);
const WORKDIR = process.env.WORKDIR || WORKDIR_DEFAULT;
const TOKEN = process.env.RUNNER_TOKEN || '';
const MAX_BODY = 1024 * 1024; // 1MB。入力は URL で渡すのが基本（画像を積まない）

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function authed(req) {
  if (!TOKEN) return false; // トークン未設定なら誰も通さない（既定で閉じる）
  const h = String(req.headers['x-runner-token'] || '');
  const b = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return h === TOKEN || b === TOKEN;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (d) => {
      n += d.length;
      if (n > MAX_BODY) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://container');
  const p = url.pathname;

  // ヘルスチェックは認証不要（起動確認だけ。中身は何も漏らしません）
  if (p === '/health' || p === '/') {
    return json(res, 200, {
      ok: true,
      service: 'wealth-agent-runner',
      kinds: Object.keys(JOB_KINDS),
      token_configured: !!TOKEN,
      note: 'POST /job には x-runner-token が必要です',
    });
  }

  if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

  if (p === '/artifacts' && req.method === 'GET') {
    return json(res, 200, { ok: true, artifacts: await listArtifacts(WORKDIR) });
  }

  if (p.startsWith('/artifact/') && req.method === 'GET') {
    const name = safeName(decodeURIComponent(p.slice('/artifact/'.length)), '');
    if (!name) return json(res, 400, { ok: false, error: 'bad_name' });
    const file = path.join(WORKDIR, name);
    if (!file.startsWith(path.join(WORKDIR))) return json(res, 400, { ok: false, error: 'bad_path' });
    try {
      const st = await stat(file);
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': name.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream', 'content-length': buf.length, 'x-artifact-bytes': String(st.size) });
      return res.end(buf);
    } catch { return json(res, 404, { ok: false, error: 'not_found' }); }
  }

  if (p === '/job' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return json(res, 400, { ok: false, error: 'bad_json', detail: String(e.message) }); }
    const kind = String(body.kind || '');
    if (!Object.keys(JOB_KINDS).includes(kind)) return json(res, 400, { ok: false, error: 'kind_not_allowed', allowed: Object.keys(JOB_KINDS) });
    try {
      const result = await runJob(kind, body.payload || {}, { workdir: WORKDIR, log: (m) => console.log(m) });
      return json(res, result.ok ? 200 : 500, result);
    } catch (e) {
      return json(res, 500, { ok: false, error: 'job_crashed', detail: String(e && e.message || e) });
    }
  }

  return json(res, 404, { ok: false, error: 'not_found', routes: ['GET /health', 'GET /artifacts', 'GET /artifact/<name>', 'POST /job'] });
});

server.listen(PORT, () => console.log(`runner listening on :${PORT} workdir=${WORKDIR} token=${TOKEN ? 'set' : 'MISSING'}`));
