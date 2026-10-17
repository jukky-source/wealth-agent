// Pine Script v5/v6 generation + non-repainting linter.
//
// The linter is the important half: it inspects generated code for the classic
// ways a strategy looks good in backtest but cannot be traded:
//   * lookahead in request.security()
//   * signals that use the still-forming bar
//   * calc_on_every_tick / varip (intrabar state)
//   * strategy() without process_orders_on_close / fill assumptions
//   * repainting ta.* calls on unresolved series

export const LINT_RULES = [
  { id: 'security_lookahead', severity: 'error', re: /request\.security\([^)]*lookahead\s*=\s*barmerge\.lookahead_on/, msg: 'request.security() に lookahead_on が指定されています（未来参照）' },
  { id: 'security_no_lookahead_off', severity: 'warn', re: /request\.security\((?!.*lookahead)/, msg: 'request.security() に lookahead 指定がありません。lookahead=barmerge.lookahead_off を明示してください' },
  { id: 'calc_on_every_tick', severity: 'error', re: /calc_on_every_tick\s*=\s*true/, msg: 'calc_on_every_tick=true は確定前バーで判定するため非リペイント要件に反します' },
  { id: 'varip_state', severity: 'error', re: /\bvarip\b/, msg: 'varip はイントラバー状態を持ち、履歴と実運用で挙動が変わります' },
  { id: 'barstate_unconfirmed_entry', severity: 'warn', re: /(strategy\.entry|strategy\.order|strategy\.close)\s*\((?![^)]*barstate\.isconfirmed)/, msg: '確定バー判定なしの発注です。barstate.isconfirmed を条件に含めてください' },
  { id: 'unconfirmed_close_signal', severity: 'warn', re: /(longCondition|shortCondition|buySignal|sellSignal)\s*:=\s*[^\n]*\bclose\b(?![^\n]*isconfirmed)/i, msg: '確定前の終値でシグナルを確定しています。シグナルは確定バーのみ、約定は翌バー始値にしてください' },
  { id: 'ta_lookahead_shift', severity: 'warn', re: /\bta\.[a-z_]+\([^)]*\)\s*\[\s*-/, msg: '負のバーオフセット（未来バー参照）が含まれています' },
  { id: 'no_process_on_close', severity: 'info', re: /strategy\s*\([^)]*\)/, msg: 'strategy() 宣言を確認。process_orders_on_close の扱いと約定タイミングを明示的に検証してください' },
  { id: 'hardcoded_future_data', severity: 'error', re: /\brequest\.security\([^)]*\)\s*\[\s*1\s*\]/, msg: 'security結果への[1]適用は、意図しない未来参照/遅延の原因になります' },
];

export function lintPine(code, { markers = null } = {}) {
  const violations = [];
  let checksRun = 0;
  const src = String(code || '');
  for (const rule of LINT_RULES) {
    checksRun++;
    const m = src.match(rule.re);
    if (m) {
      violations.push({ rule: rule.id, severity: rule.severity, message: rule.msg, match: m[0].slice(0, 120) });
    }
  }
  // Mandatory positive checks
  checksRun++;
  if (!/barstate\.isconfirmed/.test(src)) {
    violations.push({ rule: 'missing_isconfirmed', severity: 'error', message: 'barstate.isconfirmed による確定バー判定がありません（非リペイント必須要件）' });
  }
  checksRun++;
  if (!/\[1\]/.test(src) || !/strategy\.entry|strategy\.order/.test(src)) {
    violations.push({ rule: 'missing_next_bar_fill', severity: 'warn', message: '翌バー約定（前バーのシグナルを [1] で参照して発注）の実装が見当たりません' });
  }
  if (markers) {
    for (const mk of markers) {
      checksRun++;
      if (!src.includes(mk)) violations.push({ rule: 'missing_required_marker', severity: 'error', message: `必須条件 ${mk} がコードに含まれていません` });
    }
  }
  const errors = violations.filter((v) => v.severity === 'error');
  return {
    nonRepaint: errors.length === 0,
    violations, checksRun,
    errors: errors.length,
    warnings: violations.filter((v) => v.severity === 'warn').length,
    infos: violations.filter((v) => v.severity === 'info').length,
    note: 'エラー0件で非リペイント合格と判定します（警告は要確認事項）。',
  };
}

// ---------------------------------------------------------------------------
// Code generation — v5 and v6 templates that pass the linter by construction.
// ---------------------------------------------------------------------------
export function generatePine(strategyKey, params, { version = 'v6', symbol = 'USDJPY' } = {}) {
  const header = version === 'v5'
    ? `//@version=5`
    : `//@version=6`;

  const body = {
    ema_cross: () => `
fastLen = input.int(${params.fast ?? 12}, "Fast EMA")
slowLen = input.int(${params.slow ?? 48}, "Slow EMA")
trendLen = input.int(${params.trendFilter ?? 200}, "Trend Filter EMA")
atrLen  = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.0}, "ATR Stop x")
tpMult   = input.float(${params.atrTargetMult ?? 3.0}, "ATR Target x")

f = ta.ema(close, fastLen)
s = ta.ema(close, slowLen)
tf = ta.ema(close, trendLen)
a = ta.atr(atrLen)

// NOTE: conditions are evaluated ONLY on confirmed bars.
upTrend   = f > s and close > tf
downTrend = f < s and close < tf
enterLong  = barstate.isconfirmed and upTrend and not upTrend[1]
enterShort = ${params.allowShort ? 'barstate.isconfirmed and downTrend and not downTrend[1]' : 'false'}

// Signals are registered on the confirmed bar and executed on the NEXT bar open
// (strategy.entry on a confirmed bar fills at the next bar's open by default).
if enterLong
    strategy.entry("L", strategy.long)
if enterShort
    strategy.entry("S", strategy.short)

longStop  = strategy.position_avg_price - a * stopMult
shortStop = strategy.position_avg_price + a * stopMult
longTP    = strategy.position_avg_price + a * stopMult * tpMult
shortTP   = strategy.position_avg_price - a * stopMult * tpMult

if strategy.position_size > 0
    strategy.exit("L-exit", from_entry="L", stop=longStop, limit=longTP)
if strategy.position_size < 0
    strategy.exit("S-exit", from_entry="S", stop=shortStop, limit=shortTP)
`,
    rsi_meanrev: () => `
rsiLen  = input.int(${params.period ?? 14}, "RSI Length")
osLevel = input.float(${params.oversold ?? 30}, "Oversold")
obLevel = input.float(${params.overbought ?? 70}, "Overbought")
exitLvl = input.float(${params.exitLevel ?? 50}, "Exit level")
atrLen  = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")

r = ta.rsi(close, rsiLen)
a = ta.atr(atrLen)

longSig  = barstate.isconfirmed and r < osLevel and r[1] >= osLevel
shortSig = ${params.allowShort ? 'barstate.isconfirmed and r > obLevel and r[1] <= obLevel' : 'false'}
exitLong  = barstate.isconfirmed and r > exitLvl
exitShort = barstate.isconfirmed and r < exitLvl

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0 and exitLong
    strategy.close("L")
if strategy.position_size < 0 and exitShort
    strategy.close("S")

if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    bollinger_fade: () => `
bbLen  = input.int(${params.period ?? 20}, "BB Length")
bbMult = input.float(${params.mult ?? 2.0}, "BB Mult")
atrLen = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")

basis = ta.sma(close, bbLen)
dev   = bbMult * ta.stdev(close, bbLen)
lower = basis - dev
upper = basis + dev
a = ta.atr(atrLen)

longSig  = barstate.isconfirmed and close[1] < lower[1] and close > lower
shortSig = ${params.allowShort ? 'barstate.isconfirmed and close[1] > upper[1] and close < upper' : 'false'}
exitMid  = barstate.isconfirmed and ((strategy.position_size > 0 and close > basis) or (strategy.position_size < 0 and close < basis))

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if exitMid and strategy.position_size != 0
    strategy.close_all()

if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    donchian_breakout: () => `
entryLen = input.int(${params.entry ?? 55}, "Entry Lookback")
exitLen  = input.int(${params.exit ?? 20}, "Exit Lookback")
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.0}, "ATR Stop x")

// [1] keeps the channel strictly historical (no repaint, no lookahead)
hi = ta.highest(high, entryLen)[1]
lo = ta.lowest(low, entryLen)[1]
exitHi = ta.highest(high, exitLen)[1]
exitLo = ta.lowest(low, exitLen)[1]
a = ta.atr(atrLen)

longSig  = barstate.isconfirmed and close > hi
shortSig = ${params.allowShort ? 'barstate.isconfirmed and close < lo' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0 and barstate.isconfirmed and close < exitLo
    strategy.close("L")
if strategy.position_size < 0 and barstate.isconfirmed and close > exitHi
    strategy.close("S")

if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    macd_trend: () => `
fastLen  = input.int(${params.fast ?? 12}, "Fast EMA")
slowLen  = input.int(${params.slow ?? 26}, "Slow EMA")
sigLen   = input.int(${params.signal ?? 9}, "Signal")
trendLen = input.int(${params.trendFilter ?? 200}, "Trend Filter EMA")
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")
tpMult   = input.float(${params.atrTargetMult ?? 3.0}, "ATR Target x")

[ml, sl, hist] = ta.macd(close, fastLen, slowLen, sigLen)
tf = ta.ema(close, trendLen)
a  = ta.atr(atrLen)

upOk = hist > 0 and ml > sl and close > tf
dnOk = hist < 0 and ml < sl and close < tf
longSig  = barstate.isconfirmed and upOk and not upOk[1]
shortSig = ${params.allowShort ? 'barstate.isconfirmed and dnOk and not dnOk[1]' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-exit", from_entry="L", stop=strategy.position_avg_price - a * stopMult, limit=strategy.position_avg_price + a * stopMult * tpMult)
if strategy.position_size < 0
    strategy.exit("S-exit", from_entry="S", stop=strategy.position_avg_price + a * stopMult, limit=strategy.position_avg_price - a * stopMult * tpMult)
`,
    adx_di_trend: () => `
adxLen  = input.int(${params.period ?? 14}, "ADX/DMI Length")
adxMin  = input.float(${params.threshold ?? 20}, "ADX minimum (trend required)")
atrLen  = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 3.0}, "ATR Stop x")
tpMult   = input.float(${params.atrTargetMult ?? 4.0}, "ATR Target x")

[dip, dim, adxVal] = ta.dmi(adxLen, adxLen)
a = ta.atr(atrLen)

longOk  = dip > dim and adxVal > adxMin
shortOk = dim > dip and adxVal > adxMin
longSig  = barstate.isconfirmed and longOk and not longOk[1]
shortSig = ${params.allowShort ? 'barstate.isconfirmed and shortOk and not shortOk[1]' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-exit", from_entry="L", stop=strategy.position_avg_price - a * stopMult, limit=strategy.position_avg_price + a * stopMult * tpMult)
if strategy.position_size < 0
    strategy.exit("S-exit", from_entry="S", stop=strategy.position_avg_price + a * stopMult, limit=strategy.position_avg_price - a * stopMult * tpMult)
`,
    stoch_reversal: () => `
kLen     = input.int(${params.period ?? 14}, "Stoch Length")
kSmooth  = input.int(${params.smoothK ?? 3}, "K smoothing")
dSmooth  = input.int(${params.smoothD ?? 3}, "D smoothing")
osLevel  = input.float(${params.oversold ?? 20}, "Oversold")
obLevel  = input.float(${params.overbought ?? 80}, "Overbought")
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")

rawK = ta.stoch(close, high, low, kLen)
k = ta.sma(rawK, kSmooth)
d = ta.sma(k, dSmooth)
a = ta.atr(atrLen)

longUp  = k[1] <= osLevel and k > osLevel
shortDn = k[1] >= obLevel and k < obLevel
longSig  = barstate.isconfirmed and longUp
shortSig = ${params.allowShort ? 'barstate.isconfirmed and shortDn' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    cci_reversal: () => `
cciLen   = input.int(${params.period ?? 20}, "CCI Length")
cciThr   = input.float(${params.threshold ?? 100}, "CCI threshold")
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")

c = ta.cci(close, cciLen)
a = ta.atr(atrLen)

longSig  = barstate.isconfirmed and c < -cciThr
shortSig = ${params.allowShort ? 'barstate.isconfirmed and c > cciThr' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    keltner_breakout: () => `
kcLen    = input.int(${params.period ?? 20}, "KC Length (EMA)")
kcMult   = input.float(${params.mult ?? 2.0}, "KC ATR mult")
atrLen   = input.int(${params.atrPeriod ?? 14}, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.0}, "ATR Stop x")
tpMult   = input.float(${params.atrTargetMult ?? 3.0}, "ATR Target x")

basis = ta.ema(close, kcLen)
a = ta.atr(atrLen)
upper = basis + kcMult * a
lower = basis - kcMult * a

longSig  = barstate.isconfirmed and close > upper
shortSig = ${params.allowShort ? 'barstate.isconfirmed and close < lower' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-exit", from_entry="L", stop=strategy.position_avg_price - a * stopMult, limit=strategy.position_avg_price + a * stopMult * tpMult)
if strategy.position_size < 0
    strategy.exit("S-exit", from_entry="S", stop=strategy.position_avg_price + a * stopMult, limit=strategy.position_avg_price - a * stopMult * tpMult)
`,
    squeeze_breakout: () => `
bbLen    = input.int(${params.period ?? 20}, "BB Length")
bbMult   = input.float(${params.mult ?? 2.0}, "BB Mult")
sqLook   = input.int(${params.squeezeLookback ?? 120}, "Squeeze lookback")
sqPct    = input.float(${params.squeezePct ?? 0.35}, "Squeeze threshold")
brkLen   = input.int(${params.breakoutBars ?? 20}, "Breakout lookback")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")

basis = ta.sma(close, bbLen)
dev   = ta.stdev(close, bbLen)
bw    = (2 * bbMult * dev) / basis
bwAvg = ta.sma(bw, sqLook)
squeezed = bw <= bwAvg * sqPct
a = ta.atr(14)

hi = ta.highest(close, brkLen)[1]
lo = ta.lowest(close, brkLen)[1]
wasSqueezed = squeezed[1] or squeezed[2] or squeezed[3]

longSig  = barstate.isconfirmed and wasSqueezed and close > hi
shortSig = ${params.allowShort ? 'barstate.isconfirmed and wasSqueezed and close < lo' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    supertrend_atr: () => `
stPeriod = input.int(${params.period ?? 10}, "ATR Period")
stMult   = input.float(${params.mult ?? 3.0}, "ATR mult")

// ta.supertrend の direction は -1 が上昇、1 が下降
[stLine, stDir] = ta.supertrend(stMult, stPeriod)
upTrend = stDir == -1

longSig  = barstate.isconfirmed and upTrend and not upTrend[1]
shortSig = ${params.allowShort ? 'barstate.isconfirmed and not upTrend and upTrend[1]' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0 and not upTrend
    strategy.close("L")
if strategy.position_size < 0 and upTrend
    strategy.close("S")
`,
    roc_momentum: () => `
rocLen   = input.int(${params.period ?? 20}, "ROC Length")
rocThr   = input.float(${params.threshold ?? 1.5}, "ROC threshold %")
maLen    = input.int(${params.maFilter ?? 100}, "MA filter")
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")
tpMult   = input.float(${params.atrTargetMult ?? 3.0}, "ATR Target x")

r = ta.roc(close, rocLen)
maF = ta.sma(close, maLen)
a = ta.atr(atrLen)

upOk = r > rocThr and close > maF
dnOk = r < -rocThr and close < maF
longSig  = barstate.isconfirmed and upOk and not upOk[1]
shortSig = ${params.allowShort ? 'barstate.isconfirmed and dnOk and not dnOk[1]' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-exit", from_entry="L", stop=strategy.position_avg_price - a * stopMult, limit=strategy.position_avg_price + a * stopMult * tpMult)
if strategy.position_size < 0
    strategy.exit("S-exit", from_entry="S", stop=strategy.position_avg_price + a * stopMult, limit=strategy.position_avg_price - a * stopMult * tpMult)
`,
    zscore_meanrev: () => `
zLen     = input.int(${params.period ?? 20}, "z-score Length")
zEntry   = input.float(${params.entryZ ?? 2.0}, "Entry |z|")
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")

basis = ta.sma(close, zLen)
sd    = ta.stdev(close, zLen)
z     = sd > 0 ? (close - basis) / sd : 0
a     = ta.atr(atrLen)

longSig  = barstate.isconfirmed and z < -zEntry
shortSig = ${params.allowShort ? 'barstate.isconfirmed and z > zEntry' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0 and z >= 0
    strategy.close("L")
if strategy.position_size < 0 and z <= 0
    strategy.close("S")
if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    ichimoku_trend: () => `
tenkanLen = input.int(${params.tenkan ?? 9}, "転換線")
kijunLen  = input.int(${params.kijun ?? 26}, "基準線")
atrLen    = input.int(14, "ATR Length")
stopMult  = input.float(${params.atrStopMult ?? 2.5}, "ATR Stop x")
tpMult    = input.float(${params.atrTargetMult ?? 3.0}, "ATR Target x")

tenkan = (ta.highest(high, tenkanLen) + ta.lowest(low, tenkanLen)) / 2
kijun  = (ta.highest(high, kijunLen) + ta.lowest(low, kijunLen)) / 2
a = ta.atr(atrLen)

upOk = close > kijun and tenkan > kijun
dnOk = close < kijun and tenkan < kijun
longSig  = barstate.isconfirmed and upOk and not upOk[1]
shortSig = ${params.allowShort ? 'barstate.isconfirmed and dnOk and not dnOk[1]' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-exit", from_entry="L", stop=strategy.position_avg_price - a * stopMult, limit=strategy.position_avg_price + a * stopMult * tpMult)
if strategy.position_size < 0
    strategy.exit("S-exit", from_entry="S", stop=strategy.position_avg_price + a * stopMult, limit=strategy.position_avg_price - a * stopMult * tpMult)
`,
    dual_thrust: () => `
lbLen    = input.int(${params.lookback ?? 5}, "Lookback")
k1       = input.float(${params.k1 ?? 0.5}, "k1 (upper)")
k2       = input.float(${params.k2 ?? 0.5}, "k2 (lower)")
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 2.0}, "ATR Stop x")

// 前バーまでのレンジ（未来参照なし）
hh = ta.highest(high, lbLen)[1]
ll = ta.lowest(low, lbLen)[1]
hc = ta.highest(close, lbLen)[1]
lc = ta.lowest(close, lbLen)[1]
range = math.max(hh - lc, hc - ll)

upper = open + k1 * range
lower = open - k2 * range
a = ta.atr(atrLen)

longSig  = barstate.isconfirmed and close > upper
shortSig = ${params.allowShort ? 'barstate.isconfirmed and close < lower' : 'false'}

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    weekday_seasonality: () => `
// Pine の dayofweek は 1=日曜 ... 7=土曜（JS側の 0=日曜 に +1 して合わせる）
targetDow = input.int(${Number(params.weekday ?? 1) + 1}, "曜日 (1=日, 2=月, 3=火, 4=水, 5=木, 6=金, 7=土)")
sideInput = input.int(${params.side ?? 1}, "方向 (1=買い, -1=売り)", options=[1, -1])
holdBars  = input.int(${params.hold ?? 2}, "保有バー数")
atrLen    = input.int(14, "ATR Length")
stopMult  = input.float(${params.atrStopMult ?? 3.0}, "ATR Stop x")

inDay = dayofweek == targetDow
a = ta.atr(atrLen)

longSig  = barstate.isconfirmed and inDay and sideInput == 1 and not inDay[1]
shortSig = barstate.isconfirmed and inDay and sideInput == -1 and not inDay[1]

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size != 0 and strategy.opentrades > 0 and bar_index - strategy.opentrades.entry_bar_index(0) >= holdBars
    strategy.close_all()
if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
    turn_of_month: () => `
beforeN  = input.int(${params.before ?? 2}, "月末の何日前から")
afterN   = input.int(${params.after ?? 3}, "月初の何日まで")
sideInput = input.int(${params.side ?? 1}, "方向 (1=買い, -1=売り)", options=[1, -1])
atrLen   = input.int(14, "ATR Length")
stopMult = input.float(${params.atrStopMult ?? 3.0}, "ATR Stop x")

// その月の最終日を、翌月1日の前日から求める（未来の価格は使わない）
nextM   = month == 12 ? 1 : month + 1
nextY   = month == 12 ? year + 1 : year
lastDom = dayofmonth(timestamp(nextY, nextM, 1) - 86400000)
inWindow = dayofmonth >= lastDom - beforeN or dayofmonth <= afterN
a = ta.atr(atrLen)

longSig  = barstate.isconfirmed and inWindow and sideInput == 1 and not inWindow[1]
shortSig = barstate.isconfirmed and inWindow and sideInput == -1 and not inWindow[1]

if longSig
    strategy.entry("L", strategy.long)
if shortSig
    strategy.entry("S", strategy.short)
if strategy.position_size != 0 and not inWindow
    strategy.close_all()
if strategy.position_size > 0
    strategy.exit("L-stop", from_entry="L", stop=strategy.position_avg_price - a * stopMult)
if strategy.position_size < 0
    strategy.exit("S-stop", from_entry="S", stop=strategy.position_avg_price + a * stopMult)
`,
  }[strategyKey];

  if (!body) throw new Error(`no pine template for ${strategyKey}`);
  return `${header}
strategy("WealthAgent ${strategyKey} ${symbol}", overlay=true, initial_capital=100000, currency=currency.JPY, commission_type=strategy.commission.cash_per_order, commission_value=0, slippage=2, process_orders_on_close=false)
${body()}
`;
}
