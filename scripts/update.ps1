# 업데이트 (git 불필요) — GitHub 공개 리포의 zip 아카이브로 최신본을 받아 반영한다.
#
#   1) GitHub API로 최신 커밋 SHA 확인 → 로컬 .deploy-version 과 비교
#   2) 다르면 zip 아카이브를 받아 압축 해제 후 프로젝트 폴더에 덮어쓰기
#      (zip엔 data/ .env node_modules 가 없으므로 그것들은 건드리지 않음)
#   3) package-lock.json 이 바뀌었으면 npm install
#   4) (-NoRestart 아니면) restart.ps1 로 작업을 껐다 켜서 새 코드 적용
#
# node/npm 은 필요하지만 git 은 필요 없다. 설계 원칙은 start.ps1 과 동일 —
# 네트워크/원격 문제 시 업데이트는 조용히 건너뛰고 기존 코드를 유지한다.
#
# ⚠️ 덮어쓰기라 로컬에서 직접 고친 코드 파일은 원격 버전으로 덮인다(배포용 PC 기준).
#    data/ 와 .env 는 영향 없음(아카이브에 없음).

param([switch]$NoRestart)

$Repo   = 'rijyori/trade-health-tracker'
$Branch = 'main'

$ProjectDir  = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir
$VersionFile = Join-Path $ProjectDir '.deploy-version'

# GitHub는 TLS 1.2+ 요구 (Windows PowerShell 5.1 기본이 옛 프로토콜일 수 있어 강제)
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# --- 1) 최신 커밋 SHA 확인 ---
$latest = $null
try {
    $api = "https://api.github.com/repos/$Repo/commits/$Branch"
    $latest = (Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'tht-updater' } -TimeoutSec 20).sha
} catch {
    Write-Host "업데이트 확인 실패(네트워크 등) — 건너뜁니다. ($_)" -ForegroundColor Yellow
    exit 0
}
if (-not $latest) { Write-Host "최신 버전 정보를 못 읽음 — 건너뜁니다." -ForegroundColor Yellow; exit 0 }

$current = ''
if (Test-Path $VersionFile) { $current = (Get-Content $VersionFile -Raw).Trim() }

if ($current -eq $latest) {
    Write-Host "이미 최신 버전입니다 ($($latest.Substring(0,7)))."
    exit 0
}
Write-Host "새 버전 발견: $($latest.Substring(0,7)) (현재: $(if ($current) { $current.Substring(0,7) } else { '없음' }))"

# --- 2) zip 다운로드 + 압축 해제 + 덮어쓰기 ---
$tmp = Join-Path $env:TEMP ("tht-update-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zipUrl  = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
    $zipPath = Join-Path $tmp 'update.zip'
    Write-Host "다운로드 중..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force

    # 아카이브는 'trade-health-tracker-main' 같은 단일 폴더로 풀린다.
    $extracted = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (-not $extracted) { throw "압축 해제 결과 폴더를 찾을 수 없음" }

    # 인터넷에서 받은 파일엔 "Mark of the Web"(Zone.Identifier)가 붙어 SmartScreen/실행정책이
    # 트집 잡을 수 있음 → 적용 전에 제거해 둔다(신뢰하는 내 공개 리포이므로 안전).
    Get-ChildItem -Path $extracted.FullName -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

    $lock = Join-Path $ProjectDir 'package-lock.json'
    $oldHash = if (Test-Path $lock) { (Get-FileHash $lock).Hash } else { '' }

    Write-Host "적용 중..."
    Copy-Item -Path (Join-Path $extracted.FullName '*') -Destination $ProjectDir -Recurse -Force

    $newHash = if (Test-Path $lock) { (Get-FileHash $lock).Hash } else { '' }

    Set-Content -Path $VersionFile -Value $latest -NoNewline
    Write-Host "코드 갱신 완료 ($($latest.Substring(0,7)))."

    if ($oldHash -ne $newHash) {
        Write-Host "의존성 변경 감지 — npm install 실행."
        npm install
    }
} catch {
    Write-Host "업데이트 적용 실패 — 기존 코드 유지. ($_)" -ForegroundColor Yellow
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue

# --- 3) 재시작 ---
if ($NoRestart) {
    Write-Host "적용 완료(재시작은 호출측에서 처리)."
} else {
    Write-Host "서버 재시작..."
    & (Join-Path $PSScriptRoot 'restart.ps1')
}
