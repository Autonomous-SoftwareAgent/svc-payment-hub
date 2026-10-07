<#
Khôi phục PostgreSQL từ một tệp dump của backup.ps1. GHI ĐÈ dữ liệu hiện tại (xóa và tạo lại database `hub`).
  .\restore.ps1 -File .\backups\hub-20261002-101500.dump -Force [-ComposeFile ..] [-EnvFile ..]
Trình tự: dừng hub -> drop/create DB -> pg_restore -> bật lại hub -> chờ hub khỏe.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$File,
  [switch]$Force,
  [string]$ComposeFile = (Join-Path $PSScriptRoot 'docker-compose.yml'),
  [string]$EnvFile = (Join-Path $PSScriptRoot '.env'),
  [int]$WaitSeconds = 90
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $File) -or (Get-Item $File).Length -eq 0) { throw "Tệp dump không có hoặc rỗng: $File" }
if (-not $Force) { throw 'Thao tác ghi đè toàn bộ dữ liệu. Thêm -Force để xác nhận.' }
$dc = @('compose', '-f', $ComposeFile)
if (Test-Path $EnvFile) { $dc += @('--env-file', $EnvFile) }
function Dc { $ErrorActionPreference = 'Continue'; & docker @dc @args 2>&1 | ForEach-Object { Write-Host "$_" }; if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') lỗi ($LASTEXITCODE)" } }

$tmp = '/tmp/restore.dump'
Dc cp $File "postgres:$tmp"
Dc exec -T postgres sh -c "pg_restore --list $tmp > /dev/null"   # dump hỏng thì dừng trước khi xóa gì
Dc stop hub
# Postgres là dịch vụ riêng nên giữ chạy; xóa DB cũ rồi tạo lại sạch.
Dc exec -T postgres sh -c "psql -U hub -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS hub WITH (FORCE)' -c 'CREATE DATABASE hub OWNER hub'"
Dc exec -T postgres sh -c "pg_restore -U hub -d hub --no-owner --exit-on-error $tmp"
Dc exec -T postgres rm -f $tmp
Dc up -d --no-build hub

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
  Start-Sleep -Seconds 2
  $cid = (& docker @dc ps -q hub)
  $st = if ($cid) { (& docker inspect -f '{{.State.Health.Status}}' $cid) } else { 'none' }
} while ($st -ne 'healthy' -and (Get-Date) -lt $deadline)
if ($st -ne 'healthy') { throw "Hub chưa khỏe sau khi khôi phục (trạng thái: $st). Xem: docker compose logs hub" }
Write-Host "OK đã khôi phục từ $File, hub healthy"
