'use strict';
// Tokenize only CLI syntax, never rescan option values or tokens after `--`.
// Adapters supply their own option arities and aliases.
function scan(argv, spec) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const start = i; const token = argv[i];
    if (token === '--') { out.push({ key: '--', start, end: i + 1 }); break; }
    if (!token.startsWith('-') || token === '-') { out.push({ positional: token, start, end: i + 1 }); continue; }
    let key = token; let value;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) { key = token.slice(0, eq); value = token.slice(eq + 1); }
    } else if (spec.aliases[token.slice(0, 2)]) {
      key = spec.aliases[token.slice(0, 2)];
      if (token.length > 2 && spec.values.includes(key)) value = token.slice(2).replace(/^=/, '');
    }
    if (value === undefined && spec.values.includes(key)) value = argv[++i];
    else if (value === undefined && (spec.optional || []).includes(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) value = argv[++i];
    if ((spec.variadic || []).includes(key)) while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++;
    out.push({ key, value, start, end: i + 1 });
  }
  return out;
}
module.exports = { scan };
