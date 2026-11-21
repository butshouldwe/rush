# Change Log - @butshouldwe/worktree-rush

This log was last generated on Sat, 21 Nov 2026 00:13:23 GMT and should not be manually modified.

## 0.2.0
Sat, 21 Nov 2026 00:13:23 GMT

### Minor changes

- Safely recognize squash-merged branches during proof-bearing worktree removal.
- Add creation-only --start-point support with local commit validation.

### Patches

- Prepare public npm metadata and configurable registry routing.
- Require npm package names for filtered installs and double embedded quotes in the Windows shell fallback.
- Authenticate linked-worktree registrations and contain Claude settings copies against symlink redirection.
- Bind removal to the worktree's actual HEAD and delete branches atomically with an expected-old OID.
- Canonicalize removal paths, enforce owned Claude-state locking, and fail touched-file validation safely.

