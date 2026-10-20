import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scanSkills, classify, parseFrontmatter } from '../miniapps/mimic-tear/miniapp/node/skill-catalog.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const DOMAINS = [
  { key: 'unreal', label: 'UE5 引擎', match: ['ue5-', 'unreal'], keywords: ['unreal'] },
  { key: 'frontend', label: '前端', match: ['frontend-design'], keywords: ['design'] },
];

function makeSkill(root, dirName, frontmatter) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), frontmatter, 'utf8');
}

test('skill-catalog', async (t) => {
  await t.test('解析 frontmatter 的 name 与 description', () => {
    const raw = `---
name: ue5-cpp-gameplay
description: UE5 C++ gameplay module routing and best practices.
---

# Body

Not frontmatter.
`;
    const meta = parseFrontmatter(raw);
    assert.equal(meta.name, 'ue5-cpp-gameplay');
    assert.equal(meta.description, 'UE5 C++ gameplay module routing and best practices.');
  });

  await t.test('frontmatter 缺失时返回空值', () => {
    assert.deepEqual(parseFrontmatter('# just a heading'), { name: '', description: '' });
    assert.deepEqual(parseFrontmatter(''), { name: '', description: '' });
  });

  await t.test('块标量 description 会被拼接', () => {
    const raw = `---
name: some-skill
description: |
  第一行说明。
  第二行说明。
---
`;
    const meta = parseFrontmatter(raw);
    assert.equal(meta.name, 'some-skill');
    assert.match(meta.description, /第一行说明/);
    assert.match(meta.description, /第二行说明/);
  });

  await t.test('扫描技能目录，坏目录进入 failures', async () => {
    const root = tmpDir();
    try {
      makeSkill(root, 'ue5-cpp-gameplay', '---\nname: ue5-cpp-gameplay\ndescription: gameplay\n---\n');
      makeSkill(root, 'frontend-design', '---\nname: frontend-design\ndescription: ui/ux helper\n---\n');
      // A directory without SKILL.md must be reported, not crash the scan.
      mkdirSync(join(root, 'broken-dir'), { recursive: true });

      const scan = await scanSkills([{ label: 'user', source: 'user', dir: root }]);

      assert.equal(scan.skills.length, 2);
      assert.equal(scan.failures.length, 1);
      assert.match(scan.failures[0].path, /broken-dir/);
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('扫描不存在的根目录时记入 failures，不抛错', async () => {
    const scan = await scanSkills([{ label: 'missing', source: 'user', dir: join(tmpDir(), 'nope') }]);
    assert.equal(scan.skills.length, 0);
    assert.equal(scan.failures.length, 1);
  });

  await t.test('缺少 name 时用目录名兜底', async () => {
    const root = tmpDir();
    try {
      makeSkill(root, 'nameless-skill', '---\ndescription: 只有描述\n---\n');
      const scan = await scanSkills([{ label: 'user', source: 'user', dir: root }]);
      assert.equal(scan.skills[0].name, 'nameless-skill');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('按名称前缀归类，未命中的进入 unmapped', () => {
    const skills = [
      { name: 'ue5-cpp-gameplay', description: 'gameplay', source: 'user', path: 'a' },
      { name: 'frontend-design', description: 'design', source: 'user', path: 'b' },
      { name: 'something-else', description: 'nothing matches', source: 'user', path: 'c' },
    ];

    const { groups, unmapped } = classify(skills, DOMAINS);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].key, 'unreal');
    assert.equal(groups[0].skills.length, 1);
    assert.equal(groups[1].key, 'frontend');
    assert.equal(unmapped.length, 1);
    assert.equal(unmapped[0].name, 'something-else');
  });

  await t.test('名称不匹配时用名称关键词兜底', () => {
    const skills = [
      { name: 'my-design-helper', description: 'helper', source: 'user', path: 'a' },
    ];
    const { groups, unmapped } = classify(skills, DOMAINS);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'frontend');
    assert.equal(unmapped.length, 0);
  });

  await t.test('描述里出现关键词不会被归类（避免误归档）', () => {
    const skills = [
      { name: 'industrial-brutalist-ui', description: '提到 unreal 的工业风界面', source: 'user', path: 'a' },
    ];
    const { groups, unmapped } = classify(skills, DOMAINS);

    assert.equal(groups.length, 0, '只靠描述命中会误归档，不应产生分组');
    assert.equal(unmapped.length, 1);
    assert.equal(unmapped[0].name, 'industrial-brutalist-ui');
  });

  await t.test('空分组不返回', () => {
    const { groups } = classify([], DOMAINS);
    assert.equal(groups.length, 0);
  });
});
