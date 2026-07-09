// Initializes Firebase and exposes a small db helper for Firestore operations.
(() => {
  if (!window.FIREBASE_CONFIG || Object.keys(window.FIREBASE_CONFIG).length === 0) {
    console.warn('FIREBASE_CONFIG is missing or empty. Verify firebase-config.js is loaded.');
  }

  try {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    const firestore = firebase.firestore();

    // Basic connectivity probe: if we can reach Firestore (even with denied rules), the app is connected.
    firestore.collection('roster').limit(1).get()
      .then(() => {
        console.log('Firestore connection check passed.');
      })
      .catch((err) => {
        if (err && (err.code === 'permission-denied' || err.code === 'failed-precondition')) {
          console.log('Firestore reachable, but read is blocked by Firestore rules:', err.code);
          return;
        }
        console.error('Firestore connection check failed:', err);
      });

    // Helpers: realtime listeners and simple setters
    const rankToSort = (rank) => {
      const n = Number(String(rank || 'R1').replace(/[^0-9]/g, ''));
      return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 1;
    };

    window.db = {
      onRosterSnapshot: (cb) => firestore.collection('roster').orderBy('createdAt', 'asc').onSnapshot(cb),
      onArchivedSnapshot: (cb) => firestore.collection('archived_players').onSnapshot(cb),
      onRegistrationsSnapshot: (cb) => firestore.collection('desert_registrations').onSnapshot(cb),
      onDesertMetaSnapshot: (cb) => firestore.doc('desert/meta').onSnapshot(cb),
      onDesertCurrentSnapshot: (cb) => firestore.doc('desert/current_event').onSnapshot(cb),
      onTeamsMetaSnapshot: (cb) => firestore.doc('teams/meta').onSnapshot(cb),
      onTeamsAssignmentsSnapshot: (cb) => firestore.collection('teams_assignments').onSnapshot(cb),
      onWarzonesSnapshot: (cb) => firestore.collection('warzone_events').orderBy('eventDate', 'desc').onSnapshot(cb),
      onDesertHistorySnapshot: (cb) => firestore.collection('desert_history').orderBy('eventDate', 'desc').onSnapshot(cb),
      onParticipationStatsSnapshot: (cb) => firestore.collection('participation_stats').onSnapshot(cb),

      upsertPlayer: (player) => firestore.collection('roster').doc(player.id).set({
        name: player.name,
        rank: player.rank,
        rankValue: player.rankValue || (player.rank || 'R1'),
        rankSort: rankToSort(player.rankValue || player.rank),
        thp: Number(player.thp) || 0,
        createdAt: player.createdAt || firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }),

      archivePlayer: async (player, attendance = {}) => {
        const batch = firestore.batch();
        const archivedRef = firestore.collection('archived_players').doc(player.id);
        batch.set(archivedRef, {
          name: player.name,
          rank: player.rank,
          rankValue: player.rankValue || (player.rank || 'R1'),
          rankSort: rankToSort(player.rankValue || player.rank),
          thp: Number(player.thp) || 0,
          lastKnownRank: player.rankValue || player.rank || 'R1',
          lastKnownThp: Number(player.thp) || 0,
          attendancePercent: attendance.attendancePercent ?? null,
          participated: Number(attendance.participated) || 0,
          eligibleWarzones: Number(attendance.eligibleWarzones) || 0,
          archiveNote: '',
          archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdAt: player.createdAt || firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        batch.delete(firestore.collection('roster').doc(player.id));
        batch.delete(firestore.collection('desert_registrations').doc(player.id));
        batch.delete(firestore.collection('teams_assignments').doc(player.id));
        return batch.commit();
      },

      restorePlayer: async (playerId) => {
        const archivedRef = firestore.collection('archived_players').doc(playerId);
        const archivedSnap = await archivedRef.get();
        if (!archivedSnap.exists) return;
        const data = archivedSnap.data() || {};
        const batch = firestore.batch();
        batch.set(firestore.collection('roster').doc(playerId), {
          name: data.name || '',
          rank: data.rankValue || data.rank || data.lastKnownRank || 'R1',
          rankValue: data.rankValue || data.rank || data.lastKnownRank || 'R1',
          rankSort: rankToSort(data.rankValue || data.rank || data.lastKnownRank || 'R1'),
          thp: Number(data.thp ?? data.lastKnownThp) || 0,
          createdAt: data.createdAt || firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        batch.delete(archivedRef);
        return batch.commit();
      },

      permanentlyDeleteArchivedPlayer: async (playerId) => {
        const archivedRef = firestore.collection('archived_players').doc(playerId);
        const attendanceRef = firestore.collection('attendance_stats').doc(playerId);
        const participationRef = firestore.collection('participation_stats').doc(playerId);
        const batch = firestore.batch();

        batch.delete(archivedRef);
        batch.delete(attendanceRef);
        batch.delete(participationRef);

        return batch.commit();
      },

      setArchivedPlayerNote: (playerId, note) => firestore.collection('archived_players').doc(playerId).set({
        archiveNote: String(note || '').trim(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }),

      setRegistration: (playerId, payload) => firestore.collection('desert_registrations').doc(playerId).set(payload, { merge: true }),
      setDesertMeta: (payload) => firestore.doc('desert/meta').set(payload, { merge: true }),
      setDesertCurrentEvent: (payload) => firestore.doc('desert/current_event').set({
        ...payload,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }),
      clearDesertCurrentEvent: () => firestore.doc('desert/current_event').delete(),

      setTeamAssignment: (playerId, payload) => firestore.collection('teams_assignments').doc(playerId).set(payload, { merge: true }),

      batchAssignments: async (assignments, meta) => {
        const batch = firestore.batch();
        Object.entries(assignments).forEach(([playerId, entry]) => {
          const ref = firestore.collection('teams_assignments').doc(playerId);
          batch.set(ref, entry, { merge: true });
        });
        if (meta) {
          const metaRef = firestore.doc('teams/meta');
          batch.set(metaRef, meta, { merge: true });
        }
        return batch.commit();
      },

      setTeamsMeta: (payload) => firestore.doc('teams/meta').set(payload, { merge: true }),

      createDesertHistoryEvent: (payload) => firestore.collection('desert_history').add({
        ...payload,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }),

      updateDesertHistoryEvent: (eventId, payload) => firestore.collection('desert_history').doc(eventId).set({
        ...payload,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }),

      upsertWarzoneEvent: (eventId, payload) => firestore.collection('warzone_events').doc(eventId).set({
        ...payload,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }),

      setAttendanceStats: async (statsMap) => {
        const entries = Object.entries(statsMap || {});
        if (!entries.length) return;
        const batch = firestore.batch();
        entries.forEach(([playerId, stats]) => {
          batch.set(firestore.collection('attendance_stats').doc(playerId), {
            ...stats,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });
        return batch.commit();
      },

      setParticipationStats: async (statsMap) => {
        const entries = Object.entries(statsMap || {});
        if (!entries.length) return;
        const batch = firestore.batch();
        entries.forEach(([playerId, stats]) => {
          batch.set(firestore.collection('participation_stats').doc(playerId), {
            ...stats,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });
        return batch.commit();
      },

      serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp()
    };

    console.log('Firebase initialized. db helper available on window.db');
  } catch (err) {
    console.error('Error initializing Firebase', err);
  }
})();
