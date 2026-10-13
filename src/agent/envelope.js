// 自律の範囲（autonomy envelope）— 「どこまで自分で決めて、どこから人間の承認か」を
// 金額と操作で明示する。既定は最も狭い（1円の支出も承認）。オーナーが広げた分だけ
// エージェントが動ける、という関係にする。広げた範囲は会話にも必ず表示する。
//
// 稼ぐモードでは、これが安全装置であると同時に「商品の一部」になる。顧客や取引先に
// 「このエージェントはここまでしか動かない」と説明できる形になっているため。

import { setting, setSetting } from '../db.js';
import { nowIso } from '../util.js';

export const ENVELOPE_KEY = 'agent:envelope';

/** 既定は最小権限。ここを広げるのはオーナーの明示的な操作だけ。 */
export const DEFAULT_ENVELOPE = {
  auto_max_yen_per_action: 0,   // 1操作あたりの自動支出の上限（円）
  auto_max_yen_per_day: 0,      // 1日あたりの自動支出の上限（円）
  auto_max_usdc_per_call: 0,    // x402 など従量課金の1回あたり上限（USDC）
  public_post: 'approval',      // approval | auto
  external_signature: 'human_only',
  account_creation: 'human_only',
  identity_verification: 'human_only',
  scrape_and_resell: 'never',
  auto_rework: true,            // 判定に落ちた作業を自動で作り直すか
  updated_at: null,
};

const int = (v) => Math.max(0, Math.round(Number(v) || 0));
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

export async function getEnvelope(store) {
  const saved = await setting(store, ENVELOPE_KEY, null).catch(() => null);
  const v = saved && typeof saved === 'object' ? saved : {};
  return {
    ...DEFAULT_ENVELOPE,
    auto_max_yen_per_action: int(v.auto_max_yen_per_action),
    auto_max_yen_per_day: int(v.auto_max_yen_per_day),
    auto_max_usdc_per_call: Number(v.auto_max_usdc_per_call) || 0,
    public_post: oneOf(v.public_post, ['approval', 'auto'], DEFAULT_ENVELOPE.public_post),
    external_signature: oneOf(v.external_signature, ['human_only', 'auto'], 'human_only'),
    account_creation: oneOf(v.account_creation, ['human_only', 'auto'], 'human_only'),
    identity_verification: oneOf(v.identity_verification, ['human_only', 'auto'], 'human_only'),
    scrape_and_resell: oneOf(v.scrape_and_resell, ['never', 'allowed'], 'never'),
    auto_rework: v.auto_rework === false ? false : true,
    updated_at: v.updated_at || null,
  };
}

export async function setEnvelope(store, patch = {}) {
  const cur = await getEnvelope(store);
  const next = { ...cur, ...patch, updated_at: nowIso() };
  await setSetting(store, ENVELOPE_KEY, next);
  return next;
}

/**
 * ある操作を、いまの範囲で自動でやってよいか。
 * @returns {{allowed:boolean, requires:string|null, reason:string}}
 */
export function checkEnvelope(env, { action = 'generic', amount_yen = 0, amount_usdc = 0, spent_today_yen = 0 } = {}) {
  const y = Number(amount_yen) || 0;
  const u = Number(amount_usdc) || 0;
  if (env.scrape_and_resell === 'never' && /scrape|転売|再販/.test(action)) {
    return { allowed: false, requires: 'never', reason: 'スクレイプした内容の再販は行いません（設定で禁止）' };
  }
  if (['public_post', 'post', 'publish'].includes(action) && env.public_post !== 'auto') {
    return { allowed: false, requires: 'approval', reason: '外部への投稿・公開はあなたの承認が要ります' };
  }
  if (['external_signature', 'sign', 'contract'].includes(action) && env.external_signature !== 'auto') {
    return { allowed: false, requires: 'human_only', reason: '対外的な署名は人間だけが行えます' };
  }
  if (['account_creation', 'signup'].includes(action) && env.account_creation !== 'auto') {
    return { allowed: false, requires: 'human_only', reason: 'アカウント作成は人間だけが行えます' };
  }
  if (['identity_verification', 'kyc'].includes(action) && env.identity_verification !== 'auto') {
    return { allowed: false, requires: 'human_only', reason: '本人確認は人間だけが行えます' };
  }
  if (y > 0) {
    if (y > Number(env.auto_max_yen_per_action || 0)) {
      return { allowed: false, requires: 'approval', reason: `1回 ${y.toLocaleString('ja-JP')}円 の支出は上限（${Number(env.auto_max_yen_per_action || 0).toLocaleString('ja-JP')}円）を超えます` };
    }
    if (Number(spent_today_yen) + y > Number(env.auto_max_yen_per_day || 0)) {
      return { allowed: false, requires: 'approval', reason: `本日の支出が上限（${Number(env.auto_max_yen_per_day || 0).toLocaleString('ja-JP')}円）に達します` };
    }
  }
  if (u > 0 && u > Number(env.auto_max_usdc_per_call || 0)) {
    return { allowed: false, requires: 'approval', reason: `1回 ${u} USDC の支払いは上限（${env.auto_max_usdc_per_call || 0} USDC）を超えます` };
  }
  return { allowed: true, requires: null, reason: 'いまの範囲内なので自分で実行できます' };
}

/** 設定キーの日本語表示（会話で「何を変えたか」を言い直すため）。 */
export const ENVELOPE_FIELD_LABEL = {
  auto_max_yen_per_action: '自動で使える1回の上限',
  auto_max_yen_per_day: '1日の上限',
  auto_max_usdc_per_call: '従量課金の1回上限',
  public_post: '外部への投稿',
  external_signature: '対外的な署名',
  account_creation: 'アカウント作成',
  identity_verification: '本人確認',
  scrape_and_resell: 'スクレイプの再販',
  auto_rework: '判定に落ちた作業の作り直し',
};

export function envelopeCard(env) {
  return {
    type: 'kpi',
    title: '自律の範囲（ここから先はあなたの承認）',
    items: [
      { label: '自動で使える1回の上限', value: Number(env.auto_max_yen_per_action || 0), unit: '円', hl: true },
      { label: '1日の上限', value: Number(env.auto_max_yen_per_day || 0), unit: '円' },
      { label: '従量課金の1回上限', value: Number(env.auto_max_usdc_per_call || 0), unit: 'USDC' },
      { label: '外部への投稿', value: env.public_post === 'auto' ? '自動' : '承認制' },
    ],
  };
}

export function envelopeLine(env) {
  return `いまの範囲: 自動支出は1回 ${Number(env.auto_max_yen_per_action || 0).toLocaleString('ja-JP')}円・1日 ${Number(env.auto_max_yen_per_day || 0).toLocaleString('ja-JP')}円まで。外部への投稿は${env.public_post === 'auto' ? '自動' : 'あなたの承認制'}、対外的な署名と本人確認は人間のみ。`;
}

/** 「1回の上限を500円にして」などの言い分けを読む。 */
export function parseEnvelopeRequest(text) {
  const s = String(text || '');
  const amt = (m) => {
    const man = (s.match(m) || [])[1];
    return man ? Math.round(Number(man.replace(/[^\d.]/g, '')) * 10000) : null;
  };
  const yenNear = (kw) => {
    const m = s.match(new RegExp(`${kw}[^\\d]{0,12}(\\d[\\d,]*(?:\\.\\d+)?)\\s*(万)?\\s*円`));
    if (!m) return null;
    const n = Number(m[1].replace(/[^\d.]/g, ''));
    return m[2] ? Math.round(n * 10000) : Math.round(n);
  };
  const patch = {};
  const perAction = yenNear('(?:1回|一回|1操作|ひとつ)');
  const perDay = yenNear('(?:1日|一日|毎日|本日)');
  if (perAction != null) patch.auto_max_yen_per_action = perAction;
  if (perDay != null) patch.auto_max_yen_per_day = perDay;
  if (/投稿|公開/.test(s)) {
    if (/自動で(?:よい|いい|ok|して|可)|承認なし/.test(s)) patch.public_post = 'auto';
    if (/承認|確認してから|勝手にしない/.test(s)) patch.public_post = 'approval';
  }
  if (/作り直し/.test(s)) {
    if (/自動で|自分で|任せ/.test(s)) patch.auto_rework = true;
    if (/承認|確認してから|しない/.test(s)) patch.auto_rework = false;
  }
  return Object.keys(patch).length ? patch : null;
}
