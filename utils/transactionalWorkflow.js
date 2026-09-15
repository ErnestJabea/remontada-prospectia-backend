const pool = require('../db');

function transactionalWorkflow(Service, table, getters) {
  for (const name of Object.getOwnPropertyNames(Service)) {
    if (['length','name','prototype',...getters].includes(name) || typeof Service[name] !== 'function') continue;
    const original = Service[name];
    Service[name] = async function (...args) {
      return pool.withTransaction(async () => {
        const lockTable = name === 'generateFromMission' ? 'crm_missions' : table;
        await pool.query(`SELECT id FROM ${lockTable} WHERE id = ? FOR UPDATE`, [args[0]]);
        return original.apply(this,args);
      });
    };
  }
  return Service;
}
module.exports = transactionalWorkflow;
