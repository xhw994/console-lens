# Console Lens

**Turn messy console.log output into a searchable, filterable dashboard with dot-path queries and live column extraction.**

Stop scrolling through collapsed console objects. Console Lens gives your browser's console output the structure it deserves.

Console Lens adds a dedicated DevTools panel that captures every `console.log`, `debug`, `warn`, and `error` call — then lets you slice through deeply nested objects with a powerful dot-path query language.

## Features

- **Dot-path queries** — Type `user.address.city` to extract and display nested values as column pills on every log card
- **Live filtering** — Add `=` to filter: `status=active` shows only matching logs. Comma for OR: `role=admin,editor`. Space for AND. Use `field=null` to match null values
- **Smart label detection** — Automatically extracts labels from `console.group`, `%c` styled output, and printf-style format strings (`%s`, `%d`, `%f`)
- **Collapsible JSON tree** — Each log card shows a fully interactive JSON tree with per-node collapse/expand controls. Objects show `{...N keys}` and arrays show `[...N items]` when collapsed
- **Filter by level** — Isolate log, debug, info, warn, or error calls with one click
- **Key fingerprint labels** — Object-only logs get a readable label from their top-level keys: `{id, name, status, ...}`
- **Settings panel** — Consolidated `⚙` settings with Sort keys A→Z, Strict path filtering, Clear on navigation, and Field stripping
- **Field stripping** — Hide sensitive or noisy fields from JSON display by entering dot-paths (e.g. `user.password`, `meta._trackingId`). Original data is untouched
- **Right-click export** — Right-click any log card to Copy as JSON or Copy label to clipboard
- **Zero configuration** — Open DevTools, click the Console Lens tab, and start filtering. No SDK, no code changes, works on any website

## Query Language

| Query | Behavior |
|-------|----------|
| `status` | Display `status` as a column pill on every card |
| `user.address.city` | Extract nested values using dot-paths |
| `status=active` | Filter: only show logs where `status` is `"active"` |
| `role=admin,editor` | OR filter: match `"admin"` or `"editor"` |
| `status=active type=request` | AND filter: both must match |
| `items.id=42` | Filter on nested array values — auto-flattens arrays |
| `referrer=null` | Filter for fields with `null` value |

## How It Works

Console Lens monkey-patches `console.log`, `debug`, `info`, `warn`, `error`, `group`, and `groupCollapsed` in the page context via a Manifest V3 content script (`"world": "MAIN"`). Intercepted logs are buffered and polled by the DevTools panel via `chrome.devtools.inspectedWindow.eval`.

- Labels are extracted from printf-style format strings (`%c`, `%s`, `%d`), `console.group`/`groupCollapsed` headers, or generated as key fingerprints for object-only logs
- Objects are deep-cloned with circular reference detection, depth limiting, and graceful handling of DOM nodes, functions, and non-serializable values
- The panel reads in batches of 100 with adaptive polling (50ms when draining a backlog, 300ms at steady state)
- Original console behavior is fully preserved — Console Lens never suppresses or modifies output

## Install

### From source (development)

```bash
git clone https://github.com/xhw994/console-lens.git
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the cloned `console-lens/` folder
4. Open DevTools on any page — the **Console Lens** tab appears

### Chrome Web Store

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/console-lens/) *(link live once approved)*

### Microsoft Edge Add-ons

[Install from Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/console-lens/) *(link live once approved)*

## Tested On

Console Lens has been tested on the following sites to verify broad compatibility:

| Site | Logs | What's captured |
|------|------|----------------|
| **LinkedIn** (linkedin.com) | ~86 | BooleanExpression warnings, debug/log events. Mostly flat `{ message }` data |
| **Discord** (discord.com) | ~39 | Internal module logs (`[libdiscore]`, `[DatabaseManager]`), connection events |
| **YouTube** (youtube.com) | ~1 | LegacyDataMixin info. YouTube suppresses most console output in production |
| **Google** (google.com) | 0 | Zero console output — expected for production homepage |
| **Amazon** (amazon.com) | 0 | Zero console output — Amazon suppresses console in production |

## Privacy

Console Lens never modifies page behavior, never sends data anywhere, and works entirely offline. All captured logs stay in your browser's memory and are cleared when you close DevTools or navigate away.

## License

MIT
