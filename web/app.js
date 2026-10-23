import { createAdvisor } from './advisor.js';
import { createDraft } from './draft.js';
import { createTradeBuilder } from './trade-builder.js';
import { createPlayoffSeries } from './playoff-series.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '—';
const signed = n => Number.isFinite(n) ? `${n > 0 ? '+' : ''}${number(n)}` : '—';
const interval = values => values?.length === 2 ? `${signed(values[0])} to ${signed(values[1])}` : '—';
const money = amount => Number.isFinite(amount) ? `$${number(amount / 1000, 2)}M` : '—';
const synergyLabels = {off:'Offensive synergy', def:'Defensive synergy', reb:'Rebounding synergy'};
const skillLabels = {'3':'Shooting', A:'Athleticism', B:'Handling', Di:'Interior D', Dp:'Perimeter D', Po:'Post play', Ps:'Passing', R:'Rebounding'};
const state = { session:null, tab:'overview', evaluation:null, job:null, importing:false, version:0 };
let pollTimer;

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function showError(error) { $('error-banner').textContent = error?.message ?? String(error); $('error-banner').hidden = false; }
function clearError() { $('error-banner').hidden = true; }
function selectedTeam() { return state.session?.teams.find(t => t.tid === Number($('team-select').value)); }
function teamName(tid) { return state.session?.teams.find(t => t.tid === tid)?.name ?? `Team ${tid}`; }
function report() { return state.tab === 'overview' ? state.evaluation : state.tab === 'series' ? playoffs.report() : state.tab === 'draft' ? draft.report() : state.tab === 'advisor' ? advisor.report() : builder.report(); }
function setBusy() {
  const busy = !!state.job || state.importing;
  for (const id of ['import-button','empty-import-button','team-select','evaluate-button','phase-select','health-select','games-select','seed-input']) {
    $(id).disabled = busy || (!state.session && !['import-button','empty-import-button'].includes(id));
  }
  builder.setDisabled(busy || !state.session || state.tab !== 'trade');
  advisor.setDisabled(busy || !state.session || state.tab !== 'advisor');
  draft.setDisabled(busy || !state.session || state.tab !== 'draft');
  playoffs.setDisabled(busy || !state.session || state.tab !== 'series');
  $('download-button').disabled = busy || !report();
  $('job-panel').hidden = !state.job;
  $('cancel-button').disabled = false;
  $('import-button').textContent = state.importing ? 'Reading league…' : '＋ Import league';
}
function switchTab(tab) {
  if (state.tab === 'series' && tab !== 'series') void playoffs.cancel();
  if (state.tab === 'trade' && tab !== 'trade') void builder.cancel();
  state.tab = tab;
  for (const item of document.querySelectorAll('[data-tab]')) {
    item.classList.toggle('active', item.dataset.tab === tab);
    if (item.dataset.tab === tab) item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current');
  }
  $('overview-view').hidden = tab !== 'overview'; $('trade-view').hidden = tab !== 'trade';
  $('series-view').hidden = tab !== 'series'; $('draft-view').hidden = tab !== 'draft'; $('advisor-view').hidden = tab !== 'advisor'; $('analysis-toolbar').hidden = ['series','draft','advisor'].includes(tab);
  $('view-label').textContent = tab === 'overview' ? 'Team overview' : tab === 'series' ? 'Playoff matchup' : tab === 'draft' ? 'Draft prospects' : tab === 'advisor' ? 'Trade advisor' : 'Trade builder';
  renderWarnings(); setBusy();
}
function clearResults() {
  state.evaluation = null; builder.reset(); playoffs.reset(); draft.reset(); advisor.reset();
  renderEvaluation(); renderWarnings(); setBusy();
}
function renderTeam() {
  const team = selectedTeam(); if (!team) return;
  $('team-title').textContent = team.name;
  $('team-subtitle').textContent = `Your roster in focus. ${team.players.slice().sort((a,b) => b.ovr-a.ovr).slice(0,3).map(p => p.name).join(' · ')}`;
  $('season-label').textContent = `${state.session.season} SEASON / ${team.abbrev}`;
  $('team-meta').hidden = false;
  $('team-meta').textContent = `${team.players.length} players  ·  ${state.session.teams.length} teams  ·  ${state.session.tradeContext.phaseLabel}`;
  $('league-label').textContent = state.session.filename;
  $('league-detail').textContent = `${state.session.season} season · ${state.session.teams.length} teams`;
  $('roster-count').textContent = team.players.length;
  builder.renderContext(); renderRoster();
}
function renderRoster() {
  const team = selectedTeam(); if (!team) return;
  const stats = new Map((state.evaluation?.teams?.[0]?.players ?? []).map(p => [p.pid,p]));
  $('roster-body').innerHTML = team.players.slice().sort((a,b) => (b.ovr ?? b.valueNoPot)-(a.ovr ?? a.valueNoPot)).map(p => {
    const stat = stats.get(p.pid), initials = p.name.split(' ').map(n => n[0]).slice(0,2).join('');
    return `<tr><td><div class="player-cell"><span class="player-initials">${escape(initials)}</span><div><span class="player-name">${escape(p.name)}</span>${p.injury?.gamesRemaining > 0 ? `<span class="injury-label">${escape(p.injury.gamesRemaining)} games injured</span>` : ''}<span class="player-skills">PID ${p.pid}${p.skills?.length ? ` · ${escape(p.skills.join(' · '))}` : ''}</span></div></div></td><td>${escape(p.pos)}</td><td>${number(p.age,0)}</td><td><span class="rating-badge ${p.ovr >= 65 ? 'elite' : p.ovr < 45 ? 'low' : ''}">${number(p.ovr,0)}</span></td><td>${number(p.pot,0)}</td><td>${money(p.salary)}</td><td>${number(stat?.min)}</td><td>${number(stat?.pts)}</td></tr>`;
  }).join('');
}
function renderEvaluation() {
  const result = state.evaluation, team = result?.teams?.[0];
  $('strength-value').textContent = signed(team?.strength);
  $('strength-detail').textContent = team ? `95% interval: ${interval(team.strengthConfidence95)}` : 'Above zero means better than the field';
  $('offense-value').textContent = number(team?.offensiveRating);
  $('defense-value').textContent = number(team?.defensiveRating);
  $('win-value').textContent = team ? `${number(team.winRate*100)}%` : '—';
  $('evaluation-meta').textContent = result ? `${team.games.toLocaleString()} games · ${number(result.elapsedSeconds)}s · ${result.phase === 'playoffs' ? 'Playoffs' : 'Regular season'}` : 'Run an evaluation to see your results';
  $('synergy-bars').innerHTML = Object.entries(synergyLabels).map(([key,label]) => {
    const value = team?.synergy?.scale100[key], opponent = team?.synergy?.opponentAverageScale100[key];
    return `<div class="${team ? '' : 'synergy-empty'}"><div class="synergy-title"><span>${label}</span><strong>${number(value)} <em>/ 100</em></strong></div><div class="synergy-track ${key}" role="img" aria-label="${label}: ${number(value)}; opponent average ${number(opponent)}"><div class="synergy-fill" style="width:${Math.max(0,Math.min(100,value ?? 0))}%"></div><span class="synergy-marker" style="left:${Math.max(0,Math.min(100,opponent ?? 0))}%"></span></div><div class="synergy-compare">${team ? `${signed(value-opponent)} vs. opponents’ average (${number(opponent)})` : 'Evaluate your team to measure lineup fit'}</div></div>`;
  }).join('');
  $('skill-counts').className = 'skill-counts';
  $('skill-counts').innerHTML = team ? Object.entries(skillLabels).map(([key,label]) => `<span>${label}<strong>${number(team.synergy.fractionalSkills[key],2)}</strong></span>`).join('') : '';
  if (team) {
    const gaps = Object.keys(synergyLabels).map(key => ({key,gap:team.synergy.scale100[key]-team.synergy.opponentAverageScale100[key]})).sort((a,b) => a.gap-b.gap);
    const weakest = gaps[0];
    $('insight-title').textContent = weakest.gap < 0 ? `${synergyLabels[weakest.key]} has room to grow.` : 'Your combinations compare well.';
    $('insight-copy').textContent = weakest.gap < 0 ? `It is ${number(-weakest.gap)} points below the opponents’ average on the synergy scale. Use this as a clue for players to investigate; test a trade’s full impact before deciding.` : 'All three synergy measures meet or exceed the opponents’ average. A stronger player can still help, but check the complete team result.';
  } else {
    $('insight-title').textContent = 'Find the missing piece.';
    $('insight-copy').textContent = 'Evaluate your roster to see how its on-court combinations compare with the rest of the league.';
  }
  renderRoster();
}
function renderWarnings() {
  const messages = report()?.warnings ?? state.session?.warnings ?? [];
  $('warnings-panel').hidden = !messages.length;
  $('warnings-summary').textContent = `Model notes & assumptions (${messages.length})`;
  $('warnings-list').innerHTML = messages.map(w => `<li>${escape(w)}</li>`).join('');
}
async function importFile(file) {
  if (!file || state.importing || state.job) return;
  clearError(); state.importing = true; setBusy();
  try {
    await builder.cancel();
    await playoffs.cancel();
    const imported = await api('/api/import', {method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(file.name)},body:file});
    state.session = imported; state.version++;
    $('team-select').innerHTML = imported.teams.map(t => `<option value="${t.tid}">${escape(t.name)}</option>`).join('');
    $('team-select').value = String(imported.teamId);
    $('trade-phase-select').value = '';
    $('import-empty').hidden = true; $('workspace').hidden = false;
    clearResults(); renderTeam(); switchTab('overview');
  } catch (error) { showError(error); }
  finally { state.importing = false; $('league-file').value = ''; setBusy(); }
}
function jobOptions() {
  return {teamId:selectedTeam().tid,phase:$('phase-select').value,health:$('health-select').value,
    gamesPerOpponent:Number($('games-select').value),seed:Number($('seed-input').value)};
}
function updateProgress(progress = {}) {
  $('job-message').textContent = progress.message ?? (progress.total ? `${progress.completed ?? 0} / ${progress.total} completed` : progress.stage ?? 'Working…');
  const bar = $('job-progress');
  bar.classList.toggle('indeterminate', !progress.total);
  bar.style.width = progress.total ? `${Math.max(2,Math.min(100,100*(progress.completed ?? 0)/progress.total))}%` : '30%';
}
async function startJob(type) {
  if (!state.session || state.job || state.importing) return;
  if (!$('seed-input').reportValidity()) return;
  clearError(); state.job = {id:null,type,version:state.version};
  if(type === 'advisor') advisor.clear(); else if(type === 'draft') draft.clear(); else { state.evaluation = null; renderEvaluation(); }
  switchTab(['draft','advisor'].includes(type) ? type : 'overview');
  $('job-title').textContent = type === 'draft' ? 'Projecting draft prospects' : type === 'advisor' ? 'Finding trades for your future' : 'Analyzing your team';
  updateProgress(); setBusy();
  const job = state.job;
  try {
    await builder.cancel();
    await playoffs.cancel();
    if (state.job !== job) return;
    const response = await api('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:state.session.sessionId,type,options:type === 'draft' ? draft.options() : type === 'advisor' ? advisor.options() : jobOptions()})});
    job.id = response.jobId;
    if (state.job !== job) { await api(`/api/jobs/${job.id}`,{method:'DELETE'}); return; }
    pollJob(job);
  } catch (error) { if (state.job === job) { state.job = null; showError(error); setBusy(); } }
}
async function pollJob(job) {
  if (state.job !== job) return;
  try {
    const response = await api(`/api/jobs/${job.id}`);
    if (state.job !== job) return;
    updateProgress(response.progress);
    if (response.status === 'running') { pollTimer = setTimeout(() => pollJob(job),300); return; }
    state.job = null;
    if (response.status === 'failed') throw new Error(response.error || 'This run could not be completed');
    if (response.status === 'complete' && job.version === state.version) {
      if(job.type === 'advisor') advisor.show(response.result); else if(job.type === 'draft') draft.show(response.result); else { state.evaluation = response.result; renderEvaluation(); }
    }
    renderWarnings(); setBusy();
  } catch (error) {
    // Do not abandon a still-running worker on a transient polling failure.
    if (state.job && state.job !== job) return;
    if (state.job === job && job.id) {
      try { await api(`/api/jobs/${job.id}`,{method:'DELETE'}); } catch { /* reconnect/restart may be necessary */ }
    }
    state.job = null; showError(error); setBusy();
  }
}
async function cancelJob() {
  const job = state.job; if (!job) return;
  $('cancel-button').disabled = true;
  clearTimeout(pollTimer);
  try {
    if (job.id) await api(`/api/jobs/${job.id}`,{method:'DELETE'});
    state.job = null; setBusy();
  } catch (error) { showError(error); $('cancel-button').disabled = false; pollTimer = setTimeout(() => pollJob(job),500); }
}
function downloadReport() {
  const result = report(); if (!result) return;
  const blob = new Blob([JSON.stringify(result,null,2)],{type:'application/json'}), url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `bbgm-${state.session.season}-team${selectedTeam().tid}-${state.tab === 'overview' ? 'evaluation' : state.tab}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}

const builder = createTradeBuilder({
  $, api, escape, number, signed, interval, money, selectedTeam, teamName,
  getSession:() => state.session, getOptions:jobOptions,
  onChange:() => { renderWarnings(); setBusy(); },
});
const playoffs = createPlayoffSeries({
  $, api, escape, number, selectedTeam, getSession:() => state.session,
  onTeamChange:tid => { $('team-select').value = String(tid); $('team-select').dispatchEvent(new Event('change')); },
  onChange:() => { renderWarnings(); setBusy(); },
  beforeRun:() => builder.cancel(),
});

const draft = createDraft({$,escape,number,getSession:()=>state.session,selectedTeam,onChange:()=>{renderWarnings();setBusy();},onRun:()=>startJob('draft')});

const advisor = createAdvisor({$,escape,number,money,getSession:()=>state.session,selectedTeam,onChange:()=>{renderWarnings();setBusy();},onRun:()=>startJob('advisor'),onOpen:scenario=>{switchTab('trade');builder.loadScenario(scenario);window.scrollTo({top:0,behavior:'smooth'});}});

$('import-button').addEventListener('click',() => $('league-file').click());
$('empty-import-button').addEventListener('click',() => $('league-file').click());
$('league-file').addEventListener('change',event => importFile(event.target.files[0]));
for (const eventName of ['dragenter','dragover']) document.addEventListener(eventName,event => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); $('import-empty').classList.add('drag-over'); }
});
document.addEventListener('dragleave',() => $('import-empty').classList.remove('drag-over'));
document.addEventListener('drop',event => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault(); $('import-empty').classList.remove('drag-over'); importFile(event.dataTransfer.files[0]);
});
$('team-select').addEventListener('change',() => { state.version++; clearError(); clearResults(); renderTeam(); });
for (const item of document.querySelectorAll('[data-tab]')) item.addEventListener('click',() => switchTab(item.dataset.tab));
$('open-trade-button').addEventListener('click',() => { switchTab('trade'); window.scrollTo({top:0,behavior:'smooth'}); });
$('evaluate-button').addEventListener('click',() => startJob('evaluate'));
$('cancel-button').addEventListener('click',cancelJob);
$('download-button').addEventListener('click',downloadReport);
for (const id of ['phase-select','health-select','seed-input']) $(id).addEventListener('change',() => {
  state.version++; state.evaluation = null; renderEvaluation(); builder.refresh(); renderWarnings(); setBusy();
});
$('games-select').addEventListener('change',() => {
  state.version++; state.evaluation = null; renderEvaluation(); builder.renderBudget(); renderWarnings(); setBusy();
});
renderEvaluation(); builder.render(); setBusy();
