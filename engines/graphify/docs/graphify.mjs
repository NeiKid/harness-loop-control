#!/usr/bin/env node
/**
 * Graphify — mapa del conocimiento de este repo.
 *
 * Variante para repos de documentos (el motor `code` es el grafo AST). El grafo
 * es de documentos: archivos, secciones, enlaces internos y fuentes externas citadas. Se genera, se
 * commitea y se consulta. Sin LLM, sin red y sin servidor.
 *
 * Uso:
 *   node scripts/graphify/graphify.mjs <comando> [opciones]
 *   npm run graph -- <comando> [opciones]
 *
 * El grafo es una brújula, no la verdad: que un documento cite una fuente no
 * prueba que la fuente diga lo que el documento afirma. Para eso está la
 * sección "Verificación adversarial" de cada documento.
 */
import { buildGraph } from './lib/build.mjs'
import { loadGraph, writeGraph, checkStale, GRAPH_PATH } from './lib/store.mjs'
import {
  indexGraph,
  resolveNode,
  search,
  docReport,
  sourceReport,
  tagReport,
  neighborsOf,
  shortestPath,
  godNodes,
  brokenLinks,
} from './lib/query.mjs'

const USAGE = `Graphify — mapa del conocimiento (grafo versionado de documentos)

  build                          reconstruye ${GRAPH_PATH}
  stale                          ¿el grafo está atrasado? (exit 1 si sí)
  stats                          tamaño y forma del grafo
  search <query>                 títulos, descripciones, tags y secciones
                                 (texto, /regex/ o re:regex; en Git Bash usá re:…)
  doc <ruta>                     frontmatter, secciones, enlaces y fuentes de un documento
  source <query>                 qué documentos citan un URL o dominio
  tag [tag]                      documentos con un tag (sin tag: lista de tags)
  neighbors <nodo>               vecinos de un documento o una fuente
  path <origen> <destino>        camino más corto (por enlaces o fuentes compartidas)
  gods                           nodos más conectados
  broken                         enlaces internos rotos (exit 1 si hay)

Opciones:
  --limit N        máximo de resultados (default 25)
  --depth N        profundidad de neighbors (default 1)
  --in | --out     dirección: solo entrantes o solo salientes
  --kind K         filtra search por tipo de archivo: doc, control, artifact, root
  --sources        en gods, rankea fuentes por cantidad de documentos que las citan
  --domains        en gods, rankea dominios
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
    kind: null,
    mode: 'files',
    quiet: false,
    json: false,
    force: false,
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
      case '--in':
        options.direction = 'in'
        break
      case '--out':
        options.direction = 'out'
        break
      case '--sources':
        options.mode = 'sources'
        break
      case '--domains':
        options.mode = 'domains'
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
      case '-h':
      case '--help':
        positional.unshift('help')
        break
      default:
        positional.push(arg)
    }
  }
  return { command: positional[0] ?? 'help', args: positional.slice(1), options }
}

function emit(options, data, text) {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(text)
  }
}

/** Un mapa viejo se lee con la misma cara de certeza que uno fresco: avisar siempre. */
function loadForQuery(options) {
  const graph = loadGraph()
  if (!graph) {
    console.error(`No existe ${GRAPH_PATH}. Corré 'npm run graph:build'.`)
    process.exit(2)
  }
  const stale = checkStale(graph)
  if (stale.stale && !options.quiet) {
    const n = stale.added.length + stale.changed.length + stale.removed.length
    console.error(`aviso: el grafo está atrasado (${n} archivo(s)). Corré 'npm run graph:build' antes de decidir con él.`)
  }
  return indexGraph(graph)
}

function requireNode(index, query) {
  const node = resolveNode(index, query ?? '')
  if (!query || !node) {
    console.error(`No encontré un documento ni una fuente para '${query ?? ''}'.`)
    process.exit(2)
  }
  return node
}

const label = (node) => (node.type === 'source' ? `[fuente] ${node.id}` : node.id)

function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2))

  switch (command) {
    case 'build': {
      const graph = buildGraph()
      const result = writeGraph(graph, { force: options.force })
      const s = graph.stats
      emit(options, { ...result, stats: s },
        `${result.written ? 'Escrito' : 'Sin cambios'}: ${GRAPH_PATH} — ${s.files} archivos, ` +
          `${s.sections} secciones, ${s.links} enlaces (${s.brokenLinks} rotos), ` +
          `${s.cites} citas a ${s.sources} fuentes en ${s.domains} dominios`)
      return
    }
    case 'stale': {
      const graph = loadGraph()
      const result = graph ? checkStale(graph) : { stale: true, missing: true, added: [], changed: [], removed: [] }
      const lines = [result.stale ? 'ATRASADO' : 'Al día']
      if (result.missing) lines.push(`  no existe ${GRAPH_PATH}`)
      for (const p of result.added) lines.push(`  + ${p}`)
      for (const p of result.changed) lines.push(`  ~ ${p}`)
      for (const p of result.removed) lines.push(`  - ${p}`)
      if (result.stale) lines.push(`Se arregla con 'npm run graph:build' y commiteando ${GRAPH_PATH}.`)
      emit(options, result, lines.join('\n'))
      process.exit(result.stale ? 1 : 0)
    }
    case 'stats': {
      const index = loadForQuery(options)
      const g = index.graph
      const byKind = {}
      for (const f of g.files) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
      emit(options, { ...g.stats, byKind, builtAt: g.builtAt, commit: g.commit },
        [
          `Construido: ${g.builtAt}${g.commit ? ` (commit ${g.commit.slice(0, 8)})` : ''}`,
          `Archivos:   ${g.stats.files} (${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ')})`,
          `Secciones:  ${g.stats.sections}`,
          `Enlaces:    ${g.stats.links} (${g.stats.brokenLinks} rotos)`,
          `Citas:      ${g.stats.cites} a ${g.stats.sources} fuentes en ${g.stats.domains} dominios`,
        ].join('\n'))
      return
    }
    case 'search': {
      const index = loadForQuery(options)
      const result = search(index, args.join(' '), options)
      emit(options, result,
        [
          ...result.results.map((r) => `${r.path}:${r.line}  ${r.type === 'section' ? '§ ' : ''}${r.text}`),
          `${result.total} resultado(s)${result.total > result.results.length ? `, mostrando ${result.results.length}` : ''}`,
        ].join('\n'))
      return
    }
    case 'doc': {
      const index = loadForQuery(options)
      const node = requireNode(index, args[0])
      if (node.type !== 'file') {
        console.error(`'${args[0]}' es una fuente; usá 'source'.`)
        process.exit(2)
      }
      const r = docReport(index, node.id)
      const f = r.file
      const lines = [`${f.path}  [${f.kind}${f.type ? ` · ${f.type}` : ''}]`, `  ${f.title}`]
      if (f.description) lines.push(`  ${f.description}`)
      if (f.tags) lines.push(`  tags: ${f.tags.join(', ')}`)
      lines.push('', `Secciones (${r.sections.length})`)
      for (const s of r.sections) lines.push(`  ${f.path}:${s.line}  ${'  '.repeat(s.level - 1)}${s.title}`)
      lines.push('', `Enlaza a (${r.out.length})`)
      for (const l of r.out) lines.push(`  ${l.to}${l.anchor ? `#${l.anchor}` : ''}${l.broken ? `  ROTO (${l.broken})` : ''}  ← ${f.path}:${l.line}`)
      lines.push('', `Enlazado desde (${r.in.length})`)
      for (const l of r.in) lines.push(`  ${l.from}:${l.line}`)
      lines.push('', `Cita ${r.cites.length} fuente(s) en ${r.domains.length} dominio(s)`)
      for (const [domain, n] of r.domains.slice(0, options.limit)) lines.push(`  ${String(n).padStart(3)}  ${domain}`)
      emit(options, r, lines.join('\n'))
      return
    }
    case 'source': {
      const index = loadForQuery(options)
      const result = sourceReport(index, args.join(' '), options)
      const lines = []
      for (const s of result.results) {
        lines.push(`${s.url}  (${s.citers.length} documento(s))`)
        for (const c of s.citers) lines.push(`  ${c.from}:${c.line}${c.count > 1 ? `  ×${c.count}` : ''}`)
      }
      lines.push(`${result.total} fuente(s)`)
      emit(options, result, lines.join('\n'))
      return
    }
    case 'tag': {
      const index = loadForQuery(options)
      const result = tagReport(index, args[0])
      const text = result.tags
        ? result.tags.map((t) => `${String(t.count).padStart(3)}  ${t.name}`).join('\n')
        : [...result.files, `${result.files.length} documento(s) con '${result.tag}'`].join('\n')
      emit(options, result, text)
      return
    }
    case 'neighbors': {
      const index = loadForQuery(options)
      const node = requireNode(index, args[0])
      const found = neighborsOf(index, node, options)
      emit(options, { node, neighbors: found },
        [
          label(node),
          ...found.map((n) => `${'  '.repeat(n.depth)}${n.rel} ${label(n.node)}`),
          `${found.length} vecino(s)`,
        ].join('\n'))
      return
    }
    case 'path': {
      const index = loadForQuery(options)
      const from = requireNode(index, args[0])
      const to = requireNode(index, args[1])
      const path = shortestPath(index, from, to)
      if (!path) {
        emit(options, { path: null }, `Sin camino entre ${label(from)} y ${label(to)}.`)
        process.exit(1)
      }
      emit(options, { path },
        path.map((step, i) => (i === 0 ? label(step) : `  ${step.rel} → ${label(step)}`)).join('\n'))
      return
    }
    case 'gods': {
      const index = loadForQuery(options)
      const result = godNodes(index, options)
      emit(options, result, result.map((r) => `${String(r.score).padStart(4)}  ${r.id}`).join('\n'))
      return
    }
    case 'broken': {
      const index = loadForQuery(options)
      const result = brokenLinks(index)
      emit(options, result,
        result.length
          ? result.map((l) => `${l.from}:${l.line}  → ${l.to}${l.anchor ? `#${l.anchor}` : ''}  (${l.broken})`).join('\n')
          : 'Sin enlaces rotos.')
      process.exit(result.length ? 1 : 0)
    }
    case 'help':
      console.log(USAGE)
      return
    default:
      console.error(`Comando desconocido: ${command}\n\n${USAGE}`)
      process.exit(2)
  }
}

main()
