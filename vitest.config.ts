import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // tsconfig 用 `jsx: preserve`（交给 Next 编译）；vitest 下 esbuild 会退回经典转换，
  // 产出裸 `React.createElement`，任何 import 了 .tsx 的测试都得先塞一个全局 React。
  // 显式用 automatic runtime，让 .tsx 自带 jsx-runtime 导入。
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
