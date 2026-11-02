/**
 * Persistencia del grafo y detección de atraso.
 *
 * El grafo se commitea (`.graphify/graph.json`): viaja con el repo, CI lo puede
 * usar y no depende de ningún índice local. Se serializa con UNA ENTRADA POR
 * LÍNEA a propósito — un JSON de una sola línea haría ilegible cualquier diff,
 * y un `JSON.stringify(…, 2)` triplicaría el tamaño.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { repoRoot, listCodeFiles, fileStats } from './repo.mjs'

export const GRAPH_PATH = '.graphify/graph.json'

function serializeList(name, entries, indent = '  ') {
  if (entries.length === 0) {
    return `${indent}"${name}": []`
  }
  const body = entries
    .map((entry) => `${indent}  ${JSON.stringify(entry)}`)
    .join(',\n')
  return `${indent}"${name}": [\n${body}\n${indent}]`
}

export function serializeGraph(graph) {
  const head = [
    `  "schemaVersion": ${JSON.stringify(graph.schemaVersion)}`,
    `  "generator": ${JSON.stringify(graph.generator)}`,
    `  "builtAt": ${JSON.stringify(graph.builtAt)}`,
    `  "commit": ${JSON.stringify(graph.commit)}`,
    `  "stats": ${JSON.stringify(graph.stats)}`,
  ]
  const lists = [
    serializeList('files', graph.files),
    serializeList('symbols', graph.symbols),
    serializeList('imports', graph.imports),
    serializeList('refs', graph.refs),
  ]
  return `{\n${[...head, ...lists].join(',\n')}\n}\n`
}

/** Compara dos grafos ignorando metadatos que cambian en cada corrida. */
export function sameGraph(a, b) {
  if (!a || !b) {
    return false
  }
  const strip = (g) => ({
    schemaVersion: g.schemaVersion,
    generator: g.generator,
    files: g.files,
    symbols: g.symbols,
    imports: g.imports,
    refs: g.refs,
  })
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

export function graphPath(root = repoRoot) {
  return join(root, GRAPH_PATH)
}

export function loadGraph(root = repoRoot) {
  const path = graphPath(root)
  if (!existsSync(path)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    throw new Error(`${GRAPH_PATH} ilegible: ${error.message}`)
  }
}

/**
 * Escribe el grafo salvo que sea idéntico al ya guardado (sin contar `builtAt`
 * y `commit`): así reconstruirlo no genera un diff vacío en cada commit.
 */
export function writeGraph(graph, { root = repoRoot, force = false } = {}) {
  const path = graphPath(root)
  if (!force) {
    let previous = null
    try {
      previous = loadGraph(root)
    } catch {
      previous = null
    }
    if (sameGraph(previous, graph)) {
      return { written: false, path }
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeGraph(graph))
  return { written: true, path }
}

/**
 * Compara el grafo guardado contra el estado actual de los archivos de código.
 *
 * Se compara por HASH DE CONTENIDO, no por commit: un commit que solo toca
 * documentación no atrasa el grafo, y un cambio de código sin commitear sí lo
 * atrasa (que es cuando más importa saberlo).
 */
export function checkStale(graph, root = repoRoot) {
  const current = new Map()
  for (const relPath of listCodeFiles(root)) {
    current.set(relPath, fileStats(relPath, root).hash)
  }
  const stored = new Map((graph?.files ?? []).map((f) => [f.path, f.hash]))

  const added = []
  const changed = []
  const removed = []

  for (const [path, hash] of current) {
    const previous = stored.get(path)
    if (previous === undefined) {
      added.push(path)
    } else if (previous !== hash) {
      changed.push(path)
    }
  }
  for (const path of stored.keys()) {
    if (!current.has(path)) {
      removed.push(path)
    }
  }

  return {
    stale: added.length + changed.length + removed.length > 0,
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  }
}
