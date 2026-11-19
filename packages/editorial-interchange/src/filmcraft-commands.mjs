import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { craftCommandCandidates } from '../../craft-mcp-client/src/index.mjs';

// Apply a video transition (e.g. cross_dissolve) across a clip boundary in a
// saved FilmCraft project. The clip ids are discovered from the sequence
// inspect, so callers only name the track and the clip ordinal (1-based from
// the track start): the transition is applied at that clip's boundary.
export async function applyFilmCraftTransition({ projectPath, track = 'V1', clipOrdinal = 1, effect = 'cross_dissolve', frames = 24, filmcraftCommand, signal, timeoutMs = 300_000, onLine } = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('A saved .fcproj project path is required.');
  if (!Number.isInteger(clipOrdinal) || clipOrdinal < 1) throw new Error('clipOrdinal must be a 1-based integer.');
  if (!Number.isInteger(frames) || frames <= 0) throw new Error('frames must be a positive integer.');
  const resolvedProject = path.resolve(projectPath);
  const command = filmcraftCommand ?? await resolveFilmcraftCommand();

  const inspectOut = await runFilmcraftCli(command, ['--project', resolvedProject, 'inspect', 'sequence'], { signal, timeoutMs, onLine });
  const sequence = parseJsonOutput(inspectOut.stdout);
  const trackEntry = (sequence.video || []).find(entry => entry.name === track) || (sequence.video || [])[0];
  if (!trackEntry) throw new Error('FilmCraft sequence has no video track to transition on.');
  const clips = (trackEntry.items || []).map(item => item.clip).filter(id => Number.isInteger(id));
  if (clips.length < clipOrdinal + 1) throw new Error('FilmCraft sequence has ' + clips.length + ' clip(s) on ' + (trackEntry.name || track) + '; a transition at clip ' + clipOrdinal + ' needs at least ' + (clipOrdinal + 1) + '.');

  const phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-filmcraft-transition-'));
  try {
    const sessionFile = path.join(phaseRoot, 'transition.jsonl');
    const steps = [
      { id: 'sequence.open', params: { item: sequence.id } },
      { id: 'sequence.applyVideoTransition', params: { clip: clips[clipOrdinal - 1], effect, frames } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    await writeFile(sessionFile, steps.map(step => JSON.stringify(step)).join('\n') + '\n', 'utf8');
    await runFilmcraftCli(command, ['--project', resolvedProject, 'run', '--commands', sessionFile], { signal, timeoutMs, onLine });
    return {
      ok: true,
      projectPath: resolvedProject,
      sequenceId: sequence.id,
      clip: clips[clipOrdinal - 1],
      effect,
      frames
    };
  } finally {
    await rm(phaseRoot, { recursive: true, force: true });
  }
}

// FilmCraft handoff (2026-11-15): FilmCraft's `file.import` is polymorphic —
// it accepts media files AND interchange documents, importing a Motion Studio
// FCPXML as a linked-media sequence (documents[0].linkedMedia / .sequences).
// So the earlier "FCPXML import gap" does not exist; this module performs the
// handoff end-to-end: import the FCPXML in one headless session, save the
// project, reopen it, discover the imported sequence id from the project tree
// and activate it — then the CLI export subcommand can render the master.

export async function resolveFilmcraftCommand() {
  for (const candidate of craftCommandCandidates({ app: 'filmcraft' })) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('filmcraft-cli was not found on this machine. Install FilmCraft (https://github.com/storytold/filmcraft) or pass filmcraftCommand/--filmcraft-cli explicitly.');
}

function runFilmcraftCli(command, args, { signal, timeoutMs = 300_000, onLine } = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('FilmCraft bridge requires a validated argument array.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (onLine) for (const line of chunk.split(/\r?\n/)) if (line.trim()) onLine(line);
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        // filmcraft reports per-step failures as {"ok":false} lines on stdout.
        const failures = stdout.split(/\r?\n/).filter(line => line.includes('"ok":false')).slice(-3);
        reject(new Error('filmcraft-cli run failed (exit ' + code + '). ' + (failures.join(' | ') || stderr.slice(-500) || 'no step output')));
      }
    });
  });
}

// Find a Sequence item anywhere in the project tree (sequences land inside a
// bin named after the project when imported from FCPXML).
function findSequenceItem(node) {
  if (!node || typeof node !== 'object') return null;
  if (String(node.type || '').toLowerCase() === 'sequence') return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findSequenceItem(child);
    if (found) return found;
  }
  return null;
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('filmcraft-cli did not print a JSON result.');
  return JSON.parse(stdout.slice(start));
}

export async function importInterchangeIntoFilmCraft({ fcpxmlPath, projectPath, filmcraftCommand, signal, timeoutMs = 300_000, onLine } = {}) {
  if (typeof fcpxmlPath !== 'string' || !fcpxmlPath.trim()) throw new Error('A FCPXML interchange path is required.');
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('A target .fcproj project path is required.');
  if (!existsSync(fcpxmlPath)) throw new Error('The FCPXML interchange file does not exist: ' + fcpxmlPath);
  const resolvedFcpxml = path.resolve(fcpxmlPath);
  const resolvedProject = path.resolve(projectPath);
  const command = filmcraftCommand ?? await resolveFilmcraftCommand();

  const phaseRoot = await mkdtemp(path.join(os.tmpdir(), 'motion-filmcraft-handoff-'));
  try {
    // Session 1: import the interchange document and save in the SAME session
    // — a saveAs from a separate session would persist an empty project.
    const sessionFile = path.join(phaseRoot, 'import.jsonl');
    const steps = [
      { id: 'file.newProject', params: { name: path.basename(resolvedProject, '.fcproj').slice(0, 100) } },
      { id: 'file.import', params: { paths: [resolvedFcpxml] } },
      { id: 'file.saveAs', params: { path: resolvedProject } }
    ];
    await writeFile(sessionFile, steps.map(step => JSON.stringify(step)).join('\n') + '\n', 'utf8');
    const runOut = await runFilmcraftCli(command, ['run', '--commands', sessionFile], { signal, timeoutMs, onLine });
    const runResults = runOut.stdout.split(/\r?\n/).filter(line => line.includes('"file.import"')).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const importResult = runResults.find(entry => entry.ok === true)?.result;
    if (!importResult?.documents?.length) throw new Error('FilmCraft imported the interchange but reported no document: ' + JSON.stringify(importResult ?? {}));
    const document = importResult.documents[0];

    // Session 2: reopen the saved project, discover the sequence id and
    // activate it so the CLI export subcommand targets it.
    const inspectOut = await runFilmcraftCli(command, ['--project', resolvedProject, 'inspect', 'project'], { signal, timeoutMs, onLine });
    const tree = parseJsonOutput(inspectOut.stdout);
    const sequenceItem = findSequenceItem(tree.root);
    if (!sequenceItem) throw new Error('The imported project contains no sequence item; the FCPXML may have described only unsupported clips.');
    if (tree.activeSequence !== sequenceItem.item) {
      const activateFile = path.join(phaseRoot, 'activate.jsonl');
      await writeFile(activateFile, JSON.stringify({ id: 'sequence.open', params: { item: sequenceItem.item } }) + '\n', 'utf8');
      await runFilmcraftCli(command, ['--project', resolvedProject, 'run', '--commands', activateFile], { signal, timeoutMs, onLine });
    }

    return {
      ok: true,
      issues: [],
      projectPath: resolvedProject,
      sequenceId: sequenceItem.item,
      sequenceName: sequenceItem.name ?? null,
      linkedMedia: document.linkedMedia ?? null,
      offlineMedia: document.offlineMedia ?? [],
      report: document.report ?? [],
      fcpxmlPath: resolvedFcpxml
    };
  } finally {
    await rm(phaseRoot, { recursive: true, force: true });
  }
}

