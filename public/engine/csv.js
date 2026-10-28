/**
 * Fast, tolerant CSV reader.
 *
 * nflverse ships wide CSVs (the player-week file has ~150 columns and ~25k rows).
 * Parsing all of that into objects is wasteful, so we parse *column-wise* and only
 * keep the columns the engine asks for.
 *
 * Returns { n, col(name) -> array }. Numeric columns are converted once, with
 * empty strings preserved as NaN so callers can tell "did not play" from "zero".
 */

function splitFields(line) {
  if (line.indexOf('"') === -1) return line.split(','); // fast path: no quoting
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (quoted) {
      if (ch === 34 /* " */) {
        if (line.charCodeAt(i + 1) === 34) { cur += '"'; i++; }
        else quoted = false;
      } else cur += line[i];
    } else if (ch === 34) quoted = true;
    else if (ch === 44 /* , */) { out.push(cur); cur = ''; }
    else cur += line[i];
  }
  out.push(cur);
  return out;
}

export function parseCsv(text, columns, { numeric = [] } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0) return { n: 0, col: () => [] };

  const header = splitFields(text.slice(0, firstBreak).replace(/\r$/, ''));
  const index = new Map();
  const numericSet = new Set(numeric);
  const store = new Map();

  for (const name of columns) {
    const at = header.indexOf(name);
    if (at >= 0) {
      index.set(name, at);
      store.set(name, []);
    }
  }
  if (index.size === 0) return { n: 0, col: () => [] };

  const keys = [...index.keys()];
  const positions = keys.map((k) => index.get(k));
  const arrays = keys.map((k) => store.get(k));
  const isNum = keys.map((k) => numericSet.has(k));
  let n = 0;

  let start = firstBreak + 1;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.length === 0 || line.charCodeAt(0) === 13) continue;

    const fields = splitFields(line);
    for (let c = 0; c < keys.length; c++) {
      const raw = fields[positions[c]];
      if (raw === undefined) { arrays[c].push(isNum[c] ? NaN : ''); continue; }
      arrays[c].push(isNum[c] ? (raw === '' ? NaN : +raw) : raw);
    }
    n++;
  }

  return { n, col: (name) => store.get(name) ?? [] };
}

export function zip(columns, names) {
  // convenience for small rows: returns array of objects
  const n = columns.n;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = {};
    for (const k of names) o[k] = columns.col(k)[i];
    out[i] = o;
  }
  return out;
}
