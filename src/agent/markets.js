/**
 * Market adapters — the outward-facing sales channels.
 *
 * Each channel is an external place where this agent sells, or attempts to sell,
 * its deterministic services. Nothing here holds a secret in code: keys are read
 * from the Worker environment and a missing key is reported, never guessed.
 *
 * Determinism rule: every probe is wrapped, time-boxed and never throws, so a
 * dead marketplace can never take down the revenue surface.
 */

export const MARKET_CHANNELS = [
  {
    id: 'agenthansa',
    label: 'AgentHansa',
    kind: 'agent_task_market',
    signup: 'api_only',
    key_env: 'AGENTHANSA_KEY',
    probe: (key) => ({ url: 'https://www.agenthansa.com/api/agents/me', headers: { authorization: `Bearer ${key}` } }),
    parse: (d) => ({
      email_verified: d.email_verified === true,
      wallet_set: Boolean(d.wallet_address),
      bonus_usd: d.bonus_balance_usd ?? null,
      alliance: d.alliance ?? null,
      referral_code: d.referral_code ?? null,
    }),
    human_actions: [
      'Click the email link from AgentHansa to bind jukky.48@gmail.com (+$0.50)',
      'Set the payout Solana wallet (blocked until the email is bound)',
      'Verify X (+$0.50) from your own account — open X while logged in, the check reads the logged-in session',
      'Verify Reddit (up to $14.50) from your own account — the only Reddit cash that needs no API access or approval',
    ],
  },
  {
    id: 'agoragentic',
    label: 'Agoragentic',
    kind: 'capability_marketplace',
    signup: 'api_only',
    key_env: 'AGORAGENTIC_KEY',
    probe: (key) => ({ url: 'https://agoragentic.com/api/agents/me/listing-health', headers: { authorization: `Bearer ${key}` } }),
    parse: (d) => ({
      listings: (d.listings || []).map((l) => ({ slug: l.slug, status: l.status, review: l.review_status, health: l.health })),
      listing_count: (d.listings || []).length,
    }),
    human_actions: [],
  },
  {
    id: 'the402',
    label: 'the402',
    kind: 'capability_marketplace',
    signup: 'api_only',
    key_env: null,
    probe: () => ({ url: 'https://api.the402.ai/health', headers: {} }),
    parse: (d) => ({ status: d.status ?? null, paused_at: d.paused_at ?? null }),
    human_actions: ['Nothing to do — the platform is paused; retry later'],
  },
  {
    id: 'clustly',
    label: 'Clustly',
    kind: 'escrowed_task_market',
    signup: 'operator_console',
    key_env: 'CLUSTLY_KEY',
    probe: () => ({ url: 'https://www.clustly.ai/docs', headers: {} }),
    parse: () => ({ reachable: true, signup: 'operator_console' }),
    human_actions: ['Open the Clustly operator console once and copy the clk_ key'],
  },
];

/** Fetch with a hard timeout; returns null instead of throwing. */
async function safeJson(url, headers = {}, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _nonJson: true, _bytes: text.length };
    }
    return { http: res.status, body };
  } catch (err) {
    return { http: 0, body: null, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeMarket(channel, env) {
  const key = channel.key_env ? env && env[channel.key_env] : null;
  if (channel.key_env && !key) {
    return { id: channel.id, label: channel.label, configured: false, state: 'key_missing', detail: `${channel.key_env} is not set on the Worker` };
  }
  const { url, headers } = channel.probe(key);
  const res = await safeJson(url, headers);
  if (!res.body) {
    return { id: channel.id, label: channel.label, configured: true, state: 'unreachable', http: res.http, error: res.error ?? null };
  }
  let detail = null;
  try {
    detail = channel.parse(res.body);
  } catch (err) {
    detail = { parse_error: String(err && err.message ? err.message : err) };
  }
  return {
    id: channel.id,
    label: channel.label,
    kind: channel.kind,
    signup: channel.signup,
    configured: true,
    state: res.http === 200 ? 'ok' : `http_${res.http}`,
    http: res.http,
    detail,
  };
}

/** One snapshot of every outward channel, plus the human queue it implies. */
export async function marketSnapshot(env, opts = {}) {
  const ids = opts.ids ?? MARKET_CHANNELS.map((c) => c.id);
  const selected = MARKET_CHANNELS.filter((c) => ids.includes(c.id));
  const results = await Promise.all(selected.map((c) => probeMarket(c, env)));
  const human = [];
  for (const r of results) {
    const ch = MARKET_CHANNELS.find((c) => c.id === r.id);
    const pending = (ch.human_actions || []).filter((a) => {
      if (r.id !== 'agenthansa') return false;
      if (/email link/i.test(a)) return !(r.detail && r.detail.email_verified);
      if (/payout solana wallet/i.test(a)) return !(r.detail && r.detail.wallet_set);
      return true;
    });
    human.push(...pending.map((action) => ({ channel: r.id, action })));
  }
  return {
    generated_at: new Date().toISOString(),
    channels: results,
    human_action_queue: human,
    note: 'Read-only snapshot. Probes are time-boxed and never throw; a channel failing here never affects the paid x402 surface.',
  };
}
