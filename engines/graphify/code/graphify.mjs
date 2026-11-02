#!/usr/bin/env node
/**
 * Graphify — mapa del código de este repo (Pilar 2 del método de trabajo).
 *
 * Grafo AST versionado: se genera, se commitea y se consulta. Sin LLM, sin red
 * y sin servidor; el archivo `.graphify/graph.json` viaja con el repo, así que
 * CI y cualquier agente leen exactamente el mismo mapa.
 *
 * Uso:
 *   node scripts/graphify/graphify.mjs <comando> [opciones]
 *   npm run graph -- <comando> [opciones]
 *
 * El grafo es una brújula, no la verdad: conexión no es causalidad, y si el
 * mapa dice que algo no existe, hay que verificarlo antes de creerle.
 */
import { buildGraph } from './lib/build.mjs'
import { loadGraph, writeGraph, checkStale, GRAPH_PATH } from './lib/store.mjs'
import {
  indexGraph,
  findSymbols,
  findFiles,
  resolveTarget,
  neighborsOf,
  shortestPath,
  godNodes,
  fileReport,
} from './lib/query.mjs'

const USAGE = `Graphify — mapa del código (grafo AST versionado)

  build                          reconstruye ${GRAPH_PATH}
  stale                          ¿el grafo está atrasado? (exit 1 si sí)
  stats                          tamaño y forma del grafo
  symbol <query>                 busca símbolos por nombre, Clase.metodo,
                                 archivo#nombre, /regex/ o re:regex
                                 (en Git Bash usá re:… — /… se vuelve ruta)
  file <ruta>                    qué declara, qué importa y quién lo importa
  neighbors <nodo>               vecinos de un archivo o símbolo
  path <origen> <destino>        camino más corto entre dos nodos
  gods                           nodos más conectados (dónde se propaga un cambio)

Opciones:
  --limit N        máximo de resultados (default 25)
  --depth N        profundidad de neighbors (default 1)
  --in | --out     dirección: solo entrantes o solo salientes
  --kind K         filtra por tipo: function, component, hook, class, method,
                   interface, type, enum, const, namespace, accessor
  --exported       solo símbolos exportados
  --file F         restringe la búsqueda a rutas que contengan F
  --symbols        en gods, rankea símbolos en vez de archivos
  --top N          en gods, cuántos mostrar (default 15)
  --force          en build, reescribe aunque no haya cambios
  --quiet          menos ruido en stdout
  --json           salida JSON en vez de texto
`

function parseArgs(argv) {
  const options = {
    limit: 25,
    depth: 1,
    top: 15,
    direction: 'both',
    quiet: false,
    json: false,
    force: false,
    exported: false,
    symbols: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--limit':
        options.limit = Number(argv[++i])
        break
      case '--depth':
        options.depth = Number(argv[++i])
        break
      case '--top':
        options.top = Number(argv[++i])
        break
      case '--kind':
        options.kind = argv[++i]
        break
      case '--file':
        options.file = argv[++i]
        break
      case '--in':
        options.direction = 'in'
        break
      case '--out':
        options.direction = 'out'
        break
      case '--exported':
        options.exported = true
        break
      case '--symbols':
        options.symbols = true
        break
      case '--force':
        options.force = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--json':
        options.json = true
        break
      default:
        positional.push(arg)
    }
  }
  return { options, positional }
}

function fail(message) {
  console.error(`graphify: ${message}`)
  process.exit(1)
}

function requireGraph() {
  const graph = loadGraph()
  if (!graph) {
    fail(`no existe ${GRAPH_PATH}. Corré: npm run graph:build`)
  }
  return graph
}

/**
 * Aviso de atraso en toda consulta: un mapa viejo miente con la misma cara que
 * uno fresco. No bloquea — solo deja de ser invisible.
 */
function warnIfStale(graph) {
  const status = checkStale(graph)
  if (!status.stale) {
    return
  }
  const total =
    status.added.length + status.changed.length + status.removed.length
  console.error(
    `graphify: ⚠ grafo atrasado (${total} archivo(s) de código cambiaron desde el build). ` +
      `Corré 'npm run graph:build' antes de confiar en este resultado.`
  )
}

function symbolLine(symbol) {
  const flags = [symbol.kind, symbol.exported ? 'exported' : null]
    .filter(Boolean)
    .join(' ')
  const qualified = symbol.id.split('#')[1] ?? symbol.name
  return `${symbol.file}:${symbol.line}  ${qualified}  [${flags}, ${symbol.lines} líneas]`
}

function nodeLabel(index, id) {
  const symbol = index.symbols.get(id)
  return symbol ? `${symbol.id} (${symbol.file}:${symbol.line})` : id
}

function printAmbiguous(resolved) {
  console.error(
    `graphify: "${resolved.kind}" ambiguo, ${resolved.candidates.length}+ candidatos:`
  )
  for (const candidate of resolved.candidates) {
    console.error(`  ${candidate}`)
  }
}

function resolveOrExit(index, target) {
  const resolved = resolveTarget(index, target)
  if (resolved.type === 'missing') {
    console.error(
      `graphify: no hay nodo para "${target}". El mapa puede estar incompleto: verificá con grep antes de concluir que no existe.`
    )
    process.exit(1)
  }
  if (resolved.type === 'ambiguous') {
    printAmbiguous(resolved)
    process.exit(1)
  }
  return resolved
}

function cmdBuild(options) {
  const started = Date.now()
  const graph = buildGraph({
    onProgress: (done, total) => {
      if (!options.quiet && (done % 50 === 0 || done === total)) {
        process.stderr.write(`\rgraphify: parseando ${done}/${total}`)
      }
    },
  })
  if (!options.quiet) {
    process.stderr.write('\n')
  }
  const result = writeGraph(graph, { force: options.force })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const s = graph.stats
  if (!options.quiet) {
    console.log(
      `${result.written ? 'escrito' : 'sin cambios'}: ${GRAPH_PATH} — ` +
        `${s.files} archivos, ${s.symbols} símbolos, ${s.imports} imports, ` +
        `${s.refs} refs, ${s.externalPackages} paquetes externos (${elapsed}s)`
    )
  }
}

function cmdStale(options) {
  const graph = loadGraph()
  if (!graph) {
    console.error(`graphify: falta ${GRAPH_PATH}. Corré: npm run graph:build`)
    process.exit(1)
  }
  const status = checkStale(graph)
  if (!status.stale) {
    if (!options.quiet) {
      console.log(
        `grafo al día — ${graph.files.length} archivos de código, construido ${graph.builtAt}`
      )
    }
    return
  }
  const show = (label, list) => {
    if (list.length === 0) {
      return
    }
    console.error(`  ${label} (${list.length}):`)
    for (const path of list.slice(0, options.limit)) {
      console.error(`    ${path}`)
    }
    if (list.length > options.limit) {
      console.error(`    … y ${list.length - options.limit} más`)
    }
  }
  console.error('graphify: grafo ATRASADO respecto del código actual.')
  show('modificados', status.changed)
  show('nuevos', status.added)
  show('borrados', status.removed)
  console.error("Corré 'npm run graph:build' y commiteá el resultado.")
  process.exit(1)
}

function cmdStats(options) {
  const graph = requireGraph()
  if (options.json) {
    console.log(JSON.stringify(graph.stats, null, 2))
    return
  }
  const byKind = new Map()
  for (const symbol of graph.symbols) {
    byKind.set(symbol.kind, (byKind.get(symbol.kind) ?? 0) + 1)
  }
  const lines = graph.files.reduce((acc, f) => acc + f.lines, 0)
  console.log(`grafo construido: ${graph.builtAt}`)
  console.log(`commit de build:  ${graph.commit ?? '(sin git)'}`)
  console.log(
    `archivos: ${graph.stats.files} (${lines} líneas)   símbolos: ${graph.stats.symbols}`
  )
  console.log(
    `imports: ${graph.stats.imports} (${graph.stats.externalPackages} paquetes externos)   refs: ${graph.stats.refs}`
  )
  console.log('símbolos por tipo:')
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${kind}`)
  }
  warnIfStale(graph)
}

function cmdSymbol(query, options) {
  if (!query) {
    fail('falta el nombre a buscar. Ej: npm run graph -- symbol useStore')
  }
  const graph = requireGraph()
  const index = indexGraph(graph)
  const hits = findSymbols(index, query, {
    kind: options.kind,
    exportedOnly: options.exported,
    file: options.file,
  })
  if (options.json) {
    console.log(JSON.stringify(hits.slice(0, options.limit), null, 2))
  } else if (hits.length === 0) {
    console.log(
      `sin resultados para "${query}". El mapa puede no cubrirlo: verificá con grep antes de concluir que no existe.`
    )
  } else {
    for (const symbol of hits.slice(0, options.limit)) {
      console.log(symbolLine(symbol))
    }
    if (hits.length > options.limit) {
      console.log(`… ${hits.length - options.limit} resultados más (--limit N)`)
    }
  }
  warnIfStale(graph)
  if (hits.length === 0) {
    process.exit(1)
  }
}

function cmdFile(target, options) {
  if (!target) {
    fail('falta la ruta. Ej: npm run graph -- file src/App.tsx')
  }
  const graph = requireGraph()
  const index = indexGraph(graph)
  const matches = index.files.has(target) ? [target] : findFiles(index, target)
  if (matches.length === 0) {
    console.error(
      `graphify: ningún archivo del grafo coincide con "${target}".`
    )
    process.exit(1)
  }
  if (matches.length > 1 && !index.files.has(target)) {
    const exact = matches.filter((path) => path.endsWith(target))
    if (exact.length !== 1) {
      console.error(
        `graphify: "${target}" coincide con ${matches.length} archivos:`
      )
      for (const path of matches.slice(0, 15)) {
        console.error(`  ${path}`)
      }
      process.exit(1)
    }
    matches[0] = exact[0]
  }

  const report = fileReport(index, matches[0])
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    warnIfStale(graph)
    return
  }

  console.log(
    `${report.node.path}  [${report.node.lines} líneas, ${report.node.symbols} símbolos]`
  )
  if (report.symbols.length > 0) {
    console.log(`\ndeclara (${report.symbols.length}):`)
    for (const symbol of report.symbols.slice(0, options.limit)) {
      console.log(
        `  ${symbol.file}:${symbol.line}  ${symbol.name}  [${symbol.kind}${symbol.exported ? ', exported' : ''}]`
      )
    }
    if (report.symbols.length > options.limit) {
      console.log(
        `  … y ${report.symbols.length - options.limit} más (--limit N)`
      )
    }
  }
  if (report.importsInternal.length > 0) {
    console.log('\nimporta del repo:')
    for (const edge of report.importsInternal) {
      console.log(
        `  ${edge.to}${edge.names.length > 0 ? `  (${edge.names.join(', ')})` : ''}`
      )
    }
  }
  if (report.importsExternal.length > 0) {
    console.log(
      `\nimporta externo: ${report.importsExternal.map((e) => e.to).join(', ')}`
    )
  }
  if (report.importedBy.length > 0) {
    console.log(`\nimportado por (${report.importedBy.length}):`)
    for (const edge of report.importedBy.slice(0, options.limit)) {
      console.log(`  ${edge.from}`)
    }
    if (report.importedBy.length > options.limit) {
      console.log(`  … y ${report.importedBy.length - options.limit} más`)
    }
  }
  warnIfStale(graph)
}

function cmdNeighbors(target, options) {
  if (!target) {
    fail('falta el nodo. Ej: npm run graph -- neighbors src/App.tsx')
  }
  const graph = requireGraph()
  const index = indexGraph(graph)
  const resolved = resolveOrExit(index, target)
  const levels = neighborsOf(index, resolved, {
    depth: options.depth,
    direction: options.direction,
  })

  if (options.json) {
    console.log(JSON.stringify({ target: resolved, levels }, null, 2))
    warnIfStale(graph)
    return
  }

  console.log(`${resolved.type}: ${nodeLabel(index, resolved.id)}`)
  if (levels.length === 0) {
    console.log(
      resolved.type === 'symbol'
        ? 'sin vecinos en el grafo de referencias (las refs son heurísticas: verificá con grep).'
        : 'sin vecinos internos.'
    )
  }
  for (const level of levels) {
    console.log(`\nnivel ${level.level} (${level.nodes.length}):`)
    for (const entry of level.nodes.slice(0, options.limit)) {
      console.log(`  ${entry.via.padEnd(13)} ${nodeLabel(index, entry.node)}`)
    }
    if (level.nodes.length > options.limit) {
      console.log(`  … y ${level.nodes.length - options.limit} más`)
    }
  }
  warnIfStale(graph)
}

function cmdPath(from, to, options) {
  if (!from || !to) {
    fail('faltan origen y destino. Ej: npm run graph -- path App.tsx model.ts')
  }
  const graph = requireGraph()
  const index = indexGraph(graph)
  let source = resolveOrExit(index, from)
  let target = resolveOrExit(index, to)

  // Tipos mixtos: se compara a nivel archivo, que es el grafo completo
  // (las refs símbolo → símbolo solo existen donde el nombre se pudo resolver).
  if (source.type !== target.type) {
    const toFile = (node) =>
      node.type === 'file'
        ? node
        : { type: 'file', id: index.symbols.get(node.id).file }
    console.log(
      '(origen y destino son de tipo distinto: se busca el camino entre sus archivos)'
    )
    source = toFile(source)
    target = toFile(target)
  }

  const path = shortestPath(index, source, target, {
    direction: options.direction,
  })
  if (!path) {
    console.log(
      `sin camino entre ${source.id} y ${target.id}` +
        (source.type === 'symbol'
          ? ' en el grafo de referencias. Probá a nivel archivo.'
          : '.')
    )
    warnIfStale(graph)
    process.exit(1)
  }
  if (options.json) {
    console.log(JSON.stringify(path, null, 2))
  } else {
    console.log(`camino de ${path.length - 1} salto(s):`)
    path.forEach((node, i) => {
      console.log(`  ${i === 0 ? '' : '↓ '}${nodeLabel(index, node)}`)
    })
    console.log(
      '\nconexión no es causalidad: el camino dice que hay relación, no que el cambio se propague por ahí.'
    )
  }
  warnIfStale(graph)
}

function cmdGods(options) {
  const graph = requireGraph()
  const index = indexGraph(graph)
  const rows = godNodes(index, {
    scope: options.symbols ? 'symbols' : 'files',
    top: options.top,
  })
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2))
    warnIfStale(graph)
    return
  }
  console.log(
    `${options.symbols ? 'símbolos' : 'archivos'} más conectados (in = quién lo usa, out = qué usa):`
  )
  console.log(
    `  ${'in'.padStart(4)} ${'out'.padStart(4)} ${'líneas'.padStart(7)}  nodo`
  )
  for (const row of rows) {
    console.log(
      `  ${String(row.in).padStart(4)} ${String(row.out).padStart(4)} ${String(row.lines).padStart(7)}  ${row.id}`
    )
  }
  console.log(
    '\nun número alto no es un defecto por sí solo: es dónde un cambio se propaga más lejos.'
  )
  warnIfStale(graph)
}

const [, , command, ...rest] = process.argv
const { options, positional } = parseArgs(rest)

switch (command) {
  case 'build':
    cmdBuild(options)
    break
  case 'stale':
  case 'check':
    cmdStale(options)
    break
  case 'stats':
    cmdStats(options)
    break
  case 'symbol':
    cmdSymbol(positional[0], options)
    break
  case 'file':
    cmdFile(positional[0], options)
    break
  case 'neighbors':
    cmdNeighbors(positional[0], options)
    break
  case 'path':
    cmdPath(positional[0], positional[1], options)
    break
  case 'gods':
    cmdGods(options)
    break
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    console.log(USAGE)
    break
  default:
    console.error(`graphify: comando desconocido "${command}"\n`)
    console.log(USAGE)
    process.exit(1)
}
