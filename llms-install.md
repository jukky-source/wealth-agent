# Installing wealth-agent (for AI agents)

wealth-agent is a **remote MCP server** — there is nothing to build and no package to install.
Point an MCP client at the Streamable HTTP endpoint below, or call the REST endpoints directly.

## 1. MCP client (recommended)

Transport: `streamable-http`
URL: `https://wealth-agent.wealthagent-app.workers.dev/api/mcp`
Auth: none for discovery and for the free tier. Paid tools settle an x402 payment header.

Example Cline / Claude / Cursor MCP config:

```json
{
  "mcpServers": {
    "wealth-agent": {
      "type": "streamableHttp",
      "url": "https://wealth-agent.wealthagent-app.workers.dev/api/mcp"
    }
  }
}
```

## 2. REST (no MCP client needed)

- Free tier (no payment, rate-limited per IP per day):
  - `GET  https://wealth-agent.wealthagent-app.workers.dev/api/free` — list of free capabilities
  - `GET  https://wealth-agent.wealthagent-app.workers.dev/api/free/url-meta?url=https://example.com`
  - `POST https://wealth-agent.wealthagent-app.workers.dev/api/free/regex` — body `{"pattern":"...","text":"..."}`
  - `POST https://wealth-agent.wealthagent-app.workers.dev/api/free/csv-json` — body `{"data":"a,b\n1,2"}`
  - `POST https://wealth-agent.wealthagent-app.workers.dev/api/free/diff` — body `{"a":"...","b":"..."}`
- Paid x402 tools: `POST https://wealth-agent.wealthagent-app.workers.dev/api/x402/<tool>`
  (tools: `brief` 0.25, `data-clean` 0.50, `code-review` 0.75 USDC)
  Send no body first to receive the `402` + `PAYMENT-REQUIRED` challenge, then retry with `PAYMENT-SIGNATURE`.

## 3. Discovery documents

- `https://wealth-agent.wealthagent-app.workers.dev/llms.txt`
- `https://wealth-agent.wealthagent-app.workers.dev/openapi.json`
- `https://wealth-agent.wealthagent-app.workers.dev/.well-known/x402`
- `https://wealth-agent.wealthagent-app.workers.dev/.well-known/agent-card.json`

## 4. Verify it works

```bash
curl -s https://wealth-agent.wealthagent-app.workers.dev/api/free | head -c 400
```
