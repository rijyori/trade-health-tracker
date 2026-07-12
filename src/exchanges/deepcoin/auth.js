import { createHmac } from 'crypto';

// Deepcoin 서명 방식(레퍼런스 ../deepcoin 프로젝트에서 그대로 이식):
// prehash = timestamp(ISO8601) + METHOD + requestPath + body
// sign = base64(HMAC-SHA256(secretKey, prehash))
export function buildHeaders(apiKey, secretKey, passphrase, method, requestPath, body = '') {
  const timestamp = new Date().toISOString();
  const prehash = timestamp + method.toUpperCase() + requestPath + body;
  const sign = createHmac('sha256', secretKey).update(prehash).digest('base64');
  return {
    'DC-ACCESS-KEY': apiKey,
    'DC-ACCESS-SIGN': sign,
    'DC-ACCESS-TIMESTAMP': timestamp,
    'DC-ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
  };
}
