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
  }[strategyKey];

  if (!body) throw new Error(`no pine template for ${strategyKey}`);
  return `${header}
strategy("WealthAgent ${strategyKey} ${symbol}", overlay=true, initial_capital=100000, currency=currency.JPY, commission_type=strategy.commission.cash_per_order, commission_value=0, slippage=2, process_orders_on_close=false)
${body()}
`;
}
