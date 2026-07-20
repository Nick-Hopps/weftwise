# Spec：维护到期页面预览（Pages due now 可查看明细）

日期：2026-07-20
状态：已定稿

## 背景与问题

Settings → Automation → Maintenance 卡片的状态行只显示 `Pages due now: {count}`
（数据来自 `GET /api/maintenance/status` 的 `dueCount`，口径为
`maturity-repo.countDue`：维护范围内 `state != 'graduated' AND next_due_at <= now`）。
用户只能看到数字，无法知道**具体是哪些页面**将被下一次 sweep 处理，
既无法评估维护成本，也无法在开启维护前抽查目标页面。

## 目的

给用户一个到期页面明细的预览入口：看得到是哪些页、属于哪个项目、
到期多久、优先级如何，并能直接跳转到对应 wiki 页面。

## 约束

- 只读功能：不新增任何写操作，不影响 sweep 调度逻辑。
- 口径必须与 `countDue` / sweep 完全一致（同 scope、同 `state != 'graduated'`、
  同 `next_due_at <= now`、同 `priority DESC, next_due_at ASC` 排序）。
- 维护是全局调度、不绑 subject：新 API 与 `/api/maintenance/status` 一样仅
  `requireAuth`，不走 `resolveSubjectFromRequest`。
- 明细列表有界：单次最多返回 100 条，超出部分以「+N more」提示（数字用
  `total - entries.length` 计算），不做分页（YAGNI：到期页数受 sweep 消化，
  长期滞留几百条本身是配置问题，预览前 100 条足够判断）。

## 方案取舍

1. **扩展 `/api/maintenance/status` 返回列表**：调用方（打开 Automation 面板即请求）
   每次都要付出 JOIN 成本，且多数时候用户不看明细。❌
2. **新增独立只读端点 `GET /api/maintenance/due-pages`，UI 懒加载**：
   打开明细时才请求；status 端点保持轻量不变。✅（推荐）
3. **在 Health 页新增区块**：Health 定位是 lint findings 处置，维护到期是
   scheduler 运行态，语义不合；且离配置入口远。❌

## 功能设计

### API：`GET /api/maintenance/due-pages`

- 鉴权：`requireAuth`；scope 读 `settings-repo.getMaintenanceScope()`（与 status 同源）。
- 响应（新增契约 `MaintenanceDuePagesResult`）：

```ts
interface MaintenanceDuePage {
  subjectId: string;
  subjectSlug: string;
  subjectName: string;
  slug: string;
  /** pages 表标题；maturity 孤儿行（页已删未 prune）为 null，UI 回退显示 slug。 */
  title: string | null;
  nextDueAt: string; // ISO
  priority: number;
  state: MaturityState;
}
interface MaintenanceDuePagesResult {
  total: number;              // countDue 同口径全量数
  entries: MaintenanceDuePage[]; // 最多 limit 条，priority DESC, next_due_at ASC
  limit: number;              // 服务端上限（100），供 UI 判断截断
}
```

### Repo：`maturity-repo.listDueDetailed(nowIso, limit, subjectIds?)`

`page_maturity` LEFT JOIN `pages`（复合键 subject_id+slug 取 title）
JOIN `subjects`（取 slug/name），WHERE/ORDER 与 `listDue` 完全一致。
LEFT JOIN 容忍 maturity 孤儿行，避免明细数与 `countDue` 不一致。

### UI：Maintenance 状态行内联展开

- `Pages due now: N` 行右侧新增文字按钮：`View`（展开后变 `Hide`）；
  `N = 0` 或 status 加载失败时不显示按钮。
- 展开区渲染在同一张卡片内（`divide-y` 追加一行），懒加载
  `['maintenance-due-pages']`（React Query，`enabled: open`，`staleTime 10s`，
  与 status 一致）。
- 每条目一行：标题（title ?? slug，Link 到 `/wiki/<slug>?s=<subjectSlug>`，
  点击后 `closeSettingsDialog()`）+ subject 名 + 相对到期时间
  （复用 `formatSweepTime` 的相对时间逻辑，文案 `Due {time}`）。
  priority 不单列徽标：列表顺序（priority DESC）已表达优先级，内部数字对
  用户无解释价值（YAGNI）。
- `total > entries.length` 时末尾显示 `+{count} more`。
- 空列表（打开后恰好 count 变 0）显示 `No pages due right now.`。
- i18n：en / zh-CN 同步新增 key。

## 成功标准

- 到期明细端点返回的 `total` 与 status 的 `dueCount` 同口径；scope 为
  `subjects` 模式时明细只含所选 subject。
- 已到期但页面已删（maturity 孤儿行）不会导致端点报错，明细 title 回退。
- Settings 里点 `View` 能看到列表，点条目能跳到对应页面且弹窗关闭。
- `tsc --noEmit` 通过；新增 repo / route 测试通过，存量测试不回归。
