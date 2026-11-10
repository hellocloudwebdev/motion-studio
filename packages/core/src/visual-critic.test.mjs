import test from "node:test";
import assert from "node:assert/strict";
import { runVisualCritic } from "./visual-critic.mjs";

test("visual critic requires explicit provider and returns advisory-only findings", async () => {
  await assert.rejects(() => runVisualCritic({ frames: [{ path: "frame.png" }] }), /opt-in/);
  const result = await runVisualCritic({
    frames: [{ path: "frame.png" }],
    provider: async () => ({ provider: "test-provider", verdict: "review", findings: [{ severity: "medium", description: "Title may be crowded." }] })
  });
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.canOverrideDeterministicGates, false);
  assert.equal(result.findings.length, 1);
});