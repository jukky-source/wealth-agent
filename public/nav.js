// Wealth Agent — スマホ用シェル（下タブ5つ）。
// チャットは既存の app.js がそのまま担当し、このファイルは
// タスク / 自律運転 / 記憶 / 設定 の4画面とタブ切り替えだけを受け持つ。
// データはすべて既存の /api/* から取る（画面のための嘘の数字は作らない）。

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => { const d = new Date(s || 0); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const num = (n) => Number(n || 0).toLocaleString('ja-JP');

// 画面に出す「いま何をしているか」。内部の推論は見せず、段階だけを見せる。
const STATE_JA = {
  queued: '待機', planning: '目標を分析中', running: '作業を実行中', testing: '検証中',
  verifying: '結果を検証中', improving: '改善中', waiting_for_quota: '枠の回復待ち',
  waiting_for_approval: '承認待ち', waiting_for_user: 'あなたの操作待ち',
  completed: '完了', failed: '失敗', cancelled: '取り消し',
};
const badgeCls = (s) => (['running', 'planning', 'testing', 'verifying', 'improving'].includes(s) ? 'run'
  : (s === 'completed' ? 'done' : (s === 'failed' || s === 'cancelled' ? 'fail' : 'wait')));

function token() {
  const q = new URLSearchParams(location.search);
  const t = q.get('token') || q.get('t') || q.get('access_token');
  if (t) { try { localStorage.setItem('wa_token', t); } catch { /* 端末が拒否しても続行 */ } return t; }
  for (const k of ['wa_token', 'wealth_agent_token', 'owner_token', 'wa:token', 'token']) {
    try { const v = localStorage.getItem(k); if (v && v.length > 8) return v; } catch { /* noop */ }
  }
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (/token/i.test(k)) { const v = localStorage.getItem(k); if (v && v.length > 8) return v; }
    }
  } catch { /* noop */ }
  return '';
}

async function api(path, { method = 'GET', body = null, timeout = 25000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method, signal: ctl.signal,
      headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt.slice(0, 300) }; }
    if (res.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e; }
    if (!res.ok) { const e = new Error(String(data?.error || data?.hint || `HTTP ${res.status}`)); e.code = res.status; throw e; }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') { const t2 = new Error('timeout'); t2.code = 'timeout'; throw t2; }
    throw e;
  } finally { clearTimeout(t); }
}

let toastTimer = null;
function toast(msg) {
  let el = $('#nbToast');
  if (!el) { el = document.createElement('div'); el.id = 'nbToast'; el.className = 'toast2'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

function errBlock(e, retryAttr) {
  const msg = e?.code === 401
    ? 'この端末はまだ本人確認が済んでいません。チャット画面の「⋯」→「この端末をつなぐ」でアクセストークンを入れると、ここに実データが出ます。'
    : e?.code === 'timeout' ? '応答がありませんでした（25秒）。通信を確かめて、もう一度お試しください。'
      : `読み込みに失敗しました（${esc(e?.message || e)}）。`;
  return `<div class="err"><b>${e?.code === 401 ? '未接続' : 'エラー'}</b><div style="margin-top:5px">${msg}</div>
    <div class="acts"><button data-act="${retryAttr}">再試行</button></div></div>`;
}

// ---------------------------------------------------------------- タスク
function taskRow(t) {
  const st = t.state || 'queued';
  const errs = Array.isArray(t.error_history) ? t.error_history : [];
  const lastErr = errs.length ? errs[errs.length - 1] : null;
  return `<div class="row">
    <div class="t"><span class="badge ${badgeCls(st)}">${esc(STATE_JA[st] || st)}</span>${esc(t.title || '(無題)')}</div>
    <div class="m">
      ${t.category ? `<code>${esc(t.category)}</code>` : ''}
      ${t.tool_name ? `<code>${esc(t.tool_name)}</code>` : ''}
      <span>試行 ${num(t.attempt)}/${num(t.max_attempts)}</span>
      <span>${esc(fmtTime(t.updated_at))}</span>
    </div>
    ${t.next_action ? `<div class="m"><span>次の一手: ${esc(String(t.next_action).slice(0, 120))}</span></div>` : ''}
    ${lastErr ? `<details class="fold"><summary>失敗の理由（${errs.length}件）</summary><div class="body">${esc(typeof lastErr === 'string' ? lastErr : JSON.stringify(lastErr)).slice(0, 600)}</div></details>` : ''}
    <div class="acts">
      <button data-act="task-detail" data-id="${esc(t.id)}">履歴</button>
      ${['failed', 'cancelled'].includes(st) ? `<button class="pri" data-act="task-retry" data-id="${esc(t.id)}">再試行</button>` : ''}
      ${['queued', 'running', 'planning'].includes(st) ? `<button data-act="task-cancel" data-id="${esc(t.id)}">取り消す</button>` : ''}
    </div>
    <div class="det" data-det="${esc(t.id)}"></div>
  </div>`;
}

async function viewTasks(root) {
  const d = await api('/api/tasks?limit=150');
  const tasks = d.tasks || [];
  const by = (states) => tasks.filter((t) => states.includes(t.state));
  const groups = [
    ['実行中・検証中', by(['running', 'planning', 'testing', 'verifying', 'improving'])],
    ['待機', by(['queued'])],
    ['あなたの操作・承認待ち', by(['waiting_for_user', 'waiting_for_approval', 'waiting_for_quota'])],
    ['完了', by(['completed']).slice(0, 15)],
    ['失敗', by(['failed', 'cancelled']).slice(0, 15)],
  ];
  const total = tasks.length;
  root.innerHTML = `<div class="vwrap">
    <div class="vhead"><h2>タスク</h2><span class="sub">${num(total)}件</span><span class="sp"></span>
      <button class="ghost" data-act="reload-tasks">更新</button></div>
    ${groups.map(([label, list]) => list.length ? `<div class="card"><h3>${label} <span class="badge">${list.length}</span></h3>${list.map(taskRow).join('')}</div>` : '').join('')}
    ${total ? '' : '<div class="empty">タスクはまだありません。下の「自律運転」から目標を話しかけると、ここに計画が並びます。</div>'}
  </div>`;
}

// ---------------------------------------------------------------- 自律運転
async function viewAuto(root) {
  const [dash, eng, threads] = await Promise.all([
    api('/api/dashboard'),
    api('/api/engine'),
    api('/api/threads').catch(() => ({ threads: [] })),
  ]);
  const st = eng.state || dash.state || {};
  const mode = String(st.mode || st.state || dash.mode?.id || 'unknown');
  const running = dash.running || [];
  const queued = dash.queued || [];
  const mission = dash.activeMission || (dash.missions || [])[0] || null;
  const prog = mission ? Math.round(Number(mission.progress || 0) * (Number(mission.progress || 0) <= 1 ? 100 : 1)) : 0;
  const stage = running[0] ? (STATE_JA[running[0].state] || '作業を実行中') : (queued.length ? '次の作業を選んでいます' : '待機中');
  const nextSel = dash.nextSel || dash.next || null;
  const ai = dash.aiStatus || {};
  const list = (threads.threads || []).slice(0, 12);
  root.innerHTML = `<div class="vwrap">
    <div class="vhead"><h2>自律運転</h2><span class="sub">${esc(mode)}</span><span class="sp"></span>
      <button class="ghost" data-act="reload-auto">更新</button></div>

    <div class="card tight">
      <h3>いまの段階</h3>
      <div class="m" style="font-size:13px">${esc(stage)}</div>
      <div class="stat" style="margin-top:9px">
        <div class="s"><b>${num(running.length)}</b><span>実行中</span></div>
        <div class="s"><b>${num(queued.length)}</b><span>待機</span></div>
        <div class="s"><b>${num((dash.failed || []).length)}</b><span>失敗</span></div>
      </div>
      ${mission ? `<div style="margin-top:6px;font-size:12.5px">目標: ${esc(mission.title || mission.goal || '')}</div>
        <div class="bar"><i style="width:${Math.max(0, Math.min(100, prog))}%"></i></div>
        <div class="note">進捗 ${prog}%（自己申告ではなくタスク完了数から算出）</div>` : '<div class="note">目標はまだ登録されていません。</div>'}
      ${nextSel ? `<div class="note">次の一手: ${esc(String(nextSel.title || nextSel.next_action || nextSel.task?.title || '')).slice(0, 160)}</div>` : ''}
    </div>

    <div class="card">
      <h3>運転の操作</h3>
      <div class="acts">
        <button class="pri" data-act="engine-resume">再開</button>
        <button data-act="engine-pause">一時停止</button>
        <button data-act="engine-stop" class="danger">停止</button>
        <button data-act="engine-tick">1歩すすめる</button>
        <button data-act="sched-tick">1周まわす</button>
      </div>
      <div class="note">「1歩すすめる」はタスクを最大2件、「1周まわす」はcronと同じ処理を1回だけその場で走らせます。重い処理は分割して、次の実行に続きます。</div>
    </div>

    <div class="card">
      <h3>話しかけて実行させる</h3>
      <label class="fld"><span>目標（例: 毎日稼げる方法を探して、実現可能なものを試して）</span>
        <textarea class="i" id="goalIn" placeholder="自然な日本語で書いてください"></textarea></label>
      <div class="acts">
        <button class="pri" data-act="plan-goal">計画して実行する</button>
        ${list.length ? `<button data-act="pick-thread">会話から選ぶ</button>` : ''}
      </div>
      ${list.length ? `<label class="fld" id="thrWrap" hidden><span>会話を選ぶ（最後の指示を読み込みます）</span>
        <select class="i" id="thrSel">${list.map((t) => `<option value="${esc(t.id)}">${esc((t.title || '無題').slice(0, 40))} · ${esc(fmtTime(t.updated_at || t.created_at))}</option>`).join('')}</select></label>` : ''}
      <div class="note">押すと「計画（タスク分解）」を作り、その場で1〜2件実行します。残りはcronが続きを進めます。お金が動く操作・外部投稿は承認待ちで止まります。</div>
    </div>

    <div class="card">
      <h3>直近の動き</h3>
      ${(running.concat(queued)).slice(0, 8).map((t) => `<div class="row"><div class="t"><span class="badge ${badgeCls(t.state)}">${esc(STATE_JA[t.state] || t.state)}</span>${esc(t.title || '')}</div><div class="m"><span>${esc(fmtTime(t.updated_at))}</span></div></div>`).join('') || '<div class="empty">まだ動きはありません。</div>'}
    </div>

    <div class="card">
      <h3>AIの割り当て</h3>
      <dl class="kv">
        <dt>使える提供元</dt><dd>${num((ai.providers || []).length || Object.keys(ai.providers || {}).length)}</dd>
        <dt>今日の呼び出し</dt><dd>${num(ai.calls_today ?? ai.calls ?? 0)}</dd>
        <dt>今日の推定費用</dt><dd>$${Number(ai.est_cost_usd || 0).toFixed(4)}</dd>
      </dl>
      <div class="note">無料枠を優先して自動で切り替えます（詳細は「設定」タブ）。</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- 記憶
function memRow(m) {
  return `<div class="row">
    <div class="t"><span class="badge">${esc(m.kind)}</span>${esc(m.text)}</div>
    <div class="m"><span>重要度 ${num(m.importance)}</span><span>${esc(fmtTime(m.created_at))}</span>${m.evidence ? `<code>${esc(m.evidence)}</code>` : ''}</div>
    <div class="acts">
      <button data-act="mem-edit" data-id="${esc(m.id)}">編集</button>
      <button class="danger" data-act="mem-del" data-id="${esc(m.id)}">削除</button>
    </div>
  </div>`;
}

async function viewMemory(root, q = '') {
  const d = await api(`/api/memory?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const rows = d.memories || [];
  const kinds = [...new Set(rows.map((r) => r.kind))];
  root.innerHTML = `<div class="vwrap">
    <div class="vhead"><h2>記憶</h2><span class="sub">${num(rows.length)}件${q ? '（検索中）' : ''}</span><span class="sp"></span>
      <button class="ghost" data-act="reload-mem">更新</button></div>
    <div class="card tight">
      <input class="i" id="memQ" placeholder="記憶を検索（例: 収益 / 失敗 / x402）" value="${esc(q)}" enterkeyhint="search" />
      <div class="note">目標・好み・禁止事項・成功した手順・失敗の理由・決定事項がここに入ります。鍵やパスワードは保存しません。</div>
    </div>
    <div class="card tight">
      <h3>自分で覚えさせる</h3>
      <label class="fld"><span>種類</span>
        <select class="i" id="memKind">
          ${['goal', 'preference', 'prohibition', 'constraint', 'fact', 'success', 'failure', 'experience', 'next_action'].map((k) => `<option value="${k}">${k}</option>`).join('')}
        </select></label>
      <label class="fld"><span>内容</span><textarea class="i" id="memText" placeholder="例: 平日の昼は作業できない。夜の報告だけにして。"></textarea></label>
      <div class="acts"><button class="pri" data-act="mem-add">覚えさせる</button></div>
    </div>
    <div class="card">${rows.map(memRow).join('') || '<div class="empty">まだ記憶はありません。</div>'}</div>
    <div class="note">${esc(kinds.length ? `種類: ${kinds.join(' / ')}` : '')}</div>
  </div>`;
}

// ---------------------------------------------------------------- 設定
function providerRows(p) {
  const src = p?.providers || p?.pool || p?.list || null;
  if (Array.isArray(src)) return src.map((x) => ({ name: x.provider || x.name || x.id, status: x.status || x.state || (x.enabled === false ? 'off' : ''), note: x.last_error || x.model || x.note || '' }));
  if (src && typeof src === 'object') return Object.entries(src).map(([k, v]) => (v && typeof v === 'object'
    ? { name: k, status: v.status || v.state || (v.enabled === false ? 'off' : ''), note: v.last_error || v.model || v.note || '' }
    : { name: k, status: String(v), note: '' }));
  return [];
}
function modelNames(m) {
  const src = m?.models ?? m;
  if (Array.isArray(src)) return src.map((x) => (typeof x === 'string' ? x : (x.name || x.model || x.id))).filter(Boolean);
  if (src && typeof src === 'object') return Object.entries(src).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${typeof x === 'string' ? x : (x.name || x.model || x.id)}`) : [`${k}`]));
  return [];
}

async function viewSettings(root) {
  const [prov, models, sett, env, chk] = await Promise.all([
    api('/api/providers').catch((e) => ({ __err: e })),
    api('/api/ai/models').catch((e) => ({ __err: e })),
    api('/api/settings').catch((e) => ({ __err: e })),
    api('/api/envelope').catch((e) => ({ __err: e })),
    api('/api/setup/checklist').catch((e) => ({ __err: e })),
  ]);
  const rows = providerRows(prov);
  const names = modelNames(models).slice(0, 24);
  const settings = sett.settings || [];
  const envFlags = sett.env || {};
  const permissions = env.permissions || env.envelope || env;
  const permRows = (permissions && typeof permissions === 'object' && !permissions.__err)
    ? Object.entries(permissions).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean').slice(0, 14)
    : [];
  root.innerHTML = `<div class="vwrap">
    <div class="vhead"><h2>設定</h2><span class="sub">モデル・予算・権限</span><span class="sp"></span>
      <button class="ghost" data-act="reload-set">更新</button></div>

    <div class="card">
      <h3>AIモデルの使い分け</h3>
      ${rows.length ? `<dl class="kv">${rows.map((r) => `<dt>${esc(r.name)}</dt><dd>${esc(r.status || '—')}</dd>`).join('')}</dl>` : '<div class="empty">提供元の状態を取得できませんでした。</div>'}
      ${names.length ? `<details class="fold"><summary>見えているモデル（${names.length}）</summary><div class="body">${esc(names.join('\n'))}</div></details>` : ''}
      <label class="fld"><span>優先するモデル（例: @cf/openai/gpt-oss-120b）</span>
        <input class="i mono" id="prefModel" placeholder="空なら自動（無料枠を優先）" /></label>
      <div class="acts"><button class="pri" data-act="save-model">保存</button></div>
      <div class="note">重い計画・コード生成は高性能モデル、分類や要約は軽量モデル、結果の確認は検証担当、障害時は代替に自動で切り替えます。単一モデルで足りる作業は分けません。鍵はサーバー側のシークレットのみに置き、この画面には出しません。</div>
    </div>

    <div class="card">
      <h3>予算と通知</h3>
      <label class="fld"><span>1日のAI費用の上限（USD）</span>
        <input class="i mono" id="budget" inputmode="decimal" placeholder="例: 0（無料枠のみ）" /></label>
      <label class="fld"><span>報告の頻度</span>
        <select class="i" id="freq"><option value="daily">毎日</option><option value="weekly">毎週</option><option value="off">しない</option></select></label>
      <div class="acts"><button class="pri" data-act="save-budget">保存</button></div>
      <div class="note">上限を超える有料呼び出しは行いません。無料枠（Cloudflare Workers AI 10,000 Neurons/日・Gemini・Groq・Cerebras・Mistral・OpenRouter の無料モデル）を先に使います。</div>
    </div>

    <div class="card">
      <h3>権限（できること / しないこと）</h3>
      ${permRows.length ? `<dl class="kv">${permRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join('')}</dl>` : '<div class="empty">権限の設定を取得できませんでした。</div>'}
      <div class="note">外部への投稿・購入・送金・アカウント変更・不可逆な操作は、あなたの明示の承認なしには実行しません。</div>
    </div>

    <div class="card">
      <h3>接続の状態</h3>
      <dl class="kv">
        <dt>この端末</dt><dd>${token() ? '接続済み' : '未接続'}</dd>
        <dt>実行環境</dt><dd>Cloudflare Workers</dd>
        <dt>定期実行</dt><dd>${esc(String(envFlags.ENGINE_STEPS_PER_TICK ?? '既定'))}</dd>
      </dl>
      ${chk && !chk.__err ? `<details class="fold"><summary>セットアップの残り</summary><div class="body">${esc(JSON.stringify(chk).slice(0, 700))}</div></details>` : ''}
    </div>

    <div class="card">
      <h3>保存されている設定</h3>
      ${settings.length ? settings.map((s) => `<div class="row"><div class="t mono" style="font-size:12px">${esc(s.key)}</div><div class="m"><span>${esc(typeof s.value === 'string' ? s.value : JSON.stringify(s.value)).slice(0, 140)}</span></div></div>`).join('') : '<div class="empty">設定はまだありません。</div>'}
      <div class="note">APIキーはここに出ません（サーバー側のシークレットにのみ保存）。</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- タブ
const TABS = [
  { id: 'chat', label: 'チャット', d: 'M4 5.5h16v10.5H9.5L5 20V5.5Z' },
  { id: 'tasks', label: 'タスク', d: 'M5 6.5h14M5 12h14M5 17.5h9' },
  { id: 'auto', label: '自律運転', d: 'M12 4a8 8 0 1 0 7.4 5M12 8v4l3 2M20 3.5v5h-5' },
  { id: 'memory', label: '記憶', d: 'M6 4h9l4 4v12H6zM9 9h7M9 13h7M9 17h4' },
  { id: 'settings', label: '設定', d: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 12h2M17.5 12h2M12 4.5v2M12 17.5v2' },
];
let activeTab = 'chat';
let refreshing = false;

function paintNav() {
  const nav = $('#bnav');
  if (!nav) return;
  nav.innerHTML = TABS.map((t) => `<button data-tab="${t.id}" class="${t.id === activeTab ? 'on' : ''}" aria-label="${t.label}">
    <svg viewBox="0 0 24 24"><path d="${t.d}"/></svg><span>${t.label}</span></button>`).join('');
}

async function loadView(force = false) {
  if (activeTab === 'chat') return;
  const root = $('#views');
  if (!root) return;
  if (refreshing && !force) return;
  refreshing = true;
  root.innerHTML = `<div class="vwrap"><div class="skel" style="width:38%"></div><div class="skel"></div><div class="skel" style="width:82%"></div><div class="skel" style="height:96px"></div></div>`;
  try {
    if (activeTab === 'tasks') await viewTasks(root);
    else if (activeTab === 'auto') await viewAuto(root);
    else if (activeTab === 'memory') await viewMemory(root, '');
    else await viewSettings(root);
  } catch (e) {
    root.innerHTML = `<div class="vwrap">${errBlock(e, `reload-${activeTab}`)}</div>`;
  } finally { refreshing = false; }
}

function showTab(id) {
  activeTab = id;
  document.body.dataset.tab = id;
  document.body.classList.add('has-bnav');
  const root = $('#views');
  if (root) root.hidden = id === 'chat';
  paintNav();
  try { history.replaceState(null, '', `#${id}`); } catch { /* noop */ }
  loadView();
}

document.addEventListener('click', async (ev) => {
  const tabBtn = ev.target.closest('[data-tab]');
  if (tabBtn) { showTab(tabBtn.dataset.tab); return; }
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const id = b.dataset.id;
  const wrap = (fn) => { b.disabled = true; fn().catch((e) => toast(e?.code === 401 ? '未接続です（設定タブを確認）' : `失敗: ${e?.message || e}`)).finally(() => { b.disabled = false; }); };
  if (act.startsWith('reload-')) { loadView(true); return; }
  if (act === 'task-retry') return wrap(async () => { await api(`/api/tasks/${id}/action`, { method: 'POST', body: { action: 'retry' } }); toast('再試行を積みました'); loadView(true); });
  if (act === 'task-cancel') return wrap(async () => { await api(`/api/tasks/${id}/action`, { method: 'POST', body: { action: 'cancel' } }); toast('取り消しました'); loadView(true); });
  if (act === 'task-detail') return wrap(async () => {
    const d = await api(`/api/tasks/${id}`);
    const runs = d.runs || [];
    const box = document.querySelector(`[data-det="${id}"]`);
    if (box) box.innerHTML = `<details class="fold" open><summary>実行履歴（${runs.length}）</summary><div class="body">${runs.map((r) => `${esc(fmtTime(r.created_at))} [${esc(r.state)}] ${esc(String(r.summary || '').slice(0, 200))}`).join('\n') || 'まだ実行されていません'}</div></details>`;
  });
  if (act === 'engine-resume') return wrap(async () => { await api('/api/engine/resume', { method: 'POST', body: {} }); toast('再開しました'); loadView(true); });
  if (act === 'engine-pause') return wrap(async () => { await api('/api/engine/pause', { method: 'POST', body: { reason: 'オーナーの操作' } }); toast('一時停止しました'); loadView(true); });
  if (act === 'engine-stop') return wrap(async () => { await api('/api/engine/stop', { method: 'POST', body: { reason: 'オーナーの操作' } }); toast('停止しました'); loadView(true); });
  if (act === 'engine-tick') return wrap(async () => { const r = await api('/api/engine/tick', { method: 'POST', body: { steps: 2 } }); toast(`1歩すすみました（${r.step || r.steps?.length || 0}）`); loadView(true); });
  if (act === 'sched-tick') return wrap(async () => { await api('/api/scheduler/tick', { method: 'POST', body: {} }); toast('1周まわしました'); loadView(true); });
  if (act === 'pick-thread') { const w = $('#thrWrap'); if (w) w.hidden = !w.hidden; return; }
  if (act === 'plan-goal') return wrap(async () => {
    const goal = ($('#goalIn')?.value || '').trim();
    if (!goal) return toast('目標を書いてください');
    const r = await api('/api/chat/plan', { method: 'POST', body: { goal } });
    toast(`計画を作りました（${(r.tasks || []).length}件のタスク）`);
    loadView(true);
  });
  if (act === 'mem-add') return wrap(async () => {
    const text = ($('#memText')?.value || '').trim();
    if (!text) return toast('内容を書いてください');
    await api('/api/memory', { method: 'POST', body: { kind: $('#memKind')?.value || 'fact', text } });
    toast('覚えました'); loadView(true);
  });
  if (act === 'mem-del') return wrap(async () => {
    if (!confirm('この記憶を削除します。よろしいですか？')) return;
    await api(`/api/memory/${id}`, { method: 'POST', body: { action: 'delete' } });
    toast('削除しました'); loadView(true);
  });
  if (act === 'mem-edit') return wrap(async () => {
    const row = ev.target.closest('.row');
    const cur = row?.querySelector('.t')?.textContent?.replace(/^[a-z_]+/, '').trim() || '';
    const next = prompt('記憶を編集', cur);
    if (next == null) return;
    await api(`/api/memory/${id}`, { method: 'POST', body: { text: next } });
    toast('更新しました'); loadView(true);
  });
  if (act === 'save-model') return wrap(async () => {
    const v = ($('#prefModel')?.value || '').trim();
    await api('/api/settings', { method: 'POST', body: { key: 'ai:preferred', value: v } });
    toast('保存しました'); loadView(true);
  });
  if (act === 'save-budget') return wrap(async () => {
    const b1 = ($('#budget')?.value || '').trim();
    const f = $('#freq')?.value || 'daily';
    if (b1 !== '') await api('/api/settings', { method: 'POST', body: { key: 'ai:budget_usd_day', value: Number(b1) || 0 } });
    await api('/api/settings', { method: 'POST', body: { key: 'report:frequency', value: f } });
    toast('保存しました'); loadView(true);
  });
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target?.id === 'memQ') { ev.preventDefault(); viewMemory($('#views'), ev.target.value).catch(() => {}); }
});
document.addEventListener('change', (ev) => {
  if (ev.target?.id === 'thrSel') {
    const tid = ev.target.value;
    api(`/api/threads/${tid}`).then((d) => {
      const msgs = (d.messages || []).filter((m) => m.role === 'me');
      const last = msgs[msgs.length - 1];
      if (last && $('#goalIn')) { $('#goalIn').value = last.text || ''; toast('最後の指示を読み込みました'); }
    }).catch(() => toast('会話を読めませんでした'));
  }
});

function boot() {
  if (!$('#bnav')) return;
  document.body.classList.add('has-bnav');
  const h = (location.hash || '').replace('#', '');
  activeTab = TABS.some((t) => t.id === h) ? h : 'chat';
  document.body.dataset.tab = activeTab;
  const root = $('#views');
  if (root) root.hidden = activeTab === 'chat';
  paintNav();
  if (activeTab !== 'chat') loadView();
  // タスクと自律運転は見ている間だけ静かに追いかける（20秒）。
  setInterval(() => {
    if (document.hidden || refreshing) return;
    if (activeTab === 'tasks' || activeTab === 'auto') loadView();
  }, 20000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
