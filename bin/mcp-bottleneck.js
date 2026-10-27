#!/usr/bin/env node
import { parseArgs, usage, UsageError, VERSION } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { Proxy } from '../src/proxy.js';

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`mcp-bottleneck: ${error.message}\n\n${usage}`);
      process.exit(2);
    }
    throw error;
  }

  if (parsed.help) {
    process.stdout.write(usage);
    process.exit(0);
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const [command, ...args] = parsed.command;
  const log = createLogger(parsed.config.logLevel);
  const proxy = new Proxy({ command, args, config: parsed.config, logger: log });

  proxy.start();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      proxy.shutdown();
      process.exit(0);
    });
  }

  proxy.whenExited().then((code) => {
    // Let any queued stdout writes reach the client before leaving.
    setImmediate(() => process.exit(code));
  });
}

main(process.argv.slice(2));
