import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read the client as a whole, not as one file.
 *
 * The client used to be a single `assets/app.js`. It is now a tree of native ES modules
 * under `assets/` — `shared/api.js`, `views/overview.js`, `runtime/router.js` and so on.
 *
 * Several tests read the client's source to check contracts: that the endpoints it calls
 * are the ones the server exposes, that the fields it reads are the ones the server
 * returns. Those checks are about the client as a whole, so they must read the client as a
 * whole. Reading one file made them silently check less every time the client was
 * reorganised — and then fail for the wrong reason, or worse, pass while checking
 * nothing.
 *
 * Concatenating the files is enough: these tests parse the source as text, they do not
 * execute it. Each file is separated by a statement terminator and a newline so a comment
 * at the end of one file can never swallow the start of the next.
 */

/**
 * Every file of a kind under a directory, keyed by its path relative to that directory.
 *
 * @param {string} dir
 * @param {string} extension e.g. '.js'
 * @returns {Promise<Record<string, string>>}
 */
export async function readSources(dir, extension) {
  const out = {};
  for (const rel of await listFiles(dir)) {
    if (!rel.endsWith(extension)) continue;
    out[rel] = await readFile(join(dir, ...rel.split('/')), 'utf8');
  }
  return out;
}

/**
 * The client's JavaScript source, as one text.
 *
 * @param {string} clientDir the `miniapp/client` directory
 * @returns {Promise<string>}
 */
export async function readClientSource(clientDir) {
  const sources = await readSources(join(clientDir, 'assets'), '.js');
  const parts = Object.entries(sources)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([rel, source]) => `// ===== ${rel} =====\n${source}`);
  if (parts.length === 0) throw new Error('客户端的 assets 目录里一个 js 文件都没有');
  // The terminator keeps one file's trailing comment from swallowing the next file's
  // first line; the newlines keep the line numbers meaningful.
  return parts.join('\n;\n');
}

/**
 * The client's stylesheet source, as one text.
 *
 * @param {string} clientDir the `miniapp/client` directory
 * @returns {Promise<string>}
 */
export async function readClientStyles(clientDir) {
  const sources = await readSources(join(clientDir, 'assets'), '.css');
  const parts = Object.entries(sources)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([rel, source]) => `/* ===== ${rel} ===== */\n${source}`);
  if (parts.length === 0) throw new Error('客户端的 assets 目录里一个 css 文件都没有');
  return parts.join('\n');
}

/**
 * Every file under a directory, as relative paths with forward slashes.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  const out = [];
  const walk = async (current, prefix) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}
