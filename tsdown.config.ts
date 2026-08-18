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
          const match = code.match(/^(?:import (?:\{[^}]+\}|(\w+),?\s*\{([^}]*)\}) from )?"react(?:\/jsx-runtime)?";\n/gm)
          if (!match) return code
          const imports = []
          let replaced = code
          for (const m of code.matchAll(/import\s+(?:\{([^}]+)\}|(\w+),?\s*\{([^}]*)\})?\s*from\s*"react(?:\/jsx-runtime)?";?/g)) {
            const module = m[0].includes('jsx-runtime') ? 'react/jsx-runtime' : 'react'
            const bindings = m[1] ?? (m[2] ? m[2] + (m[3] ? ', ' + m[3] : '') : m[3] ?? '')
            if (bindings) imports.push([bindings, module])
          }
          replaced = code.replace(/import\s+(?:\{[^}]+\}|\w+,?\s*\{[^}]*\})?\s*from\s*"react(?:\/jsx-runtime)?";?\n?/g, '')
          const requires = imports.map(([bindings, module]) => {
            const clean = bindings.replace(/\s+/g, ' ')
            return clean.includes(',')
              ? `\t\tvar { ${clean.split(',').map(b => b.trim()).join(', ')} } = require("${module}");`
              : `\t\tvar { ${clean} } = require("${module}");`
          }).join('\n')
          const exports = replaced.match(/export\s*\{([^}]+)\};?\n?/m)
          const exportNames = exports ? exports[1].split(',').map(n => n.trim().split(' as ').pop()!.trim()).filter(Boolean) : []
          const body = replaced.replace(/export\s*\{[^}]+\};?\n?/m, '')
          const assigns = exportNames.map(n => `\t\tmodule.exports.${n} = ${n};`).join('\n')
          return `window.__ModuleLoader__.load({\n\tid: "dsh-claude-code",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${requires}\n${body.replace(/^/gm, '\t\t')}${assigns}\n\t\treturn module.exports;\n\t}\n});`
        },
      },
    }],
    sourcemap: true,
    deps: { neverBundle: [/^@deepseek-ai\//, /^react(?:\/.*)?$/, /^react-dom(?:\/.*)?$/] },
  },
])
