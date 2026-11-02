/**
 * Índices y consultas sobre el grafo: búsqueda, informe de documento, fuentes,
 * tags, vecinos, camino más corto y nodos más conectados.
 *
 * Hay dos tipos de nodo: archivo (id = ruta) y fuente (id = URL). Las aristas
 * son `links` (archivo → archivo) y `cites` (archivo → fuente). Dos documentos
 * que citan la misma fuente quedan a distancia 2: así `path` muestra cómo se
 * conecta la investigación aunque los documentos no se enlacen entre sí.
 */

export function makeMatcher(query) {
  if (query.startsWith('re:')) {
    const re = new RegExp(query.slice(3), 'i')
    return (text) => re.test(text ?? '')
  }
  if (query.length > 2 && query.startsWith('/') && query.endsWith('/')) {
    const re = new RegExp(query.slice(1, -1), 'i')
    return (text) => re.test(text ?? '')
  }
  const needle = query.toLowerCase()
  return (text) => (text ?? '').toLowerCase().includes(needle)
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

export function indexGraph(graph) {
  const files = new Map(graph.files.map((f) => [f.path, f]))
  const sources = new Map(graph.sources.map((s) => [s.url, s]))
  const sectionsByFile = new Map()
  const outLinks = new Map()
  const inLinks = new Map()
  const citesByFile = new Map()
  const citersByUrl = new Map()

  for (const section of graph.sections) push(sectionsByFile, section.file, section)
  for (const link of graph.links) {
    push(outLinks, link.from, link)
    if (!link.asset && (!link.broken || link.broken === 'missing-anchor')) push(inLinks, link.to, link)
  }
  for (const cite of graph.cites) {
    push(citesByFile, cite.from, cite)
    push(citersByUrl, cite.url, cite)
  }

  return { graph, files, sources, sectionsByFile, outLinks, inLinks, citesByFile, citersByUrl }
}

/** Resuelve un texto a un nodo: ruta exacta, URL exacta, sufijo de ruta, título o URL parcial. */
export function resolveNode(index, query) {
  if (index.files.has(query)) return { type: 'file', id: query }
  if (index.sources.has(query)) return { type: 'source', id: query }

  const match = makeMatcher(query)
  const byPath = [...index.files.keys()].filter((p) => p.endsWith(query) || match(p))
  if (byPath.length) {
    byPath.sort((a, b) => a.length - b.length)
    return { type: 'file', id: byPath[0], candidates: byPath }
  }
  const byTitle = [...index.files.values()].filter((f) => match(f.title))
  if (byTitle.length) {
    return { type: 'file', id: byTitle[0].path, candidates: byTitle.map((f) => f.path) }
  }
  const byUrl = [...index.sources.keys()].filter((u) => match(u))
  if (byUrl.length) {
    byUrl.sort((a, b) => (index.citersByUrl.get(b)?.length ?? 0) - (index.citersByUrl.get(a)?.length ?? 0))
    return { type: 'source', id: byUrl[0], candidates: byUrl }
  }
  return null
}

export function search(index, query, { limit = 25, kind = null } = {}) {
  const match = makeMatcher(query)
  const results = []
  for (const file of index.files.values()) {
    if (kind && file.kind !== kind) continue
    const fields = [file.title, file.description, file.path, ...(file.tags ?? [])]
    if (fields.some(match)) {
      results.push({ type: 'file', path: file.path, line: 1, text: file.title })
    }
  }
  for (const section of index.graph.sections) {
    if (kind && index.files.get(section.file)?.kind !== kind) continue
    if (match(section.title)) {
      results.push({ type: 'section', path: section.file, line: section.line, text: section.title })
    }
  }
  return { total: results.length, results: results.slice(0, limit) }
}

function domainCounts(cites, sources) {
  const counts = new Map()
  for (const cite of cites) {
    const domain = sources.get(cite.url)?.domain ?? '(sin dominio)'
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

export function docReport(index, path) {
  const file = index.files.get(path)
  if (!file) return null
  const cites = index.citesByFile.get(path) ?? []
  return {
    file,
    sections: index.sectionsByFile.get(path) ?? [],
    out: index.outLinks.get(path) ?? [],
    in: index.inLinks.get(path) ?? [],
    cites,
    domains: domainCounts(cites, index.sources),
  }
}

export function sourceReport(index, query, { limit = 25 } = {}) {
  const match = makeMatcher(query)
  const hits = index.graph.sources
    .filter((s) => match(s.url) || match(s.domain))
    .map((s) => ({ ...s, citers: index.citersByUrl.get(s.url) ?? [] }))
    .sort((a, b) => b.citers.length - a.citers.length || a.url.localeCompare(b.url))
  return { total: hits.length, results: hits.slice(0, limit) }
}

export function tagReport(index, tag) {
  const all = new Map()
  for (const file of index.files.values()) {
    for (const t of file.tags ?? []) push(all, t.toLowerCase(), file.path)
  }
  if (!tag) {
    return {
      tags: [...all.entries()]
        .map(([name, paths]) => ({ name, count: paths.length }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }
  }
  return { tag, files: all.get(tag.toLowerCase()) ?? [] }
}

/** Aristas de un nodo: salientes, entrantes o ambas. */
function edgesOf(index, node, direction) {
  const out = []
  if (node.type === 'file') {
    if (direction !== 'in') {
      for (const l of index.outLinks.get(node.id) ?? []) {
        if (l.broken !== 'missing-file' && !l.asset) out.push({ node: { type: 'file', id: l.to }, rel: 'enlaza a', line: l.line })
      }
      for (const c of index.citesByFile.get(node.id) ?? []) {
        out.push({ node: { type: 'source', id: c.url }, rel: 'cita', line: c.line })
      }
    }
    if (direction !== 'out') {
      for (const l of index.inLinks.get(node.id) ?? []) {
        out.push({ node: { type: 'file', id: l.from }, rel: 'enlazado desde', line: l.line })
      }
    }
  } else if (direction !== 'out') {
    for (const c of index.citersByUrl.get(node.id) ?? []) {
      out.push({ node: { type: 'file', id: c.from }, rel: 'citada por', line: c.line })
    }
  }
  return out
}

const keyOf = (node) => `${node.type}:${node.id}`

export function neighborsOf(index, start, { depth = 1, direction = 'both' } = {}) {
  const seen = new Set([keyOf(start)])
  const found = []
  let frontier = [start]
  for (let d = 1; d <= depth && frontier.length; d += 1) {
    const next = []
    for (const node of frontier) {
      for (const edge of edgesOf(index, node, direction)) {
        const key = keyOf(edge.node)
        if (seen.has(key)) continue
        seen.add(key)
        found.push({ ...edge, depth: d, via: node.id })
        next.push(edge.node)
      }
    }
    frontier = next
  }
  return found
}

/** Camino más corto sin dirección: documentos conectados por enlaces o por fuentes compartidas. */
export function shortestPath(index, from, to) {
  const target = keyOf(to)
  const prev = new Map([[keyOf(from), null]])
  const queue = [from]
  while (queue.length) {
    const node = queue.shift()
    if (keyOf(node) === target) {
      const path = []
      let key = target
      while (key) {
        const entry = prev.get(key)
        path.unshift({ key, rel: entry?.rel ?? null })
        key = entry?.from ?? null
      }
      return path.map(({ key, rel }) => {
        const [type, ...rest] = key.split(':')
        return { type, id: rest.join(':'), rel }
      })
    }
    for (const edge of edgesOf(index, node, 'both')) {
      const key = keyOf(edge.node)
      if (prev.has(key)) continue
      prev.set(key, { from: keyOf(node), rel: edge.rel })
      queue.push(edge.node)
    }
  }
  return null
}

export function godNodes(index, { top = 15, mode = 'files' } = {}) {
  if (mode === 'sources') {
    return index.graph.sources
      .map((s) => ({ id: s.url, score: (index.citersByUrl.get(s.url) ?? []).length }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, top)
  }
  if (mode === 'domains') {
    const counts = new Map()
    for (const s of index.graph.sources) {
      const citers = new Set((index.citersByUrl.get(s.url) ?? []).map((c) => c.from))
      if (!counts.has(s.domain)) counts.set(s.domain, new Set())
      for (const f of citers) counts.get(s.domain).add(f)
    }
    return [...counts.entries()]
      .map(([id, set]) => ({ id, score: set.size }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, top)
  }
  return [...index.files.keys()]
    .map((path) => ({
      id: path,
      score:
        (index.outLinks.get(path)?.length ?? 0) +
        (index.inLinks.get(path)?.length ?? 0) +
        (index.citesByFile.get(path)?.length ?? 0),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, top)
}

export function brokenLinks(index) {
  return index.graph.links.filter((l) => l.broken)
}
