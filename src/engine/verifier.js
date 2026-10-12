// Verifier — evidence-based acceptance. A task is only "completed" when the
// tool output satisfies an explicit, machine-checkable criterion.
// No evidence ⇒ not complete. Estimates never satisfy a revenue criterion.

import { BASIS } from '../truth.js';
import { safeJson } from '../util.js';

/**
 * @returns {{passed:boolean, reason?:string, checks:Array<{name,passed,detail}>}}
 */
export function verifyResult(task, res, { toolName } = {}) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: !!passed, detail });

  add('tool_returned_ok', res.ok === true, res.ok ? 'ツール成功' : `エラー: ${res.error}`);
  add('has_summary', !!res.summary, res.summary ? '要約あり' : '要約なし');

  const data = res.data || {};

  switch (toolName) {
    case 'web_search': {
      const n = data.sources?.length || 0;
      add('sources_ge_3', n >= 3, `${n}件の情報源`);
      add('sources_have_urls', (data.sources || []).every((s) => /^https?:\/\//.test(s.url || '')),
        '全情報源に出典URL');
      break;
    }
    case 'deep_research': {
      add('findings_present', (data.findings?.length || 0) > 0, `${data.findings?.length || 0}所見`);
      const cited = (data.findings || []).filter((f) => (f.sources || []).length > 0).length;
      add('findings_cited', (data.findings || []).length === 0 ? false : cited / data.findings.length >= 0.6, `${cited}/${data.findings?.length || 0} に出典`);
      add('no_fabricated_revenue', !JSON.stringify(data).match(/"basis"\s*:\s*"measured"[^}]*revenue/i), '推定を実測として混在させていない');
      break;
    }
    case 'fx_market_data': {
      add('bars_ge_250', (data.bars || 0) >= 250, `${data.bars || 0}本`);
      add('has_source', !!data.source, `source: ${data.source}`);
      break;
    }
    case 'fx_lint_pine':
      add('non_repaint', data.nonRepaint === true, `違反 ${data.violations?.length || 0}件`);
      break;
    case 'fx_backtest': {
      const m = data.metrics || {};
      add('trades_ge_30', (m.trades || 0) >= 30, `${m.trades || 0}取引（統計的有意性の目安）`);
      add('metrics_complete', ['profitFactor', 'winRate', 'expectancy', 'maxDrawdownPct'].every((k) => m[k] !== undefined && m[k] !== null), '指標が揃っている');
      add('walkforward_present', !!data.walkforward, data.walkforward ? 'ウォークフォワード実施' : '未実施');
      add('not_overfit_flag', data.overfit?.verdict !== 'overfit_high', `過剰最適化判定: ${data.overfit?.verdict || 'n/a'}`);
      add('cost_model_applied', !!data.backtest_id, 'スプレッド/手数料/スリッページ適用');
      break;
    }
    case 'rewards_research':
    case 'sidehustle_research': {
      const cands = data.candidates || [];
      add('candidates_present', cands.length > 0, `${cands.length}件`);
      add('japan_availability_known', cands.every((c) => ['yes', 'no', 'conditional', 'unknown'].includes(c.japan_availability)), '日本からの利用可否を記録');
      add('revenue_basis_set', cands.every((c) => !!c.revenue_basis), '収益根拠の区分を記録');
      add('no_measured_without_evidence', cands.every((c) => c.revenue_basis !== 'measured' || (c.evidence_urls || []).length > 0), '実測収益には証拠URL');
      break;
    }
    case 'rank_opportunities':
      add('ranking_produced', (data.total || 0) > 0, `${data.total || 0}件を評価`);
      add('breakdown_present', (data.top || []).every((t) => !!t.score_breakdown), 'スコア内訳を保存');
      break;
    case 'code_generate':
      add('code_nonempty', (data.code || '').length > 20, `${(data.code || '').split('\n').length}行`);
      add('tests_generated', (data.tests || []).length > 0, `テスト ${data.tests?.length || 0}件`);
      break;
    case 'code_test':
      add('tests_ran', res.data?.ran === true, res.data?.runner || 'runner未実行');
      add('tests_passed', res.data?.passed === true, `${res.data?.passedCount ?? 0}/${res.data?.total ?? 0} 合格`);
      break;
    case 'knowledge_ingest':
      add('chunks_created', (data.chunks || 0) > 0, `${data.chunks || 0}チャンク`);
      break;
    case 'knowledge_query':
      add('answers_with_citation', (data.hits || []).every((h) => h.doc_id), '根拠箇所つき');
      break;
    case 'data_analysis':
      add('analysis_completed', !!data.summary, '分析完了');
      add('stats_present', !!(data.stats || data.loaded), '統計/読込結果あり');
      break;
    case 'ledger_record':
      add('basis_recorded', ['measured', 'third_party', 'estimated', 'unverified'].includes(data.basis), `basis: ${data.basis}`);
      add('measured_has_source', data.basis !== 'measured' || !!data.source, '実測には出典');
      break;
    case 'report_write':
      add('body_present', (data.report_id || '').length > 0, 'レポートIDあり');
      break;
    case 'browser_extract':
      add('extracted', (data.textLength || 0) > 100, `${data.textLength || 0}文字`);
      break;
    default:
      add('generic_evidence', res.ok === true, 'ツール成功のみ（専用基準なし）');
  }

  // Universal truthfulness gate: a claim of measured revenue requires evidence.
  if (res.basis === BASIS.MEASURED && /revenue|収益/i.test(String(res.summary || '')) && !res.evidence_url) {
    add('measured_revenue_requires_evidence', false, '実測収益には証拠URLが必要');
  }

  const failed = checks.filter((c) => !c.passed);
  const passed = failed.length === 0;
  return {
    passed,
    reason: passed ? null : failed.map((f) => `${f.name}(${f.detail})`).join(', '),
    checks,
  };
}

/**
 * Mission-level verification: is the objective actually met?
 * Uses the ledger (measured only) — estimates can never satisfy the target.
 */
export async function verifyMission(store, mission) {
  const rows = await store.all(`SELECT * FROM ledger WHERE occurred_on >= ?`, mission.created_at?.slice(0, 10) || '1970-01-01');
  const measuredRevenue = rows.filter((r) => r.kind === 'revenue' && r.basis === 'measured').reduce((s, r) => s + r.amount, 0);
  const estimatedRevenue = rows.filter((r) => r.kind === 'revenue' && r.basis !== 'measured').reduce((s, r) => s + r.amount, 0);
  const measuredCost = rows.filter((r) => r.kind === 'cost' && r.basis === 'measured').reduce((s, r) => s + r.amount, 0);
  const target = mission.target_value || null;

  const met = target !== null && measuredRevenue >= target;
  return {
    mission_id: mission.id,
    target_value: target,
    metric_unit: mission.metric_unit || 'JPY',
    measured_revenue: measuredRevenue,
    estimated_revenue: estimatedRevenue,
    measured_cost: measuredCost,
    measured_net: measuredRevenue - measuredCost,
    progress: target ? Math.min(100, Math.round((measuredRevenue / target) * 1000) / 10) : null,
    met,
    statement: met
      ? `実測収益 ${measuredRevenue} が目標 ${target} に到達（証拠記録済み）`
      : `目標未達: 実測 ${measuredRevenue} / 目標 ${target ?? '未設定'}（推定 ${estimatedRevenue} は実績として算入していません）`,
  };
}
