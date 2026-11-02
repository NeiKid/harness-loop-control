# AGENTS.md — harness-loop-control

Este repo es una **plantilla**: genera el harness de otros repos. Las reglas de abajo son para
mantener la plantilla; las del harness generado están en `template/core/AGENTS.md`.

## Qué es cada cosa

| Ruta | Qué es |
|---|---|
| `harness.spec.example.json` | La spec de ejemplo: la entrada del generador |
| `bin/harness-init.mjs` | El generador (validación de la spec, capas, fusión con un repo existente) |
| `lib/render.mjs` | Render mínimo: `{{var}}`, `{{#seccion}}`, `{{^seccion}}` |
| `template/core/` | Lo que siempre se genera: `AGENTS.md`, `_AI_LOOP_CONTROL/`, `scripts/harness.mjs` |
| `template/graphify/`, `template/ci-github/` | Capas opcionales según la spec |
| `template/adapters/<herramienta>/` | Adaptadores por herramienta: sólo apuntan a `AGENTS.md` |
| `engines/graphify/{code,docs}/` | Motores de graphify, copiados tal cual a `scripts/graphify/` |
| `BOOTSTRAP.md` | Protocolo para que un agente instale el harness en un repo |
| `test/` | Tests del generador |

## Reglas

- **Agnóstico del proveedor de modelo.** Ninguna regla del harness generado depende de un modelo,
  un proveedor o una función exclusiva de una herramienta. Lo propio de una herramienta va en
  `template/adapters/<herramienta>/` y no tiene reglas: apunta a `AGENTS.md`. Lo opcional (un MCP, un
  hook) se escribe como opcional y con su alternativa.
- **Una regla en un solo lugar.** Si una regla aparece en un adaptador, está mal: va al
  `AGENTS.md` de la plantilla.
- **Nada de un repo en particular.** La plantilla no menciona productos, clientes, hosts ni
  decisiones de ningún repo en particular; lo específico entra por la spec.
- Los archivos `.mjs`, `.cjs` y `.js` se copian sin renderizar; el resto pasa por `lib/render.mjs`, y
  un `{{var}}` sin valor es un error. Los dotfiles de la plantilla se escriben `dot-<nombre>` para que
  no se activen en este repo.
- Los marcadores `<<ID>>`, `<<PREFIJO>>`, `<<TITULO>>`, `<<FECHA>>` de `specs/_TEMPLATE/` no son del
  generador: los rellena `scripts/harness.mjs new-spec` en el repo generado.
- Graphify es una utilidad aparte: `engines/graphify/` es su integración, no su código fuente. Se
  actualiza reemplazando la carpeta del motor por la versión nueva de Graphify, y una mejora al motor
  se hace en Graphify, no acá. Lo que el harness necesita de un motor está en
  `engines/graphify/README.md`.

## Verificación

- `npm test`: render, validación, generación con la spec de ejemplo y con una mínima, `harness check`
  del resultado, `new-spec`/`next-dec`, fusión con un repo existente y los tests del motor `docs`.
- El motor `code` necesita `typescript`: se prueba generando en un directorio con `typescript`
  instalado y corriendo `node --test scripts/graphify/graphify.test.mjs` ahí.
- Un cambio en un adaptador se comprueba en la herramienta real; si no se pudo, se dice.
