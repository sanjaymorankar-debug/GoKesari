<#
  Copies the Product Master data from the local pilot database into a TARGET database whose pmd schema has been
  migrated (npm run db:migrate) but is still empty.

  Why a script: pg_dump orders the partitioned price_history before the table it references, so a plain restore fails.
  price_history has to be restored last. No superuser option is used, so this works on a hosted database.

    .\scripts\pmd\copy-pilot-data.ps1 -Target "<direct postgres URL of the target>"

  It refuses to run if the target has no pmd schema, or if pmd.product_master is not empty (it never overwrites).
  The target URL is never printed.
#>
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Source = 'postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd',
  [string]$PgHome = 'C:\Program Files\PostgreSQL\16'
)

$ErrorActionPreference = 'Stop'
$bin = Join-Path $PgHome 'bin'
$psql = Join-Path $bin 'psql.exe'
$pgDump = Join-Path $bin 'pg_dump.exe'
$pgRestore = Join-Path $bin 'pg_restore.exe'
foreach ($exe in @($psql, $pgDump, $pgRestore)) { if (-not (Test-Path $exe)) { throw "Not found: $exe (set -PgHome to a PostgreSQL 16+ install)" } }

function Scalar([string]$url, [string]$sql) {
  # options first, the connection URL last: psql on Windows stops parsing options at the first positional argument
  $out = & $psql -X -A -t -v ON_ERROR_STOP=1 -c $sql $url
  if ($LASTEXITCODE -ne 0) { throw "psql failed for: $sql" }
  return ($out | Select-Object -First 1).Trim()
}

Write-Host 'Checking the target ...'
if ((Scalar $Target "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pmd'") -ne '1') {
  throw 'The target has no pmd schema. Run "npm run db:migrate" against it first.'
}
$existing = [int](Scalar $Target 'SELECT count(*) FROM pmd.product_master')
if ($existing -ne 0) { throw "The target already holds $existing master products. This script only fills an empty pmd schema." }
$refs = [int](Scalar $Target 'SELECT count(*) FROM pmd.category') + [int](Scalar $Target 'SELECT count(*) FROM pmd.source')
if ($refs -ne 0) { throw 'The target already has categories or sources (a seed was run). Use a target whose pmd schema is untouched after migration.' }

$work = Join-Path ([IO.Path]::GetTempPath()) ('pmd-copy-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $dump = Join-Path $work 'pilot-pmd.dump'
  Write-Host 'Dumping the pilot data ...'
  # pg_dump warns on stderr about circular foreign keys; PowerShell 5.1 would turn that into a terminating error, so the
  # exit code decides. Options first, the connection URL last (Windows getopt).
  & { $ErrorActionPreference = 'Continue'; & $pgDump -Fc -a -n pmd -f $dump $Source 2>$null }
  if ($LASTEXITCODE -ne 0) { throw 'pg_dump failed.' }

  $toc = & $pgRestore -l $dump
  $last = @($toc | Where-Object { $_ -match 'TABLE DATA pmd price_history' })
  $rest = @($toc | Where-Object { $_ -notmatch 'TABLE DATA pmd price_history' })
  $tocFile = Join-Path $work 'toc.txt'
  ($rest + $last) | Set-Content -Encoding ascii $tocFile

  Write-Host 'Restoring (one transaction: all or nothing) ...'
  & { $ErrorActionPreference = 'Continue'; & $pgRestore -d $Target -a --single-transaction -L $tocFile $dump }
  if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed; nothing was written (single transaction).' }

  Write-Host 'Verifying ...'
  $ok = $true
  foreach ($t in 'product_master', 'product_source', 'product_identifier', 'product_image', 'category', 'source', 'price_history') {
    $a = Scalar $Source "SELECT count(*) FROM pmd.$t"
    $b = Scalar $Target "SELECT count(*) FROM pmd.$t"
    $flag = if ($a -eq $b) { 'ok' } else { $ok = $false; 'MISMATCH' }
    Write-Host ('  {0,-20} source {1,7}  target {2,7}  {3}' -f $t, $a, $b, $flag)
  }
  if (-not $ok) { throw 'Row counts differ between source and target.' }
  Write-Host 'Done. Next: npm run pmd:promote (dry run) - see docs/product-master/PUBLISH_TO_SHOP.md'
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
