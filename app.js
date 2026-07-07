const WARZONE_STATUS = {
  participated: 'participated',
  excused: 'excused',
  missed: 'missed'
};

const PARTICIPATION_STATUS = {
  participated: 'participated',
  late: 'late',
  noShow: 'no-show',
  excused: 'excused',
  leftOut: 'left-out',
  didNotRegister: 'did-not-register'
};

const PARTICIPATION_POINTS = {
  [PARTICIPATION_STATUS.participated]: 2,
  [PARTICIPATION_STATUS.late]: -1,
  [PARTICIPATION_STATUS.noShow]: -2,
  [PARTICIPATION_STATUS.excused]: 0,
  [PARTICIPATION_STATUS.leftOut]: 0,
  [PARTICIPATION_STATUS.didNotRegister]: 0
};

const state = {
  roster: [],
  archived: [],
  desert: { eventDate: '', timeSlot: '18:00', registrations: {} },
  teams: {
    assignments: {},
    generated: false,
    lastSavedAt: '',
    useParticipationTiebreak: false
  },
  warzone: {
    events: [],
    draft: { eventDate: todayInputValue(), opponentServer: '' },
    selectedEventId: '',
    historyOpen: false,
    participations: {}
  },
  desertHistory: {
    events: [],
    selectedEventId: ''
  },
  attendance: {
    stats: {},
    persistedSignature: ''
  },
  participation: {
    stats: {},
    persistedSignature: ''
  },
  history: {
    selectedWarzoneId: ''
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
  renderAll();
  initFirebaseListeners();
}

function initFirebaseListeners() {
  if (!window.db) {
    console.warn('window.db not available; running in offline/local mode.');
    return;
  }

  window.db.onRosterSnapshot((snap) => {
    const players = [];
    snap.forEach((doc) => {
      players.push(normalizePlayer(doc.id, doc.data() || {}));
    });
    state.roster = players;
    syncWarzoneDraftPlayers();
    recomputeAllStats();
    renderAll();
  });

  window.db.onArchivedSnapshot((snap) => {
    const players = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      players.push({
        ...normalizePlayer(doc.id, data),
        archivedAt: data.archivedAt || null,
        lastKnownRank: data.lastKnownRank || data.rankValue || data.rank || 'R1',
        lastKnownThp: Number(data.lastKnownThp ?? data.thp) || 0
      });
    });
    state.archived = players.sort((left, right) => {
      const lv = toMillis(left.archivedAt);
      const rv = toMillis(right.archivedAt);
      return rv - lv || left.name.localeCompare(right.name);
    });
    recomputeAllStats();
    renderArchived();
    renderHistory();
  });

  window.db.onRegistrationsSnapshot((snap) => {
    const registrations = {};
    snap.forEach((doc) => {
      const data = doc.data() || {};
      registrations[doc.id] = {
        requested: Boolean(data.requested),
        guaranteed: Boolean(data.guaranteed)
      };
    });
    state.desert.registrations = registrations;
    renderDesert();
    renderTeams();
  });

  window.db.onDesertMetaSnapshot((doc) => {
    if (!doc.exists) return;
    const data = doc.data() || {};
    state.desert.eventDate = data.eventDate || '';
    state.desert.timeSlot = data.timeSlot || '18:00';
    renderDesert();
  });

  window.db.onTeamsAssignmentsSnapshot((snap) => {
    const assignments = {};
    snap.forEach((doc) => {
      const data = doc.data() || {};
      assignments[doc.id] = {
        pool: data.pool || 'leftOut',
        locked: Boolean(data.locked)
      };
    });
    state.teams.assignments = assignments;
    renderTeams();
  });

  window.db.onTeamsMetaSnapshot((doc) => {
    if (!doc.exists) return;
    const data = doc.data() || {};
    state.teams.generated = Boolean(data.generated);
    state.teams.lastSavedAt = data.lastSavedAt || '';
    state.teams.useParticipationTiebreak = Boolean(data.useParticipationTiebreak);
    const toggle = document.getElementById('use-participation-tiebreak');
    if (toggle) toggle.checked = state.teams.useParticipationTiebreak;
    renderTeams();
  });

  window.db.onWarzonesSnapshot((snap) => {
    const events = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      events.push({
        id: doc.id,
        eventDate: data.eventDate || '',
        opponentServer: data.opponentServer || '',
        participations: data.participations || {},
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
      });
    });

    state.warzone.events = events.sort((left, right) => right.eventDate.localeCompare(left.eventDate));

    if (state.warzone.selectedEventId) {
      const selected = state.warzone.events.find((entry) => entry.id === state.warzone.selectedEventId);
      if (selected) {
        hydrateWarzoneFromEvent(selected);
      } else {
        resetWarzoneDraft();
      }
    }

    if (state.history.selectedWarzoneId && !state.warzone.events.some((entry) => entry.id === state.history.selectedWarzoneId)) {
      state.history.selectedWarzoneId = '';
    }

    recomputeAttendanceStats();
    renderWarzone();
    renderAttendance();
    renderHistory();
    renderArchived();
  });

  window.db.onDesertHistorySnapshot((snap) => {
    const events = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      events.push({
        id: doc.id,
        eventDate: data.eventDate || '',
        eventTime: data.eventTime || '18:00',
        teamA: data.teamA || [],
        teamB: data.teamB || [],
        leftOut: data.leftOut || [],
        teamATHP: Number(data.teamATHP) || 0,
        teamBTHP: Number(data.teamBTHP) || 0,
        thpDifference: Number(data.thpDifference) || 0,
        participationResults: data.participationResults || {},
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
      });
    });

    state.desertHistory.events = events.sort((left, right) => {
      const dc = right.eventDate.localeCompare(left.eventDate);
      if (dc !== 0) return dc;
      return right.eventTime.localeCompare(left.eventTime);
    });

    if (state.desertHistory.selectedEventId && !state.desertHistory.events.some((entry) => entry.id === state.desertHistory.selectedEventId)) {
      state.desertHistory.selectedEventId = '';
    }

    recomputeParticipationStats();
    renderParticipation();
    renderHistory();
    renderTeams();
    renderArchived();
  });
}

function bindNavigation() {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => openView(button.dataset.target));
  });
}

function bindRoster() {
  const form = document.getElementById('roster-form');
  const toggle = document.getElementById('toggle-roster-form');
  const cancel = document.getElementById('cancel-edit');

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

    if (!player.name || Number.isNaN(player.thp)) return;

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

  document.getElementById('roster-search').addEventListener('input', renderRoster);
  document.getElementById('roster-sort').addEventListener('change', renderRoster);
}

function bindDesert() {
  document.getElementById('event-date').addEventListener('change', (event) => {
    state.desert.eventDate = event.target.value;
    if (window.db && window.db.setDesertMeta) {
      window.db.setDesertMeta({ eventDate: state.desert.eventDate }).catch((err) => console.error('set desert date', err));
    }
    renderDesert();
  });

  document.getElementById('event-time').addEventListener('change', (event) => {
    state.desert.timeSlot = event.target.value;
    if (window.db && window.db.setDesertMeta) {
      window.db.setDesertMeta({ timeSlot: state.desert.timeSlot }).catch((err) => console.error('set desert time', err));
    }
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
      window.db.setTeamsMeta({
        lastSavedAt: new Date().toISOString(),
        useParticipationTiebreak: state.teams.useParticipationTiebreak
      }).catch((err) => console.error('set teams meta', err));
    }
    createDesertHistoryFromCurrentTeams();
    renderTeams();
  });

  document.getElementById('use-participation-tiebreak').addEventListener('change', (event) => {
    state.teams.useParticipationTiebreak = Boolean(event.target.checked);
    if (window.db && window.db.setTeamsMeta) {
      window.db.setTeamsMeta({ useParticipationTiebreak: state.teams.useParticipationTiebreak }).catch((err) => console.error('set tiebreak', err));
    }
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
    const draft = state.ui.pendingPlayerDraft;
    closeArchiveMatchModal();
    if (draft) saveRosterPlayer(draft);
  });
  document.getElementById('restore-archived-player').addEventListener('click', () => {
    const archivedId = state.ui.pendingArchivedMatchId;
    closeArchiveMatchModal();
    if (archivedId) restoreArchivedPlayer(archivedId);
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

function renderAll() {
  renderRoster();
  renderDesert();
  renderTeams();
  renderWarzone();
  renderAttendance();
  renderParticipation();
  renderHistory();
  renderArchived();
}

function renderRoster() {
  const list = document.getElementById('roster-list');
  const search = document.getElementById('roster-search').value.toLowerCase();
  const sort = document.getElementById('roster-sort').value;

  const players = [...state.roster]
    .filter((player) => [player.name, player.rank, String(player.thp)].some((value) => value.toLowerCase().includes(search)))
    .sort((left, right) => compareRosterPlayers(left, right, sort));

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">No active players yet. Add the first roster member to begin.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    return `
      <article class="player-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${formatThp(player.thp)}</div>
          </div>
        </div>
        <div class="row-actions">
          <button class="secondary-btn" onclick="editPlayer('${player.id}')">Edit</button>
          <button class="secondary-btn" onclick="archivePlayer('${player.id}')">Remove from Alliance</button>
        </div>
      </article>
    `;
  }).join('');
}

function renderDesert() {
  const list = document.getElementById('desert-list');
  document.getElementById('event-date').value = state.desert.eventDate;
  document.getElementById('event-time').value = state.desert.timeSlot;

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
            <div class="registration-meta"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${formatThp(player.thp)}</div>
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
      current[field] = Boolean(event.target.checked);
      state.desert.registrations[playerId] = current;
      if (window.db && window.db.setRegistration) {
        window.db.setRegistration(playerId, current).catch((err) => console.error('set registration', err));
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
  const toggle = document.getElementById('use-participation-tiebreak');
  if (toggle) toggle.checked = state.teams.useParticipationTiebreak;

  const assignments = state.teams.assignments || {};
  const includedPlayers = getIncludedPlayers();
  const pools = {
    teamAStarter: [],
    teamASub: [],
    teamBStarter: [],
    teamBSub: [],
    leftOut: []
  };

  includedPlayers.forEach((player) => {
    const pool = normalizePool(assignments[player.id]?.pool || 'leftOut');
    if (pools[pool]) pools[pool].push(player);
  });

  const teamATHP = sumPlayers(pools.teamAStarter) + sumPlayers(pools.teamASub);
  const teamBTHP = sumPlayers(pools.teamBStarter) + sumPlayers(pools.teamBSub);
  document.getElementById('team-a-thp').textContent = String(teamATHP);
  document.getElementById('team-b-thp').textContent = String(teamBTHP);
  document.getElementById('thp-diff').textContent = String(Math.abs(teamATHP - teamBTHP));

  if (!includedPlayers.length) {
    const empty = '<div class="list-empty">No eligible players yet. Mark players as requested or guaranteed in Desert Storm.</div>';
    teamAList.innerHTML = empty;
    teamBList.innerHTML = empty;
    leftOutList.innerHTML = empty;
    return;
  }

  renderTeamGroup(teamAList, pools.teamAStarter, pools.teamASub, 'teamA');
  renderTeamGroup(teamBList, pools.teamBStarter, pools.teamBSub, 'teamB');
  renderPool(leftOutList, pools.leftOut, 'leftOut');
}

function renderTeamGroup(container, starters, subs, teamKey) {
  container.innerHTML = `
    <section class="team-group-section">
      <div class="team-meta">Starters (${starters.length}/20)</div>
      ${renderPoolCards(starters, `${teamKey}Starter`) || '<div class="list-empty">No starters assigned.</div>'}
    </section>
    <section class="team-group-section">
      <div class="team-meta">Subs (${subs.length}/10)</div>
      ${renderPoolCards(subs, `${teamKey}Sub`) || '<div class="list-empty">No substitutes assigned.</div>'}
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
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    const score = getParticipationScore(player.id);
    return `
      <article class="team-player-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${formatThp(player.thp)} • ⭐${score}</div>
          </div>
          <div class="chip">${labelForPool(assignment.pool || pool)}</div>
        </div>
        <div class="row-actions">
          <button class="secondary-btn" onclick="toggleLock('${player.id}')">${assignment.locked ? 'Locked' : 'Unlock'}</button>
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
  document.getElementById('warzone-status-note').textContent = state.warzone.selectedEventId
    ? 'Editing a saved Warzone. Participation and field changes autosave.'
    : 'Set participation for each active player, then save the event.';
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
  const players = [...state.roster].sort((left, right) => left.name.localeCompare(right.name));

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">Add active players to the Alliance Roster before recording a Warzone.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    const status = normalizeWarzoneStatus(state.warzone.participations[player.id]?.status);
    return `
      <article class="player-card warzone-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${formatThp(player.thp)}</div>
          </div>
        </div>
        <div class="warzone-status-group" role="radiogroup" aria-label="${escapeHtml(player.name)} participation status">
          ${warzoneOption(player.id, status, WARZONE_STATUS.participated, 'Participated')}
          ${warzoneOption(player.id, status, WARZONE_STATUS.excused, 'Excused')}
          ${warzoneOption(player.id, status, WARZONE_STATUS.missed, 'Did Not Participate')}
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const playerId = event.target.dataset.playerId;
      const player = state.roster.find((entry) => entry.id === playerId);
      if (!player) return;

      state.warzone.participations[playerId] = {
        status: normalizeWarzoneStatus(event.target.value),
        name: player.name,
        rank: player.rankValue || player.rank || 'R1',
        thp: Number(player.thp) || 0
      };

      if (state.warzone.selectedEventId) persistSelectedWarzone();
      renderWarzonePlayers();
      renderAttendance();
      renderHistory();
    });
  });
}

function warzoneOption(playerId, currentStatus, optionValue, label) {
  const checked = currentStatus === optionValue ? 'checked' : '';
  const inputId = `warzone-${playerId}-${optionValue}`;
  return `
    <label class="radio-pill ${checked ? 'selected' : ''}" for="${inputId}">
      <input id="${inputId}" type="radio" name="warzone-status-${playerId}" data-player-id="${playerId}" value="${optionValue}" ${checked} />
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
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    return `
      <article class="player-card attendance-card ${attendanceBorderClass(stats.attendancePercent)}">
        <div class="attendance-card-header">
          <div class="player-name">${escapeHtml(player.name)}</div>
          <div class="attendance-percent">${formatAttendancePercent(stats.attendancePercent)}</div>
        </div>
        <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${formatThp(player.thp)}</div>
        <div class="attendance-history">${escapeHtml(formatAttendanceHistory(stats))}</div>
      </article>
    `;
  }).join('');
}

function renderAttendanceSummary() {
  const container = document.getElementById('attendance-summary');
  const activeStats = state.roster.map((player) => state.attendance.stats[player.id] || emptyAttendanceStat(player));
  const valid = activeStats.filter((entry) => typeof entry.attendancePercent === 'number');
  const average = valid.length ? valid.reduce((sum, entry) => sum + entry.attendancePercent, 0) / valid.length : null;
  const above90 = valid.filter((entry) => entry.attendancePercent >= 90).length;
  const below75 = valid.filter((entry) => entry.attendancePercent < 75).length;

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

function renderParticipation() {
  const list = document.getElementById('participation-list');
  if (!state.roster.length) {
    list.innerHTML = '<div class="list-empty">No active players available for participation statistics.</div>';
    return;
  }

  const players = [...state.roster].sort((left, right) => left.name.localeCompare(right.name));
  list.innerHTML = players.map((player) => {
    const stats = state.participation.stats[player.id] || emptyParticipationStat(player);
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    return `
      <article class="player-card participation-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${formatThp(player.thp)} • ⭐${stats.score}</div>
          </div>
        </div>
        <div class="participation-breakdown">
          <div>Participated: ${stats.participated}</div>
          <div>Late: ${stats.late}</div>
          <div>No Shows: ${stats.noShow}</div>
          <div>Excused: ${stats.excused}</div>
          <div>Left Out: ${stats.leftOut}</div>
        </div>
      </article>
    `;
  }).join('');
}

function renderHistory() {
  renderDesertHistoryList();
  renderWarzoneHistoryList();
  renderDesertHistoryDetail();
  renderWarzoneHistoryDetail();
}

function renderDesertHistoryList() {
  const list = document.getElementById('history-desert-list');
  if (!state.desertHistory.events.length) {
    list.innerHTML = '<div class="list-empty">No Desert Storm history yet. Save teams after event completion.</div>';
    return;
  }

  list.innerHTML = state.desertHistory.events.map((event) => `
    <button class="history-entry ${event.id === state.desertHistory.selectedEventId ? 'selected' : ''}" data-event-id="${event.id}">
      <span>${escapeHtml(formatDateLabel(event.eventDate))} • ${escapeHtml(event.eventTime)}</span>
      <span>Diff ${Math.abs(Number(event.thpDifference) || 0)}</span>
    </button>
  `).join('');

  list.querySelectorAll('.history-entry').forEach((button) => {
    button.addEventListener('click', () => {
      state.desertHistory.selectedEventId = button.dataset.eventId;
      renderHistory();
    });
  });
}

function renderWarzoneHistoryList() {
  const list = document.getElementById('history-warzone-list');
  if (!state.warzone.events.length) {
    list.innerHTML = '<div class="list-empty">No Warzone events have been saved yet.</div>';
    return;
  }

  list.innerHTML = state.warzone.events.map((event) => `
    <button class="history-entry ${event.id === state.history.selectedWarzoneId ? 'selected' : ''}" data-event-id="${event.id}">
      <span>${escapeHtml(formatDateLabel(event.eventDate))}</span>
      <span>${escapeHtml(event.opponentServer || 'Unknown Opponent')}</span>
    </button>
  `).join('');

  list.querySelectorAll('.history-entry').forEach((button) => {
    button.addEventListener('click', () => {
      state.history.selectedWarzoneId = button.dataset.eventId;
      renderHistory();
    });
  });
}

function renderDesertHistoryDetail() {
  const detail = document.getElementById('history-desert-detail');
  const meta = document.getElementById('history-desert-meta');
  const event = state.desertHistory.events.find((entry) => entry.id === state.desertHistory.selectedEventId);

  if (!event) {
    meta.textContent = 'Select a Desert Storm event to view full details.';
    detail.innerHTML = '<div class="list-empty">No Desert Storm event selected.</div>';
    return;
  }

  const leftOutNames = (event.leftOut || []).map((entry) => entry.name).join(', ') || 'None';
  meta.textContent = `${formatDateLabel(event.eventDate)} • ${event.eventTime} • Team A THP ${event.teamATHP} • Team B THP ${event.teamBTHP} • Diff ${event.thpDifference}`;

  const rows = Object.entries(event.participationResults || {})
    .map(([playerId, entry]) => ({
      playerId,
      name: entry.name || playerId,
      status: normalizeParticipationStatus(entry.status)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  detail.innerHTML = `
    <div class="history-detail-head"><strong>Left Out Players:</strong> ${escapeHtml(leftOutNames)}</div>
    <div class="stack">
      ${rows.map((row) => desertHistoryRow(event.id, row)).join('')}
    </div>
  `;

  detail.querySelectorAll('select[data-player-id]').forEach((select) => {
    select.addEventListener('change', (eventTarget) => {
      updateDesertHistoryParticipation(event.id, eventTarget.target.dataset.playerId, eventTarget.target.value);
    });
  });
}

function desertHistoryRow(eventId, row) {
  const points = PARTICIPATION_POINTS[row.status] || 0;
  const statuses = [
    PARTICIPATION_STATUS.participated,
    PARTICIPATION_STATUS.late,
    PARTICIPATION_STATUS.noShow,
    PARTICIPATION_STATUS.excused,
    PARTICIPATION_STATUS.leftOut,
    PARTICIPATION_STATUS.didNotRegister
  ];
  return `
    <article class="player-card history-player-row">
      <div class="player-top">
        <div class="player-name">${escapeHtml(row.name)}</div>
        <div class="chip">${points > 0 ? `+${points}` : points}</div>
      </div>
      <div class="history-edit-row">
        <select data-player-id="${row.playerId}" data-event-id="${eventId}">
          ${statuses.map((status) => `<option value="${status}" ${status === row.status ? 'selected' : ''}>${participationLabel(status)}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function renderWarzoneHistoryDetail() {
  const detail = document.getElementById('history-warzone-detail');
  const meta = document.getElementById('history-warzone-meta');
  const event = state.warzone.events.find((entry) => entry.id === state.history.selectedWarzoneId);

  if (!event) {
    meta.textContent = 'Select a Warzone event to view full details.';
    detail.innerHTML = '<div class="list-empty">No Warzone event selected.</div>';
    return;
  }

  meta.textContent = `${formatDateLabel(event.eventDate)} • ${event.opponentServer || 'Unknown Opponent'}`;

  const rows = Object.entries(event.participations || {})
    .map(([playerId, entry]) => ({
      playerId,
      name: entry.name || playerId,
      rank: entry.rank || 'R1',
      thp: Number(entry.thp) || 0,
      status: normalizeWarzoneStatus(entry.status)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (!rows.length) {
    detail.innerHTML = '<div class="list-empty">No participation records saved for this event.</div>';
    return;
  }

  detail.innerHTML = rows.map((row) => `
    <article class="player-card history-player-row">
      <div class="player-top">
        <div>
          <div class="player-name">${escapeHtml(row.name)}</div>
          <div class="player-meta">${escapeHtml(row.rank)} • THP ${formatThp(row.thp)}</div>
        </div>
      </div>
      <div class="history-edit-row">
        ${historyWarzoneOption(event.id, row.playerId, row.status, WARZONE_STATUS.participated, 'Participated')}
        ${historyWarzoneOption(event.id, row.playerId, row.status, WARZONE_STATUS.excused, 'Excused')}
        ${historyWarzoneOption(event.id, row.playerId, row.status, WARZONE_STATUS.missed, 'Did Not Participate')}
      </div>
    </article>
  `).join('');

  detail.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.addEventListener('change', (eventTarget) => {
      updateWarzoneHistoryStatus(
        eventTarget.target.dataset.eventId,
        eventTarget.target.dataset.playerId,
        eventTarget.target.value
      );
    });
  });
}

function historyWarzoneOption(eventId, playerId, currentStatus, optionValue, label) {
  const inputId = `history-warzone-${eventId}-${playerId}-${optionValue}`;
  const checked = currentStatus === optionValue ? 'checked' : '';
  return `
    <label class="radio-pill ${checked ? 'selected' : ''}" for="${inputId}">
      <input id="${inputId}" type="radio" name="history-warzone-${eventId}-${playerId}" data-event-id="${eventId}" data-player-id="${playerId}" value="${optionValue}" ${checked} />
      <span>${label}</span>
    </label>
  `;
}

function renderArchived() {
  const list = document.getElementById('archived-list');
  if (!state.archived.length) {
    list.innerHTML = '<div class="list-empty">No archived players yet.</div>';
    return;
  }

  const players = [...state.archived].sort((left, right) => left.name.localeCompare(right.name));
  list.innerHTML = players.map((player) => {
    const attendance = state.attendance.stats[player.id] || emptyAttendanceStat(player);
    const participation = state.participation.stats[player.id] || emptyParticipationStat(player);
    const rankLabel = escapeHtml(player.lastKnownRank || player.rank || player.rankValue || 'R1');
    return `
      <article class="player-card archived-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge rank-${rankLabel}">${rankLabel}</span> • THP ${formatThp(player.lastKnownThp ?? player.thp)}</div>
          </div>
          <div class="archived-meta">⭐${participation.score}</div>
        </div>
        <div class="archived-details">
          <div>Archived Date: ${escapeHtml(formatDateTimeLabel(player.archivedAt))}</div>
          <div>Warzone Attendance: ${escapeHtml(formatAttendancePercent(attendance.attendancePercent))}</div>
          <div>Participation Score: ⭐${participation.score}</div>
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
    window.db.upsertPlayer(player).then(resetRosterForm).catch((err) => console.error('save player', err));
    return;
  }

  const existingId = document.getElementById('player-id').value;
  if (existingId) {
    state.roster = state.roster.map((entry) => (entry.id === existingId ? player : entry));
  } else {
    state.roster.push(player);
  }

  resetRosterForm();
  syncWarzoneDraftPlayers();
  recomputeAllStats();
  renderAll();
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

function toggleLock(playerId) {
  const current = state.teams.assignments[playerId] || { pool: 'leftOut', locked: false };
  const updated = { ...current, locked: !current.locked };
  state.teams.assignments[playerId] = updated;

  if (window.db && window.db.setTeamAssignment) {
    window.db.setTeamAssignment(playerId, updated).catch((err) => console.error('set lock', err));
  }

  renderTeams();
}

function movePlayer(playerId) {
  const current = state.teams.assignments[playerId] || { pool: 'leftOut', locked: false };
  const updated = { ...current, pool: getNextPool(current.pool || 'leftOut') };
  state.teams.assignments[playerId] = updated;

  if (window.db && window.db.setTeamAssignment) {
    window.db.setTeamAssignment(playerId, updated).catch((err) => console.error('move player', err));
  }

  renderTeams();
}

function archivePlayer(playerId) {
  const player = state.roster.find((entry) => entry.id === playerId);
  if (!player) return;

  const attendance = state.attendance.stats[playerId] || emptyAttendanceStat(player);
  const participation = state.participation.stats[playerId] || emptyParticipationStat(player);

  if (window.db && window.db.archivePlayer) {
    window.db.archivePlayer(player, {
      ...attendance,
      participationScore: participation.score
    }).catch((err) => console.error('archive player', err));
    return;
  }

  state.roster = state.roster.filter((entry) => entry.id !== playerId);
  state.archived.push({
    ...player,
    archivedAt: new Date().toISOString(),
    lastKnownRank: player.rankValue || player.rank || 'R1',
    lastKnownThp: Number(player.thp) || 0
  });
  delete state.desert.registrations[playerId];
  delete state.teams.assignments[playerId];
  delete state.warzone.participations[playerId];
  syncWarzoneDraftPlayers();
  recomputeAllStats();
  renderAll();
}

function restoreArchivedPlayer(playerId) {
  if (window.db && window.db.restorePlayer) {
    window.db.restorePlayer(playerId).catch((err) => console.error('restore player', err));
    return;
  }

  const player = state.archived.find((entry) => entry.id === playerId);
  if (!player) return;
  state.archived = state.archived.filter((entry) => entry.id !== playerId);
  state.roster.push(normalizePlayer(player.id, player));
  syncWarzoneDraftPlayers();
  recomputeAllStats();
  renderAll();
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
    const next = { ...event.participations };
    delete next[playerId];
    return { ...event, participations: next };
  });
  state.desertHistory.events = state.desertHistory.events.map((event) => {
    if (!event.participationResults || !event.participationResults[playerId]) return event;
    const next = { ...event.participationResults };
    delete next[playerId];
    return { ...event, participationResults: next };
  });

  recomputeAllStats();
  renderAll();
}

function saveWarzone() {
  const eventDate = state.warzone.draft.eventDate;
  const opponentServer = state.warzone.draft.opponentServer.trim();
  if (!eventDate || !opponentServer) return;

  const participationMap = { ...state.warzone.participations };
  state.roster.forEach((player) => {
    if (!participationMap[player.id]) {
      participationMap[player.id] = {
        status: WARZONE_STATUS.missed,
        name: player.name,
        rank: player.rankValue || player.rank || 'R1',
        thp: Number(player.thp) || 0
      };
    }
  });

  state.warzone.participations = participationMap;
  const eventId = state.warzone.selectedEventId || crypto.randomUUID();
  const payload = {
    eventDate,
    opponentServer,
    participations: participationMap
  };

  if (!state.warzone.selectedEventId && window.db && window.db.serverTimestamp) {
    payload.createdAt = window.db.serverTimestamp();
  }

  if (window.db && window.db.upsertWarzoneEvent) {
    window.db.upsertWarzoneEvent(eventId, payload)
      .then(() => {
        state.warzone.selectedEventId = eventId;
        state.history.selectedWarzoneId = eventId;
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
  }).catch((err) => console.error('persist warzone', err));
}

function createDesertHistoryFromCurrentTeams() {
  if (!state.desert.eventDate || !state.desert.timeSlot) return;

  const includedPlayers = getIncludedPlayers();
  if (!includedPlayers.length) return;

  const byPool = {
    teamAStarter: [],
    teamASub: [],
    teamBStarter: [],
    teamBSub: [],
    leftOut: []
  };

  includedPlayers.forEach((player) => {
    const pool = normalizePool(state.teams.assignments[player.id]?.pool || 'leftOut');
    byPool[pool].push(player);
  });

  const teamA = [...byPool.teamAStarter, ...byPool.teamASub].map(toHistoryPlayer);
  const teamB = [...byPool.teamBStarter, ...byPool.teamBSub].map(toHistoryPlayer);
  const leftOut = [...byPool.leftOut].map(toHistoryPlayer);

  const participationResults = {};
  state.roster.forEach((player) => {
    const registration = state.desert.registrations[player.id] || { requested: false };
    let status = PARTICIPATION_STATUS.didNotRegister;
    if (registration.requested) {
      const pool = normalizePool(state.teams.assignments[player.id]?.pool || 'leftOut');
      status = pool === 'leftOut' ? PARTICIPATION_STATUS.leftOut : PARTICIPATION_STATUS.participated;
    }

    participationResults[player.id] = {
      playerId: player.id,
      name: player.name,
      rank: player.rankValue || player.rank || 'R1',
      thp: Number(player.thp) || 0,
      status,
      points: PARTICIPATION_POINTS[status] || 0
    };
  });

  const teamATHP = sumPlayers(teamA);
  const teamBTHP = sumPlayers(teamB);
  const payload = {
    eventDate: state.desert.eventDate,
    eventTime: state.desert.timeSlot,
    teamA,
    teamB,
    leftOut,
    teamATHP,
    teamBTHP,
    thpDifference: Math.abs(teamATHP - teamBTHP),
    participationResults
  };

  if (window.db && window.db.createDesertHistoryEvent) {
    window.db.createDesertHistoryEvent(payload)
      .then(() => {
        openView('history-view');
      })
      .catch((err) => console.error('create desert history', err));
    return;
  }

  const localEvent = {
    ...payload,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.desertHistory.events.unshift(localEvent);
  state.desertHistory.selectedEventId = localEvent.id;
  recomputeParticipationStats();
  renderParticipation();
  renderHistory();
}

function updateDesertHistoryParticipation(eventId, playerId, statusValue) {
  const status = normalizeParticipationStatus(statusValue);
  const event = state.desertHistory.events.find((entry) => entry.id === eventId);
  if (!event || !event.participationResults[playerId]) return;

  const updatedResults = {
    ...event.participationResults,
    [playerId]: {
      ...event.participationResults[playerId],
      status,
      points: PARTICIPATION_POINTS[status] || 0
    }
  };

  if (window.db && window.db.updateDesertHistoryEvent) {
    window.db.updateDesertHistoryEvent(eventId, { participationResults: updatedResults }).catch((err) => console.error('update desert history', err));
    return;
  }

  event.participationResults = updatedResults;
  recomputeParticipationStats();
  renderParticipation();
  renderHistory();
  renderTeams();
  renderArchived();
}

function updateWarzoneHistoryStatus(eventId, playerId, statusValue) {
  const status = normalizeWarzoneStatus(statusValue);
  const event = state.warzone.events.find((entry) => entry.id === eventId);
  if (!event || !event.participations[playerId]) return;

  const updated = {
    ...event.participations,
    [playerId]: {
      ...event.participations[playerId],
      status
    }
  };

  if (window.db && window.db.upsertWarzoneEvent) {
    window.db.upsertWarzoneEvent(eventId, {
      eventDate: event.eventDate,
      opponentServer: event.opponentServer,
      participations: updated
    }).catch((err) => console.error('update warzone history', err));
    return;
  }

  event.participations = updated;
  if (state.warzone.selectedEventId === eventId) {
    state.warzone.participations = cloneObject(updated);
  }
  recomputeAttendanceStats();
  renderWarzone();
  renderAttendance();
  renderHistory();
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

  eligiblePlayers.forEach((player) => {
    const existing = assignments[player.id];
    if (existing?.locked) {
      const pool = normalizePool(existing.pool);
      poolState[pool].push(player);
    }
  });

  const available = eligiblePlayers.filter((player) => !assignments[player.id]?.locked);
  const guaranteed = available.filter((player) => state.desert.registrations[player.id]?.guaranteed);
  const leaders = available.filter((player) => !state.desert.registrations[player.id]?.guaranteed && isLeader(player));
  const others = available.filter((player) => !state.desert.registrations[player.id]?.guaranteed && !isLeader(player));

  const starterSlots = getOpenSlots(poolState, ['teamAStarter', 'teamBStarter'], 20);
  const subSlots = getOpenSlots(poolState, ['teamASub', 'teamBSub'], 10);

  const guaranteedStarter = assignBalancedGroup(guaranteed, poolState, ['teamAStarter', 'teamBStarter'], starterSlots, true);
  placePlayers(poolState, guaranteedStarter.assignments);

  const leaderStarter = assignBalancedGroup(leaders, poolState, ['teamAStarter', 'teamBStarter'], getOpenSlots(poolState, ['teamAStarter', 'teamBStarter'], 20), true);
  placePlayers(poolState, leaderStarter.assignments);

  const otherStarter = assignBalancedGroup(others, poolState, ['teamAStarter', 'teamBStarter'], getOpenSlots(poolState, ['teamAStarter', 'teamBStarter'], 20), false);
  placePlayers(poolState, otherStarter.assignments);

  const remaining = [...guaranteedStarter.unassigned, ...leaderStarter.unassigned, ...otherStarter.unassigned];
  const guaranteedSub = remaining.filter((player) => state.desert.registrations[player.id]?.guaranteed);
  const leaderSub = remaining.filter((player) => !state.desert.registrations[player.id]?.guaranteed && isLeader(player));
  const otherSub = remaining.filter((player) => !state.desert.registrations[player.id]?.guaranteed && !isLeader(player));

  const guaranteedSubResult = assignBalancedGroup(guaranteedSub, poolState, ['teamASub', 'teamBSub'], subSlots, true);
  placePlayers(poolState, guaranteedSubResult.assignments);

  const leaderSubResult = assignBalancedGroup(leaderSub, poolState, ['teamASub', 'teamBSub'], getOpenSlots(poolState, ['teamASub', 'teamBSub'], 10), true);
  placePlayers(poolState, leaderSubResult.assignments);

  const otherSubResult = assignBalancedGroup(otherSub, poolState, ['teamASub', 'teamBSub'], getOpenSlots(poolState, ['teamASub', 'teamBSub'], 10), false);
  placePlayers(poolState, otherSubResult.assignments);

  [...guaranteedSubResult.unassigned, ...leaderSubResult.unassigned, ...otherSubResult.unassigned].forEach((player) => {
    poolState.leftOut.push(player);
  });

  const nextAssignments = {};
  const ordered = [
    ...poolState.teamAStarter,
    ...poolState.teamASub,
    ...poolState.teamBStarter,
    ...poolState.teamBSub,
    ...poolState.leftOut
  ];

  ordered.forEach((player) => {
    const previous = assignments[player.id];
    nextAssignments[player.id] = {
      pool: resolvePoolForPlayer(player.id, poolState),
      locked: Boolean(previous?.locked)
    };
  });

  ordered.forEach((player) => {
    const registration = state.desert.registrations[player.id] || { requested: false, guaranteed: false };
    if (resolvePoolForPlayer(player.id, poolState) === 'leftOut') {
      registration.guaranteed = true;
      state.desert.registrations[player.id] = registration;
    }
  });

  state.teams.assignments = nextAssignments;
  state.teams.generated = true;

  if (window.db && window.db.batchAssignments) {
    window.db.batchAssignments(nextAssignments, {
      generated: true,
      lastSavedAt: new Date().toISOString(),
      useParticipationTiebreak: state.teams.useParticipationTiebreak
    }).catch((err) => console.error('batch assignments', err));
  }

  Object.entries(state.desert.registrations).forEach(([playerId, registration]) => {
    if (registration.guaranteed && window.db && window.db.setRegistration) {
      window.db.setRegistration(playerId, registration).catch((err) => console.error('set registration', err));
    }
  });
}

function assignBalancedGroup(players, poolState, pools, slotsByPool, mustPlace) {
  const sorted = [...players].sort((left, right) => {
    const thpDiff = (Number(right.thp) || 0) - (Number(left.thp) || 0);
    if (thpDiff !== 0) return thpDiff;
    if (state.teams.useParticipationTiebreak) {
      const scoreDiff = getParticipationScore(right.id) - getParticipationScore(left.id);
      if (scoreDiff !== 0) return scoreDiff;
    }
    return left.name.localeCompare(right.name);
  });

  const totalSlots = pools.reduce((sum, pool) => sum + (slotsByPool[pool] || 0), 0);
  const required = mustPlace ? Math.min(sorted.length, totalSlots) : totalSlots;

  if (!sorted.length || required <= 0) {
    return { assignments: [], unassigned: sorted };
  }

  const initState = {
    assignments: [],
    skipped: [],
    counts: Object.fromEntries(pools.map((pool) => [pool, 0])),
    thpA: sumPlayers(poolState.teamAStarter) + sumPlayers(poolState.teamASub),
    thpB: sumPlayers(poolState.teamBStarter) + sumPlayers(poolState.teamBSub),
    scoreA: sumParticipation(poolState.teamAStarter) + sumParticipation(poolState.teamASub),
    scoreB: sumParticipation(poolState.teamBStarter) + sumParticipation(poolState.teamBSub)
  };

  let beam = [initState];
  const width = 96;

  sorted.forEach((player, index) => {
    const remaining = sorted.length - index - 1;
    const nextStates = [];

    beam.forEach((entry) => {
      const placed = entry.assignments.length;

      pools.forEach((pool) => {
        if (entry.counts[pool] >= (slotsByPool[pool] || 0)) return;
        const score = getParticipationScore(player.id);
        nextStates.push({
          assignments: [...entry.assignments, { player, pool }],
          skipped: entry.skipped,
          counts: { ...entry.counts, [pool]: entry.counts[pool] + 1 },
          thpA: entry.thpA + (pool.startsWith('teamA') ? Number(player.thp) || 0 : 0),
          thpB: entry.thpB + (pool.startsWith('teamB') ? Number(player.thp) || 0 : 0),
          scoreA: entry.scoreA + (pool.startsWith('teamA') ? score : 0),
          scoreB: entry.scoreB + (pool.startsWith('teamB') ? score : 0)
        });
      });

      if (!mustPlace || placed + remaining >= required) {
        nextStates.push({
          assignments: entry.assignments,
          skipped: [...entry.skipped, player],
          counts: entry.counts,
          thpA: entry.thpA,
          thpB: entry.thpB,
          scoreA: entry.scoreA,
          scoreB: entry.scoreB
        });
      }
    });

    beam = nextStates
      .filter((entry) => entry.assignments.length <= required && entry.assignments.length + remaining >= required)
      .sort((left, right) => beamScore(left, required) - beamScore(right, required))
      .slice(0, width);
  });

  const best = beam
    .filter((entry) => entry.assignments.length === required)
    .sort((left, right) => beamScore(left, required) - beamScore(right, required))[0];

  if (!best) {
    return { assignments: [], unassigned: sorted };
  }

  return { assignments: best.assignments, unassigned: best.skipped };
}

function beamScore(entry, required) {
  const thpDiff = Math.abs(entry.thpA - entry.thpB);
  const missingPenalty = (required - entry.assignments.length) * 1000000;
  const countA = (entry.counts.teamAStarter || 0) + (entry.counts.teamASub || 0);
  const countB = (entry.counts.teamBStarter || 0) + (entry.counts.teamBSub || 0);
  const countPenalty = Math.abs(countA - countB);

  if (!state.teams.useParticipationTiebreak) {
    return thpDiff + missingPenalty + countPenalty;
  }

  const scoreDiff = Math.abs(entry.scoreA - entry.scoreB);
  return thpDiff + missingPenalty + countPenalty + scoreDiff * 0.0001;
}

function resolvePoolForPlayer(playerId, poolState) {
  if (poolState.teamAStarter.some((entry) => entry.id === playerId)) return 'teamAStarter';
  if (poolState.teamASub.some((entry) => entry.id === playerId)) return 'teamASub';
  if (poolState.teamBStarter.some((entry) => entry.id === playerId)) return 'teamBStarter';
  if (poolState.teamBSub.some((entry) => entry.id === playerId)) return 'teamBSub';
  return 'leftOut';
}

function getIncludedPlayers() {
  const ids = new Set();
  Object.entries(state.desert.registrations).forEach(([playerId, registration]) => {
    if (registration.requested) ids.add(playerId);
  });
  return state.roster.filter((player) => ids.has(player.id));
}

function toHistoryPlayer(player) {
  return {
    playerId: player.id,
    name: player.name,
    rank: player.rankValue || player.rank || 'R1',
    thp: Number(player.thp) || 0
  };
}

function updateDesertHistoryParticipationLocal(eventId, playerId, status) {
  const event = state.desertHistory.events.find((entry) => entry.id === eventId);
  if (!event || !event.participationResults[playerId]) return;
  event.participationResults[playerId] = {
    ...event.participationResults[playerId],
    status,
    points: PARTICIPATION_POINTS[status] || 0
  };
  recomputeParticipationStats();
  renderParticipation();
  renderHistory();
  renderTeams();
  renderArchived();
}

function updateWarzoneHistoryStatusLocal(eventId, playerId, status) {
  const event = state.warzone.events.find((entry) => entry.id === eventId);
  if (!event || !event.participations[playerId]) return;
  event.participations[playerId] = {
    ...event.participations[playerId],
    status
  };
  recomputeAttendanceStats();
  renderWarzone();
  renderAttendance();
  renderHistory();
}

function recomputeAllStats() {
  recomputeAttendanceStats();
  recomputeParticipationStats();
}

function recomputeAttendanceStats() {
  const directory = buildPlayerDirectory();
  const stats = {};

  Object.values(directory).forEach((player) => {
    stats[player.id] = emptyAttendanceStat(player);
  });

  state.warzone.events.forEach((event) => {
    Object.entries(event.participations || {}).forEach(([playerId, entry]) => {
      if (!stats[playerId]) {
        stats[playerId] = emptyAttendanceStat(normalizePlayer(playerId, entry || {}));
      }
      const stat = stats[playerId];
      stat.playerId = playerId;
      stat.name = entry.name || stat.name;
      stat.rank = entry.rank || stat.rank;
      stat.thp = Number(entry.thp ?? stat.thp) || 0;
      stat.recordedWarzones += 1;

      const status = normalizeWarzoneStatus(entry.status);
      if (status === WARZONE_STATUS.participated) stat.participated += 1;
      if (status === WARZONE_STATUS.excused) stat.excused += 1;
      if (status === WARZONE_STATUS.missed) stat.missed += 1;

      stat.eligibleWarzones = Math.max(0, stat.recordedWarzones - stat.excused);
      stat.attendancePercent = stat.eligibleWarzones > 0 ? (stat.participated / stat.eligibleWarzones) * 100 : null;
    });
  });

  state.attendance.stats = stats;
  persistAttendanceStats(stats);
}

function recomputeParticipationStats() {
  const stats = {};

  [...state.roster, ...state.archived].forEach((player) => {
    stats[player.id] = emptyParticipationStat(player);
  });

  state.desertHistory.events.forEach((event) => {
    Object.entries(event.participationResults || {}).forEach(([playerId, entry]) => {
      if (!stats[playerId]) {
        stats[playerId] = emptyParticipationStat(normalizePlayer(playerId, entry || {}));
      }
      const stat = stats[playerId];
      const status = normalizeParticipationStatus(entry.status);
      stat.name = entry.name || stat.name;
      stat.rank = entry.rank || stat.rank;
      stat.thp = Number(entry.thp ?? stat.thp) || 0;
      stat.totalEvents += 1;
      stat.score += PARTICIPATION_POINTS[status] || 0;

      if (status === PARTICIPATION_STATUS.participated) stat.participated += 1;
      if (status === PARTICIPATION_STATUS.late) stat.late += 1;
      if (status === PARTICIPATION_STATUS.noShow) stat.noShow += 1;
      if (status === PARTICIPATION_STATUS.excused) stat.excused += 1;
      if (status === PARTICIPATION_STATUS.leftOut) stat.leftOut += 1;
      if (status === PARTICIPATION_STATUS.didNotRegister) stat.didNotRegister += 1;
    });
  });

  state.participation.stats = stats;
  persistParticipationStats(stats);
}

function persistAttendanceStats(stats) {
  const payload = {};
  Object.entries(stats).forEach(([playerId, stat]) => {
    payload[playerId] = {
      playerId,
      name: stat.name,
      rank: stat.rank,
      thp: stat.thp,
      participated: stat.participated,
      excused: stat.excused,
      missed: stat.missed,
      recordedWarzones: stat.recordedWarzones,
      eligibleWarzones: stat.eligibleWarzones,
      attendancePercent: stat.attendancePercent
    };
  });

  const signature = JSON.stringify(payload);
  if (signature === state.attendance.persistedSignature) return;
  state.attendance.persistedSignature = signature;

  if (window.db && window.db.setAttendanceStats) {
    window.db.setAttendanceStats(payload).catch((err) => console.error('persist attendance', err));
  }
}

function persistParticipationStats(stats) {
  const payload = {};
  Object.entries(stats).forEach(([playerId, stat]) => {
    payload[playerId] = {
      playerId,
      name: stat.name,
      rank: stat.rank,
      thp: stat.thp,
      score: stat.score,
      participated: stat.participated,
      late: stat.late,
      noShow: stat.noShow,
      excused: stat.excused,
      leftOut: stat.leftOut,
      didNotRegister: stat.didNotRegister,
      totalEvents: stat.totalEvents
    };
  });

  const signature = JSON.stringify(payload);
  if (signature === state.participation.persistedSignature) return;
  state.participation.persistedSignature = signature;

  if (window.db && window.db.setParticipationStats) {
    window.db.setParticipationStats(payload).catch((err) => console.error('persist participation', err));
  }
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

  state.desertHistory.events.forEach((event) => {
    Object.entries(event.participationResults || {}).forEach(([playerId, entry]) => {
      if (!directory[playerId]) {
        directory[playerId] = normalizePlayer(playerId, entry || {});
      }
    });
  });

  return directory;
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

function compareRosterPlayers(left, right, sort) {
  switch (sort) {
    case 'thp-desc':
      return right.thp - left.thp;
    case 'thp-asc':
      return left.thp - right.thp;
    case 'rank-asc':
      return rankSort(left) - rankSort(right) || left.name.localeCompare(right.name);
    case 'rank-desc':
      return rankSort(right) - rankSort(left) || left.name.localeCompare(right.name);
    default:
      return left.name.localeCompare(right.name);
  }
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

function rankSort(player) {
  return Number(player.rankSort) || Number(String(player.rank || player.rankValue || 'R1').replace(/[^0-9]/g, '')) || 1;
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

function emptyParticipationStat(player) {
  return {
    playerId: player.id,
    name: player.name || '',
    rank: player.rankValue || player.rank || player.lastKnownRank || 'R1',
    thp: Number(player.thp ?? player.lastKnownThp) || 0,
    score: 0,
    participated: 0,
    late: 0,
    noShow: 0,
    excused: 0,
    leftOut: 0,
    didNotRegister: 0,
    totalEvents: 0
  };
}

function attendanceBorderClass(percent) {
  if (typeof percent !== 'number') return 'attendance-gray';
  if (percent >= 90) return 'attendance-green';
  if (percent >= 75) return 'attendance-yellow';
  if (percent >= 50) return 'attendance-orange';
  return 'attendance-red';
}

function formatAttendancePercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--';
  return `${value.toFixed(1)}%`;
}

function formatAttendanceHistory(stats) {
  if (!stats.recordedWarzones) return 'No attendance history';
  return `${stats.participated} / ${stats.eligibleWarzones} Warzones`;
}

function formatThp(value) {
  const number = Number(value) || 0;
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(1);
}

function formatDateLabel(value) {
  if (!value) return 'No date';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateTimeLabel(value) {
  if (!value) return 'Unknown';
  const millis = toMillis(value);
  if (!millis) return 'Unknown';
  return new Date(millis).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function getParticipationScore(playerId) {
  return Number(state.participation.stats[playerId]?.score) || 0;
}

function sumParticipation(players) {
  return players.reduce((sum, player) => sum + getParticipationScore(player.id), 0);
}

function findArchivedPlayerByName(name) {
  const normalized = normalizeName(name);
  return state.archived.find((player) => normalizeName(player.name) === normalized) || null;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePool(pool) {
  const map = {
    teamA: 'teamAStarter',
    teamAStarter: 'teamAStarter',
    teamASub: 'teamASub',
    teamB: 'teamBStarter',
    teamBStarter: 'teamBStarter',
    teamBSub: 'teamBSub',
    leftOut: 'leftOut',
    subs: 'teamASub'
  };
  return map[pool] || 'leftOut';
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

function getNextPool(currentPool) {
  const order = ['teamAStarter', 'teamBStarter', 'teamASub', 'teamBSub', 'leftOut'];
  const index = order.indexOf(normalizePool(currentPool));
  return order[(index + 1) % order.length];
}

function normalizeWarzoneStatus(value) {
  if (value === WARZONE_STATUS.participated) return WARZONE_STATUS.participated;
  if (value === WARZONE_STATUS.excused) return WARZONE_STATUS.excused;
  return WARZONE_STATUS.missed;
}

function normalizeParticipationStatus(value) {
  if (Object.values(PARTICIPATION_STATUS).includes(value)) return value;
  return PARTICIPATION_STATUS.didNotRegister;
}

function participationLabel(status) {
  const labels = {
    [PARTICIPATION_STATUS.participated]: 'Participated',
    [PARTICIPATION_STATUS.late]: 'Late',
    [PARTICIPATION_STATUS.noShow]: 'No Show',
    [PARTICIPATION_STATUS.excused]: 'Excused',
    [PARTICIPATION_STATUS.leftOut]: 'Left Out',
    [PARTICIPATION_STATUS.didNotRegister]: 'Did Not Register'
  };
  return labels[normalizeParticipationStatus(status)] || 'Did Not Register';
}

function resetRosterForm() {
  document.getElementById('roster-form').reset();
  document.getElementById('player-id').value = '';
  document.getElementById('roster-form').classList.add('hidden');
}

function resetWarzoneDraft() {
  state.warzone.selectedEventId = '';
  state.warzone.draft = { eventDate: todayInputValue(), opponentServer: '' };
  state.warzone.participations = {};
  syncWarzoneDraftPlayers();
  renderWarzone();
}

function hydrateWarzoneFromEvent(event) {
  state.warzone.selectedEventId = event.id;
  state.warzone.draft = {
    eventDate: event.eventDate || todayInputValue(),
    opponentServer: event.opponentServer || ''
  };
  state.warzone.participations = cloneObject(event.participations || {});
}

function syncWarzoneDraftPlayers() {
  if (state.warzone.selectedEventId) return;
  const next = {};
  state.roster.forEach((player) => {
    next[player.id] = state.warzone.participations[player.id]
      ? {
          ...state.warzone.participations[player.id],
          name: player.name,
          rank: player.rankValue || player.rank || 'R1',
          thp: Number(player.thp) || 0
        }
      : {
          status: '',
          name: player.name,
          rank: player.rankValue || player.rank || 'R1',
          thp: Number(player.thp) || 0
        };
  });
  state.warzone.participations = next;
}

function openArchiveMatchModal(player) {
  document.getElementById('archive-match-message').textContent = `This player already exists. Would you like to restore ${player.name} instead?`;
  document.getElementById('archive-match-modal').classList.remove('hidden');
}

function closeArchiveMatchModal() {
  state.ui.pendingArchivedMatchId = '';
  state.ui.pendingPlayerDraft = null;
  document.getElementById('archive-match-modal').classList.add('hidden');
}

function upsertWarzoneLocally(eventId, payload) {
  const index = state.warzone.events.findIndex((entry) => entry.id === eventId);
  const nextEvent = { id: eventId, ...payload };
  if (index >= 0) {
    state.warzone.events[index] = nextEvent;
  } else {
    state.warzone.events.unshift(nextEvent);
  }
  hydrateWarzoneFromEvent(nextEvent);
  recomputeAttendanceStats();
  renderWarzone();
  renderAttendance();
  renderHistory();
}

function getOpenSlots(poolState, pools, capacity) {
  const map = {};
  pools.forEach((pool) => {
    map[pool] = Math.max(0, capacity - poolState[pool].length);
  });
  return map;
}

function placePlayers(poolState, assignments) {
  assignments.forEach(({ player, pool }) => {
    poolState[pool].push(player);
  });
}

function isLeader(player) {
  const rank = (player.rank || player.rankValue || '').toString();
  return rank.startsWith('R4') || rank.startsWith('R5');
}

function sumPlayers(players) {
  return players.reduce((sum, player) => sum + (Number(player.thp) || 0), 0);
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function cloneObject(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

window.editPlayer = editPlayer;
window.archivePlayer = archivePlayer;
window.toggleLock = toggleLock;
window.movePlayer = movePlayer;
window.restoreArchivedPlayer = restoreArchivedPlayer;
window.deleteArchivedPlayerPermanently = deleteArchivedPlayerPermanently;

init();
