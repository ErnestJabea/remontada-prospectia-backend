const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('node:async_hooks');
require('dotenv').config();

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME     || 'nexus_crm',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

const transactions = new AsyncLocalStorage();
const baseQuery = pool.query.bind(pool);
const baseExecute = pool.execute.bind(pool);
const baseGetConnection = pool.getConnection.bind(pool);
pool.query = (...args) => (transactions.getStore()?.connection.query(...args) || baseQuery(...args));
pool.execute = (...args) => (transactions.getStore()?.connection.execute(...args) || baseExecute(...args));
pool.getConnection = async () => {
  const scope = transactions.getStore();
  if (!scope) return baseGetConnection();
  let finished = false;
  // Nested services participate in the parent transaction; they never commit it.
  return {
    query: scope.connection.query.bind(scope.connection),
    execute: scope.connection.execute.bind(scope.connection),
    beginTransaction: async () => { finished = false; },
    commit: async () => { finished = true; }, release: () => {},
    rollback: async () => { if (!finished) scope.rollbackOnly = true; finished = true; }
  };
};
pool.withTransaction = async callback => {
  if (transactions.getStore()) return callback();
  const connection = await baseGetConnection();
  const scope = { connection, rollbackOnly: false };
  try {
    await connection.beginTransaction();
    const result = await transactions.run(scope, callback);
    if (scope.rollbackOnly) throw new Error('Transaction annulée par une opération imbriquée.');
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
};
pool.inTransaction = () => Boolean(transactions.getStore());
module.exports = pool;
