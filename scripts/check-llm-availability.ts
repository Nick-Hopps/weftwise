/**
 * LLM 服务可用性 + 结构化输出诊断脚本（一次性）。
 *
 * 用法：
 *   npx tsx --env-file=.env.local scripts/check-llm-availability.ts
 *
 * 对 llm-config.json 中 ingest / query / lint 三类任务，按生产路径
 * （resolveTask → getLanguageModel）各做两项探测：
 *   1) generateText  —— 验证连通性 / 鉴权 / 模型名是否有效
 *   2) generateObject —— 用一个极小 schema 复现「response did not match schema.」
 *
 * 不写库、不写 vault。每次调用 maxTokens 很小，超时 40s。
 */

import { generateText, generateObject, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import { resolveTask } from '../src/server/llm/task-router';
import { getLanguageModel } from '../src/server/llm/provider-factory';
import type { LLMTask } from '../src/server/llm/config-schema';

const TASKS: LLMTask[] = ['ingest', 'query', 'lint'];
const PROBE_TIMEOUT_MS = 40_000;

// 极小的结构化输出契约：嵌套对象 + 数组，专门用于暴露弱模型 / 代理的 shape 漂移。
const ProbeSchema = z.object({
  ok: z.boolean(),
  capital: z.string(),
  meta: z.object({
    population_millions: z.number(),
    tags: z.array(z.string()),
  }),
});

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(PROBE_TIMEOUT_MS);
}

function short(v: unknown, n = 300): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function probeText(task: LLMTask) {
  const route = resolveTask(task);
  const model = getLanguageModel(route);
  const t0 = Date.now();
  try {
    const r = await generateText({
      model,
      prompt: 'Reply with exactly the word: pong',
      maxTokens: 16,
      abortSignal: withTimeout(),
    });
    return {
      ok: true,
      ms: Date.now() - t0,
      text: r.text.trim(),
      usage: r.usage,
    };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, err };
  }
}

async function probeObject(task: LLMTask) {
  const route = resolveTask(task);
  const model = getLanguageModel(route);
  const t0 = Date.now();
  try {
    const r = await generateObject({
      model,
      schema: ProbeSchema,
      prompt:
        'Return a JSON object describing France: ok=true, its capital, ' +
        'meta.population_millions (number), meta.tags (array of 2 strings).',
      maxTokens: 200,
      abortSignal: withTimeout(),
    });
    return { ok: true, ms: Date.now() - t0, object: r.object };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, err };
  }
}

function describeError(err: unknown): void {
  if (NoObjectGeneratedError.isInstance?.(err) || err instanceof NoObjectGeneratedError) {
    const e = err as NoObjectGeneratedError;
    console.log(`      SDK error : ${e.message}`);
    console.log(`      finish    : ${e.finishReason}`);
    console.log(`      raw text  : ${short(e.text)}`);
    const cause = e.cause as { name?: string; message?: string } | undefined;
    if (cause) {
      console.log(`      cause     : ${cause.name ?? ''} ${short(cause.message)}`);
    }
    return;
  }
  if (err instanceof Error) {
    console.log(`      error     : ${err.name}: ${err.message}`);
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      console.log(`      cause     : ${cause.name}: ${short(cause.message)}`);
    } else if (cause) {
      console.log(`      cause     : ${short(cause)}`);
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status) console.log(`      status    : ${status}`);
    const body = (err as { responseBody?: string }).responseBody;
    if (body) console.log(`      body      : ${short(body)}`);
    return;
  }
  console.log(`      error     : ${short(err)}`);
}

async function main() {
  console.log('\n══════════════ LLM 服务可用性 + 结构化输出诊断 ══════════════\n');

  for (const task of TASKS) {
    const route = resolveTask(task);
    const baseURL =
      'baseURL' in route.provider ? (route.provider.baseURL ?? '(provider default)') : '(provider default)';
    console.log(`▶ task=${task}  profile=${route.profileName}  provider=${route.provider.provider}`);
    console.log(`  model=${route.model}  baseURL=${baseURL}`);

    const text = await probeText(task);
    if (text.ok) {
      console.log(`  [generateText]   ✅ ${text.ms}ms  → "${short(text.text, 60)}"  (in=${text.usage?.promptTokens} out=${text.usage?.completionTokens})`);
    } else {
      console.log(`  [generateText]   ❌ ${text.ms}ms`);
      describeError(text.err);
    }

    const obj = await probeObject(task);
    if (obj.ok) {
      console.log(`  [generateObject] ✅ ${obj.ms}ms  → ${short(obj.object, 120)}`);
    } else {
      console.log(`  [generateObject] ❌ ${obj.ms}ms`);
      describeError(obj.err);
    }

    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch((e) => {
  console.error('诊断脚本自身异常：', e);
  process.exit(1);
});
