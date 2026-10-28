/**
 * 领域层的业务错误。
 *
 * 一个错误带着两样东西：给机器看的稳定错误码，和给 HTTP 用的状态码。Host 的路由层只负责
 * 把它们翻译成响应，领域层自己说清楚「这是哪一类错」。
 */

/** 一条带 HTTP 状态和稳定机器码的业务错误。 */
export class DomainError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}
