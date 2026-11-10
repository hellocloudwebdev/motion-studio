# OpenRouter creative pipeline

Motion Studio can use OpenRouter to turn an idea into a research brief, creative direction, script, storyboard, design system and validated Canonical Video IR. This is a planning and IR-generation stage; it does not synthesize narration audio, run Adobe, render or declare a production accepted.

## Credentials

Set `OPENROUTER_API_KEY` in a local environment. Do not put it in project JSON, CLI arguments, source control, logs or MCP tool inputs. For local development, create an ignored `.env.local` from `.env.example` and invoke Node with `--env-file=.env.local`:

```powershell
Copy-Item .env.example .env.local
# Edit .env.local locally without sharing its contents.
node --env-file=.env.local apps/cli/src/index.mjs plan "Explain how community solar works" --duration 45 --audience "first-time renters" --output projects/community-solar
```

If a credential has been pasted into chat, revoke it in OpenRouter and create a replacement before testing.

## Free model routing and web research

By default, the provider selects `openrouter/free`; override it with `--model <provider/model>` or `MOTION_STUDIO_MODEL`. OpenRouter documents this router as selecting free models that support required capabilities, but free capacity, availability and rate limits can change. See [OpenRouter's free model router](https://openrouter.ai/openrouter/free) and [API reference](https://openrouter.ai/docs/api_reference/overview).

Web research is disabled by default. Pass `--allow-web-search` only when you approve the possibility of separate search-provider charges; model inference being free does not make every search backend free. OpenRouter's [web search tool documentation](https://openrouter.ai/tool/web-search/) lists current engine pricing.

## Commands

```bash
node --env-file=.env.local apps/cli/src/index.mjs plan "<idea>" \
  --duration 45 --audience "<audience>" --purpose "<purpose>" \
  --language English --platform youtube --aspect-ratio 16:9 \
  --output projects/<project-id>
```

On success the command writes `project.json` (Canonical Video IR) and `production-plan.json` (brief, research evidence, concept, script, storyboard, design system and provenance). If essential information is missing, it returns clarifying questions and does not write a project. Output paths are exclusive: an existing project file is never overwritten.

Use `--allow-web-search` only for research-required ideas after checking the current OpenRouter search charges. Research citations are accepted only when the provider response contains matching URL citation annotations; unverified URLs are discarded.
