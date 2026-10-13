// HTTP API — the single surface used by the PWA.
// Auth: Bearer token (OWNER_TOKEN secret). Never returns secrets to the client.

import { safeJson, j, truncate, nowIso, utcDay, round } from './util.js';
import { summarizeLedger, MEASUREMENT_LABEL, BASIS_LABEL } from './truth.js';
import { STARTER_WORKFLOWS, evalExpr } from './workflow/workflow.js';
import { runPeerReview } from './engine/peer.js';
import { verifyMission } from './engine/verifier.js';
import { PRESETS } from './ai/prompts.js';
import { LINT_RULES } from './income/pine.js';
import { SUPPORTED_SYMBOLS } from './income/fx.js';
import { STRATEGIES } from './income/backtest.js';
import { parseTable, toCsv, statColumns, qualityCheck } from './data/analyze.js';
import { POLICY, reworkTask } from './agent/judge.js';
import { activeMode, allModes, builtinModes, defaultChips, setActiveMode, upsertCustomMode } from './agent/modes.js';
import { getEnvelope, setEnvelope, envelopeCard, checkEnvelope } from './agent/envelope.js';
import { createJob, advanceJob, revenueSummary, jobCard, jobListItems, recordReceipt } from './agent/revenue.js';
import { catalog as x402Catalog, x402Enabled, receiptFromCallback } from './agent/x402.js';

import { providerCard, providerHelp, poolCapacity } from './agent/providers.js';
import { AUTO_LANES, MONITOR_PRODUCTS, autoLaneHelp, autoPlan, rankByLeastHands } from './agent/autolanes.js';
import { CAPS, PIPELINE, approveDraft, listDrafts, markPosted, publishHelp, publishState, queueDraft } from './agent/publish.js';
import { dispatchJob, runnerHelp, runnerPlan, runnerState } from './agent/runner.js';
import { channelCard, channelHelp } from './agent/channels.js';
import { capacityValue, inferenceHelp, readUsageBoard } from './agent/inference.js';

export function createApi(deps) {
  const { store, env, engine, router, memory, tools, research, deepResearch, knowledge, dataAnalysis, codeAgent, browser, workflows, fx, rewards, sidehustle, ranking, scheduler, imagegen } = deps;
  // ハンドラの第2引数は body なので env は渡ってこない。ここで受け取った env を使う。
  const boundEnv = env || {};

  const routes = [];
  // Multi-agent fleet + image studio settings live on deps so the API layer
  // stays a thin router.
  const fleetApi = deps.fleet || null;
  const imgApi = deps.imagegen || null;
  const runnerApi = deps.runner || null;
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------------------------------------------------------------- health
  on('GET', '/api/health', async () => ({
    ok: true, at: nowIso(),
    engine: (await engine.engineState()).status,
    providers_configured: router.availableProviders(),
    db: 'ok',
    version: '1.0.0',
  }));

  // ---------------------------------------------------------------- dashboard
  on('GET', '/api/dashboard', async () => {
    const character = await engine.getCharacter();
    const state = await engine.engineState();
    const missions = await store.all(`SELECT * FROM missions ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, priority DESC LIMIT 20`);
    const activeMission = missions.find((m) => m.status === 'active') || missions[0] || null;

    const [running, queued, completed, failed, waiting] = await Promise.all([
      store.all(`SELECT * FROM tasks WHERE state IN ('running','planning','testing','verifying','improving') ORDER BY updated_at DESC LIMIT 10`),
      store.all(`SELECT * FROM tasks WHERE state='queued' ORDER BY priority DESC LIMIT 10`),
      store.all(`SELECT * FROM tasks WHERE state='completed' ORDER BY finished_at DESC LIMIT 10`),
      store.all(`SELECT * FROM tasks WHERE state='failed' ORDER BY updated_at DESC LIMIT 5`),
      store.all(`SELECT * FROM tasks WHERE state IN ('waiting_for_quota','waiting_for_approval','waiting_for_user') LIMIT 10`),
    ]);

    const nextSel = activeMission ? await (async () => {
      const memos = await memory.digest(`${activeMission.title}`, { scope: `mission:${activeMission.id}`, limit: 8 });
      const selMod = await import('./engine/executor.js');
      return selMod.selectNextTask(store, { character, mission: activeMission, memories: memos });
    })() : null;

    const ledgerRows = await store.all(`SELECT * FROM ledger ORDER BY occurred_on DESC LIMIT 500`);
    const ledger = summarizeLedger(ledgerRows);

    const [aiStatus, notifications, memStats, approvals] = await Promise.all([
      router.status(), engine.notifications(), memory.stats(),
      store.all(`SELECT * FROM approvals WHERE status='pending' ORDER BY requested_at DESC LIMIT 20`),
    ]);

    const lastSuccess = await store.all(
      `SELECT t.title, t.last_success_step, t.finished_at FROM tasks t WHERE t.state='completed' ORDER BY t.finished_at DESC LIMIT 1`);

    const opportunities = await store.all(
      `SELECT domain, COUNT(*) AS count, MAX(score) AS best, SUM(CASE WHEN status='candidate' THEN 1 ELSE 0 END) AS candidates FROM opportunities GROUP BY domain`);

    const missionVerification = activeMission ? await verifyMission(store, activeMission) : null;
    const watchesActive = await store.first(`SELECT COUNT(*) AS c FROM watch_rules WHERE status IN ('active','triggered','achieved')`).catch(() => null);
    const mode = await activeMode(store).catch(() => null);
    const { activeGoal } = await import('./agent/watch.js');
    const goal = await activeGoal(store).catch(() => null);
    const revenue = await revenueSummary(store).catch(() => null);
    const envelope = await getEnvelope(store).catch(() => null);
    const jobsOpen = await store.all(`SELECT * FROM jobs WHERE state NOT IN ('settled','abandoned') ORDER BY updated_at DESC LIMIT 5`).catch(() => []);

    return {
      character: character ? {
        id: character.id, name: character.name, avatar: character.avatar, preset: character.preset,
        avatar_url: character.avatar_url || null, avatar_source: character.avatar_source || null,
        description: character.description, tone: character.tone, autonomy_level: character.autonomy_level,
        report_frequency: character.report_frequency, risk_tolerance: character.risk_tolerance,
        caution: character.caution, creativity: character.creativity, weights: character.priority_weights,
      } : null,
      engine: state,
      missions: missions.map((m) => ({ ...m, verification: m.id === activeMission?.id ? missionVerification : null })),
      current_mission: activeMission,
      running_tasks: running, queued_tasks: queued, completed_tasks: completed, failed_tasks: failed, waiting_tasks: waiting,
      next_task: nextSel?.chosen ? {
        id: nextSel.chosen.task.id, title: nextSel.chosen.task.title,
        score: nextSel.chosen.score, reasons: nextSel.chosen.reasons,
        tool: nextSel.chosen.task.tool_name, category: nextSel.chosen.task.category,
        explanation: nextSel.chosen.reasons,
      } : null,
      candidates_considered: nextSel?.candidateCount ?? 0,
      last_success_step: lastSuccess[0] || null,
      ai: aiStatus,
      notifications,
      memory: memStats,
      pending_approvals: approvals,
      watches_active: Number(watchesActive?.c || 0),
      mode: mode ? {
        id: mode.id, label: mode.label, blurb: mode.blurb || '', goal: mode.goal || '',
        chips: defaultChips(mode), placeholder: mode.placeholder || 'エージェントに指示する',
        outcome_label: mode.outcome_label || '終わったこと', kpi_title: mode.kpi_title || '', custom: !!mode.custom,
      } : null,
      goal,
      ledger,
      revenue,
      envelope,
      jobs_open: jobsOpen,
      x402: { enabled: x402Enabled(env), catalog: x402Catalog(env) },
      opportunities,
      honesty: {
        ladder: MEASUREMENT_LABEL,
        basis_labels: BASIS_LABEL,
        note: '実績と推定は常に分離して表示します。実測には証拠記録が必要です。',
      },
    };
  });

  // ---------------------------------------------------------------- engine control
  on('GET', '/api/engine', async () => ({ ...(await engine.engineState()), notifications: await engine.notifications() }));
  on('POST', '/api/engine/start', async () => engine.control('start'));
  on('POST', '/api/engine/pause', async (req, body) => engine.control('pause', { note: body.reason }));
  on('POST', '/api/engine/resume', async () => engine.control('resume'));
  on('POST', '/api/engine/stop', async (req, body) => engine.control('stop', { note: body.reason }));
  on('POST', '/api/engine/tick', async (req, body) => engine.tick({ maxSteps: body.steps || 3, source: 'api' }));
  on('POST', '/api/scheduler/tick', async (req, body) => scheduler.scheduledTick({ source: 'api' }));

  // ---------------------------------------------------------------- character
  on('GET', '/api/character', async () => {
    const character = await engine.getCharacter();
    return {
      character,
      avatar: { ...avatarState(character), ...avatarOptions() },
      presets: Object.values(PRESETS).map((p) => ({ key: p.key, label: p.label, description: p.description, tone: p.tone, personality: p.personality, values: p.values, creativity: p.creativity, caution: p.caution, risk_tolerance: p.risk_tolerance, planning_style: p.planning_style })),
    };
  });
  // An emoji pasted into the monogram field would break the icon system,
  // so a stored mark is stripped down to plain text on write.
  const stripEmoji = (v) => String(v ?? '').replace(/\p{Extended_Pictographic}+/gu, '').trim();
  on('POST', '/api/character', async (req, body) => {
    const c = body.character || body;
    if (!c?.name) return { ok: false, error: 'name_required' };
    const preset = PRESETS[c.preset] || PRESETS.custom;
    const row = {
      id: c.id || `chr_${Date.now().toString(36)}`,
      preset: c.preset || 'custom',
      name: c.name, avatar: stripEmoji(c.avatar) || preset.name?.[0] || '',
      description: c.description ?? preset.description ?? '',
      personality: c.personality ?? preset.personality ?? '',
      tone: c.tone ?? preset.tone ?? '',
      values_json: j(Array.isArray(c.values) ? c.values : (preset.values || [])),
      strengths: c.strengths ?? preset.strengths ?? '',
      weaknesses: c.weaknesses ?? preset.weaknesses ?? '',
      creativity: clampInt(c.creativity ?? preset.creativity ?? 60),
      caution: clampInt(c.caution ?? preset.caution ?? 60),
      risk_tolerance: clampInt(c.risk_tolerance ?? preset.risk_tolerance ?? 30),
      report_frequency: c.report_frequency || 'daily',
      // Autonomy above the self-grant ceiling must be an explicit owner action.
      autonomy_level: Math.min(5, Math.max(1, Number(c.autonomy_level ?? 4))),
      long_term_goals: c.long_term_goals ?? '',
      prohibitions: c.prohibitions ?? preset.prohibitions ?? '',
      is_active: 1, created_at: nowIso(), updated_at: nowIso(),
    };
    const existing = c.id ? await store.get('characters', c.id) : await store.first('SELECT * FROM characters WHERE is_active=1');
    if (existing) {
      await store.update('characters', existing.id, { ...row, id: undefined, created_at: undefined });
      row.id = existing.id;
    } else {
      await store.insert('characters', row);
    }
    await store.run('UPDATE characters SET is_active=0 WHERE id != ?', row.id);
    await memory.write({
      kind: 'preference', key: `character:${row.id}`,
      text: `キャラクター設定: ${row.name}（${row.preset}）/ 自律性L${row.autonomy_level} / リスク許容${row.risk_tolerance} / 慎重さ${row.caution} / 禁止: ${row.prohibitions || 'なし'}`,
      evidence: 'measured', importance: 85, data: { character_id: row.id },
    });
    return { ok: true, character: await engine.getCharacter() };
  });

  // ------------------------------------------------------------ avatar (icon)
  // One bounded image per character, kept on the character row as a data URL so
  // the PWA needs no object storage and works offline. Uploads and generations
  // both pass this validator, so the row can never hold anything but an image.
  const AVATAR_MAX_CHARS = 400000; // ≈300 KB binary; a 256 px avatar is ~15 KB
  const AVATAR_RASTER = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;
  const AVATAR_SVG = /^data:image\/svg\+xml,/i;

  function sanitizeAvatarDataUrl(v) {
    const s = String(v ?? '').trim();
    if (!s) return { ok: false, error: 'missing_image', hint: '画像がありません' };
    if (!AVATAR_RASTER.test(s) && !AVATAR_SVG.test(s)) {
      return { ok: false, error: 'unsupported_type', hint: 'PNG / JPEG / WebP / SVG のみ保存できます' };
    }
    if (s.length > AVATAR_MAX_CHARS) {
      return { ok: false, error: 'image_too_large', hint: '画像が大きすぎます（256px 程度に縮小してから保存してください）' };
    }
    // An SVG avatar is rendered inside <img>, where scripts cannot run — but a
    // stored payload should never carry one in the first place.
    if (/<script|javascript:|onload\s*=|onerror\s*=/i.test(s)) {
      return { ok: false, error: 'unsafe_payload', hint: '安全でない内容を含む画像は保存できません' };
    }
    return { ok: true, value: s };
  }

  const avatarState = (ch) => (!ch ? null : {
    url: ch.avatar_url || null, source: ch.avatar_source || null, prompt: ch.avatar_prompt || null,
    model: ch.avatar_model || null, updated_at: ch.avatar_updated_at || null,
  });
  function avatarOptions() {
    const o = imagegen.options();
    return { engines: o.engines, styles: o.styles, max_instruction_chars: o.max_instruction_chars, order: o.order };
  }

  on('GET', '/api/character/avatar', async () => ({
    avatar: avatarState(await engine.getCharacter()), max_chars: AVATAR_MAX_CHARS, ...imagegen.options(),
  }));

  // Store an image the owner picked in their photo library (already downscaled
  // in the browser) or one that was just generated.
  on('POST', '/api/character/avatar', async (req, body) => {
    const ch = await engine.getCharacter();
    if (!ch) return { ok: false, error: 'character_required' };
    const v = sanitizeAvatarDataUrl(body.data_url);
    if (!v.ok) return v;
    const source = body.source === 'generated' ? 'generated' : 'upload';
    await store.update('characters', ch.id, {
      avatar_url: v.value, avatar_source: source,
      avatar_prompt: body.prompt ? truncate(String(body.prompt), 400) : null,
      avatar_model: body.model ? String(body.model).slice(0, 80) : null,
      avatar_updated_at: nowIso(),
    });
    await memory.write({
      kind: 'preference', key: `character:avatar:${ch.id}`,
      text: `キャラクターのアイコンを${source === 'generated' ? '生成AIで作成' : 'アップロード'}して設定した`,
      evidence: 'measured', importance: 40, data: { source, model: body.model || null },
    });
    return { ok: true, avatar: avatarState(await store.get('characters', ch.id)) };
  });

  // Generate without storing: the browser previews it, downscales it, and then
  // POSTs the result back, so a rejected generation never overwrites the avatar.
  on('POST', '/api/character/avatar/generate', async (req, body) => imagegen.generate({
    instruction: body.instruction, style: body.style || null, character: await engine.getCharacter(),
  }));

  on('POST', '/api/character/avatar/clear', async () => {
    const ch = await engine.getCharacter();
    if (!ch) return { ok: false, error: 'character_required' };
    await store.update('characters', ch.id, {
      avatar_url: null, avatar_source: null, avatar_prompt: null, avatar_model: null, avatar_updated_at: nowIso(),
    });
    return { ok: true, avatar: avatarState(await store.get('characters', ch.id)) };
  });

  // ---------------------------------------------------------------- missions
  on('GET', '/api/missions', async () => {
    const rows = await store.all(`SELECT * FROM missions ORDER BY created_at DESC LIMIT 50`);
    const out = [];
    for (const m of rows) {
      const counts = await store.all(`SELECT state, COUNT(*) AS c FROM tasks WHERE mission_id=? GROUP BY state`, m.id);
      out.push({ ...m, task_counts: Object.fromEntries(counts.map((c) => [c.state, c.c])) });
    }
    return { missions: out };
  });
  on('POST', '/api/missions', async (req, body) => {
    if (!body.goal) return { ok: false, error: 'goal_required' };
    const r = await engine.createMission({
      title: body.title || truncate(body.goal, 60), goal: body.goal,
      constraints: body.constraints || '', successMetric: body.success_metric || null,
      targetValue: body.target_value ?? null, metricUnit: body.metric_unit || 'JPY',
      priority: body.priority ?? 70, planNow: body.plan !== false,
    });
    return { ok: true, mission: r.mission, tasks: r.plan?.created || [], categories: r.plan?.categories || [] };
  });
  on('GET', '/api/missions/:id', async (req, body, p) => {
    const m = await store.get('missions', p.id);
    if (!m) return { ok: false, error: 'not_found' };
    const tasks = await store.all(`SELECT * FROM tasks WHERE mission_id=? ORDER BY created_at ASC`, p.id);
    const runs = await store.all(`SELECT * FROM runs WHERE mission_id=? ORDER BY created_at DESC LIMIT 40`, p.id);
    return { mission: m, tasks, runs, verification: await verifyMission(store, m) };
  });
  on('POST', '/api/missions/:id/status', async (req, body, p) => {
    await store.update('missions', p.id, { status: body.status, updated_at: nowIso() });
    return { ok: true };
  });
  on('POST', '/api/missions/:id/replan', async (req, body, p) => {
    const m = await store.get('missions', p.id);
    const { planMission } = await import('./engine/planner.js');
    const r = await planMission({ store, router, memory, character: await engine.getCharacter(), mission: m, existingTasks: await store.all('SELECT * FROM tasks WHERE mission_id=?', p.id) });
    return { ok: true, created: r.created, categories: r.categories, note: r.note };
  });

  // ---------------------------------------------------------------- tasks
  on('GET', '/api/tasks', async (req, body) => {
    const state = req.query.get('state');
    const mission = req.query.get('mission');
    const limit = Math.min(200, Number(req.query.get('limit') || 100));
    let sql = `SELECT * FROM tasks WHERE 1=1`;
    const params = [];
    if (state) { sql += ` AND state=?`; params.push(state); }
    if (mission) { sql += ` AND mission_id=?`; params.push(mission); }
    sql += ` ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'improving' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END, priority DESC LIMIT ?`;
    params.push(limit);
    const rows = await store.all(sql, ...params);
    return { tasks: rows.map((t) => ({ ...t, error_history: safeJson(t.error_history, []), artifacts: safeJson(t.artifacts, []), tool_args: safeJson(t.tool_args, {}), depends_on: safeJson(t.depends_on, []) })) };
  });
  on('GET', '/api/tasks/:id', async (req, body, p) => {
    const t = await store.get('tasks', p.id);
    if (!t) return { ok: false, error: 'not_found' };
    const runs = await store.all(`SELECT * FROM runs WHERE task_id=? ORDER BY created_at DESC LIMIT 50`, p.id);
    return { task: { ...t, error_history: safeJson(t.error_history, []), artifacts: safeJson(t.artifacts, []) }, runs };
  });
  on('POST', '/api/tasks/:id/action', async (req, body, p) => {
    const t = await store.get('tasks', p.id);
    if (!t) return { ok: false, error: 'not_found' };
    switch (body.action) {
      case 'retry':
        await store.run(`UPDATE tasks SET state='improving', attempt=0, next_action='手動再試行', updated_at=? WHERE id=?`, nowIso(), p.id);
        return { ok: true, state: 'improving' };
      case 'cancel':
        await store.run(`UPDATE tasks SET state='cancelled', finished_at=?, updated_at=? WHERE id=?`, nowIso(), nowIso(), p.id);
        return { ok: true, state: 'cancelled' };
      case 'prioritize':
        await store.run(`UPDATE tasks SET priority=?, updated_at=? WHERE id=?`, Math.min(100, (t.priority || 50) + 20), nowIso(), p.id);
        return { ok: true };
      case 'requeue':
        await store.run(`UPDATE tasks SET state='queued', finished_at=NULL, updated_at=? WHERE id=?`, nowIso(), p.id);
        return { ok: true, state: 'queued' };
      case 'resume': {
        // 途中で止まった作業を、ゼロからではなく最後に成功した地点から再開する。
        const ck = await store.first(`SELECT * FROM checkpoints WHERE scope=? ORDER BY created_at DESC LIMIT 1`, `task:${p.id}`).catch(() => null);
        const from = ck?.state || t.last_success_step || '開始地点';
        await store.run(`UPDATE tasks SET state='improving', next_action=?, finished_at=NULL, updated_at=? WHERE id=?`,
          `続きから再開（前回: ${from}）`, nowIso(), p.id);
        await store.insert('checkpoints', {
          id: `ckp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          scope: `task:${p.id}`, state: 'resumed', payload: j({ from, attempt_kept: t.attempt || 0 }), created_at: nowIso(),
        }).catch(() => {});
        return { ok: true, state: 'improving', from, attempt_kept: t.attempt || 0 };
      }
      case 'rework': {
        // 判定に落ちた成果物を、前回の続きから作り直す（お金を動かす操作は承認へ回す）。
        const r = await reworkTask(store, p.id, { reason: body.reason || 'オーナーの指示による作り直し', force: !!body.force });
        return r.ok ? { ok: true, state: 'improving', attempt: r.attempt, reason: r.reason } : r;
      }
      default:
        return { ok: false, error: 'unknown_action' };
    }
  });

  // ---------------------------------------------------------------- approvals
  on('GET', '/api/approvals', async () => ({
    approvals: (await store.all(`SELECT * FROM approvals ORDER BY requested_at DESC LIMIT 100`)).map((a) => ({ ...a, payload: safeJson(a.payload, null) })),
    policy: {
      autonomous: POLICY.autonomous,
      approval_required: POLICY.approval_required,
      never: POLICY.never,
      keys: POLICY.keys,
    },
  }));
  on('POST', '/api/approvals/:id/decide', async (req, body, p) => {
    const decision = body.decision === 'approved' ? 'approved' : 'rejected';
    await store.run(`UPDATE approvals SET status=?, decided_at=?, note=? WHERE id=?`, decision, nowIso(), body.note || '', p.id);
    if (decision === 'approved') {
      const a = await store.get('approvals', p.id);
      if (a?.task_id) await store.run(`UPDATE tasks SET state='improving', next_action='承認済み。再実行します', updated_at=? WHERE id=?`, nowIso(), a.task_id);
      await memory.write({ kind: 'preference', key: `approval:${p.id}`, text: `オーナーが ${a?.action} を承認しました`, evidence: 'measured', importance: 60 });
    }
    return { ok: true, status: decision };
  });

  // ---------------------------------------------------------------- opportunities
  on('GET', '/api/opportunities', async (req) => {
    const domain = req.query.get('domain');
    const rows = domain
      ? await store.all(`SELECT * FROM opportunities WHERE domain=? ORDER BY score DESC LIMIT 200`, domain)
      : await store.all(`SELECT * FROM opportunities ORDER BY score DESC LIMIT 300`);
    return { opportunities: rows.map((o) => ({ ...o, evidence_urls: safeJson(o.evidence_urls, []), score_breakdown: safeJson(o.score_breakdown, null) })) };
  });
  on('POST', '/api/opportunities/research', async (req, body) => {
    const domain = body.domain || 'rewards';
    const topic = body.topic || (domain === 'fx' ? 'USDJPY 自動売買 戦略' : domain === 'rewards' ? 'ポイ活 高還元 換金' : '個人開発 副業 収益');
    const mission = body.mission_id ? await store.get('missions', body.mission_id) : (await store.first(`SELECT * FROM missions WHERE status='active' LIMIT 1`));
    const character = await engine.getCharacter();
    let result;
    if (domain === 'rewards') result = await rewards.research({ store, router, memory, research, mission, character, topic, limit: body.limit || 6 });
    else if (domain === 'side_hustle') result = await sidehustle.research({ store, router, memory, research, mission, character, topic, limit: body.limit || 6 });
    else result = { candidates: [], note: 'FXは /api/fx/* を使用してください' };
    const ranked = await ranking.rank(store, { domain, persist: true, character });
    return { ok: true, ...result, ranking: ranked };
  });
  on('POST', '/api/opportunities/:id/reject', async (req, body, p) => {
    const o = await store.get('opportunities', p.id);
    if (!o) return { ok: false, error: 'not_found' };
    await rewards.reject(store, { opportunityId: p.id, reason: body.reason || 'オーナーによる却下', name: o.name });
    return { ok: true };
  });
  on('POST', '/api/opportunities/:id/funnel', async (req, body, p) => {
    const r = await sidehustle.recordFunnel({ store, opportunityId: p.id, metrics: body.metrics || {}, source: body.source || null, occurredOn: body.occurred_on || null });
    return { ok: true, ...r };
  });
  on('POST', '/api/opportunities/rank', async () => ({ ok: true, ranking: await ranking.rank(store, { persist: true, character: await engine.getCharacter() }) }));

  // ---------------------------------------------------------------- FX
  on('GET', '/api/fx', async () => {
    const strategies = await store.all(`SELECT id,name,symbol,version,hypothesis,non_repaint,status,pine_version,created_at FROM fx_strategies ORDER BY created_at DESC LIMIT 50`);
    const backtests = await store.all(`SELECT id,strategy_id,symbol,bars,date_from,date_to,pass,metrics_json,walkforward_json,overfit_json,created_at FROM fx_backtests ORDER BY created_at DESC LIMIT 30`);
    return {
      symbols: SUPPORTED_SYMBOLS,
      strategies,
      backtests: backtests.map((b) => ({ ...b, metrics: safeJson(b.metrics_json, {}), walkforward: safeJson(b.walkforward_json, {}), overfit: safeJson(b.overfit_json, {}) })),
      strategies_available: Object.entries(STRATEGIES).map(([k, v]) => ({ key: k, label: v.label, defaultParams: v.defaultParams })),
      lint_rules: LINT_RULES.map((r) => ({ id: r.id, severity: r.severity, msg: r.msg })),
      disclaimer: '過去データの成績は将来の利益を保証しません。初期状態では実口座発注は無効です（研究・バックテスト・デモ検証のみ）。',
    };
  });
  on('POST', '/api/fx/market-data', async (req, body) => {
    const md = await fx.fetchMarketData(store, body.symbol || 'USDJPY', { days: body.days || 1500, force: !!body.force });
    return { ok: md.bars.length > 0, symbol: md.symbol, source: md.source, quality: md.quality, bars: md.bars.length, from: md.bars[0]?.date, to: md.bars[md.bars.length - 1]?.date, sample: md.bars.slice(-5), cached: md.cached };
  });
  on('POST', '/api/fx/generate', async (req, body) => {
    const s = await fx.generateStrategy({ store, router, character: await engine.getCharacter(), symbol: body.symbol || 'USDJPY', seedIdeas: body.ideas || null, avoid: body.avoid || [] });
    return { ok: true, strategy: { id: s.id, name: s.name, version: s.version, hypothesis: s.hypothesis, params: s.params, pine_code: s.pine_code, pine_version: s.pine_version, lint: s.lint } };
  });
  on('POST', '/api/fx/lint', async (req, body) => {
    let code = body.code; let sid = body.strategy_id;
    if (!code && sid) code = (await store.get('fx_strategies', sid))?.pine_code;
    if (!code) return { ok: false, error: 'code_required' };
    const lint = fx.lintPine(code);
    if (sid) await store.run(`UPDATE fx_strategies SET non_repaint=?, lint_json=?, updated_at=? WHERE id=?`, lint.nonRepaint ? 1 : 0, j(lint), nowIso(), sid);
    return { ok: lint.nonRepaint, lint };
  });
  on('POST', '/api/fx/backtest', async (req, body) => {
    const r = await fx.runBacktestForStrategy(store, {
      strategyId: body.strategy_id || null, symbol: body.symbol, days: body.days || 1500,
      costModel: body.cost_model || null, overrides: body.overrides || null,
    });
    if (!r.ok) return { ok: false, error: r.error, summary: r.summary };
    const { trades, equity, ...rest } = r.result;
    return {
      ok: true, backtest_id: r.backtestId, strategy: { id: r.strategy.id, name: r.strategy.name, version: r.strategy.version },
      symbol: r.symbol, bars: r.bars, cost_model: r.cost, ...rest,
      trades: trades.slice(-200), equity: equity.filter((_, i) => i % Math.max(1, Math.floor(equity.length / 300)) === 0),
      disclaimer: 'これは過去データでの検証結果です。将来の収益を保証しません。実運用ではスリッページ・約定拒否・流動性が悪化します。',
    };
  });
  on('POST', '/api/fx/improve', async (req, body) => {
    const r = await fx.improveStrategy(store, { strategyId: body.strategy_id, router, character: await engine.getCharacter() });
    return r;
  });
  on('GET', '/api/fx/strategy/:id', async (req, body, p) => {
    const s = await store.get('fx_strategies', p.id);
    if (!s) return { ok: false, error: 'not_found' };
    const bts = await store.all(`SELECT * FROM fx_backtests WHERE strategy_id=? ORDER BY created_at DESC LIMIT 5`, p.id);
    return { strategy: { ...s, lint: safeJson(s.lint_json, {}), params: safeJson(s.params_json, {}) },
      backtests: bts.map((b) => ({ ...b, metrics: safeJson(b.metrics_json, {}), walkforward: safeJson(b.walkforward_json, {}), overfit: safeJson(b.overfit_json, {}), losers: null })) };
  });

  // ---------------------------------------------------------------- research
  on('POST', '/api/research/deep', async (req, body) => {
    if (!body.question) return { ok: false, error: 'question_required' };
    const r = await deepResearch.investigate({ question: body.question, missionId: body.mission_id || null, taskId: null, passes: body.passes || 2, character: await engine.getCharacter() });
    return { ok: true, report: r };
  });
  on('GET', '/api/research/reports', async (req) => {
    const rows = await store.all(`SELECT * FROM research_reports ORDER BY created_at DESC LIMIT 50`);
    return { reports: rows.map((r) => ({ ...r, findings: safeJson(r.findings_json, {}), sources: safeJson(r.sources_json, []), gaps: safeJson(r.gaps_json, []) })) };
  });
  on('POST', '/api/research/search', async (req, body) => {
    const r = await research.search(body.query, { limit: body.limit || 6 });
    return { ok: true, ...r };
  });

  // ---------------------------------------------------------------- knowledge base
  on('GET', '/api/knowledge', async () => knowledge.list());
  on('POST', '/api/knowledge/ingest', async (req, body) => {
    if (!body.text) return { ok: false, error: 'text_required' };
    const r = await knowledge.ingest({ name: body.name || 'document.txt', mime: body.mime || 'text/plain', text: body.text });
    return r;
  });
  on('POST', '/api/knowledge/query', async (req, body) => {
    if (!body.question) return { ok: false, error: 'question_required' };
    return knowledge.query({ question: body.question, limit: body.limit || 5 });
  });
  on('POST', '/api/knowledge/delete', async (req, body) => knowledge.remove(body.doc_id));

  // ---------------------------------------------------------------- data analysis
  on('POST', '/api/data/analyze', async (req, body) => {
    if (body.text === undefined && !body.data) return { ok: false, error: 'no_data' };
    const text = body.text ?? (typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
    const r = await dataAnalysis.run({ spec: body.spec || { kind: 'describe' }, inlineData: text, datasetId: body.dataset_id });
    return r;
  });
  on('POST', '/api/data/preview', async (req, body) => {
    const text = body.text ?? JSON.stringify(body.data || []);
    try {
      const table = parseTable(text, body.format);
      return { ok: true, format: table.format, columns: table.columns, rows: table.rows.slice(0, 50), total: table.rows.length, stats: statColumns(table), quality: qualityCheck(table) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ---------------------------------------------------------------- code agent
  on('POST', '/api/code/generate', async (req, body) => {
    if (!body.spec) return { ok: false, error: 'spec_required' };
    return codeAgent.generate({ store, router, character: await engine.getCharacter(), spec: body.spec, language: body.language || 'javascript' });
  });
  on('POST', '/api/code/test', async (req, body) => codeAgent.test({ store, snippetId: body.snippet_id, code: body.code, tests: body.tests, language: body.language || 'javascript' }));

  // ---------------------------------------------------------------- browser agent
  on('POST', '/api/browser/extract', async (req, body) => {
    if (!body.url) return { ok: false, error: 'url_required' };
    return browser.extract({ store, url: body.url, selectorGoal: body.goal, maxChars: body.maxChars || 8000 });
  });
  on('POST', '/api/browser/compare', async (req, body) => browser.compare({ urls: body.urls || [], question: body.question }));

  // ---------------------------------------------------------------- workflows
  on('GET', '/api/workflows', async () => ({ workflows: await workflows.list(), starters: STARTER_WORKFLOWS }));
  on('POST', '/api/workflows', async (req, body) => {
    const w = await workflows.save({ id: body.id || null, name: body.name, definition: body.definition, enabled: body.enabled !== false });
    return { ok: true, workflow: w };
  });
  on('POST', '/api/workflows/:id/run', async (req, body, p) => workflows.run(p.id, { context: body.context || {} }));
  on('GET', '/api/workflows/runs', async (req) => ({ runs: await workflows.runs(req.query.get('workflow_id')) }));
  on('POST', '/api/workflows/seed', async () => {
    const created = [];
    for (const s of STARTER_WORKFLOWS) {
      const existing = await store.first(`SELECT * FROM workflows WHERE name=?`, s.name);
      if (!existing) created.push(await workflows.save({ name: s.name, definition: s.definition }));
    }
    return { ok: true, created };
  });

  // ---------------------------------------------------------------- peer review
  on('POST', '/api/peer-review', async (req, body) => {
    const r = await runPeerReview({ router, character: await engine.getCharacter(), artifact: body.artifact, artifactType: body.type || 'plan', question: body.question || null, roles: body.roles || ['critic', 'verifier', 'optimizer'] });
    return { ok: true, ...r };
  });

  // ---------------------------------------------------------------- logs & memory
  on('GET', '/api/logs', async (req) => {
    const limit = Math.min(500, Number(req.query.get('limit') || 120));
    const state = req.query.get('state');
    const rows = state
      ? await store.all(`SELECT * FROM runs WHERE state=? ORDER BY created_at DESC LIMIT ?`, state, limit)
      : await store.all(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`, limit);
    const ai = await store.all(`SELECT provider, model, role, ok, status_code, error, latency_ms, created_at FROM ai_usage ORDER BY created_at DESC LIMIT 60`);
    return { runs: rows.map((r) => ({ ...r, detail: safeJson(r.detail, null) })), ai_usage: ai };
  });
  on('GET', '/api/memory', async (req) => {
    const kind = req.query.get('kind');
    const q = req.query.get('q');
    const limit = Math.min(300, Number(req.query.get('limit') || 100));
    let rows;
    if (q) rows = await memory.search(q, { kinds: kind ? [kind] : null, limit });
    else if (kind) rows = await store.all(`SELECT * FROM memories WHERE kind=? ORDER BY created_at DESC LIMIT ?`, kind, limit);
    else rows = await store.all(`SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`, limit);
    return { memories: rows, stats: await memory.stats() };
  });
  on('GET', '/api/memory/guardrails', async () => ({ memories: await memory.guardrails('global') }));
  on('GET', '/api/checkpoints', async (req) => {
    const scope = req.query.get('scope');
    const rows = scope
      ? await store.all(`SELECT * FROM checkpoints WHERE scope=? ORDER BY created_at DESC LIMIT 25`, scope)
      : await store.all(`SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT 50`);
    return { checkpoints: rows.map((c) => ({ ...c, payload: safeJson(c.payload, null) })) };
  });

  // ---------------------------------------------------------------- ledger
  on('GET', '/api/ledger', async () => {
    const rows = await store.all(`SELECT * FROM ledger ORDER BY occurred_on DESC, created_at DESC LIMIT 500`);
    const daily = await store.all(`SELECT occurred_on AS day, kind, basis, SUM(amount) AS total FROM ledger GROUP BY occurred_on, kind, basis ORDER BY day DESC LIMIT 200`);
    return { entries: rows, summary: summarizeLedger(rows), daily, disclaimer: '実測(measured)には証拠があります。推定(estimated)は実績として算入していません。' };
  });
  on('POST', '/api/ledger', async (req, body) => {
    const kind = body.kind === 'cost' ? 'cost' : 'revenue';
    const basis = ['measured', 'third_party', 'estimated', 'unverified'].includes(body.basis) ? body.basis : 'unverified';
    if (basis === 'measured' && !body.source) return { ok: false, error: 'measured_requires_source', note: '実測として記録するには source（証拠URL/記録）が必要です' };
    const row = { id: `led_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, amount: Number(body.amount) || 0, currency: body.currency || 'JPY', basis, source: body.source || null, opportunity_id: body.opportunity_id || null, occurred_on: body.occurred_on || utcDay(), note: body.note || null, created_at: nowIso() };
    await store.insert('ledger', row);
    return { ok: true, entry: row };
  });

  // ---------------------------------------------------------------- settings / providers
  on('GET', '/api/providers', async () => ({ ...(await router.status()), env: publicEnv(env) }));
  on('GET', '/api/settings', async () => {
    const rows = await store.all(`SELECT * FROM settings WHERE key NOT LIKE 'md:%' AND key NOT LIKE 'fetch%' ORDER BY key`);
    return {
      settings: rows.map((r) => ({ key: r.key, value: safeJson(r.value, r.value) })),
      env: publicEnv(env),
      secrets_policy: 'APIキーはサーバー側のシークレットとしてのみ保存されます（wrangler secret put）。ブラウザーや公開リポジトリには一切露出しません。',
    };
  });
  on('POST', '/api/settings', async (req, body) => {
    const allowed = ['engine:state', 'ai:preferred', 'report:frequency', 'notify:webhook'];
    if (!allowed.includes(body.key)) return { ok: false, error: 'key_not_allowed', allowed };
    await store.run(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, body.key, typeof body.value === 'string' ? body.value : j(body.value), nowIso());
    return { ok: true };
  });

  // ---------------------------------------------------------------- chat (auxiliary)
  on('POST', '/api/chat', async (req, body) => {
    const character = await engine.getCharacter();
    const state = await engine.engineState();
    const memos = await memory.digest(body.message, { scope: 'global', limit: 10 });
    const context = {
      engine: state.status, next: (await store.first(`SELECT title, state FROM tasks WHERE state='queued' ORDER BY priority DESC LIMIT 1`)) || null,
      running: await store.first(`SELECT COUNT(*) AS c FROM tasks WHERE state='running'`),
      ledger: summarizeLedger(await store.all(`SELECT * FROM ledger ORDER BY occurred_on DESC LIMIT 300`)),
    };
    const r = await router.complete({
      role: 'chat',
      system: `${(await import('./ai/prompts.js')).characterSystemPrompt(character, { role: 'chat' })}
# 現在の状況
エンジン: ${context.engine}
実行中タスク: ${context.running?.c || 0}
次のタスク: ${context.next?.title || 'なし'}
実測収益: ${context.ledger.revenue.measured} / 推定: ${context.ledger.revenue.total_estimated}
# 長期記憶
${memos.map((m) => `- [${m.kind}] ${truncate(m.text, 160)}`).join('\n') || '（なし）'}`,
      user: body.message, maxTokens: 1200, temperature: 0.6,
    });
    await memory.write({ kind: 'experience', key: `chat:${Date.now()}`, text: `オーナーとの対話: ${truncate(body.message, 200)}`, evidence: 'measured', importance: 30 });
    return { ok: true, reply: r.text, provider: r.provider, fallback: !!r.fallback, note: r.note || null };
  });

  // ---------------------------------------------------------------- threads
  // The conversation list the owner keeps on the left. Stored in D1 so a thread
  // started on the phone continues on the desktop.
  on('GET', '/api/threads', async (req) => {
    const q = String(req?.query?.get?.('q') || '').trim();
    const rows = await store.all(
      `SELECT t.*,
              (SELECT text FROM chat_messages m WHERE m.thread_id=t.id ORDER BY m.created_at DESC LIMIT 1) AS preview,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id=t.id) AS message_count
         FROM chat_threads t ${q ? 'WHERE t.title LIKE ?' : ''}
        ORDER BY t.pinned DESC, t.updated_at DESC LIMIT 100`,
      ...(q ? [`%${q}%`] : []),
    );
    return { ok: true, threads: rows, query: q || null };
  });
  on('POST', '/api/threads', async (req, body) => {
    const id = `thr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const at = nowIso();
    const title = String(body?.title || '新しい会話').slice(0, 120);
    await store.run(`INSERT INTO chat_threads (id,title,mode,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      id, title, body?.mode || 'normal', 0, at, at);
    return { ok: true, thread: { id, title, mode: body?.mode || 'normal', pinned: 0, created_at: at, updated_at: at } };
  });
  on('GET', '/api/threads/:id', async (req, body, p) => {
    const thread = await store.get('chat_threads', p.id);
    if (!thread) return { ok: false, error: 'not_found' };
    const rows = await store.all(`SELECT * FROM chat_messages WHERE thread_id=? ORDER BY created_at LIMIT 500`, p.id);
    return {
      ok: true, thread,
      messages: rows.map((m) => ({ ...m, cards: safeJson(m.cards_json, []), events: safeJson(m.events_json, []) })),
    };
  });
  on('POST', '/api/threads/:id', async (req, body, p) => {
    const thread = await store.get('chat_threads', p.id);
    if (!thread) return { ok: false, error: 'not_found' };
    if (body?.action === 'delete') {
      await store.run(`DELETE FROM chat_messages WHERE thread_id=?`, p.id);
      await store.run(`DELETE FROM chat_threads WHERE id=?`, p.id);
      return { ok: true, deleted: p.id };
    }
    const title = body?.title !== undefined ? String(body.title).slice(0, 120) : thread.title;
    const pinned = body?.pinned !== undefined ? (body.pinned ? 1 : 0) : thread.pinned;
    const at = nowIso();
    await store.run(`UPDATE chat_threads SET title=?, pinned=?, updated_at=? WHERE id=?`, title, pinned, at, p.id);
    return { ok: true, thread: { ...thread, title, pinned, updated_at: at } };
  });

  // ---------------------------------------------------------------- chat actions (chat-first UI)
  on('POST', '/api/chat/act', async (req, body) => {
    const message = body && body.message ? String(body.message).slice(0, 4000) : '';
    const cmds = await import('./agent/commands.js');
    const deps = {
      store, env, engine, router, memory, research, deepResearch, knowledge, workflows, ranking, scheduler,
      browser, tools, fleet: fleetApi, runner: runnerApi, thread_id: body?.thread_id || null,
      // 判定に落ちた返答は、その場で本物の作り直しにつなげる。
      rework: (taskId, opts) => reworkTask(store, taskId, opts || {}),
    };

    // Active memory: bring back anything from earlier conversations that bears
    // on this message BEFORE answering, and show the owner what was recalled.
    let recalled = [];
    try {
      const hits = await memory.digest(message, { scope: 'global', limit: 5 });
      recalled = (hits || []).map((h) => ({ kind: h.kind, text: truncate(h.text, 200) }));
    } catch { recalled = []; }

    const out = await cmds.runCommand({ message, deps });

    // Store the exchange so the thread survives reloads and devices. Storage is
    // best-effort: a failure here never blocks the reply.
    let threadId = body?.thread_id || null;
    try {
      const at = nowIso();
      if (!threadId) {
        threadId = `thr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        await store.run(`INSERT INTO chat_threads (id,title,mode,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
          threadId, message.replace(/\s+/g, ' ').trim().slice(0, 38) || '新しい会話', 'normal', 0, at, at);
      } else {
        await store.run(`UPDATE chat_threads SET updated_at=? WHERE id=?`, at, threadId);
      }
      await store.insert('chat_messages', {
        id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        thread_id: threadId, role: 'me', text: message, cards_json: j([]), events_json: j([]), kind: null, created_at: at,
      });
      await store.insert('chat_messages', {
        id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}a`,
        thread_id: threadId, role: 'agent', text: String(out.reply || ''), cards_json: j(out.cards || []),
        events_json: j(out.events || []), kind: out.kind || null, created_at: nowIso(),
      });
      // A watch created in a brand-new conversation belongs to that conversation.
      if (out.watch_id && threadId) {
        await store.run(`UPDATE watch_rules SET thread_id=? WHERE id=? AND (thread_id IS NULL OR thread_id='')`, threadId, out.watch_id);
      }
      const n = await store.first(`SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id=?`, threadId);
      if (Number(n?.c || 0) <= 2) {
        await store.run(`UPDATE chat_threads SET title=? WHERE id=?`, message.replace(/\s+/g, ' ').trim().slice(0, 38) || '新しい会話', threadId);
      }
    } catch { /* keep the reply even if storage is unavailable */ }

    const modeNow = await activeMode(store).catch(() => null);
    return {
      ...out, thread_id: threadId, memory: recalled,
      mode: modeNow ? { id: modeNow.id, label: modeNow.label, blurb: modeNow.blurb || '', chips: defaultChips(modeNow), placeholder: modeNow.placeholder || 'エージェントに指示する' } : null,
    };
  });

  // ---------------------------------------------------------------- fleet (multi-agent)
  on('GET', '/api/fleet', async () => {
    if (!fleetApi) return { ok: false, error: 'fleet_unavailable' };
    return {
      agents: await fleetApi.list(),
      status: await fleetApi.status(),
      presets: Object.entries(fleetApi.AGENT_PRESETS || {}).map(([key, v]) => ({ key, ...v })),
    };
  });
  on('POST', '/api/fleet/agents', async (req, body) => fleetApi.create(body || {}));
  on('POST', '/api/fleet/agents/:id', async (req, body, p) => (body && body.action)
    ? fleetApi.control(body.action, { id: p.id })
    : fleetApi.update(p.id, body || {}));
  on('POST', '/api/fleet/agents/:id/remove', async (req, body, p) => fleetApi.remove(p.id));
  on('POST', '/api/fleet/tick', async (req, body) => fleetApi.tickAll({
    source: 'api',
    concurrency: Number(body && body.concurrency) || null,
    steps: Number(body && body.steps) || null,
  }));
  on('POST', '/api/fleet/all', async (req, body) => fleetApi.control((body && body.action) === 'pause' ? 'pause-all' : 'start-all'));
  on('POST', '/api/fleet/supervise', async (req, body) => fleetApi.supervise({ spawn: Number(body && body.spawn) || 1 }));
  on('POST', '/api/fleet/bootstrap', async () => fleetApi.bootstrap());

  // ---------------------------------------------------------------- image studio settings
  on('GET', '/api/image/settings', async () => {
    if (!imgApi) return { ok: false, error: 'imagegen_unavailable' };
    return { config: await imgApi.config(), options: imgApi.options(), availability: imgApi.availability(), defaults: imgApi.DEFAULT_CONFIG };
  });
  on('POST', '/api/image/settings', async (req, body) => imgApi.setConfig(body || {}));

  // ---------------------------------------------------------------- cloud PC (runner)
  on('GET', '/api/runner', async (req) => (runnerApi ? runnerApi.status({ limit: Number(req?.query?.get?.('limit') || 20) }) : { ok: false, error: 'runner_unavailable' }));
  on('POST', '/api/runner/jobs', async (req, body) => runnerApi.enqueue({
    command: body?.command, cwd: body?.cwd, timeoutMs: body?.timeout_ms, requestedBy: 'owner',
  }));
  on('POST', '/api/runner/claim', async (req, body) => runnerApi.claim({
    runnerId: body?.runner_id || 'cloud-pc', limit: body?.limit || 3,
  }));
  on('POST', '/api/runner/complete', async (req, body) => runnerApi.complete({
    jobId: body?.job_id, exitCode: body?.exit_code, stdout: body?.stdout, stderr: body?.stderr,
    durationMs: body?.duration_ms, runnerId: body?.runner_id,
  }));
  on('POST', '/api/runner/jobs/:id/cancel', async (req, body, p) => runnerApi.cancel(p.id));

  // ---------------------------------------------------------------- modes (用途)
  // 「たまに金稼ぎ以外にも使いたい」— 用途を切り替えると、提案・成果の数え方・
  // 承認の範囲が変わる。自分のモードもここから追加できる。
  on('GET', '/api/mode', async () => {
    const current = await activeMode(store);
    return { ok: true, current, modes: await allModes(store), builtin: builtinModes(), chips: defaultChips(current) };
  });
  on('POST', '/api/mode', async (req, body) => {
    const action = body?.action || 'switch';
    if (action === 'create') {
      const created = await upsertCustomMode(store, { label: body?.label, goal: body?.goal || '' });
      if (!created) return { ok: false, error: 'label_required' };
      await setActiveMode(store, created.id);
      return { ok: true, mode: created, modes: await allModes(store), chips: defaultChips(created) };
    }
    if (action === 'goal') {
      if (!body?.goal) return { ok: false, error: 'goal_required' };
      const cur = await activeMode(store);
      const upd = cur.custom ? await upsertCustomMode(store, { id: cur.id, label: cur.label, goal: body.goal }) : null;
      return { ok: true, mode: upd || cur, note: upd ? 'updated' : 'builtin_mode_uses_goal_watch' };
    }
    const { parseModeRequest } = await import('./agent/modes.js');
    const wanted = String(body?.id || parseModeRequest(body?.text || '').label || '');
    const modes = await allModes(store);
    const target = modes.find((m) => m.id === wanted || m.label === wanted || (wanted && m.label.includes(wanted)));
    if (!target) return { ok: false, error: 'mode_not_found', modes };
    await setActiveMode(store, target.id);
    return { ok: true, mode: target, modes, chips: defaultChips(target) };
  });

  // ---------------------------------------------------------------- watches (先回り報告)
  on('GET', '/api/watches', async () => {
    const { WATCH_METRICS, metricValue, goalProgress } = await import('./agent/watch.js');
    const rows = await store.all(`SELECT * FROM watch_rules ORDER BY hold DESC, created_at DESC LIMIT 50`).catch(() => []);
    const watches = [];
    for (const r of rows) {
      const value = await metricValue(store, r.metric).catch(() => null);
      watches.push({
        ...r, label: WATCH_METRICS[r.metric]?.label || r.metric, unit: WATCH_METRICS[r.metric]?.unit || '',
        current_value: value, progress: goalProgress(r, value || 0),
      });
    }
    const { activeGoal } = await import('./agent/watch.js');
    return { ok: true, watches, goal: await activeGoal(store).catch(() => null), metrics: Object.values(WATCH_METRICS) };
  });
  on('POST', '/api/watches', async (req, body) => {
    const { parseWatch, createWatch } = await import('./agent/watch.js');
    const parsed = body?.metric ? { metric: body.metric, op: body.op || '>=', threshold: Number(body.threshold) || 0, note: body.note || '' } : parseWatch(body?.text || '');
    if (!parsed || !parsed.metric) return { ok: false, error: 'metric_required', hint: '実測収益・完了した作業・失敗した作業・承認待ち のいずれかを指定してください' };
    const w = await createWatch(store, {
      ...parsed, thread_id: body?.thread_id || null,
      hold: body?.hold !== undefined ? !!body.hold : !!parsed.hold,
      stop_on_hit: !!body?.stop_on_hit,
    });
    return { ok: true, watch: w };
  });
  on('POST', '/api/watches/:id', async (req, body, p) => {
    const w = await store.get('watch_rules', p.id);
    if (!w) return { ok: false, error: 'not_found' };
    if (body?.action === 'delete') { await store.run(`DELETE FROM watch_rules WHERE id=?`, p.id); return { ok: true, deleted: p.id }; }
    if (body?.action === 'hold' || body?.action === 'unhold') {
      // 「達成するまで続ける」への切り替え（仕事の完了条件にする）。
      const on = body.action === 'hold';
      await store.run(`UPDATE watch_rules SET hold=?, status='active', achieved_value=NULL, updated_at=? WHERE id=?`, on ? 1 : 0, nowIso(), p.id);
      return { ok: true, hold: on ? 1 : 0 };
    }
    if (body?.action === 'pause' || body?.action === 'activate') {
      const status = body.action === 'pause' ? 'paused' : 'active';
      await store.run(`UPDATE watch_rules SET status=?, updated_at=? WHERE id=?`, status, nowIso(), p.id);
      return { ok: true, status };
    }
    if (body?.action === 'check') {
      const { checkWatches } = await import('./agent/watch.js');
      const r = await checkWatches({ store, memory });
      return { ok: true, ...r };
    }
    return { ok: false, error: 'unknown_action' };
  });

  // ---------------------------------------------------------------- admin
  on('POST', '/api/admin/migrate', async () => {
    const { ensureSchema } = await import('./db.js');
    await ensureSchema(store);
    return { ok: true };
  });
  on('POST', '/api/admin/seed', async () => {
    const character = await engine.getCharacter();
    if (!character) {
      const { DEFAULT_CHARACTER } = await import('./ai/prompts.js');
      await store.insert('characters', {
        id: 'chr_default', preset: DEFAULT_CHARACTER.preset, name: DEFAULT_CHARACTER.name,
        avatar: DEFAULT_CHARACTER.avatar, description: DEFAULT_CHARACTER.description,
        personality: DEFAULT_CHARACTER.personality, tone: DEFAULT_CHARACTER.tone,
        values_json: j(DEFAULT_CHARACTER.values), strengths: DEFAULT_CHARACTER.strengths,
        weaknesses: DEFAULT_CHARACTER.weaknesses, creativity: DEFAULT_CHARACTER.creativity,
        caution: DEFAULT_CHARACTER.caution, risk_tolerance: DEFAULT_CHARACTER.risk_tolerance,
        report_frequency: DEFAULT_CHARACTER.report_frequency, autonomy_level: DEFAULT_CHARACTER.autonomy_level,
        long_term_goals: '月3万円の追加収益を、規約と法令の範囲内で継続的に生み出す',
        prohibitions: DEFAULT_CHARACTER.prohibitions, is_active: 1, created_at: nowIso(), updated_at: nowIso(),
      });
    }
    const starters = [];
    for (const s of STARTER_WORKFLOWS) {
      if (!(await store.first(`SELECT id FROM workflows WHERE name=?`, s.name))) starters.push(await workflows.save({ name: s.name, definition: s.definition }));
    }
    await store.run(`INSERT INTO missions (id,title,goal,constraints,success_metric,target_value,metric_unit,status,priority,autonomy_level,progress,created_at,updated_at)
      VALUES ('msn_starter','月3万円の追加収益','毎月3万円の追加収益を、日本から利用可能で規約に適合する方法で継続的に生み出す','元手ゼロ〜最小、法令・規約遵守、多重アカウント禁止','実測収益(measured)の月次合計',30000,'JPY','active',80,4,0,?,?)
      ON CONFLICT(id) DO NOTHING`, nowIso(), nowIso());
    const mission = await store.get('missions', 'msn_starter');
    let plan = null;
    const existing = await store.all(`SELECT * FROM tasks WHERE mission_id='msn_starter'`);
    if (!existing.length && mission) {
      const { planMission } = await import('./engine/planner.js');
      plan = await planMission({ store, router, memory, character: await engine.getCharacter(), mission, existingTasks: [] });
    }
    return { ok: true, workflows: starters, character_created: !character, plan };
  });

  // ------------------------------------------------ 自律の範囲（autonomy envelope）
  on('GET', '/api/envelope', async () => {
    const e = await getEnvelope(store);
    return { ok: true, envelope: e, card: envelopeCard(e),
      policy: { gate: checkEnvelope(e, { action: 'spend', amount_yen: 1 }), basis: POLICY.envelope } };
  });
  on('POST', '/api/envelope', async (req, body) => {
    const e = await setEnvelope(store, body || {});
    return { ok: true, envelope: e, card: envelopeCard(e) };
  });

  // ------------------------------------------------ 案件（jobs）
  on('GET', '/api/jobs', async (req) => {
    const state = new URL(req.url).searchParams.get('state');
    const rows = state
      ? await store.all(`SELECT * FROM jobs WHERE state=? ORDER BY updated_at DESC LIMIT 100`, state)
      : await store.all(`SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 100`);
    return { ok: true, jobs: rows, items: jobListItems(rows) };
  });
  on('POST', '/api/jobs', async (req, body) => {
    const job = await createJob(store, body || {});
    if (!job) return { ok: false, error: 'title_required' };
    return { ok: true, job, card: jobCard(job) };
  });
  on('POST', '/api/jobs/:id', async (req, body, p) => {
    const r = await advanceJob(store, p.id, body || {});
    return r.ok ? { ok: true, ...r, card: jobCard(r.job) } : { ok: false, ...r };
  });

  // ------------------------------------------------ 入金・純益（revenue）
  on('GET', '/api/revenue', async () => {
    const r = await revenueSummary(store);
    return { ok: true, revenue: r, basis: POLICY.receipts, margin_rule: POLICY.margin };
  });
  on('GET', '/api/receipts', async () => ({
    ok: true,
    receipts: await store.all(`SELECT * FROM receipts ORDER BY created_at DESC LIMIT 100`),
    note: POLICY.receipts,
  }));

  // ------------------------------------------------ x402（エージェント同士の市場で売る）
  on('GET', '/api/x402/catalog', async () => ({
    ok: true, enabled: x402Enabled(env), catalog: x402Catalog(env), note: POLICY.envelope,
  }));

  // ------------------------------------------------ 決済プロバイダの通知 → 入金
  // 検証できない通知は記録しない。ここが「実測」の入口を守っている。
  on('POST', '/api/webhooks/x402', async (req, body) => {
    const secret = env.WEBHOOK_SECRET || null;
    const u = new URL(req.url);
    const provided = req.headers.get('x-webhook-secret') || u.searchParams.get('secret') || '';
    const verified = !!secret && provided === secret;
    const r = await recordReceipt(store, { ...receiptFromCallback(body || {}), signature_verified: verified });
    return r.ok ? { ok: true, receipt_id: r.receipt.id, amount: r.receipt.amount } : { ok: false, error: r.error, note: r.note || POLICY.receipts };
  });
  on('POST', '/api/webhooks/stripe', async (req, body) => {
    const secret = env.STRIPE_WEBHOOK_SECRET || null;
    const u = new URL(req.url);
    const provided = u.searchParams.get('secret') || req.headers.get('x-webhook-secret') || '';
    const verified = !!secret && provided === secret;
    if (!verified) return { ok: false, error: 'unverified', note: 'STRIPE_WEBHOOK_SECRET が未設定、または一致しません。検証できない入金は記録しません。' };
    const b = body || {};
    const obj = b.data?.object || b;
    const amount = Number(obj.amount_received ?? obj.amount ?? obj.amount_total ?? 0);
    const r = await recordReceipt(store, {
      source: 'stripe', external_id: String(obj.id || obj.payment_intent || ''),
      amount, currency: String(obj.currency || 'jpy').toUpperCase(), fee: Number(obj.fee || 0),
      raw: b, signature_verified: true,
    });
    return r.ok ? { ok: true, receipt_id: r.receipt.id, amount: r.receipt.amount } : { ok: false, error: r.error };
  });

  on('GET', '/api/providers', async () => {
    const card = providerCard();
    return { ...card, help: providerHelp() };
  });

  on('GET', '/api/channels', async (req) => {
    let gross = 19;
    try {
      const u = new URL(req.url, 'http://local');
      const q = Number(u.searchParams.get('gross'));
      if (Number.isFinite(q) && q > 0) gross = q;
    } catch { /* keep default */ }
    const card = channelCard(gross);
    return { ...card, help: channelHelp() };
  });

  // 無料推論の使用量（実測）と円換算。自己申告は入れない。usd_jpy は上書き可。
  on('GET', '/api/autolanes', async () => ({
    lanes: AUTO_LANES,
    ranked: rankByLeastHands(),
    plan: autoPlan(),
    monitor: MONITOR_PRODUCTS,
    help: autoLaneHelp(),
  }));

  // 投稿キュー（下書きまでは全自動、最後の1タップだけ人が持つ）
  on('GET', '/api/publish', async () => {
    const st = await publishState(store);
    return { ...st, drafts: st.rows, pipeline: PIPELINE, caps_meta: CAPS, help: publishHelp() };
  });
  on('GET', '/api/publish/drafts', async () => listDrafts(store, { limit: 50 }));
  on('POST', '/api/publish/drafts', async (req, body) => queueDraft(store, body || {}));
  on('POST', '/api/publish/approve', async (req, body) => approveDraft(store, (body || {}).id));
  on('POST', '/api/publish/posted', async (req, body) => markPosted(store, (body || {}).id, (body || {}).url || null));

  // 実行環境（手足）— 音声と動画の合成だけがWorkersの外に出る
  on('GET', '/api/runner/status', async (req, env) => {
    const st = runnerState(boundEnv);
    return { ...st, pipeline: runnerPlan(), help: runnerHelp() };
  });
  on('POST', '/api/runner/dispatch', async (req, body) => dispatchJob(boundEnv, store, {
    kind: (body || {}).kind,
    payload: (body || {}).payload || {},
    name: (body || {}).name,
  }));
  on('GET', '/api/inference', async (req) => {
    let usd_jpy = null;
    try {
      const u = new URL(req.url, 'http://local');
      const q = Number(u.searchParams.get('usd_jpy'));
      if (Number.isFinite(q) && q > 0) usd_jpy = q;
    } catch { /* default */ }
    const board = await readUsageBoard(store, usd_jpy ? { usd_jpy } : {});
    return { ...board, capacity: capacityValue(poolCapacity()), help: inferenceHelp() };
  });

  return { routes };
}

function publicEnv(env) {
  return {
    AGENT_NAME: env.AGENT_NAME || 'Wealth Agent',
    ENGINE_STEPS_PER_TICK: env.ENGINE_STEPS_PER_TICK || '3',
    AI_DAILY_CALL_BUDGET: env.AI_DAILY_CALL_BUDGET || '300',
    ALLOW_PAID_AI: env.ALLOW_PAID_AI || 'false',
    PAID_DAILY_CAP_USD: env.PAID_DAILY_CAP_USD || null,
    // presence flags only — never the values
    secrets_present: {
      OWNER_TOKEN: !!env.OWNER_TOKEN,
      GEMINI_API_KEY: !!env.GEMINI_API_KEY,
      GROQ_API_KEY: !!env.GROQ_API_KEY,
      OPENROUTER_API_KEY: !!env.OPENROUTER_API_KEY,
      CEREBRAS_API_KEY: !!env.CEREBRAS_API_KEY,
      MISTRAL_API_KEY: !!env.MISTRAL_API_KEY,
      CLOUDFLARE_API_TOKEN: !!(env.CLOUDFLARE_API_TOKEN || env.AI),
    },
    search_endpoint_configured: !!env.SEARCH_ENDPOINT,
    runtime: env.RUNTIME || 'cloudflare-workers',
  };
}

const clampInt = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
