// Injury scenarios belong to this view; the imported league remains unchanged.
export function createPlayoffSeries({ $, api, escape, number, selectedTeam, getSession, onTeamChange, onChange, beforeRun }) {
  const injuries = new Map();
  let currentScore = [0, 0];
  let result = null, job = null, revision = 0, timer, pollTimer;
  let disabled = true, autoUpdate = false, sessionId = null, creationQueue = Promise.resolve();
  const opponent = () => getSession()?.teams.find(t => t.tid === Number($('series-opponent-select').value));
  const teams = () => [selectedTeam(), opponent()].filter(Boolean);
  const percent = p => Number.isFinite(p) ? `${number(p * 100)}%` : '—';
  const status = message => { $('series-status').textContent = message; };

  function controls() {
    for (const node of document.querySelectorAll('#series-view select, #series-view input, #series-view button')) node.disabled = disabled;
    $('series-run').disabled = disabled || !!job;
    $('series-cancel').hidden = !job && !timer;
    $('series-reset-injuries').disabled = disabled || !injuries.size;
    $('series-progress').hidden = !job;
    for (const button of document.querySelectorAll('[data-series-win]')) button.disabled = disabled || currentScore.includes(4);
  }
  function renderScore() {
    $('series-score-controls').innerHTML = teams().map((t,i) => `<div class="series-score-side"><label>${escape(t.name)} wins<select data-series-score="${i}" aria-label="Series wins for ${escape(t.name)}">${[0,1,2,3,4].map(w => `<option value="${w}" ${w === currentScore[i] ? 'selected' : ''} ${w === 4 && currentScore[1-i] === 4 ? 'disabled' : ''}>${w}</option>`).join('')}</select></label><button class="button button-secondary" data-series-win="${i}">Won next game +1</button></div>`).join('') + '<button class="button button-quiet" id="series-reset-score">Reset to 0–0</button>';
    const played = currentScore[0] + currentScore[1];
    const home = Number($('series-home-select').value);
    const host = [true,true,false,false,true,false,true][played] ? home : teams().find(t => t.tid !== home)?.tid;
    $('series-next-game').textContent = currentScore.includes(4)
      ? `Series complete: ${teams()[currentScore.indexOf(4)]?.name} wins ${4}–${currentScore[1-currentScore.indexOf(4)]}.`
      : `Current score: ${currentScore.join('–')}. Next: Game ${played+1}${getSession()?.warnings && teams().length === 2 ? ` · ${teams().find(t => t.tid === host)?.name} scheduled at home (unless neutral venues apply)` : ''}.`;
  }
  function renderResults() {
    $('series-probabilities').innerHTML = `<div class="series-probability-grid">${teams().map((t, i) => {
      const prediction = result?.teams.find(p => p.tid === t.tid);
      const ci = prediction?.seriesWinConfidence95;
      return `<div class="series-probability ${i === 0 ? 'series-ours' : ''}"><span class="section-kicker">${i === 0 ? 'YOUR TEAM' : 'OPPONENT'}</span><h3>${escape(t.name)}</h3><strong>${percent(prediction?.seriesWinProbability)}</strong><span>chance to win the series</span><small>${ci ? `95% sampling interval: ${percent(ci[0])}–${percent(ci[1])}` : 'Awaiting simulation'}</small></div>`;
    }).join('')}</div>${result ? `<div class="series-odds-bar" role="img" aria-label="${escape(result.teams[0].name)}: ${percent(result.teams[0].seriesWinProbability)}; ${escape(result.teams[1].name)}: ${percent(result.teams[1].seriesWinProbability)}"><div style="width:${100 * result.teams[0].seriesWinProbability}%"></div></div>` : ''}`;
    $('series-result-note').textContent = result
      ? result.finished ? `Series complete at ${result.currentScore.join('–')}. The winner is already determined; no games were simulated.` : `Starting at ${result.currentScore.join('–')} · ${result.series.toLocaleString()} series · ${result.simulatedGames.toLocaleString()} remaining games simulated · ${number(result.elapsedSeconds)}s · Average remaining: ${number(result.meanRemainingGames, 2)} games. ${result.neutralSite ? 'Neutral playoff venues: home-court advantage is disabled.' : 'Home court: ' + teams().find(t => t.tid === result.homeCourt)?.name + '.'} Intervals reflect simulation sampling, not model accuracy.`
      : 'Simulate this matchup to estimate each team’s chance of advancing.';
    $('series-outcomes').innerHTML = result ? `<div class="table-scroll"><table><caption>Series result probabilities</caption><thead><tr><th>Winner</th>${[0,1,2,3].map(losses => `<th>4–${losses}</th>`).join('')}</tr></thead><tbody>${result.teams.map(t => `<tr><td>${escape(t.name)}</td>${[0,1,2,3].map(losses => `<td>${percent(result.outcomes.find(o => o.winner === t.tid && o.loserWins === losses).probability)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
  }
  const availability = games => games > 4 ? 'Out' : games > 0 ? `Playing through · ${games}g` : 'Healthy';
  function renderRosters() {
    $('series-rosters').innerHTML = teams().map(t => `<article class="panel series-roster"><div class="panel-header"><h3>${escape(t.name)}</h3><span class="muted">${t.players.length} players</span></div><div class="table-scroll"><table><thead><tr><th>Player</th><th>OVR</th><th>Availability for this series</th></tr></thead><tbody>${t.players.slice().sort((a,b) => (b.ovr ?? b.valueNoPot) - (a.ovr ?? a.valueNoPot)).map(p => {
      const value = injuries.has(p.pid) ? String(injuries.get(p.pid)) : '';
      const options = [['', `Export: ${availability(p.injury.gamesRemaining)}`], ['0', 'Healthy'], ...[1,2,3,4].map(g => [String(g), `Play through · ${g}g injury`]), ['30', 'Out for series']];
      return `<tr><td><span class="player-name">${escape(p.name)}</span><span class="player-skills">${escape(p.pos)}${p.injury.gamesRemaining > 0 ? ` · ${escape(p.injury.type ?? 'Injured')} (${p.injury.gamesRemaining}g)` : ''}</span></td><td><span class="rating-badge">${number(p.ovr,0)}</span></td><td><select data-injury-pid="${p.pid}" aria-label="Availability for ${escape(p.name)}">${options.map(([key,label]) => `<option value="${key}" ${key === value ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select></td></tr>`;
    }).join('')}</tbody></table></div></article>`).join('');
    controls();
  }
  function renderHomeCourt() {
    const previous = Number($('series-home-select').value);
    $('series-home-select').innerHTML = teams().map(t => `<option value="${t.tid}">${escape(t.name)}</option>`).join('');
    $('series-home-select').value = String(teams().some(t => t.tid === previous) ? previous : selectedTeam()?.tid);
  }
  async function deleteJob(current) {
    if (current?.id) await api(`/api/jobs/${current.id}`, { method: 'DELETE' });
  }
  function invalidate() {
    revision++;
    clearTimeout(timer); timer = null; clearTimeout(pollTimer);
    const previous = job; job = null; result = null;
    // Serialize cancellation and creation, including POSTs still in flight.
    creationQueue = creationQueue.catch(() => {}).then(() => deleteJob(previous));
    $('series-error').hidden = true;
    return revision;
  }
  function refresh() {
    invalidate(); renderScore(); renderResults();
    status(autoUpdate ? 'Updating estimate…' : 'Ready to simulate this matchup.');
    if (autoUpdate && !disabled) timer = setTimeout(() => { timer = null; void run(); }, 350);
    controls(); onChange();
  }
  async function cancel() {
    const wasPending = !!job || !!timer;
    clearTimeout(timer); timer = null; clearTimeout(pollTimer); revision++;
    const previous = job; job = null;
    creationQueue = creationQueue.catch(() => {}).then(() => deleteJob(previous));
    if (wasPending) status('Simulation cancelled. Run again when ready.');
    controls(); onChange();
    try { await creationQueue; } catch (error) { showError(error); }
  }
  function showError(error) {
    job = null; status('Could not calculate this matchup.');
    $('series-error').textContent = error.message || String(error);
    $('series-error').hidden = false;
    controls(); onChange();
  }
  async function run() {
    if (disabled || teams().length !== 2) return;
    if (!$('series-seed').reportValidity()) {
      showError(new Error('Enter a whole-number simulation seed from 0 to 2147483647.'));
      return;
    }
    const rev = invalidate(); autoUpdate = true;
    const current = { id: null, revision: rev }; job = current;
    const options = { teamId: selectedTeam().tid, opponentId: opponent().tid,
      homeCourt: Number($('series-home-select').value), series: Number($('series-budget').value),
      seed: Number($('series-seed').value), health: 'current',
      currentScore: [...currentScore],
      injuries: [...injuries].map(([pid, gamesRemaining]) => ({ pid, gamesRemaining })) };
    const runSession = getSession().sessionId;
    renderResults(); status('Preparing playoff simulations…');
    $('series-progress').firstElementChild.style.width = '0%';
    controls(); onChange();
    creationQueue = creationQueue.catch(() => {}).then(async () => {
      if (revision !== rev || job !== current) return;
      try {
        await beforeRun();
        if (revision !== rev || job !== current) return;
        const created = await api('/api/jobs', { method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({sessionId:runSession, type:'series', options, replace:true}) });
        current.id = created.jobId;
        if (revision !== rev || job !== current) { await deleteJob(current); return; }
        void poll(current);
      } catch (error) { if (revision === rev && job === current) showError(error); }
    });
    await creationQueue;
  }
  async function poll(current) {
    try {
      const response = await api(`/api/jobs/${current.id}`);
      if (job !== current || revision !== current.revision) return;
      if (response.status === 'running') {
        const p = response.progress;
        status(`${p?.completed ?? 0} / ${p?.total ?? $('series-budget').value} series simulated`);
        $('series-progress').firstElementChild.style.width = `${p?.total ? 100 * p.completed / p.total : 0}%`;
        pollTimer = setTimeout(() => void poll(current), 250); return;
      }
      job = null;
      if (response.status === 'failed') throw new Error(response.error || 'Simulation failed');
      if (response.status === 'complete') {
        result = response.result; renderResults(); status('Estimate updated. Score and injury changes recalculate automatically.');
      } else status('Simulation cancelled.');
      controls(); onChange();
    } catch (error) {
      if (revision !== current.revision || (job && job !== current)) return;
      try { await deleteJob(current); } catch { /* Surface the original connection failure. */ }
      if (revision === current.revision && (!job || job === current)) showError(error);
    }
  }
  function reset() {
    currentScore = [0, 0];
    const previousOpponent = opponent()?.tid;
    const sameSession = sessionId === getSession()?.sessionId;
    sessionId = getSession()?.sessionId;
    if (!sameSession) { autoUpdate = false; $('series-budget').value = '200'; $('series-seed').value = '12345'; }
    injuries.clear();
    $('series-team-select').innerHTML = (getSession()?.teams ?? []).map(t => `<option value="${t.tid}">${escape(t.name)}</option>`).join('');
    $('series-team-select').value = String(selectedTeam()?.tid);
    const others = (getSession()?.teams ?? []).filter(t => t.tid !== selectedTeam()?.tid);
    $('series-opponent-select').innerHTML = others.map(t => `<option value="${t.tid}">${escape(t.name)}</option>`).join('');
    if (sameSession && others.some(t => t.tid === previousOpponent)) $('series-opponent-select').value = String(previousOpponent);
    $('series-home-select').innerHTML = '';
    renderHomeCourt();
    // Default explicitly to our team, including when the opponent has ID 0.
    $('series-home-select').value = String(selectedTeam()?.tid);
    renderRosters(); refresh();
  }
  $('series-team-select').addEventListener('change', () => onTeamChange(Number($('series-team-select').value)));
  $('series-opponent-select').addEventListener('change', () => {
    currentScore = [0, 0];
    const pids = new Set(teams().flatMap(t => t.players.map(p => p.pid)));
    for (const pid of injuries.keys()) if (!pids.has(pid)) injuries.delete(pid);
    renderHomeCourt(); renderRosters(); refresh();
  });
  for (const id of ['series-home-select','series-budget','series-seed']) $(id).addEventListener('change', refresh);
  $('series-score-controls').addEventListener('change', event => {
    if (event.target.dataset.seriesScore === undefined) return;
    currentScore[Number(event.target.dataset.seriesScore)] = Number(event.target.value);
    autoUpdate = true; refresh();
  });
  $('series-score-controls').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || disabled) return;
    if (button.id === 'series-reset-score') currentScore = [0, 0];
    else if (button.dataset.seriesWin !== undefined && !currentScore.includes(4)) currentScore[Number(button.dataset.seriesWin)]++;
    else return;
    autoUpdate = true; refresh();
  });
  $('series-rosters').addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.injuryPid === undefined) return;
    const pid = Number(input.dataset.injuryPid);
    if (input.value === '') injuries.delete(pid); else injuries.set(pid, Number(input.value));
    refresh();
  });
  $('series-reset-injuries').addEventListener('click', () => { injuries.clear(); renderRosters(); refresh(); });
  $('series-run').addEventListener('click', () => void run());
  $('series-cancel').addEventListener('click', () => void cancel());
  return { reset, cancel, report: () => result, setDisabled: value => { disabled = value; controls(); } };
}
