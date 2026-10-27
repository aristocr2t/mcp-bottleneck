import { readFileSync } from 'node:fs';
import { LOG_LEVELS } from './log.js';

/** Single source of truth: package.json. */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const DEFAULTS = {
  groups: {
    'tools/call': { interval: 0, concurrency: null },
    '*': { interval: 0, concurrency: null },
  },
  tools: {},
  retries: 0,
  retryOn: ['rate limit', 'too many requests', '429', 'quota exceeded'],
  retryBaseMs: 1000,
  timeout: 0,
  maxPending: 0,
  coalesce: false,
  shutdownGraceMs: 2000,
  logLevel: 'info',
};

export const PRESETS = {
  brave: {
    groups: { 'tools/call': { interval: 1100, concurrency: 1 } },
    retries: 3,
  },
};

const HELP = `mcp-bottleneck ${VERSION} - rate-limited MCP proxy

Usage: mcp-bottleneck [options] -- <command> [args...]

Throttling
  --interval <ms>        minimum gap between tool calls (default: 0)
  --concurrency <n>      max in-flight tool calls, 0 = unlimited (default: 0)
  --max-pending <n>      reject new requests beyond n pending (queued + in-flight),
                         0 = unlimited (default: 0)
  --preset <name>        named limit set, currently: brave
  --config <path>        JSON config with per-method and per-tool limits
  --coalesce             merge identical in-flight tool calls into one

Reliability
  --retries <n>          retries for rate-limit errors (default: 0)
  --retry-on <list>      comma-separated error substrings, case-insensitive
  --retry-base-ms <ms>   first backoff delay, doubled per attempt (default: 1000)
  --timeout <ms>         answer with a JSON-RPC error if the server is silent
                         for this long, 0 = wait forever (default: 0)

Other
  --log <level>          ${LOG_LEVELS.join(' | ')} (default: info)
  -h, --help             show this help
  -v, --version          print version
`;

export class UsageError extends Error {}

/** Recursively merge plain objects; arrays and scalars replace. */
export function merge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = merge(base?.[key] ?? {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readConfigFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read --config "${path}": ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`invalid JSON in --config "${path}": ${error.message}`);
  }
}

const toolCallGroup = (patch) => ({ groups: { 'tools/call': patch } });

const NUMBER_FLAGS = {
  '--interval': (flags, value) => (flags.patch = merge(flags.patch, toolCallGroup({ interval: value }))),
  '--concurrency': (flags, value) => (flags.patch = merge(flags.patch, toolCallGroup({ concurrency: value }))),
  '--retries': (flags, value) => (flags.patch.retries = value),
  '--retry-base-ms': (flags, value) => (flags.patch.retryBaseMs = value),
  '--timeout': (flags, value) => (flags.patch.timeout = value),
  '--max-pending': (flags, value) => (flags.patch.maxPending = value),
};

/**
 * Parses argv. Precedence, lowest first:
 * built-in defaults -> --preset -> --config file -> individual flags.
 *
 * @returns {{ command: string[], config: object, help: boolean, version: boolean }}
 */
export function parseArgs(argv) {
  const flags = { patch: {} };
  let help = false;
  let version = false;
  let index = 0;

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      continue;
    }

    const [flag, inline] = arg.split(/=(.*)/s);
    const take = () => {
      const value = inline !== undefined ? inline : argv[++index];
      if (value === undefined) throw new UsageError(`${flag} needs a value`);
      return value;
    };

    if (flag in NUMBER_FLAGS) {
      const raw = take();
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new UsageError(`${flag} expects a non-negative number, got "${raw}"`);
      }
      NUMBER_FLAGS[flag](flags, value);
      continue;
    }

    switch (flag) {
      case '--config':
        flags.configFile = take();
        break;
      case '--preset': {
        const name = take();
        if (!PRESETS[name]) throw new UsageError(`unknown preset "${name}"`);
        flags.preset = name;
        break;
      }
      case '--retry-on':
        flags.patch.retryOn = take().split(',').map((item) => item.trim()).filter(Boolean);
        break;
      case '--log': {
        const level = take();
        if (!LOG_LEVELS.includes(level)) throw new UsageError(`unknown log level "${level}"`);
        flags.patch.logLevel = level;
        break;
      }
      case '--coalesce':
        flags.patch.coalesce = true;
        break;
      default:
        throw new UsageError(`unknown option "${arg}"`);
    }
  }

  const command = argv.slice(index);
  if (!help && !version && command.length === 0) {
    throw new UsageError('missing server command after "--"');
  }

  let config = merge(DEFAULTS, flags.preset ? PRESETS[flags.preset] : {});
  if (flags.configFile) config = merge(config, readConfigFile(flags.configFile));
  config = merge(config, flags.patch);

  return { command, config, help, version };
}

export const usage = HELP;
