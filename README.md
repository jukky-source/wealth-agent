# Wealth Agent

Self-running, pay-per-call tool shop for AI agents. 26 tools priced in USDC via [x402](https://www.x402.org), no accounts, no API keys: an agent POSTs, gets a machine-readable 402 price quote, pays through any x402 facilitator, retries with the payment signature, and receives the deliverable.

**Live:** https://wealth-agent.wealthagent-app.workers.dev

## How a purchase works

```
POST https://wealth-agent.wealthagent-app.workers.dev/api/x402/brief          # no payment
  -> 402  PAYMENT-REQUIRED header + JSON body (accepts[], bazaar extension, vendor block)
  -> pay with any x402 client (exact scheme, USDC)
  -> retry the same POST with the PAYMENT-SIGNATURE header
  -> 200  deliverable JSON
```

Settlement runs through an external x402 facilitator; payments verified on-chain before delivery. Tests from the operator's own wallets are tagged self-test and excluded from revenue.

## Networks and prices

- USDC on **Base (eip155:8453)**, **Arbitrum (42161)**, **Polygon (137)**, and **Solana mainnet** — the exact `accepts[]` set ships in every 402 quote.
- Micro-priced per call: roughly $0.0005–$0.01 for most tools; the full-surface `diligence-pack` bundle is $1.00 flat.

## Catalog highlights

| Resource | What it returns | Price (USDC) |
|---|---|---|
| `crypto-price` | Spot prices for up to 10 symbols, venue-attributed | $0.001 |
| `fx-rates` | Reference FX rates (ECB-based feed, fallback named) | $0.001 |
| `brief` | One-page sourced answer with citations and gaps | $0.002 |
| `code-review` | Static review of a code blob | $0.002 |
| `url-meta` | Machine-readable page metadata for one URL | $0.002 |
| `surface-report` | Capability report of a public API/site | $0.01 |
| `diligence-pack` | Full-surface bundle on any public URL | $1.00 |

Full machine-readable catalog: [`/api/x402/catalog.json`](https://wealth-agent.wealthagent-app.workers.dev/api/x402/catalog.json) · Agent-facing docs: [`/llms.txt`](https://wealth-agent.wealthagent-app.workers.dev/llms.txt) · OpenAPI: [`/openapi.json`](https://wealth-agent.wealthagent-app.workers.dev/openapi.json)

## Free tier

Four deterministic products (`crypto-price`, `fx-rates`, `dns-lookup`, `time-convert`) are sampleable without payment at `/api/free/<resource>` — 25 calls per IP per UTC day (`url-meta` gets 5). No sign-up.

## Discovery surfaces

- `/.well-known/x402.json` — x402 discovery feed (canonical URLs)
- `/llms.txt` — LLM-facing catalog with per-venue attribution tags
- `/agents.json`, `/openapi.json`, `server.json`
- `POST /mcp` — MCP (JSON-RPC) endpoint, protocolVersion 2025-06-18
- `/api/discwatch/public` — daily discovery audit (which products are accepted/indexed on external x402 indices)
- Listed on the Coinbase CDP x402 Bazaar

## Trust

- Payments only after on-chain verification; failed/undelivered jobs go to a refund-or-redeliver approval queue (`POST /api/contact`).
- Self-test wallets are excluded from reported revenue.
- The KPI funnel and receipts are internal; the public audit surfaces are `discwatch` and the on-chain payment records themselves.

## Operations

Cloudflare Workers + D1 + Workers AI (free tier, neuron-capped) + a Containers-backed runner. Cronticks every 5 minutes drive scouting, discovery audits, IndexNow pings, and the free-tier reaper. Deploy:

```
CLOUDFLARE_API_TOKEN=... npx wrangler deploy -c wrangler.containers.toml
```

Secrets (`OWNER_TOKEN`, `RUNNER_TOKEN`, payment config) are injected via `wrangler secret put` and never committed.

## License

No license granted — all rights reserved.
