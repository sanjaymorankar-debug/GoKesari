<#
.SYNOPSIS
  Disposable local PostgreSQL 16 cluster for the Product Master pilot.

.DESCRIPTION
  Creates and manages a throwaway cluster in a folder OUTSIDE the repo, on its own
  port, bound to 127.0.0.1 with trust auth. It never touches an existing PostgreSQL
  service or any hosted database (Neon etc.) - the pilot is deliberately run here
  so nothing is written to a shared environment before the pilot is validated.

  Uses the binaries of an installed PostgreSQL 16 (no admin rights needed).

.EXAMPLE
  ./scripts/pmd/local-pg.ps1 init      # once: create the cluster + databases
  ./scripts/pmd/local-pg.ps1 start
  ./scripts/pmd/local-pg.ps1 status
  ./scripts/pmd/local-pg.ps1 stop
  ./scripts/pmd/local-pg.ps1 reset     # DESTROYS the cluster and recreates it
#>
param(
  [ValidateSet('init', 'start', 'stop', 'status', 'reset', 'url')]
  [string]$Action = 'status',
  # Default lives under the user profile, not the repo: a database has no business in a source tree,
  # and the repo drive can be the small one.
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'GokesariPmd'),
  [int]$Port = 54329,
  [string]$PgHome = 'C:\Program Files\PostgreSQL\16'
)

$ErrorActionPreference = 'Stop'
$bin = Join-Path $PgHome 'bin'
$data = Join-Path $Root 'pgdata'
$log = Join-Path $Root 'postgres.log'
$user = 'pmd_admin'
$databases = @('gokesari_pmd', 'gokesari_pmd_test')

function Test-Running {
  $probe = & (Join-Path $bin 'pg_isready.exe') -h 127.0.0.1 -p $Port 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Start-Cluster {
  if (Test-Running) { Write-Output "already running on 127.0.0.1:$Port"; return }
  if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) { throw "no cluster at $data - run 'init' first" }
  # Start-Process keeps the server alive after this shell exits.
  $args = @('-D', "`"$data`"", '-p', $Port, '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off',
            '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=60',
            '-c', 'shared_buffers=256MB', '-c', 'log_min_messages=warning')
  Start-Process -FilePath (Join-Path $bin 'postgres.exe') -ArgumentList $args -WindowStyle Hidden `
    -RedirectStandardError $log | Out-Null
  for ($i = 0; $i -lt 40; $i++) { if (Test-Running) { break }; Start-Sleep -Milliseconds 500 }
  if (-not (Test-Running)) { throw "server did not come up; see $log" }
  Write-Output "started on 127.0.0.1:$Port"
}

function Stop-Cluster {
  if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) { Write-Output 'no cluster'; return }
  & (Join-Path $bin 'pg_ctl.exe') -D $data -m fast stop 2>&1 | Out-Null
  Write-Output 'stopped'
}

switch ($Action) {
  'init' {
    New-Item -ItemType Directory -Force $Root | Out-Null
    if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) {
      & (Join-Path $bin 'initdb.exe') -D $data -U $user --auth=trust -E UTF8 --locale=C | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
    }
    Start-Cluster
    foreach ($db in $databases) {
      $exists = & (Join-Path $bin 'psql.exe') -h 127.0.0.1 -p $Port -U $user -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'"
      if (-not $exists) { & (Join-Path $bin 'createdb.exe') -h 127.0.0.1 -p $Port -U $user $db }
    }
    Write-Output "databases ready: $($databases -join ', ')"
  }
  'start'  { Start-Cluster }
  'stop'   { Stop-Cluster }
  'status' { if (Test-Running) { Write-Output "running on 127.0.0.1:$Port" } else { Write-Output 'not running' } }
  'url'    { Write-Output "postgresql://${user}@127.0.0.1:${Port}/$($databases[0])" }
  'reset'  {
    Stop-Cluster
    if (Test-Path $data) { Remove-Item -Recurse -Force $data }
    & $PSCommandPath -Action init -Root $Root -Port $Port -PgHome $PgHome
  }
}
