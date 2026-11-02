/**
 * Tests del generador: lo que sale tiene que pasar su propio `harness check` y no dejar marcadores
 * sin resolver, con cualquier combinación de módulos. Correr: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
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
