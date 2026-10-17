// 最小限の人間操作チェックリスト。
//
// 方針: 「AIが自律的に稼ぐ」経路のうち、人間にしかできない初回設定だけを集めて
// 一覧にする。設定が済めば、以後はエージェントが無人で回す。
// ここに挙げた項目はエージェントからは実行できない（ウォレットの作成、本人確認、
// 秘密の投入）ので、隠さず「残っている人間の操作」として見せる。

import { x402Enabled } from './x402.js';

const FREE_AI_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY'];

export function setupChecklist(env = {}) {
  const has = (k) => !!(env && env[k]);

  const items = [
    {
      id: 'x402_wallet',
      title: 'x402 受け取りウォレット',
      unlocks: 'x402 直販API（自分の能力を従量課金で売る経路）',
      env: 'X402_PAY_TO',
      done: has('X402_PAY_TO') && x402Enabled(env),
      who: 'human',
      effort: '1回だけ（アドレスを貼る）',
      action: 'USDC を受け取るアドレスを1つ設定する（例: MetaMask の Base ネットワークのアドレス 0x…）。X402_NETWORK は既定の Base のままで可。',
      note: 'これ1つで「AIが自分で値札を出して売る」経路が開きます。以後の値付け・検証・決済・納品は全自動です。',
    },
    {
      id: 'stripe_webhook',
      title: '決済プロバイダ（Stripe）の検証済み通知',
      unlocks: 'サブスク・買い切りの入金を実測として記録',
      env: 'STRIPE_WEBHOOK_SECRET',
      done: has('STRIPE_WEBHOOK_SECRET'),
      who: 'human',
      effort: '1回だけ',
      action: 'Stripe の Webhook 署名シークレットを設定する（未設定の間、未検証の入金は記録しません＝意図した挙動）。',
      note: 'x402 だけで始めるなら後回しで構いません。',
    },
    {
      id: 'free_ai_keys',
      title: '無料AI枠のキー（回転数アップ）',
      unlocks: '無料枠の合算（キー1つで概ね10倍以上）',
      env: 'GROQ_API_KEY / GEMINI_API_KEY ほか',
      done: FREE_AI_KEYS.some((k) => has(k)),
      who: 'human',
      effort: '1回だけ（任意・推奨）',
      action: '無料キーを1つ以上登録する（Groq / Gemini / Cerebras / Mistral / OpenRouter）。複数は _2〜_5 で最大5本まで回転。',
      note: '各社は独立した無料枠を持つため、合算で回転数が増えます。',
    },
    {
      id: 'market_kyc',
      title: 'マーケット出品の初回本人確認',
      unlocks: 'API・自動化ツール出品（RapidAPI / Apify 等）',
      env: '(各社の画面で実施)',
      done: false,
      who: 'human',
      effort: '1回だけ',
      action: 'RapidAPI / Apify の出品者登録と本人確認を行う（出金口座の設定を含む）。',
      note: '本人確認後は、出品・更新・価格調整をエージェントが行います。',
    },
  ];

  const remaining = items.filter((i) => !i.done && i.who === 'human');
  return {
    ok: true,
    policy: '人間にしかできない初回設定だけを残し、それ以外はエージェントが無人で回します。',
    items,
    human_remaining: remaining.length,
    human_actions: remaining.map((i) => ({ id: i.id, title: i.title, env: i.env, action: i.action })),
  };
}
