# trade-health-tracker — 멀티 거래소 매매 건전성/PNL 트래커

여러 거래소의 거래내역을 종합 연동해서, PNL·승률·수수료·리베이트 등 "매매 건전성" 통계를
한 대시보드에서 보는 프로젝트. 첫 타깃은 **Gate.io**, 이후 다른 거래소 추가 예정.
윈도우 PC 상시 구동(작업 스케줄러)을 상정.

## 반드시 먼저 읽을 것
1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — 검증된 레퍼런스 구현(`../deepcoin`)의 전체 아키텍처,
   도메인 로직, 거래소 어댑터 체크리스트, 실측 방법론, Pi 배포 노트. 이 프로젝트는 그 아키텍처를
   **멀티 거래소로 일반화**한 것입니다.
2. **[SESSION_LESSONS.md](SESSION_LESSONS.md)** — deepcoin 세션에서 실제로 겪은 구체적 버그/수치/
   디버깅 과정 다이제스트(레이트리밋 실측값, PNL GROSS 검증법, 리베이트 정산 역공학, 트레이드
   그룹핑 버그 등). 세션 기록 검색이 안 될 때를 대비한 로컬 사본이니 **이 파일이 항상 먼저
   확인 가능한 소스**입니다.

## 레퍼런스 구현
- `../deepcoin` — 단일 거래소(Deepcoin)용으로 완성·검증된 시스템. 이걸 베이스로 삼음.
- "왜 이렇게 짰는지"의 근거·수치는 대부분 [SESSION_LESSONS.md](SESSION_LESSONS.md)에 정리돼
  있으니 코드보다 그걸 먼저 볼 것. 참고 키워드: `rate limit`, `pnl GROSS`, `trade grouping`,
  `FIFO`, `win rate`, `rebate`, `UTC+8`, `cursor stuck`, `retention`, `Invalid IP`, `multi account`.

## 멀티 거래소 설계 원칙 (deepcoin 대비 추가 고려사항)
deepcoin은 단일 거래소라 어댑터 추상화가 암묵적이었음. 여기서는 **명시적 어댑터 경계**를 둘 것:

- **거래소 어댑터 인터페이스**: 각 거래소는 `{ auth, endpoints, client-config, field-mapping }`를
  구현. ARCHITECTURE.md §5 체크리스트가 그대로 어댑터가 채워야 할 슬롯 목록.
- **정규화 스키마(normalized)**: 각 거래소 원시 응답을 공통 orders/trades 스키마로 매핑해 저장.
  ARCHITECTURE.md §4.6의 orders_history 필드가 정규화 타깃. 거래소별 원시 필드는 `_raw`에 보존.
- **거래소 구분 컬럼**: deepcoin은 주문 ID가 전역 유일이라 계정 병합이 공짜였지만, **거래소가
  다르면 ID가 겹칠 수 있음.** 모든 테이블에 `exchange` 컬럼을 넣고 PK를 `(exchange, id)`
  복합키로 설계할 것. (§7의 멀티계정 병합 전제가 여기선 안 통함.)
- **거래소별 PNL 의미론 차이**: 어떤 거래소는 pnl이 NET일 수 있음. §5-5대로 **거래소마다 실측**해서
  정규화 시점에 GROSS로 통일해 저장(또는 gross/net 둘 다 저장).
- **거래소별 정산/타임존**: 리베이트 정산 주기·타임존이 제각각. 거래소별 메타로 관리.

## 도메인 코어 (거래소 무관 — deepcoin에서 그대로 가져옴)
ARCHITECTURE.md §6 참조. 정규화 스키마 위에서 동작하므로 거래소 수가 늘어도 로직은 하나:
- Net PNL = `pnl(GROSS) - ABS(fee) + rebate`
- 트레이드 그룹핑(포지션 생애주기 FIFO) → 트레이드 단위 승률/평균/베스트워스트
- 가변 빈 누적 PNL(시간축), 월별 풀그리드 캘린더

## 이번 프로젝트에서 뺄 것
- 수수료% 롤링 차트, 거래량(7d 롤링/일별) 차트 → **미사용**. 대시보드에서 생략.
- `/api/balance` + balance 테이블 → deepcoin에서도 죽은 코드였음. 처음부터 제외.

## 배포
윈도우 PC 상시 구동(작업 스케줄러). 로그온 시 `scripts/start.ps1`이 실행되어 GitHub 원격에
새 커밋이 있으면 `git pull`(+ 필요 시 `npm install`)한 뒤 `npm start`로 서버를 띄운다 —
업데이트 확인이 실패해도 기존 코드로 무조건 시작하도록 방어적으로 작성됨. 등록/해제는
`scripts/install-task.ps1` / `scripts/uninstall-task.ps1`. `PORT`+`0.0.0.0` 바인딩.
(원 레퍼런스 deepcoin의 Pi/pm2 배포 방법론은 ARCHITECTURE.md §10에 참고용으로 남아있음.)

## 작업 규칙
- 사용자는 한국어 존댓말. 프리뷰/스크린샷 도구를 임의로 켜지 말 것.
- 사용자가 띄워 쓰는 서버 프로세스를 임의로 kill하지 말 것.
- `.env`는 커밋 금지.

## 진행 상태
- [x] 프로젝트 스캐폴딩 (deepcoin 구조 기반 + exchange 컬럼/어댑터 경계)
- [x] Gate.io 어댑터 (auth → endpoints → field mapping, §11 순서)
- [x] Deepcoin 어댑터
- [x] 정규화 스키마 + 도메인 코어 이식
- [x] 대시보드 (수수료/거래량 차트 제외, 손실패턴/보유시간/PNL 분포 추가)
- [x] Windows 배포 (작업 스케줄러 + 자동 업데이트 스크립트)
