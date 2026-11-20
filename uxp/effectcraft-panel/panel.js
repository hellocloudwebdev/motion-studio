/*
 * Motion Studio — EffectCraft UXP panel (After Effects, manifest v5, UXP 9.4 beta).
 * Plain IIFE script, no modules, no eval. index.html loads mcp-http-client.js
 * before this file, so window.MotionStudioMcpClient is available here.
 *
 * Every user handler is wrapped in guard(): failures land in the status pill
 * and the receipt log, never as uncaught exceptions. All timeouts live in the
 * shared client (5 s connect, 30 s calls, AbortController-based).
 *
 * Cards: Engine, Tool console (command browser + run_command), Scene render,
 * Comp render, Layer properties (gated: set_blend_mode / set_track_matte /
 * set_parent / add_mask — one Run per row), Composition extras (gated:
 * add_marker / set_work_area), Timeline interchange (gated: import_timeline),
 * Export / queue (ungated: export_lottie / export_timeline / render_queue /
 * list_fonts), Receipt log.
 *
 * Approval flow: mutating calls build the approval locally via
 * MotionStudioMcpClient.createApproval — toolName is app-prefixed
 * ("effectcraft.run_command" etc.) and args are the SERVER's resolved
 * operation arguments (projectId, runId and timeoutMs: undefined included —
 * see approvedCall); the tool is then called with
 * { approval, projectId, runId, ...opArgs }. Tools the server does not gate
 * (render_scene, render_comp, export_lottie, export_timeline, render_queue,
 * list_fonts — sandboxed artifact generation / read-only) call the tool
 * directly without an approval.
 */
(function () {
    'use strict';

    var PANEL = {
        app: 'effectcraft',
        title: 'EffectCraft',
        defaultBaseUrl: 'http://127.0.0.1:7420/mcp',
        runCommandTool: 'effectcraft.run_command',
        settingsPath: 'plugin-data:/motion-studio-settings.json'
    };

    // Enum surfaces mirrored from packages/effectcraft-mcp-server/src/index.mjs
    // — keep both sides in sync so the selects always send schema-valid values.
    var BLEND_MODES = [
        'Normal', 'Multiply', 'Screen', 'Overlay', 'Add', 'Lighten', 'Darken', 'ColorDodge', 'ColorBurn',
        'HardLight', 'SoftLight', 'Difference', 'Exclusion', 'Hue', 'Saturation', 'Color', 'Luminosity',
        'StencilAlpha', 'StencilLuma', 'SilhouetteAlpha', 'SilhouetteLuma', 'AlphaAdd', 'ClassicColorBurn',
        'ClassicColorDodge', 'LinearBurn', 'LinearDodge', 'LinearLight', 'PinLight', 'VividLight', 'HardMix'
    ];
    var MASK_SHAPES = ['rect', 'ellipse', 'rounded', 'polygon', 'star'];
    var TRACK_MATTE_KINDS = ['alpha', 'alphaInverted', 'luma', 'lumaInverted', 'preserve'];
    var TIMELINE_EXPORT_FORMATS = ['fcpxml', 'xml', 'otio', 'edl'];
    var TIMELINE_IMPORT_FORMATS = ['auto', 'fcpxml', 'xml', 'otio', 'edl', 'aaf', 'omf'];
    var RENDER_QUEUE_FORMATS = ['h264', 'hevc', 'av1', 'prores', 'webm'];
    var RENDER_QUEUE_RESOLUTIONS = ['full', 'half', 'third', 'quarter'];

    var mcp = (typeof window !== 'undefined' && window.MotionStudioMcpClient) ||
        (typeof globalThis !== 'undefined' && globalThis.MotionStudioMcpClient) ||
        null;

    var refs = {};
    var state = {
        client: null,
        connected: false,
        connecting: false,
        serverInfo: null,
        tools: [],
        commands: [],
        commandFilter: ''
    };

    // ------------------------------------------------------------------ DOM
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function makeInput(type, placeholder, value) {
        var input = el('input');
        input.type = type;
        if (placeholder) input.placeholder = placeholder;
        if (value) input.value = value;
        return input;
    }

    function makeSelect(options) {
        var select = el('select');
        for (var i = 0; i < options.length; i++) {
            var option = el('option', null, options[i][1]);
            option.value = options[i][0];
            select.appendChild(option);
        }
        return select;
    }

    function makeModeSelect(values) {
        var options = [];
        for (var i = 0; i < values.length; i++) options.push([values[i], values[i]]);
        return makeSelect(options);
    }

    function makeField(labelText, input) {
        var wrap = el('div', 'field');
        wrap.appendChild(el('label', 'field-label', labelText));
        wrap.appendChild(input);
        return wrap;
    }

    function buildKv(key, value) {
        var row = el('div', 'kv');
        row.appendChild(el('span', 'k', key));
        row.appendChild(el('span', 'v', value === undefined || value === null ? '—' : value));
        return row;
    }

    function prettyJson(value) {
        try {
            return JSON.stringify(value, null, 2);
        } catch (err) {
            return String(value); // receipts must never fail on cyclic payloads
        }
    }

    function nowStamp() {
        var d = new Date();
        return d.toTimeString().slice(0, 8);
    }

    // ------------------------------------------------- defensive dispatch
    function handleFailure(label, err) {
        var message = err && err.message ? err.message : String(err);
        setStatus('error', 'Error: ' + message);
        addReceipt({ tool: label, ok: false, json: { error: message } });
    }

    function guard(label, fn) {
        return function () {
            var args = Array.prototype.slice.call(arguments);
            try {
                var result = fn.apply(null, args);
                if (result && typeof result.catch === 'function') {
                    return result.catch(function (err) { handleFailure(label, err); });
                }
                return result;
            } catch (err) {
                handleFailure(label, err);
            }
        };
    }

    // -------------------------------------------------------------- status
    function setStatus(kind, text) {
        if (!refs.statusPill) return;
        refs.statusPill.className = 'status-pill is-' + kind;
        refs.statusPill.textContent = text;
        refs.statusPill.title = text;
    }

    function setBusy(busy) {
        if (refs.connectBtn) refs.connectBtn.disabled = busy;
    }

    // -------------------------------------------------------------- receipts
    function copyToClipboard(text, button) {
        var finish = function (ok) {
            button.textContent = ok ? 'Copied' : 'Copy failed';
            setTimeout(function () { button.textContent = 'Copy JSON'; }, 1500);
        };
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () { finish(true); }, function () { finish(false); });
        } else {
            finish(false);
        }
    }

    function copyReceiptButton(entry) {
        var button = el('button', 'link-like', 'Copy JSON');
        button.addEventListener('click', guard('receipt.copy', function (event) {
            if (event && event.stopPropagation) event.stopPropagation();
            copyToClipboard(prettyJson(entry.json), button);
        }));
        return button;
    }

    function addReceipt(entry) {
        var log = refs.receiptList;
        if (!log) return;
        var item = el('div', 'receipt-item');
        var summary = el('div', 'receipt-summary');
        summary.appendChild(el('span', 'receipt-time', nowStamp()));
        summary.appendChild(el('span', 'receipt-tool', entry.tool));
        summary.appendChild(el('span', entry.ok ? 'tag-ok' : 'tag-err', entry.ok ? 'ok' : 'error'));
        summary.appendChild(copyReceiptButton(entry));
        summary.addEventListener('click', guard('receipt.toggle', function () {
            detail.className = detail.className.indexOf('collapsed') !== -1 ? 'receipt-detail' : 'receipt-detail collapsed';
        }));
        var detail = el('div', 'receipt-detail collapsed');
        detail.appendChild(el('pre', 'json', prettyJson(entry.json)));
        item.appendChild(summary);
        item.appendChild(detail);
        log.insertBefore(item, log.firstChild);
        // Cap the log so a long session cannot grow the DOM unbounded.
        while (log.children.length > 100) log.removeChild(log.lastChild);
    }

    // -------------------------------------------------------------- settings
    function localFs() {
        try {
            var uxp = typeof require === 'function' ? require('uxp') : null;
            return (uxp && uxp.storage && uxp.storage.localFileSystem) || null;
        } catch (err) {
            return null; // outside UXP the panel still works, settings just do not persist
        }
    }

    function loadSettings() {
        var fs = localFs();
        if (!fs) return Promise.resolve(null);
        return fs.readFile(PANEL.settingsPath, { encoding: 'utf8' }).then(function (data) {
            try {
                var parsed = JSON.parse(String(data));
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch (err) {
                return null; // a corrupted settings file behaves like "no settings"
            }
        }).catch(function () {
            return null; // first run before the file exists
        });
    }

    function saveSettings(settings) {
        var fs = localFs();
        if (!fs) return Promise.resolve(false);
        return fs.writeFile(PANEL.settingsPath, JSON.stringify(settings, null, 2)).then(function () {
            return true;
        }, function (err) {
            addReceipt({ tool: 'settings.save', ok: false, json: { error: err && err.message ? err.message : String(err) } });
            return false;
        });
    }

    function clearSettings() {
        var fs = localFs();
        if (!fs) return Promise.resolve(false);
        return fs.writeFile(PANEL.settingsPath, JSON.stringify({}, null, 2)).then(function () {
            return true;
        }, function (err) {
            addReceipt({ tool: 'settings.clear', ok: false, json: { error: err && err.message ? err.message : String(err) } });
            return false;
        });
    }

    function loadSettingsIntoForm() {
        return loadSettings().then(function (settings) {
            if (!settings) return;
            if (settings.baseUrl) refs.baseUrl.value = String(settings.baseUrl);
            if (typeof settings.token === 'string') refs.token.value = settings.token;
        });
    }

    // ------------------------------------------------------------ connection
    function getFormData() {
        return {
            baseUrl: refs.baseUrl.value.trim() || PANEL.defaultBaseUrl,
            token: refs.token.value.trim()
        };
    }

    function connect() {
        if (state.connecting) return;
        if (state.connected) disconnect(true);
        if (!mcp || typeof mcp.createMcpHttpClient !== 'function') {
            setStatus('error', 'MotionStudioMcpClient is not loaded — mcp-http-client.js must load before panel.js in index.html.');
            return;
        }
        var form = getFormData();
        var client;
        try {
            client = mcp.createMcpHttpClient({ baseUrl: form.baseUrl, token: form.token || undefined });
        } catch (err) {
            setStatus('error', err.message);
            addReceipt({ tool: 'connect', ok: false, json: { baseUrl: form.baseUrl, error: err.message } });
            return;
        }
        state.connecting = true;
        state.client = client;
        setBusy(true);
        setStatus('connecting', 'Connecting…');
        client.connect().then(function (serverInfo) {
            state.connecting = false;
            state.connected = true;
            state.serverInfo = serverInfo;
            var name = serverInfo && serverInfo.name ? serverInfo.name : 'server';
            var version = serverInfo && serverInfo.version ? serverInfo.version : '?';
            setStatus('connected', 'Connected to ' + name + ' v' + version);
            addReceipt({ tool: 'connect', ok: true, json: { baseUrl: form.baseUrl, serverInfo: serverInfo } });
            saveSettings({ baseUrl: form.baseUrl, token: form.token });
            refreshEngineCard();
            refreshTools();
            refreshCommands();
        }, function (err) {
            state.connecting = false;
            state.client = null;
            setStatus('error', err.message);
            addReceipt({ tool: 'connect', ok: false, json: { baseUrl: form.baseUrl, error: err.message } });
        }).then(function () { setBusy(false); }, function () { setBusy(false); });
    }

    function disconnect(silent) {
        var client = state.client;
        state.client = null;
        state.connected = false;
        state.connecting = false;
        state.serverInfo = null;
        state.tools = [];
        state.commands = [];
        state.commandFilter = '';
        if (refs.commandFilter) refs.commandFilter.value = '';
        setStatus('disconnected', 'Disconnected');
        renderCommands();
        clearEngineCard();
        if (client) {
            client.close().then(function () {
                if (!silent) addReceipt({ tool: 'disconnect', ok: true, json: { closed: true } });
            });
        }
    }

    // ----------------------------------------------------------- tool calls
    function callToolTracked(tool, args) {
        if (!state.client || !state.connected) {
            return Promise.reject(new Error('Not connected — connect to the MCP server first.'));
        }
        return state.client.callTool(tool, args).then(function (result) {
            addReceipt({ tool: tool, ok: !result.isError, json: { args: args, result: result } });
            return result;
        }, function (err) {
            addReceipt({ tool: tool, ok: false, json: { args: args, error: err.message } });
            throw err;
        });
    }

    function readApprovalIdentity() {
        return {
            projectId: refs.projectId.value.trim(),
            runId: refs.runId.value.trim(),
            approvedBy: refs.approvedBy.value.trim()
        };
    }

    function approvedCall(toolName, fields, identityOverrides) {
        var identity = identityOverrides ? Object.assign(readApprovalIdentity(), identityOverrides) : readApprovalIdentity();
        if (!identity.projectId || !identity.runId || !identity.approvedBy) {
            return Promise.reject(new Error('Approval required: fill in Project ID, Run ID and Approved By at the top of the tool console first.'));
        }
        if (!mcp || typeof mcp.createApproval !== 'function') {
            return Promise.reject(new Error('MotionStudioMcpClient is not loaded — cannot build the approval.'));
        }
        // The server gate digests its RESOLVED operation arguments — projectId,
        // runId and timeoutMs included. timeoutMs is never sent (JSON.stringify
        // drops undefined), the server schema resolves it back to undefined and
        // the digest writes the literal "undefined"; optional keys the card
        // leaves empty must still be present, as undefined, or the digests
        // diverge and the mutation is refused.
        var opArgs = Object.assign({ projectId: identity.projectId, runId: identity.runId, timeoutMs: undefined }, fields);
        return mcp.createApproval({
            projectId: identity.projectId,
            runId: identity.runId,
            app: PANEL.app,
            toolName: toolName,
            args: opArgs,
            approvedBy: identity.approvedBy
        }).then(function (approval) {
            var toolArgs = Object.assign({ approval: approval, projectId: identity.projectId, runId: identity.runId }, opArgs);
            return callToolTracked(toolName, toolArgs);
        });
    }

    // ---------------------------------------------------------- engine card
    function buildEngineCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Engine (check_engine)'));
        refs.engineBody = el('div');
        refs.engineBody.appendChild(el('div', 'inline-note', 'Connect to load engine info.'));
        card.appendChild(refs.engineBody);
        root.appendChild(card);
    }

    function clearEngineCard() {
        if (!refs.engineBody) return;
        refs.engineBody.textContent = '';
        refs.engineBody.appendChild(el('div', 'inline-note', 'Connect to load engine info.'));
    }

    function refreshEngineCard() {
        if (!refs.engineBody) return;
        refs.engineBody.textContent = '';
        refs.engineBody.appendChild(el('div', 'inline-note', 'Checking engine…'));
        callToolTracked('check_engine', {}).then(function (result) {
            var data = result.data !== undefined ? result.data : (result.text !== undefined ? { raw: result.text } : {});
            var engine = data && typeof data.engine === 'object' ? data.engine : {};
            renderEngineRows([
                ['CLI path', data.cliPath || data.cli || data.path || engine.cliPath || '—'],
                ['Version', data.version || data.engineVersion || engine.version || '—'],
                ['Tool count', data.toolCount !== undefined ? data.toolCount : (Array.isArray(data.tools) ? data.tools.length : state.tools.length)]
            ]);
        }, function (err) {
            refs.engineBody.textContent = '';
            refs.engineBody.appendChild(el('div', 'inline-error', 'check_engine failed: ' + err.message));
        });
    }

    function renderEngineRows(rows) {
        var list = el('div', 'kv-list');
        for (var i = 0; i < rows.length; i++) list.appendChild(buildKv(rows[i][0], rows[i][1]));
        refs.engineBody.textContent = '';
        refs.engineBody.appendChild(list);
    }

    // -------------------------------------------------------- tool console
    function buildToolConsoleCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Tool console'));
        card.appendChild(el('div', 'card-sub', 'Mutating calls are gated by a producer approval created locally (WebCrypto SHA-256 over the operation args).'));

        refs.projectId = makeInput('text', 'project id');
        refs.runId = makeInput('text', 'run id');
        refs.approvedBy = makeInput('text', 'approved by');
        var identityRow = el('div', 'row');
        var identityA = el('div');
        var identityB = el('div');
        var identityC = el('div');
        identityA.appendChild(makeField('Project ID', refs.projectId));
        identityB.appendChild(makeField('Run ID', refs.runId));
        identityC.appendChild(makeField('Approved By', refs.approvedBy));
        identityRow.appendChild(identityA);
        identityRow.appendChild(identityB);
        identityRow.appendChild(identityC);
        card.appendChild(identityRow);

        card.appendChild(el('div', 'field-label', 'Command browser (list_commands / describe_command)'));
        var filterRow = el('div', 'row');
        refs.commandFilter = makeInput('text', 'filter commands…');
        refs.commandFilter.addEventListener('input', guard('commands.filter', function () {
            state.commandFilter = refs.commandFilter.value;
            renderCommands();
        }));
        refs.refreshCommandsBtn = el('button', null, 'Refresh');
        refs.refreshCommandsBtn.addEventListener('click', guard('list_commands', refreshCommands));
        filterRow.appendChild(refs.commandFilter);
        filterRow.appendChild(refs.refreshCommandsBtn);
        card.appendChild(filterRow);

        refs.commandList = el('div', 'cmd-list');
        refs.commandListNote = el('div', 'list-note', 'Not connected.');
        card.appendChild(refs.commandList);
        card.appendChild(refs.commandListNote);

        refs.describeOutput = el('div', 'describe-output');
        card.appendChild(refs.describeOutput);

        card.appendChild(el('div', 'field-label', 'Run command (' + PANEL.runCommandTool + ')'));
        refs.runCommandId = makeInput('text', 'command id (click a command above to stage it)');
        card.appendChild(makeField('commandId', refs.runCommandId));
        refs.runParams = el('textarea');
        refs.runParams.placeholder = '{"sceneId": "sc-01", "quality": 2}';
        card.appendChild(makeField('params (JSON, validated before send)', refs.runParams));
        refs.runProjectPath = makeInput('text', 'path to the project file (optional)');
        card.appendChild(makeField('projectPath', refs.runProjectPath));
        var saveRow = el('div', 'checkbox-row');
        refs.runSave = el('input');
        refs.runSave.type = 'checkbox';
        saveRow.appendChild(refs.runSave);
        saveRow.appendChild(el('label', null, 'Save project after the command'));
        card.appendChild(saveRow);
        refs.runBtn = el('button', 'primary', 'Run');
        refs.runBtn.addEventListener('click', guard('run_command', runCommand));
        card.appendChild(refs.runBtn);
        refs.runResult = el('div');
        card.appendChild(refs.runResult);
        root.appendChild(card);
    }

    function refreshTools() {
        if (!state.client) return Promise.resolve();
        return state.client.listTools().then(function (result) {
            state.tools = (result && Array.isArray(result.tools) ? result.tools : []).map(function (tool) {
                return { name: tool && tool.name ? String(tool.name) : String(tool), description: tool && tool.description ? String(tool.description) : '' };
            });
            addReceipt({ tool: 'tools/list', ok: true, json: { count: state.tools.length, names: state.tools.map(function (tool) { return tool.name; }) } });
        }, function (err) {
            state.tools = [];
            addReceipt({ tool: 'tools/list', ok: false, json: { error: err.message } });
        });
    }

    function refreshCommands() {
        if (!refs.commandList) return;
        refs.commandList.textContent = '';
        refs.commandListNote.textContent = 'Loading commands…';
        callToolTracked('list_commands', {}).then(function (result) {
            state.commands = extractCommandList(result.data, result.text);
            renderCommands();
        }, function (err) {
            state.commands = [];
            refs.commandListNote.textContent = 'list_commands failed: ' + err.message;
        });
    }

    function extractCommandList(data, rawText) {
        var candidate = Array.isArray(data) ? data
            : (data && Array.isArray(data.commands) ? data.commands
                : (data && Array.isArray(data.items) ? data.items
                    : (data && Array.isArray(data.tools) ? data.tools : null)));
        if (!candidate) return [];
        return candidate.map(function (item) {
            if (typeof item === 'string') return { id: item, summary: '' };
            var id = item && (item.commandId !== undefined ? item.commandId : (item.id !== undefined ? item.id : item.name));
            return { id: id === undefined || id === null ? '' : String(id), summary: item && (item.summary || item.description || item.title) ? String(item.summary || item.description || item.title) : '' };
        }).filter(function (item) { return item.id; });
    }

    function makeCommandClickHandler(commandId) {
        return function () { describeCommand(commandId); };
    }

    function renderCommands() {
        if (!refs.commandList) return;
        refs.commandList.textContent = '';
        var filter = state.commandFilter.toLowerCase();
        var matching = [];
        for (var i = 0; i < state.commands.length; i++) {
            var command = state.commands[i];
            if (filter && (command.id + ' ' + command.summary).toLowerCase().indexOf(filter) === -1) continue;
            matching.push(command);
        }
        var limit = Math.min(matching.length, 50);
        for (var j = 0; j < limit; j++) {
            var item = el('div', 'cmd-item');
            item.appendChild(el('span', 'cmd-id', matching[j].id));
            if (matching[j].summary) item.appendChild(el('span', 'cmd-summary', matching[j].summary));
            item.addEventListener('click', makeCommandClickHandler(matching[j].id));
            refs.commandList.appendChild(item);
        }
        if (!matching.length) {
            refs.commandListNote.textContent = state.commands.length ? 'No commands match the filter.' : 'No commands reported by list_commands.';
        } else if (matching.length > limit) {
            refs.commandListNote.textContent = 'Showing ' + limit + ' of ' + matching.length + ' matching commands (limit 50).';
        } else {
            refs.commandListNote.textContent = matching.length + ' command' + (matching.length === 1 ? '' : 's') + '.';
        }
    }

    function describeCommand(commandId) {
        var children = refs.commandList.children;
        for (var i = 0; i < children.length; i++) {
            children[i].className = children[i].className.indexOf('is-selected') !== -1 || children[i].textContent.indexOf(commandId) === 0 ? 'cmd-item is-selected' : 'cmd-item';
        }
        if (refs.runCommandId) refs.runCommandId.value = commandId;
        setDescribeOutput('Describing ' + commandId + '…');
        callToolTracked('describe_command', { commandId: commandId }).then(function (result) {
            setDescribeOutput(describeText(result.data, result.text));
        }, function (err) {
            setDescribeOutput('describe_command failed: ' + err.message);
        });
    }

    function describeText(data, rawText) {
        if (data && typeof data === 'object') {
            var schema = data.schema !== undefined ? data.schema : (data.inputSchema !== undefined ? data.inputSchema : data.input_schema);
            var parts = [];
            if (data.summary || data.description) parts.push(String(data.summary || data.description));
            if (schema !== undefined) parts.push(typeof schema === 'string' ? schema : prettyJson(schema));
            if (!parts.length) parts.push(prettyJson(data));
            return parts.join('\n\n');
        }
        if (data !== undefined) return prettyJson(data);
        return rawText !== undefined ? String(rawText) : '';
    }

    function setDescribeOutput(text) {
        refs.describeOutput.textContent = '';
        refs.describeOutput.appendChild(el('pre', 'json', text));
    }

    function runCommand() {
        var commandId = refs.runCommandId.value.trim();
        if (!commandId) {
            showRunResult(false, 'commandId is required (click a command above or type one).');
            return;
        }
        var paramsRaw = refs.runParams.value.trim();
        var params;
        if (!paramsRaw) {
            params = {};
        } else {
            try {
                params = JSON.parse(paramsRaw);
            } catch (err) {
                showRunResult(false, 'params must be valid JSON: ' + err.message);
                return;
            }
            if (!params || typeof params !== 'object' || Array.isArray(params)) {
                showRunResult(false, 'params must be a JSON object, e.g. {"sceneId": "sc-01"}.');
                return;
            }
        }
        var projectPath = refs.runProjectPath.value.trim();
        // projectPath stays present-but-undefined when empty: the server gate
        // digests its resolved opArgs, so the key must exist on both sides.
        var opArgs = { commandId: commandId, params: params, projectPath: projectPath || undefined, save: refs.runSave.checked === true };
        showRunResult(null, 'Running ' + PANEL.runCommandTool + '…');
        approvedCall(PANEL.runCommandTool, opArgs).then(function (result) {
            showRunResult(result.isError ? false : true, result);
        }, function (err) {
            showRunResult(false, err.message);
        });
    }

    function showRunResult(status, payload) {
        refs.runResult.textContent = '';
        if (status === null) {
            refs.runResult.appendChild(el('div', 'inline-note', String(payload)));
            return;
        }
        if (typeof payload === 'string') {
            refs.runResult.appendChild(el('div', status ? 'result-status-ok' : 'result-status-error', status ? 'ok' : 'error'));
            refs.runResult.appendChild(el('div', 'inline-error', payload));
            return;
        }
        refs.runResult.appendChild(el('div', payload.isError ? 'result-status-error' : 'result-status-ok', payload.isError ? 'isError: true' : 'ok'));
        var data = payload.data !== undefined ? payload.data : (payload.text !== undefined ? payload.text : payload);
        refs.runResult.appendChild(el('pre', 'json', typeof data === 'string' ? data : prettyJson(data)));
    }

    // --------------------------------------------- EffectCraft-specific cards
    function buildSceneRenderCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Scene render (render_scene)'));
        var projectId = makeInput('text', 'project id');
        var sceneId = makeInput('text', 'scene id');
        card.appendChild(makeField('Project ID', projectId));
        card.appendChild(makeField('Scene ID', sceneId));
        var runButton = el('button', 'primary', 'Render scene');
        var result = el('div');
        runButton.addEventListener('click', guard('render_scene', function () {
            var pid = projectId.value.trim();
            var sid = sceneId.value.trim();
            if (!pid || !sid) {
                showCardResult(result, false, 'Project ID and Scene ID are required.');
                return;
            }
            showCardResult(result, null, 'render_scene running…');
            // render_scene is sandboxed artifact generation, not a gated engine
            // mutation — it runs without an approval (mirrors video.render_project).
            callToolTracked('effectcraft.render_scene', { projectId: pid, sceneId: sid }).then(function (res) {
                showReceiptResult(result, res, ['verified', 'output', 'duration', 'sha256']);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        card.appendChild(runButton);
        card.appendChild(result);
        root.appendChild(card);
    }

    function buildCompRenderCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Comp render (render_comp)'));
        var projectPath = makeInput('text', 'path to .aep / .ecproj');
        var compId = makeInput('text', 'comp id');
        var format = makeSelect([['h264', 'h264 (H.264)'], ['prores', 'prores (ProRes)'], ['png', 'png (PNG sequence)'], ['exr', 'exr (OpenEXR)']]);
        var resolution = makeSelect([['1920x1080', '1920x1080 (HD)'], ['2560x1440', '2560x1440'], ['3840x2160', '3840x2160 (UHD)'], ['1080x1920', '1080x1920 (vertical)']]);
        var channels = makeSelect([['rgb', 'rgb'], ['rgba', 'rgba (with alpha)'], ['alpha', 'alpha only']]);
        card.appendChild(makeField('projectPath', projectPath));
        card.appendChild(makeField('compId', compId));
        card.appendChild(makeField('format', format));
        card.appendChild(makeField('resolution', resolution));
        card.appendChild(makeField('channels', channels));
        var runButton = el('button', 'primary', 'Render comp');
        var result = el('div');
        runButton.addEventListener('click', guard('render_comp', function () {
            var path = projectPath.value.trim();
            var comp = compId.value.trim();
            if (!path || !comp) {
                showCardResult(result, false, 'projectPath and compId are required.');
                return;
            }
            var opArgs = {
                projectPath: path,
                compId: comp,
                format: format.value,
                resolution: resolution.value,
                channels: channels.value
            };
            showCardResult(result, null, 'render_comp running…');
            // render_comp is sandboxed artifact generation — no approval needed.
            callToolTracked('effectcraft.render_comp', opArgs).then(function (res) {
                showReceiptResult(result, res, ['verified', 'output', 'duration', 'sha256']);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        card.appendChild(runButton);
        card.appendChild(result);
        root.appendChild(card);
    }

    // --------------------------------------------------- field parsing helpers
    // Number inputs: blank means "not provided" — optional opArgs keys must
    // stay present as undefined so the approval digest matches the server
    // (the server destructures every field into its opArgs object, so a
    // missing key and an undefined key digest identically there); anything
    // else must parse to a finite number or NaN comes back for the caller to
    // reject with a clear message BEFORE any call is made.
    function parseNumberInput(input) {
        var raw = String(input.value === undefined || input.value === null ? '' : input.value).trim();
        if (!raw) return undefined;
        var value = Number(raw);
        return isFinite(value) ? value : NaN;
    }

    function parseJsonText(raw, what) {
        try {
            return { ok: true, value: JSON.parse(raw) };
        } catch (err) {
            return { ok: false, error: what + ' must be valid JSON: ' + (err && err.message ? err.message : String(err)) };
        }
    }

    function isInteger(value) {
        return isFinite(value) && value === Math.floor(value);
    }

    // ------------------------------------------ gated layer/comp/timeline cards
    function buildLayerPropertiesCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Layer properties (gated)'));
        card.appendChild(el('div', 'card-sub', 'Blend mode, track matte, parenting and masks on one layer of a saved comp — each row is its own gated mutation and needs a producer approval.'));
        var projectPath = makeInput('text', 'path to .aep / .ecproj');
        var compId = makeInput('text', 'comp id');
        var layer = makeInput('text', 'layer name');
        card.appendChild(makeField('projectPath', projectPath));
        var idsRow = el('div', 'row');
        var idsA = el('div');
        var idsB = el('div');
        idsA.appendChild(makeField('compId', compId));
        idsB.appendChild(makeField('layer', layer));
        idsRow.appendChild(idsA);
        idsRow.appendChild(idsB);
        card.appendChild(idsRow);

        card.appendChild(el('div', 'field-label', 'Blend mode (effectcraft.set_blend_mode)'));
        var blendMode = makeModeSelect(BLEND_MODES);
        card.appendChild(makeField('mode', blendMode));
        var blendResult = el('div');
        var blendButton = el('button', 'primary', 'Set blend mode');
        blendButton.addEventListener('click', guard('set_blend_mode', function () {
            var path = projectPath.value.trim();
            var comp = compId.value.trim();
            var layerName = layer.value.trim();
            if (!path || !comp || !layerName) {
                showCardResult(blendResult, false, 'projectPath, compId and layer are required.');
                return;
            }
            showCardResult(blendResult, null, 'set_blend_mode running…');
            approvedCall('effectcraft.set_blend_mode', { projectPath: path, compId: comp, layer: layerName, mode: blendMode.value }).then(function (res) {
                showReceiptResult(blendResult, res, ['mode', 'savePath']);
            }, function (err) {
                showCardResult(blendResult, false, err.message);
            });
        }));
        card.appendChild(blendButton);
        card.appendChild(blendResult);

        card.appendChild(el('div', 'field-label', 'Track matte (effectcraft.set_track_matte)'));
        var matteLayer = makeInput('text', 'matte layer name');
        var matteKind = makeModeSelect(TRACK_MATTE_KINDS);
        var matteRow = el('div', 'row');
        var matteA = el('div');
        var matteB = el('div');
        matteA.appendChild(makeField('matteLayer', matteLayer));
        matteB.appendChild(makeField('kind', matteKind));
        matteRow.appendChild(matteA);
        matteRow.appendChild(matteB);
        card.appendChild(matteRow);
        var matteResult = el('div');
        var matteButton = el('button', 'primary', 'Set track matte');
        matteButton.addEventListener('click', guard('set_track_matte', function () {
            var path = projectPath.value.trim();
            var comp = compId.value.trim();
            var layerName = layer.value.trim();
            var matte = matteLayer.value.trim();
            if (!path || !comp || !layerName || !matte) {
                showCardResult(matteResult, false, 'projectPath, compId, layer and matteLayer are required.');
                return;
            }
            showCardResult(matteResult, null, 'set_track_matte running…');
            approvedCall('effectcraft.set_track_matte', { projectPath: path, compId: comp, layer: layerName, matteLayer: matte, kind: matteKind.value }).then(function (res) {
                showReceiptResult(matteResult, res, ['matteLayer', 'kind', 'savePath']);
            }, function (err) {
                showCardResult(matteResult, false, err.message);
            });
        }));
        card.appendChild(matteButton);
        card.appendChild(matteResult);

        card.appendChild(el('div', 'field-label', 'Parent (effectcraft.set_parent)'));
        var parentLayer = makeInput('text', 'parent layer name');
        var compensateRow = el('div', 'checkbox-row');
        var compensate = el('input');
        compensate.type = 'checkbox';
        compensateRow.appendChild(compensate);
        compensateRow.appendChild(el('label', null, 'compensate for the transform (the layer keeps its position)'));
        card.appendChild(makeField('parentLayer', parentLayer));
        card.appendChild(compensateRow);
        var parentResult = el('div');
        var parentButton = el('button', 'primary', 'Set parent');
        parentButton.addEventListener('click', guard('set_parent', function () {
            var path = projectPath.value.trim();
            var comp = compId.value.trim();
            var layerName = layer.value.trim();
            var parentName = parentLayer.value.trim();
            if (!path || !comp || !layerName || !parentName) {
                showCardResult(parentResult, false, 'projectPath, compId, layer and parentLayer are required.');
                return;
            }
            showCardResult(parentResult, null, 'set_parent running…');
            approvedCall('effectcraft.set_parent', { projectPath: path, compId: comp, layer: layerName, parentLayer: parentName, compensate: compensate.checked === true }).then(function (res) {
                showReceiptResult(parentResult, res, ['parentLayer', 'compensate', 'savePath']);
            }, function (err) {
                showCardResult(parentResult, false, err.message);
            });
        }));
        card.appendChild(parentButton);
        card.appendChild(parentResult);

        card.appendChild(el('div', 'field-label', 'Mask (effectcraft.add_mask)'));
        var maskShape = makeModeSelect(MASK_SHAPES);
        var maskMode = makeInput('text', 'mask mode (optional, max 40 chars)');
        var maskRow = el('div', 'row');
        var maskA = el('div');
        var maskB = el('div');
        maskA.appendChild(makeField('shape', maskShape));
        maskB.appendChild(makeField('mode (optional)', maskMode));
        maskRow.appendChild(maskA);
        maskRow.appendChild(maskB);
        card.appendChild(maskRow);
        var maskRect = makeInput('text', '[x, y, w, h] for rect/ellipse/rounded/star');
        card.appendChild(makeField('rect (JSON, exactly one of rect / vertices)', maskRect));
        var maskRoundness = makeInput('number', 'roundness (optional, >= 0)');
        card.appendChild(makeField('roundness (optional)', maskRoundness));
        var maskVertices = el('textarea');
        maskVertices.placeholder = '[[x, y], …] for polygon/star (3–200 points)';
        card.appendChild(makeField('vertices (JSON, exactly one of rect / vertices)', maskVertices));
        var maskResult = el('div');
        var maskButton = el('button', 'primary', 'Add mask');
        maskButton.addEventListener('click', guard('add_mask', function () {
            var path = projectPath.value.trim();
            var comp = compId.value.trim();
            var layerName = layer.value.trim();
            if (!path || !comp || !layerName) {
                showCardResult(maskResult, false, 'projectPath, compId and layer are required.');
                return;
            }
            var rect = undefined;
            var rectRaw = maskRect.value.trim();
            if (rectRaw) {
                var parsedRect = parseJsonText(rectRaw, 'rect');
                if (!parsedRect.ok) {
                    showCardResult(maskResult, false, parsedRect.error);
                    return;
                }
                var rectValue = parsedRect.value;
                if (!Array.isArray(rectValue) || rectValue.length !== 4 || !rectValue.every(function (n) { return typeof n === 'number' && isFinite(n); })) {
                    showCardResult(maskResult, false, 'rect must be a JSON array of four numbers [x, y, w, h].');
                    return;
                }
                rect = rectValue;
            }
            var vertices = undefined;
            var verticesRaw = maskVertices.value.trim();
            if (verticesRaw) {
                var parsedVertices = parseJsonText(verticesRaw, 'vertices');
                if (!parsedVertices.ok) {
                    showCardResult(maskResult, false, parsedVertices.error);
                    return;
                }
                var points = parsedVertices.value;
                var pointsOk = Array.isArray(points) && points.length >= 3 && points.length <= 200 && points.every(function (point) {
                    return Array.isArray(point) && point.length === 2 && point.every(function (n) { return typeof n === 'number' && isFinite(n); });
                });
                if (!pointsOk) {
                    showCardResult(maskResult, false, 'vertices must be a JSON array of 3–200 [x, y] point pairs.');
                    return;
                }
                vertices = points;
            }
            if (Boolean(rect) === Boolean(vertices)) {
                showCardResult(maskResult, false, 'Provide exactly one of rect (JSON [x, y, w, h]) or vertices (JSON [[x, y], …]).');
                return;
            }
            var roundness = parseNumberInput(maskRoundness);
            if (roundness !== undefined && (isNaN(roundness) || roundness < 0)) {
                showCardResult(maskResult, false, 'roundness must be a number >= 0.');
                return;
            }
            var maskModeValue = maskMode.value.trim() || undefined;
            if (maskModeValue && maskModeValue.length > 40) {
                showCardResult(maskResult, false, 'mode must be at most 40 characters.');
                return;
            }
            showCardResult(maskResult, null, 'add_mask running…');
            approvedCall('effectcraft.add_mask', { projectPath: path, compId: comp, layer: layerName, shape: maskShape.value, rect: rect, roundness: roundness, vertices: vertices, mode: maskModeValue }).then(function (res) {
                showReceiptResult(maskResult, res, ['shape', 'path', 'savePath']);
            }, function (err) {
                showCardResult(maskResult, false, err.message);
            });
        }));
        card.appendChild(maskButton);
        card.appendChild(maskResult);
        root.appendChild(card);
    }

    function buildCompExtrasCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Composition extras (gated)'));
        card.appendChild(el('div', 'card-sub', 'Composition markers and the work area on a saved comp — both rows are gated mutations needing a producer approval.'));
        var projectPath = makeInput('text', 'path to .aep / .ecproj');
        var compId = makeInput('text', 'comp id');
        card.appendChild(makeField('projectPath', projectPath));
        card.appendChild(makeField('compId', compId));

        card.appendChild(el('div', 'field-label', 'Marker (effectcraft.add_marker)'));
        var seconds = makeInput('number', 'seconds (0–86400)');
        var comment = makeInput('text', 'comment (optional, max 500)');
        var markerRow = el('div', 'row');
        var markerA = el('div');
        var markerB = el('div');
        markerA.appendChild(makeField('seconds', seconds));
        markerB.appendChild(makeField('comment (optional)', comment));
        markerRow.appendChild(markerA);
        markerRow.appendChild(markerB);
        card.appendChild(markerRow);
        var markerResult = el('div');
        var markerButton = el('button', 'primary', 'Add marker');
        markerButton.addEventListener('click', guard('add_marker', function () {
            var path = projectPath.value.trim();
            var comp = compId.value.trim();
            if (!path || !comp) {
                showCardResult(markerResult, false, 'projectPath and compId are required.');
                return;
            }
            var atSeconds = parseNumberInput(seconds);
            if (atSeconds === undefined || isNaN(atSeconds) || atSeconds < 0 || atSeconds > 86400) {
                showCardResult(markerResult, false, 'seconds is required and must be between 0 and 86400.');
                return;
            }
            var commentValue = comment.value.trim() || undefined;
            if (commentValue && commentValue.length > 500) {
                showCardResult(markerResult, false, 'comment must be at most 500 characters.');
                return;
            }
            showCardResult(markerResult, null, 'add_marker running…');
            approvedCall('effectcraft.add_marker', { projectPath: path, compId: comp, seconds: atSeconds, comment: commentValue }).then(function (res) {
                showReceiptResult(markerResult, res, ['seconds', 'comment', 'savePath']);
            }, function (err) {
                showCardResult(markerResult, false, err.message);
            });
        }));
        card.appendChild(markerButton);
        card.appendChild(markerResult);

        card.appendChild(el('div', 'field-label', 'Work area (effectcraft.set_work_area)'));
        var start = makeInput('number', 'start seconds');
        var end = makeInput('number', 'end seconds');
        var workRow = el('div', 'row');
        var workA = el('div');
        var workB = el('div');
        workA.appendChild(makeField('start', start));
        workB.appendChild(makeField('end', end));
        workRow.appendChild(workA);
        workRow.appendChild(workB);
        card.appendChild(workRow);
        var workResult = el('div');
        var workButton = el('button', 'primary', 'Set work area');
        workButton.addEventListener('click', guard('set_work_area', function () {
            var path = projectPath.value.trim();
            var comp = compId.value.trim();
            if (!path || !comp) {
                showCardResult(workResult, false, 'projectPath and compId are required.');
                return;
            }
            var startSeconds = parseNumberInput(start);
            if (startSeconds === undefined || isNaN(startSeconds) || startSeconds < 0) {
                showCardResult(workResult, false, 'start is required and must be a number >= 0.');
                return;
            }
            var endSeconds = parseNumberInput(end);
            if (endSeconds === undefined || isNaN(endSeconds) || endSeconds < 0) {
                showCardResult(workResult, false, 'end is required and must be a number >= 0.');
                return;
            }
            if (endSeconds <= startSeconds) {
                showCardResult(workResult, false, 'end must be greater than start.');
                return;
            }
            showCardResult(workResult, null, 'set_work_area running…');
            approvedCall('effectcraft.set_work_area', { projectPath: path, compId: comp, start: startSeconds, end: endSeconds }).then(function (res) {
                showReceiptResult(workResult, res, ['start', 'end', 'savePath']);
            }, function (err) {
                showCardResult(workResult, false, err.message);
            });
        }));
        card.appendChild(workButton);
        card.appendChild(workResult);
        root.appendChild(card);
    }

    function buildTimelineInterchangeCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Timeline interchange (gated)'));
        card.appendChild(el('div', 'card-sub', 'Import a timeline interchange file (.xml/.fcpxml/.otio/.edl/.aaf/.omf) into a saved comp — gated mutation, producer approval required.'));
        var projectPath = makeInput('text', 'path to .aep / .ecproj');
        var timelinePath = makeInput('text', 'path to the timeline file');
        var format = makeModeSelect(TIMELINE_IMPORT_FORMATS);
        card.appendChild(makeField('projectPath', projectPath));
        card.appendChild(makeField('timelinePath', timelinePath));
        card.appendChild(makeField('format', format));
        var runButton = el('button', 'primary', 'Import timeline');
        var result = el('div');
        runButton.addEventListener('click', guard('import_timeline', function () {
            var path = projectPath.value.trim();
            var timeline = timelinePath.value.trim();
            if (!path || !timeline) {
                showCardResult(result, false, 'projectPath and timelinePath are required.');
                return;
            }
            showCardResult(result, null, 'import_timeline running…');
            approvedCall('effectcraft.import_timeline', { projectPath: path, timelinePath: timeline, format: format.value }).then(function (res) {
                showReceiptResult(result, res, ['timelinePath', 'format', 'compsCreated']);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        card.appendChild(runButton);
        card.appendChild(result);
        root.appendChild(card);
    }

    function validateQueueJob(job, index) {
        var where = 'jobs[' + index + ']';
        if (!job || typeof job !== 'object' || Array.isArray(job)) return where + ' must be a JSON object.';
        if (typeof job.compId !== 'string' || !job.compId.trim()) return where + '.compId must be a non-empty string.';
        if (typeof job.outputPath !== 'string' || !job.outputPath.trim()) return where + '.outputPath must be a non-empty string.';
        if (job.format !== undefined && RENDER_QUEUE_FORMATS.indexOf(job.format) === -1) return where + '.format must be one of: ' + RENDER_QUEUE_FORMATS.join(', ') + '.';
        if (job.resolution !== undefined && RENDER_QUEUE_RESOLUTIONS.indexOf(job.resolution) === -1) return where + '.resolution must be one of: ' + RENDER_QUEUE_RESOLUTIONS.join(', ') + '.';
        return null;
    }

    // The gate digests the zod-parsed payload: unknown keys are stripped and
    // missing optional keys never materialize, so nested objects are rebuilt
    // with exactly the keys the user provided (present-as-undefined is only
    // correct at the TOP level of opArgs, where the server destructures every
    // field into its digest object).
    function normalizeQueueJob(job) {
        var normalized = { compId: job.compId, outputPath: job.outputPath };
        if (job.format !== undefined) normalized.format = job.format;
        if (job.resolution !== undefined) normalized.resolution = job.resolution;
        return normalized;
    }

    function buildExportQueueCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Export / queue (ungated)'));
        card.appendChild(el('div', 'card-sub', 'Sandboxed artifact generation and read-only lookups — these run without a producer approval.'));
        var projectPath = makeInput('text', 'path to .aep / .ecproj');
        card.appendChild(makeField('projectPath', projectPath));

        card.appendChild(el('div', 'field-label', 'Lottie (effectcraft.export_lottie)'));
        var lottieComp = makeInput('text', 'comp id');
        var lottieOutput = makeInput('text', 'output .json / .lottie path');
        var lottieFlagsRow = el('div', 'row');
        var expressionsRow = el('div', 'checkbox-row');
        var includeExpressions = el('input');
        includeExpressions.type = 'checkbox';
        expressionsRow.appendChild(includeExpressions);
        expressionsRow.appendChild(el('label', null, 'includeExpressions'));
        var shapesRow = el('div', 'checkbox-row');
        var textAsShapes = el('input');
        textAsShapes.type = 'checkbox';
        shapesRow.appendChild(textAsShapes);
        shapesRow.appendChild(el('label', null, 'textAsShapes'));
        lottieFlagsRow.appendChild(expressionsRow);
        lottieFlagsRow.appendChild(shapesRow);
        card.appendChild(makeField('compId', lottieComp));
        card.appendChild(makeField('outputPath', lottieOutput));
        card.appendChild(lottieFlagsRow);
        var lottieResult = el('div');
        var lottieButton = el('button', 'primary', 'Export Lottie');
        lottieButton.addEventListener('click', guard('export_lottie', function () {
            var path = projectPath.value.trim();
            var comp = lottieComp.value.trim();
            var output = lottieOutput.value.trim();
            if (!path || !comp || !output) {
                showCardResult(lottieResult, false, 'projectPath, compId and outputPath are required.');
                return;
            }
            if (!/\.(json|lottie)$/i.test(output)) {
                showCardResult(lottieResult, false, 'outputPath must end in .json or .lottie: ' + output);
                return;
            }
            showCardResult(lottieResult, null, 'export_lottie running…');
            callToolTracked('effectcraft.export_lottie', {
                projectPath: path,
                compId: comp,
                outputPath: output,
                includeExpressions: includeExpressions.checked === true,
                textAsShapes: textAsShapes.checked === true
            }).then(function (res) {
                showReceiptResult(lottieResult, res, ['outputPath', 'frames', 'layers']);
            }, function (err) {
                showCardResult(lottieResult, false, err.message);
            });
        }));
        card.appendChild(lottieButton);
        card.appendChild(lottieResult);

        card.appendChild(el('div', 'field-label', 'Timeline export (effectcraft.export_timeline)'));
        var tlComp = makeInput('text', 'comp id (optional)');
        var tlOutput = makeInput('text', 'output path');
        var tlFormat = makeModeSelect(TIMELINE_EXPORT_FORMATS);
        card.appendChild(makeField('compId (optional)', tlComp));
        card.appendChild(makeField('outputPath', tlOutput));
        card.appendChild(makeField('format', tlFormat));
        var tlResult = el('div');
        var tlButton = el('button', 'primary', 'Export timeline');
        tlButton.addEventListener('click', guard('export_timeline', function () {
            var path = projectPath.value.trim();
            var output = tlOutput.value.trim();
            if (!path || !output) {
                showCardResult(tlResult, false, 'projectPath and outputPath are required.');
                return;
            }
            showCardResult(tlResult, null, 'export_timeline running…');
            callToolTracked('effectcraft.export_timeline', {
                projectPath: path,
                compId: tlComp.value.trim() || undefined,
                outputPath: output,
                format: tlFormat.value
            }).then(function (res) {
                showReceiptResult(tlResult, res, ['outputPath', 'format']);
            }, function (err) {
                showCardResult(tlResult, false, err.message);
            });
        }));
        card.appendChild(tlButton);
        card.appendChild(tlResult);

        card.appendChild(el('div', 'field-label', 'Render queue (effectcraft.render_queue)'));
        var queueJobs = el('textarea');
        queueJobs.placeholder = '[{"compId": "main", "outputPath": "D:/out/main.mp4", "format": "h264", "resolution": "full"}]';
        card.appendChild(makeField('jobs (JSON array, 1–10, validated before send)', queueJobs));
        var queueResult = el('div');
        var queueButton = el('button', 'primary', 'Render queue');
        queueButton.addEventListener('click', guard('render_queue', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(queueResult, false, 'projectPath is required.');
                return;
            }
            var jobsRaw = queueJobs.value.trim();
            if (!jobsRaw) {
                showCardResult(queueResult, false, 'jobs is required: a JSON array of 1–10 {compId, outputPath} job objects.');
                return;
            }
            var parsedJobs = parseJsonText(jobsRaw, 'jobs');
            if (!parsedJobs.ok) {
                showCardResult(queueResult, false, parsedJobs.error);
                return;
            }
            var jobs = parsedJobs.value;
            if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 10) {
                showCardResult(queueResult, false, 'jobs must be a JSON array of 1–10 {compId, outputPath} job objects.');
                return;
            }
            var normalizedJobs = [];
            for (var i = 0; i < jobs.length; i++) {
                var jobError = validateQueueJob(jobs[i], i);
                if (jobError) {
                    showCardResult(queueResult, false, jobError);
                    return;
                }
                normalizedJobs.push(normalizeQueueJob(jobs[i]));
            }
            showCardResult(queueResult, null, 'render_queue running…');
            callToolTracked('effectcraft.render_queue', { projectPath: path, jobs: normalizedJobs }).then(function (res) {
                showReceiptResult(queueResult, res, ['allVerified']);
            }, function (err) {
                showCardResult(queueResult, false, err.message);
            });
        }));
        card.appendChild(queueButton);
        card.appendChild(queueResult);

        card.appendChild(el('div', 'field-label', 'Font catalog (effectcraft.list_fonts, read-only)'));
        var fontsQuery = makeInput('text', 'substring query (optional, max 120)');
        card.appendChild(makeField('query (optional)', fontsQuery));
        var fontsResult = el('div');
        var fontsButton = el('button', null, 'List fonts');
        fontsButton.addEventListener('click', guard('list_fonts', function () {
            var query = fontsQuery.value.trim() || undefined;
            if (query && query.length > 120) {
                showCardResult(fontsResult, false, 'query must be at most 120 characters.');
                return;
            }
            showCardResult(fontsResult, null, 'list_fonts running…');
            callToolTracked('effectcraft.list_fonts', { query: query }).then(function (res) {
                showReceiptResult(fontsResult, res, ['query', 'count']);
            }, function (err) {
                showCardResult(fontsResult, false, err.message);
            });
        }));
        card.appendChild(fontsButton);
        card.appendChild(fontsResult);
        root.appendChild(card);
    }

    function buildPanelCards(root) {
        buildSceneRenderCard(root);
        buildCompRenderCard(root);
        buildLayerPropertiesCard(root);
        buildCompExtrasCard(root);
        buildTimelineInterchangeCard(root);
        buildExportQueueCard(root);
    }

    // ------------------------------------------------- shared result helpers
    function showCardResult(container, status, payload) {
        container.textContent = '';
        if (status === null) {
            container.appendChild(el('div', 'inline-note', String(payload)));
            return;
        }
        container.appendChild(el('div', status ? 'result-status-ok' : 'result-status-error', status ? 'ok' : 'error'));
        container.appendChild(el('div', 'inline-error', String(payload)));
    }

    function showReceiptResult(container, result, keys) {
        container.textContent = '';
        container.appendChild(el('div', result.isError ? 'result-status-error' : 'result-status-ok', result.isError ? 'isError: true' : 'ok'));
        var data = result.data;
        if (keys && keys.length && data && typeof data === 'object') {
            var list = el('div', 'kv-list');
            for (var i = 0; i < keys.length; i++) {
                var value = data[keys[i]];
                if (value === undefined && data.receipt && typeof data.receipt === 'object') value = data.receipt[keys[i]];
                list.appendChild(buildKv(keys[i], value));
            }
            container.appendChild(list);
        } else if (result.text !== undefined) {
            container.appendChild(el('pre', 'json', String(result.text)));
        }
    }

    // ---------------------------------------------------------- receipt card
    function buildReceiptCard(root) {
        var card = el('div', 'card');
        var titleRow = el('div', 'receipt-toggle-row');
        titleRow.appendChild(el('h3', 'card-title', 'Receipt log'));
        refs.receiptToggle = el('button', 'link-like', 'Hide');
        refs.receiptToggle.addEventListener('click', guard('receipt.log', function () {
            var collapsed = refs.receiptList.className.indexOf('collapsed') !== -1;
            refs.receiptList.className = collapsed ? 'receipt-list' : 'receipt-list collapsed';
            refs.receiptToggle.textContent = collapsed ? 'Hide' : 'Show';
        }));
        titleRow.appendChild(refs.receiptToggle);
        card.appendChild(titleRow);
        refs.receiptList = el('div', 'receipt-list');
        card.appendChild(refs.receiptList);
        root.appendChild(card);
    }

    // ------------------------------------------------------------ panel root
    function buildPanel(rootNode) {
        rootNode.textContent = '';
        var root = el('div', 'panel-root');

        var header = el('div', 'header');
        var titleRow = el('div', 'header-row');
        titleRow.appendChild(el('span', 'brand', 'Motion Studio — ' + PANEL.title));
        refs.statusPill = el('span', 'status-pill is-disconnected', 'Disconnected');
        titleRow.appendChild(refs.statusPill);
        header.appendChild(titleRow);

        refs.baseUrl = makeInput('text', 'http://127.0.0.1:7420/mcp', PANEL.defaultBaseUrl);
        header.appendChild(makeField('Server URL (use 127.0.0.1, never localhost)', refs.baseUrl));
        refs.token = makeInput('password', 'optional shared token');
        header.appendChild(makeField('Token (x-motion-studio-token)', refs.token));

        var buttonsRow = el('div', 'header-row');
        refs.connectBtn = el('button', 'primary', 'Connect');
        refs.connectBtn.addEventListener('click', guard('connect', connect));
        refs.disconnectBtn = el('button', null, 'Disconnect');
        refs.disconnectBtn.addEventListener('click', guard('disconnect', function () { disconnect(false); }));
        buttonsRow.appendChild(refs.connectBtn);
        buttonsRow.appendChild(refs.disconnectBtn);
        header.appendChild(buttonsRow);

        refs.clearSettingsBtn = el('button', 'link-like', 'Clear saved settings');
        refs.clearSettingsBtn.addEventListener('click', guard('settings.clear', function () {
            clearSettings().then(function () {
                refs.baseUrl.value = PANEL.defaultBaseUrl;
                refs.token.value = '';
                addReceipt({ tool: 'settings.clear', ok: true, json: { cleared: true } });
            });
        }));
        header.appendChild(refs.clearSettingsBtn);
        root.appendChild(header);

        buildEngineCard(root);
        buildToolConsoleCard(root);
        buildPanelCards(root);
        buildReceiptCard(root);

        rootNode.appendChild(root);
        setStatus('disconnected', 'Disconnected');
    }

    var panels = {
        main: {
            create: function (rootNode) {
                try {
                    buildPanel(rootNode);
                    loadSettingsIntoForm();
                } catch (err) {
                    rootNode.textContent = '';
                    rootNode.appendChild(el('div', 'panel-fatal', 'Panel failed to build: ' + (err && err.message ? err.message : String(err))));
                }
            },
            show: function () { /* connection and receipts persist while the panel is hidden */ },
            hide: function () { /* keep running; UXP may park the DOM while hidden */ }
        }
    };

    // UXP picks the panel lifecycle object up either as a global or via
    // module.exports, depending on host runtime — provide both.
    if (typeof module !== 'undefined' && module !== null && module.exports) {
        module.exports.panels = panels;
    }
    if (typeof window !== 'undefined') {
        window.panels = panels;
    }
})();
