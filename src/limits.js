import Bottleneck from 'bottleneck';

/**
 * Builds a Bottleneck group from one limit description:
 *   interval     minimum ms between two dispatches (`minTime`)
 *   concurrency  max in-flight requests; null/0 = unlimited
 *
 * Returns null when nothing is limited, so the hot path skips the scheduler.
 */
function createLimiter({ interval = 0, concurrency = null } = {}) {
  const minTime = Math.max(0, Number(interval) || 0);
  const maxConcurrent = Number(concurrency) > 0 ? Math.trunc(Number(concurrency)) : null;

  if (minTime === 0 && maxConcurrent === null) return null;

  return new Bottleneck({ minTime, maxConcurrent });
}

/**
 * Resolves the limiter for a request. Precedence, lowest first:
 * `groups["*"]`, `groups[<method>]` (or `groups["tools/call"]` for tool
 * calls), then `tools.<toolName>`.
 */
export class LimiterRegistry {
  #config;
  #limiters = new Map();

  constructor(config) {
    this.#config = config;
  }

  limitFor(message) {
    const isToolCall = message?.method === 'tools/call';
    const tool = isToolCall ? message.params?.name : undefined;
    const group = isToolCall ? this.#config.groups?.['tools/call'] : this.#config.groups?.[message?.method];

    return {
      ...(this.#config.groups?.['*'] ?? {}),
      ...(group ?? {}),
      ...((isToolCall && tool !== undefined ? this.#config.tools?.[tool] : undefined) ?? {}),
    };
  }

  limiterFor(message) {
    const isToolCall = message?.method === 'tools/call';
    const tool = isToolCall ? message.params?.name : undefined;
    const key = isToolCall && tool !== undefined && this.#config.tools?.[tool] ? `tool:${tool}` : `method:${message?.method}`;

    if (!this.#limiters.has(key)) {
      this.#limiters.set(key, createLimiter(this.limitFor(message)));
    }
    return this.#limiters.get(key);
  }
}
