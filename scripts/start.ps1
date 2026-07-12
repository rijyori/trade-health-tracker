# Trade Health Tracker 시작 스크립트 (자동 업데이트 포함).
#
# 하는 일:
#   1) GitHub 원격에 새 커밋이 있는지 확인
#   2) 있으면 git pull 로 코드 갱신 + package.json 이 바뀌었으면 npm install
#   3) 서버 시작 (npm start = node src/server.js)
#
# 설계 원칙: "업데이트 실패해도 앱은 무조건 뜬다."
#   네트워크가 없거나 git/원격에 문제가 있어도, 업데이트 단계는 조용히 건너뛰고
#   기존 로컬 코드로 서버를 그대로 시작한다. (평소 쓰는 사람이 인터넷 때문에 못 켜면 안 됨)
#
# 경로는 이 스크립트 위치 기준으로 잡으므로 폴더를 어디로 옮겨도 동작한다.

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

Write-Host "=== Trade Health Tracker ==="
Write-Host "Project: $ProjectDir"

function Test-Cmd($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# --- 1) 자동 업데이트 (실패해도 계속 진행) ---
if ((Test-Cmd git) -and (Test-Path (Join-Path $ProjectDir '.git'))) {
    try {
        Write-Host "업데이트 확인 중..."
        git fetch --quiet 2>$null

        $branch = (git rev-parse --abbrev-ref HEAD 2>$null)
        $local  = (git rev-parse HEAD 2>$null)
        $remote = (git rev-parse "origin/$branch" 2>$null)

        if ($remote -and $local -ne $remote) {
            Write-Host "새 버전 발견 — 받아옵니다 ($branch)."
            # package.json 이 바뀌는지 미리 확인 (바뀌면 npm install 필요)
            $pkgChanged = (git diff --name-only HEAD "origin/$branch" 2>$null | Select-String 'package(-lock)?\.json')
            git pull --ff-only 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "업데이트 적용 완료."
                if ($pkgChanged) {
                    Write-Host "의존성 변경 감지 — npm install 실행."
                    npm install
                }
            } else {
                Write-Host "git pull 실패(로컬 변경 충돌 등) — 기존 코드로 시작합니다." -ForegroundColor Yellow
            }
        } else {
            Write-Host "이미 최신 버전입니다."
        }
    } catch {
        Write-Host "업데이트 확인 실패 — 기존 코드로 시작합니다. ($_)" -ForegroundColor Yellow
    }
} else {
    Write-Host "git 저장소가 아니거나 git 미설치 — 업데이트 건너뜀."
}

# --- 2) 의존성이 아예 없으면(최초 실행 등) 설치 ---
if (-not (Test-Path (Join-Path $ProjectDir 'node_modules'))) {
    Write-Host "node_modules 없음 — npm install 실행."
    npm install
}

# --- 3) 서버 시작 ---
Write-Host "서버 시작: npm start"
npm start
