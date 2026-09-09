# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

A Chrome Manifest V3 extension that exports/imports VTEX CMS (`vtex.admin-cms`) sections
directly from an open editor tab, by reusing the editor's own GraphQL traffic and session.
[README.md](README.md) describes the end-user flow — read it first.

## Stack and constraints

- Plain vanilla JavaScript, loaded as-is by the browser. **No build step, no bundler, no
  package.json, no dependencies, no TypeScript, no tests, no linter.** Do not introduce any of
  these unless explicitly asked.
- Match the existing style: `'use strict'`, `var` (not `let`/`const`), `function` expressions
  instead of arrows, `.then()` instead of `async/await`, and comments reserved for explaining
  *why* something non-obvious is done (see [src/main-world.js](src/main-world.js)).
- **User-facing strings are pt-BR; code comments are English.** Keep both.

## Architecture

Three isolated contexts. There is **no `chrome.runtime` message passing** anywhere — the side
panel reaches the page exclusively through `chrome.scripting.executeScript({ world: 'MAIN' })`.

- [manifest.json](manifest.json) — MV3 manifest: side panel, service worker, content script
  (`src/main-world.js`, `world: MAIN`, `run_at: document_start`, `all_frames: true`, matching
  `*://*.myvtex.com/admin/*`), permissions, and host permission limited to `*.myvtex.com`.
- [background.js](background.js) — service worker; its only job is opening the side panel on
  action click.
- [src/main-world.js](src/main-world.js) — runs in the **page's own JS realm**. Passively sniffs
  the editor's GraphQL traffic to fill `window.__eitriCmsState__`
  (`lastGraphqlUrl`, `builderId`, `pageType`, `documentId`, `documentVersionId`, `sections`,
  `capturedAt`), and exposes `window.__eitriCmsApply__(payload)` to publish.
- [panel.html](panel.html) / [panel.css](panel.css) / [panel.js](panel.js) — side panel UI:
  reads state from the page, lists sections, exports JSON to clipboard, validates pasted JSON,
  builds the publish payload, and invokes the apply function.
- [icons/](icons/) — icons only.

## Non-obvious invariants

These are the things that silently break. Preserve them.

1. **The editor lives in a same-origin iframe, not the top frame.** `panel.js` reads state from
   *all* frames (`allFrames: true`), scores the results (`scoreState`), and remembers the winning
   `primaryFrameId` so the publish call runs in the frame that actually captured traffic. Never
   collapse this back to a single/top-frame call.
2. **Functions passed to `executeScript` are serialized** — they cannot close over panel.js
   variables. Everything they need must go through `args: [...]`.
3. **The publish uses `origFetch`, captured at `document_start` before the hook is installed.**
   Publishing through the patched `window.fetch` would re-enter the sniffer. Keep that reference.
4. **Four independent capture paths exist on purpose**, because no single one is sufficient:
   the `window.fetch` hook, an XHR hook, a `Response.prototype.json/text` hook (catches clients
   that grabbed `fetch` before injection), and a `defineProperty` trap on `__STATE__` /
   `__APOLLO_STATE__` (SSR hydration data that never crosses the network at all). Removing one
   because it "looks redundant" will break some load paths.
5. **`deepScanForSections` is shape-based, not schema-based** (`id` + `name` + `props`/`data`),
   depth-capped at 8. It is deliberately agnostic of VTEX's GraphQL field names, which we don't
   control.
6. **Two section shapes exist and the conversion is duplicated.** Wire format is
   `{ data: { id, name, props, errors } }`; the friendly/exported format is `{ name, data }`.
   Conversion lives in `toWireSection` (main-world.js) *and* in `normalizeInputSections` /
   `sectionsToFriendly` (panel.js). Changing one side requires changing the other.
7. **Variables are base64-encoded JSON inside `extensions.variables`**, not standard GraphQL
   `variables` (which is sent empty). This is VTEX's persisted-query convention — see
   `buildPayload`. The `escape`/`unescape` + `btoa`/`atob` dance is the UTF-8 workaround; do not
   "modernize" it away or non-ASCII section props will corrupt.
8. **`PERSISTED_QUERY.sha256Hash` in panel.js is VTEX's, not ours.** If VTEX ships a new
   `vtex.admin-cms` query, publishing fails and the hash must be re-sniffed from real editor
   traffic. Same for the `/_v/private/graphql/v1` URL fragment used to recognize CMS calls.
9. **REPLACE publishes immediately and overwrites every live section.** It is destructive with no
   undo — keep the confirmation dialog and its explicit warning text intact.

## Security boundaries

- Host permission is intentionally scoped to `*.myvtex.com`. Do not broaden it.
- Captured data (documentId, sections, …) must never leave the browser tab. The only network
  call is the publish mutation, issued by the page itself so its cookies apply automatically —
  do not add extension-side requests that carry cookies or tokens separately.
- Pasted JSON is untrusted input. Keep the validation and normalization in
  `normalizeInputSections`, and keep rendering section names via `textContent` (never
  `innerHTML`).

## Verifying changes

There is nothing to run — no tests, no lint. Verification is manual:

1. `chrome://extensions` → "Modo do desenvolvedor" → "Carregar sem compactação" (or reload the
   already-loaded extension after any edit).
2. Open a real VTEX CMS editor tab and confirm the panel auto-fills `builderId` / `pageType` /
   `documentId` / `documentVersionId` and lists the current sections.
3. Exercise all three paths: export ("Copiar JSON"), import in ADD mode, import in REPLACE mode.
4. Check the panel's footer log for the API response.

Bump `version` in [manifest.json](manifest.json) for user-visible changes.

## Known loose ends

- The `storage` permission is declared in the manifest but nothing uses it.
- Some strings and comments still say "popup"/"content script" from an earlier design; the UI is
  a side panel and the injected file runs in the MAIN world.
