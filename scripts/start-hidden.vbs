' 콘솔 창을 완전히 숨긴 채 start.ps1 을 실행하는 래퍼.
'
' 작업 스케줄러가 powershell.exe를 직접 부르면 -WindowStyle Hidden을 줘도 창이 잠깐 깜빡이거나,
' 자식으로 뜨는 node.exe 콘솔 창이 화면에 둥둥 떠 보인다. WScript.Shell.Run(cmd, 0, ...) 은
' 창 스타일 0(숨김)으로 프로세스를 띄워서 아예 창이 안 뜨게 한다.
' (딥코인 프로젝트에서 쓰던 것과 동일한 vbscript 래핑 방식.)
'
' 경로는 이 .vbs 파일 위치 기준으로 잡으므로 폴더를 어디로 옮겨도 동작한다.

Option Explicit
Dim shell, fso, scriptDir, ps1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\start.ps1"

cmd = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File """ & ps1 & """"

' 인자: (명령, 창스타일, 완료대기)
'  0    = 창 완전 숨김 (콘솔 안 뜸)
'  True = 서버가 떠 있는 동안 이 wscript 프로세스도 유지 → 작업이 '실행 중'으로 남아
'         restart.ps1 의 schtasks /end 로 트리째 종료가 가능해진다.
shell.Run cmd, 0, True
