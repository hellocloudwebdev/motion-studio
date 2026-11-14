import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPronunciationToText, parsePronunciationSpecs, validateLocaleTag, validateNarrationDirection } from './direction.mjs';
import { narrationSegmentsFromProject } from './index.mjs';

test('parsePronunciationSpecs accepts CLI strings and IR objects, rejects junk', () => {
  assert.deepEqual(parsePronunciationSpecs(['Kubernetes=Koo-ber-net-eez', 'Git=Ghit']), [
    { term: 'Kubernetes', phonetic: 'Koo-ber-net-eez' },
    { term: 'Git', phonetic: 'Ghit' }
  ]);
  assert.deepEqual(parsePronunciationSpecs([{ term: 'IRENA', phonetic: 'ee-RAY-na' }]), [{ term: 'IRENA', phonetic: 'ee-RAY-na' }]);
  assert.deepEqual(parsePronunciationSpecs([]), []);
  assert.deepEqual(parsePronunciationSpecs(undefined), []);
  assert.throws(() => parsePronunciationSpecs(['NoSeparator']), /=/);
  assert.throws(() => parsePronunciationSpecs(['=Orphan']), /Term=Phonetic/);
  assert.throws(() => parsePronunciationSpecs([{ term: 'X' }]), /non-empty term and phonetic/);
});

test('applyPronunciationToText rewrites at word boundaries, case-preservingly, longest-first', () => {
  const { text, applied } = applyPronunciationToText('IRENA reports renewable stats. The irena dataset uses NGFW gear.', [
    'IRENA=ee-RAY-na',
    'NGFW=next-generation firewall'
  ]);
  assert.equal(text, 'ee-RAY-na reports renewable stats. The ee-RAY-na dataset uses next-generation firewall gear.');
  assert.deepEqual(applied, [
    { term: 'IRENA', phonetic: 'ee-RAY-na', count: 2 },
    { term: 'NGFW', phonetic: 'next-generation firewall', count: 1 }
  ]);
});

test('applyPronunciationToText does not rewrite inside larger words and survives regex metacharacters', () => {
  const { text, applied } = applyPronunciationToText('A C++ (C-plus-plus) pioneer studies C++ish things.', ['C++=C-plus-plus']);
  assert.equal(text, 'A C-plus-plus (C-plus-plus) pioneer studies C++ish things.', 'C++ish is a different word and stays untouched');
  assert.equal(applied[0].count, 1);
});

test('applyPronunciationToText passes text through unchanged without specs', () => {
  const result = applyPronunciationToText('Plain narration.', []);
  assert.equal(result.text, 'Plain narration.');
  assert.deepEqual(result.applied, []);
});

test('locale validation accepts BCP-47-style tags and rejects junk', () => {
  assert.equal(validateLocaleTag('en-US'), 'en-US');
  assert.equal(validateLocaleTag('de-DE'), 'de-DE');
  assert.equal(validateLocaleTag('zh-Hans'), 'zh-Hans');
  assert.equal(validateLocaleTag(' pt-BR '), 'pt-BR');
  assert.throws(() => validateLocaleTag('not a locale'), /BCP-47/);
  assert.throws(() => validateLocaleTag(''), /BCP-47/);
  assert.throws(() => validateLocaleTag(null), /BCP-47/);
});

test('validateNarrationDirection checks speed range and normalizes pronunciation specs', () => {
  const direction = validateNarrationDirection({ locale: 'en-US', speed: '1.25', pronunciation: ['Data=Day-ta'] });
  assert.equal(direction.speed, 1.25);
  assert.deepEqual(direction.pronunciation, [{ term: 'Data', phonetic: 'Day-ta' }]);
  assert.throws(() => validateNarrationDirection({ speed: 4 }), /between 0.5 and 2/);
  assert.throws(() => validateNarrationDirection({ locale: 'x' }), /BCP-47/);
});

test('narrationSegmentsFromProject carries provider-independent direction metadata', () => {
  const project = {
    production: {
      script: [
        { narration: 'Ireña opens the story.', locale: 'en-US', pronunciation: [{ term: 'Ireña', phonetic: 'ee-RAY-nya' }], leadInFrames: 6, voiceId: 'voice-77' },
        { narration: 'Second segment stays plain.' }
      ]
    },
    scenes: [{ id: 's1' }, { id: 's2' }]
  };
  const segments = narrationSegmentsFromProject(project);
  assert.deepEqual(segments, [
    { text: 'Ireña opens the story.', leadInFrames: 6, locale: 'en-US', pronunciation: [{ term: 'Ireña', phonetic: 'ee-RAY-nya' }], voiceId: 'voice-77' },
    { text: 'Second segment stays plain.' }
  ]);
});
