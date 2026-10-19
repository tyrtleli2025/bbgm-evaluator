// The browser owns only selections and presentation. Rule checks, negotiation,
// and all basketball simulations run against the imported server-side snapshot.
export function createTradeBuilder(helpers) {
  const {$, api, escape, number, signed, interval, money, selectedTeam, teamName,
    getSession, getOptions, onChange} = helpers;
  const selected = new Map(), picks = new Map(), protectedPlayers = new Map();
  const filters = new Map(), sorts = new Map();
  let revision = 0, timer, pollTimer, checkController, job = null;
  let result = null, assessment = null, disabled = true, creationQueue = Promise.resolve();
  let impactState = 'empty', impactMessage = '', suggestedPlayers = new Set();

  const setFor = (map, tid) => {
    if (!map.has(tid)) map.set(tid, new Set());
    return map.get(tid);
  };
  const partner = () => getSession()?.teams.find(t => t.tid === Number($('opponent-select').value));
  const activeTeams = () => [selectedTeam(), partner()].filter(Boolean);
  const scenario = () => ({teams:activeTeams().map(t => ({tid:t.tid,
    send:[...setFor(selected,t.tid)].sort((a,b) => a-b),
    picks:[...setFor(picks,t.tid)].sort((a,b) => a-b)}))});
  const assetCount = () => scenario().teams.reduce((sum,t) => sum+t.send.length+t.picks.length,0);
  const hasAssets = () => activeTeams().length === 2 && assetCount() > 0;
  const pickName = pick => `${pick.season ?? 'Future'} · Round ${pick.round ?? '?'}${Number.isInteger(pick.originalTid) ? ` · ${teamName(pick.originalTid)}` : ''}`;
  const deltaClass = (value, lowerIsBetter = false) => !Number.isFinite(value) || Math.abs(value) < 0.05 ? '' : (lowerIsBetter ? value < 0 : value > 0) ? 'delta-positive' : 'delta-negative';

  function tradeOptions(games = 4) {
    const options = {...getOptions(),gamesPerOpponent:games,scenario:scenario()};
    if ($('trade-phase-select').value !== '') options.tradePhase = Number($('trade-phase-select').value);
    if ($('difficulty-input').value !== '') options.difficulty = Number($('difficulty-input').value);
    if ($('strategy-select').value !== '' && partner()) options.strategies = {[partner().tid]:$('strategy-select').value};
    return options;
  }
  function validOptions() {
    return ['difficulty-input','seed-input'].every(id => $(id).reportValidity());
  }
  function applyDisabled() {
    for (const node of document.querySelectorAll('#trade-view input, #trade-view select, #trade-view button')) node.disabled = disabled;
    $('make-work-button').disabled = disabled || !hasAssets() || job?.type === 'make-work';
    $('clear-trade-button').disabled = disabled || (!hasAssets() && ![...protectedPlayers.values()].some(set => set.size));
    $('refine-trade-button').disabled = disabled || !hasAssets() || !!job;
    $('cancel-trade-button').disabled = disabled;
    $('cancel-trade-button').hidden = !job && impactState !== 'waiting';
  }
  function renderContext() {
    if (!getSession()) return;
    const context = getSession().tradeContext, missing = [];
    if (context.phase === null) missing.push('transaction phase');
    if (!context.hasDifficulty) missing.push('difficulty');
    if (!context.hasTeamStrategies) missing.push('team strategies');
    const overrides = $('trade-phase-select').value !== '' || $('difficulty-input').value !== '' || $('strategy-select').value !== '';
    $('trade-context-note').textContent = `${missing.length ? `This export omits ${missing.join(', ')}. Team impact can still be simulated; complete AI checks require more context.` : 'This snapshot includes the main trade context. The deal is checked against the pinned game’s transaction and AI rules.'}${overrides ? ' Overrides that differ from exported values are assumptions, so those results remain conditional.' : ''} A passing model check is not a promise of acceptance in a different game version.`;
  }
  function renderBudget() {
    const games = Number($('games-select').value);
    $('refine-trade-button').textContent = `Refine · ${games} games / opponent`;
  }
  function renderSummary() {
    const ours = selectedTeam(), other = partner();
    if (!ours || !other) { $('trade-summary').innerHTML = ''; return; }
    $('trade-summary').innerHTML = [ours,other].map((team,index) => {
      const sent = team.players.filter(p => setFor(selected,team.tid).has(p.pid));
      const sentPicks = (team.picks ?? []).filter(p => setFor(picks,team.tid).has(p.dpid));
      const salary = sent.every(p => Number.isFinite(p.salary)) ? sent.reduce((sum,p) => sum+p.salary,0) : null;
      const row = assessment?.details?.teams?.find(t => t.tid === team.tid);
      const others = [ours,other][1-index];
      const countAfter = team.players.length-sent.length+setFor(selected,others.tid).size;
      const chips = [...sent.map(p => ({id:p.pid,name:p.name,type:'player'})),...sentPicks.map(p => ({id:p.dpid,name:pickName(p),type:'pick'}))];
      return `<div class="package-summary ${index ? 'receiving' : ''}"><div class="package-heading"><div><span class="section-kicker">${index ? 'YOU RECEIVE' : 'YOU SEND'}</span><h3>${escape(team.name)}</h3></div><div class="package-salary"><strong>${money(salary)}</strong><span>outgoing salary</span></div></div><div class="package-assets">${chips.length ? chips.map(asset => `<button class="asset-chip" data-remove="${asset.type}" data-tid="${team.tid}" data-id="${asset.id}" aria-label="Remove ${escape(asset.name)} from trade">${escape(asset.name)} <span aria-hidden="true">×</span></button>`).join('') : '<span class="package-placeholder">Choose assets from the roster below</span>'}</div><div class="package-footer"><span>${sent.length} ${sent.length === 1 ? 'player' : 'players'}${sentPicks.length ? ` · ${sentPicks.length} ${sentPicks.length === 1 ? 'pick' : 'picks'}` : ''} selected</span><span>${countAfter} players after${Number.isFinite(row?.payrollAfter) ? ` · ${money(row.payrollAfter)} payroll` : ''}</span></div></div>`;
    }).join('');
  }
  function renderAssessment() {
    if (!hasAssets()) {
      $('trade-assessment').innerHTML = '<span class="assessment-idle">Select assets to check salary rules and the partner’s response.</span>';
      return;
    }
    if (!assessment) {
      $('trade-assessment').innerHTML = '<span class="assessment-idle">Checking the current package…</span>';
      return;
    }
    const legalLabel = assessment.legal === true ? 'Pass' : assessment.legal === false ? 'Does not pass' : 'Needs context';
    const aiLabel = assessment.aiAcceptance === true ? 'Would accept' : assessment.aiAcceptance === false ? 'Would reject' : assessment.details?.missing?.length ? 'Needs context' : 'Not checked';
    const badge = value => value === true ? 'badge-verified' : value === false ? 'badge-rejected' : 'badge-conditional';
    const reasons = [...new Set([...(assessment.reasons ?? []),...(assessment.details?.rosterWarnings ?? [])])];
    $('trade-assessment').innerHTML = `<div class="assessment-statuses"><span>Transaction rules <strong class="badge ${badge(assessment.legal)}">${legalLabel}</strong></span><span>Partner AI <strong class="badge ${badge(assessment.aiAcceptance)}">${aiLabel}</strong></span><span class="assessment-model">${assessment.status === 'verified' ? 'Verified against imported inputs' : assessment.details?.assumptions?.length ? 'Conditional on your assumptions' : 'Pinned game model'}</span></div>${reasons.length ? `<details class="assessment-reasons" ${assessment.legal === false ? 'open' : ''}><summary>${assessment.legal === false ? 'Why this deal does not pass' : 'Context, assumptions & details'} (${reasons.length})</summary><ul>${reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></details>` : ''}`;
  }
  function playerRows(team) {
    const query = (filters.get(team.tid) ?? '').toLowerCase().trim();
    const sort = sorts.get(team.tid) ?? 'ovr';
    const list = team.players.filter(p => `${p.name} ${p.pos} ${(p.skills ?? []).join(' ')} ${p.pid}`.toLowerCase().includes(query));
    list.sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'age' ? a.age-b.age || a.name.localeCompare(b.name) : (b[sort] ?? -Infinity)-(a[sort] ?? -Infinity) || a.name.localeCompare(b.name));
    if (!list.length) return '<tr><td colspan="9" class="no-player-results">No players match this filter.</td></tr>';
    return list.map(p => {
      const included = setFor(selected,team.tid).has(p.pid), protectedPlayer = setFor(protectedPlayers,team.tid).has(p.pid);
      const restricted = p.gamesUntilTradable > 0;
      return `<tr class="${included ? 'player-included' : protectedPlayer ? 'player-protected' : ''}"><td class="checkbox-cell"><input id="include-${team.tid}-${p.pid}" type="checkbox" data-action="include" data-tid="${team.tid}" data-id="${p.pid}" ${included ? 'checked' : ''} aria-label="Include ${escape(p.name)} in trade"></td><td class="checkbox-cell"><input id="protect-${team.tid}-${p.pid}" type="checkbox" data-action="protect" data-tid="${team.tid}" data-id="${p.pid}" ${protectedPlayer ? 'checked' : ''} aria-label="Protect ${escape(p.name)} from counteroffers" title="Exclude from suggested counteroffers"></td><td class="trade-player-name"><span>${escape(p.name)}${suggestedPlayers.has(p.pid) ? '<span class="added-dot" title="Added by counteroffer" aria-label="Added by counteroffer"></span>' : ''}</span><small>PID ${p.pid}${p.skills?.length ? ` · ${escape(p.skills.join(' · '))}` : ''}${p.injury?.gamesRemaining > 0 ? ` · Injured ${escape(p.injury.gamesRemaining)}g` : ''}${restricted ? ` · Restricted ${escape(p.gamesUntilTradable)}g` : ''}</small></td><td>${escape(p.pos)}</td><td>${number(p.age,0)}</td><td><span class="rating-badge ${p.ovr >= 65 ? 'elite' : p.ovr < 45 ? 'low' : ''}">${number(p.ovr,0)}</span></td><td>${number(p.pot,0)}</td><td>${money(p.salary)}</td><td>${number(p.contractExp,0)}</td></tr>`;
    }).join('');
  }
  function renderRosterBody(tid) {
    const team = getSession()?.teams.find(t => t.tid === tid);
    if (!team || !$(`trade-roster-${tid}`)) return;
    $(`trade-roster-${tid}`).innerHTML = playerRows(team);
    applyDisabled();
  }
  function renderRosters() {
    const focusedId = document.activeElement?.id;
    $('trade-rosters').innerHTML = activeTeams().map((team,index) => `<article class="panel trade-roster-panel"><div class="trade-roster-title"><div><span class="section-kicker">${index ? 'THEIR ROSTER' : 'YOUR ROSTER'}</span><h3>${escape(team.name)} <span class="count-badge">${team.players.length}</span></h3></div><span class="roster-side-badge">${index ? 'Receive' : 'Send'}</span></div><div class="roster-filter"><input id="roster-filter-${team.tid}" type="search" placeholder="Find player, position, skill…" aria-label="Filter ${escape(team.name)} roster" data-filter="${team.tid}" value="${escape(filters.get(team.tid) ?? '')}"><select id="roster-sort-${team.tid}" data-sort="${team.tid}" aria-label="Sort ${escape(team.name)} roster">${[['ovr','OVR ↓'],['name','Name A–Z'],['salary','Salary ↓'],['age','Age ↑']].map(([value,label]) => `<option value="${value}" ${(sorts.get(team.tid) ?? 'ovr') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="trade-roster-scroll"><table class="trade-roster-table"><thead><tr><th class="checkbox-cell" title="Include in trade">In</th><th class="checkbox-cell" title="Protect from counteroffers">Keep</th><th>Player</th><th>Pos</th><th>Age</th><th>OVR</th><th>POT</th><th>Salary</th><th>Exp</th></tr></thead><tbody id="trade-roster-${team.tid}">${playerRows(team)}</tbody></table></div><details class="draft-picks"><summary>Draft picks <span>${team.picks?.length ?? 0} available</span></summary>${team.picks?.length ? team.picks.map(pick => `<label class="pick-row"><input id="pick-${team.tid}-${pick.dpid}" type="checkbox" data-action="pick" data-tid="${team.tid}" data-id="${pick.dpid}" ${setFor(picks,team.tid).has(pick.dpid) ? 'checked' : ''} aria-label="Include ${escape(pickName(pick))} from ${escape(team.name)}">${escape(pickName(pick))}</label>`).join('') : `<p>${getSession()?.tradeContext.hasDraftPicks ? 'This team has no exported draft picks.' : 'Draft picks were not included in this export.'}</p>`}</details></article>`).join('');
    applyDisabled();
    if (focusedId && $(focusedId)) $(focusedId).focus({preventScroll:true});
  }
  function renderImpact() {
    const before = result?.before, after = result?.after;
    const stats = [
      {label:'TEAM STRENGTH',key:'strength',delta:'net',format:signed,unit:'net points / 100',primary:true},
      {label:'OFFENSIVE RATING',key:'offensiveRating',delta:'offense',format:number,unit:'higher is better'},
      {label:'DEFENSIVE RATING',key:'defensiveRating',delta:'defense',format:number,unit:'lower is better',lower:true},
      {label:'SIMULATED WIN RATE',key:'winRate',delta:'win',format:n => Number.isFinite(n) ? `${number(n*100)}%` : '—',unit:'game wins, not title odds',percent:true},
    ];
    $('trade-impact').innerHTML = `<div class="impact-metrics">${stats.map(stat => {
      const difference = result?.delta?.[stat.delta]?.estimate;
      const change = Number.isFinite(difference) ? signed(difference*(stat.percent ? 100 : 1)) : '—';
      return `<div class="impact-metric ${stat.primary ? 'impact-primary' : ''}"><span class="metric-label">${stat.label}</span><div class="impact-value"><span class="impact-before">${stat.format(before?.[stat.key])}</span><span class="impact-arrow" aria-label="to">→</span><strong>${stat.format(after?.[stat.key])}</strong></div><div class="impact-difference ${deltaClass(difference,stat.lower)}">${change}${stat.percent ? ' pp' : ''}<span>${stat.unit}</span></div>${stat.primary ? `<p class="gain-interval">95% gain interval: ${interval(result?.delta?.net?.confidence95)}</p>` : ''}</div>`;
    }).join('')}</div><div class="impact-synergies">${[['off','Offensive synergy'],['def','Defensive synergy'],['reb','Rebounding synergy']].map(([key,label]) => {
      const a = before?.synergy?.scale100?.[key], b = after?.synergy?.scale100?.[key];
      const change = result?.synergyChange?.[key] ?? (Number.isFinite(a) && Number.isFinite(b) ? b-a : undefined);
      return `<div class="impact-synergy"><div class="impact-synergy-heading"><span>${label}</span><strong class="${deltaClass(change)}">${signed(change)}</strong></div><div class="synergy-comparison"><span>${number(a)} <span aria-label="to">→</span> <strong>${number(b)}</strong> <small>/ 100</small></span><div class="synergy-track ${key}"><div class="synergy-fill" style="width:${Math.max(0,Math.min(100,b ?? 0))}%"></div>${Number.isFinite(a) ? `<span class="synergy-marker" style="left:${Math.max(0,Math.min(100,a))}%" title="Before: ${number(a)}"></span>` : ''}</div></div></div>`;
    }).join('')}</div>`;
    const changes = result?.playerChanges ?? [];
    $('impact-rotation').hidden = !changes.length;
    $('rotation-body').innerHTML = changes.map(p => `<tr><td>${escape(p.name)}</td><td>${escape(p.status)}</td><td>${number(p.beforeMinutes)}</td><td>${number(p.afterMinutes)}</td><td>${signed(p.minutesChange)}</td></tr>`).join('');
    const status = {
      empty:'Select a package to begin', waiting:'Waiting for your edits…', running:'Simulating this package…',
      'make-work':'Finding a counteroffer…', error:'Preview unavailable', cancelled:'Preview paused',
      complete:result ? `${result.gamesPerOpponent ?? result.simulationOptions?.gamesPerOpponent ?? job?.games ?? 4} games / opponent · ${number(result.elapsedSeconds)}s` : 'Preview complete',
    }[impactState];
    $('impact-status').textContent = impactMessage || status || 'Select a package to begin';
    $('impact-status').classList.toggle('working', ['waiting','running','make-work'].includes(impactState));
    $('impact-status').classList.toggle('error-inline', impactState === 'error');
    $('impact-progress').hidden = !['running','make-work'].includes(impactState);
    const pending = ['waiting','running','make-work'].includes(impactState);
    const selectedPickCount = scenario().teams.reduce((sum,t) => sum+t.picks.length,0);
    $('impact-caption').textContent = impactState === 'error' ? impactMessage : result
      ? `Same opponent schedule and automatic rotations for every team before and after. This baseline can differ from the exported rotations in Team overview. ${result.gamesPerOpponent === 4 ? 'Quick preview: refine before comparing close results. ' : ''}Synergy is scaled to the engine ceiling, not a percentile.${selectedPickCount ? ' Picks are included in the deal, but their future value is not scored.' : ''}`
      : pending ? 'You can keep adjusting the deal. Each edit replaces the pending preview; rejected deals can still be evaluated as hypotheticals.'
      : 'Each change runs a quick preview with 4 games per opponent. Refine uses the simulation budget selected above. The markers show synergy before the trade.';
    renderBudget(); applyDisabled();
  }
  function render() {
    renderSummary(); renderAssessment(); renderRosters(); renderImpact(); renderContext();
  }
  async function deleteJob(current) {
    if (!current?.id) return;
    try { await api(`/api/jobs/${current.id}`,{method:'DELETE'}); }
    catch { /* replace:true also cancels the previous job server-side. */ }
  }
  async function cancel({quiet = false} = {}) {
    const rev = ++revision;
    clearTimeout(timer); clearTimeout(pollTimer); checkController?.abort();
    const previous = job; job = null;
    await deleteJob(previous);
    // Wait for a pending creation request before letting overview work begin.
    await creationQueue;
    if (rev === revision && !quiet && !job && ['waiting','running','make-work'].includes(impactState)) {
      impactState = hasAssets() ? 'cancelled' : 'empty'; impactMessage = ''; renderImpact(); onChange();
    }
  }
  function invalidate() {
    revision++; clearTimeout(timer); clearTimeout(pollTimer); checkController?.abort();
    const previous = job; job = null; void deleteJob(previous);
    result = null; assessment = null; impactMessage = '';
    $('make-work-message').hidden = true;
    return revision;
  }
  async function check(rev) {
    const controller = new AbortController(); checkController = controller;
    try {
      const response = await api('/api/trade-check',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sessionId:getSession().sessionId,options:tradeOptions()}),signal:controller.signal});
      if (revision !== rev) return;
      assessment = response.assessment ?? response; renderAssessment(); renderSummary(); applyDisabled();
    } catch (error) {
      if (revision !== rev || error.name === 'AbortError') return;
      $('trade-assessment').innerHTML = `<span class="assessment-error">Could not check this package: ${escape(error.message)}</span>`;
    }
  }
  function refresh({keepMessage = false} = {}) {
    const message = keepMessage ? $('make-work-message').textContent : '';
    const rev = invalidate();
    if (message) { $('make-work-message').textContent = message; $('make-work-message').hidden = false; }
    impactState = hasAssets() ? 'waiting' : 'empty';
    renderSummary(); renderAssessment(); renderImpact(); renderContext(); onChange();
    if (!hasAssets() || disabled) return;
    if (!validOptions()) { impactState = 'error'; impactMessage = 'Correct the trade assumptions to update this preview.'; renderImpact(); return; }
    void check(rev);
    timer = setTimeout(() => { if (rev === revision) void startJob('trade',4,rev); },300);
  }
  function updateProgress(progress = {}) {
    if (!job) return;
    const bar = $('impact-progress').firstElementChild;
    bar.classList.toggle('indeterminate', !progress.total);
    bar.style.width = progress.total ? `${Math.max(3,Math.min(100,100*(progress.completed ?? 0)/progress.total))}%` : '30%';
    $('impact-status').textContent = progress.message ?? (job.type === 'make-work' ? 'Finding a counteroffer…' : `Simulating ${job.games} games / opponent${progress.total ? ` · ${Math.round(100*(progress.completed ?? 0)/progress.total)}%` : ''}`);
  }
  async function startJob(type, games, rev = revision) {
    if (disabled || !hasAssets() || rev !== revision || !validOptions()) return;
    clearTimeout(timer);
    const previous = job; job = null; void deleteJob(previous);
    const current = {type,games,revision:rev,id:null}; job = current;
    impactState = type === 'trade' ? 'running' : 'make-work'; impactMessage = '';
    renderImpact(); updateProgress(); onChange();
    const options = tradeOptions(games);
    if (type === 'make-work') options.excluded = Object.fromEntries(activeTeams().map(t => [t.tid,[...setFor(protectedPlayers,t.tid)]]));
    const sessionId = getSession().sessionId;
    // Serialize creation requests so an old, slow POST cannot replace newer work.
    creationQueue = creationQueue.catch(() => {}).then(async () => {
      if (revision !== rev || job !== current) return;
      try {
        const response = await api('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({sessionId,type,options,replace:true})});
        current.id = response.jobId;
        if (revision !== rev || job !== current) { await deleteJob(current); return; }
        void poll(current);
      } catch (error) { if (revision === rev && job === current) failJob(error); }
    });
    await creationQueue;
  }
  function failJob(error) {
    job = null; impactState = 'error'; impactMessage = error.message || String(error);
    renderImpact(); onChange();
  }
  async function poll(current) {
    if (job !== current || revision !== current.revision) return;
    try {
      const response = await api(`/api/jobs/${current.id}`);
      if (job !== current || revision !== current.revision) return;
      updateProgress(response.progress);
      if (response.status === 'running') { pollTimer = setTimeout(() => void poll(current),250); return; }
      job = null;
      if (response.status === 'failed') throw new Error(response.error || 'This preview could not be completed.');
      if (response.status !== 'complete') { impactState = 'cancelled'; renderImpact(); onChange(); return; }
      if (current.type === 'make-work') { acceptSuggestion(response.result); return; }
      result = {...response.result,gamesPerOpponent:current.games};
      if (result.assessment) assessment = result.assessment;
      impactState = 'complete'; impactMessage = '';
      renderSummary(); renderAssessment(); renderImpact(); onChange();
    } catch (error) {
      if (revision !== current.revision || (job && job !== current)) return;
      await deleteJob(current);
      if (revision !== current.revision || (job && job !== current)) return;
      failJob(error);
    }
  }
  function acceptSuggestion(suggestion) {
    const messages = {
      suggested:'Counteroffer added to the deal. Its team impact is being evaluated.',
      'already-works':'The AI requests no additional players. Transaction rules are checked separately below.',
      unavailable:'The counteroffer needs more trade context. See the details below.',
      'no-deal':'No acceptable player counteroffer was found with these selections and protections.',
    };
    const reasons = [...new Set([...(suggestion.reasons ?? []),...(suggestion.warnings ?? [])])];
    const message = [messages[suggestion.status] ?? 'Counteroffer check completed.',...reasons].join(' ');
    $('make-work-message').textContent = message;
    $('make-work-message').hidden = false;
    if (suggestion.assessment) assessment = suggestion.assessment;
    if (suggestion.status === 'suggested' && suggestion.scenario?.teams?.length === 2) {
      suggestedPlayers = new Set();
      for (const side of suggestion.scenario.teams) {
        const previous = setFor(selected,side.tid);
        for (const pid of side.send) if (!previous.has(pid)) suggestedPlayers.add(pid);
        selected.set(side.tid,new Set(side.send)); picks.set(side.tid,new Set(side.picks ?? []));
      }
      renderRosters(); refresh({keepMessage:true});
    } else {
      impactState = result ? 'complete' : 'cancelled'; impactMessage = '';
      renderAssessment(); renderImpact(); onChange();
      // An interrupted live preview can resume after an unsuccessful negotiation.
      if (!result && hasAssets()) timer = setTimeout(() => void startJob('trade',4),300);
    }
  }
  function reset() {
    invalidate(); selected.clear(); picks.clear(); protectedPlayers.clear(); filters.clear(); sorts.clear();
    suggestedPlayers = new Set(); impactState = 'empty';
    const otherTeams = (getSession()?.teams ?? []).filter(t => t.tid !== selectedTeam()?.tid);
    $('opponent-select').innerHTML = otherTeams.map(t => `<option value="${t.tid}">${escape(t.name)} · ${t.tid}</option>`).join('');
    $('strategy-select').value = ''; $('difficulty-input').value = ''; $('trade-phase-select').value = '';
    render();
  }

  $('opponent-select').addEventListener('change',() => {
    for (const [tid] of selected) if (tid !== selectedTeam().tid) selected.delete(tid);
    for (const [tid] of picks) if (tid !== selectedTeam().tid) picks.delete(tid);
    $('strategy-select').value = ''; suggestedPlayers = new Set(); renderRosters(); refresh();
  });
  $('trade-rosters').addEventListener('input',event => {
    if (event.target.dataset.filter === undefined) return;
    const tid = Number(event.target.dataset.filter); filters.set(tid,event.target.value); renderRosterBody(tid);
  });
  $('trade-rosters').addEventListener('change',event => {
    const input = event.target;
    if (input.dataset.sort !== undefined) { const tid = Number(input.dataset.sort); sorts.set(tid,input.value); renderRosterBody(tid); return; }
    if (!input.dataset.action) return;
    const tid = Number(input.dataset.tid), id = Number(input.dataset.id), checked = input.checked;
    const map = input.dataset.action === 'pick' ? picks : input.dataset.action === 'protect' ? protectedPlayers : selected;
    if (checked) setFor(map,tid).add(id); else setFor(map,tid).delete(id);
    if (checked && map === selected) setFor(protectedPlayers,tid).delete(id);
    if (checked && map === protectedPlayers) setFor(selected,tid).delete(id);
    suggestedPlayers = new Set(); renderRosters(); refresh();
  });
  $('trade-summary').addEventListener('click',event => {
    const button = event.target.closest('[data-remove]'); if (!button || disabled) return;
    setFor(button.dataset.remove === 'pick' ? picks : selected,Number(button.dataset.tid)).delete(Number(button.dataset.id));
    suggestedPlayers = new Set(); renderRosters(); refresh();
  });
  $('clear-trade-button').addEventListener('click',() => {
    selected.clear(); picks.clear(); protectedPlayers.clear(); suggestedPlayers = new Set(); renderRosters(); refresh();
  });
  for (const id of ['trade-phase-select','difficulty-input','strategy-select']) $(id).addEventListener('change',() => refresh());
  $('make-work-button').addEventListener('click',() => {
    if (!validOptions()) return;
    const rev = ++revision; clearTimeout(timer); clearTimeout(pollTimer); checkController?.abort();
    $('make-work-message').hidden = true;
    void startJob('make-work',4,rev);
  });
  $('refine-trade-button').addEventListener('click',() => {
    const rev = ++revision; clearTimeout(timer); checkController?.abort();
    void startJob('trade',Number($('games-select').value),rev);
  });
  $('cancel-trade-button').addEventListener('click',() => void cancel());

  return {reset,refresh,render,renderContext,renderBudget,cancel,report:() => result,
    setDisabled:value => { disabled = value; applyDisabled(); },isBusy:() => !!job};
}
