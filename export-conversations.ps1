$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$archiveName = "conversation-records-archive-$timestamp"
$archiveRoot = Join-Path $projectRoot $archiveName
$zipPath = "$archiveRoot.zip"

function Copy-IfExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (Test-Path -LiteralPath $Source) {
        $parent = Split-Path -Parent $Destination
        if ($parent) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
        return $true
    }

    Write-Warning "Skipped missing path: $Source"
    return $false
}

function Get-CursorProjectId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (($Path -replace "[^A-Za-z0-9]+", "-").Trim("-"))
}

$homeDir = [Environment]::GetFolderPath("UserProfile")
$appDataDir = [Environment]::GetFolderPath("ApplicationData")
$cursorProjectId = Get-CursorProjectId -Path $projectRoot
$projectEnvFile = Join-Path $projectRoot ".env"
$projectSummariesDir = Join-Path $projectRoot "summaries"
$claudeDesktopConfig = Join-Path $appDataDir "Claude\claude_desktop_config.json"

$sources = @(
    @{
        Label = "Project summaries"
        Source = $projectSummariesDir
        Destination = Join-Path $archiveRoot "project\summaries"
    },
    @{
        Label = "Project .env"
        Source = $projectEnvFile
        Destination = Join-Path $archiveRoot "project\.env"
    },
    @{
        Label = "Claude projects"
        Source = Join-Path $homeDir ".claude\projects"
        Destination = Join-Path $archiveRoot "claude\projects"
    },
    @{
        Label = "Codex sessions"
        Source = Join-Path $homeDir ".codex\sessions"
        Destination = Join-Path $archiveRoot "codex\sessions"
    },
    @{
        Label = "Codex session index"
        Source = Join-Path $homeDir ".codex\session_index.jsonl"
        Destination = Join-Path $archiveRoot "codex\session_index.jsonl"
    },
    @{
        Label = "Cursor agent transcripts"
        Source = Join-Path $homeDir ".cursor\projects\$cursorProjectId\agent-transcripts"
        Destination = Join-Path $archiveRoot "cursor\agent-transcripts"
    },
    @{
        Label = "Cursor state.vscdb"
        Source = Join-Path $appDataDir "Cursor\User\globalStorage\state.vscdb"
        Destination = Join-Path $archiveRoot "cursor\globalStorage\state.vscdb"
    },
    @{
        Label = "Cursor state.vscdb.options.json"
        Source = Join-Path $appDataDir "Cursor\User\globalStorage\state.vscdb.options.json"
        Destination = Join-Path $archiveRoot "cursor\globalStorage\state.vscdb.options.json"
    },
    @{
        Label = "Claude desktop config"
        Source = $claudeDesktopConfig
        Destination = Join-Path $archiveRoot "claude\claude_desktop_config.json"
    }
)

Remove-Item -LiteralPath $archiveRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null

$copied = @()
$missing = @()

foreach ($entry in $sources) {
    if (Copy-IfExists -Source $entry.Source -Destination $entry.Destination) {
        $copied += $entry.Label
    }
    else {
        $missing += $entry.Label
    }
}

if (-not $copied.Count) {
    Remove-Item -LiteralPath $archiveRoot -Recurse -Force -ErrorAction SilentlyContinue
    throw "No Chronicler data sources were found. Archive was not created."
}

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path $archiveRoot -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $archiveRoot -Recurse -Force

$zipFile = Get-Item -LiteralPath $zipPath

Write-Host ""
Write-Host "Created archive:" -ForegroundColor Green
Write-Host $zipFile.FullName
Write-Host ""
Write-Host "Included sources:" -ForegroundColor Green
$copied | ForEach-Object { Write-Host " - $_" }

if ($missing.Count) {
    Write-Host ""
    Write-Host "Missing sources:" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host " - $_" }
}

Write-Host ""
Write-Host ("Archive size: {0:N0} bytes" -f $zipFile.Length)
