// Browser Agent — read-only extraction with respectful, bounded fetching.
//
// Honest scope statement (surfaced in the UI):
//   * This agent READS public pages over HTTP and extracts structured content.
//   * It does NOT log in, solve CAPTCHAs, bypass anti-bot protection, or submit
//     forms on remote sites. Those require an approval-gated flow and a real
//     browser runtime, which Cloudflare Workers does not provide.
//   * Every fetch is rate-limited and cached; robots-disallowed paths are skipped.

import { id as newId, nowIso, truncate, hash, safeJson } from '../util.js';
import { sanitizeExternal } from '../safety.js';

const DISALLOW = [/\/wp-login/, /\/admin/, /\/logout/, /\/signin/, /\/login/, /\/checkout/, /\/cart/];

export function createBrowser({ store, research }) {
  const lastFetch = new Map();

  async function extract({ url, selectorGoal = null, maxChars = 8000 }) {
    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, error: 'invalid_url', summary: 'URLが不正です' }; }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'unsupported_protocol', summary: 'http/https のみ対応しています' };
    if (parsed.hostname === 'localhost' || /^127\.|^10\.|^192\.168\.|^169\.254\.|\.internal$/.test(parsed.hostname)) {
      return { ok: false, error: 'blocked_private_host', summary: 'プライベートネットワーク宛の取得は拒否しました（SSRF対策）' };
    }
    if (DISALLOW.some((re) => re.test(parsed.pathname))) {
      return { ok: false, error: 'disallowed_path', summary: 'ログイン/決済系のパスは取得対象外です（権限が必要な操作は行いません）' };
    }
    // Rate limit: 1 request / 1.5s per host
    const now = Date.now();
    const prev = lastFetch.get(parsed.hostname) || 0;
    if (now - prev < 1500) await new Promise((r) => setTimeout(r, 1500 - (now - prev)));
    lastFetch.set(parsed.hostname, Date.now());

    const robots = await checkRobots(parsed.origin, parsed.pathname);
    if (robots === 'disallowed') {
      return { ok: false, error: 'robots_disallowed', summary: 'robots.txt により取得が許可されていません', robots };
    }

    const page = await research.fetch(url, { store });
    if (!page.ok) return { ok: false, error: page.error || 'fetch_failed', summary: `取得失敗: ${url} (${page.error})`, robots };

    const { text, flagged } = sanitizeExternal(page.text, maxChars);
    const tables = extractTables(page.text);
    const links = extractLinks(page.text, parsed.origin);

    return {
      ok: true, url, title: page.title, status: page.status, robots,
      textLength: text.length, text: truncate(text, maxChars),
      headings: extractHeadings(page.text),
      tables, links: links.slice(0, 40),
      sanitizedInstructions: flagged,
      note: 'これはHTTP取得による読み取りです。JavaScript実行やログインが必要なページでは内容が不完全な場合があります。',
    };
  }

  async function checkRobots(origin, path) {
    try {
      const r = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': 'WealthAgent/1.0' } });
      if (!r.ok) return 'unknown';
      const txt = await r.text();
      const lines = txt.split(/\r?\n/).map((l) => l.trim());
      let applies = false; const disallow = [];
      for (const l of lines) {
        if (/^user-agent:/i.test(l)) applies = /\*|wealthagent/i.test(l);
        else if (applies && /^disallow:/i.test(l)) { const p = l.split(':')[1]?.trim(); if (p) disallow.push(p); }
      }
      return disallow.some((d) => path.startsWith(d)) ? 'disallowed' : 'allowed';
    } catch { return 'unknown'; }
  }

  /** Compare two pages on the same question — used by the research flow. */
  async function compare({ urls = [], question = null }) {
    const pages = [];
    for (const u of urls.slice(0, 4)) {
      const r = await extract({ url: u, maxChars: 5000 });
      pages.push({ url: u, ok: r.ok, title: r.title, headings: r.headings, text: r.ok ? truncate(r.text, 1200) : null, error: r.error });
    }
    return {
      question, pages, comparable: pages.filter((p) => p.ok).length,
      note: '原文を並べて提示します。矛盾の自動判定は行いません（誤判定を避けるため）。',
    };
  }

  return { extract, compare };
}

function extractHeadings(html) {
  const out = [];
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 30) {
    const t = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) out.push({ level: Number(m[1]), text: truncate(t, 160) });
  }
  return out;
}

function extractTables(html) {
  const tables = [];
  const tre = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = tre.exec(html)) && tables.length < 5) {
    const rows = [];
    const rre = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = rre.exec(m[0])) && rows.length < 40) {
      const cells = [];
      const cre = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let c;
      while ((c = cre.exec(r[0]))) cells.push(c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80));
      if (cells.length) rows.push(cells);
    }
    if (rows.length > 1) tables.push(rows);
  }
  return tables;
}

function extractLinks(html, origin) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 100) {
    let href = m[1];
    try { href = new URL(href, origin).toString(); } catch { continue; }
    if (!/^https?:/.test(href)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ url: href, text: truncate(text, 80) });
  }
  return out;
}
