# Security Policy

Taco is open-source software released under the MIT license. The
project is developed and maintained for **personal use** — it is
intended to be run on a developer's own machine by a single user. We
take security issues seriously and appreciate coordinated disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Send a private report to `niuma1024@outlook.com`. The report should
include:

- A clear description of the issue and its impact.
- A reproducer (NDJSON transcript, sandbox log, or build hash).
- The version / commit SHA where it was observed.
- Whether you intend to disclose publicly, and on what timeline.

Reporters are credited in the fix commit and CHANGELOG entry unless
they ask to remain anonymous.

## Threat model

Taco is a **personal-use local tool** — the expected deployment is a
single developer running the sidecar and desktop on their own
machine. The threat model is scoped to that:

- **Local shell / FS access.** `NodeExecutionEnv` runs shell and FS
  tools directly on the host; any sidecar user can reach any file the
  process can. The same physical-user trust boundary already covers
  the host terminal, so this is acceptable for personal use but is
  not a substitute for proper isolation in any shared / multi-tenant
  environment.
- **MCP tools are not gated** by the permission broker — adding a
  server in `taco.json` is implicit authorization for every tool it
  exposes. Vet MCP servers before adding them.
- **API keys** live in `$TACO_HOME/taco.json` (`0600`) and are also
  held in plaintext in sidecar memory and mirrored into `process.env`
  for subprocesses. Treat `taco.json` like any credentials file.
- **IM channel credentials** live in `$TACO_HOME/channels/<id>.json`
  (`0600`), separate from `taco.json`.
- **Network exposure.** v0.1.0 transport is stdio NDJSON only;
  Tauri uses localhost IPC, not a network port.

## Out of scope

- Bugs in upstream dependencies (`@earendil-works/pi-agent-core`,
  `@earendil-works/pi-ai`, `@modelcontextprotocol/sdk`) — report to
  those projects.
- Issues in third-party agent / skill / extension frontmatter the
  user has explicitly added.