import type { JobStreamEvent } from '@/hooks/use-job-stream';
import { SYNTHETIC_FINAL_ID } from '@/hooks/job-stream-logic';
import { stripLegacyToolActivityIcon, toolNameFromEvent } from '@/lib/tool-activity';

export type JobLogTone = 'default' | 'success' | 'warning' | 'error';

export interface JobLogLine {
  time: string;
  text: string;
  isError: boolean;
  tool: string | null;
  tone: JobLogTone;
}

export interface JobError {
  message: string;
  stack?: string;
  cause?: string;
  responseText?: string;
  finishReason?: string;
  usage?: unknown;
}

function pickText(data: Record<string, unknown>): string {
  const v = data.message;
  return typeof v === 'string' && v.length > 0 ? v : '';
}

function formatLogTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logTone(type: string): JobLogTone {
  if (type === 'job:failed' || type.endsWith(':error')) return 'error';
  if (type === 'job:completed' || type.endsWith(':complete') || type.endsWith(':done')) {
    return 'success';
  }
  if (type === 'job:retrying' || type.endsWith(':warn') || type.endsWith(':validation-failed')) {
    return 'warning';
  }
  return 'default';
}

/** 把一条 job 事件归一化为一行日志（时间 + 文本 + 是否错误行）。 */
export function eventLogLine(event: JobStreamEvent): JobLogLine {
  const data = event.data ?? {};
  const createdAt = typeof data.createdAt === 'string' ? data.createdAt : '';
  const tool = toolNameFromEvent(event);
  const text = pickText(data) || event.type;
  const tone = logTone(event.type);
  return {
    time: formatLogTime(createdAt),
    text: tool ? stripLegacyToolActivityIcon(text) : text,
    isError: tone === 'error',
    tool,
    tone,
  };
}

/** 去掉 SSE 为关闭连接追加的无文案终态标记，只保留真实持久化事件。 */
export function eventLogLines(events: JobStreamEvent[]): JobLogLine[] {
  return events
    .filter((event) => event.id !== SYNTHETIC_FINAL_ID)
    .map(eventLogLine);
}

/** 解析 jobs.resultJson 中的 error 对象；非法/无 error 返回 null。 */
export function parseJobError(resultJson: string | null | undefined): JobError | null {
  if (!resultJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const err = (parsed as Record<string, unknown>).error;
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const out: JobError = {
    message: typeof e.message === 'string' ? e.message : String(e.message ?? 'Job failed'),
  };
  if (typeof e.stack === 'string') out.stack = e.stack;
  if (e.cause != null) out.cause = typeof e.cause === 'string' ? e.cause : JSON.stringify(e.cause);
  if (typeof e.responseText === 'string') out.responseText = e.responseText;
  if (typeof e.finishReason === 'string') out.finishReason = e.finishReason;
  if (e.usage != null) out.usage = e.usage;
  return out;
}
