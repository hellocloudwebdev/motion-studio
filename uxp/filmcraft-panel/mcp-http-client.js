/*
 * Motion Studio MCP client over Streamable HTTP for UXP panels.
 * Canonical source: uxp/shared/mcp-http-client.js — the effectcraft-panel and
 * filmcraft-panel copies (copy of ../shared/mcp-http-client.js — keep in sync)
 * must stay byte-identical to this file; uxp/shared/mcp-http-client.test.mjs
 * enforces that. UXP plugins are directory-sandboxed, so panels cannot import
 * ../shared at runtime — hence the copies.
 *
 * Plain script, no imports, no eval: attaches to window.MotionStudioMcpClient
 * when window exists and module.exports when module exists (so node:test can
 * require it). Uses only globals available in UXP 9.x: fetch, AbortController,
 * TextEncoder, WebCrypto (crypto.subtle), Headers.
 *
 * Wire contract (matches the MCP SDK Streamable HTTP server surface):
 *  - POST JSON-RPC 2.0 messages to baseUrl (e.g. http://127.0.0.1:7420/mcp).
 *    Use 127.0.0.1, never localhost (UXP URL parser gotcha).
 *  - Headers on every POST: Content-Type: application/json,
 *    Accept: application/json, text/event-stream, and (when configured)
 *    x-motion-studio-token: <token>.
 *  - The initialize response carries the session: the mcp-session-id response
 *    header is captured case-insensitively and echoed on all later requests,
 *    together with MCP-Protocol-Version: <negotiated version>.
 *  - notifications/initialized is POSTed right after initialize; the server
 *    answers 202 with an empty body — status/body are intentionally not
 *    validated (the SDK only requires the notification to be sent).
 *  - Response bodies may be application/json or SSE (text/event-stream); both
 *    are parsed, taking the data: payload whose JSON-RPC id matches the
 *    request id.
 */
(function (root, factory) {
    var api = factory();
    if (typeof window !== 'undefined') window.MotionStudioMcpClient = api;
    if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
    if (typeof window === 'undefined' && typeof module === 'undefined' && root && typeof root === 'object') {
        root.MotionStudioMcpClient = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var CLIENT_NAME = 'motion-studio-uxp-panel';
    var CLIENT_VERSION = '1.0.0';
    var DEFAULT_PROTOCOL_VERSION = '2025-06-18';
    var CONNECT_TIMEOUT_MS = 5000;
    var CALL_TIMEOUT_MS = 30000;
    // Well-known default ports -> start command surfaced in transport errors.
    var START_HINTS = {
        7420: 'node packages/effectcraft-mcp-server/src/index.mjs --http',
        7430: 'node packages/filmcraft-mcp-server/src/index.mjs --http --port 7430'
    };

    // -------------------------------------------------------------------------
    // Approval digest — must match Motion Studio's craft servers byte-for-byte.
    //
    // Rule: sha256 over stableStringify(operationArgs) encoded UTF-8, hex
    // encoded, where operationArgs are the tool's operation arguments EXCLUDING
    // the approval field itself (projectId/runId/approvedBy live in the approval
    // envelope, not in the digested args). The Node servers compute the same
    // value with createHash('sha256').update(stableStringify(args)).digest('hex')
    // (utf-8 update default); WebCrypto digest is async-only, so every approval
    // API here returns a promise. stableStringify is intentionally the exact
    // implementation used by packages/craft-mcp-client: sorted object keys,
    // JSON.stringify leaves, array order preserved, and undefined leaves
    // concatenating as the literal text "undefined".
    // -------------------------------------------------------------------------
    function stableStringify(value) {
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + stableStringify(value[key]); }).join(',') + '}';
        return JSON.stringify(value);
    }

    function utf8Bytes(text) {
        if (typeof TextEncoder !== 'function') {
            throw new Error('Motion Studio MCP client requires TextEncoder to build the approval digest; this runtime does not provide it.');
        }
        return new TextEncoder().encode(text);
    }

    function sha256Hex(text) {
        var subtle = (typeof crypto !== 'undefined' && crypto && crypto.subtle) || null;
        if (!subtle || typeof subtle.digest !== 'function') {
            return Promise.reject(new Error('Motion Studio MCP client requires WebCrypto (crypto.subtle) to build approvals; this runtime does not provide it.'));
        }
        var bytes;
        try {
            bytes = utf8Bytes(text);
        } catch (err) {
            return Promise.reject(err);
        }
        return subtle.digest('SHA-256', bytes).then(function (digest) {
            return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
                return byte.toString(16).padStart(2, '0');
            }).join('');
        });
    }

    function randomApprovalId() {
        var cryptoRef = (typeof crypto !== 'undefined' && crypto) || null;
        if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
        if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
            var bytes = cryptoRef.getRandomValues(new Uint8Array(16));
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            var hex = Array.prototype.map.call(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
            return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
        }
        // Last resort: UXP runtimes always provide crypto, but a missing id must
        // never hard-crash the panel — degrade to a timestamp-based id.
        return 'approval-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /**
     * Build a Motion Studio craft-operation approval record.
     * @param {object} options { projectId, runId, app, toolName, args, approvedBy, expiresInMs? = 600000, now? }
     * @returns {Promise<object>} approval — send as the `approval` field of the tool call.
     */
    function createApproval(options) {
        var opts = options || {};
        var args = opts.args === undefined || opts.args === null ? {} : opts.args;
        var projectId = opts.projectId;
        var runId = opts.runId;
        var app = opts.app;
        var toolName = opts.toolName;
        var actor = typeof opts.approvedBy === 'string' ? opts.approvedBy.trim() : '';
        var expiresInMs = opts.expiresInMs === undefined ? 600000 : opts.expiresInMs;
        var now = typeof opts.now === 'number' && isFinite(opts.now) ? opts.now : Date.now();

        if (!projectId || !runId || !toolName) {
            return Promise.reject(new Error('Approval requires projectId, runId and toolName.'));
        }
        if (app !== 'effectcraft' && app !== 'filmcraft') {
            return Promise.reject(new Error('Approval app must be "effectcraft" or "filmcraft".'));
        }
        if (!actor) {
            return Promise.reject(new Error('Approval requires a non-empty approvedBy (the person signing off on this mutation).'));
        }
        if (!isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > 3600000) {
            return Promise.reject(new Error('Approval expiry must be between 1 ms and 1 hour.'));
        }
        return sha256Hex(stableStringify(args)).then(function (argumentsSha256) {
            return {
                approvalId: randomApprovalId(),
                approved: true,
                projectId: projectId,
                runId: runId,
                app: app,
                toolName: toolName,
                argumentsSha256: argumentsSha256,
                approvedBy: actor,
                approvedAt: new Date(now).toISOString(),
                expiresAt: new Date(now + expiresInMs).toISOString()
            };
        });
    }

    // -------------------------------------------------------------------------
    // Streamable HTTP transport
    // -------------------------------------------------------------------------
    function normalizeBaseUrl(baseUrl) {
        var value = String(baseUrl === undefined || baseUrl === null ? '' : baseUrl).trim().replace(/\/+$/, '');
        if (!/^https?:\/\/\S/.test(value)) {
            throw new Error('baseUrl must be a full http(s) MCP endpoint, e.g. http://127.0.0.1:7420/mcp — always use 127.0.0.1, never localhost (UXP URL parser gotcha).');
        }
        return value;
    }

    function resolveFetch(fetchImpl) {
        if (typeof fetchImpl === 'function') return fetchImpl;
        if (typeof fetch === 'function') return fetch;
        throw new Error('Motion Studio MCP client needs a fetch implementation: UXP provides a global fetch; pass fetchImpl when embedding this module elsewhere.');
    }

    function startHint(baseUrl) {
        var match = /:(\d+)/.exec(String(baseUrl));
        var port = match ? Number(match[1]) : NaN;
        return START_HINTS[port] || 'node packages/<craft>-mcp-server/src/index.mjs --http';
    }

    function getResponseHeader(headers, name) {
        if (!headers || typeof headers.get !== 'function') return null;
        var direct = headers.get(name);
        if (direct) return direct;
        // Belt-and-braces scan: the MCP spec puts no casing guarantee on the
        // mcp-session-id header and some UXP builds have been case-sensitive.
        if (typeof headers.forEach === 'function') {
            var found = null;
            headers.forEach(function (value, key) {
                if (!found && String(key).toLowerCase() === String(name).toLowerCase()) found = value;
            });
            if (found) return found;
        }
        return direct;
    }

    function snippet(text) {
        var value = String(text === undefined || text === null ? '' : text).trim();
        return value.length > 200 ? value.slice(0, 200) + '…' : value;
    }

    function tryParseJson(text) {
        if (typeof text !== 'string' || !text.trim()) return { ok: false };
        try {
            return { ok: true, value: JSON.parse(text) };
        } catch (err) {
            return { ok: false }; // "not JSON" is an expected outcome here, not an error
        }
    }

    function httpStatusError(status, bodyText) {
        if (status === 401 || status === 403) {
            return new Error('MCP server rejected the request (HTTP ' + status + '): server token required or mismatch — configure the same token on the server and in the panel (header: x-motion-studio-token).');
        }
        if (status === 404) {
            return new Error('MCP endpoint returned HTTP 404: wrong path — the URL must point at the server\'s /mcp route (e.g. http://127.0.0.1:7420/mcp).');
        }
        return new Error('MCP server returned HTTP ' + status + (bodyText ? ': ' + snippet(bodyText) : '.'));
    }

    function parseSseForId(text, requestId) {
        var blocks = String(text).split(/\r?\n\r?\n/);
        var candidates = [];
        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split(/\r?\n/);
            var dataLines = [];
            for (var j = 0; j < lines.length; j++) {
                if (lines[j].slice(0, 5) === 'data:') dataLines.push(lines[j].slice(5).replace(/^ /, ''));
            }
            if (!dataLines.length) continue;
            var payload = tryParseJson(dataLines.join('\n'));
            if (payload.ok) candidates.push(payload.value);
        }
        var matching = candidates.filter(function (item) {
            return item && typeof item === 'object' && item.id === requestId;
        });
        if (matching.length) return matching[0];
        // Defensive: servers must echo the request id, but a lone JSON-RPC
        // message without one is still unambiguous — accept it.
        var messages = candidates.filter(function (item) {
            return item && typeof item === 'object' && ('result' in item || 'error' in item);
        });
        if (messages.length === 1) return messages[0];
        throw new Error('MCP SSE stream contained no JSON-RPC response for request id ' + requestId + '.');
    }

    function parseRpcBody(text, requestId) {
        var parsed = tryParseJson(text);
        if (!parsed.ok) {
            throw new Error('MCP server returned an unparsable body: ' + snippet(text));
        }
        var value = parsed.value;
        if (Array.isArray(value)) {
            var match = value.filter(function (item) { return item && typeof item === 'object' && item.id === requestId; })[0];
            if (!match) throw new Error('MCP batch response contained no message for request id ' + requestId + '.');
            return match;
        }
        if (value && typeof value === 'object' && ('result' in value || 'error' in value)) return value;
        throw new Error('MCP server response was not a JSON-RPC message: ' + snippet(JSON.stringify(value)));
    }

    function protocolError(message) {
        var error = (message && message.error) || {};
        return new Error('MCP error ' + (error.code === undefined ? '' : error.code) + ': ' + (error.message || 'server returned an error without a message.'));
    }

    function assertResult(message, what) {
        if (!message || typeof message !== 'object') throw new Error('MCP ' + what + ' returned no JSON-RPC message.');
        if (message.error) throw protocolError(message);
        if (!('result' in message)) throw new Error('MCP ' + what + ' returned no result.');
        return message.result;
    }

    /**
     * Minimal MCP client over Streamable HTTP.
     * @param {object} options { baseUrl, token?, fetchImpl?, protocolVersion? = '2025-06-18' }
     */
    function createMcpHttpClient(options) {
        var opts = options || {};
        var state = {
            baseUrl: normalizeBaseUrl(opts.baseUrl),
            token: typeof opts.token === 'string' ? opts.token : (opts.token === undefined || opts.token === null ? '' : String(opts.token)),
            fetch: resolveFetch(opts.fetchImpl),
            protocolVersion: typeof opts.protocolVersion === 'string' && opts.protocolVersion ? opts.protocolVersion : DEFAULT_PROTOCOL_VERSION,
            sessionId: null,
            serverInfo: null,
            nextId: 1
        };

        function postRpc(payload, timeoutMs) {
            var headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            };
            if (state.token) headers['x-motion-studio-token'] = state.token;
            // The session id and negotiated protocol version only exist after
            // initialize; the SDK sends both on every post-initialize request.
            if (state.sessionId) {
                headers['mcp-session-id'] = state.sessionId;
                headers['MCP-Protocol-Version'] = state.protocolVersion;
            }
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
            var label = payload && payload.method ? payload.method : 'request';
            return state.fetch(state.baseUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
                signal: controller ? controller.signal : undefined
            }).catch(function (err) {
                clearTimeout(timer);
                if (controller && controller.signal.aborted) {
                    throw new Error('MCP request timed out after ' + timeoutMs + ' ms (' + label + ').');
                }
                throw new Error('MCP request failed (' + label + '): ' + (err && err.message ? err.message : String(err)) + ' — server not running? Start it with: ' + startHint(state.baseUrl));
            }).then(function (response) {
                clearTimeout(timer);
                return response;
            }, function (err) {
                clearTimeout(timer);
                throw err;
            });
        }

        function readRpcMessage(response, requestId) {
            return response.text().then(function (text) {
                if (!(response.status >= 200 && response.status < 300)) throw httpStatusError(response.status, text);
                var contentType = String(getResponseHeader(response.headers, 'content-type') || '');
                if (/text\/event-stream/i.test(contentType)) return parseSseForId(text, requestId);
                return parseRpcBody(text, requestId);
            }, function (err) {
                throw new Error('MCP response could not be read: ' + (err && err.message ? err.message : String(err)));
            });
        }

        function decodeToolResult(result) {
            var source = result && typeof result === 'object' ? result : {};
            var content = Array.isArray(source.content) ? source.content : [];
            // Surface content[].text as JSON when it parses — the craft servers
            // wrap their receipts in content[0].text. Non-JSON text passes
            // through untouched; isError and content are always faithful.
            var decoded = content.map(function (item) {
                if (item && item.type === 'text' && typeof item.text === 'string') {
                    var parsed = tryParseJson(item.text);
                    if (parsed.ok) {
                        var copy = Object.assign({}, item);
                        copy.json = parsed.value;
                        return copy;
                    }
                }
                return item;
            });
            var firstJson;
            for (var i = 0; i < decoded.length; i++) {
                if (decoded[i] && 'json' in decoded[i]) { firstJson = decoded[i].json; break; }
            }
            return Object.assign({}, source, {
                isError: source.isError === true,
                content: decoded,
                data: firstJson,
                text: content[0] && typeof content[0].text === 'string' ? content[0].text : undefined
            });
        }

        return {
            get baseUrl() { return state.baseUrl; },
            get sessionId() { return state.sessionId; },
            get serverInfo() { return state.serverInfo; },
            get protocolVersion() { return state.protocolVersion; },

            /** POST initialize, capture the session id, then POST notifications/initialized (202 expected, body ignored). */
            connect: function () {
                var id = state.nextId++;
                return postRpc({
                    jsonrpc: '2.0',
                    id: id,
                    method: 'initialize',
                    params: {
                        protocolVersion: state.protocolVersion,
                        capabilities: {},
                        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
                    }
                }, CONNECT_TIMEOUT_MS).then(function (response) {
                    var session = getResponseHeader(response.headers, 'mcp-session-id');
                    if (session) state.sessionId = session;
                    return readRpcMessage(response, id);
                }).then(function (message) {
                    var result = assertResult(message, 'initialize');
                    state.serverInfo = result && typeof result.serverInfo === 'object' && result.serverInfo ? result.serverInfo : null;
                    // Adopt the negotiated version so MCP-Protocol-Version
                    // echoes what the server actually speaks.
                    if (result && typeof result.protocolVersion === 'string' && result.protocolVersion) {
                        state.protocolVersion = result.protocolVersion;
                    }
                    return postRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, CONNECT_TIMEOUT_MS)
                        .then(function (ack) { return ack.text().then(function () { return ''; }, function () { return ''; }); })
                        .catch(function () { /* best-effort notification: the session is already valid; later calls surface any breakage */ })
                        .then(function () { return state.serverInfo; });
                });
            },

            /** POST tools/list; resolves with the full result object ({ tools: [...] }). */
            listTools: function () {
                var id = state.nextId++;
                return postRpc({ jsonrpc: '2.0', id: id, method: 'tools/list', params: {} }, CALL_TIMEOUT_MS)
                    .then(function (response) { return readRpcMessage(response, id); })
                    .then(function (message) { return assertResult(message, 'tools/list'); });
            },

            /** POST tools/call; resolves with { isError, content, data?, text? } — isError/content surfaced faithfully. */
            callTool: function (name, args) {
                if (typeof name !== 'string' || !name.trim()) {
                    return Promise.reject(new Error('callTool requires a non-empty tool name.'));
                }
                var id = state.nextId++;
                return postRpc({
                    jsonrpc: '2.0',
                    id: id,
                    method: 'tools/call',
                    params: { name: name, arguments: args === undefined || args === null ? {} : args }
                }, CALL_TIMEOUT_MS)
                    .then(function (response) { return readRpcMessage(response, id); })
                    .then(function (message) { return decodeToolResult(assertResult(message, 'tools/call')); });
            },

            /** DELETE the session; every failure is ignored — cleanup must never mask a result. */
            close: function () {
                var sessionId = state.sessionId;
                state.sessionId = null;
                if (!sessionId) return Promise.resolve();
                var headers = { 'Content-Type': 'application/json', 'mcp-session-id': sessionId };
                if (state.token) headers['x-motion-studio-token'] = state.token;
                return new Promise(function (resolve) {
                    var settled = false;
                    var finish = function () { if (!settled) { settled = true; resolve(); } };
                    var controller = typeof AbortController === 'function' ? new AbortController() : null;
                    var timer = setTimeout(function () {
                        if (controller) controller.abort();
                        finish();
                    }, CONNECT_TIMEOUT_MS);
                    try {
                        state.fetch(state.baseUrl, { method: 'DELETE', headers: headers, signal: controller ? controller.signal : undefined })
                            .then(function (response) { return response.text().catch(function () { return ''; }); })
                            .then(function () { clearTimeout(timer); finish(); },
                                function () { clearTimeout(timer); finish(); });
                    } catch (err) {
                        clearTimeout(timer);
                        finish();
                    }
                });
            }
        };
    }

    return {
        version: CLIENT_VERSION,
        defaultProtocolVersion: DEFAULT_PROTOCOL_VERSION,
        createMcpHttpClient: createMcpHttpClient,
        stableStringify: stableStringify,
        createApproval: createApproval,
        sha256Hex: sha256Hex
    };
}));
