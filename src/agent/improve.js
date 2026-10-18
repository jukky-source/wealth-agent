// 全般の改善ループ（improve loop）— FX だけでなく、エージェントの全レーンを同じ形で回す。
//
// 1ラウンド = 測る → 壁を名指しする → 手を変える → 記録する（improve_rounds）。
// 原価0の制約は変えない: 読み取りと自分の持ち物への書込だけ。人の1タップが要る所は
// approve で止め、「押すだけ」の形まで用意して記録に残す。
//
// なぜ要るか（2026-10-18 の実測）:
//   * 実売上 $0 が続いていたのに、「なぜ止まっているか」を毎回測っていたのは FX の lab だけだった。
//     ネタ帳・特典・REA・収集・売り物は、数だけが貯まり、出口が詰まっていても誰も気づかない。
//   * 同じ手を打ち続けても改善しない。壁ごとに打ち手を1対1で決め、3連続で無変化なら
//     見切りをつけて探索を広げる（lab loop と同じ規律）。
import { nowIso, safeJson } from '../util.js';
import { setting, setSetting } from '../db.js';
import { funnel, selfHeal } from './loop.js';
import { playbookSummary, ingestFindings, tryPlaybooks, seedPlaybooks } from './playbook.js';
import { perkSummary, tryPerks, seedPerks, ingestPerks } from './perks.js';
import { queueSummary, enqueueFromFindings, autoAnalyze } from './reaQueue.js';
import { scoutSummary, scoutTick } from './scout.js';
import { twitterSummary, sweepTwitter, listTweets, toPerkItems } from './twitter.js';
import { X402_CATALOG, preflight } from './x402.js';
import { labPassBoard, labBoardRanked } from '../income/lab.js';
import { labLoopRound, labLoopStatus } from '../income/labLoop.js';

export const IMPROVE_VERSION = 'improve-1.0';
export const IR = 'improve_rounds';
export const ISTATE_KEY = 'improve:state';
export const ICURSOR_KEY = 'improve:cursor';
export const STALL_LIMIT = 3;
export const HIST_MAX = 10;
export const ROW_MAX = 80;

const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const rid = () => `imp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const pick = (o, keys) => (keys || []).filter((k) => o && o[k] != null)
  .map((k) => `${k}=${typeof o[k] === 'object' ? JSON.stringify(o[k]).slice(0, 90) : String(o[k]).slice(0, 90)}`).join(' ');
const brief = (o, keys) => pick(o, keys) || (o && typeof o === 'object' ? Object.keys(o).slice(0, 4).join(',') : String(o || ''));

// 収集の向きを変えるときの語（現金化の報告が出る側へ寄せる）。
export const MONEY_QUERIES = [
  'beermoney payout proof',
  'bounty paid open source',
  '報酬 支払い 完了 アプリ',
  'cashout received reward app',
  'ギフトコード 配布 完了',
];

// ---------------------------------------------------------------------------
// レーン定義 — 各レーンは measure（測る）と act（手を変える）だけを持つ。
// walls は「壁 → 打ち手」の1対1対応。level は approve なら人が押す段で止める印。
// ---------------------------------------------------------------------------
export const LANES = [
  // 1) FX の論理（lab loop 本体に委譲。壁の名指しも lab loop の規則を使う）
  {
    key: 'fx',
    label: 'FXの論理（自己資金 / E8）',
    what: 'Yahoo 日足で候補を作り、門（15/6/40/45）で採点し、通った個体を実行部へ引き渡す。',
    fallback: 'none_pass',
    walls: {
      none_pass: { label: '門を通る個体が無い', why: '作っている候補が門で全部落ちている', fix: '門の近くまで来た個体を親にして周辺を変異させる', action: 'mutate_near_miss', level: 'allow' },
      plateau: { label: '伸び止まり', why: '同じ顔ぶれが上に居座り、改善が止まっている', fix: '親を捨てて探索範囲を広げる', action: 'explore_broaden', level: 'allow' },
      unmeasured: { label: '測れていない', why: '順位表が空で、どこで止まっているか分からない', fix: 'まず候補を作って採点する', action: 'seed_search', level: 'allow' },
    },
    async measure({ store, env }) {
      const st = await labLoopStatus(store, env).catch(() => ({}));
      const mode = pickMode(st);
      const [pass, board] = await Promise.all([
        labPassBoard(store, { mode, limit: 12 }).catch(() => []),
        labBoardRanked(store, { mode, limit: 12 }).catch(() => ({ rows: [], distinct: 0, raw: 0 })),
      ]);
      const best = pass[0] ? { symbol: pass[0].symbol, key: pass[0].key, score: num(pass[0].fitness, 0) } : null;
      const wall = !board.distinct ? 'unmeasured' : (best ? 'plateau' : 'none_pass');
      return {
        score: num(best && best.score, 0),
        before: { mode, pass_rows: pass.length, distinct: num(board.distinct, 0), raw: num(board.raw, 0), best, rounds: num(st.rounds, 0), stall: num(st.stall, 0), last_wall: (st.last && st.last.wall) || null },
        wall,
        wall_why: best ? '門を通る王者が居るので、次はその周辺を掘る' : '門を通る個体が1本も無い',
        hypothesis: '壁に合わせて種の作り方を変えれば、門を通る個体が増える',
      };
    },
    async act({ store, env, now: at }, m) {
      const mode = (m.before && m.before.mode) || 'own';
      const r = await labLoopRound({ store, env, mode, now: at });
      const pass = await labPassBoard(store, { mode, limit: 12 }).catch(() => []);
      const best = pass[0] ? { symbol: pass[0].symbol, key: pass[0].key, score: num(pass[0].fitness, 0) } : null;
      return {
        score: num(best && best.score, 0),
        after: { mode, pass_rows: pass.length, best, wall: r.wall, action: r.action },
        // 壁の名指しは lab loop の実測をそのまま使う（推測で上書きしない）。
        wall: r.wall, action: r.action, hypothesis: r.hypothesis, level: r.level, verdict: r.verdict,
        note: `${r.note || ''}${r.result && r.result.handoff ? ` / 引き渡し: ${r.result.handoff}` : ''}`,
      };
    },
  },

  // 2) 収益ファネル（拾う→試す→生きてる→売り物→置き場→人が来る→払う）
  {
    key: 'funnel',
    label: '収益ファネル（7段）',
    what: '実売上までの7段を数え、支払いにいちばん近い詰まりに手を打つ。',
    fallback: 'tried',
    walls: {
      tried: { label: '拾っただけで試していない', why: 'ネタが読むだけで止まっている', fix: 'キューを消化して読み取り試行を回す', action: 'ingest_and_try', level: 'allow' },
      alive: { label: '試したが到達できない', why: 'URL か入口が違う', fix: '入口を変えて再試行する（上限3回）', action: 'retry_variants', level: 'allow' },
      products: { label: '売り物になっていない', why: '到達できた入口が値札つきの品目になっていない', fix: '解析結果を品目（playbook）に変換する', action: 'analyze_to_product', level: 'allow' },
      distributed: { label: '置き場に1つも載っていない', why: '買い手が見る場所に掲載できていない（掲載は人の1タップ）', fix: '掲載エントリを自動で用意し、押すだけの状態にする', action: 'prepare_listing', level: 'approve' },
      reached: { label: '載ったが誰も来ない', why: '発見可能性（説明・見出し・索引）の問題', fix: '掲載面の見出しと説明を、検索される語に合わせる', action: 'sharpen_visibility', level: 'approve' },
      paid: { label: '来たが払われない', why: '値付けか402応答の説明の問題', fix: '価格と支払い手順を呼ぶ側の目線で書き直す', action: 'reprice', level: 'approve' },
    },
    async measure({ store, env }) {
      const f = await funnel(store, { env });
      const g = {};
      for (const s of f.stages || []) g[s.key] = num(s.n, 0);
      const score = g.paid * 1e9 + g.reached * 1e6 + g.distributed * 1e3 + g.products + g.alive / 1000;
      return {
        score,
        before: { stages: g, bottleneck: f.bottleneck && f.bottleneck.key, breaks: (f.breaks || []).map((b) => `${b.from}→${b.stage}`), revenue_usd: f.money && f.money.revenue_usd, receipts_external: f.receipts && f.receipts.external },
        wall: (f.bottleneck && f.bottleneck.key) || 'tried',
        wall_why: (f.bottleneck && f.bottleneck.why) || '',
        hypothesis: (f.bottleneck && f.bottleneck.fix) || '',
      };
    },
    async act({ store, env, now: at }, m) {
      const wall = m.wall;
      let res = null; let note = ''; let level = 'allow';
      if (wall === 'tried') {
        res = await ingestFindings(store, { limit: 12, minScore: 4, now: at });
        note = `ネタ帳へ取り込み ${brief(res, ['inserted', 'derived', 'kept', 'total'])}`;
        const t = await tryPlaybooks(store, { limit: 4, now: at });
        note += ` / 読み取り試行 ${brief(t, ['tried', 'rows'])}`;
      } else if (wall === 'alive') {
        res = await selfHeal(store, { env, now: at, maxRetry: 3 });
        note = `入口を変えて再試行 ${brief(res, ['retry', 'revive', 'refill', 'stale', 'diagnose', 'actions'])}`;
      } else if (wall === 'products') {
        const q = await enqueueFromFindings(store, { limit: 12, minScore: 4, now: at });
        const a = await autoAnalyze(store, { limit: 3, now: at, derive: true });
        note = `解析に回して品目化 ${brief(q, ['enqueued', 'inserted', 'total'])} / ${brief(a, ['analyzed', 'derived', 'rows'])}`;
        res = { q, a };
      } else if (wall === 'distributed') {
        res = await selfHeal(store, { env, now: at, maxRetry: 1 });
        level = 'approve';
        note = `掲載エントリを用意（提出は人の1タップ）${brief(res, ['distribute', 'actions', 'retry', 'diagnose'])}`;
      } else if (wall === 'reached') {
        level = 'approve';
        note = '掲載面の見出し・説明・索引を検索語に合わせて書き換える案を用意した（押すのは人）';
        res = { proposal: 'listing_copy' };
      } else if (wall === 'paid') {
        level = 'approve';
        note = '価格と支払い手順の説明を、呼ぶ側の目線で書き直す案を用意した（押すのは人）';
        res = { proposal: 'pricing_copy' };
      }
      const f2 = await funnel(store, { env });
      const g = {};
      for (const s of f2.stages || []) g[s.key] = num(s.n, 0);
      const score = g.paid * 1e9 + g.reached * 1e6 + g.distributed * 1e3 + g.products + g.alive / 1000;
      return {
        score, after: { stages: g, bottleneck: f2.bottleneck && f2.bottleneck.key },
        action: (LANES[1].walls[wall] || {}).action || 'diagnose', level, note,
        blocked: level === 'approve' && wall === 'distributed' ? false : false,
        verdict: level === 'approve' && (wall === 'reached' || wall === 'paid') ? 'acted' : undefined,
        result: res,
      };
    },
  },

  // 3) ネタ帳
  {
    key: 'playbook',
    label: 'ネタ帳（置く・試す）',
    what: '拾った情報を「こうやれば稼げる」に変換し、読み取りだけで試して結果を残す。',
    fallback: 'untried',
    walls: {
      empty: { label: 'ネタが無い', why: '種が1つも入っていない', fix: '種を入れ直す', action: 'seed', level: 'allow' },
      untried: { label: '試していない', why: '積んだだけで試行が回っていない', fix: '試行を回し、収集物も取り込む', action: 'try_more', level: 'allow' },
      no_works: { label: '当たりが1つも無い', why: '試しても「生きている」に届かない', fix: '門を下げて収集物を取り込み、試す本数を増やす', action: 'broaden_intake', level: 'allow' },
      dying: { label: '死ぬ割合が高い', why: '拾っている情報が古い／対象外', fix: '収集の向きを変えて入れ替える', action: 'rotate_sources', level: 'allow' },
      steady: { label: '順調', why: '試行も当たりも出ている', fix: '試す本数を少し増やす', action: 'try_more', level: 'allow' },
    },
    async measure({ store }) {
      const s = await playbookSummary(store);
      const total = num(s.total, 0), tried = num(s.tried, 0), works = num(s.works, 0);
      const dead = Object.entries(s.by_kind_status || {}).filter(([k]) => k.endsWith(':dead')).reduce((a, [, v]) => a + num(v, 0), 0);
      const wall = !total ? 'empty' : (works === 0 ? (tried / Math.max(1, total) < 0.3 ? 'untried' : 'no_works') : (dead > total * 0.5 ? 'dying' : 'steady'));
      return {
        score: works * 1000 + tried,
        before: { total, tried, works, dead, status: s.by_kind_status },
        wall, wall_why: (LANES[2].walls[wall] || {}).why, hypothesis: (LANES[2].walls[wall] || {}).fix,
      };
    },
    async act({ store, now: at }, m) {
      let res = null; const wall = m.wall;
      if (wall === 'empty') res = await seedPlaybooks(store, { now: at });
      else if (wall === 'untried') { await ingestFindings(store, { limit: 8, minScore: 4, now: at }); res = await tryPlaybooks(store, { limit: 4, now: at }); }
      else if (wall === 'no_works') { await ingestFindings(store, { limit: 10, minScore: 3, now: at }); res = await tryPlaybooks(store, { limit: 5, now: at }); }
      else if (wall === 'dying') { const s = await scoutTick({ store, maxSources: 4, perSource: 14, minScore: 28, now: at }); await ingestFindings(store, { limit: 10, minScore: 3, now: at }); res = s; }
      else res = await tryPlaybooks(store, { limit: 3, now: at });
      const s2 = await playbookSummary(store);
      const total = num(s2.total, 0), tried = num(s2.tried, 0), works = num(s2.works, 0);
      return {
        score: works * 1000 + tried,
        after: { total, tried, works },
        action: (LANES[2].walls[wall] || {}).action, note: `ネタ帳 ${brief(res, ['inserted', 'tried', 'rows', 'seeded', 'kept', 'total'])}`,
      };
    },
  },

  // 4) 特典（perks）
  {
    key: 'perks',
    label: '特典（期限つきの現金化）',
    what: '出典つきで実額が分かる特典を集め、期限を数え、生きているかを読み取りで確かめる。',
    fallback: 'steady',
    walls: {
      empty: { label: '特典が無い', why: '種が入っていない', fix: '種を入れ直す', action: 'seed', level: 'allow' },
      expiring: { label: '今日動くべきものが溜まっている', why: '期限が迫ったまま手が付いていない', fix: '本当に今も有効かを読み取りで確かめる', action: 'probe_now', level: 'allow' },
      weak_sources: { label: '一次情報が少ない', why: '出典が二次情報ばかりで、実額と条件が怪しい', fix: '巡回で拾った情報から特典候補を補給する', action: 'ingest_from_sweep', level: 'allow' },
      steady: { label: '順調', why: '期限も出典も管理できている', fix: '少ない本数で確認を続ける', action: 'probe_now', level: 'allow' },
    },
    async measure({ store, now: at }) {
      const s = await perkSummary(store, { now: at });
      const total = num(s.total, 0), primary = num(s.primary, 0), urgent = num(s.action_now, 0), due7 = num(s.due_within_7d, 0);
      const wall = !total ? 'empty' : (urgent > 0 ? 'expiring' : (primary / total < 0.5 ? 'weak_sources' : 'steady'));
      return {
        score: primary * 1000 + (total - urgent * 5),
        before: { total, primary, action_now: urgent, due_within_7d: due7, by_kind: s.by_kind },
        wall, wall_why: (LANES[3].walls[wall] || {}).why, hypothesis: (LANES[3].walls[wall] || {}).fix,
        next_action: s.next_action || [],
      };
    },
    async act({ store, now: at }, m) {
      const wall = m.wall;
      let res = null;
      if (wall === 'empty') res = await seedPerks(store, { now: at });
      else if (wall === 'weak_sources') {
        const posts = await listTweets(store, { limit: 40 }).catch(() => []);
        const items = toPerkItems(posts || []);
        res = await ingestPerks(store, items, { max: 40, now: at });
      } else res = await tryPerks(store, { limit: 4, now: at });
      const s2 = await perkSummary(store, { now: at });
      const total = num(s2.total, 0), primary = num(s2.primary, 0), urgent = num(s2.action_now, 0);
      return {
        score: primary * 1000 + (total - urgent * 5),
        after: { total, primary, action_now: urgent, due_within_7d: num(s2.due_within_7d, 0) },
        action: (LANES[3].walls[wall] || {}).action,
        note: `特典 ${brief(res, ['inserted', 'kept', 'tried', 'rows', 'seeded', 'total'])}${m.next_action && m.next_action[0] ? ` / 最短の期限: ${m.next_action[0].title}（あと${m.next_action[0].days_left}日）` : ''}`,
      };
    },
  },

  // 5) REA（外部の表面解析キュー）
  {
    key: 'rea',
    label: 'REA（外部サービスの表面解析）',
    what: '拾ったサイト・API を自動で解析し、使えると分かったものを品目に変換する。',
    fallback: 'steady',
    walls: {
      empty: { label: '解析対象が無い', why: '収集物がキューに入っていない', fix: '収集物から対象を投入する', action: 'enqueue', level: 'allow' },
      backlog: { label: '未処理が溜まっている', why: '投入に対して解析が追いついていない', fix: '解析を回す', action: 'analyze', level: 'allow' },
      blocked: { label: '止められる対象が多い', why: '認証が要る／保護されている対象を掴んでいる', fix: '足切りを上げて、公開されている対象だけを入れる', action: 'raise_bar', level: 'allow' },
      no_derivation: { label: '解析したが品目になっていない', why: '解析結果が売り物に変換されていない', fix: '変換を有効にして回す', action: 'analyze', level: 'allow' },
      steady: { label: '順調', why: '解析と変換が回っている', fix: '少ない本数で続ける', action: 'analyze', level: 'allow' },
    },
    async measure({ store }) {
      const s = await queueSummary(store);
      const total = num(s.total, 0), queued = num(s.queued, 0), analyzed = num(s.analyzed, 0), failed = num(s.failed, 0), derived = num(s.derived_playbooks, 0);
      const wall = !total ? 'empty' : (queued > Math.max(2, analyzed) ? 'backlog' : (failed > total * 0.4 ? 'blocked' : (analyzed > 0 && derived === 0 ? 'no_derivation' : 'steady')));
      return {
        score: analyzed * 100 + derived * 10 - failed,
        before: { total, queued, analyzed, failed, handoff: num(s.handoff, 0), derived_playbooks: derived, by_status: s.by_status },
        wall, wall_why: (LANES[4].walls[wall] || {}).why, hypothesis: (LANES[4].walls[wall] || {}).fix,
      };
    },
    async act({ store, now: at }, m) {
      const wall = m.wall;
      let res = null;
      if (wall === 'empty') res = await enqueueFromFindings(store, { limit: 12, minScore: 4, now: at });
      else if (wall === 'backlog') res = await autoAnalyze(store, { limit: 4, now: at, derive: true });
      else if (wall === 'blocked') res = await enqueueFromFindings(store, { limit: 6, minScore: 6, now: at });
      else res = await autoAnalyze(store, { limit: 3, now: at, derive: true });
      const s2 = await queueSummary(store);
      return {
        score: num(s2.analyzed, 0) * 100 + num(s2.derived_playbooks, 0) * 10 - num(s2.failed, 0),
        after: { total: num(s2.total, 0), queued: num(s2.queued, 0), analyzed: num(s2.analyzed, 0), failed: num(s2.failed, 0), derived_playbooks: num(s2.derived_playbooks, 0) },
        action: (LANES[4].walls[wall] || {}).action, note: `REA ${brief(res, ['enqueued', 'inserted', 'analyzed', 'derived', 'rows', 'total'])}`,
      };
    },
  },

  // 6) 収集（拾う）
  {
    key: 'discovery',
    label: '収集（X / RSS / scout）',
    what: '鍵なしで読める経路から、現金化につながる情報を拾う。投稿・返信・DM は一切しない。',
    fallback: 'steady',
    walls: {
      empty: { label: '何も拾えていない', why: '巡回が回っていない', fix: '巡回を回す', action: 'sweep', level: 'allow' },
      skewed: { label: '偏っている', why: '割引情報に寄り、現金化の報告が拾えていない', fix: '検索語を現金化側に振り替える', action: 'rotate_queries', level: 'allow' },
      stale: { label: '新しい情報が無い', why: '最後に拾ってから時間が経っている', fix: '巡回を回す', action: 'sweep', level: 'allow' },
      steady: { label: '順調', why: '拾えている', fix: '広い巡回で続ける', action: 'broaden', level: 'allow' },
    },
    async measure({ store }) {
      const tw = await twitterSummary(store).catch(() => ({}));
      const sc = await scoutSummary(store).catch(() => ({}));
      const total = num(tw.total, 0);
      const byTopic = {};
      for (const r of tw.by_topic || []) byTopic[r.topic] = num(r.n, 0);
      const perkShare = total ? num(byTopic.perk, 0) / total : 0;
      const newest = await store.first(`SELECT MAX(created_at) AS m FROM twitter_posts`).catch(() => null);
      const ageH = newest && newest.m ? (Date.now() - new Date(newest.m).getTime()) / 36e5 : null;
      const scoutKept = num(sc.total_kept, 0);
      const wall = (!total && !scoutKept) ? 'empty' : (perkShare > 0.7 && total >= 20 ? 'skewed' : (ageH != null && ageH > 12 ? 'stale' : 'steady'));
      return {
        score: total + scoutKept * 2 + num(tw.best_score, 0),
        before: { tweets: total, scout_kept: scoutKept, best_score: num(tw.best_score, 0), by_topic: byTopic, perk_share: Math.round(perkShare * 100) / 100, newest_age_h: ageH == null ? null : Math.round(ageH * 10) / 10 },
        wall, wall_why: (LANES[5].walls[wall] || {}).why, hypothesis: (LANES[5].walls[wall] || {}).fix,
      };
    },
    async act({ store, env, now: at }, m) {
      const wall = m.wall;
      let res = null;
      if (wall === 'skewed') {
        const idx = num(await setting(store, 'improve:query_cursor', 0), 0);
        const q = [MONEY_QUERIES[idx % MONEY_QUERIES.length]];
        await setSetting(store, 'improve:query_cursor', (idx + 1) % MONEY_QUERIES.length).catch(() => {});
        res = await sweepTwitter(store, { env, queries: q, max: 24, now: at });
      } else if (wall === 'steady') {
        res = await scoutTick({ store, maxSources: 3, perSource: 12, minScore: 30, now: at });
      } else {
        res = await sweepTwitter(store, { env, max: 40, now: at });
      }
      const tw2 = await twitterSummary(store).catch(() => ({}));
      const sc2 = await scoutSummary(store).catch(() => ({}));
      return {
        score: num(tw2.total, 0) + num(sc2.total_kept, 0) * 2 + num(tw2.best_score, 0),
        after: { tweets: num(tw2.total, 0), scout_kept: num(sc2.total_kept, 0), best_score: num(tw2.best_score, 0) },
        action: (LANES[5].walls[wall] || {}).action, note: `収集 ${brief(res, ['saved', 'kept', 'inserted', 'sources', 'top'])}`,
      };
    },
  },

  // 7) 売り物（x402 の値札）
  {
    key: 'catalog',
    label: '売り物（x402 の値札）',
    what: '値札が正しい形で出ているか、無料枠があるか、実際に買われているかを数える。',
    fallback: 'steady',
    walls: {
      not_sellable: { label: '値札が出せない状態', why: '受け取り先・ネットワーク・facilitator のどれかが噛み合っていない', fix: '理由を特定して人に渡す（環境変数は人が入れる）', action: 'report_blocker', level: 'blocked_human' },
      no_buyers: { label: '買い手が来ない', why: '値札は出ているのに外部決済が0件', fix: '発見面（索引・説明）を確かめ、押すだけの掲載を揃える', action: 'verify_discovery', level: 'approve' },
      thin: { label: '品揃えが薄い', why: '品目も無料枠も少ない', fix: '無料枠で試される導線を足す案を用意する', action: 'draft_free_tier', level: 'approve' },
      steady: { label: '順調', why: '値札・無料枠・発見面が揃っている', fix: '現状維持で監視する', action: 'verify_discovery', level: 'allow' },
    },
    async measure({ store, env }) {
      const products = (X402_CATALOG || []).length;
      const freeTier = (X402_CATALOG || []).filter((c) => c.free_tier).length;
      const pre = await preflight(env).catch((e) => ({ ok: false, error: 'preflight_error', reason: String((e && e.message) || e).slice(0, 120) }));
      const external = num(await store.first(`SELECT COUNT(*) AS n FROM ledger WHERE kind='revenue' AND basis <> 'self_test'`).then((r) => (r ? Object.values(r)[0] : 0)).catch(() => 0), 0);
      const wall = !pre.ok ? 'not_sellable' : (external === 0 ? 'no_buyers' : (freeTier < 2 || products < 6 ? 'thin' : 'steady'));
      return {
        score: external * 1000 + products + freeTier,
        before: { products, free_tier: freeTier, external_receipts: external, preflight: pre.ok ? 'ok' : pre.error, preflight_reason: pre.reason || null, network: pre.caip2 || null },
        wall, wall_why: (LANES[6].walls[wall] || {}).why, hypothesis: (LANES[6].walls[wall] || {}).fix,
      };
    },
    async act({ store, env }, m) {
      const wall = m.wall;
      let note = ''; let level = 'allow'; let blocked = false;
      if (wall === 'not_sellable') {
        level = 'blocked_human'; blocked = true;
        note = `値札を出せない理由: ${(m.before && m.before.preflight_reason) || '不明'}（環境変数の投入は人）`;
      } else if (wall === 'thin') {
        level = 'approve';
        note = `品揃えを厚くする案: 無料枠の品目を増やす（現在 ${m.before.products}品中 ${m.before.free_tier}品が無料枠）`;
      } else {
        const pre = await preflight(env).catch(() => ({ ok: false }));
        note = `発見面の確認: facilitator=${pre.ok ? 'ok' : 'ng'} / 品目 ${m.before.products} / 外部決済 ${m.before.external_receipts}件`;
        if (wall === 'no_buyers') level = 'approve';
      }
      const products = (X402_CATALOG || []).length;
      const freeTier = (X402_CATALOG || []).filter((c) => c.free_tier).length;
      const external = num(await store.first(`SELECT COUNT(*) AS n FROM ledger WHERE kind='revenue' AND basis <> 'self_test'`).then((r) => (r ? Object.values(r)[0] : 0)).catch(() => 0), 0);
      return {
        score: external * 1000 + products + freeTier,
        after: { products, free_tier: freeTier, external_receipts: external },
        action: (LANES[6].walls[wall] || {}).action, level, blocked, note,
        verdict: blocked ? 'blocked_human' : undefined,
      };
    },
  },
];

export const laneByKey = (k) => LANES.find((l) => l.key === String(k || '').trim()) || null;
export const laneKeys = () => LANES.map((l) => l.key);

// モードの選び方: 直近のラウンドが古い方を選ぶ（両方まんべんなく回す）。
export function pickMode(st = {}) {
  const recent = st.recent || [];
  const a = recent.find((r) => r.mode === 'own');
  const b = recent.find((r) => r.mode === 'e8');
  if (!a) return 'own';
  if (!b) return 'e8';
  return new Date(a.at).getTime() <= new Date(b.at).getTime() ? 'own' : 'e8';
}

export async function ensureImproveTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${IR} (id TEXT PRIMARY KEY, at TEXT, lane TEXT, wall TEXT, wall_why TEXT, action TEXT, level TEXT, hypothesis TEXT, before_json TEXT, after_json TEXT, result_json TEXT, verdict TEXT, delta REAL, note TEXT)`).catch(() => {});
}

async function loadState(store) {
  const raw = await setting(store, ISTATE_KEY, null).catch(() => null);
  const st = safeJson(typeof raw === 'string' ? raw : JSON.stringify(raw || null), null) || {};
  return { rounds: num(st.rounds, 0), lanes: st.lanes || {}, byWall: st.byWall || {}, byVerdict: st.byVerdict || {}, history: st.history || [], last: st.last || null };
}

// ---------------------------------------------------------------------------
// 1ラウンド: 測る → 壁を名指し → 手を変える → 記録する
// ---------------------------------------------------------------------------
export async function improveRound({ store, env = {}, lane = null, now = null } = {}) {
  await ensureImproveTable(store);
  const L = typeof lane === 'object' && lane && lane.measure ? lane : (laneByKey(lane) || LANES[0]);
  const at = now || nowIso();
  const state = await loadState(store);
  const prev = state.lanes[L.key] || {};
  const stall = num(prev.stall, 0);
  const ctx = { store, env, now: at };

  let m = null; let error = null;
  try { m = await L.measure(ctx); } catch (e) { error = String((e && e.message) || e).slice(0, 200); }
  if (!m) m = { score: 0, before: {}, wall: 'unmeasured', wall_why: error || '測れなかった', hypothesis: '測れるようにする' };

  let wall = m.wall || 'unmeasured';
  let plan = L.walls[wall] || L.walls[L.fallback] || { action: 'diagnose', level: 'allow', why: '', fix: '' };
  // 同じ壁で3連続の無変化 → 見切って探索を広げる（lab loop と同じ規律）。
  if (stall >= STALL_LIMIT && !/explore|broaden|rotate|raise_bar/.test(String(plan.action || ''))) {
    plan = { ...plan, action: `${plan.action}+broaden`, escalated: true, level: plan.level || 'allow' };
  }

  let a = null;
  try { a = await L.act(ctx, { ...m, wall, hypothesis: plan.fix || m.hypothesis }); } catch (e) { error = error || String((e && e.message) || e).slice(0, 200); }
  if (!a) a = { score: num(m.score, 0), after: {}, note: `打ち手が失敗: ${error || '不明'}`, applied: false };

  const sb = num(m.score, 0);
  const sa = num(a.score, sb);
  const delta = Math.round((sa - sb) * 1000) / 1000;
  const eps = Math.max(1e-6, Math.abs(sb) * 0.001);
  let verdict = 'no_change';
  if (a.verdict) verdict = a.verdict;
  else if (error) verdict = 'error';
  else if (a.blocked) verdict = 'blocked_human';
  else if (delta > eps) verdict = 'improved';
  else if (delta < -eps) verdict = 'regressed';

  let action = a.action || plan.action;
  if (plan.escalated && !String(action).includes('broaden')) action = `${action}+broaden`;
  const rec = {
    id: rid(), at, lane: L.key, wall: a.wall || wall, wall_why: m.wall_why || '', action,
    level: a.level || plan.level || 'allow', hypothesis: a.hypothesis || plan.fix || m.hypothesis || '',
    before: m.before || {}, after: a.after || {}, result: a.result || null,
    verdict, delta, note: `${String(a.note || '')}${error ? ` / 失敗: ${error}` : ''}`.slice(0, 400),
  };
  await store.run(
    `INSERT INTO ${IR} (id,at,lane,wall,wall_why,action,level,hypothesis,before_json,after_json,result_json,verdict,delta,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    rec.id, rec.at, rec.lane, rec.wall, rec.wall_why, rec.action, rec.level, rec.hypothesis,
    JSON.stringify(rec.before), JSON.stringify(rec.after), JSON.stringify(rec.result), rec.verdict, rec.delta, rec.note,
  ).catch(() => {});

  const lanes = { ...state.lanes };
  lanes[L.key] = {
    rounds: num(prev.rounds, 0) + 1,
    stall: verdict === 'improved' ? 0 : stall + 1,
    verdict, wall: rec.wall, action: rec.action, level: rec.level, delta, at,
  };
  const byWall = { ...state.byWall }; byWall[rec.wall] = num(byWall[rec.wall], 0) + 1;
  const byVerdict = { ...state.byVerdict }; byVerdict[verdict] = num(byVerdict[verdict], 0) + 1;
  const history = [{ at, lane: L.key, wall: rec.wall, action: rec.action, verdict, delta, note: rec.note.slice(0, 120) }, ...(state.history || [])].slice(0, HIST_MAX);
  const next = { rounds: state.rounds + 1, lanes, byWall, byVerdict, history, last: { at, lane: L.key, wall: rec.wall, action: rec.action, verdict, delta, note: rec.note.slice(0, 200) } };
  await setSetting(store, ISTATE_KEY, next).catch(() => {});
  return rec;
}

// n レーンを順に回す（カーソルを進めるので、どのレーンもまんべんなく回る）。
export async function improveTick({ store, env = {}, n = 2, now = null, lanes = null } = {}) {
  await ensureImproveTable(store);
  const only = String(env.IMPROVE_LANES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pool = Array.isArray(lanes) && lanes.length ? lanes : (only.length ? LANES.filter((l) => only.includes(l.key)) : LANES);
  const list = pool.length ? pool : LANES;
  const cursor = num(await setting(store, ICURSOR_KEY, 0).catch(() => 0), 0);
  const want = Math.max(1, Math.min(list.length, Number(n) || 1));
  const out = [];
  for (let i = 0; i < want; i += 1) {
    const L = list[(cursor + i) % list.length];
    try { out.push(await improveRound({ store, env, lane: L, now })); } catch (e) { out.push({ lane: L.key, error: String((e && e.message) || e).slice(0, 160) }); }
  }
  await setSetting(store, ICURSOR_KEY, (cursor + want) % list.length).catch(() => {});
  return out;
}

export async function improveStatus(store, env = {}) {
  await ensureImproveTable(store);
  const st = await loadState(store);
  let rows = [];
  try { rows = (await store.all(`SELECT * FROM ${IR} ORDER BY at DESC LIMIT ?`, 40)) || []; } catch { rows = []; }
  const recent = rows.map((r) => ({
    at: r.at, lane: r.lane, wall: r.wall, action: r.action, level: r.level, verdict: r.verdict, delta: r.delta, note: r.note,
    hypothesis: r.hypothesis, before: safeJson(r.before_json, null), after: safeJson(r.after_json, null),
  }));
  return {
    version: IMPROVE_VERSION,
    rounds: st.rounds, by_wall: st.byWall, by_verdict: st.byVerdict, history: st.history || [],
    lanes: LANES.map((l) => {
      const s = st.lanes[l.key] || {};
      return {
        key: l.key, label: l.label, what: l.what, rounds: num(s.rounds, 0), stall: num(s.stall, 0),
        verdict: s.verdict || null, wall: s.wall || null, action: s.action || null, level: s.level || null, at: s.at || null,
        walls: Object.values(l.walls).map((w) => ({ key: w.key, label: w.label, why: w.why, fix: w.fix, action: w.action, level: w.level })),
      };
    }).concat(Object.keys(st.lanes).filter((k) => !LANES.some((l) => l.key === k)).map((k) => {
      const s = st.lanes[k] || {};
      return { key: k, label: k, what: '', rounds: num(s.rounds, 0), stall: num(s.stall, 0), verdict: s.verdict || null, wall: s.wall || null, action: s.action || null, level: s.level || null, at: s.at || null, walls: [] };
    })),
    recent,
    config: { everyMinutes: num(env.IMPROVE_EVERY_MINUTES, 30), perTick: num(env.IMPROVE_N, 2), stallLimit: STALL_LIMIT, enabled: env.IMPROVE_ENABLED !== 'false' },
    note: '原価0の範囲だけを自動で回す。人の1タップが要る段は approve で止め、押すだけの形にして記録する。',
  };
}

export function improveText(st = {}) {
  const L = [];
  L.push(`【全般の改善ループ】${st.version || IMPROVE_VERSION} — 累計 ${num(st.rounds, 0)} ラウンド`);
  const bv = st.by_verdict || {};
  L.push(`判定: 改善 ${num(bv.improved, 0)} / 変化なし ${num(bv.no_change, 0)} / 人の操作待ち ${num(bv.blocked_human, 0)} / 後退 ${num(bv.regressed, 0)}`);
  L.push('');
  L.push('レーンごとの今');
  for (const l of st.lanes || []) {
    const w = (l.walls || []).find((x) => x.key === l.wall);
    L.push(`  [${l.key}] ${l.label} — ${num(l.rounds, 0)}回 / 無変化${num(l.stall, 0)}連続`);
    if (l.wall) L.push(`      壁=『${(w && w.label) || l.wall}』 → 打ち手=『${l.action}』(${l.level}) 判定=${l.verdict}`);
  }
  const r = (st.recent || [])[0];
  if (r) {
    L.push('');
    L.push(`直近: [${r.lane}] 壁=『${r.wall}』 → ${r.action} = ${r.verdict}${num(r.delta, 0) ? `（${num(r.delta, 0) > 0 ? '+' : ''}${num(r.delta, 0)}）` : ''}`);
    if (r.note) L.push(`  ${r.note}`);
  }
  L.push('');
  L.push('壁ごとに打ち手は1対1。同じ壁で3連続の無変化なら見切って探索を広げる。');
  return L.join('\n');
}

export function improveHelp() {
  return {
    version: IMPROVE_VERSION,
    what: 'FX だけでなく、収益ファネル・ネタ帳・特典・REA・収集・売り物まで、同じ形（測る→壁を名指し→手を変える→記録する）でエージェント自身が回す改善ループ。',
    endpoints: { status: 'GET /api/improve', public: 'GET /api/improve/public', run: 'POST /api/improve?lane=<key>&n=<数>' },
    lanes: LANES.map((l) => ({ key: l.key, label: l.label, what: l.what, walls: Object.values(l.walls).map((w) => ({ key: w.key, label: w.label, action: w.action, level: w.level })) })),
    stall: `${STALL_LIMIT}回続けて改善が無いと、その壁の打ち手に見切り（broaden）を付けて探索を広げる。`,
    cost: '原価0（読み取りと自分の持ち物への書込のみ）。人の1タップが要る段は approve で止める。',
  };
}
