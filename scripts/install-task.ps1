# Trade Health Tracker를 윈도우 작업 스케줄러에 등록한다.
# 로그온 시 scripts\start.ps1 을 실행 — GitHub에서 업데이트를 확인해 있으면 pull한 뒤 서버를 띄운다.
# 프로젝트 경로를 하드코딩하지 않고 이 스크립트 자신의 위치를 기준으로 잡아서,
# 폴더를 어디로 옮겨도(다른 PC로 복사해도) 그대로 다시 실행하면 된다.

$ErrorActionPreference = 'Stop'
$TaskName = 'TradeHealthTracker'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $ProjectDir 'scripts\start.ps1'

if (-not (Test-Path $StartScript)) {
    Write-Error "start.ps1을 찾을 수 없습니다: $StartScript`n이 스크립트는 프로젝트 폴더 안의 scripts\install-task.ps1 위치 그대로 실행해야 합니다."
    exit 1
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "node를 찾을 수 없습니다. Node.js를 먼저 설치하고 새 터미널에서 다시 실행하세요."
    exit 1
}

Write-Host "Node.js: $($NodeCmd.Source)"
Write-Host "Project: $ProjectDir"

# 로그온 시 start.ps1을 숨김 창으로 실행(자동 업데이트 확인 → 서버 시작).
# 이미 등록돼 있으면 덮어쓰기(/F) — 몇 번을 다시 실행해도 안전.
$Action = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$StartScript`""
schtasks /create /tn $TaskName /tr $Action /sc onlogon /rl limited /f

if ($LASTEXITCODE -ne 0) {
    Write-Error "작업 스케줄러 등록 실패."
    exit 1
}

Write-Host ""
Write-Host "등록 완료 — 다음 로그온부터 자동으로 서버가 시작됩니다."
Write-Host "지금 바로 확인하려면:"
Write-Host "  schtasks /run /tn $TaskName"
Write-Host "  그 후 브라우저에서 http://localhost:3010 접속"
Write-Host ""
Write-Host "지금 바로 시작할까요? 이어서 자동 실행합니다..."
schtasks /run /tn $TaskName
Start-Sleep -Seconds 2
Write-Host "서버를 백그라운드로 시작했습니다. http://localhost:3010 에서 확인하세요."
