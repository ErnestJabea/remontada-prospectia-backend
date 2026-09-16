const pool = require('./db');
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS notification_push_subscriptions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
    endpoint_hash CHAR(64) NOT NULL UNIQUE, subscription TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(user_id)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS notification_deliveries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, notification_id BIGINT NOT NULL,
    channel VARCHAR(10) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0, next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_until DATETIME NULL, last_error VARCHAR(160) NULL, sent_at DATETIME NULL,
    UNIQUE KEY notification_channel(notification_id,channel), INDEX(status,next_attempt_at)
  ) ENGINE=InnoDB`);
}
if (require.main === module) migrate().then(()=>console.log('Notification schema ready')).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>pool.end());
module.exports=migrate;
