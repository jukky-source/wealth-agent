import { icon } from './icons.js';

// Wealth Agent — chat-first front end.
// One thread, one composer. The agent does the work; the interface just talks.

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('ja-JP') : esc(String(v));
};
const fmtDate = (s) => { try { return new Date(s).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return String(s || ''); } };

const LS_TOKEN = 'wa_token';
const LS_LOG = 'wa_chat_v2';
const DEFAULT_SUGGEST = ['今どうなってる？', '次の一手を進めて', '収益はいくら？', '稼げる方法を探して'];

const url = new URL(location.href);
if (url.searchParams.get('token')) {
  localStorage.setItem(LS_TOKEN, url.searchParams.get('token'));
  url.searchParams.delete('token');
  history.replaceState(null, '', url.pathname + url.hash);
}

const state = {
  token: localStorage.getItem(LS_TOKEN) || '',
  log: [],
  dash: null,
  suggest: DEFAULT_SUGGEST.slice(),
  busy: false,
};

try {
  const raw = JSON.parse(localStorage.getItem(LS_LOG) || '[]');
  if (Array.isArray(raw)) state.log = raw.slice(-40);
} catch { state.log = []; }

function saveLog() {
  try { localStorage.setItem(LS_LOG, JSON.stringify(state.log.slice(-40))); } catch { /* quota */ }
}

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
            <div class="row-t">${esc(it.title || '')}</div>
            ${it.sub ? `<div class="row-s">${esc(it.sub)}</div>` : ''}
          </div>
          ${it.badge ? `<span class="badge ${esc(it.tone || 'ghost')}">${esc(it.badge)}</span>` : ''}
        </div>`).join('')}</div></div>
    </div>`;
  }
  if (c.type === 'note') {
    return `<div class="card"><div class="card-h">${icon(c.icon || 'file')}<span>${esc(c.title || '')}</span></div>
      <div class="card-b"><div class="row-t" style="font-size:13px;color:var(--fg-2);-webkit-line-clamp:unset">${esc(c.text || '')}</div></div></div>`;
  }
  return '';
}

function msgHTML(m) {
  const mine = m.role === 'me';
  const events = (m.events || []).map((e) => `<div class="ev">${icon(e.tick ? 'check' : 'dot', e.tick ? 'i tick' : 'i')}<span>${esc(e.text || '')}</span></div>`).join('');
  const cards = (m.cards || []).map(cardHTML).join('');
  const action = m.action === 'settings' ? `<div class="btn-row" style="margin-top:8px"><button class="btn" data-open="settings">設定を開く</button></div>` : '';
  return `
    <div class="m ${mine ? 'me' : 'agent'}">
      <div class="bub">${esc(m.text || '')}${events ? `<div class="events">${events}</div>` : ''}</div>
      ${cards}${action}
      <span class="t">${mine ? 'あなた' : 'エージェント'} · ${fmtDate(m.at)}</span>
    </div>`;
}

function thread() { return $('#thread'); }

function scrollDown(smooth = true) {
  const el = thread();
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function renderThread() {
  const el = thread();
  if (!state.log.length) {
    const name = state.dash?.character?.name || 'Wealth Agent';
    el.innerHTML = `
      <div class="m agent"><div class="bub">${esc(`はじめまして、${name} です。\n\n目標を教えてもらえれば、計画を立てて調査・実行・検証まで自分で進めます。むずかしい設定は要りません — 話しかけるだけで動きます。`)}</div>
      <span class="t">エージェント</span></div>`;
    return;
  }
  el.innerHTML = state.log.map(msgHTML).join('');
  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));
}

function append(m) {
  state.log.push(m);
  saveLog();
  const el = thread();
  if (state.log.length === 1) { renderThread(); }
  else {
    const holder = document.createElement('div');
    holder.innerHTML = msgHTML(m);
    const node = holder.firstElementChild;
    el.appendChild(node);
    node.querySelectorAll?.('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));
  }
  scrollDown();
}

function push(m) { append({ at: Date.now(), ...m }); }

function thinking(on) {
  let el = $('#thinking');
  if (on) {
    if (el) return;
    el = document.createElement('div');
    el.id = 'thinking';
    el.className = 'm agent typing';
    el.innerHTML = `<div class="bub"><span class="dots"><i></i><i></i><i></i></span></div>`;
    thread().appendChild(el);
    scrollDown();
  } else if (el) el.remove();
}

function renderChips() {
  const el = $('#chips');
  el.innerHTML = state.suggest.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('');
  el.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => send(b.textContent)));
}

// ------------------------------------------------------------------ header

function renderHeader() {
  const d = state.dash;
  const ch = d?.character;
  const eng = d?.engine || {};
  $('#agentName').textContent = ch?.name || 'Wealth Agent';
  const st = $('#agentStatus');
  const pulse = $('#pulse');
  const running = eng.status === 'running';
  pulse.className = `pulse ${running ? 'on' : eng.status === 'paused' ? 'warn' : ''}`;
  const waiting = (d?.notifications?.waiting_approval || 0);
  st.textContent = [
    running ? '稼働中' : eng.status === 'paused' ? '一時停止中' : '待機中',
    `${d?.completed_tasks?.length ? '' : ''}${(d?.engine?.total_steps ?? '') !== '' && d?.engine?.total_steps != null ? `通算 ${d.engine.total_steps} ステップ` : null}`,
    waiting ? `承認待ち ${waiting} 件` : null,
  ].filter(Boolean).join(' · ');

  const a = $('#avaBtn');
  const ava = ch?.avatar_url;
  a.innerHTML = /^data:image\//i.test(String(ava || '')) ? `<img src="${esc(ava)}" alt="">` : esc(String(ch?.avatar || ch?.name || 'WA').replace(/\p{Extended_Pictographic}+/gu, '').slice(0, 2) || 'WA');
}

async function refresh({ quiet = true } = {}) {
  const d = await api('/api/dashboard', { quiet });
  if (d && d.ok !== false) { state.dash = d; renderHeader(); }
  return d;
}

// ------------------------------------------------------------------ send

async function send(text) {
  const msg = String(text || '').trim();
  if (!msg || state.busy) return;
  state.busy = true;
  $('#sendBtn').disabled = true;
  $('#input').value = '';
  autoGrow();
  if (!state.log.length) { push({ role: 'agent', text: 'はい、始めます。' }); } else { append({ role: 'me', text: msg, at: Date.now() }); }
  state.log.push({ role: 'me', text: msg, at: Date.now() });
  saveLog();
  const el = thread();
  const holder = document.createElement('div');
  holder.innerHTML = msgHTML(state.log[state.log.length - 1]);
  el.appendChild(holder.firstElementChild);
  scrollDown();
  thinking(true);

  const r = await api('/api/chat/act', { method: 'POST', body: { message: msg }, quiet: true });
  thinking(false);

  if (!r) {
    push({ role: 'agent', text: '通信できませんでした。電波のある場所でもう一度試してください。' });
  } else if (r.ok === false && r.reply) {
    push({ role: 'agent', text: r.reply });
  } else {
    push({ role: 'agent', text: r.reply || '処理しました。', cards: r.cards || [], events: r.events || [] });
  }
  if (Array.isArray(r?.suggest) && r.suggest.length) { state.suggest = r.suggest; renderChips(); }

  state.busy = false;
  $('#sendBtn').disabled = false;
  refresh({ quiet: true });
}

// ------------------------------------------------------------------ sheet

function kv(k, v) { return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`; }

async function openSheet(which = 'info') {
  const d = state.dash || (await refresh({ quiet: false })) || {};
  const led = d.ledger?.revenue || {};
  const ch = d.character || {};
  const eng = d.engine || {};
  const runner = await api('/api/runner', { quiet: true }).catch(() => null);
  const paired = Array.isArray(runner?.runners) ? runner.runners.length > 0 : !!runner?.runner;

  const tasks = (d.running_tasks || []).slice(0, 3).map((t) => `
    <div class="row"><div class="row-main"><div class="row-t">${esc(t.title)}</div>
    <div class="row-s">${esc(t.category || '')}</div></div><span class="badge accent">実行中</span></div>`).join('');

  $('#sheetIn').innerHTML = `
    <div class="sheet-h"><b>${which === 'settings' ? '設定' : 'エージェント'}</b>
      <button class="icon-btn" id="sheetX" aria-label="閉じる">✕</button></div>
    <div class="sheet-b">
      <div>
        <div class="sec-t">いまの目標</div>
        ${d.current_mission
          ? kv('目標', esc(d.current_mission.title)) + kv('進捗', `${fmt(d.current_mission.progress)}%`) + kv('目標値', `${fmt(d.current_mission.target_value)} ${esc(d.current_mission.metric_unit || 'JPY')}`)
          : `<div class="muted" style="font-size:13.5px">まだ設定されていません。「月5万円を稼ぐ目標にして」のように話しかけてください。</div>`}
      </div>

      <div>
        <div class="sec-t">数字</div>
        ${kv('実測収益', `${fmt(led.measured)} 円`)}
        ${kv('推定収益（実績に数えない）', `${fmt(led.total_estimated)} 円`)}
        ${kv('完了した作業', `${fmt((d.completed_tasks || []).length)} 件`)}
      </div>

      ${tasks ? `<div><div class="sec-t">進行中</div><div class="rows">${tasks}</div></div>` : ''}

      <div>
        <div class="sec-t">動きかた</div>
        ${kv('状態', esc(eng.status === 'running' ? '稼働中' : eng.status === 'paused' ? '一時停止中' : '停止中'))}
        ${kv('最終実行', esc(eng.last_tick ? fmtDate(eng.last_tick) : '—'))}
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
          <button class="btn" id="clearChat">会話を消す</button>
          <button class="btn danger" id="wipe">全消去</button>
        </div>
      </div>
    </div>`;

  $('#sheet').classList.add('open');
  $('#sheet').setAttribute('aria-hidden', 'false');
  $('#sheetScrim').classList.add('open');

  $('#sheetX').addEventListener('click', closeSheet);
  $('#saveTok').addEventListener('click', () => {
    state.token = $('#sToken').value.trim();
    localStorage.setItem(LS_TOKEN, state.token);
    toast('保存しました');
    closeSheet();
    push({ role: 'agent', text: '本人確認を更新しました。さっそく「今どうなってる？」と聞いてみてください。' });
    refresh({ quiet: true });
  });
  $('#clearChat').addEventListener('click', () => {
    state.log = []; saveLog(); renderThread(); closeSheet();
  });
  $('#wipe').addEventListener('click', () => {
    state.token = ''; state.log = [];
    localStorage.removeItem(LS_TOKEN); saveLog(); renderThread(); closeSheet();
    toast('この端末の情報を消しました');
  });
  $('#copyCmd')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#runnerCmd').textContent); toast('コピーしました'); }
    catch { toast('コピーできませんでした'); }
  });
}

function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
  $('#sheetScrim').classList.remove('open');
}

// ------------------------------------------------------------------ composer

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
}

function bind() {
  const form = $('#composer');
  form.addEventListener('submit', (e) => { e.preventDefault(); send($('#input').value); });
  const ta = $('#input');
  ta.addEventListener('input', autoGrow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
  });
  $('#moreBtn').addEventListener('click', () => openSheet('settings'));
  $('#avaBtn').addEventListener('click', () => openSheet('info'));
  $('#whoBtn').addEventListener('click', () => openSheet('info'));
  $('#sheetScrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
}

// ------------------------------------------------------------------ boot

async function boot() {
  bind();
  renderChips();
  await refresh({ quiet: true });
  renderThread();
  scrollDown(false);
  if (!state.token) {
    setTimeout(() => push({ role: 'agent', text: 'はじめての端末ですね。右上の「⋯」からアクセストークンを貼り付けると、あなた専用のエージェントとして動きます。', action: 'settings' }), 400);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  setInterval(() => refresh({ quiet: true }), 45000);
}

boot();
