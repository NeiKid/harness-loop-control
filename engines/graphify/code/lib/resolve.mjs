/**
 * Resolución de especificadores de import a rutas del repo.
 *
 * Es resolución sintáctica, no del compilador: alias declarados en el tsconfig
 * raíz, nombres de paquetes del workspace y rutas relativas. Cubre además el
 * patrón NodeNext de `packages/contracts` (importar './x.js' desde './x.ts').
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot, toPosix } from './repo.mjs'

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/** Quita comentarios de línea de un JSON con comentarios (tsconfig). */
function readJsonc(absPath) {
  const raw = readFileSync(absPath, 'utf-8').replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(raw)
}

/**
 * Directorios de paquete del workspace, leidos del filesystem.
 *
 * No se hardcodean: un alias faltante no rompe nada, el mapa simplemente deja
 * de ver esos imports, y nadie se entera. Se derivan de los mismos globs que
 * declara `pnpm-workspace.yaml` (`apps/*`, `packages/*`).
 */
function workspaceDirs(root) {
  const dirs = []
  for (const parent of ['apps', 'packages']) {
    let entries
    try {
      entries = readdirSync(join(root, parent), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(`${parent}/${entry.name}`)
      }
    }
  }
  return dirs.sort()
}

/**
 * Construye el mapa de alias: los `paths` del tsconfig raíz más una entrada por
 * paquete del workspace (`@scope/api` → `apps/api/src`), que el tsconfig no
 * declara pero los imports sí usan.
 */
export function loadAliases(root = repoRoot) {
  const aliases = new Map()

  try {
    const tsconfig = readJsonc(join(root, 'tsconfig.json'))
    const paths = tsconfig?.compilerOptions?.paths ?? {}
    for (const [pattern, targets] of Object.entries(paths)) {
      if (Array.isArray(targets) && targets.length > 0) {
        aliases.set(pattern.replace(/\*$/, ''), targets[0].replace(/\*$/, ''))
      }
    }
  } catch {
    // Sin tsconfig raíz legible: quedan los alias del workspace.
  }

  for (const dir of workspaceDirs(root)) {
    const pkgPath = join(root, dir, 'package.json')
    if (!existsSync(pkgPath)) {
      continue
    }
    try {
      const name = JSON.parse(readFileSync(pkgPath, 'utf-8')).name
      if (name && !aliases.has(name)) {
        aliases.set(name, `${dir}/src`)
      }
    } catch {
      // package.json ilegible: se omite ese alias.
    }
  }

  return aliases
}

function joinPosix(base, relative) {
  const parts = base.split('/')
  for (const part of relative.split('/')) {
    if (part === '.' || part === '') {
      continue
    }
    if (part === '..') {
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}

function pickExisting(base, fileSet) {
  if (fileSet.has(base)) {
    return base
  }
  // './x.js' escrito desde TypeScript con moduleResolution NodeNext apunta a
  // './x.ts' en el árbol de fuentes.
  const withoutJs = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const bases = base === withoutJs ? [base] : [base, withoutJs]
  for (const candidate of bases) {
    for (const ext of CANDIDATE_EXTENSIONS) {
      if (fileSet.has(candidate + ext)) {
        return candidate + ext
      }
    }
    for (const ext of CANDIDATE_EXTENSIONS) {
      if (fileSet.has(`${candidate}/index${ext}`)) {
        return `${candidate}/index${ext}`
      }
    }
  }
  return null
}

/**
 * Devuelve `{ kind: 'internal', file }` si el import apunta a un archivo del
 * repo, `{ kind: 'external', package }` si apunta a una dependencia, y
 * `{ kind: 'unresolved' }` si parece interno pero no se encontró el archivo
 * (por ejemplo un `.json` o un asset, que no son nodos del grafo).
 */
export function resolveSpecifier(specifier, fromFile, fileSet, aliases) {
  if (specifier.startsWith('.')) {
    const base = joinPosix(
      fromFile.split('/').slice(0, -1).join('/'),
      specifier
    )
    const hit = pickExisting(base, fileSet)
    return hit
      ? { kind: 'internal', file: hit }
      : { kind: 'unresolved', specifier }
  }

  for (const [prefix, target] of aliases) {
    if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
      const rest = specifier.slice(prefix.length).replace(/^\//, '')
      const base = rest ? `${toPosix(target)}/${rest}` : toPosix(target)
      const hit = pickExisting(base, fileSet)
      return hit
        ? { kind: 'internal', file: hit }
        : { kind: 'unresolved', specifier }
    }
  }

  const pkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  return { kind: 'external', package: pkg }
}
