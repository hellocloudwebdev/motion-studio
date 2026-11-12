import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Quality-gates policy loader (P1.3 repair executor). The file is optional:
// when absent, the bounded defaults apply. A present file must keep
// repair.maxCycles inside 1..3 and both rerender/retest flags boolean.

const DEFAULT_REPAIR = { maxCycles: 2, targetedRerender: true, retestRequired: true };

function fail(message) {
  throw new Error(message);
}

export async function loadQualityGates(configPath) {
  const sourcePath = configPath === undefined || configPath === null || configPath === '' ? null : path.resolve(String(configPath));
  let raw = null;
  if (sourcePath) {
    try {
      raw = await readFile(sourcePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (raw === null) {
    return { version: 1, repair: { ...DEFAULT_REPAIR }, sourcePath, sha256: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail('Quality gates config is not valid JSON (' + sourcePath + '): ' + error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Quality gates config must be a JSON object: ' + sourcePath);
  const repairInput = parsed.repair && typeof parsed.repair === 'object' && !Array.isArray(parsed.repair) ? parsed.repair : {};
  const maxCycles = repairInput.maxCycles ?? DEFAULT_REPAIR.maxCycles;
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 3) fail('Quality gates repair.maxCycles must be an integer between 1 and 3 (received ' + JSON.stringify(repairInput.maxCycles ?? null) + '): ' + sourcePath);
  const repair = { maxCycles };
  for (const flag of ['targetedRerender', 'retestRequired']) {
    const value = repairInput[flag] ?? DEFAULT_REPAIR[flag];
    if (typeof value !== 'boolean') fail('Quality gates repair.' + flag + ' must be a boolean (received ' + JSON.stringify(value ?? null) + '): ' + sourcePath);
    repair[flag] = value;
  }
  return {
    version: Number.isInteger(parsed.version) ? parsed.version : 1,
    repair,
    sourcePath,
    sha256: createHash('sha256').update(raw).digest('hex')
  };
}
