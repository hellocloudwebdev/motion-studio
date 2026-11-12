import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registryEntryFor } from '../../core/src/index.mjs';

// Escalation artifacts (design §4.2 step 12): a JSON report plus a human
// readable markdown twin per escalation. The registry verdict of every
// unresolved defect becomes its reasonNotRepaired; callers can override a
// verdict when the loop knows better (e.g. a recurring frame-decode failure).

const ESCALATION_SCHEMA_VERSION = '1.0.0';

export function buildEscalationReport({ run, defects, history, attempt, maxCycles, verdicts = null } = {}) {
  if (!run || typeof run.id !== 'string' || !run.id.trim()) throw new Error('A run with a stable id is required to escalate.');
  if (!Array.isArray(defects)) throw new Error('An array of unresolved defects is required to escalate.');
  const unresolvedDefects = defects.filter(defect => defect && typeof defect === 'object' && defect.code).map(defect => {
    let reasonNotRepaired = null;
    if (verdicts) {
      if (typeof verdicts === 'function') reasonNotRepaired = verdicts(defect) || null;
      else if (typeof verdicts.get === 'function') reasonNotRepaired = verdicts.get(defect.defectId) ?? verdicts.get(defect.code) ?? null;
    }
    if (!reasonNotRepaired) reasonNotRepaired = registryEntryFor(defect.code).reason;
    return {
      defectId: defect.defectId ?? null,
      code: defect.code,
      severity: defect.severity ?? 'medium',
      sceneId: defect.sceneId ?? null,
      timeRangeFrames: defect.timeRangeFrames ?? null,
      evidence: defect.evidence ?? null,
      repairOwner: defect.repairOwner ?? 'executive-producer',
      reasonNotRepaired
    };
  });
  return {
    schemaVersion: ESCALATION_SCHEMA_VERSION,
    type: 'repair-escalation',
    projectId: run.projectId ?? null,
    runId: run.id,
    attempt: Number.isInteger(attempt) ? attempt : 0,
    maxCycles: Number.isInteger(maxCycles) ? maxCycles : null,
    unresolvedDefects,
    repairHistory: (Array.isArray(history) ? history : []).map(entry => typeof entry === 'string' ? entry : [
      entry.patchId ?? 'no-patch', entry.status ?? 'repair-required', 'attempt', entry.attempt ?? '—',
      entry.retestResult ? 'retest:' + entry.retestResult : null
    ].filter(item => item !== null && item !== undefined && item !== '').join(' ')),
    requestedAction: 'human-review',
    createdAt: new Date().toISOString()
  };
}

function markdownFor(report) {
  const lines = [
    '# Repair escalation — ' + (report.projectId ?? 'unknown project') + ' / ' + report.runId,
    '',
    '- Attempt: a' + report.attempt + (report.maxCycles != null ? ' of max ' + report.maxCycles : ''),
    '- Requested action: ' + report.requestedAction,
    '- Created: ' + report.createdAt,
    '',
    '## Unresolved defects',
    ''
  ];
  if (!report.unresolvedDefects.length) lines.push('_No unresolved defects were recorded._');
  else {
    lines.push('| Defect | Code | Severity | Scene | Owner | Reason not repaired |', '|---|---|---|---|---|---|');
    for (const defect of report.unresolvedDefects) {
      lines.push('| ' + (defect.defectId ?? '—') + ' | ' + defect.code + ' | ' + defect.severity + ' | ' + (defect.sceneId ?? '—') + ' | ' + defect.repairOwner + ' | ' + defect.reasonNotRepaired + ' |');
    }
  }
  lines.push('', '## Repair history', '');
  if (!report.repairHistory.length) lines.push('_No repair cycles were recorded for this run._');
  else for (const entry of report.repairHistory) lines.push('- ' + entry);
  lines.push('');
  return lines.join('\n');
}

async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
}

export async function writeEscalationReport(projectRoot, options = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') throw new Error('A project workspace directory is required to write the escalation report.');
  const report = buildEscalationReport(options);
  const dir = path.join(projectRoot, 'escalations');
  const jsonPath = path.join(dir, 'escalation-' + report.runId + '-a' + report.attempt + '.json');
  const markdownPath = path.join(dir, 'escalation-' + report.runId + '-a' + report.attempt + '.md');
  await atomicWrite(jsonPath, JSON.stringify(report, null, 2) + '\n');
  await atomicWrite(markdownPath, markdownFor(report));
  return { jsonPath, markdownPath, report };
}
