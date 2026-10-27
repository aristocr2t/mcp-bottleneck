import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  encode,
  errorResponse,
  errorText,
  isErrorResponse,
  isRequest,
  isResponse,
  parseLine,
  requestKey,
  toolNameOf,
} from './jsonrpc.js';
import { LimiterRegistry } from './limits.js';

const TIMEOUT_CODE = -32000;
const UPSTREAM_CODE = -32001;
const OVERFLOW_CODE = -32002;
const RETRY_MAX_MS = 30_000;

const truncate = (text, limit = 120) => (text.length > limit ? `${text.slice(0, limit)}...` : text);

/**
 * The proxy.
 *
 * One entry per client request is tracked through queueing, dispatch, retries
 * and response fan-out. Entries are keyed by the upstream JSON-RPC id, which is
 * always the id of the first client that asked; duplicate clients attached by
 * coalescing are extra `waiters`.
 */
export class Proxy {
  constructor({ command, args = [], config, logger, input = process.stdin, output = process.stdout }) {
    this.command = command;
    this.args = args;
    this.config = config;
    this.log = logger;
    this.input = input;
    this.output = output;

    this.limiters = new LimiterRegistry(config);
    this.retryPatterns = (config.retryOn ?? []).map((pattern) => pattern.toLowerCase());

    this.pending = new Map();
    this.entries = new Map();
    this.byKey = new Map();
    this.timers = new Set();
    this.stopped = false;
    this.clientClosed = false;
    this.exitCode = null;
    this.server = null;
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.server = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });

    this.server.on('error', (error) => {
      this.log.error(`cannot start "${this.command}": ${error.message}`);
      this.exitCode = 1;
      this.shutdown();
    });

    this.server.on('exit', (code, signal) => {
      this.log.debug(`server exited (code=${code}, signal=${signal})`);
      for (const entry of [...this.entries.values()]) {
        this.fail(entry, UPSTREAM_CODE, 'mcp-bottleneck: upstream server exited');
      }
      this.entries.clear();
      this.pending.clear();
      this.byKey.clear();
      // A server that dies after the client hung up is a normal shutdown.
      this.exitCode = this.clientClosed ? 0 : code ?? 1;
      this.shutdown();
    });

    this.clientLines = createInterface({ input: this.input, crlfDelay: Infinity });
    this.clientLines.on('line', (line) => this.onClientLine(line));
    this.clientLines.on('close', () => this.onClientClose());

    this.serverLines = createInterface({ input: this.server.stdout, crlfDelay: Infinity });
    this.serverLines.on('line', (line) => this.onServerLine(line));

    this.log.debug(`started: ${this.command} ${this.args.join(' ')}`);
    return this;
  }

  /** Stop the upstream server and drop every timer. Safe to call repeatedly. */
  shutdown() {
    if (this.stopped) return;
    this.stopped = true;

    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();

    for (const entry of [...this.entries.values()]) {
      this.fail(entry, UPSTREAM_CODE, 'mcp-bottleneck: shutting down');
    }
    this.entries.clear();
    this.pending.clear();
    this.byKey.clear();

    if (this.server) {
      if (!this.server.stdin.destroyed) this.server.stdin.end();
      const server = this.server;
      const killTimer = setTimeout(() => {
        if (server.exitCode === null) server.kill('SIGTERM');
      }, 250);
      killTimer.unref?.();
    }
    this.log.debug('stopped');
  }

  /** Resolves once the upstream process is gone (also when it failed to start). */
  whenExited() {
    if (!this.server) return Promise.resolve(this.exitCode ?? 1);
    if (this.server.exitCode !== null || this.server.killed) return Promise.resolve(this.exitCode ?? 1);
    return new Promise((resolve) => this.server.once('close', () => resolve(this.exitCode ?? 1)));
  }

  onClientClose() {
    this.clientClosed = true;
    this.log.debug('client closed its end; draining');
    const deadline = Date.now() + this.config.shutdownGraceMs;
    const poll = () => {
      if (this.entries.size === 0 || Date.now() > deadline) return this.shutdown();
      setTimeout(poll, 25);
    };
    poll();
  }

  // ------------------------------------------------------------ client input

  onClientLine(line) {
    if (!line.trim()) return;

    const message = parseLine(line);
    if (!message || Array.isArray(message)) {
      // Not JSON-RPC (or a batch we do not need to understand): pass through.
      this.writeToServer(`${line}\n`);
      return;
    }

    if (!isRequest(message)) {
      // Notifications and responses to server-initiated requests.
      if (message.method === 'notifications/cancelled') this.onCancel(message);
      this.writeToServer(encode(message));
      return;
    }

    this.handleRequest(message);
  }

  handleRequest(message) {
    let key = null;
    if (this.config.coalesce) {
      key = requestKey(message);
      const existing = this.byKey.get(key);
      if (existing && !existing.done) {
        existing.waiters.push(message.id);
        this.log.debug(`coalesced id ${message.id} into upstream id ${existing.id}`);
        return;
      }
    }

    if (this.config.maxPending > 0 && this.entries.size >= this.config.maxPending) {
      this.log.warn(`rejecting id ${message.id}: ${this.entries.size} pending (max ${this.config.maxPending})`);
      this.writeToClient(errorResponse(message.id, OVERFLOW_CODE, `mcp-bottleneck: too many pending requests (max ${this.config.maxPending})`));
      return;
    }

    const entry = {
      id: message.id,
      message,
      key,
      waiters: [message.id],
      attempt: 0,
      timer: null,
      release: null,
      done: false,
    };
    this.entries.set(entry.id, entry);
    if (key) this.byKey.set(key, entry);
    this.schedule(entry);
  }

  onCancel(message) {
    const requestId = message.params?.requestId;
    if (requestId === undefined) return;

    const entry = this.entries.get(requestId);
    if (entry) {
      this.log.debug(`cancelled id ${requestId}`);
      this.abandon(entry);
      return;
    }

    // A coalesced waiter is not an entry itself; find and detach it.
    for (const other of this.entries.values()) {
      const index = other.waiters.indexOf(requestId);
      if (index >= 0) {
        other.waiters.splice(index, 1);
        this.log.debug(`cancelled coalesced waiter id ${requestId}`);
        if (other.waiters.length === 0) this.abandon(other);
        return;
      }
    }
  }

  // -------------------------------------------------------------- scheduling

  schedule(entry) {
    if (entry.done) return;
    entry.release = null;

    const limiter = this.limiters.limiterFor(entry.message);
    if (!limiter) {
      this.dispatch(entry);
      return;
    }

    limiter
      .schedule(() => new Promise((resolve) => {
        if (entry.done) {
          resolve();
          return;
        }
        entry.release = resolve;
        this.dispatch(entry);
      }))
      .catch((error) => this.fail(entry, UPSTREAM_CODE, `mcp-bottleneck: ${error.message}`));
  }

  dispatch(entry) {
    if (entry.done || this.stopped) {
      this.release(entry);
      return;
    }

    this.pending.set(entry.id, entry);

    if (this.config.timeout > 0) {
      entry.timer = this.after(this.config.timeout, () => this.onTimeout(entry));
    }

    if (this.server.stdin.destroyed) {
      this.fail(entry, UPSTREAM_CODE, 'mcp-bottleneck: upstream stdin is closed');
      return;
    }

    this.server.stdin.write(encode(entry.message));
    this.log.debug(`dispatch ${this.describe(entry.message)} attempt=${entry.attempt + 1}`);
  }

  onTimeout(entry) {
    if (this.pending.get(entry.id) !== entry) return;
    this.pending.delete(entry.id);
    this.log.warn(`timeout ${this.config.timeout}ms for ${this.describe(entry.message)}`);
    this.finish(entry, (id) => errorResponse(id, TIMEOUT_CODE, `mcp-bottleneck: no response after ${this.config.timeout}ms`));
  }

  // ------------------------------------------------------------ server input

  onServerLine(line) {
    if (!line.trim()) return;

    const message = parseLine(line);
    if (!message || Array.isArray(message) || !isResponse(message)) {
      // Notifications, server-initiated requests and anything else: pass through.
      this.writeToClient(`${line}\n`);
      return;
    }

    const entry = this.pending.get(message.id);
    if (!entry || entry.done) {
      this.writeToClient(`${line}\n`);
      return;
    }

    this.pending.delete(message.id);
    this.clearTimer(entry);

    if (this.shouldRetry(entry, message)) {
      this.retry(entry, message);
      return;
    }

    this.finish(entry, (id) => ({ ...message, id }));
  }

  shouldRetry(entry, message) {
    if (entry.attempt >= this.config.retries) return false;
    if (!isErrorResponse(message)) return false;
    const text = errorText(message).toLowerCase();
    return this.retryPatterns.some((pattern) => text.includes(pattern));
  }

  retry(entry, message) {
    entry.attempt += 1;
    const delay = Math.min(RETRY_MAX_MS, this.config.retryBaseMs * 2 ** (entry.attempt - 1));
    this.log.warn(`retry ${entry.attempt}/${this.config.retries} in ${delay}ms: ${truncate(errorText(message))}`);
    this.release(entry);
    this.after(delay, () => this.schedule(entry));
  }

  // ------------------------------------------------------------------ ending

  /** Send a final response for every waiter, then free the entry. */
  finish(entry, build) {
    if (entry.done) return;
    entry.done = true;
    this.clearTimer(entry);
    for (const waiterId of entry.waiters) this.writeToClient(build(waiterId));
    this.cleanup(entry);
    this.release(entry);
  }

  fail(entry, code, text) {
    this.finish(entry, (id) => errorResponse(id, code, text));
  }

  /** Drop an entry without answering anyone (cancellation). */
  abandon(entry) {
    if (entry.done) return;
    entry.done = true;
    this.clearTimer(entry);
    this.cleanup(entry);
    this.release(entry);
  }

  cleanup(entry) {
    if (entry.key && this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key);
    if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
  }

  release(entry) {
    const release = entry.release;
    entry.release = null;
    if (release) release();
  }

  // ------------------------------------------------------------------ helpers

  after(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  clearTimer(entry) {
    if (!entry.timer) return;
    clearTimeout(entry.timer);
    this.timers.delete(entry.timer);
    entry.timer = null;
  }

  writeToClient(payload) {
    this.output.write(typeof payload === 'string' ? payload : encode(payload));
  }

  writeToServer(payload) {
    if (this.server.stdin.destroyed) return;
    this.server.stdin.write(payload);
  }

  describe(message) {
    const tool = toolNameOf(message);
    return tool ? `${message.method}(${tool})` : String(message.method);
  }
}
