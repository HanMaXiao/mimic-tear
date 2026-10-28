# 仿身泪滴（Mimic Tear）

多智能体项目管理指挥部：聚合全部项目的 Goal 进度、待决策问题与团队层级，并把指令投递给项目负责人会话。

## 安装

1. 下载安装包或克隆本仓库，取到 `miniapps/mimic-tear/` 目录；
2. **整个目录**（含隐藏的 `.minimax-plugin/`）复制到 `~/.minimax/plugins/mimic-tear/`；
   - Windows：`%USERPROFILE%\.minimax\plugins\mimic-tear\`
3. 重启 MiniMax Code，确认插件已识别并启用。

目录名必须是 `mimic-tear`，要和 `.minimax-plugin/plugin.json` 里的 `name` 一致。

## 它会访问什么

**只读**：

| 数据 | 位置 |
| --- | --- |
| 项目、会话、Goal、待回答问题、后台任务 | `~/.minimax/v2/sqlite/runtime-state.sqlite`（`node:sqlite`，`readOnly: true`） |
| 已安装的 skill 清单 | `~/.agents/skills`、`~/.minimax/skills`、`~/.minimax/.builtin-skills` |

**写入**（只写自己的数据目录，Mini App 的 `dataDir`）：

| 文件 | 内容 |
| --- | --- |
| `dispatches.json` | 派工记录 |
| `acks.json` | 已确认的收件箱条目 |
| `boss-session.json` | 大哥会话 id |
| `managed-projects.json` | 大哥管辖的项目名单 |
| `duty-intent.json` / `patrol.json` | 值班状态与巡检配置 |
| `watchdog-alert.log` | 看门狗告警流水 |

**网络**：不主动访问任何外部服务。页面与 Agent 之间的通信走宿主分配的回环端口。

**Windows 计划任务**：安装时会注册一个名为 `MimicTear-DutyWatchdog` 的计划任务，让看门狗在 MiniMax Code 关闭时也能值班。卸载插件时执行 `node miniapp/node/install-watchdog-task.mjs remove` 即可移除。

## 运行环境与测试版本

- MiniMax Code 桌面端（Windows / macOS）
- Node.js ≥ 22（用到 `node:sqlite`），开发与测试在 Node 24 上验证
- 测试：`node --test`（无第三方依赖；条数以该命令的输出为准）

> **2026-10-28 补记**：用例数由 386 订正为 **411**（`node --test` 的 TAP 输出：`tests 411 / pass 411 / fail 0`，2026-10-28 复测）。386 是旧数字，已过期。
>
> **2026-10-28 再补记**：411 又过期了（本轮补的守卫与契约测试把它推到了 **525**）。写死条数
> 只会一次次过期，所以上面那行改成「以该命令的输出为准」：条数是**产物**，不是**常量**。

## 目录

```plaintext
.minimax-plugin/plugin.json   插件清单
icon.png                     图标
skills/                      随插件分发的 Skill
miniapp/
  miniapp.json               Mini App 声明
  client/                    前端（无构建步骤）
  node/                      Node 运行时：REST + SSE + 领域服务
```

## 许可证

MIT，见仓库根目录的 [LICENSE](https://github.com/HanMaXiao/mimic-tear/blob/main/LICENSE)。
