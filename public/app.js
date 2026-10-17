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
  attach: [], // 送信前の画像（{data_url, thumb, name}）
};

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ images
/** 画像を長辺 max px の JPEG に縮小する（iPhone の HEIC も <img> 経由で JPEG になる）。 */
function shrinkImage(file, max = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を開けませんでした')); };
    img.src = url;
  });
}

async function addFiles(files) {
  const list = [...(files || [])].filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name || ''));
  if (!list.length) return;
  for (const f of list) {
    if (state.attach.length >= 3) { toast('画像は3枚までです'); break; }
    try {
      let data = await shrinkImage(f, 1280, 0.82);
      if (data.length > 1_400_000) data = await shrinkImage(f, 960, 0.72);
      const thumb = await shrinkImage(f, 160, 0.7);
      state.attach.push({ data_url: data, thumb, name: f.name || '画像' });
    } catch (e) { toast(e.message || '画像を読み込めませんでした'); }
  }
  renderAttach();
}

function renderAttach() {
  const el = $('#attach');
  if (!el) return;
  el.innerHTML = state.attach.map((a, i) => `
    <div class="att" style="--i:${i}"><img src="${esc(a.thumb)}" alt=""><button type="button" class="att-x" data-att="${i}" aria-label="外す">✕</button></div>`).join('');
  el.classList.toggle('on', state.attach.length > 0);
  $$('[data-att]', el).forEach((b) => b.addEventListener('click', () => {
    state.attach.splice(Number(b.dataset.att), 1); renderAttach();
  }));
  syncSend();
}

function syncSend() {
  const has = $('#input').value.trim().length > 0 || state.attach.length > 0;
  $('#sendBtn').classList.toggle('ready', has);
}

/** 数字を 0 から目標値まで数え上げる（KPI カードが「生きている」感じを出す）。 */
function countUp(root) {
  if (reduceMotion()) return;
  $$('[data-count]', root).forEach((el) => {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to) || to === 0) return;
    const t0 = performance.now(); const dur = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(to * e).toLocaleString('ja-JP');
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  });
}

/** 押した場所から広がる波紋。 */
function ripple(e) {
  const b = e.currentTarget;
  if (reduceMotion() || !b.getBoundingClientRect) return;
  const r = b.getBoundingClientRect();
  const s = document.createElement('span');
  s.className = 'rip';
  const d = Math.max(r.width, r.height) * 1.2;
  s.style.cssText = `width:${d}px;height:${d}px;left:${(e.clientX || r.left + r.width / 2) - r.left - d / 2}px;top:${(e.clientY || r.top + r.height / 2) - r.top - d / 2}px`;
  b.appendChild(s);
  setTimeout(() => s.remove(), 600);
}

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
        <div class="kpi-v"><span ${Number.isFinite(Number(k.value)) ? `data-count="${Number(k.value)}"` : ''}>${fmt(k.value)}</span>${k.unit ? `<small>${esc(k.unit)}</small>` : ''}</div>
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
  const imgs = (m.images || []).filter((x) => x && (x.thumb || x.data_url));
  const gallery = imgs.length ? `<div class="m-imgs">${imgs.map((x) => `<img src="${esc(x.thumb || x.data_url)}" alt="${esc(x.name || '画像')}" loading="lazy">`).join('')}</div>` : '';
  return `
    <div class="m ${mine ? 'me' : 'agent'}">
      ${gallery}
      ${m.text ? `<div class="bub">${esc(m.text || '')}${events ? `<div class="events">${events}</div>` : ''}</div>` : ''}
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
      refreshSoon();
      renderThread();
    } else { toast('切り替えられませんでした'); btn.disabled = false; }
    return;
  }
  if (kind === 'watch_hold') {
    const r = await api(`/api/watches/${encodeURIComponent(id)}`, { method: 'POST', body: { action: 'hold' }, quiet: true });
    if (r && r.ok !== false) { toast('達成するまで続ける完了条件にしました'); closeSheet(); refreshSoon(); }
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
    const ok = await copySmart(m?.text || '');
    toast(ok ? 'コピーしました' : 'この端末ではコピーが通りません（本文を長押しで選択してください）', ok ? 1600 : 4600);
  }));
  $$('[data-remember]', root).forEach((b) => b.addEventListener('click', () => send('この手順を覚えて')));
  $$('[data-do]', root).forEach((b) => b.addEventListener('click', () => doAction(b.dataset.do, b)));
  $$('.card', root).forEach((c, i) => c.style.setProperty('--d', `${80 + i * 70}ms`));
  $$('.btn,.chip,.msg-act', root).forEach((b) => b.addEventListener('pointerdown', ripple));
  countUp(root);
}

function renderThread() {
  const el = threadEl();
  if (!state.messages.length) {
    const name = state.dash?.character?.name || 'Wealth Agent';
    const m = state.mode;
    el.innerHTML = `
      <div class="m agent"><div class="bub">${esc(`はじめまして、${name} です。\n\n目標を教えてもらえれば、計画を立てて調査・実行・検証まで自分で進めます。むずかしい設定は要りません — 話しかけるだけで動きます。${m ? `\n\n「x402 直販API」「API・自動化ツール出品」「AI代行サービス」の3つの稼ぎ方を同時に進めています（画面の「稼ぎ方」で進行が見えます）。` : ''}`)}</div>
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
    el.innerHTML = '<div class="bub"><span class="dots"><i></i><i></i><i></i></span><span class="think-l" id="thinkL">考えています</span></div>';
    threadEl().appendChild(el);
    $('#avaBtn').classList.add('busy');
    const steps = state.attach.length || on === 'vision'
      ? ['画像を見ています', '文字と数字を読んでいます', 'まとめています']
      : ['考えています', '台帳を確認しています', '計画を組み立てています', '結果を検証しています'];
    let i = 0;
    clearInterval(thinking._t);
    thinking._t = setInterval(() => {
      const l = $('#thinkL'); if (!l) return;
      i = (i + 1) % steps.length;
      l.classList.remove('swap'); void l.offsetWidth; l.classList.add('swap');
      l.textContent = steps[i];
    }, 1500);
    scrollDown();
  } else {
    clearInterval(thinking._t);
    $('#avaBtn').classList.remove('busy');
    if (el) el.remove();
  }
}

function renderChips() {
  const el = $('#chips');
  el.innerHTML = state.suggest.map((s, i) => `<button class="chip" type="button" style="--i:${i}">${esc(s)}</button>`).join('');
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
    <button class="rail-item" data-open="streams">${icon('gear', 'i sm')}稼ぎ方 <span class="mut-strong">${(d.streams || []).length}件 同時進行</span></button>
    <button class="rail-item" data-open="work">${icon('eye', 'i sm')}作業をのぞく</button>
    <button class="rail-item" data-open="approvals">${icon('shield', 'i sm')}承認${waiting ? `<span class="badge warn">${waiting}</span>` : ''}</button>
    <button class="rail-item" data-open="watch">${icon('eye', 'i sm')}見張り${watchCount ? `<span class="badge accent">${watchCount}</span>` : ''}</button>
    <button class="rail-item" data-open="agent">${icon('mask', 'i sm')}エージェント設定</button>
    <button class="rail-item" data-open="settings">${icon('gear', 'i sm')}端末とつながり</button>`;
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
    role: m.role, text: m.text, cards: m.cards || [], events: m.events || [], images: m.images || [], created_at: m.created_at,
  }));
  state.suggestTouched = false;
  state.suggest = (state.mode?.chips || DEFAULT_SUGGEST).slice();
  const swap = () => { renderChips(); renderThread(); renderRail(); scrollDown(false); };
  if (document.startViewTransition && !reduceMotion()) document.startViewTransition(swap); else swap();
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
  renderStreams(d);
  const ava = ch?.avatar_url;
  const avaIsImg1 = /^data:image\//i.test(String(ava || '')) || /^\/api\//.test(String(ava || ''));
  $('#avaBtn').innerHTML = avaIsImg1
    ? `<img src="${esc(avaSrc(ava))}" alt="">`
    : esc(String(ch?.avatar || ch?.name || 'WA').replace(/\p{Extended_Pictographic}+/gu, '').slice(0, 2) || 'WA');
}

/** 稼ぎ方（同時進行）の進行ボード。目標入力は不要 — 見るだけ。 */
function streamRowsHTML(list) {
  return (list || []).map((s) => {
    const st = s.status === 'active' ? '<span class="badge accent">進行中</span>' : `<span class="badge">${esc(s.status)}</span>`;
    const nums = s.total ? `${s.completed}/${s.total} 完了` : '着手前';
    const extra = [s.running ? `実行中 ${s.running}` : null, s.queued ? `待機 ${s.queued}` : null,
      s.failed ? `失敗 ${s.failed}` : null, s.waiting ? `承認待ち ${s.waiting}` : null].filter(Boolean).join(' ・ ');
    const next = (s.next_task && s.next_task.title) || (s.status === 'active' ? '次のタスクを準備中' : '—');
    return `<div class="row"><div class="row-main">
      <div class="row-t">${esc(s.label)} ${st}</div>
      <div class="row-s">${esc(nums)} ・ 進行 ${Number(s.progress) || 0}%${extra ? ' ・ ' + esc(extra) : ''}</div>
      <div class="row-s">次: ${esc(next)}</div>
      ${s.last_done ? `<div class="row-s">直近の完了: ${esc(s.last_done.title)}</div>` : ''}
    </div></div>`;
  }).join('');
}
function renderStreams(d) {
  const list = (d && d.streams) || [];
  if (!list.length) return;
  let host = document.getElementById('streamBoard');
  if (!host) {
    host = document.createElement('section');
    host.id = 'streamBoard';
    host.style.cssText = 'margin:12px 10px 4px;';
    const main = document.querySelector('main') || document.querySelector('#app, .app, .wrap') || document.body;
    main.insertBefore(host, main.firstChild);
  }
  const done = list.reduce((a, s) => a + (Number(s.completed) || 0), 0);
  host.innerHTML = `<div class="sec-t">稼ぎ方（同時進行）</div>
    <div class="row-s" style="margin:-2px 0 8px">目標の入力は要りません。自動で計画し、並行して進めます（完了 通算 ${done} 件）。</div>
    <div class="rows">${streamRowsHTML(list)}</div>`;
}
let _notifCount = 0;
/** 承認が必要になったら知らせる（タイトル + 端末の通知）。 */
async function checkNotifications() {
  try {
    const n = await api('/api/notifications', { quiet: true });
    if (!n || n.ok === false) return;
    const u = Number(n.unread || 0);
    document.title = u > 0 ? `(${u}) Wealth Agent` : 'Wealth Agent';
    if (u > 0 && u !== _notifCount) {
      _notifCount = u;
      const top = (n.items && n.items[0]) || {};
      const body = `${top.title || '承認待ちがあります'}${u > 1 ? `\n他 ${u - 1} 件` : ''}`;
      let shown = false;
      try {
        if ('Notification' in window && Notification.permission === 'granted') { new Notification('承認が必要です', { body, icon: './icons/icon-192.png' }); shown = true; }
      } catch { shown = false; }
      if (!shown) toast('承認待ちが ' + u + ' 件あります');
    } else if (u === 0) { _notifCount = 0; }
  } catch { /* 通知の失敗で本筋は止めない */ }
}
/** 稼ぎ方シート（進行の詳細 + 承認通知のオン） */
async function openStreams() {
  const r = await api('/api/streams', { quiet: true }).catch(() => null);
  const list = (r && r.streams) || (state.dash && state.dash.streams) || [];
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  openSheetRaw('稼ぎ方（同時進行）', `
    <div class="muted" style="font-size:12.5px">目標の入力は不要です。稼ぎ方ごとに自動で計画し、同時に進めます。承認が必要なときだけ通知します。</div>
    <div class="rows" style="margin-top:10px">${streamRowsHTML(list)}</div>
    ${perm !== 'granted' ? '<div class="btn-row" style="margin-top:12px"><button class="btn primary" id="notifyOn">承認通知をオンにする</button></div><div class="muted" style="font-size:11.5px;margin-top:6px">端末の通知を許可すると、承認待ちが出たときに知らせます。</div>' : '<div class="muted" style="font-size:12px;margin-top:10px">承認通知はオンです。</div>'}
  `);
  $('#notifyOn')?.addEventListener('click', async () => {
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') { await checkNotifications(); toast('承認通知をオンにしました'); closeSheet(); } else toast('通知は許可されませんでした');
    } catch { toast('この端末では通知を使えません'); }
  });
}

function avaSrc(u) {
  const s = String(u || '');
  if (/^\/api\//.test(s)) return s + (s.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(state.token || '');
  return s;
}

function refreshSoon() { refresh({ quiet: true }).catch(() => {}); }

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
  const images = state.attach.slice();
  if ((!msg && !images.length) || state.busy) return;
  state.busy = true;
  $('#sendBtn').disabled = true;
  $('#sendBtn').classList.add('fly');
  setTimeout(() => $('#sendBtn').classList.remove('fly'), 520);
  const ta = $('#input');
  ta.value = '';
  ta.style.height = 'auto';
  state.attach = [];
  renderAttach();

  addMessage({ role: 'me', text: msg, images: images.map((i) => ({ thumb: i.thumb, name: i.name })), at: Date.now() });
  thinking(images.length ? 'vision' : true);

  const r = await api('/api/chat/act', {
    method: 'POST', quiet: true,
    body: { message: msg, thread_id: state.currentId, ...(images.length ? { images } : {}) },
  });
  thinking(false);

  if (!r) {
    push({ role: 'agent', text: '通信できませんでした。電波のある場所でもう一度試してください。' });
  } else {
    push({ role: 'agent', text: r.reply || (r.ok === false ? `うまくいきませんでした（${r.error || 'error'}）` : '処理しました。'), cards: r.cards || [], events: r.events || [], memory: r.memory || [] });
  if (r.thread_id && r.thread_id !== state.currentId) state.currentId = r.thread_id;
  }
  if (Array.isArray(r?.suggest) && r.suggest.length) { state.suggest = r.suggest; state.suggestTouched = true; renderChips(); }
  if (r?.mode) { state.mode = { ...(state.mode || {}), ...r.mode }; renderModeChrome(); }

  state.busy = false;
  $('#sendBtn').disabled = false;
  syncSend();
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
  $$('.sheet-b > *', $('#sheetIn')).forEach((c, i) => c.style.setProperty('--i', String(Math.min(i, 8))));
  $$('.btn', $('#sheetIn')).forEach((b) => b.addEventListener('pointerdown', ripple));
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
  if (which === 'mode' || which === 'streams') return openStreams();
  if (which === 'sns') return openSns();
  if (which === 'fx') return openFx();
  if (which === 'scout') return openScout();
  if (which === 'agent') return openAgent();

  const d = state.dash || (await refresh({ quiet: false })) || {};
  const ch = d.character || {};
  const eng = d.engine || {};
  const led = d.ledger?.revenue || {};
  const runner = await api('/api/runner', { quiet: true }).catch(() => null);
  const paired = Array.isArray(runner?.runners) ? runner.runners.length > 0 : !!runner?.runner;

  openSheetRaw(which === 'settings' ? '設定' : 'エージェント', `
    <button class="btn primary wide" id="snsBtn" type="button">${icon('file', 'i sm')}SNS投稿（開いて押すだけ）</button>
    <button class="btn wide" id="fxBtn" type="button">${icon('pulse', 'i sm')}FXの成績と論理を見る</button>
    <button class="btn wide" id="goAgent" type="button">${icon('mask', 'i sm')}エージェント設定を開く（性格・お金の範囲・アイコン）</button>
    <div>
      <div class="sec-t">いまの目標</div>
      ${d.current_mission
        ? kv('目標', esc(d.current_mission.title)) + kv('進捗', `${fmt(d.current_mission.progress)}%`) + kv('目標値', `${fmt(d.current_mission.target_value)} ${esc(d.current_mission.metric_unit || 'JPY')}`)
        : '<div class="muted" style="font-size:13.5px">まだ設定されていません。「月5万円を稼ぐ目標にして」のように話しかけてください。</div>'}
    </div>

    <div>
      <div class="sec-t">数字</div>
      ${kv('実測収益', `${fmt(led.measured)} 円`)}
      ${Object.keys(led.measured_by_currency || {}).length
        ? kv('実測収益（円以外）', Object.entries(led.measured_by_currency).map(([c, v]) => `${c} ${fmt(v)}`).join(' / '))
        : ''}
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
      <div class="muted" style="font-size:12.5px;margin-top:10px">つながらなくなったときは、サーバー側で発行した<strong>ペアリングコード</strong>をここに入れてください。1回だけ有効で、期限があります。</div>
      <div class="field" style="margin-top:8px"><span>ペアリングコード</span>
        <input id="pairCode" placeholder="例: ABCD-2345" autocapitalize="characters" autocomplete="off" spellcheck="false"></div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" id="pairGo">この端末をつなぐ</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn primary" id="saveTok">保存</button>
        <button class="btn danger" id="wipe">この端末の情報を消す</button>
      </div>
    </div>
  `);

  $('#goAgent').addEventListener('click', () => openAgent());
  $('#snsBtn').addEventListener('click', () => openSns());
  $('#fxBtn').addEventListener('click', () => openFx());
  // ペアリング: コードを持っている端末だけがトークンを受け取る（1回だけ有効）。
  $('#pairGo').addEventListener('click', async () => {
    const code = $('#pairCode').value.trim();
    if (!code) { toast('コードを入れてください'); return; }
    $('#pairGo').disabled = true;
    let r = null;
    try {
      const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      r = await res.json();
    } catch { r = null; }
    $('#pairGo').disabled = false;
    if (r && r.ok && r.token) {
      state.token = r.token;
      localStorage.setItem(LS_TOKEN, r.token);
      closeSheet();
      toast('つながりました');
      await refresh({ quiet: true });
      await loadThreads();
      push({ role: 'agent', text: 'つながりました。これで指示できます。' });
      return;
    }
    const why = r?.error === 'expired' ? 'コードの期限が切れています。新しく発行してください。'
      : r?.error === 'too_many_tries' ? '何度も間違えたためコードを無効にしました。新しく発行してください。'
      : r?.error === 'bad_code' ? `コードが違います（残り ${r.tries_left ?? 0} 回）`
      : r?.error === 'no_pairing_open' ? 'サーバー側でコードが発行されていません'
      : 'つながりませんでした';
    toast(why, 4200);
  });
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
    const ok = await copySmart($('#runnerCmd').textContent);
    toast(ok ? 'コピーしました' : 'この端末ではコピーが通りません（コマンドを長押しで選択してください）', ok ? 1600 : 4600);
  });
}

/** エージェント設定 — 名前・性格・自律性・お金の範囲・アイコン・動かす/止める。 */
async function openAgent() {
  const [cr, er, pr] = await Promise.all([
    api('/api/character', { quiet: true }),
    api('/api/envelope', { quiet: true }),
    api('/api/providers', { quiet: true }),
  ]);
  const ch = cr?.character || {};
  const presets = cr?.presets || [];
  const env = er?.envelope || {};
  const eng = state.dash?.engine || {};
  const neu = pr?.neurons || null;
  const ava = ch.avatar_url;
  const slider = (id, label, v, hint) => `
    <label class="slide"><span class="slide-h"><b>${esc(label)}</b><output id="${id}O">${esc(v)}</output></span>
      <input type="range" id="${id}" min="0" max="100" step="5" value="${esc(v)}">
      <small>${esc(hint)}</small></label>`;
  openSheetRaw('エージェント設定', `
    <div class="ag-head">
      <button class="ag-ava" id="agAva" type="button" aria-label="アイコンを変える">${(/^data:image\//i.test(String(ava || '')) || /^\/api\//.test(String(ava || ''))) ? `<img src="${esc(avaSrc(ava))}" alt="">` : esc(String(ch.avatar || ch.name || 'WA').slice(0, 2))}<i>${icon('image', 'i sm')}</i></button>
      <div class="ag-id">
        <div class="field"><span>名前</span><input id="agName" maxlength="40" value="${esc(ch.name || 'Wealth Agent')}"></div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn sm" id="agUp" type="button">${icon('upload', 'i sm')}写真から</button>
          <button class="btn sm" id="agGen" type="button">${icon('sparkle', 'i sm')}AIで作る</button>
          ${ava ? '<button class="btn sm danger" id="agClr" type="button">外す</button>' : ''}
        </div>
        <input type="file" id="agFile" accept="image/*" hidden>
      </div>
    </div>

    <div>
      <div class="sec-t">動かす / 止める</div>
      <div class="eng ${esc(eng.status || 'stopped')}">
        <i class="pulse ${eng.status === 'running' ? 'on' : eng.status === 'paused' ? 'warn' : ''}"></i>
        <div class="eng-t"><b>${eng.status === 'running' ? '自律運転中（5分ごとに1手）' : eng.status === 'paused' ? '一時停止中' : '停止中'}</b>
          ${eng.reason ? `<small>${esc(eng.reason)}</small>` : ''}</div>
        ${eng.status === 'running'
          ? '<button class="btn sm" id="agPause" type="button">止める</button>'
          : '<button class="btn sm primary" id="agRun" type="button">動かす</button>'}
      </div>
    </div>

    <div>
      <div class="sec-t">性格</div>
      <div class="presets">${presets.map((p) => `<button type="button" class="preset${p.key === ch.preset ? ' on' : ''}" data-preset="${esc(p.key)}"><b>${esc(String(p.label || '').replace(/^[A-E]\.\s*/, ''))}</b><small>${esc(p.description || '')}</small></button>`).join('')}</div>
      <div class="field" style="margin-top:10px"><span>話し方</span><input id="agTone" maxlength="160" value="${esc(ch.tone || '')}" placeholder="例: 結論から短く。数字には出典をつける"></div>
      <div class="field" style="margin-top:8px"><span>長期の目標（任意）</span><textarea id="agGoal" rows="2" maxlength="300" placeholder="例: 手間を最小にして月3万円の実測入金">${esc(ch.long_term_goals || '')}</textarea></div>
      <div class="field" style="margin-top:8px"><span>やってほしくないこと</span><textarea id="agNo" rows="2" maxlength="300">${esc(ch.prohibitions || '')}</textarea></div>
    </div>

    <div>
      <div class="sec-t">判断のくせ</div>
      ${slider('agRisk', 'リスク許容', ch.risk_tolerance ?? 30, '高いほど不確かな案も試す。お金の上限はこれとは別に下で固定されます')}
      ${slider('agCaution', '慎重さ', ch.caution ?? 60, '高いほど検証を厚くし、根拠の薄い報告を出しません')}
      ${slider('agCreat', '発想の幅', ch.creativity ?? 60, '高いほど新しい売り方を提案します')}
      <label class="slide"><span class="slide-h"><b>自律性</b><output id="agAutoO">L${esc(ch.autonomy_level ?? 4)}</output></span>
        <input type="range" id="agAuto" min="1" max="5" step="1" value="${esc(ch.autonomy_level ?? 4)}">
        <small>L1=毎回確認 … L5=任せる。L5でも下の「承認が要ること」は必ず止まります</small></label>
      <div class="field" style="margin-top:6px"><span>報告の頻度</span>
        <select id="agFreq">${[['realtime', 'その都度'], ['daily', '1日1回'], ['weekly', '週1回']].map(([k, l]) => `<option value="${k}"${(ch.report_frequency || 'daily') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>

    <div>
      <div class="sec-t">お金の範囲（ここから先はあなたの承認）</div>
      <div class="money">
        <div class="field"><span>自動で使える1回の上限（円）</span><input id="agYen1" type="number" inputmode="numeric" min="0" max="5000" step="100" value="${esc(env.auto_max_yen_per_action ?? 0)}"></div>
        <div class="field"><span>1日の上限（円）</span><input id="agYenD" type="number" inputmode="numeric" min="0" max="20000" step="100" value="${esc(env.auto_max_yen_per_day ?? 0)}"></div>
      </div>
      <label class="tog"><input type="checkbox" id="agRework" ${env.auto_rework !== false ? 'checked' : ''}><span></span><b>判定に落ちた作業は自動で作り直す</b></label>
      <label class="tog"><input type="checkbox" id="agPost" ${env.public_post === 'auto' ? 'checked' : ''}><span></span><b>投稿も承認なしで出す</b><small>おすすめはオフ。凍結されると収益の出口ごと失います</small></label>
      <div class="locks">${[['本人確認', 'identity'], ['口座・アカウント作成', 'account'], ['契約・署名', 'sign'], ['入金済みの確定', 'paid']].map(([l]) => `<span class="lock">${icon('shield', 'i sm')}${esc(l)}は人間だけ</span>`).join('')}</div>
    </div>

    ${neu ? `<div>
      <div class="sec-t">今日のAI無料枠</div>
      <div class="goal-bar"><div class="goal-fill" style="width:${Math.min(100, Math.max(2, Math.round((neu.today / Math.max(1, neu.free_per_day)) * 100)))}%"></div></div>
      <div class="muted" style="font-size:12px;margin-top:6px">Cloudflare Workers AI ${fmt(Math.round(neu.today))} / ${fmt(neu.free_per_day)} Neurons（${fmt(neu.cap)} で自動停止 → 無料枠の外には出ません）</div>
    </div>` : ''}

    <div class="btn-row sticky-save">
      <button class="btn primary wide" id="agSave" type="button">保存する</button>
    </div>
  `);

  let preset = ch.preset || 'custom';
  $$('[data-preset]', $('#sheetIn')).forEach((b) => b.addEventListener('click', () => {
    preset = b.dataset.preset;
    $$('[data-preset]', $('#sheetIn')).forEach((x) => x.classList.toggle('on', x === b));
    const p = presets.find((x) => x.key === preset);
    if (p && preset !== 'custom') {
      if (p.tone) $('#agTone').value = p.tone;
      [['agRisk', p.risk_tolerance], ['agCaution', p.caution], ['agCreat', p.creativity]].forEach(([id, v]) => {
        if (v != null) { $(`#${id}`).value = v; $(`#${id}O`).textContent = v; }
      });
    }
  }));
  ['agRisk', 'agCaution', 'agCreat'].forEach((id) => $(`#${id}`).addEventListener('input', (e) => { $(`#${id}O`).textContent = e.target.value; }));
  $('#agAuto').addEventListener('input', (e) => { $('#agAutoO').textContent = `L${e.target.value}`; });

  const setAva = async (dataUrl, source, extra = {}) => {
    const r = await api('/api/character/avatar', { method: 'POST', body: { data_url: dataUrl, source, ...extra }, quiet: true });
    if (r && r.ok !== false) { toast('アイコンを変えました'); await refresh({ quiet: true }); openAgent(); }
    else toast(r?.hint || '保存できませんでした');
  };
  $('#agUp').addEventListener('click', () => $('#agFile').click());
  $('#agAva').addEventListener('click', () => $('#agFile').click());
  $('#agFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { await setAva(await shrinkImage(f, 256, 0.85), 'upload'); } catch { toast('画像を開けませんでした'); }
  });
  $('#agGen').addEventListener('click', async (e) => {
    const ins = prompt('どんなアイコンにしますか？（例: 落ち着いた紺色のアドバイザー、ミニマル）', '');
    if (!ins) return;
    e.target.disabled = true; $('#agAva').classList.add('busy');
    const g = await api('/api/character/avatar/generate', { method: 'POST', body: { instruction: ins }, quiet: true });
    $('#agAva').classList.remove('busy'); e.target.disabled = false;
    if (g?.ok && g.data_url) {
      let url = g.data_url;
      if (/^data:image\/(png|jpe?g|webp)/i.test(url)) {
        try { const b = await (await fetch(url)).blob(); url = await shrinkImage(new File([b], 'a.jpg', { type: b.type }), 256, 0.85); } catch { /* そのまま */ }
      }
      await setAva(url, 'generated', { prompt: g.prompt_used, model: g.model });
      if (g.note) toast(g.note, 4000);
    } else toast(g?.hint || '生成できませんでした');
  });
  $('#agClr')?.addEventListener('click', async () => { await api('/api/character/avatar/clear', { method: 'POST', quiet: true }); await refresh({ quiet: true }); openAgent(); });

  $('#agRun')?.addEventListener('click', async () => {
    const r = await api(`/api/engine/${eng.status === 'paused' ? 'resume' : 'start'}`, { method: 'POST', quiet: true });
    toast(r && r.ok !== false ? '動かしました。5分ごとに自分で1手ずつ進めます' : '動かせませんでした');
    refreshSoon(); openAgent();
  });
  $('#agPause')?.addEventListener('click', async () => {
    await api('/api/engine/pause', { method: 'POST', body: { reason: 'オーナーが設定画面から停止' }, quiet: true });
    toast('止めました'); refreshSoon(); openAgent();
  });

  $('#agSave').addEventListener('click', async (e) => {
    const name = $('#agName').value.trim();
    if (!name) { toast('名前を入れてください'); return; }
    const yen1 = Math.max(0, Math.min(5000, Math.round(Number($('#agYen1').value) || 0)));
    const yenD = Math.max(0, Math.min(20000, Math.round(Number($('#agYenD').value) || 0)));
    if (yenD < yen1) { toast('1日の上限は1回の上限以上にしてください'); return; }
    if ($('#agPost').checked && env.public_post !== 'auto' && !confirm('投稿を承認なしで出します。規約違反や重複で凍結されると、そのアカウントの収益がすべて止まります。本当にオンにしますか？')) return;
    e.target.disabled = true;
    const [c, v] = await Promise.all([
      api('/api/character', { method: 'POST', quiet: true, body: { character: {
        id: ch.id, name, preset, avatar: ch.avatar,
        tone: $('#agTone').value.trim(), long_term_goals: $('#agGoal').value.trim(), prohibitions: $('#agNo').value.trim(),
        risk_tolerance: Number($('#agRisk').value), caution: Number($('#agCaution').value), creativity: Number($('#agCreat').value),
        autonomy_level: Number($('#agAuto').value), report_frequency: $('#agFreq').value,
        description: ch.description, personality: ch.personality, values: ch.values, strengths: ch.strengths, weaknesses: ch.weaknesses,
      } } }),
      api('/api/envelope', { method: 'POST', quiet: true, body: {
        auto_max_yen_per_action: yen1, auto_max_yen_per_day: yenD,
        auto_rework: $('#agRework').checked, public_post: $('#agPost').checked ? 'auto' : 'approval',
      } }),
    ]);
    e.target.disabled = false;
    if (c?.ok !== false && v?.ok !== false) {
      const b = e.target; b.classList.add('done'); b.textContent = '保存しました';
      refreshSoon();
      setTimeout(closeSheet, 650);
    } else toast('保存できませんでした');
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
      refreshSoon();
      send('このモードで次にやることを1つ進めて');
    } else { toast('追加できませんでした'); e.target.disabled = false; }
  });
}

/** 承認1件を1行の日本語にする（生の action 名をそのまま人に見せない）。 */
function approvalLabel(x) {
  const p = x.payload || {};
  if (x.action === 'x402_refund_or_redeliver') return '入金済みだが納品できなかった1件（返金または再納品）';
  if (x.action === 'live_order') return '実口座の発注';
  if (x.action === 'fund_transfer') return '換金・資金移動';
  if (x.action === 'external_publish') return '外部への投稿・公開';
  if (x.action === 'account_signup') return 'アカウント登録';
  return x.summary || x.action || '承認要求';
}
function approvalDetail(x) {
  const p = x.payload || {};
  const bits = [];
  if (p.resource) bits.push(`品目 ${p.resource}`);
  if (p.amount != null) bits.push(`金額 ${(Number(p.amount) / 1e6).toFixed(2)} USDC`);
  if (p.tx) bits.push(`tx ${String(p.tx).slice(0, 12)}…`);
  if (p.error || p.detail) bits.push(`理由 ${p.error || p.detail}`);
  bits.push(`受付 ${esc(x.requested_at || '')}`);
  if (x.risk_level) bits.push(`リスク ${x.risk_level}`);
  return bits.join(' ・ ');
}

async function openApprovals() {
  const a = await api('/api/approvals', { quiet: true });
  const pending = (a?.approvals || []).filter((x) => x.status === 'pending');
  openSheetRaw('承認', `
    <div>
      <div class="sec-t">あなたの判断が必要な操作</div>
      ${pending.length ? `<div class="rows">${pending.map((x) => `<div class="row"><div class="row-main"><div class="row-t">${esc(approvalLabel(x))}</div><div class="row-s">${esc(approvalDetail(x))}</div><div class="btn-row" style="margin-top:8px"><button class="btn primary" data-ap-yes="${esc(x.id)}">承認する</button><button class="btn" data-ap-no="${esc(x.id)}">却下する</button></div></div><span class="badge warn">承認待ち</span></div>`).join('')}</div>`
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
  // 承認・却下はここで1タップ。押した瞬間にサーバーへ記録し、承認済みは次の実行で進める。
  document.querySelectorAll('[data-ap-yes],[data-ap-no]').forEach((b) => b.addEventListener('click', async () => {
    const yes = !!b.dataset.apYes;
    const id = b.dataset.apYes || b.dataset.apNo;
    const btns = document.querySelectorAll(`[data-ap-yes="${id}"],[data-ap-no="${id}"]`);
    btns.forEach((x) => { x.disabled = true; });
    const r = await api(`/api/approvals/${id}/decide`, { method: 'POST', body: { decision: yes ? 'approved' : 'rejected' }, quiet: true });
    if (r?.ok) {
      toast(yes ? '承認しました。エージェントが進めます' : '却下しました');
      await openApprovals();
      refreshSoon();
    } else { toast('記録できませんでした'); btns.forEach((x) => { x.disabled = false; }); }
  }));
}

// ------------------------------------------------------- コピー（貼り付けまでの一本道）
// アプリ内ブラウザなどで navigator.clipboard が通らない端末がある。
// ①タップの権限をそのまま使う同期コピー → ②非同期API → ③別タブで「長押し→全選択→コピー」の順に落とす。
function execCopy(t) {
  try {
    const ta = document.createElement('textarea');
    ta.value = String(t);
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, String(t).length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch { return false; }
}

/** 本文を控えに置いて、長押しでコピーできる別タブのURLを返す。 */
function copyHelperLink(text, title, url) {
  try {
    localStorage.setItem('wa_copybox', JSON.stringify({ text: String(text || ''), title: String(title || ''), url: String(url || ''), at: Date.now() }));
  } catch {}
  return '/copy';
}

/**
 * コピーを試す。同期パスが成功したらその場で true（await を挟むと無効になる環境があるため、
 * 呼び出し側は戻り値の Promise を待たずに window.open してよい）。
 */
function copySmart(text, opts = {}) {
  const t = String(text || '');
  if (!t) return Promise.resolve(false);
  if (execCopy(t)) return Promise.resolve(true);
  return (async () => {
    try { await navigator.clipboard.writeText(t); return true; } catch {}
    if (opts.box) { try { opts.box.hidden = false; opts.box.focus(); opts.box.select(); } catch {} }
    return false;
  })();
}

// ------------------------------------------------------- SNS（開いて押すだけ）
// エージェントは「開くリンク」と「貼る本文」までを用意し、押すのは人。既存の承認制は崩さない。
function snsItemHTML(it, i) {
  const url = it.url || '';
  // 媒体名はサーバーが返す値を使う。ここで決め打ちすると、媒体を足したときに
  // 別の媒体の名前で表示されてしまう（ココナラがYouTubeと表示されていた不具合）。
  const FALLBACK_UI = {
    x: { action: 'Xにポスト', cta: '開いて、ポストする', done: '投稿済みにする' },
    note: { action: 'noteに公開', cta: '開いて、公開する', done: '公開した' },
    coconala: { action: 'ココナラに出品', cta: '開いて、出品する', done: '出品した' },
    youtube: { action: 'YouTubeにアップロード', cta: '開いて、アップロードする', done: 'アップロードした' },
  };
  const fall = { action: '投稿する', cta: '開いて、進める', done: '完了にする' };
  const ui = (it.action ? { action: it.action, cta: it.cta, done: it.done_label } : FALLBACK_UI[it.channel]) || fall;
  const title = ui.action;
  const cta = ui.cta || '開く';
  const doneLabel = ui.done || '完了にする';
  const copyLabel = it.copy_label || (it.mode === 'paste' ? 'タイトルと本文をコピー' : '本文をコピー');
  const steps = (it.steps || []).map((s) => `<div class="row-s">${esc(s)}</div>`).join('');
  const xNote = it.channel === 'x'
    ? `<div class="row-s">重み付き ${esc(String(it.weighted ?? ''))} / ${esc(String(it.limit ?? 280))} 文字${it.truncated ? '（末尾のURLを残すため本文を短くしました）' : ''}</div>` : '';
  const studio = it.channel === 'youtube' ? `<button class="btn" type="button" data-studio="${i}">台本から動画を作る（無料）</button>` : '';
  const body = String(it.copy_text || '');
  return `<div class="row" style="display:block">
    <div class="row-t">${esc(title)}${it.channel_label ? ` <span class="badge">${esc(it.channel_label)}</span>` : ''}</div>
    <button class="btn primary wide" type="button" data-open="${i}" style="margin:8px 0">${esc(cta)}</button>
    ${steps}${xNote}
    <textarea class="copybox" data-body="${i}" readonly spellcheck="false" hidden>${esc(body)}</textarea>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn" type="button" data-show="${i}">本文を読む</button>
      <button class="btn" type="button" data-copy="${i}">${esc(copyLabel)}</button>
      <button class="btn" type="button" data-done="${esc(it.id || '')}">${esc(doneLabel)}</button>
      ${studio}
    </div>
    <div class="row-s" style="margin-top:6px">上のボタンは<b>本文をコピーしてから</b>画面を開きます（貼り付けて押すだけ）。コピーが効かない端末では <a href="#" data-helper="${i}">別のタブで開く</a> → 枠を長押し → 全選択 → コピー。</div>
    <div class="row-s" style="margin-top:4px"><a href="${esc(url)}" target="_blank" rel="noreferrer">リンクだけ開く</a>${it.fallback_url ? ` ・ <a href="${esc(it.fallback_url)}" target="_blank" rel="noreferrer">代替リンク</a>` : ''}</div>
  </div>`;
}

async function openSns() {
  const s = await api('/api/social', { quiet: true });
  if (!s || s.ok === false) {
    openSheetRaw('SNS投稿', '<div class="muted" style="font-size:13px">サーバーにつながりませんでした。「設定」→「この端末をつなぐ」でペアリングしてください。</div>');
    return;
  }
  const ch = s.by_channel || [];
  openSheetRaw('SNS投稿', `
    <div>
      <div class="sec-t">あなたの操作は「開いて押す」だけ</div>
      <div class="muted" style="font-size:12.5px">下書きと開くリンクはエージェントが用意します。ポストを押すのはあなたです（投稿は承認制のまま）。</div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" id="snsRefill">下書きをそろえる</button>
        <button class="btn primary" id="snsApprove">開くリンクを出す</button>
        <button class="btn ghost" id="snsScout">拾ったネタと試す計画</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">${s.outcomes?.recorded ? `記録済みの結果: ${esc(String(s.outcomes.recorded))}件（売れた ${esc(String(s.outcomes.sold || 0))} / 反応あり ${esc(String(s.outcomes.replied || 0))} / 反応なし ${esc(String(s.outcomes.no_reaction || 0))}）— 次の選別に効かせています。` : '投稿したら「開いた／出した／反応あり／売れた／反応なし」を記録してください。次に拾う候補の優先順位が変わります。'}</div>
    </div>
    <div>
      <div class="sec-t">いまの残り枠</div>
      <div class="rows">${ch.map((c) => `<div class="row"><div class="row-main"><div class="row-t">${esc(c.label)}</div><div class="row-s">${esc(c.human || '')}</div></div><span class="badge ${c.left > 0 ? 'ok' : 'warn'}">残り ${esc(String(c.left))}/${esc(String(c.limit))}</span></div>`).join('')}</div>
    </div>
    <div id="snsOut"><div class="muted" style="font-size:13px">「開くリンクを出す」を押すと、待ち行列${esc(String(s.one_tap_total || 0))}件ぶんのリンクが出ます。</div></div>
  `);
  state.snsItems = [];
  const render = (items) => {
    state.snsItems = items || [];
    $('#snsOut').innerHTML = state.snsItems.length
      ? `<div><div class="sec-t">タップで開く（${state.snsItems.length}件）</div><div class="rows">${state.snsItems.map((it, i) => `${snsItemHTML(it)}<div class="btn-row" data-outrow="${i}" style="margin:-2px 0 12px">${OUTCOME_BTNS}</div>`).join('')}</div></div>`
      : '<div class="muted" style="font-size:13px">出す材料がありません。「下書きをそろえる」を押してください。</div>';
    const snsRoot = $('#snsOut');
    const itemAt = (i) => state.snsItems[Number(i)] || {};
    const boxAt = (i) => snsRoot.querySelector(`[data-body="${Number(i)}"]`);
    const revealBox = (i) => { const b = boxAt(i); if (b) { b.hidden = false; try { b.focus(); b.select(); b.setSelectionRange(0, b.value.length); } catch {} } return b; };
    // 1タップで「コピー＋画面を開く」。await を挟むとポップアップが止められる環境があるので同期でコピーしてすぐ開く。
    $$('[data-open]', snsRoot).forEach((b) => b.addEventListener('click', () => {
      const i = b.dataset.open;
      const it = itemAt(i);
      const p = copySmart(String(it.copy_text || ''), { box: boxAt(i) });
      try { window.open(String(it.url || ''), '_blank', 'noopener'); } catch {}
      p.then((ok) => toast(ok
        ? '本文をコピーしました。開いた画面で貼り付けて押すだけです'
        : 'コピーできませんでした。「本文を読む」の枠を長押し → 全選択 → コピーしてください', ok ? 3400 : 5600));
    }));
    $$('[data-show]', snsRoot).forEach((b) => b.addEventListener('click', () => {
      const box = boxAt(b.dataset.show);
      if (!box) return;
      if (box.hidden) { revealBox(b.dataset.show); b.textContent = '本文を閉じる'; }
      else { box.hidden = true; b.textContent = '本文を読む'; }
    }));
    $$('[data-helper]', snsRoot).forEach((b) => b.addEventListener('click', (ev) => {
      ev.preventDefault();
      const it = itemAt(b.dataset.helper);
      window.open(copyHelperLink(it.copy_text, it.title || it.channel_label, it.url), '_blank', 'noopener');
    }));
    $$('[data-copy]', snsRoot).forEach((b) => b.addEventListener('click', async () => {
      const i = b.dataset.copy;
      const it = itemAt(i);
      const ok = await copySmart(String(it.copy_text || ''), { box: boxAt(i) });
      if (ok) toast('本文をコピーしました');
      else { revealBox(i); toast('この端末ではコピーが通りません。出ている枠を長押し → 全選択 → コピーしてください', 5600); }
    }));
    $$('[data-done]', $('#snsOut')).forEach((b) => b.addEventListener('click', async () => {
      if (!b.dataset.done) return;
      const r = await api('/api/publish/posted', { method: 'POST', body: { id: b.dataset.done }, quiet: true });
      if (r && r.ok !== false) { toast('投稿済みにしました'); b.disabled = true; refreshSoon(); }
      else toast('記録できませんでした');
    }));
    $$('[data-studio]', $('#snsOut')).forEach((b) => b.addEventListener('click', () => {
      const it = state.snsItems[Number(b.dataset.studio)] || {};
      openStudio({ title: it.title || '', script: String(it.copy_text || '') });
    }));
    // 結果の書き戻し。ここで押した内容が、次に拾う候補の優先順位に効く。
    $$('[data-out]', $('#snsOut')).forEach((b) => b.addEventListener('click', async () => {
      const i = Number(b.closest('[data-outrow]')?.dataset.outrow ?? -1);
      const it = state.snsItems[i] || {};
      const r = await api('/api/outcome', { method: 'POST', body: { draft_id: it.id, outcome: b.dataset.out }, quiet: true });
      if (r && r.ok !== false) toast(`${r.summary || '記録しました'}`, 3000);
      else toast('記録できませんでした', 3000);
    }));
  };
  $('#snsRefill').addEventListener('click', async () => {
    $('#snsRefill').disabled = true;
    const r = await api('/api/social/refill', { method: 'POST', body: {}, quiet: true });
    $('#snsRefill').disabled = false;
    const rep = r?.report || r || {};
    const made = (rep.created || []).length;
    if (!r) toast('そろえられませんでした（通信かサーバー側）', 4000);
    else if (made) toast(`下書きを${made}件そろえました`);
    else toast(`新しく作れた下書きは0件です。${rep.reason || ''}`, 4600);
  });
  $('#snsApprove').addEventListener('click', async () => {
    $('#snsApprove').disabled = true;
    const r = await api('/api/social/approve-all', { method: 'POST', body: {}, quiet: true });
    $('#snsApprove').disabled = false;
    if (!r) { toast('出せませんでした'); return; }
    render(r.approved || []);
    if (!(r.approved || []).length) toast('材料がありません。先に「下書きをそろえる」を押してください', 3600);
  });
  $('#snsScout')?.addEventListener('click', () => openScout());
}

// ------------------------------------------- 拾ったネタ（自動巡回）と「試す計画」
const OUTCOME_BTNS = [['opened', '開いた'], ['posted', '出した'], ['replied', '反応あり'], ['sold', '売れた'], ['no_reaction', '反応なし']]
  .map(([id, label]) => `<button class="btn" data-out="${id}">${label}</button>`).join('');

async function openScout() {
  const d = await api('/api/scout', { quiet: true });
  if (!d || d.ok === false) {
    openSheetRaw('拾ったネタ', '<div class="muted" style="font-size:13px">サーバーにつながりませんでした。設定からペアリングしてください。</div>');
    return;
  }
  const rows = d.findings || [];
  const bySrc = Object.entries(d.by_source || {}).sort((a, b) => b[1] - a[1]);
  const measured = d.loop?.measured_outcomes || 0;
  openSheetRaw('拾ったネタ（自動巡回）', `
    <div>
      <div class="sec-t">無料の巡回先から「金を払う人がいそうな話」だけ拾っています</div>
      <div class="muted" style="font-size:12.5px">鍵が要る所は使いません（原価0）。拾った候補は、既存の能力で「小さく試す計画」に自動で変換されます。</div>
      <div class="kpis with-head" style="margin-top:10px">
        <div class="kpi"><div class="kpi-v">${fmt(rows.length)}<small>件</small></div><div class="kpi-l">いまの候補</div></div>
        <div class="kpi"><div class="kpi-v">${fmt(d.source_count || 0)}<small>箇所</small></div><div class="kpi-l">巡回している先</div></div>
        <div class="kpi"><div class="kpi-v">${fmt(rows.filter((r) => (r.trial?.steps || []).length).length)}<small>件</small></div><div class="kpi-l">試す計画つき</div></div>
        <div class="kpi"><div class="kpi-v">0<small>円</small></div><div class="kpi-l">手順にかかる原価</div></div>
      </div>
    </div>
    <div>
      <div class="sec-t">試す価値のある順</div>
      ${rows.length ? `<div class="rows">${rows.slice(0, 12).map((r) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:13px">${esc(String(r.title || '').slice(0, 90))}</div><div class="row-s">${esc(r.source_label || r.source || '')} ・ 相性 ${esc((r.fits || []).join('/'))}${r.url ? ` ・ <a href="${esc(r.url)}" target="_blank" rel="noopener">開く</a>` : ''}${r.status && r.status !== 'new' ? ` ・ 状態 ${esc(r.status)}` : ''}</div>${(r.trial?.steps || []).length ? `<div class="row-s">試す計画: ${esc((r.trial.steps || []).map((x) => x.action).join(' → '))}</div><div class="row-s">人がやること: ${esc((r.trial.human_taps || []).join(' / ') || 'なし（下書きまで自動）')}</div>` : ''}</div><span class="badge ${r.score >= 50 ? 'ok' : 'ghost'}">${esc(String(r.score))}点</span></div>`).join('')}</div>` : '<div class="muted" style="font-size:13px">まだ候補がありません。巡回は180分おきに自動で回ります。</div>'}
    </div>
    <div>
      <div class="sec-t">巡回先の内訳</div>
      <div class="muted" style="font-size:12.5px">${bySrc.map(([k, v]) => `${esc(k)}: ${esc(String(v))}件`).join(' / ') || '—'}</div>
    </div>
    <div>
      <div class="sec-t">この輪のどこが自動で、どこが人か（正直に）</div>
      <div class="rows">
        <div class="row"><div class="row-main"><div class="row-t">巡回・採点・保存・「試す計画」</div></div><span class="badge ok">全自動</span></div>
        <div class="row"><div class="row-main"><div class="row-t">実行（投稿・出品・応募）</div><div class="row-s">凍結で入金経路ごと失うため、人の1タップを残しています</div></div><span class="badge warn">人が1タップ</span></div>
        <div class="row"><div class="row-main"><div class="row-t">結果の書き戻し（反応・成約）</div><div class="row-s">記録した結果が、次に拾う候補の優先順位に効きます（FXは実験ループが自動で閉じています）</div></div><span class="badge ${measured ? 'ok' : 'ghost'}">${measured ? `記録 ${esc(String(measured))}件` : 'まだ記録なし'}</span></div>
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn" id="scoutRefill">下書きをそろえる</button><button class="btn ghost" id="scoutSns">SNS投稿へ</button></div>
      <div class="muted" style="font-size:12px;margin-top:8px">巡回先は開発者コミュニティ（Hacker News / GitHub / dev.to / Qiita / Zenn / Product Hunt / Lobsters / Indie Hackers / MCPレジストリ）です。SNSの投稿そのものを巡回しているわけではありません。</div>
    </div>
  `);
  $('#scoutSns')?.addEventListener('click', () => openSns());
  $('#scoutRefill')?.addEventListener('click', async () => {
    $('#scoutRefill').disabled = true;
    const r = await api('/api/social/refill', { method: 'POST', body: {}, quiet: true });
    $('#scoutRefill').disabled = false;
    const rep = r?.report || r || {};
    const made = (rep.created || []).length;
    toast(made ? `下書きを${made}件そろえました` : `新しく作れた下書きは0件です。${rep.reason || ''}`, made ? 2600 : 4600);
  });
}

/** ブラウザ内で動画を作る（原価0）。台本はセッション経由でスタジオへ渡す。 */
function openStudio(payload) {
  try { sessionStorage.setItem('wa.studio', JSON.stringify({ token: state.token || '', ...payload })); } catch {}
  window.open('/studio.html', '_blank', 'noopener');
}

// ------------------------------------------------------- FX（どんな論理・どんな成績）
function fxKVs(m = {}) {
  const LABEL = {
    netProfitPct: '純益', profitFactor: 'プロフィットファクター', maxDrawdownPct: '最大ドローダウン',
    trades: '取引回数', winRatePct: '勝率', winRate: '勝率', expectancy: '期待値（1取引あたり）',
    avgWin: '平均利益', avgLoss: '平均損失', cagrPct: '年率換算', netProfit: '純益（金額）',
    grossProfit: '総利益', grossLoss: '総損失', bars: '本数',
  };
  const out = [];
  for (const [k, v] of Object.entries(m || {})) {
    if (typeof v !== 'number' || !isFinite(v)) continue;
    const pct = /Pct|Rate/.test(k);
    const val = /Rate/.test(k) && Math.abs(v) <= 1 ? `${Number((v * 100).toFixed(1))}%` : `${Number(v.toFixed(2))}${pct ? '%' : ''}`;
    out.push(kv(LABEL[k] || k, esc(val)));
  }
  return out.length ? out.join('') : '<div class="muted" style="font-size:13px">まだ記録がありません。</div>';
}

async function openFx() {
  const d = await api('/api/fx/lab', { quiet: true });
  if (!d || d.ok === false) {
    openSheetRaw('FX', '<div class="muted" style="font-size:13px">サーバーにつながりませんでした。設定からペアリングしてください。</div>');
    return;
  }
  const c = d.champion;
  const strat = d.strategies || [];
  const labelOf = (k) => (strat.find((s) => s.key === k)?.label || k);
  const howOf = (k) => (strat.find((s) => s.key === k)?.how || '');
  const best = d.best || [];
  const champParams = c ? Object.entries(c.params || {}).map(([k, v]) => kv(k, esc(String(v)))).join('') : '';
  const champBlock = c ? `
    <div>
      <div class="sec-t">いまの王者（自動で更新されます）</div>
      <div class="rows">
        <div class="row"><div class="row-main"><div class="row-t">${esc(c.symbol)} / ${esc(labelOf(c.strategy_key))}</div><div class="row-s">${esc(howOf(c.strategy_key))}</div></div><span class="badge ok">評価 ${esc(String(c.fitness ?? '—'))}</span></div>
      </div>
      <div style="margin-top:10px">${fxKVs(c.metrics)}</div>
      ${champParams ? `<div style="margin-top:8px"><div class="sec-t">いまのパラメータ</div>${champParams}</div>` : ''}
      ${c.walkforward ? `<div class="row-s" style="margin-top:8px">ウォークフォワード: ${esc(String(c.walkforward.netPositiveFolds))}/${esc(String(c.walkforward.totalFolds))} フォルダでプラス${c.walkforward.consistent ? '（一貫）' : '（不安定）'}</div>` : ''}
      ${c.promoted_to ? `<div class="row-s">昇格済み: fx_strategies に書き出しました（Pine / MQL5 の対象）</div>` : ''}
      <div class="muted" style="font-size:12px;margin-top:8px">ここから MT5 用の EA（.mq5）と設定ファイル（.set）を書き出せます。検証で終わらせないための出口です。</div>
      <div class="btn-row" style="margin-top:8px"><button class="btn primary" id="fxEa">EA（MQL5）を書き出す</button></div>
    </div>` : `<div><div class="sec-t">いまの王者</div><div class="muted" style="font-size:13px">まだ門を通過した候補がありません。「今すぐ試させる」を押すと実験が始まります。</div></div>`;

  openSheetRaw('FX（考え方と成績）', `
    <div>
      <div class="sec-t">このエージェントのやり方</div>
      <div class="muted" style="font-size:12.5px">完成品を置くのではなく、少数の実験を繰り返して強い組み合わせを探し続けます。負けた実験も残し、「次に試さないこと」の判断に使います。使うのは無料の市場データだけで、原価は0円です。</div>
      <div class="kpis with-head" style="margin-top:10px">
        <div class="kpi"><div class="kpi-v">${fmt(d.total_experiments || 0)}<small>件</small></div><div class="kpi-l">試した組み合わせ</div></div>
        <div class="kpi"><div class="kpi-v">${fmt(d.passed || 0)}<small>件</small></div><div class="kpi-l">門を通過${d.pass_rate != null ? `（${esc(String(d.pass_rate))}%）` : ''}</div></div>
        <div class="kpi"><div class="kpi-v">${fmt(d.stats?.runs || 0)}<small>回</small></div><div class="kpi-l">自動で回った反復</div></div>
        <div class="kpi"><div class="kpi-v">${fmt(d.stats?.improvements || 0)}<small>回</small></div><div class="kpi-l">王者が更新された回数</div></div>
      </div>
    </div>
    ${champBlock}
    <div>
      <div class="sec-t">成績の上位（過去データでの検証）</div>
      ${best.length ? `<div class="rows">${best.map((b) => `<div class="row"><div class="row-main"><div class="row-t">${esc(b.symbol)} / ${esc(labelOf(b.strategy_key))}</div><div class="row-s">純益 ${esc(String(b.metrics?.netProfitPct ?? '—'))}% ・ PF ${esc(String(b.metrics?.profitFactor ?? '—'))} ・ 最大DD ${esc(String(b.metrics?.maxDrawdownPct ?? '—'))}% ・ ${esc(String(b.metrics?.trades ?? '—'))}取引${b.promoted ? ' ・ 昇格済み' : ''}</div>${b.verdict !== 'pass' && (b.gates || []).length ? `<div class="row-s">見送り理由: ${esc((b.gates || []).join(' / '))}</div>` : ''}</div><span class="badge ${b.verdict === 'pass' ? 'ok' : 'ghost'}">${b.verdict === 'pass' ? '門を通過' : '見送り'}</span></div>`).join('')}</div>`
        : '<div class="muted" style="font-size:13px">まだ実験の記録がありません。</div>'}
    </div>
    <div>
      <div class="sec-t">何を探しているか（探索範囲）</div>
      <div class="rows">${strat.map((s) => `<div class="row"><div class="row-main"><div class="row-t">${esc(s.label)}</div><div class="row-s">${esc(s.how)}</div><div class="row-s">入り口 ${esc(s.entry)} ／ 出口 ${esc(s.exit)}</div><div class="row-s">グリッド ${esc(String(s.combo_count))}通り${Object.keys(s.grid || {}).length ? `（${Object.entries(s.grid).map(([k, v]) => `${k}: ${(v || []).join('/')}`).join(' ・ ')}）` : ''}＋ATRストップ・逆張り可否を連続でサンプル</div></div></div>`).join('')}</div>
      <div class="muted" style="font-size:12.5px;margin-top:8px">銘柄: ${esc((d.symbols || []).map((x) => x.symbol).join(' / '))}${d.cost ? ` ／ 費用: ${esc(d.cost)}` : ''}</div>
    </div>
    <div>
      <div class="sec-t">次に試す予定（自動）</div>
      <div class="rows">${(d.next || []).map((n) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:13px">${esc(n.what)}</div><div class="row-s">狙い: ${esc(n.expected)}</div></div><span class="badge ghost">${esc(n.tag)}</span></div>`).join('')}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="fxTick">今すぐ試させる</button></div>
      <div class="muted" style="font-size:12px;margin-top:8px">過去データの成績は将来の利益を保証しません。実口座の発注はしていません（研究と検証のみ）。</div>
    </div>
  `);
  $('#fxTick')?.addEventListener('click', async () => {
    $('#fxTick').disabled = true;
    const r = await api('/api/fx/lab/tick', { method: 'POST', body: { n: 2 }, quiet: true });
    if (r && r.ok !== false) { toast(`${r.ran || 0}件の実験を回しました${r.improved ? '（王者を更新）' : ''}`); await openFx(); }
    else { toast('回せませんでした'); $('#fxTick').disabled = false; }
  });
  $('#fxEa')?.addEventListener('click', async () => {
    $('#fxEa').disabled = true;
    const r = await api('/api/fx/ea', { method: 'POST', body: {}, quiet: true });
    $('#fxEa').disabled = false;
    if (r && r.ok !== false) openEa(r);
    else toast(r?.summary || '書き出せませんでした', 3600);
  });
}

// --------------------------------------------------- EA（MQL5）の書き出し画面
function openEa(d) {
  const chk = (d.lint?.checks || []).map((c) => `<div class="row"><div class="row-main"><div class="row-t" style="font-size:12.5px">${esc(c.note)}</div></div><span class="badge ${c.ok ? 'ok' : 'warn'}">${c.ok ? 'OK' : '要確認'}</span></div>`).join('');
  const paramsText = Object.entries(d.params || {}).map(([k, v]) => kv(k, esc(String(v)))).join('');
  openSheetRaw('EA（MQL5）の書き出し', `
    <div>
      <div class="sec-t">${esc(d.filename || 'ea.mq5')}</div>
      <div class="muted" style="font-size:12.5px">${esc(d.symbol || '')} / ${esc(d.strategy_label || d.strategy_key || '')} / ${esc(d.timeframe || '')}。過去データの検証を通過した王者を、そのままMT5で動く形に落としたものです。</div>
      ${paramsText ? `<div style="margin-top:8px">${paramsText}</div>` : ''}
    </div>
    <div>
      <div class="sec-t">MT5での手順</div>
      <div class="rows">
        <div class="row"><div class="row-main"><div class="row-t">1. コードを保存</div><div class="row-s">「コードをコピー」して、MT5 の ファイル → データフォルダを開く → MQL5\Experts\ に <b>${esc(d.filename || '')}</b> として保存</div></div></div>
        <div class="row"><div class="row-main"><div class="row-t">2. コンパイル</div><div class="row-s">MetaEditor で開いて F7。警告とエラーを確認します（私の環境にMT5が無いので、コンパイル確認はできていません）</div></div></div>
        <div class="row"><div class="row-main"><div class="row-t">3. 設定ファイル</div><div class="row-s"><b>${esc(d.set_filename || '')}</b> も保存（EAの「読み込み」で使えます）</div></div></div>
        <div class="row"><div class="row-main"><div class="row-t">4. まずデモ口座で前向きに検証</div><div class="row-s">日足・スプレッド固定という前提なので、実口座のスワップ・約定差・週末の窓は別物です。いきなり実資金を入れないでください</div></div></div>
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="eaCopy">コードをコピー</button><button class="btn" id="eaCopySet">設定ファイルをコピー</button></div>
      <div class="muted" style="font-size:12px;margin-top:8px">構造の自己点検: 重大な問題は${d.lint?.ok ? '見つかっていません' : '残っています（要確認）'}。</div>
    </div>
    <div>
      <div class="sec-t">自己点検（構造）</div>
      <div class="rows">${chk || '<div class="muted" style="font-size:13px">—</div>'}</div>
    </div>
    <div>
      <div class="sec-t">コード（${esc(d.strategy_key || '')}）</div>
      <pre style="max-height:320px;overflow:auto;font-size:11px;line-height:1.45;background:rgba(127,127,127,.08);padding:10px;border-radius:8px;white-space:pre">${esc(String(d.mq5_code || ''))}</pre>
    </div>
    <div class="row-s" style="margin-top:6px">コピーが効かない端末では <a href="#" id="eaHelper">別のタブで開く</a> → 枠を長押し → 全選択 → コピー。</div>
    <div><div class="muted" style="font-size:12px">過去データの成績は将来の利益を保証しません。このEAは発注を自動化する道具で、勝ちを約束するものではありません。</div></div>
  `);
  $('#eaCopy')?.addEventListener('click', async () => {
    const ok = await copySmart(String(d.mq5_code || ''));
    toast(ok ? 'EAのコードをコピーしました' : 'この端末ではコピーが通りません。「別のタブで開く」→ 枠を長押し → 全選択 → コピー', ok ? 1800 : 5600);
  });
  $('#eaCopySet')?.addEventListener('click', async () => {
    const ok = await copySmart(String(d.set_code || ''));
    toast(ok ? '設定ファイルをコピーしました' : 'この端末ではコピーが通りません。「別のタブで開く」→ 枠を長押し → 全選択 → コピー', ok ? 1800 : 5600);
  });
  $('#eaHelper')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    window.open(copyHelperLink(d.mq5_code, d.filename || 'EA'), '_blank', 'noopener');
  });
}

// ------------------------------------------------------------------ composer

function bind() {
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send($('#input').value); });
  const ta = $('#input');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`; syncSend(); });
  $('#attachBtn').addEventListener('click', () => $('#fileIn').click());
  $('#fileIn').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  const main = $('.main-col');
  ['dragenter', 'dragover'].forEach((t) => main.addEventListener(t, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); main.classList.add('drop'); } }));
  ['dragleave', 'drop'].forEach((t) => main.addEventListener(t, (e) => { if (t === 'dragleave' && main.contains(e.relatedTarget)) return; main.classList.remove('drop'); }));
  main.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer?.files); });
  $$('.send,.icon-btn,.newchat').forEach((b) => b.addEventListener('pointerdown', ripple));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
  });
  $('#moreBtn').addEventListener('click', () => openSheet('settings'));
  $('#avaBtn').addEventListener('click', () => openAgent());
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
  // 通信が遅くても起動画面で止まらない（最長1.2秒で画面を出す）。
  setTimeout(() => document.body.classList.add('ready'), 1200);
  bind();
  renderChips();
  await Promise.all([refresh({ quiet: true }), loadThreads()]);
  // トークンが古い（401）ときは、黙って失敗させずに再接続の入口を出す。
  const who = await api('/api/owner/whoami', { quiet: true }).catch(() => null);
  if (state.token && who && who.ok === false) {
    setTimeout(() => push({ role: 'agent', text: 'この端末のトークンが変わっています。「⋯」→「この端末をつなぐ」にペアリングコードを入れると復帰します。', action: 'settings' }), 300);
  }
  renderThread();
  scrollDown(false);
  document.body.classList.add('ready');
  // 直リンク: #agent でエージェント設定、#settings で端末設定を開く。
  {
    const want = (location.hash || '').slice(1) || new URL(location.href).searchParams.get('open') || '';
    if (/^(agent|settings|work|mode|watch|approvals|sns|fx|scout)$/.test(want)) openSheet(want);
  }
  setTimeout(() => $('#splash')?.remove(), 900);
  if (!state.token) {
    setTimeout(() => push({ role: 'agent', text: 'はじめての端末ですね。「⋯」からアクセストークンを貼り付けると、あなた専用のエージェントとして動きます。', action: 'settings' }), 400);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  setInterval(() => { refresh({ quiet: true }); renderFoot(); checkNotifications(); }, 20000);
}

boot();
