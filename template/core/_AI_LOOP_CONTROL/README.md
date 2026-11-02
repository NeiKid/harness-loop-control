---
type: Guide
title: "Bus operativo"
description: "Qué es cada archivo del bus, el formato de una decisión y el protocolo de trabajo."
tags: [harness, guia]
generated: { by: {{generator_actor}}, at: {{now}} }
---

# Bus operativo — {{project_title}}

Esta carpeta contiene el estado que cualquier agente (de cualquier proveedor) o persona debe leer
**antes de actuar** sobre este repositorio. Su propósito es que una sesión nueva pueda retomar el
trabajo sin perder decisiones ya tomadas. Las reglas están en [`../AGENTS.md`](../AGENTS.md).

## Archivos vivos y reescribibles

Una sección por producto; cada uno se actualiza en la suya. Se reescriben, no se apilan.

- [`LOOP_STATE.md`](LOOP_STATE.md): spec activa, fase, alcance y siguiente checkpoint.
- [`ACTION_QUEUE.md`](ACTION_QUEUE.md): máximo tres prioridades ordenadas, más lo que espera al owner.
- [`AGENT_BOARD.md`](AGENT_BOARD.md): quién trabaja en qué y los límites de edición vigentes.
- [`HEARTBEAT.json`](HEARTBEAT.json): el mismo estado en forma máquina-legible y la nota de relevo.
- [`specs/`](specs/): una carpeta por spec (`spec.md`, `plan.md`, `tasks.md`); el estado de cada una
  está en [`specs/README.md`](specs/README.md).
- [`harness.json`](harness.json): configuración del harness (productos, prefijos, owners, ramas). La
  leen `scripts/harness.mjs` y los hooks.

## Archivos append-only

- [`ITERATION_LOG.md`](ITERATION_LOG.md): historial de iteraciones. No se edita ni se reordena; se
  corrige con una entrada nueva.
- [`DECISION_LEDGER.jsonl`](DECISION_LEDGER.jsonl): una decisión por línea, en JSON.
- [`IDEAS_VAULT.md`](IDEAS_VAULT.md): ideas del owner sin priorizar; no es trabajo planificado.

Una entrada append-only incorrecta no se borra: se agrega una corrección que referencia su `id`. El
contenido previo debe seguir siendo prefijo exacto del contenido nuevo.

## Productos y prefijos

| Prefijo | Producto |
|---|---|
{{#products}}
| `{{prefix}}` | {{name}} |
{{/products}}

- **Decisiones:** `<PREFIJO>/dec/<NNN>`, una sola secuencia global (`node scripts/harness.mjs next-dec <PREFIJO>`).
- **Iteraciones:** `<PREFIJO>-<n>`, con un contador por producto.
- **Specs:** `specs/<PREFIJO>-S<NN>-<slug>/` (`node scripts/harness.mjs new-spec <PREFIJO> <slug>`).

## Formato de una decisión

Una línea JSON por decisión. Obligatorios: `id`, `type`, `decision`, `rationale`, `status`,
`recorded_at`. Opcionales: `spec`, `source`, `alternatives_rejected`, `supersedes`.

```json
{"schema_version":1,"id":"{{fallback_prefix}}/dec/002","spec":"{{fallback_prefix}}-S01-ejemplo","type":"tecnica","decision":"Qué se decidió, en una frase que se entienda sin contexto.","rationale":"Por qué, con el dato o el pedido que lo sostiene.","source":"Pedido del owner en la sesión del AAAA-MM-DD; spec.md §Requisitos","alternatives_rejected":["Otra opción: por qué no"],"status":"vigente","recorded_at":"AAAA-MM-DDTHH:MM:SSZ"}
```

- `type`: `alcance`, `producto`, `tecnica`, `gobernanza` u `operacion`.
- `status`: `vigente`, `reemplazada` o `revocada`. Una decisión no se edita para reemplazarla: se
  agrega la nueva con `"supersedes": "<id viejo>"`, y la vieja se lee como reemplazada.

## Protocolo de trabajo

Leer `LOOP_STATE.md` → leer `ACTION_QUEUE.md` → abrir la spec activa → tomar el primer paso pendiente
de su `tasks.md` → trabajar en un loop pequeño → checkpoint (verificar y marcar el paso) → registrar
decisión en `DECISION_LEDGER.jsonl` → registrar iteración en `ITERATION_LOG.md` → actualizar
`HEARTBEAT.json`, `LOOP_STATE.md`, `ACTION_QUEUE.md` y `AGENT_BOARD.md` → `node scripts/harness.mjs check`
→ relevo.

Si este bus contradice la fuente de verdad de un producto, prevalece esa fuente y se corrige el bus
en el mismo turno.
