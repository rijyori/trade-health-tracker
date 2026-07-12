# Trade Health Tracker를 윈도우 작업 스케줄러에 등록한다.
# 로그온 시 scripts\start-hidden.vbs 를 실행 — vbs가 콘솔 없이 start.ps1을 띄우고,
# start.ps1이 업데이트 확인 후 서버를 시작한다. (node.exe 콘솔 창이 안 뜨게 하려는 래핑)
#
# schtasks 대신 ScheduledTasks 모듈(Register-ScheduledTask)을 쓰는 이유:
#   schtasks 커맨드라인엔 "실행시간 제한"을 끄는 옵션이 없어서, 기본값(보통 3일) 때문에
#   상시 구동 서버가 3일마다 강제 종료된다. 여기선 ExecutionTimeLimit=0(무제한)으로 등록해
#   그 문제를 없앤다. 이 설정은 시스템 전역이 아니라 **이 작업 하나에만** 적용된다.
#
# 경로는 이 스크립트 위치 기준으로 잡으므로 폴더를 어디로 옮겨도 그대로 다시 실행하면 된다.

$ErrorActionPreference = 'Stop'
$TaskName = 'TradeHealthTracker'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$VbsScript = Join-Path $ProjectDir 'scripts\start-hidden.vbs'

if (-not (Test-Path $VbsScript)) {
    Write-Error "start-hidden.vbs를 찾을 수 없습니다: $VbsScript`n이 스크립트는 프로젝트 폴더 안의 scripts\install-task.ps1 위치 그대로 실행해야 합니다."
    exit 1
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "node를 찾을 수 없습니다. Node.js를 먼저 설치하고 새 터미널에서 다시 실행하세요."
    exit 1
}

Write-Host "Node.js: $($NodeCmd.Source)"
Write-Host "Project: $ProjectDir"

# 로그온 시 wscript로 start-hidden.vbs 실행 → 콘솔 창 없이 서버 시작(자동 업데이트 포함).
$Action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B `"$VbsScript`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
# ExecutionTimeLimit 0 = 무제한(상시 구동), 배터리로 꺼지지 않게 + 배터리에서도 시작 허용.
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
# 로그인한 사용자로, 로그온 중일 때만, 제한 권한(관리자 아님)으로 실행.
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# 이미 등록돼 있으면 덮어쓰기(-Force) — 몇 번을 다시 실행해도 안전.
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Principal $Principal -Force | Out-Null

Write-Host ""
Write-Host "등록 완료 — 다음 로그온부터 자동으로(콘솔 창 없이) 서버가 시작됩니다."
Write-Host "실행시간 제한: 무제한 (3일 강제 종료 없음)."
Write-Host ""
Write-Host "지금 바로 시작합니다..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
Write-Host "서버를 백그라운드로 시작했습니다. http://localhost:3010 에서 확인하세요."
