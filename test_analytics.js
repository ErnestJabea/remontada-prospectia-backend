const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const pool = require('./db');
const { analytics, period, canRead } = require('./services/analytics');
after(async () => pool.end());

test('periods reject invalid dates, unknown filters and unbounded ranges', () => {
  for (const query of [{start:'2026-02-30'}, {start:['2026-01-01']}, {start:'2020-01-01'}, {end:'2999-01-01'}, {commercial_id:'2'}, {start:'2026-09-12',end:'2026-09-01'}]) assert.throws(() => period(query,new Date('2026-09-12T12:00:00Z')));
  assert.deepEqual(period({start:'2026-09-01',end:'2026-09-07'},new Date('2026-09-12')), {start:'2026-09-01',end:'2026-09-07',exclusiveEnd:'2026-09-08',previousStart:'2026-08-25',days:7});
});
test('role restrictions apply to analytics including administrative modules', async () => {
  for (const module of ['permissions','security','referentials','commerciaux']) assert.equal(canRead(module,{role:'COMMERCIAL'}),false);
  assert.equal(canRead('security',{role:'DIRECTION'}),false);
  await assert.rejects(analytics(null,'permissions',{id:1,role:'COMMERCIAL'},period({})), {status:403});
  await assert.rejects(analytics(null,'unknown',{id:1,role:'ADMIN'},period({})), {status:404});
});
test('all ten modules execute on the current schema in a read-only consistent snapshot', async () => {
  const db = await pool.getConnection();
  try {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    for (const module of ['dashboard','objectives','missions','institutions','opportunities','reports','commerciaux','referentials','security','permissions']) {
      const data = await analytics(db,module,{id:1,role:'ADMIN'},period({}));
      assert.ok(data.metrics?.length || data.sections, module);
    }
  } finally { await db.rollback(); db.release(); }
});
test('isolated fixtures verify monetary totals, wins, old backlog and two-user isolation', async () => {
  // Temporary tables shadow real tables on this connection only; persistent data is untouched.
  const db = await pool.getConnection();
  try {
    await db.query('CREATE TEMPORARY TABLE crm_opportunities (id INT, title VARCHAR(100), assigned_to INT, status VARCHAR(50), pipeline_stage VARCHAR(50), estimated_amount DECIMAL(15,2), created_at DATETIME, updated_at DATETIME)');
    await db.query(`INSERT INTO crm_opportunities (id,title,assigned_to,status,pipeline_stage,estimated_amount,created_at,updated_at) VALUES
      (900001,'A',101,'WON','SIGNATURE',100,'2026-09-01','2026-09-01'),
      (900002,'B',101,'LOST','DECISION',200,'2026-09-02','2026-09-02'),
      (900003,'C',202,'NEGOTIATION','NEGOCIATION',900,'2026-09-03','2026-09-03'),
      (900004,'D',101,'PROPOSAL','PROPOSITION',300,'2026-01-01','2026-01-01')`);
    const range = period({start:'2026-09-01',end:'2026-09-07'},new Date('2026-09-12'));
    const first = await analytics(db,'opportunities',{id:101,role:'COMMERCIAL'},range);
    const second = await analytics(db,'opportunities',{id:202,role:'COMMERCIAL'},range);
    assert.equal(first.metrics[0].value,2);
    assert.equal(first.metrics[1].value,0);
    assert.equal(first.metrics[2].value,50);
    assert.equal(first.stockMetrics[0].value,3);
    assert.equal(first.stockMetrics[1].value,300);
    assert.equal(second.metrics[0].value,1);
    assert.equal(second.metrics[1].value,900);
    assert.equal(second.metrics[2].value,null);
    assert.equal(first.trend.length,7);
    assert.equal(first.trend[2].value,0);
    assert.equal(first.trend.reduce((sum,r)=>sum+r.value,0),2);
    const empty = await analytics(db,'opportunities',{id:303,role:'COMMERCIAL'},range);
    assert.equal(empty.metrics[0].value,0);
    assert.deepEqual(empty.groups,[]);
  } finally { await db.query('DROP TEMPORARY TABLE IF EXISTS crm_opportunities'); db.release(); }
});
test('HTTP rejects requests without a session and commercial access to security', async () => {
  const express = require('express');
  const app = express();
  // Test identity injection is confined to this test harness; production uses authenticate.
  app.use((req,res,next)=> {if(req.get('X-Test-Role')) req.user={id:101,role:req.get('X-Test-Role')};next();});
  app.use('/analytics',require('./routes/analytics'));
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const url = `http://127.0.0.1:${server.address().port}/analytics`;
  try {
    assert.equal((await fetch(url+'/missions')).status,401);
    assert.equal((await fetch(url+'/security',{headers:{'X-Test-Role':'COMMERCIAL'}})).status,403);
    assert.equal((await fetch(url+'/permissions',{headers:{'X-Test-Role':'ADMIN'}})).status,200);
    assert.equal((await fetch(url+'/missions?start=invalid',{headers:{'X-Test-Role':'ADMIN'}})).status,400);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
