const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const crypto = require('node:crypto');
const { assertFeature, scopeRestricted } = require('../middleware/featureAccess');
const { pushConfigured, validSubscription, endpointHash } = require('../utils/notificationDelivery');
router.get('/push-key',authenticate,(req,res)=>res.json({publicKey:pushConfigured()?process.env.VAPID_PUBLIC_KEY:null}));
router.post('/subscriptions',authenticate,async(req,res,next)=>{
  try {
    if (!pushConfigured()) return res.status(503).json({error:'Le service push n’est pas configuré.'});
    if (!validSubscription(req.body)) return res.status(400).json({error:'Abonnement push invalide.'});
    const [[count]]=await pool.query('SELECT COUNT(*) n FROM notification_push_subscriptions WHERE user_id=? AND endpoint_hash<>?',[req.user.id,endpointHash(req.body.endpoint)]);
    if(count.n>=10) return res.status(409).json({error:'La limite de dix appareils abonnés est atteinte.'});
    await pool.query(`INSERT INTO notification_push_subscriptions(user_id,endpoint_hash,subscription) VALUES(?,?,?)
      ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),subscription=VALUES(subscription)`,[req.user.id,endpointHash(req.body.endpoint),JSON.stringify(req.body)]);
    res.json({success:true});
  } catch(error) {next(error);}
});
router.delete('/subscriptions',authenticate,async(req,res,next)=>{
  try {
    if (typeof req.body.endpoint!=='string') return res.status(400).json({error:'Abonnement requis.'});
    await pool.query('DELETE FROM notification_push_subscriptions WHERE user_id=? AND endpoint_hash=?',[req.user.id,endpointHash(req.body.endpoint)]);
    res.json({success:true});
  } catch(error) {next(error);}
});
// Stream only committed, user-scoped data. Polling the database also supports multiple API instances.
router.get('/stream',authenticate,async(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders();
  let closed=false, previous='', timer;
  const token=req.cookies?.crm_access || req.headers.authorization?.slice(7);
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  const stop=()=>{closed=true;clearTimeout(timer);};
  res.on('close',stop);
  const tick=async()=>{
    if(closed) return;
    try {
      const [[user]]=await pool.query('SELECT is_active,auth_version,job_description_id,role FROM users WHERE id=?',[req.user.id]);
      const [revoked]=await pool.query('SELECT token_hash FROM revoked_access_tokens WHERE token_hash=? AND expires_at>NOW()',[hash]);
      if(!user?.is_active || user.role!==req.user.role || Number(user.auth_version)!==Number(req.user.authVersion||0) || user.job_description_id!==req.user.job_description_id || revoked.length || Date.now()>=req.user.exp*1000) { res.end();stop();return; }
      if(user.job_description_id && req.user.role!=='SYSTEM') {
        [req.user.jobPermissions]=await pool.query('SELECT * FROM job_feature_permissions WHERE job_description_id=?',[user.job_description_id]);
      }
      const [notifications]=await pool.query('SELECT * FROM crm_notifications WHERE user_id=? ORDER BY id DESC LIMIT 50',[req.user.id]);
      let objectiveVersion='';
      try {
        assertFeature(req.user,'objectives');
        const restricted=scopeRestricted(req.user,'objectives');
        const [objectives]=await pool.query(`SELECT o.id,o.status,o.updated_at FROM crm_objectives o ${restricted ? "WHERE o.created_by=? OR o.responsible_id=? OR EXISTS (SELECT 1 FROM objectif_affectations a WHERE a.objective_id=o.id AND a.type='COMMERCIAL' AND a.target_id=?)" : ''} ORDER BY o.id`,restricted?[req.user.id,req.user.id,req.user.id]:[]);
        objectiveVersion=crypto.createHash('sha256').update(JSON.stringify(objectives)).digest('hex');
      } catch(error) {if(error.status!==403) throw error;}
      const payload={notifications,objectiveVersion};
      const signature=JSON.stringify(payload);
      if(!closed && previous!==signature) {res.write(`data: ${signature}\n\n`);previous=signature;}
      else if(!closed) res.write(': heartbeat\n\n');
    } catch { if(!closed) res.end();stop();return; }
    if(!closed) timer=setTimeout(tick,3000);
  };
  tick();
});

// GET /api/notifications - Récupérer toutes les notifications de l'utilisateur connecté
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM crm_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[NOTIFICATIONS/LIST]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/notifications/:id/read - Marquer une notification comme lue
router.post('/:id/read', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE crm_notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Notification marquée comme lue.' });
  } catch (err) {
    console.error('[NOTIFICATIONS/READ]', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
