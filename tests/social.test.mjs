// SNS投稿（X / note / YouTube）の「人の手出し最小化」のテスト。
// ・Xは intent URL に本文が入っている（＝開いて押すだけ）
// ・Xの280文字は「重み付き」（日本語は1文字=2）。素の文字数で切るとURLが消えるので、そこを固定する
// ・note / YouTube は「貼るだけの塊」を出す（AI開示が最初から入っている）
// ・キューは scout の実データから自動で補充され、同じ候補を二度使わない
// ・本数の上限は publish.js の既存ゲートが効く（再実装しない）
// ・投稿はしない（approveAll は「材料を返す」だけ）
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store, ensureSchema } from '../src/db.js';
import { CHANNELS, CHANNEL_IDS, composeFor, templateFor, refillQueue, approveAll, socialReport, socialCards, socialHelp, weightedLen, fitToX } from '../src/agent/social.js';
import { listDrafts } from '../src/agent/publish.js';
import { ensureScoutTable } from '../src/agent/scout.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

function makeDb() {
  const db = new DatabaseSync(':memory:');
  const prepare = (sql) => {
    const st = db.prepare(sql);
    return {
      bind: (...p) => ({
        all: () => ({ results: st.all(...p) }),
        first: () => st.get(...p) ?? null,
        run: () => st.run(...p),
      }),
      all: () => ({ results: st.all() }),
      first: () => st.get() ?? null,
      run: () => st.run(),
    };
  };
  return { exec: (s) => db.exec(s), prepare };
}

// 実際の巡回先の候補のように、互いに十分違う文面にする
const SAMPLES = [
  { title: 'CSVの重複除去に月20ドル払うと言っている人がいる', url: 'https://news.example.com/csv-dedup', excerpt: '手作業でやっているので自動化したい、予算は月20ドルまで出せると書いてある。', signals: '["pay_intent","price"]', fits: '["x402","content"]' },
  { title: '賞金付きのIssueが立った：レガシーAPIの移行スクリプト', url: 'https://github.example.com/acme/repo/issues/42', excerpt: 'bountyラベルが付き、締切は来月末。既存の表をJSONに落とすだけの作業。', signals: '["bounty","hire_paid"]', fits: '["x402"]' },
  { title: '再入荷と値下げの見張りが面倒だという不満が集まっている', url: 'https://forum.example.com/t/restock-watch/123', excerpt: '毎朝手で確認している、通知が来ないと気づけないと複数人が書いている。', signals: '["pain","looking_for"]', fits: '["monitor","content"]' },
  { title: 'MCPで在庫を引くサーバーを探している', url: 'https://blog.example.com/mcp-inventory', excerpt: 'model context protocol 対応のツールが欲しい、自作はしたくないという要望。', signals: '["looking_for"]', fits: '["mcp","content"]' },
  { title: '正規表現のレビューだけで3万円の案件が出ている', url: 'https://jp.example.com/regex-review', excerpt: 'ログ抽出の正規表現をレビューしてほしい、報酬は3万円と明記されている。', signals: '["hire_paid","price"]', fits: '["x402","content"]' },
  { title: 'x402で何が売れるのか、という議論が伸びている', url: 'https://zenn.example.com/x402-market', excerpt: 'エージェント同士の決済で何が売れるのか、実例が少ないという指摘。', signals: '["x402"]', fits: '["x402","content"]' },
];
const TRIAL = JSON.stringify({ steps: [{ capability: 'content', action: 'note / X / YouTube のネタにする', cost_jpy: 0, auto: true, human: ['投稿の1タップ'] }, { capability: 'measure', action: '反応を記録する', cost_jpy: 0, auto: true, human: [] }], money_at_risk_jpy: 0 });

async function seedFinding(store, i) {
  const s = SAMPLES[i % SAMPLES.length];
  const at = new Date(Date.now() - i * 3600e3).toISOString();
  await store.insert('scout_findings', {
    id: `sc_f${i}`, key: `k${i}`, source_id: 'hn_money',
    title: s.title, url: s.url, excerpt: s.excerpt, tags_json: '["api"]',
    score: 60 - i, fresh: 8, engage: 5, age_hours: 3,
    signals_json: s.signals, money_json: s.signals,
    fits_json: s.fits, trial_json: TRIAL,
    status: 'new', note: null, created_at: at, updated_at: at,
  });
}

async function freshStore(n = 6) {
  const store = new Store(makeDb());
  await ensureSchema(store);
  await ensureScoutTable(store); // scout_findings は遅延作成なので、種を蒔く前に作る
  for (let i = 0; i < n; i++) await seedFinding(store, i);
  return store;
}

// ---------------------------------------------------------------------------
await t('レジストリ: X / note / ココナラ / YouTube の4媒体を持つ', () => {
  const ids = CHANNELS.map((c) => c.id);
  for (const id of ['x', 'note', 'coconala']) assert.ok(ids.includes(id), `${id} が無い`);
  for (const c of CHANNELS) {
    assert.ok(c.human, `${c.id}: 人がやることが書かれている`);
    assert.ok(c.cap && Number(c.cap.n) > 0, `${c.id}: 本数の上限がある`);
    assert.ok(Array.isArray(c.notes) && c.notes.length, `${c.id}: 注意書きがある`);
  }
});

await t('X: リンクを開くと本文が入っている（タップ1回）', () => {
  const c = composeFor('x', { body: 'テスト本文です https://example.com/a' });
  assert.equal(c.mode, 'prefilled');
  assert.ok(c.url.startsWith('https://x.com/intent/post?text='), `url=${c.url}`);
  const decoded = decodeURIComponent(c.url.split('text=')[1]);
  assert.ok(decoded.includes('テスト本文です'), '本文がURLに入っている');
  assert.ok(c.fallback_url.includes('twitter.com/intent/tweet'), '代替URLも出す');
  assert.equal(c.steps.length, 3, '手順は3つまで');
});

await t('X: 日本語は重み2で数え、URLを落とさない（280文字の重み付き上限）', () => {
  assert.equal(weightedLen('あ'), 2);
  assert.equal(weightedLen('ab'), 2);
  const long = `${'あ'.repeat(300)}\nhttps://example.com/x`;
  const f = fitToX(long);
  assert.ok(f.text.endsWith('https://example.com/x'), 'URLが残る');
  assert.ok(f.weighted <= 280, `weighted=${f.weighted}`);
  assert.equal(f.truncated, true, '切ったことを正直に返す');
  const c = composeFor('x', { body: long });
  const decoded = decodeURIComponent(c.url.split('text=')[1]);
  assert.ok(decoded.includes('https://example.com/x'), 'intent URLにもURLが残る');
});

await t('note: 貼るだけの塊を出し、AI開示が冒頭にある', () => {
  const d = templateFor('note', { title: 'テスト候補', url: 'https://example.com/a', score: 55, fits_json: '["content"]', signals_json: '["bounty"]', trial_json: TRIAL });
  assert.ok(d.body.startsWith('この記事はAI（人工知能）を使って作成しました。'), '開示が冒頭');
  assert.ok(d.body.length > 200, `本文長=${d.body.length}（薄い成果物を出さない）`);
  assert.equal(d.kind, 'article');
  const c = composeFor('note', d);
  assert.equal(c.mode, 'paste');
  assert.ok(c.url.includes('note.com'), `url=${c.url}`);
  assert.ok(c.copy_text.includes('AI（人工知能）'), 'コピー塊に開示が含まれる');
});

await t('YouTube: 台本・概要欄・サムネ指示を出し、既存ゲートを通る', () => {
  const d = templateFor('youtube', { title: 'テスト候補', url: 'https://example.com/a', score: 55 });
  for (const key of ['【台本】', '【概要欄】', '【サムネイル指示】']) assert.ok(d.body.includes(key), `${key} が無い`);
  assert.ok(d.body.includes('この動画はAI'), 'AI開示が入っている');
  assert.equal(d.ai_disclosure, 1, 'AI開示フラグ');
  assert.equal(d.unique_commentary, 1, '独自の解説フラグ（外部リンク目的だけの動画は規約違反）');
  const c = composeFor('youtube', d);
  assert.equal(c.mode, 'upload');
  assert.equal(c.video_required, true, '動画ファイルが要ることを明示する');
  assert.ok(c.notes.some((n) => n.includes('ffmpeg')), '動画合成ができないことを隠さない');
});

await t('未知の媒体: 黙って通さない', () => {
  const r = composeFor('tiktok', { body: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_channel');
});

await t('自動補充: scout の候補から下書きを作り、媒体をローテーションする', async () => {
  const store = await freshStore(6);
  const r = await refillQueue({ store, limit: 3 });
  assert.equal(r.created.length, 3, `created=${r.created.length} blocked=${JSON.stringify(r.blocked)}`);
  const channels = r.created.map((c) => c.channel);
  // YouTube を外したので、ローテーションは X と note の2媒体（ココナラは別枠で作る）
  assert.ok(new Set(channels).size >= 2, `媒体が回っていない: ${channels.join(',')}`);
  const rows = await listDrafts(store, { limit: 20 });
  assert.ok(rows.every((d) => d.state === 'queued'), '作った下書きは承認待ちに入る');
  const withLink = rows.find((d) => d.channel === 'x');
  assert.ok(withLink && withLink.body.includes('example.com'), 'Xの下書きに出典URLが入っている');
});

await t('重複防止: 同じ候補を二度使わず、同じ品目も二度出品しない', async () => {
  const store = await freshStore(4);
  const r1 = await refillQueue({ store, limit: 4 });
  assert.ok(r1.created.length >= 3, `1回目: ${r1.created.length}`);
  for (let i = 0; i < 12; i++) await refillQueue({ store, limit: 4 }); // 出品（品目7つ）まで使い切る
  const r3 = await refillQueue({ store, limit: 4 });
  assert.equal(r3.created.length, 0, `使い切った後に作った: ${JSON.stringify(r3.created)}`);
  assert.ok(r3.reason && r3.reason.length > 10, `0件の理由が無い: ${r3.reason}`);
  const rows = await listDrafts(store, { limit: 80 });
  const live = rows.filter((d) => d.state !== 'blocked');
  for (const s of SAMPLES) {
    // 数えるのは「同じ候補を使った下書きの本数」。YouTubeの台本は概要欄にも出典URLを
    // 入れる設計なので、1本の下書きにURLが2回出るのは正常。
    const n = live.filter((d) => String(d.body || '').includes(s.url)).length;
    assert.ok(n <= 1, `同じ候補が ${n} 本の下書きで使われた: ${s.url}`);
  }
  const co = live.filter((d) => d.channel === 'coconala').map((d) => d.title);
  assert.equal(new Set(co).size, co.length, `同じ品目を二度出品した: ${co.join(' | ')}`);
});

await t('上限: Xのリンク付きは1日3件を超えない（既存ゲートが効く）', async () => {
  const store = await freshStore(6);
  const r = await refillQueue({ store, limit: 6, channels: ['x'] });
  assert.ok(r.created.length <= 3, `created=${r.created.length}`);
  assert.ok(r.blocked.some((b) => b.blocks.some((x) => x.includes('上限'))), JSON.stringify(r.blocked));
  assert.ok(r.deferred >= 1, '上限による差し戻しは一時的なので候補を消費しない');
});

await t('一括承認: 全媒体ぶんの「開くだけの材料」を1回で返す', async () => {
  const store = await freshStore(6);
  await refillQueue({ store, limit: 3 });
  const r = await approveAll(store);
  assert.equal(r.count, 3, `count=${r.count}`);
  for (const a of r.approved) {
    assert.ok(a.url, `${a.channel}: 開くURLがある`);
    assert.ok(a.steps.length >= 3, `${a.channel}: 手順がある`);
    assert.ok(a.human, `${a.channel}: 人がやることが書かれている`);
  }
  const rows = await listDrafts(store, { limit: 20 });
  assert.ok(rows.some((d) => d.state === 'approved'), '承認済みになっている');
  assert.ok(!rows.some((d) => d.state === 'posted'), '投稿はしない（承認制のまま）');
});

await t('状態: 媒体ごとの残り枠と、押すだけの件数を出す', async () => {
  const store = await freshStore(5);
  await refillQueue({ store, limit: 3 });
  const rep = await socialReport(store);
  assert.equal(rep.by_channel.length, 3);
  for (const c of rep.by_channel) {
    assert.ok(c.left >= 0 && c.left <= c.limit, `${c.id}: left=${c.left}/${c.limit}`);
  }
  assert.equal(rep.one_tap_total, 3, `one_tap_total=${rep.one_tap_total}`);
  assert.ok(String(rep.video_note || '').includes('外しました'), 'YouTubeを外したことを隠さない');
  assert.ok(!rep.by_channel.some((c) => c.id === 'youtube'), '外した媒体がカードに残っている');
  const cards = socialCards(rep);
  assert.ok(cards.length >= 2, 'カードが出る');
  assert.ok(socialHelp().includes('ココナラ'), 'ヘルプが媒体を正しく書く');
});

await t('回帰: channels=null / [] / 知らないIDでも落ちない（「0件」で固まった原因）', async () => {
  const store = await freshStore(4);
  const r = await refillQueue({ store, limit: 2, channels: null });
  assert.equal(r.created.length, 2, `created=${r.created.length}`);
  assert.deepEqual(r.channels, ['x', 'note', 'coconala']);
  const r2 = await refillQueue({ store, limit: 2, channels: [] });
  assert.ok(Array.isArray(r2.created) && r2.created.length >= 1, `[] で落ちた: ${JSON.stringify(r2).slice(0, 140)}`);
  const r3 = await refillQueue({ store, limit: 2, channels: ['tiktok'] });
  assert.deepEqual(r3.channels, ['x', 'note', 'coconala'], '知らないIDだけなら既定に戻す');
});

await t('ココナラ: 候補が無くても出品の下書きを作り、価格は決めた980円で出す', async () => {
  const store = await freshStore(0); // 拾った候補ゼロでも出品は作れる
  const r = await refillQueue({ store, limit: 2 });
  assert.equal(r.created.length, 2, `created=${r.created.length}`);
  assert.ok(r.created.every((c) => c.channel === 'coconala'), '候補が無いときは出品だけを作る');
  const rows = await listDrafts(store, { limit: 20 });
  const co = rows[0];
  for (const key of ['【できること】', '【納品物】', '【価格】', '【できないこと】']) assert.ok(co.body.includes(key), `${key} が無い`);
  assert.ok(co.body.includes('980円'), '価格を勝手に決めない');
  assert.ok(!/https?:\/\//.test(co.body), '出品本文に外部URLを入れない');
  const c = composeFor('coconala', co);
  assert.equal(c.mode, 'paste');
  assert.ok(c.url.startsWith('https://coconala.com/services/add'), `url=${c.url}`);
  assert.ok(c.steps.length >= 3, '手順が出る');
});

// --------------------------------------------------------------------------
// 回帰: 画面の媒体名を app.js が決め打ちしていたため、ココナラが「YouTubeに
// アップロード」と表示され、押すとココナラに飛ぶ状態になっていた。媒体名は
// サーバーが返す値（action / cta / done_label）に一本化する。
// --------------------------------------------------------------------------
const _eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''}: expected ${b} / got ${a}`); };
const _ok = (v, m) => { if (!v) throw new Error(m || 'not ok'); };

await t('媒体ごとの見出し: 全媒体が固有の action を持ち、ココナラがYouTube表示にならない', async () => {
  for (const id of CHANNELS.map((c) => c.id)) {
    const r = composeFor(id, { title: 't', body: 'b' });
    _eq(r.ok, true, `${id} ok`);
    _ok(r.action && r.cta && r.done_label, `${id} に見出しがある`);
    if (id !== 'youtube') _ok(r.action !== 'YouTubeにアップロード', `${id} がYouTube表示`);
  }
  _eq(composeFor('coconala', { title: 't', body: 'b' }).action, 'ココナラに出品', 'coconala action');
  _eq(composeFor('youtube', { title: 't', body: 'b' }).action, 'YouTubeにアップロード', 'youtube action');
  _eq(composeFor('nope', { title: 't', body: 'b' }).ok, false, '知らない媒体は拒否');
});

await t('ココナラ: 手順は出品向け・価格は980円・本文に外部URLを入れない', async () => {
  const r = composeFor('coconala', { title: 'タイトル', body: '案: 1,000円（あなたが決めてください）' });
  _eq(r.url, 'https://coconala.com/services/add', 'compose url');
  _ok(String(r.steps.join(' ')).includes('出品'), '手順に「出品」が入る');
  _eq(r.copy_label, 'タイトルと本文をコピー', 'コピーの見出し');
  _ok(!/https?:\/\//.test(String(r.copy_text).replace('タイトル\n\n', '')), '出品本文に外部URLを入れない');
});

await t('一括承認は二度押しても同じリンクを返す（承認済みを取り残さない）', async () => {
  const store = await freshStore(6);
  await refillQueue({ store, limit: 3 });
  const a = await approveAll(store);
  _ok(a.count > 0, 'まず材料が作られる');
  const b = await approveAll(store);
  _eq(b.count, a.count, '二度目も同じ件数を返す');
  _ok(b.approved.every((x) => x.url), '全件に開くURLがある');
});

await t('YouTube: 下書きの対象から外した（明示指定でも作らない）', async () => {
  assert.ok(!CHANNEL_IDS.includes('youtube'), `CHANNEL_IDS=${CHANNEL_IDS}`);
  assert.ok(CHANNEL_IDS.includes('coconala'), 'ココナラは残す');
  const store = await freshStore(6);
  const r = await refillQueue({ store, limit: 4, channels: ['youtube'] });
  assert.equal(r.created.filter((c) => c.channel === 'youtube').length, 0, `youtube を作った: ${JSON.stringify(r.created.map((c) => c.channel))}`);
  assert.ok(!r.channels.includes('youtube'), `既定に混ざっている: ${r.channels}`);
  const rep = await socialReport(store);
  assert.ok(!rep.by_channel.some((c) => c.id === 'youtube'), '状態カードに残っている');
  // 後方互換: レジストリには残すので、過去に作った下書きは今も開ける
  const c = composeFor('youtube', { body: 'テスト', title: 't' });
  assert.equal(c.mode, 'upload');
});

console.log(`\nSNS: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);