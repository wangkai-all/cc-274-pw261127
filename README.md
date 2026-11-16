# Driftfield

流式数据变换的**规则迁移**与**执行器切换**控制系统：规则用受限表达式在网页里编辑，运行中的执行器持续累计去重与窗口状态，规则变更会被自动判定为「可迁移」或「必须重建」，并在影子追赶 / 停流切换之间选择；旧执行器在发布后继续上报、重建途中又来新版本，都不会混入当前结果。

从零实现：没有 Web 框架、没有 ORM、没有表达式库，运行时零依赖（仅 `node:sqlite`）。所有表达式由手写 tokenizer → 递归下降 parser → 静态类型检查 → 树遍历求值器执行，**任何用户输入都不会被当作代码执行**。

---

## 快速开始

```bash
node --version          # 需要 >= 22.5（使用内置 node:sqlite）
npm install             # 只安装 devDependency playwright-core
npm run seed            # 生成一周演示数据到 data/driftfield.db
npm start               # http://127.0.0.1:3000
```

其他命令：

| 命令 | 说明 |
| --- | --- |
| `npm test` | 单元/集成测试（表达式、聚合器、引擎、HTTP API），66 项 |
| `npm run test:ui` | 无头 Chromium 端到端测试（需先安装 Chromium，见下） |
| `npm run dev` | `node --watch` 启动 |
| `node scripts/seed.js --out x.db --events 2000 --seed 42 --reset` | 自定义种子数据 |

环境变量：`PORT`（默认 3000）、`HOST`（默认 127.0.0.1）、`DRIFTFIELD_DB`（默认 `data/driftfield.db`）。

UI 测试需要 Chromium。脚本默认读取 `/tmp/pw-browsers/.../chrome-headless-shell`，可用 `PLAYWRIGHT_CHROME` 指向自己的可执行文件；容器里缺共享库时用 `LD_LIBRARY_PATH` / `FONTCONFIG_FILE` 兜底：

```bash
PLAYWRIGHT_CHROME=/path/to/chrome-headless-shell npm run test:ui
```

---

## 核心概念

### 规则（rule spec）

一条规则是**不可变、带版本号的值**：

```json
{
  "label": "按设备统计成功事件金额",
  "filter": "ok && amount > 0",
  "group": "coalesce(device, \"unknown\")",
  "dedup": "event_id",
  "measure": "amount",
  "aggregate": "sum",
  "window": { "kind": "tumbling", "sizeMs": 15000, "slideMs": 15000,
              "allowedLatenessMs": 3000, "offsetMs": 0 }
}
```

- `filter` 必须返回 boolean（`null` 视为不通过）；
- `group` 必须返回非空标量，空值事件判为 `invalid-group` 跳过；
- `dedup` 可留空，命中同一窗口内重复键的事件判为 `duplicate`；
- `measure` 必须返回数字，`null` 仍计入 `count` 但不参与 `sum/min/max`；
- `aggregate ∈ {sum, count, avg, min, max}`；
- `window.kind ∈ {tumbling, hopping}`，`sizeMs` 必须是 `slideMs` 的整数倍，单事件最多落入 60 个窗口。

同一语义的不同写法（空格、冗余括号）经规范化后得到相同的 `semanticHash`：

```js
canonicalString(parseExpression('amount>1&&ok')) ===
canonicalString(parseExpression('(amount > 1) && ok'))   // true
```

### 受限表达式语法

支持：数字/字符串/布尔/`null` 字面量、字段、白名单函数、`+ - * / %`、`< <= > >= == !=`、`&& || !`、三元 `? :`、圆括号。

**不支持**（在词法/语法/类型阶段拒绝）：成员访问 `.`、下标 `[]`、赋值 `=`、自增、逗号运算符、分号、换行分隔的多语句、模板字符串、注释、箭头函数、`eval`/`require`/`globalThis`、未知字段与未知函数。

类型规则：不做隐式转换（`amount > "100"` 直接报错），空值沿算术与比较三值传播，除零/取模零结果为 `null`，`coalesce` 类型必须一致并短路。

字段：`event_id event_time user_id region plan action amount duration_ms ok device channel country ts`。

函数：`coalesce(1–4) len lower upper starts_with contains abs round(1–2, digits 0–6) min max to_number`。

### epoch 与 fence

- **epoch** 是一次「执行器实例」：绑定一个规则版本与一套派生状态。所有结果行、逐条判定都带 `epoch_id`。
- **raw_events** 只追加，是重建与核对唯一的真值来源。
- **fence** 是单调递增的凭据代数。发布、迁移、暂停/恢复、切换都会 bump；上报必须同时匹配 `epochId + versionId + fence`，否则 409 并落库到 `stale_reports`，绝不写入 `raw_events`。
- **build generation** 是重建令牌：更新的发布会中止所有在途重建，旧重建即使跑完也无法把自己切上线。

### 事件时间与窗口

水位线 `watermark = max(event_time) − allowedLateness`，**先推进水位线再处理事件**，因此事件不会关闭自己所在的窗口。窗口在 `end <= watermark` 时关闭并写入 `results`；此前的窗口只作为「开放窗口」展示，不参与最终结果。迟到超过允许范围的事件判为 `late`，不会静默合并进已关闭窗口。

去重是**按窗口**的，不是全局的：同一个 `event_id` 落在下一个窗口时是新事件。

同一事件序列 + 同一规则 → 完全相同的窗口结果（不依赖墙钟），这是核对可以做逐行比对的前提。

---

## 变更分类：能不能迁移？

`classifyChange(old, new)` 返回 `noop | migrate | rebuild`：

| 字段 | 分类 | 原因 |
| --- | --- | --- |
| 名称 label | `noop` | 只影响展示 |
| `aggregate` | `migrate` | 状态中同时保留 count/sum/min/max，仅换口径 |
| `filter` | `rebuild` | 改变了进入聚合的事件集合，旧状态无法反推被排除的事件 |
| `group` | `rebuild` | 旧聚合行无法拆分到新分组键 |
| `dedup` | `rebuild` | 「哪些事件算重复」的定义变了，旧去重集合不可复用 |
| `measure` | `rebuild` | 已存 sum/min/max 属于旧度量，无法换算 |
| `window.kind/sizeMs/slideMs/offsetMs` | `rebuild` | 窗口边界无法重新切分 |
| `window.allowedLatenessMs` | `rebuild` | 窗口关闭与迟到丢弃的判定变了 |

`migrate` / `noop` 的发布是**零重放**：新建 epoch、复制已关闭结果、`adoptState()` 直接接管内存窗口状态、切换指针，冻结在毫秒级。`rebuild` 必须从 `raw_events` 重放。

网页上的「变更分类与影响预览」会对最近留存事件同时跑候选规则与活动规则，给出新增/消失/变化窗口数、逐行 diff 与逐条判定变化，**只读，不改线上状态**。

---

## 两种切换策略与延迟

| | 影子追赶 `shadow` | 停流切换 `stop-the-world` |
| --- | --- | --- |
| 发布瞬间 | 旧 epoch 继续服务并接收事件 | 立即暂停旧 epoch、bump fence |
| 新事件 | 照常进入 `raw_events`，旧规则继续消费 | 全部 409 `paused` 并被记录，需要重提 |
| 重建 | 后台按 chunk 重放留存数据 | 后台重放；期间 `resume()` 被拒（`paused-by-rebuild`） |
| 切换 | 追上尾部后**同步**做最后一次 tail catch-up + 指针交换 | 同左，但切换前线上一直冻结 |
| 冻结时间 | 毫秒级（仅 tail catch-up） | ≈ 全量重放时间，`estimatedFreezeMs = replayEvents / replayRate + 5ms` |
| 适用 | 默认；可接受重建期间继续用旧结果 | 不能容忍新旧结果并存的场景 |

`engine.planFor(change, strategy)` 会给出 `replayEvents`、`estimatedReplayMs`、`estimatedFreezeMs`、`estimatedTotalMs` 以及一段中文延迟说明，网页直接展示。

**切换的原子性**：`RebuildRunner.cutover()` 在整个 Node 事件循环任务内完成「最后一次 tail catch-up → 校验 build generation → 单事务退役旧 epoch / 激活新 epoch / 更新 meta 指针 / bump fence → 替换 `engine.active`」。中间没有 await，因此不会有 ingest 插入到追平与交换之间。

### 冲突与中断

- **旧执行器继续上报**：epoch/fence/version 任一不符 → 409 + `stale_reports`（同一 worker/epoch/version/fence/reason 每秒最多落一条，附 `suppressedSinceLast`），不会污染当前结果。演示页有「启动旧执行器」按钮，它会一直用启动时的凭据上报。
- **重建中途又来新版本**：`publishVersion` 先 `abortAll()` 把旧任务置 `aborted`、旧构建 epoch 置 `aborted`，再 bump generation。旧 session 即使后续 tick 也不会切换。
- **停流重建中途取消**：恢复旧 epoch 为 `active`、清除 `pause_owner`、bump fence——但**不会**让被拒绝的事件复活，需执行器重提。
- **进程重启**：boot 时从最近快照恢复并重放尾部 `raw_events`；在途重建被标记 `failed`（`进程重启，重建任务中断`），旧 epoch 继续服务。

### 暂停 / 恢复 / 回滚

- `pause` 会 bump fence，所有上报被拒；停流重建进行中不允许手动暂停。
- `resume` 在 `pause_owner === 'rebuild'` 时拒绝——停流语义必须靠取消重建或等待切换，否则会退化成隐式影子重建。
- `rollback(toVersionId)` **派生新版本**（版本历史只追加），可复用目标版本最近的 `epoch_snapshots` 续建，避免重放未变化的历史；语义变化时仍走重建。

---

## 全量基准核对

`POST /api/verify`（页面「运行核对」）用留存 `raw_events` 以**全新 Aggregator** 从零重算指定 epoch，逐窗口比对：

- `count / sum / min / max`（浮点容差 1e-9）；
- `contributions_digest`（贡献事件 seq 集合的 sha256 前 32 位），使比对不受浮点舍入影响；
- 缺失/多余窗口分别报 `missing-in-store` / `extra-in-store`。

未关窗只列出、不参与比对。核对结果、次数、时间写入 `meta` 与 `audit_log`，页面显示通过/差异表格。测试里故意改一行 `results.sum`，核对会如实报 `value-mismatch`。

---

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + 当前 `runtime`（epoch/version/fence/paused） |
| GET | `/api/meta` | 字段、函数、聚合、窗口限制、策略、默认规则 |
| GET | `/api/state` | 控制台主视图：活动版本、计数、开放窗口、任务、过期上报、epoch 列表 |
| GET | `/api/stream` | SSE，推送 `ingest`/`activate`/`rebuild-*`/`stale` 事件 |
| GET/POST | `/api/versions` | 列版本 / 建草稿（返回变更分类） |
| GET | `/api/versions/compare?from=&to=` | 任意两版本语义对比 |
| GET/PUT | `/api/versions/:id` | 版本详情 / 改草稿（仅 draft） |
| POST | `/api/versions/:id/preview` | 影响预览（只读） |
| POST | `/api/versions/:id/publish` | 发布，body `{strategy}` |
| POST | `/api/rollback` | 回滚并派生新版本 `{versionId, strategy}` |
| POST | `/api/executor/pause`、`/resume` | 暂停 / 恢复 |
| GET/POST | `/api/rebuilds` | 任务列表 / 手动全量重建 |
| POST | `/api/rebuilds/cancel` | 取消在途重建 `{jobId}` |
| POST | `/api/ingest` | 带凭据上报 `{workerId, epochId, versionId, fence, batchKey?, events[]}` |
| GET | `/api/results`、`/api/adjudications`、`/api/events` | 结果 / 逐条判定 / 原始事件（分页） |
| GET | `/api/stale-reports`、`/api/quarantine`、`/api/audit` | 过期上报 / 隔离 / 审计 |
| GET/POST | `/api/verify` | 全量基准核对 |
| GET/POST | `/api/simulator`、`/start`、`/stop`、`/step`、`/legacy-executor` | 模拟数据源与旧执行器 |

错误统一为 `{ error: { code, message, details } }`，状态码 400/404/409/500。`stale-fence`、`stale-version`、`paused`、`results-not-ready`、`paused-by-rebuild`、`version-immutable` 等都是显式 code。

---

## 网页控制台

五个页签：

1. **总览** — 活动执行器与规则、处理计数、数据计数、模拟数据源、执行器控制、重建任务、最近被拒绝的上报。
2. **规则与迁移** — 版本列表（活动/草稿/待切换/历史）、表达式编辑器（打字即校验、550ms 防抖预览）、变更分类横幅、两种切换策略的延迟估算、影响预览表、发布/回滚。
3. **结果与逐条判定** — 已关闭窗口结果、开放窗口、按 epoch 查询历史结果、逐条事件采用了哪版规则（含「继承自 #epoch」标记）、按判定类型过滤。
4. **时间线与核对** — 运行全量核对、版本谱系、epoch 时间线（含每个 epoch 的覆盖起点/检查点/备注）、操作审计。
5. **语法参考** — 字段表、函数表、迁移判定与切换策略说明。

---

## 项目结构

```
src/
  expr/            # 受限表达式：tokenizer / parser / typecheck / evaluator / 白名单
  spec.js          # 规则规范化、语义哈希、变更分类
  engine/
    aggregator.js  # 确定性窗口聚合、水位线、去重、贡献摘要、快照
    engine.js      # 版本、epoch、fence、上报、迁移、暂停/回滚、读模型
    rebuild.js     # 影子/停流重建、build generation、原子切换
    preview.js     # 候选 vs 活动的只读影响预览
    verify.js      # 全量基准核对
    repository.js  # 行映射与 epoch 作用域 SQL
  schema.js        # SQLite 表结构
  server.js        # 无框架 HTTP + 静态服务 + 启动入口
  simulator.js     # 模拟数据源与旧执行器
public/            # index.html / app.js / styles.css（无构建步骤）
scripts/seed.js    # 确定性种子数据
test/              # expr / aggregator / engine / api 单测 + ui.e2e.js
```

### 数据表

`meta`（活动指针/fence/build generation）、`rule_versions`（不可变版本历史）、`epochs`（执行器实例与状态）、`raw_events`（只追加真值）、`results`（epoch 作用域已关闭窗口）、`adjudications`（epoch 作用域逐条判定）、`rebuild_jobs`、`epoch_snapshots`、`ingest_batches`（幂等批次）、`stale_reports`、`quarantine`、`audit_log`。

---

## 有意的取舍

- **按窗口去重**而非全局去重：状态可随窗口关闭释放，且与窗口语义一致；跨窗口同 id 视为新事件。
- **水位线由事件时间推进**，不掺墙钟：换来确定性与可重放性，代价是事件流停止时最后一个窗口不会关闭（页面会明确标注「开放窗口」）。
- **停流切换不自动恢复**被拒事件：拒绝是显式语义，执行器必须按 409 里的新 epoch/fence 重提；若静默补写，就失去了「冻结」的意义。
- **版本历史只追加**：回滚派生新版本，避免「同一个 id 指向不同语义」。
- **预览有截断**：默认最近 5 万条事件、diff 采样 200 行，但聚合与差异计数始终覆盖全部读取到的事件。
