import * as gateio from './gateio/fetcher.js';
import * as deepcoin from './deepcoin/fetcher.js';

// 새 거래소 추가 시 이 맵에 한 줄만 추가하면 설정 모달/refresh/필터링이 전부 따라옴.
export const EXCHANGES = {
  gateio: {
    label: 'Gate.io',
    defaultBaseUrl: 'https://api.gateio.ws/api/v4',
    requiresPassphrase: false,
    fetchAccountData: gateio.fetchAccountData,
    verifyAccount: gateio.verifyAccount,
  },
  deepcoin: {
    label: 'Deepcoin',
    defaultBaseUrl: 'https://api.deepcoin.com',
    requiresPassphrase: true,
    fetchAccountData: deepcoin.fetchAccountData,
    verifyAccount: deepcoin.verifyAccount,
  },
};
