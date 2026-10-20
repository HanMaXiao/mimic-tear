/**
 * Duty rounds, grouped for the conversation.
 *
 * The duty boss runs on its own cron session, so the Host chat side panel — which shows
 * exactly one session — never shows the rounds. The rounds *are* the user seeing the boss
 * walk between projects, so they belong in the conversation too.
 *
 * The rounds are not moved into the conversation: steering a running turn would cut off
 * whatever the user is saying. They are surfaced there, as the boss's own reports.
 *
 * Grouping is by time, not by a stored round id: findings carry no round id, but a round
 * writes all of its findings within the same second, and rounds are 30 minutes apart.
 * A one-minute window therefore separates rounds reliably without inventing a schema.
 */

/**
 * How close two findings have to be to belong to the same round.
 *
 * A round writes its findings in one batch, so they share a timestamp. Rounds are 30
 * minutes apart. Anything within a minute is the same round; anything further apart is
 * a different one.
 */
const ROUND_WINDOW_MS = 60_000;

/**
 * @typedef {{
 *   startedAt:number,
 *   findings:Array<{id:string, severity:string, title:string, projectName:string|null,
 *                    acknowledged:boolean, acknowledgedBy:string|null}>,
 *   counts:{high:number, medium:number, low:number},
 * }} DutyRound
 */

/**
 * Group patrol findings into duty rounds, newest first.
 *
 * @param {Array<{id:string, createdAt:number, severity:string, title:string,
 *                projectName?:string|null, acknowledged?:boolean, acknowledgedBy?:string|null}>} findings
 * @param {{ windowMs?:number, limit?:number }} [options]
 * @returns {DutyRound[]}
 */
export function buildDutyRounds(findings, options = {}) {
  const windowMs = options.windowMs ?? ROUND_WINDOW_MS;
  const limit = options.limit ?? 20;

  const sorted = (Array.isArray(findings) ? findings : [])
    .filter((f) => f && typeof f.createdAt === 'number')
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  /** @type {DutyRound[]} */
  const rounds = [];
  for (const finding of sorted) {
    const head = rounds[0];
    // The newest round is the head; a finding joins it when it lands in the same window.
    if (head && head.startedAt - finding.createdAt < windowMs) {
      head.findings.push({        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        projectName: finding.projectName ?? null,
        acknowledged: Boolean(finding.acknowledged),
        acknowledgedBy: finding.acknowledgedBy ?? null,
      });
      head.counts[finding.severity] = (head.counts[finding.severity] ?? 0) + 1;
      continue;
    }
    rounds.push({
      startedAt: finding.createdAt,
      findings: [{
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        projectName: finding.projectName ?? null,
        acknowledged: Boolean(finding.acknowledged),
        acknowledgedBy: finding.acknowledgedBy ?? null,
      }],
      counts: {
        high: finding.severity === 'high' ? 1 : 0,
        medium: finding.severity === 'medium' ? 1 : 0,
        low: finding.severity === 'low' ? 1 : 0,
      },
    });
  }

  return rounds.slice(0, limit);
}
