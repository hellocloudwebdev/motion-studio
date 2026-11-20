/*
 * Motion Studio — FilmCraft UXP panel (Premiere Pro 25.2+, manifest v5).
 * Plain IIFE script, no modules, no eval. index.html loads mcp-http-client.js
 * before this file, so window.MotionStudioMcpClient is available here.
 *
 * Every user handler is wrapped in guard(): failures land in the status pill
 * and the receipt log, never as uncaught exceptions. All timeouts live in the
 * shared client (5 s connect, 30 s calls, AbortController-based).
 *
 * Approval flow: mutating calls build the approval locally via
 * MotionStudioMcpClient.createApproval — toolName is app-prefixed
 * ("filmcraft.run_command" etc.) and args are the SERVER's resolved operation
 * arguments (projectId, runId and timeoutMs: undefined included — see
 * approvedCall); the tool is then called with
 * { approval, projectId, runId, ...opArgs }.
 *
 * Cards: Engine, Tool console (command browser + run_command), Import
 * interchange, Inspect, Export master + Export frame (ungated), Probe media,
 * Captions (add_captions/import_captions gated, export_captions ungated),
 * Audio mix (inspect_mixer read-only; set_clip_audio_gain /
 * auto_match_loudness / generate_ducking gated), Narration (TTS)
 * (list_tts_voices read-only; download_tts_voices + create_tts_narration
 * gated), Markers & timing (add_markers / speed_clip / detect_scene_cuts
 * gated), Receipt log.
 *
 * Ungated tools run without an approval: read-only inspections
 * (inspect_project, inspect_sequence, inspect_mixer, probe_media,
 * list_commands, describe_command, check_engine, list_tts_voices) and
 * verified artifact generation (export_master, export_captions,
 * export_frame).
 */
(function () {
    'use strict';

    var PANEL = {
        app: 'filmcraft',
        title: 'FilmCraft',
        defaultBaseUrl: 'http://127.0.0.1:7430/mcp',
        runCommandTool: 'filmcraft.run_command',
        settingsPath: 'plugin-data:/motion-studio-settings.json'
    };

    // Enum surfaces mirrored from packages/filmcraft-mcp-server/src/index.mjs
    // — keep both sides in sync so the selects always send schema-valid values.
    var CAPTION_EXPORT_FORMATS = ['srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp'];
    var CAPTION_TRACK_FORMATS = ['Subtitle', 'CEA-608', 'CEA-708', 'Teletext'];
    var GAIN_MODES = ['set', 'adjust', 'normalizeMax', 'normalizeAll'];
    var TTS_PITCHES = ['extraLow', 'low', 'default', 'high', 'extraHigh'];
    var FRAME_FORMATS = ['png', 'jpeg', 'tiff', 'bmp'];
    var SPEED_INTERPOLATIONS = ['frameSampling', 'frameBlending', 'opticalFlow'];

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

    // Tri-state select for fields the server schema marks optional WITHOUT a
    // default: blank sends undefined so the approval digest matches the
    // server's zod-resolved opArgs.
    function makeOptionalSelect(values, blankLabel) {
        var select = el('select');
        var blank = el('option', null, blankLabel || '— (engine default)');
        blank.value = '';
        select.appendChild(blank);
        for (var i = 0; i < values.length; i++) {
            var option = el('option', null, values[i]);
            option.value = values[i];
            select.appendChild(option);
        }
        return select;
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
        refs.runParams.placeholder = '{"sequenceId": "seq-01"}';
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
                showRunResult(false, 'params must be a JSON object, e.g. {"sequenceId": "seq-01"}.');
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

    // ---------------------------------------------- FilmCraft-specific cards
    function buildImportCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Import interchange (import_interchange)'));
        var fcpxmlPath = makeInput('text', 'path to .fcpxml');
        var projectPath = makeInput('text', 'target .fcproj path');
        card.appendChild(makeField('fcpxmlPath', fcpxmlPath));
        card.appendChild(makeField('projectPath', projectPath));
        var runButton = el('button', 'primary', 'Import interchange');
        var result = el('div');
        runButton.addEventListener('click', guard('import_interchange', function () {
            var xmlPath = fcpxmlPath.value.trim();
            var path = projectPath.value.trim();
            if (!xmlPath || !path) {
                showCardResult(result, false, 'fcpxmlPath and projectPath are required.');
                return;
            }
            showCardResult(result, null, 'import_interchange running…');
            approvedCall('filmcraft.import_interchange', { fcpxmlPath: xmlPath, projectPath: path }).then(function (res) {
                showReceiptResult(result, res, ['verified', 'output', 'duration', 'sha256']);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        card.appendChild(runButton);
        card.appendChild(result);
        root.appendChild(card);
    }

    function buildInspectCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Inspect (read-only)'));
        var projectPath = makeInput('text', 'path to .prproj / .fcproj');
        var sequenceId = makeInput('text', 'sequence id');
        card.appendChild(makeField('projectPath', projectPath));
        card.appendChild(makeField('sequenceId (for inspect_sequence)', sequenceId));
        var inspectProjectButton = el('button', null, 'Inspect project');
        var inspectSequenceButton = el('button', null, 'Inspect sequence');
        var buttonsRow = el('div', 'row');
        buttonsRow.appendChild(inspectProjectButton);
        buttonsRow.appendChild(inspectSequenceButton);
        var result = el('div');
        inspectProjectButton.addEventListener('click', guard('inspect_project', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(result, false, 'projectPath is required.');
                return;
            }
            showCardResult(result, null, 'inspect_project running…');
            callToolTracked('inspect_project', { projectPath: path }).then(function (res) {
                showReceiptResult(result, res, null);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        inspectSequenceButton.addEventListener('click', guard('inspect_sequence', function () {
            var path = projectPath.value.trim();
            var seq = sequenceId.value.trim();
            if (!path || !seq) {
                showCardResult(result, false, 'projectPath and sequenceId are required.');
                return;
            }
            showCardResult(result, null, 'inspect_sequence running…');
            callToolTracked('inspect_sequence', { projectPath: path, sequenceId: seq }).then(function (res) {
                showReceiptResult(result, res, null);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        card.appendChild(buttonsRow);
        card.appendChild(result);
        root.appendChild(card);
    }

    function buildExportCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Export master (export_master)'));
        var projectPath = makeInput('text', 'path to .prproj / .fcproj');
        var outputPath = makeInput('text', 'output file path');
        var format = makeSelect([['h264', 'h264'], ['hevc', 'hevc'], ['prores', 'prores'], ['dnxhr', 'dnxhr'], ['png', 'png'], ['wav', 'wav']]);
        var quality = makeInput('number', 'quality', '90');
        card.appendChild(makeField('projectPath', projectPath));
        card.appendChild(makeField('outputPath', outputPath));
        card.appendChild(makeField('format', format));
        card.appendChild(makeField('quality', quality));
        var noAudioRow = el('div', 'checkbox-row');
        var noAudio = el('input');
        noAudio.type = 'checkbox';
        noAudioRow.appendChild(noAudio);
        noAudioRow.appendChild(el('label', null, 'noAudio (export without audio track)'));
        card.appendChild(noAudioRow);
        var runButton = el('button', 'primary', 'Export master');
        var result = el('div');
        runButton.addEventListener('click', guard('export_master', function () {
            var path = projectPath.value.trim();
            var out = outputPath.value.trim();
            if (!path || !out) {
                showCardResult(result, false, 'projectPath and outputPath are required.');
                return;
            }
            var qualityValue = Number(quality.value);
            if (!isFinite(qualityValue) || qualityValue < 0) {
                showCardResult(result, false, 'quality must be a non-negative number.');
                return;
            }
            var opArgs = {
                projectPath: path,
                outputPath: out,
                format: format.value,
                quality: qualityValue,
                noAudio: noAudio.checked === true
            };
            showCardResult(result, null, 'export_master running…');
            // export_master is verified artifact generation — no approval needed.
            callToolTracked('filmcraft.export_master', opArgs).then(function (res) {
                showReceiptResult(result, res, ['verified', 'output', 'duration', 'sha256']);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        card.appendChild(runButton);
        card.appendChild(result);

        card.appendChild(el('div', 'field-label', 'Export frame (filmcraft.export_frame — ungated, one frame of the saved-active sequence)'));
        var frameOutput = makeInput('text', 'output .png/.jpeg/.tiff/.bmp path');
        var frameFormat = makeModeSelect(FRAME_FORMATS);
        var frameSeconds = makeInput('number', 'seconds (optional, 0–86400)');
        card.appendChild(makeField('outputPath', frameOutput));
        var frameRow = el('div', 'row');
        var frameA = el('div');
        var frameB = el('div');
        frameA.appendChild(makeField('format', frameFormat));
        frameB.appendChild(makeField('seconds (optional)', frameSeconds));
        frameRow.appendChild(frameA);
        frameRow.appendChild(frameB);
        card.appendChild(frameRow);
        var frameResult = el('div');
        var frameButton = el('button', 'primary', 'Export frame');
        frameButton.addEventListener('click', guard('export_frame', function () {
            var path = projectPath.value.trim();
            var output = frameOutput.value.trim();
            if (!path || !output) {
                showCardResult(frameResult, false, 'projectPath and outputPath are required.');
                return;
            }
            var atSeconds = parseNumberInput(frameSeconds);
            if (atSeconds !== undefined && (isNaN(atSeconds) || atSeconds < 0 || atSeconds > 86400)) {
                showCardResult(frameResult, false, 'seconds must be a number between 0 and 86400.');
                return;
            }
            showCardResult(frameResult, null, 'export_frame running…');
            // export_frame is verified artifact generation — no approval needed.
            callToolTracked('filmcraft.export_frame', { projectPath: path, outputPath: output, format: frameFormat.value, seconds: atSeconds }).then(function (res) {
                showReceiptResult(frameResult, res, ['outputPath', 'seconds']);
            }, function (err) {
                showCardResult(frameResult, false, err.message);
            });
        }));
        card.appendChild(frameButton);
        card.appendChild(frameResult);
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

    // The gate digests the zod-parsed payload: unknown keys are stripped and
    // missing optional keys never materialize, so nested objects (cues,
    // markers, style, queue jobs) are rebuilt with exactly the keys the user
    // provided. present-as-undefined is only correct at the TOP level of
    // opArgs, where the server destructures every field into its digest.
    function normalizeCaptionsCues(cues) {
        return cues.map(function (cue) {
            var normalized = { text: cue.text, seconds: cue.seconds };
            if (cue.durationSeconds !== undefined) normalized.durationSeconds = cue.durationSeconds;
            return normalized;
        });
    }

    function normalizeCaptionsStyle(style) {
        var normalized = {};
        if (style.font !== undefined) normalized.font = style.font;
        if (style.size !== undefined) normalized.size = style.size;
        if (style.color !== undefined) normalized.color = style.color;
        return normalized;
    }

    function validateCaptionsCues(cues) {
        if (!Array.isArray(cues) || cues.length < 1 || cues.length > 500) {
            return 'cues must be a JSON array of 1–500 {text, seconds} cues.';
        }
        for (var i = 0; i < cues.length; i++) {
            var cue = cues[i];
            var where = 'cues[' + i + ']';
            if (!cue || typeof cue !== 'object' || Array.isArray(cue)) return where + ' must be a JSON object.';
            if (typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 2000) return where + '.text must be a string of 1–2000 characters.';
            if (typeof cue.seconds !== 'number' || !isFinite(cue.seconds) || cue.seconds < 0 || cue.seconds > 86400) return where + '.seconds must be a number between 0 and 86400.';
            if (cue.durationSeconds !== undefined && (typeof cue.durationSeconds !== 'number' || !isFinite(cue.durationSeconds) || cue.durationSeconds < 0.1 || cue.durationSeconds > 3600)) return where + '.durationSeconds must be a number between 0.1 and 3600.';
        }
        return null;
    }

    function validateCaptionsStyle(style) {
        if (!style || typeof style !== 'object' || Array.isArray(style)) {
            return 'style must be a JSON object like {"font": "Arial", "size": 40, "color": "#FFFFFF"}.';
        }
        if (style.font !== undefined && (typeof style.font !== 'string' || !style.font.trim() || style.font.length > 80)) return 'style.font must be a string of 1–80 characters.';
        if (style.size !== undefined && (typeof style.size !== 'number' || !isFinite(style.size) || style.size < 4 || style.size > 400)) return 'style.size must be a number between 4 and 400.';
        if (style.color !== undefined && (typeof style.color !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(style.color))) return 'style.color must be a #RRGGBB or #RRGGBBAA hex string.';
        return null;
    }

    function normalizeMarkers(markers) {
        return markers.map(function (marker) {
            var normalized = { seconds: marker.seconds };
            if (marker.name !== undefined) normalized.name = marker.name;
            if (marker.comment !== undefined) normalized.comment = marker.comment;
            if (marker.color !== undefined) normalized.color = marker.color;
            if (marker.chapter !== undefined) normalized.chapter = marker.chapter;
            return normalized;
        });
    }

    function validateMarkers(markers) {
        if (!Array.isArray(markers) || markers.length < 1 || markers.length > 200) {
            return 'markers must be a JSON array of 1–200 {seconds, …} entries.';
        }
        for (var i = 0; i < markers.length; i++) {
            var marker = markers[i];
            var where = 'markers[' + i + ']';
            if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return where + ' must be a JSON object.';
            if (typeof marker.seconds !== 'number' || !isFinite(marker.seconds) || marker.seconds < 0 || marker.seconds > 86400) return where + '.seconds must be a number between 0 and 86400.';
            if (marker.name !== undefined && (typeof marker.name !== 'string' || !marker.name.trim() || marker.name.length > 120)) return where + '.name must be a string of 1–120 characters.';
            if (marker.comment !== undefined && (typeof marker.comment !== 'string' || !marker.comment.trim() || marker.comment.length > 500)) return where + '.comment must be a string of 1–500 characters.';
            if (marker.color !== undefined && (typeof marker.color !== 'string' || !marker.color.trim() || marker.color.length > 40)) return where + '.color must be a string of 1–40 characters.';
            if (marker.chapter !== undefined && typeof marker.chapter !== 'boolean') return where + '.chapter must be true or false.';
        }
        return null;
    }

    // ------------------------------------------------------------- captions
    function buildCaptionsCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Captions'));
        card.appendChild(el('div', 'card-sub', 'Create or import caption tracks (gated mutations) and export captions (ungated) — one Run per row, projectPath shared.'));
        var projectPath = makeInput('text', 'path to .prproj / .fcproj');
        card.appendChild(makeField('projectPath', projectPath));

        card.appendChild(el('div', 'field-label', 'Add caption track (filmcraft.add_captions — gated)'));
        var addSequenceId = makeInput('number', 'sequence id (optional)');
        var addTrackFormat = makeModeSelect(CAPTION_TRACK_FORMATS);
        var addTrackName = makeInput('text', 'track name (optional, max 80)');
        var addLanguage = makeInput('text', 'language (optional, e.g. en-US)');
        var addCues = el('textarea');
        addCues.placeholder = '[{"text": "Hello", "seconds": 0, "durationSeconds": 3}]';
        var addStyle = makeInput('text', '{"font": "Arial", "size": 40, "color": "#FFFFFF"} (optional)');
        card.appendChild(makeField('sequenceId (optional)', addSequenceId));
        card.appendChild(makeField('trackFormat', addTrackFormat));
        card.appendChild(makeField('trackName (optional)', addTrackName));
        card.appendChild(makeField('language (optional)', addLanguage));
        card.appendChild(makeField('cues (JSON array, min 1, validated before send)', addCues));
        card.appendChild(makeField('style (JSON object, optional)', addStyle));
        var addResult = el('div');
        var addButton = el('button', 'primary', 'Add captions');
        addButton.addEventListener('click', guard('add_captions', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(addResult, false, 'projectPath is required.');
                return;
            }
            var sequenceId = parseNumberInput(addSequenceId);
            if (sequenceId !== undefined && !isInteger(sequenceId)) {
                showCardResult(addResult, false, 'sequenceId must be an integer (blank targets the saved-active sequence).');
                return;
            }
            var cuesRaw = addCues.value.trim();
            if (!cuesRaw) {
                showCardResult(addResult, false, 'cues is required: a JSON array of at least one {text, seconds} cue.');
                return;
            }
            var parsedCues = parseJsonText(cuesRaw, 'cues');
            if (!parsedCues.ok) {
                showCardResult(addResult, false, parsedCues.error);
                return;
            }
            var cueError = validateCaptionsCues(parsedCues.value);
            if (cueError) {
                showCardResult(addResult, false, cueError);
                return;
            }
            var style = undefined;
            var styleRaw = addStyle.value.trim();
            if (styleRaw) {
                var parsedStyle = parseJsonText(styleRaw, 'style');
                if (!parsedStyle.ok) {
                    showCardResult(addResult, false, parsedStyle.error);
                    return;
                }
                var styleError = validateCaptionsStyle(parsedStyle.value);
                if (styleError) {
                    showCardResult(addResult, false, styleError);
                    return;
                }
                style = normalizeCaptionsStyle(parsedStyle.value);
            }
            showCardResult(addResult, null, 'add_captions running…');
            approvedCall('filmcraft.add_captions', {
                projectPath: path,
                sequenceId: sequenceId,
                trackFormat: addTrackFormat.value,
                trackName: addTrackName.value.trim() || undefined,
                language: addLanguage.value.trim() || undefined,
                cues: normalizeCaptionsCues(parsedCues.value),
                style: style
            }).then(function (res) {
                showReceiptResult(addResult, res, ['trackId', 'trackFormat', 'count']);
            }, function (err) {
                showCardResult(addResult, false, err.message);
            });
        }));
        card.appendChild(addButton);
        card.appendChild(addResult);

        card.appendChild(el('div', 'field-label', 'Import captions (filmcraft.import_captions — gated, .srt / .vtt)'));
        var importPath = makeInput('text', 'path to .srt / .vtt');
        var importName = makeInput('text', 'track name (optional, max 80)');
        var importLanguage = makeInput('text', 'language (optional)');
        card.appendChild(makeField('path', importPath));
        card.appendChild(makeField('name (optional)', importName));
        card.appendChild(makeField('language (optional)', importLanguage));
        var importResult = el('div');
        var importButton = el('button', 'primary', 'Import captions');
        importButton.addEventListener('click', guard('import_captions', function () {
            var path = projectPath.value.trim();
            var captionPath = importPath.value.trim();
            if (!path || !captionPath) {
                showCardResult(importResult, false, 'projectPath and path are required.');
                return;
            }
            showCardResult(importResult, null, 'import_captions running…');
            approvedCall('filmcraft.import_captions', {
                projectPath: path,
                path: captionPath,
                name: importName.value.trim() || undefined,
                language: importLanguage.value.trim() || undefined
            }).then(function (res) {
                showReceiptResult(importResult, res, ['trackId', 'format', 'count']);
            }, function (err) {
                showCardResult(importResult, false, err.message);
            });
        }));
        card.appendChild(importButton);
        card.appendChild(importResult);

        card.appendChild(el('div', 'field-label', 'Export captions (filmcraft.export_captions — ungated, saved-active sequence)'));
        var exportOutput = makeInput('text', 'output path');
        var exportFormat = makeModeSelect(CAPTION_EXPORT_FORMATS);
        var exportTrack = makeInput('number', 'caption track number (optional)');
        card.appendChild(makeField('outputPath', exportOutput));
        card.appendChild(makeField('format', exportFormat));
        card.appendChild(makeField('track (optional)', exportTrack));
        var exportResult = el('div');
        var exportButton = el('button', 'primary', 'Export captions');
        exportButton.addEventListener('click', guard('export_captions', function () {
            var path = projectPath.value.trim();
            var output = exportOutput.value.trim();
            if (!path || !output) {
                showCardResult(exportResult, false, 'projectPath and outputPath are required.');
                return;
            }
            var track = parseNumberInput(exportTrack);
            if (track !== undefined && !isInteger(track)) {
                showCardResult(exportResult, false, 'track must be an integer (blank exports the saved-active track).');
                return;
            }
            showCardResult(exportResult, null, 'export_captions running…');
            callToolTracked('filmcraft.export_captions', { projectPath: path, outputPath: output, format: exportFormat.value, track: track }).then(function (res) {
                showReceiptResult(exportResult, res, ['outputPath', 'format']);
            }, function (err) {
                showCardResult(exportResult, false, err.message);
            });
        }));
        card.appendChild(exportButton);
        card.appendChild(exportResult);
        root.appendChild(card);
    }

    // -------------------------------------------------------------- audio mix
    function mixerStripLabel(strip, index) {
        return (strip && (strip.ref || strip.name)) ? String(strip.ref || strip.name) : 'strip ' + (index + 1);
    }

    function mixerStripSummary(strip) {
        var parts = [];
        if (strip && strip.name && strip.ref && strip.name !== strip.ref) parts.push(String(strip.name));
        if (strip && strip.kind) parts.push(String(strip.kind));
        parts.push('vol ' + (strip && strip.volumeDb !== undefined && strip.volumeDb !== null ? strip.volumeDb : '—') + ' dB');
        parts.push('pan ' + (strip && strip.pan !== undefined && strip.pan !== null ? strip.pan : '—'));
        if (strip && strip.muted) parts.push('muted');
        if (strip && strip.solo) parts.push('solo');
        if (strip && strip.mode) parts.push(String(strip.mode));
        return parts.join(' · ');
    }

    function showMixerResult(container, result) {
        var data = result.data;
        var strips = data && Array.isArray(data.strips) ? data.strips : [];
        if (!strips.length) {
            showReceiptResult(container, result, null);
            return;
        }
        container.textContent = '';
        container.appendChild(el('div', result.isError ? 'result-status-error' : 'result-status-ok', result.isError ? 'isError: true' : 'ok'));
        var list = el('div', 'kv-list');
        for (var i = 0; i < strips.length; i++) {
            list.appendChild(buildKv(mixerStripLabel(strips[i], i), mixerStripSummary(strips[i])));
        }
        container.appendChild(list);
    }

    function buildAudioMixCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Audio mix'));
        card.appendChild(el('div', 'card-sub', 'Mixer inspection (read-only) and gated audio mutations — one Run per row, projectPath shared.'));
        var projectPath = makeInput('text', 'path to .prproj / .fcproj');
        card.appendChild(makeField('projectPath', projectPath));

        card.appendChild(el('div', 'field-label', 'Mixer (filmcraft.inspect_mixer, read-only)'));
        var mixerSequenceId = makeInput('number', 'sequence id (optional)');
        card.appendChild(makeField('sequenceId (optional)', mixerSequenceId));
        var mixerResult = el('div');
        var mixerButton = el('button', null, 'Inspect mixer');
        mixerButton.addEventListener('click', guard('inspect_mixer', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(mixerResult, false, 'projectPath is required.');
                return;
            }
            var sequenceId = parseNumberInput(mixerSequenceId);
            if (sequenceId !== undefined && !isInteger(sequenceId)) {
                showCardResult(mixerResult, false, 'sequenceId must be an integer (blank inspects the saved-active sequence).');
                return;
            }
            showCardResult(mixerResult, null, 'inspect_mixer running…');
            callToolTracked('filmcraft.inspect_mixer', { projectPath: path, sequenceId: sequenceId }).then(function (res) {
                showMixerResult(mixerResult, res);
            }, function (err) {
                showCardResult(mixerResult, false, err.message);
            });
        }));
        card.appendChild(mixerButton);
        card.appendChild(mixerResult);

        card.appendChild(el('div', 'field-label', 'Clip gain (filmcraft.set_clip_audio_gain — gated, exactly one of clipOrdinal / clipId)'));
        var gainOrdinal = makeInput('number', 'clip ordinal (1 = first audio clip)');
        var gainClipId = makeInput('number', 'clipId (optional)');
        var gainMode = makeModeSelect(GAIN_MODES);
        var gainDb = makeInput('number', 'gain dB (-96 to 24)');
        var gainRow = el('div', 'row');
        var gainA = el('div');
        var gainB = el('div');
        gainA.appendChild(makeField('clipOrdinal (optional)', gainOrdinal));
        gainB.appendChild(makeField('clipId (optional)', gainClipId));
        gainRow.appendChild(gainA);
        gainRow.appendChild(gainB);
        card.appendChild(gainRow);
        card.appendChild(makeField('mode', gainMode));
        card.appendChild(makeField('db', gainDb));
        var gainResult = el('div');
        var gainButton = el('button', 'primary', 'Set audio gain');
        gainButton.addEventListener('click', guard('set_clip_audio_gain', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(gainResult, false, 'projectPath is required.');
                return;
            }
            var ordinal = parseNumberInput(gainOrdinal);
            if (ordinal !== undefined && !isInteger(ordinal)) {
                showCardResult(gainResult, false, 'clipOrdinal must be an integer >= 1 (1 = first audio clip).');
                return;
            }
            var clipIdValue = parseNumberInput(gainClipId);
            if (clipIdValue !== undefined && !isInteger(clipIdValue)) {
                showCardResult(gainResult, false, 'clipId must be an integer (blank resolves the clip from clipOrdinal).');
                return;
            }
            if (Boolean(ordinal !== undefined) === Boolean(clipIdValue !== undefined)) {
                showCardResult(gainResult, false, 'Provide exactly one of clipOrdinal (1-based audio clip position) or clipId (runtime clip id).');
                return;
            }
            var dbValue = parseNumberInput(gainDb);
            if (dbValue === undefined || isNaN(dbValue) || dbValue < -96 || dbValue > 24) {
                showCardResult(gainResult, false, 'db is required and must be between -96 and 24.');
                return;
            }
            showCardResult(gainResult, null, 'set_clip_audio_gain running…');
            approvedCall('filmcraft.set_clip_audio_gain', { projectPath: path, clipOrdinal: ordinal, clipId: clipIdValue, mode: gainMode.value, db: dbValue }).then(function (res) {
                showReceiptResult(gainResult, res, ['clipId', 'mode', 'gainDb']);
            }, function (err) {
                showCardResult(gainResult, false, err.message);
            });
        }));
        card.appendChild(gainButton);
        card.appendChild(gainResult);

        card.appendChild(el('div', 'field-label', 'Loudness (filmcraft.auto_match_loudness — gated)'));
        var loudnessOrdinal = makeInput('number', 'clip ordinal (optional — blank matches all audio clips)');
        var loudnessTarget = makeInput('number', 'target LUFS (-48 to -6)', '-16');
        card.appendChild(makeField('clipOrdinal (optional)', loudnessOrdinal));
        card.appendChild(makeField('targetLufs (server default -16)', loudnessTarget));
        var loudnessResult = el('div');
        var loudnessButton = el('button', 'primary', 'Auto match loudness');
        loudnessButton.addEventListener('click', guard('auto_match_loudness', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(loudnessResult, false, 'projectPath is required.');
                return;
            }
            var ordinal = parseNumberInput(loudnessOrdinal);
            if (ordinal !== undefined && !isInteger(ordinal)) {
                showCardResult(loudnessResult, false, 'clipOrdinal must be an integer >= 1 (blank matches all audio clips).');
                return;
            }
            // The server schema defaults targetLufs to -16, so the resolved
            // digest always carries a number — blank resolves to the default.
            var targetLufs = parseNumberInput(loudnessTarget);
            if (targetLufs === undefined) targetLufs = -16;
            if (isNaN(targetLufs) || targetLufs < -48 || targetLufs > -6) {
                showCardResult(loudnessResult, false, 'targetLufs must be a number between -48 and -6.');
                return;
            }
            showCardResult(loudnessResult, null, 'auto_match_loudness running…');
            approvedCall('filmcraft.auto_match_loudness', { projectPath: path, clipOrdinal: ordinal, targetLufs: targetLufs }).then(function (res) {
                showReceiptResult(loudnessResult, res, ['targetLufs', 'classifiedAsDialogue']);
            }, function (err) {
                showCardResult(loudnessResult, false, err.message);
            });
        }));
        card.appendChild(loudnessButton);
        card.appendChild(loudnessResult);

        card.appendChild(el('div', 'field-label', 'Ducking (filmcraft.generate_ducking — gated, ducks Music/Ambience clips)'));
        var duckOrdinal = makeInput('number', 'clip ordinal (optional — blank ducks all audio clips)');
        card.appendChild(makeField('clipOrdinal (optional)', duckOrdinal));
        var duckResult = el('div');
        var duckButton = el('button', 'primary', 'Generate ducking');
        duckButton.addEventListener('click', guard('generate_ducking', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(duckResult, false, 'projectPath is required.');
                return;
            }
            var ordinal = parseNumberInput(duckOrdinal);
            if (ordinal !== undefined && !isInteger(ordinal)) {
                showCardResult(duckResult, false, 'clipOrdinal must be an integer >= 1 (blank ducks all audio clips).');
                return;
            }
            showCardResult(duckResult, null, 'generate_ducking running…');
            approvedCall('filmcraft.generate_ducking', { projectPath: path, clipOrdinal: ordinal }).then(function (res) {
                showReceiptResult(duckResult, res, ['sequenceId', 'clips']);
            }, function (err) {
                showCardResult(duckResult, false, err.message);
            });
        }));
        card.appendChild(duckButton);
        card.appendChild(duckResult);
        root.appendChild(card);
    }

    // ---------------------------------------------------------- narration TTS
    function showTtsVoicesResult(container, result) {
        var data = result.data;
        if (!data || typeof data !== 'object') {
            showReceiptResult(container, result, null);
            return;
        }
        container.textContent = '';
        container.appendChild(el('div', result.isError ? 'result-status-error' : 'result-status-ok', result.isError ? 'isError: true' : 'ok'));
        var list = el('div', 'kv-list');
        list.appendChild(buildKv('installed', data.installed === true ? 'yes' : 'no'));
        list.appendChild(buildKv('missingBytes', data.missingBytes !== undefined && data.missingBytes !== null ? data.missingBytes : '—'));
        list.appendChild(buildKv('defaultVoice', data.defaultVoice !== undefined && data.defaultVoice !== null ? data.defaultVoice : '—'));
        container.appendChild(list);
        if (data.installed !== true && data.guidance) {
            container.appendChild(el('div', 'inline-note', String(data.guidance)));
        }
    }

    function buildNarrationCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Narration (TTS)'));
        card.appendChild(el('div', 'card-sub', 'Voice catalog (read-only), voice package download (gated) and text-to-speech narration (gated).'));

        card.appendChild(el('div', 'field-label', 'Voices (filmcraft.list_tts_voices, read-only)'));
        var voicesResult = el('div');
        var voicesButton = el('button', null, 'List TTS voices');
        voicesButton.addEventListener('click', guard('list_tts_voices', function () {
            showCardResult(voicesResult, null, 'list_tts_voices running…');
            callToolTracked('filmcraft.list_tts_voices', {}).then(function (res) {
                showTtsVoicesResult(voicesResult, res);
            }, function (err) {
                showCardResult(voicesResult, false, err.message);
            });
        }));
        card.appendChild(voicesButton);
        card.appendChild(voicesResult);

        card.appendChild(el('div', 'field-label', 'Download voices (filmcraft.download_tts_voices — gated, no project needed)'));
        var waitRow = el('div', 'checkbox-row');
        var waitCheckbox = el('input');
        waitCheckbox.type = 'checkbox';
        waitCheckbox.checked = true;
        waitRow.appendChild(waitCheckbox);
        waitRow.appendChild(el('label', null, 'wait for the download to finish (~336 MB)'));
        card.appendChild(waitRow);
        var downloadResult = el('div');
        var downloadButton = el('button', 'primary', 'Download voices');
        downloadButton.addEventListener('click', guard('download_tts_voices', function () {
            showCardResult(downloadResult, null, 'download_tts_voices running…');
            approvedCall('filmcraft.download_tts_voices', { wait: waitCheckbox.checked === true }).then(function (res) {
                showReceiptResult(downloadResult, res, ['installed']);
            }, function (err) {
                showCardResult(downloadResult, false, err.message);
            });
        }));
        card.appendChild(downloadButton);
        card.appendChild(downloadResult);

        card.appendChild(el('div', 'field-label', 'Narration (filmcraft.create_tts_narration — gated)'));
        var projectPath = makeInput('text', 'path to .prproj / .fcproj');
        var narrationText = el('textarea');
        narrationText.placeholder = 'Narration text (1–20000 characters)';
        var voice = makeInput('text', 'voice name (optional, max 80)');
        var pitch = makeOptionalSelect(TTS_PITCHES);
        var pace = makeInput('number', 'pace 0.5–2 (optional)');
        var track = makeInput('text', 'audio track', 'A1');
        var atSeconds = makeInput('number', 'start seconds (optional)');
        card.appendChild(makeField('projectPath', projectPath));
        card.appendChild(makeField('text', narrationText));
        card.appendChild(makeField('voice (optional)', voice));
        card.appendChild(makeField('pitch (optional)', pitch));
        card.appendChild(makeField('pace (optional)', pace));
        card.appendChild(makeField('track (server default A1)', track));
        card.appendChild(makeField('atSeconds (optional)', atSeconds));
        var narrationResult = el('div');
        var narrationButton = el('button', 'primary', 'Create narration');
        narrationButton.addEventListener('click', guard('create_tts_narration', function () {
            var path = projectPath.value.trim();
            var text = narrationText.value.trim();
            if (!path) {
                showCardResult(narrationResult, false, 'projectPath is required.');
                return;
            }
            if (!text) {
                showCardResult(narrationResult, false, 'text is required (1–20000 characters).');
                return;
            }
            if (text.length > 20000) {
                showCardResult(narrationResult, false, 'text must be at most 20000 characters.');
                return;
            }
            var voiceValue = voice.value.trim() || undefined;
            if (voiceValue && voiceValue.length > 80) {
                showCardResult(narrationResult, false, 'voice must be at most 80 characters.');
                return;
            }
            var paceValue = parseNumberInput(pace);
            if (paceValue !== undefined && (isNaN(paceValue) || paceValue < 0.5 || paceValue > 2)) {
                showCardResult(narrationResult, false, 'pace must be a number between 0.5 and 2.');
                return;
            }
            // The server schema defaults track to 'A1', so the resolved digest
            // always carries a string — blank resolves to the default.
            var trackValue = track.value.trim() || 'A1';
            if (trackValue.length > 20) {
                showCardResult(narrationResult, false, 'track must be at most 20 characters.');
                return;
            }
            var atSecondsValue = parseNumberInput(atSeconds);
            if (atSecondsValue !== undefined && (isNaN(atSecondsValue) || atSecondsValue < 0)) {
                showCardResult(narrationResult, false, 'atSeconds must be a number >= 0.');
                return;
            }
            showCardResult(narrationResult, null, 'create_tts_narration running…');
            approvedCall('filmcraft.create_tts_narration', {
                projectPath: path,
                text: text,
                voice: voiceValue,
                pitch: pitch.value || undefined,
                pace: paceValue,
                track: trackValue,
                atSeconds: atSecondsValue
            }).then(function (res) {
                showReceiptResult(narrationResult, res, ['clipId']);
            }, function (err) {
                showCardResult(narrationResult, false, err.message);
            });
        }));
        card.appendChild(narrationButton);
        card.appendChild(narrationResult);
        root.appendChild(card);
    }

    // -------------------------------------------------------- markers & timing
    function buildMarkersTimingCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Markers & timing'));
        card.appendChild(el('div', 'card-sub', 'Markers, speed changes and scene edit detection — all gated mutations needing a producer approval.'));
        var projectPath = makeInput('text', 'path to .prproj / .fcproj');
        card.appendChild(makeField('projectPath', projectPath));

        card.appendChild(el('div', 'field-label', 'Markers (filmcraft.add_markers — gated)'));
        var markersSequenceId = makeInput('number', 'sequence id (optional)');
        var markersJson = el('textarea');
        markersJson.placeholder = '[{"seconds": 1.5, "name": "Intro", "comment": "…", "color": "Blue", "chapter": true}]';
        card.appendChild(makeField('sequenceId (optional)', markersSequenceId));
        card.appendChild(makeField('markers (JSON array, min 1, validated before send)', markersJson));
        var markersResult = el('div');
        var markersButton = el('button', 'primary', 'Add markers');
        markersButton.addEventListener('click', guard('add_markers', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(markersResult, false, 'projectPath is required.');
                return;
            }
            var sequenceId = parseNumberInput(markersSequenceId);
            if (sequenceId !== undefined && !isInteger(sequenceId)) {
                showCardResult(markersResult, false, 'sequenceId must be an integer (blank targets the saved-active sequence).');
                return;
            }
            var markersRaw = markersJson.value.trim();
            if (!markersRaw) {
                showCardResult(markersResult, false, 'markers is required: a JSON array of at least one {seconds, …} entry.');
                return;
            }
            var parsedMarkers = parseJsonText(markersRaw, 'markers');
            if (!parsedMarkers.ok) {
                showCardResult(markersResult, false, parsedMarkers.error);
                return;
            }
            var markersError = validateMarkers(parsedMarkers.value);
            if (markersError) {
                showCardResult(markersResult, false, markersError);
                return;
            }
            showCardResult(markersResult, null, 'add_markers running…');
            approvedCall('filmcraft.add_markers', { projectPath: path, sequenceId: sequenceId, markers: normalizeMarkers(parsedMarkers.value) }).then(function (res) {
                showReceiptResult(markersResult, res, ['sequenceId', 'markerCount']);
            }, function (err) {
                showCardResult(markersResult, false, err.message);
            });
        }));
        card.appendChild(markersButton);
        card.appendChild(markersResult);

        card.appendChild(el('div', 'field-label', 'Speed (filmcraft.speed_clip — gated)'));
        var speedOrdinal = makeInput('number', 'clip ordinal (1 = first clip)');
        var speedPercent = makeInput('number', 'speed % (5–2000)');
        var reverseRow = el('div', 'checkbox-row');
        var reverse = el('input');
        reverse.type = 'checkbox';
        reverseRow.appendChild(reverse);
        reverseRow.appendChild(el('label', null, 'reverse the clip'));
        var maintainPitch = makeOptionalSelect(['true', 'false']);
        var interpolation = makeOptionalSelect(SPEED_INTERPOLATIONS);
        card.appendChild(makeField('clipOrdinal', speedOrdinal));
        card.appendChild(makeField('speedPercent', speedPercent));
        card.appendChild(reverseRow);
        card.appendChild(makeField('maintainPitch (optional)', maintainPitch));
        card.appendChild(makeField('interpolation (optional)', interpolation));
        var speedResult = el('div');
        var speedButton = el('button', 'primary', 'Speed clip');
        speedButton.addEventListener('click', guard('speed_clip', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(speedResult, false, 'projectPath is required.');
                return;
            }
            var ordinal = parseNumberInput(speedOrdinal);
            if (ordinal === undefined || !isInteger(ordinal) || ordinal < 1) {
                showCardResult(speedResult, false, 'clipOrdinal is required and must be an integer >= 1 (1 = first clip).');
                return;
            }
            var percent = parseNumberInput(speedPercent);
            if (percent === undefined || isNaN(percent) || percent < 5 || percent > 2000) {
                showCardResult(speedResult, false, 'speedPercent is required and must be between 5 and 2000.');
                return;
            }
            var maintainPitchValue = maintainPitch.value === 'true' ? true : (maintainPitch.value === 'false' ? false : undefined);
            showCardResult(speedResult, null, 'speed_clip running…');
            approvedCall('filmcraft.speed_clip', {
                projectPath: path,
                clipOrdinal: ordinal,
                speedPercent: percent,
                reverse: reverse.checked === true,
                maintainPitch: maintainPitchValue,
                interpolation: interpolation.value || undefined
            }).then(function (res) {
                showReceiptResult(speedResult, res, ['speed', 'observedSpeed', 'verified']);
            }, function (err) {
                showCardResult(speedResult, false, err.message);
            });
        }));
        card.appendChild(speedButton);
        card.appendChild(speedResult);

        card.appendChild(el('div', 'field-label', 'Scene cuts (filmcraft.detect_scene_cuts — gated)'));
        var detectOrdinal = makeInput('number', 'clip ordinal (1 = first video clip)');
        var detectSensitivity = makeInput('number', 'sensitivity 0–100', '50');
        var detectMinFrames = makeInput('number', 'min shot frames', '6');
        var detectMarkersRow = el('div', 'checkbox-row');
        var detectMarkers = el('input');
        detectMarkers.type = 'checkbox';
        detectMarkersRow.appendChild(detectMarkers);
        detectMarkersRow.appendChild(el('label', null, 'generate markers for the cuts'));
        card.appendChild(makeField('clipOrdinal', detectOrdinal));
        card.appendChild(makeField('sensitivity (server default 50)', detectSensitivity));
        card.appendChild(makeField('minShotFrames (server default 6)', detectMinFrames));
        card.appendChild(detectMarkersRow);
        var detectResult = el('div');
        var detectButton = el('button', 'primary', 'Detect scene cuts');
        detectButton.addEventListener('click', guard('detect_scene_cuts', function () {
            var path = projectPath.value.trim();
            if (!path) {
                showCardResult(detectResult, false, 'projectPath is required.');
                return;
            }
            var ordinal = parseNumberInput(detectOrdinal);
            if (ordinal === undefined || !isInteger(ordinal) || ordinal < 1) {
                showCardResult(detectResult, false, 'clipOrdinal is required and must be an integer >= 1 (1 = first video clip).');
                return;
            }
            // The server schema defaults sensitivity to 50 and minShotFrames
            // to 6, so the resolved digest always carries numbers — blanks
            // resolve to the defaults.
            var sensitivity = parseNumberInput(detectSensitivity);
            if (sensitivity === undefined) sensitivity = 50;
            if (isNaN(sensitivity) || sensitivity < 0 || sensitivity > 100) {
                showCardResult(detectResult, false, 'sensitivity must be a number between 0 and 100.');
                return;
            }
            var minShotFrames = parseNumberInput(detectMinFrames);
            if (minShotFrames === undefined) minShotFrames = 6;
            if (!isInteger(minShotFrames) || minShotFrames < 1) {
                showCardResult(detectResult, false, 'minShotFrames must be an integer >= 1.');
                return;
            }
            showCardResult(detectResult, null, 'detect_scene_cuts running…');
            approvedCall('filmcraft.detect_scene_cuts', {
                projectPath: path,
                clipOrdinal: ordinal,
                sensitivity: sensitivity,
                minShotFrames: minShotFrames,
                generateMarkers: detectMarkers.checked === true
            }).then(function (res) {
                showReceiptResult(detectResult, res, ['clipId', 'cuts']);
            }, function (err) {
                showCardResult(detectResult, false, err.message);
            });
        }));
        card.appendChild(detectButton);
        card.appendChild(detectResult);
        root.appendChild(card);
    }

    function buildProbeCard(root) {
        var card = el('div', 'card');
        card.appendChild(el('h3', 'card-title', 'Probe media (probe_media, read-only)'));
        var mediaPath = makeInput('text', 'path to a media file');
        card.appendChild(makeField('mediaPath', mediaPath));
        var runButton = el('button', null, 'Probe media');
        var result = el('div');
        runButton.addEventListener('click', guard('probe_media', function () {
            var path = mediaPath.value.trim();
            if (!path) {
                showCardResult(result, false, 'mediaPath is required.');
                return;
            }
            showCardResult(result, null, 'probe_media running…');
            callToolTracked('probe_media', { mediaPath: path }).then(function (res) {
                showReceiptResult(result, res, null);
            }, function (err) {
                showCardResult(result, false, err.message);
            });
        }));
        card.appendChild(runButton);
        card.appendChild(result);
        root.appendChild(card);
    }

    function buildPanelCards(root) {
        buildImportCard(root);
        buildInspectCard(root);
        buildExportCard(root);
        buildCaptionsCard(root);
        buildAudioMixCard(root);
        buildNarrationCard(root);
        buildMarkersTimingCard(root);
        buildProbeCard(root);
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

        refs.baseUrl = makeInput('text', 'http://127.0.0.1:7430/mcp', PANEL.defaultBaseUrl);
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
