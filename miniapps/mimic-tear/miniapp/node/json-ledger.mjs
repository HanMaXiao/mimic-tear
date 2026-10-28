import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

/**
 * One write discipline for the Mini App's JSON state files.
 *
 * The board's own state directory has files with more than one writer:
 *
 *  - `dispatches.json` — the board's dispatch path (`persistence.mjs`, a long-running Node
 *    process) and the duty path (`patrol-store.mjs`, its own process). Both do
 *    read-modify-write.
 *  - `patrol.json` — the same, between the board and `patrol-cli`.
 *
 * Two read-modify-write writers on one file need three things, and all three were missing
 * at least once:
 *
 *  1. **A unique temporary file name.** With a fixed `<path>.tmp`, one writer's rename
 *     moves the file out from under the other. The second rename fails — and the file that
 *     survives can be a half-written document that was renamed mid-flight. A reader then
 *     cannot parse it. When the reader also swallowed the parse error and answered "there
 *     is nothing here", a dispatch record that existed on disk silently read back as
 *     missing — which breaks the board's idempotency, because the same instruction would
 *     then be delivered twice.
 *  2. **A merge, not an overwrite.** A plain overwrite drops whatever the other side
 *     wrote in the meantime.
 *  3. **Mutual exclusion.** Merging is not enough on its own: two writers can both read
 *     the old file, both merge, and the second rename wins with a copy that never saw the
 *     first writer's record. A lock around the whole read-merge-write closes that window.
 *     The lock is a directory, because `mkdir` is atomic on Windows and on POSIX alike —
 *     and because the duty path is a separate process, an in-process mutex would not do.
 *
 * The same discipline was already proven in `patrol-store.mjs` for the duty handover
 * timestamp (spec §15.8). This module is that discipline, extracted so there is one
 * implementation instead of two that can drift apart.
 */

/** A lock older than this is assumed to belong to a process that died. */
const LOCK_STALE_MS = 30_000;

/** How long to wait for a lock before giving up. */
const LOCK_TIMEOUT_MS = 15_000;

/**
 * Read a JSON array file.
 *
 * A missing file is an empty list — nothing has been written yet. A file that exists but
 * cannot be parsed is NOT an empty list: the state is damaged, and reporting it as "nothing
 * here" is exactly how a record that exists on disk reads back as missing.
 *
 * @param {string} path
 * @returns {Promise<any[]>}
 */
export async function readJsonArray(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} 里的内容不是合法 JSON：${error?.message ?? error}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} 不是一个数组`);
  }
  return parsed;
}

/**
 * Merge one record into a JSON array file, without losing anybody else's records.
 *
 * The whole read-merge-write happens under the file's lock, so no other writer can slip in
 * between our read and our rename. Afterwards we check that our own record survived; if it
 * did not, we write it again.
 *
 * @param {string} path
 * @param {(all: any[]) => any[]} mutate apply the change to a fresh copy of the array
 * @param {string} expectedId the record that must survive the write
 * @returns {Promise<void>}
 */
export async function updateJsonArray(path, mutate, expectedId) {
  const release = await acquireLock(`${path}.lock`);
  try {
    // A damaged ledger is refused, not overwritten. Starting over would throw away the
    // records we can no longer read — and the board's idempotency lives in them: a lost
    // key means the same instruction gets delivered twice. A loud failure is recoverable;
    // a silently emptied ledger is not.
    const current = await readJsonArray(path);
    const merged = mutate([...current]);
    await writeJsonAtomic(path, merged);

    const after = await readJsonArray(path);
    if (after.some((item) => item?.id === expectedId || item === expectedId)) return;
    // Our record was the one that got dropped. Write it again — the merge is by id, so
    // this cannot duplicate it.
    const healed = mutate([...after]);
    await writeJsonAtomic(path, healed);
  } finally {
    await release();
  }
}

/**
 * Write a whole JSON document, atomically.
 *
 * @param {string} path
 * @param {any} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(path, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = temporaryPath(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, payload, 'utf8');
    await renameWithRetry(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Take the write lock for a file.
 * `mkdir` is atomic, so it is the lock: the first writer wins and the others wait. A lock
 * older than {@link LOCK_STALE_MS} belongs to a process that died mid-write, so it is
 * broken rather than waited on forever.
 *
 * @param {string} lockPath
 * @returns {Promise<() => Promise<void>>} the release function
 */
async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // The lock lives next to the file it protects, so its directory has to exist first.
  await mkdir(dirname(lockPath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      // Not `recursive`: the directory must fail with EEXIST when somebody else holds it,
      // which is what makes this an atomic lock.
      await mkdir(lockPath);
      await writeFile(joinPath(lockPath, 'owner'), `${process.pid}\n`, 'utf8').catch(() => undefined);
      return async () => { await rm(lockPath, { recursive: true, force: true }); };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
  throw new Error(`拿不到 ${lockPath} 的写锁`);
}

/**
 * A temporary file name that no other write can collide with.
 *
 * @param {string} path
 * @returns {string}
 */
function temporaryPath(path) {
  return `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Rename, retrying the failures Windows produces when a file is momentarily open.
 *
 * Windows refuses to rename over a file another handle still has open (EPERM), and refuses
 * to rename a file that is being scanned (EBUSY). Both are transient, so a short backoff
 * turns them into a delay instead of a lost write.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
async function renameWithRetry(from, to) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = error?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
      await delay(15 * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function delay(milliseconds) {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, milliseconds); });
}

/**
 * @param {string} path
 * @returns {string}
 */
function dirname(path) {
  const index = path.lastIndexOf('\\') > path.lastIndexOf('/')
    ? path.lastIndexOf('\\')
    : path.lastIndexOf('/');
  return index <= 0 ? path.slice(0, 2) : path.slice(0, index);
}

/**
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function joinPath(dir, name) {
  const separator = dir.includes('\\') ? '\\' : '/';
  return `${dir}${separator}${name}`;
}
