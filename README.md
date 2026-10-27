# mcp-bottleneck

An [MCP](https://modelcontextprotocol.io) stdio proxy that makes tool calls polite to rate-limited servers.

Agents fire tool calls in parallel. The APIs behind MCP servers often allow **one request per second**. The first call wins, the rest come back as `Error: Rate limit exceeded`, and the agent starts apologising to the user. `mcp-bottleneck` sits between client and server and fixes exactly that: it spaces calls out, retries the ones that hit the limit, and merges duplicates.

Scheduling is done by [Bottleneck](https://github.com/SGrondin/bottleneck). The MCP-specific parts live here: JSON-RPC framing, per-tool limits, response fan-out, cancellation, and retries keyed on *error responses* rather than thrown exceptions.

## Install

```sh
npm install -g mcp-bottleneck
```

## Quick start

Wrap the server command; nothing else in the client config changes.

```jsonc
// ~/.pi/agent/mcp.json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": [
        "-y", "mcp-bottleneck",
        "--preset", "brave",          // 1100 ms between calls, 1 in flight, 3 retries
        "--", "npx", "-y", "@modelcontextprotocol/server-brave-search"
      ],
      "env": { "BRAVE_API_KEY": "..." }
    }
  }
}
```

The same block works for Claude Desktop and Cursor.

## What it does

| Feature | Flag | Why it matters |
| --- | --- | --- |
| **Interval throttle** | `--interval <ms>` | Parallel calls stop colliding with the API limit |
| **Concurrency cap** | `--concurrency <n>` | Keeps in-flight requests under what the API tolerates |
| **Retry with backoff** | `--retries <n>` | A rate-limited call is retried instead of surfacing as an error |
| **Coalescing** | `--coalesce` | Two identical in-flight calls cost one API request |
| **Timeout** | `--timeout <ms>` | A silent server becomes a JSON-RPC error, not a hung agent |
| **Per-tool limits** | `--config <file>` | Cheaper and pricier tools get different limits; `tools/list` stays fast |
| **Preset** | `--preset brave` | Known-good numbers for Brave Search |
| **Bounded queue** | `--max-pending <n>` | A burst beyond n pending requests is rejected, not buffered forever |

Cancellation is handled without a flag: `notifications/cancelled` frees the queue slot and cancels pending timers, so one abandoned call cannot wedge a concurrency limit.

Error codes the proxy may produce: `-32000` timeout, `-32001` upstream server gone, `-32002` too many pending requests. All are ordinary server errors in the JSON-RPC range, so clients treat them as tool failures.

## Options

```
--interval <ms>        minimum gap between tool calls (default: 0)
--concurrency <n>      max in-flight tool calls, 0 = unlimited (default: 0)
--max-pending <n>      reject new requests beyond n pending (queued + in-flight),
                       0 = unlimited (default: 0)
--preset <name>        named limit set, currently: brave
--config <path>        JSON config with per-method and per-tool limits
--coalesce             merge identical in-flight tool calls into one

--retries <n>          retries for rate-limit errors (default: 0)
--retry-on <list>      comma-separated error substrings, case-insensitive
--retry-base-ms <ms>   first backoff delay, doubled per attempt (default: 1000)
--timeout <ms>         answer with a JSON-RPC error if the server is silent
                       for this long, 0 = wait forever (default: 0)

--log <level>          silent | error | warn | info | debug (default: info)
-h, --help             show this help
-v, --version          print version
```

`--interval` and `--concurrency` configure the `tools/call` group; `--config` reaches other methods. `--timeout` applies to every request, including `initialize`, so keep it well above your slowest tool. Backoff doubles per attempt up to 30 s.

## Config file

```jsonc
// mcp-bottleneck.json
{
  "groups": {
    "tools/call":     { "interval": 1100, "concurrency": 1 },
    "resources/read": { "interval": 0,    "concurrency": 4 },
    "*":              { "interval": 0,    "concurrency": null }
  },
  "tools": {
    "brave_local_search": { "interval": 2000 }
  },
  "retries": 3,
  "timeout": 30000,
  "coalesce": true
}
```

A limit resolves as: `tools.<toolName>` layered over `groups["tools/call"]`, else `groups[<method>]`, else `groups["*"]`. `concurrency: null` (or `0`) means unlimited.

Sources merge lowest to highest: built-in defaults → `--preset` → `--config` file → individual flags.

## How it works

```
agent/client  <--stdio-->  mcp-bottleneck  <--stdio-->  real MCP server  -->  rate-limited API
```

- Every client request becomes an entry tracked by JSON-RPC id through queueing, dispatch, retries and response fan-out.
- Throttled requests go to a `Bottleneck` group for their method or tool. The job stays running until the response arrives, so `--concurrency` limits in-flight calls, not just queued ones.
- When the server answers with an error matching `--retry-on`, the client keeps waiting: the proxy backs off and re-sends. One response reaches the client — the successful one.
- With `--coalesce`, an identical request attaches as an extra waiter to the existing entry, and the single upstream response is re-emitted with each waiter's own id.
- Everything else — `initialize`, `tools/list`, notifications, server-initiated requests — is forwarded untouched. Lines that are not JSON are passed through byte for byte.

## Limitations

- Limits are per process. Several proxies against the same API do not share a budget.
- `--coalesce` matches on exact `method` + `params` and cannot know whether a tool is idempotent. Enable it for read-only tools.
- Retries assume idempotency too. The defaults target rate-limit errors only, but a tool that charges money per attempt still charges per retry.
- Without `--max-pending`, the queue is unbounded: a pathological burst of thousands of calls is slowed down, not rejected. Set `--max-pending` to reject the excess instead.
- JSON-RPC batch arrays are forwarded as-is and not throttled.

## Development

```sh
npm install
npm test        # node:test, no extra dependencies
```

## License

MIT
