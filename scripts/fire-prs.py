import json, base64, urllib.request, urllib.error, time, sys

TOKEN = open('.secrets/github_classic_token').read().strip()
API = 'https://api.github.com'
FOWNER = 'jukky-source'
BR = 'add-wealth-agent'

def req(method, path, body=None, raw=False):
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Authorization', 'token ' + TOKEN)
    r.add_header('User-Agent', 'wealth-agent')
    r.add_header('Accept', 'application/vnd.github.raw' if raw else 'application/vnd.github+json')
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            b = resp.read()
            return resp.status, (b.decode('utf-8', 'replace') if raw else json.loads(b or b'{}'))
    except urllib.error.HTTPError as e:
        b = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(b)
        except Exception:
            return e.code, {'raw': b[:300]}
    except Exception as e:
        return 0, {'error': str(e)}

ENTRY = ('- [wealth-agent](https://github.com/jukky-source/wealth-agent) - Self-hosted '
         'Cloudflare Worker that sells seven utility endpoints (code review, data cleaning, '
         'research briefs, URL metadata, CSV/JSON conversion, regex extraction, diff) behind '
         'x402 HTTP 402 paywalls, with a receipt ledger that records only signature-verified payments.')

TARGETS = [
    dict(upstream='bitrefill/awesome-agentic-payments', start='### x402\n',
         end='## Fiat payment rails', title='Add wealth-agent to x402 rails',
         body="Adds **wealth-agent** to the x402 rails section.\n\n"
              "**What:** A self-hosted Cloudflare Worker exposing seven utility endpoints (code review, "
              "data cleaning, research briefs, URL metadata, CSV/JSON conversion, regex, diff) behind x402 "
              "HTTP 402 paywalls. It runs an autonomous scheduler and keeps a receipt ledger that only "
              "records payments arriving through signature-verified webhooks.\n\n"
              "**Why it fits:** It is an x402 *seller-side* deployment rather than a client demo — pricing "
              "catalog, 402 challenge, verify-and-settle and fulfillment, plus public machine-readable "
              "discovery at `/openapi.json` and `/.well-known/x402.json`.\n\n"
              "- Source: https://github.com/jukky-source/wealth-agent\n"
              "- Live: https://wealth-agent.wealthagent-app.workers.dev\n"
              "- MCP registry entry: `io.github.jukky-source/wealth-agent`"),
    dict(upstream='Merit-Systems/awesome-agentic-commerce', start='### Open Source & SDKs',
         end='### Standards and EIPs', title='Add wealth-agent',
         body="## Add wealth-agent\n\n"
              "**What:** A self-hosted Cloudflare Worker that sells seven utility endpoints (code review, "
              "data cleaning, research briefs, URL metadata, CSV/JSON conversion, regex, diff) behind x402 "
              "HTTP 402 paywalls.\n\n"
              "**Why:** It is a working reference of the x402 seller side — pricing catalog, HTTP 402 "
              "challenge, verify-and-settle, and fulfillment — with a receipt ledger that records only "
              "payments arriving through signature-verified webhooks.\n\n"
              "- Source: https://github.com/jukky-source/wealth-agent\n"
              "- Live: https://wealth-agent.wealthagent-app.workers.dev\n"
              "- Discovery: https://wealth-agent.wealthagent-app.workers.dev/openapi.json"),
    dict(upstream='xpaysh/awesome-x402', start='## 🏭 Production Implementations',
         end='## 🛠️ SDKs & Client Libraries', title='Add wealth-agent',
         body="## Add wealth-agent\n\n"
              "**What:** Self-hosted Cloudflare Worker exposing seven utility endpoints behind x402 "
              "paywalls, driven by an autonomous scheduler and a ledger that records only "
              "signature-verified payments.\n\n"
              "**Why:** A working reference of the x402 seller side (catalog, 402 challenge, "
              "settle-and-fulfill) rather than a client demo, with machine-readable discovery at "
              "`/openapi.json` and `/.well-known/x402.json`.\n\n"
              "**Quality Checklist:**\n"
              "- [x] Resource is actively maintained\n"
              "- [x] Well-documented with clear usage instructions\n"
              "- [x] Directly related to x402 protocol\n"
              "- [x] Link is working and accessible\n"
              "- [x] Follows contribution format\n\n"
              "**Category:** 🏭 Production Implementations"),
]

def insert_entry(text, start_marker, end_marker, entry):
    s = text.index(start_marker)
    e = text.index(end_marker, s + len(start_marker))
    block = text[s:e]
    lines = block.split('\n')
    idxs = [i for i, l in enumerate(lines) if l.startswith('- [')]
    if not idxs:
        raise ValueError('anchor section has no bullet entries')
    li = idxs[-1]
    ctx_before = lines[max(0, li - 3):li + 1]
    lines.insert(li + 1, entry)
    new_block = '\n'.join(lines)
    return text[:s] + new_block + text[e:], ctx_before

results = []
for t in TARGETS:
    owner, repo = t['upstream'].split('/')
    f = f'{FOWNER}/{repo}'
    for _ in range(15):
        st, r = req('GET', f'/repos/{f}')
        if st == 200:
            break
        time.sleep(4)
    else:
        results.append((t['upstream'], 'FORK_NOT_READY', '')); continue
    db = r['default_branch']
    st, ref = req('GET', f'/repos/{f}/git/ref/heads/{db}')
    if st != 200:
        results.append((t['upstream'], f'REF_FAIL {st}', str(ref)[:120])); continue
    sha = ref['object']['sha']
    req('DELETE', f'/repos/{f}/git/refs/heads/{BR}')
    st, c = req('POST', f'/repos/{f}/git/refs', {'ref': f'refs/heads/{BR}', 'sha': sha})
    if st not in (201, 422):
        results.append((t['upstream'], f'BRANCH_FAIL {st}', str(c)[:120])); continue
    st, cur = req('GET', f'/repos/{f}/contents/README.md?ref={BR}')
    if st != 200:
        results.append((t['upstream'], f'CONTENT_FAIL {st}', str(cur)[:120])); continue
    text = base64.b64decode(cur['content'].replace('\n', '')).decode('utf-8')
    try:
        new, ctx = insert_entry(text, t['start'], t['end'], ENTRY)
    except Exception as ex:
        results.append((t['upstream'], f'ANCHOR_FAIL {ex}', '')); continue
    st, put = req('PUT', f'/repos/{f}/contents/README.md', {
        'message': 'Add wealth-agent',
        'content': base64.b64encode(new.encode('utf-8')).decode(),
        'sha': cur['sha'], 'branch': BR})
    if st not in (200, 201):
        results.append((t['upstream'], f'COMMIT_FAIL {st}', str(put)[:150])); continue
    st, pr = req('POST', f'/repos/{owner}/{repo}/pulls',
                 {'title': t['title'], 'head': f'{FOWNER}:{BR}', 'base': db, 'body': t['body']})
    if st == 201:
        results.append((t['upstream'], 'PR_OPENED', pr['html_url']))
        print(f'--- {t["upstream"]} 差し込み直前の3行 ---')
        for l in ctx:
            print('   ', l[:150])
    else:
        results.append((t['upstream'], f'PR_FAIL {st}', str(pr)[:200]))

print('\n===== 結果 =====')
for up, st, extra in results:
    print(f'  {up:42s} {st:14s} {extra}')
