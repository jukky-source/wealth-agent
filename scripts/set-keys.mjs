#!/usr/bin/env node
// Interactive free-API-key setup. Writes ONLY to .dev.vars (git-ignored),
// which the local server loads at startup. Secrets never touch the browser.
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

const FIELDS = [
  ['GEMINI_API_KEY',     'Google AI Studio (Gemini)', 'https://aistudio.google.com/apikey'],
  ['GROQ_API_KEY',       'Groq',                     'https://console.groq.com/keys'],
  ['CEREBRAS_API_KEY',   'Cerebras',                 'https://cloud.cerebras.ai/'],
  ['MISTRAL_API_KEY',    'Mistral',                  'https://console.mistral.ai/api-keys'],
  ['OPENROUTER_API_KEY', 'OpenRouter',               'https://openrouter.ai/keys'],
];

const existing = {};
if (existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) existing[m[1]] = m[2];
  }
}

const rl = createInterface({ input: stdin, output: stdout });
console.log('\n無料APIキー設定 — 空欄で Enter を押すとその項目はスキップ（既存値は保持）します。\n');
for (const [key, label, url] of FIELDS) {
  const cur = existing[key] ? '（設定済）' : '';
  const ans = (await rl.question(`${label} ${cur}\n  取得: ${url}\n  ${key}: `)).trim();
  if (ans) existing[key] = ans;
}
const acct = (await rl.question('\nCloudflare Account ID（Workers AI を使う場合のみ・任意）: ')).trim();
if (acct) existing.CLOUDFLARE_ACCOUNT_ID = acct;
rl.close();

const body = Object.entries(existing).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
writeFileSync('.dev.vars', body, { mode: 0o600 });
const n = Object.values(existing).filter(Boolean).length;
console.log(`\n.dev.vars に ${n} 件を保存しました（権限 600）。サーバーを再起動すると有効になります:`);
console.log('  node server/local.mjs --port 8787 --autorun\n');
