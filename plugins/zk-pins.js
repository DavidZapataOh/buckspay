const fs = require('fs')

// The keys a build trusts without asking the chain: the manifests a ceremony wrote, named by the paths in
// ZK_KEYS_MANIFEST (comma separated). A release build refuses keys whose trapdoor is known.
/** @param {Record<string, string | undefined>} [env] */
function zkPins(env = process.env) {
  const paths = (env.ZK_KEYS_MANIFEST ?? '').split(',').filter(Boolean)
  return paths.map((path) => {
    const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (manifest.Test && env.BUCKSPAY_RELEASE === '1') {
      throw new Error(`${path} holds test keys, whose trapdoor is known: a release build refuses them`)
    }
    return {
      vkSha256: manifest.VKSHA256,
      pkSha256: manifest.PKBinSHA256,
      ccsSha256: manifest.CCSSHA256,
      dumpSha256: manifest.PKDumpSHA256,
    }
  })
}

module.exports = { zkPins }
