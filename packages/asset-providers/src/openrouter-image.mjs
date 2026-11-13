import { rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspaceOutput, probeImage, sha256File } from './runtime.mjs';

const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Resolved 2026-11-14 against GET https://openrouter.ai/api/v1/models (public,
// read-only): 470 models listed, 13 expose architecture.output_modalities
// including "image" (10 named image models, e.g. google/gemini-2.5-flash-image,
// google/gemini-3-pro-image, openai/gpt-5-image; plus the 3 openrouter/auto
// routers). Image OUTPUT is therefore a real OpenRouter capability and this
// provider posts chat/completions with the modalities flag.
export const OPENROUTER_DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
export const OPENROUTER_IMAGE_TERMS_NOTE = 'Provider-generated image via OpenRouter: rights depend on the upstream model provider terms. Recorded as unknown rights pending producer review; not approved for final use by default.';
const OPENROUTER_KEY_ERROR = 'OPENROUTER_API_KEY is required for OpenRouter image generation. Set it in a protected local environment; never pass it as a CLI argument.';
const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

export function resolveOpenRouterImageOptions(env = process.env, { apiKey, model } = {}) {
  const resolvedKey = (apiKey || env.OPENROUTER_API_KEY || '').trim();
  if (!resolvedKey) throw new Error(OPENROUTER_KEY_ERROR);
  const resolvedModel = model || env.OPENROUTER_IMAGE_MODEL || OPENROUTER_DEFAULT_IMAGE_MODEL;
  return { apiKey: resolvedKey, model: resolvedModel };
}

export function assertValidImagePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new Error('Image prompt must contain 1-4000 characters.');
}

export async function generateOpenRouterImage(prompt, { outputPath, projectRoot, signal, timeoutMs = 120_000, apiKey, model, fetchImpl = fetch, env = process.env } = {}) {
  assertValidImagePrompt(prompt);
  const { root, output, realDirectory } = await prepareWorkspaceOutput({ projectRoot, outputPath, label: 'OpenRouter image output' });
  const credentials = resolveOpenRouterImageOptions(env, { apiKey, model });
  const runId = process.pid + '-' + Date.now();
  const temp = path.join(realDirectory, '.asset-openrouter-image-' + runId + '.img');
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(OPENROUTER_IMAGE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + credentials.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: credentials.model, modalities: ['image', 'text'], messages: [{ role: 'user', content: prompt.trim() }] }),
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    });
    if (!response.ok) {
      let message = 'request failed';
      try {
        const data = await response.json();
        message = (typeof data?.error?.message === 'string' && data.error.message.trim()) || (typeof data?.message === 'string' && data.message.trim()) || message;
      } catch {}
      throw new Error('OpenRouter image API returned ' + response.status + ': ' + message);
    }
    const data = await response.json();
    const images = data?.choices?.[0]?.message?.images;
    const dataUrl = Array.isArray(images) && typeof images[0]?.image_url?.url === 'string' ? images[0].image_url.url : null;
    if (!dataUrl) throw new Error('OpenRouter model ' + credentials.model + ' returned no image data. Confirm the model supports image output (architecture.output_modalities includes "image").');
    const match = DATA_URL_PATTERN.exec(dataUrl);
    if (!match) throw new Error('OpenRouter returned an unsupported image payload (expected a base64 data URL).');
    const imageBytes = Buffer.from(match[2], 'base64');
    if (imageBytes.length === 0) throw new Error('OpenRouter returned an empty image payload.');
    await writeFile(temp, imageBytes, { flag: 'wx' });
    const image = await probeImage(temp, { signal, label: 'OpenRouter image' });
    await rename(temp, output);
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('OpenRouter image output is empty.');
    return {
      provider: 'openrouter',
      kind: 'image',
      model: credentials.model,
      prompt: prompt.trim(),
      projectRoot: root,
      output,
      sha256: await sha256File(output),
      byteSize: outputStat.size,
      image: { ...image, mimeType: match[1] },
      verified: true,
      // Provider-API outputs are never final by default (roadmap P3.1): unknown
      // rights stay pending producer review until an approval is recorded.
      rightsStatus: 'unknown',
      terms: OPENROUTER_IMAGE_TERMS_NOTE,
      providerTerms: { note: OPENROUTER_IMAGE_TERMS_NOTE },
      responseId: typeof data.id === 'string' ? data.id : null,
      usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
      generatedAt: new Date().toISOString()
    };
  } finally {
    await rm(temp, { force: true });
  }
}
