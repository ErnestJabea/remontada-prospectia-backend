const pool = require('../db');
const { notifyDirection, notifyUser } = require('../utils/notifications');

const MANAGER_ROLES = new Set(['DIRECTION', 'SYSTEM', 'ADMIN']);

function isManager(user) {
  return MANAGER_ROLES.has(user.role);
}

class OpportunityWorkflowService {
  /**
   * Helper pour récupérer une opportunité et vérifier son existence
   */
  static async getOpportunity(id) {
    const [rows] = await pool.query(
      'SELECT * FROM crm_opportunities WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Helper pour vérifier l'accès à une opportunité
   */
  static canAccess(opportunity, user) {
    return isManager(user) || opportunity.assigned_to === user.id;
  }

  /**
   * Enregistre l'historique d'une transition
   */
  static async logHistory(opportunityId, oldStatus, newStatus, action, comment, userId) {
    await pool.query(
      `INSERT INTO crm_opportunity_stage_histories 
       (opportunity_id, old_status, new_status, action, comment, performed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [opportunityId, oldStatus, newStatus, action, comment || null, userId]
    );
  }

  /**
   * Transition : Soumettre au responsable
   */
  static async submit(opportunityId, user) {
    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');
    if (!this.canAccess(opp, user)) throw new Error('Accès refusé.');

    // Transition valide depuis DETECTED ou TO_CORRECT
    if (opp.status !== 'DETECTED' && opp.status !== 'TO_CORRECT') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas la soumission.`);
    }

    // Vérifier les champs obligatoires avant soumission
    if (!opp.institution_id || !opp.title?.trim() || !opp.need_description?.trim() || !opp.priority) {
      throw new Error('Champs requis manquants pour la soumission (institution, titre, besoin identifié, priorité).');
    }

    const oldStatus = opp.status;
    const newStatus = 'SUBMITTED';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ? WHERE id = ?',
      [newStatus, 'QUALIFICATION', opportunityId]
    );

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Soumettre au responsable', null, user.id);

    // Notification à la direction
    await notifyDirection(
      'Opportunité Soumise',
      `L'opportunité "${opp.title}" a été soumise par ${user.full_name} pour validation.`,
      'OPPORTUNITY_SUBMITTED',
      opportunityId
    );

    return { message: 'Opportunité soumise pour validation.', newStatus };
  }

  /**
   * Transition : Demander une correction
   */
  static async requestCorrection(opportunityId, user, comment) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable requis.');
    if (!comment?.trim()) throw new Error('Un commentaire est obligatoire pour demander des corrections.');

    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');

    if (opp.status !== 'SUBMITTED') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas de demander une correction.`);
    }

    const oldStatus = opp.status;
    const newStatus = 'TO_CORRECT';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ? WHERE id = ?',
      [newStatus, 'DETECTION', opportunityId]
    );

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Demander correction', comment.trim(), user.id);

    // Notification au commercial affecté
    if (opp.assigned_to) {
      await notifyUser(
        opp.assigned_to,
        'Correction demandée',
        `Des corrections ont été demandées sur l'opportunité "${opp.title}" : "${comment.trim()}".`,
        'OPPORTUNITY_TO_CORRECT',
        opportunityId
      );
    }

    return { message: 'Correction demandée.', newStatus };
  }

  /**
   * Transition : Rejeter
   */
  static async reject(opportunityId, user, comment) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable requis.');
    if (!comment?.trim()) throw new Error('Un commentaire est obligatoire pour rejeter une opportunité.');

    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');

    if (opp.status !== 'SUBMITTED') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas le rejet.`);
    }

    const oldStatus = opp.status;
    const newStatus = 'REJECTED';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ?, validated_by = ?, validated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, 'QUALIFICATION', user.id, opportunityId]
    );

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Rejeter', comment.trim(), user.id);

    // Notification au commercial affecté
    if (opp.assigned_to) {
      await notifyUser(
        opp.assigned_to,
        'Opportunité rejetée',
        `L'opportunité "${opp.title}" a été rejetée par le responsable. Motif : "${comment.trim()}".`,
        'OPPORTUNITY_REJECTED',
        opportunityId
      );
    }

    return { message: 'Opportunité rejetée.', newStatus };
  }

  /**
   * Transition : Valider l'opportunité
   */
  static async validate(opportunityId, user) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable requis.');

    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');

    if (opp.status !== 'SUBMITTED') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas la validation.`);
    }

    const oldStatus = opp.status;
    const newStatus = 'VALIDATED';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ?, validated_by = ?, validated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, 'QUALIFICATION', user.id, opportunityId]
    );

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Valider opportunité', null, user.id);

    // Notification au commercial affecté
    if (opp.assigned_to) {
      await notifyUser(
        opp.assigned_to,
        'Opportunité validée',
        `L'opportunité "${opp.title}" a été validée. Elle est maintenant dans le pipeline.`,
        'OPPORTUNITY_VALIDATED',
        opportunityId
      );
    }

    return { message: 'Opportunité validée.', newStatus };
  }

  /**
   * Transition : Démarrer l'analyse
   */
  static async startAnalysis(opportunityId, user) {
    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');
    if (!this.canAccess(opp, user)) throw new Error('Accès refusé.');

    if (opp.status !== 'VALIDATED') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas de démarrer l'analyse.`);
    }

    const oldStatus = opp.status;
    const newStatus = 'IN_ANALYSIS';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ? WHERE id = ?',
      [newStatus, 'ANALYSE', opportunityId]
    );

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Démarrer analyse', null, user.id);

    return { message: 'Analyse démarrée.', newStatus };
  }

  /**
   * Transition : Créer plan d'action
   */
  static async createActionPlan(opportunityId, user, actions) {
    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');
    if (!this.canAccess(opp, user)) throw new Error('Accès refusé.');

    // Transition valide depuis IN_ANALYSIS ou ACTION_PLAN (mise à jour)
    if (opp.status !== 'IN_ANALYSIS' && opp.status !== 'ACTION_PLAN') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas de définir un plan d'action.`);
    }

    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error('Le plan d\'action doit contenir au moins une action.');
    }

    const oldStatus = opp.status;
    const newStatus = 'ACTION_PLAN';

    // Insérer les actions dans la table crm_opportunity_actions
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Mettre à jour l'opportunité
      await connection.query(
        'UPDATE crm_opportunities SET status = ?, pipeline_stage = ? WHERE id = ?',
        [newStatus, 'ANALYSE', opportunityId]
      );

      for (const act of actions) {
        if (!act.title?.trim() || !act.action_type) {
          throw new Error('Chaque action doit avoir un titre et un type d\'action.');
        }
        await connection.query(
          `INSERT INTO crm_opportunity_actions 
           (opportunity_id, title, description, action_type, assigned_to, due_date, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
          [
            opportunityId,
            act.title.trim(),
            act.description || null,
            act.action_type,
            act.assigned_to || opp.assigned_to || user.id,
            act.due_date || null,
            user.id
          ]
        );
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Créer plan d\'action', `${actions.length} action(s) ajoutée(s).`, user.id);

    return { message: 'Plan d\'action créé avec succès.', newStatus };
  }

  /**
   * Transition : Passer en proposition
   */
  static async moveToProposal(opportunityId, user, proposalData = {}) {
    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');
    if (!this.canAccess(opp, user)) throw new Error('Accès refusé.');

    if (opp.status !== 'ACTION_PLAN' && opp.status !== 'IN_ANALYSIS') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas de passer en proposition.`);
    }

    const oldStatus = opp.status;
    const newStatus = 'PROPOSAL';

    const finalAmount = proposalData.final_amount || opp.estimated_amount;

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ?, final_amount = ? WHERE id = ?',
      [newStatus, 'PROPOSITION', finalAmount, opportunityId]
    );

    await this.logHistory(
      opportunityId, 
      oldStatus, 
      newStatus, 
      'Préparer proposition', 
      `Montant final proposé : ${finalAmount} FCFA. Commentaire : ${proposalData.comment || 'N/A'}`, 
      user.id
    );

    return { message: 'Opportunité passée en proposition.', newStatus };
  }

  /**
   * Transition : Passer en négociation
   */
  static async moveToNegotiation(opportunityId, user, data = {}) {
    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');
    if (!this.canAccess(opp, user)) throw new Error('Accès refusé.');

    if (opp.status !== 'PROPOSAL') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas de passer en négociation.`);
    }

    const oldStatus = opp.status;
    const newStatus = 'NEGOTIATION';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ? WHERE id = ?',
      [newStatus, 'NEGOCIATION', opportunityId]
    );

    await this.logHistory(
      opportunityId, 
      oldStatus, 
      newStatus, 
      'Passer en négociation', 
      data.comment || 'Discussion sur les termes et conditions.', 
      user.id
    );

    return { message: 'Opportunité passée en négociation.', newStatus };
  }

  /**
   * Transition : Enregistrer décision
   */
  static async moveToDecision(opportunityId, user, data = {}) {
    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');
    if (!this.canAccess(opp, user)) throw new Error('Accès refusé.');

    if (opp.status !== 'NEGOTIATION' && opp.status !== 'PROPOSAL') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas de passer en décision.`);
    }

    const oldStatus = opp.status;
    const newStatus = 'DECISION';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, pipeline_stage = ? WHERE id = ?',
      [newStatus, 'DECISION', opportunityId]
    );

    await this.logHistory(
      opportunityId, 
      oldStatus, 
      newStatus, 
      'Enregistrer décision', 
      data.comment || 'Phase de décision finale.', 
      user.id
    );

    return { message: 'Opportunité passée en étape décision.', newStatus };
  }

  /**
   * Transition : Marquer Gagnée
   */
  static async markAsWon(opportunityId, user, data = {}) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable ou direction requis.');

    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');

    if (opp.status !== 'DECISION' && opp.status !== 'NEGOTIATION' && opp.status !== 'PROPOSAL') {
      throw new Error(`Transition impossible : statut actuel '${opp.status}' ne permet pas de clore comme gagnée.`);
    }

    const finalAmount = data.final_amount || opp.estimated_amount;
    const comment = data.comment || 'Opportunité remportée avec succès !';

    const oldStatus = opp.status;
    const newStatus = 'WON';

    await pool.query(
      `UPDATE crm_opportunities 
       SET status = ?, pipeline_stage = ?, final_amount = ?, decision_date = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [newStatus, 'SIGNATURE', finalAmount, opportunityId]
    );

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Marquer gagnée', comment, user.id);

    // Notification globale à la direction et au commercial affecté
    await notifyDirection(
      'Opportunité Gagnée 🎉',
      `L'opportunité "${opp.title}" a été remportée ! Montant : ${finalAmount} FCFA.`,
      'OPPORTUNITY_WON',
      opportunityId
    );
    if (opp.assigned_to) {
      await notifyUser(
        opp.assigned_to,
        'Opportunité Gagnée 🎉',
        `Félicitations, votre opportunité "${opp.title}" a été marquée comme GAGNÉE !`,
        'OPPORTUNITY_WON',
        opportunityId
      );
    }

    return { message: 'Opportunité marquée comme gagnée.', newStatus };
  }

  /**
   * Transition : Marquer Perdue
   */
  static async markAsLost(opportunityId, user, data = {}) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable ou direction requis.');
    if (!data.lost_reason?.trim()) throw new Error('Le motif de la perte est obligatoire.');

    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');

    const oldStatus = opp.status;
    const newStatus = 'LOST';

    await pool.query(
      `UPDATE crm_opportunities 
       SET status = ?, pipeline_stage = ?, lost_reason = ?, decision_date = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [newStatus, 'DECISION', data.lost_reason.trim(), opportunityId]
    );

    await this.logHistory(
      opportunityId, 
      oldStatus, 
      newStatus, 
      'Marquer perdue', 
      `Motif : ${data.lost_reason.trim()}. Commentaire : ${data.comment || 'N/A'}`, 
      user.id
    );

    if (opp.assigned_to) {
      await notifyUser(
        opp.assigned_to,
        'Opportunité Perdue',
        `L'opportunité "${opp.title}" a été classée comme perdue. Motif : "${data.lost_reason.trim()}".`,
        'OPPORTUNITY_LOST',
        opportunityId
      );
    }

    return { message: 'Opportunité marquée comme perdue.', newStatus };
  }

  /**
   * Transition : Archiver
   */
  static async archive(opportunityId, user) {
    if (!isManager(user)) throw new Error('Accès refusé. Rôle responsable ou direction requis.');

    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');

    const oldStatus = opp.status;
    const newStatus = 'ARCHIVED';

    await pool.query(
      'UPDATE crm_opportunities SET status = ?, archived_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, opportunityId]
    );

    await this.logHistory(opportunityId, oldStatus, newStatus, 'Archiver', 'Archivage de l\'opportunité pour historique.', user.id);

    return { message: 'Opportunité archivée.', newStatus };
  }

  /**
   * Crée une mission de suivi liée à l'opportunité
   */
  static async createFollowUpMission(opportunityId, user, missionData) {
    const opp = await this.getOpportunity(opportunityId);
    if (!opp) throw new Error('Opportunité introuvable.');
    if (!this.canAccess(opp, user)) throw new Error('Accès refusé.');

    const {
      objective_id, title, description, scheduled_date, duration_hours,
      primary_commercial_id, region_id, department_id, city_id, instructions
    } = missionData;

    if (!objective_id || !title?.trim() || !scheduled_date || !primary_commercial_id) {
      throw new Error('Champs de mission requis manquants.');
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // 1. Créer la mission
      const [mResult] = await connection.query(
        `INSERT INTO crm_missions (
          objective_id, institution_id, title, description, scheduled_date,
          duration_hours, primary_commercial_id, region_id, department_id, city_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')`,
        [
          objective_id,
          opp.institution_id,
          title.trim(),
          description || null,
          scheduled_date,
          duration_hours || 2,
          primary_commercial_id,
          region_id || opp.region_id || 1, // par défaut
          department_id || opp.department_id || 1,
          city_id || opp.city_id || 1
        ]
      );

      const missionId = mResult.insertId;

      // 2. Lier la mission à l'opportunité
      await connection.query(
        `INSERT INTO crm_opportunity_mission_links (opportunity_id, mission_id, link_type)
         VALUES (?, ?, 'follow_up')`,
        [opportunityId, missionId]
      );

      await connection.commit();

      await this.logHistory(
        opportunityId,
        opp.status,
        opp.status,
        'Créer mission de suivi',
        `Mission de suivi créée : "${title.trim()}" (ID: ${missionId})`,
        user.id
      );

      // Notification
      await notifyUser(
        primary_commercial_id,
        'Nouvelle mission de suivi',
        `Vous avez été affecté à une mission de suivi terrain : "${title.trim()}" liée à l'opportunité "${opp.title}".`,
        'MISSION_ASSIGNED',
        missionId
      );

      return { message: 'Mission de suivi créée et liée.', missionId };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }
}

module.exports = OpportunityWorkflowService;
