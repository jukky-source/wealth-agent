// public/lab.js — バックテスト作業台のクライアント（2つのタブ: E8モード / 自己資金モード）
//
// ここだけ覚えれば使える:
//   * 左の「ロジック」に行を積む（銘柄 × 時間軸 × 論理 × 出口 × 方向 × 重み）。
//   * 「走らせる」で、モードごとの結論まで出る（E8なら合否・支払い、自己資金なら倍率・撤退）。
//   * 「試行錯誤（探索）」は、候補を無作為に作って順位とヒートマップを返す。
//   * 「出口の最適化」「堅牢性の検証」「保存/読込」「CSV書き出し」。
// サーバー: /api/lab/*（オーナートークンが要る。アプリ本体と同じ localStorage:wa_token）

const LS_TOKEN = 'wa_token';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const S = {
  token: '', catalog: null, mode: null, busy: false,
  m: {
    e8: blank(), own: blank(),
  },
};
function blank() {
  return { rows: [], settings: {}, options: {}, results: null, board: [], projects: [], replay: null, status: '', built: false, searchN: 8 };
}

// ---------------------------------------------------------------------------
// 小さな道具
// ---------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const f2 = (v) => (v == null || v === '' ? '—' : Number(v).toFixed(2));
const f1 = (v) => (v == null || v === '' ? '—' : Number(v).toFixed(1));
const pct = (v) => (v == null || v === '' ? '—' : `${Number(v).toFixed(2)}%`);
const yen = (v) => (v == null || v === '' ? '—' : `¥${Math.round(Number(v)).toLocaleString('ja-JP')}`);
const usd = (v) => (v == null || v === '' ? '—' : `$${Math.round(Number(v)).toLocaleString('en-US')}`);
const sgn = (v) => (n(v) >= 0 ? 'good' : 'bad');
const kpi = (k, v, s = '', c = '') => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${c}">${v}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`;

// ---------------------------------------------------------------------------
// 通信
// ---------------------------------------------------------------------------
async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok) throw new Error(`${r.status} ${(j && (j.detail || j.error)) || r.statusText}`);
  if (j && j.ok === false) throw new Error(j.detail || j.error || 'error');
  return j;
}

function setStatus(mode, msg) {
  S.m[mode].status = msg;
  const el = $(`#panel-${mode} [data-status]`);
  if (el) el.textContent = msg;
}
function conn(ok, txt) {
  const el = $('#conn');
  el.textContent = txt;
  el.className = ok ? 'good' : 'dim';
}

// ---------------------------------------------------------------------------
// 設定・オプション・行の定義（フォームを1か所で決める）
// ---------------------------------------------------------------------------
function cfgSpec(mode) {
  if (mode === 'e8') {
    return [
      { k: 'profile', label: '規格（E8 One）', type: 'select', opts: () => (S.catalog.e8.profiles || []).map((p) => ({ v: p.key, t: `${p.label}（最大損失${p.maxLossPct}% / 目標${p.targetPct}% / 日次${p.dailyLossPct}%）` })) },
      { k: 'accountSize', label: '口座サイズ(USD)', type: 'number', step: 1000 },
      { k: 'scale', label: '建玉倍率（1.0＝設計どおり）', type: 'number', step: 0.25 },
      { k: 'monthly', label: '', type: 'spacer' },
      { k: 'months', label: '資金提供後の観測(月)', type: 'number', step: 1 },
      { k: 'trials', label: 'ブートストラップ回数', type: 'number', step: 50 },
      { k: 'dailyBase', label: '日次損失の基準', type: 'select', opts: () => [{ v: 'initial', t: '初期残高基準' }, { v: 'balance', t: '当日残高基準' }] },
    ];
  }
  return [
    { k: 'capitalJPY', label: '元本(円)', type: 'number', step: 10000 },
    { k: 'riskMultiple', label: '建玉倍率', type: 'number', step: 0.5 },
    { k: 'targetMultiple', label: '目標(倍)', type: 'number', step: 0.5 },
    { k: 'months', label: '観測(月)', type: 'number', step: 1 },
    { k: 'ruinFloorPct', label: '撤退ライン（元本の%）', type: 'number', step: 5 },
    { k: 'units', label: '基準の通貨数', type: 'number', step: 1000 },
    { k: 'leverage', label: 'レバレッジ', type: 'number', step: 100 },
    { k: 'rate', label: 'USDJPY', type: 'number', step: 1 },
  ];
}
const OPT_SPEC = [
  { k: 'days', label: 'データ本数（日足）', type: 'number', step: 100 },
  { k: 'spreadPips', label: 'スプレッド(pip)', type: 'number', step: 0.1 },
  { k: 'slippagePips', label: 'スリッページ(pip)', type: 'number', step: 0.1 },
  { k: 'commissionJPY', label: '手数料/取引(円)', type: 'number', step: 10 },
  { k: 'stressMult', label: '費用の倍率（ストレス）', type: 'number', step: 0.5 },
  { k: 'oosFrac', label: 'OOSの割合', type: 'number', step: 0.05 },
];

function fieldHtml(f, value, attr) {
  if (f.type === 'spacer') return '';
  const v = value == null ? '' : value;
  if (f.type === 'select') {
    const opts = f.opts();
    return `<label class="f">${esc(f.label)}<br><select ${attr}="${f.k}">${opts.map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(v) ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}</select></label>`;
  }
  return `<label class="f">${esc(f.label)}<br><input type="number" step="${f.step || 'any'}" ${attr}="${f.k}" value="${esc(v)}" /></label>`;
}

// ---------------------------------------------------------------------------
// 初期値（カタログから作る。特定のキーに依存しない）
// ---------------------------------------------------------------------------
function initMode(mode) {
  const c = S.catalog;
  const st = S.m[mode];
  if (st.built) return;
  const syms = (c.symbols || []).slice();
  const pick = (name, i) => (syms.includes(name) ? name : syms[i % syms.length]);
  const strs = (c.strategies || []).slice();
  const mk = (si, symbol, exit, tf) => {
    const s = strs[si % strs.length];
    if (!s) return null;
    return { symbol, tf, strategy: s.key, variant: (s.variants[0] || {}).variant || 0, filter: 'none', exit, dir: 'both', weight: 1 };
  };
  st.options = {
    days: n(c.data.days, 1600),
    spreadPips: n((c.cost.defaults || {}).spreadPips, 0.3),
    slippagePips: n((c.cost.defaults || {}).slippagePips, 0.2),
    commissionJPY: n((c.cost.defaults || {}).commissionJPY, 0),
    stressMult: 1,
    oosFrac: 0.3,
  };
  st.settings = mode === 'e8'
    ? { ...(c.e8.defaults || {}) }
    : { ...(c.own.defaults || {}) };
  if (st.settings.targetMultiple == null) st.settings.targetMultiple = 1;
  st.rows = (mode === 'e8'
    ? [mk(0, pick('USDJPY', 0), 'balanced', '1d'), mk(1, pick('GOLD', 4), 'tight', '1d'), mk(2, pick('CHFJPY', 11), 'balanced', '1w')]
    : [mk(0, pick('USDJPY', 0), 'balanced', '1d'), mk(1, pick('GOLD', 4), 'tight', '1d')]
  ).filter(Boolean);
  st.built = true;
}

// ---------------------------------------------------------------------------
// 画面（タブと2つのパネル）
// ---------------------------------------------------------------------------
function renderTabs() {
  const modes = S.catalog.modes;
  $('#tabs').innerHTML = modes.map((m) => `<button class="tab${S.mode === m.key ? ' on' : ''}" data-mode="${m.key}"><b>${esc(m.label)}</b><span>${esc(m.blurb)}</span></button>`).join('');
}

function rowHtml(mode, r, i) {
  const c = S.catalog;
  const isRule = r.kind === 'rule';
  const strat = (c.strategies || []).find((s) => s.key === r.strategy) || (c.strategies || [])[0] || { key: '', label: '', variants: [] };
  const variant = (strat.variants || []).find((v) => Number(v.variant) === Number(r.variant)) || (strat.variants || [])[0] || { params: {} };
  const params = Object.entries(variant.params || {}).filter(([, v]) => Number.isFinite(Number(v))).slice(0, 6);
  const selSym = (c.symbols || []).map((s) => `<option${s === r.symbol ? ' selected' : ''}>${esc(s)}</option>`).join('');
  const selTf = (c.timeframes || []).map((t) => `<option value="${t.key}"${t.key === r.tf ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  const selBase = (c.strategies || []).map((s) => `<option value="${esc(s.key)}"${s.key === r.strategy ? ' selected' : ''}>${esc(s.label || s.key)}</option>`).join('');
  const selVar = (strat.variants || []).map((v) => `<option value="${v.variant}"${Number(v.variant) === Number(r.variant) ? ' selected' : ''}>preset ${v.variant}${v.variant === 1 ? '（小さい方）' : v.variant === 2 ? '（大きい方）' : ''}</option>`).join('');
  const selEx = (c.exits || []).map((e) => `<option value="${e.key}"${e.key === r.exit ? ' selected' : ''}>${esc(e.label)}</option>`).join('');
  const selDir = (c.directions || []).map((d) => `<option value="${d.key}"${d.key === r.dir ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
  const selFil = (c.filters || []).map((f) => `<option value="${f.key}"${f.key === r.filter ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
  const selFeat = (c.features || []).map((f) => `<option value="${f.key}"${f.key === r.feature ? ' selected' : ''}>${esc(f.label)}</option>`).join('');
  return `<div class="rowitem" data-row="${i}">
    <div class="hd"><b>${i + 1}. ${esc(r.symbol || '')} / ${esc(isRule ? '合成論理' : (strat.label || r.strategy))}</b>
      <span><button class="ghost" data-act="random" data-row="${i}" title="値を振り直す">乱数</button>
      <button class="ghost" data-act="delrow" data-row="${i}" title="削除">削除</button></span></div>
    <div class="grid3">
      <label class="f">銘柄<br><select data-f="symbol" data-row="${i}">${selSym}</select></label>
      <label class="f">時間軸<br><select data-f="tf" data-row="${i}">${selTf}</select></label>
      <label class="f">種別<br><select data-f="kind" data-row="${i}"><option value="core"${isRule ? '' : ' selected'}>既知ロジック</option><option value="rule"${isRule ? ' selected' : ''}>合成論理（部品2つ）</option></select></label>
    </div>
    ${isRule
      ? `<label class="f">仮説（この特徴量だけで組む）<br><select data-f="feature" data-row="${i}">${selFeat}</select></label>`
      : `<div class="grid2"><label class="f">論理<br><select data-f="strategy" data-row="${i}">${selBase}</select></label><label class="f">preset<br><select data-f="variant" data-row="${i}">${selVar}</select></label></div>
         ${params.length ? `<div class="grid3">${params.map(([k, v]) => `<label class="f">${esc(k)}<br><input type="number" data-p="${k}" data-row="${i}" value="${esc(v)}" /></label>`).join('')}</div>` : ''}`}
    <label class="f">絞り込み<br><select data-f="filter" data-row="${i}">${selFil}</select></label>
    <label class="f">出口<br><select data-f="exit" data-row="${i}">${selEx}</select></label>
    <div class="grid2">
      <label class="f">方向<br><select data-f="dir" data-row="${i}">${selDir}</select></label>
      <label class="f">重み<br><input type="number" step="0.25" data-f="weight" data-row="${i}" value="${esc(r.weight == null ? 1 : r.weight)}" /></label>
    </div>
  </div>`;
}

function panelHtml(mode) {
  const c = S.catalog;
  const st = S.m[mode];
  const modeMeta = (c.modes || []).find((x) => x.key === mode) || {};
  return `
  <div class="grid">
    <div>
      <div class="card">
        <p class="sec-t">${esc(modeMeta.label || mode)}の設定</p>
        <div class="grid2">${cfgSpec(mode).map((f) => fieldHtml(f, st.settings[f.k], 'data-cfg')).join('')}</div>
        <p class="hint">${mode === 'e8'
          ? 'E8 One の規則（最大損失・日次・目標）を、下のロジックに当てて選考を再生します。'
          : '自分の資金を建玉倍率ぶんのリスクで複利運用したときの数字です。撤退ラインは元本の何%を割ったら撤退するか。'}</p>
      </div>

      <div class="card">
        <p class="sec-t">データと費用</p>
        <div class="grid2">${OPT_SPEC.map((f) => fieldHtml(f, st.options[f.k], 'data-opt')).join('')}</div>
        <p class="hint">約定は「確定バーの終値で判断 → 翌バー始値」。費用の倍率を2にすると、スプレッド・スリッページ・手数料が2倍の世界で試せます（ストレス）。</p>
      </div>

      <div class="card">
        <p class="sec-t">ロジック（積んだ行を1つの口座で回す）</p>
        <div data-rows>${st.rows.map((r, i) => rowHtml(mode, r, i)).join('') || '<p class="hint">行がありません。</p>'}</div>
        <div class="row">
          <button data-act="addrow">行を足す</button>
          <button data-act="addrule">合成論理の行を足す</button>
        </div>
      </div>

      <div class="card">
        <p class="sec-t">実行</p>
        <div class="row">
          <button class="primary" data-act="run">走らせる</button>
          <button data-act="search">試行錯誤（探索）</button>
          <button data-act="robust" title="Walk Forward / Monte Carlo / 費用1.5倍 / 検証11項目">堅牢性の検証</button>
          <button data-act="exit" title="損切り・利確・保有日数を振って最良を探す">出口の最適化</button>
        </div>
        <div class="row">
          <label class="f">探索の件数<br><input type="number" min="1" max="24" data-f="searchN" data-row="-1" value="${esc(st.searchN)}" /></label>
          <button data-act="tick">背景ループを1回回す</button>
          <button data-act="refresh">順位表を読む</button>
        </div>
        <div class="bar"><i data-progress></i></div>
        <div class="status" data-status>${esc(st.status || '')}</div>
      </div>

      <div class="card">
        <p class="sec-t">保存した作品</p>
        <div class="row">
          <input type="text" data-f="projName" data-row="-1" placeholder="名前（例: e8-gold-1d-tight）" />
          <button data-act="save">保存</button>
          <button data-act="load">読込</button>
          <button data-act="projects">一覧</button>
        </div>
        <div data-projects class="hint"></div>
      </div>

      <details>
        <summary>この作業台の前提と、入っていないもの</summary>
        <p class="hint">${(c.assumptions || []).map((a) => esc(a)).join('<br>')}</p>
        <p class="hint"><b>入っていないもの</b><br>${(c.notIncluded || []).map((a) => esc(a)).join('<br>')}</p>
        <p class="hint">採点の式<br>自己資金: ${esc(c.objectives.own)}<br>E8: ${esc(c.objectives.e8)}</p>
        <p class="hint">論理空間の広さ: コア層 ${n(c.space.core).toLocaleString()} 通り / 合成層 ${n(c.space.rule).toLocaleString()} 通り（部品 ${n(c.atoms).toLocaleString()} 種）</p>
      </details>
    </div>

    <div>
      <div class="card">
        <p class="sec-t">${mode === 'e8' ? 'E8 One の選考（再生）' : '自己資金の運用'}</p>
        <div data-res><p class="hint">「走らせる」を押すと、ここに結果が出ます。</p></div>
      </div>
      <div class="card">
        <p class="sec-t">試行錯誤の地図</p>
        <div data-search><p class="hint">「試行錯誤（探索）」を押すと、候補の順位と通貨×時間足の地図が出ます。</p></div>
      </div>
      <div class="card">
        <p class="sec-t">貯まった候補（このモードの順位表）</p>
        <div data-board><p class="hint">まだありません。</p></div>
      </div>
    </div>
  </div>`;
}

function show(mode) {
  S.mode = mode;
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === mode));
  ['e8', 'own'].forEach((m) => $(`#panel-${m}`).classList.toggle('hidden', m !== mode));
  if (!S.m[mode].built) { initMode(mode); $(`#panel-${mode}`).innerHTML = panelHtml(mode); }
  renderBoard(mode);
}

// ---------------------------------------------------------------------------
// DOM ⇄ state（入力は「操作の直前に読む」）
// ---------------------------------------------------------------------------
function syncFromDom(mode) {
  const st = S.m[mode];
  const root = $(`#panel-${mode}`);
  $$('[data-cfg]', root).forEach((el) => { st.settings[el.dataset.cfg] = el.type === 'number' ? n(el.value, st.settings[el.dataset.cfg]) : el.value; });
  $$('[data-opt]', root).forEach((el) => { st.options[el.dataset.opt] = el.type === 'number' ? n(el.value, st.options[el.dataset.opt]) : el.value; });
  const sn = $('[data-f="searchN"]', root);
  if (sn) st.searchN = Math.max(1, Math.min(24, n(sn.value, st.searchN)));
  $$('[data-row]', root).forEach((el) => {
    const i = Number(el.dataset.row);
    if (i < 0) return;
    const f = el.dataset.f;
    if (!f || !st.rows[i]) return;
    st.rows[i][f] = f === 'variant' || f === 'weight' ? n(el.value, 1) : el.value;
  });
  $$('[data-p]', root).forEach((el) => {
    const i = Number(el.dataset.row);
    if (!st.rows[i]) return;
    st.rows[i].params = st.rows[i].params || {};
    st.rows[i].params[el.dataset.p] = n(el.value, 0);
  });
}

function redrawRows(mode) {
  const root = $(`#panel-${mode} [data-rows]`);
  if (!root) return;
  root.innerHTML = S.m[mode].rows.map((r, i) => rowHtml(mode, r, i)).join('') || '<p class="hint">行がありません。</p>';
}

// ---------------------------------------------------------------------------
// グラフ（canvas）
// ---------------------------------------------------------------------------
function prep(cv, h) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth || 640;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.height = `${h}px`;
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = '10px ui-monospace, monospace';
  return { c, w, h };
}

function lineChart(cv, ys, o = {}) {
  const h = o.h || 200;
  const { c, w } = prep(cv, h);
  const vals = ys.filter((v) => Number.isFinite(v));
  if (!vals.length) { c.fillStyle = '#a5a19a'; c.fillText('データなし', 10, 20); return; }
  const pad = { l: 46, r: 10, t: 12, b: 18 };
  let lo = o.yMin != null ? o.yMin : Math.min(...vals);
  let hi = o.yMax != null ? o.yMax : Math.max(...vals);
  for (const b of o.bands || []) { if (Number.isFinite(b.v)) { lo = Math.min(lo, b.v); hi = Math.max(hi, b.v); } }
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const pad2 = (hi - lo) * 0.06; lo -= pad2; hi += pad2;
  const X = (i) => pad.l + (i / Math.max(1, ys.length - 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  c.strokeStyle = '#2a2a30'; c.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const yy = pad.t + (g / 3) * (h - pad.t - pad.b);
    c.beginPath(); c.moveTo(pad.l, yy); c.lineTo(w - pad.r, yy); c.stroke();
    c.fillStyle = '#6f6b64';
    c.fillText(Number(hi - (g / 3) * (hi - lo)).toFixed(lo < 10 ? 2 : 0), 4, yy + 3);
  }
  for (const b of o.bands || []) {
    if (!Number.isFinite(b.v)) continue;
    c.strokeStyle = b.color || '#3a3a42'; c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(pad.l, Y(b.v)); c.lineTo(w - pad.r, Y(b.v)); c.stroke();
    c.setLineDash([]);
    c.fillStyle = b.color || '#6f6b64';
    c.fillText(b.label || '', pad.l + 4, Y(b.v) - 3);
  }
  if (o.fill) {
    c.beginPath(); c.moveTo(X(0), Y(ys[0] == null ? lo : ys[0]));
    ys.forEach((v, i) => c.lineTo(X(i), Y(Number.isFinite(v) ? v : lo)));
    c.lineTo(X(ys.length - 1), h - pad.b); c.lineTo(X(0), h - pad.b); c.closePath();
    c.fillStyle = o.fill; c.fill();
  }
  c.strokeStyle = o.color || '#e8a33d'; c.lineWidth = 1.6; c.beginPath();
  let started = false;
  ys.forEach((v, i) => {
    if (!Number.isFinite(v)) { started = false; return; }
    if (!started) { c.moveTo(X(i), Y(v)); started = true; } else c.lineTo(X(i), Y(v));
  });
  c.stroke();
  if (o.marks) for (const mk of o.marks) {
    const i = mk.i; if (i == null || i < 0 || i >= ys.length) continue;
    const v = Number.isFinite(ys[i]) ? ys[i] : lo;
    c.fillStyle = mk.color || '#d9483b';
    c.beginPath(); c.arc(X(i), Y(v), 3, 0, Math.PI * 2); c.fill();
    if (mk.label) { c.fillText(mk.label, Math.min(w - 60, X(i) + 5), Y(v) - 5); }
  }
  if (o.labels && o.labels.length === 2) {
    c.fillStyle = '#6f6b64';
    c.fillText(String(o.labels[0]), pad.l, h - 5);
    const t = String(o.labels[1]); c.fillText(t, w - pad.r - c.measureText(t).width, h - 5);
  }
}

function drawReplay(mode) {
  const st = S.m[mode];
  const rep = st.replay;
  const cv = $(`#panel-${mode} [data-cv="replay"]`);
  if (!cv || !rep || !rep.bars || !rep.bars.length) return;
  const i = Math.max(2, Math.min(rep.i == null ? rep.bars.length : rep.i, rep.bars.length));
  const h = 250;
  const { c, w } = prep(cv, h);
  const bars = rep.bars.slice(0, i);
  const pad = { l: 8, r: 46, t: 10, b: 16 };
  let lo = Infinity; let hi = -Infinity;
  for (const b of bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  for (const t of (rep.trades || [])) {
    if (t.entryDate < bars[0].date) continue;
    if (t.entryDate > bars[bars.length - 1].date) continue;
    lo = Math.min(lo, t.entry, t.exit); hi = Math.max(hi, t.entry, t.exit);
  }
  const pad2 = (hi - lo) * 0.05 || 0.001; lo -= pad2; hi += pad2;
  const X = (k) => pad.l + (k / Math.max(1, bars.length - 1)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const bw = Math.max(1.2, (w - pad.l - pad.r) / bars.length * 0.62);
  for (let k = 0; k < bars.length; k++) {
    const b = bars[k];
    const up = b.c >= b.o;
    c.strokeStyle = up ? '#5fbf7f' : '#d9483b';
    c.fillStyle = up ? 'rgba(95,191,127,.55)' : 'rgba(217,72,59,.55)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(X(k), Y(b.h)); c.lineTo(X(k), Y(b.l)); c.stroke();
    const y1 = Y(b.o); const y2 = Y(b.c);
    c.fillRect(X(k) - bw / 2, Math.min(y1, y2), bw, Math.max(1.5, Math.abs(y2 - y1)));
  }
  for (const t of (rep.trades || [])) {
    if (t.entryDate > bars[bars.length - 1].date) continue;
    const isLong = t.dir > 0;
    const col = n(t.pnlJPY) >= 0 ? '#e8a33d' : '#d9483b';
    const pts = [
      { v: t.entry, y: Y(t.entry), col: isLong ? '#5fbf7f' : '#d9483b', txt: isLong ? '買' : '売' },
      { v: t.exit, y: Y(t.exit), col, txt: t.exitDate === bars[bars.length - 1].date ? '含み' : (n(t.pnlJPY) >= 0 ? '利' : '損') },
    ];
    for (const p of pts) {
      const x = X(bars.findIndex((b) => b.date === (p === pts[0] ? t.entryDate : t.exitDate)));
      if (x < pad.l) continue;
      c.fillStyle = p.col; c.beginPath(); c.arc(x, p.y, 2.6, 0, Math.PI * 2); c.fill();
      c.fillText(p.txt, x + 3, p.y - 4);
    }
  }
  const eq = (rep.equity || []).slice(0, i).map((e) => e.equity);
  const eqv = eq.filter((v) => Number.isFinite(v));
  if (eqv.length > 4) {
    const elo = Math.min(...eqv); const ehi = Math.max(...eqv);
    c.strokeStyle = '#5aa9c9'; c.lineWidth = 1.4; c.beginPath();
    eq.forEach((v, k) => {
      if (!Number.isFinite(v)) return;
      const y = h - pad.b - ((v - elo) / Math.max(1e-9, ehi - elo)) * (h - pad.t - pad.b) * 0.22 - 4;
      if (k === 0) c.moveTo(X(k), y); else c.lineTo(X(k), y);
    });
    c.stroke();
  }
  c.fillStyle = '#a5a19a';
  c.fillText(`${bars[0].date} → ${bars[bars.length - 1].date}   ${i}/${rep.bars.length}本   ${rep.symbol}`, pad.l + 2, 11);
  const last = rep.bars[i - 1];
  c.fillStyle = '#f3f0e9';
  c.fillText(`${last.c}`, w - pad.r + 4, Y(last.c) + 3);
}

// ---------------------------------------------------------------------------
// 結果の描画
// ---------------------------------------------------------------------------
function kvRows(obj, labels = {}) {
  return Object.entries(obj || {}).filter(([, v]) => v == null || typeof v !== 'object')
    .map(([k, v]) => `<tr><td>${esc(labels[k] || k)}</td><td class="num">${typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('ja-JP') : Number(v).toFixed(3)) : esc(v)}</td></tr>`).join('');
}

function renderResults(mode) {
  const st = S.m[mode];
  const root = $(`#panel-${mode} [data-res]`);
  if (!root) return;
  const r = st.results;
  if (!r) { root.innerHTML = '<p class="hint">「走らせる」を押すと、ここに結果が出ます。</p>'; return; }
  if (r.ok === false) { root.innerHTML = `<p class="bad">実行できませんでした: ${esc(r.error || '')} ${esc(JSON.stringify(r.errors || []))}</p>`; return; }

  const pf = r.portfolio || {};
  const s = pf.stats || {};
  const kpis = [
    kpi('合成の1日平均', pct(s.meanDailyPct), `SD ${f2(s.sdDailyPct)}%`, sgn(s.meanDailyPct)),
    kpi('年率シャープ', f2(s.annSharpe), `Sortino ${f2(s.sortino)}`),
    kpi('含み損込み最大DD', pct(s.maxDrawdownPct), `${n(s.n).toLocaleString()}日`),
    kpi('最悪の1日', pct(s.worstDayPct), `最良 ${pct(s.bestDayPct)}`, sgn(s.worstDayPct)),
  ];

  let modeBlock = '';
  if (mode === 'e8') {
    const mr = r.modeResult || {};
    const rp = mr.replay || {};
    const b = mr.bootstrap || {};
    const p = mr.payouts || {};
    modeBlock = `
      <div class="row" style="margin-top:12px"><b>選考の再生（この経路）</b></div>
      <div class="kpis">
        ${kpi('判定', rp.passed ? '合格' : '未達', rp.breach ? `違反: ${rp.breach.type} ${rp.breach.date || ''}` : `${rp.days}日で判定`, rp.passed ? 'good' : 'warn')}
        ${kpi('残高', usd(rp.balance), `開始 ${usd(mr.accountSize)}`, rp.balance >= mr.accountSize ? 'good' : 'bad')}
        ${kpi('合格ライン', usd(rp.target), `あと ${pct(rp.toTargetPct)}`, 'warn')}
        ${kpi('床（動的）', usd(rp.floor), `床まで ${pct(rp.toFloorPct)}`, pct(rp.toFloorPct, 1) && n(rp.toFloorPct) < 5 ? 'bad' : '')}
      </div>
      <canvas data-cv="e8curve" style="margin-top:10px"></canvas>
      <div class="legend">橙＝残高 / 破線＝合格ラインと床。違反したらそこで終わり。</div>
      <div class="row"><b>合格率（ブートストラップ ${n(b.trials)}経路）</b></div>
      <div class="kpis">
        ${kpi('合格率', pct(b.passRatePct), `中央値 ${b.medianDays == null ? '—' : b.medianDays + '日'}`, n(b.passRatePct) >= 50 ? 'good' : '')}
        ${kpi('合格までの日数', `${b.p25Days == null ? '—' : b.p25Days}–${b.p75Days == null ? '—' : b.p75Days}日`, '25%〜75%', 'dim')}
        ${kpi('期待値指数', usd(mr.evIndexUSD), `≒ ${yen(mr.evIndexJPY)}/月`)}
        ${kpi('支払い（中央値）', usd(p.medianMonthly), '資金提供後 月あたり', n(p.medianMonthly) > 0 ? 'good' : 'dim')}
      </div>
      <div class="grid2" style="margin-top:10px">
        <div class="scroll"><table><thead><tr><th>失格の理由</th><th class="num">件数</th></tr></thead><tbody>${kvRows(b.breaches)}</tbody></table></div>
        <div class="scroll"><table><thead><tr><th>支払いの内訳</th><th class="num">値</th></tr></thead><tbody>${kvRows(p)}</tbody></table></div>
      </div>
      <p class="note">${esc(mr.note || '')} 支払い規則: ${esc((mr.payRules || {}).note || '')}</p>
      ${(mr.alerts || []).length ? `<div class="scroll" style="margin-top:10px"><table><thead><tr><th>日付</th><th>種別</th><th class="num">値</th></tr></thead><tbody>${mr.alerts.map((a) => `<tr><td>${esc(a.date)}</td><td>${esc(a.kind)}</td><td class="num">${a.dayLossPct != null ? pct(a.dayLossPct) : a.pct != null ? pct(a.pct) : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  } else {
    const mr = r.modeResult || {};
    const oc = (mr.outcomes || [])[0] || {};
    modeBlock = `
      <div class="kpis" style="margin-top:12px">
        ${kpi('元本', yen(mr.capitalJPY), `建玉倍率 ${f2(mr.riskMultiple)}`)}
        ${kpi('最終', yen(mr.lastEquityJPY), `${f2(mr.multiple)}倍`, n(mr.multiple) >= 1 ? 'good' : 'bad')}
        ${kpi('撤退ライン到達', `${n(mr.ruinEventCount)}回`, `元本の${n(mr.ruinFloorPct)}%`, n(mr.ruinEventCount) ? 'bad' : 'good')}
        ${kpi('証拠金', yen((mr.margin || {}).marginJPY), `元本の${f2((mr.margin || {}).marginPctOfCapital)}%`, (mr.margin || {}).fits ? 'good' : 'bad')}
      </div>
      <canvas data-cv="owncurve" style="margin-top:10px"></canvas>
      <div class="legend">橙＝残高（円・複利）。青＝ドローダウン（%）を下に重ねています。</div>
      <div class="row"><b>目標倍率ごとの到達率（${n(oc.trials || 0)}経路・リスク倍率 ${f2(mr.riskMultiple)}）</b></div>
      <div class="scroll"><table><thead><tr><th>目標</th><th class="num">到達</th><th class="num">撤退</th><th class="num">どちらでもない</th><th class="num">到達までの中央値</th><th class="num">中央値の最終</th></tr></thead><tbody>
        ${(mr.outcomes || []).map((o) => `<tr><td>${f1(o.targetMultiple + 1)}倍</td><td class="num ${o.reachPct > 0 ? 'good' : ''}">${pct(o.reachPct)}</td><td class="num ${o.ruinPct > 0 ? 'bad' : ''}">${pct(o.ruinPct)}</td><td class="num dim">${pct(o.neitherPct)}</td><td class="num">${o.medianReachMonths == null ? '—' : f1(o.medianReachMonths) + 'ヶ月'}</td><td class="num">${yen(o.medianFinalJPY)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row"><b>リスク倍率 × 目標の前線（どこまで攻めると破綻するか）</b></div>
      <div class="scroll"><table><thead><tr><th>建玉倍率</th><th class="num">2倍到達</th><th class="num">撤退</th>${[1.5, 2, 3, 5].map((t) => `<th class="num">${t}倍到達</th>`).join('')}</tr></thead><tbody>
        ${((mr.frontier || {}).rows || []).map((row) => `<tr><td>${f2(row.riskMultiple)}</td><td class="num ${row.reach2xPct > 0 ? 'good' : ''}">${pct(row.reach2xPct)}</td><td class="num ${row.ruinPct > 0 ? 'bad' : ''}">${pct(row.ruinPct)}</td>${(row.targets || []).map((c) => `<td class="num">${pct(c.reachPct)}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="note">${esc(mr.note || '')} 推奨（撤退20%以下で最も攻めた倍率）: ${(mr.frontier || {}).recommendedRiskMultiple == null ? '—' : f2((mr.frontier || {}).recommendedRiskMultiple)}
      ${((mr.frontier || {}).note ? ' / ' + esc((mr.frontier || {}).note) : '')}</p>`;
  }

  const members = (r.members || []);
  const trades = (r.portfolio || {}).trades || [];
  root.innerHTML = `
    <div class="kpis">${kpis.join('')}</div>
    ${modeBlock}
    <div class="row" style="margin-top:14px"><b>積んだロジックの成績</b><span class="tag">${members.length}本（破産で外した本は下に表示）</span></div>
    <div class="scroll"><table><thead><tr><th>ロジック</th><th class="num">取引</th><th class="num">勝率</th><th class="num">PF</th><th class="num">純益</th><th class="num">DD(含)</th><th class="num">シャープ</th><th class="num">重み</th></tr></thead><tbody>
      ${members.map((m) => `<tr><td>${esc(m.label)}${m.excludedFromEnsemble ? ' <span class="chip">束から除外</span>' : ''}<div class="tag">${m.from}〜${m.to} / ${n(m.bars)}本</div></td>
        <td class="num">${n((m.metrics || {}).trades)}</td><td class="num">${pct((m.metrics || {}).winRate)}</td>
        <td class="num">${f2((m.metrics || {}).profitFactor)}</td><td class="num ${sgn((m.metrics || {}).netProfitPct)}">${pct((m.metrics || {}).netProfitPct)}</td>
        <td class="num ${n(((m.metrics || {}).maxDrawdownPctMtm)) > 35 ? 'bad' : ''}">${pct((m.metrics || {}).maxDrawdownPctMtm)}</td>
        <td class="num">${f2((m.metrics || {}).sharpe)}</td><td class="num">${f2(m.weight)}</td></tr>`).join('') || '<tr><td colspan="8" class="dim">なし</td></tr>'}
    </tbody></table></div>
    ${(r.warnings || []).length ? `<p class="note warn">${r.warnings.map((w) => esc(w)).join('<br>')}</p>` : ''}
    ${(r.errors || []).length ? `<p class="note bad">走らなかった行: ${esc(JSON.stringify(r.errors))}</p>` : ''}

    <div class="row" style="margin-top:14px"><b>月ごとの損益（合成）</b></div>
    <div class="scroll" style="max-height:200px"><table><thead><tr><th>月</th><th class="num">損益</th><th class="num">日数</th></tr></thead><tbody>
      ${((r.portfolio || {}).monthly || []).map((m) => `<tr><td>${esc(m.month)}</td><td class="num ${sgn(m.returnPct)}">${pct(m.returnPct)}</td><td class="num dim">${m.days}</td></tr>`).join('')}
    </tbody></table></div>

    <div class="row" style="margin-top:14px"><b>日足リプレイ（Forex Tester の「1本ずつ進める」相当）</b>
      <button data-act="replay-play">再生</button><button data-act="replay-stop">停止</button><button data-act="replay-step">次のバー</button>
      <label class="f" style="margin:0">速度<br><select data-f="replaySpeed" data-row="-1"><option value="240">ゆっくり</option><option value="90" selected>普通</option><option value="30">速い</option></select></label>
    </div>
    <input type="range" min="2" max="400" value="400" data-f="replayPos" data-row="-1" style="width:100%" />
    <canvas data-cv="replay" style="margin-top:8px"></canvas>
    <div class="legend" data-replay-info></div>

    <div class="row" style="margin-top:14px"><b>取引（合成・直近${trades.length}件）</b>
      <button data-act="csv-trades">CSVで書き出す</button><button data-act="csv-monthly">月次CSV</button><button data-act="json">JSONで書き出す</button>
    </div>
    <div class="scroll trades"><table><thead><tr><th>決済日</th><th>銘柄</th><th>方向</th><th class="num">建値</th><th class="num">決済値</th><th class="num">損益(円)</th><th>理由</th></tr></thead><tbody>
      ${trades.slice().reverse().map((t) => `<tr><td>${esc(t.exitDate)}</td><td>${esc(t.symbol || '')}</td><td>${t.dir > 0 ? '買' : '売'}</td>
        <td class="num">${esc(t.entryPrice)}</td><td class="num">${esc(t.exitPrice)}</td>
        <td class="num ${n(t.pnlJPY) >= 0 ? 'pos' : 'neg'}">${Math.round(n(t.pnlJPY)).toLocaleString('ja-JP')}</td><td class="dim">${esc(t.reason)}</td></tr>`).join('')}
    </tbody></table></div>

    ${r.extras ? `<div class="row" style="margin-top:14px"><b>堅牢性の検証</b></div>
      <div class="grid2">
        <div class="scroll"><table><thead><tr><th>Walk Forward</th><th class="num">値</th></tr></thead><tbody>${kvRows(r.extras.walkforward)}</tbody></table>
        <table style="margin-top:8px"><thead><tr><th>Monte Carlo（取引順序）</th><th class="num">値</th></tr></thead><tbody>${kvRows(r.extras.montecarlo)}</tbody></table></div>
        <div class="scroll"><table><thead><tr><th>検証（11項目・費用1.5倍）</th><th class="num">値</th></tr></thead><tbody>${r.extras.robust ? `<tr><td>合格</td><td class="num ${r.extras.robust.pass ? 'good' : 'bad'}">${r.extras.robust.pass ? 'はい' : 'いいえ'}</td></tr><tr><td>素点</td><td class="num">${f2(r.extras.robust.score)}</td></tr>` : ''}${kvRows(r.extras.costStress)}${(r.extras.robust && r.extras.robust.reasons || []).map((x) => `<tr><td colspan="2" class="dim">${esc(x)}</td></tr>`).join('')}</tbody></table></div>
      </div>` : ''}
    <p class="note">${(r.assumptions || []).join(' / ')}</p>`;

  const mr = r.modeResult || {};
  if (mode === 'e8' && (mr.replay || {}).series) {
    const cv = $(`#panel-${mode} [data-cv="e8curve"]`);
    const ser = mr.replay.series;
    lineChart(cv, ser.map((d) => d.balance), {
      h: 190, color: '#e8a33d',
      bands: [{ v: mr.replay.target, color: '#5fbf7f', label: '合格ライン' }, { v: mr.replay.floor, color: '#d9483b', label: '床' }],
      labels: [ser.length ? ser[0].date : '', ser.length ? ser[ser.length - 1].date : ''],
      marks: mr.replay.breach ? [{ i: Math.max(0, ser.findIndex((d) => d.date === mr.replay.breach.date)), label: '違反', color: '#d9483b' }] : [],
    });
  }
  if (mode === 'own') {
    const cv = $(`#panel-${mode} [data-cv="owncurve"]`);
    const curve = (mr.curve || []).map((p) => p.equity);
    lineChart(cv, curve, { h: 210, color: '#e8a33d', labels: [(mr.curve || [])[0] ? (mr.curve || [])[0].date : '', (mr.curve || []).slice(-1)[0] ? (mr.curve || []).slice(-1)[0].date : ''] });
    const dd = (mr.drawdown || []).map((p) => -n(p.ddPct));
    if (dd.length > 4) {
      const cv2 = document.createElement('canvas');
      cv2.style.marginTop = '6px';
      cv.insertAdjacentElement('afterend', cv2);
      lineChart(cv2, dd, { h: 90, color: '#5aa9c9', labels: ['最大DDの推移(%)', `${f1(Math.min(...dd))}%`] });
    }
  }

  if (r.replay) {
    st.replay = { ...r.replay, i: r.replay.bars.length, timer: null };
    const range = $(`#panel-${mode} [data-f="replayPos"]`);
    if (range) { range.max = String(r.replay.bars.length); range.value = String(r.replay.bars.length); }
    const info = $(`#panel-${mode} [data-replay-info]`);
    if (info) info.textContent = `${r.replay.label} / ${r.replay.bars.length}本 / 取引 ${(r.replay.trades || []).length}件（含みの建玉は「含み」と表示）`;
    drawReplay(mode);
  }
}

function renderSearch(mode) {
  const st = S.m[mode];
  const root = $(`#panel-${mode} [data-search]`);
  if (!root) return;
  const r = st.search;
  if (!r) { root.innerHTML = '<p class="hint">「試行錯誤（探索）」を押すと、候補の順位と通貨×時間足の地図が出ます。</p>'; return; }
  const s = r.summary || {};
  root.innerHTML = `
    <div class="kpis">
      ${kpi('試した候補', `${n(s.evaluated)}/${n(s.requested)}`, `${n(s.ms)}ms`, 'dim')}
      ${kpi('門を通った', `${n(s.passedGates)}件`, 'IS/OOSの取引数とDD', n(s.passedGates) ? 'good' : 'warn')}
      ${kpi('最良の素点', f2((s.best || {}).score), (s.best || {}).label || '', 'warn')}
      ${kpi('中央値', f2((s.distribution || {}).median), `p75 ${f2((s.distribution || {}).p75)}`, 'dim')}
    </div>
    <p class="hint">${esc(s.objective || '')}</p>
    ${s.stopped ? '<p class="note warn">CPU予算を使い切ったので途中で止めました。件数を減らすか、もう一度押してください。</p>' : ''}
    ${(s.errors || []).length ? `<p class="note bad">走らなかった候補: ${esc(JSON.stringify(s.errors))}</p>` : ''}
    <div class="scroll"><table><thead><tr><th>#</th><th>ロジック</th><th class="num">素点</th><th class="num">目的の値</th><th class="num">OOS純益</th><th class="num">DD(含)</th><th>門</th></tr></thead><tbody>
      ${(r.rows || []).map((x, i) => `<tr><td class="dim">${i + 1}</td><td>${esc(x.label)}<div class="tag">${esc(x.symbol)} ${esc(x.tf)} ${esc(x.exit || '')} ${esc(x.dir || '')}</div></td>
        <td class="num">${f2(x.score)}</td>
        <td class="num dim">${x.objective ? esc(Object.entries(x.objective).filter(([k, v]) => typeof v === 'number' && ['passRatePct', 'medianMultiple', 'reachPct', 'ruinPct'].includes(k)).map(([k, v]) => `${k === 'passRatePct' ? '合格' : k === 'medianMultiple' ? '中央' : k === 'reachPct' ? '到達' : '撤退'} ${f2(v)}${k.endsWith('Pct') ? '%' : '倍'}`).join(' / ')) : ''}</td>
        <td class="num ${sgn((x.metrics.oos || {}).netProfitPct)}">${pct((x.metrics.oos || {}).netProfitPct)}</td>
        <td class="num ${n((x.metrics.oos || {}).maxDrawdownPctMtm) > 35 ? 'bad' : ''}">${pct((x.metrics.oos || {}).maxDrawdownPctMtm)}</td>
        <td>${x.gates.pass ? '<span class="chip on">通過</span>' : `<span class="tag">${esc((x.gates.reasons || []).slice(0, 2).join(' / '))}</span>`}</td></tr>`).join('') || '<tr><td colspan="7" class="dim">なし</td></tr>'}
    </tbody></table></div>
    <div class="row" style="margin-top:12px"><b>地図（通貨 × 時間軸 の最良素点）</b></div>
    <div class="scroll" style="max-height:260px"><table><thead><tr><th>通貨</th><th>時間軸</th><th class="num">最良素点</th><th class="num">件数</th></tr></thead><tbody>
      ${((r.heatmap || {}).grid || []).map((g) => `<tr><td>${esc(g.symbol)}</td><td>${esc(g.tf)}</td><td class="num ${g.best > 0 ? 'good' : 'dim'}">${f2(g.best)}</td><td class="num dim">${g.n}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="grid2" style="margin-top:10px">
      <div class="scroll" style="max-height:220px"><table><thead><tr><th>出口</th><th class="num">最良</th><th class="num">n</th></tr></thead><tbody>${((r.heatmap || {}).byExit || []).map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${f2(x.best)}</td><td class="num dim">${x.n}</td></tr>`).join('')}</tbody></table></div>
      <div class="scroll" style="max-height:220px"><table><thead><tr><th>方向</th><th class="num">最良</th><th class="num">n</th></tr></thead><tbody>${((r.heatmap || {}).byDirection || []).map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${f2(x.best)}</td><td class="num dim">${x.n}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <div class="row"><button data-act="addbest">上位3件をロジックに積む</button></div>`;
}

async function renderBoard(mode) {
  const root = $(`#panel-${mode} [data-board]`);
  if (!root) return;
  try {
    const r = await api(`/api/lab/board?mode=${mode}&limit=25`);
    S.m[mode].board = r.rows || [];
    if (!r.rows || !r.rows.length) { root.innerHTML = '<p class="hint">まだありません。「試行錯誤（探索）」か「背景ループを1回回す」で貯まります。</p>'; return; }
    root.innerHTML = `<div class="scroll"><table><thead><tr><th>素点</th><th>ロジック</th><th class="num">OOS純益</th><th class="num">DD(含)</th><th>目的の値</th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td class="num">${f2(x.fitness)}</td><td>${esc(x.label || (x.symbol + ' ' + x.key))}<div class="tag">${esc(x.symbol)} ${x.from || ''}〜${x.to || ''}</div></td>
        <td class="num ${sgn(x.oosNetPct)}">${pct(x.oosNetPct)}</td><td class="num">${pct(x.oosDdMtmPct)}</td>
        <td class="dim">${x.objective ? esc(Object.entries(x.objective).filter(([, v]) => typeof v === 'number').slice(0, 4).map(([k, v]) => `${k} ${f2(v)}`).join(' / ')) : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
  } catch (e) { root.innerHTML = `<p class="hint">順位表を読めませんでした: ${esc(e.message)}</p>`; }
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------
function csv(rows, name) {
  const body = rows.map((r) => r.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const dl = (text, name, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

async function doRun(mode, withOpts = {}) {
  if (S.busy) return;
  S.busy = true;
  syncFromDom(mode);
  setStatus(mode, '走らせています…（データ取得 → 約定を1本ずつ → まとめ）');
  const bar = $(`#panel-${mode} [data-progress]`); if (bar) bar.style.width = '40%';
  try {
    const r = await api('/api/lab/run', {
      method: 'POST',
      body: { mode, rows: S.m[mode].rows, options: S.m[mode].options, settings: S.m[mode].settings, with: withOpts },
    });
    S.m[mode].results = r;
    setStatus(mode, `完了（${(r.members || []).length}本・${n(((r.portfolio || {}).stats || {}).n).toLocaleString()}日）`);
    renderResults(mode);
    if (bar) bar.style.width = '100%';
  } catch (e) {
    setStatus(mode, `失敗: ${e.message}`);
    S.m[mode].results = { ok: false, error: e.message };
    renderResults(mode);
  } finally {
    S.busy = false;
    setTimeout(() => { const b = $(`#panel-${mode} [data-progress]`); if (b) b.style.width = '0'; }, 900);
  }
}

async function doSearch(mode) {
  if (S.busy) return;
  S.busy = true;
  syncFromDom(mode);
  setStatus(mode, `候補を作って試しています（${S.m[mode].searchN}件）…`);
  const bar = $(`#panel-${mode} [data-progress]`); if (bar) bar.style.width = '50%';
  try {
    const r = await api('/api/lab/search', { method: 'POST', body: { mode, n: S.m[mode].searchN, options: S.m[mode].options, settings: S.m[mode].settings } });
    S.m[mode].search = r;
    setStatus(mode, `探索 完了（${n(r.summary.evaluated)}件・門を通った ${n(r.summary.passedGates)}件）`);
    renderSearch(mode);
    renderBoard(mode);
    if (bar) bar.style.width = '100%';
  } catch (e) { setStatus(mode, `探索の失敗: ${e.message}`); }
  finally { S.busy = false; setTimeout(() => { const b = $(`#panel-${mode} [data-progress]`); if (b) b.style.width = '0'; }, 900); }
}

async function doExit(mode) {
  if (S.busy) return;
  S.busy = true;
  syncFromDom(mode);
  const row = S.m[mode].rows[0];
  if (!row) { setStatus(mode, '1行目がありません。'); S.busy = false; return; }
  setStatus(mode, '出口（損切り・利確・保有日数）を振っています…');
  try {
    const r = await api('/api/lab/exit', { method: 'POST', body: { row, options: S.m[mode].options, limit: 24 } });
    const best = r.best || {};
    S.m[mode].exit = r;
    setStatus(mode, `出口の最適化 完了（${n(r.evaluated)}通り）／最良: 損切${f2(best.atrStopMult)}×ATR・利確${f2(best.atrTargetMult)}×ATR・保有${n(best.maxHoldBars)}バー → 純益${pct(best.netPct)}`);
    const root = $(`#panel-${mode} [data-search]`);
    if (root) root.innerHTML = `<div class="row"><b>出口の最適化（${esc(r.label || '')}・${n(r.bars)}本）</b></div>
      <p class="hint">${esc(r.note || '')}</p>
      <div class="scroll"><table><thead><tr><th class="num">損切</th><th class="num">利確</th><th class="num">保有</th><th class="num">純益</th><th class="num">PF</th><th class="num">取引</th><th class="num">DD(含)</th></tr></thead><tbody>
      ${(r.rows || []).map((x, i) => `<tr${i === 0 ? ' style="background:rgba(232,163,61,.08)"' : ''}><td class="num">${f2(x.atrStopMult)}</td><td class="num">${f2(x.atrTargetMult)}</td><td class="num">${n(x.maxHoldBars)}</td><td class="num ${sgn(x.netPct)}">${pct(x.netPct)}</td><td class="num">${f2(x.pf)}</td><td class="num">${n(x.trades)}</td><td class="num">${pct(x.ddMtmPct)}</td></tr>`).join('')}
      </tbody></table></div>`;
  } catch (e) { setStatus(mode, `出口の最適化の失敗: ${e.message}`); }
  finally { S.busy = false; }
}

async function doTick(mode) {
  if (S.busy) return;
  S.busy = true;
  setStatus(mode, '背景ループを1回回しています（両方のモード）…');
  try {
    const r = await api('/api/lab/tick', { method: 'POST', body: {} });
    setStatus(mode, `背景ループ 完了／自己資金 ${n((r.own || {}).evaluated)}件・E8 ${n((r.e8 || {}).evaluated)}件`);
    renderBoard(mode);
  } catch (e) { setStatus(mode, `背景ループの失敗: ${e.message}`); }
  finally { S.busy = false; }
}

async function doProject(mode, action) {
  syncFromDom(mode);
  const root = $(`#panel-${mode} [data-projects]`);
  const nameEl = $(`#panel-${mode} [data-f="projName"]`);
  const name = nameEl ? nameEl.value : '';
  try {
    if (action === 'save') {
      if (!name) { setStatus(mode, '名前を入れてください。'); return; }
      await api('/api/lab/project', { method: 'POST', body: { action: 'save', name, payload: { mode, rows: S.m[mode].rows, settings: S.m[mode].settings, options: S.m[mode].options } } });
      setStatus(mode, `保存しました: ${name}`);
    } else if (action === 'load') {
      const r = await api('/api/lab/project', { method: 'POST', body: { action: 'load', name } });
      const p = r.payload || r;
      if (!p || !p.rows) { setStatus(mode, `読めませんでした: ${name}`); return; }
      S.m[mode].rows = p.rows; S.m[mode].settings = p.settings || S.m[mode].settings; S.m[mode].options = p.options || S.m[mode].options;
      $(`#panel-${mode}`).innerHTML = panelHtml(mode);
      renderBoard(mode);
      setStatus(mode, `読み込みました: ${name}`);
    }
    const list = await api('/api/lab/project', { method: 'POST', body: { action: 'list' } });
    S.m[mode].projects = list.projects || [];
    if (root) root.innerHTML = (S.m[mode].projects || []).map((p) => `<a href="#" data-act="loadnamed" data-name="${esc(p.name)}">${esc(p.name)}</a> <span class="tag">${esc((p.savedAt || '').slice(0, 16))} / ${n(p.rows)}行</span><br>`).join('') || 'まだありません。';
  } catch (e) { setStatus(mode, `保存/読込の失敗: ${e.message}`); }
}

function wirePanel(mode) {
  const root = $(`#panel-${mode}`);
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'addrow') { syncFromDom(mode); const s = S.catalog.strategies; const st = S.m[mode]; st.rows.push({ symbol: (S.catalog.symbols || ['USDJPY'])[0], tf: '1d', strategy: (s[st.rows.length % s.length] || {}).key, variant: 0, filter: 'none', exit: 'balanced', dir: 'both', weight: 1 }); redrawRows(mode); return; }
    if (act === 'addrule') { syncFromDom(mode); const st = S.m[mode]; st.rows.push({ kind: 'rule', symbol: (S.catalog.symbols || ['USDJPY'])[0], tf: '1d', feature: (S.catalog.features[0] || {}).key, filter: 'none', exit: 'balanced', dir: 'both', weight: 1 }); redrawRows(mode); return; }
    if (act === 'delrow') { syncFromDom(mode); S.m[mode].rows.splice(Number(btn.dataset.row), 1); redrawRows(mode); return; }
    if (act === 'random') {
      syncFromDom(mode);
      const c = S.catalog;
      const r = S.m[mode].rows[Number(btn.dataset.row)];
      if (!r) return;
      const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
      r.symbol = pickOne(c.symbols); r.tf = pickOne(c.timeframes).key;
      r.exit = pickOne(c.exits).key; r.dir = pickOne(c.directions).key; r.filter = pickOne(c.filters).key;
      if (r.kind === 'rule') r.feature = pickOne(c.features).key;
      else { const s = pickOne(c.strategies); r.strategy = s.key; r.variant = pickOne(s.variants).variant; r.params = { ...(pickOne(s.variants).params || {}) }; }
      redrawRows(mode); return;
    }
    if (act === 'run') return doRun(mode);
    if (act === 'robust') return doRun(mode, { robust: true });
    if (act === 'search') return doSearch(mode);
    if (act === 'exit') return doExit(mode);
    if (act === 'tick') return doTick(mode);
    if (act === 'refresh') return renderBoard(mode);
    if (act === 'save' || act === 'load' || act === 'projects') return doProject(mode, act);
    if (act === 'loadnamed') { ev.preventDefault(); const el = $(`#panel-${mode} [data-f="projName"]`); if (el) el.value = btn.dataset.name; return doProject(mode, 'load'); }
    if (act === 'addbest') {
      const rows = ((S.m[mode].search || {}).rows || []).slice(0, 3).map((x) => ({ spec: x.spec, symbol: x.symbol, weight: 1 }));
      if (!rows.length) { setStatus(mode, '探索の結果がまだありません。'); return; }
      S.m[mode].rows = rows;
      redrawRows(mode);
      setStatus(mode, '探索の上位3件を積みました。「走らせる」で確かめてください。');
      return;
    }
    if (act === 'replay-play') {
      const st = S.m[mode]; if (!st.replay) return;
      const speed = n(($(`#panel-${mode} [data-f="replaySpeed"]`) || {}).value, 90);
      if (st.replay.timer) clearInterval(st.replay.timer);
      st.replay.i = 1;
      st.replay.timer = setInterval(() => {
        st.replay.i += 1;
        const range = $(`#panel-${mode} [data-f="replayPos"]`); if (range) range.value = String(st.replay.i);
        drawReplay(mode);
        if (st.replay.i >= st.replay.bars.length) { clearInterval(st.replay.timer); st.replay.timer = null; }
      }, speed);
      return;
    }
    if (act === 'replay-stop') { const st = S.m[mode]; if (st.replay && st.replay.timer) { clearInterval(st.replay.timer); st.replay.timer = null; } return; }
    if (act === 'replay-step') { const st = S.m[mode]; if (!st.replay) return; st.replay.i = Math.min(st.replay.bars.length, n(st.replay.i, 1) + 1); const range = $(`#panel-${mode} [data-f="replayPos"]`); if (range) range.value = String(st.replay.i); drawReplay(mode); return; }
    if (act === 'csv-trades') {
      const tr = ((S.m[mode].results || {}).portfolio || {}).trades || [];
      csv([['symbol', 'entryDate', 'exitDate', 'dir', 'entryPrice', 'exitPrice', 'pnlJPY', 'reason'].concat(tr.map((t) => [t.symbol, t.entryDate, t.exitDate, t.dir, t.entryPrice, t.exitPrice, t.pnlJPY, t.reason]))], `lab-${mode}-trades.csv`);
      return;
    }
    if (act === 'csv-monthly') {
      const mo = ((S.m[mode].results || {}).portfolio || {}).monthly || [];
      csv([['month', 'returnPct', 'days']].concat(mo.map((m) => [m.month, m.returnPct, m.days])), `lab-${mode}-monthly.csv`);
      return;
    }
    if (act === 'json') { dl(JSON.stringify(S.m[mode].results, null, 2), `lab-${mode}.json`); return; }
  });
  root.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.f === 'replayPos') { const st = S.m[mode]; if (st.replay) { st.replay.i = n(el.value, 1); drawReplay(mode); } }
    if (el.dataset.f === 'strategy' || el.dataset.f === 'kind' || el.dataset.f === 'variant') {
      syncFromDom(mode);
      const i = Number(el.dataset.row);
      const r = S.m[mode].rows[i];
      if (!r) return;
      if (r.kind === 'rule') { r.feature = r.feature || (S.catalog.features[0] || {}).key; r.params = {}; }
      else {
        const s = (S.catalog.strategies || []).find((x) => x.key === r.strategy);
        const v = ((s || {}).variants || []).find((x) => Number(x.variant) === Number(r.variant)) || ((s || {}).variants || [])[0] || { params: {} };
        r.params = { ...(v.params || {}) };
      }
      redrawRows(mode);
    }
  });
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
async function boot() {
  const u = new URL(location.href);
  if (u.searchParams.get('token')) { localStorage.setItem(LS_TOKEN, u.searchParams.get('token')); u.searchParams.delete('token'); history.replaceState(null, '', u.toString()); }
  S.token = localStorage.getItem(LS_TOKEN) || '';
  const tokEl = $('#tok');
  const saveTok = async () => {
    S.token = ($('#tok').value || '').trim();
    localStorage.setItem(LS_TOKEN, S.token);
    $('#gate').classList.add('hidden');
    await start();
  };
  $('#tokSave').addEventListener('click', saveTok);
  $('#btnToken').addEventListener('click', () => $('#gate').classList.toggle('hidden'));
  if (!S.token) { $('#gate').classList.remove('hidden'); }
  $('#tabs').addEventListener('click', (ev) => { const t = ev.target.closest('.tab'); if (t) show(t.dataset.mode); });
  await start();
}

async function start() {
  try {
    S.catalog = (await api('/api/lab/catalog')).catalog;
    conn(true, `接続済み・${S.catalog.symbols.length}銘柄`);
  } catch (e) {
    conn(false, `未接続（${e.message}）`);
    $('#gate').classList.remove('hidden');
    return;
  }
  renderTabs();
  const first = S.mode || (S.catalog.modes[0] || {}).key || 'e8';
  show(first);
  try {
    const st = await api('/api/lab');
    const s = st.stats || {};
    conn(true, `接続済み・探索 ${n(s.own_searched) + n(s.e8_searched)}件`);
  } catch { /* 状態は読めなくてもよい */ }
}

boot();
