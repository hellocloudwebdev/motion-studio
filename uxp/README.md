# Motion Studio UXP panels

Adobe UXP panels that connect Adobe hosts to Motion Studio's craft MCP servers
over Streamable HTTP:

| Panel | Directory | Host | MCP server (HTTP mode) |
| --- | --- | --- | --- |
| EffectCraft | `uxp/effectcraft-panel/` | After Effects (AEFT) | `http://127.0.0.1:7420/mcp` |
| FilmCraft | `uxp/filmcraft-panel/` | Premiere Pro | `http://127.0.0.1:7430/mcp` |

```
uxp/
  README.md
  package.json                  # node-only (see note below); ignored by UXP
  shared/
    mcp-http-client.js          # canonical MCP client (plain script, UMD-style)
    panel.css                   # canonical stylesheet (copied into both panels)
    mcp-http-client.test.mjs    # node:test suite (fixture MCP server + panels)
  effectcraft-panel/
    manifest.json               # UXP manifest v5, host AEFT 27.1.0 (beta)
    index.html                  # loads mcp-http-client.js BEFORE panel.js
    panel.js                    # panel lifecycle (panels.main.create/show/hide)
    panel.css                   # copy of ../shared/panel.css
    mcp-http-client.js          # byte-identical copy of ../shared/... (UXP sandbox)
  filmcraft-panel/
    ...                         # same trio, host premierepro 25.2.0, port 7430
```

Why the copies: UXP plugins are directory-sandboxed — a plugin cannot load
scripts from outside its own folder, so each panel carries its own
`mcp-http-client.js` and `panel.css`. The node:test suite asserts both copies
are **byte-identical** to `uxp/shared/`.

`uxp/package.json` exists only so `node --test` can require the plain-script
`.js` client copies as CommonJS (the repo root is ESM). UXP itself ignores it.

---

## 1. Prerequisites

1. **Node.js 24** (repo root: `npm test` runs the whole repo suite; the UXP
   suite runs standalone — see "Tests" below).
2. **Adobe host + UXP runtime**
   - FilmCraft panel: Premiere Pro **25.2.0 or newer** (stable UXP support).
   - EffectCraft panel: After Effects **27.1 beta** with **UXP 9.4**. After
     Effects UXP is BETA-only — see the caveat in section 4.
3. **UXP Developer Tool** — install from the Adobe Creative Cloud app
   (search "UXP Developer Tool"). This is what loads and debugs the plugins.
4. **The craft MCP servers running in HTTP mode** (built elsewhere in this
   repo — `packages/effectcraft-mcp-server` and
   `packages/filmcraft-mcp-server`):

   ```bash
   # EffectCraft server on the default port 7420
   node packages/effectcraft-mcp-server/src/index.mjs --http

   # FilmCraft server on port 7430
   node packages/filmcraft-mcp-server/src/index.mjs --http --port 7430
   ```

5. **Token (optional but recommended).** If you start a server with a token
   requirement, pass the same secret in the panel's **Token** field. The
   client sends it as the `x-motion-studio-token` header on every request.
   Check the craft server's own README for its exact env var (for example
   `MOTION_STUDIO_MCP_TOKEN=<secret>`), then:

   ```bash
   MOTION_STUDIO_MCP_TOKEN=office-secret node packages/filmcraft-mcp-server/src/index.mjs --http --port 7430
   ```

   With no token configured on the server, leave the Token field empty.

---

## 2. Loading a panel with UXP Developer Tool

For **each** panel directory (`uxp/effectcraft-panel`, `uxp/filmcraft-panel`):

1. Open **UXP Developer Tool**.
2. Click **Add Plugin** and select the panel's `manifest.json`.
3. The plugin appears in UDT's list. Click the **⋯** menu → **Load** to load
   it into the matching Adobe app (UDT launches/attaches to the host).
4. In the host app, open the panel:
   - Premiere Pro: **Window → Extensions → Motion Studio — FilmCraft**
     (Premiere lists UXP panels under Extensions/UXP).
   - After Effects beta: **Window → Extensions** — panel name
     **Motion Studio — EffectCraft**.
5. In the panel: keep the **Server URL** as
   `http://127.0.0.1:<port>/mcp` (already the default), paste the token if
   the server requires one, click **Connect**.

On a successful connect the status pill shows
`Connected to <server name> v<version>`, the engine card fills from
`check_engine`, and the command browser loads `list_commands`. Settings
(server URL + token) are persisted to `plugin-data:/motion-studio-settings.json`
on connect; use **Clear saved settings** to reset.

> **Never use `localhost`** — the UXP URL parser resolves it differently and
> requests fail. Always use `127.0.0.1` (the defaults already do).

### Using the panels

- **Tool console** (both panels): filter/browse commands from
  `list_commands`, click one to `describe_command` (renders the schema), and
  run it through the `run_command` form (commandId, params JSON — validated
  before send — projectPath, save checkbox).
- **Approvals:** fill **Project ID / Run ID / Approved By** at the top of the
  tool console once per session. Every mutating call
  (`run_command`, `render_scene`, `render_comp`, `import_interchange`,
  `export_master`) is gated: the panel builds an approval record locally and
  sends `{ approval, projectId, runId, ...operationArgs }`. The approval's
  `argumentsSha256` is a SHA-256 (WebCrypto) over the **operation arguments
  excluding the approval field**, stable-stringified (sorted keys) and
  UTF-8 encoded — byte-for-byte the same digest rule the craft servers
  validate. Read-only tools (`check_engine`, `list_commands`,
  `describe_command`, `inspect_project`, `inspect_sequence`, `probe_media`)
  need no approval.
- **Panel-specific cards:** EffectCraft adds scene render (`render_scene`,
  receipt: verified / output / duration / sha256) and comp render
  (`render_comp` with format/resolution/channels). FilmCraft adds import
  interchange, project/sequence inspect, export master (format/quality/
  noAudio) and media probe.
- **Receipt log:** every tool call is logged newest-first with timestamp,
  tool, ok/error, expandable JSON and a **Copy JSON** button.

---

## 3. Manifest v5 host notes

- Both manifests are **manifest version 5** (`"manifestVersion": 5`), which is
  the current UXP manifest generation, with `"main": "index.html"` and the
  panel entrypoint (`minimumSize` 300×400, docked/floating 360×560).
- Network permission is scoped to the exact loopback origins per panel:
  `http://127.0.0.1:7420` + `https://127.0.0.1:7420` (EffectCraft) and the
  `7430` pair (FilmCraft). `localFileSystem: "plugin"` powers the
  `plugin-data:/` settings file, and `clipboard: "readAndWrite"` powers the
  receipt Copy-JSON button.
- If you change ports, update both the `network.domains` list in the panel's
  `manifest.json` and the Server URL default in `panel.js` — requests to
  non-permitted domains are blocked by UXP itself.

### After Effects beta caveat

After Effects UXP support is **BETA** (AE 27.1 beta, UXP 9.4). The
`"app": "AEFT", "minVersion": "27.1.0"` host entry follows the documented
manifest v5 shape, but Adobe's **ae-quick-starter** template in UDT is the
authoritative source for the AE host id while the host is in beta — if UDT
refuses to load `uxp/effectcraft-panel/manifest.json`, compare the `host`
entry against a freshly created ae-quick-starter plugin and adjust the id /
minVersion accordingly.

---

## 4. Troubleshooting

| Symptom (status pill) | Cause | Fix |
| --- | --- | --- |
| `HTTP 401/403: server token required or mismatch` | The server requires `x-motion-studio-token` and the panel sent none/wrong one | Set the same token on the server and in the panel's Token field, reconnect |
| `HTTP 404: wrong path` | The URL does not point at the server's `/mcp` route | Use the full endpoint, e.g. `http://127.0.0.1:7420/mcp` |
| `MCP request failed … server not running? Start it with: node packages/…` | Nothing is listening on the port (ECONNREFUSED) | Start the craft server in HTTP mode (commands in section 1) |
| `MCP request timed out after 5000/30000 ms` | Server accepted the socket but never answered | The client uses 5 s for connect, 30 s for calls; check the server's logs |
| Works on Windows, fails on **macOS Premiere** | Premiere's UXP networking may refuse plain `http://` loopback origins on macOS | Use `https://127.0.0.1:<port>` (declare the https origin in `manifest.json` and run the server behind local TLS) or run the panel on Windows |
| `baseUrl must be a full http(s) MCP endpoint` | URL missing scheme or using `localhost` | Use `http://127.0.0.1:<port>/mcp` — never `localhost` |
| Panel loads but Connect says `MotionStudioMcpClient is not loaded` | `mcp-http-client.js` did not load before `panel.js` | Keep the `<script>` order in `index.html` (client first) and keep the copies byte-identical |

---

## 5. Tests

From the repo root:

```bash
node --test "uxp/**/*.test.mjs"
```

The suite (12 tests) covers: stableStringify/sha256 golden vectors, the
approval record contract, full client flow (`connect` → `initialized` →
`tools/list` → `tools/call`) against a minimal fixture MCP Streamable-HTTP
server for **both panel copies and the shared module**, token mode (403
surfacing), wrong-path 404, connection refused, SSE-framed responses, the
byte-identical copy rule, and fake-DOM smoke tests that drive both panels'
UI (connect, command browser, describe, approved run) without uncaught
errors.

> Note: on this Node 24 / Windows + Git Bash setup `node --test uxp/` treats
> the directory as a file and fails before running anything — use the glob
> form above (`node --test "uxp/**/*.test.mjs"`), which is what CI-ready
> invocations should use.
