/**
 * Test script for offline sync of mission actions (START, COMPLETE, etc.)
 * Run: node backend/test_sync_mission.js
 */
const pool = require('./db');
const fetch = require('node-fetch'); // Let's use node-fetch or simulate the request via calling the router.
// Alternatively, since the server is running on port 3002, we can make an actual HTTP request.
// But first, let's get a token or bypass auth for testing, or use credentials.

async function runTest() {
  console.log('🧪 Starting Mission Sync Offline test...');
  
  try {
    // 1. Let's create a mission in status 'PLANNED' to prepare for testing
    const [mResult] = await pool.query(
      `INSERT INTO crm_missions (
        objective_id, institution_id, title, description, 
        scheduled_date, primary_commercial_id, region_id, department_id, city_id, status
      ) VALUES (1, 1, 'Sync Test Mission', 'Description sync test', NOW(), 3, 1, 1, 1, 'PLANNED')`
    );
    const missionId = mResult.insertId;
    console.log(`✅ Mission created with status PLANNED. ID: ${missionId}`);

    // We need to simulate the sync request. 
    // Instead of doing fetch which requires node-fetch and auth token, we can mock the Express req/res
    // and call the router handler directly, OR we can query a commercial user to get a token or login.
    // Let's do it via calling the database directly to simulate sync or calling a mock route.
    // Even easier: let's invoke the route logic by importing db and the sync code directly or simulation.
    // Let's inspect users to get a valid commercial login or use system user credentials.
    const [users] = await pool.query('SELECT id, email, role FROM users LIMIT 5');
    console.log('Available users for test:', users);

    // Let's simulate the router code for /sync/push directly in this script to verify DB transitions and code logic.
    // That ensures the queries run and do not throw.
    const syncAction = {
      id: `sync_${Date.now()}_test`,
      action: 'update',
      type: 'mission',
      payload: {
        id: missionId,
        status: 'IN_PROGRESS',
        check_in_at: new Date().toISOString(),
        check_in_location: { latitude: 48.8566, longitude: 2.3522 }
      }
    };

    console.log('\n--- Simulating sync push of mission update to IN_PROGRESS ---');
    
    // Simulating backend/routes/sync.js logic:
    const localToServerIdMap = new Map();
    const results = [];
    const syncHistoryDetails = [];
    let successCount = 0;
    let errorCount = 0;
    let conflictCount = 0;

    const { id: localId, action, type, payload } = syncAction;
    const resolvedMissionId = localToServerIdMap.has(payload.id) 
      ? localToServerIdMap.get(payload.id) 
      : payload.id;

    // Retrieve server mission
    const [missionRows] = await pool.query('SELECT id, status FROM crm_missions WHERE id = ?', [resolvedMissionId]);
    if (missionRows.length === 0) {
      throw new Error(`Mission #${resolvedMissionId} introuvable`);
    }

    const serverMission = missionRows[0];
    const targetStatus = payload.status;
    console.log(`Server mission status: ${serverMission.status}, Target status: ${targetStatus}`);

    const STATUS_TO_ACTION = {
      'IN_PROGRESS': 'START',
      'COMPLETED': 'COMPLETE',
      'POSTPONED': 'POSTPONE',
      'CANCELLED': 'CANCEL',
      'SUBMITTED': 'SUBMIT'
    };

    const missionAction = STATUS_TO_ACTION[targetStatus];
    if (!missionAction) {
      throw new Error(`Action non reconnue pour le statut ${targetStatus}`);
    }

    const allowedTransitions = {
      PLANNED: ['IN_PROGRESS', 'POSTPONED', 'CANCELLED', 'SUBMITTED'],
      POSTPONED: ['IN_PROGRESS', 'PLANNED', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'POSTPONED', 'CANCELLED'],
      DRAFT: ['SUBMITTED', 'CANCELLED'],
      REJECTED: ['SUBMITTED']
    };
    const allowed = allowedTransitions[serverMission.status] || [];
    if (!allowed.includes(targetStatus)) {
      throw new Error(`Transition interdite: ${serverMission.status} -> ${targetStatus}`);
    }

    let missionUpdateQuery = '';
    let missionUpdateParams = [];

    if (missionAction === 'START') {
      missionUpdateQuery = `UPDATE crm_missions SET 
        status = 'IN_PROGRESS', 
        started_at = COALESCE(started_at, ?),
        check_in_at = COALESCE(check_in_at, ?),
        check_in_latitude = COALESCE(check_in_latitude, ?),
        check_in_longitude = COALESCE(check_in_longitude, ?)
       WHERE id = ?`;
      missionUpdateParams = [
        payload.check_in_at || new Date().toISOString(),
        payload.check_in_at || new Date().toISOString(),
        payload.check_in_location?.latitude || null,
        payload.check_in_location?.longitude || null,
        resolvedMissionId
      ];
    }

    await pool.query(missionUpdateQuery, missionUpdateParams);
    console.log('✅ Query executed successfully!');

    // Check status after update
    const [updatedRows] = await pool.query('SELECT status, started_at, check_in_at, check_in_latitude FROM crm_missions WHERE id = ?', [resolvedMissionId]);
    console.log('Updated mission row:', updatedRows[0]);
    if (updatedRows[0].status === 'IN_PROGRESS' && updatedRows[0].check_in_latitude !== null) {
      console.log('🎉 START mission sync logic matches database and constraints!');
    } else {
      console.error('❌ Check failed: status or check_in_latitude not updated properly.');
    }

    // Cleanup
    await pool.query('DELETE FROM crm_missions WHERE id = ?', [missionId]);
    console.log('🧹 Cleanup done.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTest();
