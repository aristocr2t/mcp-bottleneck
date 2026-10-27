/** Minimal JSON-RPC 2.0 helpers for line-delimited MCP stdio traffic. */

/** Parse one line; returns undefined for anything that is not a JSON object/array. */
export function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

export function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

/** A request has an id and a method. */
export function isRequest(message) {
  return !Array.isArray(message) && typeof message?.method === 'string' && message.id !== undefined && message.id !== null;
}

/** A response has an id and no method. */
export function isResponse(message) {
  return !Array.isArray(message) && message.method === undefined && message.id !== undefined && message.id !== null;
}

export function isErrorResponse(message) {
  return isResponse(message) && (message.error !== undefined || message.result?.isError === true);
}

/** Flatten the human-readable part of a JSON-RPC error or an MCP error result. */
export function errorText(message) {
  const parts = [];
  if (message?.error !== undefined) {
    parts.push(typeof message.error === 'string' ? message.error : message.error?.message ?? JSON.stringify(message.error));
  }
  const content = message?.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item?.text === 'string') parts.push(item.text);
    }
  }
  return parts.join(' ');
}

export function toolNameOf(message) {
  if (message?.method !== 'tools/call') return undefined;
  const name = message.params?.name;
  return typeof name === 'string' ? name : undefined;
}

export function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Stable identity for coalescing: two calls are the same if method and params match. */
export function requestKey(message) {
  return `${message.method}:${stableStringify(message.params)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
