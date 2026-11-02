#!/usr/bin/env node
/**
 * Harness — chequeos y altas del bus `_AI_LOOP_CONTROL/` (ver AGENTS.md).
 *
 *   node scripts/harness.mjs check                       ledger, heartbeat e índice de specs consistentes
 *   node scripts/harness.mjs next-dec <PREFIJO>          siguiente id de decisión (secuencia global)
 *   node scripts/harness.mjs new-spec <PREFIJO> <slug> ["Título"]
 *
 * Los prefijos salen de `_AI_LOOP_CONTROL/harness.json`. Sin dependencias: corre igual en cualquier
 * máquina, en CI y para cualquier agente.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUS = join(ROOT, '_AI_LOOP_CONTROL')
const SPECS = join(BUS, 'specs')
const INDEX_MARKER = '<!-- harness:specs-index'
const REQUIRED = ['id', 'type', 'decision', 'rationale', 'status', 'recorded_at']
const STATUSES = ['vigente', 'reemplazada', 'revocada']

export function loadPrefixes(root = ROOT) {
  const config = JSON.parse(readFileSync(join(root, '_AI_LOOP_CONTROL', 'harness.json'), 'utf-8'))
  return config.products.map((p) => p.prefix)
}

const idPattern = (prefixes) => new RegExp(`^(${prefixes.join('|')})/dec/(\\d{3,})$`)

/** Problemas del ledger: JSON, forma del id, campos, ids y números repetidos, `supersedes` colgados. */
export function checkLedger(text, prefixes) {
  const problems = []
  const ids = new Map()
  const numbers = new Map()
  const supersedes = []
  const ID = idPattern(prefixes)
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return
    const where = `ledger línea ${index + 1}`
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      problems.push(`${where}: no es JSON válido`)
      return
    }
    const missing = REQUIRED.filter((k) => entry[k] === undefined || entry[k] === '')
    if (missing.length) problems.push(`${where}: faltan ${missing.join(', ')}`)
    const match = ID.exec(entry.id ?? '')
    if (!match) {
      problems.push(`${where}: id inválido ${JSON.stringify(entry.id)} (se espera <${prefixes.join('|')}>/dec/<NNN>)`)
      return
    }
    if (entry.status && !STATUSES.includes(entry.status)) problems.push(`${where}: status ${JSON.stringify(entry.status)} no es ${STATUSES.join('|')}`)
    if (ids.has(entry.id)) problems.push(`${where}: id repetido ${entry.id} (ya en la ${ids.get(entry.id)})`)
    else ids.set(entry.id, where)
    // Las entradas migradas de otro ledger (`legacy_id`) pueden repetir número entre prefijos.
    if (entry.legacy_id === undefined) {
      const number = Number(match[2])
      if (numbers.has(number)) problems.push(`${where}: el número ${number} ya lo usa ${numbers.get(number)}; la secuencia es global`)
      else numbers.set(number, entry.id)
    }
    if (entry.supersedes) supersedes.push([where, entry.supersedes])
  })
  for (const [where, target] of supersedes) {
    if (!ids.has(target)) problems.push(`${where}: supersedes ${target}, que no está en el ledger`)
  }
  return { problems, ids: [...ids.keys()], max: Math.max(0, ...numbers.keys()) }
}

export function checkHeartbeat(text, prefixes, ledgerIds) {
  let beat
  try {
    beat = JSON.parse(text)
  } catch {
    return ['HEARTBEAT.json: no es JSON válido']
  }
  const problems = []
  for (const key of Object.keys(beat.products ?? {})) {
    if (!prefixes.includes(key)) problems.push(`HEARTBEAT.json: producto ${key} no está en harness.json`)
  }
  if (beat.last_decision_id && !ledgerIds.includes(beat.last_decision_id)) {
    problems.push(`HEARTBEAT.json: last_decision_id ${beat.last_decision_id} no está en el ledger`)
  }
  return problems
}

const SPEC_DIR = (prefixes) => new RegExp(`^(${prefixes.join('|')})-S(\\d{2,})-[a-z0-9-]+$`)

export function checkSpecs(root, prefixes) {
  const dir = join(root, '_AI_LOOP_CONTROL', 'specs')
  const index = readFileSync(join(dir, 'README.md'), 'utf-8')
  const problems = []
  for (const name of listSpecDirs(dir)) {
    if (!SPEC_DIR(prefixes).test(name)) problems.push(`specs/${name}: el nombre no es <PREFIJO>-S<NN>-<slug>`)
    if (!existsSync(join(dir, name, 'spec.md'))) problems.push(`specs/${name}: falta spec.md`)
    if (!index.includes(`(${name}/`)) problems.push(`specs/${name}: no está en specs/README.md`)
  }
  return problems
}

function listSpecDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
}

function check() {
  const prefixes = loadPrefixes()
  const ledger = checkLedger(readFileSync(join(BUS, 'DECISION_LEDGER.jsonl'), 'utf-8'), prefixes)
  const problems = [
    ...ledger.problems,
    ...checkHeartbeat(readFileSync(join(BUS, 'HEARTBEAT.json'), 'utf-8'), prefixes, ledger.ids),
    ...checkSpecs(ROOT, prefixes),
  ]
  if (problems.length) {
    console.error(`harness: ${problems.length} problema(s)`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`harness: ok (${ledger.ids.length} decisiones, ${listSpecDirs(SPECS).length} specs)`)
}

function requirePrefix(prefix, prefixes) {
  if (!prefixes.includes(prefix)) {
    console.error(`prefijo ${JSON.stringify(prefix)} desconocido; los de harness.json: ${prefixes.join(', ')}`)
    process.exit(1)
  }
}

function nextDec(prefix) {
  const prefixes = loadPrefixes()
  requirePrefix(prefix, prefixes)
  const { max } = checkLedger(readFileSync(join(BUS, 'DECISION_LEDGER.jsonl'), 'utf-8'), prefixes)
  console.log(`${prefix}/dec/${String(max + 1).padStart(3, '0')}`)
}

function newSpec(prefix, slug, title) {
  const prefixes = loadPrefixes()
  requirePrefix(prefix, prefixes)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug ?? '')) {
    console.error('el slug va en minúsculas, con guiones: new-spec <PREFIJO> <slug> ["Título"]')
    process.exit(1)
  }
  const used = listSpecDirs(SPECS)
    .map((name) => SPEC_DIR([prefix]).exec(name))
    .filter(Boolean)
    .map((m) => Number(m[2]))
  const id = `${prefix}-S${String(Math.max(0, ...used) + 1).padStart(2, '0')}`
  const name = `${id}-${slug}`
  const today = new Date().toISOString().slice(0, 10)
  const fill = (text) =>
    text
      .replaceAll('<<ID>>', id)
      .replaceAll('<<PREFIJO>>', prefix)
      .replaceAll('<<FECHA>>', today)
      .replaceAll('<<TITULO>>', title || slug.replaceAll('-', ' '))
  mkdirSync(join(SPECS, name))
  for (const file of readdirSync(join(SPECS, '_TEMPLATE'))) {
    writeFileSync(join(SPECS, name, file), fill(readFileSync(join(SPECS, '_TEMPLATE', file), 'utf-8')))
  }
  const indexPath = join(SPECS, 'README.md')
  const index = readFileSync(indexPath, 'utf-8')
  const at = index.indexOf(INDEX_MARKER)
  const row = `| [${name}](${name}/spec.md) | \`${prefix}\` | Borrador | — |\n`
  writeFileSync(indexPath, at === -1 ? `${index}${row}` : index.slice(0, at) + row + index.slice(at))
  console.log(`spec creada: _AI_LOOP_CONTROL/specs/${name}/ (spec.md, plan.md, tasks.md)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'check') check()
  else if (command === 'next-dec') nextDec(args[0])
  else if (command === 'new-spec') newSpec(args[0], args[1], args.slice(2).join(' '))
  else {
    console.error('uso: node scripts/harness.mjs check | next-dec <PREFIJO> | new-spec <PREFIJO> <slug> ["Título"]')
    process.exit(1)
  }
}
