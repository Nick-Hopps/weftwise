'use client';

import { useEffect, useState } from 'react';

const KEY = 'wiki:retitle-notice';

/** 读取并一次性展示编辑器写入的「引用已联动更新」提示；展示后清除。 */
export function RetitleNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem(KEY);
    if (stored) {
      setMessage(stored);
      sessionStorage.removeItem(KEY);
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, []);

  if (!message) return null;

  return (
    <div className="max-w-content mx-auto px-6 pt-4 w-full">
      <div className="rounded-md border border-accent/30 bg-accent-subtle px-3 py-2 text-sm text-accent-strong">
        {message}
      </div>
    </div>
  );
}
