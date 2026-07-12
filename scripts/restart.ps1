# 작업 스케줄러로만 서버를 재시작한다(포트 직접 종료 X).
#   schtasks /end  — 현재 실행 중인 TradeHealthTracker 작업 인스턴스를 종료
#   schtasks /run  — 다시 시작(= start.ps1 재실행: 업데이트 확인 후 npm start)
# 재등록(install-task.ps1)은 필요 없다 — 이미 등록된 작업을 껐다 켜기만 한다.

$TaskName = 'TradeHealthTracker'

Write-Host "실행 중인 작업 종료: $TaskName"
# 안 돌고 있으면 에러가 나는데(정상), 무시하고 진행.
schtasks /end /tn $TaskName 2>$null | Out-Null

Start-Sleep -Seconds 2

Write-Host "작업 다시 시작: $TaskName"
schtasks /run /tn $TaskName
if ($LASTEXITCODE -eq 0) {
    Write-Host "재시작 요청 완료. 잠시 후 http://localhost:3010 에서 확인하세요."
} else {
    Write-Host "작업 시작 실패 — 아직 등록 전이면 먼저 scripts\install-task.ps1 을 실행하세요." -ForegroundColor Yellow
}
