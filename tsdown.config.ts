import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'preset-route': 'src/preset-route.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: 'esm',
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//, /^@anthropic-ai\//] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    format: 'esm',
    plugins: [{
      name: 'dsh-module-loader',
      renderChunk: {
        order: 'post',
        handler(code) {
          const importPattern = /import\s+\{([^}]+)\}\s+from\s+"([^"]+)";?\n?/g
          const imports = [...code.matchAll(importPattern)]
          if (imports.length === 0) return code
          const replaced = code.replace(importPattern, '')
          const requires = imports.map(([, bindings, module]) => {
            const clean = bindings.replace(/\s+/g, ' ')
            return `\t\tvar { ${clean.split(',').map(binding => binding.trim()).join(', ')} } = require("${module}");`
          }).join('\n')
          const exports = replaced.match(/export\s*\{([^}]+)\};?\n?/m)
          const exportNames = exports ? exports[1].split(',').map(n => n.trim().split(' as ').pop()!.trim()).filter(Boolean) : []
          const body = replaced.replace(/export\s*\{[^}]+\};?\n?/m, '')
          const assigns = exportNames.map(n => `\t\tmodule.exports.${n} = ${n};`).join('\n')
          return `window.__ModuleLoader__.load({\n\tid: "@norman-else/dsh-claude",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${requires}\n${body.replace(/^/gm, '\t\t')}${assigns}\n\t\treturn module.exports;\n\t}\n});`
        },
      },
    }],
    sourcemap: true,
    deps: { neverBundle: [/^@deepseek-ai\//, /^react(?:\/.*)?$/, /^react-dom(?:\/.*)?$/] },
  },
])
