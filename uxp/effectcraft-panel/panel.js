/*
 * Motion Studio — EffectCraft UXP panel (After Effects, manifest v5, UXP 9.4 beta).
 * Plain IIFE script, no modules, no eval. index.html loads mcp-http-client.js
 * before this file, so window.MotionStudioMcpClient is available here.
 *
 * Every user handler is wrapped in guard(): failures land in the status pill
 * and the receipt log, never as uncaught exceptions. All timeouts live in the
 * shared client (5 s connect, 30 s calls, AbortController-based).
 *
 * Approval flow: mutating calls build the approval locally via
 * MotionStudioMcpClient.createApproval — toolName is app-prefixed
 * ("effectcraft.run_command" etc.) and args are the SERVER's resolved
 * operation arguments (projectId, runId and timeoutMs: undefined included —
 * see approvedCall); the tool is then called with
 * { approval, projectId, runId, ...opArgs }. Tools the server does not gate
 * (render_scene, render_comp — sandboxed, verified artifact generation) call
 * the tool directly without an approval.
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

    function buildPanelCards(root) {
        buildSceneRenderCard(root);
        buildCompRenderCard(root);
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
