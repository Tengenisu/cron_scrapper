<#
.SYNOPSIS
  Windows equivalent of installing crontab.txt: runs the scraper every 5 minutes.

.DESCRIPTION
  Prefer `npm run cron` — it is the same schedule inside the Node process, with
  overlap handling and graceful shutdown. This script exists for a host that
  wants the loop owned by PowerShell (or by Task Scheduler calling it once).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\run_every.ps1
  powershell -ExecutionPolicy Bypass -File .\run_every.ps1 -Once
#>
param(
  [int]$IntervalSeconds = 300,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$env:CACHE_ENABLED = "0"
if (-not $env:MCP_ENDPOINT) { $env:MCP_ENDPOINT = "http://127.0.0.1:3123/mcp" }

do {
  $startedAt = Get-Date
  node dist/index.js --once --quiet
  if ($Once) { break }

  $elapsed = (Get-Date) - $startedAt
  $sleepFor = $IntervalSeconds - [int]$elapsed.TotalSeconds
  if ($sleepFor -gt 0) { Start-Sleep -Seconds $sleepFor }
} while ($true)
