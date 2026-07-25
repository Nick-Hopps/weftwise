# 本地测试用例 HTML 报告工具

- 日期：2026-07-22
- 状态：已定稿
- 关联计划：[docs/plans/2026-07-22-test-report-html.md](../plans/2026-07-22-test-report-html.md)

## 一、目标

新增一个可重复执行的脚本，扫描仓库中的 Vitest 测试用例，运行本地测试并导出独立 HTML 报告。报告按功能分组展示测试文件、测试用例、状态、耗时和错误信息，并为每个功能统计：

1. 用例通过率：已执行用例中通过数量的比例；
2. 用例执行覆盖率：已返回执行结果的用例数量占扫描到的用例数量的比例；
3. 代码行覆盖率：如果存在 Istanbul/Vitest `coverage-summary.json`，按功能归属聚合 `covered / total`，否则显示未采集，而不是伪造数值。

## 二、输入与输出

- 输入测试文件：`src/**/__tests__/**/*.test.ts`、`scripts/**/__tests__/**/*.test.ts`，同时兼容 `.spec.ts` 和 `.test.tsx`。
- 测试结果：脚本调用本地 `vitest run --reporter=json` 生成临时 JSON；也支持 `--results <path>` 复用已有结果。
- 覆盖率：自动读取 `coverage/coverage-summary.json`，或通过 `--coverage-summary <path>` 指定。
- 需要运行覆盖率采集时可传 `--coverage`；这沿用 Vitest 已安装的 coverage provider。当前仓库未固定 provider，未安装时报告仍会生成，但代码覆盖率显示未采集。
- 输出：默认 `test-report.html`，可通过 `--output <path>` 指定；HTML 不依赖外部资源，适合直接打开或作为构建产物归档。

## 三、功能分组

默认按测试文件路径推导，例如 `src/server/services/__tests__/query.test.ts` 归入 `server/services`；文件顶部首个 `@feature: 名称` 注释可覆盖默认分组。这样不要求改动既有测试，又给跨目录功能提供稳定命名入口。

## 四、失败与降级

- 测试进程失败仍生成报告，报告顶部显示命令失败和错误输出，CLI 以 Vitest 原退出码退出。
- 找不到 coverage provider 或 coverage-summary 时不阻断报告生成，代码覆盖率列显示“未采集”，用例执行覆盖率仍可用。
- 结果中无法匹配静态扫描用例的动态测试归入对应文件的功能，并标记为“运行结果未建立静态清单”。

## 五、非目标

- 不引入 Web 服务或数据库；
- 不修改现有测试用例；
- 不把测试数量比例称为代码覆盖率。
