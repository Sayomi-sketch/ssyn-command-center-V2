const STORAGE_KEY = 'ssyn-command-center-v2-state';

const defaultState = {
  roster: [],
  desert: {
    eventDate: '',
    timeSlot: '18:00',
    registrations: {}
  },
  teams: {
    assignments: {},
    generated: false,
    lastSavedAt: ''
  }
};

let state = loadState();

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return structuredClone(defaultState);
    }
    const parsed = JSON.parse(saved);
    return {
      roster: Array.isArray(parsed.roster) ? parsed.roster : [],
      desert: {
        eventDate: parsed?.desert?.eventDate || '',
        timeSlot: parsed?.desert?.timeSlot || '18:00',
        registrations: parsed?.desert?.registrations || {}
      },
      teams: {
        assignments: parsed?.teams?.assignments || {},
        generated: Boolean(parsed?.teams?.generated),
        lastSavedAt: parsed?.teams?.lastSavedAt || ''
      }
    };
  } catch (error) {
    console.warn('Unable to load state', error);
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  state.teams.lastSavedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function init() {
  bindNavigation();
  bindRoster();
  bindDesert();
  bindTeams();
  render();
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

  cancel.addEventListener('click', () => {
    resetRosterForm();
    form.classList.add('hidden');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const player = {
      id: document.getElementById('player-id').value || crypto.randomUUID(),
      name: document.getElementById('player-name').value.trim(),
      rank: normalizeRank(document.getElementById('player-rank').value),
      thp: Number(document.getElementById('player-thp').value)
    };

    if (!player.name || Number.isNaN(player.thp)) {
      return;
    }

    const existingId = document.getElementById('player-id').value;
    if (existingId) {
      state.roster = state.roster.map((entry) => (entry.id === existingId ? player : entry));
    } else {
      state.roster.push(player);
    }

    saveState();
    renderRoster();
    resetRosterForm();
    form.classList.add('hidden');
  });

  search.addEventListener('input', renderRoster);
  sort.addEventListener('change', renderRoster);
}

function resetRosterForm() {
  const form = document.getElementById('roster-form');
  form.reset();
  document.getElementById('player-id').value = '';
  document.getElementById('player-rank').value = 'R1';
}

function bindDesert() {
  document.getElementById('event-date').addEventListener('change', (event) => {
    state.desert.eventDate = event.target.value;
    saveState();
    renderDesert();
  });

  document.getElementById('event-time').addEventListener('change', (event) => {
    state.desert.timeSlot = event.target.value;
    saveState();
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
    saveState();
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
    return [player.name, player.rank, String(player.thp)].some((value) => String(value).toLowerCase().includes(search));
  });

  players.sort((a, b) => {
    switch (sort) {
      case 'thp-desc':
        return b.thp - a.thp;
      case 'thp-asc':
        return a.thp - b.thp;
      case 'rank':
        return normalizeRank(a.rank).localeCompare(normalizeRank(b.rank));
      default:
        return a.name.localeCompare(b.name);
    }
  });

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">No players yet. Add the first roster member to begin.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    return `
      <article class="player-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats">
              ${renderRankBadge(player.rank)}
              <span class="stat-divider">THP ${player.thp}</span>
            </div>
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
    return `
      <article class="registration-row">
        <div class="registration-top">
          <div>
            <div class="registration-name">${escapeHtml(player.name)}</div>
            <div class="registration-meta">${renderRankBadge(player.rank)} <span class="stat-divider">THP ${player.thp}</span></div>
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
      saveState();
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
  const summary = document.getElementById('team-summary');

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
    const pool = assignment.pool || 'leftOut';
    if (poolMap[pool] !== undefined) {
      poolMap[pool].push(player);
    }
  });

  const teamAThp = poolMap.teamA.reduce((sum, entry) => sum + entry.thp, 0);
  const teamBThp = poolMap.teamB.reduce((sum, entry) => sum + entry.thp, 0);
  const thpDifference = Math.abs(teamAThp - teamBThp);

  summary.innerHTML = `
    <div class="summary-grid">
      <div class="summary-item">
        <span class="summary-label">Total THP Team A</span>
        <span class="summary-value">${teamAThp}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Total THP Team B</span>
        <span class="summary-value">${teamBThp}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">THP Difference</span>
        <span class="summary-value">${thpDifference}</span>
      </div>
    </div>
  `;

  if (!includedPlayers.length) {
    [teamAList, teamBList, subsList, leftOutList].forEach((element) => {
      element.innerHTML = '<div class="list-empty">No eligible players yet. Mark players as Requested to Fight in Desert Storm.</div>';
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
            <div class="player-stats">${renderRankBadge(player.rank)} <span class="stat-divider">THP ${player.thp}</span></div>
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
  const orderedPlayers = [...availablePlayers].sort((playerA, playerB) => {
    const registrationA = state.desert.registrations[playerA.id] || { requested: false, guaranteed: false };
    const registrationB = state.desert.registrations[playerB.id] || { requested: false, guaranteed: false };
    const guaranteedDiff = Number(registrationB.guaranteed) - Number(registrationA.guaranteed);
    if (guaranteedDiff !== 0) {
      return guaranteedDiff;
    }
    return playerB.thp - playerA.thp;
  });

  const leadershipPlayers = orderedPlayers.filter((player) => isLeadershipRank(player.rank));
  const corePlayers = orderedPlayers.filter((player) => !isLeadershipRank(player.rank));

  leadershipPlayers.forEach((player) => {
    const targetPool = selectLeadershipTarget(poolState);
    if (!targetPool) {
      if (poolState.subs.length < 10) {
        poolState.subs.push(player);
      } else {
        poolState.leftOut.push(player);
      }
      return;
    }
    poolState[targetPool].push(player);
  });

  corePlayers.forEach((player) => {
    const targetPool = selectBalancedStarterTarget(poolState);
    if (!targetPool) {
      if (poolState.subs.length < 10) {
        poolState.subs.push(player);
      } else {
        poolState.leftOut.push(player);
      }
      return;
    }
    poolState[targetPool].push(player);
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
      state.desert.registrations[player.id] = registration;
    }
  });

  state.teams.assignments = nextAssignments;
  state.teams.generated = true;
  saveState();
}

function getPoolForPlayer(player, poolState) {
  if (poolState.teamA.some((entry) => entry.id === player.id)) return 'teamA';
  if (poolState.teamB.some((entry) => entry.id === player.id)) return 'teamB';
  if (poolState.subs.some((entry) => entry.id === player.id)) return 'subs';
  return 'leftOut';
}

function selectLeadershipTarget(poolState) {
  const teamAFull = poolState.teamA.length >= 20;
  const teamBFull = poolState.teamB.length >= 20;

  if (teamAFull && teamBFull) {
    return null;
  }
  if (teamAFull) {
    return 'teamB';
  }
  if (teamBFull) {
    return 'teamA';
  }

  const teamALeaders = poolState.teamA.filter((entry) => isLeadershipRank(entry.rank)).length;
  const teamBLeaders = poolState.teamB.filter((entry) => isLeadershipRank(entry.rank)).length;
  const teamAThp = poolState.teamA.reduce((sum, entry) => sum + entry.thp, 0);
  const teamBThp = poolState.teamB.reduce((sum, entry) => sum + entry.thp, 0);

  if (teamALeaders < teamBLeaders) {
    return 'teamA';
  }
  if (teamBLeaders < teamALeaders) {
    return 'teamB';
  }
  return teamAThp <= teamBThp ? 'teamA' : 'teamB';
}

function selectBalancedStarterTarget(poolState) {
  const teamAFull = poolState.teamA.length >= 20;
  const teamBFull = poolState.teamB.length >= 20;

  if (teamAFull && teamBFull) {
    return null;
  }
  if (teamAFull) {
    return 'teamB';
  }
  if (teamBFull) {
    return 'teamA';
  }

  const teamAThp = poolState.teamA.reduce((sum, entry) => sum + entry.thp, 0);
  const teamBThp = poolState.teamB.reduce((sum, entry) => sum + entry.thp, 0);
  return teamAThp <= teamBThp ? 'teamA' : 'teamB';
}

function getIncludedPlayers() {
  return state.roster.filter((player) => {
    const registration = state.desert.registrations[player.id] || { requested: false, guaranteed: false };
    return Boolean(registration.requested);
  });
}

function toggleLock(playerId) {
  const existing = state.teams.assignments[playerId] || { pool: 'leftOut', locked: false };
  existing.locked = !existing.locked;
  state.teams.assignments[playerId] = existing;
  saveState();
  renderTeams();
}

function movePlayer(playerId) {
  const current = state.teams.assignments[playerId] || { pool: 'leftOut', locked: false };
  if (current.locked) {
    return;
  }
  const nextPool = getNextPool(current.pool || 'leftOut');
  state.teams.assignments[playerId] = { ...current, pool: nextPool };
  saveState();
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

function normalizeRank(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['R1', 'R2', 'R3', 'R4', 'R5'].includes(normalized)) {
    return normalized;
  }
  return 'R1';
}

function isLeadershipRank(rank) {
  const normalized = normalizeRank(rank);
  return normalized === 'R4' || normalized === 'R5';
}

function renderRankBadge(rank) {
  const normalized = normalizeRank(rank);
  const className = `rank-badge rank-${normalized.toLowerCase()}`;
  return `<span class="${className}">${escapeHtml(normalized)}</span>`;
}

function editPlayer(playerId) {
  const player = state.roster.find((entry) => entry.id === playerId);
  if (!player) return;
  document.getElementById('player-id').value = player.id;
  document.getElementById('player-name').value = player.name;
  document.getElementById('player-rank').value = normalizeRank(player.rank);
  document.getElementById('player-thp').value = player.thp;
  document.getElementById('roster-form').classList.remove('hidden');
  document.getElementById('player-name').focus();
}

function deletePlayer(playerId) {
  state.roster = state.roster.filter((player) => player.id !== playerId);
  delete state.desert.registrations[playerId];
  delete state.teams.assignments[playerId];
  saveState();
  render();
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
