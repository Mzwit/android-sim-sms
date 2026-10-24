<#
.SYNOPSIS
  Restore the database from a backup made by backup.ps1.
.DESCRIPTION
  Stops the backend (so no phone is handed work mid-restore), replaces the
  database contents, then starts the backend again. Everything written after
  the backup was taken is lost, so the script asks for confirmation.
.EXAMPLE
  .\scripts\restore.ps1 -File backups\smsgw-20261024-210000.dump
#>
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$item = Get-Item $File
if ($item.DirectoryName -ne (Resolve-Path 'backups').Path) { throw 'The backup file must be inside the backups folder.' }
$answer = Read-Host "This REPLACES all current data with $($item.Name). Type RESTORE to continue"
if ($answer -ne 'RESTORE') { Write-Host 'Cancelled.'; exit 1 }

docker compose stop backend
docker compose exec -T db pg_restore -U smsgw -d smsgw --clean --if-exists --no-owner --single-transaction "/backups/$($item.Name)"
if ($LASTEXITCODE -ne 0) { docker compose start backend; throw "pg_restore failed (exit $LASTEXITCODE); the database was left unchanged." }
docker compose start backend
Write-Host "Restored from $($item.Name). Messages that were LEASED to a phone at backup time will be reconciled when the phone reconnects (Phase 5)."
