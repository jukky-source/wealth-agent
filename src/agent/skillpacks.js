// skillpacks.js — free, externally-published agent/skill packs, mapped onto this
// worker's own lanes and AI roles. Read-only reference data: no network calls,
// no secrets, no cost. Sources verified 2026-10-19 (stars via api.github.com).
export const SKILLPACK_VERSION = 'skillpacks-1.0';

const HOME = 'https://wealth-agent.wealthagent-app.workers.dev';

export const SKILLPACKS = [
  { key: 'agent-skills', name: 'agent-skills (Addy Osmani)', repo: 'https://github.com/addyosmani/agent-skills', stars: 103000, cost: 'free',
    gives: ['interview', 'spec', 'planning', 'constraints', 'test', 'review', 'ship', 'code-simplify', 'webperf'],
    agents: ['code-reviewer', 'security-auditor', 'test-engineer', 'web-performance-auditor'],
    harness: ['claude', 'codex', 'gemini', 'opencode'], fits: ['playbook', 'catalog', 'funnel'],
    note: '検証・計画・出荷の型。opencode 形式のスキルを同梱。' },
  { key: 'plugin-marketplace', name: 'agents (wshobson)', repo: 'https://github.com/wshobson/agents', stars: 41032, cost: 'free',
    gives: ['plugin-marketplace', 'agent-orchestration', 'agent-teams', 'context-management', 'comprehensive-review', 'incident-response', 'data-validation-suite', 'git-pr-workflows'],
    agents: [], harness: ['claude', 'codex', 'cursor', 'opencode', 'github'], fits: ['playbook', 'discovery', 'catalog'],
    note: '94プラグインの巨大カタログ。役割分担と文脈管理の実装例。' },
  { key: 'knowledge-work-plugins', name: 'knowledge-work-plugins (Anthropic)', repo: 'https://github.com/anthropics/knowledge-work-plugins', stars: 30243, cost: 'free',
    gives: ['sales', 'finance', 'legal', 'marketing', 'customer-support', 'product-management', 'data', 'engineering', 'operations', 'small-business'],
    agents: [], harness: ['claude'], fits: ['funnel', 'perks', 'rea', 'catalog', 'fx'],
    note: '職務別プラグイン。代行商品の工程表として最も実務的。' },
  { key: 'claude-quickstarts', name: 'claude-quickstarts (Anthropic)', repo: 'https://github.com/anthropics/claude-quickstarts', stars: 18667, cost: 'free',
    gives: ['customer-support-agent', 'financial-data-analyst', 'slack-github-summary', 'sentry-triage', 'slack-linear-bots'],
    agents: ['customer-support', 'financial-analyst'], harness: ['claude'], fits: ['funnel', 'playbook', 'catalog', 'fx'],
    note: '動く最小例。真似して壊して学ぶ用。' },
  { key: 'agency-agents', name: 'agency-agents (msitarzewski)', repo: 'https://github.com/msitarzewski/agency-agents', stars: 161245, cost: 'free',
    gives: ['frontend', 'design', 'marketing', 'sales', 'product', 'testing', 'security', 'support', 'finance-pack', 'health-pack', 'game-dev-pack'],
    agents: [], harness: ['claude', 'codex', 'cursor', 'gemini', 'opencode'], fits: ['funnel', 'perks', 'playbook'],
    note: '会社の形に並べた170体。職種の切り方を借りる。' },
];

export const LANES = ['fx', 'funnel', 'playbook', 'perks', 'rea', 'discovery', 'catalog'];
export const ROLES = ['planner', 'coder', 'verifier', 'critic', 'writer', 'researcher'];

export function packsForLane(lane) {
  const l = String(lane || '').toLowerCase();
  return SKILLPACKS.filter((p) => (p.fits || []).indexOf(l) >= 0);
}

export function packsForRole(role) {
  const r = String(role || '').toLowerCase();
  const kw = {
    verifier: ['test', 'review', 'comprehensive-review', 'data-validation-suite', 'security-auditor'],
    planner: ['spec', 'planning', 'constraints', 'c4-architecture'],
    coder: ['code-simplify', 'code-refactoring', 'ship', 'developer-essentials'],
    writer: ['marketing', 'documentation-generation', 'brand-landingpage'],
    critic: ['review', 'comprehensive-review', 'incident-response'],
    researcher: ['data', 'engineering', 'operations'],
  };
  const want = kw[r] || [r];
  return SKILLPACKS.filter((p) => (p.gives || []).some((g) => want.indexOf(g) >= 0));
}

export function skillCatalog() {
  const lanes = {};
  for (const l of LANES) lanes[l] = packsForLane(l).map((p) => p.key);
  const roles = {};
  for (const r of ROLES) roles[r] = packsForRole(r).map((p) => p.key);
  return { provider: 'Wealth Agent', version: SKILLPACK_VERSION, measured_at: '2026-10-19', cost_to_use: 'free', count: SKILLPACKS.length, lanes, roles, packs: SKILLPACKS };
}

// Machine-readable agent card for the crawler read order:
// robots.txt -> /.well-known/x402 -> /openapi.json -> /agents.json -> /llms.txt
export function agentsJson(env = {}) {
  const paid = ['code-review', 'rea-report', 'data-clean', 'brief', 'surface-report', 'url-meta', 'csv-json', 'regex', 'diff'];
  return {
    schema: 'wealth-agent/agents-1.0',
    name: 'Wealth Agent',
    description: 'x402 pay-per-call tools for AI agents: code review, data clean, briefs, regex, diff, URL meta.',
    homepage: HOME + '/',
    version: env.WA_VERSION || '1.0.2',
    llms: HOME + '/llms.txt',
    docs: HOME + '/surface',
    mcp: { url: HOME + '/mcp', transport: 'streamable-http', protocol: '2025-06-18', tools: 21 },
    discovery: {
      x402_manifest: HOME + '/.well-known/x402',
      openapi: HOME + '/openapi.json',
      catalog: HOME + '/api/x402/catalog.json',
      resources: HOME + '/api/x402/discovery/resources',
      free_entry: HOME + '/api/free',
      skillpacks: HOME + '/api/skills/catalog.json',
    },
    payments: {
      protocol: 'x402', version: 2, network: 'eip155:8453', network_name: 'base',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', asset_symbol: 'USDC',
      pay_to: env.X402_PAY_TO || '0x3291398dC7070472CF2ED2e757246d089760Ca91',
      fee_payer: true, facilitator_gas: 'paid_by_facilitator',
    },
    paid_tools: paid.map((k) => ({ key: k, endpoint: HOME + '/api/x402/' + k })),
    free_tools: [
      { key: 'free', endpoint: HOME + '/api/free', note: 'Keyless free tier index. Daily per-IP limits, no account and no API key.' },
      ...['url-meta', 'csv-json', 'regex', 'diff'].map((k) => ({ key: k, endpoint: HOME + '/api/free/' + k, paid: HOME + '/api/x402/' + k })),
      { key: 'skills', endpoint: HOME + '/api/skills/catalog.json' },
      { key: 'mcp', endpoint: HOME + '/mcp', note: 'Remote MCP (streamable-http) with free tools: url-meta, csv-json, regex, diff, rea_inspect, surface_inspect, list_services, agent_status.' },
    ],
    free_note: 'Four deterministic tools are free to try with no key and no account. Paid x402 tools add AI-backed research briefs, code review, data cleaning and surface analysis.',
    auth: { type: 'bearer', note: 'Discovery surfaces are open. Owner/control APIs require Authorization: Bearer.' },
    crawler_policy: { indexing: 'allowed', resale: 'not_permitted', notes: 'This agent performs no login, form submission, or payment.' },
    contact: { repository: 'https://github.com/jukky-source/wealth-agent', registry: 'io.github.jukky-source/wealth-agent' },
  };
}
