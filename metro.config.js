const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro') // make sure this import exists
const path = require('path')
const { withE2E } = require('./metro.e2e')

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

module.exports = withE2E(uniwindConfig, process.env.EXPO_PUBLIC_E2E === '1')
