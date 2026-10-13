// 実行環境との橋渡し（Worker 側）。
//
// 頭脳（Worker）は24時間そこにいて、重い処理だけを「手足」へ渡します。渡し先は2つ：
//   * container — Cloudflare Containers（runner/jobs-server.mjs）。月$5。
//   * queue     — クラウドPC/手元PC（runner_jobs テーブル経由。既存のsrc/runner/queue.js）。
// どちらも無ければ「実行環境が無い」と正直に返します。黙って失敗させません。

import { PIPELINE } from './publish.js';
import { createRunner } from '../runner/queue.js';

// 実行環境が要る工程と、そのジョブ種別。ここが唯一の対応表。
export const STEP_KIND = { voice: 'voice', encode: 'encode' };

export function stepRunnerKind(step) {
  return STEP_KIND[step] || null;
}

/** 工程表に「どこで動くか」を足して返す（会話とAPIの両方がこれを使う）。 */
export function runnerPlan(pipeline = PIPELINE) {
  return pipeline.map((p) => ({
    ...p,
    runner_kind: stepRunnerKind(p.step),
    runs_on: p.needs_runner ? (stepRunnerKind(p.step) === 'encode' ? 'ffmpeg' : 'tts') : 'worker',
  }));
}

export function runnerState(env = {}) {
  const containers = !!env.RUNNER_CONTAINER;
  const mode = containers ? 'container' : (String(env.RUNNER_ENABLED || 'false') === 'true' ? 'queue' : 'none');
  return {
    mode,
    containers_bound: containers,
    queue_enabled: String(env.RUNNER_ENABLED || 'false') === 'true',
    token_configured: !!env.RUNNER_TOKEN,
    instance_type: env.RUNNER_INSTANCE_TYPE || 'basic',
    kinds: Object.keys(STEP_KIND).map((s) => ({ step: s, kind: STEP_KIND[s] })),
    needs_runner_steps: PIPELINE.filter((p) => p.needs_runner).map((p) => p.step),
    // 動画づくりが止まる理由を、そのまま書く。曖昧に濁さない。
    blocked_reason: mode === 'none'
      ? '実行環境が未設定です。音声(TTS)と動画の合成(ffmpeg)はWorkers上では動きません。Cloudflare Containers（月$5）か、クラウドPC/手元PCのランナーを繋ぐと閉じます。'
      : null,
  };
}

function payloadB64(payload) {
  return Buffer.from(JSON.stringify(payload || {}), 'utf-8').toString('base64');
}

/**
 * 1件のジョブを実行環境へ渡す。
 * container: その場でHTTPで投げて結果を待つ（成果物はコンテナの作業ディスクに残り、
 *            GET /artifact/<name> で取り出せる）。
 * queue:     シェルジョブとして積む（runner/jobs.mjs を叩く）。結果は runner_jobs 行に残る。
 */
export async function dispatchJob(env, store, { kind, payload = {}, name = 'default' } = {}) {
  if (!Object.values(STEP_KIND).includes(kind)) {
    return { ok: false, error: 'kind_not_allowed', allowed: Object.values(STEP_KIND) };
  }
  const ns = env.RUNNER_CONTAINER;
  if (ns) {
    try {
      const inst = ns.getByName(String(name || 'default'));
      const res = await inst.fetch('http://runner/job', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-runner-token': String(env.RUNNER_TOKEN || '') },
        body: JSON.stringify({ kind, payload }),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok && body.ok !== false, via: 'container', status: res.status, ...body };
    } catch (e) {
      return { ok: false, via: 'container', error: 'container_dispatch_failed', detail: String(e && e.message || e) };
    }
  }
  const runner = createRunner({ store, env });
  const cmd = `node runner/jobs.mjs ${kind} --payload-b64 '${payloadB64(payload)}'`;
  const r = await runner.enqueue({ command: cmd, timeoutMs: kind === 'encode' ? 900000 : 180000, requestedBy: 'publish-pipeline' });
  if (!r.ok) return { ok: false, via: 'queue', ...r };
  return { ok: true, via: 'queue', job: r.job, hint: 'クラウドPC側で runner/cloud-pc.sh を起動しておくと実行されます。' };
}

export function runnerHelp() {
  return [
    '実行環境（手足）の状態です。音声と動画の合成だけがWorkersの外に出ます。',
    '・Cloudflare Containers（月$5）: ffmpeg と espeak-ng を積んだイメージが、成果物を作ってその場で保持します。',
    '・クラウドPC/手元PC: runner/cloud-pc.sh を起動しておくと、同じジョブを拾って実行します（0円）。',
    '・どちらも無い場合、リサーチ・原稿・サムネイル・概要欄までは動きますが、動画の実ファイル化だけが止まります。',
  ].join('\n');
}

export function runnerCards(env = {}) {
  const st = runnerState(env);
  return [{
    kind: 'runner_state',
    title: '実行環境（手足）',
    mode: st.mode,
    rows: [
      { k: 'Containers の割り当て', v: st.containers_bound ? 'あり' : 'なし' },
      { k: 'キューの有効化', v: st.queue_enabled ? 'あり' : 'なし' },
      { k: 'ランナーのトークン', v: st.token_configured ? '設定済み' : '未設定' },
      { k: 'コンテナの大きさ', v: st.instance_type },
      { k: '外に出る工程', v: st.needs_runner_steps.join('・') || 'なし' },
    ],
    note: st.blocked_reason || '音声と動画の合成をこの実行環境で行います。',
  }];
}
