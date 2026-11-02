/**
 * Descubrimiento de archivos de código y huella de contenido.
 *
 * El grafo se considera atrasado comparando el HASH de cada archivo de código,
 * no el SHA del commit: un commit de docs no lo invalida, y el hook post-commit
 * puede amendar el grafo dentro del propio commit (lo que cambia el SHA) sin
 * que el grafo quede marcado como atrasado por su propio amend.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
)

/** Extensiones que cuentan como "código" para el grafo y para el staleness. */
export const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/** Directorios que nunca se recorren: generados, dependencias o ignorados. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.graphify',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
])

export function toPosix(path) {
  return path.split(sep).join('/')
}

export function isCodeFile(relPath) {
  if (relPath.endsWith('.d.ts')) {
    return false
  }
  return CODE_EXTENSIONS.some((ext) => relPath.endsWith(ext))
}

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    // stderr silenciado: cuando el directorio no es un repo git el fallback es
    // el walk del filesystem, no un error que el usuario deba leer.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Lista los archivos de código del repo. Usa git (trackeados + no trackeados no
 * ignorados) para que local y CI vean exactamente el mismo conjunto; si git no
 * está disponible cae a un walk del filesystem con la misma lista de exclusión.
 */
export function listCodeFiles(root = repoRoot) {
  let files
  try {
    files = git(
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      root
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    files = walk(root, root)
  }

  return files
    .filter(isCodeFile)
    .filter((rel) => !rel.split('/').some((part) => SKIP_DIRS.has(part)))
    .filter((rel) => existsSync(join(root, rel)))
    .sort()
}

function walk(dir, root, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue
      }
      walk(join(dir, entry.name), root, acc)
    } else if (entry.isFile()) {
      acc.push(toPosix(relative(root, join(dir, entry.name))))
    }
  }
  return acc
}

/**
 * Lee un archivo normalizando CRLF a LF antes de hashear: el mismo contenido
 * debe producir el mismo hash en Windows (working tree con CRLF) y en el runner
 * de CI (LF), o el grafo se vería atrasado en CI sin que nada haya cambiado.
 */
export function readNormalized(absPath) {
  return readFileSync(absPath, 'utf-8').replace(/\r\n/g, '\n')
}

export function hashContent(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

export function currentCommit(root = repoRoot) {
  try {
    return git(['rev-parse', 'HEAD'], root).trim()
  } catch {
    return null
  }
}

export function fileStats(relPath, root = repoRoot) {
  const abs = join(root, relPath)
  const text = readNormalized(abs)
  return {
    text,
    hash: hashContent(text),
    lines: text.length === 0 ? 0 : text.split('\n').length,
    bytes: statSync(abs).size,
  }
}
