/**
 * Tests de Graphify. No prueban el producto: prueban el mapa del que dependen
 * las decisiones de los agentes. Un mapa equivocado es peor que no tener mapa,
 * porque se lee con la misma cara de certeza.
 *
 * Correr: node --test scripts/graphify/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildGraph } from './lib/build.mjs'
import { serializeGraph, checkStale, sameGraph } from './lib/store.mjs'
import {
  indexGraph,
  findSymbols,
  resolveTarget,
  shortestPath,
  godNodes,
  fileReport,
} from './lib/query.mjs'
import { isCodeFile, hashContent } from './lib/repo.mjs'
import { resolveSpecifier } from './lib/resolve.mjs'

/** Repo de juguete: un caso por cosa que el grafo tiene que saber leer. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'graphify-test-'))
  const write = (relPath, content) => {
    mkdirSync(join(root, relPath, '..'), { recursive: true })
    writeFileSync(join(root, relPath), content)
  }

  write(
    'src/model.ts',
    [
      'export interface Project { id: string }',
      "export type ProjectState = 'draft' | 'live'",
      'export const DEFAULT_STATE: ProjectState = "draft"',
      'export function normalize(project: Project): Project {',
      '  return project',
      '}',
      'function internalHelper() {',
      '  return DEFAULT_STATE',
      '}',
      'export class ProjectService {',
      '  constructor(private readonly name: string) {}',
      '  load(id: string) {',
      '    return normalize({ id })',
      '  }',
      '  get label() {',
      '    return this.name',
      '  }',
      '  handle = () => internalHelper()',
      '}',
    ].join('\n')
  )

  write(
    'src/ui.tsx',
    [
      "import { normalize, ProjectService } from './model'",
      "import { useState } from 'react'",
      '',
      'export function ProjectCard() {',
      '  const [open, setOpen] = useState(false)',
      '  const service = new ProjectService("x")',
      '  return <div className="card">{normalize({ id: "1" }).id}</div>',
      '}',
      '',
      'export const useProjectCount = () => {',
      '  return 1',
      '}',
    ].join('\n')
  )

  write(
    'src/unused.ts',
    ['export const ORPHAN = 1', 'export const alsoOrphan = () => ORPHAN'].join(
      '\n'
    )
  )

  write('README.md', '# no es código')
  write('src/types.d.ts', 'declare const x: number')
  mkdirSync(join(root, 'node_modules', 'fake'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'fake', 'index.js'),
    'module.exports = 1'
  )

  return {
    root,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('el grafo solo incluye archivos de código', () => {
  const fixture = makeFixture()
  try {
    const graph = buildGraph({ root: fixture.root })
    const paths = graph.files.map((f) => f.path).sort()
    assert.deepEqual(paths, ['src/model.ts', 'src/ui.tsx', 'src/unused.ts'])
  } finally {
    fixture.cleanup()
  }
})

test('archivos de código: .d.ts y no-código quedan fuera', () => {
  assert.equal(isCodeFile('a/b.ts'), true)
  assert.equal(isCodeFile('a/b.tsx'), true)
  assert.equal(isCodeFile('a/b.mjs'), true)
  assert.equal(isCodeFile('a/b.d.ts'), false)
  assert.equal(isCodeFile('a/b.md'), false)
  assert.equal(isCodeFile('a/b.json'), false)
})

test('extrae símbolos con su tipo, incluidos los miembros de clase', () => {
  const fixture = makeFixture()
  try {
    const graph = buildGraph({ root: fixture.root })
    const byId = new Map(graph.symbols.map((s) => [s.id, s]))

    assert.equal(byId.get('src/model.ts#Project').kind, 'interface')
    assert.equal(byId.get('src/model.ts#ProjectState').kind, 'type')
    assert.equal(byId.get('src/model.ts#DEFAULT_STATE').kind, 'const')
    assert.equal(byId.get('src/model.ts#normalize').kind, 'function')
    assert.equal(byId.get('src/model.ts#normalize').exported, true)
    assert.equal(byId.get('src/model.ts#internalHelper').exported, false)
    assert.equal(byId.get('src/model.ts#ProjectService').kind, 'class')

    // El punto ciego clásico de un indexador: registrar la clase y perder sus
    // métodos. Si esto se rompe, el mapa dirá que el método no existe.
    assert.equal(byId.get('src/model.ts#ProjectService.load').kind, 'method')
    assert.equal(
      byId.get('src/model.ts#ProjectService.constructor').kind,
      'method'
    )
    assert.equal(byId.get('src/model.ts#ProjectService.label').kind, 'accessor')
    assert.equal(byId.get('src/model.ts#ProjectService.handle').kind, 'method')

    assert.equal(byId.get('src/ui.tsx#ProjectCard').kind, 'component')
    assert.equal(byId.get('src/ui.tsx#useProjectCount').kind, 'hook')
  } finally {
    fixture.cleanup()
  }
})

test('distingue imports internos de externos', () => {
  const fixture = makeFixture()
  try {
    const graph = buildGraph({ root: fixture.root })
    const fromUi = graph.imports.filter((e) => e.from === 'src/ui.tsx')
    const internal = fromUi.find((e) => e.kind === 'internal')
    const external = fromUi.find((e) => e.kind === 'external')

    assert.equal(internal.to, 'src/model.ts')
    assert.deepEqual(internal.names.sort(), ['ProjectService', 'normalize'])
    assert.equal(external.to, 'react')
  } finally {
    fixture.cleanup()
  }
})

test('las referencias cruzan archivos y quedan dentro de la clase', () => {
  const fixture = makeFixture()
  try {
    const graph = buildGraph({ root: fixture.root })
    const refs = new Set(graph.refs.map((r) => `${r.from}→${r.to}`))

    assert.ok(refs.has('src/ui.tsx#ProjectCard→src/model.ts#normalize'))
    assert.ok(refs.has('src/ui.tsx#ProjectCard→src/model.ts#ProjectService'))
    assert.ok(
      refs.has('src/model.ts#ProjectService.load→src/model.ts#normalize')
    )
    // `className` es una clave JSX, no una referencia a un símbolo.
    assert.ok(![...refs].some((r) => r.endsWith('#className')))
  } finally {
    fixture.cleanup()
  }
})

test('resolución de especificadores: relativo, alias, externo y .js → .ts', () => {
  const fileSet = new Set([
    'packages/contracts/src/index.ts',
    'packages/contracts/src/model.ts',
    'apps/web/src/App.tsx',
  ])
  const aliases = new Map([['@scope/contracts', 'packages/contracts/src']])

  assert.deepEqual(
    resolveSpecifier(
      './model.js',
      'packages/contracts/src/index.ts',
      fileSet,
      aliases
    ),
    { kind: 'internal', file: 'packages/contracts/src/model.ts' }
  )
  assert.deepEqual(
    resolveSpecifier(
      '@scope/contracts',
      'apps/web/src/App.tsx',
      fileSet,
      aliases
    ),
    { kind: 'internal', file: 'packages/contracts/src/index.ts' }
  )
  assert.equal(
    resolveSpecifier(
      '@tanstack/react-query',
      'apps/web/src/App.tsx',
      fileSet,
      aliases
    ).package,
    '@tanstack/react-query'
  )
  assert.equal(
    resolveSpecifier('node:fs', 'apps/web/src/App.tsx', fileSet, aliases)
      .package,
    'node:fs'
  )
})

test('el hash normaliza CRLF: el mismo contenido no se ve distinto en Windows y en CI', () => {
  assert.equal(
    hashContent('const a = 1\nconst b = 2\n'),
    hashContent('const a = 1\nconst b = 2\n')
  )
  assert.notEqual(hashContent('const a = 1\n'), hashContent('const a = 2\n'))
})

test('staleness: el código lo atrasa, la documentación no', () => {
  const fixture = makeFixture()
  try {
    const graph = buildGraph({ root: fixture.root })
    assert.equal(checkStale(graph, fixture.root).stale, false)

    fixture.write('README.md', '# sigue sin ser código')
    assert.equal(checkStale(graph, fixture.root).stale, false)

    fixture.write('src/unused.ts', 'export const ORPHAN = 2')
    const afterCode = checkStale(graph, fixture.root)
    assert.equal(afterCode.stale, true)
    assert.deepEqual(afterCode.changed, ['src/unused.ts'])

    fixture.write('src/nuevo.ts', 'export const NUEVO = 1')
    assert.deepEqual(checkStale(graph, fixture.root).added, ['src/nuevo.ts'])
  } finally {
    fixture.cleanup()
  }
})

test('la serialización deja una entrada por línea y sobrevive al round-trip', () => {
  const fixture = makeFixture()
  try {
    const graph = buildGraph({ root: fixture.root })
    const text = serializeGraph(graph)
    const parsed = JSON.parse(text)

    assert.equal(parsed.stats.files, graph.stats.files)
    assert.ok(sameGraph(parsed, graph))
    // Una línea por símbolo: si esto se rompe, cada build genera un diff ilegible.
    const symbolLines = text
      .split('\n')
      .filter((line) => line.trimStart().startsWith('{"id":'))
    assert.equal(symbolLines.length, graph.symbols.length)
  } finally {
    fixture.cleanup()
  }
})

test('sameGraph ignora builtAt y commit', () => {
  const fixture = makeFixture()
  try {
    const a = buildGraph({ root: fixture.root })
    const b = { ...a, builtAt: '1999-01-01T00:00:00.000Z', commit: 'otro' }
    assert.equal(sameGraph(a, b), true)
    assert.equal(sameGraph(a, { ...a, symbols: [] }), false)
  } finally {
    fixture.cleanup()
  }
})

test('consultas: búsqueda, resolución, camino y nodos-dios', () => {
  const fixture = makeFixture()
  try {
    const index = indexGraph(buildGraph({ root: fixture.root }))

    // Coincidencia exacta antes que parcial.
    assert.equal(
      findSymbols(index, 'normalize')[0].id,
      'src/model.ts#normalize'
    )
    assert.equal(findSymbols(index, 'norm')[0].name, 'normalize')
    assert.equal(findSymbols(index, '/^Project/').length > 0, true)
    assert.equal(
      findSymbols(index, 'load', { kind: 'method' })[0].id,
      'src/model.ts#ProjectService.load'
    )

    assert.deepEqual(resolveTarget(index, 'src/model.ts'), {
      type: 'file',
      id: 'src/model.ts',
    })
    assert.deepEqual(resolveTarget(index, 'normalize'), {
      type: 'symbol',
      id: 'src/model.ts#normalize',
    })
    assert.equal(resolveTarget(index, 'noExisteEnNingunLado').type, 'missing')

    const path = shortestPath(
      index,
      { type: 'file', id: 'src/ui.tsx' },
      { type: 'file', id: 'src/model.ts' }
    )
    assert.deepEqual(path, ['src/ui.tsx', 'src/model.ts'])

    // Sin camino hacia un archivo que nadie importa ni importa a nadie.
    assert.equal(
      shortestPath(
        index,
        { type: 'file', id: 'src/ui.tsx' },
        { type: 'file', id: 'src/unused.ts' }
      ),
      null
    )

    assert.equal(godNodes(index, { top: 1 })[0].id, 'src/model.ts')

    const report = fileReport(index, 'src/model.ts')
    assert.equal(report.importedBy.length, 1)
    // El reporte de archivo se lee en orden de lectura del archivo.
    const lines = report.symbols.map((s) => s.line)
    assert.deepEqual(
      lines,
      [...lines].sort((a, b) => a - b)
    )
  } finally {
    fixture.cleanup()
  }
})
