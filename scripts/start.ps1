# Trade Health Tracker 시작 스크립트 (자동 업데이트 포함, git 불필요).
#
# 하는 일:
#   1) update.ps1 을 호출해 GitHub zip 아카이브로 최신본 확인/적용 (git 없이 동작)
#   2) 서버 시작 (npm start = node src/server.js)
#
# 설계 원칙: "업데이트 실패해도 앱은 무조건 뜬다."
#   네트워크/원격 문제 시 업데이트 단계는 조용히 건너뛰고 기존 로컬 코드로 그대로 시작한다.
#   (평소 쓰는 사람이 인터넷 때문에 못 켜면 안 됨)
#
# 경로는 이 스크립트 위치 기준으로 잡으므로 폴더를 어디로 옮겨도 동작한다.

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

Write-Host "=== Trade Health Tracker ==="
Write-Host "Project: $ProjectDir"

# --- 1) 자동 업데이트 (zip 기반, git 불필요; 실패해도 계속 진행) ---
# -NoRestart: 여기선 아래에서 바로 npm start 할 거라 update가 재시작까지 하면 안 됨.
$updater = Join-Path $PSScriptRoot 'update.ps1'
if (Test-Path $updater) {
    try { & $updater -NoRestart } catch { Write-Host "업데이트 단계 오류 — 기존 코드로 시작. ($_)" -ForegroundColor Yellow }
}

# --- 2) 의존성이 아예 없으면(최초 실행 등) 설치 ---
if (-not (Test-Path (Join-Path $ProjectDir 'node_modules'))) {
    Write-Host "node_modules 없음 — npm install 실행."
    npm install
}

# --- 3) 서버 시작 ---
Write-Host "서버 시작: npm start"
npm start
