# Upload and icon repair — version 2.0.5

Build: dropbox-composio-v7-file-staging-brand. No new public tools: 14 approved actions, eight write confirmations.

## Verified causes

The previous mapper recognized only file/file_to_upload and could not handle the catalog-declared content file input. It also never staged local files. In the installed @composio/core 0.28.0 implementation, automatic upload is disabled by default: Files.node.ts documents manual files.upload and Tools.ts documents forwarding the resulting {name,mimetype,s3key} descriptor to tools.execute. See source/upload.ts for the corrected pipeline.

The previous card bodies had no data-k-mk identity slot. Widget Kit renderCustom therefore injected an absolute .k-mkbar at the same coordinates as the success check or folder icon. All confirmations/results/errors now have one in-flow Dropbox mark, while the status icon is a separate group. The old cloud artwork was replaced consistently in the PNG, embedded mark and cached icon record. See ICON-SOURCE.md.

## Behavior

- Resolve the staged-file field from the fetched pinned schema's file_uploadable annotation or explicit descriptor shape, rather than guessing aliases. Support local schema references and reject ambiguous inputs.
- Validate non-file arguments and the selected existing local file before staging. Read no document text; the SDK receives the exact resolved local path and preserves binary Word/PDF/image data. Limit local uploads to 50 MiB as an integration limit, not a claimed Dropbox provider limit.
- Stage through Composio files.upload, validate the returned descriptor against the complete pinned schema, then dispatch one approved Dropbox upload. A missing file, invalid mode, staging failure or incomplete descriptor cannot dispatch it.
- Add uses strict conflict checks with autorename=false. Overwrite uses strict_conflict=false with autorename=false, following the explicitly approved mode.
- Cancellation during staging prevents a later Dropbox execution. The SDK staging method has no public abort argument; a temporary Composio staging transfer may finish after cancellation, but the guarded Dropbox call cannot run late. No automatic Dropbox write retry is introduced.
- Allow the Composio-managed R2 staging domain in the network manifest; no Dropbox API/token bypass is used. Phase progress remains honest; no byte percentages are invented.
- Standard confirmation forms fit at the tested widths without unnecessary scrolling. Both themes retain the protected button footer.

## Evidence and limits

65 offline tests passed, including all 64 browser layout/bridge combinations. Binary-byte fixtures cover a local filename containing spaces, staging-before-execution, single-call count, incomplete descriptors, cancellation and pre-staging size checks. Icon checks cover every success, failure and confirmation. Browser geometry verifies the mark never overlaps the title/status and no absolute mark bar exists. The rendered offline screenshot was visually inspected: screenshots/cards-2.0.5-offline.png.

These are SDK-contract/schema-fixture tests, not a claim that the live Dropbox upload succeeded. The saved host credentials are encrypted, so an authenticated external upload was not attempted. Retest the same Word upload in VoiceOS after reopening, with the full actual local path and no literal square brackets. Provider staging or schema errors must be investigated from sanitized live logs; never weaken schema validation or retry an unknown write blindly.

Deployment verification: repository, installed package, MCP handshake and cached manifest report 2.0.5 with 14 tools. The frozen dependency install and bundled-Bun startup passed. Installed PNG and cached icon data were compared with the canonical asset and matched. Credentials and unrelated integration settings were preserved.
