// Truthfulness layer — the system must never blur what was proven.
// Every capability claim flows through a measurement status here.

export const MEASUREMENT = {
  CODE_GENERATED: 'code_generated',
  TEST_EXECUTED: 'test_executed',
  TEST_PASSED: 'test_passed',
  DEPLOYED: 'deployed',
  DEPLOY_VERIFIED: 'deploy_verified',
  OPPORTUNITY_FOUND: 'opportunity_found',
  MONETIZATION_IMPLEMENTED: 'monetization_implemented',
  REVENUE_OCCURRED: 'revenue_occurred',
  PAYOUT_CONFIRMED: 'payout_confirmed',
};

export const MEASUREMENT_LABEL = {
  [MEASUREMENT.CODE_GENERATED]: 'コード生成済み',
  [MEASUREMENT.TEST_EXECUTED]: 'テスト実行済み',
  [MEASUREMENT.TEST_PASSED]: 'テスト合格',
  [MEASUREMENT.DEPLOYED]: 'デプロイ済み',
  [MEASUREMENT.DEPLOY_VERIFIED]: 'デプロイ後の動作確認済み',
  [MEASUREMENT.OPPORTUNITY_FOUND]: '収益機会の発見',
  [MEASUREMENT.MONETIZATION_IMPLEMENTED]: '収益化の仕組みの実装',
  [MEASUREMENT.REVENUE_OCCURRED]: '実際の収益発生',
  [MEASUREMENT.PAYOUT_CONFIRMED]: '実際の入金・換金確認',
};

// Ordered maturity ladder — a claim may only cite a level it actually reached.
export const LADDER = [
  MEASUREMENT.OPPORTUNITY_FOUND,
  MEASUREMENT.CODE_GENERATED,
  MEASUREMENT.TEST_EXECUTED,
  MEASUREMENT.TEST_PASSED,
  MEASUREMENT.DEPLOYED,
  MEASUREMENT.DEPLOY_VERIFIED,
  MEASUREMENT.MONETIZATION_IMPLEMENTED,
  MEASUREMENT.REVENUE_OCCURRED,
  MEASUREMENT.PAYOUT_CONFIRMED,
];

export const BASIS = {
  MEASURED: 'measured',       // we observed it ourselves, with a recordable artifact
  THIRD_PARTY: 'third_party', // a named third party reported it (must carry a URL)
  ESTIMATED: 'estimated',     // derived/model output
  UNVERIFIED: 'unverified',   // asserted, no evidence yet
};

export const BASIS_LABEL = {
  measured: '実測',
  third_party: '第三者報告',
  estimated: '推定',
  unverified: '未確認',
};

/** A verified claim must carry evidence. Everything else is downgraded. */
export function claim(level, { basis = BASIS.UNVERIFIED, evidence = null, note = '' } = {}) {
  let b = basis;
  if (b === BASIS.MEASURED && !evidence) b = BASIS.UNVERIFIED;          // no evidence → not measured
  if (b === BASIS.THIRD_PARTY && !/^https?:\/\//.test(String(evidence || ''))) b = BASIS.UNVERIFIED;
  if (!LADDER.includes(level)) throw new Error(`unknown measurement level: ${level}`);
  return {
    level,
    label: MEASUREMENT_LABEL[level],
    basis: b,
    basis_label: BASIS_LABEL[b],
    evidence: evidence || null,
    note,
    verified: b === BASIS.MEASURED,
  };
}

/** Never let an estimate be stored as a measured revenue. */
export function normalizeLedgerEntry(e) {
  if (e.kind === 'revenue' && (!e.basis || e.basis === BASIS.MEASURED) && !e.source) {
    return { ...e, basis: BASIS.UNVERIFIED };
  }
  return e;
}

/** Aggregate ledger with strict separation of measured vs estimated. */
export function summarizeLedger(rows) {
  const out = {
    revenue: { measured: 0, third_party: 0, estimated: 0, unverified: 0, total_measured: 0, total_estimated: 0, measured_by_currency: {} },
    cost: { measured: 0, third_party: 0, estimated: 0, unverified: 0, total_measured: 0, total_estimated: 0, measured_by_currency: {} },
    net_profit_measured: 0,
    net_profit_estimated: 0,
    disclaimer: '実測値には証拠記録があります。推定値は収益実績として扱いません。',
  };
  for (const r of rows) {
    const side = r.kind === 'cost' ? 'cost' : 'revenue';
    const b = ['measured', 'third_party', 'estimated'].includes(r.basis) ? r.basis : 'unverified';
    const amt = Number(r.amount) || 0;
    const cur = String(r.currency || 'JPY').toUpperCase();
    // 通貨をまたいで足さない。measured は円だけで合計し、円以外は通貨別に分けて出す。
    // USDC の売上を円の数字に混ぜると、純益も AMR も意味を失う。
    if (b === 'measured' && cur !== 'JPY') {
      const m = out[side].measured_by_currency;
      m[cur] = (m[cur] || 0) + amt;
    } else {
      out[side][b] += amt;
    }
  }
  out.revenue.total_measured = out.revenue.measured;
  out.revenue.total_estimated = out.revenue.estimated + out.revenue.third_party;
  out.cost.total_measured = out.cost.measured;
  out.cost.total_estimated = out.cost.estimated + out.cost.third_party;
  out.net_profit_measured = out.revenue.measured - out.cost.measured;
  out.net_profit_estimated = out.revenue.total_estimated - out.cost.total_estimated;
  return out;
}

/**
 * summarizeLedger と同じ形を、行を転送せずに SQL 集計（kind,basis ごとの SUM）から作る。
 * /api/dashboard は20秒ごとに叩かれるので、500行を運ぶ代わりにこの集計を使う。
 */
export function summarizeLedgerAgg(agg) {
  const out = {
    revenue: { measured: 0, third_party: 0, estimated: 0, unverified: 0, total_measured: 0, total_estimated: 0, measured_by_currency: {} },
    cost: { measured: 0, third_party: 0, estimated: 0, unverified: 0, total_measured: 0, total_estimated: 0, measured_by_currency: {} },
    net_profit_measured: 0,
    net_profit_estimated: 0,
    disclaimer: '実測値には証拠記録があります。推定値は収益実績として扱いません。',
  };
  for (const r of agg || []) {
    const side = r.kind === 'cost' ? 'cost' : 'revenue';
    const b = ['measured', 'third_party', 'estimated'].includes(r.basis) ? r.basis : 'unverified';
    const amt = Number(r.total) || 0;
    const cur = String(r.currency || 'JPY').toUpperCase();
    if (b === 'measured' && cur !== 'JPY') {
      const m = out[side].measured_by_currency;
      m[cur] = (m[cur] || 0) + amt;
    } else {
      out[side][b] += amt;
    }
  }
  out.revenue.total_measured = out.revenue.measured;
  out.revenue.total_estimated = out.revenue.estimated + out.revenue.third_party;
  out.cost.total_measured = out.cost.measured;
  out.cost.total_estimated = out.cost.estimated + out.cost.third_party;
  out.net_profit_measured = out.revenue.measured - out.cost.measured;
  out.net_profit_estimated = out.revenue.total_estimated - out.cost.total_estimated;
  return out;
}

/** Guard used before a task can be marked completed with an income claim. */
export function assertIncomeClaimAllowed(task, revenueBasis) {
  if (!revenueBasis || revenueBasis === BASIS.ESTIMATED || revenueBasis === BASIS.UNVERIFIED) {
    return { ok: true, note: '収益は推定/未確認として記録されます（実績としては扱いません）' };
  }
  if (!task.evidence_url && revenueBasis === BASIS.THIRD_PARTY) {
    return { ok: false, reason: 'third_party 収益には出典URLが必要です' };
  }
  return { ok: true };
}
