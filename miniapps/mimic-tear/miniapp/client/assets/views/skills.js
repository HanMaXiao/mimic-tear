/**
 * 能力库。
 *
 * 两个列表，两个问题：左边是这台机器上装了什么，右边是大哥从真实执行里封装了什么。
 */

import { el } from '../shared/dom.js';
import { escapeHtml } from '../shared/format.js';
import { state } from '../shared/state.js';
import { renderHeaderContext } from '../runtime/frame.js';
// 已封装技能库的渲染函数留在入口文件里（旧的契约测试直接按源码抠取它来跑），
// 这里照旧调用它。
import { renderSkillLibrary } from '../app.js';

/**
 * Draw the capability scan, by domain.
 */
export function renderSkills() {
  const scan = state.skills;
  const nav = el('domain-nav');
  const list = el('skill-list');

  if (!scan) {
    list.innerHTML = '<div class="state">正在加载能力库…</div>';
    return;
  }

  el('skills-count').textContent = `${scan.total} 个技能 · ${scan.unmapped.length} 个未归类`
    + (scan.failures ? ` · ${scan.failures} 个目录扫描失败` : '');

  const domains = [
    ...scan.groups.map((group) => ({ key: group.key, label: group.label, count: group.skills.length, skills: group.skills })),
    { key: '__unmapped', label: '未归类', count: scan.unmapped.length, skills: scan.unmapped },
  ];

  if (!state.domain || !domains.some((domain) => domain.key === state.domain)) {
    state.domain = domains[0]?.key ?? null;
  }

  nav.innerHTML = domains
    .map(
      (domain) => `<button type="button" data-domain="${escapeHtml(domain.key)}" aria-pressed="${domain.key === state.domain}">
        <span>${escapeHtml(domain.label)}</span><span class="count">${domain.count}</span>
      </button>`,
    )
    .join('');

  const current = domains.find((domain) => domain.key === state.domain);
  if (!current) {
    list.innerHTML = '<div class="empty">没有可显示的技能。</div>';
    return;
  }
  list.innerHTML = current.skills.length
    ? current.skills
        .map(
          (skill) => `<div class="skill-row">
            <span class="skill-row__name">${escapeHtml(skill.name)}</span>
            ${skill.description ? `<span class="skill-row__desc">${escapeHtml(skill.description)}</span>` : ''}
            <span class="item__meta mono">${escapeHtml(skill.path)}</span>
          </div>`,
        )
        .join('')
    : '<div class="empty">该领域下没有技能。</div>';
  renderSkillLibrary();
  renderHeaderContext();
}
