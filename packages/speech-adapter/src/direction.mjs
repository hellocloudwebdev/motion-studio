import { assertValidSpeechText } from './index.mjs';

// Provider-independent narration direction (roadmap P3.2): pronunciation,
// locale and pace travel as Canonical Video IR metadata, then get translated
// per provider — Fish Audio takes rewritten text; the offline adapters take
// rewritten text plus a locale-aware voice hint. The metadata is authored in
// the IR (production.script items or CLI flags) and never in provider request
// bodies beyond what the provider itself accepts.

const LOCALE_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

export function validateLocaleTag(value) {
  if (typeof value !== 'string' || !LOCALE_TAG.test(value.trim())) {
    throw new Error('Narration locale must be a BCP-47-style tag like en-US or de-DE (received ' + JSON.stringify(value ?? null) + ').');
  }
  return value.trim();
}

export function parsePronunciationSpecs(specs) {
  const list = Array.isArray(specs) ? specs : [];
  const parsed = [];
  for (const spec of list) {
    if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const term = typeof spec.term === 'string' ? spec.term.trim() : '';
      const phonetic = typeof spec.phonetic === 'string' ? spec.phonetic.trim() : '';
      if (!term || !phonetic) throw new Error('Pronunciation entries must carry non-empty term and phonetic strings (received ' + JSON.stringify(spec) + ').');
      parsed.push({ term, phonetic });
      continue;
    }
    if (typeof spec !== 'string' || !spec.includes('=')) throw new Error('Pronunciation specs must be "Term=Phonetic" pairs (received ' + JSON.stringify(spec) + ').');
    const separator = spec.indexOf('=');
    const term = spec.slice(0, separator).trim();
    const phonetic = spec.slice(separator + 1).trim();
    if (!term || !phonetic) throw new Error('Pronunciation specs must be "Term=Phonetic" pairs (received ' + JSON.stringify(spec) + ').');
    parsed.push({ term, phonetic });
  }
  return parsed;
}

// Word-boundary, case-preserving substitution with unicode lookaround so
// terms made of symbols ('C++') still boundary-match. Repeated terms are all
// rewritten; overlapping terms apply longest-first so 'NGFW' wins over 'NGF'.
export function applyPronunciationToText(text, pronunciation) {
  assertValidSpeechText(text);
  const list = parsePronunciationSpecs(pronunciation);
  if (!list.length) return { text, applied: [] };
  const sorted = [...list].sort((a, b) => b.term.length - a.term.length);
  const applied = [];
  let output = String(text);
  for (const { term, phonetic } of sorted) {
    const pattern = new RegExp('(?<![\\p{L}\\p{N}])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu');
    let count = 0;
    output = output.replace(pattern, () => { count += 1; return phonetic; });
    if (count) applied.push({ term, phonetic, count });
  }
  return { text: output, applied };
}

export function validateNarrationDirection({ locale, speed, pronunciation } = {}) {
  if (locale !== undefined) validateLocaleTag(locale);
  if (speed !== undefined && (!Number.isFinite(Number(speed)) || Number(speed) < 0.5 || Number(speed) > 2)) {
    throw new Error('Narration prosody speed must be a number between 0.5 and 2.');
  }
  const specs = parsePronunciationSpecs(pronunciation);
  return { locale, speed: speed !== undefined ? Number(speed) : undefined, pronunciation: specs };
}
