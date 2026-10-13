// 判定（Judge）— Genspark の「審判エージェント」と同じ役割を、AI課金なしの
// 決定的な検算として実装したもの。返答に載った数字・実測と推定の区別・危険操作の
// 同意を、その返答を組み立てたのと同じデータ（台帳・カード・イベント）と突き合わせる。
// 自己申告ではなく、保存済みの値との一致で判定する点が重要。
//
// 差し戻しは「言い直して終わり」にしない。要確認になった返答が特定の作業についての
// ものなら、その作業を実際に作り直し（attempt を引き継いで improving に戻す）、
// 何を根拠に落ちたかを記録する。お金を動かす操作だけは作り直さず承認待ちに回す。

import { nowIso, j } from '../util.js';

/** できること / 承認が要ること / しないこと。API と会話の両方がここを参照する。 */
export const POLICY = {
  autonomous: [
    '公開情報の調査', 'データ分析', 'コードの作成と検証', 'ローカル成果物の作成',
    'エラー分析', '再計画', 'チェックポイント保存', '完了した手順の学習',
    '判定に落ちた成果物の作り直し', '用途（モード）の切り替え',
  ],
  approval_required: [
    '実口座での売買', '入出金・資金移動', '有料APIの課金', 'アカウント登録',
    '外部への投稿・公開', '重要データの削除', '不可逆な操作', '個人情報の外部送信',
  ],
  never: [
    '規約違反の手法', '多重アカウントの作成', '法令に触れる行為', 'なりすまし・詐称',
  ],
  keys: 'APIキーやトークンは実行環境側の保管庫に置いたままで、判断するモデルには渡していません。会話・ログ・公開リポジトリのどこにも出しません。',
  auto_rework: '数字が台帳と合わない返答は、その場で作業を作り直してから出し直します。ただしお金を動かす操作は作り直せず、必ず承認待ちに回します。',
  envelope: '支出の上限と承認の範囲は「自律の範囲」の設定で決まります。既定は1円の支出も承認制で、外部への投稿・対外的な署名・アカウント作成・本人確認は人間だけが行えます。範囲を超える操作は実行せず、承認待ちに回します。',
  receipts: '「入金済み」は決済プロバイダの検証済み通知からだけ記録します。会話で申告された金額は推定のまま、実測には昇格しません。',
  margin: '収益だけで達成判定はしません。純益と AMR（(入金−原価)÷入金）を必ず同時に出します。原価を記録していない案件は達成として扱いません。',
};

/** Walk any JSON-ish value and collect every number it contains. */
function collectNumbers(v, out = new Set()) {
  if (v === null || v === undefined) return out;
  if (typeof v === 'number') { if (Number.isFinite(v)) out.add(String(Math.round(v))); return out; }
  if (typeof v === 'string') {
    for (const m of v.matchAll(/[¥￥]?\s*([\d][\d,]*(?:\.\d+)?)/g)) out.add(m[1].replace(/,/g, ''));
    return out;
  }
  if (Array.isArray(v)) { v.forEach((x) => collectNumbers(x, out)); return out; }
  if (typeof v === 'object') { Object.values(v).forEach((x) => collectNumbers(x, out)); return out; }
  return out;
}

const mentionedNumbers = (text) => [...new Set(
  [...String(text).matchAll(/[¥￥]?\s*([\d][\d,]*(?:\.\d+)?)/g)].map((m) => m[1].replace(/,/g, '')),
)];

/** 返答のカードが「この作業を続きから」と言っているなら、それが作り直しの対象。 */
export function reworkTargetOf(out = {}) {
  if (out.rework_id) return String(out.rework_id);
  for (const c of out.cards || []) {
    for (const it of c.items || []) {
      const m = String(it.act || '').match(/^(?:resume|rework):(.+)$/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * 返答1件を検算する。純粋関数なので、どの実行環境でも同じ結果になる。
 * @returns {{ok:boolean, checks:{label:string,ok:boolean,detail:string}[], line:string, rework?:{task_id:string,reason:string}}}
 */
export function judgeOutcome(out = {}, ctx = {}) {
  const reply = String(out?.reply || '');
  const checks = [];

  // 1) 返答に出た数字は、カード・イベント・実測値のどれかに必ず存在すること。
  const allowed = collectNumbers([out?.cards, out?.events]);
  collectNumbers(ctx.extraNumbers || {}, allowed);
  const mentioned = mentionedNumbers(reply);
  const orphans = mentioned.filter((n) => n.length >= 2 && !allowed.has(n));
  checks.push({
    label: '数字の裏づけ',
    ok: orphans.length === 0,
    detail: orphans.length ? `${orphans.slice(0, 3).join('・')} を台帳とカードで確認できませんでした` : `${mentioned.length}件すべて一致`,
  });

  // 2) 実測と推定を取り違えていないこと（実測0円なのに実測として語らない）。
  const led = ctx.ledger || null;
  if (led) {
    const measured = Number(led.revenue?.measured || 0);
    const est = Number(led.revenue?.total_estimated || 0);
    checks.push({
      label: '実測と推定の区別',
      ok: measured > 0 || !/実測(?!収益)/.test(reply),
      detail: measured > 0 ? `実測 ${measured} 円` : (est > 0 ? `実測0円・推定 ${est} 円（推定は実績に数えていません）` : '台帳は空'),
    });
  }

  // 3) 危険な操作に触れる返答は、必ず承認の一言を伴うこと。
  if (/(送金|入出金|購入|実口座|公開|投稿|アカウントを作|削除)/.test(reply)) {
    const consented = /(承認|許可|確認を待|あなたの判断)/.test(reply);
    checks.push({ label: '危険操作の同意', ok: consented, detail: consented ? '承認の一言あり' : '承認を待つ一言が抜けています' });
  }

  const bad = checks.filter((c) => !c.ok);
  const out2 = {
    ok: bad.length === 0,
    checks,
    line: bad.length
      ? `判定: ${bad.map((b) => b.label).join('・')}に要確認（${bad[0].detail}）`
      : `判定: ${checks.length}項目を台帳と照合して一致`,
  };
  const target = ctx.reworkTarget || reworkTargetOf(out);
  if (bad.length && target && ctx.rework !== false) {
    out2.rework = { task_id: target, reason: bad[0].label };
  }
  return out2;
}

/** お金を動かす話は作り直さない（承認に回す）。 */
const RISKY = /(送金|入出金|資金移動|購入|実口座|契約|アカウントを作|削除)/;

/**
 * 差し戻した作業を、実際に作り直す。試行回数は引き継ぎ、何を根拠に落ちたかを残す。
 * @returns {Promise<{ok:boolean, task_id?:string, attempt?:number, reason?:string, error?:string}>}
 */
export async function reworkTask(store, taskId, { reason = '判定に要確認', force = false } = {}) {
  const t = await store.get('tasks', taskId).catch(() => null);
  if (!t) return { ok: false, error: 'not_found' };
  if (RISKY.test(String(t.title || '')) || RISKY.test(String(t.next_action || '')) || RISKY.test(reason)) {
    if (!force) return { ok: false, error: 'approval_required', note: 'お金を動かす操作は作り直さず、承認待ちに回します' };
  }
  const attempt = Number(t.attempt || 0) + 1;
  await store.run(
    `UPDATE tasks SET state='improving', attempt=?, next_action=?, finished_at=NULL, updated_at=? WHERE id=?`,
    attempt, `判定差し戻し: ${String(reason).slice(0, 120)}`, nowIso(), taskId,
  );
  await store.insert('checkpoints', {
    id: `ckp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    scope: `task:${taskId}`, state: 'rework',
    payload: j({ reason, attempt, from: t.last_success_step || null }), created_at: nowIso(),
  }).catch(() => {});
  return { ok: true, task_id: taskId, attempt, reason };
}
