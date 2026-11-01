# voiceos-integrations

voice os (yc p25) mcp integrations built by Agentic AI @ UIUC MTS. this is an internal repo for our mts

Each integration lives in its own folder under `integrations/`.

```
integrations/
  asana/
  excel/
  ...
```

## Adding an integration

1. Fork this repo and create a branch, the branch name MUST be the name of the integration i.e. (feat/asana-integration, feat/excel-integration, feat/posthog-integration, feat/asana)
2. Add your working integration, with its tests, under `integrations/<name>/`. IF YOU DO NOT FOLLOW THIS GUIDELINE YOUR PR WILL BE CLOSED
3. Open a pull request into `main`.
4. Let me (@kidskoding) or fino (@syafino) review and approve prior to merging

## CI checks

For every integration a PR touches:

- no `.env` files are committed
- `bun install` succeeds
- it has tests, and `bun test` passes

Never commit API keys. Put them in `.env` (ignored) and document them in `.env.example`.
