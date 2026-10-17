// Logic space（論理空間）— 「この世に存在しうるロジック」を、数え上げられる形にしたもの。
//
// 考え方（誇張しないための線引き）:
//   * 「この世の全てのロジック」を列挙することは原理的にできない（語彙が無限に増えるため）。
//     代わりに、**語彙（指標・しきい値・演算子・絞り込み・出口・方向・時間軸・銘柄）を固定**し、
//     その文法の中で作れるロジックを漏れなく数え上げる。数え上げられる＝住所（番号）を持つ、
//     ということなので、エージェントは「どこまで見たか」を数字で言える。
//   * 空間は2層に分ける:
//       コア層 : 既知の17ロジック × パラメータpreset × 絞り込み × 出口 × 方向 × 時間軸 × 銘柄
//                → 全列挙する（番号で順に踏破する）
//       合成層 : 部品（指標×演算子×しきい値 = atom）2つを AND/OR で組む論理
//                → 数え上げはできるが広大なので、無作為＋王者近傍の変異で探索する
//   * ここで作った論理は、既存の検証エンジン（robust.js の11項目）にそのまま乗る。
//     昇格（＝EAの対象）はフル検証を通ったときだけ、という規則も変わらない。
//
// すべて決定論的: 同じ番号 i は常に同じ論理を返す（D1に積んだ記録と後から突き合わせられる）。

import {
  STRATEGIES, ema, sma, rsi, atr, stdevRolling, highest, lowest,
  macd, wilderADX, stoch, cci, roc, supertrend, midpoint, weekdayOf, dayOfMonth, PAIRS,
} from './backtest.js';

export const SYMBOLS = Object.keys(PAIRS);

// ---------------------------------------------------------------------------
// 特徴量（指標を「無次元の系列」に揃える）— すべて因果的（添字 i は i 以前のみ）
// ---------------------------------------------------------------------------
const FEATURE_CACHE = new WeakMap();

export function features(bars) {
  const hit = FEATURE_CACHE.get(bars);
  if (hit) return hit;
  const n = bars.length;
  const close = new Array(n); const high = new Array(n); const low = new Array(n);
  const dow = new Array(n); const dom = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    close[i] = b.close; high[i] = b.high; low[i] = b.low;
    dow[i] = weekdayOf(b.date); dom[i] = dayOfMonth(b.date);
  }
  const a14 = atr(bars, 14);
  const e12 = ema(close, 12); const e20 = ema(close, 20); const e48 = ema(close, 48);
  const s20 = sma(close, 20); const sd20 = stdevRolling(close, 20); const s200 = sma(close, 200);
  const m = macd(close, 12, 26, 9);
  const ad = wilderADX(bars, 14);
  const sk = stoch(bars, 14, 3, 3);
  const cc = cci(bars, 20);
  const rc = roc(close, 10);
  const stx = supertrend(bars, 10, 3);
  const ki = midpoint(bars, 26);
  const h20 = highest(high, 20); const l20 = lowest(low, 20);
  const bw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) bw[i] = (s20[i] == null || sd20[i] == null || s20[i] === 0) ? null : (2 * sd20[i]) / s20[i];
  const bwAvg = sma(bw.map((v) => (v == null ? 0 : v)), 120);
  const div = (x, y) => (x == null || y == null ? null : x / y);

  const series = {
    trend_spread: close.map((c, i) => (e12[i] == null || e48[i] == null ? null : (100 * (e12[i] - e48[i])) / c)),
    rsi14: rsi(close, 14),
    z20: close.map((c, i) => (s20[i] == null || sd20[i] == null || sd20[i] === 0 ? null : (c - s20[i]) / sd20[i])),
    bb_pos: close.map((c, i) => (s20[i] == null || sd20[i] == null || sd20[i] === 0 ? null : (c - s20[i]) / (2 * sd20[i]))),
    macd_hist: m.hist.map((v, i) => div(v, a14[i])),
    adx14: ad.adx,
    di_diff: ad.plusDI.map((v, i) => (v == null || ad.minusDI[i] == null ? null : v - ad.minusDI[i])),
    stoch_k: sk.k,
    cci20: cc,
    roc10: rc,
    kc_pos: close.map((c, i) => (e20[i] == null || a14[i] == null ? null : (c - e20[i]) / (2 * a14[i]))),
    st_dir: stx.dir,
    ich_diff: close.map((c, i) => (ki[i] == null || a14[i] == null ? null : (c - ki[i]) / a14[i])),
    bw_ratio: bw.map((v, i) => (v == null || bwAvg[i] == null || bwAvg[i] === 0 ? null : v / bwAvg[i])),
    atr_pct: a14.map((v, i) => (v == null || !close[i] ? null : (100 * v) / close[i])),
    don_pos: close.map((c, i) => (h20[i] == null || l20[i] == null || h20[i] === l20[i] ? null : (c - l20[i]) / (h20[i] - l20[i]))),
    ret1: close.map((c, i) => (i === 0 || !close[i - 1] ? null : (100 * (c - close[i - 1])) / close[i - 1])),
  };

  const S = { bars, n, close, high, low, dow, dom, a14, s200, series };
  FEATURE_CACHE.set(bars, S);
  return S;
}

// 語彙（特徴量）。th = その特徴量で意味のあるしきい値の集合。
// pine は「同じ意味の Pine 式」。__XXX__ は前段の定義が必要な印。
export const FEATURES = {
  trend_spread: { label: 'EMA12-EMA48乖離(%)', th: [-0.3, 0, 0.3], pine: '100 * (ta.ema(close, 12) - ta.ema(close, 48)) / close' },
  rsi14: { label: 'RSI(14)', th: [30, 45, 55, 70], pine: 'ta.rsi(close, 14)' },
  z20: { label: '終値zスコア(20)', th: [-2, -1, 0, 1, 2], pine: '(close - ta.sma(close, 20)) / ta.stdev(close, 20)' },
  bb_pos: { label: 'ボリンジャー内位置(±2σ)', th: [-1, -0.5, 0.5, 1], pine: '(close - ta.sma(close, 20)) / (2 * ta.stdev(close, 20))' },
  macd_hist: { label: 'MACDヒストグラム(ATR比)', th: [-0.2, 0, 0.2], pine: '__MACD__' },
  adx14: { label: 'ADX(14)', th: [18, 25, 32], pine: '__ADX__' },
  di_diff: { label: '+DI − −DI', th: [-5, 0, 5], pine: '__DIDIFF__' },
  stoch_k: { label: 'ストキャス%K(14)', th: [20, 50, 80], pine: 'ta.stoch(close, high, low, 14)' },
  cci20: { label: 'CCI(20)', th: [-100, 0, 100], pine: 'ta.cci(close, 20)' },
  roc10: { label: '変化率(10日,%)', th: [-1, 0, 1], pine: 'ta.roc(close, 10)' },
  kc_pos: { label: 'ケルトナー内位置(ATR比)', th: [-1, 0, 1], pine: '(close - ta.ema(close, 20)) / (2 * ta.atr(14))' },
  st_dir: { label: 'スーパートレンド方向(±1)', th: [0], pine: '__STDIR__' },
  ich_diff: { label: '一目基準線乖離(ATR比)', th: [-1, 0, 1], pine: '(close - ((ta.highest(high, 26) + ta.lowest(low, 26)) / 2)) / ta.atr(14)' },
  bw_ratio: { label: 'バンド幅/平均バンド幅', th: [0.35, 0.6], pine: '__BWRATIO__' },
  atr_pct: { label: 'ATR/終値(%)', th: [0.6, 1.0, 1.6], pine: '100 * ta.atr(14) / close' },
  don_pos: { label: 'ドンチャン内位置(20)', th: [0.2, 0.8], pine: '(close - ta.lowest(low, 20)) / (ta.highest(high, 20) - ta.lowest(low, 20))' },
  ret1: { label: '前日比(%)', th: [-1, 0, 1], pine: '100 * (close - close[1]) / close[1]' },
};

export const OPS = [
  { key: 'gt', label: 'より大きい', sym: '>' },
  { key: 'lt', label: 'より小さい', sym: '<' },
  { key: 'xup', label: 'を上抜け', sym: '↑' },
  { key: 'xdn', label: 'を下抜け', sym: '↓' },
];

export const ATOMS = (() => {
  const out = [];
  for (const [key, f] of Object.entries(FEATURES)) for (const op of OPS) for (const th of f.th) out.push({ f: key, op: op.key, th });
  return out;
})();

export function atomText(a) {
  const f = FEATURES[a.f];
  const o = OPS.find((x) => x.key === a.op);
  if (!f) return String(a.f);
  return `${f.label} が ${a.th} ${o ? o.label : a.op}`;
}

/** 部品がその時点で成立するか（null = 判定不能＝ウォームアップ中） */
export function atomCond(S, a, i) {
  const arr = S.series[a.f];
  if (!arr) return null;
  const v = arr[i];
  if (v == null) return null;
  if (a.op === 'gt') return v > a.th;
  if (a.op === 'lt') return v < a.th;
  const prev = i > 0 ? arr[i - 1] : null;
  if (prev == null) return null;
  if (a.op === 'xup') return prev <= a.th && v > a.th;
  if (a.op === 'xdn') return prev >= a.th && v < a.th;
  return null;
}

export function atomCondNot(S, a, i) {
  const v = atomCond(S, a, i);
  return v == null ? null : !v;
}

// ---------------------------------------------------------------------------
// 絞り込み（入口をマスクする条件）。すべて「その時点の確定値」だけで判定する。
// ---------------------------------------------------------------------------
function monthTurn(S, i) {
  const ds = String(S.bars[i].date);
  const y = Number(ds.slice(0, 4)); const m = Number(ds.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = S.dom[i];
  return d > last - 2 || d <= 3;
}

export const FILTERS = [
  { key: 'none', label: '絞り込みなし', pine: 'true', mask: () => true },
  { key: 'trend_up', label: '上昇トレンドのみ（終値>SMA200）', pine: 'close > ta.sma(close, 200)', mask: (S, i) => S.s200[i] != null && S.close[i] > S.s200[i] },
  { key: 'trend_dn', label: '下降トレンドのみ（終値<SMA200）', pine: 'close < ta.sma(close, 200)', mask: (S, i) => S.s200[i] != null && S.close[i] < S.s200[i] },
  { key: 'adx20', label: 'ADX>20（トレンド相場のみ）', pine: '__ADX__ > 20', mask: (S, i) => S.series.adx14[i] != null && S.series.adx14[i] > 20 },
  { key: 'adx30', label: 'ADX>30（強いトレンドのみ）', pine: '__ADX__ > 30', mask: (S, i) => S.series.adx14[i] != null && S.series.adx14[i] > 30 },
  { key: 'vol_low', label: '低ボラのみ（ATR<1.0%）', pine: '100 * ta.atr(14) / close < 1.0', mask: (S, i) => S.series.atr_pct[i] != null && S.series.atr_pct[i] < 1.0 },
  { key: 'vol_high', label: '高ボラのみ（ATR>1.6%）', pine: '100 * ta.atr(14) / close > 1.6', mask: (S, i) => S.series.atr_pct[i] != null && S.series.atr_pct[i] > 1.6 },
  { key: 'dow_mon', label: '月曜エントリーのみ', pine: 'dayofweek == 2', mask: (S, i) => S.dow[i] === 1 },
  { key: 'dow_tue', label: '火曜エントリーのみ', pine: 'dayofweek == 3', mask: (S, i) => S.dow[i] === 2 },
  { key: 'dow_wed', label: '水曜エントリーのみ', pine: 'dayofweek == 4', mask: (S, i) => S.dow[i] === 3 },
  { key: 'dow_thu', label: '木曜エントリーのみ', pine: 'dayofweek == 5', mask: (S, i) => S.dow[i] === 4 },
  { key: 'month_turn', label: '月末月初のみ', pine: '__MONTHTURN__', mask: (S, i) => monthTurn(S, i) },
  { key: 'squeeze', label: 'スクイーズ中（バンド幅<0.35倍）', pine: '__BWRATIO__ <= 0.35', mask: (S, i) => S.series.bw_ratio[i] != null && S.series.bw_ratio[i] <= 0.35 },
];

export const EXITS = [
  { key: 'tight', label: '近い利確（損切1.5×利確2.0×ATR）', atrStopMult: 1.5, atrTargetMult: 2.0, maxHoldBars: 30, trailAtrMult: 0 },
  { key: 'balanced', label: '標準（損切2.0×利確3.0×ATR）', atrStopMult: 2.0, atrTargetMult: 3.0, maxHoldBars: 60, trailAtrMult: 0 },
  { key: 'wide', label: '広い利確（損切3.0×利確4.0×ATR）', atrStopMult: 3.0, atrTargetMult: 4.0, maxHoldBars: 120, trailAtrMult: 0 },
  { key: 'trail', label: 'ATRトレーリング（利確なし）', atrStopMult: 2.5, atrTargetMult: 0, maxHoldBars: 0, trailAtrMult: 2.5 },
  { key: 'flip', label: '逆シグナルまで保有（利確なし）', atrStopMult: 3.5, atrTargetMult: 0, maxHoldBars: 0, trailAtrMult: 0 },
  { key: 'timebox', label: '短期（5バーで手仕舞い）', atrStopMult: 2.0, atrTargetMult: 2.0, maxHoldBars: 5, trailAtrMult: 0 },
];

export const DIRECTIONS = [
  { key: 'both', label: '買いも売りも', allowShort: true, side: 0 },
  { key: 'long', label: '買いのみ', allowShort: false, side: 1 },
  { key: 'short', label: '売りのみ', allowShort: true, side: -1 },
];

// 週足は日足の約5倍の値幅なので、ATRストップの倍率も同じくらい広げる（√5）。
export const TIMEFRAMES = [
  { key: '1d', label: '日足', stopScale: 1 },
  { key: '1w', label: '週足', stopScale: 2.24 },
];

const FILTER_BY_KEY = Object.fromEntries(FILTERS.map((f) => [f.key, f]));
const EXIT_BY_KEY = Object.fromEntries(EXITS.map((e) => [e.key, e]));
const DIR_BY_KEY = Object.fromEntries(DIRECTIONS.map((d) => [d.key, d]));
const TF_BY_KEY = Object.fromEntries(TIMEFRAMES.map((t) => [t.key, t]));

// ---------------------------------------------------------------------------
// コア層: 既知ロジック × パラメータpreset
// ---------------------------------------------------------------------------
export function basePresets() {
  const out = [];
  for (const [key, s] of Object.entries(STRATEGIES)) {
    if (key.startsWith('g_')) continue;   // 合成論理は混ぜない（空間を固定する）
    const g = s.grid || {};
    const keys = Object.keys(g);
    out.push({ key, variant: 0, params: { ...(s.defaultParams || {}) } });
    if (keys.length) {
      const lo = {}; const hi = {};
      for (const k of keys) {
        const arr = g[k];
        if (Array.isArray(arr) && arr.length) { lo[k] = arr[0]; hi[k] = arr[arr.length - 1]; }
      }
      out.push({ key, variant: 1, params: { ...(s.defaultParams || {}), ...lo } });
      out.push({ key, variant: 2, params: { ...(s.defaultParams || {}), ...hi } });
    }
  }
  return out;
}

export function coreAxes(symbols = SYMBOLS) {
  return [symbols.length, TIMEFRAMES.length, basePresets().length, FILTERS.length, EXITS.length, DIRECTIONS.length];
}

export function coreSize(symbols = SYMBOLS) {
  return coreAxes(symbols).reduce((a, b) => a * b, 1);
}

/** 合成層の広さ（AND/OR × 部品2つ × 出口 × 方向 × 時間軸 × 銘柄） */
/** 特徴量のキー一覧（合成層の仮説を1つに絞るときに使う） */
export function featureKeys() { return Object.keys(FEATURES); }

/**
 * 共有パラメータ制約（breadth）: 同じ論理を「同時に複数の銘柄」に当てる。
 * 1つの設定を多数の銘柄で試すので、試行1回あたりの情報量が増える。
 * 過半の銘柄で通ったときだけ候補にする＝偶然の1本を昇格させない。
 */
export function basketFor(index, symbols = SYMBOLS, k = 3) {
  const n = Math.max(1, Math.min(symbols.length, Number(k) || 1));
  const start = ((Math.floor(Number(index) || 0) % symbols.length) + symbols.length) % symbols.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(symbols[(start + i) % symbols.length]);
  return out;
}

export function ruleSize(symbols = SYMBOLS) {
  const A = ATOMS.length;
  return symbols.length * TIMEFRAMES.length * A * (A + 1) * 2 * DIRECTIONS.length * EXITS.length;
}

export function spaceSize(symbols = SYMBOLS) {
  return coreSize(symbols) + ruleSize(symbols);
}

/** 番号 → 論理（コア層）。同じ番号は常に同じ論理を返す。 */
export function coreAt(index, symbols = SYMBOLS) {
  const axes = coreAxes(symbols);
  const total = axes.reduce((a, b) => a * b, 1);
  const i0 = Math.floor(Number(index) || 0);
  let n = ((i0 % total) + total) % total;
  const idx = [];
  for (const size of axes) { idx.push(n % size); n = Math.floor(n / size); }
  const [sI, tfI, bI, fI, eI, dI] = idx;
  const base = basePresets()[bI];
  return {
    v: 1, tier: 'core', idx: i0,
    symbol: symbols[sI] || symbols[0], tf: TIMEFRAMES[tfI].key,
    filter: FILTERS[fI].key, exit: EXITS[eI].key, dir: DIRECTIONS[dI].key,
    base: { kind: 'strategy', key: base.key, variant: base.variant, params: base.params },
  };
}

/** 合成層: 部品2つを AND/OR で組む。mutateFrom を渡すと現王者の近傍を変異させる。 */
export function randomRule(rnd, symbols = SYMBOLS, { mutateFrom = null, features = null, preferState = false } = {}) {
  const A = ATOMS.length;
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  // 仮説を1本に絞る: features を渡すと、その特徴量の部品だけを使う（探索の的を絞り、試行の質を上げる）
  const allowed = (features && features.length)
    ? ATOMS.map((a, i) => (features.includes(a.f) ? i : -1)).filter((i) => i >= 0)
    : null;
  // preferState: 「状態条件（gt/lt）」と「閾値の中間」に寄せる。
  // 交差条件（xup/xdn）は閾値をまたぐ瞬間だけ成立するので、日足1600本でも取引が数回しか出ず、
  // 統計の門（IS15・OOS6）に届かない。極端な閾値も同じ理由で落ちる。門は緩めず、生成側を寄せる。
  const pickAtom = () => {
    const pool = (allowed && allowed.length) ? allowed : ATOMS.map((_, i) => i);
    let idx;
    if (!preferState) {
      idx = pool[Math.floor(rnd() * pool.length)];
    } else {
      const state = pool.filter((i) => ATOMS[i].op === 'gt' || ATOMS[i].op === 'lt');
      const cross = pool.filter((i) => ATOMS[i].op === 'xup' || ATOMS[i].op === 'xdn');
      const useState = state.length > 0 && (cross.length === 0 || rnd() < 0.75);
      const src = useState ? state : cross;
      idx = src[Math.floor(rnd() * src.length)];
    }
    if (preferState && rnd() < 0.7) {
      const a = ATOMS[idx];
      const ths = (FEATURES[a.f] && FEATURES[a.f].th) || null;
      if (ths && ths.length > 2) {
        const mid = [...ths].sort((x, y) => x - y)[Math.floor(ths.length / 2)];
        const j = ATOMS.findIndex((x) => x.f === a.f && x.op === a.op && x.th === mid);
        if (j >= 0) idx = j;
      }
    }
    return idx;
  };
  let base;
  if (mutateFrom && mutateFrom.base && mutateFrom.base.kind === 'rule' && rnd() < 0.7) {
    base = { ...mutateFrom.base };
    const w = rnd();
    if (w < 0.4) base.a = pickAtom();
    else if (w < 0.7) base.b = base.b == null ? pickAtom() : (rnd() < 0.2 ? null : pickAtom());
    else base.comb = base.comb === 'and' ? 'or' : 'and';
  } else {
    base = {
      kind: 'rule',
      a: pickAtom(),
      b: rnd() < (preferState ? 0.35 : 0.45) ? pickAtom() : null,
      comb: rnd() < (preferState ? 0.45 : 0.5) ? 'and' : 'or',
    };
  }
  const inherit = (from, other, p = 0.6) => (mutateFrom && from != null && rnd() < p ? from : other);
  return {
    v: 1, tier: 'rule', idx: null,
    symbol: inherit(mutateFrom?.symbol, pick(symbols)),
    tf: inherit(mutateFrom?.tf, pick(TIMEFRAMES).key),
    filter: 'none',   // 合成層は絞り込みなし（空間の広さを数え上げと一致させる）
    exit: inherit(mutateFrom?.exit, pick(EXITS).key, 0.5),
    dir: inherit(mutateFrom?.dir, pick(DIRECTIONS).key, 0.5),
    base,
  };
}

// ---------------------------------------------------------------------------
// 記述（人に見せる）
// ---------------------------------------------------------------------------
export function ruleText(base) {
  if (!base || base.kind !== 'rule') return '';
  const a = ATOMS[base.a]; const b = base.b == null ? null : ATOMS[base.b];
  if (!a) return '';
  const core = b ? `${atomText(a)} ${base.comb === 'and' ? 'かつ' : 'または'} ${atomText(b)}` : atomText(a);
  return `${core}（成立で買い／逆条件で売り）`;
}

export function describeLogic(spec) {
  if (!spec) return { line: '', base: '', filter: '', exit: '', dir: '', tf: '' };
  const base = spec.base?.kind === 'strategy'
    ? `${STRATEGIES[spec.base.key]?.label || spec.base.key}（${Object.entries(spec.base.params || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '既定'}）`
    : ruleText(spec.base);
  const f = FILTER_BY_KEY[spec.filter] || FILTERS[0];
  const e = EXIT_BY_KEY[spec.exit] || EXITS[1];
  const d = DIR_BY_KEY[spec.dir] || DIRECTIONS[0];
  const t = TF_BY_KEY[spec.tf] || TIMEFRAMES[0];
  return {
    base, filter: f.label, exit: e.label, dir: d.label, tf: t.label,
    line: `${base} ／ ${t.label} ／ ${f.label} ／出口: ${e.label} ／ ${d.label}`,
  };
}

export function logicKey(spec) {
  return `g_${fnv(JSON.stringify(spec)).slice(0, 10)}`;
}

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** 出口の設定（週足ならATR倍率をスケールする） */
export function exitParams(spec) {
  const e = EXIT_BY_KEY[spec.exit] || EXITS[1];
  const scale = (TF_BY_KEY[spec.tf] || TIMEFRAMES[0]).stopScale;
  return {
    atrStopMult: Math.round(e.atrStopMult * scale * 100) / 100,
    atrTargetMult: Math.round(e.atrTargetMult * scale * 100) / 100,
    atrStopMax: scale > 1 ? 8 : 4,
    maxHoldBars: e.maxHoldBars,
    trailAtrMult: e.trailAtrMult,
    allowShort: (DIR_BY_KEY[spec.dir] || DIRECTIONS[0]).allowShort,
  };
}

// ---------------------------------------------------------------------------
// 週足への集約と、日足への因果的な戻し
// 週足のシグナルは「その週が終わってから」しか分からない。戻すときは
// 週の最終日 < 日足の日付 を満たす直近の週だけを使う（未来参照なし）。
// ---------------------------------------------------------------------------
const WEEK_CACHE = new WeakMap();

export function resampleWeekly(bars) {
  const hit = WEEK_CACHE.get(bars);
  if (hit) return hit;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const wk = weekKey(b.date);
    if (!cur || cur.wk !== wk) {
      if (cur) out.push(cur.bar);
      cur = { wk, bar: { ...b, endDate: b.date } };
    } else {
      cur.bar.high = Math.max(cur.bar.high, b.high);
      cur.bar.low = Math.min(cur.bar.low, b.low);
      cur.bar.close = b.close;
      cur.bar.endDate = b.date;
    }
  }
  if (cur) out.push(cur.bar);
  WEEK_CACHE.set(bars, out);
  return out;
}

function weekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;   // 月曜=0
  t.setUTCDate(t.getUTCDate() - day);
  return t.toISOString().slice(0, 10);
}

export function mapWeeklyToDaily(bars, tfBars, raw) {
  const out = new Array(bars.length).fill(0);
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < tfBars.length && String(tfBars[j + 1].endDate || tfBars[j + 1].date) < String(bars[i].date)) j++;
    out[i] = j >= 0 ? (raw[j] || 0) : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 論理 → 意図（+1買い / -1売り / 0待ち）
// ---------------------------------------------------------------------------
export function baseIntent(tfBars, spec) {
  if (spec.base?.kind === 'rule') {
    const S = features(tfBars);
    const A = ATOMS[spec.base.a];
    const B = spec.base.b == null ? null : ATOMS[spec.base.b];
    if (!A) return new Array(tfBars.length).fill(0);
    const out = new Array(tfBars.length).fill(0);
    for (let i = 0; i < tfBars.length; i++) {
      const ca = atomCond(S, A, i);
      if (ca == null) continue;
      const na = !ca;
      let long = ca; let short = na;
      if (B) {
        const cb = atomCond(S, B, i);
        if (cb == null) continue;
        const nb = !cb;
        if (spec.base.comb === 'and') { long = ca && cb; short = na && nb; }
        else { long = ca || cb; short = na || nb; }
      }
      out[i] = long && !short ? 1 : (short && !long ? -1 : 0);
    }
    return out;
  }
  const st = STRATEGIES[spec.base.key];
  if (!st || typeof st.intent !== 'function') return new Array(tfBars.length).fill(0);
  const params = {
    ...(st.defaultParams || {}),
    ...(spec.base.params || {}),
    symbol: spec.symbol,
  };
  return st.intent(tfBars, st.normalize ? st.normalize(params) : params);
}

export function logicIntent(bars, spec, _p = {}) {
  if (!bars || !bars.length || !spec) return [];
  const tfBars = spec.tf === '1w' ? resampleWeekly(bars) : bars;
  const raw = baseIntent(tfBars, spec);
  const daily = spec.tf === '1w' ? mapWeeklyToDaily(bars, tfBars, raw) : raw;
  const S = spec.filter === 'none' || spec.base?.kind === 'rule' ? null : features(bars);
  const filter = FILTER_BY_KEY[spec.filter] || FILTERS[0];
  const dir = DIR_BY_KEY[spec.dir] || DIRECTIONS[0];
  const out = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const s = daily[i] || 0;
    if (s === 0) continue;
    if (dir.side === 1 && s < 0) continue;
    if (dir.side === -1 && s > 0) continue;
    if (S && filter.key !== 'none' && !filter.mask(S, i)) continue;
    out[i] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 実行エンジン（backtest.js）への登録
// 番号から作った論理に住所（strategyKey）を与え、既存の検証の流れにそのまま乗せる。
// ---------------------------------------------------------------------------
const REGISTRY = [];
const REGISTRY_CAP = 600;

export function materialize(spec) {
  const key = logicKey(spec);
  if (STRATEGIES[key]) return key;
  const exit = EXIT_BY_KEY[spec.exit] || EXITS[1];
  const d = describeLogic(spec);
  STRATEGIES[key] = {
    label: `合成論理 ${key.slice(2, 8)}`,
    defaultParams: {
      ...exitParams(spec),
      symbol: spec.symbol,
      logic: spec,
    },
    grid: { atrStopMult: [1.0, 1.5, 2.0, 2.5, 3.0, 4.0], atrTargetMult: [1.5, 2.0, 3.0, 4.0] },
    logicNote: d.line,
    intent(bars, p) { return logicIntent(bars, spec, p); },
  };
  REGISTRY.push(key);
  if (REGISTRY.length > REGISTRY_CAP) {
    const drop = REGISTRY.shift();
    if (drop && drop !== key) delete STRATEGIES[drop];
  }
  return key;
}

export function vocabulary() {
  return {
    features: Object.entries(FEATURES).map(([key, f]) => ({ key, label: f.label, thresholds: f.th })),
    atom_count: ATOMS.length,
    ops: OPS.map((o) => ({ key: o.key, label: o.label })),
    filters: FILTERS.map((f) => ({ key: f.key, label: f.label })),
    exits: EXITS.map((e) => ({ key: e.key, label: e.label, atrStopMult: e.atrStopMult, atrTargetMult: e.atrTargetMult, maxHoldBars: e.maxHoldBars, trailAtrMult: e.trailAtrMult })),
    directions: DIRECTIONS.map((d) => ({ key: d.key, label: d.label })),
    timeframes: TIMEFRAMES.map((t) => ({ key: t.key, label: t.label })),
    base_presets: basePresets().map((b) => ({ strategy: b.key, variant: b.variant })),
  };
}

// この空間に「入っていないもの」を明示する（できないことを黙らない）。
export const NOT_INCLUDED = [
  '日足・週足以外の時間軸（分足・時間足・月足）',
  '複数時間軸の同時参照（上位足での方向確認など）',
  '板情報・約定履歴（ティック）を使う短期戦略',
  '機械学習・統計モデルそのもの（回帰・分類・クラスタ）',
  'ニュース・経済指標・センチメント',
  'ファンダメンタル（金利・物価・需給）',
  'ペア間の裁定・相関・統計的裁定取引',
  '同時に複数の建玉を持つポートフォリオ配分',
  'オプション・先物カーブ・イールドカーブ',
  '注文執行の工夫（分割発注・約定拒否の回避）',
  '裁量の判断（チャートパターンの主観的な認識）',
];
