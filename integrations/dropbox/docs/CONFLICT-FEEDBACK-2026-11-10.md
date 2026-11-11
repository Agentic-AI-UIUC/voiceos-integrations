# Dropbox 2.0.10: conflict feedback and QA

Build: dropbox-composio-v12-conflict-feedback. All 14 public tools and eight native Cancel/Confirm cards are preserved. All write fields remain bound to the approved arguments.

## Changes

Create folder, Copy and Move conflicts now advise choosing another destination. Upload conflicts still allow requesting an explicitly approved Overwrite for an existing file, and clarify that a folder cannot be overwritten. Advice is preserved through both provider error handling and the MCP error boundary. No conflict is treated as success or retried automatically. The shared-link confirmation uses plain text without the damaged apostrophe.

## Manual evidence from 2.0.9

The supplied November 10 run contains successful executions of all 14 tools: 16 completed calls, plus one expected duplicate-folder conflict. Screenshots show native Cancel buttons on all eight writes. Cancelled requests are absent from the execution log. Earlier agent-operated Windows Preview verified that editing a folder destination sends and creates the edited path. Upload Add and Overwrite produced different content hashes; Restore returned the original upload hash. Word extraction completed. Shared links and the revision overflow rail rendered correctly. This is Windows evidence, not native Mac certification.

## Dependencies

The repository retains its tested Composio 0.28.0 pin and pinned toolkit version. VoiceOS Studio generated a Preview installation with Composio 0.29.0 and Ajv 8.20.0 in the supplied live trace. Those successful live results belong to that actual environment. A future fresh Studio/shared installation must record its installed dependencies separately; do not describe Preview as reproducing the repository lockfile. This small feedback patch does not change SDKs or provider mappings.

## Targeted retest

A full Windows 14-action rerun is unnecessary for this feedback patch after the offline suite passes. Check one existing-folder conflict, one existing-destination Copy or Move conflict, and Upload Add conflict advice. Cancel any overwrite request unless intentionally testing replacement. Open the shared-link confirmation and verify the sentence displays correctly; cancel without creating a link. Native Mac QA still needs initial acceptance: Cancel with no MCP request, edited input reaching execution, upload from a real /Users/... path containing spaces, Word reading, link controls and overflow scrolling. The changed error messages and native card text are OS-neutral. macOS launcher and production runtime use cross-platform filesystem APIs and remain unchanged.

The outer VoiceOS response scroller, managed credential lifecycle, expired/revoked-token QA, fresh shared installation and publish/share-link verification remain separate release checks.
