/**
 * Which cron definitions are the duty chain — and which one is actually the target.
 *
 * The scheduler was re-pointed on 2026-10-22 05:57: the duty cron's target session changed,
 * and the runtime created a **new cron definition** for it (`2a1d79e8…`, alive) and deleted
 * the old one (`672fde94…`). The two share the **name** 「大哥值班巡检」 but not the scheduler
 * id — nothing but the name ties them together.
 *
 * A hardcoded cron id therefore points at a dead chain, and the symptom is the worst kind:
 * the watchdog sees no runs at all and reports "nothing went wrong". That is exactly what
 * happened on 2026-10-22, and it is why the chain is resolved by name:
 *
 * - **all** definitions with that name are read (deleted ones included), so the historical
 *   evidence survives a re-point — the cumulative missed rounds do not reset;
 * - the **alive** definition (`deleted_at_ms IS NULL`) is the target: it says where the duty
 *   rounds go now, and it is what "the target exists and is not deleted" checks.
 *
 * Names are stable; ids are not. That is the whole lesson.
 */

/**
 * The duty cron's name — the stable handle.
 *
 * @type {string}
 */
export const DUTY_CRON_NAME = '大哥值班巡检';

/**
 * A fallback seed, used only to find the family when nothing is pinned.
 *
 * It points at a definition that has since been deleted; that is exactly why it cannot be
 * the primary handle. The *name* is the handle.
 *
 * @type {string}
 */
export const DUTY_CRON_SEED = '672fde94-0c52-466d-831e-e2919f49b64a';

/**
 * Resolve the duty chain from the cron definitions.
 *
 * @param {Array<{cronId:string,name:string,deletedAt:number|null,targetSessionId:string|null,schedulerId:string|null}>} definitions
 * @param {{ seedCronId?:string|null, name?:string }} [options]
 * @returns {{name:string, cronIds:string[], activeCronIds:string[], active:boolean,
 *            targetCronId:string|null, targetSessionId:string|null, reason:string,
 *            pinnedCronId:string|null}}
 */
export function resolveDutyChain(definitions, options = {}) {
  const all = Array.isArray(definitions) ? definitions : [];
  // Two different things arrive here, and they must not be confused:
  //
  //  - **the pin**: the cron id the user set in `patrol-config.json`. If that id has been
  //    deleted, the configuration is stale and we say so loudly — the node side must not
  //    quietly read a different cron than the one that was asked for.
  //  - **the seed**: the built-in fallback, used only to find the chain's *family* (the cron
  //    name). It points at a definition that has since been deleted, and treating it as a
  //    pin would make every install that has not pinned anything report "misconfigured".
  //
  // The seed is recognised by identity, because that is exactly what it is: the built-in
  // fallback, not something the user chose.
  const requestedId = String(options.pinnedCronId ?? options.seedCronId ?? '').trim();
  const requested = requestedId ? all.find((d) => d.cronId === requestedId) : null;
  const isPin = requestedId !== '' && requestedId !== DUTY_CRON_SEED;
  const pinned = isPin ? requested : null;

  // The requested definition gives us its name; without one, the duty name is the handle.
  const name = requested?.name ?? options.name ?? DUTY_CRON_NAME;
  const family = all.filter((d) => d.name === name);
  const alive = family.filter((d) => !d.deletedAt);

  // A pinned id that has been deleted is a misconfiguration, not a hint to fall back: the
  // user asked for a specific cron and that cron is gone. Say so instead of quietly
  // reading a different one — that is how the 05:57 re-point turned into "no evidence,
  // nothing wrong".
  const pinnedDead = Boolean(pinned && pinned.deletedAt);
  const active = alive.length > 0 && !pinnedDead;

  return {
    name,
    cronIds: family.map((d) => d.cronId),
    activeCronIds: alive.map((d) => d.cronId),
    active,
    targetCronId: alive[0]?.cronId ?? null,
    targetSessionId: alive[0]?.targetSessionId ?? null,
    reason: pinnedDead ? 'target_deleted' : (alive.length ? 'ok' : 'not_found'),
    pinnedCronId: isPin ? requestedId : null,
  };
}

/**
 * Read the duty chain's runs — every generation of it, merged by time.
 *
 * The runs are the evidence; the cron definitions only say where they came from. Reading
 * the whole family is what keeps the cumulative missed rounds intact across a re-point.
 *
 * @param {{listCronDefinitions?:Function, listCronRunsFor?:Function}} store
 * @param {{seedCronId?:string|null, name?:string}} [options]
 * @returns {{chain:ReturnType<typeof resolveDutyChain>, runs:any[]}}
 */
export function readDutyChain(store, options = {}) {
  const definitions = typeof store?.listCronDefinitions === 'function' ? store.listCronDefinitions() : [];
  const chain = resolveDutyChain(definitions, options);
  const runs = typeof store?.listCronRunsFor === 'function' && chain.cronIds.length
    ? store.listCronRunsFor(chain.cronIds)
    : [];
  return { chain, runs };
}
