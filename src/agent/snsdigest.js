// SNS / 情報収集の定時報告（ダイジェスト）
// 収集済みテーブル（twitter_posts / scout_findings / perks）を「前回報告以降の新着」で束ねる。
// 収集元の列名に依存しないよう rowid で差分を取る（列名が変わっても壊れない）。
import { nowIso } from '../util.js';
import { setting, setSetting } from '../db.js';

export const DIGEST_VERSION = 'snsdigest-1.0';
export const DR = 'sns_reports';

export const SOURCES = [
  { id: 'twitter', table: 'twitter_posts', label: 'X・ニュース巡回' },
  { id: 'scout', table: 'scout_findings', label: '公開ソース巡回（HN / GitHub / 求人 / 国内）' },
  { id: 'perks', table: 'perks', label: '特典・案件' },
];

const rid = () => `sns_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
const num = (n) => Math.max(0, Math.floor(Number(n) || 0));

export async function ensureDigest(store) {
  try {
    await store.run(`CREATE TABLE IF NOT EXISTS ${DR} (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, payload_json TEXT NOT NULL, text TEXT,
      delivered INTEGER DEFAULT 0, note TEXT, created_at TEXT
    )`);
  } catch (e) { /* 既存なら何もしない */ }
}

const pick = (r, keys) => {
  for (const k of keys) {
    const v = r && r[k];
    if (v == null) continue;
    if (typeof v === 'object') continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
};
export const rowTitle = (r = {}) => pick(r, ['title', 'text', 'headline', 'name', 'summary', 'excerpt']) || '(見出しなし)';
export const rowUrl = (r = {}) => pick(r, ['url', 'link', 'permalink', 'html_url']);
export const rowSource = (r = {}) => pick(r, ['source', 'source_id', 'subreddit', 'provider', 'channel', 'handle']);

export async function snsDigest(store, { env = null, limit = 40, send = true } = {}) {
  await ensureDigest(store);
  const at = nowIso();
  const sources = [];
  let totalNew = 0;

  for (const s of SOURCES) {
    const key = `sns:last_rowid:${s.id}`;
    let mx = 0, n = 0, rows = [];
    try {
      const a = await store.first(`SELECT COALESCE(MAX(rowid),0) AS mx, COUNT(*) AS n FROM ${s.table}`);
      mx = num(a && a.mx); n = num(a && a.n);
    } catch (e) {
      sources.push({ id: s.id, label: s.label, error: String((e && e.message) || e).slice(0, 140) });
      continue;
    }
    const prevRaw = await setting(store, key, null).catch(() => null);
    const prev = prevRaw == null ? Math.max(0, mx - num(limit)) : num(prevRaw);
    try {
      rows = await store.all(`SELECT * FROM ${s.table} WHERE rowid > ${prev} ORDER BY rowid DESC LIMIT ${num(limit)}`);
    } catch (e) { rows = []; }
    const newCount = Math.max(0, mx - prev);
    totalNew += newCount;
    sources.push({
      id: s.id, label: s.label, total: n, new: newCount, shown: (rows || []).length,
      top: (rows || []).slice(0, 12).map((r) => ({ title: rowTitle(r).slice(0, 160), url: rowUrl(r), source: rowSource(r) })),
    });
    await setSetting(store, key, String(mx)).catch(() => {});
  }

  const lines = [`情報収集の定時報告 ${at}`, `新着 ${totalNew} 件`, ''];
  for (const s of sources) {
    lines.push(`■ ${s.label}（新着 ${s.new != null ? s.new : '?'} / 累計 ${s.total != null ? s.total : '?'}）`);
    if (s.error) lines.push(`  取得できず: ${s.error}`);
    else if (!s.top || !s.top.length) lines.push('  新着なし');
    else for (const t of s.top) lines.push(`  ・${t.title}${t.source ? ` [${t.source}]` : ''}${t.url ? ` ${t.url}` : ''}`);
    lines.push('');
  }
  const text = lines.join('\n');

  // 届け先が設定されていれば送る（未設定なら保存だけ＝アプリ内で見える）
  let delivered = 0, note = null;
  if (send) {
    const hook = await setting(store, 'notify:webhook', null).catch(() => null);
    if (hook && /^https?:\/\//.test(String(hook))) {
      try {
        const res = await fetch(String(hook), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `${text.slice(0, 3500)}`, source: 'wealth-agent', kind: 'sns_digest', at }),
        });
        delivered = res.ok ? 1 : 0;
        note = `webhook ${res.status}`;
      } catch (e) { note = `webhook error: ${String((e && e.message) || e).slice(0, 100)}`; }
    } else {
      note = 'no destination (notify:webhook 未設定)';
    }
  }

  const payload = { version: DIGEST_VERSION, at, total_new: totalNew, sources };
  const id = rid();
  try {
    await store.run(`INSERT INTO ${DR} (id,at,payload_json,text,delivered,note,created_at) VALUES ('${esc(id)}','${esc(at)}','${esc(JSON.stringify(payload))}','${esc(text)}',${delivered},'${esc(note || '')}','${esc(at)}')`);
  } catch (e) { /* 保存失敗でも本体は返す */ }

  return { version: DIGEST_VERSION, at, total_new: totalNew, delivered, note, sources, text };
}

export async function latestDigest(store) {
  await ensureDigest(store);
  const row = await store.first(`SELECT id,at,text,delivered,note,created_at FROM ${DR} ORDER BY created_at DESC LIMIT 1`).catch(() => null);
  if (!row) return null;
  const list = await store.all(`SELECT id,at,delivered,note FROM ${DR} ORDER BY created_at DESC LIMIT 10`).catch(() => []);
  return { ...row, recent: list || [] };
}

export async function digestScheduleHint(env) {
  const min = Math.max(60, Number((env && env.DIGEST_EVERY_MINUTES) || 360));
  return `定時報告は ${min} 分ごと。届け先は settings.notify:webhook を設定すると外にも送れる（未設定ならアプリ内のみ）。`;
}
