## Integration

<!-- e.g. Asana, Microsoft Excel. Folder: integrations/<name>/ -->

## What it does

<!-- One or two sentences: what can a user do by voice with this integration? -->

## Actions / tools

<!-- List each tool the MCP server exposes and what it does. -->

-

## How I tested it

<!-- Which actions you ran live in VoiceOS, and what happened. Screenshots or a short recording help reviewers. -->

<!-- Please also show that your tests effectively pass with unit and integration tests-->

## Checklist

- [ ] Everything lives in `integrations/<name>/` and nothing outside it changed
- [ ] `voiceos.integration.json` has a unique `id`, a `version`, and the right `permissions.domains`
- [ ] No API keys or `.env` files committed; every key is listed in `.env.example`
- [ ] `bun install` and `bun test` pass locally
- [ ] Destructive actions (delete, overwrite) ask the user to confirm first
