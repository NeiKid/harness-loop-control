---
type: guide
title: "Graphify — el mapa del repo"
description: "Cómo se genera, se mantiene y se consulta el grafo versionado de {{project_title}}."
tags: [graphify, harness]
created_at: {{today}}
updated_at: {{today}}
---

# Graphify — el mapa del repo

{{#graphify_code}}
Grafo AST del código TypeScript/JavaScript del repositorio: **se genera, se commitea y se
consulta**.
{{/graphify_code}}
{{#graphify_docs}}
Grafo de los documentos del repositorio (archivos, secciones, enlaces internos y fuentes externas
citadas): **se genera, se commitea y se consulta**.
{{/graphify_docs}}
Sin LLM, sin red, sin servidor y sin índice local: `.graphify/graph.json` viaja con el repo, así que
un agente de cualquier proveedor, una persona y CI leen exactamente el mismo mapa.

Es el segundo pilar del método de trabajo, junto al loop de `_AI_LOOP_CONTROL/`: uno dice **en qué
estado está el trabajo**, el otro dice **cómo está hecho el repo**.

## El principio

> **Consultar el mapa antes de greppear la estructura.**

> **El grafo es una brújula, no la verdad: conexión no es causalidad. Si el mapa dice que algo no
> existe, verificar antes de creerle.**

## Comandos

```bash
npm run graph:build          # reconstruye .graphify/graph.json
npm run graph:check          # ¿el grafo está atrasado? exit 1 si sí
npm run graph:test           # tests del propio mapa
npm run graph -- <comando>   # consultas; sin argumentos muestra la ayuda completa
```

{{#graphify_code}}
| Consulta | Para qué |
|---|---|
| `symbol <query>` | Dónde se declara algo (nombre, `Clase.metodo`, `archivo#nombre`, `re:regex`) |
| `file <ruta>` | Qué declara un archivo, qué importa y quién lo importa |
| `neighbors <nodo>` | Qué toca directamente un archivo o un símbolo (`--depth N`, `--in`, `--out`) |
| `path <a> <b>` | Cómo se conectan dos puntos del código |
| `gods` | Dónde se propaga más lejos un cambio (`--symbols`, `--top N`) |
| `stats` | Tamaño y forma del grafo |

Requiere `typescript` instalado como dependencia de desarrollo (el parser es el del compilador). Las
referencias símbolo → símbolo son heurísticas, sin type checker.
{{/graphify_code}}
{{#graphify_docs}}
| Consulta | Para qué |
|---|---|
| `search <query>` | Títulos, descripciones, tags y secciones (`re:regex` para expresiones) |
| `doc <ruta>` | Frontmatter, secciones, enlaces y fuentes de un documento |
| `neighbors <nodo>` | Qué enlaza un documento y quién lo enlaza |
| `path <a> <b>` | Cómo se conectan dos documentos |
| `gods` | Los documentos más conectados |
| `broken` | Enlaces internos y anclas rotas |
| `stats` | Tamaño y forma del grafo |
{{/graphify_docs}}

> En Git Bash sobre Windows, un argumento que empieza con `/` se convierte en ruta antes de llegar al
> programa. Para las regex se usa `re:^patron` en vez de `/^patron/`.

## Cómo se mantiene al día

El atraso se mide por **hash de contenido** de los archivos que el grafo cubre, no por SHA de commit:
un commit que no los toca no atrasa el mapa, y un cambio sin commitear sí lo atrasa.

1. **Hook `post-commit`** (`.githooks/post-commit` → `scripts/graphify/refresh-on-commit.mjs`): en
   `{{trunk}}`, si el mapa quedó atrasado lo reconstruye y lo amenda dentro del propio commit. Es
   _fail-open_ (cualquier problema imprime un aviso y deja el commit intacto) y no amenda si quedaron
   cambios sin commitear.
2. **Hook `post-merge`**: lo mismo al integrar una rama en `{{trunk}}` con un merge local.
{{#ci_github}}
3. **CI** (`.github/workflows/harness.yml`): falla si en `{{trunk}}` o `{{stable}}` el mapa quedó atrasado.
{{/ci_github}}

Los hooks se activan con `git config core.hooksPath .githooks` (lo hace el script `prepare` de
`package.json` al instalar, y el generador del harness si el repo ya era git).

En una rama de trabajo el mapa está atrasado a propósito: si se necesita, `npm run graph:build` y no
se commitea el resultado.
