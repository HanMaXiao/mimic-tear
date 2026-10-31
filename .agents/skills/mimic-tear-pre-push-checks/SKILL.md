---
name: mimic-tear-pre-push-checks
description: |
  Use this skill when 要提交或推送这个仓库的改动之前——
  按 diff 的实际影响面选检查，而不是把全套跑一遍；以及共享工作树里的提交纪律。
  Trigger phrases: 提交前 / 推之前 / 跑一下测试 / 能提交了吗 / 提交纪律 /
  git add / pre-commit / 要不要跑全套。
  Do NOT use it to 做发布与运行副本的验收（那是 mimic-tear-release-verification）。
---

# 推送前的检查与提交纪律

## 提交纪律（先看这条）

**这个仓库里不许用会扫全树的提交方式。**

```sh
git add -A        # 错
git add .         # 错
git commit -a     # 错
```

原因很实在：仓库里可能同时有**另一个 agent 的在制品**（写到一半的改动）。全树扫会把人家的半成品一起卷进同一个 commit。

**只允许两种形式：**

**① 路径限定**

```sh
git commit -F <msg> -- <path1> <path2> ...
```

**② 补丁快照**（改动的是共享文件时用）

```sh
git diff --output=<patch> -- <shared>
git apply --cached <patch>
git diff --cached          # 确认暂存的正是自己的改动
git commit -F <msg>
git show --stat HEAD       # 确认提交内容对
```

**动手前先看清工作树**：

```sh
git status --short
```

别的 agent 的在制品长什么样——**一个你说不清来路的改动，就不是你的**。先确认再动手。

> 本机可以装 `pre-commit` 钩子（`node scripts/install-hooks.mjs`）帮你兜底：它管「提交范围」和「别碰别人工作树里的脏文件」两条。但**钩子默认不装、故意 fail-open、也不在 CI 里**——它是提醒，不是保证。理由见 [`docs/plans/2026-10-22-line-ownership.md`](../../../docs/plans/2026-10-22-line-ownership.md) §3。

## 按影响面选检查

**没有「一律跑全套」这条规矩。** 每条命令都要能对上 diff 里的某个行为——对上不上的检查就是浪费。

| 改动碰到了 | 跑什么 |
| --- | --- |
| 任何行为改动 | `node --test`（**全套**——这个仓库的测试就是一条命令，没有分包） |
| API 路由 / SSE 事件 / 客户端接口 | `node --test tests/api-contract.test.mjs tests/security.test.mjs tests/client-contract.test.mjs`，然后全套 |
| 改了 `miniapps/mimic-tear/` 下的源码 | 三个守卫脚本（见下） |
| 改了 `docs/specs/` | `node --test tests/api-contract.test.mjs`（规格 §5 被契约测试读） |
| 改了 `.agents/notes/` | `node scripts/verify-agent-notes.mjs` |
| 改了 `scripts/` 下的守卫 | `node --test tests/packaging.test.mjs` |
| 改了发布副本相关的部署 | 见 `miniapps/mimic-tear/skills/mimic-tear-release-verification/` |

**别重复跑已经通过的检查。** 提交之前不需要为了「看起来严谨」再跑一遍刚跑过的。

## 三个守卫

```sh
node scripts/check-published.mjs   # 发布副本 vs 仓库，有漂移就红
node scripts/check-package.mjs     # 零依赖、零本机路径泄漏
node scripts/check-style.mjs       # 运行时无 console、源码无 TODO/FIXME、客户端无 emoji
```

三者都是零依赖的 Node 脚本，退出码 0/1/2。**CI 里就是这三步**，本地跑一遍能在提交前就发现。

## 本地跑全套

```sh
node --test
```

**注意它不是零副作用**：会创建/删除/恢复 Windows 计划任务 `MimicTear-DutyWatchdog`（`tests/watchdog-alerts.test.mjs`）。这是**必要的**——那个任务必须被真的动过才算验收到——但要知道它在做什么。

**条数不要写死。** 文档里写死的测试条数一次次过期过。要数字就跑一次 `node --test` 看最后几行。

## 推送

```sh
git push -u origin <branch>
```

- `main` 受保护，**改动走 PR**，CI 绿了才合，用 **Squash and merge**。
- **禁止强推、禁止删分支。**
- 推完看一眼远端 CI 状态；没跑起来的时候先看 PR 的可合并状态，别急着怀疑推送。

## 报告怎么写

**只报告你真的跑过的命令和它们的真实输出。**

- 没跑的检查，写「没跑」，不写「应该没问题」。
- 没验证的结论，写「未验证」。
- **别用「实现无误」代替「未通过项如实报告为未验证」。**
