---
type: Spec Index
title: "Índice de specs"
description: "Estado de cada spec del repo y cómo crear una nueva."
tags: [harness, specs]
generated: { by: {{generator_actor}}, at: {{now}} }
---

# Índice de specs

Una carpeta por spec, `<PREFIJO>-S<NN>-<slug>/`, con tres archivos: `spec.md` (qué y por qué),
`plan.md` (cómo) y `tasks.md` (pasos y verificación). El ciclo está en `AGENTS.md`, «Ciclo
spec-driven». La plantilla de cada archivo está en [`_TEMPLATE/`](_TEMPLATE/).

- **Crear:** `node scripts/harness.mjs new-spec <PREFIJO> <slug> ["Título"]`. Copia la plantilla y
  agrega la fila a esta tabla.
- **Estado:** manda esta tabla, no el encabezado de la spec. Se actualiza al aprobar, activar, cerrar
  o descartar una spec, junto con los archivos vivos.
- Una spec no se mueve ni se borra al cerrarse.

Estados: **Borrador**, **Aprobada**, **En curso**, **Verificada**, **Cerrada**, **Descartada**.

| Spec | Producto | Estado | Cierre |
|---|---|---|---|
<!-- harness:specs-index (new-spec agrega las filas encima de esta línea) -->
