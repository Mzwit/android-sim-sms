<#
.SYNOPSIS
  Run the backend's automated tests against the smsgw_test database.
.DESCRIPTION
  Requires Node.js 20+ and the "db" container running (docker compose up -d db).
  The tests wipe and recreate the smsgw_test database only; they refuse to run
  against a database whose name does not contain "test".
#>
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path (Split-Path $PSScriptRoot -Parent) 'backend')
$envFile = Get-Content ..\.env | Where-Object { $_ -match '^\s*POSTGRES_PASSWORD=' }
$pw   = ($envFile -split '=', 2)[1].Trim()
$port = ((Get-Content ..\.env | Where-Object { $_ -match '^\s*DB_PORT=' }) -split '=', 2)[1]
if (-not $port) { $port = '5432' }
$env:TEST_DATABASE_URL = "postgres://smsgw:$pw@localhost:$($port.Trim())/smsgw_test"
if (-not (Test-Path node_modules)) { npm ci }
npm test
