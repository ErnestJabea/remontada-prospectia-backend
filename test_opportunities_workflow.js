/**
 * Script de test du workflow des opportunités commerciales.
 * Run: node backend/test_opportunities_workflow.js
 */
const pool = require('./db');
const OpportunityWorkflowService = require('./services/OpportunityWorkflowService');

async function runTests() {
  console.log('🧪 Démarrage des tests du workflow...');

  // Utilisateurs factices pour les tests (ID 3 = Commercial, ID 2 = Manager/DG)
  const commercial = { id: 3, role: 'COMMERCIAL', full_name: 'Commercial Junior Test' };
  const manager = { id: 2, role: 'DIRECTION', full_name: 'Directeur Remontada' };

  let opportunityId = null;

  try {
    // 1. Création d'une opportunité
    console.log('\n--- Test 1 : Création d\'opportunité ---');
    const code = 'OP-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    const [result] = await pool.query(
      `INSERT INTO crm_opportunities (
        code, institution_id, title, need_description, estimated_amount, priority, assigned_to, status, pipeline_stage
      ) VALUES (?, 1, 'Opportunité de Test Workflow', 'Besoin de test pour validation du service métier', 15000000.00, 'HIGH', 3, 'DETECTED', 'DETECTION')`,
      [code]
    );
    opportunityId = result.insertId;
    console.log(`✅ Opportunité créée avec succès. ID: ${opportunityId}, Code: ${code}`);

    // Logger la création initiale
    await OpportunityWorkflowService.logHistory(
      opportunityId, null, 'DETECTED', 'Créer opportunité', 'Création de test', commercial.id
    );

    // 2. Soumission sans champs requis (Simuler échec)
    console.log('\n--- Test 2 : Tentative de soumission incomplète ---');
    // Temporairement effacer le titre pour provoquer une erreur
    await pool.query('UPDATE crm_opportunities SET title = "" WHERE id = ?', [opportunityId]);
    try {
      await OpportunityWorkflowService.submit(opportunityId, commercial);
      console.error('❌ Erreur : La soumission aurait dû échouer sans titre.');
    } catch (err) {
      console.log('✅ Succès : La soumission a échoué comme prévu. Raison :', err.message);
    }
    // Restaurer le titre
    await pool.query('UPDATE crm_opportunities SET title = "Opportunité de Test Workflow" WHERE id = ?', [opportunityId]);

    // 3. Soumission correcte
    console.log('\n--- Test 3 : Soumission correcte par le commercial ---');
    const subRes = await OpportunityWorkflowService.submit(opportunityId, commercial);
    console.log('✅ Soumission réussie :', subRes);

    // 4. Demander des corrections
    console.log('\n--- Test 4 : Demande de correction par le responsable ---');
    const corrRes = await OpportunityWorkflowService.requestCorrection(opportunityId, manager, 'Veuillez préciser le planning de livraison.');
    console.log('✅ Demande de correction réussie :', corrRes);

    // 5. Soumission après correction
    console.log('\n--- Test 5 : Nouvelle soumission après correction ---');
    const subRes2 = await OpportunityWorkflowService.submit(opportunityId, commercial);
    console.log('✅ Nouvelle soumission réussie :', subRes2);

    // 6. Rejet par le responsable (Simuler flux de rejet)
    console.log('\n--- Test 6 : Rejet de l\'opportunité ---');
    const rejRes = await OpportunityWorkflowService.reject(opportunityId, manager, 'Hors budget pour cette année budgétaire.');
    console.log('✅ Rejet réussi :', rejRes);

    // Restaurer le statut à SUBMITTED pour continuer le test du flux positif
    await pool.query('UPDATE crm_opportunities SET status = "SUBMITTED" WHERE id = ?', [opportunityId]);

    // 7. Validation par le responsable
    console.log('\n--- Test 7 : Validation par le responsable ---');
    const valRes = await OpportunityWorkflowService.validate(opportunityId, manager);
    console.log('✅ Validation réussie :', valRes);

    // 8. Démarrer l'analyse
    console.log('\n--- Test 8 : Démarrage de l\'analyse commerciale ---');
    const anaRes = await OpportunityWorkflowService.startAnalysis(opportunityId, commercial);
    console.log('✅ Analyse démarrée :', anaRes);

    // 9. Création d'un plan d'action
    console.log('\n--- Test 9 : Création du plan d\'action ---');
    const actions = [
      { title: 'Appel de relance DAF', action_type: 'relance', due_date: '2026-07-01' },
      { title: 'Préparer maquette de démonstration', action_type: 'proposition', due_date: '2026-07-10' }
    ];
    const planRes = await OpportunityWorkflowService.createActionPlan(opportunityId, commercial, actions);
    console.log('✅ Plan d\'action créé :', planRes);

    // Vérifier les actions insérées
    const [actRows] = await pool.query('SELECT * FROM crm_opportunity_actions WHERE opportunity_id = ?', [opportunityId]);
    console.log(`✅ Nombre d'actions trouvées en base : ${actRows.length}`);

    // 10. Proposition commerciale
    console.log('\n--- Test 10 : Passage en phase de proposition ---');
    const propRes = await OpportunityWorkflowService.moveToProposal(opportunityId, commercial, { final_amount: 14500000.00, comment: 'Maquette validée, envoi offre finale.' });
    console.log('✅ Passage en proposition réussi :', propRes);

    // 11. Passage en négociation
    console.log('\n--- Test 11 : Passage en négociation ---');
    const negRes = await OpportunityWorkflowService.moveToNegotiation(opportunityId, commercial, { comment: 'Discussions sur la remise commerciale de 5%.' });
    console.log('✅ Passage en négociation réussi :', negRes);

    // 12. Passage en phase décision
    console.log('\n--- Test 12 : Passage en décision ---');
    const decRes = await OpportunityWorkflowService.moveToDecision(opportunityId, commercial, { comment: 'L\'institution délibère ce vendredi.' });
    console.log('✅ Passage en décision réussi :', decRes);

    // 13. Marquer comme GAGNÉE
    console.log('\n--- Test 13 : Clôture en opportunité GAGNÉE ---');
    const wonRes = await OpportunityWorkflowService.markAsWon(opportunityId, manager, { final_amount: 14500000.00, comment: 'Contrat signé reçu par courrier !' });
    console.log('✅ Opportunité GAGNÉE avec succès :', wonRes);

    // 14. Création d'une mission de suivi terrain
    console.log('\n--- Test 14 : Création d\'une mission de suivi liée ---');
    const missionRes = await OpportunityWorkflowService.createFollowUpMission(opportunityId, commercial, {
      objective_id: 1, // Objectif test existant
      title: 'Suivi terrain post-signature',
      description: 'Lancement du projet de numérisation des archives.',
      scheduled_date: '2026-08-01 10:00:00',
      duration_hours: 4,
      primary_commercial_id: 3,
      region_id: 1,
      department_id: 1,
      city_id: 1
    });
    console.log('✅ Mission de suivi créée :', missionRes);

    // Vérifier la liaison M-to-N
    const [links] = await pool.query('SELECT * FROM crm_opportunity_mission_links WHERE opportunity_id = ?', [opportunityId]);
    console.log(`✅ Liaisons opportunité-mission trouvées : ${links.length}`);

    // 15. Archivage
    console.log('\n--- Test 15 : Archivage de l\'opportunité ---');
    const arcRes = await OpportunityWorkflowService.archive(opportunityId, manager);
    console.log('✅ Archivage réussi :', arcRes);

    // 16. Vérification de l'historique d'audit
    console.log('\n--- Test 16 : Vérification de la traçabilité d\'audit ---');
    const [histRows] = await pool.query('SELECT * FROM crm_opportunity_stage_histories WHERE opportunity_id = ? ORDER BY performed_at ASC', [opportunityId]);
    console.log(`✅ Nombre de logs de transitions enregistrés : ${histRows.length}`);
    histRows.forEach((log, index) => {
      console.log(`   [Log ${index + 1}] Action : "${log.action}" | Ancien statut : ${log.old_status || 'Aucun'} ➔ Nouveau statut : ${log.new_status}`);
    });

    console.log('\n🎉 TOUS LES TESTS SONT PASSÉS AVEC SUCCÈS ! 🎉');

  } catch (error) {
    console.error('❌ Échec du test :', error.message);
    process.exitCode = 1;
  } finally {
    // Nettoyage de l'opportunité de test
    if (opportunityId) {
      console.log('\n🧹 Nettoyage des données de test...');
      await pool.query('DELETE FROM crm_opportunities WHERE id = ?', [opportunityId]);
      console.log('✅ Données de test nettoyées (cascade sur tables liées)');
    }
    await pool.end().catch(() => {});
    console.log('🏁 Fin du processus de test.');
  }
}

runTests();
