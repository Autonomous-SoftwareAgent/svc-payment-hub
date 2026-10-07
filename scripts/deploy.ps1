<#
Build image Hub và (tùy chọn) đẩy lên Docker Hub rồi triển khai lên VM. Xem skill cicd ở BSN_/.claude/skills/cicd. spec: PHUB-S-031
spec: PHUB-S-034
Theo S-017: ảnh CHỈ build từ một commit chỉ định (không đọc thư mục làm việc, nên tệp đang sửa dở không lọt vào ảnh) và nhãn ảnh là 12 ký tự đầu của mã commit.
Commit lấy từ -Commit, nếu không thì từ commit được ghim cho payment-hub ở BSN_/infra/services/payment-hub.json; không có cả hai thì dừng (không tự lấy HEAD).
MẶC ĐỊNH LÀ CHẾ ĐỘ KHÔ: chỉ in ra việc sẽ làm, không build, không đẩy, không SSH.

  .\scripts\deploy.ps1                                   # khô: in kế hoạch (commit, nhãn)
  .\scripts\deploy.ps1 -Execute                          # build local từ commit ghim, nhãn <12 ký tự commit>; KHÔNG đẩy
  .\scripts\deploy.ps1 -Execute -Commit <commit>         # như trên nhưng build commit chỉ định
  .\scripts\deploy.ps1 -Execute -Push                    # build + docker push (cần docker login hoặc DOCKERHUB_USERNAME/DOCKERHUB_TOKEN)
  .\scripts\deploy.ps1 -Execute -Push -Remote me@vm      # + scp compose, pull, up -d, chờ khỏe, tự rollback nếu không khỏe
  .\scripts\deploy.ps1 -Execute -Remote me@vm -Tag 0123456789ab   # triển khai lại nhãn cũ (rollback tay), không build

Tham số: -Commit (commit để build), -Repo (mặc định $env:DOCKERHUB_REPO, dạng <user>/<repo>), -RemoteDir (mặc định ~/app), -SshOpts, -HealthWaitSeconds.
Yêu cầu trên VM: Docker + Compose plugin, ~/app/.env đã có (bí mật ở đó; script chỉ sửa dòng HUB_IMAGE).
#>
[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$Push,
  [string]$Remote,
  [string]$Repo = $env:DOCKERHUB_REPO,
  [string]$Tag,
  [string]$Commit,
  [string]$RemoteDir = '~/app',
  [string[]]$SshOpts = @(),
  [int]$HealthWaitSeconds = 120
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$prod = Join-Path $root 'infra/prod'
$dry = -not $Execute

$build = -not $Tag
$full = $null
if ($build) {
  # Commit để build: tham số, nếu không thì commit được ghim ở BSN_/infra/services/payment-hub.json (S-017, S-023). Không tự lấy HEAD.
  if (-not $Commit) {
    $pin = Join-Path $root '../../infra/services/payment-hub.json'
    if (Test-Path $pin) { try { $Commit = (Get-Content $pin -Raw | ConvertFrom-Json).commit } catch { } }
  }
  if (-not $Commit) { throw 'Thiếu -Commit và không đọc được commit được ghim cho payment-hub ở BSN_/infra/services/payment-hub.json (S-017, S-023: build chỉ từ commit chỉ định).' }
  $full = (& git -C $root rev-parse --verify "$Commit^{commit}")
  if ($LASTEXITCODE -ne 0 -or -not $full) { throw "Commit không có trong repo: $Commit" }
  $Tag = $full.Substring(0, 12)
}
if (($Push -or $Remote) -and -not $Repo) { throw 'Thiếu -Repo hoặc biến môi trường DOCKERHUB_REPO (vd myuser/bsn).' }
if ($Remote -and $build -and -not $Push) { throw '-Remote với build mới cần -Push (VM chỉ pull, không build). Hoặc dùng -Tag <tag đã có>.' }
$image = if ($Repo) { "${Repo}:$Tag" } else { "bsn-payment-hub:$Tag" }

function Step($text, [scriptblock]$action) {
  if ($dry) { Write-Host "[khô] $text"; return }
  Write-Host ">> $text"
  & $action
}
function Run { $a = $args[1..($args.Count - 1)]; & $args[0] @a; if ($LASTEXITCODE -ne 0) { throw "Lỗi ($LASTEXITCODE): $($args -join ' ')" } }

if ($dry) { Write-Host ("CHẾ ĐỘ KHÔ (thêm -Execute để chạy thật). Image: $image" + $(if ($full) { " (commit $full)" } else { '' })) }

if ($build) {
  # Trích đúng commit ra thư mục tạm rồi build từ đó. core.autocrlf=false: trên Windows git mặc định đổi xuống dòng thành CRLF khi xuất, làm hỏng tệp chạy trong ảnh Linux.
  $src = Join-Path ([IO.Path]::GetTempPath()) "hub-build-$Tag"
  Step "git -c core.autocrlf=false archive $Tag -> $src; kiểm băm tệp trích ra trùng bản đã commit" {
    if (Test-Path $src) { Remove-Item $src -Recurse -Force }
    New-Item -ItemType Directory $src | Out-Null
    Run git -c core.autocrlf=false -C $root archive --format=tar -o "$src.tar" $full
    # Chạy tar ngay trong thư mục chứa tệp với tên tương đối: đường dẫn kiểu C:... làm tar của Git Bash hiểu nhầm là máy từ xa (giống BSN_/infra/lib.js).
    Push-Location (Split-Path $src -Parent)
    try { Run tar -xf "$(Split-Path $src -Leaf).tar" -C (Split-Path $src -Leaf) } finally { Pop-Location }
    Remove-Item "$src.tar"
    foreach ($f in 'src/hub.js', 'package.json') {
      $want = (& git -C $root rev-parse "$($full):$f")
      $got = (& git -C $root hash-object --no-filters (Join-Path $src $f))
      if ($want -ne $got) { throw "Tệp trích ra khác bản đã commit: $f ($got, cần $want)" }
    }
  }
  Step "docker buildx build --platform linux/amd64 --target hub -t $image --load $src" {
    Run docker buildx build --platform linux/amd64 --target hub -t $image --load $src
  }
  Step "Kiểm ảnh chứa đúng bản đã commit: băm /app/src/hub.js trong ảnh = băm tệp trích từ commit $Tag" {
    $inImage = ((& docker run --rm --entrypoint sh $image -c 'sha256sum /app/src/hub.js') -split '\s+')[0]
    $onDisk = (Get-FileHash (Join-Path $src 'src/hub.js') -Algorithm SHA256).Hash.ToLower()
    if ($inImage -ne $onDisk) { throw "Ảnh không chứa bản đã commit: $inImage khác $onDisk" }
    Write-Host "   khớp commit $Tag (sha256 hub.js $onDisk)"
    Remove-Item $src -Recurse -Force
  }
  Step "Kiểm tra image không chứa test/docs/.env: docker run --rm --entrypoint ls $image -a /app" {
    $ls = (& docker run --rm --entrypoint ls $image -a /app) -join ' '
    Write-Host "   /app: $ls"
    if ($ls -match 'test|docs|\.env') { throw "Image chứa tệp không mong muốn: $ls" }
  }
}
if ($Push) {
  Step "docker login (từ DOCKERHUB_USERNAME/DOCKERHUB_TOKEN nếu có), docker push $image, docker manifest inspect" {
    if ($env:DOCKERHUB_USERNAME -and $env:DOCKERHUB_TOKEN) {
      $env:DOCKERHUB_TOKEN | docker login -u $env:DOCKERHUB_USERNAME --password-stdin
      if ($LASTEXITCODE) { throw 'docker login lỗi' }
    }
    Run docker push $image
    Run docker manifest inspect $image | Out-Null
  }
}
if ($Remote) {
  Step "scp docker-compose.yml Caddyfile hub.config.json backup.sh restore.sh -> ${Remote}:$RemoteDir/ (KHÔNG gửi .env)" {
    Run ssh @SshOpts $Remote "mkdir -p $RemoteDir"
    foreach ($f in 'docker-compose.yml', 'Caddyfile', 'hub.config.json', 'backup.sh', 'restore.sh') {
      Run scp @SshOpts (Join-Path $prod $f) "${Remote}:$RemoteDir/$f"
    }
  }
  # Chạy trên VM: nhớ tag cũ, backup DB, đổi HUB_IMAGE, pull, up, chờ khỏe, rollback nếu không khỏe.
  $remoteScript = @'
set -eu
cd __DIR__
[ -f .env ] || { echo 'thiếu .env trên VM' >&2; exit 2; }
exec 9>/tmp/bsn-deploy.lock; flock -n 9 || { echo 'đang có deploy khác' >&2; exit 2; }
NEW='__IMAGE__'
PREV=$(sed -n 's/^HUB_IMAGE=//p' .env | tail -n1)
setimg() { if grep -q '^HUB_IMAGE=' .env; then sed -i "s|^HUB_IMAGE=.*|HUB_IMAGE=$1|" .env; else echo "HUB_IMAGE=$1" >> .env; fi; }
waithealthy() {
  i=0
  while [ $i -lt __WAIT__ ]; do
    cid=$(docker compose ps -q hub)
    st=$([ -n "$cid" ] && docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' "$cid" || echo none)
    [ "$st" = "healthy 0" ] && return 0
    sleep 3; i=$((i+3))
  done
  return 1
}
if [ -n "$PREV" ] && docker compose ps -q postgres | grep -q .; then ./backup.sh ./backups 14 || echo 'CẢNH BÁO: backup trước deploy lỗi' >&2; fi
setimg "$NEW"
docker compose pull
# Kiểm cấu hình bằng image MỚI, với .env và hub.config.json thật trên VM, TRƯỚC khi đụng vào bản đang chạy (PHUB-D-024). Chỉ thêm --connect khi PostgreSQL đang chạy.
CHK='--check-config'
docker compose ps -q postgres | grep -q . && CHK='--check-config --connect'
if ! docker compose run --rm --no-deps -T hub node src/main.js $CHK; then
  echo "Cấu hình KHÔNG hợp lệ với image mới, không triển khai (bản đang chạy giữ nguyên)" >&2
  if [ -n "$PREV" ]; then setimg "$PREV"; fi
  echo "$(date -Is) deploy HỦY $NEW: kiểm cấu hình lỗi" >> deploy.log
  exit 1
fi
docker compose up -d --no-build
if waithealthy; then
  echo "$(date -Is) deploy $NEW (trước đó: ${PREV:-none})" >> deploy.log
  docker image prune -f > /dev/null
  echo "OK $NEW"
else
  echo "KHÔNG KHỎE, rollback về ${PREV:-none}" >&2
  docker compose logs --tail=50 hub >&2 || true
  if [ -n "$PREV" ]; then setimg "$PREV"; docker compose up -d --no-build; waithealthy && echo "đã rollback về $PREV" >&2; fi
  echo "$(date -Is) deploy THẤT BẠI $NEW, rollback ${PREV:-none}" >> deploy.log
  exit 1
fi
'@
  $remoteScript = $remoteScript.Replace('__DIR__', $RemoteDir).Replace('__IMAGE__', $image).Replace('__WAIT__', "$HealthWaitSeconds").Replace("`r", '')
  Step "SSH ${Remote}: backup DB, HUB_IMAGE=$image, docker compose pull, kiểm cấu hình bằng image mới (--check-config, hủy deploy nếu lỗi), up -d --no-build, chờ healthy (tối đa ${HealthWaitSeconds}s), tự rollback về tag trước nếu không khỏe" {
    $remoteScript | & ssh @SshOpts $Remote 'sh -s'
    if ($LASTEXITCODE -ne 0) { throw "Deploy thất bại trên VM (mã $LASTEXITCODE); VM đã rollback nếu có tag trước." }
  }
}
Write-Host ($(if ($dry) { 'Hết kế hoạch (chưa làm gì).' } else { "Xong: $image" }))
