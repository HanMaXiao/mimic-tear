import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Durable state for the boss's proactive patrol.
 *
 * Two files live next to the other Mini App state:
 *  - `patrol.json`        — findings raised by past patrol runs
 *  - `patrol-config.json` — whether patrol runs, how often, and whether it may dispatch
 *
 * The findings are written by the boss (through the Mini App) and read back by the board,
 * so a patrol that ran while the board was closed is still visible when it reopens.
 */

/**
 * @typedef {{ id:string, createdAt:number, projectId:number|null, projectName:string|null,
 *             severity:'high'|'medium'|'low', title:string, body:string,
 *             acknowledged:boolean }} PatrolFinding
 * @typedef {{ enabled:boolean, intervalMinutes:number, autoDispatch:boolean,
 *             lastRunAt:number|null, lastSignature:string|null }} PatrolConfig
 */

const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 15,
  autoDispatch: false,
  lastRunAt: null,
  lastSignature: null,
};

export class PatrolStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.findingsPath = join(dataDir, 'patrol.json');
    this.configPath = join(dataDir, 'patrol-config.json');
  }

  /** @returns {Promise<PatrolFinding[]>} */
  async list() {
    const value = await readJson(this.findingsPath, []);
    return Array.isArray(value) ? value : [];
  }

  /** @param {PatrolFinding[]} findings */
  async save(findings) {
    await writeJson(this.findingsPath, findings);
    return findings;
  }

  /**
   * @param {Omit<PatrolFinding, 'id'|'createdAt'|'acknowledged'>} input
   * @returns {Promise<PatrolFinding>}
   */
  async add(input) {
    const findings = await this.list();
    const finding = {
      id: `patrol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      acknowledged: false,
      ...input,
    };
    findings.unshift(finding);
    // Keep the history bounded; the board only ever shows the recent tail.
    await this.save(findings.slice(0, 100));
    return finding;
  }

  /** @param {string} id */
  async ack(id) {
    const findings = await this.list();
    const target = findings.find((f) => f.id === id);
    if (target) {
      target.acknowledged = true;
      await this.save(findings);
    }
    return Boolean(target);
  }

  /** @returns {Promise<PatrolConfig>} */
  async getConfig() {
    const value = await readJson(this.configPath, {});
    return { ...DEFAULT_CONFIG, ...(value && typeof value === 'object' ? value : {}) };
  }

  /** @param {Partial<PatrolConfig>} patch */
  async setConfig(patch) {
    const current = await this.getConfig();
    const next = { ...current, ...patch };
    next.intervalMinutes = Math.min(240, Math.max(5, Number(next.intervalMinutes) || 15));
    next.enabled = Boolean(next.enabled);
    next.autoDispatch = Boolean(next.autoDispatch);
    await writeJson(this.configPath, next);
    return next;
  }
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, path);
}

function dirname(path) {
  const index = path.lastIndexOf('\\') > path.lastIndexOf('/')
    ? path.lastIndexOf('\\')
    : path.lastIndexOf('/');
  return index <= 0 ? path.slice(0, 2) : path.slice(0, index);
}
