<#
.SYNOPSIS
  Back up the SMS gateway database to .\backups\smsgw-YYYYMMDD-HHMMSS.dump
.DESCRIPTION
  Uses pg_dump inside the running "db" container (custom format, compressed).
  The file is written by the container straight into the mounted .\backups
  folder, so PowerShell never re-encodes the binary output.
  Backups contain personal data (names, phone numbers, consent records):
  keep the backups folder on a BitLocker-encrypted drive and copy it
  off the PC to encrypted storage.
.EXAMPLE
  .\scripts\backup.ps1
  .\scripts\backup.ps1 -KeepDays 30
#>
param([int]$KeepDays = 14)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name  = "smsgw-$stamp.dump"
docker compose exec -T db pg_dump -U smsgw -d smsgw -Fc -Z 6 -f "/backups/$name"
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }

# Verify the archive is readable before trusting it.
docker compose exec -T db pg_restore -l "/backups/$name" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Backup written but failed verification: backups\$name" }

$file = Get-Item "backups\$name"
Write-Host ("Backup OK: {0} ({1:N1} MB)" -f $file.FullName, ($file.Length / 1MB))

# Remove old backups.
Get-ChildItem backups -Filter 'smsgw-*.dump' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
  ForEach-Object { Write-Host "Removing old backup $($_.Name)"; Remove-Item $_.FullName }
