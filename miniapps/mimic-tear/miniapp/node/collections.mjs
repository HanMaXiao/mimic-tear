/**
 * 纯集合工具。
 *
 * 这些函数不碰 IO、不读时钟、不改入参，所以放在一起共享一份实现：项目卡和收件箱都要按
 * 键分组运行时行，两边各写一份的话，分组口径迟早会漂。
 */

/**
 * 按键把若干行分组。
 *
 * 键为 `null` / `undefined` 的行不进任何一组——它们没有归属，按项目或会话统计时不该被
 * 算到某个项目头上。
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => any} keyOf
 * @returns {Map<any, T[]>}
 */
export function groupBy(items, keyOf) {
  /** @type {Map<any, any[]>} */
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}
