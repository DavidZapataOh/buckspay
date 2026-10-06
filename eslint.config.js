// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['anchor/src/client/js/generated/*', 'anchor/target/*', 'dist/*'],
  },
  {
    ignores: ['src/keys/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/hardware-keys/**', '**/keys/device-key'],
              message: 'Sign through src/keys, which checks every message before the device key signs it.',
            },
            { group: ['**/transport/testing/**'], message: 'Test doubles live under testing/ and are for tests only.' },
            {
              group: ['**/modules/nearby/**'],
              message: 'Reach Nearby through src/transport/nearby/native.ts, the only file that binds the module.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/transport/testing/**'],
    ignores: ['src/keys/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/hardware-keys/**', '**/keys/device-key'],
              message: 'Sign through src/keys, which checks every message before the device key signs it.',
            },
            {
              group: ['**/modules/nearby/**'],
              message: 'Reach Nearby through src/transport/nearby/native.ts, the only file that binds the module.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/transport/nearby/native.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
])
