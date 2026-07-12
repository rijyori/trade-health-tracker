import Database from 'better-sqlite3';
import { join } from 'path';
import config from '../config.js';

let db;

export function getDb() {
  if (!db) {
    const dbPath = join(config.dataDir, 'trade-health.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initTables(db);
  }
  return db;
}

function initTables(db) {
  // 이전 세션에서 쓰던 임시 accounts 레지스트리 테이블(userId만 저장)은 credentials 테이블로 대체됨.
  db.exec('DROP TABLE IF EXISTS accounts');
  db.exec(`
    -- exchange가 다르면 ID가 겹칠 수 있어서 (exchange, ordId) 복합 PK로 설계.
    -- 컬럼명은 의도적으로 deepcoin(OKX 계열) 스키마와 동일하게 맞춤 —
    -- server.js의 코어 집계 로직(computeTrades 등)을 거래소 무관하게 재사용하기 위함.
    CREATE TABLE IF NOT EXISTS orders_history (
      exchange TEXT,
      ordId TEXT,
      account TEXT,
      instId TEXT,
      side TEXT,
      posSide TEXT,
      accFillSz TEXT,
      avgPx TEXT,
      pnl TEXT,
      fee TEXT,
      rebate TEXT,
      ordType TEXT,
      state TEXT,
      cTime TEXT,
      uTime TEXT,
      PRIMARY KEY (exchange, ordId)
    );

    CREATE TABLE IF NOT EXISTS positions (
      exchange TEXT,
      posId TEXT,
      account TEXT,
      instId TEXT,
      posSide TEXT,
      pos TEXT,
      avgPx TEXT,
      liqPx TEXT,
      unrealizedProfit TEXT,
      lastPx TEXT,
      ccy TEXT,
      PRIMARY KEY (exchange, posId)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_instId ON orders_history(instId);
    CREATE INDEX IF NOT EXISTS idx_orders_cTime ON orders_history(cTime);

    -- 계약 1개가 실제로 얼마만큼의 기초자산인지(Gate.io quanto_multiplier, Deepcoin ctVal).
    -- closedSize × avgPx만으로는 명목가치가 안 나오는 계약형 상품(예: Gate.io BTC_USDT는
    -- 1계약=0.0001BTC)이 있어서, 손실 패턴 분석(%수익률) 계산에 필요.
    CREATE TABLE IF NOT EXISTS instruments (
      exchange TEXT,
      instId TEXT,
      multiplier REAL DEFAULT 1,
      PRIMARY KEY (exchange, instId)
    );

    -- API 키 자체를 여기 저장(.env 대신 대시보드 설정 모달에서 등록/삭제).
    -- 라벨은 사람이 지은 표시용 이름이라 언제든 바뀔 수 있고, userId는 거래소가 부여한 값이라
    -- refresh 때마다 갱신해 화면 표시/검증용으로 남겨둠. 이 테이블에서 지운 계정은 orders_history/
    -- positions에 과거 데이터가 남아있어도 더 이상 활성 계정이 아니므로 화면엔 안 보임.
    CREATE TABLE IF NOT EXISTS credentials (
      exchange TEXT,
      label TEXT,
      apiKey TEXT,
      secretKey TEXT,
      baseUrl TEXT,
      userId TEXT,
      createdAt TEXT,
      PRIMARY KEY (exchange, label)
    );
  `);

  // 나중에 추가된 컬럼들 — 기존 DB엔 CREATE TABLE IF NOT EXISTS로는 안 생기므로 없으면 붙여준다.
  const cols = db.prepare("PRAGMA table_info(credentials)").all().map(c => c.name);
  if (!cols.includes('passphrase')) {
    db.exec('ALTER TABLE credentials ADD COLUMN passphrase TEXT');
  }
  if (!cols.includes('rebateRate')) {
    // 실제 리베이트/바우처 요율은 거래소가 API로 안 알려줘서 사용자가 직접 추정치를 입력(예: 0.32).
    // orders_history의 실제 rebate 컬럼(대부분 0)과는 별개로, "Expected PNL" 렌더링에만 쓰는
    // 순수 표시용 계수 — DB의 실제 거래 데이터는 전혀 안 건드림.
    db.exec('ALTER TABLE credentials ADD COLUMN rebateRate REAL DEFAULT 0');
  }
}

export function listCredentials() {
  const db = getDb();
  return db.prepare('SELECT * FROM credentials ORDER BY createdAt ASC').all();
}

export function addCredential({ exchange, label, apiKey, secretKey, passphrase, baseUrl, userId }) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO credentials (exchange, label, apiKey, secretKey, passphrase, baseUrl, userId, createdAt)
    VALUES (@exchange, @label, @apiKey, @secretKey, @passphrase, @baseUrl, @userId,
      COALESCE((SELECT createdAt FROM credentials WHERE exchange = @exchange AND label = @label), @now))
  `).run({ exchange, label, apiKey, secretKey, passphrase: passphrase || null, baseUrl, userId, now: new Date().toISOString() });
}

export function removeCredential(exchange, label) {
  const db = getDb();
  const result = db.prepare('DELETE FROM credentials WHERE exchange = ? AND label = ?').run(exchange, label);
  return result.changes > 0;
}

export function setCredentialUserId(exchange, label, userId) {
  const db = getDb();
  db.prepare('UPDATE credentials SET userId = ? WHERE exchange = ? AND label = ?').run(userId, exchange, label);
}

export function setRebateRate(exchange, label, rebateRate) {
  const db = getDb();
  const result = db.prepare('UPDATE credentials SET rebateRate = ? WHERE exchange = ? AND label = ?').run(rebateRate, exchange, label);
  return result.changes > 0;
}

export function upsertOrders(exchange, account, records) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO orders_history
    (exchange, ordId, account, instId, side, posSide, accFillSz, avgPx, pnl, fee, rebate, ordType, state, cTime, uTime)
    VALUES (@exchange, @ordId, @account, @instId, @side, @posSide, @accFillSz, @avgPx, @pnl, @fee, @rebate, @ordType, @state, @cTime, @uTime)
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run({ ...row, exchange, account });
  });
  tx(records);
  console.log(`  [sqlite] orders_history: upserted ${records.length} records (${exchange}/${account})`);
}

export function replacePositions(exchange, account, records) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO positions
    (exchange, posId, account, instId, posSide, pos, avgPx, liqPx, unrealizedProfit, lastPx, ccy)
    VALUES (@exchange, @posId, @account, @instId, @posSide, @pos, @avgPx, @liqPx, @unrealizedProfit, @lastPx, @ccy)
  `);
  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM positions WHERE exchange = ? AND account = ?').run(exchange, account);
    for (const row of rows) stmt.run({ ...row, exchange, account });
  });
  tx(records);
  console.log(`  [sqlite] positions: replaced with ${records.length} current record(s) (${exchange}/${account})`);
}

export function upsertInstruments(exchange, records) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO instruments (exchange, instId, multiplier)
    VALUES (@exchange, @instId, @multiplier)
  `);
  const tx = db.transaction((rows) => {
    for (const row of rows) stmt.run({ exchange, instId: row.instId, multiplier: row.multiplier || 1 });
  });
  tx(records);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
