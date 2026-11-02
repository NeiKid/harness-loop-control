---
type: Agent Board
title: "Tablero de agentes"
description: "Quién trabaja en qué y con qué límites."
tags: [harness, agentes]
generated: { by: {{generator_actor}}, at: {{now}} }
---

# Tablero de agentes — vivo

> Quién trabaja en qué y con qué límites. Un agente se identifica por herramienta y modelo (el
> proveedor no cambia sus permisos); una persona, por su nombre. Los límites de una spec se suman a
> las reglas duras de `AGENTS.md`, nunca las relajan.

## Owners

{{#owners}}
- {{name}} (`{{handle}}`)
{{/owners}}

{{#products}}
## {{name}} (`{{prefix}}`)

- **Actualizado:** {{now}}
- **Trabajando ahora:** nadie.
- **Puede editar:** {{code}}, su spec activa y su sección de los archivos vivos.
- **Límites vigentes:** las reglas duras de `AGENTS.md`.

{{/products}}
