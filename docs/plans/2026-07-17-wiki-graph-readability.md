# Wiki Graph 可读性优化实现计划

## 任务 1：锁定图数据聚合合同

涉及文件：

- `src/app/api/graph/__tests__/route.test.ts`
- `src/app/api/graph/graph-data.ts`
- `src/app/api/graph/route.ts`

步骤：

1. 写失败测试，覆盖同向重复引用聚合、反向关系保留、跨 Subject/缺失节点过滤、唯一入链来源计数。
2. 运行目标测试并确认因现有 API 返回重复边而失败。
3. 提取纯函数构建图投影，在 Route Handler 中接入。
4. 再次运行目标测试转绿。

验证命令：

```bash
npx vitest run src/app/api/graph/__tests__/route.test.ts
```

## 任务 2：放宽布局与标签视觉

涉及文件：

- `src/components/graph/__tests__/graph-layout.test.ts`
- `src/components/graph/graph-layout.ts`
- `src/components/graph/graph-stylesheet.ts`
- `src/components/graph/use-wiki-graph.ts`
- `src/app/(app)/page.tsx`

步骤：

1. 写失败测试，锁定布局必须满足的最小理想边长、斥力、最大重力和标签可读性参数。
2. 提高 `LAYOUT_COMPACT` 的间距并降低向心力。
3. 调整标签字号、默认对比度与最大宽度。
4. 增加 Dashboard 图的响应式稳定高度。
5. 将聚合边的 `weight` 传入 Cytoscape 数据。

验证命令：

```bash
npx vitest run src/components/graph/__tests__/graph-layout.test.ts
```

## 任务 3：让全屏按真实画布适配

涉及文件：

- `src/components/graph/mini-graph-view.tsx`
- `src/components/graph/fullscreen-graph.tsx`

步骤：

1. 进入全屏前保存完整 zoom/pan 快照。
2. 迁移容器后用 Cytoscape `fit` 动画计算全屏 zoom/pan，并兼容 reduced motion。
3. 退出时恢复紧凑视口，不重新运行布局。
4. 将图中统计文案明确为可视化关系数。

验证命令：

```bash
npx tsc --noEmit
npm run lint
```

## 任务 4：真实页面验收与回归

步骤：

1. 用本地真实 Wiki 数据启动开发服务器。
2. 在 1440x1000 下截图对比 Dashboard 主图，进入全屏验证 fit、拖拽、聚焦与退出恢复。
3. 在 390x844 下确认无页面横向溢出、控制按钮可用、全屏图不空白。
4. 检查浏览器 console 无新增错误。
5. 运行目标测试、全量测试、TypeScript、lint 和生产构建。

验证命令：

```bash
npx vitest run src/app/api/graph/__tests__/route.test.ts src/components/graph/__tests__/graph-layout.test.ts
npm test
npx tsc --noEmit
npm run lint
npm run build
```
