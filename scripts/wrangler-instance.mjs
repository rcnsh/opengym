/* Merge instance.jsonc over wrangler.jsonc and write wrangler.instance.json.
 *
 * wrangler.jsonc has to stay generic for the Deploy to Cloudflare button — Cloudflare reads it
 * to work out which resources to provision, and a hostname or database id belonging to somebody
 * else in there makes the button useless. So one deployment's own values live in instance.jsonc
 * and are folded in here, at deploy time.
 *
 * The output lands beside wrangler.jsonc rather than in a build directory because wrangler
 * resolves `main`, `assets.directory` and `migrations_dir` relative to the config file it was
 * given. Moving it a directory deeper would silently repoint all three.
 *
 *   node scripts/wrangler-instance.mjs [--config <path>] [--out <path>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

/* JSON with comments. Both config files are heavily commented — that is most of their value —
 * and wrangler reads JSONC natively, so the merge step has to as well. Strings are tracked so a
 * `//` inside one (a URL, say) survives. */
export function stripJsonComments(src) {
  let out = '';
  let inString = false, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  /* Trailing commas are legal in JSONC and wrangler accepts them, so JSON.parse must not be the
   * thing that rejects a config wrangler itself would have taken. */
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readJsonc(path) {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new Error(`${path}: ${e.message}`);
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/* Objects combine key by key; arrays and scalars replace outright. An array of bindings is a
 * complete statement about which bindings exist, so merging element-wise would mean an instance
 * could add a database but never drop or reorder one. */
export function merge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const basePath = flag('--config', 'wrangler.jsonc');
  const overPath = flag('--instance', 'instance.jsonc');
  const outPath = flag('--out', 'wrangler.instance.json');

  let over;
  try {
    over = readJsonc(overPath);
  } catch (e) {
    if (e.message.includes('ENOENT')) {
      console.error(
        `${overPath} not found. It holds this deployment's hostname, database and policy ` +
        `choices; see docs/CONFIG.md. To deploy the generic config instead, use \`npm run deploy\`.`
      );
      exit(1);
    }
    throw e;
  }

  const merged = merge(readJsonc(basePath), over);
  delete merged.$schema; // relative to the repo root, and meaningless in the generated file
  writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');

  const host = merged.vars?.RP_ID ?? '(unset)';
  console.log(`${outPath} ← ${basePath} + ${overPath}  (name: ${merged.name}, RP_ID: ${host})`);
}
