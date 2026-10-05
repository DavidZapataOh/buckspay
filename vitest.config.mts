import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // The program's scripts are tested with Node's own runner.
  test: {
    exclude: ['**/node_modules/**', 'anchor/scripts/**'],
    env: { EXPO_PUBLIC_FUNDING_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
  },
})
