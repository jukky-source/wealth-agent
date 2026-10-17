// 分散の門 — 同一部品（出口違い）を1本に畳み、相関が高いものを落としているか
import { labCollectionFrom, labStructKey, pairCorr } from '../src/income/lab.js';

let pass = 0; const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m = '') => { if (!v) throw new Error(m || 'expected truthy'); };

const spec = (parts, exitKind) => ({ symbol: 'EURJPY', tf: '1d', logic: { parts }, exit: { kind: exitKind } });
const row = (key, parts, exitKind, fitness, extra = {}) => ({
  symbol: 'EURJPY', key, gatesPass: true, fitness, spec: spec(parts, exitKind), label: key, ...extra,
});
const dates = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));

t('出口だけ違う同じ中身は1本に畳まれる', () => {
  const rows = [
    row('g_a', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'tight', 100),
    row('g_b', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'wide', 95),
    row('g_c', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'timebox', 90),
  ];
  const { members, skipped } = labCollectionFrom(rows, { max: 6 });
  eq(members.length, 1, '3本が1本に畳まれる');
  eq(members[0].key, 'g_a', '残るのは一番良いもの');
  eq(skipped.filter((s) => s.why === 'same_structure').length, 2, '理由が残る');
  ok(labStructKey(rows[0]) === labStructKey(rows[1]), '出口が違っても同じ鍵');
  ok(labStructKey(rows[0]) !== labStructKey(row('g_d', [{ feature: 'rsi', op: 'gt', value: 70 }], 'tight', 80)), '中身が違えば別の鍵');
});

t('中身が違えば別々に残る', () => {
  const rows = [
    row('g_a', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'tight', 100),
    row('g_b', [{ feature: 'rsi', op: 'gt', value: 70 }], 'tight', 95),
  ];
  const { members } = labCollectionFrom(rows, { max: 6 });
  eq(members.length, 2);
  const w = members.reduce((s, m) => s + m.weight, 0);
  ok(Math.abs(w - 1) < 0.01, '重みの合計は1');
});

t('系列が付いていれば相関が高い個体は落ちる', () => {
  const d = dates(40);
  const base = d.map((_, i) => Math.sin(i / 3) * 2);
  const near = base.map((v) => v + 0.01);
  const rows = [
    { ...row('g_a', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'tight', 100), daily: d.map((x, i) => ({ date: x, pct: base[i] })) },
    { ...row('g_b', [{ feature: 'rsi', op: 'gt', value: 70 }], 'tight', 95), daily: d.map((x, i) => ({ date: x, pct: near[i] })) },
  ];
  const { members, skipped } = labCollectionFrom(rows, { max: 6 });
  eq(members.length, 1, '相関≒1は落ちる');
  eq(skipped[0].why, 'correlated', '理由が残る');
  ok(pairCorr(rows[0], rows[1]) > 0.9, '相関が実際に高い');
});

t('相関が低ければ両方残る（系列が無いときは判定不能として通す）', () => {
  const d = dates(40);
  const a = d.map((_, i) => Math.sin(i / 3) * 2);
  const b = d.map((_, i) => (i % 2 ? 1 : -1) * Math.cos(i / 5) * 2);
  const rows = [
    { ...row('g_a', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'tight', 100), daily: d.map((x, i) => ({ date: x, pct: a[i] })) },
    { ...row('g_b', [{ feature: 'rsi', op: 'gt', value: 70 }], 'tight', 95), daily: d.map((x, i) => ({ date: x, pct: b[i] })) },
  ];
  const { members } = labCollectionFrom(rows, { max: 6 });
  eq(members.length, 2, '低相関は残る');
  const noSeries = labCollectionFrom([row('g_a', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'tight', 100), row('g_b', [{ feature: 'rsi', op: 'gt', value: 70 }], 'tight', 95)], { max: 6 });
  eq(noSeries.members.length, 2, '系列が無ければ相関では落とさない');
});

t('members に重い row を持ち出さない', () => {
  const rows = [row('g_a', [{ feature: 'stoch_k', op: 'lt', value: 50 }], 'tight', 100)];
  const { members } = labCollectionFrom(rows, { max: 6 });
  ok(!('row' in members[0]), 'row は残さない');
  ok(members[0].struct && members[0].struct.includes('EURJPY'), '構造の鍵は残す');
});

if (fails.length) { console.log(`labdiv: ${pass} passed, ${fails.length} FAILED`); for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log(`labdiv: ${pass}/0 (all passed)`);
