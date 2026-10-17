import json, base64, urllib.request, urllib.error, time

TOKEN = open('.secrets/github_classic_token').read().strip()
API = 'https://api.github.com'; FOWNER='jukky-source'; BR='add-wealth-agent'
REPO='awesome-remote-mcp-servers'

def req(method, path, body=None):
    r = urllib.request.Request(API+path, data=json.dumps(body).encode() if body is not None else None, method=method)
    r.add_header('Authorization','token '+TOKEN); r.add_header('User-Agent','wealth-agent')
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        b=e.read().decode('utf-8','replace')
        try: return e.code, json.loads(b)
        except Exception: return e.code, {'raw':b[:200]}

for _ in range(15):
    st,r = req('GET', f'/repos/{FOWNER}/{REPO}')
    if st==200: break
    time.sleep(4)
db=r['default_branch']
st,ref=req('GET', f'/repos/{FOWNER}/{REPO}/git/ref/heads/{db}')
sha=ref['object']['sha']
req('DELETE', f'/repos/{FOWNER}/{REPO}/git/refs/heads/{BR}')
req('POST', f'/repos/{FOWNER}/{REPO}/git/refs', {'ref':f'refs/heads/{BR}','sha':sha})
st,cur=req('GET', f'/repos/{FOWNER}/{REPO}/contents/README.md?ref={BR}')
text=base64.b64decode(cur['content'].replace('\n','')).decode('utf-8')

START='### 🛠️ <a name="developer-tools"></a>Developer Tools'
END='### 🛒 <a name="e-commerce"></a>E-Commerce'
s=text.index(START); e=text.index(END, s)
block=text[s:e]; lines=block.split('\n')
entry='- [wealth-agent](https://wealth-agent.wealthagent-app.workers.dev) `https://wealth-agent.wealthagent-app.workers.dev/api/mcp`'
key='wealth-agent'
idxs=[i for i,l in enumerate(lines) if l.startswith('- [')]
def nm(l):
    return l.split('](',1)[0].replace('- [','').strip().lower()
target=None
for i in idxs:
    if nm(lines[i]) > key:
        target=i; break
if target is None: target=idxs[-1]+1
lines.insert(target, entry)
new=text[:s]+'\n'.join(lines)+text[e:]
print('  差し込み直後の3行:')
for l in lines[target-1:target+2]: print('   ', l[:130])
st,put=req('PUT', f'/repos/{FOWNER}/{REPO}/contents/README.md',
    {'message':'Add wealth-agent','content':base64.b64encode(new.encode()).decode(),'sha':cur['sha'],'branch':BR})
print('  commit http=', st)
body=("## Add wealth-agent\n\n"
      "**What:** A remote (hosted) MCP server exposing pay-per-call utilities for agents: research briefs, "
      "CSV/JSON cleanup, code review, URL metadata, regex extraction and diff. Calls settle with x402 "
      "(USDC on Base and Solana).\n\n"
      "- Endpoint: `https://wealth-agent.wealthagent-app.workers.dev/api/mcp`\n"
      "- Source: https://github.com/jukky-source/wealth-agent\n"
      "- Registry: `io.github.jukky-source/wealth-agent` (official MCP registry, active)\n\n"
      "**Transport:** streamable HTTP, no OAuth (per-call x402 payment instead of an API key).\n\n"
      "**Category:** Developer Tools\n\n"
      "Format check: `- [Name](site) \\`endpoint\\``, alphabetical placement inside Developer Tools.")
st,pr=req('POST', f'/repos/punkpeye/{REPO}/pulls',
    {'title':'Add wealth-agent 🤖🤖🤖','head':f'{FOWNER}:{BR}','base':db,'body':body})
print('  PR http=', st, '->', pr.get('html_url') or pr.get('message'))
