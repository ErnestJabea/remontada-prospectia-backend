const pool = require('../db');
const { notifyDirection, notifyUser } = require('../utils/notifications');

const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);

function isManager(user) {
  return MANAGER_ROLES.has(user.role);
}

class ReportWorkflowService {
  /**
   * Helper to retrieve report and basic mission info
   */
  static async getReport(id) {
    const [rows] = await pool.query(
      `SELECT rp.*, m.title AS mission_title, m.primary_commercial_id
       FROM crm_reports rp
       LEFT JOIN crm_missions m ON rp.mission_id = m.id
       WHERE rp.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Helper to check access permission
   */
  static canAccess(report, user) {
    if (isManager(user)) return true;
    // For commercial, check if they are the designated commercial of the report
    // (either via report.commercial_id or mission.primary_commercial_id)
    return report.commercial_id === user.id || report.primary_commercial_id === user.id;
  }

  /**
   * Log status transition in histories table
   */
  static async logHistory(reportId, oldStatus, newStatus, action, comment, userId) {
    await pool.query(
      `INSERT INTO crm_report_histories 
       (activity_report_id, old_status, new_status, action, comment, performed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [reportId, oldStatus, newStatus, action, comment || null, userId]
    );
  }

  /**
   * Action: Generate draft from completed mission
   */
  static async generateFromMission(missionId, userId) {
    // 1. Fetch mission
    const [mRows] = await pool.query(
      `SELECT * FROM crm_missions WHERE id = ?`,
      [missionId]
    );
    const mission = mRows[0];
    if (!mission) throw new Error('Mission introuvable.');

    // 2. Check if report already exists for this mission
    const [existing] = await pool.query(
      'SELECT id, status FROM crm_reports WHERE mission_id = ?',
      [missionId]
    );
    if (existing.length > 0) {
      return { id: existing[0].id, status: existing[0].status, message: 'Le rapport existe déjà.' };
    }

    // 3. Auto-generate code
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    // Insert initial draft in BROUILLON_AUTO
    const [result] = await pool.query(
      `INSERT INTO crm_reports (
        mission_id, objective_id, institution_id, commercial_id, 
        report_type, status, executive_summary, administrations_visited, 
        persons_met, generated_from, generated_by
      ) VALUES (?, ?, ?, ?, 'mission_report', 'BROUILLON_AUTO', '', '', '', 'system', ?)`,
      [
        missionId, 
        mission.objective_id, 
        mission.institution_id, 
        mission.primary_commercial_id,
        userId
      ]
    );

    const reportId = result.insertId;
    const code = `RAP-${dateStr}-${String(reportId).padStart(4, '0')}`;
    
    await pool.query('UPDATE crm_reports SET code = ? WHERE id = ?', [code, reportId]);

    // Log history
    await this.logHistory(reportId, null, 'BROUILLON_AUTO', 'Génération automatique', 'Rapport généré après complétion de la mission', userId);

    return { id: reportId, code, status: 'BROUILLON_AUTO', message: 'Rapport brouillon généré.' };
  }

  /**
   * Action: Submit report
   */
  static async submit(reportId, user) {
    const report = await this.getReport(reportId);
    if (!report) throw new Error('Rapport introuvable.');
    if (!this.canAccess(report, user)) throw new Error('Accès refusé.');

    // Allowed status transitions for submit
    const allowed = ['BROUILLON_AUTO', 'A_COMPLETER', 'CORRECTION_DEMANDEE', 'DRAFT', 'REJECTED'];
    if (!allowed.includes(report.status)) {
      throw new Error(`Transition impossible : statut actuel '${report.status}' ne permet pas la soumission.`);
    }

    // Validation rules
    if (!report.executive_summary || !report.executive_summary.trim()) {
      throw new Error('Le résumé exécutif est obligatoire avant la soumission.');
    }
    if (!report.results || !report.results.trim()) {
      throw new Error('Les résultats obtenus sont obligatoires avant la soumission.');
    }
    if (!report.institution_id) {
      throw new Error("L'institution concernée est obligatoire avant la soumission.");
    }

    const oldStatus = report.status;
    const newStatus = 'SOUMIS';

    await pool.query(
      `UPDATE crm_reports 
       SET status = ?, submitted_by = ?, submitted_at = NOW() 
       WHERE id = ?`,
      [newStatus, user.id, reportId]
    );

    await this.logHistory(reportId, oldStatus, newStatus, 'Soumettre au responsable', null, user.id);

    // Notify managers
    await notifyDirection(
      'Rapport Soumis',
      `Le rapport d'activité "${report.code || reportId}" a été soumis par ${user.full_name} pour validation.`,
      'REPORT_SUBMITTED',
      reportId
    );

    return { message: 'Rapport soumis pour validation.', newStatus };
  }

  /**
   * Action: Request correction (GATE 2)
   */
  static async requestCorrection(reportId, user, comment) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable requis.');
    if (!comment || !comment.trim()) {
      throw new Error('Un commentaire est obligatoire pour demander des corrections.');
    }

    const report = await this.getReport(reportId);
    if (!report) throw new Error('Rapport introuvable.');

    if (report.status !== 'SOUMIS' && report.status !== 'SUBMITTED') {
      throw new Error(`Transition impossible : statut actuel '${report.status}' ne permet pas de demander de correction.`);
    }

    const oldStatus = report.status;
    const newStatus = 'CORRECTION_DEMANDEE';

    await pool.query(
      `UPDATE crm_reports 
       SET status = ?, correction_requested_by = ?, correction_requested_at = NOW(), correction_comment = ? 
       WHERE id = ?`,
      [newStatus, user.id, comment.trim(), reportId]
    );

    await this.logHistory(reportId, oldStatus, newStatus, 'Demander des corrections', comment, user.id);

    // Notify commercial
    const targetCommercialId = report.commercial_id || report.primary_commercial_id;
    if (targetCommercialId) {
      await notifyUser(
        targetCommercialId,
        'Correction demandée sur votre rapport',
        `Des corrections ont été demandées sur le rapport "${report.code || reportId}". Commentaire: ${comment}`,
        'REPORT_CORRECTION_REQUESTED',
        reportId
      );
    }

    return { message: 'Demande de correction enregistrée.', newStatus };
  }

  /**
   * Action: Validate report (GATE 2)
   */
  static async validateReport(reportId, user) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable requis.');

    const report = await this.getReport(reportId);
    if (!report) throw new Error('Rapport introuvable.');

    if (report.status !== 'SOUMIS' && report.status !== 'SUBMITTED') {
      throw new Error(`Transition impossible : statut actuel '${report.status}' ne permet pas la validation.`);
    }

    const oldStatus = report.status;
    const newStatus = 'VALIDE';

    await pool.query(
      `UPDATE crm_reports 
       SET status = ?, validated_by = ?, validated_at = NOW() 
       WHERE id = ?`,
      [newStatus, user.id, reportId]
    );

    await this.logHistory(reportId, oldStatus, newStatus, 'Valider le rapport', null, user.id);

    // Clôturer la mission associée si présente
    if (report.mission_id) {
      await pool.query(
        `UPDATE crm_missions 
         SET status = 'CLOSED', closed_at = NOW() 
         WHERE id = ?`,
        [report.mission_id]
      );
    }

    // Notify commercial
    const targetCommercialId = report.commercial_id || report.primary_commercial_id;
    if (targetCommercialId) {
      await notifyUser(
        targetCommercialId,
        'Rapport validé',
        `Félicitations, votre rapport "${report.code || reportId}" a été validé par ${user.full_name}.`,
        'REPORT_VALIDATED',
        reportId
      );
    }

    return { message: 'Rapport validé avec succès (mission clôturée).', newStatus };
  }

  /**
   * Action: Reject report (GATE 2)
   */
  static async reject(reportId, user, comment) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable requis.');
    if (!comment || !comment.trim()) {
      throw new Error('Le motif de rejet est obligatoire.');
    }

    const report = await this.getReport(reportId);
    if (!report) throw new Error('Rapport introuvable.');

    if (report.status !== 'SOUMIS' && report.status !== 'SUBMITTED') {
      throw new Error(`Transition impossible : statut actuel '${report.status}' ne permet pas le rejet.`);
    }

    const oldStatus = report.status;
    const newStatus = 'REJETE';

    await pool.query(
      `UPDATE crm_reports 
       SET status = ?, rejected_by = ?, rejected_at = NOW(), rejection_reason = ? 
       WHERE id = ?`,
      [newStatus, user.id, comment.trim(), reportId]
    );

    await this.logHistory(reportId, oldStatus, newStatus, 'Rejeter le rapport', comment, user.id);

    // Notify commercial
    const targetCommercialId = report.commercial_id || report.primary_commercial_id;
    if (targetCommercialId) {
      await notifyUser(
        targetCommercialId,
        'Rapport rejeté',
        `Votre rapport "${report.code || reportId}" a été rejeté. Motif : ${comment}`,
        'REPORT_REJECTED',
        reportId
      );
    }

    return { message: 'Rapport marqué comme rejeté.', newStatus };
  }

  /**
   * Action: Archive report
   */
  static async archive(reportId, user) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable requis.');

    const report = await this.getReport(reportId);
    if (!report) throw new Error('Rapport introuvable.');

    if (report.status !== 'VALIDE') {
      throw new Error(`Transition impossible : seul un rapport validé peut être archivé (actuel: '${report.status}').`);
    }

    const oldStatus = report.status;
    const newStatus = 'ARCHIVE';

    await pool.query(
      `UPDATE crm_reports 
       SET status = ?, archived_by = ?, archived_at = NOW() 
       WHERE id = ?`,
      [newStatus, user.id, reportId]
    );

    await this.logHistory(reportId, oldStatus, newStatus, 'Archiver le rapport', null, user.id);

    return { message: 'Rapport archivé avec succès.', newStatus };
  }
}

module.exports = ReportWorkflowService;
