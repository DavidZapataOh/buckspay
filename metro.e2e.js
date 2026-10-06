const path = require('path')

const LAB = /(^|\/)features\/nfc\/nfc-lab$/

/**
 * End-to-end builds run the transport contract suite inside the app, so `vitest` resolves to the subset it uses.
 * Every other build replaces the suite with an empty module, which keeps test-only code out of the bundle.
 */
function withE2E(config, e2e) {
  const { resolveRequest } = config.resolver
  const next =
    resolveRequest ?? ((context, moduleName, platform) => context.resolveRequest(context, moduleName, platform))
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (e2e && moduleName === 'vitest') {
      return { type: 'sourceFile', filePath: path.join(__dirname, 'src/transport/testing/vitest-shim.ts') }
    }
    if (!e2e && LAB.test(moduleName)) return { type: 'empty' }
    return next(context, moduleName, platform)
  }
  return config
}

module.exports = { withE2E }
