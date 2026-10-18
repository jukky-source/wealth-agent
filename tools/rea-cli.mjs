#!/usr/bin/env node
// rea-cli — REA のローカル解析器（Worker からは届かない部分を担当する）
//
//   node tools/rea-cli.mjs <path> [--json] [--list-main] [--self-test]
//
// 対象: ELF / PE（.NET 含む）/ Mach-O / asar（Electron）/ apk / jar / zip / js / 任意のファイル
// 方針: 読み取り専用。対象は実行しない。秘密の値は出さない（形だけ）。認証回避・DRM解除は実装しない。
// 出典: 考え方は morluto/rea（https://github.com/morluto/rea）と同じ。中身は独立実装。

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';

const LEVELS = { allow: 'そのまま実行', approve: '人の承認が要る', handoff: '人へ渡す', never: '実装しない' };
const ACTION_RULES = [
  { action: 'run_static_analyzer', level: 'allow', note: 'readelf / objdump / strings など読み取り専用の解析' },
  { action: 'read_local_file', level: 'approve', note: '人が指定したパスだけ' },
  { action: 'run_target_binary', level: 'never', note: '対象を実行しない' },
  { action: 'auth_bypass', level: 'never', note: '認証を突破しない' },
  { action: 'paywall_bypass', level: 'never', note: '課金を回避しない' },
  { action: 'drm_circumvention', level: 'never', note: 'コピープロテクトを外さない' },
  { action: 'scrape_and_resell', level: 'never', note: '再配布・再販しない' },
];

function sh(cmd, args, maxBytes = 200000) {
  try {
    const out = execFileSync(cmd, args, { maxBuffer: 12 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return String(out).slice(0, maxBytes);
  } catch (e) {
    const out = (e && e.stdout) ? String(e.stdout) : '';
    return out.slice(0, maxBytes);
  }
}
const has = (cmd) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

function uniq(a, n) { return [...new Set(a)].slice(0, n); }
function topStrings(buf, n = 60, min = 8) {
  const s = buf.toString('latin1').match(new RegExp(`[\\x20-\\x7e]{${min},}`, 'g')) || [];
  const score = (x) => (/https?:\/\//.test(x) ? 3 : /\.(json|xml|txt|so|dll|exe|js)$/.test(x) ? 2 : /[A-Za-z]{4,}/.test(x) ? 1 : 0);
  return uniq(s.map((x) => x.trim()).filter((x) => x.length >= min), 100000)
    .map((x) => [score(x), x]).sort((a, b) => b[0] - a[0]).slice(0, n).map((x) => x[1]);
}

// ---------------------------------------------------------------- 種別判定
function detectKind(path, buf) {
  if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return 'elf';
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return 'pe';
  if (buf.length >= 4) {
    const m = buf.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(m)) return 'macho';
  }
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x06d4df3c) return 'asar';
  const e = extname(path).toLowerCase();
  if (e === '.asar') return 'asar';
  if (e === '.apk' || e === '.aab' || e === '.ipa') return 'apk';
  if (e === '.jar' || e === '.zip' || e === '.xpi' || e === '.crx') return 'zip';
  if (['.js', '.mjs', '.cjs', '.ts', '.map'].includes(e)) return 'js';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304) return 'zip';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x0061736d) return 'wasm';
  if (buf.length && buf.slice(0, 512).toString('latin1').includes('<html')) return 'html';
  return 'unknown';
}

// ---------------------------------------------------------------- PE / .NET
function parsePe(buf) {
  const out = { kind: 'pe', evidence: [], capabilities: [], unknown: [], sections: [], imports: [], dotnet: null };
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') { out.unknown.push('PE ヘッダが見つからない'); return out; }
  const machine = buf.readUInt16LE(peOff + 4);
  const nSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const is64 = magic === 0x20b;
  out.arch = { 0x8664: 'x86-64', 0x14c: 'x86', 0xaa64: 'ARM64', 0x1c0: 'ARM', 0x1c4: 'ARMv7' }[machine] || `0x${machine.toString(16)}`;
  out.magic = is64 ? 'PE32+' : 'PE32';
  out.evidence.push(`PE ヘッダ: ${out.magic} / ${out.arch} / セクション ${nSections}件`);
  const ddOff = optOff + (is64 ? 112 : 96);
  const nDd = buf.readUInt32LE(optOff + (is64 ? 108 : 92));
  const dirs = [];
  for (let i = 0; i < Math.min(nDd, 16); i++) dirs.push({ rva: buf.readUInt32LE(ddOff + i * 8), size: buf.readUInt32LE(ddOff + i * 8 + 4) });
  const secOff = optOff + optSize;
  for (let i = 0; i < nSections; i++) {
    const o = secOff + i * 40;
    const name = buf.toString('latin1', o, o + 8).replace(/\0+$/, '');
    const va = buf.readUInt32LE(o + 12), raw = buf.readUInt32LE(o + 16), rawSize = buf.readUInt32LE(o + 20);
    const flags = buf.readUInt32LE(o + 36);
    out.sections.push({ name, va, rawSize, flags: flags.toString(16), exec: !!(flags & 0x20000000), write: !!(flags & 0x80000000) });
  }
  const rvaToOff = (rva) => { for (const s of out.sections) { if (rva >= s.va && rva < s.va + Math.max(s.rawSize, 4096)) return s.va === 0 ? rva : rva - s.va + (out.sections.find((x) => x.name === s.name) ? 0 : 0) + 0 || null; } return null; };
  // セクション raw 位置を持ち直して正確に変換する
  const secs = [];
  for (let i = 0; i < nSections; i++) {
    const o = secOff + i * 40;
    secs.push({ name: buf.toString('latin1', o, o + 8).replace(/\0+$/, ''), va: buf.readUInt32LE(o + 12), raw: buf.readUInt32LE(o + 20), rawSize: buf.readUInt32LE(o + 16) });
  }
  const toOff = (rva) => { for (const s of secs) { if (rva >= s.va && rva < s.va + Math.max(s.rawSize, 4096)) return rva - s.va + s.raw; } return null; };
  // 取り込む DLL（できることの推定）
  const impRva = dirs[1]?.rva;
  if (impRva) {
    let off = toOff(impRva);
    for (let i = 0; off != null && i < 64; i++) {
      const nameRva = buf.readUInt32LE(off + 12);
      if (!nameRva) break;
      const no = toOff(nameRva);
      if (no == null) break;
      const dll = buf.toString('latin1', no, buf.indexOf(0, no)).trim();
      if (dll) out.imports.push(dll);
      off += 20;
    }
    out.imports = uniq(out.imports, 40);
    if (out.imports.length) out.evidence.push(`取り込む DLL ${out.imports.length}件: ${out.imports.slice(0, 8).join(', ')}`);
  }
  const capFromDll = (d) => {
    if (/ws2_32|wininet|winhttp|urlmon/i.test(d)) return 'ネットワーク通信';
    if (/crypt32|bcrypt|ncrypt|advapi32/i.test(d)) return '暗号・資格情報';
    if (/user32|gdi32|comctl32|dwmapi|uxtheme/i.test(d)) return '画面（GUI）';
    if (/ole32|oleaut32|combase|shell32/i.test(d)) return 'COM / シェル連携';
    if (/kernel32|ntdll|msvcrt|ucrtbase/i.test(d)) return 'OS 基本機能';
    if (/sqlite|libpq|odbc/i.test(d)) return 'データベース';
    return null;
  };
  const caps = uniq(out.imports.map(capFromDll).filter(Boolean), 12);
  for (const c of caps) out.capabilities.push({ name: c, evidence: `取り込む DLL から推定（${out.imports.filter((d) => capFromDll(d) === c).join(', ')}）`, confidence: 'med' });

  // .NET（CLI ヘッダ = データディレクトリ 14）
  const cli = dirs[14];
  if (cli && cli.rva) {
    const co = toOff(cli.rva);
    if (co != null) {
      const mdRva = buf.readUInt32LE(co + 8);
      const flags = buf.readUInt32LE(co + 16);
      const mo = toOff(mdRva);
      out.dotnet = { managed: true, ilOnly: !!(flags & 1), metadata: [], types: [], methods: [] };
      out.evidence.push(`.NET（マネージド）アセンブリ。ILOnly=${!!(flags & 1)}`);
      out.capabilities.push({ name: '.NET アセンブリ（IL を読める）', evidence: 'CLI ヘッダ（データディレクトリ14）が存在', confidence: 'high' });
      if (mo != null && buf.readUInt32LE(mo) === 0x424a5342) {
        try {
          const verLen = buf.readUInt32LE(mo + 12);
          const ver = buf.toString('utf8', mo + 16, mo + 16 + verLen).replace(/\0+$/, '');
          const streamCount = buf.readUInt16LE(mo + 16 + verLen + 2);
          let sp = mo + 16 + verLen + 4;
          const streams = {};
          for (let i = 0; i < streamCount; i++) {
            const off = buf.readUInt32LE(sp), size = buf.readUInt32LE(sp + 4);
            const nameEnd = buf.indexOf(0, sp + 8);
            const name = buf.toString('latin1', sp + 8, Math.min(nameEnd, sp + 8 + 32));
            streams[name] = { off: mo + off, size };
            sp += 8 + Math.ceil((name.length + 1) / 4) * 4;
          }
          out.dotnet.version = ver;
          out.dotnet.metadata = Object.keys(streams);
          out.evidence.push(`.NET メタデータ v${ver} / ストリーム: ${Object.keys(streams).join(', ')}`);
          const t = parseDotnetTables(buf, streams);
          out.dotnet.types = t.types.slice(0, 60);
          out.dotnet.methods = t.methods.slice(0, 60);
          out.dotnet.tableCounts = t.counts;
          if (t.types.length) out.evidence.push(`型 ${t.counts.TypeDef}件（例: ${t.types.slice(0, 6).join(', ')}）`);
          if (t.methods.length) out.evidence.push(`メソッド ${t.counts.MethodDef}件（例: ${t.methods.slice(0, 6).join(', ')}）`);
          const crypto = t.types.filter((x) => /crypto|aes|rsa|hash|license|licen[cs]e|activat|trial|expire|serial|keygen/i.test(x));
          if (crypto.length) out.capabilities.push({ name: 'ライセンス/暗号に関係しそうな型がある', evidence: `型名の一致: ${crypto.slice(0, 8).join(', ')}`, confidence: 'med' });
          const net = t.types.filter((x) => /http|webclient|socket|tcp|rest|api|grpc/i.test(x));
          if (net.length) out.capabilities.push({ name: '通信を行う型がある', evidence: `型名の一致: ${net.slice(0, 8).join(', ')}`, confidence: 'med' });
        } catch (e) { out.unknown.push(`.NET メタデータの解析に失敗（${String(e.message).slice(0, 80)}）→ strings にフォールバック`); }
      }
    }
  } else {
    out.capabilities.push({ name: 'ネイティブ実行ファイル', evidence: 'CLI ヘッダが無い（マネージドではない）', confidence: 'high' });
  }
  if (out.sections.some((s) => s.write && s.exec)) out.unknown.push('書き込み可能かつ実行可能なセクションがある（自己書き換え型の可能性）');
  return out;
}

// .NET の #~ テーブルから型名とメソッド名を取る（ECMA-335 の固定長行）
function parseDotnetTables(buf, streams) {
  const out = { types: [], methods: [], counts: {} };
  const tilde = streams['#~'] || streams['#-'];
  const strS = streams['#Strings'];
  if (!tilde || !strS) return out;
  const b = tilde.off;
  const heapSizes = buf.readUInt8(b + 6);
  const strIdx = (heapSizes & 1) ? 4 : 2;
  const guidIdx = (heapSizes & 2) ? 4 : 2;
  const blobIdx = (heapSizes & 4) ? 4 : 2;
  const valid = buf.readBigUInt64LE(b + 8);
  const counts = {};
  let p = b + 24;
  for (let i = 0; i < 64; i++) {
    if ((valid >> BigInt(i)) & 1n) { counts[i] = buf.readUInt32LE(p); p += 4; }
  }
  out.counts = { Module: counts[0] || 0, TypeRef: counts[1] || 0, TypeDef: counts[2] || 0, Field: counts[4] || 0, MethodDef: counts[6] || 0, Param: counts[8] || 0, AssemblyRef: counts[35] || 0, TypeSpec: counts[27] || 0 };
  const idx = (rows) => (rows > 0xffff ? 4 : 2);
  const coded = (maxRows, bits) => (maxRows < (1 << (16 - bits)) ? 2 : 4);
  const sizes = {
    0x00: 2 + strIdx + guidIdx + guidIdx + guidIdx,
    0x01: coded(Math.max(counts[0] || 0, counts[26] || 0, counts[35] || 0, counts[1] || 0), 2) + strIdx + strIdx,
    0x02: 4 + strIdx + strIdx + coded(Math.max(counts[2] || 0, counts[1] || 0, counts[27] || 0), 2) + idx(counts[4] || 0) + idx(counts[6] || 0),
    0x03: idx(counts[4] || 0),
    0x04: 2 + strIdx + blobIdx,
    0x05: idx(counts[6] || 0),
    0x06: 4 + 2 + 2 + strIdx + blobIdx + idx(counts[8] || 0),
  };
  const order = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
  let off = p;
  for (const t of order) {
    const n = counts[t] || 0;
    if (t === 0x02 && n) {
      for (let i = 0; i < n; i++) {
        const r = off + i * sizes[0x02];
        const nameOff = strS.off + buf.readUInt32LE(r + 4) % 0x100000000;
        const nOff = (strIdx === 4) ? strS.off + buf.readUInt32LE(r + 4) : strS.off + buf.readUInt16LE(r + 4);
        const nsOff = (strIdx === 4) ? strS.off + buf.readUInt32LE(r + 8) : strS.off + buf.readUInt16LE(r + 8);
        const name = buf.toString('latin1', nOff, buf.indexOf(0, nOff)).slice(0, 80);
        const ns = buf.toString('latin1', nsOff, buf.indexOf(0, nsOff)).slice(0, 80);
        if (name && !name.startsWith('<')) out.types.push(ns && !name.startsWith(ns) ? `${ns}.${name}` : name);
        void nameOff;
      }
    }
    if (t === 0x06 && n) {
      for (let i = 0; i < n; i++) {
        const r = off + i * sizes[0x06];
        const nOff = (strIdx === 4) ? strS.off + buf.readUInt32LE(r + 8) : strS.off + buf.readUInt16LE(r + 8);
        const name = buf.toString('latin1', nOff, buf.indexOf(0, nOff)).slice(0, 80);
        if (name) out.methods.push(name);
      }
    }
    off += n * sizes[t];
  }
  return out;
}

// ---------------------------------------------------------------- ELF
function parseElf(path, buf) {
  const out = { kind: 'elf', evidence: [], capabilities: [], unknown: [], libs: [], symbols: [], strings: [] };
  const h = sh('readelf', ['-h', path]);
  const type = (h.match(/Type:\s*([A-Z_]+)/) || [])[1] || '?';
  const mach = (h.match(/Machine:\s*([^\n]+)/) || [])[1]?.trim() || '?';
  out.evidence.push(`ELF: ${type} / ${mach}`);
  out.arch = mach;
  const dyn = sh('readelf', ['-d', path]);
  out.libs = uniq([...dyn.matchAll(/NEEDED\]\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1]), 40);
  if (out.libs.length) out.evidence.push(`必要なライブラリ ${out.libs.length}件: ${out.libs.slice(0, 10).join(', ')}`);
  const syms = sh('objdump', ['-T', path]);
  out.symbols = uniq([...syms.matchAll(/\s([A-Za-z_][A-Za-z0-9_@.]{3,60})\s*$/gm)].map((m) => m[1]), 120);
  const capFrom = (l) => {
    if (/libssl|libcrypto|libgcrypt|libsodium/i.test(l)) return '暗号（TLS/ハッシュ）';
    if (/libcurl|libhttp|libsoup|libwebsockets/i.test(l)) return 'ネットワーク通信';
    if (/libgtk|libQt|libX11|libwayland|libcairo|libSDL/i.test(l)) return '画面（GUI）';
    if (/libsqlite|libpq|libmysql|libmongo/i.test(l)) return 'データベース';
    if (/libcuda|libnvinfer|libtorch|libonnx/i.test(l)) return '推論・GPU';
    if (/libnode|libv8|libuv/i.test(l)) return 'Node/JS 実行';
    if (/libpython/i.test(l)) return 'Python 実行';
    if (/libsystemd|libdbus/i.test(l)) return 'システム連携';
    if (/libarchive|libzip|libz|liblzma|libzstd/i.test(l)) return 'アーカイブ/圧縮';
    return null;
  };
  for (const c of uniq(out.libs.map(capFrom).filter(Boolean), 12)) {
    out.capabilities.push({ name: c, evidence: `リンク: ${out.libs.filter((l) => capFrom(l) === c).join(', ')}`, confidence: 'med' });
  }
  const symCap = [[/socket|connect|sendto|recvfrom/, 'ソケット通信'], [/fork|execve|posix_spawn/, '外部プロセスの起動'], [/open|fopen|read|write/, 'ファイル入出力'], [/dlopen|dlsym/, '動的ロード（プラグイン）'], [/pthread_create/, '並行処理'], [/ioctl|mmap/, 'デバイス/メモリ操作']];
  for (const [re, name] of symCap) { if (out.symbols.some((s) => re.test(s))) out.capabilities.push({ name, evidence: `シンボルに ${name} 系の呼び出しがある`, confidence: 'med' }); }
  const hasSymTab = /Symbol table/.test(sh('readelf', ['-S', path]));
  out.stripped = !hasSymTab;
  if (out.stripped) out.unknown.push('シンボルが削られている（strip 済み）。関数名からの推定が効かない');
  if (/UPX!/.test(buf.toString('latin1'))) { out.packed = true; out.unknown.push('UPX で圧縮されている（展開はしない）'); }
  if (/PIE|DYN/.test(type)) out.evidence.push('位置独立実行形式（PIE/DYN）');
  const note = sh('readelf', ['-n', path]);
  if (/Build ID/.test(note)) out.evidence.push('Build ID あり');
  out.strings = topStrings(buf, 60);
  return out;
}

// ---------------------------------------------------------------- Mach-O
function parseMacho(path, buf) {
  const out = { kind: 'macho', evidence: [], capabilities: [], unknown: [], dylibs: [], strings: [] };
  let magic = buf.readUInt32BE(0);
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const le = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const rd = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const hsize = is64 ? 32 : 28;
  const ncmds = rd(16);
  const cputype = rd(4);
  out.arch = { 0x0100000c: 'arm64', 0x01000007: 'x86_64', 0x00000007: 'i386', 0x0000000c: 'arm' }[cputype] || `0x${cputype.toString(16)}`;
  out.evidence.push(`Mach-O ${is64 ? '64bit' : '32bit'} / ${out.arch} / ロードコマンド ${ncmds}件`);
  let o = hsize;
  for (let i = 0; i < Math.min(ncmds, 512); i++) {
    const cmd = rd(o);
    const size = rd(o + 4);
    if (size < 8) break;
    if (cmd === 0xc || cmd === 0x18) { // LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB
      const no = rd(o + 8);
      out.dylibs.push(buf.toString('latin1', o + no, buf.indexOf(0, o + no)).slice(0, 120));
    }
    if (cmd === 0x1d) out.signed = true;
    if (cmd === 0x21) out.encrypted = true;
    o += size;
  }
  out.dylibs = uniq(out.dylibs, 40);
  if (out.dylibs.length) out.evidence.push(`依存フレームワーク ${out.dylibs.length}件: ${out.dylibs.slice(0, 8).join(', ')}`);
  const capFrom = (d) => {
    if (/Security|CryptoKit|CommonCrypto/i.test(d)) return '暗号・鍵';
    if (/CFNetwork|Network\.framework|WebKit/i.test(d)) return 'ネットワーク通信';
    if (/AppKit|SwiftUI|UIKit|Cocoa/i.test(d)) return '画面（GUI）';
    if (/CoreML|Metal|Accelerate/i.test(d)) return '推論・GPU';
    if (/StoreKit|Purchases/i.test(d)) return '課金（StoreKit）';
    return null;
  };
  for (const c of uniq(out.dylibs.map(capFrom).filter(Boolean), 12)) out.capabilities.push({ name: c, evidence: `リンク: ${out.dylibs.filter((d) => capFrom(d) === c).join(', ')}`, confidence: 'med' });
  if (out.signed) out.capabilities.push({ name: 'コード署名されている', evidence: 'LC_CODE_SIGNATURE が存在（改変はしない）', confidence: 'high' });
  if (out.encrypted) out.unknown.push('暗号化されている（App Store の暗号化バイナリ。解析しない）');
  out.strings = topStrings(buf, 60);
  return out;
}

// ---------------------------------------------------------------- asar（Electron）
function readAsarHeader(buf) {
  // 8byte pickle + 4byte size + 4byte json length(LE, pickle) のあと JSON
  const size = buf.readUInt32LE(12);
  const json = buf.toString('utf8', 16, 16 + size);
  return JSON.parse(json);
}
function walkAsar(node, prefix = '', acc = []) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (v.files) walkAsar(v, p, acc);
    else acc.push({ path: p, size: v.size || 0, offset: v.offset, unpacked: !!v.unpacked });
  }
  return acc;
}
function parseAsar(path, buf) {
  const out = { kind: 'asar', evidence: [], capabilities: [], unknown: [], files: [], entry: null };
  const hdr = readAsarHeader(buf);
  const files = walkAsar(hdr);
  out.files = files;
  out.evidence.push(`asar ヘッダを読んだ: ファイル ${files.length}件`);
  const pkg = files.find((f) => f.path === 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(buf.toString('utf8', 16 + buf.readUInt32LE(12) + pkg.offset, 16 + buf.readUInt32LE(12) + pkg.offset + pkg.size));
      out.package = { name: j.name, version: j.version, main: j.main, deps: Object.keys(j.dependencies || {}).slice(0, 40) };
      out.entry = j.main || 'index.js';
      out.evidence.push(`package.json: ${j.name}@${j.version} / main=${j.main || '-'} / 依存 ${out.package.deps.length}件`);
      if (out.package.deps.length) out.capabilities.push({ name: 'Electron アプリ（JS の本体が読める）', evidence: `依存: ${out.package.deps.slice(0, 10).join(', ')}`, confidence: 'high' });
    } catch (e) { out.unknown.push(`package.json が読めない（${String(e.message).slice(0, 60)}）`); }
  }
  const byExt = {};
  for (const f of files) { const e = (f.path.match(/\.([A-Za-z0-9]+)$/) || [])[1] || 'other'; byExt[e] = (byExt[e] || 0) + 1; }
  out.byExt = byExt;
  out.evidence.push(`内訳: ${Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const native = files.filter((f) => /\.(node|dll|so|dylib)$/.test(f.path));
  if (native.length) { out.capabilities.push({ name: 'ネイティブモジュールを含む', evidence: native.slice(0, 6).map((f) => f.path).join(', '), confidence: 'high' }); out.unknown.push('ネイティブモジュールの中身は未解析（別途 rea-cli に渡す）'); }
  const js = files.filter((f) => /\.(js|mjs|cjs)$/.test(f.path));
  if (js.length) out.capabilities.push({ name: 'JS のソースが同梱されている', evidence: `JS ${js.length}件（例: ${js.slice(0, 5).map((f) => f.path).join(', ')}）`, confidence: 'high' });
  const lic = files.filter((f) => /licen[cs]e|activat|trial|serial|keygen|patch/i.test(f.path));
  if (lic.length) out.capabilities.push({ name: 'ライセンス/認証に関係しそうなファイルがある', evidence: lic.slice(0, 8).map((f) => f.path).join(', '), confidence: 'med' });
  return out;
}

// ---------------------------------------------------------------- zip / apk / jar
function parseZip(path, kind) {
  const out = { kind, evidence: [], capabilities: [], unknown: [], entries: [], manifest: null };
  const list = sh('unzip', ['-l', path]);
  out.entries = uniq([...list.matchAll(/^\s*\d+\s+\S+\s+\S+\s+(\S.*)$/gm)].map((m) => m[1].trim()), 300);
  out.evidence.push(`アーカイブ内 ${out.entries.length}件を列挙`);
  const byExt = {};
  for (const e of out.entries) { const x = (e.match(/\.([A-Za-z0-9]+)$/) || [])[1] || 'other'; byExt[x] = (byExt[x] || 0) + 1; }
  out.byExt = byExt;
  if (kind === 'apk') {
    const mf = sh('unzip', ['-p', path, 'AndroidManifest.xml'], 200000);
    const perms = uniq([...mf.matchAll(/android\.permission\.[A-Z_]+/g)].map((m) => m[0]), 40);
    const comps = uniq([...mf.matchAll(/(?:activity|service|receiver|provider)\s+android:name="([^"]{3,120})"/g)].map((m) => m[1]), 40);
    const pkg = (mf.match(/package="([^"]+)"/) || [])[1] || null;
    out.manifest = { package: pkg, permissions: perms, components: comps.length };
    out.evidence.push(`AndroidManifest: package=${pkg || '?'} / 権限 ${perms.length}件 / コンポーネント ${comps.length}件`);
    for (const p of perms.slice(0, 12)) out.capabilities.push({ name: `権限: ${p.replace('android.permission.', '')}`, evidence: 'AndroidManifest の宣言', confidence: 'high' });
    const dex = out.entries.filter((e) => /classes\d*\.dex/.test(e));
    if (dex.length) out.capabilities.push({ name: 'Dalvik バイトコードを含む', evidence: dex.join(', '), confidence: 'high' });
    if (out.entries.some((e) => /^lib\//.test(e))) out.capabilities.push({ name: 'ネイティブライブラリを含む', evidence: 'lib/ 以下に .so', confidence: 'high' });
  }
  if (kind === 'zip' && out.entries.some((e) => /\.class$/.test(e))) {
    out.capabilities.push({ name: 'Java クラスを含む（jar）', evidence: `class ファイル ${byExt.class || 0}件`, confidence: 'high' });
    const classes = out.entries.filter((e) => /\.class$/.test(e)).slice(0, 40);
    out.classes = classes;
    const interesting = classes.filter((c) => /licen[cs]e|activat|trial|crypt|auth|net|http/i.test(c));
    if (interesting.length) out.capabilities.push({ name: 'ライセンス/通信に関係しそうなクラス', evidence: interesting.slice(0, 8).join(', '), confidence: 'med' });
  }
  return out;
}

// ---------------------------------------------------------------- js
function parseJs(path, code) {
  const out = { kind: 'js', evidence: [], capabilities: [], unknown: [], endpoints: [], flags: [], hosts: [], envNames: [], sourcemaps: [], secretShapes: [] };
  out.evidence.push(`JS ${code.length} bytes を静的に読んだ（実行はしない）`);
  out.endpoints = uniq([...code.matchAll(/["'`](\/(?:api|v\d|graphql|rest|mcp|rpc|oauth|auth|admin|internal)[A-Za-z0-9_\-./{}$:?=&%]{0,120})["'`]/g)].map((m) => m[1].split('?')[0]), 40);
  for (const m of code.matchAll(/https?:\/\/[A-Za-z0-9._-]{4,60}/g)) out.hosts.push(m[0].replace(/^https?:\/\//, '').split('/')[0]);
  out.hosts = uniq(out.hosts, 30);
  out.flags = uniq([...code.matchAll(/["']([a-z][A-Za-z0-9_]*(?:[Ff]lag|[Ee]xperiment|[Bb]eta|[Ee]nabl)[A-Za-z0-9_]*)["']\s*[:=]\s*(true|false|1|0)/g)].map((m) => `${m[1]}=${m[2]}`), 25);
  out.envNames = uniq([...code.matchAll(/(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{2,40})/g)].map((m) => m[1]), 25);
  out.sourcemaps = uniq([...code.matchAll(/sourceMappingURL=([^\s*'"`]+)/g)].map((m) => m[1]), 5);
  const shapes = [[/sk-[A-Za-z0-9]{20,}/, 'sk- で始まる鍵らしき文字列'], [/ghp_[A-Za-z0-9]{20,}/, 'GitHub トークンらしき文字列'], [/AIza[0-9A-Za-z_-]{20,}/, 'Google API キーらしき文字列'], [/eyJ[A-Za-z0-9_-]{10,}\./, 'JWT らしき文字列'], [/AKIA[0-9A-Z]{16}/, 'AWS 鍵IDらしき文字列']];
  for (const [re, label] of shapes) { const m = code.match(re); if (m) out.secretShapes.push(`${label}（${m[0].slice(0, 4)}… 値は出さない）`); }
  if (out.endpoints.length) out.capabilities.push({ name: '内部 API の入口候補', evidence: `${out.endpoints.length}件のパス文字列`, confidence: 'low' });
  if (out.flags.length) out.capabilities.push({ name: '機能フラグで出し分けている', evidence: out.flags.slice(0, 6).join(', '), confidence: 'med' });
  if (out.envNames.length) out.capabilities.push({ name: 'ビルド時に環境変数を埋め込んでいる', evidence: out.envNames.slice(0, 6).join(', '), confidence: 'med' });
  if (out.secretShapes.length) out.capabilities.push({ name: '秘密らしき文字列が同梱されている', evidence: out.secretShapes.join(' / '), confidence: 'high' });
  if (out.sourcemaps.length) out.unknown.push(`sourcemap 参照あり（${out.sourcemaps[0]}）`);
  return out;
}

// ---------------------------------------------------------------- 本体
export function analyze(path) {
  const at = new Date().toISOString();
  if (!existsSync(path)) return { ok: false, at, target: path, reason: 'ファイルが存在しない', action_rules: ACTION_RULES };
  const st = statSync(path);
  if (st.isDirectory()) {
    const asar = `${path.replace(/\/$/, '')}/resources/app.asar`;
    if (existsSync(asar)) return analyze(asar);
    return { ok: false, at, target: path, reason: 'ディレクトリ。Electron なら <dir>/resources/app.asar を指定する', action_rules: ACTION_RULES };
  }
  const buf = readFileSync(path);
  const kind = detectKind(path, buf);
  const base = { ok: true, at, target: path, name: basename(path), bytes: st.size, kind, mode: 'local', version: '2.0', steps: [{ state: 'parsing', at, note: `${kind} として解析` }], action_rules: ACTION_RULES };
  let r;
  try {
    if (kind === 'elf') r = parseElf(path, buf);
    else if (kind === 'pe') r = parsePe(buf);
    else if (kind === 'macho') r = parseMacho(path, buf);
    else if (kind === 'asar') r = parseAsar(path, buf);
    else if (kind === 'apk' || kind === 'zip') r = parseZip(path, kind);
    else if (kind === 'js') r = parseJs(path, buf.toString('utf8'));
    else {
      r = { kind, evidence: [], capabilities: [], unknown: [], strings: topStrings(buf, 40) };
      r.unknown.push('既知の形式ではない。文字列と種別だけ返す');
      r.evidence.push(`先頭バイト: ${buf.slice(0, 8).toString('hex')}`);
    }
  } catch (e) {
    r = { kind, evidence: [], capabilities: [], unknown: [`解析中に例外: ${String(e.message).slice(0, 120)}`] };
  }
  const rep = { ...base, ...r, state: 'done' };
  rep.capabilities = (rep.capabilities || []).slice(0, 40);
  rep.unknown = uniq([...(rep.unknown || []), '静的な読み取りのみ。実際の動作は確認していない', 'この道具は対象を実行しない'], 40);
  rep.score = Math.min(10, 1 + Math.min(4, rep.capabilities.length) + (rep.evidence.length >= 3 ? 2 : 0) + (kind === 'unknown' ? 0 : 2));
  return rep;
}

export function brief(r) {
  if (!r.ok) return `解析できません: ${r.reason}（${r.target}）`;
  const L = [];
  L.push(`# REA(local): ${r.name}`);
  L.push(`種別: ${r.kind} ／ ${r.bytes} bytes ／ 完成度: ${r.score}/10 ／ 状態: ${r.state}`);
  L.push(`\n## できること（根拠つき）`);
  L.push(r.capabilities.length ? r.capabilities.map((c) => `- ${c.name} 〔${c.confidence}〕 ← ${c.evidence}`).join('\n') : '- 判定できたことは無い');
  if (r.dotnet?.types?.length) L.push(`\n## 型（${r.dotnet.tableCounts?.TypeDef}件中 ${r.dotnet.types.length}件）\n` + r.dotnet.types.slice(0, 30).map((t) => `- ${t}`).join('\n'));
  if (r.dotnet?.methods?.length) L.push(`\n## メソッド（${r.dotnet.tableCounts?.MethodDef}件中 ${r.dotnet.methods.length}件）\n` + r.dotnet.methods.slice(0, 25).join(', '));
  if (r.files?.length) L.push(`\n## 同梱ファイル ${r.files.length}件（上位20）\n` + r.files.slice(0, 20).map((f) => `- ${f.path} (${f.size}B)`).join('\n'));
  if (r.entries?.length && r.kind !== 'asar') L.push(`\n## アーカイブ内 ${r.entries.length}件（上位20）\n` + r.entries.slice(0, 20).map((e) => `- ${e}`).join('\n'));
  if (r.imports?.length) L.push(`\n## 取り込む DLL\n${r.imports.join(', ')}`);
  if (r.libs?.length) L.push(`\n## リンクしているライブラリ\n${r.libs.join(', ')}`);
  if (r.dylibs?.length) L.push(`\n## 依存フレームワーク\n${r.dylibs.slice(0, 20).join(', ')}`);
  if (r.endpoints?.length) L.push(`\n## 入口の候補\n${r.endpoints.slice(0, 20).join(', ')}`);
  if (r.flags?.length) L.push(`\n## 機能フラグ\n${r.flags.join(', ')}`);
  if (r.secretShapes?.length) L.push(`\n## 秘密の形（値は出さない）\n${r.secretShapes.join(' / ')}`);
  if (r.strings?.length) L.push(`\n## 特徴的な文字列（上位15）\n` + r.strings.slice(0, 15).map((s) => `- ${s.slice(0, 120)}`).join('\n'));
  L.push(`\n## 根拠\n` + (r.evidence || []).map((e) => `- ${e}`).join('\n'));
  L.push(`\n## 分からなかったこと\n` + (r.unknown || []).map((e) => `- ${e}`).join('\n'));
  L.push(`\n## 権限（4段階）\n` + ACTION_RULES.map((x) => `- ${x.action}: ${LEVELS[x.level]} — ${x.note}`).join('\n'));
  return L.join('\n');
}

// ---------------------------------------------------------------- CLI
function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const path = args.find((a) => !a.startsWith('--'));
  if (flags.includes('--self-test')) {
    const r = analyze(new URL(import.meta.url).pathname);
    const ok = r.ok && r.kind === 'js';
    console.log(JSON.stringify({ self_test: ok ? 'ok' : 'ng', kind: r.kind, capabilities: r.capabilities.length, evidence: r.evidence.length }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  if (!path) {
    console.log([
      'rea-cli — ローカルのファイルを静的に解析する（対象は実行しない）',
      '  node tools/rea-cli.mjs <path> [--json] [--list-main] [--self-test]',
      '  対応: ELF / PE(.NET 含む) / Mach-O / asar(Electron) / apk / jar / zip / js',
      '  方針: 読み取り専用。認証回避・課金回避・DRM解除・再販は実装しない。',
    ].join('\n'));
    process.exit(0);
  }
  const r = analyze(path);
  if (flags.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  if (flags.includes('--list-main')) { console.log(r.entry || '(main が不明)'); process.exit(0); }
  console.log(brief(r));
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
