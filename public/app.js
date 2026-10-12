import { icon } from './icons.js';
// Wealth Agent — PWA front end (vanilla ES modules, no build step).
// Screens: Home/Mission Control, Character Studio, Missions, Task Queue,
// Income Opportunities, FX Research, Rewards, Side Hustle, Workflow Builder,
// Knowledge Base, Execution Logs, Settings/Providers (+ auxiliary chat).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  token: localStorage.getItem('wa_token') || '',
  dashboard: null,
  route: location.hash.replace(/^#\/?/, '') || 'home',
  chat: [],
  cache: {},
  busy: false,
  avatarStyle: 'flat',
};

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
async function api(path, { method = 'GET', body = null, quiet = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { data = { ok: false, error: 'invalid_response' }; }
  if (!res.ok && !quiet) {
    if (res.status === 401) toast('認証エラー: 設定でトークンを入力してください');
    else toast(data?.error || `エラー (${res.status})`);
  }
  return data;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('ja-JP');
const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return String(s); } };
const pct = (n) => (n === null || n === undefined) ? '—' : `${Number(n).toFixed(1)}%`;

const BASIS_LABEL = { measured: '実測', third_party: '第三者報告', estimated: '推定', unverified: '未確認' };
const BASIS_CLASS = { measured: 'ok', third_party: 'info', estimated: 'warn', unverified: 'ghost' };
const STATE_LABEL = {
  queued: '待機', planning: '計画', running: '実行中', testing: 'テスト', verifying: '検証',
  improving: '改善', waiting_for_quota: 'API枠待ち', waiting_for_approval: '承認待ち',
  waiting_for_user: '入力待ち', completed: '完了', failed: '失敗', cancelled: '中止',
};
const STATE_CLASS = {
  completed: 'ok', running: 'accent', improving: 'warn', verifying: 'info', testing: 'info',
  failed: 'danger', cancelled: 'ghost', waiting_for_quota: 'warn', waiting_for_approval: 'warn', waiting_for_user: 'warn',
};
const STATE_LABEL_JP = STATE_LABEL;

const NAV = [
  { id: 'home', label: 'ホーム', ic: 'home' },
  { id: 'missions', label: 'ミッション', ic: 'target' },
  { id: 'tasks', label: 'タスク', ic: 'list' },
  { id: 'opportunities', label: '収益候補', ic: 'trending' },
  { id: 'fx', label: 'FX研究', ic: 'chart' },
  { id: 'rewards', label: 'ポイ活', ic: 'gift' },
  { id: 'sidehustle', label: '副業', ic: 'briefcase' },
  { id: 'workflows', label: 'ワークフロー', ic: 'branch' },
  { id: 'knowledge', label: 'ナレッジ', ic: 'book' },
  { id: 'logs', label: '実行ログ', ic: 'file' },
  { id: 'character', label: 'Character', ic: 'mask' },
  { id: 'settings', label: '設定', ic: 'gear' },
  { id: 'approvals', label: '承認', ic: 'shield' },
];
const TABS = [
  { id: 'home', label: 'ホーム', ic: 'home' },
  { id: 'missions', label: 'ミッション', ic: 'target' },
  { id: 'tasks', label: 'タスク', ic: 'list' },
  { id: 'opportunities', label: '収益', ic: 'trending' },
  { id: 'logs', label: 'ログ', ic: 'file' },
];

// ---------------------------------------------------------------------------
// Shell rendering
// ---------------------------------------------------------------------------
function renderNav() {
  $('#drawerNav').innerHTML = NAV.map((n) => `
    <a href="#/${n.id}" class="${state.route === n.id ? 'active' : ''}"><span class="ic">${icon(n.ic)}</span><span>${n.label}</span></a>
  `).join('');
  $('#tabbar').innerHTML = TABS.map((t) => `
    <a href="#/${t.id}" class="${state.route === t.id ? 'active' : ''}"><span class="ic">${icon(t.ic)}</span><span>${t.label}</span></a>
  `).join('');
}


/**
 * Character avatar: the uploaded or generated image when there is one, and a
 * typographic monogram otherwise. The mark never collapses into an empty box,
 * and a stored emoji is stripped so the icon system stays intact.
 */
function mark(ch) {
  const url = /^data:image\//i.test(String(ch?.avatar_url || '')) ? String(ch.avatar_url) : null;
  if (url) return `<img class="ava-img" src="${esc(url)}" alt="" decoding="async">`;
  const mono = String(ch?.avatar || '').replace(/\p{Extended_Pictographic}+/gu, '').trim();
  const src = mono || String(ch?.name || 'WA').trim();
  return `<span class="mk">${esc([...src].slice(0, 2).join(''))}</span>`;
}

function renderHeader() {
  const d = state.dashboard;
  const ch = d?.character;
  $('#agentName').textContent = ch?.name ? `${ch.name}` : 'Wealth Agent';
  const eng = d?.engine || {};
  const pill = $('#enginePill');
  pill.className = `engine-pill ${eng.status || 'stopped'}`;
  pill.innerHTML = `<span class="dot"></span>${eng.status === 'running' ? '稼働中' : eng.status === 'paused' ? '一時停止' : '待機中'}`;
  const providerCount = (d?.ai?.configured || []).filter((p) => p.key_present).length;
  $('#agentStatus').textContent = [
    ch ? `L${ch.autonomy_level ?? 4}` : 'キャラ未設定',
    eng.last_tick ? `最終tick ${fmtDate(eng.last_tick)}` : '未起動',
    providerCount ? `AI ${providerCount}社` : 'AIキー未設定（決定的モード）',
    d?.notifications?.waiting_approval ? `承認待ち${d.notifications.waiting_approval}件` : null,
  ].filter(Boolean).join(' · ');
  $('#agentAvatar').innerHTML = mark(ch);
  $('#drawerName').textContent = ch?.name || '未設定';
  $('#drawerTone').textContent = ch?.tone || ch?.description || '—';
}

/** Screen title: one Latin eyebrow over the Japanese title gives every screen
    the same reading order without shouting. */
function head(en, ja) {
  return `<div class="page-head"><div class="eyebrow">${esc(en)}</div><h1>${esc(ja)}</h1></div>`;
}

/** Empty state — icon, statement, and an optional next step. */
function empty(ic, text, hint = '') {
  return `<div class="empty"><span class="empty-ic">${icon(ic)}</span><div class="empty-t">${esc(text)}</div>`
    + (hint ? `<div class="empty-h">${esc(hint)}</div>` : '') + `</div>`;
}

function loading() {
  return `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
const screens = {};

screens.home = async () => {
  const d = await api('/api/dashboard');
  if (!d?.ok) return `<div class="notice danger">ダッシュボードの取得に失敗しました</div>`;
  state.dashboard = d;
  renderHeader();
  const eng = d.engine || {};
  const nt = d.next_task;
  const led = d.ledger || {};

  return `
  ${head('MISSION CONTROL', 'ホーム')}

  <div class="card hero">
    <div class="spread">
      <div class="grow">
        <div class="row" style="gap:8px">
          <div class="agent-avatar">${mark(d.character)}</div>
          <div class="grow">
            <div style="font-weight:650">${esc(d.character?.name || '未設定')}</div>
            <div class="muted">${esc(d.character?.description || 'キャラクター未設定')}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="row wrap" style="margin-top:10px">
      <span class="badge ${eng.status === 'running' ? 'ok' : eng.status === 'paused' ? 'warn' : 'ghost'}">${eng.status === 'running' ? '稼働中' : eng.status === 'paused' ? '一時停止' : '停止'}</span>
      <span class="badge accent">自律性 L${d.character?.autonomy_level ?? 4}</span>
      <span class="badge ghost">${esc(d.character?.report_frequency || 'daily')}</span>
      ${d.notifications?.waiting_quota ? `<span class="badge warn">API枠待ち ${d.notifications.waiting_quota}</span>` : ''}
      ${d.pending_approvals?.length ? `<span class="badge warn">承認待ち ${d.pending_approvals.length}</span>` : ''}
    </div>
    ${eng.reason ? `<div class="notice warn" style="margin-top:10px">${esc(eng.reason)}</div>` : ''}
    <div class="btn-row" style="margin-top:12px">
      ${eng.status === 'running'
        ? `<button class="btn warn" data-act="pause">${icon('pause')} 一時停止</button>`
        : `<button class="btn ok" data-act="start">${icon('play')} 開始</button>`}
      <button class="btn ghost" data-act="tick">${icon('refresh')} 1サイクル実行</button>
      ${(eng.status === 'running' || eng.status === 'paused')
        ? `<button class="btn danger" data-act="stop">${icon('stop')} 停止</button>` : ''}
    </div>
  </div>

  <h2>現在のミッション</h2>
  ${d.current_mission ? `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(d.current_mission.title)}</div>
          <div class="card-sub">${esc(d.current_mission.goal)}</div>
        </div>
        <span class="badge ${d.current_mission.status === 'active' ? 'ok' : 'warn'}">${esc(d.current_mission.status)}</span>
      </div>
      ${d.current_mission.verification ? `
        <div class="kv"><span class="k">目標</span><span class="v">${fmtNum(d.current_mission.target_value)} ${esc(d.current_mission.metric_unit)}</span></div>
        <div class="kv"><span class="k">実測収益</span><span class="v">${fmtNum(d.current_mission.verification.measured_revenue)} 円</span></div>
        <div class="kv"><span class="k">推定収益（実績に不算入）</span><span class="v">${fmtNum(d.current_mission.verification.estimated_revenue)} 円</span></div>
        <div class="bar ${d.current_mission.verification.progress >= 100 ? 'ok' : ''}" style="margin-top:8px"><i style="width:${Math.min(100, d.current_mission.verification.progress || 0)}%"></i></div>
        <div class="muted" style="margin-top:6px">${esc(d.current_mission.verification.statement)}</div>
      ` : ''}
    </div>` : `${empty('target', 'アクティブなミッションがありません', 'ミッション画面で新しい目標を作成できます')}`}

  <h2>次に実行するタスク</h2>
  ${nt ? `
    <div class="card">
      <div class="card-title">${esc(nt.title)}</div>
      <div class="card-sub">ツール: ${esc(nt.tool || '未定')} · カテゴリ ${esc(nt.category || '—')}</div>
      <div class="notice">選定理由: スコア ${nt.score} — ${esc(nt.reasons || '')}<br>
        候補 ${d.candidates_considered} 件から、期待効果・確度・リスク・コストをキャラクターの重みで評価して選択しました。</div>
    </div>` : `<details class="fold"><summary>次に実行するタスク（未定）</summary>${empty('list', '実行待ちタスクがありません', '再計画するとタスクが補充されます')}</details>`}

  <h2>実行中のタスク</h2>
  ${d.running_tasks.length ? d.running_tasks.map(taskCard).join('') : `<details class="fold"><summary>実行中のタスク（0件）</summary>${empty('play', '実行中のタスクはありません')}</details>`}

  <h2>直近の完了タスク</h2>
  ${d.completed_tasks.length ? d.completed_tasks.slice(0, 5).map(taskCard).join('') : `<details class="fold"><summary>直近の完了タスク（0件）</summary>${empty('shield', 'まだ完了タスクはありません')}</details>`}

  ${d.failed_tasks.length ? `<h2>失敗したタスク</h2>${d.failed_tasks.map(taskCard).join('')}` : ''}
  ${d.waiting_tasks.length ? `<h2>待機中のタスク</h2>${d.waiting_tasks.map(taskCard).join('')}` : ''}

  <h2>最後に成功したステップ</h2>
  <div class="card">
    ${d.last_success_step ? `
      <div class="card-title">${esc(d.last_success_step.title)}</div>
      <div class="muted">${esc(d.last_success_step.last_success_step || '—')} · ${fmtDate(d.last_success_step.finished_at)}</div>
    ` : `<div class="muted">まだ成功ステップの記録がありません</div>`}
  </div>

  <h2>収支（実績と推定を分離）</h2>
  <div class="grid2">
    <div class="stat"><div class="k">実測収益</div><div class="v">${fmtNum(led.revenue?.measured)}<span class="u"> 円</span></div></div>
    <div class="stat"><div class="k">推定収益</div><div class="v">${fmtNum(led.revenue?.total_estimated)}<span class="u"> 円</span></div></div>
    <div class="stat"><div class="k">実測コスト</div><div class="v">${fmtNum(led.cost?.measured)}<span class="u"> 円</span></div></div>
    <div class="stat"><div class="k">実測純利益</div><div class="v">${fmtNum(led.net_profit_measured)}<span class="u"> 円</span></div></div>
  </div>
  <div class="notice">${esc(led.disclaimer || '')}</div>
  <div class="btn-row" style="margin-top:8px">
    <button class="btn sm" data-go="logs">収支を記録</button>
    <button class="btn sm" data-act="recalibrate">推定を実測で補正</button>
  </div>

  <h2>収益候補の状況</h2>
  <div class="grid3">
    ${(d.opportunities || []).map((o) => `<div class="stat"><div class="k">${esc(o.domain)}</div><div class="v">${o.count}</div><div class="u">最高 ${o.best ?? '—'}</div></div>`).join('') || empty('trending', '候補なし')}
  </div>

  <h2>API使用状況</h2>
  <div class="card">
    <div class="kv"><span class="k">本日のAI呼び出し</span><span class="v">${d.ai?.budget?.used ?? 0} / ${d.ai?.budget?.daily_call_budget ?? 300}</span></div>
    ${(d.ai?.configured || []).map((p) => `<div class="kv"><span class="k">${esc(p.label)}</span><span class="v">${p.key_present ? `<span class="badge ${p.state === 'ok' ? 'ok' : p.state === 'rate_limited' ? 'warn' : 'ghost'}">${esc(p.state)}</span>` : '<span class="badge ghost">キー未設定</span>'}</span></div>`).join('')}
    <div class="muted" style="margin-top:6px">${esc(d.ai?.fallback_note || '')}</div>
  </div>

  <h2>長期記憶</h2>
  <div class="card">
    <div class="row wrap">
      ${Object.entries(d.memory?.by_kind || {}).map(([k, v]) => `<span class="badge ghost">${esc(k)} ${v}</span>`).join('') || '<span class="muted">記憶なし</span>'}
    </div>
  </div>

  ${d.pending_approvals?.length ? `<h2>確認待ちの重要操作</h2>${d.pending_approvals.map((a) => approvalCard(a)).join('')}` : ''}
  `;
};

function taskCard(t) {
  return `
  <div class="card tap" data-task="${esc(t.id)}">
    <div class="card-head">
      <div class="grow">
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-sub">${esc(t.category || '')} · ${esc(t.tool_name || '未定')} · 試行 ${t.attempt || 0}/${t.max_attempts || 3}</div>
      </div>
      <span class="badge ${STATE_CLASS[t.state] || 'ghost'}">${STATE_LABEL[t.state] || t.state}</span>
    </div>
    ${t.next_action ? `<div class="muted">次のアクション: ${esc(t.next_action)}</div>` : ''}
    ${t.last_success_step ? `<div class="muted">最後の成功: ${esc(t.last_success_step)}</div>` : ''}
    ${t.score ? `<div class="muted">スコア ${t.score} — ${esc(t.score_reasons || '')}</div>` : ''}
  </div>`;
}

function approvalCard(a) {
  return `
  <div class="card">
    <div class="card-head">
      <div class="card-title">${esc(a.action)}</div>
      <span class="badge ${a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'ok' : 'ghost'}">${esc(a.status)}</span>
    </div>
    <div class="muted">リスク: ${esc(a.risk_level)} · ${fmtDate(a.requested_at)}</div>
    ${a.note ? `<div class="muted">${esc(a.note)}</div>` : ''}
    ${a.status === 'pending' ? `<div class="btn-row" style="margin-top:10px">
      <button class="btn ok" data-approve="${esc(a.id)}">承認</button>
      <button class="btn danger" data-reject="${esc(a.id)}">却下</button>
    </div>` : ''}
  </div>`;
}

screens.missions = async () => {
  const d = await api('/api/missions');
  return `
  ${head('MISSIONS', 'ミッション')}
  <div class="card">
    <h3 style="margin-top:0">新しいミッション</h3>
    <label class="field"><span class="lbl">目標（例: 毎月3万円の追加収益を目指して、利用可能な方法を探索し実行し改善し続けて）</span>
      <textarea id="mGoal" placeholder="毎月3万円の追加収益を、日本から利用可能で規約に適合する方法で継続的に生み出す"></textarea></label>
    <div class="grid2">
      <label class="field"><span class="lbl">目標値</span><input type="number" id="mTarget" value="30000"></label>
      <label class="field"><span class="lbl">単位</span><input type="text" id="mUnit" value="JPY"></label>
    </div>
    <label class="field"><span class="lbl">制約条件</span><input type="text" id="mConstraints" value="元手ゼロ〜最小、多重アカウント禁止、法令・規約遵守"></label>
    <label class="field"><span class="lbl">成功指標</span><input type="text" id="mMetric" value="実測収益(measured)の月次合計"></label>
    <button class="btn primary block" data-act="create-mission">ミッションを作成し自動分解</button>
    <div class="hint">作成すると、キャラクターの人格と長期記憶（禁止事項・過去の失敗）を踏まえてタスクに自動分解されます。</div>
  </div>
  ${(d.missions || []).map((m) => `
    <div class="card">
      <div class="card-head">
        <div class="grow">
          <div class="card-title">${esc(m.title)}</div>
          <div class="card-sub">${esc(m.goal)}</div>
        </div>
        <span class="badge ${m.status === 'active' ? 'ok' : m.status === 'completed' ? 'accent' : 'warn'}">${esc(m.status)}</span>
      </div>
      <div class="row wrap">
        ${Object.entries(m.task_counts || {}).map(([k, v]) => `<span class="badge ${STATE_CLASS[k] || 'ghost'}">${STATE_LABEL[k] || k} ${v}</span>`).join('')}
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn sm" data-mission="${esc(m.id)}">詳細</button>
        <button class="btn sm" data-replan="${esc(m.id)}">再計画</button>
        <button class="btn sm" data-mstatus="${esc(m.id)}" data-status="${m.status === 'active' ? 'paused' : 'active'}">${m.status === 'active' ? '一時停止' : '再開'}</button>
      </div>
    </div>`).join('') || empty('target', 'ミッションがありません', '上のフォームから作成してください')}
  `;
};

screens.tasks = async () => {
  const d = await api('/api/tasks?limit=120');
  const groups = {};
  for (const t of d.tasks || []) { (groups[t.state] = groups[t.state] || []).push(t); }
  const order = ['running', 'improving', 'verifying', 'testing', 'planning', 'queued', 'waiting_for_quota', 'waiting_for_approval', 'waiting_for_user', 'failed', 'completed', 'cancelled'];
  return `
  ${head('TASK QUEUE', 'タスクキュー')}
  <div class="notice">状態: queued → planning → running → testing → verifying → improving →（completed / failed / waiting_*）。
  各遷移は実行ログに記録され、チェックポイントから再開できます。</div>
  ${order.filter((s) => groups[s]?.length).map((s) => `
    <h2>${STATE_LABEL[s] || s} (${groups[s].length})</h2>
    ${groups[s].slice(0, 20).map(taskCard).join('')}
  `).join('') || empty('list', 'タスクがありません')}
  `;
};

screens.opportunities = async () => {
  const d = await api('/api/opportunities');
  const fx = await api('/api/fx');
  return `
  ${head('INCOME OPPORTUNITIES', '収益候補')}
  <div class="card">
    <h3 style="margin-top:0">候補を調査</h3>
    <label class="field"><span class="lbl">領域</span>
      <select id="oDomain"><option value="rewards">ポイ活・報酬</option><option value="side_hustle">副業・Web事業</option></select></label>
    <label class="field"><span class="lbl">テーマ</span><input type="text" id="oTopic" placeholder="ポイ活 高還元 換金"></label>
    <div class="btn-row">
      <button class="btn primary" data-act="research-opp">調査して登録</button>
      <button class="btn" data-act="rank">ランキング更新</button>
    </div>
  </div>
  ${(d.opportunities || []).map((o) => `
    <div class="card">
      <div class="card-head">
        <div class="grow">
          <div class="card-title">${esc(o.name)}</div>
          <div class="card-sub">${esc(o.domain)} · 日本${esc(o.japan_availability)} · 規約${esc(o.tos_compliance)}</div>
        </div>
        <span class="badge ${o.status === 'rejected' ? 'danger' : o.score > 60 ? 'ok' : 'ghost'}">${o.score ?? 0}</span>
      </div>
      <div class="muted" style="white-space:pre-wrap">${esc((o.summary || '').slice(0, 420))}</div>
      <div class="grid3" style="margin-top:8px">
        <div class="stat"><div class="k">想定月収</div><div class="v">${fmtNum(o.est_monthly_revenue)}</div></div>
        <div class="stat"><div class="k">根拠</div><div class="v" style="font-size:13px"><span class="badge ${BASIS_CLASS[o.revenue_basis] || 'ghost'}">${BASIS_LABEL[o.revenue_basis] || o.revenue_basis}</span></div></div>
        <div class="stat"><div class="k">自動化</div><div class="v">${o.automation ?? 0}<span class="u">/100</span></div></div>
      </div>
      ${o.score_breakdown ? `<details class="acc" style="margin-top:8px"><summary>スコア内訳</summary>
        <div class="row wrap" style="margin-top:6px">${Object.entries(o.score_breakdown.breakdown || {}).map(([k, v]) => `<span class="badge ghost">${esc(k)} ${v}</span>`).join('')}</div>
        ${(o.score_breakdown.notes || []).length ? `<div class="muted">${esc(o.score_breakdown.notes.join(' / '))}</div>` : ''}
      </details>` : ''}
      ${(o.evidence_urls || []).length ? `<details class="acc"><summary>出典 (${o.evidence_urls.length})</summary>${o.evidence_urls.map((u) => `<div class="muted mono" style="word-break:break-all">${esc(u)}</div>`).join('')}</details>` : ''}
      <div class="btn-row" style="margin-top:8px">
        ${o.status !== 'rejected' ? `<button class="btn sm danger" data-reject-opp="${esc(o.id)}" data-name="${esc(o.name)}">却下</button>` : ''}
        <button class="btn sm" data-funnel="${esc(o.id)}">計測値を記録</button>
      </div>
    </div>`).join('') || empty('trending', '候補がありません', '「調査して登録」で収益候補を集められます')}
  `;
};

screens.fx = async () => {
  const d = await api('/api/fx');
  return `
  ${head('FX RESEARCH', '為替戦略の研究')}
  <div class="notice warn">${esc(d.disclaimer || '')}</div>
  <div class="card">
    <h3 style="margin-top:0">戦略の検証</h3>
    <div class="grid2">
      <label class="field"><span class="lbl">銘柄</span>
        <select id="fxSymbol">${(d.symbols || ['USDJPY']).map((s) => `<option>${esc(s)}</option>`).join('')}</select></label>
      <label class="field"><span class="lbl">日数</span><input type="number" id="fxDays" value="1500"></label>
    </div>
    <div class="btn-row">
      <button class="btn" data-act="fx-data">市場データ取得</button>
      <button class="btn" data-act="fx-gen">仮説を生成</button>
      <button class="btn primary" data-act="fx-bt">バックテスト実行</button>
      <button class="btn" data-act="fx-improve">改善案を検証</button>
    </div>
    <div class="hint">非リペイント検査（未来参照・確定前バー・イントラバー状態）を通過した戦略のみ昇格候補になります。</div>
  </div>
  <div id="fxResult"></div>

  <h2>戦略バージョン</h2>
  ${(d.strategies || []).map((s) => `
    <div class="card tap" data-fx-strategy="${esc(s.id)}">
      <div class="card-head">
        <div class="grow"><div class="card-title">${esc(s.name)} v${s.version}</div>
          <div class="card-sub">${esc(s.symbol)} · Pine ${esc(s.pine_version)} · ${fmtDate(s.created_at)}</div></div>
        <span class="badge ${s.non_repaint ? 'ok' : 'danger'}">${s.non_repaint ? '非リペイント合格' : '違反あり'}</span>
      </div>
      <div class="muted" style="white-space:pre-wrap">${esc((s.hypothesis || '').slice(0, 220))}</div>
    </div>`).join('') || empty('branch', '戦略がありません')}

  <h2>バックテスト結果</h2>
  ${(d.backtests || []).map((b) => `
    <div class="card">
      <div class="card-head">
        <div class="grow"><div class="card-title">${esc(b.symbol)} ${esc(b.date_from)} → ${esc(b.date_to)}</div>
          <div class="card-sub">${b.bars} 本 · ${fmtDate(b.created_at)}</div></div>
        <span class="badge ${b.pass ? 'ok' : 'danger'}">${b.pass ? 'PASS' : 'FAIL'}</span>
      </div>
      <div class="grid3">
        <div class="stat"><div class="k">PF</div><div class="v">${b.metrics?.profitFactor ?? '—'}</div></div>
        <div class="stat"><div class="k">勝率</div><div class="v">${b.metrics?.winRate ?? '—'}<span class="u">%</span></div></div>
        <div class="stat"><div class="k">最大DD</div><div class="v">${b.metrics?.maxDrawdownPct ?? '—'}<span class="u">%</span></div></div>
        <div class="stat"><div class="k">期待値</div><div class="v">${b.metrics?.expectancy ?? '—'}</div></div>
        <div class="stat"><div class="k">取引数</div><div class="v">${b.metrics?.trades ?? '—'}</div></div>
        <div class="stat"><div class="k">過剰最適化</div><div class="v" style="font-size:12px">${esc(b.overfit?.verdict || '—')}</div></div>
      </div>
    </div>`).join('') || empty('chart', 'バックテスト結果がありません')}

  <h2>利用可能な戦略エンジン</h2>
  ${(d.strategies_available || []).map((s) => `<div class="item"><div class="t">${esc(s.label)}</div><div class="s mono">${esc(JSON.stringify(s.defaultParams))}</div></div>`).join('')}
  `;
};

screens.rewards = async () => {
  const d = await api('/api/opportunities?domain=rewards');
  return `
  ${head('REWARDS', 'ポイ活リサーチ')}
  <div class="notice">日本から実際に利用できることを確認できないものは「未確認」として登録し、利用可能とは断定しません。
  多重アカウントなど規約違反の獲得方法は提案しません。</div>
  <div class="card">
    <label class="field"><span class="lbl">調査テーマ</span><input type="text" id="rTopic" value="ポイ活 高還元 換金条件 2026"></label>
    <button class="btn primary block" data-act="research-rewards">調査する</button>
  </div>
  ${(d.opportunities || []).map((o) => `
    <div class="card">
      <div class="card-head"><div class="grow"><div class="card-title">${esc(o.name)}</div>
        <div class="card-sub">日本: ${esc(o.japan_availability)} · 規約: ${esc(o.tos_compliance)} · スコア ${o.score ?? 0}</div></div>
        <span class="badge ${BASIS_CLASS[o.revenue_basis] || 'ghost'}">${BASIS_LABEL[o.revenue_basis] || o.revenue_basis}</span></div>
      <div class="muted" style="white-space:pre-wrap">${esc((o.summary || '').slice(0, 700))}</div>
      <div class="muted" style="margin-top:6px">検証済み結果: ${esc(o.verified_results || '未確認')}</div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn sm danger" data-reject-opp="${esc(o.id)}" data-name="${esc(o.name)}">却下（再提案しない）</button>
      </div>
    </div>`).join('') || empty('trending', '候補がありません', '上のフォームから調査してください')}
  `;
};

screens.sidehustle = async () => {
  const d = await api('/api/opportunities?domain=side_hustle');
  return `
  ${head('SIDE HUSTLE', '副業リサーチ')}
  <div class="notice warn">Webサイトを公開しただけでは収益は発生しません。訪問・登録・クリック・成約・売上を計測できた時点で初めて「収益化前の段階」を卒業します。</div>
  <div class="card">
    <label class="field"><span class="lbl">調査テーマ</span><input type="text" id="sTopic" value="個人開発 SaaS Webツール 収益 需要"></label>
    <button class="btn primary block" data-act="research-sidehustle">調査する</button>
  </div>
  ${(d.opportunities || []).map((o) => `
    <div class="card">
      <div class="card-head"><div class="grow"><div class="card-title">${esc(o.name)}</div>
        <div class="card-sub">難易度/競合は summary 参照 · スコア ${o.score ?? 0}</div></div>
        <span class="badge ${BASIS_CLASS[o.revenue_basis] || 'ghost'}">${BASIS_LABEL[o.revenue_basis] || o.revenue_basis}</span></div>
      <div class="muted" style="white-space:pre-wrap">${esc((o.summary || '').slice(0, 600))}</div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn sm" data-funnel="${esc(o.id)}">ファネル計測を記録</button>
        <button class="btn sm danger" data-reject-opp="${esc(o.id)}" data-name="${esc(o.name)}">却下</button>
      </div>
    </div>`).join('') || empty('trending', '候補がありません', '上のフォームから調査してください')}
  `;
};

screens.workflows = async () => {
  const d = await api('/api/workflows');
  const runs = await api('/api/workflows/runs');
  return `
  ${head('WORKFLOW', 'ワークフロービルダー')}
  <div class="card">
    <button class="btn block" data-act="seed-workflows">スターターワークフローを追加</button>
    <label class="field" style="margin-top:10px"><span class="lbl">定義（JSON）</span>
      <textarea id="wfDef" class="mono" placeholder='{"schedule":"0 22 * * *","steps":[{"id":"rank","tool":"rank_opportunities","args":{}}]}'></textarea></label>
    <label class="field"><span class="lbl">名前</span><input type="text" id="wfName" placeholder="毎日の点検"></label>
    <button class="btn primary block" data-act="save-workflow">保存</button>
    <div class="hint">step.type: tool / condition / delay。tool には retries・onError(continue|fail|goto)・output を指定できます。</div>
  </div>
  ${(d.workflows || []).map((w) => `
    <div class="card">
      <div class="card-head"><div class="grow"><div class="card-title">${esc(w.name)}</div>
        <div class="card-sub">${(w.definition?.steps || []).length} ステップ ${w.definition?.schedule ? `· ${esc(w.definition.schedule)}` : ''}</div></div>
        <span class="badge ${w.enabled ? 'ok' : 'ghost'}">${w.enabled ? '有効' : '無効'}</span></div>
      <button class="btn sm" data-run-workflow="${esc(w.id)}">今すぐ実行</button>
    </div>`).join('')}
  <h2>実行履歴</h2>
  ${(runs.runs || []).slice(0, 10).map((r) => `
    <div class="item"><div class="spread"><span class="t">${r.status}</span><span class="muted">${fmtDate(r.created_at)}</span></div>
      <div class="s">${(r.log || []).map((l) => `${esc(l.id)}:${l.ok ? 'ok' : 'ng'}`).join(' → ')}</div></div>`).join('') || empty('refresh', '実行履歴はありません')}
  `;
};

screens.knowledge = async () => {
  const d = await api('/api/knowledge');
  return `
  ${head('KNOWLEDGE', 'ナレッジベース')}
  <div class="card">
    <label class="field"><span class="lbl">ファイル名</span><input type="text" id="kName" placeholder="memo.txt"></label>
    <label class="field"><span class="lbl">テキストを貼り付け（またはファイル選択）</span><textarea id="kText"></textarea></label>
    <input type="file" id="kFile" accept=".txt,.md,.csv,.json,.tsv,.log" />
    <button class="btn primary block" data-act="ingest" style="margin-top:8px">取り込む</button>
  </div>
  <div class="card">
    <label class="field"><span class="lbl">文書に質問する</span><input type="text" id="kQ" placeholder="この文書の要点は？"></label>
    <button class="btn block" data-act="kquery">検索して回答</button>
    <div id="kAnswer"></div>
  </div>
  <h2>取り込み済み (${(d.documents || []).length})</h2>
  ${(d.documents || []).map((doc) => `
    <div class="item"><div class="t">${esc(doc.name)}</div>
      <div class="s">${doc.chunks} チャンク · ${fmtNum(doc.size)} 文字 · ${fmtDate(doc.created_at)}</div>
      <button class="btn sm danger" style="margin-top:6px" data-del-doc="${esc(doc.id)}">削除</button></div>`).join('') || empty('book', '文書がありません', '上のフォームから取り込めます')}
  `;
};

screens.logs = async () => {
  const d = await api('/api/logs?limit=150');
  const led = await api('/api/ledger');
  return `
  ${head('LOGS', '実行ログと収支')}
  <div class="card">
    <h3 style="margin-top:0">収支を記録</h3>
    <div class="grid2">
      <label class="field"><span class="lbl">種別</span><select id="lKind"><option value="revenue">収益</option><option value="cost">費用</option></select></label>
      <label class="field"><span class="lbl">金額</span><input type="number" id="lAmount" placeholder="1000"></label>
    </div>
    <label class="field"><span class="lbl">区分</span><select id="lBasis">
      <option value="measured">実測（要・証拠）</option><option value="third_party">第三者報告</option>
      <option value="estimated">推定</option><option value="unverified">未確認</option></select></label>
    <label class="field"><span class="lbl">証拠（実測の場合は必須: URLや記録）</span><input type="text" id="lSource" placeholder="https://..."></label>
    <button class="btn primary block" data-act="ledger">記録する</button>
    <div class="hint">実測として記録するには証拠が必要です。推定は実績に算入されません。</div>
  </div>

  <h2>収支サマリ</h2>
  <div class="grid2">
    <div class="stat"><div class="k">実測収益</div><div class="v">${fmtNum(led.summary?.revenue?.measured)}</div></div>
    <div class="stat"><div class="k">推定収益</div><div class="v">${fmtNum(led.summary?.revenue?.total_estimated)}</div></div>
    <div class="stat"><div class="k">実測費用</div><div class="v">${fmtNum(led.summary?.cost?.measured)}</div></div>
    <div class="stat"><div class="k">実測純利益</div><div class="v">${fmtNum(led.summary?.net_profit_measured)}</div></div>
  </div>
  <h2>収支明細</h2>
  <div class="scroll-x"><table class="tbl">
    <thead><tr><th>日付</th><th>種別</th><th>金額</th><th>区分</th><th>出典</th></tr></thead>
    <tbody>${(led.entries || []).slice(0, 40).map((e) => `<tr>
      <td>${esc(e.occurred_on)}</td><td>${e.kind === 'cost' ? '費用' : '収益'}</td>
      <td class="right">${fmtNum(e.amount)}</td>
      <td><span class="badge ${BASIS_CLASS[e.basis] || 'ghost'}">${BASIS_LABEL[e.basis] || e.basis}</span></td>
      <td class="mono" style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(e.source || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">記録なし</td></tr>'}</tbody>
  </table></div>

  <h2>実行ログ</h2>
  <div class="timeline">
    ${(d.runs || []).map((r) => `<div class="tl-item">
      <span class="badge ${STATE_CLASS[r.state] || 'ghost'}">${STATE_LABEL[r.state] || r.state}</span>
      <span class="muted">${fmtDate(r.created_at)}</span>
      <div>${esc(r.summary || '')}</div>
    </div>`).join('') || empty('file', 'ログはありません')}
  </div>

  <h2>AI呼び出し履歴</h2>
  <div class="scroll-x"><table class="tbl">
    <thead><tr><th>時刻</th><th>provider</th><th>役割</th><th>結果</th><th>ms</th></tr></thead>
    <tbody>${(d.ai_usage || []).slice(0, 30).map((a) => `<tr>
      <td>${fmtDate(a.created_at)}</td><td>${esc(a.provider)}</td><td>${esc(a.role || '')}</td>
      <td>${a.ok ? '<span class="badge ok">ok</span>' : `<span class="badge danger">${a.status_code || 'err'}</span>`}</td>
      <td class="right">${a.latency_ms ?? '—'}</td></tr>`).join('')}</tbody>
  </table></div>
  `;
};

screens.character = async () => {
  const d = await api('/api/character');
  const c = d.character || {};
  return `
  ${head('CHARACTER', 'キャラクター設定')}
  <div class="notice">ここで設定した人格は、計画・優先順位・タスク選択・報告方法に実際に反映されます（口調だけの飾りではありません）。</div>

  <div class="card">
    <div class="card-head">
      <div class="card-title">アイコン</div>
      <span class="badge ${c.avatar_url ? 'accent' : 'ghost'}">${c.avatar_url ? (c.avatar_source === 'generated' ? '生成AI' : 'アップロード') : 'モノグラム'}</span>
    </div>
    <div class="avatar-editor">
      <div class="ava-lg">${mark(c)}</div>
      <div class="ava-col">
        <div class="btn-row">
          <button class="btn sm" data-act="avatar-upload">${icon('upload')} 画像を選ぶ</button>
          <button class="btn sm" data-act="avatar-clear"${c.avatar_url ? '' : ' disabled'}>${icon('refresh')} 既定に戻す</button>
        </div>
        <input type="file" id="cAvaFile" accept="image/*" hidden>
        <div class="ava-meta">写真でもスクリーンショットでも、選んだ時点で256pxに縮小して保存します（元画像は送信しません）。</div>
      </div>
    </div>
    <label class="field" style="margin-top:12px"><span class="lbl">指示文で生成</span>
      <textarea id="cAvaPrompt" style="min-height:64px" placeholder="例: 落ち着いた雰囲気の女性アドバイザー。ネイビー基調で知的、正面のバストアップ。">${esc(c.avatar_prompt || '')}</textarea></label>
    <div class="chips">${(d.avatar?.styles || []).map((s) => `<button class="chip" data-ava-style="${esc(s.key)}" aria-pressed="${(state.avatarStyle || 'flat') === s.key}">${esc(s.label)}</button>`).join('')}</div>
    <button class="btn primary block" data-act="avatar-gen">${icon('sparkle')} この指示文でアイコンを生成</button>
    <div class="ava-meta">
      生成エンジン: ${(d.avatar?.engines || []).map((e) => `${esc(e.label)}${e.available ? '（利用可）' : '（未設定）'}`).join(' / ') || 'ローカル生成（AI不使用）'}
      <br>${c.avatar_url
        ? `現在のアイコン: ${c.avatar_source === 'generated' ? '生成AI' : 'アップロード'}${c.avatar_model ? ` / ${esc(c.avatar_model)}` : ''}${c.avatar_updated_at ? ` / ${fmtDate(c.avatar_updated_at)}` : ''}`
        : '画像が未設定のため、名前のモノグラムを表示しています。'}
      <br>生成した画像はそのまま保存され、ヘッダーとホームのアイコンにも即反映されます。気に入らなければ再生成するか「既定に戻す」で戻せます。
    </div>
  </div>

  <div class="card">
    <div class="row wrap" style="margin-bottom:10px">
      ${(d.presets || []).map((p) => `<button class="btn sm ${c.preset === p.key ? 'primary' : ''}" data-preset="${esc(p.key)}">${esc(p.label)}</button>`).join('')}
    </div>
    <div class="grid2">
      <label class="field"><span class="lbl">名前</span><input type="text" id="cName" value="${esc(c.name || '')}"></label>
      <label class="field"><span class="lbl">モノグラム（画像未設定時の表示）</span><input type="text" id="cAvatar" value="${esc(c.avatar || '')}" placeholder="例: AT"></label>
    </div>
    <label class="field"><span class="lbl">説明</span><textarea id="cDesc" style="min-height:70px">${esc(c.description || '')}</textarea></label>
    <label class="field"><span class="lbl">性格</span><input type="text" id="cPersonality" value="${esc(c.personality || '')}"></label>
    <label class="field"><span class="lbl">口調</span><input type="text" id="cTone" value="${esc(c.tone || '')}"></label>
    <label class="field"><span class="lbl">価値観（カンマ区切り）</span><input type="text" id="cValues" value="${esc((c.values || []).join(', '))}"></label>
    <div class="grid2">
      <label class="field"><span class="lbl">得意分野</span><input type="text" id="cStrengths" value="${esc(c.strengths || '')}"></label>
      <label class="field"><span class="lbl">苦手分野</span><input type="text" id="cWeaknesses" value="${esc(c.weaknesses || '')}"></label>
    </div>
    ${slider('cCreativity', '創造性', c.creativity ?? 60)}
    ${slider('cCaution', '慎重さ', c.caution ?? 60)}
    ${slider('cRisk', 'リスク許容度', c.risk_tolerance ?? 30)}
    <label class="field"><span class="lbl">報告頻度</span><select id="cReport">
      ${['realtime', 'hourly', 'daily', 'weekly', 'milestones'].map((r) => `<option value="${r}" ${c.report_frequency === r ? 'selected' : ''}>${r}</option>`).join('')}
    </select></label>
    <label class="field"><span class="lbl">自律性レベル</span><select id="cAutonomy">
      ${[1, 2, 3, 4, 5].map((l) => `<option value="${l}" ${(c.autonomy_level ?? 4) === l ? 'selected' : ''}>L${l} ${['提案中心', '計画と調査を自動化', '安全タスクを自動実行', '実行・テスト・改善を自動反復', '複数ミッション並行管理'][l - 1]}</option>`).join('')}
    </select></label>
    <div class="hint">L5でも、資金移動・実売買・課金・アカウント登録・外部公開・破壊的操作は自動で許可されません。</div>
    <label class="field"><span class="lbl">長期目標</span><textarea id="cGoals" style="min-height:70px">${esc(c.long_term_goals || '')}</textarea></label>
    <label class="field"><span class="lbl">禁止事項</span><textarea id="cProhibitions" style="min-height:70px">${esc(c.prohibitions || '')}</textarea></label>
    <button class="btn primary block" data-act="save-character">保存する</button>
  </div>
  ${c.weights ? `<div class="card"><div class="card-title">現在の優先度の重み（人格から算出）</div>
    <div class="row wrap" style="margin-top:6px">${Object.entries(c.weights).map(([k, v]) => `<span class="badge accent">${esc(k)} ${v}</span>`).join('')}</div>
    <div class="muted" style="margin-top:6px">この重みがタスク選択スコアと機会ランキングに使われます。</div></div>` : ''}
  `;
};

function slider(id, label, value) {
  return `<label class="field"><span class="lbl">${label}: <b id="${id}Val">${value}</b></span>
    <input type="range" id="${id}" min="0" max="100" value="${value}" oninput="document.getElementById('${id}Val').textContent=this.value"></label>`;
}

screens.settings = async () => {
  const p = await api('/api/providers');
  const s = await api('/api/settings');
  return `
  ${head('SETTINGS', '設定とAIプロバイダー')}
  <div class="notice ok">APIキーはサーバー側のシークレット（<code>.dev.vars</code> / <code>wrangler secret</code>）としてのみ保存され、ブラウザーには一切送信されません。ここでは「設定済みかどうか」だけを表示します。</div>

  <h2>無料APIキーの取得（3分）</h2>
  <div class="notice">下の「キーを取得」から各社で無料キーを発行し、ターミナルで <code>node scripts/set-keys.mjs</code> を実行して貼り付けてください。<b>1社だけでも動きますが、複数社を設定すると独立した無料枠が合算され、自動で振り分けられます。</b></div>
  ${(p.configured || []).map((c) => `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(c.label)}</div>
          <div class="card-sub">${esc(c.free_note || '')}</div>
        </div>
        <span class="badge ${c.key_present ? 'ok' : 'ghost'}">${c.key_present ? (c.keys_supplied > 1 ? `設定済 ×${c.keys_supplied}` : '設定済') : (c.keyless ? 'デプロイ後に有効' : '未設定')}</span>
      </div>
      <div class="kv"><span class="k">環境変数</span><span class="v"><code>${esc(c.key_env)}</code></span></div>
      <div class="btn-row" style="margin-top:10px">
        ${c.signup ? `<a class="btn" href="${esc(c.signup)}" target="_blank" rel="noopener">キーを取得 ${icon('external')}</a>` : ''}
      </div>
    </div>`).join('')}
  <div class="notice">${esc(p.free_capacity_note || '')}</div>
  <div class="card">
    <h3 style="margin-top:0">認証トークン（任意）</h3>
    <label class="field"><span class="lbl">OWNER_TOKEN</span><input type="password" id="sToken" placeholder="サーバーで設定したトークン" value="${esc(state.token)}"></label>
    <button class="btn block" data-act="save-token">この端末に保存</button>
    <div class="hint">サーバー側で OWNER_TOKEN が未設定の場合、認証は不要（開発モード）です。</div>
  </div>
  <div class="card">
    <h3 style="margin-top:0">AIプロバイダー</h3>
    ${(p.configured || []).map((x) => `
      <div class="kv"><span class="k">${esc(x.label)}<br><span class="muted mono">${esc(x.key_env)}</span></span>
      <span class="v">${x.key_present ? `<span class="badge ${x.state === 'ok' ? 'ok' : x.state === 'rate_limited' ? 'warn' : 'ghost'}">${esc(x.state)}</span>` : '<span class="badge ghost">未設定</span>'}</span></div>
      <div class="muted mono">${x.models.map(esc).join(', ')}</div>`).join('')}
    <div class="kv"><span class="k">決定的フォールバック</span><span class="v"><span class="badge ok">常時利用可</span></span></div>
    <div class="muted" style="margin-top:6px">${esc(p.fallback_note || '')}</div>
  </div>
  <div class="card">
    <h3 style="margin-top:0">環境設定</h3>
    ${Object.entries(s.env || {}).filter(([k]) => k !== 'secrets_present').map(([k, v]) => `
      <div class="kv"><span class="k mono">${esc(k)}</span><span class="v">${esc(v ?? '—')}</span></div>`).join('')}
    <div class="kv"><span class="k">シークレット設定状況</span><span class="v">${Object.entries(s.env?.secrets_present || {}).map(([k, v]) => `<span class="badge ${v ? 'ok' : 'ghost'}">${esc(k)}</span>`).join(' ')}</span></div>
  </div>
  <div class="card">
    <h3 style="margin-top:0">セキュリティポリシー</h3>
    <div class="muted">${esc(s.secrets_policy || '')}</div>
    <div class="row wrap" style="margin-top:8px">
      ${['実口座売買', '資金移動', '課金', 'アカウント登録', '外部公開', 'データ削除', '不可逆操作', '個人情報送信'].map((x) => `<span class="badge warn">${x}: 要承認</span>`).join('')}
    </div>
  </div>
  <div class="card">
    <h3 style="margin-top:0">メンテナンス</h3>
    <div class="btn-row">
      <button class="btn sm" data-act="migrate">スキーマ適用</button>
      <button class="btn sm" data-act="seed">初期データ投入</button>
      <button class="btn sm" data-act="scheduler-tick">スケジューラ1回実行</button>
    </div>
  </div>
  `;
};

screens.approvals = async () => {
  const d = await api('/api/approvals');
  return `
  ${head('APPROVALS', '承認待ちの操作')}
  <div class="card">
    <div class="card-title">自動実行できるもの</div>
    <div class="row wrap" style="margin-top:6px">${(d.policy?.autonomous || []).map((x) => `<span class="badge ok">${esc(x)}</span>`).join('')}</div>
    <div class="card-title" style="margin-top:10px">人間の承認が必要なもの</div>
    <div class="row wrap" style="margin-top:6px">${(d.policy?.approval_required || []).map((x) => `<span class="badge warn">${esc(x)}</span>`).join('')}</div>
  </div>
  ${(d.approvals || []).map((a) => approvalCard(a)).join('') || empty('shield', '承認待ちはありません', '危険な操作は自動実行されません')}
  `;
};

screens.chat = async () => {
  const d = state.dashboard || await api('/api/dashboard');
  return `
  ${head('ASSIST', 'チャット（補助）')}
  <div class="notice">主要な操作は各画面から行えます。このチャットは補助的な相談用です。</div>
  <div class="chat-log" id="chatLog">
    ${state.chat.map((m) => `<div class="msg ${m.role === 'me' ? 'me' : 'agent'}">${esc(m.text)}</div>`).join('') || `<div class="msg agent">${esc(d?.character?.name || 'エージェント')}です。ミッションや次の一手について聞いてください。</div>`}
  </div>
  <div class="composer">
    <input type="text" id="chatInput" placeholder="例: 今の進捗と次の一手は？" />
    <button class="btn primary" data-act="chat-send">送信</button>
  </div>
  `;
};

// ---------------------------------------------------------------------------
// Detail views
// ---------------------------------------------------------------------------
async function taskDetail(id) {
  const d = await api(`/api/tasks/${id}`);
  if (!d?.task) return;
  const t = d.task;
  openSheet(`
    <h2 style="margin-top:0">${esc(t.title)}</h2>
    <div class="row wrap"><span class="badge ${STATE_CLASS[t.state] || 'ghost'}">${STATE_LABEL[t.state] || t.state}</span>
      <span class="badge ghost">${esc(t.category || '')}</span><span class="badge ghost">試行 ${t.attempt}/${t.max_attempts}</span></div>
    <div class="muted" style="margin-top:8px">${esc(t.description || '')}</div>
    <div class="kv"><span class="k">ツール</span><span class="v">${esc(t.tool_name || '未定')}</span></div>
    <div class="kv"><span class="k">引数</span><span class="v mono" style="max-width:60%;word-break:break-all">${esc(JSON.stringify(t.tool_args || {}))}</span></div>
    <div class="kv"><span class="k">次のアクション</span><span class="v">${esc(t.next_action || '—')}</span></div>
    <div class="kv"><span class="k">戦略</span><span class="v">${esc(t.strategy || '—')} / 切替 ${t.strategy_switches || 0}回</span></div>
    <h3>エラー履歴</h3>
    ${(t.error_history || []).map((e) => `<div class="item"><div class="s">${fmtDate(e.at)} · ${esc(e.tool || '')} · 試行${e.attempt}</div>
      <div>${esc(e.error)}</div><div class="muted">診断: ${esc(e.diagnosis || '—')}</div></div>`).join('') || '<div class="muted">なし</div>'}
    <h3>実行ログ</h3>
    <div class="timeline">${(d.runs || []).map((r) => `<div class="tl-item"><b>${esc(STATE_LABEL[r.state] || r.state)}</b> <span class="muted">${fmtDate(r.created_at)}</span><div>${esc(r.summary || '')}</div></div>`).join('') || '<div class="muted">なし</div>'}</div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" data-task-action="${esc(t.id)}" data-action="retry">再試行</button>
      <button class="btn" data-task-action="${esc(t.id)}" data-action="prioritize">優先度+20</button>
      <button class="btn danger" data-task-action="${esc(t.id)}" data-action="cancel">中止</button>
    </div>
  `);
}

async function fxStrategyDetail(id) {
  const d = await api(`/api/fx/strategy/${id}`);
  if (!d?.strategy) return;
  const s = d.strategy;
  openSheet(`
    <h2 style="margin-top:0">${esc(s.name)} v${s.version}</h2>
    <div class="row wrap"><span class="badge ${s.non_repaint ? 'ok' : 'danger'}">${s.non_repaint ? '非リペイント合格' : '違反あり'}</span>
      <span class="badge ghost">${esc(s.symbol)}</span><span class="badge ghost">Pine ${esc(s.pine_version)}</span></div>
    <div class="muted" style="margin-top:8px;white-space:pre-wrap">${esc(s.hypothesis || '')}</div>
    <h3>パラメータ</h3><div class="code-block mono">${esc(JSON.stringify(s.params, null, 2))}</div>
    <h3>非リペイント検査</h3>
    ${(s.lint?.violations || []).map((v) => `<div class="item"><span class="badge ${v.severity === 'error' ? 'danger' : v.severity === 'warn' ? 'warn' : 'ghost'}">${esc(v.severity)}</span> ${esc(v.message)}</div>`).join('') || '<div class="notice ok">指摘なし</div>'}
    <h3>Pine Script</h3><div class="code-block">${esc(s.pine_code)}</div>
    <h3>バックテスト</h3>
    ${(d.backtests || []).map((b) => `<div class="item"><div class="spread"><span class="t">${esc(b.date_from)} → ${esc(b.date_to)}</span>
      <span class="badge ${b.pass ? 'ok' : 'danger'}">${b.pass ? 'PASS' : 'FAIL'}</span></div>
      <div class="s mono">PF ${b.metrics?.profitFactor ?? '—'} / 勝率 ${b.metrics?.winRate ?? '—'}% / DD ${b.metrics?.maxDrawdownPct ?? '—'}%</div>
      <div class="s">ウォークフォワード: ${b.walkforward?.netPositiveFolds ?? '—'}/${b.walkforward?.totalFolds ?? '—'} フォルダでプラス</div>
      <div class="s">過剰最適化: ${esc(b.overfit?.verdict || '—')}（劣化 ${b.overfit?.degradationPct ?? '—'}%）</div></div>`).join('') || '<div class="muted">未実施</div>'}
  `);
}

async function missionDetail(id) {
  const d = await api(`/api/missions/${id}`);
  if (!d?.mission) return;
  openSheet(`
    <h2 style="margin-top:0">${esc(d.mission.title)}</h2>
    <div class="muted">${esc(d.mission.goal)}</div>
    <div class="kv"><span class="k">目標</span><span class="v">${fmtNum(d.mission.target_value)} ${esc(d.mission.metric_unit)}</span></div>
    <div class="kv"><span class="k">実測収益</span><span class="v">${fmtNum(d.verification?.measured_revenue)}</span></div>
    <div class="kv"><span class="k">推定収益（不算入）</span><span class="v">${fmtNum(d.verification?.estimated_revenue)}</span></div>
    <div class="muted">${esc(d.verification?.statement || '')}</div>
    <h3>タスク (${d.tasks.length})</h3>
    ${d.tasks.map(taskCard).join('')}
    <h3>実行ログ</h3>
    <div class="timeline">${(d.runs || []).map((r) => `<div class="tl-item"><b>${esc(STATE_LABEL[r.state] || r.state)}</b> <span class="muted">${fmtDate(r.created_at)}</span><div>${esc(r.summary || '')}</div></div>`).join('')}</div>
  `);
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------
function openSheet(html) {
  let el = $('#sheet');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sheet';
    el.className = 'sheet';
    document.body.appendChild(el);
    el.innerHTML = `<div class="sheet-inner"><button class="sheet-close icon-btn" aria-label="閉じる">${icon('stop')}</button><div class="sheet-body"></div></div>`;
    el.addEventListener('click', (e) => { if (e.target === el || e.target.classList.contains('sheet-close')) closeSheet(); });
  }
  $('.sheet-body', el).innerHTML = html;
  el.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  const el = $('#sheet');
  if (el) { el.classList.remove('open'); document.body.style.overflow = ''; }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function render() {
  const route = state.route;
  renderNav();
  const view = $('#view');
  view.innerHTML = loading();
  try {
    const fn = screens[route] || screens.home;
    view.innerHTML = await fn();
    view.scrollTop = 0;
    window.scrollTo(0, 0);
    bind(view);
  } catch (e) {
    view.innerHTML = `<div class="notice danger">画面の描画に失敗しました: ${esc(e.message)}</div>`;
  }
  if (state.dashboard) renderHeader();
}

function navigate() {
  state.route = location.hash.replace(/^#\/?/, '') || 'home';
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
  render();
}

function bind(root) {
  $$('[data-act]', root).forEach((b) => b.addEventListener('click', () => handleAction(b.dataset.act, root)));
  $$('[data-task]', root).forEach((c) => c.addEventListener('click', () => taskDetail(c.dataset.task)));
  $$('[data-mission]', root).forEach((c) => c.addEventListener('click', () => missionDetail(c.dataset.mission)));
  $$('[data-fx-strategy]', root).forEach((c) => c.addEventListener('click', () => fxStrategyDetail(c.dataset.fxStrategy)));
  $$('[data-go]', root).forEach((c) => c.addEventListener('click', () => { location.hash = `#/${c.dataset.go}`; }));
  // Style chips only toggle state — a full re-render would wipe the instruction
  // the owner is still typing into the textarea.
  $$('[data-ava-style]', root).forEach((b) => b.addEventListener('click', () => {
    state.avatarStyle = b.dataset.avaStyle;
    $$('[data-ava-style]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-task-action],[data-mission],[data-fx-strategy],[data-reject-opp],[data-funnel],[data-approve],[data-reject],[data-run-workflow],[data-del-doc],[data-replan],[data-mstatus],[data-preset]');
  if (!el) return;
  const d = el.dataset;
  try {
    if (d.taskAction) { await api(`/api/tasks/${d.taskAction}/action`, { method: 'POST', body: { action: d.action } }); toast('操作を反映しました'); taskDetail(d.taskAction); }
    else if (d.rejectOpp) {
      const reason = prompt(`${d.name} を却下する理由（記録され、次回の計画で再提案されません）`, '収益性・確実性が不足');
      if (reason !== null) { await api(`/api/opportunities/${d.rejectOpp}/reject`, { method: 'POST', body: { reason } }); toast('却下を記録しました'); render(); }
    }
    else if (d.funnel) {
      const raw = prompt('計測値を JSON で入力（例: {"visits":120,"signups":4,"sales":0,"revenue_measured":0}）', '{"visits":0,"signups":0,"clicks":0,"conversions":0,"sales":0,"revenue_measured":0}');
      if (raw) {
        let metrics; try { metrics = JSON.parse(raw); } catch { toast('JSONが不正です'); return; }
        const source = prompt('証拠（売上がある場合のみ必須。URLや記録名）', '') || null;
        const r = await api(`/api/opportunities/${d.funnel}/funnel`, { method: 'POST', body: { metrics, source } });
        toast(r?.note || '計測値を記録しました');
      }
    }
    else if (d.approve || d.reject) {
      const id = d.approve || d.reject;
      await api(`/api/approvals/${id}/decide`, { method: 'POST', body: { decision: d.approve ? 'approved' : 'rejected' } });
      toast(d.approve ? '承認しました' : '却下しました');
      render();
    }
    else if (d.runWorkflow) {
      toast('実行中…');
      const r = await api(`/api/workflows/${d.runWorkflow}/run`, { method: 'POST', body: {} });
      toast(`ワークフロー: ${r.status}（${r.steps} ステップ）`);
      render();
    }
    else if (d.delDoc) { await api('/api/knowledge/delete', { method: 'POST', body: { doc_id: d.delDoc } }); toast('削除しました'); render(); }
    else if (d.replan) { const r = await api(`/api/missions/${d.replan}/replan`, { method: 'POST', body: {} }); toast(`再計画: ${r.created?.length || 0} 件のタスクを追加`); render(); }
    else if (d.mstatus) { await api(`/api/missions/${d.mstatus}/status`, { method: 'POST', body: { status: d.status } }); toast('更新しました'); render(); }
    else if (d.preset) { await applyPreset(d.preset); }
  } catch (err) { toast(`失敗: ${err.message}`); }
});

async function applyPreset(key) {
  const d = await api('/api/character');
  const p = (d.presets || []).find((x) => x.key === key);
  if (!p) return;
  await api('/api/character', { method: 'POST', body: { character: { preset: key, name: (d.character?.name) || p.label, avatar: d.character?.avatar || '', ...p, autonomy_level: d.character?.autonomy_level ?? 4, long_term_goals: d.character?.long_term_goals, prohibitions: d.character?.prohibitions || p.prohibitions } } });
  toast(`プリセット「${p.label}」を適用しました`);
  render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function handleAction(act, root) {
  if (state.busy) return;
  const guard = async (fn) => { state.busy = true; try { await fn(); } finally { state.busy = false; } };
  const val = (id) => ($(id)?.value ?? '').trim();

  switch (act) {
    case 'start': case 'pause': case 'resume': case 'stop':
      await guard(async () => { const r = await api(`/api/engine/${act}`, { method: 'POST', body: {} }); toast(`エンジン: ${r.status}`); render(); });
      break;
    case 'tick':
      await guard(async () => {
        toast('自律サイクルを実行中…', 8000);
        const r = await api('/api/engine/tick', { method: 'POST', body: { steps: 3 } });
        const m = r.missions?.[0];
        toast(r.ran ? `実行: ${m?.status || 'ok'}（${m?.steps || 0}ステップ）${m?.note ? ' / ' + m.note : ''}` : (r.note || r.reason), 4200);
        render();
      });
      break;
    case 'create-mission':
      await guard(async () => {
        const goal = val('#mGoal');
        if (!goal) return toast('目標を入力してください');
        const r = await api('/api/missions', { method: 'POST', body: { goal, title: goal.slice(0, 40), target_value: Number(val('#mTarget')) || null, metric_unit: val('#mUnit') || 'JPY', constraints: val('#mConstraints'), success_metric: val('#mMetric') } });
        toast(`ミッション作成: ${r.tasks?.length || 0} タスクに自動分解`);
        location.hash = '#/tasks'; render();
      });
      break;
    case 'save-character':
      await guard(async () => {
        const body = {
          character: {
            id: state.dashboard?.character?.id,
            preset: state.dashboard?.character?.preset || 'custom',
            name: val('#cName') || 'エージェント', avatar: val('#cAvatar') || '',
            description: val('#cDesc'), personality: val('#cPersonality'), tone: val('#cTone'),
            values: val('#cValues').split(',').map((s) => s.trim()).filter(Boolean),
            strengths: val('#cStrengths'), weaknesses: val('#cWeaknesses'),
            creativity: Number(val('#cCreativity')), caution: Number(val('#cCaution')), risk_tolerance: Number(val('#cRisk')),
            report_frequency: val('#cReport'), autonomy_level: Number(val('#cAutonomy')),
            long_term_goals: val('#cGoals'), prohibitions: val('#cProhibitions'),
          },
        };
        const r = await api('/api/character', { method: 'POST', body });
        toast(r.ok ? 'キャラクターを保存しました' : '保存に失敗しました');
        render();
      });
      break;
    case 'research-opp':
      await guard(async () => {
        toast('調査中…（検索と出典確認）', 12000);
        const r = await api('/api/opportunities/research', { method: 'POST', body: { domain: val('#oDomain'), topic: val('#oTopic') } });
        toast(`候補 ${r.candidates?.length || 0} 件を登録（出典 ${r.searched || 0} 件）`);
        render();
      });
      break;
    case 'research-rewards':
      await guard(async () => {
        toast('ポイ活候補を調査中…', 12000);
        const r = await api('/api/opportunities/research', { method: 'POST', body: { domain: 'rewards', topic: val('#rTopic') } });
        toast(`候補 ${r.candidates?.length || 0} 件`);
        render();
      });
      break;
    case 'research-sidehustle':
      await guard(async () => {
        toast('副業候補を調査中…', 12000);
        const r = await api('/api/opportunities/research', { method: 'POST', body: { domain: 'side_hustle', topic: val('#sTopic') } });
        toast(`候補 ${r.candidates?.length || 0} 件`);
        render();
      });
      break;
    case 'rank': await guard(async () => { const r = await api('/api/opportunities/rank', { method: 'POST', body: {} }); toast(`${r.ranking.total} 件を再評価`); render(); }); break;
    case 'recalibrate': await guard(async () => { const r = await api('/api/opportunities/rank', { method: 'POST', body: {} }); toast(r.ranking?.allocation?.length ? '再評価しました' : '候補がありません'); render(); }); break;
    case 'fx-data':
      await guard(async () => {
        const r = await api('/api/fx/market-data', { method: 'POST', body: { symbol: val('#fxSymbol'), days: Number(val('#fxDays')) || 1500 } });
        $('#fxResult').innerHTML = r.ok
          ? `<div class="notice ok">${esc(r.symbol)}: ${r.bars} 本 (${esc(r.from)} → ${esc(r.to)}) / 品質: ${esc(r.quality)} / 出典: ${esc(r.source)}</div>`
          : `<div class="notice danger">市場データを取得できませんでした</div>`;
      });
      break;
    case 'fx-gen':
      await guard(async () => {
        toast('仮説を生成中…');
        const r = await api('/api/fx/generate', { method: 'POST', body: { symbol: val('#fxSymbol') } });
        $('#fxResult').innerHTML = `<div class="notice ${r.strategy?.lint?.nonRepaint ? 'ok' : 'warn'}">
          戦略「${esc(r.strategy?.name)}」v${r.strategy?.version} を生成 / 非リペイント検査: ${r.strategy?.lint?.nonRepaint ? '合格' : '違反 ' + (r.strategy?.lint?.violations?.length || 0) + ' 件'}</div>
          <div class="card"><div class="muted">${esc(r.strategy?.hypothesis)}</div></div>`;
        render();
      });
      break;
    case 'fx-bt':
      await guard(async () => {
        toast('バックテスト実行中…（コスト込み・ウォークフォワード・過剰最適化検査）', 25000);
        const r = await api('/api/fx/backtest', { method: 'POST', body: { symbol: val('#fxSymbol'), days: Number(val('#fxDays')) || 1500 } });
        if (!r.ok) { $('#fxResult').innerHTML = `<div class="notice danger">${esc(r.summary || r.error)}</div>`; return; }
        $('#fxResult').innerHTML = `
          <div class="card">
            <div class="card-head"><div class="card-title">${esc(r.strategy.name)} · ${esc(r.symbol)}</div>
              <span class="badge ${r.pass ? 'ok' : 'danger'}">${r.pass ? 'PASS' : 'FAIL'}</span></div>
            <div class="grid3">
              <div class="stat"><div class="k">PF</div><div class="v">${r.metrics.profitFactor ?? '—'}</div></div>
              <div class="stat"><div class="k">勝率</div><div class="v">${r.metrics.winRate}<span class="u">%</span></div></div>
              <div class="stat"><div class="k">期待値</div><div class="v">${r.metrics.expectancy}</div></div>
              <div class="stat"><div class="k">純益</div><div class="v" style="font-size:14px">${fmtNum(r.metrics.netProfitJPY)}</div></div>
              <div class="stat"><div class="k">最大DD</div><div class="v">${r.metrics.maxDrawdownPct}<span class="u">%</span></div></div>
              <div class="stat"><div class="k">取引</div><div class="v">${r.metrics.trades}</div></div>
            </div>
            ${r.reasons?.length ? `<div class="notice warn">不合格理由: ${esc(r.reasons.join(' / '))}</div>` : ''}
            <div class="muted" style="margin-top:8px">${esc(r.metrics.assumptions)}</div>
            <div class="muted">ウォークフォワード: ${r.walkforward.netPositiveFolds}/${r.walkforward.totalFolds} フォルダでプラス</div>
            <div class="muted">過剰最適化: ${esc(r.overfit.verdict)}（OOS劣化 ${r.overfit.degradationPct ?? '—'}%）</div>
            <div class="muted">損失分析の改善仮説: ${esc((r.losers?.hypotheses || []).join(' / '))}</div>
            <div class="notice">${esc(r.disclaimer)}</div>
          </div>`;
        render();
      });
      break;
    case 'fx-improve':
      await guard(async () => {
        toast('改善案を検証中…', 25000);
        const r = await api('/api/fx/improve', { method: 'POST', body: {} });
        $('#fxResult').innerHTML = `<div class="notice ${r.improved ? 'ok' : 'warn'}">${esc(r.summary || r.error || '')}</div>`;
        render();
      });
      break;
    case 'chat-send':
      await guard(async () => {
        const msg = val('#chatInput');
        if (!msg) return;
        state.chat.push({ role: 'me', text: msg });
        screens.chat().then((h) => { $('#view').innerHTML = h; bind($('#view')); });
        const r = await api('/api/chat', { method: 'POST', body: { message: msg } });
        state.chat.push({ role: 'agent', text: r.reply || r.error || '応答なし' });
        const h = await screens.chat();
        $('#view').innerHTML = h; bind($('#view'));
        const log = $('#chatLog'); if (log) log.scrollTop = log.scrollHeight;
      });
      break;
    case 'ledger':
      await guard(async () => {
        const r = await api('/api/ledger', { method: 'POST', body: { kind: val('#lKind'), amount: Number(val('#lAmount')), basis: val('#lBasis'), source: val('#lSource') || null } });
        toast(r.ok ? '記録しました' : (r.note || '記録できませんでした'));
        render();
      });
      break;
    case 'avatar-upload':
      $('#cAvaFile')?.click();
      break;
    case 'avatar-clear':
      await guard(async () => {
        await api('/api/character/avatar/clear', { method: 'POST', body: {} });
        toast('アイコンを既定に戻しました'); render();
      });
      break;
    case 'avatar-gen':
      await guard(async () => {
        const instruction = val('#cAvaPrompt');
        if (!instruction) return toast('指示文を入力してください');
        toast('アイコンを生成中…（最大30秒）', 30000);
        const g = await api('/api/character/avatar/generate', { method: 'POST', body: { instruction, style: state.avatarStyle || 'flat' } });
        if (!g?.ok) return toast(`生成できませんでした: ${g?.hint || g?.error || '不明なエラー'}`, 5200);
        toast('保存中…', 8000);
        const small = await shrinkForAvatar(g.data_url);
        const r = await api('/api/character/avatar', { method: 'POST', body: { data_url: small, source: 'generated', prompt: instruction, model: `${g.engine}/${g.model}` } });
        toast(r?.ok
          ? (g.engine === 'local' ? '設定しました（ローカル生成・AI不使用）' : `設定しました（${g.engine}）`)
          : `保存できませんでした: ${r?.hint || r?.error || ''}`, 4600);
        render();
      });
      break;
    case 'save-token': state.token = val('#sToken'); localStorage.setItem('wa_token', state.token); toast('トークンを保存しました'); break;
    case 'migrate': await guard(async () => { await api('/api/admin/migrate', { method: 'POST', body: {} }); toast('スキーマを適用しました'); }); break;
    case 'seed': await guard(async () => { const r = await api('/api/admin/seed', { method: 'POST', body: {} }); toast('初期データを投入しました'); render(); }); break;
    case 'scheduler-tick': await guard(async () => { const r = await api('/api/scheduler/tick', { method: 'POST', body: {} }); toast(`スケジューラ実行: ${(r.steps || []).map((s) => s.step).join(', ')}`); render(); }); break;
    case 'seed-workflows': await guard(async () => { await api('/api/workflows/seed', { method: 'POST', body: {} }); toast('スターターを追加しました'); render(); }); break;
    case 'save-workflow':
      await guard(async () => {
        let def; try { def = JSON.parse(val('#wfDef')); } catch { return toast('JSONが不正です'); }
        const r = await api('/api/workflows', { method: 'POST', body: { name: val('#wfName') || '無題', definition: def } });
        toast(r.ok ? '保存しました' : '保存に失敗しました'); render();
      });
      break;
    case 'ingest':
      await guard(async () => {
        const text = val('#kText');
        if (!text) return toast('テキストを入力するかファイルを選択してください');
        const r = await api('/api/knowledge/ingest', { method: 'POST', body: { name: val('#kName') || 'document.txt', text } });
        toast(r.ok ? `${r.chunks} チャンクで取り込みました` : '取り込み失敗'); render();
      });
      break;
    case 'kquery':
      await guard(async () => {
        const q = val('#kQ');
        if (!q) return;
        toast('検索中…');
        const r = await api('/api/knowledge/query', { method: 'POST', body: { question: q } });
        $('#kAnswer').innerHTML = `<div class="card"><div class="card-title">回答</div><div style="white-space:pre-wrap">${esc(r.answer?.text || '')}</div>
          ${(r.answer?.citations || []).length ? `<div class="muted">出典: ${r.answer.citations.map(esc).join(', ')}</div>` : ''}
          ${r.answer?.note ? `<div class="muted">${esc(r.answer.note)}</div>` : ''}</div>`;
      });
      break;
    default: break;
  }
}

// --- avatar helpers --------------------------------------------------------
// A 44 px avatar must not cost a megabyte of storage or a slow dashboard load,
// so every picked or generated image is centre-cropped to 256 px before it is
// sent to the server. The local engine returns SVG: it is already ~2 KB, so it
// stays vector rather than being blurred into pixels.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image_decode_failed'));
    im.src = src;
  });
}

async function shrinkForAvatar(src, size = 256) {
  const raw = String(src || '');
  if (/^data:image\/svg\+xml/i.test(raw)) return raw;
  const img = await loadImage(raw);
  const w0 = img.naturalWidth || size;
  const h0 = img.naturalHeight || size;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(size / w0, size / h0);
  const w = w0 * scale; const h = h0 * scale;
  ctx.fillStyle = '#0b0f19';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// File picker for the knowledge base
document.addEventListener('change', async (e) => {
  if (e.target.id === 'kFile' && e.target.files?.[0]) {
    const f = e.target.files[0];
    const text = await f.text();
    $('#kText').value = text.slice(0, 200000);
    $('#kName').value = f.name;
    toast(`${f.name} を読み込みました（${text.length} 文字）`);
  }

  // Avatar upload: read locally, shrink locally, then store. The original file
  // never leaves the device — only the 256 px result is sent.
  if (e.target.id === 'cAvaFile' && e.target.files?.[0]) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!/^image\//.test(f.type || '')) return toast('画像ファイルを選んでください');
    if (f.size > 12 * 1024 * 1024) return toast('画像が大きすぎます（12MBまで）');
    const dataUrl = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => resolve('');
      r.readAsDataURL(f);
    });
    if (!dataUrl) return toast('画像を読み込めませんでした');
    try {
      const small = await shrinkForAvatar(dataUrl);
      const r = await api('/api/character/avatar', { method: 'POST', body: { data_url: small, source: 'upload' } });
      toast(r?.ok ? 'アイコンを設定しました' : `保存できませんでした: ${r?.hint || r?.error || ''}`, 4600);
    } catch {
      toast('この形式は読み込めませんでした（HEIC等）。JPEG / PNG でお試しください', 5200);
    }
    render();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener('hashchange', navigate);
$('#menuBtn').addEventListener('click', () => {
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
});
$('#scrim').addEventListener('click', () => {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
});
$('#chatBtn').addEventListener('click', () => {
  location.hash = '#/chat';
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

if (!location.hash) location.hash = '#/home';
state.route = location.hash.replace(/^#\/?/, '') || 'home';
render();

// Refresh the dashboard periodically while the app is foregrounded.
// The backend keeps working regardless (cron); this only refreshes the view.
setInterval(() => {
  if (document.visibilityState === 'visible' && (state.route === 'home')) render();
}, 45000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });

// ===========================================================================
// Appended module — multi-agent fleet screen + image-generation settings.
// Kept additive on purpose: the base app.js stays untouched and easy to diff.
// ===========================================================================
(() => {
  const at = NAV.findIndex((n) => n.id === 'settings');
  if (at > -1 && !NAV.some((n) => n.id === 'fleet')) NAV.splice(at, 0, { id: 'fleet', label: 'エージェント', ic: 'cpu' });
  const ti = TABS.findIndex((t) => t.id === 'logs');
  if (ti > -1 && !TABS.some((t) => t.id === 'fleet')) TABS.splice(ti, 0, { id: 'fleet', label: 'エージェント', ic: 'cpu' });
})();

const AGENT_STATUS_LABEL = { idle: '待機', running: '稼働中', paused: '一時停止', stopped: '停止' };
const MISSION_STATUS_LABEL = { active: '進行中', paused: '要確認', completed: '達成', cancelled: '中止' };
state.imgStyle = 'flat';

function agentMark(a) {
  const url = /^data:image\//i.test(String(a && a.avatar_url || '')) ? String(a.avatar_url) : null;
  const mono = String((a && (a.avatar || a.name)) || 'A').replace(/\p{Extended_Pictographic}+/gu, '').trim().slice(0, 2);
  return `<span class="agent-ava">${url ? `<img src="${url}" alt="">` : esc(mono || 'A')}</span>`;
}

function agentCard(a, presets) {
  const p = presets.find((x) => x.key === a.preset);
  const running = a.status === 'running';
  const cls = running ? 'ok' : a.status === 'paused' ? 'warn' : 'ghost';
  const missions = a.missions && a.missions.length
    ? a.missions.map((m) => `<div class="s">${esc(m.title)} <span class="badge ghost">${esc(MISSION_STATUS_LABEL[m.status] || m.status)}</span></div>`).join('')
    : '<span class="muted">なし（次サイクルで自動割当）</span>';
  return `
  <div class="card agent-card">
    <div class="card-head">
      <div class="row" style="gap:10px;align-items:center">
        ${agentMark(a)}
        <div>
          <div class="card-title">${esc(a.name)}</div>
          <div class="card-sub">${esc(p ? p.label : a.preset)} · ${esc(a.specialty || '')}</div>
        </div>
      </div>
      <span class="badge ${cls}">${esc(AGENT_STATUS_LABEL[a.status] || a.status)}</span>
    </div>
    <div class="muted" style="margin:6px 0 8px">${esc(a.instructions || '')}</div>
    <div class="kv"><span class="k">担当ミッション</span><span class="v">${missions}</span></div>
    <div class="kv"><span class="k">タスク</span><span class="v">待機 ${a.tasks.queued} / 実行 ${a.tasks.running} / 完了 ${a.tasks.completed}（計 ${a.tasks.total}）</span></div>
    <div class="kv"><span class="k">最終実行</span><span class="v">${fmtDate(a.last_run_at)}${a.last_result ? ` · ${esc(a.last_result)}` : ''}</span></div>
    <div class="kv"><span class="k">1サイクルの上限</span><span class="v">${a.max_steps_per_tick} ステップ / 自立度 L${a.autonomy_level}</span></div>
    <div class="btn-row" style="margin-top:10px">
      ${running
        ? `<button class="btn sm" data-fleet="${esc(a.id)}|pause">一時停止</button>`
        : `<button class="btn sm primary" data-fleet="${esc(a.id)}|start">開始</button>`}
      <button class="btn sm" data-fleet="${esc(a.id)}|tick">1サイクル実行</button>
      <button class="btn sm" data-fleet="${esc(a.id)}|mission">ミッション追加</button>
      <button class="btn sm danger" data-fleet="${esc(a.id)}|remove">解任</button>
    </div>
  </div>`;
}

screens.fleet = async () => {
  const d = await api('/api/fleet');
  if (!d || d.ok === false) return `${head('FLEET', 'エージェント艦隊')}<div class="notice danger">読み込みに失敗しました: ${esc((d && d.error) || '不明')}</div>`;
  const st = d.status || {};
  const agents = d.agents || [];
  const presets = d.presets || [];
  const counts = st.counts || {};
  return `
  ${head('FLEET', 'エージェント艦隊')}
  <div class="notice">複数のエージェントが、それぞれ別のミッションを同時に進めます。「1サイクル実行」で各エージェントが担当ミッションを1〜3ステップ進め、進捗は1ステップごとに保存されます。ブラウザーを閉じても、Cloudflareへデプロイ済みなら15分ごとの自動サイクルが続きます。</div>
  <div class="card">
    <div class="card-head">
      <div><div class="card-title">運用状況</div><div class="card-sub">エンジン本体が停止していると、エージェントも進みません</div></div>
      <span class="badge ${st.master === 'running' ? 'ok' : 'ghost'}">${st.master === 'running' ? 'エンジン稼働中' : 'エンジン停止中'}</span>
    </div>
    <div class="kv"><span class="k">稼働中 / 待機 / 一時停止 / 停止</span><span class="v">${counts.running || 0} / ${counts.idle || 0} / ${counts.paused || 0} / ${counts.stopped || 0}（計 ${counts.total || 0}）</span></div>
    <div class="kv"><span class="k">直近1時間の実行ログ</span><span class="v">${st.runs_last_hour || 0} 件</span></div>
    <div class="kv"><span class="k">同時実行の上限</span><span class="v">1サイクルあたり ${st.concurrency || 3} 体 / 各 ${st.steps_per_agent || 1} ステップ</span></div>
    <div class="muted" style="margin-top:8px">前回のサイクル: ${st.last_run ? `${fmtDate(st.last_run.at)}（${esc(st.last_run.source || '')}）` : '未実行'}</div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" data-fleet="|tick-all">全エージェントを1サイクル実行</button>
      <button class="btn" data-fleet="|start-all">全員を稼働</button>
      <button class="btn" data-fleet="|pause-all">全員を一時停止</button>
      <button class="btn" data-fleet="|supervise">監督を1回実行</button>
      <button class="btn" data-fleet="|bootstrap">おすすめ編成を作成</button>
    </div>
    <div class="hint">「監督を1回実行」は、遊んでいるエージェントに未割当ミッションを割り当て（必要なら1件だけ新規ミッションを作成）します。無限に仕事を作らないための上限つきです。</div>
  </div>

  ${agents.length ? agents.map((a) => agentCard(a, presets)).join('') : empty('cpu', 'エージェントがいません', '「おすすめ編成を作成」で3体（戦略家・調査役・運用役）をまとめて作れます')}

  <div class="card">
    <div class="card-title">エージェントを追加</div>
    <div class="grid2">
      <label class="field"><span class="lbl">名前</span><input type="text" id="fName" placeholder="例: アレス"></label>
      <label class="field"><span class="lbl">役割</span><select id="fPreset">
        ${presets.map((p) => `<option value="${esc(p.key)}">${esc(p.label)} — ${esc(p.specialty)}</option>`).join('')}
      </select></label>
    </div>
    <label class="field"><span class="lbl">専門・担当範囲（任意）</span><input type="text" id="fSpecialty" placeholder="例: 海外クラウドの無料枠の比較"></label>
    <label class="field"><span class="lbl">行動指針（任意・400字まで）</span><textarea id="fInstr" style="min-height:60px" placeholder="例: 一次情報を優先し、未確認は未確認と明示する"></textarea></label>
    <label class="field"><span class="lbl">最初のミッション（任意）</span><input type="text" id="fGoal" placeholder="例: 月3万円の自動収益源を1つ検証して提案する"></label>
    <button class="btn primary block" data-fleet="|add">このエージェントを編成</button>
    <div class="hint">ミッションを書くと、その場で自動分解され、このエージェント専用のタスクになります。</div>
  </div>`;
};

// --- image generation settings card (injected into the Settings screen) -----
const _baseSettings = screens.settings;
screens.settings = async () => {
  const html = await _baseSettings();
  let cfg = null;
  try { cfg = await api('/api/image/settings'); } catch { cfg = null; }
  if (!cfg || cfg.ok === false) return html;
  state.imgStyle = cfg.config.style || 'flat';
  const card = `
  <div class="card img-set">
    <div class="card-head">
      <div><div class="card-title">画像設定（アイコン生成）</div>
      <div class="card-sub">無料枠で動く順に試し、失敗したら自動で次へ切り替えます</div></div>
      <span class="badge ${cfg.availability.local ? 'ok' : 'warn'}">ローカル生成: 常時利用可</span>
    </div>
    ${cfg.options.engines.map((e) => `
      <div class="kv"><span class="k">${esc(e.label)}<br><span class="muted mono">${esc(e.model)}</span></span>
      <span class="v"><label class="row" style="gap:8px;align-items:center"><input type="checkbox" id="img-${esc(e.key)}"${e.enabled ? ' checked' : ''}><span class="badge ${e.available ? 'ok' : 'ghost'}">${e.available ? '利用可' : 'キー未設定'}</span></label></span></div>
      <div class="muted mono">${esc(e.cost)} / ${esc(e.note)}</div>`).join('')}
    <div style="margin-top:10px"><span class="lbl">既定の画風</span>
      <div class="chips">${cfg.options.styles.map((s) => `<button class="chip" data-imgstyle="${esc(s.key)}" aria-pressed="${s.key === cfg.config.style}">${esc(s.label)}</button>`).join('')}</div>
    </div>
    <div class="grid2" style="margin-top:10px">
      <label class="field"><span class="lbl">保存サイズ（px）</span><select id="imgSize">
        ${(cfg.options.sizes || [256]).map((n) => `<option value="${n}"${n === cfg.config.size ? ' selected' : ''}>${n}px</option>`).join('')}
      </select></label>
      <label class="field"><span class="lbl">JPEG品質 ${cfg.config.quality}</span><input type="range" id="imgQuality" min="0.5" max="0.95" step="0.05" value="${cfg.config.quality}"></label>
    </div>
    <label class="field"><span class="lbl">常時付ける指示（任意・200字まで）</span><input type="text" id="imgSuffix" value="${esc(cfg.config.prompt_suffix)}" placeholder="例: 円形に切っても顔が切れない構図"></label>
    <div class="grid2">
      <label class="field"><span class="lbl">Workers AI モデルID</span><input type="text" id="imgWorkersModel" value="${esc(cfg.config.workers_model)}" placeholder="既定: ${esc((cfg.options.engines[0] || {}).model || '')}"></label>
      <label class="field"><span class="lbl">Gemini モデルID</span><input type="text" id="imgGeminiModel" value="${esc(cfg.config.gemini_model)}" placeholder="既定: ${esc((cfg.options.engines[1] || {}).model || '')}"></label>
    </div>
    <div class="btn-row">
      <button class="btn primary" data-imgsave="1">設定を保存</button>
      <button class="btn" data-imgreset="1">既定に戻す</button>
    </div>
    <div class="hint">ここでの設定はサーバー側（settingsテーブル）に保存され、指示文によるアイコン生成にすぐ反映されます。モデルIDは空欄なら上の既定値を使います。</div>
  </div>
  `;
  return html.replace('  <div class="card">\n    <h3 style="margin-top:0">メンテナンス</h3>', `${card}\n  <div class="card">\n    <h3 style="margin-top:0">メンテナンス</h3>`);
};

// --- delegated actions ------------------------------------------------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-fleet],[data-imgsave],[data-imgreset],[data-imgstyle]');
  if (!el) return;
  const d = el.dataset;
  const val = (sel) => (document.querySelector(sel) && document.querySelector(sel).value || '').trim();
  try {
    if (d.imgstyle) {
      state.imgStyle = d.imgstyle;
      document.querySelectorAll('[data-imgstyle]').forEach((x) => x.setAttribute('aria-pressed', String(x === el)));
      return;
    }
    if (d.imgreset) {
      const r = await api('/api/image/settings', { method: 'POST', body: { reset: true } });
      toast(r.ok ? '画像設定を既定に戻しました' : '戻せませんでした');
      render();
      return;
    }
    if (d.imgsave) {
      const body = {
        engines: {
          workersai: !!(document.getElementById('img-workersai') || {}).checked,
          gemini: !!(document.getElementById('img-gemini') || {}).checked,
          local: !!(document.getElementById('img-local') || {}).checked,
        },
        style: state.imgStyle || 'flat',
        size: Number(val('#imgSize')) || 256,
        quality: Number(val('#imgQuality')) || 0.85,
        prompt_suffix: val('#imgSuffix'),
        workers_model: val('#imgWorkersModel'),
        gemini_model: val('#imgGeminiModel'),
      };
      const r = await api('/api/image/settings', { method: 'POST', body });
      toast(r.ok ? `画像設定を保存しました（${Object.entries(body.engines).filter(([, v]) => v).map(([k]) => k).join(' → ') || '全エンジン無効'}）` : `保存できませんでした: ${r.hint || r.error || ''}`, 4200);
      render();
      return;
    }
    if (!d.fleet) return;
    const [aid, action] = String(d.fleet).split('|');
    if (action === 'tick-all') {
      toast('全エージェントを1サイクル実行中…', 9000);
      const r = await api('/api/fleet/tick', { method: 'POST', body: { concurrency: 3, steps: 1 } });
      const n = (r.agents || []).length;
      toast(r.ran ? `${n} 体を進めました` : (r.note || r.reason), 4600);
      render();
      return;
    }
    if (action === 'start-all' || action === 'pause-all') {
      const r = await api('/api/fleet/all', { method: 'POST', body: { action: action === 'pause-all' ? 'pause' : 'start' } });
      toast(r.ok ? (action === 'pause-all' ? '全員を一時停止しました' : '全員を稼働にしました') : '操作できませんでした');
      render();
      return;
    }
    if (action === 'supervise') {
      const r = await api('/api/fleet/supervise', { method: 'POST', body: { spawn: 1 } });
      toast(`割当 ${r.assigned.length} 件${r.spawned ? ` / 新規ミッション ${r.spawned} 件` : ''}`);
      render();
      return;
    }
    if (action === 'bootstrap') {
      const r = await api('/api/fleet/bootstrap', { method: 'POST', body: {} });
      toast(r.created && r.created.length ? `${r.created.length} 体を編成しました` : (r.note || '既に存在します'));
      render();
      return;
    }
    if (action === 'add') {
      const r = await api('/api/fleet/agents', { method: 'POST', body: {
        name: val('#fName'), preset: val('#fPreset') || 'strategist', specialty: val('#fSpecialty'),
        instructions: val('#fInstr'), goal: val('#fGoal'), status: 'running',
      } });
      toast(r.agent ? `${r.agent.name} を編成しました${r.mission ? '（ミッション作成済み）' : ''}` : '編成できませんでした');
      render();
      return;
    }
    if (action === 'start' || action === 'pause' || action === 'tick') {
      const map = { start: 'start', pause: 'pause', tick: 'tick' };
      const r = await api(`/api/fleet/agents/${aid}`, { method: 'POST', body: { action: map[action] } });
      const res = r.tick && (r.tick.missions || [])[0];
      toast(r.ok ? (action === 'tick'
        ? (res ? `${res.status}（${res.steps || 0}ステップ）` : (r.tick && r.tick.reason) || '実行しました')
        : `状態: ${r.status}`) : '操作できませんでした', 4200);
      render();
      return;
    }
    if (action === 'mission') {
      const goal = prompt('このエージェントに追加するミッション（自動でタスクに分解します）', '');
      if (!goal) return;
      const r = await api(`/api/fleet/agents/${aid}`, { method: 'POST', body: { goal } });
      toast(r.mission ? `ミッション「${r.mission.title}」を追加` : '追加できませんでした');
      render();
      return;
    }
    if (action === 'remove') {
      if (!confirm('このエージェントを解任します（担当ミッションは未割当に戻ります）')) return;
      const r = await api(`/api/fleet/agents/${aid}/remove`, { method: 'POST', body: {} });
      toast(r.ok ? `${r.removed} を解任しました` : '解任できませんでした');
      render();
    }
  } catch (err) { toast(`失敗: ${err.message}`); }
});

// While the fleet screen is open, refresh quietly so progress is visible —
// but never yank the screen out from under someone who is typing.
setInterval(() => {
  if (state.route !== 'fleet' || state.busy) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  render();
}, 20000);
