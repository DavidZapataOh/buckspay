// Only localnet test builds allow cleartext traffic, to the validator on the device's own localhost:
// every other build keeps Android's default and refuses it.
const { zkPins } = require('./plugins/zk-pins')

module.exports = ({ config }) => ({
  ...config,
  // Hashes of the proving keys this build trusts; a release build refuses test keys.
  extra: { ...config.extra, zk: zkPins() },
  // Only end-to-end builds accept a link: a request or a payment never arrives as one.
  scheme: process.env.EXPO_PUBLIC_E2E === '1' ? [config.scheme, 'buckspay-e2e'] : config.scheme,
  plugins:
    process.env.EXPO_PUBLIC_NETWORK === 'localnet'
      ? [...config.plugins, './plugins/with-localnet-cleartext']
      : config.plugins,
})
