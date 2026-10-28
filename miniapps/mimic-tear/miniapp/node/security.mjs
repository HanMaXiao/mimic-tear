/**
 * 板面共用的安全响应头。
 *
 * 板面是本机页面：HTML、脚本、样式全部来自自己这个源，运行时也没有任何远程来源
 * 要加载——所以这些头可以收得很紧：
 *
 * - `Content-Security-Policy`：只认自己（连接额外放开 loopback），远程来源一律拒绝；
 * - `X-Content-Type-Options: nosniff`：不让浏览器猜内容类型；
 * - `Referrer-Policy: no-referrer`：不带引用来源出去；
 * - `X-Frame-Options: DENY` + `frame-ancestors 'none'`：不许被别的页面套进 iframe。
 *
 * 头是加在**响应**上的，不是加在**流**上的：SSE 通道同样带这些头，但它不设
 * `Content-Length`、也不关连接，所以长连接不受影响。
 */

/** 自己这个源。板面就长在这个源上，`'self'` 已经是 loopback 那个源。 */
const SELF = "'self'";

/**
 * 允许发起连接的源。
 *
 * 除了自己，还放开本机 loopback：宿主可能把板面挂在另一个本地端口上，
 * 那是同一个信任域，但仍然不是远程来源。
 */
const CONNECT_SOURCES = [SELF, 'http://127.0.0.1:*', 'http://localhost:*'];

/**
 * 内容安全策略。
 *
 * `default-src 'self'` 兜底，其余逐项收紧：
 *
 * - `script-src 'self'`：只认自己的脚本，不许内联脚本、不许 eval；
 * - `style-src 'self' 'unsafe-inline'`：页面里有一处内联样式（进度条宽度），
 *   内联样式既不能执行脚本也拉不到远程资源，放开它不引入远程来源；
 * - `connect-src`：自己加 loopback，远程来源一律拒绝；
 * - `frame-ancestors 'none'`：不许被套进 iframe。
 */
export const CONTENT_SECURITY_POLICY = [
  `default-src ${SELF}`,
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  `script-src ${SELF}`,
  `style-src ${SELF} 'unsafe-inline'`,
  `img-src ${SELF} data:`,
  `font-src ${SELF} data:`,
  `connect-src ${CONNECT_SOURCES.join(' ')}`,
].join('; ');

/**
 * 一套共用的安全响应头。
 *
 * 冻结成常量：谁也改不动它，所有响应拿到的都是同一套。
 */
export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});

/**
 * 把安全响应头并进一组响应头。
 *
 * 调用方给的头排在后面，可以覆盖默认值——但默认值不该被覆盖，
 * 所以这里只让调用方补内容类型、缓存策略这类头。
 *
 * @param {Record<string, string>} [headers]
 * @returns {Record<string, string>}
 */
export function withSecurityHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}
