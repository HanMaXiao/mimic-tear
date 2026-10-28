/**
 * 派工写路径上的纯函数。
 *
 * 写路径只有一条：校验 → 提交 → 广播。这条路径上的**判断**都在这儿，全是纯函数，所以能被
 * 直接测：什么算合法输入、记录长什么样、给大哥的载荷长什么样、返回给调用方的结果长什么
 * 样。
 *
 * 注意这里只有「算」，没有「存」：落盘仍然由 ProjectService 负责——它是唯一的写入口。
 */

import { DomainError } from './domain-error.mjs';

/**
 * 校验一次派工请求，并把它归一成三个字段。
 *
 * 幂等键是必需的：同一个键重复提交必须是同一次投递，不能投递两遍。
 *
 * @param {{ projectId?:number, sessionId?:string|null, instruction?:string, idempotencyKey?:string }} input
 * @returns {{ projectId:number, instruction:string, idempotencyKey:string }}
 * @throws {DomainError} 参数不合法时抛出，带稳定的错误码
 */
export function validateDispatchRequest(input) {
  const projectId = Number(input?.projectId);
  const instruction = typeof input?.instruction === 'string' ? input.instruction.trim() : '';
  const idempotencyKey = typeof input?.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';

  if (!Number.isFinite(projectId)) {
    throw new DomainError('invalid_project_id', '缺少有效的项目 ID');
  }
  if (!instruction) {
    throw new DomainError('empty_instruction', '下达的指令不能为空');
  }
  if (!idempotencyKey) {
    throw new DomainError('missing_idempotency_key', '缺少幂等键');
  }

  return { projectId, instruction, idempotencyKey };
}

/**
 * 造一条待投递的派工记录。
 *
 * `source` 写死成 `board`：这条记录是看板的派工按钮写的。值班路径用运行时自己的
 * `session send` 投递，它写进同一本账的记录由值班那侧标成 `duty`。
 *
 * @param {{ projectId:number, projectName:string, targetSessionId:string|null,
 *           instruction:string, idempotencyKey:string, now?:number }} input
 * @returns {any}
 */
export function buildDispatchRecord(input) {
  const now = input?.now ?? Date.now();
  return {
    id: `dsp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: input.idempotencyKey,
    // Which path wrote this record. The duty path writes its own records into the
    // same ledger, so the two can be told apart.
    source: 'board',
    projectId: input.projectId,
    projectName: input.projectName,
    targetSessionId: input.targetSessionId,
    instruction: input.instruction,
    status: 'queued',
    bossSessionId: null,
    text: '',
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 造给大哥的投递载荷。
 *
 * 项目名与路径优先取看板自己看到的卡片（最新的），取不到就退回记录里存的值——值班那条
 * 记录只有会话，没有项目。
 *
 * @param {any} record
 * @param {any} [card]
 * @param {any} [targetSession]
 * @returns {{ projectId:number, projectName:string, projectPath:string,
 *             sessionId:string|null, sessionTitle:string|null, instruction:string }}
 */
export function buildDispatchPayload(record, card, targetSession) {
  return {
    projectId: record.projectId,
    projectName: card?.name ?? record.projectName,
    projectPath: card?.path ?? '',
    sessionId: targetSession?.id ?? null,
    sessionTitle: targetSession?.title ?? null,
    instruction: record.instruction,
  };
}

/**
 * 造一次派工的结果。
 *
 * 三条出口共用这一个形状：重复提交（幂等键命中）、投递成功、投递失败。
 *
 * @param {any} record
 * @param {{ duplicate?:boolean }} [options]
 * @returns {{ dispatchId:string, status:string, bossSessionId:string|null, text:string,
 *             error:string|null, delivered:boolean, duplicate:boolean }}
 */
export function dispatchResult(record, options = {}) {
  return {
    dispatchId: record.id,
    status: record.status,
    bossSessionId: record.bossSessionId,
    text: record.text,
    error: record.error,
    delivered: record.status === 'done',
    duplicate: Boolean(options?.duplicate),
  };
}
