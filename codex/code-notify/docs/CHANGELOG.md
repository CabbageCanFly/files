# Changelog

## v0.5 — 2026-10-17

- Forward current Codex final assistant answer to a Discord Markdown embed, capped and truncated safely. Default ON with CODE_NOTIFY_CODEX_INCLUDE_REPLY=0 opt-out.
- Extract recorded effective reasoning effort and collaboration mode from turn context.
- Polish Discord metric labels, inline-code values, timestamps and reset countdowns.
- Send explicit UTF-8 Discord payloads; log minimal delivery error types without leaking webhook URLs or messages.
- Preserve save-final, notify-toast, hooks configuration and rollback flow; add coverage for metadata, reply isolation, truncation and opt-out.


## v0.4 — 2026-10-17

- Read `resets_at` Unix timestamps from Codex's current per-turn rate-limit snapshots, for the five-hour and weekly windows when present.
- Format a Discord countdown and an exact local date/time (including UTC offset), without guessing missing reset times.
- Label elapsed reset timestamps as stale snapshots rather than claiming the limit has reset.
- Preserve existing hooks, Code-Notify backend, Discord delivery and desktop toast; add 2 regression tests.

## v0.3 — 2026-10-17

- Fixed completion telemetry when Stop fires before the JSONL `task_complete` event is appended.
- Added model, input/output tokens, approximate elapsed time, and conditional 5-hour/weekly usage labels to the Discord output.
- Added safe debug logging of metric availability and read-only local inspector.
- Optional explicit opt-in to send the final answer excerpt to Discord, off by default.
- Preserved desktop toast, output saver, webhook configuration, and existing hook registrations.

# Changelog

## v0.2 — 2026-10-17

- Kept original Windows toast, final saver, and Code-Notify Discord backend in separate hooks.
- Moved per-completion metrics and possible end-of-turn question classification into a universal, short-stdin Codex adapter.
- Added rollback-capable, dry-run-first installer and read-only event-type audit for later interactive question work.
- No changes to private webhook config or actual Codex session history.

## v0.1 — prior planning-only kit

- Token-metric parser prototype and maintenance plan; no installer.
