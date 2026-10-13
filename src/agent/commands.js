// Chat command router — the chat-first UI sends the owner's plain Japanese
// here, and the agent decides which real action to take and reports back in
// its own words. Nothing is staged: every number in a reply is read back out
// of the store AFTER the action ran, so the conversation cannot drift away
// from what actually happened.

import { summarizeLedger } from '../truth.js';
import { judgeOutcome, reworkTask, POLICY } from './judge.js';
import { parseWatch, createWatch, metricValue, goalProgress, WATCH_METRICS } from './watch.js';
import { ENVELOPE_FIELD_LABEL, checkEnvelope, envelopeCard, envelopeLine, getEnvelope, parseEnvelopeRequest, setEnvelope } from './envelope.js';
import { JOB_LABEL, advanceJob, createJob, jobCard, jobListItems, parseJobRequest, revenueCard, revenueLine, revenueSummary } from './revenue.js';
import { catalog as x402Catalog, x402Enabled } from './x402.js';
import { nowIso } from '../util.js';
import { BUILTIN_MODES, activeMode, allModes, defaultChips, modeCard, parseModeRequest, setActiveMode, upsertCustomMode } from './modes.js';

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const yen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString('ja-JP')}`;
const count = (rows, state) => Number(rows.find((r) => r.state === state)?.c || 0);
const first = (re, s) => (s.match(re) || [])[0];

const has = (s, ...w) => w.some((x) => s.includes(x));

/** 数字を含む返答は必ず検算する（判定を付ける種類）。 */
import { providerCard, providerHelp, poolCapacity } from './providers.js';
import { channelCard, channelHelp } from './channels.js';
import { capacityValue, inferenceCards, inferenceHelp, readUsageBoard } from './inference.js';
import { autoLaneCards, autoLaneHelp, laneCard, monitorHelp } from './autolanes.js';
import { pipelineCards, publishCards, publishHelp, publishState } from './publish.js';

const AUDIT_KINDS = new Set(['status', 'tick', 'money', 'ledger', 'opportunities', 'resume', 'watch', 'trace', 'mode', 'goal', 'rework', 'envelope', 'jobs', 'revenue', 'providers', 'channels', 'inference', 'autolanes', 'publish']);
const re = (s, rx) => rx.test(s);

/** Parse "3万円" / "5,000円" / "30000" out of a Japanese sentence. */
function amountOf(s) {
  // `first()` returns the WHOLE match ("3000円"), so strip everything that is
  // not a digit before converting — otherwise Number() is NaN and the amount is
  // silently dropped.
  const num = (x) => Number(String(x).replace(/[^\d.]/g, ''));
  const man = first(/(\d[\d,]*(?:\.\d+)?)\s*万/, s);
  if (man && Number.isFinite(num(man))) return Math.round(num(man) * 10000);
  const en = first(/(\d[\d,]*(?:\.\d+)?)\s*円/, s);
  if (en && Number.isFinite(num(en))) return Math.round(num(en));
  const bare = first(/(?:^|\s)(\d{3,})(?:\s|$)/, s);
  if (bare && Number.isFinite(num(bare))) return Math.round(num(bare));
  return null;
}

function stepsOf(s, fallback = 3) {
  const m = first(/(\d+)\s*(?:手|ステップ|回|件)/, s);
  const n = m ? Number(m) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(10, n) : fallback;
}

// ---------------------------------------------------------------- read-backs

async function boardMetrics(d) {
  const mode = await activeMode(d.store).catch(() => null);
  const [rows, ledgerRows, mission, lastSuccess] = await Promise.all([
    d.store.all(`SELECT state, COUNT(*) AS c FROM tasks GROUP BY state`),
    d.store.all(`SELECT kind, amount, basis FROM ledger`),
    d.store.first(`SELECT * FROM missions WHERE status='active' ORDER BY priority DESC LIMIT 1`)
      .catch(() => null),
    d.store.all(`SELECT title, finished_at FROM tasks WHERE state='completed' ORDER BY finished_at DESC LIMIT 1`).catch(() => []),
  ]);
  const led = summarizeLedger(ledgerRows);
  return {
    counts: {
      running: count(rows, 'running') + count(rows, 'planning') + count(rows, 'testing') + count(rows, 'verifying') + count(rows, 'improving'),
      queued: count(rows, 'queued'),
      completed: count(rows, 'completed'),
      failed: count(rows, 'failed'),
      waiting: count(rows, 'waiting_for_approval') + count(rows, 'waiting_for_quota') + count(rows, 'waiting_for_user'),
    },
    led,
    mode: mode || BUILTIN_MODES.money,
    mission,
    lastSuccess: lastSuccess && lastSuccess[0] ? lastSuccess[0] : null,
  };
}

// 数字のカードはモードで見せ方を変える。稼ぐモードでは実測と推定を分けて出し、
// それ以外のモードでは「そのモードの成果」を主役にする（収益は0円のときは出さない）。
function moneyCard(led, mode = null, m = null) {
  if (!mode || mode.id === 'money') {
    return {
      type: 'kpi',
      title: mode?.kpi_title || '収支（実測と推定は分けて数えます）',
      items: [
        { label: '実測収益', value: led.revenue.measured, unit: '円', hl: true },
        { label: '推定収益（不算入）', value: led.revenue.total_estimated, unit: '円' },
        { label: '実測費用', value: led.cost.measured, unit: '円' },
        { label: '実測の純益', value: led.net_profit_measured, unit: '円' },
      ],
    };
  }
  const c = m?.counts || {};
  const items = [
    { label: mode.outcome_label || '終わったこと', value: c.completed || 0, unit: mode.unit || '件', hl: true },
    { label: '動いている作業', value: c.running || 0, unit: '件' },
    { label: '待機', value: c.queued || 0, unit: '件' },
    { label: 'あなたの判断待ち', value: c.waiting || 0, unit: '件' },
  ];
  if (Number(led.revenue.measured) > 0) items.push({ label: '実測収益', value: led.revenue.measured, unit: '円' });
  return { type: 'kpi', title: mode.kpi_title || `${mode.label}の成果`, items };
}

/** 目的をそのまま完了条件（hold の見張り）として立てる。 */
async function armGoal(store, { metric = 'completed_tasks', threshold = 10, note = '', thread_id = null } = {}) {
  if (!note) return null;
  return createWatch(store, { metric, op: '>=', threshold, hold: true, note: String(note).slice(0, 220), thread_id });
}

function taskList(items, title) {
  return { type: 'list', icon: 'list', title, items };
}

const STATE_LABEL = {
  running: '実行中', planning: '計画中', testing: 'テスト中', verifying: '検証中', improving: '改善中',
  queued: '待機', completed: '完了', failed: '失敗', cancelled: '中止',
  waiting_for_approval: '承認待ち', waiting_for_quota: 'API枠待ち', waiting_for_user: '入力待ち',
};
const TONE = { completed: 'ok', running: 'accent', failed: 'danger', waiting_for_approval: 'warn', waiting_for_quota: 'warn', waiting_for_user: 'warn' };

async function liveTasks(d, states = ['running', 'planning', 'testing', 'verifying', 'improving', 'queued'], limit = 5) {
  const ph = states.map(() => '?').join(',');
  const rows = await d.store.all(
    `SELECT id, title, state, category, progress FROM tasks WHERE state IN (${ph}) ORDER BY priority DESC, updated_at DESC LIMIT ${limit}`,
    ...states,
  ).catch(() => []);
  return rows.map((t) => ({
    title: t.title,
    sub: [STATE_LABEL[t.state] || t.state, t.category, t.progress ? `${t.progress}%` : null].filter(Boolean).join(' · '),
    badge: STATE_LABEL[t.state] || t.state,
    tone: TONE[t.state] || 'ghost',
  }));
}

// ---------------------------------------------------------------- help text

export const SUGGESTIONS = ['今どうなってる？', '次の一手を進めて', '収益はいくら？', '足あとを見せて', '何ができる？'];

const HELP = `話しかけるだけで大丈夫です。たとえば:

・「今どうなってる？」— 進捗と数字をまとめます
・「次の一手を進めて」（「3手進めて」）— 実際に作業を進めます
・「始めて」／「止めて」— 自走を開始・停止します
・「月5万円を稼ぐ目標にして」— 長期目標を設定します
・「収益 3000円 を記録」— 実績・費用を記録します（実測には根拠が必要）
・「稼げる方法を探して」— 候補を探して優先順位をつけます
・「◯◯について調べて」— 調査して要点を返します
・「メモして: ◯◯」— 長期記憶に残します

・「足あとを見せて」— 実際にやったことを全部出します
・「実測収益が3万円を超えたら教えて」— 条件を見張って、満たしたら先に報告します
・「続きから再開して」— 途中で止まった作業を、最後に成功した地点から続けます
・「何ができる？」— 自分でやること・承認が要ること・やらないことを示します
・「この手順を覚えて」— 実際に完了した流れを定型として保存します

・「調べるモードにして」— 用途（モード）を切り替えます。稼ぐ・調べる・書く・つくる・暮らし、それ以外も自分で追加できます
・「◯◯モードを追加して。目的は…」— あなた専用のモードを作り、その目的を完了条件にします
・「月3万円に届くまで続けて」— 条件を満たすまで止まりません（完了条件としての見張り）
・「やり直して」— 判定に落ちた作業を、前回の続きから作り直します

・「入金はいくら？」— 決済通知で確認できた入金・原価・純益・AMR を出します（申告額は実測にしません）
・「案件: ◯◯ 5000円」— 稼ぐ案件を登録します。「案件を進めて」で提案→納品まで自分で進めます
・「自律の範囲を見せて」— 自動で使える金額と、承認が要る操作を確認・変更します
・「無料推論いくら使った？」— 実際に使った無料推論の回数と、有料なら何円分になるかを出します
・「手間が少ない順で稼ぐ方法は？」— 放置で売れる売り場と、監視型サブスクを、あなたの手間が少ない順に出します
・「投稿ボタンまで自動でやって」— 下書きまでは全自動で作り、最後の投稿だけ1タップで承認します

むずかしい設定は要りません。判断に迷ったら私が決めて進めます。`;

// ---------------------------------------------------------------- rules

const RULES = [
  {
    id: 'providers',
    // 無料のレーンを増やす話。キー0本でも全機能が動くことを先に伝える。
    test: (s) => re(s, /無料の?(AI|エイアイ)|AIの?枠|プロバイダ|推論レーン|AIをもっと|AIをめっちゃ/) || has(s, '無料AI', 'AIの枠', 'ローカル推論'),
    run: async () => ({
      reply: [
        '無料で使えるAIのレーンを一覧にしました。キーが1本も無くてもエージェントは全機能動きます（推論の品質が上がるだけです）。',
        providerHelp(),
      ].join('\n'),
      cards: [providerCard()],
    }),
  },
  {
    id: 'channels',
    // どこで売るか。手数料を引いた手残りと、無人で回せるかで並べる。
    test: (s) => re(s, /チャネル|販路|売り先|出品先|どこで売/) || has(s, '売り先', '販売先'),
    run: async () => ({
      reply: [
        '売り先ごとに、手数料を引いた手残りと「無人で回せるか」を並べました。',
        channelHelp(),
      ].join('\n'),
      cards: [channelCard(19)],
    }),
  },
  {
    id: 'inference',
    // 使用量の計測。実測（ai_usage の実際の呼び出し）と、クォータからの推定は混ぜない。
    test: (s) => re(s, /無料(の)?推論|推論.{0,6}いくら|AI.{0,6}いくら分|いくら分(使|消費)|無料枠.{0,6}使った|使用量/)
      || has(s, '無料推論', '推論の使用量', 'AIの使用量'),
    run: async (s, d) => {
      const board = await readUsageBoard(d.store);
      const capacity = capacityValue(poolCapacity());
      const lead = board.measured
        ? `実際に走った無料推論は ${board.calls} 回（成功 ${board.ok_calls}・失敗 ${board.failed}）です。有料で同じ量を買ったとすると ${yen(board.value.yen)}（${board.value.label}）相当になります。`
        : '無料推論はまだ 1 回も走っていません。ですからいまは 0 円です。作業を振ってもらえれば、ここに実測が積み上がります。';
      return {
        reply: [lead, '', inferenceHelp()].join('\n'),
        cards: inferenceCards(board, { capacity }),
        suggest: ['次の一手を進めて', '無料のAIの枠を見せて', '今どうなってる？'],
      };
    },
  },

  {
    id: 'autolanes',
    // 手間の少ない順に売り場を並べる。束縛条件は金ではなく「俺の時間」。
    test: (s) => re(s, /手間|放置|ほったらかし|無人|自動で稼|サブスク/) || has(s, '手間が少ない', '放置で稼', '自動で稼', '監視型', '監視サブスク'),
    run: async (s) => {
      const wantsMonitor = /監視|サブスク/.test(s);
      return {
        reply: [
          'あなたの手間が少ない順に、稼ぐ売り場を並べました。ポイントは「客がどこから来るか」です。売り場の検索（Apify・RapidAPI）とエージェントの自動発見（MCP）は、あなたが告知しなくても売れます。',
          autoLaneHelp(),
          '',
          wantsMonitor ? monitorHelp() : '',
        ].filter(Boolean).join('\n'),
        cards: [laneCard(19), ...autoLaneCards(19)],
        suggest: ['監視型サブスクを1本つくって', 'MCPツールとして出して', '今どうなってる？'],
      };
    },
  },
  {
    id: 'publish',
    // 投稿キュー。規約が禁じているのは自動化ではなく「量産と重複」なので、
    // 本数の上限と重複検査を自動で掛けて、人が見る前に止める。
    test: (s) => re(s, /投稿キュー|投稿ボタン|下書き|原稿|台本|量産|重複投稿|AI開示|どこまで自動|自動投稿|投稿を自動/),
    run: async (s, d) => {
      const store = d && d.store;
      const state = store ? await publishState(store).catch(() => null) : null;
      const cards = [...pipelineCards(), ...(state ? publishCards(state) : [])];
      return {
        reply: [
          '投稿ボタンを押すまでは自動です。リサーチ・原稿・台本・サムネイル・音声・動画の合成・概要欄まで自動で作り、最後の「投稿する」だけがあなたの1タップです。',
          publishHelp(),
        ].join('\n'),
        cards,
        suggest: ['下書きを作って', '投稿の上限は？', '監視型サブスクを1本つくって'],
      };
    },
  },
  {
    id: 'help',
    test: (s) => has(s, 'ヘルプ', '使い方', '操作方法', '何を頼め'),
    run: async () => ({ reply: HELP, suggest: SUGGESTIONS }),
  },
  {
    id: 'mode',
    // 「たまに金稼ぎ以外にも使いたい」に応える部分。用途を切り替えると、チップ・
    // 成果の数え方・承認の範囲まで変わる。自分のモードも会話から足せる（AI課金なし）。
    test: (s) => re(s, /モード/) || has(s, '用途を', '使い方を変え'),
    run: async (s, d) => {
      const req = parseModeRequest(s);
      const modes = await allModes(d.store);
      const current = await activeMode(d.store);
      if (req.action === 'create') {
        const created = await upsertCustomMode(d.store, { label: req.label, goal: req.goal || '' });
        if (!created) return { reply: 'モードの名前をもう一度教えてください（例:「筋トレ日記モードを追加して」）。' };
        await setActiveMode(d.store, created.id);
        const held = req.goal ? await armGoal(d.store, { metric: 'completed_tasks', threshold: 10, note: req.goal, thread_id: d.thread_id }).catch(() => null) : null;
        return {
          reply: `「${created.label}」モードを追加して、そのまま切り替えました。${created.goal ? `目的は「${created.goal}」ですね。` : ''}${held ? 'この目的は、達成するまで続ける完了条件として見張ります。' : ''}
次からは「${created.label}モードにして」で切り替えられます。`,
          cards: [modeCard(await allModes(d.store), created.id)],
          watch_id: held?.id || null,
          suggest: defaultChips(created),
        };
      }
      if (req.action === 'goal') {
        if (!req.goal) return { reply: '新しい目的を教えてください（例:「目的は 週3回の記録を続ける」）。' };
        const updated = current.custom ? await upsertCustomMode(d.store, { id: current.id, label: current.label, goal: req.goal }) : null;
        const held = await armGoal(d.store, { metric: 'completed_tasks', threshold: 10, note: req.goal, thread_id: d.thread_id }).catch(() => null);
        return {
          reply: `「${current.label}」モードの目的を「${req.goal}」にしました。${held ? 'この目的は、達成するまで続ける完了条件として見張ります。' : ''}`,
          cards: [modeCard(await allModes(d.store), updated?.id || current.id)],
          watch_id: held?.id || null,
          suggest: defaultChips(updated || current),
        };
      }
      if (req.action === 'switch') {
        const target = modes.find((mo) => mo.label === req.label || mo.id === req.label || (req.label && mo.label.includes(req.label)));
        if (!target) {
          return { reply: `「${req.label}」というモードはまだありません。追加するなら「${req.label}モードを追加して」と言ってください。`, cards: [modeCard(modes, current.id)], suggest: defaultChips(current) };
        }
        await setActiveMode(d.store, target.id);
        return {
          reply: `「${target.label}」モードに切り替えました。${target.blurb}。${target.goal ? `\n目的は「${target.goal}」です。` : ''}
このモードのあいだは、成果の数え方と提案がこの用途に合わせて変わります。`,
          cards: [modeCard(await allModes(d.store), target.id)],
          suggest: defaultChips(target),
        };
      }
      return {
        reply: `いまは「${current.label}」モードです。${current.blurb}。\n用途は切り替えられます — 「調べるモードにして」「暮らしモードにして」のように言ってください。「◯◯モードを追加して」と言えば、あなた専用のモードも作ります。`,
        cards: [modeCard(modes, current.id)],
        suggest: defaultChips(current),
      };
    },
  },
  {
    id: 'goal',
    // 「見張りを仕事の完了条件にする」— 条件を満たすまで止めない、を会話から立てる。
    test: (s) => has(s, '達成するまで', 'まで続け', 'まで止まらな', '完走', 'あきらめず'),
    run: async (s, d) => {
      const missionRow = await d.store.first(`SELECT * FROM missions WHERE status='active' ORDER BY priority DESC LIMIT 1`).catch(() => null);
      const parsed = parseWatch(s) || {};
      const metric = parsed.metric || 'measured_revenue';
      const threshold = parsed.threshold || Number(missionRow?.target_value || 0) || 30000;
      const w = await createWatch(d.store, {
        metric, op: parsed.op || '>=', threshold, hold: true,
        note: s.slice(0, 220), thread_id: d.thread_id || null,
      });
      const label = WATCH_METRICS[metric]?.label || metric;
      const unit = WATCH_METRICS[metric]?.unit || '';
      const value = await metricValue(d.store, metric).catch(() => 0);
      const p = goalProgress(w, value);
      return {
        reply: `わかりました。これはお願いではなく、完了条件として扱います。${label} が ${Number(threshold).toLocaleString('ja-JP')}${unit} に届くまで止まりません（いま ${Number(value).toLocaleString('ja-JP')}${unit}、あと ${Number(p.remain).toLocaleString('ja-JP')}${unit}）。
未達のあいだは毎回あと何が必要かを数え直して作業を続け、達成した瞬間にこの会話で報告します。`,
        cards: [{
          type: 'kpi', title: '完了条件（達成するまで続けます）',
          items: [
            { label, value, unit, hl: true },
            { label: 'ゴール', value: threshold, unit },
            { label: 'あと', value: p.remain, unit },
          ],
        }],
        watch_id: w.id,
        suggest: ['今どうなってる？', '次の一手を進めて', '足あとを見せて'],
      };
    },
  },
  {
    id: 'rework',
    // 判定に落ちた作業を、その場で作り直す。お金を動かす話は作り直さず承認に回す。
    test: (s) => has(s, '作り直し', '作り直して', 'やり直して', '差し戻', '判定に落ち', 'もう一度作'),
    run: async (s, d) => {
      const rows = await d.store.all(
        `SELECT id,title,state,attempt,next_action FROM tasks WHERE state IN ('improving','failed','waiting_for_approval') ORDER BY updated_at DESC LIMIT 6`).catch(() => []);
      const done = [];
      for (const t of rows.slice(0, 3)) {
        const r = await reworkTask(d.store, t.id, { reason: 'オーナーの指示による作り直し' }).catch(() => null);
        if (r?.ok) done.push({ title: t.title, sub: `試行 ${r.attempt} 回目 · 前回の続きから`, badge: '作り直し中', tone: 'accent' });
      }
      if (!done.length) {
        return { reply: 'いま作り直せる作業はありません。作ったものを見直したいときは「足あとを見せて」で中身を確認できます。', suggest: ['足あとを見せて', '今どうなってる？'] };
      }
      return {
        reply: `${done.length} 件を作り直しに回しました。ゼロからではなく前回うまくいった地点から続けます（試行回数は引き継ぎます）。`,
        cards: [{ type: 'list', icon: 'branch', title: '作り直し中の作業', items: done }],
        suggest: ['今どうなってる？', '足あとを見せて'],
      };
    },
  },
  {
    id: 'envelope',
    // 「どこまで自分で決めるか」を金額で決める。既定は最小（1円も承認制）で、
    // オーナーが広げた範囲だけを自分で使う。稼ぐモードでは安全装置であると同時に、
    // 取引先に見せられる説明になる。
    test: (s) => has(s, '自律の範囲', '自動で使える', '承認なしで使える', '勝手に使える', 'どこまで自分で決め')
      || (/上限/.test(s) && /(円|USDC|投稿|支出|支払)/.test(s)),
    run: async (s, d) => {
      const before = await getEnvelope(d.store);
      const patch = parseEnvelopeRequest(s);
      const env = patch ? await setEnvelope(d.store, patch) : before;
      const today = String(nowIso()).slice(0, 10);
      const spent = await d.store.first(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE kind='cost' AND occurred_on=?`, today).catch(() => null);
      const spentToday = Number(spent?.s || 0);
      const gate = checkEnvelope(env, { action: 'spend', amount_yen: 100, spent_today_yen: spentToday });
      const changed = patch ? Object.keys(patch).map((k) => `${ENVELOPE_FIELD_LABEL[k] || k}を${typeof patch[k] === 'boolean' ? (patch[k] ? '自動' : '承認制') : Number(patch[k]).toLocaleString('ja-JP')}に`).join('、') : null;
      return {
        reply: `${changed ? `自律の範囲を変えました（${changed}）。` : envelopeLine(env)}
これが「私が自分で決めてよい線」です。ここを超える操作は実行せず、承認待ちに回します。${gate.allowed ? '' : `\nいま本日の支出は ${spentToday.toLocaleString('ja-JP')}円 なので、次の100円の支出も承認待ちになります。`}`,
        cards: [envelopeCard(env)],
        suggest: ['案件を進めて', '入金はいくら？', '今どうなってる？'],
      };
    },
  },
  {
    id: 'jobs',
    // 「提案して終わり」をやめて、納品まで進める。状態を実際に前に動かす。
    test: (s) => /^案件[：:]/.test(s.trim()) || has(s, '案件を進め', '案件一覧', '案件を見せ', '案件を登録', '案件を追加'),
    run: async (s, d) => {
      const parsed = parseJobRequest(s);
      if (parsed) {
        const job = await createJob(d.store, { ...parsed, thread_id: d.thread_id || null, note: s.slice(0, 220) });
        return {
          reply: `案件「${job.title}」を登録しました（${Number(job.price).toLocaleString('ja-JP')}円${job.platform ? ` / ${job.platform}` : ''}）。まだ候補です。「案件を進めて」と言えば、提案→着手→納品→請求まで自分で進めます。入金の確定だけはあなたの承認が要ります。`,
          cards: [jobCard(job)],
          job_id: job.id,
          suggest: ['案件を進めて', '入金はいくら？', '今どうなってる？'],
        };
      }
      const target = /進め/.test(s)
        ? await d.store.all(`SELECT * FROM jobs WHERE state NOT IN ('settled','abandoned') ORDER BY updated_at DESC LIMIT 3`).catch(() => [])
        : await d.store.all(`SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 20`).catch(() => []);
      if (!target.length) {
        return {
          reply: `案件はまだ無いです。「案件: データ整理の下請け 5000円」のように登録してもらえれば、そこから自分で進めます。\n探すところから始めるなら「稼げる方法を探して」と言ってください。`,
          suggest: ['稼げる方法を探して', '今どうなってる？'],
        };
      }
      const moved = [];
      if (/進め/.test(s)) {
        for (const j of target) {
          const r = await advanceJob(d.store, j.id).catch(() => null);
          if (r?.ok) moved.push({ title: r.job.title, sub: `${JOB_LABEL[r.from] || r.from} → ${JOB_LABEL[r.to] || r.to}`, badge: JOB_LABEL[r.to] || r.to, tone: r.to === 'delivered' ? 'ok' : 'accent' });
          else if (r?.error === 'approval_required') moved.push({ title: j.title, sub: '入金・確定はあなたの承認待ちに回しました', badge: '承認待ち', tone: 'warn' });
        }
      }
      return {
        reply: moved.length
          ? `${moved.length}件を進めました。入金の確定だけはお金が動くので、あなたの承認なしには進めません。`
          : `いま ${target.length} 件の案件があります。`,
        cards: moved.length
          ? [{ type: 'list', icon: 'branch', title: '動かした案件', items: moved }]
          : [{ type: 'list', icon: 'list', title: '案件', items: jobListItems(target) }],
        suggest: ['入金はいくら？', '今どうなってる？', '足あとを見せて'],
      };
    },
  },
  {
    id: 'revenue',
    // 「収益だけ見て達成」を封じるため、入金・原価・純益・AMR を必ず一緒に出す。
    test: (s) => /純益|粗利|AMR|採算|入金|着金/.test(s) && !/(たら教えて|まで|条件|見張)/.test(s),
    run: async (s, d) => {
      const r = await revenueSummary(d.store);
      const env = await getEnvelope(d.store);
      const sellable = x402Enabled(d.env || {});
      const lines = [revenueLine(r)];
      if (r.receipts.count === 0) {
        lines.push('入金はまだ0件です。入金は決済プロバイダの検証済み通知からだけ記録するので、会話で「入金あった」と言っても実測にはなりません。');
      }
      if (r.amr != null && r.amr < 30) lines.push(`AMR が ${r.amr}% と薄い状態です。このまま件数を増やすと赤字が膨らむので、原価の見直しを先にやります。`);
      lines.push(envelopeLine(env));
      if (!sellable) lines.push('売り物を外に出す準備（x402 の受け取り先）はまだ設定されていません。');
      return {
        reply: lines.join('\n'),
        cards: [revenueCard(r)],
        suggest: ['案件を進めて', '今どうなってる？', '足あとを見せて'],
      };
    },
  },
  {
    id: 'greet',
    test: (s) => re(s, /^(やあ|こんにちは|こんばんは|おはよう|はじめまして|hi|hello|hey)/i) && s.length < 24,
    run: async (s, d) => {
      const m = await boardMetrics(d);
      return {
        reply: `はい、聞こえています。${m.mission ? `いまは「${m.mission.title}」に向けて動いています。` : '目標がまだ無いので、決めてもらえれば計画から始めます。'}`,
        cards: [moneyCard(m.led, m.mode, m)],
        suggest: SUGGESTIONS,
      };
    },
  },
  {
    id: 'resume',
    // Reddit の実運用スレッドが口をそろえて挙げる「信頼できるエージェント」の条件:
    // 途中で失敗したとき、ゼロからやり直すのか、続きから拾えるのか。
    test: (s) => has(s, '続きから', '途中から', '再開して', '失敗したもの', '失敗を', 'やり直', 'リトライ', '復帰', '止まってる作業'),
    run: async (s, d) => {
      const rows = await d.store.all(
        `SELECT id,title,state,attempt,last_success_step,next_action FROM tasks
          WHERE state IN ('failed','cancelled','improving','waiting_for_approval','waiting_for_quota')
          ORDER BY updated_at DESC LIMIT 6`).catch(() => []);
      if (!rows.length) {
        return { reply: '止まっている作業はありません。いまは詰まるところが無い状態です。', suggest: ['今どうなってる？', '次の一手を進めて'] };
      }
      return {
        reply: `${rows.length} 件が途中で止まっています。最初からやり直すのではなく、最後にうまくいった地点から続けます（試行回数は引き継ぎます）。`,
        cards: [{
          type: 'list', icon: 'branch', title: '続きから再開できる作業',
          items: rows.map((t) => ({
            title: t.title,
            sub: [STATE_LABEL[t.state] || t.state, t.last_success_step ? `前回成功: ${t.last_success_step}` : (t.next_action || null), t.attempt ? `試行 ${t.attempt} 回` : null].filter(Boolean).join(' · '),
            badge: '続きから', tone: 'warn', act: `resume:${t.id}`, act_label: '再開',
          })),
        }],
        suggest: ['今どうなってる？', '次の一手を進めて'],
      };
    },
  },
  {
    id: 'trace',
    // Manus のレビューが評価するのは「全ステップを見せて検証できること」。
    // n8n が愛される理由も可視化。ここでは runs から実際の足あとだけを出す。
    test: (s) => has(s, '足あと', '何をした', 'なにをした', 'ログ', '履歴', 'やったこと', 'ステップを見'),
    run: async (s, d) => {
      const [runs, done] = await Promise.all([
        d.store.all(`SELECT summary,state,created_at FROM runs ORDER BY created_at DESC LIMIT 12`).catch(() => []),
        d.store.all(`SELECT title,finished_at FROM tasks WHERE state='completed' ORDER BY finished_at DESC LIMIT 6`).catch(() => []),
      ]);
      const items = [
        ...done.map((t) => ({ t: t.title, s: `完了 · ${String(t.finished_at || '').slice(0, 16).replace('T', ' ')}`, cls: 'ok' })),
        ...runs.map((r) => ({ t: r.summary || r.state || '実行', s: `${r.state || ''} · ${String(r.created_at || '').slice(0, 16).replace('T', ' ')}`, cls: r.state === 'failed' ? 'next' : 'ok' })),
      ].slice(0, 14);
      if (!items.length) {
        return { reply: 'まだ足あとがありません。「始めて」と言えば、何をしたかをここに全部残します。', suggest: ['始めて', '今どうなってる？'] };
      }
      return {
        reply: `実際にやったこと ${items.length} 件です。ごまかしのないよう、記録に残っている動作だけを出しています。`,
        cards: [{ type: 'trace', icon: 'pulse', title: 'エージェントの足あと', items }],
        suggest: ['今どうなってる？', '続きから再開できる？'],
      };
    },
  },
  {
    id: 'watch',
    // Vellum が最も評価された「こちらが頼んだことを見張って、向こうから知らせる」。
    test: (s) => has(s, '監視', '見張', 'ウォッチ', '超えたら', 'なったら教え', '知らせて'),
    run: async (s, d) => {
      const parsed = parseWatch(s);
      if (!parsed) {
        return { reply: '何を見張るか教えてください。たとえば「実測収益が3万円を超えたら教えて」「失敗した作業が3件になったら知らせて」のように言ってもらえれば、条件を満たしたときに私から報告します。' };
      }
      const w = await createWatch(d.store, { ...parsed, thread_id: d.thread_id || null, note: s.slice(0, 220), hold: !!parsed.hold });
      const label = WATCH_METRICS[w.metric]?.label || w.metric;
      const unit = WATCH_METRICS[w.metric]?.unit || '';
      const current = await metricValue(d.store, w.metric).catch(() => null);
      const p = goalProgress(w, current || 0);
      return {
        reply: `${w.hold ? '完了条件として' : '見張りを'}始めました。「${label} が ${w.op === '<=' ? 'これ以下' : 'これ以上'} ${Number(w.threshold).toLocaleString('ja-JP')}${unit}」になったら、私からこの会話で報告します。${current != null ? `
いまの値は ${Number(current).toLocaleString('ja-JP')}${unit} です。` : ''}${w.hold && p.remain > 0 ? `あと ${Number(p.remain).toLocaleString('ja-JP')}${unit} なので、未達のあいだは作業を続けます。` : ''}
止めたいときは「見張りをやめて」と言ってください。`,
        cards: [{
          type: 'list', icon: 'eye', title: w.hold ? '完了条件' : 'いま見張っていること',
          items: [{
            title: `${label} ${w.op === '<=' ? '≤' : '≥'} ${Number(w.threshold).toLocaleString('ja-JP')}${unit}`,
            sub: [current != null ? `いま ${Number(current).toLocaleString('ja-JP')}${unit}` : '未計測', w.hold ? `あと ${Number(p.remain).toLocaleString('ja-JP')}${unit}` : null].filter(Boolean).join(' · '),
            badge: w.hold ? '達成まで続ける' : '見張り中', tone: 'accent', act: `watch_off:${w.id}`, act_label: '解除',
          }],
        }],
        watch_id: w.id,
        suggest: ['今どうなってる？', '何ができる？'],
      };
    },
  },
  {
    id: 'scope',
    // 評価の高いアシスタントに共通する「範囲の明示」と「鍵の分離」。
    test: (s) => has(s, '何ができ', 'なにができ', 'できること', 'やらないこと', '権限', '何をしていい', 'どこまで'),
    run: async (s, d) => {
      const present = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY'].filter((k) => d.env && d.env[k]);
      const paid = String(d.env?.ALLOW_PAID_AI || 'false') === 'true';
      const items = [
        ...POLICY.autonomous.map((x) => ({ title: x, badge: '自分でやる', tone: 'ok' })),
        ...POLICY.approval_required.map((x) => ({ title: x, badge: '承認が必要', tone: 'warn' })),
        ...POLICY.never.map((x) => ({ title: x, badge: 'やらない', tone: 'danger' })),
      ];
      return {
        reply: `いまの範囲はこうなっています。判断に迷う操作は必ず止めて聞きます。
無料のAIキーは ${present.length} 件が使える状態、有料AIは${paid ? '有効' : '無効（課金は起きません）'}です。`,
        cards: [
          { type: 'list', icon: 'shield', title: 'できること / 承認が要ること / やらないこと', items },
          { type: 'note', icon: 'key', title: '鍵のあつかい', text: POLICY.keys },
        ],
        suggest: ['承認まちを見せて', '今どうなってる？'],
      };
    },
  },
  {
    id: 'status',
    test: (s) => has(s, '状況', '進捗', 'どうなって', 'うまくいって', '今どう', '報告', 'レポート', 'まとめ', '様子', '調子'),
    run: async (s, d) => {
      const [st, m, tasks] = await Promise.all([d.engine.engineState(), boardMetrics(d), liveTasks(d)]);
      const events = [];
      const cards = [moneyCard(m.led, m.mode, m)];
      if (tasks.length) cards.push(taskList(tasks, 'いま動いている作業'));
      const progress = m.mission?.progress != null ? `（進捗 ${m.mission.progress}%）` : '';
      const lines = [
        `エンジンは${st.status === 'running' ? '稼働中' : st.status === 'paused' ? '一時停止中' : '停止中'}です。${m.mission ? `目標「${m.mission.title}」${progress}を進めています。` : 'まだ目標が設定されていません。'}`,
        m.lastSuccess?.title ? `直近で終わったのは「${m.lastSuccess.title}」です。` : null,
      ].filter(Boolean);
      if (m.counts.waiting) events.push({ text: `あなたの判断待ちが ${m.counts.waiting} 件あります`, tone: 'warn' });
      return { reply: lines.join('\n'), cards, events, suggest: ['次の一手を進めて', '収益はいくら？', '始めて'] };
    },
  },
  {
    id: 'pause',
    test: (s) => has(s, '止め', '停止', '一時停止', '休止', 'ストップ', 'やめ') && !has(s, '止ま'),
    run: async (s, d) => {
      const r = await d.engine.control(re(s, /再開|戻して/) ? 'resume' : 'pause', { note: 'オーナーの指示' });
      return { reply: r?.ok === false ? '停止できませんでした。' : '了解しました。自走を止めました。再開したいときは「始めて」と言ってください。' };
    },
  },
  {
    id: 'start',
    test: (s) => has(s, '始め', '開始', '稼働', 'スタート', '動か', '回して', '再開', '動き出'),
    run: async (s, d) => {
      const st = await d.engine.engineState();
      const r = st.status === 'paused' ? await d.engine.control('resume') : await d.engine.control('start');
      if (r?.ok === false) return { reply: `開始できませんでした（${r.error || '不明'}）。` };
      const steps = await d.engine.tick({ maxSteps: stepsOf(s, 2), source: 'chat' }).catch(() => null);
      const m = await boardMetrics(d);
      const ran = (steps?.steps || []).length;
      return {
        reply: `始めました。${ran ? `${ran}ステップ実行して、いまは実行中 ${m.counts.running} 件・待機 ${m.counts.queued} 件です。` : '次の周期から作業を進めます。'}進み具合はいつでも「今どうなってる？」で聞いてください。`,
        events: (steps?.steps || []).slice(0, 5).map((x) => ({ text: `${x.step || 'ステップ'}: ${x.task_title || x.title || '実行'}`, tick: true })),
        suggest: ['今どうなってる？', '止めて'],
      };
    },
  },
  {
    id: 'tick',
    test: (s) => has(s, '進め', '次の一手', '次を実行', '実行して', '取り掛か', 'やっておいて', '作業して'),
    run: async (s, d) => {
      const want = stepsOf(s, 3);
      const r = await d.engine.tick({ maxSteps: want, source: 'chat' });
      const steps = (r?.steps || []);
      const m = await boardMetrics(d);
      const cards = [moneyCard(m.led, m.mode, m)];
      const tasks = await liveTasks(d);
      if (tasks.length) cards.push(taskList(tasks, '進行中の作業'));
      const ok = steps.filter((x) => x.result !== 'failed' && x.ok !== false).length;
      const lines = [
        steps.length ? `${steps.length}ステップ進めました（完了 ${ok} / 失敗 ${steps.length - ok}）。` : '実行できるステップがありませんでした。目標が未設定かもしれません。',
        'いまの状況はこちらです。',
      ];
      return {
        reply: lines.join('\n'),
        cards,
        events: steps.slice(0, 6).map((x) => ({
          text: `${x.task_title || x.step || 'ステップ'}${x.result ? ` → ${x.result}` : ''}`,
          tick: x.result !== 'failed',
        })),
        suggest: ['今どうなってる？', 'もう少し進めて', '収益はいくら？'],
      };
    },
  },
  {
    id: 'mission',
    test: (s) => (has(s, '目標', 'ミッション') && has(s, '作', '設定', '追加', 'にして', '変え', '変更', '決め')) || re(s, /月\s*\d+\s*万?\s*円?\s*(を|稼)/),
    run: async (s, d) => {
      const target = amountOf(s) || 30000;
      const unit = 'JPY';
      const title = `${yen(target).replace('¥', '')}円/月をつくる`;
      const goal = s.replace(/^(目標|ミッション)?\s*(を|は)?\s*(作って|設定して|追加して|決めて|にして)?\s*/g, '').trim() || `${yen(target)}/月の追加収益を、規約と法令の順守のもとで継続的に生み出す`;
      const id = rid('msn');
      await d.store.run(`UPDATE missions SET status='paused', updated_at=? WHERE status='active'`, new Date().toISOString());
      await d.store.insert('missions', {
        id, title: title.slice(0, 60), goal,
        constraints: '元手ゼロ〜最小、多重アカウント禁止、法令・規約遵守',
        success_metric: '実測収益(measured)の月次合計', target_value: target, metric_unit: unit,
        status: 'active', priority: 80, autonomy_level: 4, progress: 0,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      let planned = 0;
      try {
        const { planMission } = await import('../engine/planner.js');
        const character = await d.engine.getCharacter();
        const mission = await d.store.get('missions', id);
        const plan = await planMission({ store: d.store, router: d.router, memory: d.memory, character, mission, existingTasks: [] });
        planned = (plan?.tasks || plan?.created || []).length || 0;
      } catch { planned = 0; }
      return {
        reply: `目標を「${title}」に設定しました。${planned ? `最初の${planned}件の作業に分解して、キューに入れました。` : 'これから作業に分解します。'}\n「始めて」と言えば自走を開始します。`,
        suggest: ['始めて', '今どうなってる？'],
      };
    },
  },
  {
    id: 'learn',
    // Grok Bot's best trick: watch how the work was done once, then run it as a
    // routine next time. Here the routine is built from the steps that actually
    // completed, so it can only contain things the agent really did.
    test: (s) => has(s, '手順を覚え', 'この手順', 'このやり方', 'ルーティン', '定型', 'やり方を覚え', '手順として'),
    run: async (s, d) => {
      const rows = await d.store.all(
        `SELECT title, tool_name FROM tasks WHERE state='completed' ORDER BY finished_at DESC LIMIT 6`).catch(() => []);
      if (!rows.length) {
        return { reply: '覚えられる手順がまだありません。先に作業をいくつか進めてもらえれば、その流れを定型として保存します。' };
      }
      const steps = rows.reverse().map((r, i) => ({ id: `step${i + 1}`, title: r.title, tool: r.tool_name || 'noop', args: {} }));
      const w = await d.workflows.save({
        name: `覚えた手順 ${new Date().toLocaleDateString('ja-JP')}`,
        definition: { schedule: '0 9 * * *', steps },
      });
      return {
        reply: `直近に完了した作業 ${steps.length} 件から手順を組み立てて、「${w?.name || '定型'}」として保存しました。次からは同じ流れを自分で回します。違う動きをさせたいときは、その場で直してください。`,
        cards: [{ type: 'list', icon: 'branch', title: '保存した手順', items: steps.map((x, i) => ({ title: `${i + 1}. ${x.title}`, sub: x.tool, badge: null })) }],
        suggest: ['始めて', '今どうなってる？'],
      };
    },
  },
  {
    id: 'remember',
    test: (s) => has(s, 'メモ', '覚えて', '記憶して', 'ナレッジに入れ', '資料として'),
    run: async (s, d) => {
      const text = s.replace(/^.*?(メモして|メモ|覚えておいて|覚えて|記憶して|ナレッジに入れて|資料として)[:：]?\s*/, '').trim() || s;
      await d.memory.write({ kind: 'fact', key: `owner:${Date.now()}`, text, evidence: 'measured', importance: 60 });
      return { reply: `覚えました。今後はこの内容を踏まえて判断します。\n\n「${text.slice(0, 120)}」` };
    },
  },
  {
    id: 'ledger',
    test: (s) => re(s, /\d/) && has(s, '記録', '追加', '入金', '売上', '収益', '費用', '経費', '出費', '稼いだ', '使った'),
    run: async (s, d) => {
      const amount = amountOf(s);
      if (!amount) return { reply: '金額を教えてください（例:「収益 3000円 を記録」）。' };
      const isCost = has(s, '費用', '経費', '出費', '使った', 'コスト');
      const evidence = first(/(https?:\/\/\S+)/, s);
      const basis = evidence || has(s, '実測', '実際に', '確認済み', '証明') ? 'measured' : 'estimated';
      await d.store.insert('ledger', {
        id: rid('led'), kind: isCost ? 'cost' : 'revenue', amount, currency: 'JPY', basis,
        source: evidence || null, opportunity_id: null,
        occurred_on: new Date().toISOString().slice(0, 10),
        note: s.slice(0, 180), created_at: new Date().toISOString(),
      });
      const m = await boardMetrics(d);
      return {
        reply: [
          `${isCost ? '費用' : '収益'} ${yen(amount)} を記録しました（${basis === 'measured' ? '実測' : '推定'}として扱います）。`,
          basis === 'measured' ? '根拠つきなので実績に算入します。' : '根拠URLを添えてもらえれば実測に切り替えます（推定値は実績に数えません）。',
        ].join('\n'),
        cards: [moneyCard(m.led, m.mode, m)],
      };
    },
  },
  {
    id: 'money',
    test: (s) => has(s, 'いくら', '収支', '収益', '実績', '売上', '利益', '損益', '儲か'),
    run: async (s, d) => {
      const m = await boardMetrics(d);
      return {
        reply: m.led.revenue.measured > 0
          ? '実測でこれだけ入っています。内訳はこちらです。'
          : 'まだ実測の収益は0円です。下の見込みは実績には数えません。確度の高い候補から進めます。',
        cards: [moneyCard(m.led, m.mode, m)],
        suggest: ['稼げる方法を探して', '次の一手を進めて'],
      };
    },
  },
  {
    id: 'opportunities',
    test: (s) => has(s, '稼げ', '案件', '候補', '有望', 'ランキング', '探して', 'リサーチして', '商売', '副業'),
    run: async (s, d) => {
      let rank = null;
      try {
        const character = await d.engine.getCharacter();
        rank = await d.ranking.rank(d.store, { persist: true, character });
      } catch { rank = null; }
      const alloc = rank?.allocation || rank?.candidates || [];
      const items = alloc.slice(0, 5).map((x) => ({
        title: x.opportunity?.name || x.name || '候補',
        sub: [x.opportunity?.domain || x.domain, x.weekly_revenue != null ? `見込み ${yen(x.weekly_revenue)}/週` : null].filter(Boolean).join(' · '),
        badge: x.score != null ? `${Math.round(x.score)}点` : null,
        tone: 'accent',
      }));
      return {
        reply: rank
          ? `${rank.total ?? items.length}件の候補を評価して、確度と実行しやすさで並べ直しました。上位から着手します。`
          : '候補の評価に必要なデータがまだありません。「始めて」と言ってもらえれば調査から自分で進めます。',
        cards: items.length ? [{ type: 'list', icon: 'trending', title: 'いま有望な順', items }] : [],
        suggest: ['次の一手を進めて', '収益はいくら？'],
      };
    },
  },
  {
    id: 'research',
    test: (s) => has(s, '調べ', '調査', 'リサーチ', 'について教えて', '検索', 'ググ'),
    run: async (s, d) => {
      const q = s.replace(/^.*?(調べて|調べる|調査して|調査|リサーチして|リサーチ|検索して|検索|について教えて|ググって)[:：]?\s*/, '').replace(/(について|を)$/, '').trim() || s;
      let r = null;
      try { r = await d.research.search(q, { limit: 6 }); } catch { r = null; }
      const items = (r?.results || r?.items || []).slice(0, 5).map((x) => ({
        title: x.title || x.name || String(x.url || '結果'),
        sub: x.snippet || x.summary || x.url || '',
        badge: null, tone: 'ghost',
      }));
      if (!items.length) {
        return {
          reply: `「${q}」について調べましたが、いまは外部検索から確かな結果を取れませんでした。AIキーか検索エンドポイントを設定すれば、ここで調べた内容を根拠つきで返せます。代わりに、いま持っている候補の整理と優先順位づけは私が進められます。`,
          suggest: ['稼げる方法を探して', '今どうなってる？'],
        };
      }
      return {
        reply: `「${q}」で ${items.length} 件見つかりました。要点は次のとおりです。`,
        cards: [{ type: 'list', icon: 'search', title: `調査: ${q}`, items }],
        suggest: ['これを目標にして', '次の一手を進めて'],
      };
    },
  },
  {
    id: 'tasks',
    test: (s) => has(s, 'タスク', 'やること', '次は', '次に何', '待ち', 'キュー'),
    run: async (s, d) => {
      const tasks = await liveTasks(d, ['running', 'planning', 'testing', 'verifying', 'improving', 'queued'], 8);
      return {
        reply: tasks.length ? `いま抱えている作業は ${tasks.length} 件です。` : '待っている作業はありません。「始めて」と言えば自分で次の作業を起こします。',
        cards: tasks.length ? [taskList(tasks, '作業キュー')] : [],
      };
    },
  },
  {
    id: 'approvals',
    test: (s) => has(s, '承認', '許可', '危険', '安全', 'お金を動か'),
    run: async (s, d) => {
      const rows = await d.store.all(`SELECT * FROM approvals WHERE status='pending' ORDER BY requested_at DESC LIMIT 10`).catch(() => []);
      return {
        reply: rows.length
          ? `あなたの承認待ちが ${rows.length} 件あります。お金を動かす操作や外部への公開は、勝手に実行しない決まりにしています。`
          : '承認待ちはありません。危険な操作（送金・注文・外部公開・アカウント作成）は必ずあなたの承認を待つルールです。',
        cards: rows.length ? [{ type: 'list', icon: 'shield', title: '承認待ち', items: rows.map((a) => ({ title: a.summary || a.action || a.kind || '承認要求', sub: a.reason || '', badge: '承認待ち', tone: 'warn' })) }] : [],
      };
    },
  },
  {
    id: 'workflows',
    test: (s) => has(s, 'ワークフロー', '定期実行', '自動化', '毎日', '毎朝', 'スケジュール'),
    run: async (s, d) => {
      const list = await d.workflows.list().catch(() => []);
      return {
        reply: list.length
          ? `${list.length} 件の自動化を登録してあります。決まった手順は私が決まった時刻に回します。`
          : '定例の自動化はまだありませんが、必要になったら私が組みます。',
        cards: list.length ? [{ type: 'list', icon: 'branch', title: '定例の自動化', items: list.slice(0, 6).map((w) => ({ title: w.name, sub: w.enabled ? '有効' : '停止中', badge: w.enabled ? '稼働' : '停止', tone: w.enabled ? 'ok' : 'ghost' })) }] : [],
      };
    },
  },
  {
    id: 'shell',
    test: (s) => has(s, 'コマンド', 'シェル', 'ターミナル', '実行環境', 'クラウドpc', 'cloud pc', 'スクリプトを動か'),
    run: async (s, d) => {
      const cmd = s.replace(/^.*?(実行して|実行|走らせて|動かして)[:：]?\s*/, '').trim();
      if (!cmd || cmd === s) {
        return { reply: 'エージェントの作業環境は、必要になったときに私が裏で使うので、ふだんは何もしなくて大丈夫です。特定のコマンドを今すぐ走らせたいときだけ「これを実行して: ...」と教えてください。' };
      }
      let st = null;
      try { st = await d.runner?.status({ limit: 5 }); } catch { st = null; }
      const paired = Array.isArray(st?.runners) ? st.runners.length > 0 : !!(st && st.runner);
      const r = await d.runner?.enqueue({ command: cmd, requestedBy: 'owner' }).catch((e) => ({ ok: false, error: String(e.message || e) }));
      if (!r || r.ok === false) return { reply: `実行キューに積めませんでした（${r?.error || '不明'}）。` };
      return {
        reply: paired
          ? `作業環境で実行を開始します。結果はここに報告します。`
          : `実行キューに積みました。作業環境がまだ繋がっていないので、必要になったタイミングで私が処理します（あなたの操作は不要です）。`,
      };
    },
  },
  {
    id: 'character',
    test: (s) => has(s, '名前', '口調', '性格', 'キャラ', 'アイコン', 'アバター'),
    run: async (s, d) => {
      const c = await d.engine.getCharacter();
      return {
        reply: `いまの設定は「${c?.name || 'Wealth Agent'}」、口調は「${c?.tone || '未設定'}」、自律性は L${c?.autonomy_level ?? 4} です。右下の「⋯」から変更できます。`,
      };
    },
  },
];

// ---------------------------------------------------------------- fallback

async function askAi(text, d) {
  try {
    const character = await d.engine.getCharacter();
    const m = await boardMetrics(d);
    const prompts = await import('../ai/prompts.js');
    const r = await d.router.complete({
      role: 'chat',
      system: `${prompts.characterSystemPrompt(character, { role: 'chat' })}
# 現在の状況
エンジン: ${(await d.engine.engineState()).status}
実行中: ${m.counts.running} / 待機: ${m.counts.queued} / 完了: ${m.counts.completed}
実測収益: ${m.led.revenue.measured} / 推定: ${m.led.revenue.total_estimated}
目標: ${m.mission?.title || '未設定'}
# 指示
短く、日本語で、次に何をするかまで書くこと。`,
      user: text, maxTokens: 900, temperature: 0.6,
    });
    if (r && r.text && !r.fallback) return { reply: r.text, suggest: SUGGESTIONS };
    return null;
  } catch { return null; }
}

/**
 * Route one owner message to a real action and return what to say back.
 * @returns {Promise<{ok:boolean,kind:string,reply:string,cards?:any[],events?:any[],suggest?:string[]}>}
 */
export async function runCommand({ message, deps }) {
  const text = String(message || '').trim();
  if (!text) return { ok: true, kind: 'empty', reply: '何か話しかけてください。', suggest: SUGGESTIONS };

  for (const rule of RULES) {
    let hit = false;
    try { hit = rule.test(text); } catch { hit = false; }
    if (!hit) continue;
    try {
      const out = (await rule.run(text, deps)) || {};
      // 判定（Judge）— 返答に出た数字を台帳と突き合わせてから返す。補助なので
      // 失敗しても返答は必ず返す。
      let verdict = null;
      try {
        if (AUDIT_KINDS.has(rule.id) || (out.cards || []).length) {
          const m = await boardMetrics(deps).catch(() => null);
          verdict = judgeOutcome(out, {
            ledger: m?.led,
            extraNumbers: { ...(m?.counts || {}), progress: m?.mission?.progress },
          });
          out.events = [...(out.events || []), { text: verdict.line, tick: verdict.ok }];
        }
      } catch { /* 判定は補助 */ }
      // 判定に落ちた返答は、その場で本物の作り直しにつなげる。お金を動かす操作は
      // 作り直さず、承認待ちに回す（POLICY のとおり）。
      let reworked = null;
      try {
        if (verdict && !verdict.ok && verdict.rework?.task_id && typeof deps.rework === 'function') {
          reworked = await deps.rework(verdict.rework.task_id, { reason: verdict.rework.reason }).catch(() => null);
          if (reworked?.ok) {
            out.events = [...(out.events || []), { text: `判定に落ちたので作り直します（試行 ${reworked.attempt} 回目）`, tick: true }];
            out.cards = [...(out.cards || []), { type: 'note', icon: 'branch', title: '判定の差し戻し', text: `根拠: ${verdict.rework.reason}。作り直しに回しました（前回うまくいった地点から再開します）。` }];
          } else if (reworked?.error === 'approval_required') {
            out.events = [...(out.events || []), { text: 'お金を動かす操作なので作り直さず、承認待ちに回しました', tick: false }];
          }
        }
      } catch { /* 差し戻しは補助 */ }
      return { ok: true, kind: rule.id, suggest: SUGGESTIONS, ...out, verdict, reworked };
    } catch (e) {
      return { ok: false, kind: rule.id, reply: `「${rule.id}」の処理でつまずきました（${String(e.message || e)}）。もう一度言い方を変えて試してもらえますか。` };
    }
  }

  const ai = await askAi(text, deps);
  if (ai) return { ok: true, kind: 'ai', ...ai };

  const m = await boardMetrics(deps).catch(() => null);
  return {
    ok: true,
    kind: 'unknown',
    reply: m
      ? `すみません、それはまだうまく掴めませんでした。いまの状況は、実行中 ${m.counts.running} 件・待機 ${m.counts.queued} 件、実測収益 ${yen(m.led.revenue.measured)} です。\n「次の一手を進めて」「収益はいくら？」のように言ってもらえれば、私が動きます。`
      : 'すみません、うまく掴めませんでした。「今どうなってる？」と聞いてもらえれば状況をまとめます。',
    cards: m ? [moneyCard(m.led, m.mode, m)] : [],
    suggest: SUGGESTIONS,
  };
}
