import { createHash } from 'node:crypto';

const OPTIONAL_FIELDS = ['audience', 'purpose', 'durationSeconds', 'language', 'platform', 'aspectRatio'];
const text = value => typeof value === 'string' ? value.trim() : '';
const issue = (code, path, message, severity = 'error') => ({ code, path, message, severity });

function stableId(value) {
  return 'brief-' + createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Convert user intake into a provider-neutral production brief.
 * This function preserves unknowns; it never invents audience, duration, platform or brand facts.
 */
export function createProductionBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Production intake must be a JSON object.');
  }
  const idea = text(input.idea);
  if (!idea) throw new Error('A non-empty video idea is required.');

  const brief = {
    schemaVersion: '1.0.0',
    id: text(input.id) || stableId(idea),
    createdAt: text(input.createdAt) || new Date().toISOString(),
    idea,
    audience: text(input.audience) || null,
    purpose: text(input.purpose) || null,
    durationSeconds: input.durationSeconds ?? null,
    language: text(input.language) || null,
    platform: text(input.platform) || null,
    aspectRatio: text(input.aspectRatio) || null,
    customDimensions: input.customDimensions && typeof input.customDimensions === 'object'
      ? structuredClone(input.customDimensions) : null,
    brandGuidelines: input.brandGuidelines && typeof input.brandGuidelines === 'object'
      ? structuredClone(input.brandGuidelines) : null,
    references: Array.isArray(input.references) ? input.references.map(text).filter(Boolean) : [],
    suppliedAssets: Array.isArray(input.suppliedAssets) ? structuredClone(input.suppliedAssets) : [],
    research: {
      required: input.researchRequired === true,
      reason: text(input.researchReason) || null
    },
    constraints: Array.isArray(input.constraints) ? input.constraints.map(text).filter(Boolean) : [],
    openQuestions: OPTIONAL_FIELDS.filter(key => brief[key] === null).map(field => ({
      field,
      question: ({
        audience: 'Who is the intended audience?',
        purpose: 'What should the video achieve?',
        durationSeconds: 'What is the target duration in seconds?',
        language: 'Which language should the narration and on-screen copy use?',
        platform: 'Where will the video be published?',
        aspectRatio: 'Which aspect ratio should the video use?'
      })[field],
      blocking: false
    }))
  };

  const validation = validateProductionBrief(brief);
  if (!validation.valid) {
    const error = new Error('Production brief is invalid.');
    error.issues = validation.issues;
    throw error;
  }
  return brief;
}

export function validateProductionBrief(brief) {
  const issues = [];
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    return { valid: false, issues: [issue('BRIEF_NOT_OBJECT', '$', 'Brief must be a JSON object.')] };
  }
  if (brief.schemaVersion !== '1.0.0') issues.push(issue('UNSUPPORTED_BRIEF_VERSION', '$.schemaVersion', 'Expected production brief schemaVersion 1.0.0.'));
  for (const field of ['id', 'idea']) {
    if (typeof brief[field] !== 'string' || !brief[field].trim()) issues.push(issue('REQUIRED_FIELD', '$.' + field, field + ' must be a non-empty string.'));
  }
  if (brief.durationSeconds !== null && brief.durationSeconds !== undefined &&
      (!Number.isFinite(brief.durationSeconds) || brief.durationSeconds <= 0 || brief.durationSeconds > 3600)) {
    issues.push(issue('INVALID_DURATION', '$.durationSeconds', 'durationSeconds must be a positive number no greater than 3600.'));
  }
  if (brief.aspectRatio && !['16:9', '9:16', '1:1', '4:5', 'custom'].includes(brief.aspectRatio)) {
    issues.push(issue('UNSUPPORTED_ASPECT_RATIO', '$.aspectRatio', 'Use 16:9, 9:16, 1:1, 4:5 or custom.'));
  }
  if (brief.aspectRatio === 'custom') {
    const d = brief.customDimensions;
    if (!d || !Number.isInteger(d.width) || d.width <= 0 || !Number.isInteger(d.height) || d.height <= 0) {
      issues.push(issue('CUSTOM_DIMENSIONS_REQUIRED', '$.customDimensions', 'Custom aspect ratio requires positive integer width and height.'));
    }
  }
  if (brief.references !== undefined && !Array.isArray(brief.references)) issues.push(issue('REFERENCES_NOT_ARRAY', '$.references', 'references must be an array.'));
  if (brief.suppliedAssets !== undefined && !Array.isArray(brief.suppliedAssets)) issues.push(issue('ASSETS_NOT_ARRAY', '$.suppliedAssets', 'suppliedAssets must be an array.'));
  if (brief.constraints !== undefined && !Array.isArray(brief.constraints)) issues.push(issue('CONSTRAINTS_NOT_ARRAY', '$.constraints', 'constraints must be an array.'));
  return { valid: !issues.some(x => x.severity === 'error'), issues };
}

/**
 * Produce a deterministic provider-neutral DAG for the creative department.
 * It describes work and dependencies; it does not claim that an AI agent ran.
 */
export function buildCreativeWorkflow(brief) {
  const validation = validateProductionBrief(brief);
  if (!validation.valid) throw new Error('Cannot plan creative workflow from an invalid brief: ' + validation.issues.map(x => x.code).join(', '));

  const stages = [];
  const add = (id, role, output, dependsOn = []) => stages.push({ id, role, output, dependsOn });
  if (brief.research?.required === true) add('research', 'researcher', 'research-evidence.json');
  add('creative-direction', 'creative-director', 'creative-direction.json', brief.research?.required ? ['research'] : []);
  add('script', 'scriptwriter', 'script.json', ['creative-direction']);
  add('storyboard', 'storyboard-director', 'storyboard.json', ['script']);
  add('design-system', 'art-director', 'design-system.json', ['creative-direction']);
  add('canonical-ir', 'executive-producer', 'canonical-video-ir.json', ['storyboard', 'design-system']);

  return {
    schemaVersion: '1.0.0',
    briefId: brief.id,
    stages,
    finalOutput: 'canonical-video-ir.json',
    executionPolicy: {
      providerNeutral: true,
      maxConcurrentStages: 1,
      requireValidatedInputs: true,
      requireHumanApprovalBeforeRendering: true
    }
  };
}

export function summarizeProductionIntake(brief) {
  const validation = validateProductionBrief(brief);
  return {
    valid: validation.valid,
    briefId: brief?.id ?? null,
    idea: brief?.idea ?? null,
    openQuestions: structuredClone(brief?.openQuestions || []),
    readyForCreativePlanning: validation.valid,
    issues: validation.issues
  };
}
