# Changelog

## v1.0.9 — 2026-10-22

- Chat brain fix: the owner-chat fallback now feeds collected intelligence into the LLM context (latest digest, X watch state, top scout findings) and answers from real data instead of claiming no capability; honest can/cannot explanation for unavailable upstreams.
## v1.0.8 — 2026-10-21

- Venue ledger measured: Circle Discovery API (`api.circle.com/v2/x402/discovery/resources`, keyless) probed for our host; PayAPI Market re-classified manual_form (read-only public API, free listing form).
## v1.0.7 — 2026-10-21

- Venue ledger +8 channels mined from awesome-agentic-commerce with live probes: PayAPI Market (free listing, API-based), Onyx Bazaar (CDP-derived, not indexed yet), x402station, AgentZone (ERC-8004), Circle Discovery API, gold-402 (PR), Pyrimid, stablecoin.com 402.
- Scout sources: Cloudflare blog RSS added (x402 infra news line).
## v1.0.6 — 2026-10-21

- `proof` now ships inside the paid response body; `output_hash` signs the deliverable (offline-verification contract: input_hash=HMAC(request body), output_hash=HMAC(deliverable)).
- llms.txt advertises signed responses and `POST /api/verify`.
## v1.0.5 — 2026-10-21

- Signed responses: every paid response now carries an HMAC-SHA256 `proof` block (resource, timestamp, input/output hashes, signature) with a public `POST /api/verify` endpoint — integrators can verify offline. Motivated by seller intel from r/AI_Agents (verification is what won integrators, not price).
- Intel sources: r/AI_Agents added to the agent's own Reddit scanning.
## v1.0.4 — 2026-10-21

- Async settlement callbacks now record `x402:<venue>:<resource>` attribution when the facilitator echoes venue/resource (sync path already tagged).
- Daily IndexNow pings cover discovery faces: /agents.json, /x402-index, /grow, /api/skills/catalog.json.
## v1.0.3 — 2026-10-21

- Face split: `/api/x402/catalog.json` tags buyer-entry resource URLs with `?venue=catalog` for attribution, while `/.well-known/x402.json` stays canonical for indexers (x402scan, CDP crawlers).
## v1.0.2 — 2026-10-21

- 402 quote body carries a machine-readable `vendor` block (docs, catalog, free samples, verification surface, refund policy, pay-to).
- Attribution tags: `llms.txt` buy lines tagged `?venue=llms`; catalog.json items tagged `?venue=catalog`; the `/.well-known/x402.json` discovery feed stays canonical for indexers.
- New tool: `seo-audit` (deterministic checks + optional AI suggestions).
- Ops: daily IndexNow pings, discwatch audit (26/26 accepted, 9 indexed externally), hunt auto-submission loop.

## v1.0.1 — 2026-10-20

- MCP endpoint (`POST /mcp`, JSON-RPC, protocolVersion 2025-06-18) verified live.
- Bazaar discovery metadata on every 402; CDP Bazaar listing confirmed (2 tools in top 12 for "wealth").

## v1.0.0 — 2026-10-15

- 26 pay-per-call tools priced in USDC via x402 v2 (Base, Arbitrum, Polygon, Solana).
- Free tier: 4 deterministic products, IP x UTC-day capped, no sign-up.
- Facilitator-verified settlement with refund-or-redeliver approval queue.
