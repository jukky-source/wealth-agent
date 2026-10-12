// Deep Research module — a thin orchestration layer on top of the research
// engine that adds multi-pass gap-filling and report persistence.
// (The retrieval + extraction primitives live in src/research/web.js.)

import { truncate, j, nowIso } from '../util.js';

export function createDeepResearch({ store, router, research, memory }) {
  /**
   * Multi-pass deep research:
   *  pass 1: broad retrieval on the question
   *  pass 2: follow-ups targeting the gaps reported in pass 1
   *  returns a merged, citation-carrying report
   */
  async function investigate({ question, missionId = null, taskId = null, passes = 2, character = null }) {
    let report = await research.deepResearch({ question, missionId, taskId, store, router, character, budget: 3 });
    const passesRun = [];

    for (let p = 2; p <= passes; p++) {
      const gaps = report.gaps || [];
      if (!gaps.length) break;
      const followUps = gaps.slice(0, 3).map((g) => `${question} — ${truncate(g, 120)}`);
      const extra = await research.deepResearch({
        question: followUps.join(' / '), subQuestions: followUps, missionId, taskId, store, router, character, budget: followUps.length,
      });
      const before = report.findings.length;
      report.findings = [...report.findings, ...extra.findings];
      report.sources = dedupe([...report.sources, ...extra.sources]);
      report.gaps = extra.gaps.filter((g) => !report.gaps.some((x) => x.slice(0, 40) === g.slice(0, 40)));
      passesRun.push({ pass: p, addedFindings: report.findings.length - before, addedSources: extra.sources.length });
      if (report.findings.length >= 12) break;
    }

    if (store) {
      await store.run(`UPDATE research_reports SET findings_json=?, sources_json=?, gaps_json=? WHERE id=?`,
        j({ sub_questions: report.subQuestions, findings: report.findings, passes: passesRun }),
        j(report.sources), j(report.gaps), report.id);
    }
    if (memory) {
      await memory.write({
        kind: 'fact', scope: missionId ? `mission:${missionId}` : 'global',
        key: `research:${question.slice(0, 60)}`,
        text: `リサーチ「${truncate(question, 80)}」: 所見${report.findings.length}件 / 出典${report.sources.length}件 / 未解決${report.gaps.length}点`,
        evidence: 'third_party', importance: 55, data: { report_id: report.id },
      });
    }
    return { ...report, passes: passesRun, confidence: grade(report) };
  }

  function grade(report) {
    const withSources = report.findings.filter((f) => (f.sources || []).length).length;
    const ratio = report.findings.length ? withSources / report.findings.length : 0;
    const srcCount = report.sources.length;
    if (srcCount >= 8 && ratio >= 0.8 && !report.degraded) return 'medium_high';
    if (srcCount >= 4 && ratio >= 0.6) return 'medium';
    return 'low';
  }

  /** Compare sources for contradictions on a single claim. */
  async function compareSources(claim, urls) {
    const fetched = [];
    for (const u of urls.slice(0, 4)) {
      const p = await research.fetch(u, { store });
      if (p.ok) fetched.push({ url: u, title: p.title, excerpt: truncate(p.text, 700) });
    }
    return {
      claim, sources: fetched,
      note: fetched.length ? '出典間の記述を並べました。矛盾は自動判定せず、原文の併記のみ行います。' : '出典を取得できませんでした。',
    };
  }

  return { investigate, grade, compareSources };
}

function dedupe(sources) {
  const map = new Map();
  for (const s of sources) if (!map.has(s.url)) map.set(s.url, s);
  return [...map.values()];
}
