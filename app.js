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

const MAX_ALLIANCE_SIZE = 100;

const FILTER_STORAGE_KEY = 'ssyn.filters.v1';

function defaultFilters() {
  return {
    desert: {
      search: '',
      ranks: [],
      flags: { playing: false, guaranteed: false, notPlaying: false },
      sort: { key: 'name', dir: 'asc' }
    },
    warzone: {
      search: '',
      ranks: [],
      flags: {},
      sort: { key: 'name', dir: 'asc' }
    },
    participation: {
      search: '',
      ranks: [],
      flags: {},
      sort: { key: 'score', dir: 'desc' }
    }
  };
}

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
  desertCurrent: {
    event: null
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
  filters: defaultFilters(),
  ui: {
    pendingArchivedMatchId: '',
    pendingPlayerDraft: null,
    pendingArchiveDeleteId: '',
    pendingArchiveNoteId: ''
  }
};

let archiveModalEventsBound = false;
let archiveNoteModalEventsBound = false;
let archiveDeleteModalEventsBound = false;

function init() {
  loadFilterState();
  bindNavigation();
  bindRoster();
  bindDesert();
  bindTeams();
  bindWarzone();
  bindAttendance();
  bindParticipation();
  bindArchived();
  bindArchiveModal();
  bindArchiveNoteModal();
  bindArchiveDeleteModal();
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
        archiveNote: data.archiveNote || '',
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
    renderRoster();
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

  window.db.onDesertCurrentSnapshot((doc) => {
    if (!doc.exists) {
      state.desertCurrent.event = null;
      renderParticipation();
      return;
    }

    const data = doc.data() || {};
    state.desertCurrent.event = normalizeCurrentDesertEvent({
      id: doc.id,
      ...data
    });
    renderParticipation();
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
        registeredCount: Number(data.registeredCount) || 0,
        guaranteedCount: Number(data.guaranteedCount) || 0,
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
    renderDesert();
    renderParticipation();
    renderHistory();
    renderTeams();
    renderArchived();
  });
}

function bindNavigation() {
  document.querySelectorAll('[data-main-target]').forEach((button) => {
    button.addEventListener('click', () => openView(button.dataset.mainTarget));
  });

  document.querySelectorAll('[data-sub-scope][data-sub-target]').forEach((button) => {
    button.addEventListener('click', () => {
      openSubView(button.dataset.subScope, button.dataset.subTarget);
    });
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
  document.getElementById('open-archived-view').addEventListener('click', () => {
    openView('alliance-view');
    openSubView('alliance-scope', 'archived-view');
  });

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
    prepareDesertParticipationFromCurrentTeams();
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

function bindParticipation() {
  const saveButton = document.getElementById('save-desert-event');
  if (saveButton) {
    saveButton.addEventListener('click', saveDesertEvent);
  }
}

function bindArchived() {
  document.getElementById('back-to-roster').addEventListener('click', () => {
    openView('alliance-view');
    openSubView('alliance-scope', 'roster-view');
  });
}

function bindArchiveModal() {
  if (archiveModalEventsBound) return;

  const modal = document.getElementById('archive-match-modal');
  const cancelButton = document.getElementById('cancel-archive-match');
  const createButton = document.getElementById('create-new-player');
  const restoreButton = document.getElementById('restore-archived-player');

  if (!modal || !cancelButton || !createButton || !restoreButton) {
    console.error('Archive modal elements are missing. Check modal IDs in index.html.');
    return;
  }

  cancelButton.addEventListener('click', closeArchiveMatchModal);

  createButton.addEventListener('click', () => {
    const draft = state.ui.pendingPlayerDraft;
    closeArchiveMatchModal();
    if (draft) saveRosterPlayer(draft);
  });

  restoreButton.addEventListener('click', () => {
    const archivedId = state.ui.pendingArchivedMatchId;
    closeArchiveMatchModal();
    if (archivedId) restoreArchivedPlayer(archivedId);
  });

  // Click outside the modal card closes the dialog.
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeArchiveMatchModal();
  });

  // Escape key closes the dialog when it is open.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!modal.classList.contains('hidden')) closeArchiveMatchModal();
  });

  archiveModalEventsBound = true;
}

function bindArchiveNoteModal() {
  if (archiveNoteModalEventsBound) return;

  const modal = document.getElementById('archive-note-modal');
  const cancelButton = document.getElementById('cancel-archive-note');
  const saveButton = document.getElementById('save-archive-note');
  const input = document.getElementById('archive-note-input');
  if (!modal || !cancelButton || !saveButton || !input) return;

  cancelButton.addEventListener('click', closeArchiveNoteModal);
  saveButton.addEventListener('click', saveArchiveNote);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeArchiveNoteModal();
  });

  archiveNoteModalEventsBound = true;
}

function bindArchiveDeleteModal() {
  if (archiveDeleteModalEventsBound) return;

  const modal = document.getElementById('archive-delete-modal');
  const cancelButton = document.getElementById('cancel-archive-delete');
  const confirmButton = document.getElementById('confirm-archive-delete');
  if (!modal || !cancelButton || !confirmButton) return;

  cancelButton.addEventListener('click', closeArchiveDeleteModal);
  confirmButton.addEventListener('click', () => {
    const id = state.ui.pendingArchiveDeleteId;
    closeArchiveDeleteModal();
    if (id) deleteArchivedPlayerPermanently(id);
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeArchiveDeleteModal();
  });

  archiveDeleteModalEventsBound = true;
}

function openView(targetId) {
  document.querySelectorAll('.main-view').forEach((view) => view.classList.remove('active'));
  document.querySelectorAll('[data-main-target]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mainTarget === targetId);
  });
  const target = document.getElementById(targetId);
  if (target) target.classList.add('active');
}

function openSubView(scopeId, targetId) {
  if (!scopeId || !targetId) return;
  const scope = document.getElementById(scopeId);
  if (!scope) return;

  scope.querySelectorAll('.sub-view').forEach((view) => view.classList.remove('active'));
  scope.querySelectorAll(`[data-sub-scope="${scopeId}"]`).forEach((button) => {
    button.classList.toggle('active', button.dataset.subTarget === targetId);
  });

  const target = document.getElementById(targetId);
  if (target && scope.contains(target)) {
    target.classList.add('active');
  }
}

function renderAll() {
  renderHome();
  renderRoster();
  renderDesert();
  renderTeams();
  renderWarzone();
  renderAttendance();
  renderParticipation();
  renderHistory();
  renderArchived();
}

function renderHome() {
  const totalMembersEl = document.getElementById('home-total-members');
  if (!totalMembersEl) return;

  const activeCount = state.roster.length;
  const archivedCount = state.archived.length;
  const totalCount = activeCount + archivedCount;

  totalMembersEl.textContent = String(totalCount);

  const memberDetailEl = document.getElementById('home-member-detail');
  if (memberDetailEl) {
    memberDetailEl.textContent = `${activeCount} active • ${archivedCount} archived`;
  }

  const attendanceRateEl = document.getElementById('home-attendance-rate');
  const activeAttendance = state.roster
    .map((player) => state.attendance.stats[player.id])
    .filter((entry) => typeof entry?.attendancePercent === 'number');
  const averageAttendance = activeAttendance.length
    ? activeAttendance.reduce((sum, entry) => sum + entry.attendancePercent, 0) / activeAttendance.length
    : null;
  if (attendanceRateEl) {
    attendanceRateEl.textContent = formatAttendancePercent(averageAttendance);
  }

  const weeklyParticipationEl = document.getElementById('home-weekly-participation');
  const latestDesertEvent = state.desertHistory.events[0] || null;
  if (weeklyParticipationEl) {
    if (!latestDesertEvent) {
      weeklyParticipationEl.textContent = '--';
    } else {
      const entries = Object.values(latestDesertEvent.participationResults || {});
      const engaged = entries.filter((entry) => {
        const status = normalizeParticipationStatus(entry.status);
        return status === PARTICIPATION_STATUS.participated || status === PARTICIPATION_STATUS.late;
      }).length;
      const percent = entries.length ? (engaged / entries.length) * 100 : null;
      weeklyParticipationEl.textContent = formatAttendancePercent(percent);
    }
  }

  const topStarsEl = document.getElementById('home-top-stars');
  const topPlayerEl = document.getElementById('home-top-player');
  const leaderboard = [...state.roster]
    .map((player) => ({ player, stars: getCombinedStormPoints(player.id) }))
    .sort((left, right) => right.stars - left.stars || left.player.name.localeCompare(right.player.name));

  if (topStarsEl && topPlayerEl) {
    if (!leaderboard.length) {
      topStarsEl.textContent = '0';
      topPlayerEl.textContent = 'No data yet';
    } else {
      topStarsEl.textContent = `${leaderboard[0].stars}`;
      topPlayerEl.textContent = leaderboard[0].player.name;
    }
  }

  const recentActivityEl = document.getElementById('home-recent-activity');
  if (recentActivityEl) {
    const items = [];

    if (state.warzone.events.length) {
      const latestWarzone = state.warzone.events[0];
      items.push(`Warzone save: ${formatDateLabel(latestWarzone.eventDate)} vs ${latestWarzone.opponentServer || 'opponent pending'}`);
    }

    if (state.desertHistory.events.length) {
      const latestDesert = state.desertHistory.events[0];
      items.push(`Desert event save: ${formatDateLabel(latestDesert.eventDate)} ${latestDesert.eventTime || ''}`.trim());
    }

    if (state.desertCurrent.event) {
      items.push('Desert participation in progress and ready to finalize.');
    }

    if (state.roster.length) {
      items.push(`Roster synced: ${state.roster.length} active players available.`);
    }

    if (!items.length) {
      items.push('No activity recorded yet.');
    }

    recentActivityEl.innerHTML = items.slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  }
}

function renderRoster() {
  const list = document.getElementById('roster-list');
  const rosterTitle = document.getElementById('roster-title');
  const search = document.getElementById('roster-search').value.toLowerCase();
  const sort = document.getElementById('roster-sort').value;

  if (rosterTitle) {
    const total = state.roster.length;
    rosterTitle.textContent = `Alliance Roster (${total} / ${MAX_ALLIANCE_SIZE})`;
  }

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
      <article class="player-card roster-card">
        <div class="player-main">
          <div>
            <div class="player-name roster-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge ${rankBadgeClass(rankLabel)}">${rankLabel}</span> • THP ${formatThp(player.thp)}</div>
          </div>
          <div class="card-actions-vertical">
            <button class="primary-btn" onclick="editPlayer('${player.id}')">Edit</button>
            <button class="secondary-btn" onclick="archivePlayer('${player.id}')">Archive</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderDesert() {
  const desertCounts = getDesertFilterCounts();
  renderFilterBar('desert-filter-bar', 'desert', {
    sortChips: [
      { key: 'name', label: 'Name' },
      { key: 'thp', label: 'THP' },
      { key: 'score', label: '⭐ Score' }
    ],
    extraChips: [
      { key: 'playing', label: 'Playing' },
      { key: 'guaranteed', label: 'Guaranteed' },
      { key: 'notPlaying', label: 'Not Playing' }
    ],
    extraChipCounts: desertCounts
  });

  const list = document.getElementById('desert-list');
  document.getElementById('event-date').value = state.desert.eventDate;
  document.getElementById('event-time').value = state.desert.timeSlot;

  if (!state.roster.length) {
    list.innerHTML = '<div class="list-empty">Build the roster first so Desert Storm registrations can appear here.</div>';
    return;
  }

  const filters = state.filters.desert;
  const players = [...state.roster]
    .filter((player) => playerMatchesSearch(player, filters.search))
    .filter((player) => rankFilterMatch(player, filters.ranks))
    .filter((player) => {
      const registration = state.desert.registrations[player.id] || { requested: false, guaranteed: false };
      if (filters.flags.playing && !registration.requested) return false;
      if (filters.flags.guaranteed && !registration.guaranteed) return false;
      if (filters.flags.notPlaying && registration.requested) return false;
      return true;
    })
    .sort((left, right) => compareByFilterSort('desert', left, right));

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">No players match the current filters.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    const registration = state.desert.registrations[player.id] || { requested: false, guaranteed: false };
    const rankLabel = escapeHtml(player.rank || player.rankValue || 'R1');
    const stormPoints = getCombinedStormPoints(player.id);
    return `
      <article class="registration-row">
        <div class="registration-top">
          <div>
            <div class="registration-name">${escapeHtml(player.name)}</div>
            <div class="registration-meta"><span class="rank-badge ${rankBadgeClass(rankLabel)}">${rankLabel}</span> • THP ${formatThp(player.thp)} • ${formatStarPoints(stormPoints)}</div>
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
    const score = getCombinedStormPoints(player.id);
    return `
      <article class="team-player-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge ${rankBadgeClass(rankLabel)}">${rankLabel}</span> • THP ${formatThp(player.thp)} • ${formatStarPoints(score)}</div>
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
  renderFilterBar('warzone-filter-bar', 'warzone', {
    sortChips: [
      { key: 'name', label: 'Name' },
      { key: 'thp', label: 'THP' }
    ],
    extraChips: []
  });

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
  const filters = state.filters.warzone;
  const players = [...state.roster]
    .filter((player) => playerMatchesSearch(player, filters.search))
    .filter((player) => rankFilterMatch(player, filters.ranks))
    .sort((left, right) => compareByFilterSort('warzone', left, right));

  if (!players.length) {
    list.innerHTML = state.roster.length
      ? '<div class="list-empty">No players match the current filters.</div>'
      : '<div class="list-empty">Add active players to the Alliance Roster before recording a Warzone.</div>';
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
            <div class="player-stats"><span class="rank-badge ${rankBadgeClass(rankLabel)}">${rankLabel}</span> • THP ${formatThp(player.thp)}</div>
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
        <div class="player-stats"><span class="rank-badge ${rankBadgeClass(rankLabel)}">${rankLabel}</span> • THP ${formatThp(player.thp)}</div>
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
  const meta = document.getElementById('participation-event-meta');
  const saveButton = document.getElementById('save-desert-event');

  if (!list) return;

  const currentEvent = state.desertCurrent.event;
  if (!currentEvent) {
    if (meta) meta.textContent = 'No active Desert Storm event. Save teams first.';
    if (saveButton) saveButton.disabled = true;
    list.innerHTML = '<div class="list-empty">No Desert Storm event in progress.</div>';
    return;
  }

  if (meta) {
    meta.textContent = `${formatDateLabel(currentEvent.eventDate)} • ${currentEvent.eventTime} • Team A THP ${currentEvent.teamATHP} • Team B THP ${currentEvent.teamBTHP} • Diff ${currentEvent.thpDifference}`;
  }
  if (saveButton) saveButton.disabled = false;

  const players = Object.values(currentEvent.participationResults || {})
    .map((entry) => ({
      playerId: entry.playerId,
      name: entry.name || '',
      rank: entry.rank || 'R1',
      thp: Number(entry.thp) || 0,
      assignmentTeam: entry.assignmentTeam || '',
      assignmentRole: entry.assignmentRole || '',
      status: normalizeParticipationStatus(entry.status)
    }))
    .filter((entry) => entry.assignmentTeam && entry.assignmentRole)
    .sort((left, right) => left.name.localeCompare(right.name));

  if (!players.length) {
    list.innerHTML = '<div class="list-empty">No players are attached to this event.</div>';
    return;
  }

  list.innerHTML = players.map((player) => {
    const rankLabel = escapeHtml(player.rank || 'R1');
    const points = PARTICIPATION_POINTS[player.status] || 0;
    const stormPoints = getCombinedStormPoints(player.playerId);
    const statuses = [
      PARTICIPATION_STATUS.participated,
      PARTICIPATION_STATUS.late,
      PARTICIPATION_STATUS.noShow,
      PARTICIPATION_STATUS.excused
    ];

    return `
      <article class="player-card participation-card">
        <div class="player-top">
          <div>
            <div class="player-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge ${rankBadgeClass(rankLabel)}">${rankLabel}</span> • THP ${formatThp(player.thp)} • ${formatStarPoints(stormPoints)}</div>
            <div class="player-stats">${escapeHtml(player.assignmentTeam)} • ${escapeHtml(player.assignmentRole)}</div>
          </div>
          <div class="chip">${points > 0 ? `+${points}` : points}</div>
        </div>
        <div class="history-edit-row">
          <select data-current-player-id="${player.playerId}">
            ${statuses.map((status) => `<option value="${status}" ${status === player.status ? 'selected' : ''}>${participationLabel(status)}</option>`).join('')}
          </select>
        </div>
      </article>
    `;
  }).join('');

  list.querySelectorAll('select[data-current-player-id]').forEach((select) => {
    select.addEventListener('change', (event) => {
      updateCurrentDesertParticipation(event.target.dataset.currentPlayerId, event.target.value);
    });
  });
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
    list.innerHTML = '<div class="list-empty">No completed Desert Storm events yet.</div>';
    return;
  }

  list.innerHTML = state.desertHistory.events.map((event) => `
    <button class="history-entry ${event.id === state.desertHistory.selectedEventId ? 'selected' : ''}" data-event-id="${event.id}">
      <span>${escapeHtml(formatDateLabel(event.eventDate))} • ${escapeHtml(event.eventTime)}</span>
      <span>Reg ${Number(event.registeredCount) || 0} • Gtd ${Number(event.guaranteedCount) || 0} • Diff ${Math.abs(Number(event.thpDifference) || 0)}</span>
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
  meta.textContent = `${formatDateLabel(event.eventDate)} • ${event.eventTime} • Registered ${Number(event.registeredCount) || 0} • Guaranteed ${Number(event.guaranteedCount) || 0} • Team A THP ${event.teamATHP} • Team B THP ${event.teamBTHP} • Diff ${event.thpDifference}`;

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

  const players = [...state.archived].sort((left, right) => {
    const dv = toMillis(right.archivedAt) - toMillis(left.archivedAt);
    if (dv !== 0) return dv;
    return left.name.localeCompare(right.name);
  });
  list.innerHTML = players.map((player) => {
    const rankLabel = escapeHtml(player.lastKnownRank || player.rank || player.rankValue || 'R1');
    const note = String(player.archiveNote || '').trim();
    return `
      <article class="player-card archived-card">
        <div class="archived-date">Archived ${escapeHtml(formatDateLabelFromAny(player.archivedAt))}</div>
        <div class="player-main">
          <div>
            <div class="player-name archived-name">${escapeHtml(player.name)}</div>
            <div class="player-stats"><span class="rank-badge ${rankBadgeClass(rankLabel)}">${rankLabel}</span> • THP ${formatThp(player.lastKnownThp ?? player.thp)}</div>
          </div>
          <div class="card-actions-vertical">
            <button class="primary-btn" onclick="restoreArchivedPlayer('${player.id}')">Restore</button>
            <button class="secondary-btn" onclick="promptDeleteArchivedPlayer('${player.id}')">Delete</button>
          </div>
        </div>

        <div class="archived-note-row">
          ${note ? `<div class="archived-note">📝 ${escapeHtml(note)}</div>` : ''}
          <button class="chip-btn" onclick="openArchiveNoteModal('${player.id}')">${note ? 'Edit Note' : 'Add Note'}</button>
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
    archiveNote: '',
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
  if (window.db && window.db.permanentlyDeleteArchivedPlayer) {
    window.db.permanentlyDeleteArchivedPlayer(playerId).catch((err) => console.error('delete archived player', err));
    return;
  }

  state.archived = state.archived.filter((entry) => entry.id !== playerId);
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

function buildDesertEventFromCurrentTeams() {
  if (!state.desert.eventDate || !state.desert.timeSlot) return null;

  const includedPlayers = getIncludedPlayers();
  if (!includedPlayers.length) return null;

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
  const registeredCount = includedPlayers.length;
  const guaranteedCount = includedPlayers.filter((player) => state.desert.registrations[player.id]?.guaranteed).length;

  const participationResults = {};
  const poolsToTeam = {
    teamAStarter: { team: 'Team A', role: 'Starter' },
    teamASub: { team: 'Team A', role: 'Sub' },
    teamBStarter: { team: 'Team B', role: 'Starter' },
    teamBSub: { team: 'Team B', role: 'Sub' }
  };

  Object.entries(poolsToTeam).forEach(([pool, assignment]) => {
    (byPool[pool] || []).forEach((player) => {
      const status = PARTICIPATION_STATUS.participated;
      participationResults[player.id] = {
        playerId: player.id,
        name: player.name,
        rank: player.rankValue || player.rank || 'R1',
        thp: Number(player.thp) || 0,
        assignmentTeam: assignment.team,
        assignmentRole: assignment.role,
        status,
        points: PARTICIPATION_POINTS[status] || 0
      };
    });
  });

  const teamATHP = sumPlayers(teamA);
  const teamBTHP = sumPlayers(teamB);
  return {
    eventDate: state.desert.eventDate,
    eventTime: state.desert.timeSlot,
    registeredCount,
    guaranteedCount,
    teamA,
    teamB,
    leftOut,
    teamATHP,
    teamBTHP,
    thpDifference: Math.abs(teamATHP - teamBTHP),
    participationResults
  };
}

function normalizeCurrentDesertEvent(event) {
  if (!event) return null;
  const normalizedResults = {};
  Object.entries(event.participationResults || {}).forEach(([playerId, entry]) => {
    normalizedResults[playerId] = {
      ...entry,
      assignmentTeam: entry.assignmentTeam || '',
      assignmentRole: entry.assignmentRole || '',
      status: normalizeParticipationStatus(entry.status)
    };
  });

  return {
    id: event.id || 'current_event',
    eventDate: event.eventDate || '',
    eventTime: event.eventTime || state.desert.timeSlot || '18:00',
    registeredCount: Number(event.registeredCount) || 0,
    guaranteedCount: Number(event.guaranteedCount) || 0,
    teamA: event.teamA || [],
    teamB: event.teamB || [],
    leftOut: event.leftOut || [],
    teamATHP: Number(event.teamATHP) || 0,
    teamBTHP: Number(event.teamBTHP) || 0,
    thpDifference: Number(event.thpDifference) || 0,
    participationResults: normalizedResults
  };
}

function prepareDesertParticipationFromCurrentTeams() {
  const payload = buildDesertEventFromCurrentTeams();
  if (!payload) return;

  if (window.db && window.db.setDesertCurrentEvent) {
    window.db.setDesertCurrentEvent(payload).catch((err) => console.error('set current desert event', err));
  } else {
    state.desertCurrent.event = normalizeCurrentDesertEvent(payload);
    renderParticipation();
  }

  openView('desert-storm-view');
  openSubView('desert-scope', 'participation-view');
}

function updateCurrentDesertParticipation(playerId, statusValue) {
  const current = state.desertCurrent.event;
  if (!current || !current.participationResults[playerId]) return;

  const status = normalizeParticipationStatus(statusValue);
  const updated = {
    ...current.participationResults,
    [playerId]: {
      ...current.participationResults[playerId],
      status,
      points: PARTICIPATION_POINTS[status] || 0
    }
  };

  if (window.db && window.db.setDesertCurrentEvent) {
    window.db.setDesertCurrentEvent({ participationResults: updated }).catch((err) => console.error('update current desert participation', err));
    return;
  }

  state.desertCurrent.event = {
    ...current,
    participationResults: updated
  };
  renderParticipation();
}

function saveDesertEvent() {
  const current = state.desertCurrent.event;
  if (!current) return;

  const payload = {
    eventDate: current.eventDate,
    eventTime: current.eventTime,
    registeredCount: Number(current.registeredCount) || 0,
    guaranteedCount: Number(current.guaranteedCount) || 0,
    teamA: current.teamA || [],
    teamB: current.teamB || [],
    leftOut: current.leftOut || [],
    teamATHP: Number(current.teamATHP) || 0,
    teamBTHP: Number(current.teamBTHP) || 0,
    thpDifference: Number(current.thpDifference) || 0,
    participationResults: cloneObject(current.participationResults || {})
  };

  if (window.db && window.db.createDesertHistoryEvent) {
    window.db.createDesertHistoryEvent(payload)
      .then((docRef) => {
        const localEvent = {
          ...payload,
          id: docRef?.id || crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        state.desertHistory.events = [localEvent, ...state.desertHistory.events.filter((event) => event.id !== localEvent.id)];
        state.desertHistory.selectedEventId = localEvent.id;
        state.desertCurrent.event = null;
        recomputeParticipationStats();
        renderDesert();
        renderTeams();
        renderParticipation();
        renderHistory();
        renderArchived();
        if (window.db && window.db.clearDesertCurrentEvent) {
          window.db.clearDesertCurrentEvent().catch((err) => console.error('clear current desert event', err));
        }
        openView('history-view');
      })
      .catch((err) => console.error('save completed desert event', err));
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
  state.desertCurrent.event = null;
  recomputeParticipationStats();
  renderParticipation();
  renderHistory();
  renderTeams();
  renderArchived();
  openView('history-view');
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
      stat.stormPoints = stat.score;
      stat.combinedStormPoints = stat.score;

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
      totalEvents: stat.totalEvents,
      stormPoints: stat.stormPoints,
      combinedStormPoints: stat.combinedStormPoints
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
    totalEvents: 0,
    stormPoints: 0,
    combinedStormPoints: 0
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

function formatDateLabelFromAny(value) {
  const millis = toMillis(value);
  if (!millis) return 'Unknown';
  return new Date(millis).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function rankBadgeClass(rankValue) {
  const rank = String(rankValue || 'R1').toLowerCase();
  return `rank-${rank}`;
}

function playerMatchesSearch(player, search) {
  const value = String(search || '').trim().toLowerCase();
  if (!value) return true;
  return [player.name, player.rank, String(player.thp)]
    .map((entry) => String(entry || '').toLowerCase())
    .some((entry) => entry.includes(value));
}

function rankFilterMatch(player, selectedRanks) {
  if (!Array.isArray(selectedRanks) || !selectedRanks.length) return true;
  const rank = String(player.rank || player.rankValue || 'R1').toUpperCase();
  return selectedRanks.includes(rank);
}

function compareByFilterSort(scope, left, right) {
  const sort = state.filters[scope]?.sort || { key: 'name', dir: 'asc' };
  const dir = sort.dir === 'desc' ? -1 : 1;
  let cmp = 0;

  if (sort.key === 'thp') {
    cmp = (Number(left.thp) || 0) - (Number(right.thp) || 0);
  } else if (sort.key === 'score') {
    cmp = getParticipationScore(left.id) - getParticipationScore(right.id);
  } else {
    cmp = String(left.name || '').localeCompare(String(right.name || ''));
  }

  if (cmp === 0) {
    cmp = String(left.name || '').localeCompare(String(right.name || ''));
  }
  return cmp * dir;
}

function renderFilterBar(containerId, scope, config) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const current = state.filters[scope] || defaultFilters()[scope];
  const ranks = ['R5', 'R4', 'R3', 'R2', 'R1'];
  const sortChips = config.sortChips || [];
  const extraChips = config.extraChips || [];
  const extraChipCounts = config.extraChipCounts || {};
  const defaults = defaultFilters()[scope] || { search: '', ranks: [], flags: {}, sort: { key: 'name', dir: 'asc' } };
  const hasFlags = Object.values(current.flags || {}).some(Boolean);
  const hasNonDefaultSort = current.sort?.key !== defaults.sort.key || current.sort?.dir !== defaults.sort.dir;
  const hasActive = Boolean((current.search || '').trim()) || (current.ranks || []).length > 0 || hasFlags || hasNonDefaultSort;

  container.innerHTML = `
    <div class="filter-bar-grid">
      <input class="filter-search" data-filter-scope="${scope}" placeholder="Search" value="${escapeHtml(current.search || '')}" />
      <div class="filter-chip-row">
        ${ranks.map((rank) => `<button class="filter-chip ${(current.ranks || []).includes(rank) ? 'active' : ''}" data-filter-scope="${scope}" data-filter-type="rank" data-filter-value="${rank}">${rank}</button>`).join('')}
      </div>
      ${extraChips.length ? `<div class="filter-chip-row">${extraChips.map((chip) => {
        const count = Number(extraChipCounts[chip.key]);
        const label = Number.isFinite(count) ? `${chip.label} (${count})` : chip.label;
        return `<button class="filter-chip ${(current.flags || {})[chip.key] ? 'active' : ''}" data-filter-scope="${scope}" data-filter-type="flag" data-filter-value="${chip.key}">${label}</button>`;
      }).join('')}</div>` : ''}
      <div class="filter-chip-row">
        ${sortChips.map((chip) => {
          const isActive = current.sort?.key === chip.key;
          const direction = isActive ? (current.sort.dir === 'desc' ? ' ↓' : ' ↑') : '';
          return `<button class="filter-chip sort-chip ${isActive ? 'active' : ''}" data-filter-scope="${scope}" data-filter-type="sort" data-filter-value="${chip.key}">${chip.label}${direction}</button>`;
        }).join('')}
      </div>
      ${hasActive ? `<div class="filter-clear-wrap"><button class="secondary-btn filter-clear" data-filter-scope="${scope}" data-filter-type="clear">Clear Filters</button></div>` : ''}
    </div>
  `;

  const searchInput = container.querySelector('.filter-search');
  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      const next = String(event.target.value || '');
      state.filters[scope].search = next;
      saveFilterState();
      renderByScope(scope);
    });
  }

  container.querySelectorAll('button[data-filter-type]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.filterType;
      const value = button.dataset.filterValue;
      if (type === 'rank') {
        const ranksSet = new Set(state.filters[scope].ranks || []);
        if (ranksSet.has(value)) ranksSet.delete(value);
        else ranksSet.add(value);
        state.filters[scope].ranks = Array.from(ranksSet);
      } else if (type === 'flag') {
        state.filters[scope].flags[value] = !state.filters[scope].flags[value];
      } else if (type === 'sort') {
        const currentSort = state.filters[scope].sort || { key: 'name', dir: 'asc' };
        if (currentSort.key === value) {
          currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          const defaultsForScope = defaultFilters()[scope] || { sort: { key: 'name', dir: 'asc' } };
          currentSort.key = value;
          currentSort.dir = value === defaultsForScope.sort.key ? defaultsForScope.sort.dir : 'asc';
        }
        state.filters[scope].sort = currentSort;
      } else if (type === 'clear') {
        state.filters[scope] = cloneObject(defaultFilters()[scope]);
      }
      saveFilterState();
      renderByScope(scope);
    });
  });
}

function renderByScope(scope) {
  if (scope === 'desert') {
    renderDesert();
    return;
  }
  if (scope === 'warzone') {
    renderWarzone();
    return;
  }
  if (scope === 'participation') {
    renderParticipation();
  }
}

function loadFilterState() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) {
      state.filters = defaultFilters();
      return;
    }
    const parsed = JSON.parse(raw);
    const defaults = defaultFilters();
    state.filters = {
      desert: {
        ...defaults.desert,
        ...(parsed.desert || {}),
        flags: { ...defaults.desert.flags, ...((parsed.desert || {}).flags || {}) },
        sort: { ...defaults.desert.sort, ...((parsed.desert || {}).sort || {}) }
      },
      warzone: {
        ...defaults.warzone,
        ...(parsed.warzone || {}),
        flags: { ...defaults.warzone.flags, ...((parsed.warzone || {}).flags || {}) },
        sort: { ...defaults.warzone.sort, ...((parsed.warzone || {}).sort || {}) }
      },
      participation: {
        ...defaults.participation,
        ...(parsed.participation || {}),
        flags: { ...defaults.participation.flags, ...((parsed.participation || {}).flags || {}) },
        sort: { ...defaults.participation.sort, ...((parsed.participation || {}).sort || {}) }
      }
    };
  } catch (error) {
    console.error('load filters', error);
    state.filters = defaultFilters();
  }
}

function saveFilterState() {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state.filters));
  } catch (error) {
    console.error('save filters', error);
  }
}

function openArchiveNoteModal(playerId) {
  const player = state.archived.find((entry) => entry.id === playerId);
  const modal = document.getElementById('archive-note-modal');
  const input = document.getElementById('archive-note-input');
  if (!player || !modal || !input) return;
  state.ui.pendingArchiveNoteId = playerId;
  input.value = String(player.archiveNote || '');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeArchiveNoteModal() {
  const modal = document.getElementById('archive-note-modal');
  state.ui.pendingArchiveNoteId = '';
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function saveArchiveNote() {
  const playerId = state.ui.pendingArchiveNoteId;
  const input = document.getElementById('archive-note-input');
  if (!playerId || !input) return;
  const note = String(input.value || '').trim();

  if (window.db && window.db.setArchivedPlayerNote) {
    window.db.setArchivedPlayerNote(playerId, note)
      .then(closeArchiveNoteModal)
      .catch((err) => console.error('save archive note', err));
    return;
  }

  state.archived = state.archived.map((entry) => (
    entry.id === playerId ? { ...entry, archiveNote: note } : entry
  ));
  closeArchiveNoteModal();
  renderArchived();
}

function promptDeleteArchivedPlayer(playerId) {
  const modal = document.getElementById('archive-delete-modal');
  if (!modal) return;
  state.ui.pendingArchiveDeleteId = playerId;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeArchiveDeleteModal() {
  const modal = document.getElementById('archive-delete-modal');
  state.ui.pendingArchiveDeleteId = '';
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function getParticipationScore(playerId) {
  return Number(state.participation.stats[playerId]?.score) || 0;
}

function getCombinedStormPoints(playerId) {
  return Number(state.participation.stats[playerId]?.combinedStormPoints) || 0;
}

function sumParticipation(players) {
  return players.reduce((sum, player) => sum + getParticipationScore(player.id), 0);
}

function getDesertFilterCounts() {
  const counts = {
    playing: 0,
    guaranteed: 0,
    notPlaying: 0
  };

  state.roster.forEach((player) => {
    const registration = state.desert.registrations[player.id] || { requested: false, guaranteed: false };
    if (registration.requested) counts.playing += 1;
    if (registration.guaranteed) counts.guaranteed += 1;
    if (!registration.requested) counts.notPlaying += 1;
  });

  return counts;
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
  const modal = document.getElementById('archive-match-modal');
  const message = document.getElementById('archive-match-message');
  if (!modal || !message) return;

  message.textContent = `This player already exists. Would you like to restore ${player.name} instead?`;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeArchiveMatchModal() {
  const modal = document.getElementById('archive-match-modal');
  state.ui.pendingArchivedMatchId = '';
  state.ui.pendingPlayerDraft = null;
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
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
window.openArchiveNoteModal = openArchiveNoteModal;
window.promptDeleteArchivedPlayer = promptDeleteArchivedPlayer;
window.openArchiveMatchModal = openArchiveMatchModal;
window.closeArchiveMatchModal = closeArchiveMatchModal;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
