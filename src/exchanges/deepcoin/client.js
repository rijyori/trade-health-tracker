import { buildHeaders } from './auth.js';

// 레퍼런스 ../deepcoin 프로젝트에서 실측한 값(엔드포인트별 레이트리밋, 전역 1/s 아님).
const RATE_LIMITS = {
  '/deepcoin/trade/orders-history': 5,
  '/deepcoin/account/positions': 10,
  '/deepcoin/market/instruments': 10,
};
const DEFAULT_LIMIT = 1;
const SAFETY_MARGIN_MS = 60;

const lastRequestTimes = new Map();

async function throttle(throttleKey, path) {
  const limit = RATE_LIMITS[path] || DEFAULT_LIMIT;
  const minInterval = Math.ceil(1000 / limit) + SAFETY_MARGIN_MS;
  const last = lastRequestTimes.get(throttleKey) || 0;
  const now = Date.now();
  const elapsed = now - last;
  if (elapsed < minInterval) {
    await new Promise(r => setTimeout(r, minInterval - elapsed));
  }
  lastRequestTimes.set(throttleKey, Date.now());
}

export async function apiGet(path, params = {}, account) {
  await throttle(`${account.apiKey}::${path}`, path);

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
  }
  const queryStr = query.toString();
  const fullPath = queryStr ? `${path}?${queryStr}` : path;
  const url = `${account.baseUrl}${fullPath}`;

  const headers = buildHeaders(account.apiKey, account.secretKey, account.passphrase, 'GET', fullPath);

  const res = await fetch(url, { headers });
  const json = await res.json();
  if (!res.ok || (json.code !== '0' && json.code !== 0)) {
    throw new Error(`API ${res.status}: code=${json.code} msg=${json.msg || ''}`);
  }
  return json;
}

// 커서 stuck 감지 포함(레퍼런스 세션에서 겪은 무한루프 버그 — 마지막 커서가 직전과 같으면 중단).
//
// [정정: 2026-07-10 커밋의 아래 진단은 오진단이었음, 2026-07-11 재조사로 원인 확정]
// 2026-07-10엔 "요청한 개수보다 적게 오면 마지막 페이지"라는 가정이 문제라고 봤었는데,
// 진짜 원인은 그게 아니었다. **`before` 커서 파라미터가 orders-history/trade/fills
// 엔드포인트에서 사실상 무시된다** — 어떤 값을 보내도 매번 최근 limit개짜리 응답을 돌려주고,
// 페이지를 계속 넘길수록 그 응답이 조금씩 겹치며 줄어드는 것처럼 보일 뿐이었다(그래서 100,
// 99, 98...로 줄어드는 게 실제 "얼마 안 남은 페이지"가 아니라 그냥 중복이 쌓이는 착시였음 —
// 실측으로 100/50/20 등 limit을 바꿔가며 확인해보니 매번 "distinct 개수 == limit"으로 정확히
// 일치, 즉 새 데이터가 전혀 안 오고 있었다는 확정적 증거). 실제 해결책은 `endpoints.js`에서
// `cursorParam`을 `'after'`로 바꾸는 것 — 그러면 진짜로 페이지마다 새 데이터가 오고, 데이터가
// 소진되면 정직하게 빈 배열을 준다(6개월치, 723건, 중복 0으로 확인됨).
//
// 이 파일의 "짧은 페이지도 끝이 아닐 수 있다"는 관용적 종료 조건 자체는 `after`가 정상
// 동작하는 지금도 해로울 게 없어서(그냥 가끔 필요없는 요청 하나 더 나가는 정도) 그대로
// 둔다. 다만 이게 "진짜 원인"이라고 오해하지 말 것 — 원인은 위 커서 파라미터였다.
export async function fetchAllPages(path, params, { cursorField, cursorParam, account, maxPages = 2000 }) {
  const allData = [];
  let cursor, prevCursor;

  for (let page = 0; page < maxPages; page++) {
    const p = { ...params, limit: params.limit || 100 };
    if (cursor) p[cursorParam] = cursor;

    let json;
    for (let attempt = 0; ; attempt++) {
      try {
        json = await apiGet(path, p, account);
        break;
      } catch (err) {
        if (attempt < 3 && /50000|frequency/.test(err.message)) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    const data = json.data;
    if (!data || data.length === 0) break;

    allData.push(...data);
    const newCursor = data[data.length - 1][cursorField];
    if (newCursor === prevCursor || newCursor === cursor) break;
    prevCursor = cursor;
    cursor = newCursor;
  }

  return allData;
}
