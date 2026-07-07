// Firestore-backed state. Real-time listeners populate the active collections.
const state = {
  roster: [],
  archived: [],
  desert: { eventDate: '', timeSlot: '18:00', registrations: {} },
  teams: { assignments: {}, generated: false, lastSavedAt: '' },
  warzone: {
    events: [],
    draft: { eventDate: getTodayInputValue(), opponentServer: '' },
    selectedEventId: '',
    historyOpen: false,
    participations: {}
  },
  attendance: {
    stats: {},
    persistedSignature: ''
  },
  ui: {
    pendingArchivedMatchId: '',
    pendingPlayerDraft: null
  }
};

function init() {
  bindNavigation();
  bindRoster();
  bindDesert();
  bindTeams();
  bindWarzone();
  bindAttendance();
  bindArchived();
  bindArchiveModal();
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
      list.push(normalizePlayer(doc.id, doc.data()));
    });
    state.roster = list;
    syncWarzoneDraftPlayers();
    recomputeAttendanceStats();
    renderRoster();
    renderDesert();
    renderTeams();
    renderWarzone();
    renderAttendance();
  });

  window.db.onArchivedSnapshot((snap) => {
    const list = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      list.push({
        ...normalizePlayer(doc.id, data),
        archivedAt: data.archivedAt || null,
        lastKnownRank: data.lastKnownRank || data.rankValue || data.rank || 'R1',
        lastKnownThp: Number(data.lastKnownThp ?? data.thp) || 0
      });
    });
    state.archived = list.sort((left, right) => {
      const a = valueToMillis(left.archivedAt);
      const b = valueToMillis(right.archivedAt);
      return b - a || left.name.localeCompare(right.name);
    });
    recomputeAttendanceStats();
    renderArchived();
    renderWarzone();
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
    const data = doc.data();
    state.desert.eventDate = data.eventDate || '';
    state.desert.timeSlot = data.timeSlot || '18:00';
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
    const data = doc.data();
    state.teams.generated = Boolean(data.generated);
    state.teams.lastSavedAt = data.lastSavedAt || '';
    renderTeams();
  });

  window.db.onWarzonesSnapshot((snap) => {
    const list = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      list.push({
        id: doc.id,
        eventDate: data.eventDate || '',
        opponentServer: data.opponentServer || '',
        participations: data.participations || {},
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
      });
    });
    state.warzone.events = list.sort((left, right) => right.eventDate.localeCompare(left.eventDate));
    if (state.warzone.selectedEventId) {
      const selected = state.warzone.events.find((entry) => entry.id === state.warzone.selectedEventId);
      if (selected) {
        hydrateWarzoneFromEvent(selected);
      } else {
        resetWarzoneDraft();
      }
    }
    recomputeAttendanceStats();
    renderWarzone();
    renderAttendance();
    renderArchived();
  });
}

function bindNavigation() {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => openView(button.dataset.target));
  });
}

function openView(targetId) {
  document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.target === targetId);
  });
  const target = document.getElementById(targetId);
  if (target) target.classList.add('active');
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
  document.getElementById('open-archived-view').addEventListener('click', () => openView('archived-view'));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const existingId = document.getElementById('player-id').value;
    const player = {
      id: existingId || crypto.randomUUID(),
      name: document.getElementById('player-name').value.trim(),
      rank: document.getElementById('player-rank').value,
      rankValue: document.getElementById('player-rank').value,
      thp: Number(document.getElementById('player-thp').value)
    };

    if (!player.name || !player.rank || Number.isNaN(player.thp)) return;

    if (!existingId) {
      const archivedMatch = findArchivedPlayerByName(player.name);
      if (archivedMatch) {
        state.ui.pendingArchivedMatchId = archivedMatch.id;
        state.ui.pendingPlayerDraft = player;
        openArchiveMatchModal(archivedMatch);
        return;
      }
    }

    saveRosterPlayer(player);
  });

  search.addEventListener('input', renderRoster);
  sort.addEventListener('change', renderRoster);
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

function bindWarzone() {
  document.getElementById('warzone-date').addEventListener('change', (event) => {
    state.warzone.draft.eventDate = event.target.value;
    if (state.warzone.selectedEventId) persistSelectedWarzone();
    renderWarzoneHeader();
  });

  document.getElementById('warzone-opponent').addEventListener('input', (event) => {
    state.warzone.draft.opponentServer = event.target.value.trim();
    if (state.warzone.selectedEventId) persistSelectedWarzone();
    renderWarzoneHeader();
  });

  document.getElementById('save-warzone').addEventListener('click', saveWarzone);
  document.getElementById('toggle-warzone-history').addEventListener('click', () => {
    state.warzone.historyOpen = !state.warzone.historyOpen;
    renderWarzone();
  });
  document.getElementById('new-warzone').addEventListener('click', resetWarzoneDraft);
}

function bindAttendance() {
  document.getElementById('attendance-search').addEventListener('input', renderAttendance);
  document.getElementById('attendance-sort').addEventListener('change', renderAttendance);
}

function bindArchived() {
  document.getElementById('back-to-roster').addEventListener('click', () => openView('roster-view'));
}

function bindArchiveModal() {
  document.getElementById('cancel-archive-match').addEventListener('click', closeArchiveMatchModal);
  document.getElementById('create-new-player').addEventListener('click', () => {
    const player = state.ui.pendingPlayerDraft;
    closeArchiveMatchModal();
    if (player) saveRosterPlayer(player, true);
  });
  document.getElementById('restore-archived-player').addEventListener('click', async () => {
    const archivedId = state.ui.pendingArchivedMatchId;
    closeArchiveMatchModal();
    if (!archivedId) return;
    if (window.db && window.db.restorePlayer) {
      window.db.restorePlayer(archivedId).catch((err) => console.error('restore archived player', err));
    }
  });
}

function render() {
  renderRoster();
  renderDesert();
  renderTeams();
  renderWarzone();
  renderAttendance();
  renderArchived();
}

function renderRoster() {
  const list = document.getElementById('roster-list');
  const search = document.getElementById('roster-search').value.toLowerCase();
  const sort = document.getElementById('roster-sort').value;

  const players = [...state.roster]
    .filter((player) => [player.name, player.rank, String(player.thp)].some((value) => value.toLowerCase().includes(search)))
    .sort((left, right) => sortPlayers(left, right, sort));

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">No active players yet. Add the first roster member to begin.</div>';
    return;
  }

  list.innerHTML = players.map((player) => renderPlayerCard(player)).join('');
}

function renderPlayerCard(player) {
  const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
  return `
    <article class="player-card">
      <div class="player-top">
        <div>
          <div class="player-name">${escapeHtml(player.name)}</div>
          <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${player.thp}</div>
        </div>
      </div>
      <div class="row-actions">
        <button class="secondary-btn" onclick="editPlayer('${player.id}')">Edit</button>
        <button class="secondary-btn" onclick="archivePlayer('${player.id}')">Archive Player</button>
      </div>
    </article>
  `;
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
  const leftOutList = document.getElementById('left-out-list');

  const assignments = state.teams.assignments || {};
  const includedPlayers = getIncludedPlayers();
  const poolMap = {
    teamAStarter: [],
    teamASub: [],
    teamBStarter: [],
    teamBSub: [],
    leftOut: []
  };
  const legacySubs = [];

  includedPlayers.forEach((player) => {
    const pool = normalizePool(assignments[player.id]?.pool);
    if (pool === 'subs') {
      legacySubs.push(player);
      return;
    }
    if (poolMap[pool] !== undefined) poolMap[pool].push(player);
  });

  legacySubs.forEach((player) => {
    const targetPool = pickBalancedPool(player, poolMap, ['teamASub', 'teamBSub']);
    poolMap[targetPool || 'leftOut'].push(player);
  });

  const teamATHP = sumPlayers(poolMap.teamAStarter) + sumPlayers(poolMap.teamASub);
  const teamBTHP = sumPlayers(poolMap.teamBStarter) + sumPlayers(poolMap.teamBSub);
  const diff = Math.abs(teamATHP - teamBTHP);
  const aEl = document.getElementById('team-a-thp');
  const bEl = document.getElementById('team-b-thp');
  const dEl = document.getElementById('thp-diff');
  if (aEl) aEl.textContent = String(teamATHP);
  if (bEl) bEl.textContent = String(teamBTHP);
  if (dEl) dEl.textContent = String(diff);

  if (!includedPlayers.length) {
    [teamAList, teamBList, leftOutList].forEach((element) => {
      element.innerHTML = '<div class="list-empty">No eligible players yet. Mark players as requested or guaranteed in Desert Storm.</div>';
    });
    return;
  }

  renderTeamGroup(teamAList, poolMap.teamAStarter, poolMap.teamASub, 'teamA');
  renderTeamGroup(teamBList, poolMap.teamBStarter, poolMap.teamBSub, 'teamB');
  renderPool(leftOutList, poolMap.leftOut, 'leftOut');
}

function renderTeamGroup(container, starters, subs, teamKey) {
  const starterCards = renderPoolCards(starters, `${teamKey}Starter`);
  const subCards = renderPoolCards(subs, `${teamKey}Sub`);
  container.innerHTML = `
    <section class="team-group-section">
      <div class="team-meta">Starters (${starters.length}/20)</div>
      ${starterCards || '<div class="list-empty">No starters assigned.</div>'}
    </section>
    <section class="team-group-section">
      <div class="team-meta">Subs (${subs.length}/10)</div>
      ${subCards || '<div class="list-empty">No substitutes assigned.</div>'}
    </section>
  `;
}

function renderPool(container, players, pool) {
  if (!players.length) {
    container.innerHTML = '<div class="list-empty">No players in this lane.</div>';
    return;
  }

  container.innerHTML = renderPoolCards(players, pool);
}

function renderPoolCards(players, pool) {
  if (!players.length) return '';

  return players.map((player) => {
    const assignment = state.teams.assignments[player.id] || { pool, locked: false };
    const lockLabel = assignment.locked ? '🔒 Locked' : '🔓 Unlock';
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    return `
      <article class="team-player-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${player.thp}</div>
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

function renderWarzone() {
  renderWarzoneHeader();

  const historyPanel = document.getElementById('warzone-history-panel');
  const newButton = document.getElementById('new-warzone');
  historyPanel.classList.toggle('hidden', !state.warzone.historyOpen);
  newButton.classList.toggle('hidden', !state.warzone.selectedEventId);

  renderWarzoneHistory();
  renderWarzonePlayers();
}

function renderWarzoneHeader() {
  document.getElementById('warzone-date').value = state.warzone.draft.eventDate || '';
  document.getElementById('warzone-opponent').value = state.warzone.draft.opponentServer || '';
  const note = document.getElementById('warzone-status-note');
  if (state.warzone.selectedEventId) {
    note.textContent = 'Editing a saved Warzone. Participation and field changes autosave.';
  } else {
    note.textContent = 'Set participation for each active player, then save the event.';
  }
}

function renderWarzoneHistory() {
  const list = document.getElementById('warzone-history-list');
  if (!state.warzone.events.length) {
    list.innerHTML = '<div class="list-empty">No Warzone events saved yet.</div>';
    return;
  }

  list.innerHTML = state.warzone.events.map((event) => `
    <button class="history-entry ${event.id === state.warzone.selectedEventId ? 'selected' : ''}" data-event-id="${event.id}">
      <span>${escapeHtml(formatDateLabel(event.eventDate))}</span>
      <span>${escapeHtml(event.opponentServer || 'Opponent pending')}</span>
    </button>
  `).join('');

  list.querySelectorAll('.history-entry').forEach((button) => {
    button.addEventListener('click', () => {
      const selected = state.warzone.events.find((entry) => entry.id === button.dataset.eventId);
      if (!selected) return;
      hydrateWarzoneFromEvent(selected);
      renderWarzone();
    });
  });
}

function renderWarzonePlayers() {
  const list = document.getElementById('warzone-player-list');
  const players = getWarzoneRosterPlayers();
  if (!players.length) {
    list.innerHTML = '<div class="list-empty">Add active players to the Alliance Roster before recording a Warzone.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    const participation = state.warzone.participations[player.id]?.status || '';
    const rankLabel = escapeHtml(player.rank || player.rankValue || player.lastKnownRank || 'R1');
    const archivedTag = player.archived ? '<span class="chip archived-chip">Archived</span>' : '';
    return `
      <article class="player-card warzone-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${Number(player.thp ?? player.lastKnownThp) || 0}</div>
          </div>
          ${archivedTag}
        </div>
        <div class="warzone-status-group" role="radiogroup" aria-label="${escapeHtml(player.name)} participation status">
          ${renderWarzoneOption(player.id, participation, 'participated', '🟢 Participated')}
          ${renderWarzoneOption(player.id, participation, 'excused', '🟡 Excused')}
          ${renderWarzoneOption(player.id, participation, 'missed', '🔴 Did Not Participate')}
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const playerId = event.target.dataset.playerId;
      const status = event.target.value;
      const player = getWarzonePlayerById(playerId);
      if (!player) return;
      state.warzone.participations[playerId] = buildParticipationEntry(player, status);
      if (state.warzone.selectedEventId) persistSelectedWarzone();
      renderWarzonePlayers();
      renderAttendance();
    });
  });
}

function renderWarzoneOption(playerId, currentStatus, value, label) {
  const checked = currentStatus === value ? 'checked' : '';
  const inputId = `warzone-${playerId}-${value}`;
  return `
    <label class="radio-pill ${checked ? 'selected' : ''}" for="${inputId}">
      <input id="${inputId}" type="radio" name="warzone-status-${playerId}" data-player-id="${playerId}" value="${value}" ${checked} />
      <span>${label}</span>
    </label>
  `;
}

function renderAttendance() {
  renderAttendanceSummary();

  const list = document.getElementById('attendance-list');
  const search = document.getElementById('attendance-search').value.trim().toLowerCase();
  const sort = document.getElementById('attendance-sort').value;

  const players = state.roster
    .filter((player) => player.name.toLowerCase().includes(search))
    .sort((left, right) => compareAttendancePlayers(left, right, sort));

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">No active players match the current search.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    const stats = state.attendance.stats[player.id] || emptyAttendanceStat(player);
    const borderClass = getAttendanceBorderClass(stats.attendancePercent);
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    return `
      <article class="player-card attendance-card ${borderClass}">
        <div class="attendance-card-header">
          <div class="player-name">${escapeHtml(player.name)}</div>
          <div class="attendance-percent">${formatAttendancePercent(stats.attendancePercent)}</div>
        </div>
        <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${player.thp}</div>
        <div class="attendance-history">${escapeHtml(formatAttendanceHistory(stats))}</div>
      </article>
    `;
  }).join('');
}

function renderAttendanceSummary() {
  const container = document.getElementById('attendance-summary');
  const activeStats = state.roster.map((player) => state.attendance.stats[player.id] || emptyAttendanceStat(player));
  const validAttendance = activeStats.filter((entry) => typeof entry.attendancePercent === 'number');
  const average = validAttendance.length
    ? validAttendance.reduce((sum, entry) => sum + entry.attendancePercent, 0) / validAttendance.length
    : null;
  const above90 = validAttendance.filter((entry) => entry.attendancePercent >= 90).length;
  const below75 = validAttendance.filter((entry) => entry.attendancePercent < 75).length;

  container.innerHTML = `
    <div class="summary-item">
      <div class="summary-label">Alliance Average Attendance</div>
      <div class="summary-value">${formatAttendancePercent(average)}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Total Warzones</div>
      <div class="summary-value">${state.warzone.events.length}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Players Above 90%</div>
      <div class="summary-value">${above90}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Players Below 75%</div>
      <div class="summary-value">${below75}</div>
    </div>
  `;
}

function renderArchived() {
  const list = document.getElementById('archived-list');
  if (!state.archived.length) {
    list.innerHTML = '<div class="list-empty">No archived players yet.</div>';
    return;
  }

  list.innerHTML = state.archived.map((player) => {
    const stats = state.attendance.stats[player.id] || emptyAttendanceStat(player);
    const rankLabel = escapeHtml(player.lastKnownRank || player.rank || player.rankValue || 'R1');
    return `
      <article class="player-card archived-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${Number(player.lastKnownThp ?? player.thp) || 0}</div>
          </div>
          <div class="archived-meta">${escapeHtml(formatAttendancePercent(stats.attendancePercent))}</div>
        </div>
        <div class="archived-details">
          <div>Archived Date: ${escapeHtml(formatDateTimeLabel(player.archivedAt))}</div>
          <div>Attendance: ${escapeHtml(formatAttendanceHistory(stats))}</div>
        </div>
        <div class="row-actions">
          <button class="secondary-btn" onclick="restoreArchivedPlayer('${player.id}')">Restore Player</button>
          <button class="secondary-btn danger-btn" onclick="deleteArchivedPlayerPermanently('${player.id}')">Delete Permanently</button>
        </div>
      </article>
    `;
  }).join('');
}

function saveRosterPlayer(player) {
  if (window.db && window.db.upsertPlayer) {
    window.db.upsertPlayer(player)
      .then(() => resetRosterForm())
      .catch((err) => console.error('Error saving player', err));
    return;
  }

  const existingId = document.getElementById('player-id').value;
  if (existingId) {
    state.roster = state.roster.map((entry) => (entry.id === existingId ? player : entry));
  } else {
    state.roster.push(player);
  }
  resetRosterForm();
  renderRoster();
}

function saveWarzone() {
  const eventDate = state.warzone.draft.eventDate;
  const opponentServer = state.warzone.draft.opponentServer.trim();
  if (!eventDate || !opponentServer) return;

  const activePlayers = state.roster;
  const participationMap = { ...state.warzone.participations };
  activePlayers.forEach((player) => {
    if (!participationMap[player.id]) {
      participationMap[player.id] = buildParticipationEntry(player, 'missed');
    }
  });
  state.warzone.participations = participationMap;

  const isExisting = Boolean(state.warzone.selectedEventId);
  const eventId = state.warzone.selectedEventId || crypto.randomUUID();
  const payload = {
    eventDate,
    opponentServer,
    participations: participationMap
  };
  if (!isExisting && window.db && window.db.serverTimestamp) {
    payload.createdAt = window.db.serverTimestamp();
  }

  if (window.db && window.db.upsertWarzoneEvent) {
    window.db.upsertWarzoneEvent(eventId, payload)
      .then(() => {
        state.warzone.selectedEventId = eventId;
        renderWarzone();
      })
      .catch((err) => console.error('save warzone', err));
    return;
  }

  upsertWarzoneLocally(eventId, payload);
}

function persistSelectedWarzone() {
  if (!state.warzone.selectedEventId || !(window.db && window.db.upsertWarzoneEvent)) return;
  window.db.upsertWarzoneEvent(state.warzone.selectedEventId, {
    eventDate: state.warzone.draft.eventDate,
    opponentServer: state.warzone.draft.opponentServer,
    participations: state.warzone.participations
  }).catch((err) => console.error('autosave warzone', err));
}

function resetRosterForm() {
  document.getElementById('roster-form').reset();
  document.getElementById('player-id').value = '';
  document.getElementById('roster-form').classList.add('hidden');
}

function resetWarzoneDraft() {
  state.warzone.selectedEventId = '';
  state.warzone.draft = { eventDate: getTodayInputValue(), opponentServer: '' };
  state.warzone.participations = {};
  syncWarzoneDraftPlayers();
  renderWarzone();
}

function hydrateWarzoneFromEvent(event) {
  state.warzone.selectedEventId = event.id;
  state.warzone.draft = {
    eventDate: event.eventDate || getTodayInputValue(),
    opponentServer: event.opponentServer || ''
  };
  state.warzone.participations = cloneParticipations(event.participations || {});
}

function syncWarzoneDraftPlayers() {
  if (state.warzone.selectedEventId) return;
  const nextParticipations = {};
  state.roster.forEach((player) => {
    nextParticipations[player.id] = state.warzone.participations[player.id]
      ? { ...state.warzone.participations[player.id], name: player.name, rank: player.rankValue || player.rank || 'R1', thp: Number(player.thp) || 0 }
      : buildParticipationEntry(player, '');
  });
  state.warzone.participations = nextParticipations;
}

function buildParticipationEntry(player, status) {
  return {
    status,
    name: player.name,
    rank: player.rankValue || player.rank || player.lastKnownRank || 'R1',
    thp: Number(player.thp ?? player.lastKnownThp) || 0
  };
}

function recomputeAttendanceStats() {
  const directory = buildPlayerDirectory();
  const stats = {};

  Object.values(directory).forEach((player) => {
    stats[player.id] = emptyAttendanceStat(player);
  });

  state.warzone.events.forEach((event) => {
    Object.entries(event.participations || {}).forEach(([playerId, entry]) => {
      const base = directory[playerId] || normalizePlayer(playerId, entry || {});
      const stat = stats[playerId] || emptyAttendanceStat(base);
      stat.playerId = playerId;
      stat.name = base.name || entry.name || '';
      stat.rank = base.rankValue || base.rank || entry.rank || 'R1';
      stat.thp = Number(base.thp ?? entry.thp) || 0;
      stat.recordedWarzones += 1;

      if (entry.status === 'participated') stat.participated += 1;
      if (entry.status === 'excused') stat.excused += 1;
      if (entry.status === 'missed') stat.missed += 1;

      stat.eligibleWarzones = Math.max(0, stat.recordedWarzones - stat.excused);
      stat.attendancePercent = stat.eligibleWarzones > 0
        ? (stat.participated / stat.eligibleWarzones) * 100
        : null;
      stats[playerId] = stat;
    });
  });

  state.attendance.stats = stats;
  persistAttendanceStats(stats);
}

function persistAttendanceStats(stats) {
  const serializable = {};
  Object.entries(stats).forEach(([playerId, entry]) => {
    serializable[playerId] = {
      playerId,
      name: entry.name,
      rank: entry.rank,
      thp: entry.thp,
      participated: entry.participated,
      excused: entry.excused,
      missed: entry.missed,
      recordedWarzones: entry.recordedWarzones,
      eligibleWarzones: entry.eligibleWarzones,
      attendancePercent: entry.attendancePercent
    };
  });
  const signature = JSON.stringify(serializable);
  if (signature === state.attendance.persistedSignature) return;
  state.attendance.persistedSignature = signature;

  if (window.db && window.db.setAttendanceStats) {
    window.db.setAttendanceStats(serializable).catch((err) => console.error('attendance stats', err));
  }
}

function emptyAttendanceStat(player) {
  return {
    playerId: player.id,
    name: player.name || '',
    rank: player.rankValue || player.rank || player.lastKnownRank || 'R1',
    thp: Number(player.thp ?? player.lastKnownThp) || 0,
    participated: 0,
    excused: 0,
    missed: 0,
    recordedWarzones: 0,
    eligibleWarzones: 0,
    attendancePercent: null
  };
}

function compareAttendancePlayers(left, right, sort) {
  const leftStats = state.attendance.stats[left.id] || emptyAttendanceStat(left);
  const rightStats = state.attendance.stats[right.id] || emptyAttendanceStat(right);
  const leftAttendance = leftStats.attendancePercent ?? -1;
  const rightAttendance = rightStats.attendancePercent ?? -1;

  switch (sort) {
    case 'name-desc':
      return right.name.localeCompare(left.name);
    case 'attendance-desc':
      return rightAttendance - leftAttendance || left.name.localeCompare(right.name);
    case 'attendance-asc':
      return leftAttendance - rightAttendance || left.name.localeCompare(right.name);
    case 'thp-desc':
      return right.thp - left.thp || left.name.localeCompare(right.name);
    case 'thp-asc':
      return left.thp - right.thp || left.name.localeCompare(right.name);
    default:
      return left.name.localeCompare(right.name);
  }
}

function formatAttendancePercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--';
  return `${value.toFixed(1)}%`;
}

function formatAttendanceHistory(stats) {
  if (!stats.recordedWarzones) return 'No attendance history';
  return `${stats.participated} / ${stats.eligibleWarzones} Warzones`;
}

function getAttendanceBorderClass(percent) {
  if (typeof percent !== 'number') return 'attendance-gray';
  if (percent >= 90) return 'attendance-green';
  if (percent >= 75) return 'attendance-yellow';
  if (percent >= 50) return 'attendance-orange';
  return 'attendance-red';
}

function renderTeamSummary() {
  renderTeams();
}

function generateTeams() {
  const eligiblePlayers = getIncludedPlayers();
  const assignments = { ...state.teams.assignments };
  const poolState = {
    teamAStarter: [],
    teamASub: [],
    teamBStarter: [],
    teamBSub: [],
    leftOut: []
  };
  const floatingLockedSubs = [];

  eligiblePlayers.forEach((player) => {
    const existing = assignments[player.id];
    if (existing?.locked) {
      const targetPool = normalizePool(existing.pool);
      if (targetPool === 'subs') {
        floatingLockedSubs.push(player);
        return;
      }
      poolState[targetPool].push(player);
    }
  });

  floatingLockedSubs.forEach((player) => {
    const targetPool = pickBalancedPool(player, poolState, ['teamASub', 'teamBSub']);
    poolState[targetPool || 'leftOut'].push(player);
  });

  const availablePlayers = eligiblePlayers.filter((player) => !assignments[player.id]?.locked);
  const guaranteedPlayers = availablePlayers.filter((player) => state.desert.registrations[player.id]?.guaranteed);
  const leaderPlayers = availablePlayers.filter((player) => !state.desert.registrations[player.id]?.guaranteed && isLeader(player));
  const otherPlayers = availablePlayers.filter((player) => !state.desert.registrations[player.id]?.guaranteed && !isLeader(player));

  const guaranteedStarterResult = assignBalancedGroup(guaranteedPlayers, poolState, ['teamAStarter', 'teamBStarter'], getOpenSlots(poolState, ['teamAStarter', 'teamBStarter'], 20), true);
  placePlayers(poolState, guaranteedStarterResult.assignments);

  const leaderStarterResult = assignBalancedGroup(leaderPlayers, poolState, ['teamAStarter', 'teamBStarter'], getOpenSlots(poolState, ['teamAStarter', 'teamBStarter'], 20), true);
  placePlayers(poolState, leaderStarterResult.assignments);

  const starterFillResult = assignBalancedGroup(otherPlayers, poolState, ['teamAStarter', 'teamBStarter'], getOpenSlots(poolState, ['teamAStarter', 'teamBStarter'], 20), false);
  placePlayers(poolState, starterFillResult.assignments);

  const subPriorityPlayers = [
    ...guaranteedStarterResult.unassigned,
    ...leaderStarterResult.unassigned,
    ...starterFillResult.unassigned
  ];

  const guaranteedSubPlayers = subPriorityPlayers.filter((player) => state.desert.registrations[player.id]?.guaranteed);
  const leaderSubPlayers = subPriorityPlayers.filter((player) => !state.desert.registrations[player.id]?.guaranteed && isLeader(player));
  const otherSubPlayers = subPriorityPlayers.filter((player) => !state.desert.registrations[player.id]?.guaranteed && !isLeader(player));

  const guaranteedSubResult = assignBalancedGroup(guaranteedSubPlayers, poolState, ['teamASub', 'teamBSub'], getOpenSlots(poolState, ['teamASub', 'teamBSub'], 10), true);
  placePlayers(poolState, guaranteedSubResult.assignments);

  const leaderSubResult = assignBalancedGroup(leaderSubPlayers, poolState, ['teamASub', 'teamBSub'], getOpenSlots(poolState, ['teamASub', 'teamBSub'], 10), true);
  placePlayers(poolState, leaderSubResult.assignments);

  const subFillResult = assignBalancedGroup(otherSubPlayers, poolState, ['teamASub', 'teamBSub'], getOpenSlots(poolState, ['teamASub', 'teamBSub'], 10), false);
  placePlayers(poolState, subFillResult.assignments);

  [...guaranteedSubResult.unassigned, ...leaderSubResult.unassigned, ...subFillResult.unassigned].forEach((player) => {
    poolState.leftOut.push(player);
  });

  const nextAssignments = {};
  const allPoolPlayers = [
    ...poolState.teamAStarter,
    ...poolState.teamASub,
    ...poolState.teamBStarter,
    ...poolState.teamBSub,
    ...poolState.leftOut
  ];

  allPoolPlayers.forEach((player) => {
    const previousEntry = assignments[player.id];
    const pool = getPoolForPlayer(player, poolState);
    nextAssignments[player.id] = { pool, locked: Boolean(previousEntry?.locked) };
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

  if (window.db && window.db.batchAssignments) {
    const meta = { generated: true, lastSavedAt: new Date().toISOString() };
    window.db.batchAssignments(nextAssignments, meta).catch((err) => console.error('batch assign', err));
  }

  Object.entries(state.desert.registrations).forEach(([playerId, reg]) => {
    if (reg.guaranteed && window.db && window.db.setRegistration) {
      window.db.setRegistration(playerId, reg).catch((err) => console.error(err));
    }
  });
}

function getPoolForPlayer(player, poolState) {
  if (poolState.teamAStarter.some((entry) => entry.id === player.id)) return 'teamAStarter';
  if (poolState.teamASub.some((entry) => entry.id === player.id)) return 'teamASub';
  if (poolState.teamBStarter.some((entry) => entry.id === player.id)) return 'teamBStarter';
  if (poolState.teamBSub.some((entry) => entry.id === player.id)) return 'teamBSub';
  return 'leftOut';
}

function getIncludedPlayers() {
  const ids = new Set();
  Object.entries(state.desert.registrations).forEach(([playerId, registration]) => {
    if (registration.requested) ids.add(playerId);
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

function archivePlayer(playerId) {
  const player = state.roster.find((entry) => entry.id === playerId);
  if (!player) return;
  const attendance = state.attendance.stats[playerId] || emptyAttendanceStat(player);
  if (window.db && window.db.archivePlayer) {
    window.db.archivePlayer(player, attendance).catch((err) => console.error('archive player', err));
    return;
  }

  state.roster = state.roster.filter((entry) => entry.id !== playerId);
  state.archived.unshift({
    ...player,
    archivedAt: new Date().toISOString(),
    lastKnownRank: player.rankValue || player.rank || 'R1',
    lastKnownThp: Number(player.thp) || 0
  });
  delete state.desert.registrations[playerId];
  delete state.teams.assignments[playerId];
  delete state.warzone.participations[playerId];
  syncWarzoneDraftPlayers();
  recomputeAttendanceStats();
  render();
}

function restoreArchivedPlayer(playerId) {
  if (window.db && window.db.restorePlayer) {
    window.db.restorePlayer(playerId).catch((err) => console.error('restore archived player', err));
    return;
  }

  const player = state.archived.find((entry) => entry.id === playerId);
  if (!player) return;
  state.archived = state.archived.filter((entry) => entry.id !== playerId);
  state.roster.push(normalizePlayer(player.id, player));
  syncWarzoneDraftPlayers();
  recomputeAttendanceStats();
  render();
}

function deleteArchivedPlayerPermanently(playerId) {
  if (!window.confirm('Delete this archived player permanently? This cannot be undone.')) return;
  if (window.db && window.db.permanentlyDeleteArchivedPlayer) {
    window.db.permanentlyDeleteArchivedPlayer(playerId).catch((err) => console.error('delete archived player', err));
    return;
  }

  state.archived = state.archived.filter((entry) => entry.id !== playerId);
  state.warzone.events = state.warzone.events.map((event) => {
    if (!event.participations || !event.participations[playerId]) return event;
    const nextParticipations = { ...event.participations };
    delete nextParticipations[playerId];
    return { ...event, participations: nextParticipations };
  });
  delete state.attendance.stats[playerId];
  if (state.warzone.selectedEventId) {
    delete state.warzone.participations[playerId];
  }
  recomputeAttendanceStats();
  renderArchived();
  renderWarzone();
  renderAttendance();
}

function editPlayer(playerId) {
  const player = state.roster.find((entry) => entry.id === playerId);
  if (!player) return;
  document.getElementById('player-id').value = player.id;
  document.getElementById('player-name').value = player.name;
  document.getElementById('player-rank').value = player.rankValue || player.rank;
  document.getElementById('player-thp').value = player.thp;
  document.getElementById('roster-form').classList.remove('hidden');
  document.getElementById('player-name').focus();
}

function getNextPool(currentPool) {
  const order = ['teamAStarter', 'teamBStarter', 'teamASub', 'teamBSub', 'leftOut'];
  const normalizedPool = normalizePool(currentPool);
  const index = order.indexOf(normalizedPool === 'subs' ? 'teamASub' : normalizedPool);
  return order[(index + 1) % order.length];
}

function labelForPool(pool) {
  const labels = {
    teamAStarter: 'Team A Starter',
    teamASub: 'Team A Sub',
    teamBStarter: 'Team B Starter',
    teamBSub: 'Team B Sub',
    leftOut: 'Left Out'
  };
  return labels[normalizePool(pool)] || 'Left Out';
}

function normalizePool(pool) {
  const normalizedPools = {
    teamA: 'teamAStarter',
    teamAStarter: 'teamAStarter',
    teamASub: 'teamASub',
    teamB: 'teamBStarter',
    teamBStarter: 'teamBStarter',
    teamBSub: 'teamBSub',
    subs: 'subs',
    leftOut: 'leftOut'
  };
  return normalizedPools[pool] || 'leftOut';
}

function isLeader(player) {
  return (player.rank || player.rankValue || '').toString().startsWith('R4') || (player.rank || player.rankValue || '').toString().startsWith('R5');
}

function sumPlayers(players) {
  return players.reduce((sum, player) => sum + (Number(player.thp) || 0), 0);
}

function getOpenSlots(poolState, pools, capacityPerPool) {
  const slotMap = {};
  pools.forEach((pool) => {
    slotMap[pool] = Math.max(0, capacityPerPool - poolState[pool].length);
  });
  return slotMap;
}

function placePlayers(poolState, assignments) {
  assignments.forEach(({ player, pool }) => {
    poolState[pool].push(player);
  });
}

function pickBalancedPool(player, poolState, pools) {
  const viablePools = pools.filter((pool) => {
    if (pool === 'teamASub') return poolState.teamASub.length < 10;
    if (pool === 'teamBSub') return poolState.teamBSub.length < 10;
    return true;
  });
  if (!viablePools.length) return null;

  let bestPool = viablePools[0];
  let bestScore = Number.POSITIVE_INFINITY;

  viablePools.forEach((pool) => {
    const teamA = sumPlayers(poolState.teamAStarter) + sumPlayers(poolState.teamASub) + (pool.startsWith('teamA') ? Number(player.thp) || 0 : 0);
    const teamB = sumPlayers(poolState.teamBStarter) + sumPlayers(poolState.teamBSub) + (pool.startsWith('teamB') ? Number(player.thp) || 0 : 0);
    const score = Math.abs(teamA - teamB);
    if (score < bestScore) {
      bestScore = score;
      bestPool = pool;
    }
  });

  return bestPool;
}

function assignBalancedGroup(players, poolState, pools, slotsByPool, mustPlace) {
  const sortedPlayers = [...players].sort((a, b) => (Number(b.thp) || 0) - (Number(a.thp) || 0));
  const totalSlots = pools.reduce((sum, pool) => sum + (slotsByPool[pool] || 0), 0);
  const requiredCount = mustPlace ? Math.min(sortedPlayers.length, totalSlots) : totalSlots;

  if (!sortedPlayers.length || requiredCount <= 0) {
    return { assignments: [], unassigned: sortedPlayers };
  }

  const initialState = {
    assignments: [],
    skipped: [],
    counts: Object.fromEntries(pools.map((pool) => [pool, 0])),
    thpA: sumPlayers(poolState.teamAStarter) + sumPlayers(poolState.teamASub),
    thpB: sumPlayers(poolState.teamBStarter) + sumPlayers(poolState.teamBSub)
  };

  let beam = [initialState];
  const beamWidth = 96;

  sortedPlayers.forEach((player, index) => {
    const remaining = sortedPlayers.length - index - 1;
    const nextStates = [];

    beam.forEach((entry) => {
      const placedCount = entry.assignments.length;

      pools.forEach((pool) => {
        if (entry.counts[pool] >= (slotsByPool[pool] || 0)) return;
        const nextCounts = { ...entry.counts, [pool]: entry.counts[pool] + 1 };
        nextStates.push({
          assignments: [...entry.assignments, { player, pool }],
          skipped: entry.skipped,
          counts: nextCounts,
          thpA: entry.thpA + (pool.startsWith('teamA') ? Number(player.thp) || 0 : 0),
          thpB: entry.thpB + (pool.startsWith('teamB') ? Number(player.thp) || 0 : 0)
        });
      });

      if (!mustPlace || placedCount + remaining >= requiredCount) {
        nextStates.push({
          assignments: entry.assignments,
          skipped: [...entry.skipped, player],
          counts: entry.counts,
          thpA: entry.thpA,
          thpB: entry.thpB
        });
      }
    });

    beam = nextStates
      .filter((entry) => entry.assignments.length <= requiredCount && entry.assignments.length + remaining >= requiredCount)
      .sort((left, right) => scoreBeamState(left, requiredCount) - scoreBeamState(right, requiredCount))
      .slice(0, beamWidth);
  });

  const bestState = beam
    .filter((entry) => entry.assignments.length === requiredCount)
    .sort((left, right) => scoreBeamState(left, requiredCount) - scoreBeamState(right, requiredCount))[0];

  if (!bestState) return { assignments: [], unassigned: sortedPlayers };

  return { assignments: bestState.assignments, unassigned: bestState.skipped };
}

function scoreBeamState(stateEntry, requiredCount) {
  const diff = Math.abs(stateEntry.thpA - stateEntry.thpB);
  const remainingPenalty = (requiredCount - stateEntry.assignments.length) * 1000000;
  const teamACount = (stateEntry.counts.teamAStarter || 0) + (stateEntry.counts.teamASub || 0);
  const teamBCount = (stateEntry.counts.teamBStarter || 0) + (stateEntry.counts.teamBSub || 0);
  const countPenalty = Math.abs(teamACount - teamBCount);
  return diff + remainingPenalty + countPenalty;
}

function sortPlayers(left, right, sort) {
  switch (sort) {
    case 'thp-desc':
      return right.thp - left.thp;
    case 'thp-asc':
      return left.thp - right.thp;
    case 'rank-asc':
      return rankSortValue(left) - rankSortValue(right) || left.name.localeCompare(right.name);
    case 'rank-desc':
      return rankSortValue(right) - rankSortValue(left) || left.name.localeCompare(right.name);
    default:
      return left.name.localeCompare(right.name);
  }
}

function rankSortValue(player) {
  return Number(player.rankSort) || Number(String(player.rank || player.rankValue || 'R1').replace(/[^0-9]/g, '')) || 1;
}

function normalizePlayer(id, data) {
  return {
    id,
    name: data.name || '',
    rank: data.rank || data.rankValue || data.lastKnownRank || 'R1',
    rankValue: data.rankValue || data.rank || data.lastKnownRank || 'R1',
    rankSort: Number(data.rankSort) || Number(String(data.rank || data.rankValue || data.lastKnownRank || 'R1').replace(/[^0-9]/g, '')) || 1,
    thp: Number(data.thp ?? data.lastKnownThp) || 0,
    createdAt: data.createdAt || null
  };
}

function buildPlayerDirectory() {
  const directory = {};
  [...state.roster, ...state.archived].forEach((player) => {
    directory[player.id] = { ...player };
  });
  state.warzone.events.forEach((event) => {
    Object.entries(event.participations || {}).forEach(([playerId, entry]) => {
      if (!directory[playerId]) {
        directory[playerId] = normalizePlayer(playerId, entry || {});
      }
    });
  });
  return directory;
}

function getWarzoneRosterPlayers() {
  return [...state.roster].sort((left, right) => left.name.localeCompare(right.name));
}

function getWarzonePlayerById(playerId) {
  return getWarzoneRosterPlayers().find((player) => player.id === playerId) || state.roster.find((player) => player.id === playerId) || state.archived.find((player) => player.id === playerId);
}

function cloneParticipations(participations) {
  const clone = {};
  Object.entries(participations || {}).forEach(([playerId, entry]) => {
    clone[playerId] = { ...entry };
  });
  return clone;
}

function upsertWarzoneLocally(eventId, payload) {
  const existingIndex = state.warzone.events.findIndex((entry) => entry.id === eventId);
  const nextEvent = { id: eventId, ...payload };
  if (existingIndex >= 0) {
    state.warzone.events.splice(existingIndex, 1, nextEvent);
  } else {
    state.warzone.events.unshift(nextEvent);
  }
  hydrateWarzoneFromEvent(nextEvent);
  recomputeAttendanceStats();
  renderWarzone();
  renderAttendance();
  renderArchived();
}

function findArchivedPlayerByName(name) {
  const normalized = normalizeName(name);
  return state.archived.find((player) => normalizeName(player.name) === normalized) || null;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function openArchiveMatchModal(player) {
  document.getElementById('archive-match-message').textContent = `This player already exists in the archive. Would you like to restore ${player.name} instead?`;
  document.getElementById('archive-match-modal').classList.remove('hidden');
}

function closeArchiveMatchModal() {
  state.ui.pendingArchivedMatchId = '';
  state.ui.pendingPlayerDraft = null;
  document.getElementById('archive-match-modal').classList.add('hidden');
}

function formatDateLabel(value) {
  if (!value) return 'No date';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateTimeLabel(value) {
  if (!value) return 'Unknown';
  const millis = valueToMillis(value);
  if (!millis) return 'Unknown';
  return new Date(millis).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function valueToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getTodayInputValue() {
  return new Date().toISOString().slice(0, 10);
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

window.editPlayer = editPlayer;
window.archivePlayer = archivePlayer;
window.toggleLock = toggleLock;
window.movePlayer = movePlayer;
window.restoreArchivedPlayer = restoreArchivedPlayer;
window.deleteArchivedPlayerPermanently = deleteArchivedPlayerPermanently;
