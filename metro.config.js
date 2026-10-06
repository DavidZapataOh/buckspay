const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro') // make sure this import exists
const path = require('path')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)

// Apply uniwind modifications before exporting
const uniwindConfig = withUniwindConfig(config, {
  // relative path to your global.css file
  cssEntryFile: './src/global.css',
  // optional: path to typings
  dtsFile: './src/uniwind-types.d.ts',
})

// Cache transforms per project; the machine-wide Metro cache can serve stale transforms from other projects.
uniwindConfig.cacheStores = ({ FileStore }) => [
  new FileStore({ root: path.join(__dirname, 'node_modules', '.cache', 'metro') }),
]

// End-to-end builds run the transport contract suite inside the app, so `vitest` resolves to the subset it uses.
if (process.env.EXPO_PUBLIC_E2E === '1') {
  const { resolveRequest } = uniwindConfig.resolver
  uniwindConfig.resolver.resolveRequest = (context, moduleName, platform) =>
    moduleName === 'vitest'
      ? { type: 'sourceFile', filePath: path.join(__dirname, 'src/transport/testing/vitest-shim.ts') }
      : (resolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = uniwindConfig
