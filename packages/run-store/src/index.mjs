import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const clone = value => structuredClone(value);
const stable = value => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
const fingerprint = value => createHash('sha256').update(stable(value)).digest('hex');
const eventFingerprint = event => fingerprint({ eventId: event.eventId, runId: event.runId, revision: event.revision, type: event.type, payload: event.payload });

function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('Run event must be an object.');
  for (const field of ['eventId', 'runId', 'type']) {
    if (typeof event[field] !== 'string' || !event[field]) throw new Error('Run event requires ' + field + '.');
  }
  if (!Number.isSafeInteger(event.revision) || event.revision < 1) throw new Error('Run event revision must be a positive safe integer.');
  if (event.payload !== undefined && (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))) throw new Error('Run event payload must be an object.');
  return {
    eventId: event.eventId,
    runId: event.runId,
    revision: event.revision,
    type: event.type,
    at: event.at || new Date().toISOString(),
    payload: clone(event.payload || {})
  };
}

export async function openRunJournal(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A journal file path is required.');
  const resolvedPath = path.resolve(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  let contents = '';
  try { contents = await readFile(resolvedPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  let recoveredPartialTail = false;
  if (contents && !contents.endsWith('\n')) {
    const lastNewline = contents.lastIndexOf('\n');
    const validLength = lastNewline < 0 ? 0 : Buffer.byteLength(contents.slice(0, lastNewline + 1));
    const handle = await open(resolvedPath, 'r+');
    try { await handle.truncate(validLength); await handle.sync(); }
    finally { await handle.close(); }
    contents = lastNewline < 0 ? '' : contents.slice(0, lastNewline + 1);
    recoveredPartialTail = true;
  }

  const events = [];
  const byId = new Map();
  const revisions = new Map();
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line) continue;
    let parsed;
    try { parsed = validateEvent(JSON.parse(line)); }
    catch (error) { throw new Error('Run journal corruption at line ' + (index + 1) + ': ' + error.message); }
    if (byId.has(parsed.eventId)) throw new Error('Run journal contains duplicate event id: ' + parsed.eventId);
    const previous = revisions.get(parsed.runId) || 0;
    if (parsed.revision !== previous + 1) throw new Error('Run journal revision gap for ' + parsed.runId + ': expected ' + (previous + 1) + ', received ' + parsed.revision + '.');
    byId.set(parsed.eventId, { event: parsed, fingerprint: eventFingerprint(parsed) });
    revisions.set(parsed.runId, parsed.revision);
    events.push(parsed);
  }

  let queue = Promise.resolve();
  let closed = false;
  return {
    filePath: resolvedPath,
    recoveredPartialTail,
    async append(input) {
      const operation = async () => {
        if (closed) throw new Error('Run journal is closed.');
        const event = validateEvent(input);
        const signature = eventFingerprint(event);
        const previousId = byId.get(event.eventId);
        if (previousId) {
          if (previousId.fingerprint !== signature) throw new Error('Event id reused with different event content: ' + event.eventId);
          return { appended: false, duplicate: true, event: clone(previousId.event) };
        }
        const expected = (revisions.get(event.runId) || 0) + 1;
        if (event.revision !== expected) throw new Error('Revision conflict for ' + event.runId + ': expected ' + expected + ', received ' + event.revision + '.');
        const handle = await open(resolvedPath, 'a');
        try { await handle.writeFile(JSON.stringify(event) + '\n', 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        byId.set(event.eventId, { event, fingerprint: signature });
        revisions.set(event.runId, event.revision);
        events.push(event);
        return { appended: true, duplicate: false, event: clone(event) };
      };
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    },
    async read({ runId } = {}) {
      await queue;
      return clone(runId ? events.filter(event => event.runId === runId) : events);
    },
    latestRevision(runId) { return revisions.get(runId) || 0; },
    async close() { await queue; closed = true; },
    async stats() {
      await queue;
      const file = await stat(resolvedPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      return { eventCount: events.length, runCount: revisions.size, bytes: file?.size || 0, recoveredPartialTail };
    }
  };
}
