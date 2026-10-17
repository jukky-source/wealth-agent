// 動画スタジオ — 台本からブラウザ内だけで動画を作る（原価0）。
//
// なぜブラウザなのか:
//   Cloudflare Workers では ffmpeg が動かず、無料の動画合成APIも無い。
//   一方、見ている端末のブラウザには Canvas と MediaRecorder がある。作画はCanvas、
//   エンコードはMediaRecorder（端末内）なので、サーバーの費用は0円のまま動画が出来る。
//
// 作るもの: 台本の各場面を1枚ずつ描き、順に切り替えて .webm（VP9/VP8）に録る。
//   1080×1920（ショート）と 1920×1080（横）に対応。音声は入れない（嘘をつかないため）。

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RATIOS = { shorts: [1080, 1920], wide: [1920, 1080] };

const state = { scenes: [], meta: { title: '', desc: '' }, active: 0, recording: false, url: '' };

// ---------------------------------------------------------------- 入力（アプリからの引き継ぎ）
function handoff() {
  try { return JSON.parse(sessionStorage.getItem('wa.studio') || 'null') || null; } catch { return null; }
}
function tokenFrom(hand) {
  if (hand && hand.token) return hand.token;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      const v = localStorage.getItem(k) || '';
      if (/token/i.test(k) && v.length >= 12 && v[0] !== '{') return v;
    }
  } catch {}
  return '';
}

// ---------------------------------------------------------------- 台本の解析
const T = (s) => {
  const m = String(s).match(/^(\d+):(\d{2})\s*(.*)$/);
  return m ? { min: Number(m[1]), sec: Number(m[2]), rest: m[3] } : null;
};
export function parseScript(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const body = raw.split(/【概要欄】/)[0].replace(/【台本】/, '').trim();
  const out = [];
  for (const line of body.split('\n')) {
    const t = T(line.trim());
    if (!t) continue;
    const [head, ...rest] = t.rest.split(/\s+—\s+|\s+-\s+/);
    out.push({
      t: `${t.min}:${String(t.sec).padStart(2, '0')}`,
      head: (head || t.rest || '').trim().slice(0, 60),
      body: (rest.join(' — ') || head || '').trim(),
    });
  }
  return out;
}
export function splitMeta(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const after = (tag) => {
    const i = raw.indexOf(`【${tag}】`);
    if (i < 0) return '';
    const rest = raw.slice(i + tag.length + 2);
    const j = rest.search(/\n【/);
    return (j < 0 ? rest : rest.slice(0, j)).trim();
  };
  return { desc: after('概要欄'), thumb: after('サムネイル指示') };
}

// ---------------------------------------------------------------- 作画
function wrap(ctx, text, maxW) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
    else line += ch;
  }
  if (line) out.push(line);
  return out;
}
function font(size, weight = 700) { return `${weight} ${size}px "Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif`; }

function drawFrame(ctx, W, H, scene, i, total, p, alpha) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, W, H);
  // うっすらと方眼（作業机の質感。装飾ではなく「位置合わせ」の目印として薄く）
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += W / 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += W / 12) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const M = Math.round(W * 0.08);
  const maxW = W - M * 2;
  ctx.globalAlpha = alpha;

  if (i === 0) {
    ctx.fillStyle = '#e8a33d'; ctx.font = font(W * 0.022, 700);
    ctx.fillText('AI がまとめた台本から', M, H * 0.3);
    ctx.fillStyle = '#f3f0e9'; ctx.font = font(W * 0.062, 700);
    let y = H * 0.36;
    for (const line of wrap(ctx, state.meta.title || scene.head || '動画', maxW).slice(0, 4)) { ctx.fillText(line, M, y); y += W * 0.078; }
    ctx.fillStyle = '#a5a19a'; ctx.font = font(W * 0.026, 400);
    ctx.fillText('実際に試した結果と、次にやることを話します', M, y + W * 0.03);
  } else if (i === total - 1) {
    ctx.fillStyle = '#f3f0e9'; ctx.font = font(W * 0.05, 700);
    ctx.fillText('試して検証', M, H * 0.36);
    ctx.fillStyle = '#a5a19a'; ctx.font = font(W * 0.026, 400);
    let y = H * 0.43;
    for (const line of wrap(ctx, 'この動画はAI（人工知能）を使って作成しています。確認できていない数字は使いません。', maxW)) { ctx.fillText(line, M, y); y += W * 0.038; }
    ctx.fillStyle = '#e8a33d'; ctx.font = font(W * 0.024, 700);
    ctx.fillText(scene.src ? '出典は概要欄に記載' : '出典なし', M, y + W * 0.05);
  } else {
    ctx.fillStyle = '#e8a33d'; ctx.font = font(W * 0.026, 700);
    ctx.fillText(scene.t, M, H * 0.24);
    ctx.fillStyle = '#f3f0e9'; ctx.font = font(W * 0.052, 700);
    let y = H * 0.3;
    for (const line of wrap(ctx, scene.head, maxW).slice(0, 3)) { ctx.fillText(line, M, y); y += W * 0.066; }
    ctx.fillStyle = '#d8d4cc'; ctx.font = font(W * 0.032, 400);
    y += W * 0.02;
    for (const line of wrap(ctx, scene.body, maxW).slice(0, 7)) { ctx.fillText(line, M, y); y += W * 0.046; }
  }

  // 進行バー（どこまで来たかが分かる）＋ 場面番号
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(M, H - M, maxW, Math.max(4, W * 0.006));
  ctx.fillStyle = '#e8a33d';
  ctx.fillRect(M, H - M, maxW * Math.max(0, Math.min(1, p)), Math.max(4, W * 0.006));
  ctx.fillStyle = '#a5a19a'; ctx.font = font(W * 0.02, 400);
  ctx.fillText(`${i + 1} / ${total}`, M, H - M - W * 0.022);
  if (state.recording) { ctx.fillStyle = '#d9483b'; ctx.beginPath(); ctx.arc(W - M - W * 0.02, H - M - W * 0.02, W * 0.012, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function renderStrip() {
  const strip = $('#strip');
  strip.innerHTML = '';
  state.scenes.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = `frame${i === 0 ? ' on' : ''}`;
    el.dataset.i = String(i);
    el.innerHTML = `<span class="dot"></span><canvas width="300" height="168"></canvas><div class="f-t"><span>${esc(i === 0 ? '00:00' : s.t)}</span><span>${i === 0 ? '見出し' : i === state.scenes.length - 1 ? '結び' : `${i}/${state.scenes.length - 2}`}</span></div>`;
    strip.appendChild(el);
    const c = el.querySelector('canvas');
    const ctx = c.getContext('2d');
    ctx.save(); ctx.scale(300 / state.scenes.length ? 300 / 1080 : 0.28, 168 / 1920);
    drawFrame(ctx, 1080, 1920, s, i, state.scenes.length, (i + 1) / state.scenes.length, 1);
    ctx.restore();
    el.addEventListener('click', () => { state.active = i; paint(i); });
  });
}

function paint(i, p = (i + 1) / state.scenes.length) {
  const cv = $('#stageCv');
  cv.width = state.W; cv.height = state.H;
  const ctx = cv.getContext('2d');
  drawFrame(ctx, state.W, state.H, state.scenes[i], i, state.scenes.length, p, 1);
  $$('#strip .frame').forEach((f, k) => f.classList.toggle('on', k === i));
  $('#tcNow').textContent = `${fmt(secsFor(i))} / ${fmt(secsFor(state.scenes.length))}`;
  $('#sizeNow').textContent = `${state.W}×${state.H} ・ 場面 ${i + 1}/${state.scenes.length}`;
}
const secsFor = (n) => n * Number($('#sec').value || 6);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- 録画
function pickType() {
  const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';
}

async function record() {
  const type = pickType();
  if (!type) { $('#status').textContent = 'このブラウザは動画の書き出し（MediaRecorder）に対応していません。Chrome / Edge / Safari の新しい版で試してください。'; return; }
  const cv = $('#stageCv');
  const stream = cv.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });

  state.recording = true;
  $('#rec').disabled = true; $('#stop').disabled = false;
  $('#live').classList.add('on'); $('#liveTxt').textContent = '録画中';
  $('#status').textContent = '録画しています。このタブを閉じたり裏に回さないでください。';

  const total = secsFor(state.scenes.length) * 1000;
  const t0 = performance.now();
  rec.start(200);
  let stopFlag = false;
  const stopNow = () => { stopFlag = true; };
  $('#stop').onclick = stopNow;

  await new Promise((res) => {
    const loop = () => {
      const el = performance.now() - t0;
      const p = Math.min(1, el / total);
      const i = Math.min(state.scenes.length - 1, Math.floor(p * state.scenes.length));
      const local = p * state.scenes.length - i;
      const alpha = Math.min(1, local * 8); // 場面の頭でふわっと出す
      drawFrame(cv.getContext('2d'), state.W, state.H, state.scenes[i], i, state.scenes.length, p, alpha);
      $$('#strip .frame').forEach((f, k) => f.classList.toggle('on', k === i));
      $('#barFill').style.width = `${Math.round(p * 100)}%`;
      $('#tcNow').textContent = `${fmt(el / 1000)} / ${fmt(total / 1000)}`;
      if (p >= 1 || stopFlag) return res();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  rec.stop();
  await done;
  state.recording = false;
  $('#rec').disabled = false; $('#stop').disabled = true; $('#stop').onclick = null;
  $('#live').classList.remove('on'); $('#liveTxt').textContent = '待機中';

  const blob = new Blob(chunks, { type: 'video/webm' });
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(blob);
  const name = `wealth-agent-${new Date().toISOString().slice(0, 10)}.webm`;
  const dl = $('#dl');
  dl.href = state.url; dl.download = name;
  $('#preview').src = state.url;
  $('#out').classList.remove('hidden');
  const secs = Math.round((blob.size / (4_000_000 / 8)));
  $('#status').textContent = `できました: ${name}（約 ${(blob.size / 1048576).toFixed(1)} MB・${fmt(total / 1000)}）。
YouTubeで「作成」→「動画をアップロード」からこのファイルを選び、右の概要欄を貼ってください。声を載せる場合は、できた動画に後から音声を足せます。`;
}

// ---------------------------------------------------------------- 起動
async function load() {
  const hand = handoff();
  const token = tokenFrom(hand);
  let draft = hand && hand.script ? { title: hand.title || '', script: hand.script } : null;

  if (!draft && token) {
    try {
      const res = await fetch('/api/social', { headers: { authorization: `Bearer ${token}` } });
      const d = await res.json();
      const item = (d?.queued || []).find((x) => x.channel === 'youtube');
      if (item) draft = { title: item.title || '', script: String(item.copy_text || '') };
    } catch {}
  }
  if (!draft) {
    $('#manualWrap').classList.remove('hidden');
    $('#status').textContent = 'アプリから「台本から動画を作る」を押すと、台本が自動で入ります。';
    return;
  }
  setDraft(draft);
}

function setDraft(draft) {
  const meta = splitMeta(draft.script);
  state.meta = { title: (draft.title || '').trim(), desc: meta.desc };
  const scenes = parseScript(draft.script);
  if (!scenes.length) { $('#manualWrap').classList.remove('hidden'); $('#status').textContent = '台本から場面を読み取れませんでした。1行1場面の形で貼ってください。'; return; }
  const src = (draft.script.match(/https?:\/\/\S+/) || [''])[0];
  state.scenes = [{ t: '0:00', head: state.meta.title, body: '', src }, ...scenes, { t: '', head: '結び', body: '', src }];
  state.W = RATIOS[$('#ratio').value][0];
  state.H = RATIOS[$('#ratio').value][1];
  renderStrip();
  paint(0);
  $('#mTitle').textContent = state.meta.title || '（タイトル未設定）';
  $('#mDesc').textContent = state.meta.desc || '（概要欄なし）';
  const mins = (secsFor(state.scenes.length) / 60).toFixed(1);
  $('#status').textContent = `${state.scenes.length}場面（約${mins}分）を用意しました。「録画して作る」を押すと、この端末の中だけで動画になります。`;
  $('#manualWrap').classList.add('hidden');
}

function bind() {
  $('#ratio').addEventListener('change', () => {
    state.W = RATIOS[$('#ratio').value][0]; state.H = RATIOS[$('#ratio').value][1];
    if (state.scenes.length) { renderStrip(); paint(state.active); }
  });
  $('#sec').addEventListener('change', () => { if (state.scenes.length) { paint(state.active); } });
  $('#rec').addEventListener('click', () => record().catch((e) => { $('#status').textContent = `録画に失敗しました（${e.message}）。もう一度試してください。`; }));
  $('#useManual').addEventListener('click', () => {
    const txt = $('#manual').value;
    if (!txt.trim()) return;
    setDraft({ title: (txt.match(/^0:00\s+(.+)$/m) || ['', '動画'])[1].split('—')[0].trim(), script: txt });
  });
  const copy = async (sel) => { try { await navigator.clipboard.writeText($(sel).textContent || ''); $('#status').textContent = 'コピーしました。'; } catch { $('#status').textContent = 'コピーできませんでした。長押しで選んでコピーしてください。'; } };
  $('#cpTitle').addEventListener('click', () => copy('#mTitle'));
  $('#cpDesc').addEventListener('click', () => copy('#mDesc'));
}

bind();
load();
