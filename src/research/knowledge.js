// Knowledge base — upload → parse → chunk → index → cited Q&A.
// Retrieval is FTS5 keyword search over chunks (works with zero AI budget);
// answers are only produced from retrieved chunks, always with citations.

import { id as newId, nowIso, j, truncate, hash, likePattern} from '../util.js';
import { BASIS } from '../truth.js';

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;

export function createKnowledge({ store, router }) {
  async function ingest({ name, mime = 'text/plain', text, chunksHint = null }) {
    const clean = String(text || '').replace(/\u0000/g, '');
    if (clean.trim().length < 20) return { ok: false, error: 'empty_document', summary: '文書のテキストが空です' };

    const docId = newId('doc');
    const chunks = chunkText(clean);
    await store.insert('documents', {
      id: docId, name, mime, size: clean.length, chunks: chunks.length,
      text_preview: truncate(clean, 400), created_at: nowIso(),
    });
    const rows = chunks.map((t, i) => ({ id: `${docId}_c${i}`, doc_id: docId, seq: i, text: t, tokens: Math.round(t.length / 3) }));
    for (let i = 0; i < rows.length; i += 50) {
      await store.insertMany('doc_chunks', rows.slice(i, i + 50));
    }
    // FTS index
    try {
      for (const r of await store.all('SELECT rowid, text FROM doc_chunks WHERE doc_id=?', docId)) {
        await store.run('INSERT INTO doc_chunks_fts (rowid, text) VALUES (?,?)', r.rowid, r.text);
      }
    } catch { /* FTS optional */ }

    return { ok: true, id: docId, name, chunks: chunks.length, chars: clean.length };
  }

  async function query({ question, limit = 5 }) {
    const terms = String(question).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).slice(0, 8);
    let hits = [];
    if (terms.length) {
      try {
        hits = await store.all(
          `SELECT c.*, d.name AS doc_name FROM doc_chunks_fts f
             JOIN doc_chunks c ON c.rowid=f.rowid JOIN documents d ON d.id=c.doc_id
            WHERE doc_chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
          terms.map((t) => `${t}*`).join(' OR '), limit);
      } catch { hits = []; }
      if (!hits.length) {
        hits = await store.all(
          `SELECT c.*, d.name AS doc_name FROM doc_chunks c JOIN documents d ON d.id=c.doc_id
            WHERE instr(c.text, ?) > 0 LIMIT ?`, String(terms[0] || '').slice(0, 64), limit);
      }
    }
    // score by term overlap for stable ordering
    hits = hits.map((h) => {
      const low = h.text.toLowerCase();
      const score = terms.reduce((s, t) => s + (low.split(t).length - 1), 0);
      return { ...h, score };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    const answer = await answerFromChunks(question, hits);
    return {
      question, hits: hits.map((h) => ({
        doc_id: h.doc_id, doc_name: h.doc_name, seq: h.seq,
        text: truncate(h.text, 500), score: h.score,
        citation: `${h.doc_name}#chunk${h.seq}`,
      })),
      answer,
    };
  }

  async function answerFromChunks(question, hits) {
    if (!hits.length) {
      return { text: '文書内に根拠が見つかりませんでした。回答は生成しません（推測で補いません）。', citations: [], grounded: false };
    }
    const block = hits.map((h, i) => `[${i + 1}] (${h.doc_name} #${h.seq})\n${truncate(h.text, 900)}`).join('\n\n');
    if (router?.availableProviders().length) {
      const r = await router.complete({
        role: 'summarizer',
        system: 'あなたは資料に基づいてのみ回答するアシスタントです。必ず [番号] で引用し、資料に無いことは「資料に記載がありません」と述べます。',
        user: `質問: ${question}\n\n# 根拠候補\n${block}\n\nJSON: {"answer":"...","used":[1,2],"unsupported":"資料に無いため答えられない部分"}`,
        json: true, schema: ['answer', 'used', 'unsupported'], maxTokens: 800, temperature: 0.1,
      });
      const p = r.json;
      if (p?.answer) {
        return {
          text: p.answer, citations: (p.used || []).map((n) => hits[n - 1]?.citation).filter(Boolean),
          unsupported: p.unsupported || null, grounded: true, provider: r.provider,
        };
      }
    }
    return {
      text: `資料からの抜粋（${hits.length}件）:\n\n` + hits.slice(0, 3).map((h, i) => `[${i + 1}] ${truncate(h.text, 400)}`).join('\n\n'),
      citations: hits.slice(0, 3).map((h) => `${h.doc_name}#chunk${h.seq}`),
      grounded: true, mode: 'extractive',
      note: 'AIキー未設定のため抽出的に提示しています（要約生成はしていません）。',
    };
  }

  async function list() {
    const docs = await store.all('SELECT id,name,mime,size,chunks,created_at FROM documents ORDER BY created_at DESC LIMIT 100');
    const total = docs.reduce((s, d) => s + (d.size || 0), 0);
    return { documents: docs, totalChars: total };
  }

  async function remove(docId) {
    await store.run('DELETE FROM doc_chunks WHERE doc_id=?', docId);
    await store.run('DELETE FROM documents WHERE id=?', docId);
    return { ok: true };
  }

  return { ingest, query, list, remove, chunkText };
}

export function chunkText(text) {
  const clean = String(text).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + CHUNK_CHARS);
    if (end < clean.length) {
      const brk = clean.lastIndexOf('\n', end);
      if (brk > i + CHUNK_CHARS * 0.5) end = brk;
      else {
        const sp = clean.lastIndexOf('。', end);
        const sp2 = clean.lastIndexOf('. ', end);
        const cut = Math.max(sp, sp2);
        if (cut > i + CHUNK_CHARS * 0.5) end = cut + 1;
      }
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return chunks.filter((c) => c.length > 20);
}
