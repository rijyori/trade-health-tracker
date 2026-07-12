# Trade Health Tracker의 작업 스케줄러 등록을 해지한다.
# 이미 떠있는 서버 프로세스는 강제 종료하지 않는다 — "다음 로그온부터 자동 시작 안 함"만 적용.
# 지금 떠있는 걸 바로 끄고 싶으면 그 창을 직접 닫거나 작업 관리자에서 node.exe를 종료할 것.

$ErrorActionPreference = 'Stop'
$TaskName = 'TradeHealthTracker'

$existing = schtasks /query /tn $TaskName 2>$null
if (-not $existing) {
    Write-Host "등록된 작업이 없습니다 ($TaskName)."
    exit 0
}

schtasks /delete /tn $TaskName /f

if ($LASTEXITCODE -eq 0) {
    Write-Host "해지 완료 — 다음 로그온부터 자동 시작 안 합니다."
    Write-Host "(지금 실행 중인 서버가 있다면 그대로 켜져 있습니다. 끄려면 직접 종료하세요.)"
} else {
    Write-Error "해지 실패."
    exit 1
}
