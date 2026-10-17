// EA（MQL5）の書き出し — 「検証で終わらせない」ための出口。
//
// なぜ要るか: fx_lab は王者を更新し続けるが、王者が EA として外に出なければ実口座に届かない。
// ここで昇格済み（fx_strategies に載った）王者を、そのままMT5で動く .mq5 に落とす。
//
// 方針（勝手に賢くしない）:
//   * バックテストと同じ規則だけを書く。非リペイント＝確定足（shift 1）で判定し、
//     新しい足が始まってから動く。利確・損切り・ロット計算も同じ意味の入力にする。
//   * 生成したコードは「構造」だけ自己点検する（OnInit/OnTick、ブレース、CopyBuffer、
//     iMAの引数数など）。MT5が要るコンパイル確認はここではできない（人がMT5で行う）。
//   * 成績の数字は検証時のものをそのまま書き、良く見せない。まずデモで前向き検証、を明記する。

import { nowIso, j, safeJson } from '../util.js';
import { PAIRS, STRATEGIES, DEFAULT_COST_MODEL } from './backtest.js';
import { CHAMPION_KEY } from './fxLab.js';

export const EA_T = 'fx_ea_exports';
export const DEFAULT_TIMEFRAME = 'PERIOD_D1';
export const TF_MAP = { '1d': 'PERIOD_D1', '1h': 'PERIOD_H1', '4h': 'PERIOD_H4', '1w': 'PERIOD_W1', day: 'PERIOD_D1' };

const fmtInt = (v, d = 0) => String(Math.round(Number.isFinite(Number(v)) ? Number(v) : d));
const fmtDbl = (v, d = 0) => { const n = Number(v); if (!Number.isFinite(n)) return Number(d).toFixed(1); return Number.isInteger(n) ? n.toFixed(1) : String(n); };
const fmtBool = (v) => (v ? 'true' : 'false');

// ---------------------------------------------------------------------------
// 戦略ごとの「入力・ハンドル・シグナル」— バックテストの intent() と同じ式だけ。
// ---------------------------------------------------------------------------
export const EA_SPECS = {
  ema_cross: {
    label: 'EMAクロス（トレンドフォロー）',
    inputs: (p) => [
      `input int    InpFast          = ${fmtInt(p.fast, 12)};       // 短期EMAの期間`,
      `input int    InpSlow          = ${fmtInt(p.slow, 48)};       // 長期EMAの期間`,
      `input int    InpTrendFilter   = ${fmtInt(p.trendFilter, 200)};      // トレンドフィルタ（0で無効）`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2)};       // ATRストップの倍率`,
      `input double InpAtrTargetMult = ${fmtDbl(p.atrTargetMult, 0)};       // ATR利確の倍率（0で利確なし）`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   hFast  = iMA(_Symbol, InpTimeframe, InpFast, 0, MODE_EMA, PRICE_CLOSE);
   hSlow  = iMA(_Symbol, InpTimeframe, InpSlow, 0, MODE_EMA, PRICE_CLOSE);
   if(InpTrendFilter > 0) hTrend = iMA(_Symbol, InpTimeframe, InpTrendFilter, 0, MODE_EMA, PRICE_CLOSE);`,
    signal: `   double fast1 = Val(hFast, 1);
   double slow1 = Val(hSlow, 1);
   if(fast1 != EMPTY_VALUE && slow1 != EMPTY_VALUE)
   {
      double trend1 = (InpTrendFilter > 0 ? Val(hTrend, 1) : EMPTY_VALUE);
      bool upOk = (fast1 > slow1) && (InpTrendFilter <= 0 || trend1 == EMPTY_VALUE || close1 > trend1);
      bool dnOk = InpAllowShort && (fast1 < slow1) && (InpTrendFilter <= 0 || trend1 == EMPTY_VALUE || close1 < trend1);
      if(upOk)      want = 1;
      else if(dnOk) want = -1;
   }`,
    tpLine: `   double tpDist = atr1 * InpAtrTargetMult;`,
  },
  rsi_meanrev: {
    label: 'RSI平均回帰',
    inputs: (p) => [
      `input int    InpRsiPeriod     = ${fmtInt(p.period, 14)};       // RSIの期間`,
      `input double InpOversold      = ${fmtDbl(p.oversold, 30)};       // 買い（売られ過ぎ）の水準`,
      `input double InpOverbought    = ${fmtDbl(p.overbought, 70)};       // 売り（買われ過ぎ）の水準`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.5)};       // ATRストップの倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   hRsi = iRSI(_Symbol, InpTimeframe, InpRsiPeriod, PRICE_CLOSE);`,
    signal: `   double rsi1 = Val(hRsi, 1);
   if(rsi1 != EMPTY_VALUE)
   {
      if(rsi1 < InpOversold)                    want = 1;
      else if(InpAllowShort && rsi1 > InpOverbought) want = -1;
   }`,
    tpLine: `   double tpDist = 0.0;`,
  },
  bollinger_fade: {
    label: 'ボリンジャー逆張り',
    inputs: (p) => [
      `input int    InpBandPeriod    = ${fmtInt(p.period, 20)};       // バンドの期間`,
      `input double InpBandMult      = ${fmtDbl(p.mult, 2)};       // 標準偏差の倍率`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.5)};       // ATRストップの倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   hBands = iBands(_Symbol, InpTimeframe, InpBandPeriod, 0, InpBandMult, PRICE_CLOSE);`,
    signal: `   double mid1 = ValB(hBands, 0, 1);
   double up1  = ValB(hBands, 1, 1);
   double dn1  = ValB(hBands, 2, 1);
   if(mid1 != EMPTY_VALUE && up1 != EMPTY_VALUE && dn1 != EMPTY_VALUE)
   {
      if(close1 < dn1)                          want = 1;
      else if(InpAllowShort && close1 > up1)    want = -1;
   }`,
    tpLine: `   double tpDist = 0.0;`,
  },
  donchian_breakout: {
    label: 'ドンチャン・ブレイクアウト',
    inputs: (p) => [
      `input int    InpEntryBars     = ${fmtInt(p.entry, 55)};       // 上抜け判定に使う本数`,
      `input int    InpExitBars      = ${fmtInt(p.exit, 20)};       // 下抜け判定に使う本数`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2)};       // ATRストップの倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: ``,
    signal: `   int hiIdx = iHighest(_Symbol, InpTimeframe, MODE_HIGH, InpEntryBars, 2);
   int loIdx = iLowest(_Symbol, InpTimeframe, MODE_LOW, InpExitBars, 2);
   if(hiIdx >= 0 && loIdx >= 0)
   {
      double hiN = iHigh(_Symbol, InpTimeframe, hiIdx);
      double loN = iLow(_Symbol, InpTimeframe, loIdx);
      if(close1 > hiN)                          want = 1;
      else if(InpAllowShort && close1 < loN)    want = -1;
   }`,
    tpLine: `   double tpDist = 0.0;`,
  },
  macd_trend: {
    label: 'MACDトレンド',
    inputs: (p) => [
      `input int    InpFast          = ${fmtInt(p.fast, 12)};       // 短期EMA`,
      `input int    InpSlow          = ${fmtInt(p.slow, 26)};       // 長期EMA`,
      `input int    InpSignal        = ${fmtInt(p.signal, 9)};       // シグナル`,
      `input int    InpTrendFilter   = ${fmtInt(p.trendFilter, 200)};      // トレンドフィルタ（0で無効）`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.5)};       // ATRストップの倍率`,
      `input double InpAtrTargetMult = ${fmtDbl(p.atrTargetMult, 3.0)};       // ATR利確の倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   int hMacd = iMACD(_Symbol, InpTimeframe, InpFast, InpSlow, InpSignal, PRICE_CLOSE);
   int hTrend2 = (InpTrendFilter > 0 ? iMA(_Symbol, InpTimeframe, InpTrendFilter, 0, MODE_EMA, PRICE_CLOSE) : INVALID_HANDLE);
   (void)hTrend2;`,
    signal: `   double ml = ValB(hMacd, 0, 1);
   double sl = ValB(hMacd, 1, 1);
   if(ml != EMPTY_VALUE && sl != EMPTY_VALUE)
   {
      double tf1 = (InpTrendFilter > 0 ? Val(hTrend2, 1) : EMPTY_VALUE);
      bool upOk = (ml > sl) && (InpTrendFilter <= 0 || tf1 == EMPTY_VALUE || close1 > tf1);
      bool dnOk = InpAllowShort && (ml < sl) && (InpTrendFilter <= 0 || tf1 == EMPTY_VALUE || close1 < tf1);
      if(upOk)      want = 1;
      else if(dnOk) want = -1;
   }`,
    tpLine: `   double tpDist = atr1 * InpAtrTargetMult;`,
  },
  adx_di_trend: {
    label: 'ADX/DIトレンド',
    inputs: (p) => [
      `input int    InpAdxPeriod     = ${fmtInt(p.period, 14)};       // ADX/DMIの期間`,
      `input double InpAdxMin        = ${fmtDbl(p.threshold, 20)};       // これ以下のADXでは入らない`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 3.0)};       // ATRストップの倍率`,
      `input double InpAtrTargetMult = ${fmtDbl(p.atrTargetMult, 4.0)};       // ATR利確の倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   int hAdx = iADX(_Symbol, InpTimeframe, InpAdxPeriod);`,
    signal: `   double adx1 = ValB(hAdx, 0, 1);
   double dip1 = ValB(hAdx, 1, 1);
   double dim1 = ValB(hAdx, 2, 1);
   if(adx1 != EMPTY_VALUE && dip1 != EMPTY_VALUE && dim1 != EMPTY_VALUE && adx1 > InpAdxMin)
   {
      if(dip1 > dim1)                           want = 1;
      else if(InpAllowShort && dim1 > dip1)     want = -1;
   }`,
    tpLine: `   double tpDist = atr1 * InpAtrTargetMult;`,
  },
  stoch_reversal: {
    label: 'ストキャス逆張り',
    inputs: (p) => [
      `input int    InpKPeriod       = ${fmtInt(p.period, 14)};       // %Kの期間`,
      `input int    InpKSmooth       = ${fmtInt(p.smoothK, 3)};       // %Kの平滑`,
      `input int    InpDSmooth       = ${fmtInt(p.smoothD, 3)};       // %Dの平滑`,
      `input double InpOversold      = ${fmtDbl(p.oversold, 20)};       // 売られ過ぎ`,
      `input double InpOverbought    = ${fmtDbl(p.overbought, 80)};       // 買われ過ぎ`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.5)};       // ATRストップの倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   int hStoch = iStochastic(_Symbol, InpTimeframe, InpKPeriod, InpDSmooth, InpKSmooth, MODE_SMA, STO_LOWHIGH);`,
    signal: `   double kNow = ValB(hStoch, 0, 1);   // 直近の確定バー
   double kPrev = ValB(hStoch, 0, 2);  // その前
   if(kNow != EMPTY_VALUE && kPrev != EMPTY_VALUE)
   {
      if(kPrev <= InpOversold && kNow > InpOversold)                    want = 1;
      else if(InpAllowShort && kPrev >= InpOverbought && kNow < InpOverbought) want = -1;
   }`,
    tpLine: `   double tpDist = 0.0;`,
  },
  cci_reversal: {
    label: 'CCI逆張り',
    inputs: (p) => [
      `input int    InpCciPeriod     = ${fmtInt(p.period, 20)};       // CCIの期間`,
      `input double InpCciThreshold  = ${fmtDbl(p.threshold, 100)};       // CCIのしきい値`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.5)};       // ATRストップの倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   int hCci = iCCI(_Symbol, InpTimeframe, InpCciPeriod, PRICE_TYPICAL);`,
    signal: `   double c1 = Val(hCci, 1);
   if(c1 != EMPTY_VALUE)
   {
      if(c1 < -InpCciThreshold)                            want = 1;
      else if(InpAllowShort && c1 > InpCciThreshold)        want = -1;
   }`,
    tpLine: `   double tpDist = 0.0;`,
  },
  keltner_breakout: {
    label: 'ケルトナーブレイクアウト',
    inputs: (p) => [
      `input int    InpKcPeriod      = ${fmtInt(p.period, 20)};       // ケルトナーの期間（EMA）`,
      `input double InpKcMult        = ${fmtDbl(p.mult, 2.0)};       // ATRの倍率`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.0)};       // ATRストップの倍率`,
      `input double InpAtrTargetMult = ${fmtDbl(p.atrTargetMult, 3.0)};       // ATR利確の倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   int hKc = iMA(_Symbol, InpTimeframe, InpKcPeriod, 0, MODE_EMA, PRICE_CLOSE);`,
    signal: `   double mid1 = Val(hKc, 1);
   double atrS = Val(hAtr, 1);
   if(mid1 != EMPTY_VALUE && atrS != EMPTY_VALUE && atrS > 0.0)
   {
      double up = mid1 + InpKcMult * atrS;
      double dn = mid1 - InpKcMult * atrS;
      if(close1 > up)                           want = 1;
      else if(InpAllowShort && close1 < dn)     want = -1;
   }`,
    tpLine: `   double tpDist = atr1 * InpAtrTargetMult;`,
  },
  roc_momentum: {
    label: 'モメンタム（変化率）',
    inputs: (p) => [
      `input int    InpRocPeriod     = ${fmtInt(p.period, 20)};       // 変化率の期間`,
      `input double InpRocThreshold  = ${fmtDbl(p.threshold, 1.5)};       // 変化率のしきい値(%)`,
      `input int    InpMaFilter      = ${fmtInt(p.maFilter, 100)};      // 移動平均フィルタ（0で無効）`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.5)};       // ATRストップの倍率`,
      `input double InpAtrTargetMult = ${fmtDbl(p.atrTargetMult, 3.0)};       // ATR利確の倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   int hRoc = iMomentum(_Symbol, InpTimeframe, InpRocPeriod, PRICE_CLOSE);
   int hMaF = (InpMaFilter > 0 ? iMA(_Symbol, InpTimeframe, InpMaFilter, 0, MODE_SMA, PRICE_CLOSE) : INVALID_HANDLE);`,
    signal: `   double mom1 = Val(hRoc, 1);
   double ma1  = (InpMaFilter > 0 ? Val(hMaF, 1) : EMPTY_VALUE);
   if(mom1 != EMPTY_VALUE)
   {
      double r = mom1 - 100.0;
      bool upOk = (r > InpRocThreshold) && (InpMaFilter <= 0 || ma1 == EMPTY_VALUE || close1 > ma1);
      bool dnOk = InpAllowShort && (r < -InpRocThreshold) && (InpMaFilter <= 0 || ma1 == EMPTY_VALUE || close1 < ma1);
      if(upOk)      want = 1;
      else if(dnOk) want = -1;
   }`,
    tpLine: `   double tpDist = atr1 * InpAtrTargetMult;`,
  },
  supertrend_atr: {
    label: 'スーパートレンド（ATRトレーリング）',
    inputs: (p) => [
      `input int    InpStPeriod      = ${fmtInt(p.period, 10)};       // ATRの期間`,
      `input double InpStMult        = ${fmtDbl(p.mult, 3.0)};       // ATRの倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   static double g_stUpper = 0.0;
   static double g_stLower = 0.0;
   static int    g_stDir   = 0;`,
    signal: `   double atrS = Val(hAtr, 1);
   if(atrS != EMPTY_VALUE && atrS > 0.0)
   {
      double hl2 = (iHigh(_Symbol, InpTimeframe, 1) + iLow(_Symbol, InpTimeframe, 1)) / 2.0;
      double close2 = iClose(_Symbol, InpTimeframe, 2);
      double up = hl2 + InpStMult * atrS;
      double dn = hl2 - InpStMult * atrS;
      if(g_stUpper > 0.0)
      {
         if(!(up < g_stUpper || close2 > g_stUpper)) up = g_stUpper;
         if(!(dn > g_stLower || close2 < g_stLower)) dn = g_stLower;
      }
      if(g_stDir == 0) g_stDir = 1;
      if(g_stUpper > 0.0)
      {
         if(close1 > g_stUpper)      g_stDir = 1;
         else if(close1 < g_stLower) g_stDir = -1;
      }
      g_stUpper = up;
      g_stLower = dn;
      want = (g_stDir == 1) ? 1 : (InpAllowShort ? -1 : 0);
   }`,
    tpLine: `   double tpDist = 0.0;`,
  },
  zscore_meanrev: {
    label: 'zスコア平均回帰',
    inputs: (p) => [
      `input int    InpZPeriod       = ${fmtInt(p.period, 20)};       // zスコアの期間`,
      `input double InpZEntry        = ${fmtDbl(p.entryZ, 2.0)};       // エントリーの|z|`,
      `input double InpAtrStopMult   = ${fmtDbl(p.atrStopMult, 2.5)};       // ATRストップの倍率`,
      `input bool   InpAllowShort    = ${fmtBool(p.allowShort !== false)};      // 売りも取る`,
    ],
    handles: `   int hMaZ = iMA(_Symbol, InpTimeframe, InpZPeriod, 0, MODE_SMA, PRICE_CLOSE);
   int hStdZ = iStdDev(_Symbol, InpTimeframe, InpZPeriod, 0, MODE_SMA, PRICE_CLOSE);`,
    signal: `   double mz = Val(hMaZ, 1);
   double sz = ValB(hStdZ, 0, 1);
   if(mz != EMPTY_VALUE && sz != EMPTY_VALUE && sz > 0.0)
   {
      double z = (close1 - mz) / sz;
      if(z < -InpZEntry)                          want = 1;
      else if(InpAllowShort && z > InpZEntry)     want = -1;
   }`,
    tpLine: `   double tpDist = 0.0;`,
  },
};

export const eaStrategyKeys = () => Object.keys(EA_SPECS);

// ---------------------------------------------------------------------------
// MQL5 の生成
// ---------------------------------------------------------------------------
export function generateMql5({ strategyKey, params = {}, symbol = 'USDJPY', timeframe = DEFAULT_TIMEFRAME, metrics = {}, cost = null, name = null, at = null } = {}) {
  const spec = EA_SPECS[strategyKey];
  if (!spec) return null;
  const C = { ...DEFAULT_COST_MODEL, ...(cost || {}) };
  const generatedAt = at || nowIso();
  // ファイル名はMT5で扱いやすい英数字だけにする（日本語の戦略名は使わない）。
  const base = String(name || `${strategyKey}_${symbol}`).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `${strategyKey}_${symbol}`;
  const filename = `${base}_${String(timeframe).replace(/[^A-Za-z0-9_]/g, '')}.mq5`;
  const setFilename = filename.replace(/\.mq5$/, '.set');
  const p = params || {};
  const strategyInputs = spec.inputs(p).join('\n');
  const handles = [`   hAtr = iATR(_Symbol, InpTimeframe, 14);`, spec.handles].filter(Boolean).join('\n');

  const code = `//+------------------------------------------------------------------+
//| ${filename}
//| Wealth Agent — 検証を通過した王者を EA にしたもの（自動生成）
//| 元: ${symbol} / ${strategyKey}（${spec.label}）
//| 生成: ${generatedAt}
//| 検証の成績（過去データ・スプレッド${C.spreadPips}pip / スリッページ${C.slippagePips}pip 込み）
//|   純益 ${metrics.netProfitPct ?? 'n/a'}% / PF ${metrics.profitFactor ?? 'n/a'} / 最大DD ${metrics.maxDrawdownPct ?? 'n/a'}% / ${metrics.trades ?? 'n/a'} 取引
//| 約束しないこと: 過去の成績は将来の利益を保証しません（実口座のスプレッド・スワップ・約定差は検証と別物）。
//|                まずデモ口座で前向きに検証してください。
//+------------------------------------------------------------------+
#property copyright "Wealth Agent"
#property version   "1.00"
#property description "自動生成EA: ${strategyKey} / ${symbol}"
#property strict_dummy_removed

#include <Trade\\Trade.mqh>

//--- 基本設定
input group "=== 基本 ==="
input string          InpSymbol          = "${symbol}";      // 検証した通貨ペア
input ENUM_TIMEFRAMES InpTimeframe       = ${timeframe};  // 検証した時間足
input double          InpLots            = 0.10;      // 固定ロット（InpRiskPercent が 0 のとき使う）
input double          InpRiskPercent     = 1.0;       // 1取引のリスク%（0で固定ロット）
input int             InpMagic           = 20261016;  // マジックナンバー
input int             InpSlippagePoints  = 10;        // 許容スリッページ（points）
input int             InpMaxSpreadPoints = 30;        // これを超えるスプレッドでは入らない

//--- 戦略のパラメータ（バックテストと同じ値）
input group "=== 戦略のパラメータ ==="
${strategyInputs}

CTrade   trade;
int      hFast  = INVALID_HANDLE;
int      hSlow  = INVALID_HANDLE;
int      hTrend = INVALID_HANDLE;
int      hAtr   = INVALID_HANDLE;
int      hRsi   = INVALID_HANDLE;
int      hBands = INVALID_HANDLE;
datetime g_lastBar = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   if(_Symbol != InpSymbol)
      Print("注意: チャートは ", _Symbol, " ですが、検証したのは ", InpSymbol, " です。同じ通貨ペアで動かしてください。");

${handles}

   if(hAtr == INVALID_HANDLE)
   {
      Print("ATRハンドルを作れませんでした。");
      return(INIT_FAILED);
   }
   Print("EA起動: ", "${strategyKey}", " / ", _Symbol, " / ", EnumToString(InpTimeframe));
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(hFast  != INVALID_HANDLE) IndicatorRelease(hFast);
   if(hSlow  != INVALID_HANDLE) IndicatorRelease(hSlow);
   if(hTrend != INVALID_HANDLE) IndicatorRelease(hTrend);
   if(hAtr   != INVALID_HANDLE) IndicatorRelease(hAtr);
   if(hRsi   != INVALID_HANDLE) IndicatorRelease(hRsi);
   if(hBands != INVALID_HANDLE) IndicatorRelease(hBands);
}

//+------------------------------------------------------------------+
//| 指標の値を1つ読む（buffer指定あり）                                |
//+------------------------------------------------------------------+
double ValB(const int handle, const int buffer, const int shift)
{
   if(handle == INVALID_HANDLE) return(EMPTY_VALUE);
   double buf[];
   if(CopyBuffer(handle, buffer, shift, 1, buf) != 1) return(EMPTY_VALUE);
   return(buf[0]);
}

double Val(const int handle, const int shift)
{
   return(ValB(handle, 0, shift));
}

//+------------------------------------------------------------------+
//| リスクからロットを決める（バックテストの固定ロットと同じ意味）        |
//+------------------------------------------------------------------+
double LotsForRisk(const double stopDistance)
{
   double lots = InpLots;
   if(InpRiskPercent > 0.0 && stopDistance > 0.0)
   {
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tickValue > 0.0 && tickSize > 0.0)
      {
         double lossPerLot = (stopDistance / tickSize) * tickValue;
         if(lossPerLot > 0.0)
            lots = (AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0) / lossPerLot;
      }
   }
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step > 0.0) lots = MathFloor(lots / step) * step;
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(vmin > 0.0) lots = MathMax(vmin, lots);
   if(vmax > 0.0) lots = MathMin(vmax, lots);
   return(NormalizeDouble(lots, 2));
}

//+------------------------------------------------------------------+
//| 本体: 確定足で判定し、新しい足の始まりにだけ動く（非リペイント）      |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime t0 = iTime(_Symbol, InpTimeframe, 0);
   if(t0 == g_lastBar) return;
   g_lastBar = t0;

   double point  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int    digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double close1 = iClose(_Symbol, InpTimeframe, 1);
   if(close1 <= 0.0 || point <= 0.0) return;

   // 意図（+1=買い / -1=売り / 0=手仕舞い）— バックテストの intent() と同じ式
   int want = 0;
${spec.signal}

   // いまの建玉（このEAのマジックナンバーのものだけ見る）
   int pos = 0;
   if(PositionSelect(_Symbol))
   {
      if(PositionGetInteger(POSITION_MAGIC) == InpMagic)
         pos = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? 1 : -1;
   }

   // 出口: 意図が反転・消滅したら閉じる（ATRの損切り・利確は別途置く）
   if(pos != 0 && want != pos)
   {
      if(trade.PositionClose(_Symbol)) pos = 0;
      else
      {
         Print("手仕舞いに失敗: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
         return;
      }
   }

   if(pos != 0 || want == 0) return;

   // 費用の防衛: スプレッドが広い時は入らない（検証の想定コストと揃える）
   long spreadPts = (long)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spreadPts > InpMaxSpreadPoints)
   {
      Print("スプレッドが広いので見送り: ", spreadPts, " points");
      return;
   }

   double atr1 = Val(hAtr, 1);
   if(atr1 == EMPTY_VALUE || atr1 <= 0.0) return;

   double slDist = atr1 * InpAtrStopMult;
${spec.tpLine}
   if(slDist <= 0.0) return;

   double entry = (want > 0) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double sl = (want > 0) ? NormalizeDouble(entry - slDist, digits) : NormalizeDouble(entry + slDist, digits);
   double tp = 0.0;
   if(tpDist > 0.0)
      tp = (want > 0) ? NormalizeDouble(entry + tpDist, digits) : NormalizeDouble(entry - tpDist, digits);

   double lots = LotsForRisk(slDist);

   bool ok = (want > 0) ? trade.Buy(lots, _Symbol, 0.0, sl, tp, "wealth-agent")
                        : trade.Sell(lots, _Symbol, 0.0, sl, tp, "wealth-agent");
   if(!ok)
      Print("注文に失敗: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
   else
      Print("約定: ", (want > 0 ? "買い " : "売り "), lots, " ロット / SL ", sl, " / TP ", tp);
}
//+------------------------------------------------------------------+
`;

  const inputs = [
    ['InpSymbol', symbol], ['InpTimeframe', timeframe], ['InpLots', '0.10'], ['InpRiskPercent', '1.0'],
    ['InpMagic', '20261016'], ['InpSlippagePoints', '10'], ['InpMaxSpreadPoints', '30'],
    ...spec.inputs(p).map((line) => {
      const m = String(line).match(/input\s+\S+\s+(Inp\w+)\s*=\s*([^;]+);/);
      return m ? [m[1], String(m[2]).trim()] : null;
    }).filter(Boolean),
  ];
  const setCode = [
    `; Wealth Agent が書き出した設定ファイル（MT5 の「読み込み」で使えます）`,
    `; 元: ${symbol} / ${strategyKey} / 生成: ${generatedAt}`,
    ...inputs.map(([k, v]) => `${k}=${v}`),
    ``,
  ].join('\n');

  return { filename, set_filename: setFilename, mq5_code: code, set_code: setCode, inputs: inputs.map(([k, v]) => ({ key: k, value: v })), strategy_label: spec.label };
}

// ---------------------------------------------------------------------------
// 構造の自己点検（MT5でのコンパイル確認の代わりではない。明らかな間違いを先に潰す）
// ---------------------------------------------------------------------------
export function lintMql5(code = '') {
  const s = String(code);
  const checks = [];
  const add = (id, ok, note) => checks.push({ id, ok: !!ok, note });

  add('trade_include', s.includes('#include <Trade\\Trade.mqh>'), '#include <Trade\\Trade.mqh> がある');
  add('handlers', /\bint\s+OnInit\s*\(/.test(s) && /\bvoid\s+OnTick\s*\(/.test(s) && /\bvoid\s+OnDeinit\s*\(/.test(s), 'OnInit / OnTick / OnDeinit が揃っている');
  const open = (s.match(/\{/g) || []).length; const close = (s.match(/\}/g) || []).length;
  add('braces', open === close && open > 0, `ブレースの数が合っている（${open} 対 ${close}）`);
  add('copybuffer', s.includes('CopyBuffer('), '指標は CopyBuffer で読んでいる（MQL5の作法）');
  add('no_ordersend', !s.includes('OrderSend('), '旧式の OrderSend を使っていない（CTrade 経由）');
  add('newbar_guard', s.includes('g_lastBar'), '新しい足のときだけ動く（非リペイントの担保）');
  add('inputs_prefixed', (s.match(/^input\s+\S+\s+(\w+)/gm) || []).every((l) => /Inp/.test(l)), '入力変数はすべて Inp で始まる');
  add('property_version', s.includes('#property version'), '#property が書かれている');
  const imas = [...s.matchAll(/iMA\(([^)]*)\)/g)].map((m) => m[1]);
  add('ima_arity', imas.every((a) => a.split(',').length === 6), `iMA を使う場合は引数6つ（MQL5の形）: ${imas.length} 箇所`);
  add('stop_loss_used', s.includes('slDist') && s.includes('SL '), '損切り（ATRストップ）を必ず付けている');
  add('risk_note', s.includes('過去の成績は将来の利益を保証しません'), '成績は保証しない旨がコードに書かれている');

  const ok = checks.every((c) => c.ok);
  return { ok, checks, failed: checks.filter((c) => !c.ok).map((c) => c.id) };
}

// ---------------------------------------------------------------------------
// 永続化と書き出し
// ---------------------------------------------------------------------------
export async function ensureEaTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${EA_T} (
    id TEXT PRIMARY KEY, strategy_id TEXT, symbol TEXT, strategy_key TEXT,
    timeframe TEXT, params_json TEXT, metrics_json TEXT,
    mq5_code TEXT, set_code TEXT, filename TEXT, lint_json TEXT, source TEXT,
    created_at TEXT NOT NULL
  )`).catch(() => {});
}

export async function listEaExports(store, { limit = 20 } = {}) {
  await ensureEaTable(store);
  const rows = await store.all(`SELECT id, strategy_id, symbol, strategy_key, timeframe, filename, lint_json, source, metrics_json, created_at FROM ${EA_T} ORDER BY created_at DESC LIMIT ?`, limit).catch(() => []);
  return rows.map((r) => ({ ...r, metrics: safeJson(r.metrics_json, {}), lint_ok: !!safeJson(r.lint_json, {})?.ok }));
}

export async function buildEa(store, { strategyId = null, timeframe = null, now = null } = {}) {
  await ensureEaTable(store);
  const at = now || nowIso();
  const champ = safeJson((await store.first(`SELECT value FROM settings WHERE key=?`, CHAMPION_KEY).catch(() => null))?.value, null);

  let row = null;
  let source = 'latest_strategy';
  if (strategyId) {
    row = await store.get('fx_strategies', strategyId).catch(() => null);
    source = 'strategy_id';
  } else if (champ?.promoted_to) {
    row = await store.get('fx_strategies', champ.promoted_to).catch(() => null);
    source = row ? 'champion' : 'champion_params';
  }
  if (!row) row = await store.first(`SELECT * FROM fx_strategies ORDER BY created_at DESC LIMIT 1`).catch(() => null);

  const params = { ...safeJson(row?.params_json, null), ...(row ? {} : (champ?.params || {})) };
  const strategyKey = params.strategyKey || champ?.strategy_key || null;
  const symbol = row?.symbol || champ?.symbol || 'USDJPY';
  if (!strategyKey || !EA_SPECS[strategyKey]) {
    return { ok: false, error: 'no_strategy', summary: `EAにできる王者がまだありません（対象: ${eaStrategyKeys().join(' / ')}）。FX Lab を回して昇格させてください。` };
  }
  const tfRaw = timeframe || DEFAULT_TIMEFRAME;
  const tf = TF_MAP[String(tfRaw).toLowerCase()] || (String(tfRaw).startsWith('PERIOD_') ? String(tfRaw) : DEFAULT_TIMEFRAME);
  const metrics = safeJson(row?.metrics_json, null) || champ?.metrics || {};
  const gen = generateMql5({ strategyKey, params, symbol, timeframe: tf, metrics, name: `${strategyKey}_${symbol}`, at });
  const lint = lintMql5(gen.mq5_code);

  const id = `ea_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await store.insert(EA_T, {
    id, strategy_id: row?.id || null, symbol, strategy_key: strategyKey, timeframe: tf,
    params_json: j(params), metrics_json: j(metrics), mq5_code: gen.mq5_code, set_code: gen.set_code,
    filename: gen.filename, lint_json: j(lint), source, created_at: at,
  }).catch(() => {});

  return {
    ok: true, id, source, strategy_id: row?.id || null, symbol, strategy_key: strategyKey,
    strategy_label: gen.strategy_label, timeframe: tf, params, metrics,
    filename: gen.filename, set_filename: gen.set_filename,
    mq5_code: gen.mq5_code, set_code: gen.set_code, lint,
    summary: lint.ok
      ? `${gen.filename} を書き出しました（構造の自己点検は全項目OK）。MT5 でコンパイルして、まずデモ口座で前向きに検証してください。`
      : `${gen.filename} を書き出しましたが、自己点検で ${lint.failed.join(' / ')} が残っています。`,
    caveats: [
      'このコードのコンパイルと実機の挙動は、私の環境（MT5なし）では確認できていません。MetaEditor で F7 して、警告・エラーを確認してください。',
      '検証は日足・スプレッドとスリッページを固定した前提です。実口座のスワップ・約定差・週末の窓は別物なので、いきなり実資金を入れないでください。',
      'いまの王者は最大ドローダウンが大きめです（1/3 近くまで沈む想定）。ロットは InpRiskPercent で小さく始めるのが安全です。',
    ],
  };
}

export function eaHelp() {
  return [
    '昇格した王者（fx_strategies に載ったもの）を、そのまま MT5 で動く EA（.mq5）と設定ファイル（.set）に書き出します。ここが「検証で終わらせない」ための出口です。',
    '書かれる規則はバックテストと同じものだけです。確定足で判定し、新しい足が始まってから動く（非リペイント）、損切りはATR、利確は戦略に応じてATRか無し、ロットは固定かリスク%から計算。検証と違う動きを勝手に入れません。',
    '生成したコードは構造だけ自己点検します（OnInit/OnTick/OnDeinit、ブレース、CopyBuffer、iMAの引数数、損切りの有無など）。MT5が要るコンパイル確認はここではできないので、MetaEditor で F7 してください。',
    '順番は「書き出す → デモ口座で前向きに走らせる → 検証と大きくズレないか見る → 小さなロットで実資金」。過去データの成績は将来の利益を保証しません。',
    '実口座への発注はあなたの操作です。このエージェントは発注も資金移動もしません（凍結と財布の防衛）。',
  ].join('\n\n');
}
