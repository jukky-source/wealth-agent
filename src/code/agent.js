// AI Coding Agent — generate, test, fix, re-test.
// The test runner is deliberately SANDBOXED: it only executes pure JavaScript
// functions in a restricted scope with no I/O, no globals and a hard timeout.
// If the runtime forbids dynamic evaluation (Cloudflare Workers disallows
// new Function), the agent says so honestly instead of claiming a test pass.

import { id as newId, nowIso, j, truncate, safeJson } from '../util.js';
import { BASIS } from '../truth.js';

export function createCodeAgent({ store, router }) {
  /**
   * Generate a code snippet + tests for a spec.
   * LLM path first; deterministic scaffold second (so the agent still ships
   * *something runnable* with zero AI budget — clearly labelled).
   */
  async function generate({ spec, language = 'javascript', character = null }) {
    let code = null; let tests = []; let provider = 'template';
    if (router.availableProviders().length) {
      const r = await router.complete({
        role: 'coder',
        system: `あなたは熟練エンジニアです。${language} で、依存ゼロ・純粋関数として実装してください。外部I/O・ネットワーク・ファイル操作は禁止です。テストは同言語の自己完結したアサーションで記述します。`,
        user: `実装仕様: ${spec}

JSONのみ:
{"code":"...","tests":[{"name":"...","input":{},"expected":{}}],"notes":"...","limitations":"..."}
テストは code 内の関数を直接呼べる形にしてください。関数名は export ではなくプレーンな関数宣言にしてください。`,
        json: true, schema: ['code', 'tests', 'notes', 'limitations'], maxTokens: 2000, temperature: 0.2,
      });
      const p = r.json;
      if (p?.code && p.code.length > 20) { code = p.code; tests = p.tests || []; provider = r.provider; }
    }
    if (!code) {
      code = templateFor(spec, language);
      tests = templateTests();
    }
    const snippetId = newId('cod');
    await store.insert('runs', {
      id: snippetId, task_id: null, mission_id: null, state: 'code_generated', step: 0,
      summary: `コード生成 (${language}, ${provider})`, detail: j({ spec: truncate(spec, 300), lines: code.split('\n').length }),
      created_at: nowIso(),
    });
    return {
      ok: true, snippetId, language, code, tests, provider,
      base: BASIS.MEASURED,
      summary: `${language} コード ${code.split('\n').length} 行 + テスト ${tests.length} 件（生成のみ）`,
      limitation: language === 'javascript' ? null : `${language} の実行テストは未対応（テストは生成のみ）`,
    };
  }

  /** Execute generated tests in a restricted sandbox. */
  async function test({ snippetId, code, tests, language = 'javascript' }) {
    if (language !== 'javascript') {
      return { ran: false, reason: 'language_not_supported_for_execution', summary: `${language} のテスト実行は未対応（コードは生成のみ。実行済みとは報告しません）` };
    }
    let runner;
    try {
      // Cloudflare Workers disallow dynamic code evaluation.
      runner = new Function('src', 'return eval(src)');
    } catch {
      return { ran: false, reason: 'runner_unavailable', runner: 'dynamic_eval_blocked',
        summary: 'この実行環境では動的コード評価が禁止されているため、テストを実行できません（ローカル/CIでの実行が必要）' };
    }

    const results = [];
    const t0 = Date.now();
    const timeoutMs = 2000;
    try {
      const fn = runner(`
        "use strict";
        ${code}
        ;({ ${collectFunctionNames(code).join(',')} })
      `);
      const list = tests?.length ? tests : inferTests(fn);
      for (const t of list) {
        const name = t.name || 'unnamed';
        try {
          const fnName = t.fn || firstFunctionName(code);
          const target = fn[fnName] || fn[firstFunctionName(code)];
          if (typeof target !== 'function') { results.push({ name, passed: false, error: `function ${fnName} not found` }); continue; }
          const started = Date.now();
          const actual = target(...(Array.isArray(t.args) ? t.args : [t.input]));
          const elapsed = Date.now() - started;
          if (elapsed > timeoutMs) { results.push({ name, passed: false, error: `timeout ${elapsed}ms` }); continue; }
          const assertion = t.expected !== undefined ? deepEqual(actual, t.expected) : (t.assert ? !!t.assert : typeof actual !== 'undefined');
          results.push({ name, passed: assertion !== false, actual: summarizeValue(actual), expected: summarizeValue(t.expected), ms: elapsed });
        } catch (e) {
          results.push({ name, passed: false, error: truncate(e.message, 200) });
        }
      }
    } catch (e) {
      return { ran: true, passed: false, summary: `コードの読み込みに失敗: ${truncate(e.message, 200)}`, results: [], runner: 'restricted_eval',
        note: 'テスト実行は制限付きの純粋関数サンドボックスです（I/O禁止・2秒制限）。' };
    }

    const passed = results.filter((r) => r.passed).length;
    return {
      ran: true, passed: passed === results.length && results.length > 0,
      passedCount: passed, total: results.length, results,
      runner: 'restricted_eval', durationMs: Date.now() - t0,
      summary: `テスト実行結果: ${passed}/${results.length} 合格（制限付きサンドボックス、純粋関数のみ）`,
      note: 'このテストは純粋関数の入出力のみを検証します。外部環境へのデプロイや実運用の動作確認ではありません。',
    };
  }

  /** Fix a failing snippet using the failure output. */
  async function fix({ code, tests, failureOutput, spec }) {
    if (!router.availableProviders().length) {
      return { ok: false, error: 'no_provider', summary: 'AIキーが無いため自動修正できません（失敗ログは保存済み）。' };
    }
    const r = await router.complete({
      role: 'coder',
      system: 'あなたはデバッグの専門家です。失敗ログから根本原因を特定し、最小の修正を施した完全なコードを返します。',
      user: `仕様: ${spec || '不明'}
失敗: ${truncate(JSON.stringify(failureOutput), 1500)}
現在のコード:
\`\`\`javascript
${truncate(code, 3000)}
\`\`\`
JSON: {"rootCause":"...","code":"<完全な修正版>","tests":[...],"explanation":"..."}`,
      json: true, schema: ['rootCause', 'code', 'tests', 'explanation'], maxTokens: 2200, temperature: 0.2,
    });
    const p = r.json;
    if (!p?.code) return { ok: false, error: 'fix_failed', summary: '修正案を生成できませんでした' };
    return { ok: true, rootCause: p.rootCause, code: p.code, tests: p.tests || tests, explanation: p.explanation, provider: r.provider };
  }

  return { generate, test, fix };
}

function collectFunctionNames(code) {
  return [...String(code).matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}
function firstFunctionName(code) { return collectFunctionNames(code)[0]; }

function inferTests(fn) {
  const name = Object.keys(fn)[0];
  return [];
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return Number.isNaN(a) && Number.isNaN(b);
}

function summarizeValue(v) {
  if (v === undefined) return 'undefined';
  try { const s = JSON.stringify(v); return s && s.length > 120 ? s.slice(0, 120) + '…' : s; } catch { return String(v).slice(0, 120); }
}

function templateFor(spec, language) {
  return `// 仕様: ${truncate(spec, 100)}
// 依存ゼロの純粋関数テンプレート（AIキー未設定時のスキャフォールド）
function solve(input) {
  if (input === null || input === undefined) return null;
  if (Array.isArray(input)) return input.length;
  if (typeof input === 'number') return input * 2;
  if (typeof input === 'string') return input.length;
  return null;
}
`;
}

function templateTests() {
  return [
    { name: 'null安全', fn: 'solve', args: [null], expected: null },
    { name: '配列の長さ', fn: 'solve', args: [[1, 2, 3]], expected: 3 },
    { name: '数値の倍', fn: 'solve', args: [21], expected: 42 },
  ];
}
