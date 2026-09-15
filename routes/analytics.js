const router = require('express').Router();
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { analytics, period } = require('../services/analytics');

router.get('/:module', authenticate, async (req,res,next) => {
  let connection;
  try {
    const range = period(req.query);
    connection = await pool.getConnection();
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const data = await analytics(connection,req.params.module,req.user,range);
    await connection.commit();
    res.set('Cache-Control','no-store');
    res.json({...data,period:range,generatedAt:new Date().toISOString(),scope:req.user.role === 'COMMERCIAL' ? 'personal' : 'organization'});
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    next(error);
  } finally { if (connection) connection.release(); }
});
module.exports = router;
