/**
 * Render mínimo estilo mustache: `{{var}}`, `{{#seccion}}…{{/seccion}}` (lista → repite, valor → si es
 * verdadero) y `{{^seccion}}…{{/seccion}}` (si es falso o lista vacía). Un `{{var}}` sin valor es un
 * error: una plantilla nunca debe salir con marcadores sin resolver.
 */
const SECTION = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g
const VAR = /\{\{(\w+)\}\}/g
// Una etiqueta de sección sola en su línea no deja una línea en blanco en la salida.
const STANDALONE = /^[ \t]*(\{\{[#^/]\w+\}\})[ \t]*\n/gm

function lookup(stack, key) {
  for (const scope of stack) {
    if (scope && typeof scope === 'object' && key in scope) return scope[key]
  }
  return undefined
}

function renderIn(text, stack, file) {
  const sections = text.replace(SECTION, (_, op, key, body) => {
    const value = lookup(stack, key)
    const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value)
    if (op === '^') return truthy ? '' : renderIn(body, stack, file)
    if (!truthy) return ''
    if (Array.isArray(value)) return value.map((item) => renderIn(body, [item, ...stack], file)).join('')
    return renderIn(body, stack, file)
  })
  return sections.replace(VAR, (_, key) => {
    const value = lookup(stack, key)
    if (value === undefined || value === null) throw new Error(`${file}: {{${key}}} sin valor`)
    return String(value)
  })
}

export function render(text, context, file = 'plantilla') {
  return renderIn(text.replace(/\r\n/g, '\n').replace(STANDALONE, '$1'), [context], file)
}
