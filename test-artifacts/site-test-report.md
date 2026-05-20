# Console Lens — Site Compatibility Test Report

**Date:** 2026-04-02
**Extension version:** 1.0.0 (post-Batch 1 features)
**Browser:** Microsoft Edge (Chromium)
**Test method:** Navigate to each site, wait 5s for page load, read `window.__consoleLensBuffer`

## Results

| Site | Logs Captured | Methods | Has Nested Objects | Notes |
|---|---|---|---|---|
| **E-commerce site** | 275 | log:263, debug:11, warn:1 | 215 (78%) | Richest source. 8+ keys per entry. Emoji labels, bootstrap events, analytics tracking. Deep nesting confirmed. |
| **LinkedIn** | 86 | warn:83, debug:2, log:1 | 0 | Mostly BooleanExpression warnings. Flat `{ message }` data. |
| **Discord** | 39 | debug:19, info:12, log:8 | 1 | Internal module labels (`[libdiscore]`, `[DatabaseManager]`). Mostly flat message objects. |
| **YouTube** | 1 | info:1 | 0 | Single LegacyDataMixin warning on page load. YouTube suppresses console in production. |
| **Google** | 0 | — | — | Zero console output. Expected for google.com homepage. |
| **Amazon** | 0 | — | — | Zero console output. Amazon suppresses console in production. |

## Features Verified

### Font Rendering (Req 1)
- **Edge:** Consolas font confirmed rendering in JSON tree (not Courier New)
- **Fix:** `font-family: inherit` on `.json-pre` forces body font stack onto `<pre>` elements

### Null Values (Req 2)
- `referrer=null` filter correctly matches entries where value is `null`
- Null pills render in italic gray (`.is-null` class)
- Visually distinct from missing fields (no pill shown) and string values

### Collapsible JSON Tree (Req 5)
- Nested objects/arrays render with `▼`/`►` toggle controls
- Collapse shows summary: `► { ...3 keys }` or `► [ ...5 items ]`
- All levels independently collapsible
- Default state: fully expanded

### Sort Keys (Req 4)
- Keys render alphabetically when "Sort keys A→Z" is checked (default)
- Verified: `active, address, email, referrer, role, score, tags, userId`

### Settings Dropdown (Req B)
- `[hidden]` attribute fix prevents panel from showing on load
- Toggle: `none → flex → none` on ⚙ button click
- Contains: Sort keys, Strict path filtering, Clear on navigation, Strip fields

### Strict/Lenient Mode (Req A)
- Strict ON + `referrer=null`: 2 entries shown (only those with null referrer)
- Strict OFF + `referrer=null`: 6 entries shown (all entries, including those without field)

### Strip Fields (Req 3)
- Strip `address` → field removed from JSON display
- Original `logs[]` data untouched (verified by re-rendering without strip)
- Clear strip button appears when paths are active, with "Stripping N fields" status

### Right-Click Context Menu (Req E)
- `Copy as JSON` and `Copy label` menu items wired via `navigator.clipboard.writeText`
- Menu dismisses on outside click

## Known Limitations
- Sites with zero console output (Google, Amazon) produce no logs — expected behavior
- YouTube has minimal output in production; debug logs require `#debug` flag
- DevTools panel icon requires extension reload after code change
