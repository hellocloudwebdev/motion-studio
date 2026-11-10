const allowedVerdicts = new Set(["pass", "review", "fail"]);

export async function runVisualCritic({ provider, frames, projectBrief, signal } = {}) {
  if (typeof provider !== "function") throw new Error("Visual critic is opt-in and requires an explicitly supplied provider function.");
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("Visual critic requires sampled frame evidence.");
  const response = await provider({ frames, projectBrief: projectBrief || "", signal });
  if (!response || typeof response !== "object" || !allowedVerdicts.has(response.verdict)) throw new Error("Visual critic returned an invalid verdict.");
  const findings = Array.isArray(response.findings) ? response.findings.map((item, index) => ({
    id: String(item.id || "critic-" + (index + 1)),
    severity: ["critical", "high", "medium", "low"].includes(item.severity) ? item.severity : "low",
    description: String(item.description || "Unspecified visual review note."),
    frameAtSeconds: Number.isFinite(Number(item.frameAtSeconds)) ? Number(item.frameAtSeconds) : null
  })) : [];
  return { provider: String(response.provider || "user-supplied"), verdict: response.verdict, advisoryOnly: true, canOverrideDeterministicGates: false, findings, createdAt: new Date().toISOString() };
}