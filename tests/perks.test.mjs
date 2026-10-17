// 有益情報 (perks) のテスト — 出典・実額・期限・原価0の約束を壊していないか
import {
  T, PERK_KINDS, SEED_PERKS, perkKey, classifyPerk, isBeneficial, perkSignals,
  perkFrom, daysLeft, nextDeadline, expiryState, perkScore, rankPerks, runPerkProbe,
  ensurePerkTable, savePerk, seedPerks, ingestPerks, listPerks, perkSummary, perkText, perkHelp,
} from '../src/agent/perks.js';

let pass = 0; const fails = [];
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { fails.push(`${name}: ${e.message}`); }
};
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m = '') => { if (!v) throw new Error(m || 'expected truthy'); };

/** 必要なクエリだけ答える最小のストア */
function memStore() {
  const inserts = [];
  return {
    inserts,
    async run(sql, ...a) {
      if (/CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(sql)) return { success: true };
      if (/^INSERT INTO/i.test(sql)) { inserts.push(a); return { success: true }; }
      if (/^UPDATE/i.test(sql)) return { success: true };
      throw new Error('run unhandled: ' + sql.slice(0, 70));
    },
    async first(sql) {
      if (/SELECT id FROM/i.test(sql)) return null;
      if (/COUNT\(\*\)/i.test(sql)) return { n: 0 };
      throw new Error('first unhandled: ' + sql.slice(0, 70));
    },
    async all(sql) {
      if (/GROUP BY/i.test(sql)) return [];
      if (/^SELECT \*/i.test(sql)) return [];
      throw new Error('all unhandled: ' + sql.slice(0, 70));
    },
  };
}

const fakeFetch = (body, status = 200) => async () => ({ ok: status < 400, status, text: async () => body });

const NOW = '2026-10-18T00:00:00.000Z';
const days = (n) => new Date(Date.parse(NOW) + n * 86400000).toISOString();

await t('種はすべて出典URLと出典種別と裏取り文言を持つ', async () => {
  ok(SEED_PERKS.length >= 10, `種が少なすぎる: ${SEED_PERKS.length}`);
  for (const s of SEED_PERKS) {
    ok(/^https?:\/\//.test(s.url || ''), `url が無い: ${s.title}`);
    ok(['primary', 'secondary'].includes(s.source_quality), `source_quality が不正: ${s.title}`);
    ok((s.evidence || '').length > 20, `裏取り文言が無い: ${s.title}`);
    ok(Number.isFinite(s.outlay_jpy), `先に払う額が未定義: ${s.title}`);
    ok(PERK_KINDS.some((k) => k.id === s.kind), `kind が不正: ${s.title}`);
  }
});

await t('テーブル作成と種の投入（重複は増やさない）', async () => {
  const st = memStore();
  await ensurePerkTable(st);
  const r1 = await seedPerks(st, { now: NOW });
  eq(r1.inserted, SEED_PERKS.length, '1回目は全部入る');
  eq(st.inserts.length, SEED_PERKS.length);
});

await t('有益情報の判定: 金額つきの特典は拾い、質問・愚痴は捨てる', async () => {
  ok(isBeneficial('Google AI Pro を契約すると Google Play ギフトがもらえる（最大5,000円分）'));
  ok(isBeneficial('もれなく10%分のギフトコードプレゼント'));
  ok(isBeneficial('$14.50 for verifying your Reddit account'));
  ok(!isBeneficial('Is this legit? help me understand the fees'));
  ok(!isBeneficial('愚痴：ポイント還元が減った気がする'));
  ok(!isBeneficial('Character.AI files for bankruptcy, to sell some assets for $20 million'), '金額だけのニュースは拾わない');
  ok(!isBeneficial('Anthropic ran a 26B model across 15 off-brand Android TV boxes worth $55 each'), 'off-brand を「割引」と誤認しない');
  ok(isBeneficial('Sennheiser Momentum 4 Headphones at $207 (31% off)'), '金額+割引の形は拾う');
  ok(!isBeneficial('もらえるらしいよ'), 'シグナル1つ・金額なしは拾わない');
  ok(isBeneficial('無料トライアル実施中・ポイント5倍キャンペーン'), '別々の強いシグナルが2つあれば拾う');
});

await t('種類の判定', async () => {
  eq(classifyPerk({ title: 'もれなく購入金額の最大10%分を還元' }), 'cashback');
  eq(classifyPerk({ title: 'Pontaカードでポイント5倍' }), 'points');
  eq(classifyPerk({ title: 'Google Play ギフトコード 10%OFFクーポン' }), 'discount');
  eq(classifyPerk({ title: '$50 bounty for fixing this' }), 'reward');
  eq(classifyPerk({ title: '無料トライアル3か月' }), 'perk');
});

await t('perkSignals は金額シグナルを立てる', async () => {
  ok(perkSignals('最大 5,000円分もらえる').includes('money'));
  ok(perkSignals('$14.50').includes('money'));
  ok(perkSignals('最大10%分').includes('money'));
});

await t('perkFrom は同じ入力なら同じキー（重複しない）', async () => {
  const a = perkFrom({ kind: 'perk', title: 'x', url: 'https://a.example/1', site: 'a.example' });
  const b = perkFrom({ kind: 'perk', title: 'x', url: 'https://a.example/1', site: 'a.example' });
  const c = perkFrom({ kind: 'perk', title: 'x', url: 'https://a.example/2', site: 'a.example' });
  eq(a.key, b.key);
  ok(a.key !== c.key, 'URLが違えば別キー');
  eq(a.outlay_jpy, 0, '既定は先払い0');
  eq(perkKey({ kind: 'perk', site: 'a.example', url: 'https://a.example/1', title: 'x' }), a.key);
});

await t('期限の判定（過ぎた / 7日以内 / 有効 / 不明）', async () => {
  eq(expiryState({ expires_at: days(-1) }, NOW), 'expired');
  eq(expiryState({ expires_at: days(3) }, NOW), 'soon');
  eq(expiryState({ expires_at: days(30) }, NOW), 'active');
  eq(expiryState({ expires_at: null }, NOW), 'unknown');
  eq(daysLeft(days(-2), NOW), -2);
});

await t('スコアは 期限が近い × 実額 で決まる', async () => {
  const soon = { expires_at: days(2), benefit_jpy: 5000 };
  const later = { expires_at: days(60), benefit_jpy: 5000 };
  ok(perkScore(soon, NOW) > perkScore(later, NOW), '期限が近いほうが上');
  ok(perkScore({ expires_at: days(2), benefit_jpy: 5000 }, NOW) > perkScore({ expires_at: days(2), benefit_jpy: 100 }, NOW), '実額が大きいほうが上');
  eq(perkScore({ expires_at: days(-1), benefit_jpy: 99999 }, NOW) < perkScore(soon, NOW), true, '期限切れは沈む');
});

await t('rankPerks は期限が近く実額が大きいものを先頭に出す', async () => {
  const rows = [
    { title: 'A', expires_at: days(60), benefit_jpy: 1000 },
    { title: 'B', expires_at: days(1), benefit_jpy: 5000 },
    { title: 'C', expires_at: days(-5), benefit_jpy: 99999 },
  ];
  eq(rankPerks(rows, { now: NOW }).map((r) => r.title), ['B', 'A', 'C']);
});

await t('確認（読み取り）: 実額の記載 / 終了の記載 / 到達不可', async () => {
  const live = await runPerkProbe({ url: 'https://a.example/', expires_at: days(20) }, { fetchImpl: fakeFetch('<html>もれなく最大10%分</html>'), now: NOW });
  eq(live.verdict, 'mentions_amount');
  eq(live.evidence.expiry_state, 'active');
  const ended = await runPerkProbe({ url: 'https://a.example/' }, { fetchImpl: fakeFetch('<html>本キャンペーンは終了しました</html>'), now: NOW });
  eq(ended.verdict, 'ended');
  const dead = await runPerkProbe({ url: 'https://a.example/' }, { fetchImpl: fakeFetch('nope', 503), now: NOW });
  eq(dead.verdict, 'unreachable');
  const nourl = await runPerkProbe({ url: null }, { fetchImpl: fakeFetch(''), now: NOW });
  eq(nourl.verdict, 'no_url');
});

await t('取り込み: 有益なものだけ残し、2回目は重複しない', async () => {
  const st = memStore();
  await ensurePerkTable(st);
  const items = [
    { title: 'Google AI Pro契約で Google Play ギフトがもらえる（最大5,000円分）', url: 'https://r.example/1', subreddit: 'beermoney' },
    { title: 'Is this a scam? help me', url: 'https://r.example/2', subreddit: 'beermoney' },
    { title: '無料枠: $50 credit が貰える', url: 'https://r.example/3', subreddit: 'devops' },
  ];
  const r1 = await ingestPerks(st, items, { now: NOW });
  eq(r1.scanned, 3);
  eq(r1.inserted, 2, '質問は落ちる');
  eq(r1.kept.length, 2);
  ok(r1.kept.some((k) => k.title.includes('Play')), '有益なものが残る');
});

await t('人が読む形: 期限が近いものが先頭に出て、出典と裏取りが付く', async () => {
  const rows = [
    perkFrom({ kind: 'perk', title: '遠い特典', url: 'https://a.example/x', site: 'a.example', expires_at: days(90), benefit_jpy: 100, source_quality: 'secondary' }),
    perkFrom({ kind: 'cashback', title: '近い還元', url: 'https://b.example/y', site: 'b.example', expires_at: days(2), benefit_jpy: 5000, source_quality: 'primary', evidence: '「もれなく最大10%分」', human: ['アプリのエントリー'], outlay_jpy: 1000, outlay_note: '買い物が前提' }),
  ];
  const txt = perkText(rows, { now: NOW });
  ok(txt.includes('期限が近い（7日以内）: 1件'), '期限が近いセクションが出る');
  ok(txt.indexOf('近い還元') < txt.indexOf('遠い特典'), '期限が近いものが先');
  ok(txt.includes('一次情報'), '出典の種別が出る');
  ok(txt.includes('人の操作: アプリのエントリー'), '人の1タップが明記される');
  ok(txt.includes('先に払う: 1,000円'), '先払いが明記される');
  ok(perkHelp().includes('自動応募'), '規約違反をしない方針が説明に載る');
});

await t('保存と一覧（実ストアで使う口が揃っている）', async () => {
  const st = memStore();
  await ensurePerkTable(st);
  const r = await savePerk(st, perkFrom({ kind: 'perk', title: 'x', url: 'https://a.example/1' }), { now: NOW });
  eq(r.inserted, true);
  await listPerks(st, { limit: 5 });
  await perkSummary(st, { now: NOW });
  eq(T, 'perks');
});

await t('1件が複数の期限を持ち、一番近い「まだ来ていない」期限で判定する', async () => {
  const lawson = SEED_PERKS.find((p) => p.deadlines && p.deadlines.length);
  ok(lawson, '複数期限を持つ種がある');
  ok(lawson.deadlines.length >= 3, '購入・応募・受け取りが分かれている');
  const nd = nextDeadline(lawson, '2026-10-18T00:00:00+09:00');
  eq(nd.label, '店頭で購入', '今日動くべき期限は購入');
  eq(nd.days_left, 1, '購入期限は残り1日');
  eq(expiryState(lawson, '2026-10-18T00:00:00+09:00'), 'soon', '期限が近い扱いになる');
  const later = nextDeadline(lawson, '2026-10-20T00:00:00+09:00');
  eq(later.label, 'コースへの応募', '購入が過ぎたら次は応募');
  eq(expiryState(lawson, '2026-11-03T00:00:00+09:00'), 'expired', '全部過ぎたら期限切れ');
});

await t('順位は「貰える額 − 先に払う額」× 期限の近さ', async () => {
  const soon = { benefit_jpy: 5000, outlay_jpy: 1000, deadlines: [{ label: '購入', at: '2026-10-19T23:59:00+09:00' }] };
  const far = { benefit_jpy: 5000, outlay_jpy: 1000, expires_at: '2027-10-31T23:59:00+09:00' };
  const dead = { benefit_jpy: 99999, outlay_jpy: 0, expires_at: '2026-09-01T00:00:00+09:00' };
  const n = '2026-10-18T00:00:00+09:00';
  ok(perkScore(soon, n) > perkScore(far, n), '期限が近いほうが上');
  eq(perkScore(dead, n), 0, '期限切れは金額が大きくても0');
  eq(perkScore({ benefit_jpy: 500, outlay_jpy: 5000 }, n), 0, '先に払う額が上回るなら0');
  const ranked = rankPerks([far, soon, dead], { now: n });
  eq(ranked[0].benefit_jpy, 5000, '先頭は期限が近いもの');
  eq(ranked[ranked.length - 1].expires_at, '2026-09-01T00:00:00+09:00', '末尾は期限切れ');
});

await t('一覧の先頭に「今日動くべきもの」が出る', async () => {
  const lawson = SEED_PERKS.find((p) => p.deadlines && p.deadlines.length);
  const txt = perkText([lawson], { now: '2026-10-18T00:00:00+09:00' });
  ok(txt.includes('今日動くべきもの'), '見出しが出る');
  ok(txt.includes('店頭で購入'), '何をすべきかが出る');
  ok(txt.includes('次に動く期限: 店頭で購入'), '各件にも次の期限が出る');
});

if (fails.length) { console.log(`perks: ${pass} passed, ${fails.length} FAILED`); for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log(`perks: ${pass}/0 (all passed)`);
