/**
 * Construcción del grafo AST.
 *
 * Parsea cada archivo de código con el parser de TypeScript (sin type checker:
 * no necesita un Program ni el build de los packages, y corre en pocos segundos
 * sobre el repo entero). Extrae archivos, símbolos, imports y referencias.
 *
 * Las referencias símbolo → símbolo son HEURÍSTICAS: se resuelven por nombre
 * contra lo importado o declarado en el mismo archivo, sin resolución de tipos
 * ni de scopes. Sirven como brújula, no como verdad.
 */
import ts from 'typescript'
import { listCodeFiles, fileStats, currentCommit, repoRoot } from './repo.mjs'
import { loadAliases, resolveSpecifier } from './resolve.mjs'

export const SCHEMA_VERSION = 1
export const GENERATOR = 'graphify/1.0.0'

function scriptKindFor(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.ts')) return ts.ScriptKind.TS
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

function isExported(node) {
  if (!ts.canHaveModifiers(node)) {
    return false
  }
  const modifiers = ts.getModifiers(node) ?? []
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

function containsJsx(node) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (
      ts.isJsxElement(n) ||
      ts.isJsxSelfClosingElement(n) ||
      ts.isJsxFragment(n)
    ) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** Afina el tipo de una función: componente React, hook o función común. */
function functionKind(name, node) {
  if (/^use[A-Z]/.test(name)) {
    return 'hook'
  }
  if (/^[A-Z]/.test(name) && containsJsx(node)) {
    return 'component'
  }
  return 'function'
}

/**
 * Identificadores usados dentro de un nodo, sin los nombres que son claves
 * (`obj.prop`, `<Tag className=…>`, `{ clave: valor }`): esos no son
 * referencias a símbolos del repo.
 */
function collectIdentifiers(node, out) {
  if (!node) {
    return
  }
  if (ts.isPropertyAccessExpression(node)) {
    collectIdentifiers(node.expression, out)
    return
  }
  if (ts.isQualifiedName(node)) {
    collectIdentifiers(node.left, out)
    return
  }
  if (ts.isJsxAttribute(node)) {
    collectIdentifiers(node.initializer, out)
    return
  }
  if (ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)) {
    collectIdentifiers(node.initializer, out)
    return
  }
  if (ts.isBindingElement(node)) {
    collectIdentifiers(node.initializer, out)
    return
  }
  if (ts.isIdentifier(node)) {
    out.add(node.text)
    return
  }
  ts.forEachChild(node, (child) => collectIdentifiers(child, out))
}

/** Extrae símbolos, imports y usos de un archivo ya parseado. */
function analyzeSource(relPath, source) {
  const symbols = []
  const imports = []
  const usesBySymbol = new Map()
  /** nombre local → { specifier, original } */
  const importedNames = new Map()

  const lineAt = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1

  const addSymbol = (node, name, kind, { exported, parent = null }) => {
    const line = lineAt(node.getStart(source))
    const endLine = lineAt(node.end)
    const id = parent ? `${relPath}#${parent}.${name}` : `${relPath}#${name}`
    symbols.push({
      id,
      name,
      kind,
      file: relPath,
      line,
      lines: Math.max(1, endLine - line + 1),
      exported: Boolean(exported),
      ...(parent ? { parent: `${relPath}#${parent}` } : {}),
    })
    const uses = new Set()
    collectIdentifiers(node, uses)
    uses.delete(name)
    usesBySymbol.set(id, uses)
    return id
  }

  const addClassMembers = (node, className) => {
    for (const member of node.members ?? []) {
      if (ts.isConstructorDeclaration(member)) {
        addSymbol(member, 'constructor', 'method', {
          exported: false,
          parent: className,
        })
        continue
      }
      const name =
        member.name && ts.isIdentifier(member.name) ? member.name.text : null
      if (!name) {
        continue
      }
      if (ts.isMethodDeclaration(member)) {
        addSymbol(member, name, 'method', {
          exported: false,
          parent: className,
        })
      } else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
        addSymbol(member, name, 'accessor', {
          exported: false,
          parent: className,
        })
      } else if (
        ts.isPropertyDeclaration(member) &&
        member.initializer &&
        (ts.isArrowFunction(member.initializer) ||
          ts.isFunctionExpression(member.initializer))
      ) {
        addSymbol(member, name, 'method', {
          exported: false,
          parent: className,
        })
      }
    }
  }

  const visitStatement = (node) => {
    const exported = isExported(node)

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names = []
      const clause = node.importClause
      if (clause?.name) {
        names.push({ local: clause.name.text, original: 'default' })
      }
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push({ local: clause.namedBindings.name.text, original: '*' })
        } else {
          for (const element of clause.namedBindings.elements) {
            names.push({
              local: element.name.text,
              original: (element.propertyName ?? element.name).text,
            })
          }
        }
      }
      imports.push({
        specifier: node.moduleSpecifier.text,
        names,
        kind: 'import',
      })
      return
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        names: [],
        kind: 'reexport',
      })
      return
    }

    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? (exported ? 'default' : null)
      if (name) {
        addSymbol(node, name, functionKind(name, node), { exported })
      }
      return
    }

    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? (exported ? 'default' : null)
      if (name) {
        addSymbol(node, name, 'class', { exported })
        addClassMembers(node, name)
      }
      return
    }

    if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node, node.name.text, 'interface', { exported })
      return
    }

    if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node, node.name.text, 'type', { exported })
      return
    }

    if (ts.isEnumDeclaration(node)) {
      addSymbol(node, node.name.text, 'enum', { exported })
      return
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue
        }
        const name = declaration.name.text
        const init = declaration.initializer
        const kind =
          init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
            ? functionKind(name, declaration)
            : 'const'
        addSymbol(declaration, name, kind, { exported })
      }
      return
    }

    if (
      ts.isModuleDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      addSymbol(node, node.name.text, 'namespace', { exported })
      if (node.body && ts.isModuleBlock(node.body)) {
        node.body.statements.forEach(visitStatement)
      }
    }
  }

  source.statements.forEach(visitStatement)

  // Imports dinámicos y `require()` en cualquier posición del archivo.
  const visitDynamic = (node) => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const arg = node.arguments[0]
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteral(arg)) {
        imports.push({
          specifier: arg.text,
          names: [],
          kind: isDynamicImport ? 'dynamic' : 'require',
        })
      }
    }
    ts.forEachChild(node, visitDynamic)
  }
  visitDynamic(source)

  for (const entry of imports) {
    for (const name of entry.names) {
      importedNames.set(name.local, {
        specifier: entry.specifier,
        original: name.original,
      })
    }
  }

  return { symbols, imports, usesBySymbol, importedNames }
}

/**
 * Construye el grafo completo del repo.
 * `onProgress` recibe (procesados, total) para el indicador de avance.
 */
export function buildGraph({ root = repoRoot, onProgress } = {}) {
  const files = listCodeFiles(root)
  const fileSet = new Set(files)
  const aliases = loadAliases(root)

  const fileNodes = []
  const analyses = new Map()
  const externalPackages = new Set()

  let processed = 0
  for (const relPath of files) {
    const stats = fileStats(relPath, root)
    const source = ts.createSourceFile(
      relPath,
      stats.text,
      ts.ScriptTarget.Latest,
      false,
      scriptKindFor(relPath)
    )
    const analysis = analyzeSource(relPath, source)
    analyses.set(relPath, analysis)
    fileNodes.push({
      path: relPath,
      hash: stats.hash,
      lines: stats.lines,
      symbols: analysis.symbols.length,
    })
    processed += 1
    onProgress?.(processed, files.length)
  }

  const symbols = []
  const symbolIds = new Set()
  for (const analysis of analyses.values()) {
    for (const symbol of analysis.symbols) {
      symbols.push(symbol)
      symbolIds.add(symbol.id)
    }
  }

  const imports = []
  /** archivo → (especificador → archivo interno resuelto) */
  const importTargets = new Map()
  for (const [relPath, analysis] of analyses) {
    const seen = new Map()
    const targets = new Map()
    for (const entry of analysis.imports) {
      const resolved = resolveSpecifier(
        entry.specifier,
        relPath,
        fileSet,
        aliases
      )
      if (resolved.kind === 'external') {
        externalPackages.add(resolved.package)
      }
      if (resolved.kind === 'internal') {
        targets.set(entry.specifier, resolved.file)
      }
      const to =
        resolved.kind === 'internal'
          ? resolved.file
          : resolved.kind === 'external'
            ? resolved.package
            : entry.specifier
      const key = `${to}|${resolved.kind}`
      const names = entry.names.map((n) => n.local)
      const existing = seen.get(key)
      if (existing) {
        for (const name of names) {
          if (!existing.names.includes(name)) {
            existing.names.push(name)
          }
        }
        continue
      }
      const edge = { from: relPath, to, kind: resolved.kind, names }
      seen.set(key, edge)
      imports.push(edge)
    }
    importTargets.set(relPath, targets)
  }

  const refs = []
  const refSeen = new Set()
  for (const [relPath, analysis] of analyses) {
    const localNames = new Map()
    for (const symbol of analysis.symbols) {
      if (!symbol.parent) {
        localNames.set(symbol.name, symbol.id)
      }
    }
    const targets = importTargets.get(relPath) ?? new Map()

    for (const [symbolId, uses] of analysis.usesBySymbol) {
      for (const name of uses) {
        let targetId = null
        const imported = analysis.importedNames.get(name)
        if (imported) {
          const targetFile = targets.get(imported.specifier)
          if (targetFile) {
            const originalName =
              imported.original === 'default' || imported.original === '*'
                ? name
                : imported.original
            const candidate = `${targetFile}#${originalName}`
            if (symbolIds.has(candidate)) {
              targetId = candidate
            }
          }
        } else if (localNames.has(name)) {
          targetId = localNames.get(name)
        }
        if (!targetId || targetId === symbolId) {
          continue
        }
        const key = `${symbolId}|${targetId}`
        if (refSeen.has(key)) {
          continue
        }
        refSeen.add(key)
        refs.push({ from: symbolId, to: targetId })
      }
    }
  }

  symbols.sort((a, b) => a.id.localeCompare(b.id))
  imports.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`))
  refs.sort((a, b) => `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`))

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: GENERATOR,
    builtAt: new Date().toISOString(),
    commit: currentCommit(root),
    stats: {
      files: fileNodes.length,
      symbols: symbols.length,
      imports: imports.length,
      refs: refs.length,
      externalPackages: externalPackages.size,
    },
    files: fileNodes,
    symbols,
    imports,
    refs,
  }
}
