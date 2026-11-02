# Registro de iteraciones — append-only

Una entrada por iteración, al final del archivo. No se edita ni se reordena: una corrección es una
entrada nueva que referencia a la anterior.

Formato del encabezado: `## <AAAA-MM-DD> — <PREFIJO>-<n> / <título corto>`. Cuerpo:

- **Pedido:** quién pidió qué (o qué paso de qué spec se tomó).
- **Hecho:** qué cambió, con rutas; quién lo escribió (persona, o herramienta y modelo del agente).
- **Decisiones:** ids del ledger, si hubo.
- **Verificado:** qué se comprobó y cómo.
- **Sin verificar:** lo que no se pudo comprobar, dicho explícitamente.
- **Siguiente:** el próximo paso.

## {{today}} — {{fallback_prefix}}-1 / bootstrap del harness

- **Pedido:** crear el harness base del repo.
- **Hecho:** `AGENTS.md`, `_AI_LOOP_CONTROL/` (archivos vivos, append-only, `harness.json` y `specs/`),
  `scripts/harness.mjs`{{#graphify}}, graphify (`scripts/graphify/`, motor `{{graphify_engine}}`, hooks en `.githooks/`){{/graphify}}{{#adapters_any}} y los
  adaptadores por herramienta ({{adapter_files}}){{/adapters_any}}, generados desde la plantilla `harness-loop-control`.
- **Decisiones:** `{{fallback_prefix}}/dec/001`.
- **Verificado:** `node scripts/harness.mjs check` (lo corre el generador al terminar).
- **Sin verificar:** la misión, los productos, la tabla de verificación y las fuentes de verdad son
  lo que declaró la spec del harness; los revisa un owner.
- **Siguiente:** primera spec de trabajo (`node scripts/harness.mjs new-spec <PREFIJO> <slug>`).
