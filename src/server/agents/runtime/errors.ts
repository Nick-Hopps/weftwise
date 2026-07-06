/**
 * agents runtime 共享错误类型（叶子模块，禁止 import 任何业务模块）。
 *
 * 独立成文件是为了打破 provider-registry ↔ agent-loop 的循环依赖：
 * agent-loop 依赖 provider-registry.resolveModel，而 provider-registry 的
 * 取消轮询需要抛 AgentCancelled——二者统一从本模块引入。
 */
export class AgentCancelled extends Error {
  constructor() { super('Agent cancelled'); this.name = 'AgentCancelled'; }
}
