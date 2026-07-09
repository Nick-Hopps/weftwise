import type React from 'react';

/**
 * 判断当前 keydown 是否来自输入法（IME）组词过程。
 * 中文/日文等输入法里按 Enter 确认候选词时，浏览器仍会派发 key === 'Enter' 的
 * keydown，若不拦截会误触发发送/提交/保存。keyCode 229 是 Safari 的兜底标识
 *（其 compositionend 后仍可能派发一个 isComposing=false 的 Enter）。
 */
export function isImeComposing(e: React.KeyboardEvent<Element>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- keyCode 229 是 Safari IME 唯一可靠信号
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * 挂在 <form onKeyDown> 上：阻止 IME 组词确认的 Enter 触发表单隐式提交。
 */
export function blockImeEnterSubmit(e: React.KeyboardEvent<HTMLFormElement>): void {
  if (e.key === 'Enter' && isImeComposing(e)) e.preventDefault();
}
