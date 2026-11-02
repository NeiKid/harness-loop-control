/**
 * Extracción de frontmatter, secciones y enlaces desde Markdown y HTML.
 *
 * Sin dependencias: el frontmatter OKF de este repo usa un subconjunto plano de
 * YAML (`clave: valor` y listas `[a, b]`), y eso es lo único que se parsea. Un
 * frontmatter más rico no rompe nada: lo que no se entiende queda como texto.
 */
import { posix } from 'node:path'

const BARE_URL = /https?:\/\/[^\s<>()"'`\]]+/g
const MD_LINK = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const TRAILING_PUNCT = /[.,;:!?*_]+$/

function parseScalar(raw) {
  const value = raw.trim()
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => parseScalar(item))
      .filter((item) => item !== '')
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Devuelve `{ meta, bodyStart }`. `bodyStart` es el índice (0-based) de la
 * primera línea del cuerpo, para que las secciones conserven su línea real.
 */
export function parseFrontmatter(lines) {
  if (lines[0] !== '---') {
    return { meta: null, bodyStart: 0 }
  }
  const end = lines.indexOf('---', 1)
  if (end === -1) {
    return { meta: null, bodyStart: 0 }
  }
  const meta = {}
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (match) {
      meta[match[1]] = parseScalar(match[2])
    }
  }
  return { meta, bodyStart: end + 1 }
}

export function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function cleanUrl(url) {
  let out = url.replace(TRAILING_PUNCT, '')
  // Un paréntesis de cierre sobrante es puntuación de la prosa, no del URL.
  while (out.endsWith(')') && (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length) {
    out = out.slice(0, -1).replace(TRAILING_PUNCT, '')
  }
  return out
}

/** Clasifica un destino de enlace y, si es interno, lo resuelve a una ruta del repo. */
export function resolveTarget(fromPath, target) {
  if (/^https?:\/\//i.test(target)) {
    return { kind: 'external', url: cleanUrl(target) }
  }
  if (/^(mailto:|tel:|data:|javascript:)/i.test(target) || target.startsWith('#')) {
    return null
  }
  const [pathPart, anchor = null] = target.split('#')
  if (!pathPart) {
    return null
  }
  let resolved
  if (pathPart.startsWith('/')) {
    // En un bundle OKF, `/x.md` es relativo a la raíz del bundle (`docs/`).
    const base = fromPath.startsWith('docs/') ? 'docs' : ''
    resolved = posix.normalize(posix.join(base, pathPart))
  } else {
    resolved = posix.normalize(posix.join(posix.dirname(fromPath), pathPart))
  }
  resolved = resolved.replace(/^\.\//, '')
  if (resolved.startsWith('../')) {
    return null
  }
  return { kind: 'internal', path: resolved, anchor }
}

function uniqueSlug(slug, seen) {
  const count = seen.get(slug) ?? 0
  seen.set(slug, count + 1)
  return count === 0 ? slug : `${slug}-${count}`
}

export function extractMarkdown(relPath, text) {
  const lines = text.split('\n')
  const { meta, bodyStart } = parseFrontmatter(lines)
  const sections = []
  const links = []
  const seen = new Map()
  let inFence = false

  for (let i = bodyStart; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const title = heading[2].trim()
      sections.push({
        slug: uniqueSlug(slugify(title), seen),
        level: heading[1].length,
        title,
        line: i + 1,
      })
    }
    // Primero los enlaces Markdown, fuera de código inline (`[x](y)` dentro de
    // backticks es un ejemplo, no un enlace); después los URLs sueltos del
    // resto de la línea, para no contar dos veces el mismo destino. El código
    // inline se tapa con espacios para conservar las posiciones.
    const noCode = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    let rest = line
    for (const match of noCode.matchAll(MD_LINK)) {
      links.push({ target: match[2], line: i + 1 })
      rest = rest.slice(0, match.index) + ' '.repeat(match[0].length) + rest.slice(match.index + match[0].length)
    }
    for (const match of rest.matchAll(BARE_URL)) {
      links.push({ target: match[0], line: i + 1 })
    }
  }

  const firstH1 = sections.find((s) => s.level === 1)
  return {
    meta,
    title: meta?.title ?? firstH1?.title ?? relPath,
    sections,
    links,
  }
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

export function extractHtml(relPath, text) {
  const title = stripTags(text.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '') || relPath
  const sections = []
  const links = []
  const seen = new Map()
  // El contenido de `<script>` es código o datos: sus `<h2>` y `<a href>` son
  // plantillas, no secciones ni citas. Se blanquea conservando los saltos de
  // línea para que los números de línea sigan apuntando al archivo real.
  const markup = text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, open, body, close) => open + body.replace(/[^\n]/g, ' ') + close)

  for (const match of markup.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const heading = stripTags(match[2])
    if (!heading) continue
    sections.push({
      slug: uniqueSlug(slugify(heading), seen),
      level: Number(match[1]),
      title: heading,
      line: lineAt(text, match.index),
    })
  }
  // Solo anclas `<a href>`: los `<link href>` son hojas de estilo, no citas.
  for (const match of markup.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    links.push({ target: match[1], line: lineAt(markup, match.index) })
  }

  return { meta: null, title, sections, links }
}
