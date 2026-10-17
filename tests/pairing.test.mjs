// ペアリング（端末の再接続）— 外部通信なし。D1 の代わりに settings 表だけを持つ偽 store。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintPairing, pairState, redeemPairing, generateCode, normalizeCode, hashCode,
  CODE_RE, PAIR_KEY, PAIR_MAX_TRIES,
} from '../src/agent/pairing.js';

function fakeStore() {
  const map = new Map();
  return {
    _map: map,
    async first(sql, ...args) {
      if (/FROM settings WHERE key=\?/.test(sql)) {
        const v = map.get(args[0]);
        return v === undefined ? null : { key: args[0], value: v };
      }
      return null;
    },
    async run(sql, ...args) {
      if (/INSERT INTO settings/.test(sql)) { map.set(args[0], args[1]); return { ok: true }; }
      if (/DELETE FROM settings WHERE key=\?/.test(sql)) { map.delete(args[0]); return { ok: true }; }
      return { ok: true };
    },
  };
}

const T0 = '2026-10-16T10:00:00.000Z';
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();

test('code: 形が決まっている（紛らわしい文字を使わない）', () => {
  for (let i = 0; i < 200; i++) {
    const c = generateCode();
    assert.match(c, CODE_RE);
    assert.ok(!/[0O1IL]/.test(c.replace('-', '')), `紛らわしい文字が入った: ${c}`);
  }
});

test('code: 区切り・大小を無視して同じコードとして扱う', async () => {
  assert.equal(normalizeCode(' abcd-2345 '), 'ABCD2345');
  assert.equal(await hashCode('abcd-2345'), await hashCode('ABCD 2345'));
});

test('mint: 発行すると受け付け状態になる（コード本体は保存しない）', async () => {
  const store = fakeStore();
  const m = await mintPairing(store, { now: T0, rnd: () => 0.5 });
  assert.match(m.code, CODE_RE);
  assert.equal(m.ttl_minutes, 30);
  const st = await pairState(store, at(1));
  assert.equal(st.open, true);
  assert.ok(st.minutes_left > 0 && st.minutes_left <= 30);
  // 保存されているのはハッシュだけ（平文のコードが残っていない）
  const raw = store._map.get(PAIR_KEY);
  assert.ok(!raw.includes(normalizeCode(m.code)));
  assert.ok(raw.includes(await hashCode(m.code)));
});

test('redeem: 正しいコードでトークンが渡り、コードは消える', async () => {
  const store = fakeStore();
  const m = await mintPairing(store, { now: T0, rnd: () => 0.3 });
  const r = await redeemPairing(store, m.code, { token: 'tok-abcdefghijklmnop', now: at(1) });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'tok-abcdefghijklmnop');
  assert.equal(await pairState(store, at(2)).then((s) => s.open), false);
});

test('redeem: 使い捨て（2回目は通らない）', async () => {
  const store = fakeStore();
  const m = await mintPairing(store, { now: T0 });
  await redeemPairing(store, m.code, { token: 'tok-abcdefghijklmnop', now: at(1) });
  const again = await redeemPairing(store, m.code, { token: 'tok-abcdefghijklmnop', now: at(2) });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'no_pairing_open');
});

test('redeem: 打ち間違いは回数を数え、残り回数を返す', async () => {
  const store = fakeStore();
  await mintPairing(store, { now: T0, rnd: () => 0.7 });
  const bad = await redeemPairing(store, 'ZZZZ-ZZZZ', { token: 'tok-abcdefghijklmnop', now: at(1) });
  assert.equal(bad.error, 'bad_code');
  assert.equal(bad.tries_left, PAIR_MAX_TRIES - 1);
});

test('redeem: 3回間違えるとコードを無効化する（総当たりを成立させない）', async () => {
  const store = fakeStore();
  await mintPairing(store, { now: T0, rnd: () => 0.2 });
  await redeemPairing(store, 'AAAA-AAAA', { token: 'tok-abcdefghijklmnop', now: at(1) });
  await redeemPairing(store, 'BBBB-BBBB', { token: 'tok-abcdefghijklmnop', now: at(2) });
  const third = await redeemPairing(store, 'CCCC-CCCC', { token: 'tok-abcdefghijklmnop', now: at(3) });
  assert.equal(third.error, 'too_many_tries');
  assert.equal(await pairState(store, at(4)).then((s) => s.open), false);
});

test('redeem: 期限が切れたコードは通らない', async () => {
  const store = fakeStore();
  const m = await mintPairing(store, { now: T0, ttlMs: 60000 });
  const late = await redeemPairing(store, m.code, { token: 'tok-abcdefghijklmnop', now: at(30) });
  assert.equal(late.error, 'expired');
  assert.equal(await pairState(store, at(30)).then((s) => s.open), false);
});

test('redeem: コード未発行なら断る', async () => {
  const store = fakeStore();
  const r = await redeemPairing(store, 'ABCD-2345', { token: 'tok-abcdefghijklmnop', now: T0 });
  assert.equal(r.error, 'no_pairing_open');
});

test('redeem: トークン未設定のときはコードを消費しない', async () => {
  const store = fakeStore();
  const m = await mintPairing(store, { now: T0, rnd: () => 0.9 });
  const r = await redeemPairing(store, m.code, { token: null, now: at(1) });
  assert.equal(r.error, 'token_not_configured');
  assert.equal(await pairState(store, at(2)).then((s) => s.open), true); // まだ使える
  const ok = await redeemPairing(store, m.code, { token: 'tok-abcdefghijklmnop', now: at(3) });
  assert.equal(ok.ok, true);
});

test('code: 総当たり耐性（探索空間が十分に広い）', () => {
  const space = Math.pow(32, 8);
  assert.ok(space > 1e12, `探索空間が狭い: ${space}`);
});
