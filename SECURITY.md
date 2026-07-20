# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest 0.x | ✅ |
| older | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use GitHub's private vulnerability reporting: go to the [Security tab](https://github.com/Sertelegger/claude-sesh-mover/security) → **Report a vulnerability**.

This is a personal open-source project, so response times are best-effort — expect an acknowledgment within a week.

## Scope

Reports are especially welcome for the areas where this tool handles untrusted or sensitive input:

- **Archive extraction** (`src/archiver.ts`) — imported `.tar.gz`/`.tar.zst` bundles are untrusted input. Entries with absolute paths, `..` segments, or symlink/hardlink entries are rejected before extraction; bypasses of these checks are security bugs.
- **Path rewriting** (`src/rewriter.ts`) — rewrites must never send session content outside the target config/project directories.
- **Session content** — exported bundles contain full conversation history. Anything that leaks session content to unexpected locations (temp files outside private temp dirs, manifests when `--no-summary` is set, etc.) is in scope.
