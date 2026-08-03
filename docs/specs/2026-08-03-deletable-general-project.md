# general 可删除：默认 project 从「不可删的特例」改为「零 project 时的自动兜底」

日期：2026-08-03
状态：设计定稿（盘问结论已沉淀进「目的 / 约束 / 成功标准」三节）

---

## 一、问题现状

`general` 是全应用唯一一个**不能删除**的 project（代码里叫 subject）。它的特殊性散落在三层，每层各自写死了 `slug === 'general'` 或「general 必存」的假设：

### 1. 禁删守卫（2 处服务端 + 1 处前端）

| 位置 | 代码 | 行为 |
|---|---|---|
| `subjects-repo.ts:214` | `beginDeleteMaintenance` 内 `if (subject.slug === 'general') throw SubjectError('protected')` | 领取删除维护权前就拒 |
| `subjects-repo.ts:272` | `deleteWithContents` 内同一判断 | 搬完目录、真正 purge 前二次拒 |
| `subject-dialog.tsx:312` | `canDelete = !isActive && subject.slug !== 'general'` | 危险区不渲染删除按钮，改显示「can't be deleted」 |

### 2. 「general 必存」的隐式依赖（4 处）

| 位置 | 代码 | general 缺失时的后果 |
|---|---|---|
| `db/client.ts:133` | `ensureSubjectsAndGeneral()`：`SELECT id FROM subjects WHERE slug='general'`，没有就插一行 | 无条件补建 —— **用户删掉 general 后，下次启动会原地复活** |
| `middleware/subject.ts:96` | `resolveGeneralOrFail()`：兜底取 general，取不到返回 500「Run database migration」 | 所有非 required 的 API 在 cookie 失效时 500 |
| `(app)/page.tsx:34` | `subjectsRepo.getBySlug(cookieSlug) ?? getBySlugOrThrow(GENERAL_SUBJECT_SLUG)` | 首页 SSR 抛异常 |
| `(app)/wiki/[...slug]/page.tsx:33` | 同上 | 阅读页 SSR 抛异常 |

### 3. 全局 reset 拿 general 的 id 当 vault marker

`api/reset/route.ts:271` 起：

```ts
sqlite.exec(`DELETE FROM subjects WHERE slug != 'general'`);   // 保留 general 行
...
const generalMarker = sqlite.prepare(
  `SELECT id, mutation_epoch FROM subjects WHERE slug = 'general'`
).get() as { id: string; mutation_epoch: number };              // ← 非空断言
staged = stageVaultPaths([...], { markerSubjectId: generalMarker.id, ... });
```

`generalMarker` 上了非空类型断言但没有运行时检查。general 一旦可删，删掉它之后跑全局 reset 会在 `generalMarker.id` 上空指针崩（500）。

### 4. 「active 不能删」让「删到零」在结构上不可达

前端守卫是 `!isActive && slug !== 'general'`。**最后剩下的那个 project 必然是 active 的**（`SubjectsBootstrap` 保证 `currentSubjectId` 总落在列表内的某一项）。所以即使去掉 general 的禁删，只要保留 `!isActive`，project 数量就永远不可能减到 0 —— 需求里「删除所有 projects」这个前置条件根本触发不了。

注意：**服务端从来没有这条守卫**。`beginDeleteMaintenance` 的守卫只有 not-found / protected / maintenance / active-jobs / has-inbound-refs 五条，active 与否服务端不知道（那是 cookie + Zustand 的客户端概念）。所以这是一条纯前端的、可以安全放宽的限制。

---

## 二、目的

把 `general` 从「受保护的特例」重新定义为「**零 project 时的自动兜底**」：

1. `general` 与任何其他 project 一样可以删除，走完全相同的级联清理路径（DB 单事务 + vault 目录 + git commit）。
2. project 总数不允许为 0 —— 删除后若一个都不剩，系统自动生成一个 slug 为 `general` 的空 project。
3. 「零 project」这个中间态对用户不可见：删除请求返回时列表里已经有 general 了。

---

## 三、约束

以下为盘问达成的共识，实现不得偏离：

1. **生成时机 = 删除请求内原子补齐 + 启动兜底。**
   - `DELETE /api/subjects/[id]` 在同一路径内检测「删完为零」并建 general，响应体带上它，前端直接切过去；
   - `db/client.ts::ensureSubjectsAndGeneral()` 的判据从「**没有 general** 就建」改为「**零 project** 才建」—— 这一字之差既是启动兜底，也是「用户删掉 general 后不会被重启复活」的唯一保证。

2. **前端整体去掉 `isActive` 禁删守卫。** 任何 project 都能删；删完切到剩下的（或新生成的 general）并落到首页。理由：服务端本来就没有这条守卫，`SubjectsBootstrap` 已经会把悬空的 `currentSubjectId` 重置到列表内的项。

3. **新生成的 general 只是一行 DB 记录**：`slug='general'` / `name='General'` / `description=''` / `augmentationLevel='standard'`。不建 vault 目录、不生成 `index.md`/`log.md` stub、不做 git commit —— 与用户在 UI 里手动新建 project 的形态**逐字节一致**（`POST /api/subjects` 只调 `subjectsRepo.create`）。

4. **全局 reset 只做最小适配**：`/api/reset`（不带 subjectId）开头先确保 general 行存在，其余逻辑（保留 general 行、重建两个 stub 页、marker/epoch 编号）**一行不改**。不改成「删光再重建」——那会让 general 的 id 变化，`stageVaultPaths` 的 `markerSubjectId`/`expectedEpoch` 契约要跟着动，风险远大于收益。

5. **其余删除守卫对 general 一视同仁**：`maintenance` / `active-jobs` / `has-inbound-refs` 三条继续生效，不为 general 开后门也不给它加额外限制。

6. **不改 vault 布局、不改 DB schema、不需要数据迁移。** 存量库里 general 已存在，新判据（零 project 才建）对它是 no-op。

7. **`GENERAL_SUBJECT_SLUG` 常量保留**，它仍是「自动生成时用哪个 slug」的单一真实源（`server/wiki/page-identity.ts` + `stores/ui-store.ts` 两份，本次不合并）。

---

## 四、成功标准

### 行为

1. 只有 general 一个 project 时，打开它的设置弹窗，危险区渲染删除按钮（不是「can't be deleted」文案）；两步确认后删除成功。
2. 上述删除返回后：project 列表里有且仅有一个 slug 为 `general` 的项，`pageCount` 为 0，其 id **不等于**被删的那个 general 的 id（是新建的行，不是没删掉）。
3. general 与另一个 project 共存时删掉 general：列表只剩另一个，**不会**自动补 general；重启应用（重新 `getDb()` 建表/迁移）后仍然不补。
4. 删除 active project（无论是不是 general）后，前端切到剩余项或新 general 并落到首页，不出现悬空 `currentSubjectId`。
5. general 不存在时（例如上面第 3 条之后）：首页与阅读页 SSR 正常渲染（回落到第一个 project），非 required 的 API 正常解析 subject，全局 reset 不再 500。
6. 删除 general 时若它有 active job 或被跨主题引用，仍按既有 409 语义拒绝，错误文案与其他 project 一致。

### 验证

- 单测（vitest）覆盖：
  - `subjects-repo`：general 可走完 `beginDeleteMaintenance` → `deleteWithContents`；`SubjectError('protected')` 不再因 slug 触发；
  - 「零 project → 自动生成 general」的仓储级不变量（真实 SQLite）；
  - `db/client`：已有非 general project 且无 general 时，启动不补 general；空库启动补 general；
  - `DELETE /api/subjects/[id]` 路由：删最后一个时响应体带新 general；删非最后一个时不带；
  - `middleware/subject`：general 缺失时兜底到第一个 project 而非 500。
- 真实验收（不只跑测试）：`npm run dev:all` 起真实应用，在真实 vault 上走完「两个 project → 删 general → 删剩下那个 → 自动出现 general」全程，附命令与输出。
- 回归：`npx vitest run` 全绿；`npm run lint` 通过。

---

## 五、方案取舍

### 方案 A（采用）：守卫下沉为「非空不变量」

删掉 3 处 `slug === 'general'` 判断，新增一个「保证至少有一个 project」的口径，挂在删除路径尾部与启动期。

- 优点：概念数量不增加（没有「默认 project」这种新状态），general 退化成普通 project + 一个 slug 约定；改动面小且集中。
- 缺点：「至少一个」这个不变量在两处独立维护（删除路径 + 启动期），需要靠测试锁住。

### 方案 B（否决）：给 subjects 表加 `is_default` 列

用列标记默认 project，删除时把标记转移给下一个。

- 否决理由：违反 YAGNI。需求只要「零就补一个 general」，不需要「谁是默认」这个可变的、需要迁移和转移逻辑的状态；且 `GENERAL_SUBJECT_SLUG` 已经承担了「兜底 slug」的职责，加列等于把单一真实源劈成两份。

### 方案 C（否决）：允许零 project，UI 出空态引导页

- 否决理由：需求明确要求自动生成。且四处 SSR/中间件的兜底路径都得处理「一个 project 都没有」，空态是新的一整类 UI 分支，成本远高于自动补一行。
