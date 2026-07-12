# Exchange PNL Tracker — Transferable Architecture

이 문서는 **Deepcoin 거래내역 트래커**의 아키텍처를, 다른 거래소(예: Gate.io)로 이식 가능하도록
정리한 것입니다. 새 에이전트 세션은 이 문서를 먼저 읽고, 필요하면 원본 세션 기록을 검색해서
설계 의도와 시행착오를 참고하십시오.

---

## 0. 이 문서를 읽는 새 에이전트에게

- **레퍼런스 구현**: 로컬 사이드 프로젝트 `deepcoin`(단일 거래소용 완성본). 이 저장소와
  같은 상위 폴더에 나란히 두고 `../deepcoin`으로 참조.
- **설계 결정/디버깅 근거**: 대부분 [SESSION_LESSONS.md](SESSION_LESSONS.md)에 정리돼 있음.
  참고 키워드: `rate limit`, `cursor stuck`, `pnl GROSS`, `trade grouping`,
  `win rate`, `rebate`, `commission`, `UTC+8`, `retention`, `FIFO`.
- **핵심 원칙**: 이 시스템은 "매일 데이터만 새로고침하고, 쿼리는 하드코딩되어 있다"는 철학이다.
  사용자는 대시보드를 보고, 새 통계가 필요하면 에이전트에게 SQL/집계를 짜달라고 한다.
  즉 **분석 로직은 서버에 하드코딩**되고, 프론트는 얇은 렌더러다.
- 사용자는 한국어 존댓말을 쓰고 "주인님"이라고 부르길 원함(글로벌 CLAUDE.md 참조). 프리뷰/스크린샷
  도구를 임의로 켜지 말 것.

---

## 1. 무엇을 재사용하고 무엇을 새로 짜는가

이 시스템은 **거래소-중립 코어**와 **거래소-특화 어댑터**로 나뉜다. Gate.io 이식은 후자만
새로 구현하면 된다.

### 그대로 재사용 (거래소 중립)
- 전체 레이어 구조와 데이터 흐름
- SQLite 스키마 개념 (orders/fills/bills/positions/balance/instruments/sync_state)
- **PNL 의미론과 트레이드 그룹핑 로직** (§6 — 이게 이 프로젝트의 핵심 IP)
- 트레이드 단위 승률/평균손익 계산
- 누적 PNL 차트(가변 빈 + 시간축), 캘린더(월 네비 + 풀그리드)
- 멀티 계정 병합 (§7)
- 타임존 처리 (§8)
- HTTP 서버 라우팅 + 단일 HTML 대시보드 패턴
- 레이트리밋 실측 방법론, 리텐션/리베이트 검증 방법론 (§9)

### 반드시 새로 구현 (거래소 특화) — §5의 체크리스트 참조
- 인증 서명 방식 (HMAC prehash 포맷, 헤더 이름)
- 엔드포인트 경로 및 응답 스키마
- 필드 이름 매핑 (ordId/billId/pnl/fee/lever/posSide/cTime/accFillSz/avgPx…)
- 페이지네이션 방식 (cursor vs page)
- 엔드포인트별 레이트리밋 값
- PNL이 GROSS인지 NET인지 (Deepcoin은 GROSS = 가격차만, 수수료 미포함)
- 주문 ID의 전역 유일성 여부 (멀티계정 병합 안전성 판단)
- 리베이트/커미션 정산 규칙 (Deepcoin: 32%, T+1, UTC+8 경계)

---

## 2. 데이터 흐름 (한눈에)

```
.env (계정 크리덴셜 N개)
   │
   ▼
config.js ──► accounts[] 배열로 노출
   │
   ▼
[POST /api/refresh]  ← 브라우저가 페이지 로드 시 + Refresh 버튼 클릭 시 호출
   │
   ├─ 각 계정마다 병렬:
   │    fetcher.js ──► client.js (레이트리밋 스로틀 + 서명) ──► 거래소 REST API
   │      · 첫 동기화면 무제한, 이후엔 DB 최신 timestamp 이후만 증분 조회
   │
   ▼
storage/sqlite.js  ← 모든 계정 데이터를 같은 테이블에 upsert (ID 전역 유일 전제)
   │
   ▼
[GET /api/*]  ← 대시보드가 병렬로 호출, 서버에서 SQL/JS 집계
   │
   ▼
dashboard.html (단일 파일, Chart.js CDN, localStorage로 필터 상태 저장)
```

**핵심**: refresh는 서버가 거래소를 긁어 DB에 쌓는 단계, GET /api/*는 DB에서 집계해 뿌리는 단계.
둘은 완전히 분리돼 있다. 대시보드를 열면 (1) 캐시된 DB로 즉시 렌더 → (2) 백그라운드 refresh →
(3) 다시 렌더 순서로 동작한다.

---

## 3. 파일별 역할

| 파일 | 역할 | 거래소 특화도 |
|---|---|---|
| `src/config.js` | `.env`에서 계정 N개(`_2`,`_3`,`_4` 접미사) 로드 → `accounts[]` | 낮음 |
| `src/auth.js` | HMAC 서명 + 인증 헤더 생성 | **높음 (재구현)** |
| `src/endpoints.js` | 엔드포인트 경로/페이지네이션 방식 카탈로그 | **높음 (재구현)** |
| `src/client.js` | 레이트리밋 스로틀, 서명 호출, 커서/페이지 페이지네이션 | 중간 (스로틀 값·커서 필드) |
| `src/fetcher.js` | 엔드포인트별 fetch 래퍼 (instType, credentials 전달) | 중간 |
| `src/storage/sqlite.js` | 테이블 정의 + upsert 함수 + sync_state | 낮음 (필드명만) |
| `src/server.js` | HTTP 서버 + 모든 분석 API + refresh 오케스트레이션 | 중간 (집계는 중립, WHERE절 필드명만) |
| `src/dashboard.html` | 단일 파일 UI (Chart.js, 필터, 캘린더, 테이블) | 낮음 |
| `src/index.js` | CLI (fetch/stats/query) — 대시보드 없이 터미널용. 선택적. | 낮음 |
| `src/stats.js` | CLI용 통계 함수. 대시보드 안 쓰면 무시 가능. | 낮음 |

---

## 4. 레이어 상세

### 4.1 config.js — 멀티 계정 로딩
```
'', '_2', '_3', '_4' 접미사를 순회하며 DEEPCOIN_API_KEY{suffix} 등이 다 있으면 accounts[]에 push.
각 account = { label, apiKey, secretKey, passphrase }.
.env의 DEEPCOIN_LABEL_2 같은 값으로 사람이 읽을 라벨 지정.
```
Gate.io 이식 시: 접두어를 `GATEIO_`로 바꾸고, Gate.io가 요구하는 크리덴셜 필드(예: passphrase가
없을 수도 있음)에 맞춰 조정.

### 4.2 auth.js — 서명 (거래소마다 완전히 다름)
Deepcoin 방식:
```
prehash = timestamp + METHOD.toUpperCase() + requestPath + body
sign    = base64( HMAC-SHA256(secretKey, prehash) )
timestamp = new Date().toISOString()   // ISO 8601
headers = {
  'DC-ACCESS-KEY': apiKey,
  'DC-ACCESS-SIGN': sign,
  'DC-ACCESS-TIMESTAMP': timestamp,
  'DC-ACCESS-PASSPHRASE': passphrase,
}
```
**Gate.io는 서명 스킴이 다르다.** (Gate.io v4는 보통:
`SIGN = HMAC-SHA512(secret, method + "\n" + path + "\n" + query + "\n" + SHA512(body) + "\n" + ts)`,
헤더는 `KEY`/`SIGN`/`Timestamp`). 반드시 Gate.io 공식 문서로 재구현하고, 단일 잔고 조회로
200을 받아 검증할 것. (이식 시 §9의 "실측 스크립트" 패턴 사용)

### 4.3 endpoints.js — 엔드포인트 카탈로그
각 엔드포인트를 `{ path, description, params, pagination }`로 선언.
`pagination.type`은 `'cursor'`(before/after + 커서필드) 또는 `'page'`(page/size) 또는 없음(단건).
Deepcoin 예:
```
ordersHistory: { path:'/deepcoin/trade/orders-history',
  pagination:{ type:'cursor', cursorParam:'after', cursorField:'ordId' } }
```
**주의**: Deepcoin의 `orders-history`/`trade/fills`는 `cursorParam`이 `'before'`면 커서가
사실상 무시되고 매번 최근 limit개만 반환한다(실측 확정, SESSION_LESSONS.md §3/§14 참조).
반드시 `'after'`를 쓸 것 — 새 거래소를 붙일 때도 "커서를 바꿔가며 새 데이터가 실제로 오는지"
(`limit`을 바꿔 distinct 개수와 비교하는 게 가장 빠름)를 먼저 확인하고 결정할 것.

### 4.4 client.js — 레이트리밋 + 페이지네이션
- **엔드포인트별 레이트리밋**: `RATE_LIMITS` 맵. Deepcoin 실측값 = trade/account 계열 5/s,
  balance/positions/instruments 10/s. **전역 1/s 아님** (초기엔 그렇게 오해했음 — 세션기록 참조).
- **스로틀 키 = `apiKey::path`**: 계정별·엔드포인트별로 독립 버킷. 계정이 다르면 병렬로 나감.
  (레이트리밋은 계정별로 독립이므로.)
- `apiGet(path, params, credentials)`: 서명 → fetch → `code !== '0'`이면 throw.
- `fetchAllPages`: 커서 페이지네이션. **커서 stuck 감지** — 마지막 레코드의 커서가 직전과
  같으면 중단(Deepcoin이 데이터 소진 후 같은 커서를 무한 반복하는 버그 회피).
- `fetchAllPagesBased`: page/size 페이지네이션.

### 4.5 fetcher.js — 래퍼
`fetchOrderHistory(instType, extraParams, credentials)` 형태. `credentials`를 client까지 전달.
증분 조회용 `begin=` 파라미터 등을 `extraParams`로 넘김.

### 4.6 storage/sqlite.js — 저장
- better-sqlite3, WAL 모드, 동기 API.
- 테이블: `orders_history`, `trade_fills`, `account_bills`, `positions`, `balance`,
  `instruments`, `sync_state`.
- upsert = `INSERT OR REPLACE`. **PK는 거래소 ID 단독**(ordId/billId). 멀티계정이라도
  ID가 전역 유일하면 그대로 병합 가능(§7).
- `positions`는 스냅샷이 아니라 **매 refresh마다 DELETE 후 현재 상태로 전량 교체**
  (`replacePositions`). 포지션이 없으면 빈 배열로 교체 → 유령 포지션 방지.
- `sync_state(label, firstSyncAt)`: 계정별 최초 동기화 완료 여부. 신규 계정의 첫 풀백필 판단용.

**핵심 스키마 필드 (orders_history)** — 분석이 여기에 의존:
```
ordId(PK), instId, instType, ordType, side, posSide, lever,
accFillSz(체결수량), avgPx(평균체결가), px, sz,
pnl(★GROSS: 가격차만, 수수료 미포함), fee(음수로 저장될 수 있음, ABS로 사용),
rebate, rebateCcy, state('filled' 등), cTime(생성ms), uTime
```
Gate.io 이식 시 이 필드들에 대응하는 Gate.io 필드를 매핑 테이블로 정리해 저장할 것.

**필터링 시 `state` 문자열을 믿지 말 것**: `WHERE state = 'filled'`로 걸러야 할 것 같지만,
부분체결 후 취소된 주문(`partially_filled_canceled` 등)은 실제 체결 수량·실현손익이 있는데도
`state`가 정확히 `'filled'`가 아니라서 빠진다(실제로 겪은 버그, SESSION_LESSONS.md §11).
**`WHERE CAST(accFillSz AS REAL) > 0`으로 필터링할 것** — 상태 문자열이 아니라 실제 체결
수량이 진짜 기준.

### 4.7 server.js — 분석 API (대부분 재사용)
`routes` 맵에 `'METHOD /path': handler`. 각 handler는 `params`를 받아 JS 객체 반환 →
자동 JSON 직렬화. `buildWhere(params)`가 공통 필터(from/to/lever 배열) SQL 생성.
**모든 datetime은 KST**: `datetime(CAST(cTime AS REAL)/1000 + 32400, 'unixepoch')` (§8).

주요 엔드포인트 (★ = 코어, 나머지는 부가):
- ★`/api/summary` — Net/Gross PNL, **트레이드 단위** 승률/평균/베스트워스트, 총수수료, 리베이트
- ★`/api/recent-trades` — 포지션 생애주기별 집계 (§6)
- ★`/api/recent-closes` — 개별 청산별 net (엔트리 수수료 FIFO 배분)
- ★`/api/recent-orders` — 원시 주문 최근순
- ★`/api/cumulative-pnl` — 가변 빈 누적 곡선 (§6.3)
- ★`/api/calendar?month=YYYY-MM` — 월별 캘린더 (풀그리드, §6.4)
- `/api/data-bounds` — 데이터 최초 월(캘린더 네비 경계용)
- `/api/levers` — 존재하는 레버리지 목록(필터 UI용)
- `/api/positions` — 현재 오픈 포지션
- `/api/daily`, `/api/volume`, `/api/fee-pct-rolling`, `/api/fee-breakdown`
  — **수수료/거래량 그래프용. 이 프로젝트에선 안 쓸 예정이라 이식 시 스킵 가능.**
- `POST /api/refresh` — §7의 멀티계정 오케스트레이션

### 4.8 dashboard.html — UI
- 단일 파일. Chart.js는 CDN. `chartjs-adapter-date-fns`도 CDN(시간축용).
- 필터/토글 상태는 **localStorage**에 저장(`dc_levers`, `dc_pnl_toggles`,
  `dc_pnl_timeframe`). 새로고침해도 유지.
- `loadAll()`이 모든 GET을 `Promise.all`로 병렬 호출 후 각 렌더 함수 호출.
- 레버리지 필터/타임프레임 선택기는 leverage filter처럼 클릭형 가로 태그(라디오/체크박스 + label).

---

## 5. 거래소 어댑터 체크리스트 (Gate.io 이식 시 이것부터)

새 거래소를 붙일 때 **반드시 실측으로 확인**해야 하는 항목. 문서만 믿지 말고 §9의 스크립트로
직접 응답을 찍어볼 것.

1. **인증**: 서명 알고리즘(SHA256/512), prehash 조립 순서, 헤더 이름, timestamp 포맷(ISO vs epoch).
   → 잔고 조회로 200 확인.
2. **엔드포인트 경로**: 주문내역/체결/원장/포지션/잔고/상품정보. Gate.io는 spot/futures/delivery가
   경로부터 다름.
3. **페이지네이션**: 커서(before/after/last_id) vs 페이지(page/limit) vs 시간범위(from/to).
   무한루프/커서 stuck 케이스 확인.
4. **레이트리밋**: 응답 헤더의 `x-ratelimit-limit`류를 찍어서 엔드포인트별 실측(§9). 계정별 독립인지도.
5. **PNL 의미론**: 청산 pnl이 GROSS인지 NET인지. **실제 체결가로 역산해 검증**(가격차×수량×배수 vs pnl).
   Deepcoin은 GROSS였음. 이게 틀리면 모든 net 계산이 어긋남.
6. **필드 매핑**: §4.6의 orders_history 필드에 대응하는 Gate.io 필드명.
   특히 "엔트리 vs 청산" 구분법(Deepcoin은 `pnl===0`이면 엔트리) — Gate.io는 별도 플래그가
   있을 수 있음(reduce_only, is_close 등). 이 구분이 §6 트레이드 그룹핑의 전제.
7. **수량/명목가치 단위**: Deepcoin은 계약 단위라 `accFillSz × avgPx × ctVal(instrument별)`로
   명목 거래량 계산. Gate.io는 단위 체계가 다름(size가 코인수/계약수/명목 중 무엇인지 확인).
8. **주문 ID 전역 유일성**: 멀티계정 병합 안전성(§7)의 전제. 시간순 단조증가 시퀀스면 안전.
   아니면 테이블에 `account` 컬럼 추가하고 복합 PK로 변경 필요.
9. **리베이트/커미션 정산**: 비율, 정산 주기(T+1?), 날짜 경계 타임존. 조회 API 존재 여부.
10. **데이터 리텐션**: 조회 API가 과거 어디까지 주는지(Deepcoin은 최근 구간만). 이게 짧으면
    "매일 refresh로 누적 저장"이 유일한 풀히스토리 확보 수단이 됨.

---

## 6. 코어 도메인 로직 (거래소 중립 — 그대로 옮길 것)

### 6.1 PNL 기본 공식
```
Gross PNL   = pnl                       (거래소가 준 값, GROSS = 가격차만)
Net PNL     = pnl - ABS(fee) + rebate   (수수료 차감, 리베이트 가산)
```
- **엔트리 주문은 pnl=0** (포지션 여는 건 손익 확정이 아님). 수수료만 발생.
- **청산 주문은 pnl≠0**. 여기에 확정 손익이 실림.
- `fee`는 음수로 저장될 수 있으니 항상 `ABS()`.

### 6.2 트레이드 그룹핑 (`computeTrades` in server.js — 이 프로젝트의 심장)
개별 주문(row)이 아니라 **포지션 생애주기**를 하나의 "트레이드"로 묶는다.
왜? 부분익절 20번이면 승리가 20으로 뻥튀기되고, 본절 잔량정리가 손실로 오카운트되기 때문.

알고리즘:
```
1. (instId, posSide)로 그룹핑, 시간순 정렬.
2. 각 그룹에서 FIFO 큐로 엔트리 물량을 쌓음 (pnl===0 인 주문 = 엔트리, 수량·단위수수료 push).
3. 청산 주문(pnl≠0)이 오면:
     - 그 수량만큼 FIFO 큐에서 엔트리 물량을 꺼내며 엔트리수수료를 비례 배분.
     - trade에 grossPnl/entryFee/exitFee/rebate/closeCount/closedSize 누적.
     - openQty(열린 수량)를 차감.
4. openQty가 0이 되면 → 한 트레이드 완성, push (open=false).
5. 그룹 끝까지 갔는데 openQty가 남으면 → 아직 실현된 부분만 flush.
     · 단, 진짜 오픈인지는 라이브 positions 테이블과 대조(openKeys)해서 판단.
       (우리 주문내역에 리텐션 갭이 있으면 사이즈가 안 맞아 가짜 "오픈"이 생기므로.)
6. netPnl = grossPnl - entryFee - exitFee + rebate.
```
**엔트리 수수료 FIFO 배분**이 핵심: 청산된 물량이 "어느 엔트리에서 나왔는지" 매칭해서 그 엔트리의
수수료를 net에 반영. 엔트리 데이터가 부족하면(리텐션 갭) 그룹 평균 수수료율(`fallbackRate`)로 보정.

이 로직은 `computeTrades`(집계용), `apiRecentTrades`(트레이드 테이블), `apiRecentCloses`(청산별),
`apiSummary`(승률/평균) 네 곳에서 재사용됨.

### 6.3 누적 PNL — 가변 빈 + 시간축
- 타임프레임(all/1Y/90/60/30/7/custom) 내에서 **전체 구간을 1000개 빈으로 균등 분할**
  (`binMs = ceil((maxT-minT+1)/1000)`). 데이터 row 기준이 아니라 **시간 기준** 빈.
- 각 빈의 pnl 합을 누적. 프론트는 Chart.js `type:'time'` 축으로 렌더 →
  **거래 없는 밤 시간대는 시각적으로 빈 간격**으로 보임(균등 간격 아님).
- 선은 직선(`tension:0`), 시작 0(`beginAtZero`). Net 기본, Gross/Expected는 토글.

### 6.4 캘린더 — 월별 풀그리드
- `/api/calendar?month=YYYY-MM`. 해당 월의 첫날이 속한 주 일요일 ~ 말일이 속한 주 토요일까지
  **모든 칸을 실제 데이터로 채움**(빈칸 없음). 인접월 날짜는 `inMonth=0`으로 표시(프론트에서 흐리게).
- 네비: `«`(최초데이터월) `‹`(이전달) `›`(다음달) `»`(이번달). 데이터 경계(`/api/data-bounds`의
  minMonth) 밖으로는 버튼 비활성화.
- 각 칸: 일손익(net), 진입 수(entries), 수수료% 바. **진입만 있는 날은 수수료%를 그리지 않음**
  (absGross=0이면 100%로 왜곡되므로).

### 6.5 승률 (트레이드 단위)
`winCount = 트레이드 중 netPnl>0 개수`, `lossCount = netPnl<0`. `winRate = win/totalTrades`.
**절대 주문 row 기준으로 세지 말 것** (부분익절/분할손절로 뻥튀기/디플레).

---

## 7. 멀티 계정 병합

전제: **주문 ID가 거래소 전역에서 유일**(Deepcoin은 시간순 단조증가 스노우플레이크형).
→ 계정 태깅 없이 같은 테이블에 그냥 병합. PK 충돌 없음.

`apiRefresh` 흐름:
```
for each account (병렬, Promise.all):
    firstSync = !hasSynced(label)
    - firstSync면 begin= 없이 무제한 조회 (신규 계정 풀백필)
      · 왜? 서브계정 과거 거래는 다른 계정의 최신 커서보다 오래됐으므로,
        공유 증분 커서를 쓰면 통째로 스킵됨.
    - 아니면 DB의 MAX(cTime)/MAX(ts) 이후만 증분 조회.
    각 계정 내에서도 instruments/orders/fills/bills/positions/balance를 Promise.all 병렬
      (엔드포인트별 독립 레이트리밋 버킷 + 계정별 독립 쿼터).
    markSynced(label).
저장은 순차 (SQLite 동기). positions만 전 계정 flat_map으로 모아 한 번에 replace.
```
ID가 유일하지 않은 거래소면: 모든 테이블에 `account` 컬럼 추가 + 복합 PK로 변경.

---

## 8. 타임존

- 사용자 기준 KST(UTC+9). 모든 SQL datetime 계산에 **`+ 32400`초**.
  `datetime(CAST(cTime AS REAL)/1000 + 32400, 'unixepoch')`.
- SQLite `datetime('now')`는 UTC이므로 "오늘" 계산도 `datetime('now','+32400 seconds')`.
- **주의**: 거래소 정산 타임존은 KST와 다를 수 있음. Deepcoin 커미션은 **UTC+8 경계, T+1 정산**
  이었음(§9의 리베이트 검증에서 발견). 이식 시 정산 타임존은 별도로 실측할 것.

---

## 9. 실측/검증 방법론 (재사용 가치 높음)

문서를 믿지 말고 스크래치 스크립트로 라이브 응답을 찍는 패턴. `.env`를 직접 파싱하는 독립 mjs를
scratchpad에 만들어 실행(프로젝트 코드 수정 없이 탐색).

- **레이트리밋 실측**: 같은 엔드포인트에 동시 요청 N개(`Promise.all`)를 쏴서 429가 날 때까지
  올린 뒤, 응답 헤더의 `x-ratelimit-limit` / `x-ratelimit-window`를 읽음. 또는 단건 요청의
  응답 헤더만 봐도 대부분 리밋이 찍힘.
- **PNL GROSS 검증**: 청산 주문의 실제 체결가·수량으로 (청산가-진입가)×수량×배수를 계산해서
  `pnl` 필드와 비교. 일치하면 GROSS(수수료 미포함).
- **리베이트/정산 검증**: 커미션 계좌 입금 내역(수동 확보)과 우리 일별 수수료를 날짜 매칭.
  타임존 오프셋(+7~+9)과 시차(lag 0/1일)를 iterate하며 비율이 가장 안정적으로 상수(예: 0.32)에
  수렴하는 조합을 찾음 → 정산 규칙 역공학. (Deepcoin = UTC+8, T+1, 32%.)
- **리텐션 한계 확인**: 커서를 끝까지 밀어서 조회 API가 실제로 과거 어디까지 주는지 페이지네이션.
- **엔드포인트 probing**: 추측 경로 여러 개를 순회 요청해 200/404로 존재 여부 확인.

원본 세션 기록에 이 스크립트들의 실제 코드와 결과가 다 있음. 검색해서 재활용할 것.

---

## 10. 라즈베리파이 배포 노트

- **Node**: Pi에는 nvm으로 Node가 설치돼 있음(예: v22.20.0). `bash -lc`(로그인쉘)로는 nvm 로더가
  안 잡힐 수 있으니 `bash -ic`(인터랙티브쉘)로 확인하거나 nvm을 명시적으로 source할 것.
  **함부로 `apt install nodejs`로 시스템 전역 설치하지 말 것** (과거에 이걸로 사고 남).
- **better-sqlite3**: 네이티브 모듈. ARM에서 prebuilt가 없으면 `node-gyp`로 컴파일 →
  `build-essential`, `python3` 필요. 설치 느릴 수 있음. 대안: ARM prebuilt 확인, 또는 Node 버전을
  prebuilt 있는 버전에 맞추기.
- **포트**: 서버는 `PORT` env로 포트 지정 가능(기본 3000). Pi에서 다른 기기가 접속하려면
  `server.listen(PORT, '0.0.0.0')` 확인 및 방화벽 개방.
- **상시 구동**: `pm2` 또는 systemd 유닛으로 데몬화. WAL 모드 SQLite는 단일 프로세스 쓰기라
  refresh 동시성만 `refreshing` 플래그로 막으면 됨(이미 구현됨).
- **크리덴셜**: `.env`는 절대 커밋 금지(`.gitignore`에 포함). IP 화이트리스트 바인딩된 키는
  Pi의 공인 IP로 갱신 필요(공유기 바뀌면 `Invalid IP` 남 — 실제로 겪음).

---

## 11. Gate.io 이식 순서 (권장)

1. 이 문서 + 원본 세션 기록 정독. `deepcoin` 프로젝트를 복사해 `gateio`로 리네임.
2. §9 스크립트로 Gate.io 인증부터 뚫기(잔고 200 확인). `auth.js` 재구현.
3. §5 체크리스트를 하나씩 실측하며 `endpoints.js` / `client.js`(레이트리밋·페이지네이션) 채우기.
4. **PNL GROSS/NET, 엔트리/청산 구분법, ID 유일성**을 실측으로 확정(가장 중요, 여기 틀리면 전부 어긋남).
5. `storage/sqlite.js`의 필드를 Gate.io 필드로 매핑(스키마 개념은 유지).
6. `server.js`의 **§6 코어 로직(computeTrades/summary/cumulative/calendar)은 거의 그대로**,
   `buildWhere`와 필드명만 조정.
7. 수수료/거래량 그래프(`/api/daily`,`/api/volume`,`/api/fee-*`)는 **안 쓸 예정이니 생략**.
   대시보드에서도 해당 chart-row 제거.
8. 멀티계정(§7)은 ID 유일성 확인 후 그대로. 아니면 account 컬럼 추가.
9. §10대로 Pi 배포.

---

## 부록: 안 쓰기로 한 것 / 죽은 코드
- `/api/balance` + `balance` 테이블: 밸런스는 어떤 통계에도 안 쓰임(스냅샷만 쌓임). 대시보드
  카드도 제거됨. DB 저장 로직은 남겨둠(나중을 위해). Gate.io에선 처음부터 빼도 됨.
- 수수료% 롤링, 거래량(7d 롤링/일별) 차트: 이번 프로젝트에선 미사용 예정.
- `src/index.js` / `src/stats.js` (CLI): 대시보드로 대체됨. 유지보수 대상 아님.
