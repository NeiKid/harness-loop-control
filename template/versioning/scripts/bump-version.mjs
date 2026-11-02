#!/usr/bin/env node
/**
 * Bump automático de versión con Conventional Commits (AGENTS.md, «Versionado»). Lo invoca el hook
 * post-commit: git ya escribió el commit, así que el bump se amenda sobre él.
 *
 * Reglas: «BREAKING CHANGE» en el mensaje o «tipo!:» → major; `feat` → minor; el resto → patch.
 * Sólo en el tronco (`VERSION_BRANCHES`, que fija el hook; si no, `branches.trunk` de harness.json):
 * si cada rama subiera la suya, todas chocarían al integrarse. Un merge hacia el tronco se versiona
 * por el commit más fuerte de los que trae (`HEAD^1..HEAD^2`). Se omite en fixup!/squash!, si el
 * commit ya cambió la versión, o con SKIP_VERSION_BUMP=1.
 *
 * Los archivos salen de `versioning.files` en harness.json: un `.json` con campo "version" (como
 * package.json) o un archivo de texto con la versión sola (como VERSION). Todos llevan la misma.
 *
 * El amend lleva SÓLO el cambio de versión: cada archivo se toma de HEAD, se le cambia la versión y
 * se escribe en un índice temporal armado desde HEAD. Lo que tengas sin commitear (en esos archivos o
 * en otros) no entra al commit; después se aplica el mismo cambio al índice real y a la copia de
 * trabajo, sin tocar el resto.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_VERSION = /"version":\s*"([^"]+)"/

export function bumpOf(message) {
  const first = message.split('\n').find((l) => l.trim()) ?? ''
  const header = /^(\w+)(\([^)]*\))?(!)?:/.exec(first.trim())
  if (/BREAKING CHANGE/.test(message) || header?.[3] === '!') return 'major'
  if (header?.[1] === 'feat') return 'minor'
  return 'patch'
}

export function nextVersion([major, minor, patch], bump) {
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const parse = (raw) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw ?? '')
  return m ? m.slice(1).map(Number) : null
}
const readVersion = (rel, content) => (rel.endsWith('.json') ? JSON_VERSION.exec(content)?.[1] : content.trim())
const withVersion = (rel, content, version) =>
  rel.endsWith('.json') ? content.replace(JSON_VERSION, `"version": "${version}"`) : `${version}\n`
const greater = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function git(args, { env, input } = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  })
}

function stage(rel, content, mode, env) {
  const sha = git(['hash-object', '-w', '--stdin'], { input: content }).trim()
  git(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`], { env })
}

function main() {
  if (process.env.SKIP_VERSION_BUMP === '1') return
  const config = JSON.parse(readFileSync(join(ROOT, '_AI_LOOP_CONTROL', 'harness.json'), 'utf-8'))
  if (config.versioning?.enabled === false) return
  const files = config.versioning?.files ?? ['package.json']
  const branches = (process.env.VERSION_BRANCHES ?? config.branches?.trunk ?? 'dev').split(',').map((b) => b.trim())
  if (!branches.includes(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim())) return

  const message = git(['log', '-1', '--pretty=%B'])
  if (/^(fixup!|squash!)/.test(message.trim())) return
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).slice(1)
  // El primer commit del repo nace con la versión inicial.
  if (!parents.length) return

  // Si el commit ya cambió la versión respecto del padre (bump a mano o re-disparo), no se toca.
  try {
    const before = readVersion(files[0], git(['show', `HEAD~1:${files[0]}`]))
    const after = readVersion(files[0], git(['show', `HEAD:${files[0]}`]))
    if (before && after && before !== after) return
  } catch {
    // Archivo nuevo en este commit: seguir.
  }

  const messages = parents.length > 1 ? [message, ...git(['log', '--format=%B%x00', 'HEAD^1..HEAD^2']).split('\0')] : [message]
  const RANK = { patch: 0, minor: 1, major: 2 }
  const bump = messages
    .filter((m) => m.trim())
    .map(bumpOf)
    .reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'patch')

  let base = [0, 0, 0]
  const entries = []
  for (const rel of files) {
    let committed
    try {
      committed = git(['show', `HEAD:${rel}`])
    } catch {
      console.error(`bump-version: ${rel} no está en el commit; versión sin cambios`)
      return
    }
    const version = parse(readVersion(rel, committed))
    if (!version) {
      console.error(`bump-version: ${rel} no tiene una versión X.Y.Z; versión sin cambios`)
      return
    }
    if (greater(version, base) > 0) base = version
    entries.push({ rel, committed, mode: git(['ls-tree', 'HEAD', '--', rel]).split(/\s/)[0] || '100644' })
  }
  const next = nextVersion(base, bump)

  const tmp = mkdtempSync(join(tmpdir(), 'bump-version-'))
  const tmpIndex = { GIT_INDEX_FILE: join(tmp, 'index') }
  try {
    git(['read-tree', 'HEAD'], { env: tmpIndex })
    for (const { rel, committed, mode } of entries) stage(rel, withVersion(rel, committed, next), mode, tmpIndex)
    // Sin hooks en el amend: el post-commit anidado correría con el índice temporal en el entorno.
    git(['-c', `core.hooksPath=${join(tmp, 'no-hooks')}`, 'commit', '--amend', '--no-edit', '--no-verify', '--allow-empty'], {
      env: { ...tmpIndex, SKIP_VERSION_BUMP: '1' },
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  for (const { rel, mode } of entries) {
    stage(rel, withVersion(rel, git(['show', `:${rel}`]), next), mode)
    const path = join(ROOT, rel)
    if (existsSync(path)) writeFileSync(path, withVersion(rel, readFileSync(path, 'utf-8'), next))
  }
  console.log(`bump-version: ${bump} → ${next} (${files.join(', ')})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`bump-version: no se pudo subir la versión (${error.message}).`)
  }
}
