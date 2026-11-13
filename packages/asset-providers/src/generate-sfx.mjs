import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspaceOutput, probeAudio, run, sha256File } from './runtime.mjs';

export const SFX_TERMS = 'Locally synthesized, no third-party material';
const SFX_SAMPLE_RATE = 44100;
const SFX_DURATION_RANGE = { min: 0.1, max: 30 };
const SFX_GAIN_RANGE = { min: 0, max: 2 };

// Per-kind frequency mapping: the caller-facing `frequency` param drives the
// musically meaningful frequency of each recipe (band center, oscillator pitch
// or sweep start). All recipes are pure math over these numbers, so renders are
// byte-deterministic for identical params.
const SFX_KINDS = {
  whoosh: { defaultFrequency: 900, minFrequency: 60, maxFrequency: 4000, defaultDurationSeconds: 1.5, defaultSeed: 1729 },
  shimmer: { defaultFrequency: 2400, minFrequency: 800, maxFrequency: 8000, defaultDurationSeconds: 1.2, defaultSeed: 1729 },
  pop: { defaultFrequency: 320, minFrequency: 60, maxFrequency: 1200, defaultDurationSeconds: 0.35, defaultSeed: 1729 },
  riser: { defaultFrequency: 220, minFrequency: 80, maxFrequency: 800, defaultDurationSeconds: 3, defaultSeed: 1729 },
  impact: { defaultFrequency: 120, minFrequency: 40, maxFrequency: 300, defaultDurationSeconds: 1.2, defaultSeed: 4711 },
  thud: { defaultFrequency: 70, minFrequency: 30, maxFrequency: 180, defaultDurationSeconds: 0.8, defaultSeed: 4711 }
};

export const SFX_KIND_NAMES = Object.keys(SFX_KINDS);

const seconds = value => value.toFixed(6);
const hertz = value => String(Math.round(value * 10000) / 10000);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function numberParam(params, name, { min, max, fallback }) {
  const value = params[name] === undefined ? fallback : params[name];
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error('params.' + name + ' must be a number between ' + min + ' and ' + max + '.');
  }
  return value;
}

// Mono 44.1 kHz pcm_s16le recipes. Noise sources take an explicit anoisesrc
// seed so determinism holds for noise-based kinds too. The riser volume
// expression escapes its comma (`\,`) because ffmpeg splits filter chains on
// commas at the filtergraph level. `gain` is applied as the final volume filter
// of each chain (inside the filter_complex for the two-source impact recipe).
function recipe(kind, { durationSeconds, frequency, gain, seed }) {
  const d = durationSeconds;
  const gainFilter = gain === 1 ? null : 'volume=' + hertz(gain);
  const chain = filters => (gainFilter ? [...filters, gainFilter] : filters);
  switch (kind) {
    case 'whoosh': {
      const filters = chain([
        'highpass=f=' + Math.round(clamp(frequency * 0.45, 20, 16000)),
        'lowpass=f=' + Math.round(clamp(frequency * 2.4, 40, 16000)),
        'tremolo=f=' + hertz(clamp(frequency / 140, 1, 12)) + ':d=0.8',
        'afade=t=in:d=' + seconds(d * 0.18),
        'afade=t=out:st=' + seconds(d * 0.72) + ':d=' + seconds(d * 0.28)
      ]);
      return {
        inputs: [['-f', 'lavfi', '-i', 'anoisesrc=colour=pink:seed=' + seed + ':amplitude=0.7:r=' + SFX_SAMPLE_RATE + ':d=' + seconds(d)]],
        audioArgs: ['-af', filters.join(',')], filters
      };
    }
    case 'shimmer': {
      const filters = chain([
        'vibrato=f=7:d=0.35',
        'tremolo=f=3.2:d=0.7',
        'afade=t=in:d=' + seconds(d * 0.3),
        'afade=t=out:st=' + seconds(d * 0.5) + ':d=' + seconds(d * 0.5)
      ]);
      return {
        inputs: [['-f', 'lavfi', '-i', 'sine=frequency=' + hertz(frequency) + ':sample_rate=' + SFX_SAMPLE_RATE + ':duration=' + seconds(d)]],
        audioArgs: ['-af', filters.join(',')], filters
      };
    }
    case 'pop': {
      const filters = chain(['afade=t=out:st=0:d=' + seconds(d * 0.85) + ':curve=exp']);
      return {
        inputs: [['-f', 'lavfi', '-i', 'sine=frequency=' + hertz(frequency) + ':sample_rate=' + SFX_SAMPLE_RATE + ':duration=' + seconds(d)]],
        audioArgs: ['-af', filters.join(',')], filters
      };
    }
    case 'riser': {
      const end = frequency * 3.5;
      const rate = (end - frequency) / (2 * d); // instantaneous frequency: start + 2*rate*t
      const filters = chain([
        "volume=0.3+0.7*min(1\\,t/" + seconds(d) + '):eval=frame',
        'tremolo=f=8:d=0.4',
        'afade=t=out:st=' + seconds(Math.max(0, d - 0.15)) + ':d=' + seconds(Math.min(0.15, d))
      ]);
      return {
        inputs: [['-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*(" + hertz(frequency) + '*t+' + hertz(rate) + '*t*t))\':s=' + SFX_SAMPLE_RATE + ':d=' + seconds(d)]],
        audioArgs: ['-af', filters.join(',')], filters
      };
    }
    case 'impact': {
      const noiseDuration = Math.min(0.4, d * 0.5);
      const filters = chain([
        '[0:a]afade=t=out:st=0:d=' + seconds(d * 0.9) + ':curve=exp[v]',
        '[1:a]afade=t=out:st=0:d=' + seconds(noiseDuration * 0.85) + ':curve=exp[n]',
        '[v][n]amix=inputs=2:duration=longest:normalize=0[aout]'
      ]);
      return {
        inputs: [
          ['-f', 'lavfi', '-i', 'sine=frequency=' + hertz(frequency) + ':sample_rate=' + SFX_SAMPLE_RATE + ':duration=' + seconds(d)],
          ['-f', 'lavfi', '-i', 'anoisesrc=colour=brown:seed=' + seed + ':amplitude=0.9:r=' + SFX_SAMPLE_RATE + ':d=' + seconds(noiseDuration)]
        ],
        audioArgs: ['-filter_complex', filters.join(';'), '-map', '[aout]'], filters
      };
    }
    case 'thud': {
      const filters = chain([
        'lowpass=f=' + Math.round(clamp(frequency * 2.3, 40, 500)),
        'afade=t=out:st=0:d=' + seconds(d * 0.88) + ':curve=exp'
      ]);
      return {
        inputs: [['-f', 'lavfi', '-i', 'sine=frequency=' + hertz(frequency) + ':sample_rate=' + SFX_SAMPLE_RATE + ':duration=' + seconds(d)]],
        audioArgs: ['-af', filters.join(',')], filters
      };
    }
    default:
      throw new Error('Unknown SFX kind: ' + String(kind) + '. Supported kinds: ' + SFX_KIND_NAMES.join(', ') + '.');
  }
}

// Pure plan builder: identical arguments always produce an identical ffmpeg
// invocation, so tests can pin the provider contract without running ffmpeg.
export function buildSfxPlan(kind, { durationSeconds, frequency, gain, seed } = {}) {
  const spec = SFX_KINDS[kind];
  if (!spec) throw new Error('Unknown SFX kind: ' + String(kind) + '. Supported kinds: ' + SFX_KIND_NAMES.join(', ') + '.');
  const resolvedDuration = durationSeconds === undefined ? spec.defaultDurationSeconds : durationSeconds;
  if (!Number.isFinite(resolvedDuration) || resolvedDuration < SFX_DURATION_RANGE.min || resolvedDuration > SFX_DURATION_RANGE.max) {
    throw new Error('durationSeconds must be a number between ' + SFX_DURATION_RANGE.min + ' and ' + SFX_DURATION_RANGE.max + '.');
  }
  const params = {
    kind,
    durationSeconds: resolvedDuration,
    frequency: numberParam({ frequency }, 'frequency', { min: spec.minFrequency, max: spec.maxFrequency, fallback: spec.defaultFrequency }),
    gain: numberParam({ gain }, 'gain', { min: SFX_GAIN_RANGE.min, max: SFX_GAIN_RANGE.max, fallback: 1 }),
    seed: numberParam({ seed }, 'seed', { min: 0, max: 2 ** 31 - 1, fallback: spec.defaultSeed })
  };
  const built = recipe(kind, params);
  return { kind, params, inputs: built.inputs, audioArgs: built.audioArgs, filters: built.filters, extension: '.wav' };
}

export async function generateSfx({ kind, durationSeconds, outputPath, projectRoot, params = {}, signal, timeoutMs = 120_000 } = {}) {
  const plan = buildSfxPlan(kind, { durationSeconds, ...params });
  const { root, output, realDirectory } = await prepareWorkspaceOutput({ projectRoot, outputPath, label: 'SFX output' });
  const runId = process.pid + '-' + Date.now();
  const temp = path.join(realDirectory, '.asset-sfx-' + runId + plan.extension);
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const input of plan.inputs) args.push(...input);
    args.push(...plan.audioArgs, '-c:a', 'pcm_s16le', temp);
    await run('ffmpeg', args, { cwd: realDirectory, signal, timeoutMs });
    const audio = await probeAudio(temp, { signal, label: 'ffmpeg-lavfi SFX (' + kind + ')' });
    const tolerance = Math.max(0.05, plan.params.durationSeconds * 0.1);
    if (Math.abs(audio.durationSeconds - plan.params.durationSeconds) > tolerance) {
      throw new Error('ffmpeg-lavfi SFX (' + kind + ') duration drifted: expected ~' + plan.params.durationSeconds + 's, FFprobe measured ' + audio.durationSeconds + 's.');
    }
    await rename(temp, output);
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('ffmpeg-lavfi SFX output is empty.');
    return {
      provider: 'ffmpeg-lavfi',
      kind: 'sfx',
      variant: kind,
      params: plan.params,
      projectRoot: root,
      output,
      sha256: await sha256File(output),
      byteSize: outputStat.size,
      audio,
      verified: true,
      rightsStatus: 'generated',
      terms: SFX_TERMS,
      generatedAt: new Date().toISOString()
    };
  } finally {
    await rm(temp, { force: true });
  }
}
