const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

// The Localnet network is a validator forwarded to the device's own localhost over plain HTTP.
// Release builds refuse cleartext traffic, so allow it for localhost only. A network security
// config overrides `usesCleartextTraffic`, so debug builds keep cleartext for Metro everywhere.
const release = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`
const debug = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`
const configs = { main: release, debug, debugOptimized: debug }

module.exports = (config) => {
  config = withDangerousMod(config, [
    'android',
    (config) => {
      for (const [sourceSet, xml] of Object.entries(configs)) {
        const dir = path.join(config.modRequest.platformProjectRoot, 'app/src', sourceSet, 'res/xml')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'network_security_config.xml'), xml)
      }
      return config
    },
  ])
  return withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config'
    return config
  })
}
