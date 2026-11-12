# Speech providers

`narration-generate` produces one narrated audio asset per production-script segment, plus narration cues with integer frame offsets and captions. The narration text comes from the Canonical Video IR; the voice comes from one of two provider backends selected with `--speech-provider`.

## Providers

| Provider | Flag value | Network | Credentials | Asset `source` |
| --- | --- | --- | --- | --- |
| Platform offline TTS (default) | `local` | none | none | `generated-local-speech` |
| Fish Audio cloud TTS | `fish-audio` | HTTPS | `FISH_AUDIO_API_KEY` (or `FISH_API_KEY`) | `fish-audio` |

Both providers write 16-bit PCM WAV assets inside the project workspace, verify them with an independent FFprobe pass, and remove trailing silence with the same FFmpeg filter chain. Generated assets always keep `rightsStatus: "unknown"` and the command prints `rightsReviewRequired: true`; a provider-generated voice line is never automatically rights-cleared and needs producer review before publication.

## Local offline provider (default)

```bash
node apps/cli/src/index.mjs narration-generate projects/<project-id>/project.json
```

Uses the fixed platform executable: Windows SAPI (through a PowerShell script), macOS `say`, or Linux `espeak`. No key, no network. Omitting `--speech-provider` preserves this behavior.

## Fish Audio provider

```bash
node --env-file=.env.local apps/cli/src/index.mjs narration-generate projects/<project-id>/project.json \
  --speech-provider fish-audio [--speech-model <fish-audio-model-id>]
```

Calls `POST https://api.fish.audio/v1/tts` (model id sent as a request header) and requests WAV at 44.1 kHz, because the narration pipeline probes PCM WAV and trims it with FFmpeg. `--speech-model` overrides the model for the run; `FISH_AUDIO_MODEL` sets the same default in the environment.

### Credentials

Fish Audio is a separate account and subscription from OpenRouter; an `OPENROUTER_API_KEY` does **not** work against Fish Audio. Create the key at [fish.audio](https://fish.audio).

Set `FISH_AUDIO_API_KEY` in a local environment only — never in project JSON, CLI arguments, source control, logs or MCP tool inputs. For local development, keep it in the ignored `.env.local` and invoke Node with `--env-file=.env.local` as shown above. Failures print the HTTP status plus the provider message only; the key is never echoed.

### Free tier model and terms

The default model is `s2.1-pro-free` — the same weights as the paid `s2.1-pro`, priced at $0 and free through 2026-11-30 per the provider's documentation. Fish Audio's free tier gives **no text-to-speech or digital-persona availability guarantees (no TTFA/DPA)**, and the provider may use submitted requests to improve its models: do not send confidential script material you are not licensed to share. These terms are recorded verbatim in each generated asset's metadata (`providerFreeTier: true` plus a `terms` note) and in the command receipt (`providerTerms`).

## Rights

Generated narration is machine output whose provenance, model and provider terms are stored in the project, but clearance for a real publication is a producer decision. Keep `rightsStatus: "unknown"` until the producer reviews the voice, and use `assets approve-rights` to record that review explicitly.
