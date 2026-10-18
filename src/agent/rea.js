// REA 完全実装（サーバー側）— 参考: morluto/rea（ローカルのネイティブバイナリ・JS/Electron・.NET アセンブリ・
// Webサイトをエージェントに解析させ、根拠と限界つきで返す MCP ツール）。
//
// ここは「Worker から届く範囲」を全部やる:
//   web    … HTML の表面（フォーム・フィード・痕跡）
//   js     … 読み込んでいる JS バンドルの中身（入口・フラグ・外部ホスト・sourcemap・秘密の形）
//   api    … OpenAPI / GraphQL / .well-known / MCP の公開定義
//   local  … ローカルのファイル（ELF/PE/.NET/Mach-O/asar/apk）→ ここでは実行できないので手順を返す
//
// 実装しないもの（要件ではなく禁止）: 認証回避・課金回避・DRM/コピープロテクト解除・再販。
// 401/403 は auth_required として記録して止める。
//
// 設計上の約束（参考ドキュメントの権限モデルを4段階でコードに落とした）:
//   allow  = そのまま実行する
//   approve= 人が指定・承認した対象にだけ実行する
//   handoff= 実行せず、人（またはローカルの CLI）へ渡す
//   never  = 実装しない
// すべての「できること」には根拠を付ける。根拠が無いものは unknown に落とす。

import { findEndpoints, findForms, findFeeds, parseHead, detectMcp, normTarget } from './surface.js';

export const REA_VERSION = '2.0';
export const REA_PRICE_USDC = 0.5;

const UA = `wealth-agent-rea/${REA_VERSION} (+https://wealth-agent.wealthagent-app.workers.dev)`;

export const ACTION_RULES = [
  { action: 'read_public_response', level: 'allow', note: '公開されている応答を1回だけ読む' },
  { action: 'run_static_analyzer', level: 'allow', note: 'readelf / objdump / strings など読み取り専用の解析' },
  { action: 'read_local_file', level: 'approve', note: '人が指定したパスだけ。勝手に探し回らない' },
  { action: 'install_tooling', level: 'approve', note: '解析に必要な道具の導入は人の承認が要る' },
  { action: 'publish_findings', level: 'approve', note: '外に出す前に人が確認する' },
  { action: 'analyze_local_artifact', level: 'handoff', note: 'Worker では読めない。手順を返して手元の rea-cli に渡す' },
  { action: 'run_target_binary', level: 'never', note: '対象を実行しない。静的に読むだけ' },
  { action: 'auth_bypass', level: 'never', note: '認証を突破しない。401/403 で止める' },
  { action: 'paywall_bypass', level: 'never', note: '課金を回避しない' },
  { action: 'drm_circumvention', level: 'never', note: 'コピープロテクトを外さない' },
  { action: 'network_write', level: 'never', note: '対象へ書き込まない（GET と公開 introspection のみ）' },
  { action: 'scrape_and_resell', level: 'never', note: '取得物を再配布・再販しない' },
];

export const GUARDRAILS = [
  '読むのは公開されている応答だけ（認証情報は使わない）',
  '401/403 は「要認証」と記録して止める。突破はしない',
  '対象は実行しない（静的解析のみ）',
  '秘密らしき文字列は「形」だけ記録し、値は出さない',
  '再配布・再販はしない（出典URLを必ず残す）',
];

export const LIMITS = [
  '対象は実行しない（静的に読むだけ。動作の確認は別の作業）',
  'SPA の動的レンダリング後の DOM は取れない（初期HTML・インラインJS・配信JSまで）',
  '認証後の内部 API は原理的に見えない',
  'エンドポイントは文字列としての出現であり、動作確認はしていない',
  'ローカルのファイル（バイナリ・asar・アセンブリ）は Worker からは読めない（手順を返す）',
  'ネイティブコードの「何をするか」は呼び出し関係と文字列からの推定で、動作の証明ではない',
  '難読化・暗号化された区間は解析できない',
];

export const KINDS = ['web', 'api', 'documented-api', 'mcp', 'js', 'local', 'protected', 'unknown'];

// ---------------------------------------------------------------------------
// 対象の判定と、ローカル解析の手順（handoff）
// ---------------------------------------------------------------------------

export function classifyTarget(t = '') {
  const s = String(t || '').trim();
  if (!s) return { mode: 'unknown', kind: 'unknown', target: s };
  if (/^https?:\/\//i.test(s)) return { mode: 'remote', kind: 'web', target: s };
  const ext = (s.match(/\.([A-Za-z0-9_]+)$/) || [])[1]?.toLowerCase() || '';
  const byExt = {
    exe: 'pe', dll: 'pe', sys: 'pe', msi: 'pe', node: 'pe', so: 'elf', elf: 'elf', bin: 'elf',
    dylib: 'macho', app: 'macho', asar: 'asar', apk: 'apk', aab: 'apk', ipa: 'ipa', xpi: 'xpi', crx: 'crx',
    jar: 'jar', zip: 'zip', '7z': 'archive', tar: 'archive', gz: 'archive', xz: 'archive',
    js: 'js', mjs: 'js', cjs: 'js', ts: 'js', map: 'js', html: 'html', htm: 'html', wasm: 'wasm', dmg: 'dmg', pkg: 'pkg',
  };
  return { mode: 'local', kind: byExt[ext] || 'unknown', ext, target: s };
}

// ローカル解析の手順。Worker はこれを「実行せず」返す（handoff）。実行するのは tools/rea-cli.mjs。
export function reaPlan(kind = 'unknown') {
  const cli = 'node tools/rea-cli.mjs';
  const base = [
    { step: '種別の確定', tool: 'file / 先頭バイト', cmd: `file <path> && head -c 16 <path> | xxd`, level: 'allow' },
  ];
  const byKind = {
    pe: [
      { step: 'ヘッダとセクション', tool: 'objdump', cmd: `objdump -p <path> | head -80`, level: 'allow' },
      { step: '取り込む DLL と関数（できることの推定）', tool: 'objdump', cmd: `objdump -p <path> | sed -n '/DLL Name/,$p' | head -60`, level: 'allow' },
      { step: '.NET かどうか / 型とメソッド名', tool: 'rea-cli', cmd: `${cli} <path> --json`, level: 'allow' },
      { step: '特徴的な文字列', tool: 'strings', cmd: `strings -n 8 <path> | sort -u | head -200`, level: 'allow' },
    ],
    elf: [
      { step: 'ヘッダ（種別・PIE・アーキ）', tool: 'readelf', cmd: `readelf -h <path>`, level: 'allow' },
      { step: 'リンクしているライブラリ（GUI/通信/暗号の推定）', tool: 'readelf', cmd: `readelf -d <path} | grep NEEDED`, level: 'allow' },
      { step: '未定義シンボル＝呼ぶ機能', tool: 'objdump', cmd: `objdump -T <path} | head -80`, level: 'allow' },
      { step: '固まった文字列（URL・パス・設定キー）', tool: 'strings', cmd: `strings -n 8 <path> | sort -u | head -200`, level: 'allow' },
    ],
    macho: [
      { step: 'アーキテクチャと種別', tool: 'file', cmd: `file <path>`, level: 'allow' },
      { step: '依存フレームワーク', tool: 'rea-cli', cmd: `${cli} <path> --json`, level: 'allow' },
      { step: '文字列', tool: 'strings', cmd: `strings -n 8 <path> | sort -u | head -200`, level: 'allow' },
    ],
    asar: [
      { step: '中身の一覧（Electron のアプリ本体）', tool: 'rea-cli', cmd: `${cli} <path> --json`, level: 'allow' },
      { step: 'main の入口と依存', tool: 'rea-cli', cmd: `${cli} <path> --list-main`, level: 'allow' },
    ],
    apk: [
      { step: '中の一覧', tool: 'unzip', cmd: `unzip -l <path> | head -60`, level: 'allow' },
      { step: '権限とコンポーネント（AndroidManifest）', tool: 'rea-cli', cmd: `${cli} <path> --json`, level: 'allow' },
      { step: 'クラス名の一覧', tool: 'unzip', cmd: `unzip -p <path> classes.dex | strings -n 10 | sort -u | head -200`, level: 'allow' },
    ],
    js: [
      { step: '入口・フラグ・外部ホスト・秘密の形', tool: 'rea-cli', cmd: `${cli} <path> --json`, level: 'allow' },
    ],
    jar: [
      { step: '中の一覧', tool: 'unzip', cmd: `unzip -l <path> | head -80`, level: 'allow' },
      { step: 'クラス名と文字列', tool: 'rea-cli', cmd: `${cli} <path> --json`, level: 'allow' },
    ],
  };
  const steps = byKind[kind] || [
    { step: '種別が不明なので、まず中身を見る', tool: 'file / 7z / strings', cmd: `file <path> && 7z l <path> | head -40 && strings -n 8 <path> | head -100`, level: 'allow' },
  ];
  return [...base, ...steps].map((s) => ({ ...s, handoff: 'local' }));
}

// ---------------------------------------------------------------------------
// 読み取り（1回ずつ・GET と公開 introspection のみ）
// ---------------------------------------------------------------------------

async function getUrl(url, { fetchImpl = fetch, timeoutMs = 12000, accept = 'text/html,application/json;q=0.9,*/*;q=0.8' } = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { redirect: 'follow', headers: { accept, 'user-agent': UA }, signal: c.signal });
    const ct = r.headers.get('content-type') || '';
    const textual = /json|text|html|xml|javascript|yaml/i.test(ct);
    const body = textual ? (await r.text()).slice(0, 400000) : '';
    return { status: r.status, ct, body, server: r.headers.get('server') || '', finalUrl: r.url || url, len: Number(r.headers.get('content-length') || 0), x402: r.headers.get('payment-required') || '' };
  } catch (e) {
    return { status: 0, ct: '', body: '', server: '', finalUrl: url, len: 0, error: String((e && e.message) || e).slice(0, 140) };
  } finally { clearTimeout(t); }
}

// JS バンドルの中身を見る（読むだけ・値は出さない）
export function scanJsBundle(code = '', origin = '') {
  const out = { bytes: code.length, endpoints: [], hosts: [], flags: [], envNames: [], sourcemaps: [], libs: [], secretShapes: [] };
  if (!code) return out;
  out.endpoints = findEndpoints(code, origin).slice(0, 40);
  for (const m of code.matchAll(/https?:\/\/[A-Za-z0-9._-]{4,60}/g)) {
    const h = m[0].replace(/^https?:\/\//, '').split('/')[0];
    if (origin && m[0].startsWith(origin)) continue;
    if (!out.hosts.includes(h)) out.hosts.push(h);
  }
  out.hosts = out.hosts.slice(0, 30);
  const FLAG_KW = /(flag|feature|experiment|beta|enabl|toggle|rollout|gate|canary|variant)/i;
  for (const m of code.matchAll(/["']?([A-Za-z_$][A-Za-z0-9_$.]{2,44})["']?\s*[:=]\s*(true|false|1|0)\b/g)) {
    const k = m[1];
    if (!FLAG_KW.test(k)) continue;
    if (!out.flags.some((f) => f.name === k)) out.flags.push({ name: k, value: m[2] === 'true' || m[2] === '1' });
  }
  out.flags = out.flags.slice(0, 25);
  for (const m of code.matchAll(/(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{2,40})/g)) {
    if (!out.envNames.includes(m[1])) out.envNames.push(m[1]);
  }
  out.envNames = out.envNames.slice(0, 25);
  for (const m of code.matchAll(/sourceMappingURL=([^\s*'"`]+)/g)) out.sourcemaps.push(m[1].slice(0, 200));
  const libs = [[/react(-dom)?[@.\/](\d+\.\d+)/, 'React'], [/vue[@.\/](\d+\.\d+)/, 'Vue'], [/angular[.\/](\d+\.\d+)/, 'Angular'], [/jquery[.-]?(\d+\.\d+)/i, 'jQuery'], [/stripe/i, 'Stripe'], [/sentry/i, 'Sentry'], [/posthog/i, 'PostHog'], [/segment/i, 'Segment'], [/firebase/i, 'Firebase'], [/supabase/i, 'Supabase'], [/socket\.io/i, 'Socket.IO'], [/graphql/i, 'GraphQL']];
  for (const [re, name] of libs) { if (re.test(code)) out.libs.push(name); }
  // 秘密の「形」だけ。値は絶対に返さない。
  const shapes = [[/sk-[A-Za-z0-9]{20,}/, 'sk- で始まる鍵らしき文字列'], [/ghp_[A-Za-z0-9]{20,}/, 'GitHub のトークンらしき文字列'], [/AIza[0-9A-Za-z_-]{20,}/, 'Google API キーらしき文字列'], [/eyJ[A-Za-z0-9_-]{10,}\./, 'JWT らしき文字列'], [/AKIA[0-9A-Z]{16}/, 'AWS の鍵IDらしき文字列'], [/(?:api[_-]?key|apikey|secret|token)["']\s*[:=]\s*["'][^"']{12,}["']/i, 'キー名に秘密語を含む代入']];
  for (const [re, label] of shapes) { const m = code.match(re); if (m) out.secretShapes.push({ label, sample: m[0].slice(0, 4) + '…（値は出さない）' }); }
  return out;
}

function extractScripts(html = '', origin = '') {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']{1,400})["'][^>]*>/gi)) {
    try { out.push(new URL(m[1], origin + '/').href); } catch {}
  }
  return [...new Set(out)].slice(0, 6);
}

async function inspectJs(origin, html, { fetchImpl } = {}) {
  const js = { bundles: [], hosts: [], flags: [], envNames: [], sourcemaps: [], libs: [], secretShapes: [], endpoints: [], inlineBytes: 0, totalBytes: 0 };
  const inline = [...String(html).matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]{0,200000}?)<\/script>/gi)].map((m) => m[1]).join('\n');
  if (inline.trim()) {
    js.inlineBytes = inline.length;
    const s = scanJsBundle(inline, origin);
    js.endpoints.push(...s.endpoints); js.flags.push(...s.flags); js.hosts.push(...s.hosts);
    js.envNames.push(...s.envNames); js.libs.push(...s.libs); js.secretShapes.push(...s.secretShapes);
  }
  for (const u of extractScripts(html, origin)) {
    const r = await getUrl(u, { fetchImpl, accept: 'application/javascript,text/javascript,*/*' });
    if (r.status !== 200 || !r.body) { js.bundles.push({ url: u, status: r.status || 'err', bytes: 0 }); continue; }
    const s = scanJsBundle(r.body, origin);
    js.totalBytes += r.body.length;
    js.bundles.push({ url: u, status: 200, bytes: r.body.length, endpoints: s.endpoints.length, flags: s.flags.length });
    js.endpoints.push(...s.endpoints); js.flags.push(...s.flags); js.hosts.push(...s.hosts);
    js.envNames.push(...s.envNames); js.sourcemaps.push(...s.sourcemaps); js.libs.push(...s.libs); js.secretShapes.push(...s.secretShapes);
  }
  const dedupe = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  js.endpoints = dedupe(js.endpoints, (e) => String(e.path).toLowerCase()).slice(0, 40);
  js.flags = dedupe(js.flags, (f) => f.name).slice(0, 25);
  js.hosts = [...new Set(js.hosts)].slice(0, 30);
  js.envNames = [...new Set(js.envNames)].slice(0, 25);
  js.sourcemaps = [...new Set(js.sourcemaps)].slice(0, 5);
  js.libs = [...new Set(js.libs)].slice(0, 12);
  js.secretShapes = dedupe(js.secretShapes, (s) => s.label).slice(0, 6);
  return js;
}

async function inspectApi(origin, { fetchImpl } = {}) {
  const api = { openapi: null, swagger: null, graphql: null, wellKnown: [], mcpManifest: null };
  const cands = ['/openapi.json', '/swagger.json', '/v1/openapi.json', '/api/openapi.json', '/.well-known/openapi.json'];
  for (const p of cands) {
    const r = await getUrl(origin + p, { fetchImpl, timeoutMs: 7000, accept: 'application/json' });
    if (r.status === 200 && r.body.trim().startsWith('{')) {
      let paths = 0, title = '';
      try { const j = JSON.parse(r.body); paths = Object.keys(j.paths || {}).length; title = j.info?.title || ''; } catch {}
      api.openapi = { url: origin + p, paths, title, bytes: r.body.length };
      break;
    }
  }
  const g = await getUrl(origin + '/graphql', { fetchImpl, timeoutMs: 7000, accept: 'application/json' });
  if (g.status === 200 && g.body.trim().startsWith('{')) {
    try {
      const j = JSON.parse(g.body);
      api.graphql = { url: origin + '/graphql', hint: j.errors ? 'introspection は無効' : '応答あり' };
    } catch { api.graphql = { url: origin + '/graphql', hint: 'JSON でない応答' }; }
  } else if (g.status && g.status !== 404 && g.status !== 0) {
    api.graphql = { url: origin + '/graphql', hint: `status ${g.status}（introspection は試していない）` };
  }
  for (const p of ['/.well-known/mcp.json', '/.well-known/ai-plugin.json', '/.well-known/security.txt']) {
    const r = await getUrl(origin + p, { fetchImpl, timeoutMs: 6000 });
    if (r.status === 200 && r.body.trim()) {
      api.wellKnown.push({ url: origin + p, bytes: r.body.length });
      if (p.includes('mcp')) { try { api.mcpManifest = JSON.parse(r.body); } catch {} }
    }
  }
  return api;
}

// できることの地図（必ず根拠と一緒に返す）
export function capabilityMap(s = {}) {
  const caps = [];
  const add = (name, evidence, confidence = 'med') => { if (evidence) caps.push({ name, evidence: String(evidence).slice(0, 200), confidence }); };
  if (s.mcp?.ok) add('MCP サーバーを公開している', `POST /mcp initialize → 200（ツール ${s.mcp.tools.length}件）`, 'high');
  if (s.api?.openapi) add('OpenAPI で API を公開している', `${s.api.openapi.url}（パス ${s.api.openapi.paths}件）`, 'high');
  if (s.api?.graphql) add('GraphQL の口がある', `${s.api.graphql.url} → ${s.api.graphql.hint}`, 'med');
  if (s.x402) add('x402（機械決済）に対応している', 'PAYMENT-REQUIRED ヘッダあり', 'high');
  if (s.js?.flags?.length) add('機能フラグで出し分けている', `フラグ ${s.js.flags.length}件（例: ${s.js.flags.slice(0, 3).map((f) => f.name).join(', ')}）`, 'med');
  if (s.js?.envNames?.length) add('ビルド時に環境変数を埋め込んでいる', `変数名 ${s.js.envNames.slice(0, 5).join(', ')}`, 'med');
  if (s.js?.sourcemaps?.length) add('sourcemap を配信している', s.js.sourcemaps[0], 'high');
  if (s.js?.secretShapes?.length) add('秘密らしき文字列がクライアント側にある', s.js.secretShapes.map((x) => x.label).join(' / '), 'high');
  if (s.forms?.length) add('フォームで入力を受け付けている', `フォーム ${s.forms.length}件`, 'high');
  if (s.feeds?.length) add('フィードを配信している', `フィード ${s.feeds.length}件`, 'high');
  if (s.robots) add('クロール方針を明示している', s.robots.url, 'high');
  if (s.signals?.includes('Shopify')) add('Shopify の店舗', 'HTML に cdn.shopify.com / Shopify.theme', 'high');
  if (s.signals?.includes('WordPress')) add('WordPress のサイト', 'HTML に wp-content / wp-json', 'high');
  if (s.signals?.includes('Stripe')) add('Stripe で決済している', 'HTML/JS に js.stripe.com', 'med');
  if (s.endpoints?.length) add('内部 API の入口候補がある', `文字列として ${s.endpoints.length}件のパス`, 'low');
  return caps;
}

export function reaScore(s = {}) {
  let n = 0;
  if (s.ok) n += 1;
  n += Math.min(3, (s.capabilities || []).length);
  if (s.api?.openapi) n += 2;
  if (s.mcp?.ok) n += 2;
  if (s.js?.totalBytes > 0) n += 1;
  if (s.endpoints?.length) n += 1;
  if ((s.evidence || []).length >= 4) n += 1;
  return Math.min(10, n);
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export async function inspectRea(target, { fetchImpl = fetch, now = null, deep = true } = {}) {
  const at = now || new Date().toISOString();
  const cls = classifyTarget(target);
  const steps = [];
  const mark = (state, note) => steps.push({ state, at: new Date().toISOString(), note: note || '' });

  mark('queued', `対象の判定: ${cls.mode}/${cls.kind}`);

  // パスでも拡張子でもない裸の文字列は、ホスト名のつもりかもしれない（例: "example.com"）→ URL として判定する
  if (cls.mode === 'local' && !cls.ext && !/[\/\\]/.test(cls.target)) {
    const asUrl = normTarget(cls.target);
    if (!asUrl) {
      mark('failed', 'URL としてもパスとしても解釈できない');
      return { ok: false, at, version: REA_VERSION, mode: 'remote', kind: 'unknown', target: cls.target, state: 'failed', steps, reason: 'URL が不正です', action_rules: ACTION_RULES, guardrails: GUARDRAILS, limits: LIMITS };
    }
    cls.mode = 'remote'; cls.kind = 'web';
  }
  if (cls.mode === 'local') {
    // Worker はローカルのファイルを読めない。実行せず、人（ローカルCLI）へ渡す（handoff）。
    mark('handoff', 'ローカル解析は手順として返す（実行しない）');
    const plan = reaPlan(cls.kind);
    const rep = {
      ok: true, at, version: REA_VERSION, mode: 'local', kind: cls.kind, target: cls.target,
      state: 'handoff', steps, plan,
      capabilities: plan.map((p) => ({ name: `手順: ${p.step}`, evidence: `${p.tool}: ${p.cmd}`, confidence: 'high' })),
      evidence: [`拡張子から ${cls.kind} と判定した（中身は見ていない）`],
      unknown: ['ファイルの中身は読んでいない（Worker からは届かない）'],
      action_rules: ACTION_RULES, guardrails: GUARDRAILS, limits: LIMITS,
    };
    rep.score = reaScore(rep);
    return rep;
  }

  const u = normTarget(target);
  if (!u) { mark('failed', 'URL が不正'); return { ok: false, at, version: REA_VERSION, mode: 'remote', kind: 'unknown', target: String(target || ''), state: 'failed', steps, reason: 'URL が不正です', action_rules: ACTION_RULES, guardrails: GUARDRAILS, limits: LIMITS }; }
  const origin = u.origin;

  mark('fetching', `GET ${origin}/`);
  const root = await getUrl(origin + '/', { fetchImpl });
  const s = {
    ok: true, at, version: REA_VERSION, mode: 'remote', kind: 'web', target: origin, requested: u.href,
    state: 'parsing', steps, status: root.status, server: root.server, contentType: root.ct, finalUrl: root.finalUrl,
    auth: 'public', x402: !!root.x402, signals: [], title: '', endpoints: [], forms: [], feeds: [], mcp: null,
    js: null, api: null, capabilities: [], evidence: [], unknown: [], action_rules: ACTION_RULES, guardrails: GUARDRAILS, limits: LIMITS,
  };
  if (root.status === 401 || root.status === 403) {
    s.auth = 'auth_required'; s.kind = 'protected'; s.state = 'blocked';
    s.evidence.push(`GET ${origin}/ → ${root.status}（要認証。ここで止める）`);
    s.unknown.push('認証後の表面は取得していない（突破しない）');
    mark('blocked', `status ${root.status} → auth_required`);
    s.capabilities = capabilityMap(s); s.score = reaScore(s); return s;
  }
  if (root.status === 0) {
    s.ok = false; s.reason = root.error || '接続できません'; s.state = 'failed'; mark('failed', s.reason);
    s.capabilities = capabilityMap(s); s.score = reaScore(s); return s;
  }
  s.evidence.push(`GET ${origin}/ → ${root.status} ${root.ct || ''}`.trim());
  mark('parsing', `HTML ${root.body.length} bytes を読む`);

  if ((root.ct || '').includes('json')) {
    s.kind = 'api';
    try { const j = JSON.parse(root.body); s.jsonKeys = Object.keys(j).slice(0, 20); s.evidence.push(`JSON のキー: ${s.jsonKeys.join(', ')}`); } catch {}
    s.endpoints = findEndpoints(root.body, origin);
  } else {
    const h = parseHead(root.body);
    s.title = h.title; s.description = h.description; s.generator = h.generator; s.signals = h.signals;
    s.endpoints = findEndpoints(root.body, origin);
    s.forms = findForms(root.body);
    s.feeds = findFeeds(root.body);
    if (s.signals.includes('OpenAPI/Swagger の痕跡')) s.kind = 'documented-api';
    else if (s.signals.includes('Shopify')) s.kind = 'commerce';
    else if (s.signals.includes('WordPress')) s.kind = 'cms';
  }

  mark('probing', '定番の公開メタ（robots / sitemap / openapi / swagger）');
  for (const [p, label] of [['/robots.txt', 'robots'], ['/sitemap.xml', 'sitemap'], ['/openapi.json', 'openapiTop'], ['/swagger.json', 'swaggerTop']]) {
    const r = await getUrl(origin + p, { fetchImpl, timeoutMs: 7000 });
    if (r.status === 200 && r.body.trim()) { s[label] = { url: origin + p, bytes: r.body.length, head: r.body.slice(0, 200).replace(/\s+/g, ' ').trim() }; s.evidence.push(`GET ${p} → 200（${r.body.length} bytes）`); }
    else s.unknown.push(`${p} は取得できず（${r.status || 'err'}）`);
  }
  if (s.robots && /disallow:\s*\/\s*$/im.test(s.robots.head)) { s.robotsBlocks = true; s.unknown.push('robots.txt が全体を Disallow している'); }

  mark('probing', 'MCP の公開定義');
  const m = await detectMcp(origin, { fetchImpl });
  s.mcp = m;
  if (m.ok) { s.kind = 'mcp'; s.signals = [...new Set([...s.signals, 'MCP'])]; s.evidence.push(`POST /mcp initialize → 200（${m.server?.name || '?'} / tools ${m.tools.length}件）`); }
  else s.unknown.push(`/mcp は応答せず（${m.status || m.error || 'no result'}）`);

  if (deep && !(root.ct || '').includes('json')) {
    mark('parsing', '配信している JS を読む');
    s.js = await inspectJs(origin, root.body, { fetchImpl });
    if (s.js.bundles.length) s.evidence.push(`JS バンドル ${s.js.bundles.length}件 / ${s.js.totalBytes} bytes を読んだ`);
    if (s.js.inlineBytes) s.evidence.push(`インライン JS ${s.js.inlineBytes} bytes を読んだ`);
    if (s.js.flags.length) s.evidence.push(`機能フラグ ${s.js.flags.length}件: ${s.js.flags.slice(0, 5).map((f) => `${f.name}=${f.value}`).join(', ')}`);
    if (s.js.envNames.length) s.evidence.push(`環境変数名 ${s.js.envNames.length}件: ${s.js.envNames.slice(0, 5).join(', ')}（値は出さない）`);
    if (s.js.hosts.length) s.evidence.push(`外部ホスト ${s.js.hosts.length}件: ${s.js.hosts.slice(0, 6).join(', ')}`);
    for (const sec of s.js.secretShapes) s.evidence.push(`秘密の形: ${sec.label}（${sec.sample}）`);
    if (s.js.sourcemaps.length) s.unknown.push(`sourcemap が ${s.js.sourcemaps.length}件ある（中身は取っていない）`);
    if (!s.js.bundles.length && !s.js.inlineBytes) s.unknown.push('外部JSもインラインJSも見つからなかった');
  }

  mark('probing', 'API の公開定義');
  s.api = await inspectApi(origin, { fetchImpl });
  if (s.api.openapi) { s.kind = 'documented-api'; s.evidence.push(`OpenAPI: ${s.api.openapi.url}（パス ${s.api.openapi.paths}件）`); }
  if (s.api.graphql) s.evidence.push(`GraphQL: ${s.api.graphql.url} → ${s.api.graphql.hint}`);
  for (const w of s.api.wellKnown) s.evidence.push(`GET ${w.url.replace(origin, '')} → 200（${w.bytes} bytes）`);

  if (!s.endpoints.length) s.unknown.push('エンドポイントの文字列は見つからなかった（動的レンダリングの可能性）');
  if (!s.forms.length) s.unknown.push('フォームは見つからなかった');

  mark('evidence', '根拠をまとめる');
  s.capabilities = capabilityMap(s);
  s.score = reaScore(s);
  s.state = 'done';
  mark('done', `できること ${s.capabilities.length}件 / 分からなかったこと ${s.unknown.length}件`);
  return s;
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

const LEVEL_JA = { allow: 'そのまま実行', approve: '人の承認が要る', handoff: '人へ渡す', never: '実装しない' };

export function reaBrief(s = {}, { full = false } = {}) {
  if (!s.ok) return `解析できませんでした: ${s.reason || '不明'}（対象 ${s.target || ''}）`;
  const L = [];
  L.push(`# REA: ${s.title || s.target}`);
  L.push(`対象: ${s.target} ／ 種別: ${s.kind} ／ 実行: ${s.mode} ／ 完成度: ${s.score}/10 ／ 状態: ${s.state} ／ 認証: ${s.auth}`);
  if (s.description) L.push(`説明: ${s.description}`);
  if (s.signals?.length) L.push(`痕跡: ${s.signals.join(' / ')}`);

  L.push(`\n## できること（根拠つき）`);
  L.push(s.capabilities?.length ? s.capabilities.map((c) => `- ${c.name} 〔${c.confidence}〕 ← ${c.evidence}`).join('\n') : '- 判定できたことは無い');

  if (s.mode === 'local') {
    L.push(`\n## 実行手順（ローカルの rea-cli に渡す）`);
    L.push((s.plan || []).map((p, i) => `${i + 1}. ${p.step}〔${p.tool}〕\n   ${p.cmd}`).join('\n'));
    L.push(`\n一括でやるなら: node tools/rea-cli.mjs <path> --json`);
  }

  if (s.js && (s.js.flags?.length || s.js.hosts?.length || s.js.secretShapes?.length)) {
    L.push(`\n## クライアント側のJS`);
    if (s.js.bundles?.length) L.push(`バンドル: ${s.js.bundles.map((b) => `${b.url.replace(s.target, '')}(${b.status}/${b.bytes}B)`).join(', ')}`);
    if (s.js.libs?.length) L.push(`ライブラリ: ${s.js.libs.join(', ')}`);
    if (s.js.flags?.length) L.push(`機能フラグ ${s.js.flags.length}件:\n` + s.js.flags.slice(0, full ? 25 : 6).map((f) => `  - ${f.name} = ${f.value}`).join('\n'));
    if (s.js.envNames?.length) L.push(`環境変数名: ${s.js.envNames.slice(0, full ? 25 : 6).join(', ')}（値は出さない）`);
    if (s.js.hosts?.length) L.push(`外部ホスト: ${s.js.hosts.slice(0, full ? 30 : 8).join(', ')}`);
    if (s.js.secretShapes?.length) L.push(`秘密の形: ${s.js.secretShapes.map((x) => x.label).join(' / ')}（値は出さない）`);
  }
  if (s.endpoints?.length) L.push(`\n## 入口の候補 ${s.endpoints.length}件\n` + s.endpoints.slice(0, full ? 40 : 8).map((e) => `- ${e.path}${e.external ? '（外部）' : ''} 〔${e.evidence}〕`).join('\n'));
  if (s.forms?.length) L.push(`\n## フォーム ${s.forms.length}件\n` + s.forms.slice(0, full ? 10 : 3).map((f) => `- ${f.method.toUpperCase()} ${f.action} ${f.fields.length ? '(' + f.fields.join(', ') + ')' : ''}`).join('\n'));
  if (s.api?.openapi) L.push(`\nOpenAPI: ${s.api.openapi.url}（パス ${s.api.openapi.paths}件）`);
  if (s.mcp?.ok) L.push(`\nMCP: ${s.mcp.server?.name || '?'} v${s.mcp.server?.version || '?'} / ツール ${s.mcp.tools.length}件${s.mcp.tools.length ? ' → ' + s.mcp.tools.slice(0, full ? 40 : 8).map((t) => t.name).join(', ') : ''}`);

  L.push(`\n## 根拠\n` + s.evidence.map((e) => `- ${e}`).join('\n'));
  L.push(`\n## 分からなかったこと\n` + (s.unknown?.length ? s.unknown.map((e) => `- ${e}`).join('\n') : '- 特になし'));
  L.push(`\n## この道具が守ること\n` + GUARDRAILS.map((g) => `- ${g}`).join('\n'));
  L.push(`\n## 権限（4段階）\n` + (s.action_rules || ACTION_RULES).map((r) => `- ${r.action}: ${LEVEL_JA[r.level] || r.level} — ${r.note}`).join('\n'));
  L.push(`\n## 限界\n` + LIMITS.map((g) => `- ${g}`).join('\n'));
  if (!full) L.push(`\n（無料版は要約。全件・根拠の全文・実行手順の全文・MCPツール全件は有料版 ${REA_PRICE_USDC} USDC）`);
  return L.join('\n');
}

export function reaHelp() {
  return [
    `REA v${REA_VERSION} — 対象の「表面」を解析して、できることと根拠と限界を返す`,
    '  使い方:',
    '    GET /api/rea?url=https://example.com        サイト（HTML/JS/API/MCP）を解析',
    '    GET /api/rea?target=./app.asar             ローカルのファイル → 実行手順を返す（実行はしない）',
    '    GET /api/rea/plan?kind=elf                 ローカル解析の手順だけ',
    '    GET /api/rea/runs                          直近の解析の状態遷移',
    '  ローカルで実際に解析する: node tools/rea-cli.mjs <path> --json',
    `  有料版: ${REA_PRICE_USDC} USDC（x402）→ 全件＋根拠の全文＋実行手順の全文。MCP からは buy_rea_report。`,
    '  禁止: 認証回避・課金回避・DRM解除・対象の実行・再販。401/403 は auth_required として止める。',
  ].join('\n');
}

export function reaText(s = {}, { full = false } = {}) { return reaBrief(s, { full }); }

// ---------------------------------------------------------------------------
// 実行の記録（状態遷移を後から見られるようにする）
// ---------------------------------------------------------------------------

const REA_TABLE = `CREATE TABLE IF NOT EXISTS rea_runs (
  id TEXT PRIMARY KEY, target TEXT, kind TEXT, mode TEXT, state TEXT,
  score INTEGER, caps INTEGER, unknowns INTEGER, steps_json TEXT, at TEXT)`;

export async function recordRun(store, rep = {}, { now = null } = {}) {
  if (!store || typeof store.run !== 'function') return null;
  const at = rep.at || now || new Date().toISOString();
  const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await store.run(REA_TABLE);
    await store.run(
      'INSERT OR REPLACE INTO rea_runs (id,target,kind,mode,state,score,caps,unknowns,steps_json,at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, String(rep.target || '').slice(0, 200), String(rep.kind || ''), String(rep.mode || ''), String(rep.state || ''),
      Number(rep.score || 0), (rep.capabilities || []).length, (rep.unknown || []).length,
      JSON.stringify((rep.steps || []).slice(-12)), at,
    );
    return id;
  } catch { return null; }
}

export async function listRuns(store, limit = 20) {
  if (!store || typeof store.all !== 'function') return [];
  try {
    return (await store.all('SELECT id,target,kind,mode,state,score,caps,unknowns,at FROM rea_runs ORDER BY at DESC LIMIT ?', Math.max(1, Math.min(50, Number(limit) || 20)))) || [];
  } catch { return []; }
}
