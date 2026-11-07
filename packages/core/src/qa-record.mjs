export function persistQaRecord(project, { run, qaResult, repairPlan, approval = null } = {}) {
  if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("A Canonical Video IR project object is required.");
  if (!run || typeof run !== "object" || !run.id) throw new Error("A QA run with a stable id is required.");
  const next = structuredClone(project);
  const previous = next.qa && typeof next.qa === "object" ? next.qa : {};
  const runRecord = {
    id: run.id, createdAt: run.createdAt || new Date().toISOString(),
    passed: qaResult?.passed === true, productionReady: qaResult?.productionReady === true,
    summary: qaResult?.summary || null, defects: qaResult?.defects || [],
    renderManifest: run.renderManifest || null
  };
  const runs = [...(Array.isArray(previous.runs) ? previous.runs : [])];
  const existingIndex = runs.findIndex(item => item.id === run.id);
  if (existingIndex >= 0) runs[existingIndex] = { ...runs[existingIndex], ...runRecord, createdAt: run.createdAt || runs[existingIndex].createdAt };
  else runs.push(runRecord);
  next.qa = {
    ...previous, runs, defects: qaResult?.defects || [],
    repairHistory: approval ? (Array.isArray(previous.repairHistory) ? previous.repairHistory : []) : [...(Array.isArray(previous.repairHistory) ? previous.repairHistory : []), {
      runId: run.id, attempt: repairPlan?.attempt ?? 0, status: repairPlan?.status || "no-action",
      actions: repairPlan?.actions || [], escalation: repairPlan?.escalation || null
    }],
    approvals: approval ? [...(Array.isArray(previous.approvals) ? previous.approvals : []), {
      runId: run.id, approved: approval.approved === true, actor: approval.actor || "unspecified",
      approvedAt: approval.approvedAt || new Date().toISOString(), note: approval.note || null
    }] : (Array.isArray(previous.approvals) ? previous.approvals : [])
  };
  return next;
}
