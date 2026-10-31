export function createDraft({$,escape,number,getSession,selectedTeam,onChange,onRun}) {
  let result=null,focusedPid=null,disabled=false,sortDirection='ascending';
  let marksSession=null;
  const drafted=new Set();
  const defaultDirection=sort=>['name','age'].includes(sort)?'ascending':'descending';
  const n=v=>number(v,1),signed=v=>`${v>0?'+':''}${n(v)}`,percent=v=>`${n(100*v)}%`;
  const searchText=value=>value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase();
  const board=()=>getSession()?.prospects?.filter(p=>p.year===Number($('draft-year').value))??[];
  const fit=p=>p.scoreConfidence95[0]>0?'Positive signal':p.scoreConfidence95[1]<0?'Negative signal':'Unclear signal';
  function renderBoard() {
    const results=new Map(result?.results.map(p=>[p.pid,p])??[]);
    const query=searchText($('draft-search').value.trim());
    const sort=$('draft-sort').value;
    for(const button of document.querySelectorAll('[data-draft-sort]')) {
      const active=button.dataset.draftSort===sort;
      if(active)button.closest('th').setAttribute('aria-sort',sortDirection);
      else button.closest('th').removeAttribute('aria-sort');
      button.querySelector('[data-sort-indicator]').textContent=active?(sortDirection==='ascending'?'↑':'↓'):'↕';
      const next=active?(sortDirection==='ascending'?'descending':'ascending'):defaultDirection(button.dataset.draftSort);
      button.title=`Sort ${next}`;
    }
    const rows=board().map(p=>results.get(p.pid)??p)
      .filter(p=>!$('draft-hide-drafted').checked||!drafted.has(p.pid))
      .filter(p=>searchText(`${p.name} ${p.position??''}`).includes(query))
      .sort((a,b)=>{
        const direction=sortDirection==='ascending'?1:-1;
        if(sort==='name')return direction*a.name.localeCompare(b.name)||a.pid-b.pid;
        const value=p=>sort==='impact'?p.score:sort==='upside60'?p.upside?.chance60:sort==='upside70'?p.upside?.chance70:sort==='future'?p.years?.[4].ovr:sort==='age'?p.age:p.ovr;
        const av=value(a),bv=value(b);
        // Keep unavailable projections below known values in either direction.
        if(av==null&&bv!=null)return 1;
        if(bv==null&&av!=null)return -1;
        return direction*((av??0)-(bv??0))||a.name.localeCompare(b.name)||a.pid-b.pid;
      });
    $('draft-board').innerHTML=rows.map(p=>`<tr class="${p.pid===focusedPid?'draft-focused ':''}${drafted.has(p.pid)?'draft-taken':''}">
      <td><input type="checkbox" data-drafted="${p.pid}" aria-label="Mark ${escape(p.name)} as drafted" ${drafted.has(p.pid)?'checked':''} ${disabled?'disabled':''}></td>
      <td>${results.has(p.pid)?`<button class="draft-player draft-player-name" data-prospect="${p.pid}" aria-pressed="${p.pid===focusedPid}" ${disabled?'disabled':''}>${escape(p.name)}</button>`:`<span class="draft-player-name">${escape(p.name)}</span>`}<small class="draft-position">${escape(p.position??'')} · ID ${p.pid}${drafted.has(p.pid)?' · Drafted':''}</small></td>
      <td>${p.age}</td><td>${p.ovr}</td><td>${p.years?n(p.years[4].ovr):'—'}</td>
      <td>${p.upside?percent(p.upside.chance60):'—'}</td><td>${p.upside?percent(p.upside.chance70):'—'}</td>
      <td>${p.years?`${signed(p.score)}<small class="draft-position">${fit(p)}</small>`:'—'}</td>
      </tr>`).join('')||'<tr><td colspan="8">No matching prospects. Adjust your search or show drafted players.</td></tr>';
    const marked=board().filter(p=>drafted.has(p.pid)).length;
    const counts=`${rows.length} of ${board().length} prospects shown · ${marked} marked drafted · ${board().length-marked} remaining.`;
    const currentYear=Number($('draft-year').value)===getSession()?.season;
    $('draft-selection-note').textContent=!board().length?'No eligible prospects in this export. Import a full league containing undrafted players with complete ratings.':!currentYear?'Import a snapshot in this draft class’s year to evaluate team fit.':result?`${counts} Click a name for the five-season breakdown. Searching and sorting use the completed evaluation.`:`${counts} Evaluate the entire class once, then look up any player still available in your game. Search and drafted marks do not limit the evaluation.`;
    $('draft-clear-marks').disabled=disabled||marked===0;
    $('draft-run').disabled=disabled||!currentYear||!board().length;
    $('draft-run').textContent=result?'Re-evaluate available class':'Evaluate available class';
  }
  function renderDetail() {
    const p=result?.results.find(p=>p.pid===focusedPid);
    if(!p){$('draft-results').innerHTML='';return;}
    const early=(p.years[0].impact+p.years[1].impact)/2,later=(p.years[3].impact+p.years[4].impact)/2;
    const explanation=fit(p)==='Positive signal'?'The sampled team-impact interval is above zero.':fit(p)==='Negative signal'?'The sampled team-impact interval is below zero.':'The sampled team-impact interval includes zero; the fit estimate is inconclusive.';
    $('draft-results').innerHTML=`<article class="panel series-config" aria-labelledby="draft-player-heading">
      <h3 id="draft-player-heading">${escape(p.name)} <span class="pill">${escape(p.position??'')} · Age ${p.age}</span>${drafted.has(p.pid)?' <span class="pill">Marked drafted</span>':''}</h3>
      <div class="draft-outlook">
        <div><span class="section-kicker">FIT FOR YOUR TEAM</span><strong>${signed(p.score)}</strong><p>Weighted net points per 100 possessions added. ${explanation} 95% sampling interval: ${signed(p.scoreConfidence95[0])} to ${signed(p.scoreConfidence95[1])}.</p></div>
        <div><span class="section-kicker">FUTURE CONTRIBUTION</span><strong>${signed(later)}</strong><p>Mean team impact in years 4–5; ${signed(early)} in years 1–2. Projected year-5 OVR: ${n(p.years[4].ovr)}.</p></div>
        <div><span class="section-kicker">DEVELOPMENT UPSIDE</span><strong>${percent(p.upside.chance60)}</strong><p>Chance of reaching 60+ OVR within five seasons. Chance of 70+: ${percent(p.upside.chance70)}. Mean peak OVR in that period: ${n(p.upside.peakOVR)}; 80% range ${p.upside.peakRange80.join('–')}.</p></div>
      </div>
      <p>Fit compares your projected roster with and without this player. A strong prospect may add little to an already strong rotation. The 60/70 thresholds describe ratings, not guaranteed awards or a career ceiling.</p>
      <div class="table-scroll"><table><thead><tr><th>Season after draft</th><th>Mean OVR</th><th>80% development range</th><th>Chance OVR ≥ 50</th><th>Chance OVR ≥ 60</th><th>Chance OVR ≥ 70</th><th>Minutes</th><th>Team impact</th><th>Δ Off synergy</th><th>Δ Def synergy</th><th>Δ Reb synergy</th></tr></thead><tbody>${p.years.map(y=>`<tr><td>${y.year}</td><td>${n(y.ovr)}</td><td>${y.ovrRange80.join('–')}</td><td>${percent(y.rotationProbability)}</td><td>${percent(y.starProbability)}</td><td>${percent(y.eliteProbability)}</td><td>${n(y.minutes)}</td><td>${signed(y.impact)}</td><td>${signed(y.synergy.off)}</td><td>${signed(y.synergy.def)}</td><td>${signed(y.synergy.reb)}</td></tr>`).join('')}</tbody></table></div>
      <p class="series-note">${result.paths} development paths per prospect; ${result.fitPaths} shared team scenarios. Year 1 is the first preseason after the draft. All current players are retained, healthy, and automatically rotated. Contracts, future transactions, and retirement are not modeled.</p>
    </article>`;
  }
  function clear() {
    result=null;focusedPid=null;$('draft-summary').textContent='';renderDetail();renderBoard();onChange();
  }
  function reset() {
    if(marksSession!==getSession()?.sessionId) {
      marksSession=getSession()?.sessionId;drafted.clear();$('draft-hide-drafted').checked=false;
    }
    const years=[...new Set(getSession()?.prospects?.map(p=>p.year)??[])];
    $('draft-year').innerHTML=years.map(y=>`<option>${y}</option>`).join('');
    if(years.includes(getSession()?.season))$('draft-year').value=String(getSession().season);
    $('draft-search').value='';$('draft-sort').value='name';sortDirection='ascending';clear();
  }
  function show(r) {
    result=r;focusedPid=null;
    $('draft-summary').textContent=`Evaluated ${r.results.length} prospects in ${n(r.elapsedSeconds)}s. Chances of 60+/70+ OVR mean reaching that rating at least once within five post-draft seasons. Team-impact signals use 95% sampling intervals; close differences can be noise. Choose a name to see details.`;
    renderBoard();renderDetail();onChange();
  }
  $('draft-year').addEventListener('change',()=>{$('draft-search').value='';clear();});
  $('draft-search').addEventListener('input',renderBoard);
  $('draft-hide-drafted').addEventListener('change',()=>{
    if($('draft-hide-drafted').checked&&drafted.has(focusedPid))focusedPid=null;
    renderBoard();renderDetail();
  });
  $('draft-clear-marks').addEventListener('click',()=>{
    for(const p of board())drafted.delete(p.pid);
    renderBoard();renderDetail();
  });
  $('draft-board').addEventListener('change',e=>{
    const input=e.target.closest('[data-drafted]');if(!input||disabled)return;
    const pid=Number(input.dataset.drafted);
    if(input.checked)drafted.add(pid);else drafted.delete(pid);
    if($('draft-hide-drafted').checked&&drafted.has(focusedPid))focusedPid=null;
    renderBoard();renderDetail();
    $('draft-board').querySelector(`[data-drafted="${pid}"]`)?.focus({preventScroll:true});
  });
  $('draft-sort').addEventListener('change',()=>{sortDirection=defaultDirection($('draft-sort').value);renderBoard();});
  $('draft-board-headers').addEventListener('click',e=>{
    const button=e.target.closest('[data-draft-sort]');if(!button||disabled)return;
    const sort=button.dataset.draftSort;
    sortDirection=$('draft-sort').value===sort?(sortDirection==='ascending'?'descending':'ascending'):defaultDirection(sort);
    $('draft-sort').value=sort;renderBoard();
  });
  $('draft-board').addEventListener('click',e=>{
    const button=e.target.closest('[data-prospect]');if(!button||disabled)return;
    focusedPid=Number(button.dataset.prospect);renderBoard();renderDetail();
    $('draft-results').scrollIntoView({behavior:'smooth',block:'start'});
  });
  for(const id of ['draft-coaching','draft-window'])$(id).addEventListener('change',clear);
  $('draft-run').addEventListener('click',()=>{if($('draft-coaching').reportValidity())onRun();});
  return {reset,clear,show,report:()=>result,
    options:()=>({teamId:selectedTeam().tid,year:Number($('draft-year').value),window:$('draft-window').value,coaching:Number($('draft-coaching').value),seed:12345}),
    setDisabled:value=>{disabled=value;for(const el of document.querySelectorAll('#draft-view input,#draft-view select,#draft-view button'))el.disabled=disabled;renderBoard();},
  };
}
