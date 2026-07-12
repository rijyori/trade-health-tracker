import { buildHeaders } from './auth.js';

// 실측 전 보수적 기본값. ARCHITECTURE.md §9 방법론(동시요청 + 응답 헤더 확인)으로 필요시 갱신할 것.
const DEFAULT_LIMIT = 5;
const SAFETY_MARGIN_MS = 60;

// Gate.io 주문 ID(orders.id)는 18~19자리라 JS Number(안전정수 2^53≈16자리)를 넘어서
// 표준 JSON.parse가 마지막 자릿수를 뭉갠다(실측 확인: 370421069416186023 -> ...186050로 손상).
// JSON.parse 전에 16자리 이상 순수 정수 리터럴을 문자열로 감싸서 정밀도를 보존한다.
function safeJsonParse(text) {
  const fixed = text.replace(/:(-?\d{16,})(?=[,}\]])/g, ':"$1"');
  return JSON.parse(fixed);
}

const lastRequestTimes = new Map();

async function throttle(throttleKey, limit) {
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
  await throttle(`${account.apiKey}::${path}`, DEFAULT_LIMIT);

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      query.set(k, String(v));
    }
  }
  const queryStr = query.toString();
  const requestPath = `/api/v4${path}`;
  const url = `${account.baseUrl}${path}${queryStr ? `?${queryStr}` : ''}`;

  const headers = buildHeaders(account.apiKey, account.secretKey, 'GET', requestPath, queryStr, '');

  const res = await fetch(url, { headers });
  const text = await res.text();
  const json = safeJsonParse(text);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${json.label || ''} ${json.message || JSON.stringify(json)}`);
  }
  return json;
}

export async function fetchAllPagesOffset(path, params, { account, pageSize = 100, maxPages = 500 } = {}) {
  const allData = [];
  for (let page = 0; page < maxPages; page++) {
    const p = { ...params, limit: pageSize, offset: page * pageSize };
    const data = await apiGet(path, p, account);
    if (!Array.isArray(data) || data.length === 0) break;
    allData.push(...data);
    if (data.length < pageSize) break;
  }
  return allData;
}
