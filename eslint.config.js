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
          ],
        },
      ],
    },
  },
])
