/**
 * Migration script for reports schema v2 (Rapports d'Activité)
 * Run: node backend/migrate_reports_v2.js
 */
const pool = require('./db');

async function migrate() {
  try {
    console.log('🚀 Starting migration for reports schema v2...');

    // 1. Check existing columns in crm_reports to perform non-destructive updates
    const [columns] = await pool.query('SHOW COLUMNS FROM crm_reports');
    const existingCols = columns.map(c => c.Field);

    console.log('  🔍 Current columns in crm_reports:', existingCols.join(', '));

    // Modify status column type to VARCHAR(50)
    await pool.query(`
      ALTER TABLE crm_reports 
      MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'BROUILLON_AUTO'
    `);
    console.log('  ✅ Modified status column to VARCHAR(50) with default BROUILLON_AUTO.');

    // Helper function to add column if it doesn't exist
    const addColumn = async (colName, colDefinition) => {
      if (!existingCols.includes(colName)) {
        await pool.query(`ALTER TABLE crm_reports ADD COLUMN ${colName} ${colDefinition}`);
        console.log(`  ✅ Added column: ${colName}`);
      } else {
        console.log(`  ℹ️ Column ${colName} already exists.`);
      }
    };

    // Add new columns to crm_reports
    await addColumn('code', "VARCHAR(50) UNIQUE DEFAULT NULL AFTER id");
    await addColumn('report_type', "VARCHAR(50) NOT NULL DEFAULT 'mission_report' AFTER code");
    await addColumn('objective_id', "INT DEFAULT NULL AFTER mission_id");
    await addColumn('institution_id', "INT DEFAULT NULL AFTER objective_id");
    await addColumn('commercial_id', "INT DEFAULT NULL AFTER institution_id");
    await addColumn('team_id', "INT DEFAULT NULL AFTER commercial_id");
    await addColumn('period_start', "DATE DEFAULT NULL AFTER team_id");
    await addColumn('period_end', "DATE DEFAULT NULL AFTER period_start");
    await addColumn('results', "TEXT DEFAULT NULL AFTER executive_summary");
    await addColumn('diagnosis', "TEXT DEFAULT NULL AFTER results");
    await addColumn('next_steps', "TEXT DEFAULT NULL AFTER recommendations");
    await addColumn('generated_from', "VARCHAR(50) NOT NULL DEFAULT 'system' AFTER next_steps");
    await addColumn('generated_by', "INT DEFAULT NULL AFTER generated_from");
    await addColumn('submitted_by', "INT DEFAULT NULL AFTER generated_by");
    await addColumn('submitted_at', "TIMESTAMP NULL DEFAULT NULL AFTER submitted_by");
    await addColumn('validated_by', "INT DEFAULT NULL AFTER submitted_at");
    await addColumn('validated_at', "TIMESTAMP NULL DEFAULT NULL AFTER validated_by");
    await addColumn('rejected_by', "INT DEFAULT NULL AFTER validated_at");
    await addColumn('rejected_at', "TIMESTAMP NULL DEFAULT NULL AFTER rejected_by");
    await addColumn('rejection_reason', "TEXT DEFAULT NULL AFTER rejected_at");
    await addColumn('correction_requested_by', "INT DEFAULT NULL AFTER rejection_reason");
    await addColumn('correction_requested_at', "TIMESTAMP NULL DEFAULT NULL AFTER correction_requested_by");
    await addColumn('correction_comment', "TEXT DEFAULT NULL AFTER correction_requested_at");
    await addColumn('archived_by', "INT DEFAULT NULL AFTER correction_comment");
    await addColumn('archived_at', "TIMESTAMP NULL DEFAULT NULL AFTER archived_by");
    await addColumn('pdf_path', "VARCHAR(255) DEFAULT NULL AFTER archived_at");

    // Add Foreign Keys to crm_reports (wrapped in try-catch in case constraints already exist)
    const addFK = async (col, refTable, refCol) => {
      try {
        await pool.query(`
          ALTER TABLE crm_reports
          ADD CONSTRAINT fk_reports_${col}
          FOREIGN KEY (${col}) REFERENCES ${refTable}(${refCol}) ON DELETE SET NULL
        `);
        console.log(`  ✅ Added foreign key constraint for ${col} -> ${refTable}(${refCol})`);
      } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_FK_DUP_NAME') {
          console.log(`  ℹ️ Foreign key for ${col} already exists.`);
        } else {
          console.warn(`  ⚠️ Warning: Could not create foreign key for ${col}:`, err.message);
        }
      }
    };

    await addFK('objective_id', 'crm_objectives', 'id');
    await addFK('institution_id', 'crm_institutions', 'id');
    await addFK('commercial_id', 'users', 'id');
    await addFK('generated_by', 'users', 'id');
    await addFK('submitted_by', 'users', 'id');
    await addFK('validated_by', 'users', 'id');
    await addFK('rejected_by', 'users', 'id');
    await addFK('correction_requested_by', 'users', 'id');
    await addFK('archived_by', 'users', 'id');

    // Make mission_id nullable in crm_reports (since we support periodic or manual reports)
    try {
      await pool.query(`
        ALTER TABLE crm_reports MODIFY COLUMN mission_id INT NULL DEFAULT NULL
      `);
      console.log('  ✅ Modified mission_id column in crm_reports to be nullable.');
    } catch (err) {
      console.warn('  ⚠️ Warning: Could not make mission_id nullable:', err.message);
    }

    // 2. Create table crm_report_opportunities
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_report_opportunities (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_report_id INT NOT NULL,
        opportunity_id INT NOT NULL,
        relation_type VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (activity_report_id) REFERENCES crm_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(id) ON DELETE CASCADE,
        UNIQUE KEY uq_report_opportunity (activity_report_id, opportunity_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_report_opportunities created.');

    // 3. Create table crm_report_histories
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_report_histories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_report_id INT NOT NULL,
        old_status VARCHAR(50) DEFAULT NULL,
        new_status VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        comment TEXT DEFAULT NULL,
        performed_by INT NOT NULL,
        performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (activity_report_id) REFERENCES crm_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_report_histories created.');

    // 4. Create table crm_report_comments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_report_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        activity_report_id INT NOT NULL,
        user_id INT NOT NULL,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (activity_report_id) REFERENCES crm_reports(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✅ Table crm_report_comments created.');

    // 5. Update existing reports to have correct codes if code is null
    const [existingReports] = await pool.query('SELECT id, created_at FROM crm_reports WHERE code IS NULL');
    for (const rep of existingReports) {
      const dateStr = new Date(rep.created_at || Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
      const code = `RAP-${dateStr}-${String(rep.id).padStart(4, '0')}`;
      await pool.query('UPDATE crm_reports SET code = ? WHERE id = ?', [code, rep.id]);
    }
    console.log(`  ✅ Generated unique codes for ${existingReports.length} existing reports.`);

    console.log('🎉 Migration complétée avec succès !');
    process.exit(0);
  } catch (err) {
    console.error('❌ Critical error during migration:', err);
    process.exit(1);
  }
}

migrate();
