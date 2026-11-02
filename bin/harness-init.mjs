#!/usr/bin/env node
/**
 * Genera el harness de un repo a partir de su spec (`harness.spec.json`).
 *
 *   node bin/harness-init.mjs --spec <harness.spec.json> --target <repo> [--dry-run] [--force]
 *
 * Nunca pisa un archivo existente salvo con --force; `.gitattributes` y `package.json` se completan
 * con lo que les falta. Sin dependencias.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { resolve, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { render } from '../lib/render.mjs'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Adaptadores por herramienta y lo que generan. Codex y OpenCode leen AGENTS.md sin adaptador. */
export const ADAPTERS = {
  claude: ['CLAUDE.md'],
  codex: [],
  gemini: ['GEMINI.md'],
  copilot: ['.github/copilot-instructions.md'],
  cursor: ['.cursor/rules/harness.mdc'],
  windsurf: ['.windsurf/rules/harness.md'],
  cline: ['.clinerules/harness.md'],
  opencode: [],
}
const ENGINES = ['code', 'docs', 'none']
const LEVELS = ['lite', 'full', 'ultra']
const INDEX_MODES = ['fast', 'moderate', 'full']
const VERBATIM = /\.(mjs|cjs|js)$/

export function validateSpec(spec) {
  const errors = []
  const need = (cond, msg) => cond || errors.push(msg)
  need(/^[a-z0-9][a-z0-9-]*$/.test(spec.project?.name ?? ''), 'project.name: minúsculas, números y guiones')
  // Estos valores terminan dentro de YAML, JSON y scripts de shell: sin comillas ni saltos de línea.
  need(spec.project?.title && !/["\n\\]/.test(spec.project.title), 'project.title es obligatorio, sin comillas ni saltos de línea')
  need(Array.isArray(spec.owners) && spec.owners.length > 0, 'owners: al menos uno')
  for (const [i, o] of (spec.owners ?? []).entries()) {
    need(o.name && /^[A-Za-z0-9._-]+$/.test(o.handle ?? ''), `owners[${i}]: name, y handle con letras, números, punto, guion o guion bajo`)
  }
  for (const key of ['trunk', 'stable']) {
    const branch = spec.branches?.[key]
    need(branch === undefined || (/^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes('..')), `branches.${key}: nombre de rama inválido`)
  }
  need(Array.isArray(spec.rules?.extra ?? []) && Array.isArray(spec.verification ?? []), 'rules.extra y verification son listas')
  need(Array.isArray(spec.products) && spec.products.length > 0, 'products: al menos uno')
  const seen = new Set()
  for (const [i, p] of (spec.products ?? []).entries()) {
    need(/^[A-Z][A-Z0-9]{1,7}$/.test(p.prefix ?? ''), `products[${i}].prefix: 2 a 8 mayúsculas o dígitos, empieza con letra`)
    need(!seen.has(p.prefix), `products[${i}].prefix ${p.prefix} repetido`)
    seen.add(p.prefix)
    need(p.name && p.code && p.source_of_truth, `products[${i}]: name, code y source_of_truth`)
  }
  need(ENGINES.includes(spec.graphify?.engine ?? 'code'), `graphify.engine: ${ENGINES.join('|')}`)
  need(LEVELS.includes(spec.ponytail?.level ?? 'full'), `ponytail.level: ${LEVELS.join('|')}`)
  for (const a of spec.adapters ?? []) need(a in ADAPTERS, `adapters: ${a} desconocido (${Object.keys(ADAPTERS).join(', ')})`)
  need(['github', 'none'].includes(spec.ci ?? 'github'), 'ci: github|none')
  const files = spec.versioning?.files ?? ['package.json']
  need(Array.isArray(files) && files.length > 0, 'versioning.files: al menos un archivo')
  need(INDEX_MODES.includes(spec.codebase_memory?.index_mode ?? 'fast'), `codebase_memory.index_mode: ${INDEX_MODES.join('|')}`)
  return errors
}

export function buildContext(spec, now = new Date()) {
  const engine = spec.graphify?.engine ?? 'code'
  const ponytail = spec.ponytail?.enabled !== false
  const level = spec.ponytail?.level ?? 'full'
  const memory = spec.codebase_memory?.enabled !== false
  const adapters = spec.adapters ?? []
  const files = adapters.flatMap((a) => ADAPTERS[a]).map((f) => `\`${f}\``)
  const mcpServers = [ponytail && 'ponytail', memory && 'codebase-memory-mcp'].filter(Boolean)
  const versioning = spec.versioning?.enabled !== false
  // Herramientas con hook de arranque de sesión que corre agent-session.mjs (las demás lo hacen por AGENTS.md).
  const hookTools = mcpServers.length ? [['claude', 'Claude Code'], ['cursor', 'Cursor']].filter(([a]) => adapters.includes(a)).map(([, n]) => n) : []
  return {
    ...Object.fromEntries(Object.keys(ADAPTERS).map((a) => [`adapter_${a}`, adapters.includes(a)])),
    mcp_any: mcpServers.length > 0,
    mcp_servers_json: JSON.stringify(mcpServers),
    mcp_servers_list: mcpServers.map((s) => `\`${s}\``).join(' y '),
    mcp_hooked: hookTools.length > 0,
    mcp_hook_tools: hookTools.join(' y '),
    versioning,
    version_file_list: spec.versioning?.files ?? ['package.json'],
    version_files: (spec.versioning?.files ?? ['package.json']).map((f) => `\`${f}\``).join(', '),
    hooks: versioning || engine !== 'none',
    // Actor OKF (§7) de lo que escribe el generador: <producer>/<version>.
    generator_actor: `harness-loop-control/${JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf-8')).version}`,
    owner_actor: `human:${spec.owners[0].handle}`,
    project_name: spec.project.name,
    project_title: spec.project.title,
    mission: spec.project.mission || 'TODO(owner): qué resuelve este repo, para quién y qué queda fuera.',
    owners: spec.owners,
    owners_list: spec.owners.map((o) => `${o.name} (\`${o.handle}\`)`).join(', '),
    products: spec.products.map((p, i, all) => ({
      ...p,
      prefix_lower: p.prefix.toLowerCase(),
      comma: i < all.length - 1 ? ',' : '',
    })),
    fallback_prefix: spec.products[0].prefix,
    trunk: spec.branches?.trunk ?? 'dev',
    stable: spec.branches?.stable ?? 'main',
    verification: spec.verification ?? [],
    extra_rules: (spec.rules?.extra ?? []).map((rule) => ({ rule })),
    no_commit_attribution: spec.rules?.commit_attribution !== true,
    graphify: engine !== 'none',
    graphify_code: engine === 'code',
    graphify_docs: engine === 'docs',
    graphify_engine: engine,
    ponytail,
    ponytail_level: level,
    ponytail_state: ponytail ? `activo (nivel ${level})` : 'desactivado',
    codebase_memory: memory,
    index_mode: spec.codebase_memory?.index_mode ?? 'fast',
    codebase_memory_state: memory ? 'como complemento opcional' : 'desactivado',
    ci_github: (spec.ci ?? 'github') === 'github',
    adapters_any: files.length > 0,
    adapter_files: files.length ? files.join(', ') : '`CLAUDE.md`, `GEMINI.md` y similares, si se agregan',
    today: now.toISOString().slice(0, 10),
    now: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
}

/** `dot-github/x` → `.github/x`: los dotfiles de la plantilla no se activan en este repo. */
const targetPath = (rel) => rel.split(/[\\/]/).map((s) => s.replace(/^dot-/, '.')).join('/')

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

/** Lista de archivos a generar: [{ path, content }], sin tocar el disco. */
export function plan(spec, now = new Date()) {
  const ctx = buildContext(spec, now)
  const adapters = spec.adapters ?? []
  const layers = [
    ['template/core', true],
    ['template/graphify', ctx.graphify],
    ['template/hooks', ctx.hooks],
    ['template/versioning', ctx.versioning],
    ['template/mcp', ctx.mcp_any],
    ['template/ci-github', ctx.ci_github],
    ...adapters.map((a) => [`template/adapters/${a}`, true]),
    ['template/adapters/claude-mcp', ctx.adapter_claude && ctx.mcp_any],
    ['template/adapters/cursor-mcp', ctx.adapter_cursor && ctx.mcp_any],
  ]
  const out = []
  for (const [layer, on] of layers) {
    const dir = join(HERE, layer)
    if (!on || !existsSync(dir)) continue
    for (const file of walk(dir)) {
      const rel = relative(dir, file).split(sep).join('/')
      const raw = readFileSync(file, 'utf-8')
      const content = VERBATIM.test(rel) ? raw : render(raw, ctx, `${layer}/${rel}`)
      out.push({ path: targetPath(rel), content })
    }
  }
  if (ctx.graphify) {
    const dir = join(HERE, 'engines/graphify', ctx.graphify_engine)
    for (const file of walk(dir)) {
      out.push({ path: `scripts/graphify/${relative(dir, file).split(sep).join('/')}`, content: readFileSync(file, 'utf-8') })
    }
  }
  // Un archivo de versión de texto (VERSION) arranca en 0.1.0; package.json lo completa mergePackageJson.
  if (ctx.versioning) {
    for (const rel of ctx.version_file_list.filter((f) => !f.endsWith('.json'))) out.push({ path: rel, content: '0.1.0\n' })
  }
  const config = { generated_from: 'harness-loop-control', generated_at: ctx.now, ...spec }
  out.push({ path: '_AI_LOOP_CONTROL/harness.json', content: `${JSON.stringify(config, null, 2)}\n` })
  return { ctx, files: out }
}

function mergePackageJson(target, ctx, dryRun, log) {
  const path = join(target, 'package.json')
  const pkg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : { name: ctx.project_name, private: true }
  const scripts = { 'harness:check': 'node scripts/harness.mjs check' }
  if (ctx.graphify) {
    Object.assign(scripts, {
      graph: 'node scripts/graphify/graphify.mjs',
      'graph:build': 'node scripts/graphify/graphify.mjs build',
      'graph:check': 'node scripts/graphify/graphify.mjs stale',
      'graph:test': 'node --test scripts/graphify/graphify.test.mjs',
    })
  }
  if (ctx.mcp_any) scripts['agent:doctor'] = 'node scripts/agent-session.mjs doctor'
  // Al instalar: hooks de git activos y MCPs registrados en esta máquina.
  const prepare = [
    ctx.hooks &&
      // También repone el permiso de ejecución: un clon de un repo commiteado desde Windows lo pierde.
      "node -e \"try{const fs=require('node:fs');for(const f of fs.readdirSync('.githooks'))fs.chmodSync('.githooks/'+f,0o755);const g=(a)=>require('node:child_process').execFileSync('git',a,{stdio:'ignore'});g(['config','core.hooksPath','.githooks']);g(['config','merge.ours.driver','true'])}catch{}\"",
    ctx.mcp_any && 'node scripts/agent-session.mjs sync --quiet',
  ].filter(Boolean)
  if (prepare.length) scripts.prepare = prepare.join(' && ')
  pkg.scripts ??= {}
  const added = []
  if (ctx.versioning && ctx.version_file_list.includes('package.json') && !pkg.version) {
    pkg.version = '0.1.0'
    added.push('version')
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (pkg.scripts[name] === undefined) {
      pkg.scripts[name] = command
      added.push(name)
    } else if (pkg.scripts[name] !== command) {
      log.warn.push(`package.json: el script «${name}» ya existe y no se tocó; revisar que haga lo del harness`)
    }
  }
  if (ctx.graphify_code && !pkg.devDependencies?.typescript && !pkg.dependencies?.typescript) {
    pkg.devDependencies = { ...pkg.devDependencies, typescript: '^6.0.3' }
    added.push('devDependencies.typescript')
  }
  if (!added.length) return
  ;(existsSync(path) ? log.merged : log.created).push(`package.json (${added.join(', ')})`)
  if (!dryRun) writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
}

/** `.gitattributes` o `.gitignore` existente: se le agregan las líneas que le faltan, al final. */
function appendMissingLines(existing, content) {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()))
  const missing = content.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !have.has(l.trim()))
  return missing.length ? `${existing.replace(/\n?$/, '\n')}\n# Harness (generado por harness-loop-control)\n${missing.join('\n')}\n` : null
}

/** Documentos de un docs/ existente que no abren con frontmatter (sin contar index.md ni log.md). */
function nonOkfDocs(target) {
  const dir = join(target, 'docs')
  if (!existsSync(dir)) return []
  return walk(dir)
    .filter((f) => f.endsWith('.md') && !/[\\/](index|log)\.md$/.test(f))
    .filter((f) => !readFileSync(f, 'utf-8').replace(/^﻿/, '').startsWith('---'))
    .map((f) => relative(target, f).split(sep).join('/'))
}

export function generate({ spec, target, dryRun = false, force = false, now = new Date() }) {
  const { ctx, files } = plan(spec, now)
  const log = { created: [], skipped: [], merged: [], warn: [] }
  // Un docs/ previo sin frontmatter OKF no se convierte en bundle: el check fallaría de entrada.
  const legacyDocs = nonOkfDocs(target)
  if (legacyDocs.length) {
    log.warn.push(
      `docs/ ya tiene documentos sin frontmatter OKF (${legacyDocs.slice(0, 3).join(', ')}${legacyDocs.length > 3 ? ', …' : ''}): ` +
        'no se crea docs/index.md y docs/ queda fuera del check hasta migrarlo (frontmatter con type + docs/index.md con okf_version)'
    )
  }
  for (const { path, content } of files) {
    const abs = join(target, path)
    if (path === 'docs/index.md' && legacyDocs.length) continue
    // .gitattributes y .gitignore siempre se completan, también con --force: pisarlos borra reglas ajenas.
    if (existsSync(abs) && (path === '.gitattributes' || path === '.gitignore')) {
      const merged = appendMissingLines(readFileSync(abs, 'utf-8'), content)
      if (merged) {
        log.merged.push(path)
        if (!dryRun) writeFileSync(abs, merged)
      }
      continue
    }
    if (existsSync(abs) && !force) {
      log.skipped.push(path)
      continue
    }
    log.created.push(path)
    if (!dryRun) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
      // git ignora en silencio un hook que no es ejecutable (Linux y macOS).
      if (path.startsWith('.githooks/')) chmodSync(abs, 0o755)
    }
  }
  mergePackageJson(target, ctx, dryRun, log)
  return { ctx, log }
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf-8' })
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const specPath = arg('--spec')
  const targetArg = arg('--target')
  if (argv.includes('--help') || !specPath || !targetArg) {
    console.log('uso: node bin/harness-init.mjs --spec <harness.spec.json> --target <repo> [--dry-run] [--force]')
    process.exit(specPath && targetArg ? 0 : 1)
  }
  const dryRun = argv.includes('--dry-run')
  const spec = JSON.parse(readFileSync(resolve(specPath), 'utf-8'))
  const errors = validateSpec(spec)
  if (errors.length) {
    console.error(`spec inválida (${specPath}):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  const target = resolve(targetArg)
  if (existsSync(target) && !statSync(target).isDirectory()) {
    console.error(`${target} no es un directorio`)
    process.exit(1)
  }
  if (!dryRun) mkdirSync(target, { recursive: true })

  const { ctx, log } = generate({ spec, target, dryRun, force: argv.includes('--force') })
  const show = (title, items) => items.length && console.log(`\n${title} (${items.length}):\n${items.map((i) => `  ${i}`).join('\n')}`)
  console.log(`${dryRun ? '[dry-run] ' : ''}harness para ${ctx.project_title} → ${target}`)
  show('Crea', log.created)
  show('Completa', log.merged)
  show('Ya existían, no se tocaron (--force para pisarlos)', log.skipped)
  show('Avisos', log.warn)
  if (dryRun) return

  const notes = []
  if (ctx.hooks && existsSync(join(target, '.git'))) {
    run('git', ['config', 'core.hooksPath', '.githooks'], target)
    run('git', ['config', 'merge.ours.driver', 'true'], target)
    notes.push('hooks de git activos (core.hooksPath = .githooks)')
  } else if (ctx.hooks) {
    notes.push('el destino no es un repo git: al hacer `git init`, correr `npm install` (script prepare) para activar los hooks')
  }
  if (ctx.mcp_any) {
    const sync = run('node', ['scripts/agent-session.mjs', 'sync'], target)
    const lines = sync.stdout.trim()
    notes.push(lines ? `MCPs registrados en esta máquina:\n    ${lines.split('\n').join('\n    ')}` : 'ningún MCP encontrado en esta máquina: `npm run agent:doctor` dice cómo instalarlos')
  }
  if (ctx.graphify) {
    const graph = run('node', ['scripts/graphify/graphify.mjs', 'build'], target)
    notes.push(
      graph.status === 0
        ? 'mapa inicial generado (.graphify/graph.json)'
        : `el mapa no se pudo generar todavía${ctx.graphify_code ? ' (¿falta `npm install` para typescript?)' : ''}: correr \`npm run graph:build\``
    )
  }
  const check = run('node', ['scripts/harness.mjs', 'check'], target)
  notes.push(check.status === 0 ? check.stdout.trim() : `harness check FALLÓ:\n${check.stderr}`)

  const todos = log.created
    .map((entry) => entry.split(' (')[0]) // «package.json (version, …)» → package.json
    .filter((p) => !VERBATIM.test(p) && existsSync(join(target, p)) && readFileSync(join(target, p), 'utf-8').includes('TODO(owner)'))
  if (todos.length) notes.push(`quedan TODO(owner) para completar en: ${todos.join(', ')}`)
  show('Después de generar', notes)
  if (check.status !== 0) process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
