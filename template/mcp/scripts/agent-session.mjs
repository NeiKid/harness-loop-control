#!/usr/bin/env node
/**
 * Arranque de sesión para cualquier agente (AGENTS.md, «Arranque de sesión»).
 *
 *   node scripts/agent-session.mjs start [--format text|claude|cursor]
 *       registra los MCPs, indexa el repo y dice qué activar (lo corren los hooks o el agente)
 *   node scripts/agent-session.mjs sync [--quiet]   sólo registra los MCPs en cada herramienta
 *   node scripts/agent-session.mjs doctor           qué hay instalado, qué falta y cómo resolverlo
 *
 * Los MCPs (Ponytail, codebase-memory-mcp) se instalan en la máquina, no en el repo: este script los
 * encuentra (primero en lo que ya registraste en tus agentes, después en el PATH y en las rutas de
 * instalación conocidas) y escribe la configuración de proyecto de cada herramienta de `adapters`.
 * Esos archivos llevan rutas de esta máquina, así que van en .gitignore; un archivo versionado en git
 * no se toca. `start` nunca falla: un problema acá no puede frenar la sesión.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = homedir()
const PONYTAIL = 'ponytail'
const MEMORY = 'codebase-memory-mcp'

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}
const config = () => readJson(join(ROOT, '_AI_LOOP_CONTROL', 'harness.json')) ?? {}

function wanted(cfg) {
  return [cfg.ponytail?.enabled !== false && PONYTAIL, cfg.codebase_memory?.enabled !== false && MEMORY].filter(Boolean)
}

function onPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const full = join(dir, bin + ext)
      if (dir && existsSync(full)) return full
    }
  }
  return null
}

/** Lo que ya registraste en algún agente: si funciona ahí, funciona acá. */
function fromUserConfigs(name) {
  const claude = readJson(join(HOME, '.claude.json'))
  const entries = [
    claude?.mcpServers?.[name],
    ...Object.values(claude?.projects ?? {}).map((p) => p?.mcpServers?.[name]),
    readJson(join(HOME, '.cursor', 'mcp.json'))?.mcpServers?.[name],
    readJson(join(HOME, '.gemini', 'settings.json'))?.mcpServers?.[name],
    readJson(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'))?.mcpServers?.[name],
  ]
  const hit = entries.find((e) => e?.command)
  // Sólo command y args: el env de un MCP puede traer tokens, y estos archivos viven dentro del repo.
  return hit ? { command: hit.command, args: hit.args ?? [] } : null
}

const FALLBACKS = {
  [PONYTAIL]: () => {
    const localAppData = process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local')
    const script = [
      process.env.PONYTAIL_MCP,
      join(localAppData, 'Programs', 'ponytail', 'ponytail-mcp', 'index.js'),
      join(HOME, '.local', 'share', 'ponytail', 'ponytail-mcp', 'index.js'),
    ].find((p) => p && existsSync(p))
    return script ? { command: 'node', args: [script] } : null
  },
  [MEMORY]: () => {
    const bin = process.env.CODEBASE_MEMORY_MCP || onPath(MEMORY)
    return bin ? { command: bin, args: [] } : null
  },
}

export function resolveServers(names) {
  return Object.fromEntries(names.map((name) => [name, fromUserConfigs(name) ?? FALLBACKS[name]()]))
}

const mapValues = (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]))
const mergeKey = (key, shape) => (current, servers) => ({ ...current, [key]: { ...current[key], ...mapValues(servers, shape) } })
const plain = (s) => s

/** Configuración de proyecto de cada herramienta. Windsurf y Cline sólo leen MCPs de su config global. */
export const WRITERS = {
  claude: { file: '.mcp.json', json: mergeKey('mcpServers', plain) },
  cursor: { file: '.cursor/mcp.json', json: mergeKey('mcpServers', plain) },
  gemini: { file: '.gemini/settings.json', json: mergeKey('mcpServers', plain) },
  copilot: { file: '.vscode/mcp.json', json: mergeKey('servers', (s) => ({ type: 'stdio', ...s })) },
  opencode: {
    file: 'opencode.json',
    json: (current, servers) => ({
      $schema: 'https://opencode.ai/config.json',
      ...mergeKey('mcp', (s) => ({ type: 'local', command: [s.command, ...s.args], enabled: true }))(current, servers),
    }),
  },
  codex: { file: '.codex/config.toml', toml: true },
}

const TOML_START = '# harness:mcp (lo escribe scripts/agent-session.mjs; no editar este bloque)'
const TOML_END = '# harness:mcp-end'

function codexBlock(servers) {
  const lines = [TOML_START]
  for (const [name, s] of Object.entries(servers)) {
    // Un string JSON es un string básico válido en TOML (mismos escapes).
    lines.push(`[mcp_servers.${name}]`, `command = ${JSON.stringify(s.command)}`, `args = ${JSON.stringify(s.args)}`, '')
  }
  lines.push(TOML_END)
  return lines.join('\n')
}

function tracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function sync(cfg = config()) {
  const servers = Object.fromEntries(Object.entries(resolveServers(wanted(cfg))).filter(([, s]) => s))
  const results = []
  if (!Object.keys(servers).length) return { servers, results }
  for (const adapter of cfg.adapters ?? []) {
    const writer = WRITERS[adapter]
    if (!writer) continue
    const abs = join(ROOT, writer.file)
    if (tracked(writer.file)) {
      results.push({ file: writer.file, status: 'omitido: está versionado en git' })
      continue
    }
    const before = existsSync(abs) ? readFileSync(abs, 'utf-8') : ''
    let after
    if (writer.toml) {
      const block = codexBlock(servers)
      const start = before.indexOf(TOML_START)
      const end = before.indexOf(TOML_END)
      after = start === -1 ? `${before}${before && !before.endsWith('\n') ? '\n' : ''}${block}\n` : before.slice(0, start) + block + before.slice(end + TOML_END.length)
    } else {
      let current = {}
      try {
        current = before ? JSON.parse(before) : {}
      } catch {
        results.push({ file: writer.file, status: 'omitido: no es JSON válido' })
        continue
      }
      after = `${JSON.stringify(writer.json(current, servers), null, 2)}\n`
    }
    if (after === before) {
      results.push({ file: writer.file, status: 'sin cambios' })
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, after)
    results.push({ file: writer.file, status: 'actualizado', changed: true })
  }
  return { servers, results }
}

/** Indexa el repo en codebase memory si todavía no está; en segundo plano para no frenar la sesión. */
function ensureIndexed(memory, cfg) {
  if (cfg.codebase_memory?.auto_index === false) return 'indexado automático desactivado en harness.json'
  try {
    const listed = execFileSync(memory.command, [...memory.args, 'cli', '--json', 'list_projects'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // shortcut: compara la ruta como texto en la salida; si cambia el formato de list_projects, reindexa de más (inofensivo).
    const norm = (s) => s.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase()
    if (norm(listed).includes(norm(ROOT))) return 'el repo ya está indexado (se actualiza solo)'
  } catch {
    // Sin respuesta: se intenta indexar igual.
  }
  const mode = cfg.codebase_memory?.index_mode ?? 'fast'
  const child = spawn(memory.command, [...memory.args, 'cli', '--quiet', 'index_repository', '--repo-path', ROOT, '--mode', mode], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
  return `indexando el repo en segundo plano (modo ${mode}); en unos minutos responde`
}

function start(format) {
  const cfg = config()
  const lines = []
  try {
    const { servers, results } = sync(cfg)
    const level = cfg.ponytail?.level ?? 'full'
    if (cfg.ponytail?.enabled !== false) {
      lines.push(
        servers[PONYTAIL]
          ? `Ponytail: invoca ahora la herramienta ponytail_instructions del MCP ponytail con mode "${level}" y sigue su ruleset toda la sesión.`
          : 'Ponytail: el MCP no está instalado en esta máquina; rige el resumen de AGENTS.md («Modo de trabajo: Ponytail»).'
      )
    }
    if (cfg.codebase_memory?.enabled !== false) {
      lines.push(
        servers[MEMORY]
          ? `Codebase memory: ${ensureIndexed(servers[MEMORY], cfg)}. Úsalo junto al mapa para preguntas de estructura; las decisiones van sólo al ledger.`
          : 'Codebase memory: el MCP no está instalado en esta máquina; sigue con el mapa y grep.'
      )
    }
    const changed = results.filter((r) => r.changed).map((r) => r.file)
    if (changed.length) {
      lines.push(`MCPs registrados recién en ${changed.join(', ')}: si sus herramientas no aparecen en esta sesión, reiníciala.`)
    }
  } catch (error) {
    lines.push(`agent-session: no se pudieron activar los MCPs (${error.message}); rigen los resúmenes de AGENTS.md.`)
  }
  lines.push('Después: lee _AI_LOOP_CONTROL/LOOP_STATE.md y ACTION_QUEUE.md (AGENTS.md, «Orden de lectura»).')
  const text = lines.join('\n')
  if (format === 'claude') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }))
  } else if (format === 'cursor') {
    process.stdout.write(JSON.stringify({ additional_context: text }))
  } else {
    console.log(text)
  }
}

function doctor() {
  const cfg = config()
  const { servers, results } = sync(cfg)
  console.log('MCPs:')
  for (const name of wanted(cfg)) {
    const s = servers[name]
    console.log(`  ${name}: ${s ? `${s.command} ${s.args.join(' ')}`.trim() : 'NO ENCONTRADO'}`)
  }
  console.log('\nConfiguración de proyecto:')
  for (const r of results) console.log(`  ${r.file}: ${r.status}`)
  const tips = []
  if (wanted(cfg).includes(PONYTAIL) && !servers[PONYTAIL]) {
    tips.push('Ponytail: instálalo (https://github.com/DietrichGebert/ponytail) o define PONYTAIL_MCP con la ruta de ponytail-mcp/index.js.')
  }
  if (wanted(cfg).includes(MEMORY) && !servers[MEMORY]) {
    tips.push('codebase-memory-mcp: instálalo y deja el binario en el PATH, o define CODEBASE_MEMORY_MCP con su ruta.')
  }
  const globalOnly = (cfg.adapters ?? []).filter((a) => ['windsurf', 'cline'].includes(a))
  if (globalOnly.length) {
    tips.push(`${globalOnly.join(' y ')} sólo leen MCPs de su configuración global: \`codebase-memory-mcp install\` los registra ahí; Ponytail ya les llega como regla vía AGENTS.md.`)
  }
  if (tips.length) console.log(`\nPendiente:\n${tips.map((t) => `  - ${t}`).join('\n')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'start', ...args] = process.argv.slice(2)
  const format = args[args.indexOf('--format') + 1]
  if (command === 'start') {
    start(args.includes('--format') ? format : 'text')
    process.exit(0)
  } else if (command === 'sync') {
    const { results } = sync()
    if (!args.includes('--quiet')) for (const r of results) console.log(`${r.file}: ${r.status}`)
  } else if (command === 'doctor') doctor()
  else {
    console.error('uso: node scripts/agent-session.mjs start [--format text|claude|cursor] | sync [--quiet] | doctor')
    process.exit(1)
  }
}
