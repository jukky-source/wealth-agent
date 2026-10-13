// Chat command router — the chat-first UI sends the owner's plain Japanese
// here, and the agent decides which real action to take and reports back in
// its own words. Nothing is staged: every number in a reply is read back out
// of the store AFTER the action ran, so the conversation cannot drift away
// from what actually happened.

import { summarizeLedger } from '../truth.js';
import { judgeOutcome, POLICY } from './judge.js';
import { parseWatch, createWatch, WATCH_METRICS } from './watch.js';

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const yen = (n) => `¥${Math.round(Number(n) || 0).toLocaleString('ja-JP')}`;
const count = (rows, state) => Number(rows.find((r) => r.state === state)?.c || 0);
const first = (re, s) => (s.match(re) || [])[0];

const has = (s, ...w) => w.some((x) => s.includes(x));

/** 数字を含む返答は必ず検算する（判定を付ける種類）。 */
const AUDIT_KINDS = new Set(['status', 'tick', 'money', 'ledger', 'opportunities', 'resume', 'watch']);
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
    mission,
    lastSuccess: lastSuccess && lastSuccess[0] ? lastSuccess[0] : null,
  };
}

function moneyCard(led) {
  return {
    type: 'kpi',
    title: '収支（実測と推定は分けて数えます）',
    items: [
      { label: '実測収益', value: led.revenue.measured, unit: '円', hl: true },
      { label: '推定収益（不算入）', value: led.revenue.total_estimated, unit: '円' },
      { label: '実測費用', value: led.cost.measured, unit: '円' },
      { label: '実測の純益', value: led.net_profit_measured, unit: '円' },
    ],
  };
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

むずかしい設定は要りません。判断に迷ったら私が決めて進めます。`;

// ---------------------------------------------------------------- rules

const RULES = [
  {
    id: 'help',
    test: (s) => has(s, 'ヘルプ', '使い方', '操作方法', '何を頼め'),
    run: async () => ({ reply: HELP, suggest: SUGGESTIONS }),
  },
  {
    id: 'greet',
    test: (s) => re(s, /^(やあ|こんにちは|こんばんは|おはよう|はじめまして|hi|hello|hey)/i) && s.length < 24,
    run: async (s, d) => {
      const m = await boardMetrics(d);
      return {
        reply: `はい、聞こえています。${m.mission ? `いまは「${m.mission.title}」に向けて動いています。` : '目標がまだ無いので、決めてもらえれば計画から始めます。'}`,
        cards: [moneyCard(m.led)],
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
      const w = await createWatch(d.store, { ...parsed, thread_id: d.thread_id || null, note: s.slice(0, 220) });
      const label = WATCH_METRICS[w.metric]?.label || w.metric;
      const unit = WATCH_METRICS[w.metric]?.unit || '';
      let current = null;
      try {
        const { metricValue } = await import('./watch.js');
        current = await metricValue(d.store, w.metric);
      } catch { current = null; }
      return {
        reply: `見張りを始めました。「${label} が ${w.op === '<=' ? 'これ以下' : 'これ以上'} ${Number(w.threshold).toLocaleString('ja-JP')}${unit}」になったら、私からこの会話で報告します。${current != null ? `
いまの値は ${Number(current).toLocaleString('ja-JP')}${unit} です。` : ''}
止めたいときは「見張りをやめて」と言ってください。`,
        cards: [{ type: 'list', icon: 'eye', title: 'いま見張っていること', items: [{ title: `${label} ${w.op === '<=' ? '≤' : '≥'} ${Number(w.threshold).toLocaleString('ja-JP')}${unit}`, sub: current != null ? `いま ${Number(current).toLocaleString('ja-JP')}${unit}` : '未計測', badge: '見張り中', tone: 'accent', act: `watch_off:${w.id}`, act_label: '解除' }] }],
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
      const cards = [moneyCard(m.led)];
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
      const cards = [moneyCard(m.led)];
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
        cards: [moneyCard(m.led)],
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
        cards: [moneyCard(m.led)],
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
      return { ok: true, kind: rule.id, suggest: SUGGESTIONS, ...out, verdict };
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
    cards: m ? [moneyCard(m.led)] : [],
    suggest: SUGGESTIONS,
  };
}
