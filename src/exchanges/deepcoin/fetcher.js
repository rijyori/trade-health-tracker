import { apiGet, fetchAllPages } from './client.js';
import { ENDPOINTS } from './endpoints.js';

const INST_TYPE = 'SWAP';

async function fetchOrdersRaw(account) {
  const ep = ENDPOINTS.ordersHistory;
  const json = await fetchAllPages(ep.path, { instType: INST_TYPE }, {
    cursorField: ep.pagination.cursorField,
    cursorParam: ep.pagination.cursorParam,
    account,
  });
  return json;
}

async function fetchPositionsRaw(account) {
  const ep = ENDPOINTS.positions;
  const json = await apiGet(ep.path, { instType: INST_TYPE }, account);
  return json.data || [];
}

async function fetchInstrumentsRaw(account) {
  const ep = ENDPOINTS.instruments;
  const json = await apiGet(ep.path, { instType: INST_TYPE }, account);
  return json.data || [];
}

// Deepcoin(OKX 계열)은 이 프로젝트의 정규화 스키마와 필드명이 원래 거의 동일하다
// (스키마 자체를 deepcoin 기준으로 설계했으므로) — Gate.io처럼 별도 체결 합산/부호 역산이 필요 없다.
// state='filled'만 통계에 쓰이므로 나머지 상태도 그대로 저장은 하되 필터링은 server.js에서.
export function normalizeOrders(rawOrders) {
  return rawOrders.map(o => ({
    ordId: String(o.ordId),
    instId: o.instId,
    side: o.side,
    posSide: o.posSide,
    accFillSz: o.accFillSz,
    avgPx: o.avgPx,
    pnl: o.pnl,
    fee: o.fee,
    rebate: o.rebate || '0',
    ordType: o.ordType,
    state: o.state,
    cTime: String(o.cTime),
    uTime: String(o.uTime),
  }));
}

// 레퍼런스 프로젝트에서 accountPositions는 실제 열려있는 포지션만 반환하는 것으로 확인됐지만,
// Gate.io에서 겪은 "미보유 계약까지 다 옴" 버그 클래스를 방지하기 위해 방어적으로 한 번 더 필터링.
export function normalizePositions(rawPositions) {
  return rawPositions
    .filter(p => Number(p.pos) !== 0)
    .map(p => ({
      posId: String(p.posId),
      instId: p.instId,
      posSide: p.posSide,
      pos: p.pos,
      avgPx: p.avgPx,
      liqPx: p.liqPx,
      unrealizedProfit: p.unrealizedProfit,
      lastPx: p.lastPx,
      ccy: p.ccy,
    }));
}

export async function fetchAccountData(account) {
  const [rawOrders, rawPositions, rawInstruments] = await Promise.all([
    fetchOrdersRaw(account),
    fetchPositionsRaw(account),
    fetchInstrumentsRaw(account),
  ]);
  return {
    orders: normalizeOrders(rawOrders),
    positions: normalizePositions(rawPositions),
    userId: null, // Deepcoin API는 별도 계정 uid를 손쉽게 내려주는 필드가 없음(라벨로만 구분).
    instruments: rawInstruments.map(i => ({ instId: i.instId, multiplier: Number(i.ctVal) || 1 })),
  };
}

// 설정 화면에서 키 등록 시 유효성 확인용 — 포지션 조회 하나로 인증 여부 확인.
export async function verifyAccount(account) {
  await fetchPositionsRaw(account);
  return { userId: null };
}
