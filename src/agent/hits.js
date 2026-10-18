// x402 の「人が来たか」を数える計器。売上（receipts）とは別物で、
// 値札(402)を見に来た呼び出しを記録する。呼び手は短い指紋だけで残す（個人は特定しない）。
export const HITS_TABLE = 'x402_hits';

export async function ensureHits(store) {
  try {
    await store.run(`CREATE TABLE IF NOT EXISTS ${HITS_TABLE} (id TEXT PRIMARY KEY, at TEXT NOT NULL, resource TEXT, kind TEXT NOT NULL, status INTEGER, caller TEXT, ua TEXT, note TEXT)`);
    await store.run(`CREATE INDEX IF NOT EXISTS x402_hits_at ON ${HITS_TABLE}(at)`);
  } catch { /* 計器が無くても売り物は動く */ }
}

/** 値札(402)を見た／払った／弾かれた を1行だけ残す。失敗しても本筋は止めない。 */
export async function logHit(store, request, { resource, kind, status = 0, note = null } = {}) {
  if (!store || !kind) return null;
  try {
    const raw = (request && (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for'))) || '';
    const ip = String(raw).split(',')[0].trim();
    let caller = null;
    if (ip) {
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|x402-hits`));
        caller = [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { caller = null; }
    }
    const selfTest = request && request.headers.get('x-wa-selftest') ? 'self_test' : null;
    await ensureHits(store);
    await store.insert(HITS_TABLE, {
      id: `hit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(), resource: resource || null, kind, status,
      caller, ua: ((request && request.headers.get('user-agent')) || '').slice(0, 160) || null,
      note: selfTest || note,
    });
    return { ok: true };
  } catch { return null; }
}
