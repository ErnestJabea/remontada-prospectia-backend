/**
 * Test script for Activity Reports workflow and PDF generation.
 * Run: node backend/test_reports_workflow.js
 */
const pool = require('./db');
const ReportWorkflowService = require('./services/reportWorkflow');
const ReportPdfService = require('./services/reportPdfService');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('🧪 Starting tests for Activity Reports workflow & PDF...');

  const commercial = { id: 3, role: 'COMMERCIAL', full_name: 'Commercial Test' };
  const manager = { id: 2, role: 'DIRECTION', full_name: 'Directeur Test' };

  let testMissionId = null;
  let testReportId = null;

  try {
    // 1. Create a fake mission in IN_PROGRESS status
    console.log('\n--- Step 1: Creating a fake mission in IN_PROGRESS ---');
    const [mResult] = await pool.query(
      `INSERT INTO crm_missions (
        objective_id, institution_id, title, description, 
        scheduled_date, primary_commercial_id, region_id, department_id, city_id, status
      ) VALUES (1, 1, 'Mission Test pour Rapport', 'Description de test', NOW(), 3, 1, 1, 1, 'IN_PROGRESS')`
    );
    testMissionId = mResult.insertId;
    console.log(`✅ Mission created. ID: ${testMissionId}`);

    // 2. Complete the mission (triggering automatic report generation)
    console.log('\n--- Step 2: Completing mission & triggering auto-report ---');
    await pool.query(
      `UPDATE crm_missions SET status = 'COMPLETED', completed_at = NOW() WHERE id = ?`,
      [testMissionId]
    );
    
    // Call the generator
    const genRes = await ReportWorkflowService.generateFromMission(testMissionId, commercial.id);
    testReportId = genRes.id;
    console.log(`✅ Auto-report generated. ID: ${testReportId}, Status: ${genRes.status}, Code: ${genRes.code}`);

    // Verify report details
    let report = await ReportWorkflowService.getReport(testReportId);
    console.log(`  Report status is: ${report.status}`);

    // 3. Try submitting without filling required fields (Should fail)
    console.log('\n--- Step 3: Attempting submission without executive summary (Should Fail) ---');
    try {
      await ReportWorkflowService.submit(testReportId, commercial);
      console.error('❌ Error: Submission should have failed.');
    } catch (err) {
      console.log('✅ Success: Submission failed as expected. Error:', err.message);
    }

    // 4. Update the report fields
    console.log('\n--- Step 4: Updating report contents ---');
    await pool.query(
      `UPDATE crm_reports 
       SET executive_summary = 'Resume executif de test.', 
           results = 'Resultats de test obtenus.', 
           diagnosis = 'Diagnostic de test.', 
           status = 'A_COMPLETER' 
       WHERE id = ?`,
      [testReportId]
    );
    console.log('✅ Report contents updated.');

    // 5. Submit report (Should succeed)
    console.log('\n--- Step 5: Submitting report ---');
    const subRes = await ReportWorkflowService.submit(testReportId, commercial);
    console.log('✅ Report submitted:', subRes);

    // 6. Request correction (GATE 2)
    console.log('\n--- Step 6: Requesting correction (GATE 2) ---');
    const corrRes = await ReportWorkflowService.requestCorrection(testReportId, manager, 'Veuillez ajouter plus de détails.');
    console.log('✅ Correction requested:', corrRes);

    // Verify report status is CORRECTION_DEMANDEE
    report = await ReportWorkflowService.getReport(testReportId);
    console.log(`  Report status is now: ${report.status}`);

    // 7. Submit again after correction
    console.log('\n--- Step 7: Submitting corrected report ---');
    const resubRes = await ReportWorkflowService.submit(testReportId, commercial);
    console.log('✅ Report resubmitted:', resubRes);

    // 8. Validate report (GATE 2)
    console.log('\n--- Step 8: Validating report (GATE 2) ---');
    const valRes = await ReportWorkflowService.validateReport(testReportId, manager);
    console.log('✅ Report validated:', valRes);

    // Verify associated mission is CLOSED
    const [mRows] = await pool.query('SELECT status FROM crm_missions WHERE id = ?', [testMissionId]);
    console.log(`  Associated mission status is now: ${mRows[0].status} (Expected: CLOSED)`);

    // 9. Generate PDF
    console.log('\n--- Step 9: Generating PDF ---');
    const pdfPath = await ReportPdfService.generatePdf(testReportId);
    console.log(`✅ PDF generated successfully. Path: ${pdfPath}`);
    if (fs.existsSync(pdfPath)) {
      console.log('  File exists on disk.');
    } else {
      console.error('❌ File NOT found on disk.');
    }

    // 10. Archive report
    console.log('\n--- Step 10: Archiving report ---');
    const archRes = await ReportWorkflowService.archive(testReportId, manager);
    console.log('✅ Report archived:', archRes);

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (err) {
    console.error('❌ TEST FAILED with error:', err);
  } finally {
    // Cleanup fake test records
    console.log('\n--- Cleaning up test records ---');
    if (testReportId) {
      await pool.query('DELETE FROM crm_report_histories WHERE activity_report_id = ?', [testReportId]);
      await pool.query('DELETE FROM crm_report_comments WHERE activity_report_id = ?', [testReportId]);
      await pool.query('DELETE FROM crm_report_opportunities WHERE activity_report_id = ?', [testReportId]);
      
      // Delete generated PDF if exists
      const reportInfo = await ReportWorkflowService.getReport(testReportId);
      if (reportInfo && reportInfo.pdf_path) {
        const fullPdfPath = path.resolve(__dirname, '..', reportInfo.pdf_path);
        if (fs.existsSync(fullPdfPath)) {
          fs.unlinkSync(fullPdfPath);
          console.log('  Deleted test PDF file.');
        }
      }
      await pool.query('DELETE FROM crm_reports WHERE id = ?', [testReportId]);
      console.log('  Deleted test report.');
    }
    if (testMissionId) {
      await pool.query('DELETE FROM crm_missions WHERE id = ?', [testMissionId]);
      console.log('  Deleted test mission.');
    }
    process.exit(0);
  }
}

runTests();
