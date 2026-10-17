// Tool registry — the agent's actual capabilities.
// Every tool returns a uniform envelope so the verifier can judge it:
//   { ok, summary, basis, evidence_url, data, artifacts[], error, detail }
// `basis` uses the truthfulness vocabulary (measured|third_party|estimated|unverified).

import { id as newId, nowIso, j, truncate, hash, utcDay } from '../util.js';
import { BASIS, claim, MEASUREMENT } from '../truth.js';
import { gate, spendGuard, sanitizeExternal } from '../safety.js';
import { recordExperience } from '../memory/memory.js';

const ok = (o) => ({ ok: true, basis: BASIS.MEASURED, artifacts: [], ...o });
const fail = (error, o = {}) => ({ ok: false, error: String(error), basis: BASIS.UNVERIFIED, artifacts: [], ...o });

export const TOOL_META = {
  web_search: { category: 'research', needs: [], approval: null, label: 'Web検索' },
  web_fetch: { category: 'research', needs: [], approval: null, label: 'Webページ取得' },
  deep_research: { category: 'research', needs: [], approval: null, label: '深層リサーチ' },
  fx_market_data: { category: 'income_fx', needs: [], approval: null, label: 'FX市場データ取得' },
  fx_generate_strategy: { category: 'income_fx', needs: [], approval: null, label: 'FX戦略仮説の生成' },
  fx_lint_pine: { category: 'income_fx', needs: [], approval: null, label: 'Pine非リペイント検査' },
  fx_backtest: { category: 'income_fx', needs: [], approval: null, label: 'FXバックテスト' },
  rewards_research: { category: 'income_rewards', needs: [], approval: null, label: 'ポイ活・報酬サービス調査' },
  sidehustle_research: { category: 'income_sidehustle', needs: [], approval: null, label: '副業・Web事業調査' },
  rank_opportunities: { category: 'analysis', needs: [], approval: null, label: '機会ランキング' },
  data_analysis: { category: 'analysis', needs: [], approval: null, label: 'データ分析' },
  code_generate: { category: 'coding', needs: [], approval: null, label: 'コード生成' },
  code_test: { category: 'testing', needs: [], approval: null, label: 'コードテスト実行' },
  knowledge_ingest: { category: 'research', needs: [], approval: null, label: '文書の取り込み' },
  knowledge_query: { category: 'research', needs: [], approval: null, label: 'ナレッジ検索' },
  memory_write: { category: 'meta', needs: [], approval: null, label: '記憶の書き込み' },
  ledger_record: { category: 'meta', needs: [], approval: null, label: '収支記録' },
  report_write: { category: 'writing', needs: [], approval: null, label: 'レポート作成' },
  checkpoint: { category: 'meta', needs: [], approval: null, label: 'チェックポイント保存' },
  browser_extract: { category: 'research', needs: [], approval: null, label: 'ページ抽出' },
  // Approval-gated tools (never run without an approved approval record):
  live_order: { category: 'income_fx', needs: [], approval: 'live_order', label: '実口座発注【要承認】' },
  fund_transfer: { category: 'income_rewards', needs: [], approval: 'fund_transfer', label: '換金・資金移動【要承認】' },
  external_publish: { category: 'income_sidehustle', needs: [], approval: 'external_publish', label: '外部公開【要承認】' },
  account_signup: { category: 'income_rewards', needs: [], approval: 'account_signup', label: 'アカウント登録【要承認】' },
};

export function buildTools(deps) {
  const { store, env, router, memory, research, fx, rewards, sidehustle, ranking, knowledge, dataAnalysis, codeAgent, browser } = deps;

  const T = {
    // ---------------- research ----------------
    async web_search(ctx, args) {
      const query = args.query || ctx.task.title;
      const r = await research.search(query, { limit: args.limit || 6 });
      if (!r.sources.length) return fail('no_results', { summary: `「${query}」の検索結果が0件でした`, data: { query } });
      return ok({
        summary: `「${query}」で ${r.sources.length} 件の情報源を取得（出典URL付き）`,
        basis: BASIS.MEASURED,
        data: { query, sources: r.sources },
        artifacts: r.sources.map((s) => ({ type: 'source', url: s.url, title: s.title })),
      });
    },

    async web_fetch(ctx, args) {
      const url = args.url;
      if (!url) return fail('url_required');
      const page = await research.fetch(url);
      if (!page.ok) return fail(page.error || 'fetch_failed', { summary: `取得失敗: ${url}` });
      const { text, flagged } = sanitizeExternal(page.text, 12000);
      return ok({
        summary: `ページ取得: ${page.title || url}（${text.length}文字${flagged ? ` / 指示的表現${flagged}件を無害化` : ''}）`,
        data: { url, title: page.title, text: truncate(text, 9000), status: page.status },
        evidence_url: url,
        artifacts: [{ type: 'page', url, title: page.title }],
      });
    },

    async deep_research(ctx, args) {
      const question = args.question || ctx.task.title;
      const rep = await research.deepResearch({
        question, missionId: ctx.task.mission_id, taskId: ctx.task.id,
        subQuestions: args.sub_questions || null, budget: args.budget || 3,
      });
      if (!rep.findings.length) return fail('no_findings', { summary: `「${question}」で裏付けのある所見を取得できませんでした`, data: rep });
      return ok({
        summary: `深層リサーチ完了: ${rep.findings.length}所見 / 出典${rep.sources.length}件 / 不足${rep.gaps.length}点`,
        data: rep,
        artifacts: rep.sources.map((s) => ({ type: 'source', url: s.url, title: s.title })),
      });
    },

    // ---------------- FX ----------------
    async fx_market_data(ctx, args) {
      const symbol = args.symbol || 'USDJPY';
      const md = await fx.fetchMarketData(store, symbol, { days: args.days || 1500 });
      if (!md.bars.length) return fail('no_market_data', { summary: `${symbol} の市場データを取得できませんでした` });
      return ok({
        summary: `${symbol} の日足 ${md.bars.length} 本を取得（source: ${md.source}, ${md.bars[0].date}〜${md.bars[md.bars.length - 1].date}）`,
        data: { symbol, source: md.source, bars: md.bars.length, from: md.bars[0].date, to: md.bars[md.bars.length - 1].date, cached: md.cached },
        artifacts: [{ type: 'dataset', symbol, bars: md.bars.length, source: md.source }],
      });
    },

    async fx_generate_strategy(ctx, args) {
      const s = await fx.generateStrategy({ store, router, character: ctx.character, symbol: args.symbol || 'USDJPY', seedIdeas: args.ideas || null, avoid: args.avoid || [] });
      if (!s) return fail('generation_failed');
      return ok({
        summary: `戦略仮説を生成: ${s.name}（${s.symbol} / v${s.version}）平文仮説: ${truncate(s.hypothesis, 120)}`,
        data: { strategy_id: s.id, name: s.name, version: s.version, hypothesis: s.hypothesis, params: s.params, pine_version: s.pine_version },
        artifacts: [{ type: 'strategy', id: s.id, name: s.name }],
      });
    },

    async fx_lint_pine(ctx, args) {
      const { strategyId, code } = args;
      let pine = code; let sid = strategyId;
      if (!pine && strategyId) {
        const row = await store.get('fx_strategies', strategyId);
        pine = row?.pine_code; sid = strategyId;
      }
      if (!pine) return fail('no_code');
      const lint = fx.lintPine(pine, { markers: ctx.hypothesisMarkers || null });
      if (sid) await store.run('UPDATE fx_strategies SET non_repaint=?, lint_json=?, updated_at=? WHERE id=?',
        lint.nonRepaint ? 1 : 0, j(lint), nowIso(), sid);
      if (!lint.nonRepaint) {
        return fail(`non_repaint_violation: ${lint.violations.map((v) => v.rule).join(', ')}`, {
          summary: `非リペイント検査 不合格（${lint.violations.length}件）`,
          data: lint, artifacts: [{ type: 'lint', strategy_id: sid, violations: lint.violations.length }],
        });
      }
      return ok({ summary: `非リペイント検査 合格（検査項目 ${lint.checksRun}）`, data: lint, artifacts: [{ type: 'lint', strategy_id: sid }] });
    },

    async fx_backtest(ctx, args) {
      const r = await fx.runBacktestForStrategy(store, {
        strategyId: args.strategy_id, symbol: args.symbol, days: args.days || 1500,
        costModel: args.cost_model || null, overrides: args.overrides || null,
      });
      if (!r.ok) return fail(r.error, { summary: r.summary || 'バックテスト失敗', data: r.data || null });
      const m = r.result.metrics;
      return ok({
        summary: `${r.strategy.name} ${r.symbol} ${r.bars}本: PF ${m.profitFactor ?? 'n/a'} / 勝率 ${m.winRate}% / 期待値 ${m.expectancy} / 最大DD ${m.maxDrawdownPct}% / 取引${m.trades} / 判定 ${r.result.pass ? 'PASS' : 'FAIL'}`,
        data: {
          backtest_id: r.backtestId, metrics: m, walkforward: r.result.walkforward,
          overfit: r.result.overfit, pass: r.result.pass, reasons: r.result.reasons,
        },
        basis: BASIS.MEASURED,
        artifacts: [{ type: 'backtest', id: r.backtestId, pass: r.result.pass, pf: m.profitFactor }],
      });
    },

    // ---------------- rewards / side hustle ----------------
    async rewards_research(ctx, args) {
      const r = await rewards.research({ store, router, memory, mission: ctx.mission, character: ctx.character, topic: args.topic || ctx.task.title, limit: args.limit || 6 });
      if (!r.candidates.length) {
        return fail('no_candidates', { summary: `${r.searched}件の検索から日本で利用可能な候補を確定できませんでした（不確実なものを候補として扱いません）`, data: r });
      }
      return ok({
        summary: `${r.candidates.length}件の候補を登録（却下済み${r.rejected.length}件を除外）`,
        data: r,
        artifacts: r.candidates.map((c) => ({ type: 'opportunity', id: c.id, name: c.name })),
      });
    },

    async sidehustle_research(ctx, args) {
      const r = await sidehustle.research({ store, router, memory, mission: ctx.mission, character: ctx.character, topic: args.topic || ctx.task.title, limit: args.limit || 6 });
      if (!r.candidates.length) return fail('no_candidates', { summary: `副業候補を確定できませんでした`, data: r });
      return ok({ summary: `${r.candidates.length}件の副業候補を登録`, data: r, artifacts: r.candidates.map((c) => ({ type: 'opportunity', id: c.id, name: c.name })) });
    },

    async rank_opportunities(ctx, args) {
      const opts = { domain: args.domain || null, persist: true };
      let r = await ranking.rank(store, opts);
      let seeded = 0;
      if (!r.total) {
        // 候補表が空（方針変更で廃止分を消した後など）。ここで空回りすると
        // 検証に落ちて「改善→再試行」を繰り返すだけになるので、実際に稼ぐ
        // 4本を候補として登録し直してから採点する。
        const { ensureLaneOpportunities } = await import('../income/lanes.js');
        const s = await ensureLaneOpportunities({
          store,
          origin: (env && (env.AGENT_ORIGIN || env.PUBLIC_ORIGIN)) || null,
        });
        seeded = s.seeded;
        r = await ranking.rank(store, opts);
      }
      if (!r.total) {
        return fail('no_candidates', { summary: '機会候補が0件のためランキングを作成できませんでした', data: r });
      }
      const lead = r.top.slice(0, 3).map((t) => `${t.name}(${t.score})`).join(', ');
      const alloc = (r.allocation || [])[0];
      return ok({
        summary: `機会ランキング更新: 全${r.total}件${seeded ? `（稼ぎ方${seeded}本を候補として登録）` : ''}（上位: ${lead}）` +
          (alloc ? ` / 次の一手: ${alloc.name} に資源の ${Math.round(alloc.share * 100)}%（${alloc.next_step}）` : ''),
        data: { ...r, seeded },
      });
    },

    // ---------------- generic capabilities ----------------
    async data_analysis(ctx, args) {
      const r = await dataAnalysis.run({ store, env, router, spec: args.spec || { kind: 'describe' }, datasetId: args.dataset_id, inlineData: args.data });
      if (!r.ok) return fail(r.error, { summary: r.summary });
      return ok({ summary: r.summary, data: r, artifacts: r.artifacts || [] });
    },

    async code_generate(ctx, args) {
      const r = await codeAgent.generate({ store, router, character: ctx.character, spec: args.spec || ctx.task.description || ctx.task.title, language: args.language || 'javascript' });
      if (!r.ok) return fail(r.error, { summary: r.summary });
      return ok({
        summary: `コード生成: ${r.language} / ${r.code.split('\n').length}行（テスト: ${r.tests?.length || 0}件）`,
        data: { snippet_id: r.snippetId, language: r.language, code: r.code, tests: r.tests },
        basis: BASIS.MEASURED,
        artifacts: [{ type: 'code', id: r.snippetId, language: r.language }],
      });
    },

    async code_test(ctx, args) {
      const r = await codeAgent.test({ store, snippetId: args.snippet_id, code: args.code, tests: args.tests, language: args.language });
      if (!r.ran) return fail(r.reason || 'runner_unavailable', { summary: r.summary, data: r });
      if (!r.passed) return fail('tests_failed', { summary: r.summary, data: r });
      return ok({ summary: r.summary, data: r, basis: BASIS.MEASURED, artifacts: [{ type: 'test_result', snippet_id: args.snippet_id, passed: true }] });
    },

    async knowledge_ingest(ctx, args) {
      const r = await knowledge.ingest({ store, name: args.name || 'upload.txt', mime: args.mime || 'text/plain', text: args.text });
      if (!r.ok) return fail(r.error, { summary: r.summary });
      return ok({ summary: `${r.name} を取り込み（${r.chunks}チャンク）`, data: r, artifacts: [{ type: 'document', id: r.id, name: r.name }] });
    },

    async knowledge_query(ctx, args) {
      const r = await knowledge.query({ store, question: args.question || ctx.task.title, limit: args.limit || 5 });
      if (!r.hits.length) return fail('no_hits', { summary: `文書内に根拠が見つかりませんでした（回答を生成しません）`, data: r });
      return ok({ summary: `${r.hits.length}件の根拠箇所を特定`, data: r });
    },

    async memory_write(ctx, args) {
      const mid = await memory.write({
        kind: args.kind || 'fact', text: args.text,
        scope: args.scope || (ctx.task.mission_id ? `mission:${ctx.task.mission_id}` : 'global'),
        key: args.key || null, evidence: args.evidence || 'unverified', importance: args.importance || 50,
      });
      return ok({ summary: `記憶を保存: [${args.kind || 'fact'}] ${truncate(args.text, 80)}`, data: { memory_id: mid } });
    },

    async ledger_record(ctx, args) {
      const kind = args.kind === 'cost' ? 'cost' : 'revenue';
      const basis = ['measured', 'third_party', 'estimated', 'unverified'].includes(args.basis) ? args.basis : 'unverified';
      if (basis === 'measured' && !args.source) return fail('measured_requires_source', { summary: '実測として記録するには証拠(source)が必要です' });
      const row = {
        id: newId('led'), kind, amount: Number(args.amount) || 0, currency: args.currency || 'JPY',
        basis, source: args.source || null, opportunity_id: args.opportunity_id || null,
        occurred_on: args.occurred_on || utcDay(), note: args.note || null, created_at: nowIso(),
      };
      await store.insert('ledger', row);
      return ok({ summary: `収支記録: ${kind} ${row.amount} ${row.currency} (${basis})`, basis: BASIS.MEASURED, data: { ledger_id: row.id, ...row } });
    },

    async report_write(ctx, args) {
      const title = args.title || ctx.task.title;
      const body = args.body || args.summary || '';
      const id = newId('rpt');
      await store.insert('research_reports', {
        id, mission_id: ctx.task.mission_id, task_id: ctx.task.id, question: title,
        summary: body.slice(0, 4000), findings_json: j(args.findings || []), sources_json: j(args.sources || []),
        gaps_json: j(args.gaps || []), created_at: nowIso(),
      });
      return ok({ summary: `レポート保存: ${title}`, data: { report_id: id }, artifacts: [{ type: 'report', id, title }] });
    },

    async checkpoint(ctx, args) {
      const id = newId('ckp');
      await store.insert('checkpoints', {
        id, scope: args.scope || `task:${ctx.task.id}`, state: args.state || 'saved',
        payload: j(args.payload || {}), created_at: nowIso(),
      });
      return ok({ summary: `チェックポイント保存 (${args.state || 'saved'})`, data: { checkpoint_id: id } });
    },

    async browser_extract(ctx, args) {
      const r = await browser.extract({ store, url: args.url, selectorGoal: args.goal || ctx.task.description });
      if (!r.ok) return fail(r.error, { summary: r.summary });
      return ok({ summary: r.summary, data: r, evidence_url: args.url });
    },

    // ---------------- approval-gated ----------------
    async live_order(ctx, args) {
      const g = await gate(store, { action: 'live_order', taskId: ctx.task.id, payload: args });
      if (!g.allowed) return fail(g.reason, { summary: `実口座発注は承認が必要です（${g.label}）。承認リクエストを作成しました。`, data: g, needsApproval: true });
      return fail('not_implemented_in_research_mode', { summary: '研究・デモ検証モードでは実発注を実行しません（明示的な実装と承認が別途必要）' });
    },
    async fund_transfer(ctx, args) {
      const g = await gate(store, { action: 'fund_transfer', taskId: ctx.task.id, payload: args });
      if (!g.allowed) return fail(g.reason, { summary: `資金移動は承認が必要です（${g.label}）`, data: g, needsApproval: true });
      return fail('not_implemented', { summary: '自動資金移動は実装されていません' });
    },
    async external_publish(ctx, args) {
      const g = await gate(store, { action: 'external_publish', taskId: ctx.task.id, payload: args });
      if (!g.allowed) return fail(g.reason, { summary: `外部公開は承認が必要です（${g.label}）`, data: g, needsApproval: true });
      return fail('not_implemented', { summary: '外部公開の自動実行は実装されていません' });
    },
    async account_signup(ctx, args) {
      const g = await gate(store, { action: 'account_signup', taskId: ctx.task.id, payload: args });
      if (!g.allowed) return fail(g.reason, { summary: `アカウント登録は承認が必要です（${g.label}）`, data: g, needsApproval: true });
      return fail('not_implemented', { summary: '自動アカウント登録は実装されていません' });
    },
  };

  return T;
}

/** Dispatch a task to its tool, with approval gating and spend guard. */
export async function executeTool(tools, ctx, toolName, args) {
  const meta = TOOL_META[toolName];
  if (!meta) return fail(`unknown_tool:${toolName}`);
  if (meta.approval) {
    const g = await gate(ctx.store, { action: meta.approval, taskId: ctx.task.id, payload: args });
    if (!g.allowed) return { ...fail(g.reason, { summary: g.label ? `${g.label} は人間の承認が必要です` : g.reason }), needsApproval: true, approvalId: g.approvalId };
  }
  const spend = await spendGuard(ctx.store, ctx.env, { paid: false });
  if (!spend.allowed) return fail(spend.reason, { summary: spend.detail });
  const t0 = Date.now();
  try {
    const res = await tools[toolName](ctx, args || {});
    return { ...res, tool: toolName, duration_ms: Date.now() - t0 };
  } catch (e) {
    return { ...fail(e.message || 'tool_exception', { summary: `ツール実行時例外: ${e.message}` }), tool: toolName, duration_ms: Date.now() - t0 };
  }
}
