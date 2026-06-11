/**
 * 服务端统一日志 facade：所有 console 输出带 `[module]` 前缀，便于在
 * worker / next 混合输出中定位来源。新代码请使用 createLogger，
 * 不要直接调 console.*。
 */

export interface Logger {
  info: (message: string) => void;
  warn: (message: string, detail?: unknown) => void;
  error: (message: string, err?: unknown) => void;
}

export function createLogger(module: string): Logger {
  const prefix = `[${module}]`;
  return {
    info: (message) => console.log(`${prefix} ${message}`),
    warn: (message, detail) =>
      detail === undefined
        ? console.warn(`${prefix} ${message}`)
        : console.warn(`${prefix} ${message}`, detail),
    error: (message, err) =>
      err === undefined
        ? console.error(`${prefix} ${message}`)
        : console.error(`${prefix} ${message}`, err),
  };
}
