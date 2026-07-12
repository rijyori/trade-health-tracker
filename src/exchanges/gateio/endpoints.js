// Gate.io USDT-M 무기한 선물(futures/usdt) 엔드포인트 카탈로그.
//
// 주의(실측, 2026-07-10): 기본 /futures/usdt/orders, /futures/usdt/my_trades는
// from/to 파라미터를 그냥 무시하고(문서에 파라미터로 정의돼 있지도 않음) offset 기반으로
// 최근 데이터만 준다 — 오프셋을 아무리 밀어도 계정의 "현재 유효 주문 목록" 범위(수십 건) 밖으로
// 못 나간다. 진짜 과거 조회는 별도 엔드포인트 orders_timerange/my_trades_timerange를 써야 하며,
// 이쪽은 from/to가 실제로 동작하고 기본 6개월(약 180일, account_book과 동일 한도)까지 지원한다.
export const ENDPOINTS = {
  ordersHistory: {
    path: '/futures/usdt/orders_timerange',
    description: '주문 내역 (시간 범위 조회, 최대 약 180일)',
    pagination: { type: 'offset' },
  },
  myTrades: {
    path: '/futures/usdt/my_trades_timerange',
    description: '체결 내역 (시간 범위 조회, 주문별 수수료 집계용)',
    pagination: { type: 'offset' },
  },
  positions: {
    path: '/futures/usdt/positions',
    description: '현재 포지션 (size=0인 미보유 계약도 함께 내려옴 — 반드시 필터링 필요)',
  },
  contracts: {
    path: '/futures/usdt/contracts',
    description: '계약 정보(공개, 인증 불필요) — quanto_multiplier(계약당 기초자산 수량) 확보용',
  },
};
