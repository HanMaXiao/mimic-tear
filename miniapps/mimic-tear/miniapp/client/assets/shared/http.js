/**
 * 请求封装。
 *
 * 所有读都走 GET、所有改都走 POST，出错时把服务端的说法原样抛出来。
 */

/**
 * One read or one write against the board's API.
 *
 * @param {string} path
 * @param {any} [options]
 * @returns {Promise<any>}
 */
export async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.code = payload?.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}
