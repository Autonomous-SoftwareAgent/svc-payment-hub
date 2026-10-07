<#
Sao lưu PostgreSQL của stack prod bằng pg_dump (định dạng custom) chạy trong container.
  .\backup.ps1 [-OutDir .\backups] [-Keep 14] [-ComposeFile .\docker-compose.yml] [-EnvFile .\.env]
Ghi <OutDir>\hub-yyyyMMdd-HHmmss.dump, kiểm tra tệp không rỗng và đọc được (pg_restore --list), giữ -Keep bản mới nhất.
#>
[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'backups'),
  [int]$Keep = 14,
  [string]$ComposeFile = (Join-Path $PSScriptRoot 'docker-compose.yml'),
  [string]$EnvFile = (Join-Path $PSScriptRoot '.env')
)
$ErrorActionPreference = 'Stop'
if ($Keep -lt 1) { throw 'Keep phải >= 1' }
$dc = @('compose', '-f', $ComposeFile)
if (Test-Path $EnvFile) { $dc += @('--env-file', $EnvFile) }
function Dc { $ErrorActionPreference = 'Continue'; & docker @dc @args 2>&1 | ForEach-Object { Write-Host "$_" }; if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') lỗi ($LASTEXITCODE)" } }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir "hub-$stamp.dump"
$tmp = "/tmp/hub-$stamp.dump"

# Dump trong container rồi docker cp: tránh làm hỏng dữ liệu nhị phân qua pipe của PowerShell.
Dc exec -T postgres sh -c "pg_dump -U hub -d hub -Fc -f $tmp"
try {
  Dc cp "postgres:$tmp" $file
  # pg_restore --list từ stdin trong container: xác nhận tệp là dump hợp lệ.
  Dc exec -T postgres sh -c "pg_restore --list $tmp > /dev/null"
} finally {
  Dc exec -T postgres rm -f $tmp
}
if (-not (Test-Path $file) -or (Get-Item $file).Length -eq 0) { Remove-Item $file -ErrorAction SilentlyContinue; throw "Tệp dump rỗng hoặc không có: $file" }

# Chỉ xóa bản cũ sau khi bản mới đã kiểm tra xong.
Get-ChildItem $OutDir -Filter 'hub-*.dump' | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
Write-Host "OK $file ($((Get-Item $file).Length) byte)"
