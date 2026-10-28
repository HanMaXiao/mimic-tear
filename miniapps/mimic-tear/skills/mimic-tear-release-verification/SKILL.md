---
name: mimic-tear-release-verification
description: |
  Use this skill when 需要验证「发布 / 部署」这一步真的把新代码送到了运行的地方——
  发布副本与仓库逐字节一致、跑起来的就是新代码。
  Trigger phrases: 发布了 / 上线了 / deploy 了 / 新版本生效了吗 / 板面还是旧的 /
  改了没生效 / 发布副本 / publish 之后要做什么。
  Do NOT use it to约束自己这一轮怎么声称完成（那是 verification-before-completion），
  也不要用它做代码评审或决定要不要发布。
---

# 发布 ≠ 新代码跑过

「发布成功」只证明了一件事：**仓库里的文件被搬运到了目标目录**。它没有证明目标目录里的文件是对的，也没有证明正在跑的进程用的是它。这份技能是把这两件事分开验的清单。

## Inputs to collect

- **三层分别在哪**：仓库（source of truth）/ 发布副本（运行时加载的那份）/ 运行中的进程（内存里跑的那份）。三层不同源，是这类问题的全部来源。
- **发布机制是什么**：写文件后要重启进程吗？只写文件不重启 = 新副本永远不生效。
- **这次改动的"新行为"是什么**：一个新产品文件、一个新接口、一个新字段——用来证明跑起来的是新代码。

## Procedure

1. **先声明三层，再动手。**
   原因：绝大多数"发布了没生效"到最后查出来是"搞错了自己在看哪一层"。先把三层各自的路径写出来，后面的每一步才有对象。

2. **逐字节比对发布副本与仓库。**
   原因：**存在性检查不算比对**——它只回答"文件在不在"，不回答"内容一不一样"。一个改了一半的副本，文件都在，但跑的是旧逻辑。
   做法：在 node 里逐文件 `Buffer.equals` 比对，**并把两个方向的差集都列出来**——「仅在仓库」= 新增文件没进发布包；「仅在发布副本」= 副本里有仓库没有的文件，说明它是被旧发布流程留下的。
   两个根目录用环境变量传进来，不要把本机绝对路径写死在脚本里：

   ```js
   import { readdirSync, readFileSync } from 'node:fs';
   import { join, relative } from 'node:path';

   // 仓库根 / 发布副本根，由调用方按本机实际情况传入。
   const workspace = process.env.WORKSPACE_ROOT;
   const published = process.env.PUBLISHED_ROOT;
   if (!workspace || !published) throw new Error('需要 WORKSPACE_ROOT 与 PUBLISHED_ROOT');

   const walk = (root, base = root, out = []) => {
     for (const e of readdirSync(root, { withFileTypes: true })) {
       const full = join(root, e.name);
       if (e.isDirectory()) walk(full, base, out);
       else out.push(relative(base, full).replace(/\\/g, '/'));
     }
     return out;
   };
   const w = new Set(walk(workspace));
   const p = new Set(walk(published));
   for (const f of w) {
     if (!p.has(f)) { process.stdout.write('仅在仓库  ' + f + '\n'); continue; }
     if (!readFileSync(join(workspace, f)).equals(readFileSync(join(published, f)))) {
       process.stdout.write('内容不同  ' + f + '\n');
     }
   }
   for (const f of p) if (!w.has(f)) process.stdout.write('仅在发布副本  ' + f + '\n');
   ```

3. **确认运行时加载的是发布副本，不是仓库。**
   原因：开发态经常直接从工作区跑脚本、加载器也可能指向工作区。那样"改了就能生效"，于是本地永远绿，发布后行为却不一样——这种差异会伪装成"环境问题"。
   做法：查进程的加载路径 / 启动参数里的目录，确认它读的是发布副本。

4. **用新行为证明"跑的是新代码"。**
   原因："页面能打开""接口有响应"证明不了版本——旧代码也响应。
   做法：挑一个**只有新代码才有**的行为去观察：新产品文件出现了、新接口返回了新字段、新日志行出现了。

5. **确认副本是活的。**
   原因：发布机制是"写文件 + 重启进程"时，光写文件没用。进程启动时间早于副本写入时间 = 新副本还没被加载。
   做法：比进程启动时间与副本最后写入时间；必要时显式重启再验第 4 步。

6. **做一次真实产物验证。**
   原因：单测全绿和"生产里跑的是这份代码"是两件事。单测可能跑在仓库副本上（还没发布），也可能用的是生产不走的调用形状。
   做法：在**发布副本**上跑一次产物级验证（真机、真数据、真调用），而不是只跑仓库里的测试。

7. **别手改发布副本来"修"问题。**
   原因：手改的副本在下一次发布时被覆盖，而"我明明改过了"的记忆会留很久。
   做法：改仓库 → 重新发布 → 重新比对。

## Output contract

- **验收结论**：一致 / 不一致（列出差异文件）
- **三层路径**：仓库、发布副本、运行时实际加载的那份
- **生效证据**：观察到的那个"只有新代码才有"的行为，具体到字段或文件
- **待办**：还有哪一层没验到

## Failure handling

- **发布副本与仓库不一致**：以仓库为准重新发布，不要就地改副本。
- **差集里有「仅在仓库」的文件**：多半是新增文件没被打进发布包（打包清单按目录/通配符收，没覆盖新目录）。查打包规则，不要手工补文件。
- **三层都对但行为还是旧的**：查进程是不是在跑发布之前的实例，或者有个更长驻的进程缓存了旧模块。
- **验证卡在鉴权上拿不到真实数据**：直读数据目录/状态文件验证，不要因为"接口 401"就改口说"看起来没问题"。

## Examples

**Input**：改完 publish 了，板面还是老样子。

**Output**：判定**发布副本一致但运行的不是新代码**。证据：仓库 `miniapps/mimic-tear/miniapp/` 与发布副本 `~/.minimax/plugins/mimic-tear/miniapp/`（Windows 是 `%USERPROFILE%\.minimax\plugins\mimic-tear\miniapp\`）全部文件逐字节一致、差集为空；新加的 `skill-library.mjs` 在两侧都存在；但板面「能力库」页没有「已封装技能库」区块——查进程加载路径发现它读的是发布前启动的实例。已显式重启运行时，第 4 步的新行为（新增区块）随之出现。

---

## 收编说明

本文件是仓库内的**项目自用副本**，来源是本机的 `~/.minimax/skills/mimic-tear-release-verification/SKILL.md`（Windows 是 `%USERPROFILE%\.minimax\skills\...`）。收进仓库是为了可评审、可版本控制。

维护约定：**先改仓库里的这份**，再同步回本机安装目录；两处不一致时以仓库为准。
