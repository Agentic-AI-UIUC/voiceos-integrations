# voiceos-integrations

voice os (yc p25) mcp integrations built by Agentic AI @ UIUC MTS. this is an internal repo to our mts

Each integration lives in its own folder under `integrations/`.

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

## Testing

Every integration must be thoroughly tested. Include a link to your integration on VoiceOS in your PR.

Never commit API keys. Put them in `.env` (ignored) and document them in `.env.example`.
