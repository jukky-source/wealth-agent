// Planner — turns a mission goal into a DAG of concrete tasks.
// Two paths:
//   * LLM planner (when a provider key exists) → structured JSON plan
//   * deterministic planner (always available) → template decomposition
// Both respect the memory guardrails (prohibitions, rejected candidates,
// failed strategies) so the agent never repeats a known-bad approach.

import { id as newId, nowIso, j, extractJson, truncate, hash } from '../util.js';
import { characterSystemPrompt, memoryBlock } from '../ai/prompts.js';

export const CATEGORY_BLUEPRINT = {
  fx: [
    { title: 'FX市場データを取得しデータ品質を確認', category: 'income_fx', tool: 'fx_market_data', args: { symbol: 'USDJPY', days: 1500 } },
    { title: '戦略仮説を生成（既存の失敗手法を回避）', category: 'income_fx', tool: 'fx_generate_strategy', args: { symbol: 'USDJPY' } },
    { title: '非リペイント検査を実行', category: 'income_fx', tool: 'fx_lint_pine', args: {} },
    { title: 'バックテスト（スプレッド・手数料・スリッページ考慮）', category: 'income_fx', tool: 'fx_backtest', args: {} },
  ],
  rewards: [
    { title: '日本のポイ活・報酬サービスを調査（公式情報で条件確認）', category: 'income_rewards', tool: 'rewards_research', args: {} },
    { title: '換金条件・最低換金額・手数料を検証', category: 'verification', tool: 'deep_research', args: {} },
  ],
  side_hustle: [
    { title: '副業・Web事業の候補を調査（需要と競合を確認）', category: 'income_sidehustle', tool: 'sidehustle_research', args: {} },
    { title: '有望候補の実装可能性を検証', category: 'research', tool: 'deep_research', args: {} },
  ],
  research: [
    { title: '目標に関連する情報を深層リサーチ', category: 'research', tool: 'deep_research', args: {} },
  ],
  analysis: [
    { title: '収益機会を横断比較しランキングを更新', category: 'analysis', tool: 'rank_opportunities', args: {} },
  ],
  general: [
    { title: '目標達成に必要な情報を調査', category: 'research', tool: 'deep_research', args: {} },
    { title: '調査結果から実行可能な施策を立案', category: 'analysis', tool: 'rank_opportunities', args: {} },
    { title: '最有望施策のプロトタイプを実装', category: 'coding', tool: 'code_generate', args: {} },
    { title: '成果を検証し次アクションを決定', category: 'verification', tool: 'report_write', args: {} },
  ],
};

/** Detect which blueprints a mission goal calls for. */
export function classifyGoal(goalText) {
  const g = String(goalText || '').toLowerCase();
  const cats = new Set();
  if (/fx|為替|usdjpy|eurusd|トレード|pine|テクニカル|チャート/.test(g)) cats.add('fx');
  if (/ポイ活|ポイント|報酬|換金|キャッシュバック|アンケート|放置|マイル|paypay|楽天/.test(g)) cats.add('rewards');
  if (/副業|サイド|web事業|アフィリ|広告|saas|コンテンツ|ブログ|アプリ|ツール販売|ネット収益|せどり/.test(g)) cats.add('side_hustle');
  if (/調査|リサーチ|比較|分析/.test(g)) cats.add('research');
  if (cats.size === 0) cats.add('general');
  // A broad "make money" mission should explore every income domain.
  if (/収益|稼ぐ|マネタイズ|月.*円|収入/.test(g) && cats.size === 1 && (cats.has('research') || cats.has('general'))) {
    cats.delete('general');
    cats.add('fx'); cats.add('rewards'); cats.add('side_hustle');
  }
  return [...cats];
}

export function blueprintFor(categories) {
  const tasks = [];
  for (const c of categories) {
    for (const t of (CATEGORY_BLUEPRINT[c] || [])) tasks.push({ ...t, domain: c });
  }
  // Every mission ends with an evaluation + ranking pass.
  tasks.push({ title: '収益機会を横断比較しランキングを更新', category: 'analysis', tool: 'rank_opportunities', args: {}, domain: 'analysis' });
  return tasks;
}

/**
 * Decompose a mission into persisted tasks.
 * Returns the created task rows.
 */
export async function planMission({ store, router, memory, character, mission, existingTasks = [] }) {
  const guard = await memory.guardrails(`mission:${mission.id}`);
  const experiences = await memory.recentExperience(`mission:${mission.id}`, 15);

  const categories = classifyGoal(`${mission.title} ${mission.goal} ${mission.constraints || ''}`);
  let plan = null;

  // --- LLM path -------------------------------------------------------------
  if (router.availableProviders().length) {
    const prompt = `ミッション: ${mission.title}
目標: ${mission.goal}
制約: ${mission.constraints || 'なし'}
成功指標: ${mission.success_metric || '未設定'}

推定される領域: ${categories.join(', ')}

# 長期記憶（禁止事項・却下済み・失敗経験 — これらを必ず回避すること）
${memoryBlock([...guard, ...experiences])}

# 現在のタスク（重複を避ける）
${existingTasks.map((t) => `- [${t.state}] ${t.title}`).join('\n') || '（なし）'}

# 指示
目標達成のために次に実行すべきタスクを 4〜8 件、依存関係つきで分解してください。
各タスクは必ず「実行可能なツール」に紐づけます。利用可能なツール:
${Object.keys(CATEGORY_BLUEPRINT).map((k) => `${k}: ${CATEGORY_BLUEPRINT[k].map((t) => t.tool).join(', ')}`).join('\n')}
rank_opportunities, deep_research, web_search, data_analysis, code_generate, code_test, report_write

JSONのみで返す:
{"tasks":[{"title":"...","category":"research|analysis|coding|testing|income_fx|income_rewards|income_sidehustle|verification|writing","tool_name":"...","tool_args":{},"priority":0-100,"depends_on_titles":["..."],"rationale":"なぜ今これをやるか"}]}`;

    const r = await router.complete({
      role: 'planner', system: characterSystemPrompt(character, { role: 'planner' }),
      user: prompt, json: true,
      schema: ['tasks'], maxTokens: 1600, temperature: 0.5,
    });
    const parsed = r.json || extractJson(r.text);
    if (parsed?.tasks?.length) plan = normalizePlan(parsed.tasks, categories);
  }

  // --- deterministic path ---------------------------------------------------
  if (!plan) plan = blueprintFor(categories);

  // Drop tasks that duplicate an existing open task.
  const openTitles = new Set(existingTasks.filter((t) => !['completed', 'cancelled', 'failed'].includes(t.state)).map((t) => normTitle(t.title)));
  plan = plan.filter((t) => !openTitles.has(normTitle(t.title)));

  if (!plan.length) return { created: [], categories, note: '新規タスクなし（既存タスクが網羅済み）' };

  const titleToId = {};
  const created = [];
  for (const t of plan) {
    const row = {
      id: newId('tsk'), mission_id: mission.id, parent_id: null,
      title: t.title, description: t.rationale || t.description || t.title,
      category: t.category || 'research', state: 'queued',
      priority: t.priority ?? 50, score: 0, score_reasons: null,
      depends_on: j([]), attempt: 0, max_attempts: 3,
      last_success_step: null, next_action: '計画の実行', tool_name: t.tool_name || t.tool || null,
      tool_args: j(t.tool_args || {}), result_ref: null, error_history: j([]),
      strategy: t.strategy || null, strategy_switches: 0, progress_marker: null,
      artifacts: j([]), created_at: nowIso(), updated_at: nowIso(),
      started_at: null, finished_at: null,
    };
    titleToId[normTitle(t.title)] = row.id;
    created.push(row);
  }
  // Resolve dependencies by title.
  for (const t of plan) {
    const row = created.find((c) => normTitle(c.title) === normTitle(t.title));
    if (!row) continue;
    const deps = (t.depends_on_titles || []).map((x) => titleToId[normTitle(x)]).filter(Boolean);
    row.depends_on = j(deps);
  }
  await store.insertMany('tasks', created);

  await memory.write({
    kind: 'checkpoint', scope: `mission:${mission.id}`, key: `plan:${mission.id}:${hash(created.map((c) => c.title).join('|'))}`,
    text: `ミッション「${mission.title}」を ${created.length} タスクに分解: ${created.map((c) => c.title).join(' / ')}`,
    evidence: 'measured', importance: 55,
    data: { task_ids: created.map((c) => c.id), categories },
  });

  return { created, categories };
}

function normalizePlan(tasks, categories) {
  const allowedTools = new Set([
    'web_search', 'web_fetch', 'deep_research', 'fx_market_data', 'fx_generate_strategy', 'fx_lint_pine', 'fx_backtest',
    'rewards_research', 'sidehustle_research', 'rank_opportunities', 'data_analysis',
    'code_generate', 'code_test', 'knowledge_ingest', 'knowledge_query', 'memory_write',
    'ledger_record', 'report_write', 'checkpoint', 'browser_extract',
  ]);
  return tasks.slice(0, 10).map((t) => ({
    title: truncate(t.title || 'untitled task', 120),
    category: t.category || 'research',
    tool_name: allowedTools.has(t.tool_name) ? t.tool_name : null,
    tool_args: t.tool_args && typeof t.tool_args === 'object' ? t.tool_args : {},
    priority: Math.max(0, Math.min(100, Number(t.priority) || 50)),
    rationale: t.rationale || '',
    depends_on_titles: Array.isArray(t.depends_on_titles) ? t.depends_on_titles : [],
  })).filter((t) => t.title);
}

/**
 * Re-plan after failures: produce a strategy-shifted task.
 * Guarantees a *different* approach than the one that failed.
 */
export async function replanAfterFailure({ store, router, memory, character, mission, failedTask, diagnosis }) {
  const failed = await memory.byKinds(['strategy', 'failure'], `mission:${mission.id}`, 12);
  const tried = new Set([failedTask.tool_name].filter(Boolean));

  const prompt = `失敗したタスク: ${failedTask.title}
使用したツール: ${failedTask.tool_name}
カテゴリ: ${failedTask.category}
失敗の診断: ${diagnosis}
試行回数: ${failedTask.attempt}

# 既に失敗した手法（再使用禁止）
${memoryBlock(failed)}

# 指示
上記とは異なる仮説・手段で、同じ目的を達成する新しいタスクを1〜2件提案してください。
必ず別の tool_name を使うか、条件・パラメータを根本的に変えてください。
JSONのみ: {"tasks":[{"title":"...","category":"...","tool_name":"...","tool_args":{},"priority":0-100,"rationale":"前回との差分"}]}`;

  let plan = null;
  if (router.availableProviders().length) {
    const r = await router.complete({ role: 'optimizer', system: characterSystemPrompt(character, { role: 'optimizer' }), user: prompt, json: true, schema: ['tasks'], maxTokens: 900, temperature: 0.7 });
    const parsed = r.json || extractJson(r.text);
    if (parsed?.tasks?.length) plan = parsed.tasks.slice(0, 2);
  }
  if (!plan) {
    // Deterministic alternative-strategy table.
    const alt = ALT_STRATEGY[failedTask.category] || ALT_STRATEGY.default;
    plan = alt.filter((a) => !tried.has(a.tool_name)).slice(0, 1).map((a) => ({
      ...a, rationale: `前回の ${failedTask.tool_name} が失敗したため、${a.tool_name} に切り替えます。`,
    }));
    if (!plan.length) plan = [{
      title: `「${truncate(failedTask.title, 60)}」の前提条件を再調査する`,
      category: 'research', tool_name: 'deep_research', tool_args: { question: `${failedTask.title} が失敗した原因と代替手段` },
      priority: 60, rationale: '既知の代替手段が尽きたため、前提から再調査します。',
    }];
  }

  const created = [];
  for (const t of plan) {
    const row = {
      id: newId('tsk'), mission_id: mission.id, parent_id: failedTask.id,
      title: truncate(t.title, 120), description: t.rationale || '',
      category: t.category || failedTask.category, state: 'queued',
      priority: t.priority ?? Math.max(40, (failedTask.priority || 50) - 5),
      score: 0, depends_on: j([]), attempt: 0, max_attempts: 3,
      last_success_step: null, next_action: '代替戦略の実行',
      tool_name: t.tool_name || null, tool_args: j(t.tool_args || {}),
      result_ref: null, error_history: j([]),
      strategy: `alt-after-${failedTask.tool_name || 'unknown'}`,
      strategy_switches: (failedTask.strategy_switches || 0) + 1,
      progress_marker: null, artifacts: j([]),
      created_at: nowIso(), updated_at: nowIso(), started_at: null, finished_at: null,
    };
    created.push(row);
  }
  await store.insertMany('tasks', created);
  await memory.write({
    kind: 'strategy', scope: `mission:${mission.id}`,
    key: `replan:${failedTask.category}:${failedTask.attempt}`,
    text: `「${failedTask.title}」失敗（${diagnosis}）→ 代替戦略 ${created.map((c) => c.tool_name).join(', ')} に切替。`,
    evidence: 'measured', importance: 72,
  });
  return created;
}

const ALT_STRATEGY = {
  income_fx: [
    { title: '別の戦略ファミリー（トレンドフォロー→平均回帰）を検証', category: 'income_fx', tool_name: 'fx_generate_strategy', tool_args: { ideas: ['mean_reversion_rsi', 'bollinger_fade'] } },
    { title: '対象銘柄を変更して再検証（分散）', category: 'income_fx', tool_name: 'fx_backtest', tool_args: { symbol: 'EURUSD' } },
  ],
  income_rewards: [
    { title: '調査軸を変更（即日換金型→継続型）で候補を再探索', category: 'income_rewards', tool_name: 'rewards_research', tool_args: { topic: '継続型・自動積立型のポイント還元' } },
    { title: '海外クラウドソーシング型の案件を調査', category: 'income_sidehustle', tool_name: 'sidehustle_research', tool_args: { topic: 'オンライン案件 面接なし' } },
  ],
  income_sidehustle: [
    { title: '既存需要の検証に切り替える（検索ボリューム・競合分析）', category: 'research', tool_name: 'deep_research', tool_args: { question: '個人開発SaaSの需要と競合の実データ' } },
    { title: '低リスクの収益手段に切り替える（ポイ活・報酬系）', category: 'income_rewards', tool_name: 'rewards_research', tool_args: {} },
  ],
  coding: [
    { title: '実装方針を変更（依存を減らす最小構成）で再実装', category: 'coding', tool_name: 'code_generate', tool_args: { spec: '依存ゼロの単一ファイル実装に変更' } },
  ],
  research: [
    { title: '検索クエリを英語圏に切り替えて再調査', category: 'research', tool_name: 'web_search', tool_args: { query: 'english sources alternative' } },
  ],
  default: [
    { title: '前提条件を見直して再計画', category: 'analysis', tool_name: 'rank_opportunities', tool_args: {} },
  ],
};

/** Suggested next action text for the Mission Control screen. */
export function explainNext(task) {
  if (!task) return '実行可能なタスクがありません（再計画が必要）';
  return `${task.title} — ツール: ${task.tool_name || '未指定'} / 優先度 ${Math.round(task.priority)}`;
}

function normTitle(t) { return String(t || '').replace(/\s+/g, '').toLowerCase(); }
