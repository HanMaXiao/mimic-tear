#!/usr/bin/env node
/**
 * 值班提示词与 boss 技能的**契约检查**：两份仓库外的文本必须说同一件事。
 *
 * ## 为什么要有这个守卫
 *
 * 大哥的值班行为由**两份文本**共同决定，而它们都在**仓库外**：
 *
 * - `~/.minimax/agents/boss/state/cron-prompt-duty-canonical.txt` —— 每轮的操作步骤
 * - `~/.minimax/agents/boss/skills/mimic-tear-boss/SKILL.md` —— 判断依据
 *
 * 主规格 §3.5 的铁律是「改一处就要同步另一处」。但那靠的是**人的自觉**——而这两份文件
 * **不在仓库里，CI 看不见它们**，于是「同步」既没有检查，也没有痕迹。
 *
 * 这个守卫把「同步」变成**可执行的断言**：两份文件都必须提到同一批关键概念。少改一份，
 * 守卫就红。
 *
 * ## 它在 CI 上会跳过
 *
 * CI 上没有 `~/.minimax/agents/boss/`（那是本机的大哥运行时），所以守卫报 **SKIPPED**
 * 并以 0 退出——**不制造假红**。但它把「该同步什么」这件事**写在了仓库里**，本机随时能查。
 *
 * 退出码：0 = 通过或跳过；1 = 有漂移；2 = 用法错误
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..');

const repoRoot = resolve(process.env.MIMIC_TEAR_REPO_ROOT || DEFAULT_REPO_ROOT);

/** 大哥的运行时根目录。 */
const bossRoot = resolve(
  process.env.MIMIC_TEAR_BOSS_ROOT || join(homedir(), '.minimax', 'agents', 'boss'),
);

/** 两份文本：一份是每轮怎么做，一份是凭什么这么判断。 */
const TEXTS = [
  {
    key: 'prompt',
    label: '值班提示词（每轮怎么做）',
    path: join(bossRoot, 'state', 'cron-prompt-duty-canonical.txt'),
  },
  {
    key: 'skill',
    label: 'boss 技能（凭什么这么判断）',
    path: join(bossRoot, 'skills', 'mimic-tear-boss', 'SKILL.md'),
  },
];

/**
 * 两份文本都必须提到的概念。
 *
 * **每一条都对应一个已经落地的机制**——不是「希望它们提到」，是「它们必须知道这件事存在」。
 * 少改一份的后果是具体的：大哥读到的事实表形状变了，它却按老办法读。
 */
const CLAIMS = [
  {
    term: 'triggers.candidates',
    why: '事实表分两层了，「这一轮变了什么」在 triggers.candidates 里',
  },
  {
    term: 'recall',
    why: '长正文被换成摘要，全文要按 ID 取回（patrol-cli recall <id>）',
  },
  {
    term: 'delivered',
    why: '带 delivered 标记的事件已经投出去了，不归大哥管',
  },
  {
    term: 'threads',
    why: '归属表：哪条线有负责会话',
  },
  {
    term: 'patrol-cli answer',
    why: '代答走命令、不再手写 `patrol-answered.json`——那份账已收进单一 store，手写的板面读不到',
  },
  {
    term: 'hostStatus',
    why: '「卡开没开」只认运行时：建议记了不等于卡翻了，`hostStatus` 才是那张卡的开合状态',
  },
  {
    term: 'bossSuggestion',
    why: '待答清单里每张卡带 `bossSuggestion`——给过建议的卡仍在清单里，它还卡着、还没人点',
  },
  {
    term: 'ownerAgent',
    why: '归属表说明这条线由谁承接（`ownerAgent`）、那个负责会话是不是仿身泪滴自己建的（`owned`）',
  },
  {
    term: '有归属的事件不归你管',
    why: '直通真的投出去了：有归属的事件由程序直接投给负责会话，大哥只管没有归属的事',
  },
  {
    term: 'inFlight',
    why: '「在途」是独立的第三个状态——`delivered` 要等负责会话那一轮结束才落盘（滞后 11 分钟），只看它会误判成没投出去',
  },
];

function printHelp() {
  process.stdout.write([
    '用法：node scripts/check-boss-prompt.mjs',
    '',
    '检查大哥的值班提示词与 boss 技能是否都提到了同一批关键概念。',
    '两份文件都不在本机时（例如 CI）报 SKIPPED 并以 0 退出。',
    '',
    '环境变量：',
    '  MIMIC_TEAR_REPO_ROOT   仓库根目录',
    '  MIMIC_TEAR_BOSS_ROOT   大哥运行时目录（默认 ~/.minimax/agents/boss）',
    '',
  ].join('\n'));
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return 0;
  }

  const present = TEXTS.filter((text) => existsSync(text.path));
  if (present.length === 0) {
    process.stdout.write([
      '=== 值班提示词契约检查 ===',
      `大哥运行时目录：${bossRoot}`,
      '结论：SKIPPED —— 这台机器上没有大哥的运行时文件（CI 上就是这种情况）。',
      '',
    ].join('\n'));
    return 0;
  }

  const violations = [];
  const missing = [];
  for (const text of TEXTS) {
    if (!existsSync(text.path)) {
      missing.push(text.label);
      continue;
    }
    const content = await readFile(text.path, 'utf8');
    for (const claim of CLAIMS) {
      if (!content.includes(claim.term)) {
        violations.push(`${text.label}：找不到「${claim.term}」——${claim.why}`);
      }
    }
  }

  process.stdout.write([
    '=== 值班提示词契约检查 ===',
    `大哥运行时目录：${bossRoot}`,
    `检查了 ${present.length} / ${TEXTS.length} 份文本，${CLAIMS.length} 条约定`,
    '',
  ].join('\n'));

  if (missing.length) {
    for (const label of missing) {
      process.stdout.write(`  - 缺文件：${label}\n`);
    }
  }

  if (violations.length === 0) {
    process.stdout.write('结论：两份文本都提到了同一批关键概念，没有漂移。\n');
    return 0;
  }

  process.stdout.write(`发现 ${violations.length} 处漂移：\n`);
  for (const violation of violations) process.stdout.write(`  - ${violation}\n`);
  process.stdout.write('\n结论：值班提示词与 boss 技能没有同步。改一处就要同步另一处（主规格 §3.5）。\n');
  return 1;
}

process.exitCode = await main();
