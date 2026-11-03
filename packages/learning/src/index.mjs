const LOW_RISK_KINDS = new Set(['skill-content', 'template-content', 'reference-metadata', 'workflow-documentation']);
const HIGH_RISK_KINDS = new Set(['executable-code', 'dependencies', 'permissions', 'secrets', 'core-agent', 'core-contract']);

export function createImprovementProposal({ id, kind, title, evidence = [], diff, tests = [] } = {}) {
  if (!id || !kind || !title || !diff) throw new Error('Proposal id, kind, title and diff are required.');
  return { id, kind, title, evidence: structuredClone(evidence), diff, tests: structuredClone(tests), status: 'proposed', evaluation: null, approval: null, createdAt: new Date().toISOString(), history: [{ status: 'proposed', at: new Date().toISOString() }] };
}
export function evaluateProposal(proposal, { testsPassed, regressionPassed, securityPassed = true, reviewerNotes = '' } = {}) {
  if (!proposal || proposal.status !== 'proposed') throw new Error('Only proposed changes can be evaluated.');
  const highRisk = HIGH_RISK_KINDS.has(proposal.kind), passed = Boolean(testsPassed && regressionPassed && securityPassed), next = structuredClone(proposal);
  next.evaluation = { testsPassed: Boolean(testsPassed), regressionPassed: Boolean(regressionPassed), securityPassed: Boolean(securityPassed), passed, highRisk, reviewerNotes };
  next.status = passed ? 'evaluated' : 'rejected'; next.history.push({ status: next.status, at: new Date().toISOString() }); return next;
}
export function approveProposal(proposal, { approver, note = '' } = {}) {
  if (!proposal || proposal.status !== 'evaluated' || !proposal.evaluation?.passed) throw new Error('Proposal must pass evaluation before approval.');
  if (!approver) throw new Error('An explicit approver identity is required.');
  const next = structuredClone(proposal); next.approval = { approver, note, at: new Date().toISOString() }; next.status = 'approved'; next.history.push({ status: 'approved', at: new Date().toISOString(), approver }); return next;
}
export function promoteProposal(proposal, { autoPromoteLowRisk = false } = {}) {
  if (!proposal || !proposal.evaluation?.passed) throw new Error('Proposal must pass all evaluation gates before promotion.');
  if (HIGH_RISK_KINDS.has(proposal.kind)) throw new Error(`Promotion blocked: ${proposal.kind} changes require explicit human approval and a separate controlled deployment path.`);
  const approved = proposal.status === 'approved', eligible = LOW_RISK_KINDS.has(proposal.kind) && autoPromoteLowRisk === true;
  if (!approved && !eligible) throw new Error('Explicit approval is required; low-risk auto-promotion is disabled.');
  const next = structuredClone(proposal); next.status = 'promoted'; next.promotedAt = new Date().toISOString(); next.history.push({ status: 'promoted', at: next.promotedAt, mode: approved ? 'approved' : 'configured-low-risk-auto-promotion' }); return next;
}
