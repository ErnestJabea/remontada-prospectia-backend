// Local smoke test: only GET requests. Authentication updates last_activity.
// A short-lived token stays in memory; credentials and business records are never printed.
require('dotenv').config();
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('./db');
async function main() {
  const [[user]] = await pool.query("SELECT id,role,auth_version FROM users WHERE role='SYSTEM' AND is_active=1 ORDER BY id LIMIT 1");
  assert.ok(user,'An active local SYSTEM account is required for the complete read-only smoke test.');
  const token=jwt.sign({id:user.id,role:user.role,authVersion:user.auth_version,clientType:'mobile_pwa',jti:crypto.randomUUID()},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:120});
  const modules=['dashboard','objectives','missions','institutions','opportunities','reports','commerciaux','referentials','security','permissions'];
  const origins=['http://127.0.0.1:3012','http://127.0.0.1:5174','http://127.0.0.1:5175'];
  let verified=0;
  for(const origin of origins){
    const health=await fetch(origin+'/api/v1/health');assert.equal(health.status,200);assert.equal((await health.json()).status,'ok');
    assert.equal((await fetch(origin+'/api/v1/analytics/dashboard')).status,401);
    const profile=await fetch(origin+'/api/v1/auth/me',{headers:{Authorization:'Bearer '+token}});
    assert.equal(profile.status,200);assert.ok(Array.isArray((await profile.json()).user.jobPermissions),'Updated API contract is active');
    for(const days of [30,365]){
      const end=new Date(),start=new Date(end.getTime()-(days-1)*86400000);
      const query=new URLSearchParams({start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)});
      for(const module of modules){
        const response=await fetch(origin+'/api/v1/analytics/'+module+'?'+query,{headers:{Authorization:'Bearer '+token}});
        assert.equal(response.status,200,origin+' '+module+' '+days+' days');
        const data=await response.json();assert.ok(data.sections || Array.isArray(data.metrics));verified++;
      }
    }
    console.log('PASS '+origin+': health, authentication, updated profile and 10 monitoring modules at 30/365 days');
  }
  for(const origin of origins.slice(1)){
    const response=await fetch(origin);assert.equal(response.status,200);assert.match(await response.text(),/<div id="root"><\/div>/);
  }
  console.log('RESULT '+verified+' authenticated analytics responses; both HTML frontends and all three API paths are reachable.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
