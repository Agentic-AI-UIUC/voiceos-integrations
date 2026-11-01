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
2. Add your working integration, with its tests, under `integrations/<name>/`.
3. Open a pull request into `main`.
4. CI must pass and a code owner (@kidskoding or @syafino) must approve before it can merge.

## CI checks

For every integration a PR touches:

- no `.env` files are committed
- `bun install` succeeds
- it has tests, and `bun test` passes

Never commit API keys. Put them in `.env` (ignored) and document them in `.env.example`.
