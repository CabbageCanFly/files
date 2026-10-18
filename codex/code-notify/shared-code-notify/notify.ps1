# Code-Notify notification script
# Called by Claude Code, Codex, and Gemini hooks

param(
    [Parameter(Position=0)]
    [string]$HookType = "notification",

    [Parameter(Position=1)]
    [string]$ToolName = "claude",

    [Parameter(Position=2)]
    [string]$ProjectName = ""
)

$ClaudeHome = "$env:USERPROFILE\.claude"
$VoiceFile = "$ClaudeHome\notifications\voice-enabled"
$LogFile = "$ClaudeHome\logs\notifications.log"
$CodeNotifyConfigDir = "$env:USERPROFILE\.config\code-notify"
$ChannelsFile = "$CodeNotifyConfigDir\channels.json"

# Read hook data from stdin (Claude Code passes JSON with hook context)
$HookData = ""
try {
    if ([Console]::IsInputRedirected) {
        [Console]::InputEncoding = [System.Text.Encoding]::UTF8
        $HookData = [Console]::In.ReadToEnd()
    }
} catch {
    $HookData = ""
}

function Get-JsonStringValue {
    param(
        [string]$Json,
        [string]$Key
    )

    if (-not $Json) {
        return ""
    }

    try {
        $parsed = $Json | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return ""
    }

    $value = $parsed.PSObject.Properties[$Key].Value
    if ($value -is [string]) {
        return $value
    }

    return ""
}

function Get-CodexHookType {
    param([string]$Payload)

    $payloadType = (Get-JsonStringValue -Json $Payload -Key "type").ToLowerInvariant()

    if ($payloadType -eq "agent-turn-complete") {
        return "stop"
    }

    if ($payloadType -match 'request_permissions|permission|approval|elicitation|prompt') {
        return "notification"
    }

    if ($payloadType -match 'error|failed') {
        return "error"
    }

    if ($Payload -match 'last-assistant-message') {
        return "stop"
    }

    if ($Payload -match 'request_permissions|approval|permission') {
        return "notification"
    }

    return "stop"
}

function Get-CodexProjectName {
    param([string]$Payload)

    $payloadCwd = Get-JsonStringValue -Json $Payload -Key "cwd"
    if ($payloadCwd) {
        return Split-Path $payloadCwd -Leaf
    }

    return Split-Path (Get-Location) -Leaf
}

if ($HookType -eq "codex") {
    $ToolName = "codex"
    $HookData = $ProjectName
    $HookType = Get-CodexHookType -Payload $HookData
    $ProjectName = Get-CodexProjectName -Payload $HookData
}

function Get-ToolDisplayName {
    param([string]$Tool = "claude")

    switch ($Tool.ToLower()) {
        "codex" { return "Codex" }
        "gemini" { return "Gemini" }
        default { return "Claude Code" }
    }
}

$ToolDisplay = Get-ToolDisplayName $ToolName

$NotificationStateDir = "$ClaudeHome\notifications\state"
$UsageConfigFile = Join-Path $env:USERPROFILE ".config\code-notify\usage.json"

try {
    if ($env:CODE_NOTIFY_STOP_RATE_LIMIT_SECONDS) { $StopRateLimitSeconds = [int]$env:CODE_NOTIFY_STOP_RATE_LIMIT_SECONDS } else { $StopRateLimitSeconds = 10 }
} catch {
    $StopRateLimitSeconds = 10
}

try {
    $NotificationRateLimitSeconds = [int]($env:CODE_NOTIFY_NOTIFICATION_RATE_LIMIT_SECONDS)
} catch {
    $NotificationRateLimitSeconds = 180
}

function Get-ProjectNameForNotification {
    if ($ProjectName) {
        return $ProjectName
    }

    $gitRoot = $null
    try {
        $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        if ($gitCmd) {
            $gitRoot = & git rev-parse --show-toplevel 2>$null
            if ($LASTEXITCODE -ne 0) {
                $gitRoot = $null
            }
        }
    } catch {
        $gitRoot = $null
    }

    if ($gitRoot) {
        return Split-Path $gitRoot -Leaf
    }

    return Split-Path (Get-Location) -Leaf
}

function Get-NotificationSubtype {
    if ($ToolName -eq 'codex' -and $HookData -match 'codex-input-question') {
        $thread = Get-JsonStringValue -Json $HookData -Key 'thread-id'
        $turn = Get-JsonStringValue -Json $HookData -Key 'turn-id'
        if ($thread -and $turn) { return "question_${thread}_${turn}" }
        return 'question'
    }
    if ($HookData -match 'idle_prompt') {
        return "idle_prompt"
    }

    if ($HookData -match 'permission_prompt|request_permissions|sandbox_approval') {
        return "permission_prompt"
    }

    if ($HookData -match 'auth_success') {
        return "auth_success"
    }

    if ($HookData -match 'elicitation_dialog|mcp_elicitations') {
        return "elicitation_dialog"
    }

    return "notification"
}

function Get-UsageResetAlertConfigLocal {
    $defaults = [pscustomobject]@{ enabled = $true; voice = $true; sound = $true; sound_file = "" }
    if (-not (Test-Path $UsageConfigFile)) {
        return $defaults
    }

    try {
        $config = Get-Content $UsageConfigFile -Raw | ConvertFrom-Json
        if ($config.reset_alerts) {
            foreach ($name in @("enabled", "voice", "sound", "sound_file")) {
                if ($null -eq $config.reset_alerts.$name) {
                    $config.reset_alerts | Add-Member -NotePropertyName $name -NotePropertyValue $defaults.$name -Force
                }
            }
            return $config.reset_alerts
        }
    } catch {
    }

    return $defaults
}

function Get-RateLimitPath {
    param([string]$Key)

    $safeKey = ($Key -replace '[^A-Za-z0-9._-]', '_')
    return Join-Path $NotificationStateDir $safeKey
}

function Get-LegacyRateLimitPath {
    param([string]$Key)

    $safeKey = ($Key -replace '[^A-Za-z0-9._-]', '_')
    return Join-Path "$ClaudeHome\notifications" $safeKey
}

function Test-RateLimited {
    param(
        [string]$Key,
        [int]$WindowSeconds
    )

    if ($WindowSeconds -le 0) {
        return $false
    }

    $path = Get-RateLimitPath $Key
    if (-not (Test-Path $path)) {
        $legacyPath = Get-LegacyRateLimitPath $Key
        if (Test-Path $legacyPath) {
            $path = $legacyPath
        }
    }

    if (-not (Test-Path $path)) {
        return $false
    }

    try {
        $lastTime = [long]((Get-Content $path -Raw -ErrorAction Stop).Trim())
    } catch {
        return $false
    }

    $currentTime = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    return (($currentTime - $lastTime) -lt $WindowSeconds)
}

function Update-RateLimit {
    param([string]$Key)

    if (-not (Test-Path $NotificationStateDir)) {
        New-Item -ItemType Directory -Path $NotificationStateDir -Force | Out-Null
    }

    $currentTime = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $path = Get-RateLimitPath $Key
    $currentTime | Set-Content $path -Encoding ASCII

    $legacyPath = Get-LegacyRateLimitPath $Key
    if ($legacyPath -ne $path -and (Test-Path $legacyPath)) {
        Remove-Item $legacyPath -Force -ErrorAction SilentlyContinue
    }
}

# CODE-NOTIFY CODEX DEDUPE V2
# Use a separate 4-second dedupe key for each Codex thread + turn.
# This leaves the cooldown for Claude and other tools unchanged.
$StopRateLimitKey = "last_stop_notification"
if ($ToolName -eq "codex" -and $HookType -eq "stop") {
    $StopRateLimitSeconds = 4
    $codexThread = Get-JsonStringValue -Json $HookData -Key "thread-id"
    $codexTurn = Get-JsonStringValue -Json $HookData -Key "turn-id"

    if ($codexThread -and $codexTurn) {
        $StopRateLimitKey = "last_stop_codex_${codexThread}_${codexTurn}"
    } elseif ($codexThread) {
        $StopRateLimitKey = "last_stop_codex_${codexThread}"
    } else {
        # No IDs available: isolate the fallback cooldown by project.
        $StopRateLimitKey = "last_stop_codex_$ProjectName"
    }

    # If Codex reports a generic 'workdir' path, try the original
    # workspace recorded in that Codex thread's local rollout metadata.
    # If no reliable metadata is available, leave the name unchanged.
    if ($ProjectName -eq "workdir" -and $codexThread -match '^[0-9a-fA-F-]{32,36}$') {
        try {
            $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
            $sessionFolder = Join-Path $codexHome 'sessions'
            if (Test-Path -LiteralPath $sessionFolder -PathType Container) {
                $rollouts = @(Get-ChildItem -LiteralPath $sessionFolder -Recurse -File -Filter "rollout-*$codexThread*.jsonl" -ErrorAction SilentlyContinue | Select-Object -First 3)
                foreach ($rollout in $rollouts) {
                    $firstLine = Get-Content -LiteralPath $rollout.FullName -TotalCount 1 -ErrorAction Stop
                    $metadata = $firstLine | ConvertFrom-Json -ErrorAction Stop
                    if ($metadata.type -ne 'session_meta' -or -not $metadata.payload.cwd) { continue }
                    $rawCwd = [string]$metadata.payload.cwd
                    $candidate = Split-Path -Path ($rawCwd.TrimEnd('\', '/')) -Leaf
                    if ($candidate -and $candidate -ne 'workdir') {
                        $ProjectName = $candidate
                        break
                    }
                }
            }
        } catch {
            # Project metadata may be missing or unavailable; notifications still work.
        }
    }
}
# Function to check if notification should be suppressed
function Test-ShouldSuppressNotification {
    # Skip suppression checks for test notifications
    if ($HookType -eq "test") {
        return $false
    }

    if ($HookType -eq "stop" -and (Test-RateLimited -Key $StopRateLimitKey -WindowSeconds $StopRateLimitSeconds)) {
        return $true
    }

    if ($HookType -eq "notification") {
        $notificationKey = "last_notification_{0}_{1}_{2}" -f $ToolName, (Get-ProjectNameForNotification), (Get-NotificationSubtype)
        $window = $NotificationRateLimitSeconds
        if ($ToolName -eq 'codex' -and $HookData -match 'codex-input-question') { $window = 4 }
        if (Test-RateLimited -Key $notificationKey -WindowSeconds $window) {
            return $true
        }
    }

    # For Stop hooks: Check if stop_hook_active is true
    # This means Claude is still working (continuing from a previous stop hook)
    # We should only notify when Claude has truly finished
    if ($HookType -eq "stop" -and $HookData) {
        if ($HookData -match '"stop_hook_active"\s*:\s*true') {
            return $true  # Suppress - Claude is still working
        }
    }

    # Check for auto-accept environment variable (Issue #7)
    if ($env:CLAUDE_AUTO_ACCEPT -eq "true") {
        return $true
    }

    # Check if hook data indicates auto-acceptance
    if ($HookData -and $HookData -match '"autoAccepted"\s*:\s*true') {
        return $true
    }

    return $false
}

# Check if notification should be suppressed
if ($HookType -eq "stop" -or $HookType -eq "notification") {
    if (Test-ShouldSuppressNotification) {
        exit 0  # Skip this notification
    }
}

if ($HookType -eq "stop") {
    Update-RateLimit -Key $StopRateLimitKey
} elseif ($HookType -eq "notification") {
    Update-RateLimit -Key ("last_notification_{0}_{1}_{2}" -f $ToolName, (Get-ProjectNameForNotification), (Get-NotificationSubtype))
}

if (-not $ProjectName) {
    $ProjectName = Get-ProjectNameForNotification
}

# Set notification content based on hook type
switch ($HookType.ToLower()) {
    "stop" {
        $Title = "$ToolDisplay - Task Complete"
        $Message = "$ToolDisplay completed the task in $ProjectName"
        $VoiceMessage = "$ToolDisplay completed the task in $ProjectName"
    }
    "notification" {
        $Title = "$ToolDisplay - Input Required"
        $Message = "$ToolDisplay needs your input in $ProjectName"
        $VoiceMessage = "$ToolDisplay needs your input in $ProjectName"
    }
    "pretooluse" {
        $Title = "$ToolDisplay - Command Approval"
        $Message = "$ToolDisplay wants to run a command in $ProjectName"
        $VoiceMessage = "$ToolDisplay wants to run a command in $ProjectName"
    }
    "error" {
        $Title = "$ToolDisplay - Error"
        $Message = "An error occurred in $ProjectName"
        $VoiceMessage = "An error occurred in $ProjectName"
    }
    "test" {
        $Title = "Code-Notify Test"
        $Message = "Notifications are working correctly!"
        $VoiceMessage = "Test notification successful"
    }
    "usage" {
        $Title = if ($env:CODE_NOTIFY_USAGE_TITLE) { $env:CODE_NOTIFY_USAGE_TITLE } else { "$ToolDisplay usage alert" }
        $Message = if ($env:CODE_NOTIFY_USAGE_MESSAGE) { $env:CODE_NOTIFY_USAGE_MESSAGE } else { "$ToolDisplay usage changed" }
        $VoiceMessage = if ($env:CODE_NOTIFY_USAGE_VOICE_MESSAGE) { $env:CODE_NOTIFY_USAGE_VOICE_MESSAGE } else { "$ToolDisplay usage alert" }
    }
    "usage_reset" {
        $Title = if ($env:CODE_NOTIFY_USAGE_TITLE) { $env:CODE_NOTIFY_USAGE_TITLE } else { "$ToolDisplay token limit reset" }
        $Message = if ($env:CODE_NOTIFY_USAGE_MESSAGE) { $env:CODE_NOTIFY_USAGE_MESSAGE } else { "$ToolDisplay tokens have reset. Usage is back to 100%." }
        $VoiceMessage = if ($env:CODE_NOTIFY_USAGE_VOICE_MESSAGE) { $env:CODE_NOTIFY_USAGE_VOICE_MESSAGE } else { "$ToolDisplay token limit reset" }
    }
    default {
        $Title = $ToolDisplay
        $Message = "Status update: $HookType"
        $VoiceMessage = "Status update from $ProjectName"
    }
}

# Get the terminal process to activate on notification click
function Get-TerminalProcess {
    # Try to find the parent terminal process
    $terminalApps = @("WindowsTerminal", "powershell", "pwsh", "cmd", "Code")

    foreach ($app in $terminalApps) {
        $proc = Get-Process -Name $app -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc) {
            return $proc.MainWindowHandle
        }
    }
    return $null
}

# Bring window to foreground
function Set-WindowForeground {
    param([IntPtr]$WindowHandle)

    if ($WindowHandle -eq [IntPtr]::Zero) { return }

    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class WindowHelper {
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
    [WindowHelper]::ShowWindow($WindowHandle, 9) | Out-Null  # SW_RESTORE
    [WindowHelper]::SetForegroundWindow($WindowHandle) | Out-Null
}

# Send desktop notification
function Send-DesktopNotification {
    # Store terminal handle for activation
    $terminalHandle = Get-TerminalProcess

    # Try BurntToast first
    if (Get-Module -ListAvailable -Name BurntToast) {
        Import-Module BurntToast -ErrorAction SilentlyContinue

        # Create activation script - closure variables won't work with BurntToast
        # Use a global variable approach instead
        $global:ClaudeNotify_TerminalHandle = $terminalHandle
        $activateScript = {
            if ($global:ClaudeNotify_TerminalHandle -and $global:ClaudeNotify_TerminalHandle -ne [IntPtr]::Zero) {
                Set-WindowForeground -WindowHandle $global:ClaudeNotify_TerminalHandle
            }
        }

        $toastParams = @{
            Text = $Title, $Message
            ErrorAction = 'SilentlyContinue'
        }
        $burntToastCommand = Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue
        if ($burntToastCommand -and $burntToastCommand.Parameters.ContainsKey('Silent')) {
            $toastParams['Silent'] = $true
        }

        # Add activation if we have a terminal handle
        if ($terminalHandle) {
            $toastParams['ActivatedAction'] = $activateScript
        }

        New-BurntToastNotification @toastParams
        return
    }

    # Fallback to native Windows toast.
    # Foreground activation requires extra registration that a standalone script does not provide,
    # so keep the WinRT path simple and reliable here.
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

        $template = @"
<toast>
    <visual>
        <binding template="ToastText02">
            <text id="1">$Title</text>
            <text id="2">$Message</text>
        </binding>
    </visual>
    <audio silent="true"/>
</toast>
"@
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($template)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Code-Notify").Show($toast)
    }
    catch {
        # Final fallback - balloon notification (no click activation support)
        Add-Type -AssemblyName System.Windows.Forms
        $notification = New-Object System.Windows.Forms.NotifyIcon
        $notification.Icon = [System.Drawing.SystemIcons]::Information
        $notification.BalloonTipIcon = "Info"
        $notification.BalloonTipTitle = $Title
        $notification.BalloonTipText = $Message
        $notification.Visible = $true
        $notification.ShowBalloonTip(10000)
        Start-Sleep -Milliseconds 500
        $notification.Dispose()
    }
}

# Send voice notification if enabled
function Send-VoiceNotificationLocal {
    if ($HookType -eq "usage_reset") {
        $resetConfig = Get-UsageResetAlertConfigLocal
        if (-not $resetConfig.enabled -or -not $resetConfig.voice) { return }
    }

    # Check for project-specific voice first
    $projectRoot = $null
    try {
        $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        if ($gitCmd) {
            $projectRoot = & git rev-parse --show-toplevel 2>$null
            if ($LASTEXITCODE -ne 0) {
                $projectRoot = $null
            }
        }
    } catch {
        $projectRoot = $null
    }

    if ($projectRoot) {
        $projectVoice = Join-Path $projectRoot ".claude\voice"
        if (Test-Path $projectVoice) {
            $VoiceFile = $projectVoice
        }
    }

    $voice = $null
    if (Test-Path $VoiceFile) {
        $voice = Get-Content $VoiceFile -ErrorAction SilentlyContinue
    } elseif ($HookType -eq "usage_reset") {
        $voice = "Microsoft David Desktop"
    }

    if ($voice) {
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

        try {
            $synth.SelectVoice($voice)
        } catch {
            # Use default voice
        }

        $synth.SpeakAsync($VoiceMessage) | Out-Null
    }
}

# Send sound notification if enabled
function Send-SoundNotificationLocal {
    $SoundEnabledFile = "$ClaudeHome\notifications\sound-enabled"
    $SoundCustomFile = "$ClaudeHome\notifications\sound-custom"
    $DefaultSoundFile = "C:\Windows\Media\chimes.wav"
    $UsageResetSoundFile = "C:\Windows\Media\tada.wav"

    if ($HookType -eq "usage_reset") {
        $resetConfig = Get-UsageResetAlertConfigLocal
        if (-not $resetConfig.enabled -or -not $resetConfig.sound) { return }
        if ($resetConfig.sound_file) {
            $soundFile = $resetConfig.sound_file
        } else {
            $soundFile = $UsageResetSoundFile
        }
    } else {
        if (-not (Test-Path $SoundEnabledFile)) { return }

        $soundFile = $DefaultSoundFile
        if (Test-Path $SoundCustomFile) {
            $soundFile = Get-Content $SoundCustomFile -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-Path $soundFile)) { return }

    try {
        $player = New-Object System.Media.SoundPlayer
        $player.SoundLocation = $soundFile
        # Keep the process alive until playback starts and completes.
        $player.PlaySync()
    } catch {
        # Silently fail if sound cannot be played
    }
}

function Send-ChannelDeliveryLocal {
    if (-not (Test-Path $ChannelsFile)) {
        return
    }

    try {
        $config = Get-Content $ChannelsFile -Raw | ConvertFrom-Json
    } catch {
        return
    }

    if (-not $config.enabled) {
        return
    }

    foreach ($channel in @($config.channels)) {
        try {
            $text = $Title
            if ($Message) { $text = "$text`n$Message" }
            if ($ProjectName) { $text = "$text`nProject: $ProjectName" }
            # CODE-NOTIFY COMPACT CODEX CHANNEL MESSAGE V0.5
            # Codex metrics are formatted here; the final answer (when enabled)
            # is delivered separately as a Discord Markdown embed below.
            if ($ToolName -eq 'codex' -and ($HookType -eq 'stop' -or $HookType -eq 'notification')) {
                # Optional telemetry and final assistant text arrive on stdin
                # from the Codex Stop adapter. Do not send entire transcripts.
                $codexData = $null
                try { $codexData = $HookData | ConvertFrom-Json -ErrorAction Stop } catch { }
                $kind = [string]$codexData.codex_notify.kind
                $now = [DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz')
                $text = "⋄ ──────────────────────────"
                if ($kind -eq 'possible_question') {
                    $text += "`n**Codex may need your reply**`n**Project:** ``$ProjectName```n**Time:** ``$now``"
                } elseif ($HookType -eq 'stop') {
                    $text += "`n**Codex task completed**`n**Project:** ``$ProjectName```n**Time:** ``$now``"
                }
                $stats = $codexData.codex_notify.metrics
                $details = @()
                if ($null -ne $stats) {
                    if ($null -ne $stats.duration_seconds) {
                        $seconds = [int]$stats.duration_seconds
                        if ($seconds -ge 0) {
                            $minutes = [math]::Floor($seconds / 60)
                            $remainder = $seconds % 60
                            $prefix = if ($stats.duration_approximate) { '~' } else { '' }
                            $details += ("`n" + ('**Duration:** `{0}{1}m {2:D2}s`' -f $prefix, $minutes, [int]$remainder))
                        }
                    }
                    if ($stats.model) {
                        $details += ('**Model:** `{0}`' -f [string]$stats.model)
                    }
                    if ($stats.reasoning_effort) { $details += ('**Effort:** `{0}`' -f [string]$stats.reasoning_effort) }
                    if ($stats.mode) { $details += ('**Mode:** `{0}`' -f [string]$stats.mode) }
                    
                    $t = $stats.turn_tokens
                    if ($null -ne $t) {
                        if ($null -ne $t.input_tokens -and $null -ne $t.output_tokens) {
                            $details += ("`n" + ('**This turn:** `{0:N0}` in / `{1:N0}` out' -f [long]$t.input_tokens, [long]$t.output_tokens))
                        } elseif ($null -ne $t.total_tokens) {
                            $details += ("`n" + ('**This turn:** `{0:N0}` tokens' -f [long]$t.total_tokens))
                        }
                    }
                    if ($null -ne $stats.context_percent_approx) {
                        $details += ('**Context (approx.):** `{0:N1}% used`' -f [double]$stats.context_percent_approx)
                    }
                    $limits = $stats.rate_limit_used_percent
                    $windows = $stats.rate_limit_window_minutes
                    $resets = $stats.rate_limit_resets_at
                    foreach ($field in @('primary', 'secondary')) {
                        if ($null -eq $limits -or $null -eq $limits.$field) { continue }
                        $windowMins = if ($null -ne $windows) { $windows.$field } else { $null }
                        $label = if ($null -ne $windowMins -and [int]$windowMins -eq 300) { '5-hour limit' } elseif ($null -ne $windowMins -and [int]$windowMins -eq 10080) { 'Weekly limit' } else { "$field limit" }
                        $details += ("`n" + ('**{0}:** `{1:N1}% left`' -f $label, (100.0 - [double]$limits.$field)))
                        # Display the server-reported absolute reset instant in the
                        # machine's local timezone; countdown is as of send time.
                        # Do not guess a reset if Codex omitted resets_at.
                        $resetEpoch = if ($null -ne $resets) { $resets.$field } else { $null }
                        if ($null -ne $resetEpoch) {
                            try {
                                $resetSeconds = [long]$resetEpoch
                                if ($resetSeconds -ge 1577836800 -and $resetSeconds -lt 4102444800) {
                                    $resetLocal = [DateTimeOffset]::FromUnixTimeSeconds($resetSeconds).ToLocalTime()
                                    $resetDateText = $resetLocal.ToString('yyyy-MM-dd h:mm:ss tt zzz', [Globalization.CultureInfo]::InvariantCulture)
                                    $nowUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
                                    $secondsLeft = $resetSeconds - $nowUnix
                                    if ($secondsLeft -gt 0) {
                                        $minutesLeft = [long][math]::Ceiling($secondsLeft / 60.0)
                                        $daysLeft = [long][math]::Floor($minutesLeft / 1440)
                                        $hoursLeft = [long][math]::Floor(($minutesLeft % 1440) / 60)
                                        $minsLeft = [long]($minutesLeft % 60)
                                        $parts = @()
                                        if ($daysLeft -gt 0) { $parts += ('{0}d' -f $daysLeft) }
                                        if ($hoursLeft -gt 0) { $parts += ('{0}h' -f $hoursLeft) }
                                        if ($minsLeft -gt 0 -or $parts.Count -eq 0) { $parts += ('{0}m' -f $minsLeft) }
                                        $details += (">Resets in ``{0}`` `n>``{1}`` (local)" -f ($parts -join ' '), $resetDateText)
                                    } else {
                                        # This is an old snapshot; do not imply new quota
                                        # is already available without an updated observation.
                                        $details += ('>Last reported reset `{0}` (snapshot may be stale)' -f $resetDateText)
                                    }
                                }
                            } catch { } # Reset display is optional; keep Discord delivery working.
                        }
                    }
                    if ($stats.reply_excerpt) {
                        $details += ('**Reply excerpt:** {0}' -f [string]$stats.reply_excerpt)
                    }
                }
                if ($details.Count -gt 0) {
                    $text += "`n" + ($details -join "`n")
                } else {
                    $text += "`nUsage details not available for this turn"
                }

            }
            $text += "`n⋄ ──────────────────────────"

            if ($channel.provider -eq "discord") {
                # Codex's final answer stays in its own Markdown-capable embed;
                # unlike a giant code block, this renders lists and fenced code.
                $message = @{ content = $text; allowed_mentions = @{ parse = @() } }
                <# 
                if ($ToolName -eq 'codex' -and ($HookType -eq 'stop' -or $HookType -eq 'notification')) {
                    $reply = [string]$codexData.codex_notify.final_reply
                    if ($reply) {
                        # Discord embed descriptions are capped at 4096 chars.
                        # The stdin adapter pre-truncates at 3750 for headroom.
                        $reply = if ($reply.Length -le 3950) { $reply } else { $reply.Substring(0, 3900) + "… (truncated)" }
                        $message.embeds = @(@{
                            title = 'Codex final response'
                            description = $reply
                        })
                    }
                }
                #>
                $payload = $message | ConvertTo-Json -Depth 12
            } else {
                $payload = @{ text = $text } | ConvertTo-Json -Depth 10
            }


            # Windows PowerShell 5.1 can mishandle non-ASCII request bodies if
            # string encoding is inferred. Send explicit UTF-8 for Markdown replies.
            $payloadBytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
            Invoke-RestMethod -Uri $channel.url -Method Post -Body $payloadBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 5 | Out-Null
        } catch {
            # Do not include webhook URLs or message text in diagnostic logs.
            if ($ToolName -eq 'codex') {
                try {
                    $deliveryLog = Join-Path $CodeNotifyConfigDir 'delivery-errors.log'
                    $errorKind = $_.Exception.GetType().Name
                    Add-Content -LiteralPath $deliveryLog -Value ("{0} provider={1} error={2}" -f (Get-Date -Format 'o'), $channel.provider, $errorKind) -ErrorAction SilentlyContinue
                } catch { }
            }
        }
    }
}

# Log notification
function Write-NotificationLog {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$ToolName] [$ProjectName] $Title - $Message"

    $logDir = Split-Path $LogFile -Parent
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    Add-Content -Path $LogFile -Value $logEntry -ErrorAction SilentlyContinue
}

# Execute
# Send-DesktopNotification
# Send-VoiceNotificationLocal
# Send-SoundNotificationLocal
Send-ChannelDeliveryLocal
Write-NotificationLog

exit 0

