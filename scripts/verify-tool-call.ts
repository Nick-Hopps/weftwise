/**
 * 工具调用（tool call / function calling）端点验证脚本
 *
 * 用途：实测「当前 llm-config 解析出的模型端点」是否真正支持工具调用，
 *       而不是靠项目历史/文档外推。它直接复用 app 的 task-router + provider-factory，
 *       因此打到的就是 app 真正在用的那条线路（endpoint + model + auth）。
 *
 * 探测三件历史上踩过坑的事：
 *   ① 工具名是否被端点接受（OpenAI 系要求 ^[a-zA-Z0-9_-]{1,64}$，点号名会 400）
 *   ② 工具调用参数能否干净往返、JSON 是否合法（DeepSeek 等会在合法 JSON 后吐尾随垃圾）
 *   ③ 多轮工具循环能否「收敛」——消费工具结果后作答，还是空转撞 maxSteps（reviewer 死循环特征）
 *
 * 运行：
 *   npx tsx scripts/verify-tool-call.ts                 # 默认测 query 任务
 *   npx tsx scripts/verify-tool-call.ts query ingest    # 测多个任务各自的路由
 *
 * 环境：从 .env / .env.local 读取 *_API_KEY（与 worker 一致）。
 */

import { generateText, tool, InvalidToolArgumentsError } from 'ai';
import { z } from 'zod';
import { resolveTask } from '../src/server/llm/task-router';
import { getLanguageModel } from '../src/server/llm/provider-factory';

// ── env 加载（.env 后被 .env.local 覆盖，与 dev:all 的 --env-file-if-exists 顺序一致）──
for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* 文件不存在或不支持，忽略 */ }
}

const PROBE_TIMEOUT_MS = 90_000;
const PROBE_MAX_TOKENS = 2048;

// ── app 的 repairToolCallArgs 逻辑内联（避免 import agent-loop 拖入 DB/settings 副作用）──
function extractFirstJsonValue(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
function repairToolCallArgs(rawArgs: string): string | null {
  const extracted = extractFirstJsonValue(rawArgs);
  if (!extracted || extracted === rawArgs) return null;
  try { JSON.parse(extracted); } catch { return null; }
  return extracted;
}

// ── 确定性「知识库」工具（小参数、只读，贴合 Ask 真实用法）──
function cannedSearch(query: string): string {
  const q = query.toLowerCase();
  if (q.includes('capital') && q.includes('france')) return 'The capital of France is Paris.';
  if (q.includes('paris') || q.includes('landmark') || q.includes('eiffel'))
    return 'The most famous landmark in Paris is the Eiffel Tower.';
  return `No specific entry for "${query}". Treat this as an authoritative placeholder snippet.`;
}
const searchTool = tool({
  description:
    'Look up authoritative factual information from the knowledge base. ' +
    'Always prefer this tool over your own knowledge.',
  parameters: z.object({ query: z.string().describe('the search query') }),
  execute: async ({ query }: { query: string }) => ({ result: cannedSearch(query) }),
});

interface ProbeOutcome {
  ok: boolean;
  note: string;
  detail: Record<string, unknown>;
}

function describeError(err: unknown): Record<string, unknown> {
  const e = err as Record<string, unknown> & { message?: string; name?: string };
  const out: Record<string, unknown> = {
    name: e?.name ?? typeof err,
    message: e?.message ?? String(err),
  };
  if (InvalidToolArgumentsError.isInstance?.(err))
    out.classified = 'InvalidToolArgumentsError —— 端点吐了非法的工具参数 JSON（需 repair）';
  for (const k of ['statusCode', 'responseBody', 'url']) {
    if (e && e[k] !== undefined) out[k] = e[k];
  }
  if (e?.cause) out.cause = (e.cause as { message?: string })?.message ?? String(e.cause);
  return out;
}

interface GenLike {
  steps?: Array<{ toolCalls?: Array<{ toolName: string; args: unknown }> }>;
  finishReason: string;
  text?: string;
}

function aggregate(result: GenLike) {
  const steps = result.steps ?? [];
  const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
  return {
    stepCount: steps.length,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map((t) => t.toolName),
    firstArgs: toolCalls[0]?.args,
    finishReason: result.finishReason,
    text: (result.text ?? '').trim(),
  };
}

async function runProbes(task: string): Promise<void> {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`Task: ${task}`);

  let model: ReturnType<typeof getLanguageModel>;
  try {
    const route = resolveTask(task as Parameters<typeof resolveTask>[0]);
    const prov = route.provider as { provider: string; baseURL?: string; name?: string };
    model = getLanguageModel(route);
    console.log(
      `Endpoint: profile=${route.profileName}  provider=${prov.provider}  ` +
        `model=${route.model}  baseURL=${prov.baseURL ?? '(provider default)'}`,
    );
    console.log('═'.repeat(64));
  } catch (err) {
    console.log('═'.repeat(64));
    console.log('❌ 无法解析模型端点（配置或 API key 问题）：');
    console.log(JSON.stringify(describeError(err), null, 2));
    return;
  }

  const verdict: Record<string, boolean | string> = {};

  // ── Probe 1：强制工具调用 + 原始参数往返（无 repair）。同时测 toolChoice:'required' 支持。──
  let p1: ProbeOutcome;
  try {
    const res = await generateText({
      model,
      tools: { search: searchTool },
      toolChoice: 'required',
      maxSteps: 1,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      prompt: 'What is the capital of France? Use the search tool to look it up.',
    });
    const a = aggregate(res);
    const called = a.toolCallCount > 0;
    const argsValid = !!a.firstArgs && typeof a.firstArgs === 'object';
    p1 = {
      ok: called && argsValid,
      note: called
        ? `工具被调用：${a.toolNames.join(',')}(${JSON.stringify(a.firstArgs)})；参数 JSON 合法 ${argsValid ? '✅' : '❌'}`
        : '端点未发起任何工具调用（toolChoice:required 可能不被支持，或模型拒调）',
      detail: a,
    };
    verdict['工具调用'] = p1.ok;
    verdict['参数往返(原始)'] = argsValid;
  } catch (err) {
    p1 = { ok: false, note: '抛错（原始参数往返失败）', detail: describeError(err) };
    verdict['工具调用'] = false;
    verdict['参数往返(原始)'] = false;
  }
  printProbe('Probe 1 · 强制工具调用 + 原始参数往返 (toolChoice=required, maxSteps=1, 无 repair)', p1);

  // ── Probe 2：启用 app 的 repairToolCall，看缓解是否触发/救回 ──
  let p2: ProbeOutcome;
  const repairFlag = { fired: false };
  try {
    const res = await generateText({
      model,
      tools: { search: searchTool },
      toolChoice: 'required',
      maxSteps: 1,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      experimental_repairToolCall: async ({ toolCall, error }) => {
        if (!InvalidToolArgumentsError.isInstance(error)) return null;
        const repaired = repairToolCallArgs(toolCall.args);
        if (!repaired) return null;
        repairFlag.fired = true;
        return { ...toolCall, args: repaired };
      },
      prompt: 'What is the capital of France? Use the search tool to look it up.',
    });
    const a = aggregate(res);
    p2 = {
      ok: a.toolCallCount > 0,
      note: repairFlag.fired
        ? 'repair 触发了 ✅（原始端点参数有问题，但 app 缓解救回）'
        : '无需 repair（端点参数本就干净）',
      detail: { ...a, repairFired: repairFlag.fired },
    };
    verdict['repair 是否必需'] = repairFlag.fired ? 'YES' : 'no';
  } catch (err) {
    p2 = { ok: false, note: '即便启用 repair 仍抛错', detail: describeError(err) };
    verdict['repair 是否必需'] = '即便 repair 也救不回';
  }
  printProbe('Probe 2 · app repairToolCall 缓解 (toolChoice=required, maxSteps=1)', p2);

  // ── Probe 3：单跳自然收敛（auto）——消费工具结果后是否正常作答收尾 ──
  let p3: ProbeOutcome;
  try {
    const res = await generateText({
      model,
      tools: { search: searchTool },
      maxSteps: 6,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      experimental_repairToolCall: async ({ toolCall, error }) => {
        if (!InvalidToolArgumentsError.isInstance(error)) return null;
        const repaired = repairToolCallArgs(toolCall.args);
        return repaired ? { ...toolCall, args: repaired } : null;
      },
      prompt:
        'Use the search tool to find the capital of France, then answer in one sentence.',
    });
    const a = aggregate(res);
    const converged = a.finishReason === 'stop' && a.text.length > 0;
    p3 = {
      ok: converged && a.toolCallCount > 0,
      note: converged
        ? `收敛 ✅ (工具调用 ${a.toolCallCount} 次, steps=${a.stepCount}, finish=stop, 终答非空)`
        : `未收敛 ⚠️ (steps=${a.stepCount}, finish=${a.finishReason}, toolCalls=${a.toolCallCount}, 终答${a.text ? '非空' : '为空'})`,
      detail: { ...a, text: a.text.slice(0, 160) },
    };
    verdict['单跳收敛'] = p3.ok;
  } catch (err) {
    p3 = { ok: false, note: '抛错', detail: describeError(err) };
    verdict['单跳收敛'] = false;
  }
  printProbe('Probe 3 · 单跳自然收敛 (toolChoice=auto, maxSteps=6)', p3);

  // ── Probe 4：多跳收敛（需 2 次 search）——死循环最敏感的探测 ──
  let p4: ProbeOutcome;
  const P4_MAX = 8;
  try {
    const res = await generateText({
      model,
      tools: { search: searchTool },
      maxSteps: P4_MAX,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      experimental_repairToolCall: async ({ toolCall, error }) => {
        if (!InvalidToolArgumentsError.isInstance(error)) return null;
        const repaired = repairToolCallArgs(toolCall.args);
        return repaired ? { ...toolCall, args: repaired } : null;
      },
      prompt:
        'Using ONLY the search tool: first look up the capital of France, then look up ' +
        'the most famous landmark in that capital, then state that landmark in one sentence.',
    });
    const a = aggregate(res);
    const converged = a.finishReason === 'stop' && a.text.length > 0;
    const hitCap = a.stepCount >= P4_MAX && a.finishReason !== 'stop';
    p4 = {
      ok: converged,
      note: converged
        ? `收敛 ✅ (工具调用 ${a.toolCallCount} 次, steps=${a.stepCount}, finish=stop)`
        : hitCap
          ? `❌ 撞 maxSteps 仍在调工具（死循环特征）：steps=${a.stepCount}/${P4_MAX}, toolCalls=${a.toolCallCount}, finish=${a.finishReason}`
          : `⚠️ 异常终止：finish=${a.finishReason}, toolCalls=${a.toolCallCount}`,
      detail: { ...a, text: a.text.slice(0, 200) },
    };
    verdict['多跳收敛'] = p4.ok;
  } catch (err) {
    p4 = { ok: false, note: '抛错', detail: describeError(err) };
    verdict['多跳收敛'] = false;
  }
  printProbe('Probe 4 · 多跳收敛 / 死循环探测 (toolChoice=auto, 需 2 次 search, maxSteps=8)', p4);

  // ── Probe 5：点号工具名原样发送，探测端点是否强制 provider-safe 名 ──
  let p5: ProbeOutcome;
  try {
    const res = await generateText({
      model,
      tools: { 'vault.search': searchTool },
      toolChoice: 'required',
      maxSteps: 1,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      prompt: 'Look up the capital of France.',
    });
    const a = aggregate(res);
    p5 = {
      ok: a.toolCallCount > 0,
      note: a.toolCallCount > 0
        ? '端点接受点号工具名 ✅（app 的 toProviderToolName 对该端点非必需）'
        : '点号名下未发起调用',
      detail: a,
    };
    verdict['点号工具名'] = a.toolCallCount > 0 ? '接受' : '未调用';
  } catch (err) {
    const d = describeError(err);
    p5 = {
      ok: false,
      note: '点号工具名被拒 → app 的工具名 sanitize 对该端点是必需的',
      detail: d,
    };
    verdict['点号工具名'] = '被拒(需 sanitize)';
  }
  printProbe('Probe 5 · 点号工具名 vault.search 原样发送 (探测 name sanitize 必要性)', p5);

  // ── 小结 ──
  console.log(`\n─── 小结 (${task}) ───`);
  for (const [k, v] of Object.entries(verdict)) {
    const mark = typeof v === 'boolean' ? (v ? '✅' : '❌') : `→ ${v}`;
    console.log(`  ${k.padEnd(16)} ${typeof v === 'boolean' ? mark : mark}`);
  }
  const supports = verdict['工具调用'] === true && verdict['单跳收敛'] === true && verdict['多跳收敛'] === true;
  console.log(
    `\n  结论：该端点 ${supports ? '✅ 正常支持 tool call' : '⚠️/❌ 工具调用存在问题（见上）'}` +
      `${verdict['repair 是否必需'] === 'YES' ? '（依赖 app 的 repair 缓解）' : ''}`,
  );
}

async function main() {
  const tasks = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = tasks.length > 0 ? tasks : ['query'];
  console.log(`验证工具调用支持 —— 任务：${targets.join(', ')}`);
  for (const t of targets) {
    try {
      await runProbes(t);
    } catch (err) {
      console.log(`\n[task ${t}] 未捕获错误：`, err);
    }
  }
  console.log('\n完成。');
}

main();

function printProbe(title: string, o: ProbeOutcome): void {
  console.log(`\n[${o.ok ? 'PASS ✅' : 'FAIL ⚠️'}] ${title}`);
  console.log(`  ${o.note}`);
  console.log(`  detail: ${JSON.stringify(o.detail)}`);
}
