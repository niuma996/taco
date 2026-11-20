# Worktree D6 Design

**Goal:** Make managed worktree mutations safe across Taco processes, reconcile stale ownership metadata on repository access, and provide an explicit conservative cleanup RPC.

## Scope

D5 review found no correctness defect requiring a repair commit. The desktop already displays Git changes in the file tree, refreshes Git status every ten seconds, and invalidates worktree queries after a mutation. D6 therefore stays on the sidecar and protocol boundary; it does not add a second desktop cleanup flow.

The managed root remains `<projectRoot>/.taco/worktrees`. A repository is only considered for reconciliation when a caller asks for its worktree inventory or cleanup. Taco never scans arbitrary folders at startup and never deletes an unowned or orphaned checkout.

## Mutation coordination

The existing process-local promise chain remains the fast path. Each queued create, remove, metadata repair, or cleanup operation also acquires a lock directory beside the repository's shared Git metadata. The lock contains an owner token, PID, and renewable lease. Acquisition retries on contention, reclaims only an expired or dead owner, and fails with a bounded domain error. Release verifies the owner token before removing the lock.

All metadata changes performed by the service happen inside this same repository mutation boundary. A crashed operation leaves either a persisted `removing` record or an expired lock; the next explicit remove or cleanup call can retry the persisted operation.

## Reconciliation and orphan handling

Reconciliation compares the strict Taco metadata index with the current Git worktree inventory and validates repository and Git directory identities.

- A matching live record remains managed.
- A record whose checkout or Git admin identity disappeared or changed becomes `orphaned` and remains history-only.
- A persisted `removing` record whose checkout and Git admin directory are both gone is finalized as `removed`.
- A live checkout under the managed root without matching Taco metadata is reported as orphaned.
- Reconciliation never invokes Git removal and never claims an unrelated path.

Orphaned records retain provenance for passive history lookup but cannot be removed through Taco or used for execution. A later explicit create may reuse a missing orphaned path only after Git's own branch and directory checks succeed.

## Cleanup policy

`worktree.cleanup` is an explicit command. Destructive automatic cleanup remains disabled. The command uses defaults of fourteen days and fifteen retained managed worktrees; callers may provide positive `maxAgeDays` and `maxCount` values. A worktree is a candidate when it is managed, live, unlocked, non-prunable, clean, inactive, and older than the age limit or outside the newest retained count.

Cleanup calls the existing ownership, activity, dirty-file, and identity checks for each candidate. It preserves Git branches and all Taco history, memory, checkpoints, and session records. A failed candidate is returned with its reason; persisted `removing` records remain retryable on a later explicit cleanup or remove call.

## Protocol and verification

The protocol minor advances to 2.23 for `worktree.cleanup` and the additive orphan marker. Tests cover lock serialization and stale recovery, metadata reconciliation, replacement and orphan boundaries, cleanup threshold selection, activity and dirty-tree skips, retry after metadata failure, RPC validation, and the unchanged D5 desktop behavior.

