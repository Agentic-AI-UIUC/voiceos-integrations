# Production review

[UIUC-1](https://app.notion.com/p/Integrate-GitHub-MCP-via-Composio-OAuth2-4035cec9ef9e816a893ae407274dc8a7)
requires a SOC 2 review gate before production and a warning until sign-off
from Max and the SOC 2 team. VoiceOS's automated share review is a separate check.

**Status: pending. No SOC 2 sign-off is claimed.** The normal build displays
the warning on the integration page and refuses production reads, writes,
OAuth linking and session warm-up. Its blocked-action card also shows the warning.
All eight tools and their confirmation cards remain registered for review.
Tests can use the existing command-line override to a loopback fake Composio;
there is no production opt-in setting. Disconnect/revocation remains available.

## Record sign-off and build

1. Finish the code changes and run `bun run build && bun test && bun run verify`.
2. Run `bun run review:production`. It prints the SHA-256 fingerprint and
   exits nonzero while review is pending. The fingerprint covers every file
   in `src/` and `scripts/`, plus `package.json`, `bun.lock`, `widgetKit.ts`,
   `run.sh` and `run.cmd`. Review evidence and generated output are excluded.
3. Max and a separate SOC 2 team reviewer review those inputs and record
   their actual sign-offs. Only after both approve, update
   `production-review.json` through a reviewed PR:

   ```json
   {
     "schemaVersion": 1,
     "status": "approved",
     "artifactSha256": "<the exact 64-character fingerprint>",
     "approvals": [
       { "role": "max", "reviewer": "<Max's identity>", "approvedAt": "<UTC ISO timestamp>", "evidenceUrl": "<HTTPS sign-off URL>" },
       { "role": "soc2", "reviewer": "<SOC 2 reviewer's identity>", "approvedAt": "<UTC ISO timestamp>", "evidenceUrl": "<HTTPS sign-off URL>" }
     ]
   }
   ```

4. Run `bun run review:production && bun run build:production && bun test && bun run verify && bun verify.ts --package`.
   Publish the rebuilt `server.ts` and manifest together using the normal
   VoiceOS review/publish process.

The build embeds the validation result in the self-contained server, so a
shared install needs no evidence file or additional setting. Missing or
malformed evidence, either missing sign-off, future approval dates, or a
changed source fingerprint leave production blocked and the warning visible.
Any covered code/dependency change requires renewed review and a rebuild.
The evidence file records human approval; it does not authenticate reviewers
or replace repository review controls or a SOC 2 audit. Maintainers must
verify the linked approvals before accepting the evidence change.

Merging this PR supplies the gate; it does not grant production approval or
update the previously published VoiceOS share.
