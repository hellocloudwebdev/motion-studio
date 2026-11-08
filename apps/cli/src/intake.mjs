#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createProductionBrief, validateProductionBrief, buildCreativeWorkflow, summarizeProductionIntake,
  validatePlanningArtifacts, compilePlanningArtifacts
} from '../../../packages/production-planning/src/index.mjs';

const [command, inputFile, ...args] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const print = value => console.log(JSON.stringify(value, null, 2));
async function load(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function save(file, value) { await writeFile(path.resolve(file), JSON.stringify(value, null, 2) + '\n', 'utf8'); }

try {
  if (!['create', 'validate', 'workflow', 'validate-artifacts', 'compile'].includes(command) || !inputFile) {
    throw new Error('Usage: npm run intake -- create <idea.json> [--output brief.json] [--workflow workflow.json] | validate <brief.json> | workflow <brief.json> | validate-artifacts <planning.json> | compile <planning.json> [--output project.json]');
  }
  const input = await load(inputFile);
  if (command === 'create') {
    const brief = createProductionBrief(input);
    const output = option('--output', 'production-brief.json');
    await save(output, brief);
    const workflowFile = option('--workflow', '');
    if (workflowFile) await save(workflowFile, buildCreativeWorkflow(brief));
    print({ ...summarizeProductionIntake(brief), output: path.resolve(output), workflow: workflowFile ? path.resolve(workflowFile) : null });
  } else if (command === 'validate') {
    const result = validateProductionBrief(input);
    print(result);
    if (!result.valid) process.exitCode = 2;
  } else if (command === 'workflow') {
    print(buildCreativeWorkflow(input));
  } else if (command === 'validate-artifacts') {
    const result = validatePlanningArtifacts(input);
    print(result);
    if (!result.valid) process.exitCode = 2;
  } else {
    const result = compilePlanningArtifacts(input);
    const output = option('--output', 'canonical-video-ir.json');
    await save(output, result.project);
    print({ summary: result.summary, validation: result.validation, output: path.resolve(output) });
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, issues: error.issues || [] }, null, 2));
  process.exitCode = 2;
}
