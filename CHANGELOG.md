# Changelog

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
