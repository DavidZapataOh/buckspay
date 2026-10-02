export default {
  idl: 'target/idl/buckspay.json',
  scripts: {
    js: {
      from: '@codama/renderers-js',
      args: [
        'anchor/src/client/js',
        { generatedFolder: 'generated', kitImportStrategy: 'rootOnly', syncPackageJson: false },
      ],
    },
    rust: {
      from: '@codama/renderers-rust',
      args: ['gateway/client', { anchorTraits: false }],
    },
  },
}
