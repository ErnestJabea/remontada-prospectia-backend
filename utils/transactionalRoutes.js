const pool = require('../db');
// Only for JSON-only mutation handlers; never wrap downloads or streaming routes.
module.exports = function transactionalRoutes(router, table, paths) {
  for (const layer of router.stack) {
    if (!layer.route || !paths.includes(layer.route.path)) continue;
    if (!['post','put','patch','delete'].some(method => layer.route.methods[method])) continue;
    for (const item of layer.route.stack.slice(-1)) {
      const handler = item.handle;
      item.handle = async (req,res,next) => {
        const send = res.json.bind(res);
        let body;
        res.json = value => { body = value; return res; };
        try {
          await pool.withTransaction(async () => {
            if (req.params.id) await pool.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [req.params.id]);
            await handler(req,res,next);
            if (res.statusCode >= 400) throw Object.assign(new Error('Mutation refusée.'), { buffered: true });
            await pool.query('INSERT INTO crm_audit_logs (user_id, action_type, module_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)', [req.user.id, `${req.method} ${req.path}`.slice(0,100), table, JSON.stringify({action:req.body.action,status:req.body.status}), (req.ip || '').slice(0,45)]);
          });
          res.json = send;
          return send(body);
        } catch (error) {
          res.json = send;
          if (error.buffered) return send(body);
          return next(error);
        }
      };
    }
  }
};
