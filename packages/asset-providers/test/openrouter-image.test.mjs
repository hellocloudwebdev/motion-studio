import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertValidImagePrompt, generateOpenRouterImage, resolveOpenRouterImageOptions,
  OPENROUTER_DEFAULT_IMAGE_MODEL, OPENROUTER_IMAGE_TERMS_NOTE
} from '../src/openrouter-image.mjs';
import { ffmpegAvailable, TINY_PNG_BASE64 } from './helpers.mjs';

const TEST_API_KEY = 'openrouter-test-key-not-a-real-credential';

const imageResponse = () => new Response(JSON.stringify({
  id: 'gen-resp-1',
  choices: [{ message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + TINY_PNG_BASE64 } }] } }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
}), { status: 200, headers: { 'content-type': 'application/json' } });

const errorResponse = status => body => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function trackingFetch(response) {
  const requests = [];
  const impl = async (url, options) => { requests.push({ url, options }); return typeof response === 'function' ? response() : response; };
  return { requests, impl };
}

test('resolves OpenRouter credentials from the environment and requires a key', () => {
  assert.throws(() => resolveOpenRouterImageOptions({}), /OPENROUTER_API_KEY is required for OpenRouter image generation/);
  assert.throws(() => resolveOpenRouterImageOptions({ OPENROUTER_API_KEY: '  ' }), /OPENROUTER_API_KEY is required/);
  assert.deepEqual(resolveOpenRouterImageOptions({ OPENROUTER_API_KEY: TEST_API_KEY }), { apiKey: TEST_API_KEY, model: OPENROUTER_DEFAULT_IMAGE_MODEL });
  assert.deepEqual(resolveOpenRouterImageOptions({ OPENROUTER_API_KEY: TEST_API_KEY, OPENROUTER_IMAGE_MODEL: 'google/gemini-3-pro-image' }), { apiKey: TEST_API_KEY, model: 'google/gemini-3-pro-image' });
  assert.deepEqual(resolveOpenRouterImageOptions({ OPENROUTER_API_KEY: 'env-key' }, { model: 'flag-model', apiKey: 'flag-key' }), { apiKey: 'flag-key', model: 'flag-model' });
});

test('rejects invalid prompts and unsafe output paths before any network call', async () => {
  assert.throws(() => assertValidImagePrompt(''), /Image prompt must contain 1-4000 characters/);
  assert.throws(() => assertValidImagePrompt('x'.repeat(4001)), /Image prompt must contain 1-4000 characters/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-or-image-'));
  try {
    const { requests, impl } = trackingFetch(imageResponse());
    await assert.rejects(generateOpenRouterImage('A prompt.', { projectRoot: root, outputPath: path.join(root, '..', 'out.png'), fetchImpl: impl }), /must remain inside/);
    await assert.rejects(generateOpenRouterImage('   ', { projectRoot: root, outputPath: path.join(root, 'ok.png'), fetchImpl: impl, env: { OPENROUTER_API_KEY: TEST_API_KEY } }), /Image prompt must contain 1-4000 characters/);
    assert.equal(requests.length, 0, 'no request may leave the process for invalid input');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects generation before any network call when no key is configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-or-image-'));
  try {
    const { requests, impl } = trackingFetch(imageResponse());
    await assert.rejects(generateOpenRouterImage('A prompt.', { projectRoot: root, outputPath: path.join(root, 'out.png'), fetchImpl: impl, env: {} }), /OPENROUTER_API_KEY is required/);
    assert.equal(requests.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maps OpenRouter HTTP errors to clear messages without echoing the key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-or-image-'));
  try {
    const { impl } = trackingFetch(() => errorResponse(401)({ error: { message: 'Invalid API key', code: 401 } }));
    await assert.rejects(
      generateOpenRouterImage('A prompt.', { projectRoot: root, outputPath: path.join(root, 'out.png'), apiKey: TEST_API_KEY, fetchImpl: impl }),
      /OpenRouter image API returned 401: Invalid API key/
    );
    const { impl: impl500 } = trackingFetch(() => errorResponse(500)({ message: 'upstream exploded' }));
    await assert.rejects(
      generateOpenRouterImage('A prompt.', { projectRoot: root, outputPath: path.join(root, 'out.png'), apiKey: TEST_API_KEY, fetchImpl: impl500 }),
      /OpenRouter image API returned 500: upstream exploded/
    );
    const listing = await readdir(root);
    assert.equal(listing.filter(name => name.startsWith('.asset-openrouter-image-')).length, 0, 'failed requests must not leave temp files behind');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fails closed when the model returns no image payload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-or-image-'));
  try {
    const noImages = new Response(JSON.stringify({ id: 'r1', choices: [{ message: { role: 'assistant', content: 'I can only make text.' } }] }), { status: 200 });
    const { impl } = trackingFetch(noImages);
    await assert.rejects(
      generateOpenRouterImage('A prompt.', { projectRoot: root, outputPath: path.join(root, 'out.png'), apiKey: TEST_API_KEY, fetchImpl: impl }),
      /returned no image data\. Confirm the model supports image output/
    );
    const badPayload = new Response(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'https://example.invalid/cat.png' } }] } }] }), { status: 200 });
    const { impl: impl2 } = trackingFetch(badPayload);
    await assert.rejects(
      generateOpenRouterImage('A prompt.', { projectRoot: root, outputPath: path.join(root, 'out.png'), apiKey: TEST_API_KEY, fetchImpl: impl2 }),
      /unsupported image payload/
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generates a verified image with an unknown-rights receipt via the chat/completions contract', async t => {
  if (!ffmpegAvailable()) { t.skip('This runner does not have its platform FFmpeg tools installed.'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-or-image-'));
  try {
    const { requests, impl } = trackingFetch(imageResponse());
    const output = path.join(root, 'assets', 'images', 'scene.png');
    const receipt = await generateOpenRouterImage('  A teal gradient backdrop with soft light.  ', { projectRoot: root, outputPath: output, apiKey: TEST_API_KEY, fetchImpl: impl, timeoutMs: 30_000 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + TEST_API_KEY);
    assert.deepEqual(JSON.parse(requests[0].options.body), { model: OPENROUTER_DEFAULT_IMAGE_MODEL, modalities: ['image', 'text'], messages: [{ role: 'user', content: 'A teal gradient backdrop with soft light.' }] });
    assert.equal(receipt.provider, 'openrouter');
    assert.equal(receipt.kind, 'image');
    assert.equal(receipt.model, OPENROUTER_DEFAULT_IMAGE_MODEL);
    assert.equal(receipt.prompt, 'A teal gradient backdrop with soft light.');
    assert.equal(receipt.rightsStatus, 'unknown', 'provider-API output is unknown rights by default');
    assert.equal(receipt.terms, OPENROUTER_IMAGE_TERMS_NOTE);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.projectRoot, path.resolve(root));
    assert.equal(receipt.output, output);
    assert.equal(receipt.image.codec, 'png');
    assert.equal(receipt.image.width, 64);
    assert.equal(receipt.image.height, 48);
    assert.equal(receipt.image.mimeType, 'image/png');
    assert.equal(receipt.sha256, createHash('sha256').update(await readFile(output)).digest('hex'));
    assert.equal(receipt.byteSize, (await stat(output)).size);
    assert.ok(receipt.byteSize === Buffer.from(TINY_PNG_BASE64, 'base64').length);
    assert.equal(receipt.responseId, 'gen-resp-1');
    assert.deepEqual(receipt.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
    const listing = await readdir(root);
    assert.equal(listing.filter(name => name.startsWith('.asset-openrouter-image-')).length, 0, 'temp files must be cleaned up');
  } finally { await rm(root, { recursive: true, force: true }); }
});
