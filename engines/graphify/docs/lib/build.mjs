/**
 * Documentos → archivos, secciones, enlaces internos, citas y fuentes.
 *
 * Nodos: `files` (cada documento o página) y `sources` (cada URL externo
 * citado). Aristas: `links` (documento → documento) y `cites` (documento →
 * fuente). Las secciones cuelgan de su archivo y sirven para búsqueda y para
 * validar anclas.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot, listKnowledgeFiles, fileStats, currentCommit } from './repo.mjs'
import { extractMarkdown, extractHtml, resolveTarget } from './parse.mjs'

export const SCHEMA_VERSION = 1
export const GENERATOR = 'graphify-docs@1'

function kindOf(relPath) {
  if (relPath.endsWith('.html')) return 'artifact'
  if (relPath.startsWith('docs/')) return 'doc'
  if (relPath.startsWith('_AI_LOOP_CONTROL/')) return 'control'
  return 'root'
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function buildGraph(root = repoRoot) {
  const paths = listKnowledgeFiles(root)
  const known = new Set(paths)

  const files = []
  const sections = []
  const links = []
  const cites = []
  const sources = new Map()
  const anchorsByFile = new Map()
  const pendingAnchors = []

  for (const relPath of paths) {
    const stats = fileStats(relPath, root)
    const extracted = relPath.endsWith('.html')
      ? extractHtml(relPath, stats.text)
      : extractMarkdown(relPath, stats.text)

    const meta = extracted.meta ?? {}
    const entry = {
      path: relPath,
      hash: stats.hash,
      lines: stats.lines,
      kind: kindOf(relPath),
      title: extracted.title,
    }
    if (meta.type) entry.type = meta.type
    if (meta.description) entry.description = meta.description
    if (Array.isArray(meta.tags) && meta.tags.length) entry.tags = meta.tags
    files.push(entry)

    anchorsByFile.set(relPath, new Set(extracted.sections.map((s) => s.slug)))
    for (const section of extracted.sections) {
      sections.push({
        id: `${relPath}#${section.slug}`,
        file: relPath,
        line: section.line,
        level: section.level,
        title: section.title,
      })
    }

    const seenInternal = new Set()
    const seenCites = new Map()
    for (const link of extracted.links) {
      const target = resolveTarget(relPath, link.target)
      if (!target) continue
      if (target.kind === 'external') {
        const previous = seenCites.get(target.url)
        if (previous) {
          previous.count += 1
          continue
        }
        const cite = { from: relPath, url: target.url, line: link.line, count: 1 }
        seenCites.set(target.url, cite)
        cites.push(cite)
        if (!sources.has(target.url)) {
          sources.set(target.url, { url: target.url, domain: domainOf(target.url) })
        }
        continue
      }
      const key = `${target.path}#${target.anchor ?? ''}`
      if (seenInternal.has(key)) continue
      seenInternal.add(key)
      const edge = { from: relPath, to: target.path, line: link.line }
      if (target.anchor) edge.anchor = target.anchor
      if (!known.has(target.path)) {
        // Un enlace a un JSON o a una carpeta que existen no está roto: solo
        // no es un documento del grafo.
        const onDisk = target.path.replace(/\/$/, '')
        if (onDisk && existsSync(join(root, onDisk))) edge.asset = true
        else edge.broken = 'missing-file'
      }
      links.push(edge)
      if (target.anchor && known.has(target.path)) pendingAnchors.push(edge)
    }
  }

  // Las anclas se validan al final: el destino puede procesarse después.
  for (const edge of pendingAnchors) {
    const anchors = anchorsByFile.get(edge.to)
    if (anchors && !anchors.has(edge.anchor)) edge.broken = 'missing-anchor'
  }

  const sourceList = [...sources.values()].sort((a, b) => a.url.localeCompare(b.url))
  const domains = new Set(sourceList.map((s) => s.domain).filter(Boolean))

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: GENERATOR,
    builtAt: new Date().toISOString(),
    commit: currentCommit(root),
    stats: {
      files: files.length,
      sections: sections.length,
      links: links.length,
      brokenLinks: links.filter((l) => l.broken).length,
      cites: cites.length,
      sources: sourceList.length,
      domains: domains.size,
    },
    files,
    sections,
    links,
    cites,
    sources: sourceList,
  }
}
