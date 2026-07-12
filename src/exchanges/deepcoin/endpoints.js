// Deepcoin 엔드포인트 카탈로그 — 이 프로젝트에 필요한 최소 세트만.
// orders-history에 pnl/fee/rebate가 이미 다 들어있어서(레퍼런스 ../deepcoin 세션 확인),
// Gate.io처럼 체결(fills)을 따로 묶어 fee를 합산할 필요가 없다.
export const ENDPOINTS = {
  ordersHistory: {
    path: '/deepcoin/trade/orders-history',
    description: '주문 히스토리 (체결/취소)',
    // 실측(2026-07-11, ../deepcoin 세션): 'before'는 이 엔드포인트에서 사실상 무시된다 —
    // 어떤 값을 보내도 항상 최근 limit개만 반환해서, 페이지를 계속 넘겨도 겹치는 데이터만
    // 온다. 그래서 이전엔 "10일치만 잡힌다"는 증상이 있었음 (client.js의 "짧은 페이지=끝"
    // 가정이 문제라고 오진단했었는데, 그건 원인이 아니었음 — 진짜 원인은 이 커서 파라미터
    // 자체였음). 'after'로 바꾸니 6개월치(723건, 중복 0, 마지막엔 진짜 빈 페이지로 자연
    // 종료)가 정상적으로 다 잡힘. 확정.
    pagination: { cursorParam: 'after', cursorField: 'ordId', type: 'cursor' },
  },
  positions: {
    path: '/deepcoin/account/positions',
    description: '현재 포지션 조회',
  },
  instruments: {
    path: '/deepcoin/market/instruments',
    description: '상품 정보 — ctVal(계약당 기초자산 수량) 확보용',
  },
};
