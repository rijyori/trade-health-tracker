import { apiGet, fetchAllPagesOffset } from './client.js';
import { ENDPOINTS } from './endpoints.js';

// account_book 실측 한도(180일)와 동일 — orders_timerange/my_trades_timerange도 기본
// 6개월(약 180일)까지만 지원. 안전하게 179일로 잡는다.
const MAX_HISTORY_DAYS = 179;

function historyWindow() {
  const to = Math.floor(Date.now() / 1000);
  const from = to - MAX_HISTORY_DAYS * 86400;
  return { from, to };
}

async function fetchOrdersRaw(account) {
  const ep = ENDPOINTS.ordersHistory;
  return fetchAllPagesOffset(ep.path, historyWindow(), { account });
}

async function fetchTradesRaw(account) {
  const ep = ENDPOINTS.myTrades;
  return fetchAllPagesOffset(ep.path, historyWindow(), { account });
}

async function fetchPositionsRaw(account) {
  const ep = ENDPOINTS.positions;
  return apiGet(ep.path, {}, account);
}

// 공개 엔드포인트(인증 불필요하지만 그냥 서명해서 호출해도 무방) — 계약당 기초자산 수량
// (quanto_multiplier)을 가져온다. closedSize×avgPx만으로는 명목가치가 안 나오는 계약이
// 있어서(예: BTC_USDT는 1계약=0.0001BTC) 손실 패턴 분석(%수익률)에 필요.
async function fetchContractsRaw(account) {
  const ep = ENDPOINTS.contracts;
  return apiGet(ep.path, {}, account);
}

// Gate.io는 posSide(long/short) 개념이 없는 단일 포지션 모드(mode:'single')를 쓴다. 방향은
// 오직 size 부호로만 알 수 있다:
//   - 엔트리(is_reduce_only=false): size>0=롱 오픈, size<0=숏 오픈
//   - 청산(is_reduce_only=true):    size<0=롱 청산(매도로 닫음), size>0=숏 청산(매수로 닫음)
// 즉 "포지션 방향"은 부호가 아니라 엔트리/청산 여부에 따라 부호 해석이 뒤집힌다.
function derivePosSide(size, isReduceOnly) {
  if (isReduceOnly) return size < 0 ? 'long' : 'short';
  return size > 0 ? 'long' : 'short';
}

// 주문(orders)에는 pnl은 있지만 절대 수수료 금액이 없다(mkfr/tkfr는 요율일 뿐).
// 체결(my_trades)의 fee를 order_id로 묶어 합산해서 주문별 fee를 만든다.
function buildFeeByOrderId(trades) {
  const feeByOrderId = new Map();
  for (const t of trades) {
    const key = String(t.order_id);
    feeByOrderId.set(key, (feeByOrderId.get(key) || 0) + Number(t.fee || 0));
  }
  return feeByOrderId;
}

// deepcoin(OKX 계열) 스키마와 동일한 컬럼명으로 정규화 — server.js의 코어 로직(computeTrades 등)을
// 그대로 재사용하기 위함. exchange 컬럼은 storage 레이어에서 추가.
export function normalizeOrders(rawOrders, rawTrades) {
  const feeByOrderId = buildFeeByOrderId(rawTrades);
  return rawOrders.map(o => {
    const size = Number(o.size);
    const ordId = String(o.id);
    return {
      ordId,
      instId: o.contract,
      side: size > 0 ? 'buy' : 'sell',
      posSide: derivePosSide(size, o.is_reduce_only),
      // o.size는 "주문 요청 수량"이지 실제 체결량이 아니다 — 부분체결 후 취소된 주문은
      // size != left(잔량)라서 abs(size)를 그대로 쓰면 실제보다 부풀려진다(딥코인에서 실제로
      // 겪은 state='filled' 필터 버그와 같은 클래스). abs(size)-abs(left)가 진짜 체결량.
      accFillSz: Math.abs(size) - Math.abs(Number(o.left || 0)),
      avgPx: o.fill_price,
      pnl: o.pnl,
      fee: String(feeByOrderId.get(ordId) || 0),
      rebate: '0', // Gate.io 리베이트/커미션 정산 규칙 미확인 — 확인되면 갱신할 것.
      ordType: o.tif,
      state: o.finish_as === 'filled' ? 'filled' : o.finish_as,
      cTime: String(Math.round(Number(o.create_time) * 1000)), // 초 -> ms (deepcoin 스키마와 단위 맞춤)
      uTime: String(Math.round(Number(o.update_time) * 1000)),
    };
  });
}

// size=0(미보유 계약)까지 전부 내려오므로 진짜 열려있는 포지션만 남긴다.
// (안 그러면 트레이드 그룹핑의 "라이브 포지션과 대조" 로직이 전부 open으로 오판)
export function normalizePositions(rawPositions) {
  return rawPositions
    .filter(p => Number(p.size) !== 0)
    .map(p => {
      const size = Number(p.size);
      return {
        posId: `${p.contract}`,
        instId: p.contract,
        posSide: size > 0 ? 'long' : 'short',
        pos: String(Math.abs(size)),
        avgPx: p.entry_price,
        liqPx: p.liq_price,
        unrealizedProfit: p.unrealised_pnl,
        lastPx: p.mark_price,
        ccy: 'USDT',
      };
    });
}

// positions 응답은 계약 전체 목록을 늘 내려주므로(§ normalizePositions 주석) 빈 배열일 일이
// 없고, 모든 row에 Gate.io 계정 고유 숫자 user id가 찍혀 있다 — 별도 API 호출 없이 여기서 얻는다.
// .env의 라벨은 사람이 바꿀 수 있어 계정 식별자로 못 믿지만, userId는 거래소가 부여한 값이라
// 안정적 식별에 쓴다.
function extractUserId(rawPositions) {
  return rawPositions[0]?.user != null ? String(rawPositions[0].user) : null;
}

export async function fetchAccountData(account) {
  const [rawOrders, rawTrades, rawPositions, rawContracts] = await Promise.all([
    fetchOrdersRaw(account),
    fetchTradesRaw(account),
    fetchPositionsRaw(account),
    fetchContractsRaw(account),
  ]);
  return {
    orders: normalizeOrders(rawOrders, rawTrades),
    positions: normalizePositions(rawPositions),
    userId: extractUserId(rawPositions),
    instruments: rawContracts.map(c => ({ instId: c.name, multiplier: Number(c.quanto_multiplier) || 1 })),
  };
}

// 설정 화면에서 새 키를 등록할 때, 저장하기 전에 실제로 유효한 키인지 확인하고 userId를 즉시
// 얻기 위한 가벼운 호출 (positions 하나면 인증 여부 + userId 둘 다 확인 가능, 별도 엔드포인트 불필요).
export async function verifyAccount(account) {
  const rawPositions = await fetchPositionsRaw(account);
  return { userId: extractUserId(rawPositions) };
}
