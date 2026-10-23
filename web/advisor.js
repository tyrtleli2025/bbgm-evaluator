export function createAdvisor({$,escape,number,money,getSession,selectedTeam,onChange,onRun,onOpen}) {
 let result=null;const protectedPids=new Set();
 const signed=v=>`${v>0?'+':''}${number(v)}`;
 function clear(){result=null;$('advisor-results').innerHTML='';onChange();}
 function reset(){
  protectedPids.clear();$('advisor-no-releases').checked=false;
  $('advisor-protected').innerHTML=(selectedTeam()?.players??[]).map(p=>`<label><input type="checkbox" data-protect-pid="${p.pid}"> ${escape(p.name)} · OVR ${p.ovr}</label>`).join('');
  const ctx=getSession()?.tradeContext;
  $('advisor-context').textContent=ctx?.hasReleasedPlayers?'Released-player obligations are included in this export.': 'This export omits released-player salaries. Import a full snapshot using the Trade builder’s collector, or explicitly select the zero-obligations assumption below if it is correct.';
  clear();
 }
 function show(r){result=r;
  const block=(title,text)=>`<article class="panel series-config"><h3>${escape(title)}</h3><p>${escape(text)}</p></article>`;
  $('advisor-results').innerHTML=block(r.status==='complete'?'Your trade shortlist':r.status==='no-upgrade'?'Keep the current roster':r.status==='needs-context'?'More league context needed':'Search completed',r.message)+
   block('Search coverage',`${r.stats.sampled} packages checked · ${r.stats.negotiated} target negotiations · ${r.stats.accepted} accepted and legal packages · ${r.candidates.length} simulated finalists · ${number(r.elapsedSeconds)}s. ${r.assumptions.join(' ')}`)+
   r.candidates.map((c,i)=>{
    const yrs=c.yearly, future=yrs.slice(1).reduce((s,y)=>s+y.contract.estimate,0)/4;
    return `<article class="panel series-config"><div class="panel-header"><h3>${i+1}. Trade with ${escape(c.transfers[1].name)}</h3><span class="pill">${c.conditional?'Conditional on assumptions':'Model accepted'}</span></div>
    <p>${c.labels.map(l=>`<span class="pill">${escape(l)}</span>`).join(' ')}</p>
    <div class="advisor-packages">${c.transfers.map((side,j)=>`<div><strong>${j?'You receive':'You send'}</strong><ul>${side.players.length?side.players.map(p=>`<li>${escape(p.name)} · age ${p.age} · OVR ${p.ovr}<br><small>${money(p.contract.amount)} / year through ${p.contract.exp}</small></li>`).join(''):'<li>No players</li>'}</ul></div>`).join('')}</div>
    <p><strong>${signed(c.score.estimate)} weighted contract-based impact</strong> · 95% interval: ${signed(c.score.confidence95[0])} to ${signed(c.score.confidence95[1])}. ${c.score.confidence95[0]<=0?'The estimated improvement is inconclusive.':'Positive within this simulation sample.'}</p>
    <p>This season: ${signed(c.immediate)}. Average future impact: ${signed(future)}. If everyone is retained, weighted impact is ${signed(c.retained.estimate)}. Values are changes in net points per 100 possessions; payroll is shown separately.</p>
    <div class="table-scroll"><table><thead><tr><th>Season</th><th>Contract-based Δ</th><th>If retained Δ</th><th>Committed before</th><th>Committed after</th><th>Change</th><th>Players under contract</th></tr></thead><tbody>${yrs.map(y=>`<tr><td>${y.season}</td><td>${signed(y.contract.estimate)}</td><td>${signed(y.retained.estimate)}</td><td>${money(y.before)}</td><td>${money(y.after)}</td><td>${money(y.change)}</td><td>${y.retainedBefore} → ${y.retainedAfter}</td></tr>`).join('')}</tbody></table></div>
    <p class="series-note">Partner AI accepts and transaction rules pass under the evaluated inputs. ${escape(c.assessment.details.assumptions.join(' '))} ${c.conditional?'Recheck cap assumptions in the game; the trade builder will use the original snapshot.':''}</p><button class="button button-secondary" data-open-advisor="${i}">Open in trade builder</button></article>`;
   }).join('');onChange();
 }
 for(const id of ['advisor-window','advisor-budget','advisor-salary','advisor-coaching','advisor-health','advisor-seed','advisor-no-releases'])$(id).addEventListener('change',clear);
 $('advisor-protected').addEventListener('change',e=>{if(!e.target.dataset.protectPid)return;const pid=Number(e.target.dataset.protectPid);e.target.checked?protectedPids.add(pid):protectedPids.delete(pid);clear();});
 $('advisor-run').addEventListener('click',()=>{if(['advisor-salary','advisor-coaching','advisor-seed'].every(id=>$(id).reportValidity()))onRun();});
 $('advisor-results').addEventListener('click',e=>{const b=e.target.closest('[data-open-advisor]');if(b)onOpen(result.candidates[Number(b.dataset.openAdvisor)].scenario);});
 return {reset,clear,show,report:()=>result,options:()=>({teamId:selectedTeam().tid,window:$('advisor-window').value,budget:Number($('advisor-budget').value),seed:Number($('advisor-seed').value),coaching:Number($('advisor-coaching').value),health:$('advisor-health').value,protectedPids:[...protectedPids],assumeNoReleased:$('advisor-no-releases').checked,maxAnnualIncrease:$('advisor-salary').value===''?null:Number($('advisor-salary').value)*1000}),setDisabled:value=>{for(const el of document.querySelectorAll('#advisor-view input,#advisor-view select,#advisor-view button'))el.disabled=value;}};
}
