# Code-Notify + Codex v0.5 — final reply and Discord formatting

A versioned, reversible upgrade for the existing Windows Codex → Code-Notify → Discord integration. This builds on the user's **working v0.4 installation**, not an alternative notification setup.

**Not installed on your PC by this package.** The Node code has local tests; native Windows PowerShell / Discord delivery still needs one real test after installation.

## What changes in v0.5

1. **Final Codex response in Discord:** The `Stop` hook forwards only the **final assistant reply**—from `last_assistant_message` in the hook payload if available, otherwise from the current turn's final `response_item` in the rollout. The response is shown **below the metrics**, in a separate Discord embed. Discord renders the response's original Markdown, including bullet lists and fenced code blocks. It is **not** wrapped in an extra code fence.
2. **Reasoning effort and mode:** Reads the effective `turn_context.effort` (fallback `collaboration_mode.settings.reasoning_effort`) and `turn_context.collaboration_mode.mode`. When present, displays labels such as `Effort: high` and `Mode: plan` or `default`. These represent the **recorded effective settings for the turn**, not assumed defaults; missing fields are omitted. A turn may be in default mode even if its final answer describes a plan.
3. **Cleaner formatting:** Bold metric labels, inline backticks for project, timestamp and values, line breaks for reset details, and separate Markdown response section. Existing per-turn tokens, context estimate, limit percentages and reset timestamps are preserved.
4. **Bounds and safety:** Discord embed description limited to **3750 UTF-16 units** (under Discord's 4096 maximum). Long replies are truncated with a visible note; if truncation falls inside a fenced code block, the helper attempts to close it. No turn transcript, user prompt, reasoning trace or tool outputs are forwarded—only the final assistant answer, which may itself summarize such content. Mentions remain disabled via `allowed_mentions`.
5. **UTF-8 delivery:** The shared PowerShell backend sends explicit UTF-8 JSON bytes. If a Codex channel delivery fails, a minimal `~/.config/code-notify/delivery-errors.log` entry records only provider and error type, *not* the webhook URL or reply.

### Privacy and opt-out

**Important change:** Installing v0.5 **opts in to sending the final assistant answer to your configured Discord webhook by default**. Earlier versions kept that text private. A final answer can contain sensitive paths, code, credentials, project details, etc.; enable this only for Discord channels you trust. **The output is forwarded to every enabled Discord channel in your existing `channels.json`.** Never include a credential in a project answer you intend to forward.

To disable it for a Codex process: set `CODE_NOTIFY_CODEX_INCLUDE_REPLY=0` **before launching Codex**. For example:

```powershell
$env:CODE_NOTIFY_CODEX_INCLUDE_REPLY = '0'
codex resume
```

To undo this override in that PowerShell session: `Remove-Item Env:CODE_NOTIFY_CODEX_INCLUDE_REPLY`. The normal metrics still arrive when the reply is disabled. For permanent preference changes, set a user environment variable and restart terminal / Codex.

The optional older `CODE_NOTIFY_CODEX_INCLUDE_SUMMARY=1` excerpt setting is only relevant if full replies have been disabled.

### No changes to desktop toast or hooks

This package **does not touch** the `notify-toast.py` desktop notification, `save-final.py` output-saving hook, `~/.codex/hooks.json`, `~/.codex/config.toml`, Discord credentials, or existing session transcripts. It only replaces these three scripts:

- `~/.codex/hooks/code-notify-stop.js`
- `~/.codex/hooks/codex-rollout.js`
- `~/.claude/notifications/notify.ps1`

For Discord payloads, the shared `notify.ps1` still handles delivery. Changes to its Codex formatting are isolated from Claude and Gemini notifications.

## Install / rollback (unchanged from v0.4)

1. Extract the ZIP, open PowerShell in the extracted `code-notify-upgrade-v0.5` folder, and close currently running Codex sessions before applying changes.
2. **Preview only:**

   ```powershell
   .\install.ps1
   ```

3. **Apply with automatic dated backup:**

   ```powershell
   .\install.ps1 -Apply
   ```

4. Start Codex normally; finish one small test task. Confirm your original desktop toast works, Discord shows the metrics and embeds the final reply, and `save-final.py` still writes your output.
5. If anything breaks, close Codex and run the rollback command printed by the installer, such as:

   ```powershell
   .\rollback.ps1 -BackupDirectory 'C:\Users\James\.codex\notification-backups\YYYYMMDD-HHMMSS' -Apply
   ```

   Replace the example path with the **actual path printed by your installer**.

### Testing without Codex tokens or a Discord message

Run the local Node synthetic test suite:

```powershell
node tools/test-notification.js
```

Inspect your most recent saved MapleStory session's recorded **metrics only**:

```powershell
node tools/inspect-metrics.js 01a145c6-b117-7533-84e4-ae01bf98ea0a
```

You can use the latter before installing to verify whether the session recorded `reasoning_effort` and `mode`. It does not print your actual final reply.

After a real turn, if no embed appears, the adapter log includes `reply_chars=` without printing the reply:

```powershell
Get-Content "$HOME\.config\code-notify\codex-stop.log" -Tail 5
```

`reply_chars=0` means the hook did not obtain a final reply, or forwarding was disabled. If nonzero and Discord has no embed, check:

```powershell
Get-Content "$HOME\.config\code-notify\delivery-errors.log" -Tail 5
```

The error log exists only after a reported delivery error. This is best-effort: not every webhook failure is necessarily observable, and a successful local process exit does not prove the Discord service accepted the message.

## Scope of question detection

End-of-turn question detection is the same conservative heuristic as v0.4. Interactive `request_user_input` questions that suspend Codex *before* `Stop` fires are **not** handled by this release. `tools/audit-question-events.js` remains read-only for future investigation.

## Maintenance and backup

Store the **source files** in your existing GitHub repository with normal Git history, and keep older ZIPs as releases (`v0.4` was your last working release). Don't commit `channels.json`, full Codex rollout histories, or unredacted webhooks. This ZIP contains no Discord credential configuration.

## Caveats

- All usage values and reset instants depend on snapshots Codex actually writes. Context is approximate; quota percentages are not remaining token balances.
- Discord embeds have message-size limits. Long final replies are visibly truncated, not split into many notifications; view the full answer in Codex or your existing final-output file.
- Synthetic tests don't execute Windows PowerShell or deliver to Discord. The first real notification validates that portion.
