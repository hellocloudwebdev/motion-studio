// M1.9 learning capture: turn what a production already persists — approved
// creative decisions in the IR provenance, repair outcomes in the QA ledger,
// declared brand tokens — into learning entries with STRICT scope separation:
// project memory (production-specific), user preferences (declared style
// tokens) and validated reusable patterns (candidates for the improvement
// pipeline). Nothing here mutates the IR or auto-promotes anything: patterns
// are candidates that still pass the proposal evaluate/approve gates.

const REPAIR_PASSED = new Set(['passed', 'retested-pass', 'retry-pass']);
const PATTERN_KIND = 'workflow-documentation';

export function captureProductionLearning({ project, runState = null, maxPatterns = 20 } = {}) {
  if (!project || typeof project !== 'object' || !project.project?.id) throw new Error('Learning capture requires a Canonical Video IR project with project.id.');
  const projectId = project.project.id;
  const repairHistory = Array.isArray(project.qa?.repairHistory) ? project.qa.repairHistory : [];
  const provenance = project.provenance && typeof project.provenance === 'object' ? project.provenance : {};

  // Project memory: production-specific decisions, kept attached to this IR.
  const projectMemory = {
    projectId,
    decisions: (Array.isArray(provenance.decisions) ? provenance.decisions : []).map(decision => ({
      type: String(decision?.type ?? 'unspecified'),
      summary: String(decision?.selectedConcept ?? decision?.summary ?? decision?.rationale ?? '').slice(0, 300) || null,
      rationale: decision?.rationale ? String(decision.rationale).slice(0, 500) : null,
      recordedAt: project.project?.createdAt ?? null
    })),
    repairOutcomes: repairHistory.map(entry => ({
      attempt: entry?.attempt ?? null,
      status: entry?.status ?? null,
      runId: entry?.runId ?? runState?.runId ?? null,
      retestResult: entry?.retestResult ?? null,
      defectCount: Array.isArray(entry?.defectIds) ? entry.defectIds.length : (entry?.patch?.defectIds?.length ?? null)
    }))
  };

  // User preferences: declared brand/style tokens only — explicitly
  // separated from project memory so a style learned on one production never
  // leaks into another project's memory.
  const brand = project.brand && typeof project.brand === 'object' ? project.brand : null;
  const userPreferences = {
    scope: 'user',
    colors: brand?.colors && typeof brand.colors === 'object' ? { ...brand.colors } : null,
    fonts: brand?.fonts && typeof brand.fonts === 'object' ? { ...brand.fonts } : null,
    rules: Array.isArray(brand?.rules) ? brand.rules.slice(0, 50) : null
  };

  // Validated patterns: only repair cycles whose retest PASSED, with the
  // defect classes they resolved — candidates for reusable documentation.
  const candidatePatterns = [];
  for (const entry of repairHistory) {
    const retestPassed = REPAIR_PASSED.has(entry?.retestResult) || entry?.retestResult === true;
    const hasPatch = entry?.patch && typeof entry.patch === 'object';
    if (!retestPassed || !hasPatch) continue;
    const defectIds = Array.isArray(entry.patch?.defectIds) ? entry.patch.defectIds : [];
    const defectCodes = [...new Set(defectIds.map(id => String(id).split('#')[0]))].slice(0, 5);
    candidatePatterns.push({
      id: 'pattern-' + projectId + '-a' + (entry.attempt ?? candidatePatterns.length + 1),
      kind: PATTERN_KIND,
      title: 'Resolved ' + (defectCodes.join(', ') || 'unknown defect') + ' via a validated repair cycle',
      evidence: [
        'run ' + (entry.runId ?? runState?.runId ?? 'unknown'),
        'attempt ' + (entry.attempt ?? '?'),
        ...(entry.patch?.ops ? ['ops: ' + entry.patch.ops.map(op => op.type).join(', ')] : []),
        ...(project.scenes?.length ? ['scenes: ' + project.scenes.length] : [])
      ].slice(0, 6),
      diff: 'Validated repair pattern from production ' + projectId + ': defects [' + defectCodes.join(', ') + '] resolved by ' + (entry.patch?.ops?.map(op => op.type).join(', ') || 'unknown ops') + ' with a passed retest.',
      tests: ['retest passed on the affected scope']
    });
    if (candidatePatterns.length >= maxPatterns) break;
  }

  return {
    projectId,
    capturedAt: new Date().toISOString(),
    scopes: {
      project: projectMemory,
      user: userPreferences,
      patterns: candidatePatterns
    },
    counts: {
      decisions: projectMemory.decisions.length,
      repairOutcomes: projectMemory.repairOutcomes.length,
      candidatePatterns: candidatePatterns.length
    }
  };
}

// Bridge a validated pattern candidate into the improvement-proposal
// pipeline (createImprovementProposal); the proposal still has to pass
// evaluate/approve/promote — capture never auto-promotes.
export function patternToProposalCandidate(candidate) {
  if (!candidate || candidate.kind !== PATTERN_KIND || !candidate.id) throw new Error('patternToProposalCandidate requires a captured pattern candidate.');
  return {
    id: candidate.id,
    kind: candidate.kind,
    title: candidate.title,
    evidence: candidate.evidence,
    diff: candidate.diff,
    tests: candidate.tests
  };
}
