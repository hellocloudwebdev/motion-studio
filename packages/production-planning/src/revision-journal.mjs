import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readJournal(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Planning revision journal cannot be a symbolic link.');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: '1.0.0', revisions: [], approvals: [] };
    throw error;
  }
}

async function atomicWrite(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const realDirectory = await realpath(directory);
  const target = path.join(realDirectory, path.basename(file));
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Planning revision journal cannot be a symbolic link.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(realDirectory, '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, target);
  return target;
}

export async function appendPlanningRevision({ journalPath, planning, project, recordedAt = new Date().toISOString() } = {}) {
  if (typeof journalPath !== 'string' || !journalPath.trim()) throw new Error('An explicit local planning journal path is required.');
  if (!planning || typeof planning !== 'object' || !project?.project?.id) throw new Error('Planning artifacts and a compiled Canonical Video IR are required.');
  const file = path.resolve(journalPath), journal = await readJournal(file);
  if (journal.schemaVersion !== '1.0.0' || !Array.isArray(journal.revisions) || !Array.isArray(journal.approvals)) throw new Error('Planning journal has an unsupported or malformed schema.');
  const revision = (journal.revisions.at(-1)?.revision || 0) + 1;
  const record = {
    revision, recordedAt, projectId: project.project.id, projectRevision: project.project.revision || 1,
    briefId: planning.brief?.id || null,
    briefSha256: hash(planning.brief || null), planningSha256: hash(planning), canonicalIrSha256: hash(project),
    planning: structuredClone(planning), canonicalVideoIr: structuredClone(project)
  };
  journal.revisions.push(record);
  await atomicWrite(file, journal);
  return { journalPath: file, revision: record.revision, projectId: record.projectId, briefSha256: record.briefSha256, planningSha256: record.planningSha256, canonicalIrSha256: record.canonicalIrSha256 };
}

export async function approvePlanningRevision({ journalPath, revision, actor, note = '', approvedAt = new Date().toISOString() } = {}) {
  if (typeof journalPath !== 'string' || !journalPath.trim()) throw new Error('An explicit local planning journal path is required.');
  if (!Number.isInteger(revision) || revision < 1) throw new Error('A positive integer revision is required.');
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('An explicit approver identity is required.');
  if (typeof note !== 'string') throw new Error('Approval note must be a string.');
  const file = path.resolve(journalPath), journal = await readJournal(file);
  const record = journal.revisions.find(item => item.revision === revision);
  if (!record) throw new Error('Cannot approve a planning revision that is not present in the journal.');
  const approval = { revision, canonicalIrSha256: record.canonicalIrSha256, actor: actor.trim(), note: note.trim() || null, approvedAt };
  journal.approvals.push(approval);
  await atomicWrite(file, journal);
  return { journalPath: file, ...approval };
}
