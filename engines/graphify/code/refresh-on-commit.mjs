#!/usr/bin/env node
/**
 * Mantiene el grafo al día dentro del propio commit. Lo invoca el hook
 * post-commit (.githooks/post-commit), con el mismo patrón que
 * `bump-version.mjs`: reconstruye y amenda solo `.graphify/graph.json`.
 *
 * Es un mecanismo, no una regla escrita: "regenerá el mapa antes de commitear"
 * se olvida; esto no.
 *
 * FAIL-OPEN por diseño: cualquier problema acá imprime un aviso y sale con 0.
 * Un bug del guardia nunca debe detener la fábrica — el commit ya está hecho, y
 * el gate de CI sigue siendo el que bloquea si el grafo quedó atrasado.
 *
 * NO amenda si quedaron cambios de código sin commitear: el grafo describiría
 * código que no está en el commit.
 */
import { execFileSync } from 'node:child_process'
import { buildGraph } from './lib/build.mjs'
import { loadGraph, writeGraph, checkStale, GRAPH_PATH } from './lib/store.mjs'
import { repoRoot, isCodeFile } from './lib/repo.mjs'

const git = (args) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })

function main() {
  // Con ramas cortas el mapa se regenera sólo en el tronco (GRAPH_BRANCHES, lo fija
  // .githooks/post-commit): una rama de trabajo que lo commiteara chocaría con las demás en
  // `.graphify/graph.json`, y el merge hacia el tronco lo regenera entero. Vacío: todas las ramas.
  const trunks = (process.env.GRAPH_BRANCHES ?? '').split(',').map((b) => b.trim()).filter(Boolean)
  if (trunks.length && !trunks.includes(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim())) {
    return
  }

  let graph = null
  try {
    graph = loadGraph()
  } catch {
    graph = null
  }

  if (graph && !checkStale(graph).stale) {
    return
  }

  // Un commit parcial (`git add` de algunos archivos) deja código modificado
  // fuera del commit: el mapa reconstruido desde el working tree no
  // correspondería a este commit.
  const dirty = git(['status', '--porcelain'])
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((path) => isCodeFile(path))

  if (dirty.length > 0) {
    console.error(
      `graphify: hay ${dirty.length} archivo(s) de código sin commitear; ` +
        `el grafo no se actualiza en este commit. Corré 'npm run graph:build' cuando cierres el cambio.`
    )
    return
  }

  const rebuilt = buildGraph()
  const result = writeGraph(rebuilt)
  if (!result.written) {
    return
  }

  git(['add', '--', GRAPH_PATH])
  execFileSync(
    'git',
    [
      'commit',
      '--amend',
      '--no-edit',
      '--no-verify',
      '--only',
      '--',
      GRAPH_PATH,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  )
  const s = rebuilt.stats
  console.log(
    `graphify: mapa actualizado en el commit — ${s.files} archivos, ${s.symbols} símbolos`
  )
}

try {
  main()
} catch (error) {
  console.error(`graphify: no se pudo actualizar el mapa (${error.message}).`)
}
process.exit(0)
