import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspaceOutput, probeAudio, run, sha256File } from './runtime.mjs';

export const MUSIC_TERMS = 'Locally synthesized, no third-party material';
const MUSIC_SAMPLE_RATE = 44100;
const MUSIC_DURATION_RANGE = { min: 2, max: 600 };
const CHORD_COUNT = 4;
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Mood -> chord progression as [semitone offset from the key root, quality].
// Progressions are stretched evenly across the bed so the graph stays bounded
// (always CHORD_COUNT segments plus one bass drone) for any duration.
export const MUSIC_MOODS = {
  uplift: { progression: [[0, 'major'], [7, 'major'], [9, 'minor'], [5, 'major']] },
  calm: { progression: [[0, 'major'], [5, 'major'], [9, 'minor'], [2, 'minor']] },
  warm: { progression: [[0, 'major'], [9, 'minor'], [5, 'major'], [7, 'major']] },
  tense: { progression: [[0, 'minor'], [8, 'major'], [3, 'major'], [10, 'major']] }
};

export const MUSIC_MOOD_NAMES = Object.keys(MUSIC_MOODS);
const KEY_PATTERN = /^([A-G])([#b]?)(m?)$/;

export function parseMusicKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key.trim())) {
    throw new Error('key must be a note name like C, F#, Bb or Am (major by default, "m" suffix for minor).');
  }
  const [, letter, accidental, minor] = KEY_PATTERN.exec(key.trim());
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  const semitone = (base + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12;
  return { name: letter + accidental + (minor || ''), semitone, minor: minor === 'm' };
}

const hertz = value => String(Math.round(value * 10000) / 10000);
const seconds = value => value.toFixed(6);
const midiToFrequency = midi => 440 * 2 ** ((midi - 69) / 12);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function chordMidiFrequencies(rootSemitone, offset, quality) {
  const root = 48 + ((rootSemitone + offset) % 12);
  const third = quality === 'minor' ? root + 3 : root + 4;
  return [root, third, root + 7].map(midiToFrequency);
}

function chordLabel(rootSemitone, offset, quality) {
  const name = SHARP_NAMES[(rootSemitone + offset) % 12];
  return quality === 'minor' ? name + 'm' : name;
}

// Pure plan builder: layered chord tones (sines) over a triangle-wave bass
// drone, per-chord tremolo (one throb per beat) + afade crossfades, then global
// fades. Everything is derived from the four params, so identical params render
// byte-identical beds.
export function buildMusicBedPlan({ durationSeconds, key = 'C', bpm = 96, mood = 'uplift' } = {}) {
  const resolvedDuration = durationSeconds;
  if (!Number.isFinite(resolvedDuration) || resolvedDuration < MUSIC_DURATION_RANGE.min || resolvedDuration > MUSIC_DURATION_RANGE.max) {
    throw new Error('durationSeconds must be a number between ' + MUSIC_DURATION_RANGE.min + ' and ' + MUSIC_DURATION_RANGE.max + '.');
  }
  const parsedKey = parseMusicKey(key);
  if (!Number.isInteger(bpm) || bpm < 40 || bpm > 220) throw new Error('bpm must be an integer between 40 and 220.');
  if (!MUSIC_MOODS[mood]) throw new Error('Unknown mood: ' + String(mood) + '. Supported moods: ' + MUSIC_MOOD_NAMES.join(', ') + '.');

  const secondsPerChord = resolvedDuration / CHORD_COUNT;
  const chordFade = Math.min(0.6, secondsPerChord * 0.3);
  const pulseHertz = hertz(bpm / 60);
  const chords = MUSIC_MOODS[mood].progression.map(([offset, quality]) => ({
    label: chordLabel(parsedKey.semitone, offset, quality),
    frequencies: chordMidiFrequencies(parsedKey.semitone, offset, quality)
  }));

  const inputs = [];
  const filters = [];
  chords.forEach((chord, index) => {
    const firstInput = inputs.length;
    for (const frequency of chord.frequencies) {
      inputs.push(['-f', 'lavfi', '-i', 'sine=frequency=' + hertz(frequency) + ':sample_rate=' + MUSIC_SAMPLE_RATE + ':duration=' + seconds(secondsPerChord)]);
    }
    const labels = chord.frequencies.map((_, tone) => '[' + (firstInput + tone) + ':a]').join('');
    filters.push(
      labels + 'amix=inputs=' + chord.frequencies.length + ':duration=first:normalize=0' +
      ',tremolo=f=' + pulseHertz + ':d=0.3' +
      ',afade=t=in:d=' + seconds(chordFade) +
      ',afade=t=out:st=' + seconds(secondsPerChord - chordFade) + ':d=' + seconds(chordFade) +
      ',volume=0.22[c' + index + ']'
    );
  });
  const bassFrequency = midiToFrequency(48 + parsedKey.semitone - 12);
  const bassInput = inputs.length;
  inputs.push(['-f', 'lavfi', '-i', "aevalsrc='0.4*(2/PI)*asin(sin(2*PI*" + hertz(bassFrequency) + '*t))\':s=' + MUSIC_SAMPLE_RATE + ':d=' + seconds(resolvedDuration)]);
  const fadeOut = Math.min(2, resolvedDuration * 0.25);
  const fadeIn = Math.min(1.5, resolvedDuration * 0.1);
  filters.push(
    '[' + bassInput + ':a]volume=0.45[bass]',
    chords.map((_, index) => '[c' + index + ']').join('') + 'concat=n=' + CHORD_COUNT + ':v=0:a=1[prog]',
    '[prog][bass]amix=inputs=2:duration=first:normalize=0' +
    ',aformat=channel_layouts=stereo' +
    ',afade=t=in:d=' + seconds(fadeIn) +
    ',afade=t=out:st=' + seconds(resolvedDuration - fadeOut) + ':d=' + seconds(fadeOut) + '[aout]'
  );

  return {
    params: {
      durationSeconds: resolvedDuration,
      key: parsedKey.name,
      bpm,
      mood,
      chords: chords.map(chord => chord.label),
      secondsPerChord,
      bassFrequency: Math.round(bassFrequency * 100) / 100,
      fadeInSeconds: fadeIn,
      fadeOutSeconds: fadeOut
    },
    inputs,
    audioArgs: ['-filter_complex', filters.join(';'), '-map', '[aout]'],
    filters,
    extension: '.wav'
  };
}

export async function generateMusicBed({ durationSeconds, outputPath, projectRoot, key, bpm, mood, signal, timeoutMs = 120_000 } = {}) {
  const plan = buildMusicBedPlan({ durationSeconds, key, bpm, mood });
  const { root, output, realDirectory } = await prepareWorkspaceOutput({ projectRoot, outputPath, label: 'Music bed output' });
  const runId = process.pid + '-' + Date.now();
  const temp = path.join(realDirectory, '.asset-music-bed-' + runId + plan.extension);
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const input of plan.inputs) args.push(...input);
    args.push(...plan.audioArgs, '-c:a', 'pcm_s16le', temp);
    await run('ffmpeg', args, { cwd: realDirectory, signal, timeoutMs });
    const audio = await probeAudio(temp, { signal, label: 'ffmpeg-lavfi music bed' });
    if (Math.abs(audio.durationSeconds - plan.params.durationSeconds) > Math.max(0.1, plan.params.durationSeconds * 0.02)) {
      throw new Error('ffmpeg-lavfi music bed duration drifted: expected ~' + plan.params.durationSeconds + 's, FFprobe measured ' + audio.durationSeconds + 's.');
    }
    await rename(temp, output);
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('ffmpeg-lavfi music bed output is empty.');
    return {
      provider: 'ffmpeg-lavfi',
      kind: 'music-bed',
      variant: plan.params.mood,
      params: plan.params,
      projectRoot: root,
      output,
      sha256: await sha256File(output),
      byteSize: outputStat.size,
      audio,
      verified: true,
      rightsStatus: 'generated',
      terms: MUSIC_TERMS,
      generatedAt: new Date().toISOString()
    };
  } finally {
    await rm(temp, { force: true });
  }
}
