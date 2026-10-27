const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Tiny stderr logger. stdout is the MCP transport and must stay clean. */
export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const at = (name) => (message) => {
    if (LEVELS[name] <= threshold) process.stderr.write(`mcp-bottleneck ${name}: ${message}\n`);
  };
  return { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

export const LOG_LEVELS = Object.keys(LEVELS);
