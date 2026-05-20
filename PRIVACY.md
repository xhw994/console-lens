# Privacy Policy — Console Lens

**Effective date:** 2026-04-02

## What Console Lens does

Console Lens is a browser DevTools extension that captures `console.log` output from the page you are currently inspecting and displays it in a searchable, filterable panel inside your browser's developer tools.

## Data collection

Console Lens **does not collect, transmit, or share any data** with the extension author or any third party.

- **Console output** is captured in your browser's memory only. It is visible in the DevTools panel and is discarded when you close DevTools or navigate away.
- **Settings** (panel history limit, page buffer size, clone depth, sort/filter preferences, and field-strip rules) are stored locally on your device using `chrome.storage.local`. They are never synced, never sent anywhere, and never accessible to any server.
- Console Lens makes no network requests of its own.

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Persist user settings (limits, toggles) across DevTools sessions using `chrome.storage.local` |
| `<all_urls>` (content script) | Inject the log interceptor into any page the user inspects via DevTools |

## Third-party access

No data captured by Console Lens is shared with any third party. There are no analytics, telemetry, crash-reporting, or advertising SDKs in this extension.

## Contact

Questions? Open an issue at https://github.com/xhw994/console-lens
