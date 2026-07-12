import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import {
  getDb, closeDb, upsertOrders, replacePositions, upsertInstruments,
  listCredentials, addCredential, removeCredential, setCredentialUserId, setRebateRate,
} from './storage/sqlite.js';
import { EXCHANGES } from './exchanges/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(config.dataDir, { recursive: true });

// 처음 이 프로젝트를 .env 키로 세팅했던 경우, credentials 테이블이 비어있으면 한 번만 옮겨준다.
// 그 이후로는 설정 모달(등록/삭제)이 유일한 계정 관리 경로 — .env의 GATEIO_API_KEY는 더 안 쓰임.
if (listCredentials().length === 0 && config.legacyAccounts.length) {
  for (const acct of config.legacyAccounts) {
    addCredential({ ...acct, userId: null });
    console.log(`[migrate] .env의 "${acct.label}" 계정을 credentials 테이블로 옮겼습니다.`);
  }
}

const PORT = process.env.PORT || 3010; // 3000은 deepcoin 모니터가 쓰는 포트라 겹치지 않게 다른 번호로.

const routes = {
  'GET /api/summary': apiSummary,
  'GET /api/calendar': apiCalendar,
  'GET /api/data-bounds': apiDataBounds,
  'GET /api/positions': apiPositions,
  'GET /api/recent-orders': apiRecentOrders,
  'GET /api/recent-closes': apiRecentCloses,
  'GET /api/recent-trades': apiRecentTrades,
  'GET /api/cumulative-pnl': apiCumulativePnl,
  'GET /api/accounts': apiAccounts,
  'GET /api/instruments': apiInstruments,
  'GET /api/settings/exchanges': apiSettingsExchanges,
  'GET /api/settings/accounts': apiSettingsListAccounts,
  'POST /api/settings/accounts': apiSettingsAddAccount,
  'POST /api/refresh': apiRefresh,
};

function parseQuery(url) {
  const u = new URL(url, 'http://localhost');
  const params = {};
  for (const [k, v] of u.searchParams) {
    if (params[k]) {
      if (Array.isArray(params[k])) params[k].push(v);
      else params[k] = [params[k], v];
    } else {
      params[k] = v;
    }
  }
  return { pathname: u.pathname, params };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function maskKey(apiKey) {
  if (!apiKey || apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

// 계정 식별은 라벨 하나만으론 안 된다 — 거래소가 다르면 같은 라벨("main" 등)이 겹칠 수 있어서
// (exchange, label) 복합키로 다룬다. credentials 테이블에 등록된 계정만 "표시 가능"으로 취급 —
// 설정 모달에서 삭제하면 DB엔 과거 데이터가 남아있어도 화면엔 안 보이게. params.account로 그
// 안에서 추가로 좁힐 수 있다(대시보드 토글, 값은 "exchange::label" 형식).
const ACCOUNT_KEY_SEP = '::';
function accountKey(exchange, label) {
  return `${exchange}${ACCOUNT_KEY_SEP}${label}`;
}

function activeAccountKeys() {
  return listCredentials().map(a => accountKey(a.exchange, a.label));
}

function resolveAccountFilter(params) {
  const active = activeAccountKeys();
  const requested = params.account ? (Array.isArray(params.account) ? params.account : [params.account]) : active;
  return requested.filter(a => active.includes(a));
}

// table을 넘기면 컬럼을 명시적으로 그 테이블로 한정한다 — apiSummary/apiCumulativePnl처럼
// credentials와 JOIN해서 rebateRate를 끌어올 때 둘 다 exchange 컬럼이 있어서 안 그러면 모호해짐.
// (table 없이 쓰는 다른 호출부는 원래부터 단일 테이블만 보므로 그대로 안전)
function accountClause(accountKeys, bind, prefix = 'acc', table = null) {
  if (!accountKeys.length) return '1=0'; // 활성 계정이 하나도 없거나 토글로 다 꺼졌으면 아무것도 보여주지 않음
  const placeholders = accountKeys.map((a, i) => { bind[`${prefix}${i}`] = a; return `@${prefix}${i}`; });
  const col = table ? `${table}.exchange` : 'exchange';
  const acc = table ? `${table}.account` : 'account';
  return `(${col} || '${ACCOUNT_KEY_SEP}' || ${acc}) IN (${placeholders.join(',')})`;
}

// 종목(instId) 필터 — 계정 필터와 같은 패턴. 아무것도 안 넘기면(params.instId 없음) 전체 종목.
function resolveInstFilter(params) {
  if (!params.instId) return null; // null = 필터 없음(전체)
  return Array.isArray(params.instId) ? params.instId : [params.instId];
}

function instClause(instIds, bind, prefix = 'inst') {
  if (instIds == null) return '1=1'; // 필터 안 걸림
  if (!instIds.length) return '1=0'; // 토글로 다 꺼졌으면 아무것도 안 보여줌
  const placeholders = instIds.map((v, i) => { bind[`${prefix}${i}`] = v; return `@${prefix}${i}`; });
  return `instId IN (${placeholders.join(',')})`;
}

// state='filled'로 거르면 "부분체결 후 취소"류(정말 체결된 물량이 있는데 최종 상태 문자열만
// 다른 경우)를 놓친다 — Deepcoin에서 실제로 겪음(../deepcoin SESSION_LESSONS.md §15,
// trade-grouping이 몇 주치를 하나로 뭉쳐버리는 버그의 원인이었음). accFillSz(실제 체결 수량)로
// 거르는 게 거래소 무관하게 맞는 기준. 단, Gate.io는 accFillSz를 주문 size로 매핑하고 있어서
// (exchanges/gateio/fetcher.js normalizeOrders) 이게 "진짜 체결량"인지 재확인 필요 — 미확인.
function buildWhere(params) {
  const bind = {};
  let where = "WHERE CAST(accFillSz AS REAL) > 0 AND " + accountClause(resolveAccountFilter(params), bind, 'acc', 'orders_history')
    + ' AND ' + instClause(resolveInstFilter(params), bind);
  if (params.from) { where += ' AND cTime >= @from'; bind.from = params.from; }
  if (params.to) { where += ' AND cTime <= @to'; bind.to = params.to; }
  return { where, bind };
}

// 포지션 생애주기(entry -> flat)를 하나의 "트레이드"로 묶는다. 개별 주문(row) 기준으로 세면
// 부분익절/분할손절로 승률이 왜곡되기 때문. deepcoin에서 그대로 이식(ARCHITECTURE.md §6.2).
function computeTrades(params = {}) {
  const db = getDb();
  const bind = {};
  const accounts = resolveAccountFilter(params);
  const rows = db.prepare(`
    SELECT ordId, instId, posSide, accFillSz, pnl, fee, rebate, cTime
    FROM orders_history WHERE CAST(accFillSz AS REAL) > 0 AND ${accountClause(accounts, bind)}
      AND ${instClause(resolveInstFilter(params), bind)}
    ORDER BY instId, posSide, CAST(cTime AS REAL) ASC
  `).all(bind);

  const groups = new Map();
  for (const r of rows) {
    const key = r.instId + '|' + (r.posSide || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // 우리 주문내역엔 리텐션 갭이 있을 수 있어서 자체 사이즈 장부만으론 신뢰 못 함.
  // 라이브 positions 스냅샷과 대조해서 진짜 열려있는 그룹만 open=true로 표시.
  const posBind = {};
  const openKeys = new Set(
    db.prepare(`SELECT instId, posSide FROM positions WHERE ${accountClause(accounts, posBind)}`).all(posBind)
      .map(p => p.instId + '|' + (p.posSide || ''))
  );

  const trades = [];
  for (const [key, list] of groups) {
    let totalEntryFee = 0, totalEntrySize = 0;
    for (const r of list) {
      if (Number(r.pnl) === 0) {
        totalEntryFee += Math.abs(Number(r.fee));
        totalEntrySize += Number(r.accFillSz);
      }
    }
    const fallbackRate = totalEntrySize > 0 ? totalEntryFee / totalEntrySize : 0;

    const queue = [];
    let openQty = 0;
    let trade = null;

    for (const r of list) {
      const pnl = Number(r.pnl), sz = Number(r.accFillSz), exitFee = Math.abs(Number(r.fee));

      if (pnl === 0) {
        if (sz > 0) queue.push({ size: sz, feePerUnit: exitFee / sz });
        if (!trade) trade = { instId: r.instId, posSide: r.posSide, grossPnl: 0, entryFee: 0, exitFee: 0, rebate: 0, closeCount: 0, closedSize: 0, startTime: r.cTime, endTime: null };
        openQty += sz;
        continue;
      }

      if (!trade) trade = { instId: r.instId, posSide: r.posSide, grossPnl: 0, entryFee: 0, exitFee: 0, rebate: 0, closeCount: 0, closedSize: 0, startTime: r.cTime, endTime: null };
      let remaining = sz, entryFeeAttr = 0;
      while (remaining > 1e-9 && queue.length > 0) {
        const head = queue[0];
        const take = Math.min(head.size, remaining);
        entryFeeAttr += take * head.feePerUnit;
        head.size -= take;
        remaining -= take;
        if (head.size <= 1e-9) queue.shift();
      }
      if (remaining > 1e-9) entryFeeAttr += remaining * fallbackRate;
      openQty = Math.max(0, openQty - sz);

      trade.grossPnl += pnl;
      trade.entryFee += entryFeeAttr;
      trade.exitFee += exitFee;
      trade.rebate += Number(r.rebate || 0);
      trade.closeCount += 1;
      trade.closedSize += sz;
      trade.endTime = r.cTime;

      if (openQty <= 1e-9) {
        trade.open = false;
        trades.push(trade);
        trade = null;
      }
    }

    if (trade) {
      trade.open = openKeys.has(key);
      trades.push(trade);
    }
  }

  const withNet = trades.map(t => ({ ...t, netPnl: t.grossPnl - t.entryFee - t.exitFee + t.rebate }));

  // from/to는 원본 주문 조회 단계가 아니라 여기서(트레이드 완성 후) 적용한다 — FIFO 엔트리
  // 수수료 매칭은 필터링 이전 시점의 엔트리 주문까지 다 봐야 정확해서, 미리 잘라내면
  // 경계에 걸친 트레이드의 entryFee가 fallbackRate로 잘못 추정된다. endTime(청산 완료 시점)
  // 기준으로 사후 필터링하는 게 "이 기간에 청산된 트레이드"라는 의미에도 더 맞는다.
  if (params.from == null && params.to == null) return withNet;
  return withNet.filter(t => {
    const end = Number(t.endTime);
    if (params.from != null && end < Number(params.from)) return false;
    if (params.to != null && end > Number(params.to)) return false;
    return true;
  });
}

function apiRecentTrades(params) {
  const trades = computeTrades(params);
  trades.sort((a, b) => Number(b.endTime) - Number(a.endTime));
  const limit = Math.min(parseInt(params.limit) || 50, 500);
  return trades.slice(0, limit);
}

// 거래소가 실제로 리베이트/바우처 비율을 API로 안 알려줘서(§ SESSION_LESSONS §12), 사용자가
// 설정 모달에서 계정별 추정 요율(credentials.rebateRate)을 직접 입력하면 그걸로 "Expected"
// 수치를 계산해 보여준다. 실제 orders_history의 pnl/fee/rebate 원본 값은 전혀 안 바뀜 —
// 순수하게 이 조회 시점에서만 반영되는 표시용 계산.
function apiSummary(params) {
  const db = getDb();
  const { where, bind } = buildWhere(params);
  const row = db.prepare(`
    SELECT
      COUNT(*) as totalOrders,
      COALESCE(SUM(CAST(pnl AS REAL)), 0) as totalGrossPnl,
      COALESCE(SUM(CAST(pnl AS REAL) - ABS(CAST(fee AS REAL)) + CAST(COALESCE(rebate,'0') AS REAL)), 0) as totalNetPnl,
      COALESCE(SUM(ABS(CAST(fee AS REAL))), 0) as totalFees,
      COALESCE(SUM(ABS(CAST(pnl AS REAL))), 0) as totalAbsGross,
      COALESCE(SUM(CAST(rebate AS REAL)), 0) as totalRebate,
      COALESCE(SUM(CAST(pnl AS REAL) - ABS(CAST(fee AS REAL)) * (1 - COALESCE(credentials.rebateRate, 0)) + CAST(COALESCE(rebate,'0') AS REAL)), 0) as totalExpectedNetPnl,
      COALESCE(SUM(ABS(CAST(fee AS REAL)) * COALESCE(credentials.rebateRate, 0)), 0) as totalExpectedRebate
    FROM orders_history
    LEFT JOIN credentials ON credentials.exchange = orders_history.exchange AND credentials.label = orders_history.account
    ${where}
  `).get(bind);

  const trades = computeTrades(params);
  row.totalTrades = trades.length;
  row.winCount = trades.filter(t => t.netPnl > 0).length;
  row.lossCount = trades.filter(t => t.netPnl < 0).length;
  row.avgPnl = trades.length ? trades.reduce((s, t) => s + t.netPnl, 0) / trades.length : 0;
  row.maxWin = trades.length ? Math.max(...trades.map(t => t.netPnl)) : 0;
  row.maxLoss = trades.length ? Math.min(...trades.map(t => t.netPnl)) : 0;

  return row;
}

function apiCalendar(params) {
  const db = getDb();
  const { where, bind } = buildWhere(params);
  const monthMatch = /^\d{4}-\d{2}$/.test(params.month) ? params.month : null;
  const month = monthMatch || db.prepare(`SELECT SUBSTR(date(datetime('now', '+32400 seconds')), 1, 7) as m`).get().m;

  return db.prepare(`
    WITH bounds AS (
      SELECT
        date(@month || '-01') as firstOfMonth,
        date(@month || '-01', '+1 month', '-1 day') as lastOfMonth
    ),
    range AS (
      SELECT
        firstOfMonth, lastOfMonth,
        date(firstOfMonth, '-' || CAST(strftime('%w', firstOfMonth) AS INT) || ' days') as rangeStart,
        date(lastOfMonth, '+' || (6 - CAST(strftime('%w', lastOfMonth) AS INT)) || ' days') as rangeEnd
      FROM bounds
    ),
    dates AS (
      SELECT rangeStart as date FROM range
      UNION ALL
      SELECT date(date, '+1 day') FROM dates, range WHERE date(date, '+1 day') <= rangeEnd
    ),
    daily AS (
      SELECT
        SUBSTR(datetime(CAST(cTime AS REAL)/1000 + 32400, 'unixepoch'), 1, 10) as date,
        COUNT(*) as orders,
        SUM(CAST(pnl AS REAL)) as grossPnl,
        SUM(CAST(pnl AS REAL) - ABS(CAST(fee AS REAL)) + CAST(COALESCE(rebate,'0') AS REAL)) as pnl,
        SUM(ABS(CAST(fee AS REAL))) as fees,
        SUM(ABS(CAST(pnl AS REAL))) as absGross,
        COUNT(CASE WHEN CAST(pnl AS REAL) = 0 THEN 1 END) as entries,
        COUNT(CASE WHEN (CAST(pnl AS REAL) - ABS(CAST(fee AS REAL)) + CAST(COALESCE(rebate,'0') AS REAL)) > 0 THEN 1 END) as wins,
        COUNT(CASE WHEN (CAST(pnl AS REAL) - ABS(CAST(fee AS REAL)) + CAST(COALESCE(rebate,'0') AS REAL)) < 0 THEN 1 END) as losses
      FROM orders_history ${where}
      GROUP BY date
    )
    SELECT d.date, COALESCE(y.orders, 0) as orders, COALESCE(y.pnl, 0) as pnl,
      COALESCE(y.fees, 0) as fees, COALESCE(y.grossPnl, 0) as grossPnl,
      COALESCE(y.absGross, 0) as absGross,
      COALESCE(y.entries, 0) as entries,
      COALESCE(y.wins, 0) as wins, COALESCE(y.losses, 0) as losses,
      CASE WHEN d.date BETWEEN (SELECT firstOfMonth FROM range) AND (SELECT lastOfMonth FROM range) THEN 1 ELSE 0 END as inMonth
    FROM dates d LEFT JOIN daily y ON d.date = y.date
    ORDER BY d.date ASC
  `).all({ ...bind, month });
}

function apiDataBounds(params) {
  const db = getDb();
  const bind = {};
  const row = db.prepare(`
    SELECT MIN(SUBSTR(datetime(CAST(cTime AS REAL)/1000 + 32400, 'unixepoch'), 1, 7)) as minMonth
    FROM orders_history WHERE CAST(accFillSz AS REAL) > 0 AND ${accountClause(resolveAccountFilter(params), bind)}
      AND ${instClause(resolveInstFilter(params), bind)}
  `).get(bind);
  return { minMonth: row.minMonth };
}

function apiPositions(params) {
  const db = getDb();
  const bind = {};
  return db.prepare(`
    SELECT instId, posSide, pos, avgPx, liqPx, unrealizedProfit, lastPx, ccy
    FROM positions WHERE ${accountClause(resolveAccountFilter(params), bind)}
      AND ${instClause(resolveInstFilter(params), bind)}
  `).all(bind);
}

function apiRecentOrders(params) {
  const db = getDb();
  const { where, bind } = buildWhere(params);
  const limit = Math.min(parseInt(params.limit) || 50, 500);
  return db.prepare(`
    SELECT ordId, instId, side, posSide, ordType, avgPx, accFillSz,
      pnl, fee, rebate, state, cTime
    FROM orders_history ${where}
    ORDER BY cTime DESC
    LIMIT ${limit}
  `).all(bind);
}

// 청산 주문을 엔트리 FIFO 큐와 매칭해서 "그 청산 물량이 실제로 낸 엔트리 수수료"를 실현손익에 반영.
function apiRecentCloses(params) {
  const db = getDb();
  const bind = {};
  const rows = db.prepare(`
    SELECT exchange, account, ordId, instId, posSide, side, accFillSz, avgPx, pnl, fee, rebate, cTime
    FROM orders_history
    WHERE CAST(accFillSz AS REAL) > 0 AND ${accountClause(resolveAccountFilter(params), bind)}
      AND ${instClause(resolveInstFilter(params), bind)}
    ORDER BY instId, posSide, CAST(cTime AS REAL) ASC
  `).all(bind);

  // closedSize×avgPx만으론 명목가치가 안 나오는 계약형 상품이 있어서(예: Gate.io BTC_USDT는
  // 1계약=0.0001BTC) 손실 패턴 분석용 배율을 같이 붙여준다.
  const multiplierByKey = new Map(
    db.prepare('SELECT exchange, instId, multiplier FROM instruments').all()
      .map(i => [`${i.exchange}|${i.instId}`, i.multiplier])
  );

  // 계정별 추정 리베이트 요율 — Expected PNL = Net + ABS(fee)*rebateRate 계산용
  // (apiSummary/apiCumulativePnl의 Expected 정의와 동일). 요율 미설정(0)이면 Expected == Net.
  const rebateByKey = new Map(
    db.prepare('SELECT exchange, label, rebateRate FROM credentials').all()
      .map(c => [`${c.exchange}|${c.label}`, Number(c.rebateRate) || 0])
  );

  const groups = new Map();
  for (const r of rows) {
    const key = r.instId + '|' + (r.posSide || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const closes = [];
  for (const list of groups.values()) {
    let totalEntryFee = 0, totalEntrySize = 0;
    for (const r of list) {
      if (Number(r.pnl) === 0) {
        totalEntryFee += Math.abs(Number(r.fee));
        totalEntrySize += Number(r.accFillSz);
      }
    }
    const fallbackRate = totalEntrySize > 0 ? totalEntryFee / totalEntrySize : 0;

    const queue = [];
    for (const r of list) {
      const pnl = Number(r.pnl);
      const sz = Number(r.accFillSz);
      const exitFee = Math.abs(Number(r.fee));

      if (pnl === 0) {
        // 진입 로트에 진입 시각(cTime)도 같이 실어둠 — 청산 시 FIFO로 매칭해서 보유시간 산출.
        if (sz > 0) queue.push({ size: sz, feePerUnit: exitFee / sz, cTime: Number(r.cTime) });
        continue;
      }

      let remaining = sz;
      let entryFee = 0;
      let complete = true;
      let entryTimeWeighted = 0, matchedSize = 0;
      while (remaining > 1e-9 && queue.length > 0) {
        const head = queue[0];
        const take = Math.min(head.size, remaining);
        entryFee += take * head.feePerUnit;
        entryTimeWeighted += take * head.cTime;
        matchedSize += take;
        head.size -= take;
        remaining -= take;
        if (head.size <= 1e-9) queue.shift();
      }
      if (remaining > 1e-9) {
        entryFee += remaining * fallbackRate;
        complete = false;
      }

      // 매칭된 진입 로트의 크기가중 평균 진입시각 → 보유시간(ms). 매칭이 하나도 안 되면(진입
      // 로트가 조회범위 밖) 진입시각을 알 수 없어 청산시각으로 두어 보유시간 0으로 처리.
      const avgEntryTime = matchedSize > 0 ? entryTimeWeighted / matchedSize : Number(r.cTime);
      const holdMs = Number(r.cTime) - avgEntryTime;

      const rebate = Number(r.rebate || 0);
      const netPnl = pnl - entryFee - exitFee + rebate;
      const rebateRate = rebateByKey.get(`${r.exchange}|${r.account}`) || 0;
      closes.push({
        ordId: r.ordId, instId: r.instId, posSide: r.posSide, side: r.side,
        closedSize: sz, avgPx: r.avgPx, grossPnl: pnl,
        entryFee, exitFee, rebate,
        netPnl,
        expectedPnl: netPnl + (entryFee + exitFee) * rebateRate,
        complete, cTime: r.cTime, holdMs,
        multiplier: multiplierByKey.get(`${r.exchange}|${r.instId}`) || 1,
      });
    }
  }

  // computeTrades와 같은 이유로 from/to는 원본 조회가 아니라 여기서(FIFO 매칭 후) 적용 —
  // 그래야 기간 경계에 걸친 청산의 entryFee가 fallbackRate로 잘못 추정되지 않는다.
  const filtered = (params.from == null && params.to == null) ? closes : closes.filter(c => {
    const t = Number(c.cTime);
    if (params.from != null && t < Number(params.from)) return false;
    if (params.to != null && t > Number(params.to)) return false;
    return true;
  });

  filtered.sort((a, b) => Number(b.cTime) - Number(a.cTime));

  // 손실 패턴 산점도 등은 "최근 50개" 테이블용 기본 캡보다 훨씬 많은 청산 건수가 필요해서
  // 상한을 넉넉히 잡음(개인용 저빈도 계정 규모라 수천 건도 부담 없음).
  const limit = Math.min(parseInt(params.limit) || 50, 20000);
  return filtered.slice(0, limit);
}

function apiCumulativePnl(params) {
  const db = getDb();
  const { where, bind } = buildWhere(params);

  const range = db.prepare(`SELECT MIN(CAST(cTime AS REAL)) as minT, MAX(CAST(cTime AS REAL)) as maxT FROM orders_history ${where}`).get(bind);
  if (range.minT == null) return [];

  const minT = range.minT;
  const binMs = Math.max(1000, Math.ceil((range.maxT - range.minT + 1) / 1000));

  const rows = db.prepare(`
    SELECT
      CAST((CAST(orders_history.cTime AS REAL) - @minT) / @binMs AS INT) as binIdx,
      SUM(CAST(pnl AS REAL)) as binGrossPnl,
      SUM(CAST(pnl AS REAL) - ABS(CAST(fee AS REAL)) + CAST(COALESCE(rebate,'0') AS REAL)) as binNetPnl,
      SUM(CAST(pnl AS REAL) - ABS(CAST(fee AS REAL)) * (1 - COALESCE(credentials.rebateRate, 0)) + CAST(COALESCE(rebate,'0') AS REAL)) as binExpectedPnl
    FROM orders_history
    LEFT JOIN credentials ON credentials.exchange = orders_history.exchange AND credentials.label = orders_history.account
    ${where}
    GROUP BY binIdx
    ORDER BY binIdx ASC
  `).all({ ...bind, minT, binMs });

  let cumGross = 0, cumNet = 0, cumExpected = 0;
  return rows.map(r => {
    cumGross += r.binGrossPnl;
    cumNet += r.binNetPnl;
    cumExpected += r.binExpectedPnl;
    return { bin: minT + r.binIdx * binMs, cumGrossPnl: cumGross, cumNetPnl: cumNet, cumExpectedPnl: cumExpected };
  });
}

// 대시보드 계정 토글 UI용 — 등록된 계정만(비밀키 없이) 반환. account 값은 "exchange::label" 복합키.
function apiAccounts(_params) {
  return listCredentials().map(a => ({
    exchange: a.exchange, account: accountKey(a.exchange, a.label), label: a.label, userId: a.userId,
  }));
}

// 종목(instId) 토글 UI용 — 현재 활성 계정들이 실제로 거래한 종목만 나열(instId 필터 자체는
// 여기 적용 안 함, 안 그러면 하나 고르는 순간 목록이 그거 하나로 줄어듦).
function apiInstruments(params) {
  const db = getDb();
  const bind = {};
  return db.prepare(`
    SELECT DISTINCT instId FROM orders_history
    WHERE CAST(accFillSz AS REAL) > 0 AND ${accountClause(resolveAccountFilter(params), bind)}
    ORDER BY instId
  `).all(bind).map(r => r.instId);
}

// 설정 모달에서 지원 거래소 목록/각 필수 입력 필드(패스프레이즈 필요 여부)를 알려준다.
function apiSettingsExchanges(_params) {
  return Object.entries(EXCHANGES).map(([id, ex]) => ({
    id, label: ex.label, requiresPassphrase: ex.requiresPassphrase,
  }));
}

// 설정 모달의 계정 목록 — apiKey는 마스킹해서만 노출, secretKey/passphrase는 절대 다시 내려주지 않는다.
function apiSettingsListAccounts(_params) {
  return listCredentials().map(a => ({
    exchange: a.exchange, exchangeLabel: EXCHANGES[a.exchange]?.label || a.exchange,
    label: a.label, apiKey: maskKey(a.apiKey), userId: a.userId, createdAt: a.createdAt,
    rebateRate: a.rebateRate || 0,
  }));
}

// 리베이트/바우처 요율 수정 — orders_history는 안 건드리고 credentials.rebateRate만 갱신.
// 다음 조회부터 apiSummary/apiCumulativePnl의 Expected 값에 바로 반영됨(별도 refresh 불필요).
function apiSettingsUpdateRebateRate(exchange, label, body) {
  const rate = Number(body.rebateRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    const err = new Error('rebateRate는 0~1 사이 숫자여야 합니다 (예: 32% -> 0.32).');
    err.statusCode = 400;
    throw err;
  }
  const updated = setRebateRate(exchange, decodeURIComponent(label), rate);
  if (!updated) {
    const err = new Error('해당 계정을 찾을 수 없습니다.');
    err.statusCode = 404;
    throw err;
  }
  return { exchange, label: decodeURIComponent(label), rebateRate: rate };
}

// 새 키 등록 — 저장 전에 실제로 거래소에 인증되는지 한 번 호출해서 확인하고, 성공하면 그 자리에서
// userId까지 같이 저장한다 (오타/잘못된 키를 그대로 저장해두는 사고를 막기 위함).
async function apiSettingsAddAccount(_params, req) {
  const body = await readJsonBody(req);
  const exchange = (body.exchange || 'gateio').trim();
  const label = (body.label || '').trim();
  const apiKey = (body.apiKey || '').trim();
  const secretKey = (body.secretKey || '').trim();
  const passphrase = (body.passphrase || '').trim();

  const ex = EXCHANGES[exchange];
  if (!ex) {
    const err = new Error(`지원하지 않는 거래소입니다: ${exchange}`);
    err.statusCode = 400;
    throw err;
  }
  if (!label || !apiKey || !secretKey || (ex.requiresPassphrase && !passphrase)) {
    const err = new Error(`label, apiKey, secretKey${ex.requiresPassphrase ? ', passphrase' : ''}는 모두 필수입니다.`);
    err.statusCode = 400;
    throw err;
  }

  const baseUrl = ex.defaultBaseUrl;
  let userId;
  try {
    ({ userId } = await ex.verifyAccount({ apiKey, secretKey, passphrase, baseUrl }));
  } catch (e) {
    const err = new Error(`${ex.label} 인증 실패: ${e.message}`);
    err.statusCode = 400;
    throw err;
  }

  addCredential({ exchange, label, apiKey, secretKey, passphrase, baseUrl, userId });
  return { exchange, label, userId };
}

function apiSettingsRemoveAccount(exchange, label) {
  const removed = removeCredential(exchange, decodeURIComponent(label));
  if (!removed) {
    const err = new Error('해당 계정을 찾을 수 없습니다.');
    err.statusCode = 404;
    throw err;
  }
  return { status: 'removed' };
}

const server = createServer(async (req, res) => {
  const { pathname, params } = parseQuery(req.url);
  const routeKey = `${req.method} ${pathname}`;

  if (routeKey === 'GET /') {
    const html = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8');
    // 개발 중 대시보드를 자주 고치는데 Cache-Control이 없으면 브라우저가 예전 버전을
    // 캐시해서 일반 새로고침(F5)으로 최신 스크립트가 안 반영되는 경우가 있었음 — 매번
    // 서버 파일을 그대로 새로 읽어 주므로 캐싱 이점도 없어서 아예 막는다.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // DELETE /api/settings/accounts/:exchange/:label — 계정별 동적 경로라 routes 맵에 못 넣고 여기서 처리.
  const deleteMatch = req.method === 'DELETE' && pathname.match(/^\/api\/settings\/accounts\/([^/]+)\/([^/]+)$/);
  if (deleteMatch) {
    try {
      const data = apiSettingsRemoveAccount(deleteMatch[1], deleteMatch[2]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // PUT /api/settings/accounts/:exchange/:label/rebate-rate — 마찬가지로 동적 경로.
  const rebateMatch = req.method === 'PUT' && pathname.match(/^\/api\/settings\/accounts\/([^/]+)\/([^/]+)\/rebate-rate$/);
  if (rebateMatch) {
    try {
      const body = await readJsonBody(req);
      const data = apiSettingsUpdateRebateRate(rebateMatch[1], rebateMatch[2], body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const handler = routes[routeKey];
  if (handler) {
    try {
      const data = await handler(params, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

let refreshing = false;

// 계정 1~2개, 저빈도 개인 트레이딩 규모라 deepcoin처럼 증분 커서(sync_state)를 두지 않고
// 매번 API가 내려주는 전체 리텐션 구간을 재조회해서 upsert한다(INSERT OR REPLACE라 안전).
// 리텐션 밖으로 밀려난 과거 데이터는 이전 refresh들에서 이미 DB에 쌓여있으므로 보존됨.
async function apiRefresh(_params) {
  const accounts = listCredentials();
  if (!accounts.length) {
    return { error: '등록된 계정이 없습니다. 설정에서 API 키를 추가하세요.' };
  }
  if (refreshing) {
    return { status: 'already refreshing' };
  }
  refreshing = true;
  console.log('[refresh] Starting...');
  try {
    const accountResults = await Promise.all(accounts.map(async (acct) => {
      const ex = EXCHANGES[acct.exchange];
      if (!ex) throw new Error(`알 수 없는 거래소: ${acct.exchange} (계정 "${acct.label}")`);
      const { orders, positions, userId, instruments } = await ex.fetchAccountData(acct);
      return { exchange: acct.exchange, label: acct.label, orders, positions, userId, instruments };
    }));

    for (const r of accountResults) {
      if (r.orders?.length) upsertOrders(r.exchange, r.label, r.orders);
      replacePositions(r.exchange, r.label, r.positions || []);
      if (r.userId) setCredentialUserId(r.exchange, r.label, r.userId);
      if (r.instruments?.length) upsertInstruments(r.exchange, r.instruments);
    }

    console.log('[refresh] Done');
    return { status: 'done' };
  } catch (err) {
    console.error('[refresh] Error:', err.message);
    return { error: err.message };
  } finally {
    refreshing = false;
  }
}

// 로컬 브라우저 접속만 상정 — 호스트 미지정 시 Node가 기본으로 모든 인터페이스에
// 바인딩해서 첫 실행 때 Windows 방화벽 "이 앱을 허용하시겠습니까" 팝업이 뜬다.
// 127.0.0.1로 명시해서 방화벽 프롬프트 자체가 안 뜨게 함 (비개발자 사용자 배려).
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});

process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });
