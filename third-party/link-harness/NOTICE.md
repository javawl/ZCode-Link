# link-harness 2.0.0 migration

The backlink publishing subsystem, provider contracts, browser command semantics,
and publishing skills in this repository are adapted from
javawl/link-harness tag 2.0.0, commit
3f2de21104493f4c00214a0c1dfc0836b63b6e14.

Original source: https://github.com/javawl/link-harness/tree/2.0.0

Copyright (c) 2026 DeepSeek. Licensed under the MIT License; see [LICENSE](LICENSE).

ZCode integration modifications include replacement of Cordis infrastructure
with native Service/RPC and MCP plugin interfaces, scoped configuration and
browser ownership, runtime validation, packaging, tests, and adapted guidance.

Covered target areas: packages/backlinks, the backlinks-plugin package under
apps/zcode-cli/packages, and backlink settings/console integration in packages/ui.
Source user data, credentials, cookies, and operational histories are excluded.
