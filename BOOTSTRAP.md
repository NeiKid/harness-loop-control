# Bootstrap de un repo con un agente

Protocolo para que **cualquier agente, de cualquier proveedor**, instale el harness en un repo
nuevo o existente. Se le pasa este archivo con la ruta del repo destino: «seguí
`harness-loop-control/BOOTSTRAP.md` para `<ruta del repo>`».

El harness también se hace spec-driven: primero se escribe su spec (`harness.spec.json`), el owner la
aprueba, y recién entonces se genera.

## 1. Relevar el repo destino

Sin escribir nada todavía:

- `README.md`, manifiestos (`package.json`, `pyproject.toml`, `go.mod`, …), estructura de carpetas,
  workflows de CI existentes.
- Si ya tiene `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `_AI_LOOP_CONTROL/` u otro harness: leerlos.
  El generador no los pisa; lo que tengan de valor se migra a mano al canon nuevo (paso 5).
- Qué comandos verifican cada área (tests, build, lint) y si el código es TypeScript/JavaScript.

## 2. Escribir la spec del harness

Copiar `harness.spec.example.json` a `<repo destino>/harness.spec.json` y completarla con lo relevado.
Los campos están explicados en el `README.md` de la plantilla. Criterios:

- **Productos y prefijos:** uno por línea de trabajo con decisiones propias. Un repo chico tiene uno
  solo; no inventar productos para llenar la tabla. El primero es el de plataforma y el de «ante la
  duda».
- **`graphify.engine`:** `code` si el repo es TypeScript/JavaScript, `docs` si es de documentos o
  investigación, `none` si no aplica ninguno (otro lenguaje sin motor todavía).
- **`verification`:** comandos que existen y se corrieron, no aspiracionales. Lo que no se sabe queda
  fuera y el generador deja un `TODO(owner)`.
- **`adapters`:** las herramientas que el equipo usa de verdad.
- **Lo que no se puede derivar del repo** (misión, owners, ramas, reglas propias): preguntárselo al
  owner. No inventarlo.

Mostrarle la spec al owner y esperar su aprobación antes de seguir.

## 3. Ver qué va a pasar

```bash
node <plantilla>/bin/harness-init.mjs --spec <repo>/harness.spec.json --target <repo> --dry-run
```

Revisar con el owner la lista «Crea», «Completa» y «Ya existían». Un archivo que ya existe no se
pisa; `--force` sólo si el owner lo pide para ese caso.

## 4. Generar

```bash
node <plantilla>/bin/harness-init.mjs --spec <repo>/harness.spec.json --target <repo>
```

El generador copia la spec a `_AI_LOOP_CONTROL/harness.json` (desde ahí manda), activa los hooks si
el destino es git (versión y mapa), registra los MCPs instalados en la máquina en cada herramienta,
intenta construir el mapa y corre `node scripts/harness.mjs check`. Después:

- Borrar `<repo>/harness.spec.json`: su contenido ya vive en `harness.json`.
- Motor `code`: `npm install` (agrega `typescript`) y `npm run graph:build`.
- `npm run agent:doctor`: si falta un MCP, decirle al owner cómo instalarlo.
- Con versionado activo, el primer commit queda en `0.1.0`; desde el segundo, el encabezado decide.

## 5. Completar lo que la plantilla no sabe

- Cada `TODO(owner)` que listó el generador, con el owner.
- Si había instrucciones previas (otro `AGENTS.md`, `CLAUDE.md`, reglas de Cursor): migrar a
  `AGENTS.md` las reglas que sigan vigentes y reemplazar esos archivos por el adaptador que apunta al
  canon. Ninguna regla queda en dos lugares.
- Si había un ledger u otro registro de decisiones: migrar las vigentes al `DECISION_LEDGER.jsonl`
  conservando el id viejo en `legacy_id`.

## 6. Cerrar

- `node scripts/harness.mjs check` en verde.
- Una entrada en `ITERATION_LOG.md` si hubo cambios después del bootstrap (la del bootstrap ya está).
- El commit lo hace el owner, a su nombre y sin atribución de la herramienta (si la spec no dice lo
  contrario).
- Decirle al owner qué quedó sin verificar (por ejemplo, el workflow de CI hasta su primer push).
