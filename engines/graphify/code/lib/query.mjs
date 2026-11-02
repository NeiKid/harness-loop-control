/**
 * Índices y consultas sobre el grafo ya construido.
 *
 * Todo lo de acá es lectura de `.graphify/graph.json`: sin LLM, sin red y sin
 * tocar el código fuente. El grafo es una brújula, no la verdad: conexión no es
 * causalidad, y si dice que algo no existe, hay que verificarlo antes de
 * creerle.
 */

export function indexGraph(graph) {
  const files = new Map(graph.files.map((f) => [f.path, f]))
  const symbols = new Map(graph.symbols.map((s) => [s.id, s]))

  const symbolsByName = new Map()
  const symbolsByFile = new Map()
  for (const symbol of graph.symbols) {
    if (!symbolsByName.has(symbol.name)) {
      symbolsByName.set(symbol.name, [])
    }
    symbolsByName.get(symbol.name).push(symbol)
    if (!symbolsByFile.has(symbol.file)) {
      symbolsByFile.set(symbol.file, [])
    }
    symbolsByFile.get(symbol.file).push(symbol)
  }

  const importsFrom = new Map()
  const importsTo = new Map()
  for (const edge of graph.imports) {
    if (!importsFrom.has(edge.from)) {
      importsFrom.set(edge.from, [])
    }
    importsFrom.get(edge.from).push(edge)
    if (edge.kind === 'internal') {
      if (!importsTo.has(edge.to)) {
        importsTo.set(edge.to, [])
      }
      importsTo.get(edge.to).push(edge)
    }
  }

  const refsFrom = new Map()
  const refsTo = new Map()
  for (const edge of graph.refs) {
    if (!refsFrom.has(edge.from)) {
      refsFrom.set(edge.from, [])
    }
    refsFrom.get(edge.from).push(edge)
    if (!refsTo.has(edge.to)) {
      refsTo.set(edge.to, [])
    }
    refsTo.get(edge.to).push(edge)
  }

  return {
    graph,
    files,
    symbols,
    symbolsByName,
    symbolsByFile,
    importsFrom,
    importsTo,
    refsFrom,
    refsTo,
  }
}

/**
 * Acepta `/patrón/flags` y también `re:patrón`. La segunda forma existe porque
 * Git Bash en Windows convierte un argumento que empieza con `/` en una ruta
 * (`/^use/` llega como `C:/Program Files/Git/^use/`).
 */
function toRegExp(query) {
  if (query.startsWith('re:')) {
    return new RegExp(query.slice(3), 'i')
  }
  const match = /^\/(.*)\/([a-z]*)$/.exec(query)
  if (!match) {
    return null
  }
  return new RegExp(
    match[1],
    match[2].includes('i') ? match[2] : `${match[2]}i`
  )
}

/**
 * Busca símbolos por nombre. Acepta `nombre`, `Clase.metodo`,
 * `ruta/archivo.ts#nombre` o una regex `/patrón/`.
 * Ordena por calidad de coincidencia: exacta, prefijo, substring.
 */
export function findSymbols(index, query, { kind, exportedOnly, file } = {}) {
  const regex = toRegExp(query)
  const [filePart, symbolPart] = query.includes('#')
    ? query.split('#')
    : [null, query]
  const needle = (symbolPart ?? '').toLowerCase()

  const scored = []
  for (const symbol of index.graph.symbols) {
    if (kind && symbol.kind !== kind) {
      continue
    }
    if (exportedOnly && !symbol.exported) {
      continue
    }
    if (file && !symbol.file.includes(file)) {
      continue
    }
    if (filePart && !symbol.file.includes(filePart)) {
      continue
    }

    const name = symbol.name
    const qualified = symbol.id.split('#')[1] ?? name
    let score = null
    if (regex) {
      score = regex.test(name) || regex.test(qualified) ? 1 : null
    } else if (
      name.toLowerCase() === needle ||
      qualified.toLowerCase() === needle
    ) {
      score = 0
    } else if (name.toLowerCase().startsWith(needle)) {
      score = 1
    } else if (
      name.toLowerCase().includes(needle) ||
      qualified.toLowerCase().includes(needle)
    ) {
      score = 2
    }
    if (score !== null) {
      scored.push({ symbol, score })
    }
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      b.symbol.lines - a.symbol.lines ||
      a.symbol.id.localeCompare(b.symbol.id)
  )
  return scored.map((entry) => entry.symbol)
}

export function findFiles(index, query) {
  const regex = toRegExp(query)
  const needle = query.toLowerCase()
  const hits = []
  for (const path of index.files.keys()) {
    if (regex ? regex.test(path) : path.toLowerCase().includes(needle)) {
      hits.push(path)
    }
  }
  return hits.sort((a, b) => a.length - b.length || a.localeCompare(b))
}

/**
 * Resuelve lo que escribió el usuario a un nodo concreto.
 * Devuelve `{ type: 'file' | 'symbol' | 'ambiguous' | 'missing', … }`.
 */
export function resolveTarget(index, target) {
  if (index.files.has(target)) {
    return { type: 'file', id: target }
  }
  if (index.symbols.has(target)) {
    return { type: 'symbol', id: target }
  }

  if (target.includes('/') || /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(target)) {
    const matches = findFiles(index, target)
    if (matches.length === 1) {
      return { type: 'file', id: matches[0] }
    }
    if (matches.length > 1) {
      const exact = matches.filter((path) => path.endsWith(target))
      if (exact.length === 1) {
        return { type: 'file', id: exact[0] }
      }
      return {
        type: 'ambiguous',
        kind: 'file',
        candidates: matches.slice(0, 15),
      }
    }
  }

  const symbolMatches = findSymbols(index, target)
  const exact = symbolMatches.filter(
    (s) => s.name === target || s.id.endsWith(`#${target}`)
  )
  const pool = exact.length > 0 ? exact : symbolMatches
  if (pool.length === 1) {
    return { type: 'symbol', id: pool[0].id }
  }
  if (pool.length > 1) {
    return {
      type: 'ambiguous',
      kind: 'symbol',
      candidates: pool.slice(0, 15).map((s) => s.id),
    }
  }
  return { type: 'missing', id: target }
}

function fileEdges(index, path, direction) {
  const out =
    direction === 'in'
      ? []
      : (index.importsFrom.get(path) ?? [])
          .filter((edge) => edge.kind === 'internal')
          .map((edge) => ({ node: edge.to, via: 'importa' }))
  const incoming =
    direction === 'out'
      ? []
      : (index.importsTo.get(path) ?? []).map((edge) => ({
          node: edge.from,
          via: 'importado por',
        }))
  return [...out, ...incoming]
}

function symbolEdges(index, id, direction) {
  const out =
    direction === 'in'
      ? []
      : (index.refsFrom.get(id) ?? []).map((edge) => ({
          node: edge.to,
          via: 'usa',
        }))
  const incoming =
    direction === 'out'
      ? []
      : (index.refsTo.get(id) ?? []).map((edge) => ({
          node: edge.from,
          via: 'usado por',
        }))
  return [...out, ...incoming]
}

export function neighborsOf(
  index,
  target,
  { depth = 1, direction = 'both' } = {}
) {
  const edgesOf = target.type === 'file' ? fileEdges : symbolEdges
  const seen = new Map([[target.id, 0]])
  const levels = []
  let frontier = [target.id]

  for (let level = 1; level <= depth; level += 1) {
    const next = []
    const found = []
    for (const node of frontier) {
      for (const edge of edgesOf(index, node, direction)) {
        if (seen.has(edge.node)) {
          continue
        }
        seen.set(edge.node, level)
        next.push(edge.node)
        found.push({ ...edge, from: node })
      }
    }
    if (found.length > 0) {
      levels.push({ level, nodes: found })
    }
    frontier = next
    if (frontier.length === 0) {
      break
    }
  }
  return levels
}

/** BFS: camino más corto entre dos nodos del mismo tipo. */
export function shortestPath(index, from, to, { direction = 'both' } = {}) {
  const edgesOf = from.type === 'file' ? fileEdges : symbolEdges
  const previous = new Map([[from.id, null]])
  const queue = [from.id]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === to.id) {
      const path = []
      let cursor = current
      while (cursor !== null && cursor !== undefined) {
        path.unshift(cursor)
        cursor = previous.get(cursor)
      }
      return path
    }
    for (const edge of edgesOf(index, current, direction)) {
      if (!previous.has(edge.node)) {
        previous.set(edge.node, current)
        queue.push(edge.node)
      }
    }
  }
  return null
}

/**
 * Nodos-dios: los más conectados del grafo. Un valor alto no es un defecto por
 * sí solo (un barrel de tipos concentra imports por diseño), pero sí es dónde
 * un cambio se propaga más lejos.
 */
export function godNodes(index, { scope = 'files', top = 15 } = {}) {
  const rows = []
  if (scope === 'files') {
    for (const path of index.files.keys()) {
      const out = (index.importsFrom.get(path) ?? []).filter(
        (edge) => edge.kind === 'internal'
      ).length
      const incoming = (index.importsTo.get(path) ?? []).length
      rows.push({
        id: path,
        in: incoming,
        out,
        total: incoming + out,
        lines: index.files.get(path).lines,
      })
    }
  } else {
    for (const [id, symbol] of index.symbols) {
      const out = (index.refsFrom.get(id) ?? []).length
      const incoming = (index.refsTo.get(id) ?? []).length
      rows.push({
        id,
        in: incoming,
        out,
        total: incoming + out,
        lines: symbol.lines,
      })
    }
  }
  rows.sort(
    (a, b) => b.total - a.total || b.in - a.in || a.id.localeCompare(b.id)
  )
  return rows.slice(0, top)
}

export function fileReport(index, path) {
  const node = index.files.get(path)
  // Orden de lectura del archivo, no alfabético: el reporte se lee junto al código.
  const all = [...(index.symbolsByFile.get(path) ?? [])].sort(
    (a, b) => a.line - b.line
  )
  const symbols = all.filter((s) => !s.parent)
  const members = all.filter((s) => s.parent)
  const outgoing = index.importsFrom.get(path) ?? []
  return {
    node,
    symbols,
    members,
    importsInternal: outgoing.filter((edge) => edge.kind === 'internal'),
    importsExternal: outgoing.filter((edge) => edge.kind === 'external'),
    importedBy: index.importsTo.get(path) ?? [],
  }
}
