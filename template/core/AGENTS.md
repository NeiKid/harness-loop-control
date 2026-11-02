# AGENTS.md — Canon operativo de {{project_title}}

No inventar decisiones, dejar rastro de las que se toman, y no confundir una maqueta con el
producto.

Este archivo es el canon para **cualquier agente, de cualquier proveedor de modelo**, y para las
personas. Los archivos de cada herramienta ({{adapter_files}}) sólo apuntan acá y no tienen reglas
propias: si una herramienta necesita algo distinto, se escribe acá. Ninguna regla de este repo
depende de un modelo, de un proveedor o de una función exclusiva de una herramienta; lo que es
opcional (un MCP, un hook) se dice como opcional y tiene su alternativa.

## Misión

{{mission}}

## Productos y prefijos

Todo lo que se registra en el harness lleva el prefijo del producto al que pertenece. Es
obligatorio: una decisión, una iteración o una spec sin prefijo no se acepta, y si algo toca dos
productos lleva el del que decide (ante la duda, `{{fallback_prefix}}`).

| Prefijo | Producto | Código | Fuente de verdad |
|---|---|---|---|
{{#products}}
| `{{prefix}}` | {{name}} | {{code}} | {{source_of_truth}} |
{{/products}}

- **Decisiones** (`DECISION_LEDGER.jsonl`): `<PREFIJO>/dec/<NNN>`, por ejemplo `{{fallback_prefix}}/dec/014`.
  El número sale de **una sola secuencia global**, la siguiente al máximo del ledger sea cual sea el
  prefijo, así el número solo nunca se repite. `node scripts/harness.mjs next-dec <PREFIJO>` lo calcula.
- **Iteraciones** (`ITERATION_LOG.md`): `<PREFIJO>-<n>` en el encabezado, con un contador por producto.
- **Specs** (`_AI_LOOP_CONTROL/specs/`): una carpeta `<PREFIJO>-S<NN>-<slug>` por spec, con contador
  por producto. `node scripts/harness.mjs new-spec <PREFIJO> <slug>` la crea y la agrega al índice.
- **Archivos vivos** (`LOOP_STATE.md`, `ACTION_QUEUE.md`, `AGENT_BOARD.md`, `HEARTBEAT.json`): una
  sección por producto; cada uno actualiza la suya sin pisar las otras.
- La lista de productos vive en `_AI_LOOP_CONTROL/harness.json` y los scripts la leen de ahí. Agregar
  un producto es editar ese archivo y esta tabla en la misma iteración.

## Orden de lectura

1. Este archivo.
2. `_AI_LOOP_CONTROL/LOOP_STATE.md` — qué se está construyendo ahora.
3. `_AI_LOOP_CONTROL/ACTION_QUEUE.md` — las próximas tres prioridades.
4. `_AI_LOOP_CONTROL/specs/README.md` y, de ahí, la spec activa: `spec.md`, `plan.md`, `tasks.md`.
5. La fuente de verdad del producto que se va a tocar (tabla de arriba), sólo en lo que toque.

No hace falta leer todo para cualquier tarea: basta con el estado vivo y el área que se modifica.
{{#graphify}}
Para orientarse **en el código** (no en el estado del trabajo) está el mapa: ver «Mapa del código».
{{/graphify}}

## Ciclo spec-driven

El trabajo de cierto tamaño se escribe antes de construirse. La spec dice **qué y por qué**, el plan
dice **cómo**, los pasos dicen **en qué orden y cómo se comprueba cada uno**. El código implementa la
spec; si la realidad obliga a cambiarla, se cambia la spec primero y se deja rastro.

**Cuándo hace falta una spec:** cuando el cambio va a tomar varias iteraciones, toca un contrato
(API, modelo de datos, configuración visible, comportamiento que alguien usa) o depende de una
decisión del owner. Un cambio chico de una sola iteración va directo, con su verificación.

| Fase | Archivo | Sale cuando | Quién cierra |
|---|---|---|---|
| 0. Idea | `IDEAS_VAULT.md` | El owner la prioriza | Owner |
| 1. Spec | `specs/<id>/spec.md` | Requisitos con criterio de aceptación verificable, fuera de alcance explícito, preguntas abiertas respondidas | Owner aprueba (queda en el encabezado de la spec) |
| 2. Plan | `specs/<id>/plan.md` | Qué archivos toca, decisiones en el ledger, cómo se verifica cada requisito | Agente; el owner revisa si hay decisión suya |
| 3. Pasos | `specs/<id>/tasks.md` | Pasos chicos, cada uno con su verificación y el requisito que cubre | Agente |
| 4. Construcción | código + `ITERATION_LOG.md` | Cada paso cerrado deja el repo verde y se marca con su commit | Agente |
| 5. Verificación | `tasks.md`, «Verificación final» | Cada requisito con evidencia, o dicho explícitamente qué quedó sin verificar | Agente; el owner da por cerrada la spec |

Estados de una spec: **Borrador**, **Aprobada**, **En curso**, **Verificada**, **Cerrada**,
**Descartada**. El estado manda en `specs/README.md`, no en el encabezado del archivo.

- No se escribe código de una spec en **Borrador**: primero se responden sus preguntas abiertas.
- Un requisito sin criterio de aceptación no es un requisito; es una intención. Se reescribe.
- Si durante la construcción aparece algo fuera del alcance de la spec, va a `IDEAS_VAULT.md` o a una
  spec nueva, no se suma en silencio.
- Una spec **Cerrada** no se reescribe: un cambio posterior es una spec nueva que la referencia.

## Cómo trabajar (el loop)

1. Leer el estado vivo (`LOOP_STATE.md`, `ACTION_QUEUE.md`) y la spec activa antes de escribir.
2. Verificar contra la fuente de verdad del producto que se toca.
3. Tomar el primer paso pendiente de `tasks.md`. Trabajar en pasos chicos y verificables antes que en
   un cambio enorme de una sola vez.
4. Checkpoint: verificar el paso (ver «Verificación por tipo de cambio»), marcarlo en `tasks.md`.
5. Registrar las decisiones relevantes en `DECISION_LEDGER.jsonl` y la iteración en
   `ITERATION_LOG.md` (los dos append-only). Para cambios chicos de una sola iteración no hace falta.
6. Actualizar `LOOP_STATE.md`, `ACTION_QUEUE.md`, `AGENT_BOARD.md` y `HEARTBEAT.json` cuando cambia
   qué se está haciendo, no en cada micro-paso. Se **reescriben**, no se apilan: el historial ya está
   en el log.
7. Relevo: la nota de `HEARTBEAT.json` deja lo que la próxima sesión necesita para seguir sin
   preguntar.

`node scripts/harness.mjs check` comprueba que el ledger, el heartbeat y el índice de specs sean
consistentes entre sí{{#ci_github}} (también corre en CI){{/ci_github}}.

## Cómo clasificar lo que se dice

Cuando se escribe en el harness, en una spec o en el backlog, se distingue con claridad:

- lo que ya está decidido y por qué (con la entrada del ledger o el documento donde se cerró);
- lo que es una recomendación, todavía sin decidir;
- lo que depende de un dato que no existe hoy.

No hace falta una etiqueta formal en cada frase; sí es obligatorio no mezclar una cosa con la otra
sin dejarlo claro en la prosa.

## Actores

- **Owners:** {{owners_list}}. Deciden alcance, prioridades y qué se considera terminado, y son las
  únicas autoridades humanas de este repositorio. Donde este canon pide la confirmación «del owner»,
  alcanza con la de uno.
- **Agentes:** cualquier agente de cualquier proveedor que siga este canon. Un mismo agente puede
  escribir y verificar su propio trabajo; cuando la tarea lo amerita se invoca otro (revisión,
  diseño) con un entregable acotado a lo que se le pidió.
- Que el agente sea de un proveedor u otro no cambia ninguna regla. Si en el ledger o en el log
  importa quién hizo algo, se dice qué herramienta y modelo, sin que eso dé ni quite autoridad.

## Flujo de ramas

Trunk-based sobre `{{trunk}}` con ramas cortas.

| Rama | Para qué | Cómo entra |
|---|---|---|
| `{{trunk}}` | El tronco: siempre integrado y verde | Merge de una rama de trabajo, con la verificación en verde |
{{#products}}
| `{{prefix_lower}}/<tarea>` | Una tarea de {{name}}; vive de uno a tres días y se actualiza contra `{{trunk}}` todos los días | PR o merge local a `{{trunk}}` |
{{/products}}
| `{{stable}}` | Lo estable: se promueve `{{trunk}}` cuando cierra un hito | Con confirmación explícita de un owner |

- Lo que no está listo se esconde detrás de una bandera, no en una rama larga.
- `ITERATION_LOG.md` y `DECISION_LEDGER.jsonl` se integran por union (`.gitattributes`): dos ramas que
  agregan entradas a la vez no chocan en git. Dos decisiones con el mismo número sí las frena
  `node scripts/harness.mjs check`, y quien integra renumera la suya antes de empujar.
{{#graphify}}

## Mapa del código (graphify)

El repo mantiene un grafo versionado en `.graphify/graph.json`, generado por `scripts/graphify/`
{{#graphify_code}}(grafo AST de TypeScript/JavaScript){{/graphify_code}}{{#graphify_docs}}(grafo de documentos: archivos, secciones, enlaces y fuentes){{/graphify_docs}}. Se consulta con
`npm run graph -- <comando>`. El manual está en `docs/graphify.md`.

- **Consultar el mapa antes de greppear la estructura.** Para «dónde se declara esto», «quién usa
  esto», «qué importa este archivo» o «cuán lejos llega este cambio», el mapa responde en una
  llamada lo que a mano cuesta varias búsquedas. Para buscar texto sigue siendo grep.
- **El grafo es una brújula, no la verdad: conexión no es causalidad.**
- **Si el mapa dice que algo no existe, verificar antes de creerle.** Ausencia en el mapa no es
  evidencia de ausencia en el repo; se confirma con grep antes de afirmarlo.
- Es una vista derivada, no una fuente de verdad: si el mapa y el repo se contradicen, manda el repo
  y se regenera el mapa.
- Se regenera solo en el hook `post-commit` **en `{{trunk}}`**{{#ci_github}}, y CI falla si en `{{trunk}}` o `{{stable}}`
  quedó atrasado{{/ci_github}}. En una rama de trabajo está atrasado a propósito: si una consulta lo
  avisa, se corre `npm run graph:build` antes de decidir con él, sin commitear el resultado.
- El grafo no necesita ningún modelo ni servicio: lo leen igual un agente de cualquier proveedor,
  una persona y CI.
{{/graphify}}
{{#codebase_memory}}

## Codebase memory

**Cuando el MCP `codebase-memory-mcp` esté disponible en la sesión**, es una fuente adicional para
las mismas preguntas de arquitectura y relaciones de código, sobre un índice propio y local en vez
del grafo versionado. No es configuración del repo: depende de lo que tenga instalado el agente que
esté corriendo, y cualquier cliente MCP lo puede usar.

- Si el repo todavía no está indexado, se indexa al empezar (`index_repository`).
- Se consulta antes o junto con {{#graphify}}el mapa{{/graphify}}{{^graphify}}grep{{/graphify}}; cuando no está, se sigue sin él como siempre.
- Las decisiones **no** se guardan en sus ADR (`manage_adr`): viven en `DECISION_LEDGER.jsonl`, que es
  la única fuente. Dos registros de decisiones terminan contradiciéndose.
{{#graphify}}
- `.graphify/graph.json` sigue siendo el mapa versionado del repo; el MCP es un complemento personal,
  no un reemplazo.
{{/graphify}}

La memoria propia de un agente (la de su herramienta, la de su proveedor) tampoco es fuente de
verdad: lo que otra sesión, otra persona u otro agente necesita saber se escribe en el harness.
{{/codebase_memory}}
{{#ponytail}}

## Modo de trabajo: Ponytail

El repo trabaja en modo Ponytail, nivel `{{ponytail_level}}`: el cambio más chico que resuelve la tarea
completa, y una respuesta que una persona ocupada entiende en una lectura.

**Cuando el MCP `ponytail` esté disponible en la sesión**, se invoca `ponytail_instructions` con
`mode: "{{ponytail_level}}"` al empezar y se sigue su ruleset el resto de la sesión. Cuando no está, rigen
estas reglas, que son su resumen:

1. Antes de escribir: leer la tarea y el código que toca, y listar todo lo que el cambio tiene que
   alcanzar (llamadores, tests, fixtures, configuración, exports). Eso es el alcance; lo extra no.
2. Tomar la primera opción que resuelve del todo: ¿hace falta que exista? → ¿ya está en el repo? →
   ¿lo da la librería estándar o la plataforma? → ¿una dependencia ya instalada? → una línea que se
   entienda de un vistazo → el mínimo código que funciona.
3. Nada de abstracciones, opciones, configuración ni código «para después» que nadie pidió. Borrar
   gana a agregar. Se respeta la estructura que el repo ya tiene.
4. Ser perezoso con la solución, nunca con el cambio: se terminan los llamadores, tests y fixtures que
   el cambio rompe. Un bug se arregla en la causa, una vez, en el código compartido.
5. La lógica nueva no trivial deja un test chico o un self-check. Un atajo con un límite conocido
   lleva un comentario `shortcut: <el límite>, <cuándo mejorarlo>`.
6. Nunca se recorta: validación en los bordes de confianza, manejo de errores que evita perder datos,
   seguridad, accesibilidad, ni nada que el owner haya pedido.
7. La respuesta termina con una o dos líneas: qué no se hizo o no se verificó, y el riesgo que el
   owner tiene que saber.
{{/ponytail}}

## Verificación por tipo de cambio

| Qué se cambia | Cómo se verifica |
|---|---|
{{#verification}}
| {{change}} | {{command}} |
{{/verification}}
{{^verification}}
| TODO(owner): cada área del repo | TODO(owner): el comando que la verifica |
{{/verification}}
| `_AI_LOOP_CONTROL/**` | `node scripts/harness.mjs check`, y que los archivos vivos digan lo mismo entre sí |
{{#graphify}}
| `scripts/graphify/**` | `npm run graph:test` y `npm run graph:build` |
{{/graphify}}

Si algo no se pudo comprobar (una UI que no se vio, un comando que no se pudo correr), se dice
explícitamente en vez de asumir que está bien.

## Reglas duras

- No inventar reglas de negocio, credenciales, hosts ni datos reales que no haya provisto un owner.
  Un valor de ejemplo se marca explícitamente como ficticio.
- No hacer push a `{{trunk}}` ni promover a `{{stable}}` sin mostrar antes el cambio y recibir
  confirmación explícita de un owner. Mismo criterio para credenciales e infraestructura real.
{{#no_commit_attribution}}
- **Los commits van a nombre de un owner y de nadie más.** El mensaje no lleva atribución de la
  herramienta ni del modelo (ni `Co-Authored-By` de un agente, ni firmas del tipo «Generated with…»),
  ni en el commit ni en la descripción de un PR, sea cual sea el proveedor. Que un agente escribió el
  cambio se registra en `ITERATION_LOG.md`.
{{/no_commit_attribution}}
- No convertir un prototipo, un plan o una spec en una afirmación de que algo ya está construido.
- Configuración antes que hardcode: lo específico de un cliente o un entorno se modela como dato.
- Preferir cambios pequeños y legibles a cambios grandes y opacos.
- Una entrada append-only (`ITERATION_LOG.md`, `DECISION_LEDGER.jsonl`) no se reescribe: una corrección
  se agrega como entrada nueva que referencia a la anterior (`supersedes` en el ledger).
- No declarar una spec cerrada sin decir qué falta verificar.
{{#extra_rules}}
- {{rule}}
{{/extra_rules}}

## Fuente de verdad

{{#products}}
- **{{name}} (`{{prefix}}`):** {{source_of_truth}}, más su spec activa.
{{/products}}
- **Estado operativo:** `_AI_LOOP_CONTROL/LOOP_STATE.md`, `ACTION_QUEUE.md` y la spec activa.
- **Decisiones de cómo se construye:** `_AI_LOOP_CONTROL/DECISION_LEDGER.jsonl`.
- **Configuración del harness:** `_AI_LOOP_CONTROL/harness.json`.

Si dos fuentes se contradicen, no elegir en silencio: decirlo explícitamente y, si hace falta,
preguntar a un owner.

## Mantenimiento de este canon

- Se actualiza en la misma iteración en que cambia una regla. Si una decisión nueva contradice lo que
  dice este archivo, se reescribe el canon (el ledger guarda la historia; acá queda sólo lo vigente).
- Corto a propósito: lo que es de un producto va a su fuente de verdad, lo que es de una tarea va a
  su spec.
- Generado desde la plantilla `harness-loop-control` el {{today}}; desde entonces es de este repo.
