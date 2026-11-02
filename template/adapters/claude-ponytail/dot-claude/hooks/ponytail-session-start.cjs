// Hook SessionStart de Claude Code: activa Ponytail solo si el MCP esta configurado en este
// entorno. Si no esta, no imprime nada y rige el resumen de AGENTS.md («Modo de trabajo: Ponytail»).
// Otros agentes no necesitan este hook: AGENTS.md les pide lo mismo.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEVEL = process.env.PONYTAIL_LEVEL || 'full';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function ponytailConfigured() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const user = readJson(path.join(os.homedir(), '.claude.json'));
  const project = readJson(path.join(projectDir, '.mcp.json'));
  const scoped = user && user.projects && user.projects[projectDir];
  return [user, project, scoped].some((cfg) => Boolean(cfg && cfg.mcpServers && cfg.mcpServers.ponytail));
}

if (ponytailConfigured()) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'El MCP ponytail esta disponible en este entorno. Invoca ' +
          `mcp__ponytail__ponytail_instructions con mode "${LEVEL}" ahora, al ` +
          'arranque de esta sesion, y segui su ruleset durante el resto de la conversacion.',
      },
    })
  );
}
