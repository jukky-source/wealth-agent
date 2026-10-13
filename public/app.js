import { icon } from './icons.js';

// Wealth Agent — chat-first front end with a conversation rail.
// Talk to the agent; every thread you have ever had stays on the left, and the
// agent's own work is one tap away. No dashboards, no tab maze.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('ja-JP') : esc(String(v));
};
const fmtTime = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const hhmm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
};
/** ChatGPT-style buckets for the conversation list. */
function bucketOf(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return '以前';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days <= 7) return '過去7日';
  if (days <= 30) return '過去30日';
  return '以前';
}

const LS_TOKEN = 'wa_token';
const DEFAULT_SUGGEST = ['今どうなってる？', '次の一手を進めて', '収益はいくら？', '足あとを見せて'];

{
  const u = new URL(location.href);
  if (u.searchParams.get('token')) {
    localStorage.setItem(LS_TOKEN, u.searchParams.get('token'));
    u.searchParams.delete('token');
    history.replaceState(null, '', u.pathname + u.hash);
  }
}

const state = {
  token: localStorage.getItem(LS_TOKEN) || '',
  threads: [],
  threadsAvailable: true,
  query: '',
  currentId: null,
  messages: [],
  dash: null,
  suggest: DEFAULT_SUGGEST.slice(),
  suggestTouched: false,
  mode: null,
  busy: false,
};

// ------------------------------------------------------------------ helpers

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, { method = 'GET', body = null, quiet = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    if (!quiet) toast('通信できませんでした。電波を確認してください。');
    return null;
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) {
    if (!quiet) push({ role: 'agent', text: 'この端末はまだ本人確認が済んでいません。「⋯」を開いてアクセストークンを貼り付けてください。', action: 'settings' });
    return data;
  }
  if (!res.ok && !quiet) toast((data && data.error) || `エラー (${res.status})`);
  return data;
}

// ------------------------------------------------------------------ rendering

function cardHTML(c) {
  if (!c) return '';
  if (c.type === 'kpi') {
    const head = c.title ? `<div class="card-h">${icon('pulse')}<span>${esc(c.title)}</span></div>` : '';
    return `<div class="card">${head}<div class="kpis${head ? ' with-head' : ''}">${(c.items || []).map((k) => `
      <div class="kpi${k.hl ? ' hl' : ''}">
        <div class="kpi-v">${fmt(k.value)}${k.unit ? `<small>${esc(k.unit)}</small>` : ''}</div>
        <div class="kpi-l">${esc(k.label || '')}</div>
      </div>`).join('')}</div></div>`;
  }
  if (c.type === 'list') {
    return `<div class="card">
      ${c.title ? `<div class="card-h">${icon(c.icon || 'list')}<span>${esc(c.title)}</span></div>` : ''}
      <div class="card-b"><div class="rows">${(c.items || []).map((it) => `
        <div class="row">
          <div class="row-main">
            <div class="row-t">${it.href ? `<a href="${esc(it.href)}" target="_blank" rel="noreferrer">${esc(it.title || '')}</a>` : esc(it.title || '')}</div>
            ${it.sub ? `<div class="row-s">${esc(it.sub)}</div>` : ''}
          </div>
          ${it.act
            ? `<button class="btn sm" type="button" data-do="${esc(it.act)}">${esc(it.act_label || '実行')}</button>`
            : (it.badge ? `<span class="badge ${esc(it.tone || 'ghost')}">${esc(it.badge)}</span>` : '')}
        </div>`).join('')}</div></div>
    </div>`;
  }
  if (c.type === 'trace') {
    return `<div class="card">
      ${c.title ? `<div class="card-h">${icon(c.icon || 'pulse')}<span>${esc(c.title)}</span></div>` : ''}
      <div class="card-b"><div class="trail">${(c.items || []).map((x) => `
        <div class="trail-i ${esc(x.cls || 'ok')}"><div class="trail-t">${esc(x.t || '')}</div><div class="trail-s">${esc(x.s || '')}</div></div>`).join('')}</div></div>
    </div>`;
  }
  if (c.type === 'note') {
    return `<div class="card"><div class="card-h">${icon(c.icon || 'file')}<span>${esc(c.title || '')}</span></div>
      <div class="card-b"><div class="row-t" style="font-size:13px;color:var(--fg-2);-webkit-line-clamp:unset">${esc(c.text || '')}</div></div></div>`;
  }
  return '';
}

function msgHTML(m, index) {
  const mine = m.role === 'me';
  const at = m.created_at || m.at;
  const events = (m.events || []).map((e) => `<div class="ev">${icon(e.tick ? 'check' : 'dot', e.tick ? 'i tick' : 'i')}<span>${esc(e.text || '')}</span></div>`).join('');
  const cards = (m.cards || []).map(cardHTML).join('');
  const memory = (m.memory && m.memory.length)
    ? `<div class="card"><div class="card-h">${icon('book')}<span>覚えていること（過去の会話から）</span></div>
       <div class="card-b"><div class="rows">${m.memory.map((x) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:13px">${esc(x.text)}</div><div class="row-s">${esc(x.kind || '')}</div></div></div>`).join('')}</div></div></div>`
    : '';
  const action = m.action === 'settings'
    ? `<div class="btn-row" style="margin-top:8px"><button class="btn" data-open="settings">設定を開く</button></div>` : '';
  const acts = !mine && !m.pending
    ? `<div class="msg-acts">
         <button class="msg-act" data-copy="${index}">${icon('file', 'i sm')}コピー</button>
         <button class="msg-act" data-remember="index">${icon('branch', 'i sm')}手順として覚える</button>
       </div>` : '';
  return `
    <div class="m ${mine ? 'me' : 'agent'}">
      <div class="bub">${esc(m.text || '')}${events ? `<div class="events">${events}</div>` : ''}</div>
      ${cards}${memory}${action}${acts}
      <span class="t">${mine ? 'あなた' : 'エージェント'} · ${fmtTime(at)}</span>
    </div>`;
}

/** Buttons that live inside cards: resume a stopped task, drop a watch rule. */
async function doAction(spec, btn) {
  const [kind, id] = String(spec || '').split(':');
  if (!id) return;
  btn.disabled = true;
  if (kind === 'resume') {
    const r = await api(`/api/tasks/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action: 'resume' }, quiet: true });
    if (r && r.ok !== false) { toast(`続きから再開しました（前回: ${r.from || '開始地点'}）`); send('足あとを見せて'); }
    else { toast('再開できませんでした'); btn.disabled = false; }
    return;
  }
  if (kind === 'rework') {
    const r = await api(`/api/tasks/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action: 'rework', reason: 'オーナーの指示による作り直し' }, quiet: true });
    if (r && r.ok !== false) { toast(`作り直しに回しました（試行 ${r.attempt} 回目）`); send('足あとを見せて'); }
    else { toast(r?.error === 'approval_required' ? 'お金を動かす操作なので承認に回しました' : '作り直せませんでした'); btn.disabled = false; }
    return;
  }
  if (kind === 'mode') {
    const r = await api('/api/mode', { method: 'POST', body: { action: 'switch', id }, quiet: true });
    if (r && r.ok !== false) {
      state.suggestTouched = false;
      state.mode = { ...r.mode, chips: r.chips };
      toast(`「${r.mode.label}」モードに切り替えました`);
      closeSheet();
      await refresh({ quiet: true });
      renderThread();
    } else { toast('切り替えられませんでした'); btn.disabled = false; }
    return;
  }
  if (kind === 'watch_hold') {
    const r = await api(`/api/watches/${encodeURIComponent(id)}`, { method: 'POST', body: { action: 'hold' }, quiet: true });
    if (r && r.ok !== false) { toast('達成するまで続ける完了条件にしました'); closeSheet(); await refresh({ quiet: true }); }
    else btn.disabled = false;
    return;
  }
  if (kind === 'watch_off') {
    await api(`/api/watches/${encodeURIComponent(id)}`, { method: 'POST', body: { action: 'delete' }, quiet: true });
    toast('見張りを解除しました');
    renderFoot();
    return;
  }
  btn.disabled = false;
}

function threadEl() { return $('#thread'); }

function scrollDown(smooth = true) {
  const el = threadEl();
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function bindMsg(root) {
  $$('[data-open]', root).forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));
  $$('[data-copy]', root).forEach((b) => b.addEventListener('click', async () => {
    const m = state.messages[Number(b.dataset.copy)];
    try { await navigator.clipboard.writeText(m?.text || ''); toast('コピーしました'); } catch { toast('コピーできませんでした'); }
  }));
  $$('[data-remember]', root).forEach((b) => b.addEventListener('click', () => send('この手順を覚えて')));
  $$('[data-do]', root).forEach((b) => b.addEventListener('click', () => doAction(b.dataset.do, b)));
}

function renderThread() {
  const el = threadEl();
  if (!state.messages.length) {
    const name = state.dash?.character?.name || 'Wealth Agent';
    const m = state.mode;
    el.innerHTML = `
      <div class="m agent"><div class="bub">${esc(`はじめまして、${name} です。\n\n目標を教えてもらえれば、計画を立てて調査・実行・検証まで自分で進めます。むずかしい設定は要りません — 話しかけるだけで動きます。${m ? `\n\nいまは「${m.label}」モードです（${m.blurb || ''}）。用途は「調べるモードにして」のように言えば切り替わります。` : ''}`)}</div>
      <span class="t">エージェント</span></div>`;
    return;
  }
  el.innerHTML = state.messages.map(msgHTML).join('');
  bindMsg(el);
}

function addMessage(m) {
  state.messages.push(m);
  const el = threadEl();
  if (state.messages.length === 1) { renderThread(); return; }
  const holder = document.createElement('div');
  holder.innerHTML = msgHTML(m, state.messages.length - 1);
  const node = holder.firstElementChild;
  el.appendChild(node);
  bindMsg(node);
  scrollDown();
}

function push(m) { addMessage({ at: Date.now(), ...m }); }

function thinking(on) {
  let el = $('#thinking');
  if (on) {
    if (el) return;
    el = document.createElement('div');
    el.id = 'thinking';
    el.className = 'm agent typing';
    el.innerHTML = '<div class="bub"><span class="dots"><i></i><i></i><i></i></span></div>';
    threadEl().appendChild(el);
    scrollDown();
  } else if (el) el.remove();
}

function renderChips() {
  const el = $('#chips');
  el.innerHTML = state.suggest.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
  $$('.chip', el).forEach((b) => b.addEventListener('click', () => send(b.textContent)));
}

// ------------------------------------------------------------------ rail

function renderRail() {
  const list = $('#railList');
  const q = state.query.trim().toLowerCase();
  const rows = state.threads.filter((t) => !q || String(t.title || '').toLowerCase().includes(q));
  if (!rows.length) {
    list.innerHTML = `<div class="rail-empty">${state.threadsAvailable
      ? 'まだ会話はありません。下の入力欄から話しかけると、ここに並びます。'
      : '会話の保存はサーバー更新後に有効になります。いまはこの端末の中だけで会話します。'}</div>`;
  } else {
    let html = '';
    let last = '';
    for (const t of rows) {
      const b = t.pinned ? 'ピン留め' : bucketOf(t.updated_at);
      if (b !== last) { html += `<div class="rail-sec">${esc(b)}</div>`; last = b; }
      const preview = String(t.preview || '').replace(/\s+/g, ' ').slice(0, 46);
      html += `
        <div class="thr ${t.id === state.currentId ? 'active' : ''}" data-thr="${esc(t.id)}" role="button" tabindex="0">
          <div class="thr-t">
            <div class="thr-n">${esc(t.title || '新しい会話')}</div>
            <div class="thr-s">${esc(preview || `${t.message_count || 0} 件`)}</div>
          </div>
          <button class="thr-menu" data-thr-menu="${esc(t.id)}" aria-label="メニュー">⋯</button>
        </div>`;
    }
    list.innerHTML = html;
  }

  $$('[data-thr]', list).forEach((el) => {
    el.addEventListener('click', (e) => { if (!e.target.closest('[data-thr-menu]')) openThread(el.dataset.thr); });
  });
  $$('[data-thr-menu]', list).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); threadMenu(b.dataset.thrMenu); }));

  renderFoot();
}

async function renderFoot() {
  const d = state.dash || {};
  const waiting = d.notifications?.waiting_approval || 0;
  const watchCount = d.watches_active || 0;
  const fleet = await api('/api/fleet', { quiet: true }).catch(() => null);
  const agents = (fleet?.agents || []).slice(0, 4);
  const teammates = agents.length
    ? `<div class="rail-sec">チーム</div><div class="rail-teammates">${agents.map((a) => `
        <div class="tm"><i class="dot ${a.status === 'running' ? 'on' : 'wait'}"></i><span>${esc(a.name || 'エージェント')}</span></div>`).join('')}</div>`
    : '';
  $('#railFoot').innerHTML = `
    ${teammates}
    <div class="rail-sec">エージェント</div>
    <button class="rail-item" data-open="mode">${icon('gear', 'i sm')}モード <span class="mut-strong">${esc(d.mode?.label || '稼ぐ')}</span></button>
    <button class="rail-item" data-open="work">${icon('eye', 'i sm')}作業をのぞく</button>
    <button class="rail-item" data-open="approvals">${icon('shield', 'i sm')}承認${waiting ? `<span class="badge warn">${waiting}</span>` : ''}</button>
    <button class="rail-item" data-open="watch">${icon('eye', 'i sm')}見張り${watchCount ? `<span class="badge accent">${watchCount}</span>` : ''}</button>
    <button class="rail-item" data-open="settings">${icon('gear', 'i sm')}設定</button>`;
  $$('[data-open]', $('#railFoot')).forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));
}

function openRail(open = true) {
  $('#rail').classList.toggle('open', open);
  $('#railScrim').classList.toggle('open', open);
  $('#rail').setAttribute('aria-hidden', open ? 'false' : 'true');
}

async function loadThreads() {
  const r = await api('/api/threads', { quiet: true });
  if (r && r.ok !== false && Array.isArray(r.threads)) {
    state.threads = r.threads;
    state.threadsAvailable = true;
  } else {
    state.threadsAvailable = false;
  }
  renderRail();
}

async function openThread(id) {
  if (!id || id === state.currentId) { openRail(false); return; }
  const r = await api(`/api/threads/${encodeURIComponent(id)}`, { quiet: true });
  if (!r || r.ok === false) { toast('会話を開けませんでした'); return; }
  state.currentId = id;
  state.messages = (r.messages || []).map((m) => ({
    role: m.role, text: m.text, cards: m.cards || [], events: m.events || [], created_at: m.created_at,
  }));
  state.suggestTouched = false;
  state.suggest = (state.mode?.chips || DEFAULT_SUGGEST).slice();
  renderChips();
  renderThread();
  renderRail();
  scrollDown(false);
  openRail(false);
}

function newThread() {
  state.currentId = null;
  state.messages = [];
  state.suggestTouched = false;
  state.suggest = (state.mode?.chips || DEFAULT_SUGGEST).slice();
  renderChips();
  renderThread();
  renderRail();
  openRail(false);
  $('#input').focus();
}

function threadMenu(id) {
  const t = state.threads.find((x) => x.id === id);
  if (!t) return;
  openSheetRaw('会話', `
    <div class="field"><span>タイトル</span><input id="thrTitle" value="${esc(t.title || '')}"></div>
    <div class="btn-row">
      <button class="btn primary" id="thrSave">保存</button>
      <button class="btn" id="thrPin">${t.pinned ? 'ピン留めを外す' : 'ピン留め'}</button>
      <button class="btn danger" id="thrDel">削除</button>
    </div>
    <div class="muted" style="font-size:12.5px">作成 ${esc(fmtTime(t.created_at))} · 更新 ${esc(fmtTime(t.updated_at))} · ${fmt(t.message_count || 0)} 件</div>
  `);
  $('#thrSave').addEventListener('click', async () => {
    await api(`/api/threads/${encodeURIComponent(id)}`, { method: 'POST', body: { title: $('#thrTitle').value } });
    closeSheet(); await loadThreads(); toast('保存しました');
  });
  $('#thrPin').addEventListener('click', async () => {
    await api(`/api/threads/${encodeURIComponent(id)}`, { method: 'POST', body: { pinned: t.pinned ? 0 : 1 } });
    closeSheet(); await loadThreads();
  });
  $('#thrDel').addEventListener('click', async () => {
    await api(`/api/threads/${encodeURIComponent(id)}`, { method: 'POST', body: { action: 'delete' } });
    if (state.currentId === id) newThread();
    closeSheet(); await loadThreads(); toast('削除しました');
  });
}

// ------------------------------------------------------------------ header

function renderHeader() {
  const d = state.dash;
  const ch = d?.character;
  const eng = d?.engine || {};
  $('#agentName').textContent = ch?.name || 'Wealth Agent';
  const running = eng.status === 'running';
  $('#pulse').className = `pulse ${running ? 'on' : eng.status === 'paused' ? 'warn' : ''}`;
  const waiting = d?.notifications?.waiting_approval || 0;
  $('#agentStatus').textContent = [
    running ? '稼働中' : eng.status === 'paused' ? '一時停止中' : '待機中',
    d?.engine?.total_steps != null ? `通算 ${d.engine.total_steps} ステップ` : null,
    waiting ? `承認待ち ${waiting} 件` : null,
  ].filter(Boolean).join(' · ');
  const ava = ch?.avatar_url;
  $('#avaBtn').innerHTML = /^data:image\//i.test(String(ava || ''))
    ? `<img src="${esc(ava)}" alt="">`
    : esc(String(ch?.avatar || ch?.name || 'WA').replace(/\p{Extended_Pictographic}+/gu, '').slice(0, 2) || 'WA');
}

async function refresh({ quiet = true } = {}) {
  const d = await api('/api/dashboard', { quiet });
  if (d && d.ok !== false) {
    state.dash = d;
    state.mode = d.mode || state.mode;
    renderHeader();
    renderModeChrome();
  }
  return d;
}

/** モードに合わせて入力欄の案内とチップを合わせる（稼ぐ以外の用途でも使いやすく）。 */
function renderModeChrome() {
  const m = state.mode;
  if (!m) return;
  const ta = $('#input');
  if (ta && m.placeholder) ta.placeholder = m.placeholder;
  if (!state.suggestTouched && Array.isArray(m.chips) && m.chips.length) {
    state.suggest = m.chips.slice();
    renderChips();
  }
  renderFoot();
}

// ------------------------------------------------------------------ send

async function send(text) {
  const msg = String(text || '').trim();
  if (!msg || state.busy) return;
  state.busy = true;
  $('#sendBtn').disabled = true;
  const ta = $('#input');
  ta.value = '';
  ta.style.height = 'auto';

  addMessage({ role: 'me', text: msg, at: Date.now() });
  thinking(true);

  const r = await api('/api/chat/act', { method: 'POST', body: { message: msg, thread_id: state.currentId }, quiet: true });
  thinking(false);

  if (!r) {
    push({ role: 'agent', text: '通信できませんでした。電波のある場所でもう一度試してください。' });
  } else {
    push({ role: 'agent', text: r.reply || '処理しました。', cards: r.cards || [], events: r.events || [], memory: r.memory || [] });
  if (r.thread_id && r.thread_id !== state.currentId) state.currentId = r.thread_id;
  }
  if (Array.isArray(r?.suggest) && r.suggest.length) { state.suggest = r.suggest; state.suggestTouched = true; renderChips(); }
  if (r?.mode) { state.mode = { ...(state.mode || {}), ...r.mode }; renderModeChrome(); }

  state.busy = false;
  $('#sendBtn').disabled = false;
  refresh({ quiet: true });
  loadThreads();
}

// ------------------------------------------------------------------ sheets

function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  $('#sheetScrim').classList.remove('open');
}

function openSheetRaw(title, bodyHTML) {
  $('#sheetIn').innerHTML = `
    <div class="sheet-h"><b>${esc(title)}</b><button class="icon-btn" id="sheetX" aria-label="閉じる">✕</button></div>
    <div class="sheet-b">${bodyHTML}</div>`;
  $('#sheet').classList.add('open');
  $('#sheet').setAttribute('aria-hidden', 'false');
  $('#sheetScrim').classList.add('open');
  $('#sheetX').addEventListener('click', closeSheet);
}

function kv(k, v) { return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`; }

async function openSheet(which = 'info') {
  if (which === 'work') return openWork();
  if (which === 'approvals') return openApprovals();
  if (which === 'watch') return openWatch();
  if (which === 'mode') return openMode();

  const d = state.dash || (await refresh({ quiet: false })) || {};
  const ch = d.character || {};
  const eng = d.engine || {};
  const led = d.ledger?.revenue || {};
  const runner = await api('/api/runner', { quiet: true }).catch(() => null);
  const paired = Array.isArray(runner?.runners) ? runner.runners.length > 0 : !!runner?.runner;

  openSheetRaw(which === 'settings' ? '設定' : 'エージェント', `
    <div>
      <div class="sec-t">いまの目標</div>
      ${d.current_mission
        ? kv('目標', esc(d.current_mission.title)) + kv('進捗', `${fmt(d.current_mission.progress)}%`) + kv('目標値', `${fmt(d.current_mission.target_value)} ${esc(d.current_mission.metric_unit || 'JPY')}`)
        : '<div class="muted" style="font-size:13.5px">まだ設定されていません。「月5万円を稼ぐ目標にして」のように話しかけてください。</div>'}
    </div>

    <div>
      <div class="sec-t">数字</div>
      ${kv('実測収益', `${fmt(led.measured)} 円`)}
      ${kv('推定収益（実績に数えない）', `${fmt(led.total_estimated)} 円`)}
      ${kv('完了した作業', `${fmt((d.completed_tasks || []).length)} 件`)}
    </div>

    <div>
      <div class="sec-t">動きかた</div>
      ${kv('状態', esc(eng.status === 'running' ? '稼働中' : eng.status === 'paused' ? '一時停止中' : '停止中'))}
      ${kv('最終実行', esc(eng.last_tick ? fmtTime(eng.last_tick) : '—'))}
      ${kv('自律性', `L${esc(ch.autonomy_level ?? 4)}`)}
      ${kv('口調', esc(ch.tone || '未設定'))}
      ${kv('AIキー', (d.ai?.configured || []).some((p) => p.key_present) ? '設定済み' : '未設定（決定的モードで動作中）')}
    </div>

    <div>
      <div class="sec-t">作業環境</div>
      ${kv('状態', paired ? '接続済み' : 'エージェントが裏で準備します')}
      <div class="muted" style="font-size:12.5px;margin-top:8px">必要なときだけエージェントが自分で使います。あなたが操作することはありません。</div>
      <details class="disclosure" style="margin-top:10px">
        <summary>自分で用意する場合（任意）</summary>
        <div class="muted" style="font-size:12.5px;margin-bottom:8px">自分のPCを1台つないでおくと、重い作業や提出物づくりをそこで実行できます。ふだんは不要です。</div>
        <div class="code" id="runnerCmd">RUNNER_URL=${esc(location.origin)} RUNNER_TOKEN=&lt;トークン&gt; bash -c "$(curl -fsSL ${esc(location.origin)}/cloud-pc.sh)"</div>
        <div class="btn-row" style="margin-top:8px"><button class="btn" id="copyCmd">コマンドをコピー</button></div>
      </details>
    </div>

    <div>
      <div class="sec-t">この端末</div>
      <div class="field"><span>アクセストークン</span>
        <input id="sToken" type="password" placeholder="サーバーで設定したトークン" value="${esc(state.token)}"></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn primary" id="saveTok">保存</button>
        <button class="btn danger" id="wipe">この端末の情報を消す</button>
      </div>
    </div>
  `);

  $('#saveTok').addEventListener('click', async () => {
    state.token = $('#sToken').value.trim();
    localStorage.setItem(LS_TOKEN, state.token);
    closeSheet();
    toast('保存しました');
    await refresh({ quiet: true });
    await loadThreads();
  });
  $('#wipe').addEventListener('click', () => {
    state.token = '';
    localStorage.removeItem(LS_TOKEN);
    newThread();
    closeSheet();
    toast('この端末の情報を消しました');
  });
  $('#copyCmd')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#runnerCmd').textContent); toast('コピーしました'); }
    catch { toast('コピーできませんでした'); }
  });
}

/** "What it did, what it is doing, what it will do" — the audit trail every
 *  always-on agent needs before you can trust it (dots/Muse both ship one). */
async function openWork() {
  const [dash, logs] = await Promise.all([
    state.dash || refresh({ quiet: true }),
    api('/api/logs?limit=12', { quiet: true }).catch(() => null),
  ]);
  const runs = (logs?.logs || logs?.runs || []).slice(0, 8);
  const running = (dash?.running_tasks || []).slice(0, 4);
  const finalNote = (logs?.routes || dash?.notifications) ? null : null;
  const trail = [
    ...runs.map((r) => ({ cls: 'ok', t: r.summary || r.state || '実行', s: `${fmtTime(r.created_at)} · ${r.state || ''}` })),
    ...running.map((t) => ({ cls: 'now', t: t.title, s: `いま実行中 · ${t.category || ''}` })),
    dash?.next_task ? { cls: 'next', t: dash.next_task.title, s: `次にやる予定 · ${dash.next_task.tool || ''}${dash.next_task.score != null ? ` · 確度 ${Math.round(dash.next_task.score)}` : ''}` } : null,
  ].filter(Boolean);

  openSheetRaw('エージェントの作業', `
    ${dash?.current_mission ? `<div><div class="sec-t">目標</div>${kv('目標', esc(dash.current_mission.title))}${kv('進捗', `${fmt(dash.current_mission.progress)}%`)}</div>` : ''}
    <div>
      <div class="sec-t">やったこと / いま / これから</div>
      ${trail.length ? `<div class="trail">${trail.map((x) => `<div class="trail-i ${x.cls}"><div class="trail-t">${esc(x.t)}</div><div class="trail-s">${esc(x.s)}</div></div>`).join('')}</div>` : '<div class="muted" style="font-size:13px">まだ記録はありません。「始めて」と言えば動き出します。</div>'}
      ${finalNote || ''}
    </div>
    ${dash?.next_task?.reasons?.length ? `<div><div class="sec-t">なぜ次にこれを選んだか</div><div class="rows">${dash.next_task.reasons.map((r) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:13px">${esc(typeof r === 'string' ? r : JSON.stringify(r))}</div></div></div>`).join('')}</div></div>` : ''}
    <div class="btn-row">
      <button class="btn primary" id="workTick">この場で1手進める</button>
      <button class="btn" id="workOpen">会話で聞く</button>
    </div>
  `);
  $('#workTick').addEventListener('click', () => { closeSheet(); send('次の一手を進めて'); });
  $('#workOpen').addEventListener('click', () => { closeSheet(); $('#input').focus(); });
}

/** 見張り（先回り報告）— 条件と現在値、完了条件（達成まで続ける）の進み具合。 */
async function openWatch() {
  const w = await api('/api/watches', { quiet: true });
  const rules = (w?.watches || []);
  const goal = w?.goal || state.dash?.goal || null;
  openSheetRaw('見張り', `
    ${goal ? `<div>
      <div class="sec-t">${goal.status === 'achieved' ? '達成しました' : '完了条件（達成するまで続けます）'}</div>
      <div class="goal-bar"><div class="goal-fill" style="width:${Math.max(2, Number(goal.pct) || 0)}%"></div></div>
      <div class="muted" style="font-size:12px;margin-top:6px">${esc(goal.metric_label || '')} ${fmt(goal.current)} / ${fmt(goal.target)}${esc(goal.unit || '')} · あと ${fmt(goal.remain)}${esc(goal.unit || '')}</div>
      ${goal.note ? `<div class="muted" style="font-size:12px;margin-top:4px">登録時の指示: ${esc(goal.note)}</div>` : ''}
    </div>` : ''}
    <div>
      <div class="sec-t">条件に達したら、私から報告します</div>
      ${rules.length ? `<div class="rows">${rules.map((r) => `<div class="row"><div class="row-main"><div class="row-t">${esc(r.label)} ${r.op === '<=' ? '≤' : '≥'} ${fmt(r.threshold)}${esc(r.unit || '')}</div><div class="row-s">いま ${fmt(r.current_value)}${esc(r.unit || '')}${r.hold ? ` · あと ${fmt(r.progress && r.progress.remain)}${esc(r.unit || '')}` : ''} · ${r.status === 'achieved' ? '達成' : r.status === 'triggered' ? '報告済み' : r.status === 'paused' ? '停止中' : '見張り中'}</div></div>${r.hold ? '<span class="badge accent">達成まで</span>' : `<button class="btn sm" data-do="watch_hold:${esc(r.id)}">達成まで続ける</button>`}<button class="btn sm" data-do="watch_off:${esc(r.id)}">解除</button></div>`).join('')}</div>`
        : '<div class="muted" style="font-size:13px">まだ見張りはありません。会話で「実測収益が3万円を超えたら教えて」「目標額に届くまで続けて」のように頼むと、ここに並びます。</div>'}
    </div>
    <div class="muted" style="font-size:12.5px">条件は登録した瞬間に固定されます。値は毎回、台帳と作業キューから読み直して照合します。</div>
  `);
  $$('[data-do]', $('#sheetIn')).forEach((b) => b.addEventListener('click', () => doAction(b.dataset.do, b)));
}

/** モード（用途）— 稼ぐ以外にも使えるように切り替える。自分のモードもここで足せる。 */
async function openMode() {
  const r = await api('/api/mode', { quiet: true });
  const modes = (r?.modes || []);
  const cur = r?.current || state.mode || {};
  const goal = state.dash?.goal || null;
  openSheetRaw('モード（用途）', `
    <div>
      <div class="sec-t">いまは「${esc(cur.label || '稼ぐ')}」モード</div>
      <div class="muted" style="font-size:13px">${esc(cur.blurb || '')}${cur.goal ? `<br>目的: ${esc(cur.goal)}` : ''}</div>
      ${goal && goal.status !== 'achieved' ? `<div style="margin-top:12px">
        <div class="goal-bar"><div class="goal-fill" style="width:${Math.max(2, Number(goal.pct) || 0)}%"></div></div>
        <div class="muted" style="font-size:12px;margin-top:6px">完了条件: ${esc(goal.metric_label || '')} ${fmt(goal.current)} / ${fmt(goal.target)}${esc(goal.unit || '')} · あと ${fmt(goal.remain)}${esc(goal.unit || '')}</div>
      </div>` : ''}
    </div>
    <div>
      <div class="sec-t">切り替える</div>
      <div class="rows">${modes.map((m) => `<div class="row mode-row${m.id === cur.id ? ' active' : ''}"><div class="row-main"><div class="row-t">${esc(m.label)}</div><div class="row-s">${esc(m.blurb || '')}${m.custom ? ' · あなたが追加' : ''}</div></div>${m.id === cur.id ? '<span class="badge accent">いま</span>' : `<button class="btn sm" data-do="mode:${esc(m.id)}">切り替え</button>`}</div>`).join('')}</div>
    </div>
    <div>
      <div class="sec-t">自分のモードを追加する</div>
      <div class="field"><span>名前</span><input id="modeLabel" placeholder="例: 筋トレ日記 / 引っ越し準備" maxlength="20"></div>
      <div class="field" style="margin-top:8px"><span>目的（任意。そのまま完了条件になります）</span><textarea id="modeGoal" rows="2" placeholder="例: 週3回の記録を続ける"></textarea></div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="modeAdd">追加して切り替える</button></div>
    </div>
    <div class="muted" style="font-size:12.5px">会話からも変えられます（「調べるモードにして」「◯◯モードを追加して。目的は…」）。</div>
  `);
  $$('[data-do]', $('#sheetIn')).forEach((b) => b.addEventListener('click', () => doAction(b.dataset.do, b)));
  $('#modeAdd').addEventListener('click', async (e) => {
    const label = $('#modeLabel').value.trim();
    if (!label) { toast('名前を入れてください'); return; }
    e.target.disabled = true;
    const res = await api('/api/mode', { method: 'POST', body: { action: 'create', label, goal: $('#modeGoal').value.trim() }, quiet: true });
    if (res && res.ok !== false) {
      state.suggestTouched = false;
      state.mode = { ...res.mode, chips: res.chips };
      toast(`「${res.mode.label}」モードを追加しました`);
      closeSheet();
      await refresh({ quiet: true });
      send('このモードで次にやることを1つ進めて');
    } else { toast('追加できませんでした'); e.target.disabled = false; }
  });
}

async function openApprovals() {
  const a = await api('/api/approvals', { quiet: true });
  const pending = (a?.approvals || []);
  openSheetRaw('承認', `
    <div>
      <div class="sec-t">あなたの判断が必要な操作</div>
      ${pending.length ? `<div class="rows">${pending.map((x) => `<div class="row"><div class="row-main"><div class="row-t">${esc(x.summary || x.action || x.kind || '承認要求')}</div><div class="row-s">${esc(x.reason || '')}</div></div><span class="badge warn">承認待ち</span></div>`).join('')}</div>`
        : '<div class="muted" style="font-size:13px">いま承認待ちはありません。</div>'}
    </div>
    <div>
      <div class="sec-t">エージェントが自分でやってよいこと</div>
      <div class="rows">${((a?.policy?.autonomous) || []).map((x) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:13px">${esc(x)}</div></div><span class="badge ok">自動</span></div>`).join('') || '<div class="muted" style="font-size:13px">情報を取得できませんでした。</div>'}</div>
    </div>
    <div>
      <div class="sec-t">必ずあなたの承認を待つこと</div>
      <div class="rows">${((a?.policy?.approval_required) || []).map((x) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:13px">${esc(x)}</div></div><span class="badge warn">承認必須</span></div>`).join('') || '<div class="muted" style="font-size:13px">—</div>'}</div>
    </div>
    <div>
      <div class="sec-t">やらないと決めていること</div>
      <div class="rows">${((a?.policy?.never) || []).map((x) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:13px">${esc(x)}</div></div><span class="badge danger">しない</span></div>`).join('') || '<div class="muted" style="font-size:13px">—</div>'}</div>
    </div>
    <div>
      <div class="sec-t">鍵のあつかい</div>
      <div class="muted" style="font-size:12.5px">${esc(a?.policy?.keys || 'APIキーはサーバー側にのみ保存し、会話には出しません。')}</div>
    </div>
  `);
}

// ------------------------------------------------------------------ composer

function bind() {
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send($('#input').value); });
  const ta = $('#input');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
  });
  $('#moreBtn').addEventListener('click', () => openSheet('settings'));
  $('#avaBtn').addEventListener('click', () => openSheet('info'));
  $('#whoBtn').addEventListener('click', () => openSheet('info'));
  $('#sheetScrim').addEventListener('click', closeSheet);
  $('#railBtn').addEventListener('click', () => openRail(true));
  $('#railClose').addEventListener('click', () => openRail(false));
  $('#railScrim').addEventListener('click', () => openRail(false));
  $('#newChat').addEventListener('click', newThread);
  let timer = null;
  $('#threadSearch').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value; renderRail(); }, 140);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); openRail(false); } });
}

// ------------------------------------------------------------------ boot

async function boot() {
  bind();
  renderChips();
  await Promise.all([refresh({ quiet: true }), loadThreads()]);
  renderThread();
  scrollDown(false);
  if (!state.token) {
    setTimeout(() => push({ role: 'agent', text: 'はじめての端末ですね。「⋯」からアクセストークンを貼り付けると、あなた専用のエージェントとして動きます。', action: 'settings' }), 400);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  setInterval(() => { refresh({ quiet: true }); renderFoot(); }, 45000);
}

boot();
