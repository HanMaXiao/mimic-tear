# 技能目录

这个目录下的技能分两类：**随插件分发**的和**项目自用**的。两类的区别只在「会不会被发出去」这一条上，技能内容本身都是一样的。

| 技能 | 路径 | 是否随插件分发 | 干什么 |
| --- | --- | --- | --- |
| `mimic-tear-board` | `mimic-tear-board/SKILL.md` | **是** | 读板面状态、读 SSE、下指令派工 |
| `mimic-tear-release-verification` | `mimic-tear-release-verification/SKILL.md` | 否 | 验收「发布副本 = 仓库、跑起来的是新代码」 |
| `mimic-tear-scheduled-task-launch-check` | `mimic-tear-scheduled-task-launch-check/SKILL.md` | 否 | 验收 Windows 计划任务的启动链有没有真跑起来 |
| `mimic-tear-watchdog-heartbeat-verify` | `mimic-tear-watchdog-heartbeat-verify/SKILL.md` | 否 | 验收心跳 / 看门狗还在不在跑，排除「恒判健康」和「钉死链」 |

## 随插件分发

`mimic-tear-board` 是插件对用户发布的技能，它在 `.minimax-plugin/plugin.json` 的 `skills` 数组里被显式列出：

```json
"skills": [
  "skills/mimic-tear-board/SKILL.md"
]
```

**只有被列出的文件才会随插件分发。** 换句话说，一个技能文件放在这个目录下、但没有进那个数组，它就只存在于仓库里，不会发布出去。

## 项目自用

后三个是**本项目自己**的验证技能，不属于插件的使用面，所以**不进 `plugin.json` 的 `skills` 数组**：

- 它们的触发词都跟仿身泪滴自己的运维有关（发布漂移、计划任务、看门狗心跳），对插件使用者没有意义。
- 插件清单由宿主校验，改它要过一遍宿主；本项目又要求零第三方依赖、包内不能有 `node_modules`。发布面保持最小，是最省事也最不容易出事的选择。
- 放回仓库的目的只有一个：**可评审、可版本控制**。以前它们只活在本机的 `~/.minimax/skills/` 下，改了什么、为什么改，仓库里查不到。

这三份在本机仍然从 `~/.minimax/skills/` 加载（Windows 是 `%USERPROFILE%\.minimax\skills\`），仓库里这份是**来源**而不是运行时副本。

## 维护约定

- **先改仓库里的这份，再同步回本机安装目录。** 两处不一致时以仓库为准。
- 收编时做过一次适配：把本机绝对路径改成占位或仓库相对路径，示例里的事实（任务名、脚本名、状态文件名、字段名）逐个对着仓库核过。仓库里没有的东西不在示例里出现。
- `mimic-tear-board` 的接口契约（21 条路由、12 类 SSE 事件）以服务端 `miniapp/node/api-routes.mjs` 与 `miniapp/node/server.mjs` 为准。**改了一边就要改另一边**——路由表是声明式的，SSE 事件在 `broadcast()` 调用点。
