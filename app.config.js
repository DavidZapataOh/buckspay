// Only localnet test builds allow cleartext traffic, to the validator on the device's own localhost:
// every other build keeps Android's default and refuses it.
module.exports = ({ config }) => ({
  ...config,
  plugins:
    process.env.EXPO_PUBLIC_NETWORK === 'localnet'
      ? [...config.plugins, './plugins/with-localnet-cleartext']
      : config.plugins,
})
