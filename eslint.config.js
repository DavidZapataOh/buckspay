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
            {
              group: ['**/modules/nfc/**'],
              message: 'Reach NFC through src/transport/nfc/native.ts, the only file that binds the module.',
            },
            {
              group: ['**/modules/mesh/**'],
              message: 'Reach the mesh through src/features/mesh/native.ts, the only file that binds the module.',
            },
            {
              group: ['**/modules/copresence/**'],
              message: 'Reach the modem through src/features/witness/native.ts, the only file that binds the module.',
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
            {
              group: ['**/modules/nfc/**'],
              message: 'Reach NFC through src/transport/nfc/native.ts, the only file that binds the module.',
            },
            {
              group: ['**/modules/mesh/**'],
              message: 'Reach the mesh through src/features/mesh/native.ts, the only file that binds the module.',
            },
            {
              group: ['**/modules/copresence/**'],
              message: 'Reach the modem through src/features/witness/native.ts, the only file that binds the module.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/transport/nearby/native.ts',
      'src/transport/nfc/native.ts',
      'src/features/witness/native.ts',
      'src/features/mesh/native.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/features/nfc/nfc-lab.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '**/keys/device-key'],
              message: 'The lab reaches the modules through the transports and their native.ts files.',
            },
          ],
        },
      ],
    },
  },
])
