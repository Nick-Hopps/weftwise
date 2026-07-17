# Ask AI 统一结构化 LLM 意图分类设计

**日期：** 2026-07-17
**状态：** 已确认，待实现

## 一、背景与问题

Ask AI 当前有两套意图识别机制：选区配图已经使用结构化 LLM 分类，其余功能仍由同步正则判断。正则目前同时承担普通 Query 的 `read/propose` 分流、单页 Re-enrich 快捷命令及目标提取、Wiki 重置请求、重置确认与取消。

这带来三类问题：

1. 自然语言的语序、同义词、否定和上下文变化会持续造成漏判或误判。
2. 同一个聊天入口同时存在服务端与客户端两套规则，语义和失败策略容易漂移。
3. Re-enrich 正则既分类又提取参数，继续扩充会让控制流越来越难审计。

## 二、目标与成功标准

1. 所有 Ask AI 自然语言意图统一由一个结构化 LLM 分类入口判断。
2. 分类结果使用有限枚举，并以结构化字段表达 Re-enrich 的当前页或显式 slug 目标。
3. 普通 Wiki 变更、History 回滚和 workflow 操作继续只获得 `query:propose` 工具面，不能直接写入。
4. 明确的单动作 Re-enrich 仍可直接创建 PendingAction 预览，不等待主 Query 工具循环。
5. 选区配图继续要求可信 canonical 选区；Reshape 选区确定性拒绝写入。
6. Wiki 重置请求进入二次确认态；确认、取消和不明确回复也走同一结构化分类入口。
7. 分类失败时保守降级：普通请求回到 `read`，重置确认回到 `unclear`，绝不扩大权限或执行重置。
8. 生产代码中不再保留面向用户自然语言的意图正则。

## 三、非目标

- 不改变 PendingAction 的批准状态机、页面 Saga、History 回滚或 workflow 入队机制。
- 不把 LLM 分类结果当成写权限凭证；工具 profile、选区来源和服务端 payload 校验保持不变。
- 不改变 `/api/reset` 的鉴权、CSRF、Subject、vault 锁和活动任务守卫。
- 不为此次分类新增独立模型配置，继续复用 `query` task。
- 不处理 Markdown、URL、wikilink、路径或敏感信息脱敏等语法正则，它们不属于自然语言意图识别。

## 四、方案比较

### 方案 A：分别把每组正则替换为独立 LLM 分类器

实现局部、风险较低，但一次请求可能产生多次分类调用，schema、prompt 和失败策略仍会分散，不能形成单一真实源。

### 方案 B：只保留主 Query 模型，让它自行选择工具

调用次数最少，但必须在分类前暴露完整 propose 工具面；也无法在进入工具循环前完成 Reshape 拒绝、Re-enrich 快捷预览和客户端重置确认，不采用。

### 方案 C：统一的前置结构化分类器（推荐）

每个聊天请求先执行一次结构化分类，返回意图枚举和目标引用。服务端再根据可信请求上下文映射能力和控制流。重置确认通过显式 `reset-confirmation` 上下文复用同一入口。

代价是普通 Ask AI 请求增加一次小型结构化调用；收益是自然语言语义、失败策略和权限映射全部集中，且不会提前暴露 propose 工具。

## 五、分类契约

分类输出固定为：

```ts
{
  intent:
    | 'read'
    | 'propose'
    | 'direct-reenrich'
    | 'image-insert'
    | 'reset-request'
    | 'reset-confirm'
    | 'reset-cancel'
    | 'reset-unclear';
  targetPage: {
    reference: 'none' | 'current-page' | 'slug';
    slug: string | null;
  };
}
```

约束如下：

- `read`：普通问答、教程、能力询问、假设、否定或取消的非确认态请求。
- `propose`：明确要求创建、更新、删除、移动、重命名、History 回滚、Research 启动或 workflow 取消等写入提案。
- `direct-reenrich`：仅限整句、单动作、目标明确的页面 Re-enrich 命令；目标通过 `targetPage` 表达。
- `image-insert`：明确要求现在为随请求提供的可信选区生成并插入图片。
- `reset-request`：明确要求清空当前 Subject Wiki。
- `reset-confirm/reset-cancel/reset-unclear`：仅在 `reset-confirmation` 分类上下文中有效。

服务端对不符合上下文的结果做确定性收窄。例如无选区的 `image-insert` 退回 `read`，普通请求中出现确认类结果也退回 `read`，缺失有效目标的 `direct-reenrich` 不走快捷路径。

## 六、请求与控制流

```text
Chat 发送原始 userQuestion + Query 上下文 question
  -> /api/query 调统一 classifyQueryIntent
  -> reset-request：返回 reset-confirmation SSE，前端进入确认态
  -> reset-confirmation 上下文：分类 confirm/cancel/unclear
       -> confirm：前端调用现有 /api/reset
       -> cancel/unclear：结束确认或继续提示
  -> direct-reenrich：服务端解析结构化目标并创建 PendingAction 预览
  -> image-insert + reshape：确定性拒绝
  -> image-insert + canonical：query:propose + 专用配图提案工具
  -> propose：query:propose
  -> read/失败：query:read
```

`/api/query` body 增加可选 `intentContext: 'reset-confirmation'`。首次重置请求仍经过正常会话创建和持久化；前端收到专用 SSE 后保存本地确认态。第二轮只用该显式上下文解释“是/否”等短回复，避免普通问答中的“继续”被误当作重置批准。

## 七、安全与失败策略

- 分类器没有 `SubjectId`、文件路径、offset 或写工具参数的决定权。
- `query:propose` 仍只包含生成 PendingAction 的提案工具。
- Re-enrich 目标由服务端结合当前页上下文解析，缺少目标时不走直接路径。
- 配图仍要求 canonical 选区；分类结果不能伪造 block anchor。
- `reset-confirm` 只有在客户端已经持有本轮 reset confirmation 状态并显式发送上下文时才有效，最终请求仍由 `/api/reset` 全套守卫执行。
- 结构化调用异常、超时或 schema 无效时，普通请求返回 `read`，确认上下文返回 `reset-unclear`。

## 八、测试策略

1. Prompt/schema 单测覆盖所有枚举、上下文和目标字段。
2. 分类服务单测注入假生成器，验证结构化调用、上下文收窄与失败回退。
3. Query route 单测覆盖 read、propose、direct Re-enrich、canonical/reshape 配图和重置三态 SSE。
4. 前端通过抽出的纯状态转换函数测试重置确认事件和上下文请求构造。
5. 定向测试通过后运行全量 Vitest、lint、build 与 `git diff --check`。

