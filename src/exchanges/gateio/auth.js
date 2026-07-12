import { createHmac, createHash } from 'crypto';

// Gate.io API v4 서명 방식 (공식 문서):
// sign_string = METHOD + "\n" + requestPath + "\n" + queryString + "\n" + hex(sha512(body)) + "\n" + timestamp
// sign = hex(HMAC-SHA512(secretKey, sign_string))
// timestamp는 유닉스 초(정수 문자열).
export function buildHeaders(apiKey, secretKey, method, requestPath, queryString = '', body = '') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hashedPayload = createHash('sha512').update(body).digest('hex');
  const signString = [method.toUpperCase(), requestPath, queryString, hashedPayload, timestamp].join('\n');
  const sign = createHmac('sha512', secretKey).update(signString).digest('hex');

  return {
    KEY: apiKey,
    SIGN: sign,
    Timestamp: timestamp,
    'Content-Type': 'application/json',
  };
}
