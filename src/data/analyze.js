// Data Analysis — CSV/TSV/JSON/TXT/Markdown parsing, statistics, data-quality
// checks, chart-ready output and export. Runs entirely in-process (no deps).

import { id as newId, nowIso, j, truncate, round, mean, stdev, safeJson } from '../util.js';
import { BASIS } from '../truth.js';

export function createDataAnalysis({ store }) {
  async function run({ spec = { kind: 'describe' }, datasetId = null, inlineData = null }) {
    const raw = inlineData ?? (datasetId ? safeJson((await store.first('SELECT text_preview FROM documents WHERE id=?', datasetId))?.text_preview, null) : null);
    if (raw === null || raw === undefined) return { ok: false, error: 'no_data', summary: '解析対象データがありません' };

    const kind = spec.kind || 'describe';
    let table;
    try { table = parseTable(raw, spec.format); } catch (e) { return { ok: false, error: 'parse_failed', summary: `解析失敗: ${e.message}` }; }
    if (!table.rows.length) return { ok: false, error: 'empty_table', summary: '行がありません' };

    const quality = qualityCheck(table);
    const stats = statColumns(table);
    const out = {
      ok: true, datasetId: datasetId || null,
      loaded: { rows: table.rows.length, columns: table.columns.length, format: table.format },
      columns: table.columns, columnsSample: table.columns.slice(0, 40),
      stats, quality,
      artifacts: [],
      summary: '',
    };

    switch (kind) {
      case 'describe':
        out.summary = `${table.rows.length}行 × ${table.columns.length}列（${table.format}）を解析。欠損セル ${quality.missingCells}件（${quality.missingPct}%）、重複行 ${quality.duplicateRows}件。`;
        break;
      case 'filter': {
        const { column, op, value } = spec;
        const ci = table.columns.indexOf(column);
        if (ci < 0) { out.summary = `列 ${column} が見つかりません`; break; }
        const filtered = table.rows.filter((r) => compare(r[ci], op, value));
        out.filtered = { rows: filtered.length, sample: filtered.slice(0, 50).map(rowToObj) };
        out.summary = `条件 ${column} ${op} ${value} で ${filtered.length} 行が一致（全 ${table.rows.length} 行中）。`;
        break;
      }
      case 'group': {
        const { groupBy, metric, agg = 'sum' } = spec;
        const gi = table.columns.indexOf(groupBy);
        const mi = table.columns.indexOf(metric);
        if (gi < 0 || mi < 0) { out.summary = `列 ${groupBy} または ${metric} が見つかりません`; break; }
        const groups = {};
        for (const r of table.rows) {
          const k = String(r[gi]);
          groups[k] = groups[k] || [];
          const v = Number(r[mi]);
          if (isFinite(v)) groups[k].push(v);
        }
        out.grouped = Object.entries(groups).map(([k, vals]) => ({
          key: k, n: vals.length, agg: agg === 'sum' ? round(vals.reduce((s, v) => s + v, 0), 3)
            : agg === 'avg' ? round(mean(vals), 3) : round(vals.length ? Math.max(...vals) : 0, 3),
        })).sort((a, b) => b.agg - a.agg).slice(0, 100);
        out.summary = `${groupBy} ごとに ${metric} を ${agg} 集計（${out.grouped.length} グループ）。`;
        break;
      }
      case 'chart': {
        const { x, y, type = 'line' } = spec;
        const xi = table.columns.indexOf(x);
        const yi = table.columns.indexOf(y);
        if (xi < 0 || yi < 0) { out.summary = `列 ${x} または ${y} が見つかりません`; break; }
        const points = table.rows.map((r) => ({ x: r[xi], y: Number(r[yi]) })).filter((p) => isFinite(p.y)).slice(0, 2000);
        out.chart = { type, series: [{ name: y, points }], xLabel: x, yLabel: y };
        out.summary = `${type} チャート用に ${points.length} 点を生成（${x} × ${y}）。`;
        break;
      }
      case 'correlation': {
        const nums = table.columns.filter((c) => stats[c]?.type === 'number');
        const pairs = [];
        for (let i = 0; i < nums.length; i++) for (let k = i + 1; k < nums.length; k++) {
          const r = pearson(table.rows.map((row) => Number(row[nums[i]])), table.rows.map((row) => Number(row[nums[k]])));
          if (r !== null) pairs.push({ a: nums[i], b: nums[k], r: round(r, 3) });
        }
        out.correlations = pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 30);
        out.summary = `相関を ${out.correlations.length} 組算出（ピアソン）。相関は因果を示しません。`;
        break;
      }
      default:
        out.summary = `未対応の解析種別: ${kind}`;
    }

    if (spec.export) {
      const csv = toCsv(table);
      const id = newId('dat');
      await store.insert('runs', {
        id, task_id: null, mission_id: null, state: 'data_export', step: 0,
        summary: `データ出力 ${table.rows.length}行`, detail: j({ csv: csv.slice(0, 20000) }), created_at: nowIso(),
      });
      out.artifacts.push({ type: 'csv', run_id: id, rows: table.rows.length });
      out.csv = csv;
    }
    out.basis = BASIS.MEASURED;
    out.disclaimer = '統計値は提供データから算出した実測値です。欠損・外れ値の影響を受けます（品質チェック結果を参照）。';
    return out;
  }

  return { run, parseTable, qualityCheck, statColumns };
}

export function parseTable(text, format = null) {
  const s = String(text).trim();
  if (!s) return { format: 'empty', columns: [], rows: [] };
  const fmt = format || detectFormat(s);

  if (fmt === 'json') {
    const parsed = safeJson(s, null);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed?.rows) ? parsed.rows : null));
    if (!arr) throw new Error('JSON配列が見つかりません');
    const columns = [...new Set(arr.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))];
    const rows = arr.map((r) => columns.map((c) => (r && typeof r === 'object' ? r[c] : null)));
    return { format: 'json', columns, rows };
  }

  const lines = s.split(/\r?\n/).filter((l) => l.trim().length);
  const delim = fmt === 'tsv' ? '\t' : (fmt === 'csv' ? ',' : guessDelimiter(lines[0]));
  const splitLine = (l) => splitCsvLine(l, delim);
  let header = splitLine(lines[0]).map((h) => h.trim());
  // Markdown tables: | a | b |
  if (/^\|/.test(lines[0])) {
    header = lines[0].split('|').map((x) => x.trim()).filter((x) => x.length);
    const body = lines.filter((l, i) => i > 0 && !/^\|[\s\-:|]+\|?$/.test(l)).map((l) => l.split('|').map((x) => x.trim()).filter((x, i2) => i2 > 0 && i2 <= header.length));
    return { format: 'markdown', columns: header, rows: body };
  }
  const rows = lines.slice(1).map(splitLine).map((cells) => header.map((_, i) => (cells[i] !== undefined ? cells[i].trim() : null)));
  // If the first row doesn't look like a header, treat it as data.
  const headerLike = header.every((h) => h.length > 0 && !/^-?\d+(\.\d+)?$/.test(h));
  if (!headerLike) {
    return { format: fmt, columns: header.map((_, i) => `col${i + 1}`), rows: [header, ...rows] };
  }
  return { format: fmt, columns: header, rows };
}

function detectFormat(s) {
  const t = s.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (t.includes('\t') && !t.split('\n')[0].includes(',')) return 'tsv';
  if (/^\|/.test(t)) return 'markdown';
  return 'csv';
}

function guessDelimiter(line) {
  const counts = { ',': (line.match(/,/g) || []).length, '\t': (line.match(/\t/g) || []).length, ';': (line.match(/;/g) || []).length };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}

function splitCsvLine(line, delim) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === delim && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function statColumns(table) {
  const stats = {};
  table.columns.forEach((col, ci) => {
    const values = table.rows.map((r) => r[ci]);
    const present = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '');
    const nums = present.map(Number).filter((v) => isFinite(v));
    const isNum = present.length > 0 && nums.length / present.length > 0.9;
    stats[col] = {
      type: isNum ? 'number' : 'text',
      count: present.length,
      missing: values.length - present.length,
      distinct: new Set(present.map((v) => String(v))).size,
    };
    if (isNum && nums.length) {
      const sorted = [...nums].sort((a, b) => a - b);
      Object.assign(stats[col], {
        min: round(sorted[0], 4), max: round(sorted[sorted.length - 1], 4),
        mean: round(mean(nums), 4), stdev: round(stdev(nums), 4),
        median: round(sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, 4),
        sum: round(nums.reduce((s, v) => s + v, 0), 4),
      });
    } else if (present.length) {
      const freq = {};
      for (const v of present) freq[String(v)] = (freq[String(v)] || 0) + 1;
      stats[col].top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => ({ value: k, n }));
    }
  });
  return stats;
}

export function qualityCheck(table) {
  const cells = table.rows.length * table.columns.length;
  let missing = 0;
  for (const r of table.rows) for (const c of r) if (c === null || c === undefined || String(c).trim() === '') missing++;
  const seen = new Set(); let dupes = 0;
  for (const r of table.rows) {
    const k = r.join('\u0001');
    if (seen.has(k)) dupes++; else seen.add(k);
  }
  // ragged rows / outliers
  const ragged = table.rows.filter((r) => r.length !== table.columns.length).length;
  const outliers = [];
  for (const [col, st] of Object.entries(statColumns(table))) {
    if (st.type !== 'number' || !st.stdev) continue;
    const ci = table.columns.indexOf(col);
    const vals = table.rows.map((r) => Number(r[ci])).filter((v) => isFinite(v));
    const out = vals.filter((v) => Math.abs(v - st.mean) > 4 * st.stdev).length;
    if (out) outliers.push({ column: col, count: out });
  }
  return {
    missingCells: missing, missingPct: cells ? round((missing / cells) * 100, 2) : 0,
    duplicateRows: dupes, raggedRows: ragged,
    outlierColumns: outliers,
    constantColumns: Object.entries(statColumns(table)).filter(([, s]) => s.distinct === 1).map(([c]) => c),
    issues: [
      missing / Math.max(1, cells) > 0.1 ? '欠損が10%を超えています' : null,
      dupes > 0 ? `${dupes}件の完全重複行` : null,
      ragged > 0 ? `${ragged}件の列数不一致行` : null,
      outliers.length ? `外れ値（4σ超）: ${outliers.map((o) => o.column).join(', ')}` : null,
    ].filter(Boolean),
  };
}

function pearson(a, b) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (isFinite(a[i]) && isFinite(b[i])) pairs.push([a[i], b[i]]);
  if (pairs.length < 3) return null;
  const xs = pairs.map((p) => p[0]); const ys = pairs.map((p) => p[1]);
  const mx = mean(xs); const my = mean(ys);
  let num = 0; let dx = 0; let dy = 0;
  for (const [x, y] of pairs) { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
  const den = Math.sqrt(dx * dy);
  return den ? num / den : null;
}

function compare(v, op, target) {
  const num = Number(v); const t = Number(target);
  switch (op) {
    case '>': return num > t; case '<': return num < t;
    case '>=': return num >= t; case '<=': return num <= t;
    case '==': return String(v) === String(target);
    case '!=': return String(v) !== String(target);
    case 'contains': return String(v).includes(String(target));
    default: return false;
  }
}

function rowToObj(r) { return r; }
function rowToObject(table, r) { return Object.fromEntries(table.columns.map((c, i) => [c, r[i]])); }

export function toCsv(table) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [table.columns.map(esc).join(','), ...table.rows.map((r) => r.map(esc).join(','))].join('\n');
}
