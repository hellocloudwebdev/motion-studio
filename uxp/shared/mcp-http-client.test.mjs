import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_PATH = path.join(here, 'mcp-http-client.js');
const EFFECTCRAFT_COPY = path.join(here, '..', 'effectcraft-panel', 'mcp-http-client.js');
const FILMCRAFT_COPY = path.join(here, '..', 'filmcraft-panel', 'mcp-http-client.js');
const EFFECTCRAFT_PANEL_JS = path.join(here, '..', 'effectcraft-panel', 'panel.js');
const FILMCRAFT_PANEL_JS = path.join(here, '..', 'filmcraft-panel', 'panel.js');
const SHARED_CSS = path.join(here, 'panel.css');
const EFFECTCRAFT_CSS = path.join(here, '..', 'effectcraft-panel', 'panel.css');
const FILMCRAFT_CSS = path.join(here, '..', 'filmcraft-panel', 'panel.css');

const { createMcpHttpClient, stableStringify, createApproval } = require(SHARED_PATH);

// ---------------------------------------------------------------------------
// Golden vectors for the approval digest, computed independently with
// node:crypto against the exact rule the craft servers implement
// (sha256(utf8(stableStringify(args)))). If the client and the servers ever
// disagree, byte-for-byte approval validation breaks — these vectors are the
// tripwire. The undefined-prop vector pins the subtle behavior where
// JSON.stringify(undefined) === undefined, which string-concatenates as the
// literal text "undefined".
// ---------------------------------------------------------------------------
const GOLDEN_VECTORS = [
    { label: 'sorted flat keys', args: { b: 2, a: 1, A: 'z' }, stable: '{"A":"z","a":1,"b":2}', digest: '4b7bf73a004f427cb88e059de6176b3037d466b6311fba9cf428f3ae7b2de868' },
    { label: 'nested objects and arrays', args: { z: [3, 1, { y: 'x', a: [true, null] }], a: { c: 'x', b: 2 } }, stable: '{"a":{"b":2,"c":"x"},"z":[3,1,{"a":[true,null],"y":"x"}]}', digest: 'afb62c39e101d660ccc475318dbc9585422d39f8ad489af41da1ddf162bb7620' },
    { label: 'empty object', args: {}, stable: '{}', digest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' },
    { label: 'array of objects', args: [{ b: 1, a: 2 }, ['z', 'a']], stable: '[{"a":2,"b":1},["z","a"]]', digest: 'dc905f9588fcbb49e82de8162da39356e21fd0185d3737d76457c4ae53107372' },
    { label: 'unicode and paths', args: { name: 'héllo ✓', path: 'D:/motions/scene.exr' }, stable: '{"name":"héllo ✓","path":"D:/motions/scene.exr"}', digest: '2bd48ab03abb45fe94d84e2e4c97afa82ca488cebf0751bfda21ec16e3fc2c48' },
    { label: 'run_command payload', args: { commandId: 'scene.render', params: { sceneId: 'sc-01', quality: 2 }, projectPath: 'D:/motions/demo.ecproj', save: true }, stable: '{"commandId":"scene.render","params":{"quality":2,"sceneId":"sc-01"},"projectPath":"D:/motions/demo.ecproj","save":true}', digest: '5d01c0c555734ee890581af541b61311a45e09367716b6daf97156caa0402028' },
    { label: 'undefined property concatenates as text', args: { a: undefined, b: null }, stable: '{"a":undefined,"b":null}', digest: '1bd7135b0bad947188e8aa54a422c973ed6c0d2062b3ee890a15cf633d074560' },
    { label: 'NaN serializes as null', args: { n: NaN }, stable: '{"n":null}', digest: '5b4da02351c1c20974b216a5e3a4edb59ac51cbda6be3e9d82952b4f5beea463' }
];

// ---------------------------------------------------------------------------
// Minimal MCP Streamable-HTTP fixture server (stand-in for the craft servers).
// POST /mcp only; initialize -> 200 + Mcp-Session-Id header; initialized
// notification -> 202 empty; tools/list -> two tools (optionally SSE-framed);
// tools/call -> JSON receipt; optional mandatory x-motion-studio-token.
// ---------------------------------------------------------------------------
const FIXTURE_TOKEN = 'fixture-token-1234';
const FIXTURE_TOOLS = [
    { name: 'fixture_echo', description: 'Echoes the arguments back as a JSON receipt.', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    { name: 'fixture_fail', description: 'Always answers isError true to exercise faithful error surfacing.', inputSchema: { type: 'object' } }
];

async function startFixture({ requireToken = false, sseToolsList = false } = {}) {
    const seen = [];
    const sessions = new Set();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const record = {
                method: req.method,
                url: req.url,
                sessionHeader: req.headers['mcp-session-id'] || null,
                protocolHeader: req.headers['mcp-protocol-version'] || null,
                tokenHeader: req.headers['x-motion-studio-token'] || null,
                acceptHeader: req.headers['accept'] || null,
                contentTypeHeader: req.headers['content-type'] || null
            };
            seen.push(record);
            const reply = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };
            const rpcError = (status, id, code, message) => reply(status, { 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));

            if (req.method !== 'POST' || req.url !== '/mcp') {
                reply(404, { 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'fixture: unknown route' } }));
                return;
            }
            let message;
            try { message = JSON.parse(raw); } catch {
                reply(400, { 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'fixture: parse error' } }));
                return;
            }
            if (requireToken && record.tokenHeader !== FIXTURE_TOKEN) {
                rpcError(403, message.id ?? null, -32001, 'forbidden: x-motion-studio-token missing or wrong');
                return;
            }
            if (message.method === 'initialize') {
                // Deliberately mixed-case header name: the client must capture the
                // session id case-insensitively.
                const sessionId = 'fixture-session-' + (sessions.size + 1);
                sessions.add(sessionId);
                reply(200, {
                    'content-type': 'application/json',
                    'McP-SeSsIoN-Id': sessionId,
                    'mcp-protocol-version': '2025-06-18'
                }, JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'fixture', version: '0.0.1' },
                        instructions: 'minimal fixture server'
                    }
                }));
                return;
            }
            if (message.method === 'notifications/initialized') {
                reply(202, {}, '');
                return;
            }
            if (!record.sessionHeader || !sessions.has(record.sessionHeader)) {
                rpcError(400, message.id ?? null, -32000, 'fixture: missing or unknown mcp-session-id');
                return;
            }
            if (message.method === 'tools/list') {
                const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: FIXTURE_TOOLS } });
                if (sseToolsList) {
                    reply(200, { 'content-type': 'text/event-stream' }, ': fixture heartbeat\n\nevent: message\ndata: ' + body + '\n\n');
                } else {
                    reply(200, { 'content-type': 'application/json' }, body);
                }
                return;
            }
            if (message.method === 'tools/call') {
                const name = message.params && message.params.name;
                const args = (message.params && message.params.arguments) || {};
                const callResult = (payload, isError = false) => reply(200, { 'content-type': 'application/json' }, JSON.stringify({
                    jsonrpc: '2.0', id: message.id,
                    result: { isError, content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] }
                }));
                if (name === 'fixture_fail') {
                    callResult('fixture boom: ' + JSON.stringify(args), true);
                    return;
                }
                if (name === 'list_commands') {
                    callResult({ commands: [{ commandId: 'fixture.echo', summary: 'Echo fixture' }, { commandId: 'fixture.boom', summary: 'Always fails' }] });
                    return;
                }
                if (name === 'describe_command') {
                    callResult({
                        commandId: args.commandId,
                        description: 'Fixture command ' + String(args.commandId),
                        schema: { type: 'object', properties: { value: { type: 'string' } } }
                    });
                    return;
                }
                callResult({ ok: true, tool: name, echoed: args });
                return;
            }
            rpcError(200, message.id ?? null, -32601, 'fixture: unknown method ' + String(message.method));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        port,
        seen,
        url: 'http://127.0.0.1:' + port + '/mcp',
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
}

test('stableStringify golden vectors match the craft-server digest rule', () => {
    for (const vector of GOLDEN_VECTORS) {
        assert.equal(stableStringify(vector.args), vector.stable, 'stable form mismatch for: ' + vector.label);
        assert.equal(createHash('sha256').update(vector.stable).digest('hex'), vector.digest, 'independent sha256 of the stable form must equal the golden digest: ' + vector.label);
    }
});

test('createApproval builds a record whose digest matches the golden vectors', async () => {
    const now = Date.parse('2026-11-19T12:00:00.000Z');
    const args = { commandId: 'scene.render', params: { sceneId: 'sc-01', quality: 2 }, projectPath: 'D:/motions/demo.ecproj', save: true };
    const approval = await createApproval({ projectId: 'p1', runId: 'r1', app: 'effectcraft', toolName: 'effectcraft.run_command', args, approvedBy: ' producer ', now });
    assert.equal(approval.approved, true);
    assert.equal(approval.projectId, 'p1');
    assert.equal(approval.runId, 'r1');
    assert.equal(approval.app, 'effectcraft');
    assert.equal(approval.toolName, 'effectcraft.run_command');
    assert.equal(approval.approvedBy, 'producer', 'approvedBy must be trimmed');
    assert.equal(approval.argumentsSha256, GOLDEN_VECTORS.find(v => v.label === 'run_command payload').digest);
    assert.match(approval.approvalId, /^[0-9a-f-]{36}$/, 'approvalId looks like a UUID');
    assert.equal(approval.approvedAt, '2026-11-19T12:00:00.000Z');
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt), 600000, 'default expiry is 10 minutes');

    const custom = await createApproval({ projectId: 'p', runId: 'r', app: 'filmcraft', toolName: 'export_master', args: {}, approvedBy: 'a', expiresInMs: 60000, now });
    assert.equal(Date.parse(custom.expiresAt) - Date.parse(custom.approvedAt), 60000);
    assert.equal(custom.argumentsSha256, GOLDEN_VECTORS.find(v => v.label === 'empty object').digest, 'nullish args digest over {}');
    const nullArgs = await createApproval({ projectId: 'p', runId: 'r', app: 'filmcraft', toolName: 't', args: null, approvedBy: 'a', now });
    assert.equal(nullArgs.argumentsSha256, GOLDEN_VECTORS.find(v => v.label === 'empty object').digest);
});

test('createApproval rejects missing scope, actor and unbounded expiry', async () => {
    await assert.rejects(createApproval({ runId: 'r', app: 'effectcraft', toolName: 't', approvedBy: 'a' }), /projectId/);
    await assert.rejects(createApproval({ projectId: 'p', app: 'effectcraft', toolName: 't', approvedBy: 'a' }), /runId/);
    await assert.rejects(createApproval({ projectId: 'p', runId: 'r', toolName: 't', approvedBy: 'a' }), /app/);
    await assert.rejects(createApproval({ projectId: 'p', runId: 'r', app: 'photoshop', toolName: 't', approvedBy: 'a' }), /effectcraft.*filmcraft/);
    await assert.rejects(createApproval({ projectId: 'p', runId: 'r', app: 'filmcraft', toolName: 't', approvedBy: '   ' }), /approvedBy/);
    await assert.rejects(createApproval({ projectId: 'p', runId: 'r', app: 'filmcraft', toolName: 't', approvedBy: 'a', expiresInMs: 0 }), /expiry/);
    await assert.rejects(createApproval({ projectId: 'p', runId: 'r', app: 'filmcraft', toolName: 't', approvedBy: 'a', expiresInMs: 3600001 }), /expiry/);
});

test('createMcpHttpClient fails fast without a fetch implementation', () => {
    const realFetch = globalThis.fetch;
    delete globalThis.fetch;
    try {
        assert.throws(() => createMcpHttpClient({ baseUrl: 'http://127.0.0.1:7420/mcp' }), /fetch implementation/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('createMcpHttpClient rejects non-http or localhost-style baseUrl', () => {
    assert.throws(() => createMcpHttpClient({ baseUrl: 'ftp://127.0.0.1:7420/mcp' }), /http\(s\) MCP endpoint/);
    assert.throws(() => createMcpHttpClient({ baseUrl: '' }), /http\(s\) MCP endpoint/);
});

test('full panel flow against one fixture: connect -> initialized -> listTools -> callTool (both panel copies + shared)', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const clients = [
        ['shared', require(SHARED_PATH)],
        ['effectcraft copy', require(EFFECTCRAFT_COPY)],
        ['filmcraft copy', require(FILMCRAFT_COPY)]
    ];
    for (const [label, moduleExports] of clients) {
        const client = moduleExports.createMcpHttpClient({ baseUrl: fixture.url });
        const serverInfo = await client.connect();
        assert.deepEqual(serverInfo, { name: 'fixture', version: '0.0.1' }, label + ': serverInfo captured');
        assert.ok(client.sessionId, label + ': session id captured from the (mixed-case) header');
        assert.equal(client.protocolVersion, '2025-06-18', label + ': negotiated protocol version stored');

        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map(tool => tool.name), ['fixture_echo', 'fixture_fail'], label + ': tools listed');

        const echo = await client.callTool('fixture_echo', { value: 'hi', nested: { b: 2, a: 1 } });
        assert.equal(echo.isError, false, label + ': echo isError false');
        assert.equal(echo.data.ok, true, label + ': content[].text parsed as JSON (data)');
        assert.deepEqual(echo.data.echoed, { value: 'hi', nested: { b: 2, a: 1 } }, label + ': args echoed verbatim');
        assert.equal(typeof echo.text, 'string', label + ': raw text surfaced');

        const failed = await client.callTool('fixture_fail', {});
        assert.equal(failed.isError, true, label + ': isError surfaced faithfully');
        assert.equal(failed.data, undefined, label + ': failing receipt is not JSON, data stays undefined');
        assert.match(failed.text, /fixture boom/, label + ': failing receipt text preserved');

        await client.close();
        assert.equal(client.sessionId, null, label + ': session cleared on close');
    }

    const initializeSeen = fixture.seen.find(r => r.url === '/mcp');
    assert.equal(initializeSeen.method, 'POST');
    assert.equal(initializeSeen.acceptHeader, 'application/json, text/event-stream', 'initialize sends the streamable-HTTP Accept pair');
    assert.equal(initializeSeen.contentTypeHeader, 'application/json');
    assert.equal(initializeSeen.sessionHeader, null, 'initialize carries no session id yet');
    const initialized = fixture.seen.find(r => r.sessionHeader && r.protocolHeader);
    assert.ok(initialized, 'post-initialize requests carry session + protocol headers');
    assert.match(initialized.sessionHeader, /^fixture-session-/);
    assert.equal(initialized.protocolHeader, '2025-06-18');
    assert.ok(fixture.seen.some(r => r.method === 'DELETE'), 'close() DELETEs the session endpoint');
});

test('token mode: absent or wrong token surfaces the 403 clearly, right token connects', async (t) => {
    const fixture = await startFixture({ requireToken: true });
    t.after(() => fixture.close());

    const noToken = createMcpHttpClient({ baseUrl: fixture.url });
    await assert.rejects(noToken.connect(), /token required or mismatch.*x-motion-studio-token/i);
    assert.equal(noToken.sessionId, null, 'no session is stored on rejection');

    const wrongToken = createMcpHttpClient({ baseUrl: fixture.url, token: 'not-the-token' });
    await assert.rejects(wrongToken.connect(), /token required or mismatch/);

    const beforeRight = fixture.seen.length;
    const rightToken = createMcpHttpClient({ baseUrl: fixture.url, token: FIXTURE_TOKEN });
    await rightToken.connect();
    const tools = await rightToken.listTools();
    assert.equal(tools.tools.length, 2);
    assert.equal(fixture.seen.slice(beforeRight).every(record => record.tokenHeader === FIXTURE_TOKEN), true, 'every authenticated request carries the token header');
    await rightToken.close();
});

test('wrong path (404) and connection refused surface descriptive errors with the start command', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());

    const wrongPath = createMcpHttpClient({ baseUrl: fixture.url.replace('/mcp', '/wrong') });
    await assert.rejects(wrongPath.connect(), /404.*wrong path/);

    // Grab an ephemeral port and release it: connecting there is refused.
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = probe.address().port;
    await new Promise(resolve => probe.close(() => resolve()));
    const refused = createMcpHttpClient({ baseUrl: 'http://127.0.0.1:' + deadPort + '/mcp' });
    await assert.rejects(refused.connect(), err => {
        assert.match(err.message, /server not running/);
        // The dead port is not one of the known MCP ports, so the hint falls
        // back to the generic craft package path.
        assert.match(err.message, /start it with: node packages\/.*-mcp-server\/src\/index\.mjs --http/i);
        return true;
    });
});

test('SSE-framed responses are parsed (data: payload matching the request id)', async (t) => {
    const fixture = await startFixture({ sseToolsList: true });
    t.after(() => fixture.close());
    const client = createMcpHttpClient({ baseUrl: fixture.url });
    await client.connect();
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['fixture_echo', 'fixture_fail'], 'tools parsed out of the SSE stream');
    const sseRecord = fixture.seen.filter(r => r.method === 'POST' && r.sessionHeader).pop();
    assert.ok(sseRecord, 'SSE request carried the session id');
    await client.close();
});

test('panel copies are byte-identical to the shared client (and stylesheet)', () => {
    const shared = readFileSync(SHARED_PATH);
    assert.deepEqual(readFileSync(EFFECTCRAFT_COPY), shared, 'effectcraft copy must be byte-identical to shared');
    assert.deepEqual(readFileSync(FILMCRAFT_COPY), shared, 'filmcraft copy must be byte-identical to shared');
    assert.match(shared.toString('utf8'), /copy of \.\.\/shared\/mcp-http-client\.js — keep in sync/, 'copies carry the keep-in-sync header');
    const css = readFileSync(SHARED_CSS);
    assert.deepEqual(readFileSync(EFFECTCRAFT_CSS), css, 'effectcraft panel.css must be byte-identical to shared');
    assert.deepEqual(readFileSync(FILMCRAFT_CSS), css, 'filmcraft panel.css must be byte-identical to shared');
});

// ---------------------------------------------------------------------------
// Fake-DOM smoke tests: both panel.js files must build their full UI and land
// every failure (dead server, server-side error) in the status pill and the
// receipt log — never as an uncaught exception. UXP DOM is stubbed with the
// minimal surface the panel uses (createElement/textContent/appendChild/…).
// ---------------------------------------------------------------------------
function FakeNode(tag) {
    this.tagName = tag;
    this.children = [];
    this.className = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.placeholder = '';
    this.disabled = false;
    this._listeners = {};
    this._text = undefined;
}
// Mirror real DOM semantics: assigning textContent replaces the children with
// plain text; reading it returns the assigned text or the concatenated tree.
Object.defineProperty(FakeNode.prototype, 'textContent', {
    get() {
        if (this._text !== undefined) return this._text;
        return this.children.map(child => child.textContent).join('');
    },
    set(value) {
        this._text = String(value);
        this.children = [];
    }
});
FakeNode.prototype.appendChild = function (child) { this.children.push(child); return child; };
FakeNode.prototype.insertBefore = function (child, ref) {
    let index = ref ? this.children.indexOf(ref) : 0;
    if (index < 0) index = 0;
    this.children.splice(index, 0, child);
    return child;
};
FakeNode.prototype.removeChild = function (child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
};
Object.defineProperty(FakeNode.prototype, 'firstChild', { get() { return this.children[0] || null; } });
Object.defineProperty(FakeNode.prototype, 'lastChild', { get() { return this.children[this.children.length - 1] || null; } });
FakeNode.prototype.addEventListener = function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); };
FakeNode.prototype.dispatch = function (type, event) { (this._listeners[type] || []).slice().forEach(fn => fn.call(this, event)); };

function findAll(node, predicate, out) {
    out = out || [];
    if (predicate(node)) out.push(node);
    for (const child of node.children) findAll(child, predicate, out);
    return out;
}

function installFakeDom(mcpModule) {
    const realWindow = globalThis.window;
    const realDocument = globalThis.document;
    globalThis.window = { MotionStudioMcpClient: mcpModule };
    globalThis.document = { createElement: tag => new FakeNode(tag) };
    return () => {
        globalThis.window = realWindow;
        globalThis.document = realDocument;
    };
}

function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('both panel.js files build their UI, browse commands and run an approved command end-to-end', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const restoreDom = installFakeDom(require(SHARED_PATH));
    t.after(restoreDom);
    const panelSpecs = [
        ['effectcraft', require(EFFECTCRAFT_PANEL_JS), 'effectcraft.run_command',
            ['Render scene', 'Render comp', 'Set blend mode', 'Set track matte', 'Set parent', 'Add mask', 'Add marker', 'Set work area', 'Import timeline', 'Export Lottie', 'Export timeline', 'Render queue', 'List fonts'],
            ['Layer properties (gated)', 'Composition extras (gated)', 'Timeline interchange (gated)', 'Export / queue (ungated)']],
        ['filmcraft', require(FILMCRAFT_PANEL_JS), 'filmcraft.run_command',
            ['Import interchange', 'Inspect project', 'Inspect sequence', 'Export master', 'Probe media', 'Export frame', 'Add captions', 'Import captions', 'Export captions', 'Inspect mixer', 'Set audio gain', 'Auto match loudness', 'Generate ducking', 'List TTS voices', 'Download voices', 'Create narration', 'Add markers', 'Speed clip', 'Detect scene cuts'],
            ['Captions', 'Audio mix', 'Narration (TTS)', 'Markers & timing']]
    ];
    for (const [name, panelModule, runTool, extraButtons, newCardTitles] of panelSpecs) {
        assert.ok(panelModule.panels && panelModule.panels.main && typeof panelModule.panels.main.create === 'function', name + ': panels.main.create exported');
        const root = new FakeNode('div');
        panelModule.panels.main.create(root);

        const buttons = findAll(root, node => node.tagName === 'button').map(node => node.textContent);
        for (const expected of ['Connect', 'Disconnect', 'Clear saved settings', 'Refresh', 'Run', ...extraButtons]) {
            assert.ok(buttons.includes(expected), name + ': button "' + expected + '" present (got: ' + buttons.join(', ') + ')');
        }
        const cardTitles = findAll(root, node => node.tagName === 'h3').map(node => node.textContent);
        for (const expected of newCardTitles) {
            assert.ok(cardTitles.includes(expected), name + ': card "' + expected + '" present (got: ' + cardTitles.join(' | ') + ')');
        }

        // Connect to the live fixture through the UI.
        const urlInput = findAll(root, node => node.tagName === 'input' && node.placeholder && node.placeholder.indexOf('/mcp') !== -1)[0];
        assert.ok(urlInput, name + ': server URL field present');
        urlInput.value = fixture.url;
        findAll(root, node => node.tagName === 'button' && node.textContent === 'Connect')[0].dispatch('click', {});
        await waitMs(250);
        const pill = findAll(root, node => node.className.indexOf('status-pill') !== -1)[0];
        assert.match(pill.className, /is-connected/, name + ': status pill shows connected');
        assert.match(pill.textContent, /Connected to fixture v0\.0\.1/, name + ': pill names the server and version from serverInfo');
        const receiptTools = findAll(root, node => node.className === 'receipt-tool').map(node => node.textContent);
        assert.ok(receiptTools.includes('connect'), name + ': connect receipt logged');

        // Command browser: Refresh populates the list from the fixture.
        const refreshButton = findAll(root, node => node.tagName === 'button' && node.textContent === 'Refresh')[0];
        refreshButton.dispatch('click', {});
        await waitMs(200);
        const notes = findAll(root, node => node.className === 'list-note').map(node => node.textContent);
        assert.match(notes.join(' '), /2 commands/, name + ': list_commands populated the browser');
        const commandItems = findAll(root, node => node.className.indexOf('cmd-item') !== -1);
        assert.equal(commandItems.length, 2, name + ': two fixture commands rendered');

        // Clicking a command stages it and renders the schema description.
        commandItems[0].dispatch('click', {});
        await waitMs(200);
        const commandIdInput = findAll(root, node => node.tagName === 'input' && node.placeholder && node.placeholder.indexOf('command id') !== -1)[0];
        assert.equal(commandIdInput.value, 'fixture.echo', name + ': clicking a command stages its id in the run form');
        const describeTexts = findAll(root, node => node.className === 'json').map(node => node.textContent).join('\n');
        assert.match(describeTexts, /Fixture command fixture\.echo/, name + ': describe_command rendered');

        // Fill the approval identity and run the staged command.
        const textInputs = findAll(root, node => node.tagName === 'input' && node.type === 'text');
        const projectIdInput = textInputs.find(node => node.placeholder === 'project id');
        projectIdInput.value = 'p1';
        const runIdInput = textInputs.find(node => node.placeholder === 'run id');
        runIdInput.value = 'r1';
        const approvedByInput = textInputs.find(node => node.placeholder === 'approved by');
        approvedByInput.value = ' producer ';
        const paramsTextarea = findAll(root, node => node.tagName === 'textarea')[0];
        paramsTextarea.value = '{"value":"hi"}';
        const runButton = findAll(root, node => node.tagName === 'button' && node.textContent === 'Run')[0];
        runButton.dispatch('click', {});
        await waitMs(250);

        // The fixture echoes the exact tool arguments back, so the approval
        // record can be verified byte-for-byte against the SERVER's opArgs
        // shape: the gate digests the resolved operation arguments INCLUDING
        // projectId/runId/timeoutMs (and projectPath present-as-undefined —
        // the panel now builds exactly this shape; see approvedCall).
        const opArgs = { projectId: 'p1', runId: 'r1', commandId: 'fixture.echo', params: { value: 'hi' }, projectPath: undefined, save: false, timeoutMs: undefined };
        const expectedDigest = createHash('sha256').update(stableStringify(opArgs)).digest('hex');
        // Receipts are prepended newest-first: the run we just triggered is the
        // newest call receipt, and the fixture echo names the tool.
        const latestCallReceipt = parseLatestCallReceipt(root);
        assert.ok(latestCallReceipt, name + ': newest receipt is a parseable call receipt');
        assert.equal(latestCallReceipt.result.data.tool, runTool, name + ': ' + runTool + ' receipt logged newest-first');
        const echoed = latestCallReceipt.result.data.echoed;
        assert.equal(echoed.approval.approved, true, name + ': approval sent with the tool call');
        assert.equal(echoed.approval.toolName, runTool, name + ': approval toolName is app-prefixed');
        assert.equal(echoed.approval.approvedBy, 'producer', name + ': approvedBy trimmed into the approval');
        assert.equal(echoed.approval.argumentsSha256, expectedDigest, name + ': approval digest covers exactly the operation args minus approval');
        assert.equal(echoed.projectId, 'p1', name + ': projectId travels with the tool call');
        assert.equal(echoed.runId, 'r1', name + ': runId travels with the tool call');
        const allReceiptTools = findAll(root, node => node.className === 'receipt-tool').map(node => node.textContent);
        assert.ok(allReceiptTools.includes('describe_command') && allReceiptTools.includes('list_commands'), name + ': list/describe receipts logged');
    }
});

test('panel-minted approvals validate against the real server approval gates', async () => {
    // The definitive regression net for the panel↔server digest contract: the
    // approval created the way the panels mint it (createApproval over the
    // server's resolved opArgs shape) must pass packages/craft-mcp-client's
    // validateCraftOperationApproval — the exact gate both studio servers run.
    const { validateCraftOperationApproval } = await import('../../packages/craft-mcp-client/src/index.mjs');
    const now = Date.now();
    // The servers' opArgs constructions, mirrored from
    // packages/effectcraft-mcp-server/src/index.mjs and
    // packages/filmcraft-mcp-server/src/index.mjs. If a server changes its
    // opArgs shape, update the shape here AND the panel card — together.
    const shapes = {
        'effectcraft.run_command': fields => ({ projectId: 'p1', runId: 'r1', commandId: fields.commandId, params: fields.params, projectPath: fields.projectPath, save: fields.save, timeoutMs: fields.timeoutMs }),
        'effectcraft.run_batch': fields => ({ projectId: 'p1', runId: 'r1', commands: fields.commands, projectPath: fields.projectPath, saveAs: fields.saveAs, timeoutMs: fields.timeoutMs }),
        'filmcraft.run_command': fields => ({ projectId: 'p1', runId: 'r1', commandId: fields.commandId, params: fields.params, projectPath: fields.projectPath, save: fields.save, timeoutMs: fields.timeoutMs }),
        'filmcraft.run_batch': fields => ({ projectId: 'p1', runId: 'r1', commands: fields.commands, projectPath: fields.projectPath, saveAs: fields.saveAs, timeoutMs: fields.timeoutMs }),
        'filmcraft.import_interchange': fields => ({ projectId: 'p1', runId: 'r1', fcpxmlPath: fields.fcpxmlPath, projectPath: fields.projectPath, timeoutMs: fields.timeoutMs }),
        'filmcraft.apply_transition': fields => ({ projectId: 'p1', runId: 'r1', projectPath: fields.projectPath, track: 'V1', clipOrdinal: 1, effect: 'cross_dissolve', frames: 12, timeoutMs: fields.timeoutMs })
    };
    const fieldSets = {
        'effectcraft.run_command': { commandId: 'comp.new', params: {}, projectPath: undefined, save: false, timeoutMs: undefined },
        'effectcraft.run_batch': { commands: [{ id: 'file.newProject', params: {} }], projectPath: undefined, saveAs: undefined, timeoutMs: undefined },
        'filmcraft.run_command': { commandId: 'file.newBin', params: { name: 'Selects' }, projectPath: 'D:/demo.fcproj', save: true, timeoutMs: undefined },
        'filmcraft.run_batch': { commands: [{ id: 'file.importDemoFootage', params: { scene: 'Plasma' } }], projectPath: 'D:/demo.fcproj', saveAs: undefined, timeoutMs: undefined },
        'filmcraft.import_interchange': { fcpxmlPath: 'D:/demo/ms.fcpxml', projectPath: 'D:/demo/p.fcproj', timeoutMs: undefined },
        'filmcraft.apply_transition': { projectPath: 'D:/demo/p.fcproj', timeoutMs: undefined }
    };
    for (const [toolName, shape] of Object.entries(shapes)) {
        const app = toolName.split('.')[0];
        const opArgs = shape(fieldSets[toolName]);
        const approval = await createApproval({ projectId: 'p1', runId: 'r1', app, toolName, args: opArgs, approvedBy: 'producer', now });
        const check = validateCraftOperationApproval({ approval, projectId: 'p1', runId: 'r1', app, toolName, args: opArgs, now });
        assert.equal(check.valid, true, toolName + ': panel-minted approval passes the real gate (' + check.reason + ')');
        // Any changed operation field must break the digest.
        const tampered = JSON.parse(JSON.stringify(fieldSets[toolName]));
        if (typeof tampered.save === 'boolean') tampered.save = !tampered.save;
        else if (tampered.params) tampered.params = { name: 'Tampered' };
        else if (tampered.commands) tampered.commands = [{ id: 'file.newBin', params: {} }];
        else if (tampered.fcpxmlPath) tampered.fcpxmlPath = 'D:/other.fcpxml';
        else tampered.projectPath = 'D:/other.fcproj';
        const refused = validateCraftOperationApproval({ approval, projectId: 'p1', runId: 'r1', app, toolName, args: shape(tampered), now });
        assert.equal(refused.valid, false, toolName + ': tampered operation args are refused');
    }
});

test('new gated cards digest the exact server opArgs shape (blend mode row + audio gain row)', async (t) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const restoreDom = installFakeDom(require(SHARED_PATH));
    t.after(restoreDom);

    // --- EffectCraft: the blend-mode row of the "Layer properties (gated)" card ---
    const ecRoot = new FakeNode('div');
    require(EFFECTCRAFT_PANEL_JS).panels.main.create(ecRoot);
    emulateSelectDefaults(ecRoot);
    const ecUrlInput = findAll(ecRoot, node => node.tagName === 'input' && node.placeholder && node.placeholder.indexOf('/mcp') !== -1)[0];
    assert.ok(ecUrlInput, 'effectcraft: server URL field present');
    ecUrlInput.value = fixture.url;
    findAll(ecRoot, node => node.tagName === 'button' && node.textContent === 'Connect')[0].dispatch('click', {});
    await waitMs(250);
    const ecPill = findAll(ecRoot, node => node.className.indexOf('status-pill') !== -1)[0];
    assert.match(ecPill.className, /is-connected/, 'effectcraft: connected to the fixture');

    fillApprovalIdentity(ecRoot, 'p1', 'r1', ' producer ');
    // Several cards share the projectPath/compId placeholders — fill every
    // occurrence with the same value; only the blend-mode row is driven.
    for (const input of findAll(ecRoot, node => node.tagName === 'input' && node.placeholder === 'path to .aep / .ecproj')) input.value = 'D:/motions/demo.ecproj';
    for (const input of findAll(ecRoot, node => node.tagName === 'input' && node.placeholder === 'comp id')) input.value = 'main-comp';
    const layerInput = findAll(ecRoot, node => node.tagName === 'input' && node.placeholder === 'layer name')[0];
    assert.ok(layerInput, 'effectcraft: layer field present in the Layer properties card');
    layerInput.value = 'Layer 1';
    findAll(ecRoot, node => node.tagName === 'button' && node.textContent === 'Set blend mode')[0].dispatch('click', {});
    await waitMs(250);

    const ecReceipt = parseLatestCallReceipt(ecRoot);
    assert.ok(ecReceipt, 'effectcraft: blend-mode call receipt logged');
    assert.equal(ecReceipt.result.data.tool, 'effectcraft.set_blend_mode', 'effectcraft: set_blend_mode receipt newest-first');
    const ecEchoed = ecReceipt.result.data.echoed;
    // Exactly the server's resolved opArgs for effectcraft.set_blend_mode
    // (projectPath included — the gate digests the destructured object):
    // { projectId, runId, projectPath, compId, layer, mode, timeoutMs }.
    const ecOpArgs = { projectId: 'p1', runId: 'r1', projectPath: 'D:/motions/demo.ecproj', compId: 'main-comp', layer: 'Layer 1', mode: 'Normal', timeoutMs: undefined };
    assert.equal(ecEchoed.approval.argumentsSha256, createHash('sha256').update(stableStringify(ecOpArgs)).digest('hex'), 'effectcraft: digest covers exactly the server opArgs (timeoutMs present as undefined)');
    assert.ok(!('timeoutMs' in ecEchoed), 'effectcraft: undefined timeoutMs is absent from the SENT JSON but present in the digest input');
    assert.equal(ecEchoed.projectId, 'p1', 'effectcraft: projectId travels with the tool call');
    assert.equal(ecEchoed.mode, 'Normal', 'effectcraft: blend mode select value sent verbatim');
    assert.equal(ecEchoed.approval.approvedBy, 'producer', 'effectcraft: approvedBy trimmed into the approval');

    // --- FilmCraft: the audio-gain row of the "Audio mix" card ---
    const fcRoot = new FakeNode('div');
    require(FILMCRAFT_PANEL_JS).panels.main.create(fcRoot);
    emulateSelectDefaults(fcRoot);
    const fcUrlInput = findAll(fcRoot, node => node.tagName === 'input' && node.placeholder && node.placeholder.indexOf('/mcp') !== -1)[0];
    assert.ok(fcUrlInput, 'filmcraft: server URL field present');
    fcUrlInput.value = fixture.url;
    findAll(fcRoot, node => node.tagName === 'button' && node.textContent === 'Connect')[0].dispatch('click', {});
    await waitMs(250);
    const fcPill = findAll(fcRoot, node => node.className.indexOf('status-pill') !== -1)[0];
    assert.match(fcPill.className, /is-connected/, 'filmcraft: connected to the fixture');

    fillApprovalIdentity(fcRoot, 'p1', 'r1', ' producer ');
    for (const input of findAll(fcRoot, node => node.tagName === 'input' && node.placeholder === 'path to .prproj / .fcproj')) input.value = 'D:/motions/demo.fcproj';
    const ordinalInput = findAll(fcRoot, node => node.tagName === 'input' && node.placeholder === 'clip ordinal (1 = first audio clip)')[0];
    assert.ok(ordinalInput, 'filmcraft: clipOrdinal field present in the Audio mix card');
    ordinalInput.value = '1';
    const dbInput = findAll(fcRoot, node => node.tagName === 'input' && node.placeholder === 'gain dB (-96 to 24)')[0];
    assert.ok(dbInput, 'filmcraft: db field present in the Audio mix card');
    dbInput.value = '-3';
    // clipId stays blank: the optional key must be absent from the SENT JSON
    // while still digesting as literal "undefined".
    findAll(fcRoot, node => node.tagName === 'button' && node.textContent === 'Set audio gain')[0].dispatch('click', {});
    await waitMs(250);

    const fcReceipt = parseLatestCallReceipt(fcRoot);
    assert.ok(fcReceipt, 'filmcraft: audio gain call receipt logged');
    assert.equal(fcReceipt.result.data.tool, 'filmcraft.set_clip_audio_gain', 'filmcraft: set_clip_audio_gain receipt newest-first');
    const fcEchoed = fcReceipt.result.data.echoed;
    // Exactly the server's resolved opArgs for filmcraft.set_clip_audio_gain:
    // { projectId, runId, projectPath, clipOrdinal, clipId, mode, db, timeoutMs }.
    const fcOpArgs = { projectId: 'p1', runId: 'r1', projectPath: 'D:/motions/demo.fcproj', clipOrdinal: 1, clipId: undefined, mode: 'set', db: -3, timeoutMs: undefined };
    assert.equal(fcEchoed.approval.argumentsSha256, createHash('sha256').update(stableStringify(fcOpArgs)).digest('hex'), 'filmcraft: digest covers exactly the server opArgs (clipId/timeoutMs present as undefined)');
    assert.ok(!('clipId' in fcEchoed), 'filmcraft: blank optional clipId is absent from the SENT JSON but present in the digest input');
    assert.ok(!('timeoutMs' in fcEchoed), 'filmcraft: undefined timeoutMs is absent from the SENT JSON but present in the digest input');
    assert.equal(fcEchoed.clipOrdinal, 1, 'filmcraft: clipOrdinal parsed to a number');
    assert.equal(fcEchoed.db, -3, 'filmcraft: db parsed to a number');
    assert.equal(fcEchoed.mode, 'set', 'filmcraft: gain mode select default sent verbatim');
    assert.equal(fcEchoed.approval.toolName, 'filmcraft.set_clip_audio_gain', 'filmcraft: approval toolName is app-prefixed');
});

function emulateSelectDefaults(root) {
    // Real DOM selects report the first option as their value; FakeNode starts
    // at '' — emulate the default selection before driving card handlers.
    for (const select of findAll(root, node => node.tagName === 'select')) {
        select.value = select.children.length ? select.children[0].value : '';
    }
}

function fillApprovalIdentity(root, projectId, runId, approvedBy) {
    const textInputs = findAll(root, node => node.tagName === 'input' && node.type === 'text');
    textInputs.find(node => node.placeholder === 'project id').value = projectId;
    textInputs.find(node => node.placeholder === 'run id').value = runId;
    textInputs.find(node => node.placeholder === 'approved by').value = approvedBy;
}

function parseLatestCallReceipt(root) {
    // Receipt details start collapsed: class is "receipt-detail collapsed".
    const detailPres = findAll(root, node => node.className.indexOf('receipt-detail') === 0 && node.children[0]);
    for (const pre of detailPres) {
        try {
            const parsed = JSON.parse(pre.textContent);
            if (parsed && parsed.args && parsed.result && parsed.result.data) return parsed;
        } catch { /* not a tool-call receipt (e.g. plain error entry) — keep scanning */ }
    }
    return null;
}

test('both panel.js files survive a refused server without uncaught errors', async (t) => {
    const restoreDom = installFakeDom(require(SHARED_PATH));
    t.after(restoreDom);
    const uncaught = [];
    const onUncaught = err => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    t.after(() => {
        process.removeListener('uncaughtException', onUncaught);
        process.removeListener('unhandledRejection', onUncaught);
    });
    for (const panelModule of [require(EFFECTCRAFT_PANEL_JS), require(FILMCRAFT_PANEL_JS)]) {
        const root = new FakeNode('div');
        panelModule.panels.main.create(root);
        // Default baseUrl points at 127.0.0.1:7420/7430 — nothing is listening there.
        const connectButton = findAll(root, node => node.tagName === 'button' && node.textContent === 'Connect')[0];
        connectButton.dispatch('click', {});
        await waitMs(400);
        const pill = findAll(root, node => node.className.indexOf('status-pill') !== -1)[0];
        assert.match(pill.className, /is-error/, 'refused connection lands in the status pill');
        assert.match(pill.textContent, /server not running/, 'refused connection suggests the start command');
        const errorTags = findAll(root, node => node.className === 'tag-err');
        assert.ok(errorTags.length >= 1, 'refused connection is logged in the receipt log');
    }
    assert.deepEqual(uncaught, [], 'no uncaught exceptions or unhandled rejections from panel handlers');
});
