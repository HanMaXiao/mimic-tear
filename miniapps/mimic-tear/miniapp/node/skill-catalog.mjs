import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Scans the installed skill libraries and groups them into capability domains.
 *
 * The domains are the boss's dispatch knowledge: they answer "this kind of project needs
 * which expertise", not "which skill should a human run".
 *
 * @typedef {'user'|'builtin'|'project'} SkillSource
 * @typedef {{ label: string, source: SkillSource, dir: string }} SkillRoot
 * @typedef {{ name: string, description: string, source: string, path: string }} SkillEntry
 * @typedef {{ skills: SkillEntry[], failures: { path: string, reason: string }[] }} SkillScan
 * @typedef {{ key: string, label: string, match: string[], keywords?: string[] }} DomainDef
 * @typedef {{ key: string, label: string, skills: SkillEntry[] }} DomainGroup
 */

/**
 * Scan skill roots for `SKILL.md` files.
 * @param {SkillRoot[]} roots
 * @returns {Promise<SkillScan>}
 */
export async function scanSkills(roots) {
  /** @type {SkillEntry[]} */
  const skills = [];
  /** @type {{ path: string, reason: string }[]} */
  const failures = [];

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch (error) {
      failures.push({ path: root.dir, reason: describe(error) });
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(root.dir, entry.name, 'SKILL.md');
      try {
        const raw = await readFile(skillFile, 'utf8');
        const meta = parseFrontmatter(raw);
        skills.push({
          name: meta.name || entry.name,
          description: meta.description || '',
          source: root.source,
          path: skillFile,
        });
      } catch (error) {
        failures.push({ path: skillFile, reason: describe(error) });
      }
    }
  }

  return { skills, failures };
}

/**
 * Read `name` and `description` from a SKILL.md YAML frontmatter block.
 *
 * A line scanner is used instead of a YAML parser so the package stays dependency-free.
 * Block scalars (`description: |`) are supported because several skills use them.
 *
 * @param {string} raw
 * @returns {{ name: string, description: string }}
 */
export function parseFrontmatter(raw) {
  const result = { name: '', description: '' };
  if (!raw) return result;

  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      start = i;
      break;
    }
  }
  if (start === -1) return result;

  let inBlock = false;
  let blockKey = '';

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') break;

    if (inBlock) {
      if (line.trim() === '' || /^\s/.test(line)) {
        if (blockKey === 'description') result.description += `${line.trim()} `;
        continue;
      }
      inBlock = false;
    }

    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();

    if (value === '|' || value === '>' || /^[|>][-+]?\d*$/.test(value)) {
      inBlock = true;
      blockKey = key;
      if (key === 'name') result.name = '';
      continue;
    }
    if (key === 'name') result.name = stripQuotes(value);
    if (key === 'description') result.description = stripQuotes(value);
  }

  result.description = result.description.trim();
  return result;
}

/**
 * Group skills into capability domains.
 *
 * A skill joins the first domain whose `match` prefix hits its name, or whose `keywords`
 * occur in its name or description. Skills that match nothing stay in `unmapped`.
 *
 * @param {SkillEntry[]} skills
 * @param {DomainDef[]} domains
 * @returns {{ groups: DomainGroup[], unmapped: SkillEntry[] }}
 */
export function classify(skills, domains) {
  /** @type {Map<string, DomainGroup>} */
  const groups = new Map();
  for (const domain of domains) {
    groups.set(domain.key, { key: domain.key, label: domain.label, skills: [] });
  }

  /** @type {SkillEntry[]} */
  const unmapped = [];

  for (const skill of skills) {
    const domain = findDomain(skill, domains);
    if (!domain) {
      unmapped.push(skill);
      continue;
    }
    groups.get(domain.key).skills.push(skill);
  }

  const ordered = domains
    .map((domain) => groups.get(domain.key))
    .filter((group) => group.skills.length > 0);

  return { groups: ordered, unmapped };
}

/**
 * Find the domain a skill belongs to.
 *
 * The `match` prefixes are matched against the skill name. The `keywords` fallback is also
 * name-only: matching against the description produced confident misfilings (a design skill
 * that merely mentions "unreal" landed in the UE5 domain), and a skill that belongs nowhere
 * is better shown as unmapped than filed under the wrong expertise.
 *
 * @param {SkillEntry} skill
 * @param {DomainDef[]} domains
 * @returns {DomainDef | null}
 */
function findDomain(skill, domains) {
  const name = skill.name.toLowerCase();

  for (const domain of domains) {
    for (const prefix of domain.match ?? []) {
      if (name.startsWith(prefix.toLowerCase())) return domain;
    }
  }
  for (const domain of domains) {
    for (const keyword of domain.keywords ?? []) {
      if (name.includes(keyword.toLowerCase())) return domain;
    }
  }
  return null;
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function describe(error) {
  return error?.message ?? String(error);
}
