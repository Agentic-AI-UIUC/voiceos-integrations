# Consolidation comparison

Compared on November 8, 2026.

The former excel/dropbox-work directory and this repository both contained version 2.0.3, build dropbox-composio-v5-live-feedback. Their 16 corresponding editable source, schema and test files were byte-for-byte identical. The portable server was also byte-for-byte identical; manifest differences were formatting/property order, not behavior. Both repair-note documents matched.

The repository source/package.json was intentionally different: it additionally declared esbuild 0.28.2 for the build workflow. Retained that package and its lockfile rather than replacing it with the older development package.

The canonical layout is now:

- Root: portable server, manifest, launchers, icon, preview metadata and runtime package.
- source/: editable source, OAuth setup utility, regression tests and build generators.
- scripts/: root build plus reusable deployment, installed-server verification and cached-manifest repair utilities.

Copied the three reusable utilities from the former directory, corrected their relative paths, and replaced the registry repair utility's hardcoded user path with APPDATA (or an explicit VOICEOS_CONFIG_PATH). Portable release packages omit development-only dependencies.

Excluded one-off registry inspection/copy scripts and ChatOverflow field-note drafts: these are session artifacts, not integration dependencies. Credentials, account-state files, registry backups and node_modules are not source artifacts. The former folder remains untouched as a fallback; further work belongs here.
