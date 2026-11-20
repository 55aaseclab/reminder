# Reminder product requirements

[简体中文](PRD.md)

Manage a checklist with recurring templates, planned tasks, a task pool and execution history. Browse, search, flag items and read estimated and actual hours in the web interface. Authorized clients and the standalone CLI manage records. Preserve date precision, history and concurrent edits when reading and writing schema-v2 data.

## Praxis provider

The app owns a version-1 `praxis-provider.mjs` contract for source-backed workbench cards and data-source metadata. Reads use host-supplied authorized callbacks; the provider has no direct filesystem, credential or network access. Preserve native object links, real revisions or stable content hashes, and distinct empty, partial and unavailable results. Personal card handling never modifies shared records. See [provider contract](PRAXIS-PROVIDER.md).

## App-owned Praxis integration

This app owns its reviewed `praxis-integration.mjs`: native entry policy, typed business operations and MCP guidance where supported. Praxis loads that declaration from the installed source and retains authorization, signing, policy leases and audit. Installation does not grant access or start a backend. Existing native interfaces, data ownership and recovery boundaries remain in force.
