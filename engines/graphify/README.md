# Graphify en el harness

Graphify es una utilidad aparte: un mapa versionado del repo (`.graphify/graph.json`) que se
genera, se commitea y se consulta, sin modelo, sin red y sin servidor. Esta carpeta trae sus dos
motores para que el generador los instale en `scripts/graphify/` del repo destino:

| Motor | Para qué repos | Qué mapea | Dependencias |
|---|---|---|---|
| `code/` | TypeScript/JavaScript | Archivos, símbolos, imports y referencias (AST) | `typescript` |
| `docs/` | Documentación, investigación | Documentos, secciones, enlaces y fuentes citadas | ninguna |

Para actualizar Graphify se reemplaza la carpeta del motor por la versión nueva, sin editarla acá.

## Lo que el harness espera de un motor

Un motor nuevo (otro lenguaje, otro tipo de repo) se integra si cumple esto:

| Archivo | Contrato | Lo usa |
|---|---|---|
| `graphify.mjs` | `build` escribe `.graphify/graph.json`; `stale` sale con 1 si el mapa está atrasado; sin argumentos muestra la ayuda | `package.json` (`graph`, `graph:build`, `graph:check`), el generador y CI |
| `refresh-on-commit.mjs` | Si el mapa está atrasado lo reconstruye y lo amenda en el commit. Respeta `GRAPH_BRANCHES` (lista separada por comas; vacío = todas las ramas), no amenda con cambios sin commitear, y siempre sale con 0 (fail-open) | `.githooks/post-commit` y `post-merge` |
| `graphify.test.mjs` | Tests con `node --test` sobre un repo de juguete propio, no sobre el repo destino | `graph:test` y CI |

El atraso se mide por hash de contenido de los archivos que el motor cubre, no por SHA de commit: así
el amend del propio hook no deja el mapa marcado como atrasado.

Para sumar el motor, se agrega su nombre a `ENGINES` en `bin/harness-init.mjs` y su variante en
`template/graphify/docs/graphify.md`.
