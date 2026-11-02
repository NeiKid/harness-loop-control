/**
 * Tests del generador: lo que sale tiene que pasar su propio `harness check` y no dejar marcadores
 * sin resolver, con cualquier combinación de módulos. Correr: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { generate, validateSpec, plan } from '../bin/harness-init.mjs'
import { render } from '../lib/render.mjs'

const example = JSON.parse(readFileSync(new URL('../harness.spec.example.json', import.meta.url), 'utf-8'))
const minimal = {
  project: { name: 'docs-repo', title: 'Docs Repo' },
  owners: [{ name: 'Ana', handle: 'ana' }],
  products: [{ prefix: 'DOC', name: 'Documentación', code: '`docs/`', source_of_truth: '`docs/`' }],
  graphify: { engine: 'docs' },
  ponytail: { enabled: false },
  codebase_memory: { enabled: false },
  adapters: [],
  ci: 'none',
}

const node = (args, cwd) => spawnSync('node', args, { cwd, encoding: 'utf-8' })
const fresh = () => mkdtempSync(join(tmpdir(), 'harness-'))

test('render: variables, secciones, listas e inversas', () => {
  const out = render('{{#xs}}\n- {{v}}{{sep}}\n{{/xs}}\n{{^none}}vacío{{/none}} {{t}}\n', { xs: [{ v: 1, sep: ',' }, { v: 2, sep: '' }], none: [], t: 'ok' })
  assert.equal(out, '- 1,\n- 2\nvacío ok\n')
  assert.throws(() => render('{{falta}}', {}), /sin valor/)
})

test('valida la spec', () => {
  assert.deepEqual(validateSpec(example), [])
  const bad = { ...minimal, products: [{ prefix: 'x', name: 'n', code: 'c', source_of_truth: 's' }], adapters: ['nope'] }
  const errors = validateSpec(bad)
  assert.ok(errors.some((e) => e.includes('prefix')))
  assert.ok(errors.some((e) => e.includes('nope')))
})

for (const [name, spec] of [['ejemplo completo', example], ['mínima con grafo de documentos', minimal]]) {
  test(`genera un harness consistente: ${name}`, () => {
    for (const { path, content } of plan(spec).files) {
      if (!/\.(mjs|cjs|js)$/.test(path)) assert.doesNotMatch(content, /\{\{\w+\}\}/, path)
      if (path.endsWith('.json')) JSON.parse(content)
      if (path.endsWith('.jsonl')) content.trim().split('\n').forEach((l) => JSON.parse(l))
    }
    const dir = fresh()
    generate({ spec, target: dir })
    const check = node(['scripts/harness.mjs', 'check'], dir)
    assert.equal(check.status, 0, check.stderr)
  })
}

test('variante mínima: sin adaptadores, sin CI, sin Ponytail ni codebase memory', () => {
  const dir = fresh()
  generate({ spec: minimal, target: dir })
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf-8')
  assert.doesNotMatch(agents, /Ponytail|codebase-memory/)
  assert.match(agents, /grafo de documentos/)
  assert.match(agents, /TODO\(owner\)/) // sin misión ni tabla de verificación
  assert.ok(!existsSync(join(dir, 'CLAUDE.md')))
  assert.ok(!existsSync(join(dir, '.github')))
  assert.equal(node(['scripts/graphify/graphify.mjs', 'build'], dir).status, 0)
  assert.equal(node(['--test', 'scripts/graphify/graphify.test.mjs'], dir).status, 0)
})

test('new-spec, next-dec y el check detectan lo que falta', () => {
  const dir = fresh()
  generate({ spec: example, target: dir })
  assert.equal(node(['scripts/harness.mjs', 'new-spec', 'API', 'login-sso', 'Login', 'SSO'], dir).status, 0)
  assert.equal(node(['scripts/harness.mjs', 'new-spec', 'API', 'otra'], dir).status, 0)
  const specs = readdirSync(join(dir, '_AI_LOOP_CONTROL/specs')).filter((n) => !n.startsWith('_') && n !== 'README.md')
  assert.deepEqual(specs, ['API-S01-login-sso', 'API-S02-otra'])
  assert.match(readFileSync(join(dir, '_AI_LOOP_CONTROL/specs/API-S01-login-sso/spec.md'), 'utf-8'), /# API-S01 — Login SSO/)
  assert.equal(node(['scripts/harness.mjs', 'next-dec', 'API'], dir).stdout.trim(), 'API/dec/002')
  assert.notEqual(node(['scripts/harness.mjs', 'new-spec', 'NOPE', 'x'], dir).status, 0)

  // Dos decisiones con el mismo número en prefijos distintos: la secuencia es global.
  const ledger = join(dir, '_AI_LOOP_CONTROL/DECISION_LEDGER.jsonl')
  const entry = (id) => JSON.stringify({ id, type: 'tecnica', decision: 'd', rationale: 'r', status: 'vigente', recorded_at: 'now' })
  writeFileSync(ledger, `${readFileSync(ledger, 'utf-8')}${entry('API/dec/002')}\n${entry('CORE/dec/002')}\n`)
  const check = node(['scripts/harness.mjs', 'check'], dir)
  assert.equal(check.status, 1)
  assert.match(check.stderr, /secuencia es global/)
})

test('versionado: el hook sube la versión según el encabezado, sólo en el tronco', () => {
  const dir = fresh()
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf-8' })
  git('init', '-q', '-b', 'dev')
  generate({ spec: minimal, target: dir })
  git('config', 'core.hooksPath', '.githooks')
  const version = () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).version
  git('add', '-A')
  git('commit', '-qm', 'chore: bootstrap')
  assert.equal(version(), '0.1.0') // el primer commit no se versiona
  for (const [message, expected] of [['feat: a', '0.2.0'], ['fix: b', '0.2.1'], ['feat!: c', '1.0.0'], ['docs: d', '1.0.1']]) {
    git('commit', '-q', '--allow-empty', '-m', message)
    assert.equal(version(), expected, message)
  }
  assert.equal(git('show', 'HEAD:package.json').stdout.includes('"1.0.1"'), true) // el bump va dentro del commit
  git('checkout', '-q', '-b', 'doc/x')
  git('commit', '-q', '--allow-empty', '-m', 'feat: en rama')
  assert.equal(version(), '1.0.1')
})

test('agent-session: registra los MCPs de la máquina en cada herramienta, sin pisar lo ajeno', () => {
  const dir = fresh()
  generate({ spec: example, target: dir })
  const configPath = join(dir, '_AI_LOOP_CONTROL/harness.json')
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  config.codebase_memory.auto_index = false
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { otro: { command: 'x', args: [] } } }))

  // Máquina falsa: sin configuraciones de usuario, MCPs en rutas conocidas.
  const home = fresh()
  const ponytail = join(home, 'ponytail-index.js')
  writeFileSync(ponytail, '')
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, PONYTAIL_MCP: ponytail, CODEBASE_MEMORY_MCP: join(home, 'cbm') }
  const session = (...args) => spawnSync('node', ['scripts/agent-session.mjs', ...args], { cwd: dir, encoding: 'utf-8', env })

  assert.equal(session('sync').status, 0)
  const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')).mcpServers
  assert.deepEqual(Object.keys(mcp), ['otro', 'ponytail', 'codebase-memory-mcp'])
  assert.deepEqual(mcp.ponytail, { command: 'node', args: [ponytail] })
  assert.ok(JSON.parse(readFileSync(join(dir, '.vscode/mcp.json'), 'utf-8')).servers.ponytail.type === 'stdio')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf-8')).mcp['codebase-memory-mcp'].command, [join(home, 'cbm')])
  assert.match(readFileSync(join(dir, '.codex/config.toml'), 'utf-8'), /\[mcp_servers\.ponytail\]/)
  assert.match(session('sync').stdout, /\.mcp\.json: sin cambios/)
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf-8'), /^\.mcp\.json$/m)

  const hook = session('start', '--format', 'claude')
  assert.equal(hook.status, 0)
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /ponytail_instructions.*"full"/)
})

test('OKF: el harness generado es conforme y el check detecta lo que no lo es', () => {
  const dir = fresh()
  generate({ spec: example, target: dir })
  const env = { ...process.env, HARNESS_ACTOR: 'codex/gpt-5' }
  assert.equal(spawnSync('node', ['scripts/harness.mjs', 'new-spec', 'API', 'login'], { cwd: dir, env }).status, 0)
  const spec = readFileSync(join(dir, '_AI_LOOP_CONTROL/specs/API-S01-login/spec.md'), 'utf-8')
  assert.match(spec, /^---\ntype: Spec\n/)
  assert.match(spec, /generated: \{ by: codex\/gpt-5, at: \d{4}-\d\d-\d\dT[\d:]+Z \}/)
  assert.match(readFileSync(join(dir, '_AI_LOOP_CONTROL/index.md'), 'utf-8'), /^---\nokf_version: "0\.2"\n---/)
  assert.equal(node(['scripts/harness.mjs', 'check'], dir).status, 0)

  writeFileSync(join(dir, 'docs/sin-type.md'), '---\ntitle: x\n---\n\nhola\n')
  writeFileSync(join(dir, 'docs/sin-frontmatter.md'), '# hola\n')
  writeFileSync(join(dir, '_AI_LOOP_CONTROL/specs/index.md'), '---\ntype: X\n---\n')
  const check = node(['scripts/harness.mjs', 'check'], dir)
  assert.equal(check.status, 1)
  assert.match(check.stderr, /docs\/sin-type\.md: el frontmatter no tiene type/)
  assert.match(check.stderr, /docs\/sin-frontmatter\.md: falta frontmatter/)
  assert.match(check.stderr, /specs\/index\.md: index\.md no lleva frontmatter/)
})

test('CLI: genera en un directorio vacío sin package.json y termina bien', () => {
  const dir = fresh()
  const specPath = join(fresh(), 'spec.json')
  writeFileSync(specPath, JSON.stringify(minimal))
  const run = node([fileURLToPath(new URL('../bin/harness-init.mjs', import.meta.url)), '--spec', specPath, '--target', dir], dir)
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /harness: ok/)
})

test('robustez: --force no pisa .gitattributes, docs/ previo no rompe el check, BOM y valores inseguros', () => {
  const dir = fresh()
  writeFileSync(join(dir, '.gitattributes'), '*.png binary\n')
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs/manual.md'), '# Manual previo\n')
  const { log } = generate({ spec: example, target: dir, force: true })
  assert.match(readFileSync(join(dir, '.gitattributes'), 'utf-8'), /^\*\.png binary\n/)
  assert.ok(!existsSync(join(dir, 'docs/index.md')))
  assert.ok(log.warn.some((w) => w.includes('docs/manual.md')))
  assert.equal(node(['scripts/harness.mjs', 'check'], dir).status, 0)

  writeFileSync(join(dir, '_AI_LOOP_CONTROL/bom.md'), '﻿---\ntype: Guide\n---\n\nhola\n')
  assert.equal(node(['scripts/harness.mjs', 'check'], dir).status, 0)

  const bad = { ...minimal, project: { name: 'x', title: 'Con "comillas"' }, branches: { trunk: 'dev"; rm -rf ~; "' } }
  const errors = validateSpec(bad)
  assert.ok(errors.some((e) => e.includes('project.title')))
  assert.ok(errors.some((e) => e.includes('branches.trunk')))
})

test('no pisa un repo existente: completa .gitattributes y package.json', () => {
  const dir = fresh()
  writeFileSync(join(dir, 'AGENTS.md'), 'mío\n')
  writeFileSync(join(dir, '.gitattributes'), '*.png binary\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { prepare: 'husky' } }))
  const { log } = generate({ spec: example, target: dir })
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf-8'), 'mío\n')
  assert.ok(log.skipped.includes('AGENTS.md'))
  const attrs = readFileSync(join(dir, '.gitattributes'), 'utf-8')
  assert.match(attrs, /^\*\.png binary\n/)
  assert.match(attrs, /DECISION_LEDGER\.jsonl merge=union/)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
  assert.equal(pkg.scripts.prepare, 'husky')
  assert.ok(pkg.scripts['harness:check'])
  assert.ok(log.warn.some((w) => w.includes('prepare')))
})
