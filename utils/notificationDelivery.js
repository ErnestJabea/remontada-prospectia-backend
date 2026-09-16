const pool = require('../db');
const webpush = require('web-push');
const mail = require('./mailer');
const crypto = require('node:crypto');
function pushConfigured() { return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT); }
function validSubscription(subscription) {
  try {
    const url = new URL(subscription.endpoint);
    const hosts = ['fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com','web.push.apple.com','wns.windows.com'];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && subscription.endpoint.length < 2048 &&
      hosts.some(host=>url.hostname===host || url.hostname.endsWith('.'+host)) &&
      /^[A-Za-z0-9_-]{87}$/.test(subscription.keys?.p256dh || '') && /^[A-Za-z0-9_-]{22}$/.test(subscription.keys?.auth || '');
  } catch { return false; }
}
const endpointHash = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex');
let running = false;
async function deliverPending() {
  if (running) return;
  running = true;
  try {
    const [rows] = await pool.query(`SELECT id FROM notification_deliveries WHERE
      (status='pending' AND next_attempt_at<=NOW()) OR (status='processing' AND locked_until<NOW()) ORDER BY id LIMIT 20`);
    for (const row of rows) {
      const [claim] = await pool.query(`UPDATE notification_deliveries SET status='processing',locked_until=DATE_ADD(NOW(),INTERVAL 5 MINUTE),attempts=attempts+1
        WHERE id=? AND ((status='pending' AND next_attempt_at<=NOW()) OR (status='processing' AND locked_until<NOW()))`,[row.id]);
      if (!claim.affectedRows) continue;
      try {
        const [[item]] = await pool.query(`SELECT d.*,n.user_id,n.title,n.message,n.type,n.target_id,u.email,u.settings,u.is_active
          FROM notification_deliveries d JOIN crm_notifications n ON n.id=d.notification_id JOIN users u ON u.id=n.user_id WHERE d.id=?`,[row.id]);
        if (!item) { await pool.query("UPDATE notification_deliveries SET status='skipped' WHERE id=?",[row.id]); continue; }
        let settings = item.settings || {};
        if (typeof settings==='string') { try { settings=JSON.parse(settings); } catch { settings={}; } }
        let skipped = !item.is_active;
        if (!skipped && item.channel==='email') {
          skipped = settings.notifications?.email===false || !item.email;
          if (!skipped) await mail.sendNotificationEmail(item.email,item.title,item.message,item.notification_id);
        }
        if (!skipped && item.channel==='push') {
          skipped = settings.notifications?.push===false;
          if (!skipped) {
            const [subscriptions] = await pool.query('SELECT * FROM notification_push_subscriptions WHERE user_id=?',[item.user_id]);
            skipped = !subscriptions.length;
            if (!skipped && !pushConfigured()) throw new Error('VAPID_NOT_CONFIGURED');
            for (const saved of subscriptions) {
              const subscription = JSON.parse(saved.subscription);
              if (!validSubscription(subscription)) throw new Error('INVALID_PUSH_ENDPOINT');
              try {
                await webpush.sendNotification(subscription,JSON.stringify({title:item.title,body:item.message,id:item.notification_id,module:'objectives',targetId:item.target_id}),{
                  TTL:86400,timeout:10000,vapidDetails:{subject:process.env.VAPID_SUBJECT,publicKey:process.env.VAPID_PUBLIC_KEY,privateKey:process.env.VAPID_PRIVATE_KEY}
                });
              } catch (error) {
                if ([404,410].includes(error.statusCode)) await pool.query('DELETE FROM notification_push_subscriptions WHERE id=?',[saved.id]);
                else throw error;
              }
            }
          }
        }
        await pool.query("UPDATE notification_deliveries SET status=?,sent_at=IF(?='sent',NOW(),NULL),locked_until=NULL,last_error=NULL WHERE id=?",[skipped?'skipped':'sent',skipped?'skipped':'sent',row.id]);
      } catch(error) {
        // No recipient address, subscription endpoint or provider payload in logs.
        await pool.query(`UPDATE notification_deliveries SET status=IF(attempts>=10,'failed','pending'),locked_until=NULL,
          next_attempt_at=DATE_ADD(NOW(),INTERVAL LEAST(3600,POW(2,attempts)*15) SECOND),last_error=? WHERE id=?`,[String(error.code || error.statusCode || 'DELIVERY_FAILED').slice(0,160),row.id]);
      }
    }
  } finally { running=false; }
}
function startDeliveryWorker() {
  const timer=setInterval(()=>deliverPending().catch(error=>console.error('[NOTIFICATION_WORKER]',error.code || 'FAILED')),2000);
  timer.unref();
  return ()=>clearInterval(timer);
}
module.exports={deliverPending,startDeliveryWorker,pushConfigured,validSubscription,endpointHash};
