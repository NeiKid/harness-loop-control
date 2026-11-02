/**
 * Tests del mapa contra un repo de juguete. Cubren los puntos ciegos que más
 * cuestan: URLs con puntuación pegada, URLs dentro de bloques de código,
 * anclas duplicadas, enlaces `/x.md` relativos a la raíz del bundle OKF y el
 * hash normalizado de CRLF.
 *
 *   node --test scripts/graphify/graphify.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { buildGraph } from './lib/build.mjs'
import { serializeGraph, writeGraph, loadGraph, checkStale, sameGraph } from './lib/store.mjs'
import { indexGraph, resolveNode, search, shortestPath, godNodes, sourceReport, tagReport } from './lib/query.mjs'
import { parseFrontmatter, slugify } from './lib/parse.mjs'

function toyRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'graphify-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

const FILES = {
  'docs/index.md': [
    '---',
    'okf_version: "0.1"',
    'title: Bundle',
    'tags: [demo, index]',
    '---',
    '',
    '# Bundle',
    '',
    '* [A](/research/a.md) - primer doc',
    '* [B](/research/b.md#costos-compartidos) - ancla válida',
    '* [Roto](/research/no-existe.md)',
    '* [Crudo](../research/raw/data.json) y [carpeta](research/)',
    '* Ejemplo de sintaxis: `[texto](destino)` no es un enlace',
  ].join('\n'),
  'research/raw/data.json': '{}',
  'docs/research/a.md': [
    '---',
    'type: Research',
    'title: "Doc A: tags"',
    'description: Asignación de costos',
    'tags: [demo, tagging]',
    '---',
    '',
    '# Doc A',
    '',
    '- Hecho clave — https://docs.finout.io/virtual-tags.md.',
    '- Otro (ver https://www.example.org/guia/).',
    '- Repetido https://docs.finout.io/virtual-tags.md',
    '- Ancla rota: [b](./b.md#no-hay)',
    '',
    '```sql',
    '-- https://ignorado.example.com/no-cuenta',
    '# no es un heading',
    '```',
  ].join('\n'),
  'docs/research/b.md': [
    '---',
    'type: Research',
    'title: Doc B',
    'tags: [demo, kubernetes]',
    '---',
    '',
    '# Doc B',
    '## Costos compartidos',
    '## Costos compartidos',
    'Fuente: https://www.example.org/guia/',
  ].join('\n'),
  'artifact/page.html': [
    '<title>Página</title>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2">',
    '<h2>Fuentes</h2>',
    '<a href="https://www.example.org/guia/" target="_blank">Framework</a>',
    '<script>',
    "const row = '<h2>Plantilla</h2><a href=\"' + url + '\">x</a>'",
    '</script>',
  ].join('\n'),
}

test('frontmatter: escalares, comillas y listas', () => {
  const { meta, bodyStart } = parseFrontmatter(['---', 'title: "A: b"', 'tags: [x, "y"]', 'n: 3', '---', 'body'])
  assert.deepEqual(meta, { title: 'A: b', tags: ['x', 'y'], n: '3' })
  assert.equal(bodyStart, 5)
  assert.equal(parseFrontmatter(['# sin frontmatter']).meta, null)
})

test('slug sin acentos ni signos', () => {
  assert.equal(slugify('Riesgos de transición: ¿qué?'), 'riesgos-de-transicion-que')
})

test('build: archivos, secciones, citas y fuentes', () => {
  const root = toyRepo(FILES)
  try {
    const g = buildGraph(root)
    assert.deepEqual(g.files.map((f) => f.path), [
      'artifact/page.html',
      'docs/index.md',
      'docs/research/a.md',
      'docs/research/b.md',
    ])
    const a = g.files.find((f) => f.path === 'docs/research/a.md')
    assert.equal(a.kind, 'doc')
    assert.equal(a.title, 'Doc A: tags')
    assert.deepEqual(a.tags, ['demo', 'tagging'])
    assert.equal(g.files.find((f) => f.path === 'artifact/page.html').kind, 'artifact')

    // URL con punto final y con paréntesis de la prosa, limpiados; el del
    // bloque de código no cuenta; el repetido suma al contador.
    const aCites = g.cites.filter((c) => c.from === 'docs/research/a.md')
    assert.deepEqual(aCites.map((c) => c.url).sort(), [
      'https://docs.finout.io/virtual-tags.md',
      'https://www.example.org/guia/',
    ])
    assert.equal(aCites.find((c) => c.url.includes('finout')).count, 2)
    assert.ok(!g.sources.some((s) => s.url.includes('ignorado')))
    assert.ok(!g.sections.some((s) => s.title === 'no es un heading'))

    // `<link href>` de la hoja de estilos no es una cita.
    assert.ok(!g.sources.some((s) => s.domain === 'fonts.googleapis.com'))
    assert.equal(g.sources.find((s) => s.url === 'https://www.example.org/guia/').domain, 'example.org')

    // Lo que está dentro de `<script>` es código: ni secciones ni enlaces.
    assert.ok(!g.sections.some((s) => s.title === 'Plantilla'))
    assert.ok(!g.sources.some((s) => s.url.includes('url')))
    assert.ok(!g.links.some((l) => l.from === 'artifact/page.html'))

    // Slugs duplicados se desambiguan como en GitHub.
    const bSlugs = g.sections.filter((s) => s.file === 'docs/research/b.md').map((s) => s.id)
    assert.deepEqual(bSlugs, [
      'docs/research/b.md#doc-b',
      'docs/research/b.md#costos-compartidos',
      'docs/research/b.md#costos-compartidos-1',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('enlaces: raíz del bundle, anclas válidas y rotas', () => {
  const root = toyRepo(FILES)
  try {
    const g = buildGraph(root)
    const fromIndex = g.links.filter((l) => l.from === 'docs/index.md')
    // El ejemplo dentro de backticks no aparece; el JSON y la carpeta que
    // existen son assets, no enlaces rotos.
    assert.deepEqual(fromIndex.map((l) => l.to), [
      'docs/research/a.md',
      'docs/research/b.md',
      'docs/research/no-existe.md',
      'research/raw/data.json',
      'docs/research/',
    ])
    assert.equal(fromIndex[1].broken, undefined)
    assert.equal(fromIndex[2].broken, 'missing-file')
    assert.ok(fromIndex.slice(3).every((l) => l.asset && !l.broken))
    const anchorLink = g.links.find((l) => l.from === 'docs/research/a.md')
    assert.equal(anchorLink.broken, 'missing-anchor')
    assert.equal(g.stats.brokenLinks, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('consultas: resolver, buscar, fuentes, tags, camino y gods', () => {
  const root = toyRepo(FILES)
  try {
    const index = indexGraph(buildGraph(root))
    assert.deepEqual(resolveNode(index, 'a.md'), { type: 'file', id: 'docs/research/a.md', candidates: ['docs/research/a.md'] })
    assert.equal(resolveNode(index, 'finout.io').type, 'source')

    const hits = search(index, 're:^costos')
    assert.equal(hits.total, 2)
    assert.ok(hits.results.every((r) => r.type === 'section'))

    const src = sourceReport(index, 'example.org')
    assert.equal(src.results[0].citers.length, 3)

    assert.deepEqual(tagReport(index, 'Kubernetes').files, ['docs/research/b.md'])

    // b y la página no se enlazan, pero citan la misma fuente.
    const path = shortestPath(index, { type: 'file', id: 'docs/research/b.md' }, { type: 'file', id: 'artifact/page.html' })
    assert.deepEqual(path.map((p) => p.type), ['file', 'source', 'file'])

    assert.equal(godNodes(index, { mode: 'domains', top: 1 })[0].id, 'example.org')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store: una entrada por línea, escritura idempotente y atraso por hash', () => {
  const root = toyRepo(FILES)
  try {
    const g = buildGraph(root)
    const text = serializeGraph(g)
    assert.equal(JSON.parse(text).files.length, 4)
    const fileLines = text.split('\n').filter((l) => l.includes('"hash"'))
    assert.equal(fileLines.length, 4)

    assert.equal(writeGraph(g, { root }).written, true)
    assert.equal(writeGraph(buildGraph(root), { root }).written, false)
    assert.ok(sameGraph(loadGraph(root), g))
    assert.equal(checkStale(loadGraph(root), root).stale, false)

    // Mismo contenido con CRLF: no atrasa.
    writeFileSync(join(root, 'docs/research/b.md'), FILES['docs/research/b.md'].replace(/\n/g, '\r\n'))
    assert.equal(checkStale(loadGraph(root), root).stale, false)

    // Cambio real y archivo nuevo: atrasa y lo dice.
    writeFileSync(join(root, 'docs/research/b.md'), FILES['docs/research/b.md'] + '\nmás')
    writeFileSync(join(root, 'docs/research/c.md'), '# C')
    const stale = checkStale(loadGraph(root), root)
    assert.deepEqual(stale, { stale: true, added: ['docs/research/c.md'], changed: ['docs/research/b.md'], removed: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
