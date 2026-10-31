(() => {
 const host=document.createElement('aside');host.id='courtside-live-panel';
 const root=host.attachShadow({mode:'open'});
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=v=>Number.isFinite(v)?v.toFixed(1):'—';
 let collapsed=false,wide=false,busy=false,lastPath='',lastData='',lastSuccess=0,result=null,choice='current';
 const mode=()=>/^\/l\/\d+\/player\/\d+\/?$/.test(location.pathname)?'player':/^\/l\/\d+\/trade\/?$/.test(location.pathname)?'trade':/^\/l\/\d+\/roster(?:\/[^/]+)?(?:\/\d+)?\/?$/.test(location.pathname)?'roster':null;
 root.innerHTML=`<style>
 :host{position:fixed;right:12px;top:68px;width:304px;max-width:calc(100vw - 24px);z-index:1040;color:#dee2e6;font:12px/1.4 system-ui,sans-serif;color-scheme:dark}
 *{box-sizing:border-box}[hidden]{display:none!important}.panel{background:#202428;border:1px solid #495057;box-shadow:0 3px 12px #0004}header{display:flex;align-items:center;gap:5px;padding:7px 9px;border-bottom:1px solid #495057}h2{font-size:12px;flex:1;margin:0;font-weight:600}button,select{font:inherit;color:inherit;border:1px solid #495057;border-radius:0;background:#292e33;padding:3px 6px;cursor:pointer}button:hover{background:#3b4249}button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #8bb9fe;outline-offset:2px}#panel-body{padding:8px;max-height:calc(100dvh - 125px);overflow:auto}p{margin:5px 0}small,.muted{color:#adb5bd;font-size:10px}.status{margin:0 0 5px;color:#adb5bd;font-size:10px}.team{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}table{border-collapse:collapse;width:100%;font-size:11px}td,th{padding:5px 3px;text-align:right;border-bottom:1px solid #383e44}th{font-weight:500;color:#adb5bd}td:first-child,th:first-child{text-align:left}.up{color:#75b798}.down{color:#ea868f}.scroll{overflow:auto}.skills{min-width:550px}.skills td:first-child,.skills th:first-child{position:sticky;left:0;background:#202428;min-width:110px}.skills tbody tr:last-child{font-weight:700}.totals{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:8px 0}.totals span{display:flex;justify-content:space-between;color:#adb5bd}.totals strong{color:#dee2e6;font-variant-numeric:tabular-nums}details{margin-top:8px;border-top:1px solid #383e44;padding-top:6px}summary{cursor:pointer;color:#ced4da}ol{padding-left:20px;margin:7px 0}.player{margin:3px 0}select{width:100%;margin:7px 0}.delta{font-variant-numeric:tabular-nums}a{color:#9ec5fe}@media(max-width:600px){:host{top:60px;right:8px;max-width:calc(100vw - 16px)}}
 </style><section class="panel"><header><h2>Courtside</h2><button id="refresh" title="Refresh" aria-label="Refresh">↻</button><button id="expand" aria-label="Widen panel" aria-expanded="false">↔</button><button id="toggle" aria-expanded="true" aria-controls="panel-body">Hide</button></header><div id="panel-body"><p class="status" id="status" role="status">Connecting…</p><div id="data"></div></div></section>`;
 const data=root.getElementById('data'),status=root.getElementById('status');
 const options={best:'Best estimate',fit:'Highest average synergy',off:'Highest offense synergy',def:'Highest defense synergy',reb:'Highest rebounding synergy',current:'Current starters'};
 const names=players=>`<ol>${players.map(p=>`<li class="player">${esc(p.name)} <small>${esc(p.pos)}${p.injured?' · hurt':''}</small></li>`).join('')}</ol>`;
 const change=(a,b)=>{if(!Number.isFinite(a)||!Number.isFinite(b))return '—';const d=Math.round((b-a)*10)/10;return `<span class="delta ${d>0?'up':d<0?'down':''}">${d>0?'+':''}${fmt(d)}</span>`;};
 function comparison(a,b,heading){
  const row=(label,x,y,title='')=>`<tr><th title="${esc(title)}">${label}</th><td>${fmt(x)}</td><td>${fmt(y)}</td><td>${change(x,y)}</td></tr>`;
  return `<table><thead><tr><th></th><th>${heading[0]}</th><th>${heading[1]}</th><th>Δ</th></tr></thead><tbody>${row('Lineup estimate',a.score,b.score,'Mean injury-adjusted true player OVR + synergy bonus. Heuristic; not expected wins or point margin.')}${['off','def','reb'].map((k,i)=>row(['Off synergy','Def synergy','Reb synergy'][i],a.synergy?.[k],b.synergy?.[k])).join('')}</tbody></table>`;
 }
 function render(r){
  const detailStates=new Map([...root.querySelectorAll('details')].map(d=>[d.id,d.open]));
  if(r.kind==='player'){
   const hurt=r.injuryDays>0;
   const labels={'3':'Shooting',A:'Athleticism',B:'Handling',Di:'Interior D',Dp:'Perimeter D',Po:'Post',Ps:'Passing',R:'Rebounding'};
   data.innerHTML=`<p class="team" title="${esc(r.name)}">${esc(r.name)}</p><p class="muted">${esc(r.pos)} · ${esc(r.ratingSeason??'Latest')} ratings</p>
    <table id="player-skills"><thead><tr><th>Skill</th><th>${hurt?'Healthy':'Contribution'}</th>${hurt?'<th>Now</th>':''}</tr></thead><tbody>${Object.entries(labels).map(([k,label])=>`<tr><th>${label}</th><td>${r.skills[k].toFixed(2)}</td>${hurt?`<td>${r.currentSkills?r.currentSkills[k].toFixed(2):'—'}</td>`:''}</tr>`).join('')}</tbody></table>
    <p class="muted" title="Underlying ratings without scouting fuzz; same skill contributions as the roster panel.">Synergy contribution · 0–1</p>${hurt?`<p class="muted" title="${esc(r.injuryType)}">${r.available?'Playing hurt':'Unavailable'} · ${r.injuryDays} games</p>`:''}`;
  }else if(r.kind==='trade'){
   const assets=a=>[...a.players.map(p=>esc(p.name)),...a.picks.map(p=>esc(p.name))].join(', ')||'—';
   const contracts=a=>a.players.map(p=>`${esc(p.name)} · ${esc(p.age)}y · ${Number.isFinite(p.contract?.amount)?'$'+(p.contract.amount/1000).toFixed(1)+'M / '+esc(p.contract.exp):'—'}`).join('<br>')||'—';
   data.innerHTML=`<p class="team" title="${esc(r.otherName)}">vs ${esc(r.otherName)}</p>${comparison(r.before,r.after,['Before','After'])}<p class="muted">Best estimates · picks excluded${r.before.search?.exact===false||r.after.search?.exact===false?' · bounded':''}</p>${!r.after.enoughPlayers?'<p>Not enough eligible players.</p>':''}
    <details id="lineups"><summary>Starting lineups</summary><small>Before</small>${names(r.before.lineup)}<small>After</small>${names(r.after.lineup)}</details>
    <details id="assets"><summary>Trade assets</summary><p>Out: ${assets(r.outgoing)}</p><p>In: ${assets(r.incoming)}</p><small>${contracts(r.outgoing)}<hr>${contracts(r.incoming)}</small></details>`;
  }else{
   const selected=choice==='current'?r:choice==='best'?r.best:r.alternatives[choice];
   const shown=selected??r;
   data.innerHTML=`<p class="team" title="${esc(r.name)}">${esc(r.name)}</p>${comparison(r,shown,['Current',choice==='best'?'Best':'Selected'])}<p class="muted">Estimate · not win odds${r.search.exact?'':' · bounded search'}</p>${!r.enoughPlayers?'<p>Not enough eligible players.</p>':''}
    <details id="skills" open><summary>Skills · ${esc(options[choice])}</summary><div class="totals">${Object.entries({'3':'Shooting',A:'Athleticism',B:'Handling',Di:'Interior D',Dp:'Perimeter D',Po:'Post',Ps:'Passing',R:'Rebounding'}).map(([k,label])=>`<span>${label} <strong>${shown.count[k].toFixed(2)}</strong></span>`).join('')}</div><div class="scroll"><table class="skills"><thead><tr><th>Player</th>${['Shoot','Ath','Handle','Int D','Per D','Post','Pass','Reb'].map(k=>`<th>${k}</th>`).join('')}</tr></thead><tbody>${shown.lineup.map(p=>`<tr><td>${esc(p.name)}</td>${['3','A','B','Di','Dp','Po','Ps','R'].map(k=>`<td>${p.skills[k].toFixed(2)}</td>`).join('')}</tr>`).join('')}<tr><th>Total</th>${['3','A','B','Di','Dp','Po','Ps','R'].map(k=>`<td>${shown.count[k].toFixed(2)}</td>`).join('')}</tr></tbody></table></div></details>
    <details id="lineups"><summary>Starting lineup · ${esc(options[choice])}</summary><select id="lineup-choice" aria-label="Lineup objective">${Object.entries(options).map(([v,label])=>`<option value="${v}" ${choice===v?'selected':''}>${label}</option>`).join('')}</select>${names(shown.lineup)}<small>${r.search.tested.toLocaleString()} lineups checked</small></details>`;
  }
  for(const [id,open] of detailStates){const d=root.getElementById(id);if(d)d.open=open;}
 }
 async function tick(){
  const path=location.pathname,m=mode();
  if(!m){host.remove();lastPath='';lastData='';data.innerHTML='';return;}
  if(!host.isConnected)document.body.append(host);
  root.querySelector('h2').textContent=`Courtside · ${m==='trade'?'Trade':m==='player'?'Player':'Roster'}`;
  if(path!==lastPath){lastPath=path;lastData='';data.innerHTML='';status.textContent='Updating…';}
  if(document.hidden||collapsed)return;
  if(busy){if(Date.now()-lastSuccess>5000){data.innerHTML='';lastData='';status.textContent='Updating…';}return;}
  busy=true;
  try{
   const response=await chrome.runtime.sendMessage({type:`courtside-${m}`,path});
   if(location.pathname!==path||mode()!==m)return;
   if(!response?.ok)throw new Error(response?.error??'Reload BBGM to reconnect.');
   const serialized=JSON.stringify(response.data);result=response.data;
   if(lastData!==serialized){render(result);lastData=serialized;}
   lastSuccess=Date.now();status.textContent='Live';status.title=new Date(lastSuccess).toLocaleTimeString();
  }catch(error){if(location.pathname===path){data.innerHTML='';lastData='';status.textContent=error.message;}}
  finally{busy=false;}
 }
 root.addEventListener('change',event=>{if(event.target.id==='lineup-choice'){choice=event.target.value;if(result)render(result);}});
 root.getElementById('refresh').onclick=()=>void tick();
 root.getElementById('expand').onclick=()=>{wide=!wide;host.style.width=wide?'640px':'304px';root.getElementById('expand').setAttribute('aria-expanded',String(wide));};
 root.getElementById('toggle').onclick=()=>{
  collapsed=!collapsed;root.getElementById('panel-body').hidden=collapsed;
  root.getElementById('refresh').hidden=collapsed;root.getElementById('expand').hidden=collapsed;
  host.style.width=collapsed?'180px':wide?'640px':'304px';
  const toggle=root.getElementById('toggle');toggle.textContent=collapsed?'Show':'Hide';toggle.setAttribute('aria-expanded',String(!collapsed));
  if(!collapsed){data.innerHTML='';lastData='';status.textContent='Updating…';void tick();}
 };
 document.addEventListener('visibilitychange',()=>void tick());setInterval(()=>void tick(),1000);void tick();
})();
