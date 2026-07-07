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
      onRegistrationsSnapshot: (cb) => firestore.collection('desert_registrations').onSnapshot(cb),
      onDesertMetaSnapshot: (cb) => firestore.doc('desert/meta').onSnapshot(cb),
      onTeamsMetaSnapshot: (cb) => firestore.doc('teams/meta').onSnapshot(cb),
      onTeamsAssignmentsSnapshot: (cb) => firestore.collection('teams_assignments').onSnapshot(cb),

      upsertPlayer: (player) => firestore.collection('roster').doc(player.id).set({
        name: player.name,
        rank: player.rank,
        rankValue: player.rankValue || (player.rank || 'R1'),
        rankSort: rankToSort(player.rankValue || player.rank),
        thp: Number(player.thp) || 0,
        createdAt: player.createdAt || firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }),

      deletePlayer: (playerId) => Promise.all([
        firestore.collection('roster').doc(playerId).delete(),
        firestore.collection('desert_registrations').doc(playerId).delete(),
        firestore.collection('teams_assignments').doc(playerId).delete()
      ]),

      setRegistration: (playerId, payload) => firestore.collection('desert_registrations').doc(playerId).set(payload, { merge: true }),
      setDesertMeta: (payload) => firestore.doc('desert/meta').set(payload, { merge: true }),

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

      serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp()
    };

    console.log('Firebase initialized. db helper available on window.db');
  } catch (err) {
    console.error('Error initializing Firebase', err);
  }
})();
