# voiceos-integrations

VoiceOS MCP integrations built by Agentic AI @ UIUC. Each integration lives in its own folder under `integrations/`.

```
integrations/
  asana/
  excel/
  ...
```

## Adding an integration

1. Fork this repo and create a branch.
2. Add your integration as `integrations/<name>/`. It must contain `package.json`, `bun.lock`, `server.ts`, `run.sh`, `voiceos.integration.json` and `.env.example`.
3. Open a pull request into `main`.
4. CI must pass and a reviewer from `@Agentic-AI-UIUC/voiceos-reviewers` must approve before it can merge.

## CI checks

For every integration a PR touches:

- required files are present
- `voiceos.integration.json` is valid and has `schemaVersion`, `id`, `name`, `version` and `runtime.kind`
- no `.env` files are committed
- `bun install --frozen-lockfile` succeeds
- `server.ts` builds
- `bun test` passes, if the integration has tests

Never commit API keys. Put them in `.env` (ignored) and document them in `.env.example`.
