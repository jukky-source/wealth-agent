// Containers を使うときだけの入口。
//
// 無料枠（wrangler.toml）は src/index.js をそのまま使います。こちらは
// wrangler.containers.toml だけが参照するので、@cloudflare/containers が
// 入っていない環境でも無料側の配備は壊れません。
//
// 使い方：
//   npm i @cloudflare/containers
//   npx wrangler deploy -c wrangler.containers.toml
//
// 注意：この経路は Cloudflare のトークンと Docker が要るため、いまは配備できていません
// （コードとしては用意済み・未配備）。配備した瞬間から上の実行環境が 'container' になります。

import { Container } from '@cloudflare/containers';
import worker from './index.js';

export class RunnerContainer extends Container {
  defaultPort = 8080;
  // 使われていない間は寝かせる。課金は「動いている間だけ」なので、これが原価をほぼ0にする。
  sleepAfter = '5m';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      WORKDIR: '/tmp/wa-jobs',
      RUNNER_TOKEN: String(env.RUNNER_TOKEN || ''),
    };
  }

  onStart() { console.log('runner container started'); }
  onStop() { console.log('runner container stopped'); }
  onError(e) { console.log('runner container error', e && e.message); }
}

export default worker;
