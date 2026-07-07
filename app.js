// Firestore-backed state. Real-time listeners will populate this.
const state = {
  roster: [],
  desert: { eventDate: '', timeSlot: '18:00', registrations: {} },
  teams: { assignments: {}, generated: false, lastSavedAt: '' }
};

function saveState() {
  // no-op: individual operations write directly to Firestore via window.db
}

function init() {
  bindNavigation();
  bindRoster();
  bindDesert();
  bindTeams();
  render();
  initFirebaseListeners();
}

function initFirebaseListeners() {
  if (!window.db) {
    console.warn('window.db not available; running in offline/local mode.');
    return;
  }

  window.db.onRosterSnapshot((snap) => {
    const list = [];
    snap.forEach((doc) => {
      const data = doc.data();
      list.push({
        id: doc.id,
        name: data.name || '',
        rank: data.rank || 'R1',
        rankValue: data.rankValue || data.rank || 'R1',
        rankSort: Number(data.rankSort) || Number(String(data.rank || 'R1').replace(/[^0-9]/g, '')) || 1,
        thp: Number(data.thp) || 0
      });
    });
    state.roster = list;
    renderRoster();
    renderDesert();
    renderTeams();
  });

  window.db.onRegistrationsSnapshot((snap) => {
    const map = {};
    snap.forEach((doc) => {
      const data = doc.data();
      map[doc.id] = { requested: Boolean(data.requested), guaranteed: Boolean(data.guaranteed) };
    });
    state.desert.registrations = map;
    renderDesert();
    renderTeams();
  });

  window.db.onDesertMetaSnapshot((doc) => {
    if (!doc.exists) return;
    const d = doc.data();
    state.desert.eventDate = d.eventDate || '';
    state.desert.timeSlot = d.timeSlot || '18:00';
    renderDesert();
  });

  window.db.onTeamsAssignmentsSnapshot((snap) => {
    const map = {};
    snap.forEach((doc) => {
      const data = doc.data();
      map[doc.id] = { pool: data.pool || 'leftOut', locked: Boolean(data.locked) };
    });
    state.teams.assignments = map;
    renderTeams();
  });

  window.db.onTeamsMetaSnapshot((doc) => {
    if (!doc.exists) return;
    const d = doc.data();
    state.teams.generated = Boolean(d.generated);
    state.teams.lastSavedAt = d.lastSavedAt || '';
    renderTeams();
  });
}

function bindNavigation() {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach((item) => item.classList.remove('active'));
      document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(button.dataset.target).classList.add('active');
    });
  });
}

function bindRoster() {
  const form = document.getElementById('roster-form');
  const toggle = document.getElementById('toggle-roster-form');
  const cancel = document.getElementById('cancel-edit');
  const search = document.getElementById('roster-search');
  const sort = document.getElementById('roster-sort');

  toggle.addEventListener('click', () => {
    resetRosterForm();
    form.classList.toggle('hidden');
  });

  cancel.addEventListener('click', resetRosterForm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = document.getElementById('player-id').value || crypto.randomUUID();
    const player = {
      id,
      name: document.getElementById('player-name').value.trim(),
      rank: document.getElementById('player-rank').value,
      rankValue: document.getElementById('player-rank').value,
      thp: Number(document.getElementById('player-thp').value)
    };

    if (!player.name || !player.rank || Number.isNaN(player.thp)) return;

    if (window.db && window.db.upsertPlayer) {
      window.db.upsertPlayer(player).then(() => {
        resetRosterForm();
      }).catch((err) => console.error('Error saving player', err));
    } else {
      // fallback to local update for offline/editor preview
      const existingId = document.getElementById('player-id').value;
      if (existingId) {
        state.roster = state.roster.map((entry) => (entry.id === existingId ? player : entry));
      } else {
        state.roster.push(player);
      }
      renderRoster();
      resetRosterForm();
    }
  });

  search.addEventListener('input', renderRoster);
  sort.addEventListener('change', renderRoster);
}

function resetRosterForm() {
  document.getElementById('roster-form').reset();
  document.getElementById('player-id').value = '';
}

function bindDesert() {
  document.getElementById('event-date').addEventListener('change', (event) => {
    state.desert.eventDate = event.target.value;
    if (window.db && window.db.setDesertMeta) window.db.setDesertMeta({ eventDate: state.desert.eventDate });
    renderDesert();
  });

  document.getElementById('event-time').addEventListener('change', (event) => {
    state.desert.timeSlot = event.target.value;
    if (window.db && window.db.setDesertMeta) window.db.setDesertMeta({ timeSlot: state.desert.timeSlot });
    renderDesert();
  });
}

function bindTeams() {
  document.getElementById('generate-teams').addEventListener('click', () => {
    generateTeams();
    renderTeams();
  });

  document.getElementById('regenerate-teams').addEventListener('click', () => {
    generateTeams(true);
    renderTeams();
  });

  document.getElementById('save-teams').addEventListener('click', () => {
    if (window.db && window.db.setTeamsMeta) {
      window.db.setTeamsMeta({ lastSavedAt: new Date().toISOString() });
    }
    renderTeams();
  });
}

function render() {
  renderRoster();
  renderDesert();
  renderTeams();
}

function renderRoster() {
  const list = document.getElementById('roster-list');
  const search = document.getElementById('roster-search').value.toLowerCase();
  const sort = document.getElementById('roster-sort').value;

  let players = [...state.roster].filter((player) => {
    return [player.name, player.rank, String(player.thp)].some((value) => value.toLowerCase().includes(search));
  });

  players.sort((a, b) => {
    const rankValue = (r) => {
      try {
        if (r.rankSort) return Number(r.rankSort) || 1;
        return Number((r.rank || r.rankValue || 'R1').replace(/[^0-9]/g, '')) || 1;
      } catch (e) { return 1; }
    };

    switch (sort) {
      case 'thp-desc':
        return b.thp - a.thp;
      case 'thp-asc':
        return a.thp - b.thp;
      case 'rank-asc':
        return rankValue(a) - rankValue(b) || a.name.localeCompare(b.name);
      case 'rank-desc':
        return rankValue(b) - rankValue(a) || a.name.localeCompare(b.name);
      default:
        return a.name.localeCompare(b.name);
    }
  });

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">No players yet. Add the first roster member to begin.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    // display modern rank badge
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    const thpLabel = `THP ${player.thp}`;
    return `
      <article class="player-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • ${thpLabel}</div>
          </div>
        </div>
        <div class="row-actions">
          <button class="secondary-btn" onclick="editPlayer('${player.id}')">Edit</button>
          <button class="secondary-btn" onclick="deletePlayer('${player.id}')">Delete</button>
        </div>
      </article>
    `;
  }).join('');
}

function renderDesert() {
  const list = document.getElementById('desert-list');
  const dateInput = document.getElementById('event-date');
  const timeInput = document.getElementById('event-time');

  dateInput.value = state.desert.eventDate;
  timeInput.value = state.desert.timeSlot;

  if (!state.roster.length) {
    list.innerHTML = '<div class="list-empty">Build the roster first so Desert Storm registrations can appear here.</div>';
    return;
  }

  list.innerHTML = state.roster.map((player) => {
    const registration = state.desert.registrations[player.id] || { requested: false, guaranteed: false };
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    return `
      <article class="registration-row">
        <div class="registration-top">
          <div>
            <div class="registration-name">${escapeHtml(player.name)}</div>
            <div class="registration-meta"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${player.thp}</div>
          </div>
        </div>
        <div class="checkbox-block">
          <label>
            <span>Requested to Fight</span>
            <input type="checkbox" data-player-id="${player.id}" data-field="requested" ${registration.requested ? 'checked' : ''} />
          </label>
          <label>
            <span>Guaranteed Next Round</span>
            <input type="checkbox" data-player-id="${player.id}" data-field="guaranteed" ${registration.guaranteed ? 'checked' : ''} />
          </label>
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', (event) => {
      const playerId = event.target.dataset.playerId;
      const field = event.target.dataset.field;
      const current = state.desert.registrations[playerId] || { requested: false, guaranteed: false };
      current[field] = event.target.checked;
      state.desert.registrations[playerId] = current;
      if (window.db && window.db.setRegistration) {
        window.db.setRegistration(playerId, current).catch((err) => console.error('reg save', err));
      }
      renderDesert();
      renderTeams();
    });
  });
}

function renderTeams() {
  const teamAList = document.getElementById('team-a-list');
  const teamBList = document.getElementById('team-b-list');
  const subsList = document.getElementById('subs-list');
  const leftOutList = document.getElementById('left-out-list');

  const assignments = state.teams.assignments || {};
  const includedPlayers = getIncludedPlayers();
  const poolMap = {
    teamA: [],
    teamB: [],
    subs: [],
    leftOut: []
  };

  includedPlayers.forEach((player) => {
    const assignment = assignments[player.id] || { pool: 'leftOut', locked: false };
    if (poolMap[assignment.pool] !== undefined) {
      poolMap[assignment.pool].push(player);
    }
  });

  // Update THP summary
  const teamATHP = poolMap.teamA.reduce((s, p) => s + (p.thp || 0), 0);
  const teamBTHP = poolMap.teamB.reduce((s, p) => s + (p.thp || 0), 0);
  const diff = Math.abs(teamATHP - teamBTHP);
  const aEl = document.getElementById('team-a-thp');
  const bEl = document.getElementById('team-b-thp');
  const dEl = document.getElementById('thp-diff');
  if (aEl) aEl.textContent = String(teamATHP);
  if (bEl) bEl.textContent = String(teamBTHP);
  if (dEl) dEl.textContent = String(diff);

  if (!includedPlayers.length) {
    [teamAList, teamBList, subsList, leftOutList].forEach((element) => {
      element.innerHTML = '<div class="list-empty">No eligible players yet. Mark players as requested or guaranteed in Desert Storm.</div>';
    });
    return;
  }

  renderPool(teamAList, poolMap.teamA, 'teamA');
  renderPool(teamBList, poolMap.teamB, 'teamB');
  renderPool(subsList, poolMap.subs, 'subs');
  renderPool(leftOutList, poolMap.leftOut, 'leftOut');
}

function renderPool(container, players, pool) {
  if (!players.length) {
    container.innerHTML = '<div class="list-empty">No players in this lane.</div>';
    return;
  }

  container.innerHTML = players.map((player) => {
    const assignment = state.teams.assignments[player.id] || { pool, locked: false };
    const lockLabel = assignment.locked ? '🔒 Locked' : '🔓 Unlock';
    return `
      <article class="team-player-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${escapeHtml(player.rank || player.rankValue || 'R1')}">${escapeHtml(player.rank || player.rankValue || 'R1')}</span> • THP ${player.thp}</div>
          </div>
          <div class="chip">${labelForPool(assignment.pool || pool)}</div>
        </div>
        <div class="row-actions">
          <button class="secondary-btn" onclick="toggleLock('${player.id}')">${lockLabel}</button>
          <button class="move-btn" onclick="movePlayer('${player.id}')">Move</button>
        </div>
      </article>
    `;
  }).join('');
}

function generateTeams() {
  const eligiblePlayers = getIncludedPlayers();
  const assignments = { ...state.teams.assignments };
  const poolState = {
    teamA: [],
    teamB: [],
    subs: [],
    leftOut: []
  };

  eligiblePlayers.forEach((player) => {
    const existing = assignments[player.id];
    if (existing?.locked) {
      const targetPool = ['teamA', 'teamB', 'subs', 'leftOut'].includes(existing.pool) ? existing.pool : 'leftOut';
      poolState[targetPool].push(player);
    }
  });

  const availablePlayers = eligiblePlayers.filter((player) => !assignments[player.id]?.locked);
  const guaranteedPlayers = availablePlayers.filter((player) => state.desert.registrations[player.id]?.guaranteed);
  const requestedPlayers = availablePlayers.filter((player) => state.desert.registrations[player.id]?.requested && !state.desert.registrations[player.id]?.guaranteed);

  const orderedPlayers = [...guaranteedPlayers, ...requestedPlayers].sort((a, b) => b.thp - a.thp);
  // First, split R4 and R5 leaders evenly between Team A and Team B.
  const isLeader = (p) => (p.rank || p.rankValue || '').toString().startsWith('R4') || (p.rank || p.rankValue || '').toString().startsWith('R5');
  const leaders = orderedPlayers.filter(isLeader);
  const nonLeaders = orderedPlayers.filter((p) => !isLeader(p));

  // Sort leaders by THP desc so strongest leaders are balanced first
  leaders.sort((a, b) => b.thp - a.thp);

  leaders.forEach((player) => {
    const teamACount = poolState.teamA.filter((p) => isLeader(p)).length;
    const teamBCount = poolState.teamB.filter((p) => isLeader(p)).length;
    const teamAThp = poolState.teamA.reduce((sum, entry) => sum + entry.thp, 0);
    const teamBThp = poolState.teamB.reduce((sum, entry) => sum + entry.thp, 0);

    let targetTeam = 'teamA';
    if (teamACount > teamBCount) targetTeam = 'teamB';
    else if (teamACount < teamBCount) targetTeam = 'teamA';
    else targetTeam = teamAThp <= teamBThp ? 'teamA' : 'teamB';

    if (poolState[targetTeam].length < 20) {
      poolState[targetTeam].push(player);
    } else if (poolState[ targetTeam === 'teamA' ? 'teamB' : 'teamA' ].length < 20) {
      poolState[targetTeam === 'teamA' ? 'teamB' : 'teamA'].push(player);
    } else if (poolState.subs.length < 10) {
      poolState.subs.push(player);
    } else {
      poolState.leftOut.push(player);
    }
  });

  // Then assign remaining players (non-leaders) by THP balance
  nonLeaders.forEach((player) => {
    const teamAThp = poolState.teamA.reduce((sum, entry) => sum + entry.thp, 0);
    const teamBThp = poolState.teamB.reduce((sum, entry) => sum + entry.thp, 0);
    const targetTeam = teamAThp <= teamBThp ? 'teamA' : 'teamB';
    const alternateTeam = targetTeam === 'teamA' ? 'teamB' : 'teamA';

    if (poolState[targetTeam].length < 20 && (poolState[alternateTeam].length >= 20 || Math.abs(teamAThp - teamBThp) <= 100)) {
      poolState[targetTeam].push(player);
      return;
    }

    if (poolState[alternateTeam].length < 20) {
      poolState[alternateTeam].push(player);
      return;
    }

    if (poolState.subs.length < 10) {
      poolState.subs.push(player);
      return;
    }

    poolState.leftOut.push(player);
  });

  const nextAssignments = {};
  const allPoolPlayers = [...poolState.teamA, ...poolState.teamB, ...poolState.subs, ...poolState.leftOut];

  allPoolPlayers.forEach((player) => {
    const previousEntry = assignments[player.id];
    const pool = getPoolForPlayer(player, poolState);
    nextAssignments[player.id] = {
      pool,
      locked: Boolean(previousEntry?.locked)
    };
  });

  allPoolPlayers.forEach((player) => {
    const registration = state.desert.registrations[player.id] || { requested: false, guaranteed: false };
    if (getPoolForPlayer(player, poolState) === 'leftOut') {
      registration.guaranteed = true;
      registration.requested = registration.requested || true;
      state.desert.registrations[player.id] = registration;
    }
  });

  // Persist assignments and updated registrations to Firestore
  state.teams.assignments = nextAssignments;
  state.teams.generated = true;

  if (window.db && window.db.batchAssignments) {
    const meta = { generated: true, lastSavedAt: new Date().toISOString() };
    window.db.batchAssignments(nextAssignments, meta).catch((err) => console.error('batch assign', err));
  }

  // update registrations for left-out players
  Object.entries(state.desert.registrations).forEach(([playerId, reg]) => {
    if (reg.guaranteed) {
      if (window.db && window.db.setRegistration) window.db.setRegistration(playerId, reg).catch((err) => console.error(err));
    }
  });
}

function getPoolForPlayer(player, poolState) {
  if (poolState.teamA.some((entry) => entry.id === player.id)) return 'teamA';
  if (poolState.teamB.some((entry) => entry.id === player.id)) return 'teamB';
  if (poolState.subs.some((entry) => entry.id === player.id)) return 'subs';
  return 'leftOut';
}

function getIncludedPlayers() {
  const ids = new Set();
  Object.entries(state.desert.registrations).forEach(([playerId, registration]) => {
    if (registration.requested || registration.guaranteed) {
      ids.add(playerId);
    }
  });

  return state.roster.filter((player) => ids.has(player.id));
}

function toggleLock(playerId) {
  const existing = state.teams.assignments[playerId] || { pool: 'leftOut', locked: false };
  const updated = { ...existing, locked: !existing.locked };
  state.teams.assignments[playerId] = updated;
  if (window.db && window.db.setTeamAssignment) {
    window.db.setTeamAssignment(playerId, updated).catch((err) => console.error('lock save', err));
  }
  renderTeams();
}

function movePlayer(playerId) {
  const current = state.teams.assignments[playerId] || { pool: 'leftOut', locked: false };
  const nextPool = getNextPool(current.pool || 'leftOut');
  const updated = { ...current, pool: nextPool };
  state.teams.assignments[playerId] = updated;
  if (window.db && window.db.setTeamAssignment) {
    window.db.setTeamAssignment(playerId, updated).catch((err) => console.error('move save', err));
  }
  renderTeams();
}

function getNextPool(currentPool) {
  const order = ['teamA', 'teamB', 'subs', 'leftOut'];
  const index = order.indexOf(currentPool);
  return order[(index + 1) % order.length];
}

function labelForPool(pool) {
  const labels = {
    teamA: 'Team A',
    teamB: 'Team B',
    subs: 'Subs',
    leftOut: 'Left Out'
  };
  return labels[pool] || 'Left Out';
}

function editPlayer(playerId) {
  const player = state.roster.find((entry) => entry.id === playerId);
  if (!player) return;
  document.getElementById('player-id').value = player.id;
  document.getElementById('player-name').value = player.name;
  document.getElementById('player-rank').value = player.rank;
  document.getElementById('player-thp').value = player.thp;
  document.getElementById('roster-form').classList.remove('hidden');
  document.getElementById('player-name').focus();
}

function deletePlayer(playerId) {
  if (window.db && window.db.deletePlayer) {
    window.db.deletePlayer(playerId).catch((err) => console.error('delete player', err));
  } else {
    state.roster = state.roster.filter((player) => player.id !== playerId);
    delete state.desert.registrations[playerId];
    delete state.teams.assignments[playerId];
    render();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

init();
