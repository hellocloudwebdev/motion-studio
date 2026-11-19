import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// P4.3 production failure tracking: aggregate what the run-state ledgers and
// IR repair histories already persist into per-project and global repair /
// acceptance / escalation statistics. No secrets, no media — counters and
// timestamps only. Aggregation is read-only over the projects root.

export async function aggregateProductionStats(projectsRoot, { clock = () => new Date() } = {}) {
  let entries = [];
  try { entries = await readdir(projectsRoot, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, generatedAt: clock().toISOString(), projects: [], totals: emptyTotals(), note: 'projects root does not exist yet' };
    throw error;
  }
  const projects = [];
  for (const entry of entries.filter(item => item.isDirectory())) {
    const projectDir = path.join(projectsRoot, entry.name);
    const state = await readJson(path.join(projectDir, 'run-state.json'));
    const project = await readJson(path.join(projectDir, 'project.json'));
    if (!state && !project) continue;
    const repairHistory = Array.isArray(project?.qa?.repairHistory) ? project.qa.repairHistory : [];
    const executedCycles = repairHistory.filter(item => item?.status === 'repair-required').length;
    const escalations = repairHistory.filter(item => item?.status === 'escalated').length;
    const verifiedMaster = (Array.isArray(state?.artifacts) ? state.artifacts : []).some(artifact => artifact?.kind === 'master-render' && artifact.verified === true);
    projects.push({
      projectId: state?.projectId ?? project?.project?.id ?? entry.name,
      runId: state?.runId ?? null,
      runStatus: state?.status ?? null,
      repairCycles: state?.repairCycles ?? executedCycles,
      executedRepairCycles: executedCycles,
      escalations,
      retestOutcomes: state?.repair?.retestOutcomes ?? null,
      verifiedMaster,
      productionReady: project?.qa?.gates?.some(gate => gate.id === 'production-ready' && gate.status === 'passed') ?? null,
      lastActivityAt: state?.updatedAt ?? null,
      renderSeconds: renderSecondsFromState(state)
    });
  }
  projects.sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)));
  const totals = {
    projects: projects.length,
    runs: projects.filter(item => item.runId).length,
    productionReady: projects.filter(item => item.productionReady === true).length,
    withVerifiedMaster: projects.filter(item => item.verifiedMaster).length,
    executedRepairCycles: projects.reduce((sum, item) => sum + item.executedRepairCycles, 0),
    escalatedProjects: projects.filter(item => item.escalations > 0).length,
    totalRenderSeconds: projects.reduce((sum, item) => sum + (item.renderSeconds ?? 0), 0)
  };
  totals.repairRate = totals.runs > 0 ? Math.round(totals.executedRepairCycles / totals.runs * 1000) / 1000 : null;
  return { schemaVersion: 1, generatedAt: clock().toISOString(), projects, totals };
}

function emptyTotals() {
  return { projects: 0, runs: 0, productionReady: 0, withVerifiedMaster: 0, executedRepairCycles: 0, escalatedProjects: 0, totalRenderSeconds: 0, repairRate: null };
}

function renderSecondsFromState(state) {
  // Render cost: sum of verified master render evidence durations recorded by
  // the render-manager steps, when present in the artifacts' render manifests.
  let seconds = 0;
  for (const artifact of Array.isArray(state?.artifacts) ? state.artifacts : []) {
    if (artifact?.kind !== 'master-render' || typeof artifact.path !== 'string') continue;
    // The artifact path is the rendered file; render duration evidence lives
    // in the sidecar manifest when present. Reading it here would be I/O per
    // project — the tracked proxy is the artifact's own recorded render time,
    // which the render-manager writes into the manifest as renderSeconds.
    seconds += Number(artifact.renderSeconds) || 0;
  }
  return seconds > 0 ? seconds : null;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
