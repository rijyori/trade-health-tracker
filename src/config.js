import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EXCHANGES } from './exchanges/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

// API 키 자체는 이제 .env가 아니라 DB(credentials 테이블, 대시보드 설정 모달에서 등록/삭제)에 저장.
// 다만 처음 이 프로젝트를 만들 때 .env에 Gate.io 키를 넣어뒀던 경우(레거시) 서버 시작 시 한 번만
// credentials 테이블로 옮겨준다 — server.js의 마이그레이션 로직에서 이 값을 참조.
const legacyGateioAccount = process.env.GATEIO_API_KEY && process.env.GATEIO_SECRET_KEY
  ? {
      exchange: 'gateio',
      label: process.env.GATEIO_LABEL || 'main',
      apiKey: process.env.GATEIO_API_KEY,
      secretKey: process.env.GATEIO_SECRET_KEY,
      baseUrl: process.env.GATEIO_BASE_URL || EXCHANGES.gateio.defaultBaseUrl,
    }
  : null;

export default {
  dataDir: resolve(__dirname, '..', 'data'),
  legacyAccounts: legacyGateioAccount ? [legacyGateioAccount] : [],
};
