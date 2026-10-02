const { withGradleProperties } = require('expo/config-plugins')

const key = 'org.gradle.jvmargs'
const value = '-Xmx4g -XX:MaxMetaspaceSize=1g'

module.exports = (config) =>
  withGradleProperties(config, (config) => {
    const property = config.modResults.find((item) => item.type === 'property' && item.key === key)
    if (property) property.value = value
    else config.modResults.push({ type: 'property', key, value })
    return config
  })
