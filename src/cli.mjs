import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readLeague, normalizeLeague } from './importer.mjs';
import { createHash } from 'node:crypto';

try {
  const {values} = parseArgs({options:{
    league:{type:'string'},
    'team-id':{type:'string'},phase:{type:'string'},
    'opponent-id':{type:'string'},series:{type:'string'},'home-court':{type:'string'},
    trade:{type:'string'},players:{type:'string'},
    proposals:{type:'string'},'proposal-limit':{type:'string'},
    health:{type:'string',default:'current'},'games-per-opponent':{type:'string'},
    seed:{type:'string',default:'12345'},out:{type:'string'},json:{type:'boolean'},
    inspect:{type:'boolean'},help:{type:'boolean'},
  }});
  if(values.help) {
    console.log(`Usage: node src/cli.mjs [options]
  --league PATH               BBGM JSON or JSON.gz (auto-select if only one snapshot)
  --inspect                   List reconstructed rosters without simulation
  --team-id ID                Evaluate one team (default: all teams)
  --trade PATH                Compare a trade JSON scenario for --team-id
  --proposals PATH            Rank game proposals with their bundled snapshot
  --proposal-limit N          Maximum distinct proposals to rank (default: 20)
  --players QUERY             Find rostered players by name or player ID
  --opponent-id ID            Simulate a best-of-seven against this team
  --series N                  Number of series trials (default: 1000)
  --home-court ID             Hosts games 1, 2, 5, 7 (default: --team-id)
  --phase regular|playoffs    Separate engine settings (default: regular)
  --health current|healthy   Exported injuries or fully healthy (default: current)
  --games-per-opponent N      Even integer >=4, split home/away (default: 20)
  --seed N                    Repeatable seed schedule (default: 12345)
  --out PATH                  Save full JSON report
  --json                      Print JSON instead of the readable report`);
  } else {
    let proposalBundle;
    if (values.proposals) {
      if (values.league || values.trade || values.inspect || values.players !== undefined || values['opponent-id'] !== undefined || values.series !== undefined || values['home-court'] !== undefined) throw new Error('--proposals uses its bundled league; do not combine it with --league or other modes');
      proposalBundle = JSON.parse(readFileSync(values.proposals,'utf8'));
      if (proposalBundle.format !== 'bbgm-proposals-v1' || !proposalBundle.league) throw new Error('Expected a proposal bundle from scripts/collect-proposals.js');
      if (values['team-id'] === undefined) values['team-id'] = String(proposalBundle.context?.userTid);
      if (values.out && resolve(values.out) === resolve(values.proposals)) throw new Error('Output must not overwrite the proposal bundle');
    } else if (values['proposal-limit'] !== undefined) throw new Error('--proposal-limit requires --proposals');
    if (!values.league && !proposalBundle) {
      const files = existsSync('League json files') ? readdirSync('League json files').filter(f => /\.json(\.gz)?$/.test(f)) : [];
      const snapshots = [...new Set(files.map(f => f.replace(/\.gz$/, '')))];
      if (snapshots.length !== 1) throw new Error('Select a league export with --league "path/to/league.json"');
      const file = files.includes(snapshots[0]) ? snapshots[0] : `${snapshots[0]}.gz`;
      values.league = `League json files/${file}`;
    }
    const league = proposalBundle
      ? normalizeLeague(proposalBundle.league,createHash('sha256').update(JSON.stringify(proposalBundle.league)).digest('hex'))
      : readLeague(values.league);
    if (values.trade && (values.inspect || values.players !== undefined || values['opponent-id'] !== undefined || values.series !== undefined || values['home-court'] !== undefined)) throw new Error('--trade cannot be combined with inspect, players, or series options');
    if (values.trade && values['team-id'] === undefined) throw new Error('--trade requires --team-id');
    if (values.out && ((values.league && resolve(values.out) === resolve(values.league)) || (values.trade && resolve(values.out) === resolve(values.trade)))) throw new Error('Output must not overwrite league or trade input');
    if (values.players !== undefined) {
      const query = values.players.toLocaleLowerCase();
      const found = [...league.teams.values()].flat().filter(p =>
        (values['team-id'] === undefined || p.tid === Number(values['team-id'])) &&
        (`${p.firstName} ${p.lastName}`.toLocaleLowerCase().includes(query) || String(p.pid) === query));
      const rows = found.map(p => ({pid:p.pid,tid:p.tid,name:`${p.firstName} ${p.lastName}`,position:p.rating.pos,ovr:p.rating.ovr}));
      if (values.json) console.log(JSON.stringify(rows,null,2));
      else {
        for (const p of rows) console.log(`PID ${p.pid} | team ${p.tid} | ${p.name} | ${p.position} | OVR ${p.ovr}`);
        if (!rows.length) console.log('No rostered players matched.');
      }
    } else if(values.inspect) {
      console.log(`${league.totalPlayers} player records; ${league.teams.size} teams; season ${league.settings.season}`);
      for(const [tid,ps] of league.teams) {
        if (values['team-id'] !== undefined && tid !== Number(values['team-id'])) continue;
        console.log(`Team ${String(tid).padStart(2)} (${ps.length}): ${ps.map(p=>`${p.firstName} ${p.lastName} [PID ${p.pid}]`).join(', ')}`);
      }
    } else {
      if(!existsSync(new URL('../.engine/worker/core/GameSim.basketball/index.js',import.meta.url))) await import('../scripts/build-engine.mjs');
      const seriesMode = values['opponent-id'] !== undefined;
      if (!seriesMode && (values.series !== undefined || values['home-court'] !== undefined)) throw new Error('--series and --home-court require --opponent-id');
      if (seriesMode && values.phase !== undefined && values.phase !== 'playoffs') throw new Error('Series mode uses --phase playoffs');
      if (seriesMode && values['team-id'] === undefined) throw new Error('--opponent-id requires --team-id');
      if (seriesMode && values['games-per-opponent'] !== undefined) throw new Error('Use --series to set the series trial budget, rather than --games-per-opponent');
      let lastUpdate=Date.now();
      const options = {
        teamId: values['team-id'] === undefined ? undefined : Number(values['team-id']),
        phase:values.phase ?? 'regular',health:values.health,gamesPerOpponent:Number(values['games-per-opponent'] ?? 20),seed:Number(values.seed),
        onProgress:({simulatedGames})=>{if(Date.now()-lastUpdate>10000){console.error(`Simulated ${simulatedGames} games...`);lastUpdate=Date.now();}},
      };
      const result = proposalBundle
        ? (await import('./proposals.mjs')).rankProposals(league,proposalBundle,{...options,proposalLimit:Number(values['proposal-limit'] ?? 20),
          onProposal:({completed,total})=>console.error(`Evaluated proposal ${completed}/${total}`)})
        : values.trade
        ? (await import('./trade.mjs')).evaluateTrade(league, JSON.parse(readFileSync(values.trade,'utf8')), options)
        : seriesMode
        ? (await import('./series.mjs')).evaluateSeries(league, { ...options,
          opponentId: Number(values['opponent-id']), series: Number(values.series ?? 1000),
          homeCourt: Number(values['home-court'] ?? values['team-id']),
        })
        : (await import('./evaluator.mjs')).evaluate(league, options);
      if(values.out) {
        const path=resolve(values.out);
        if(values.league && path===resolve(values.league)) throw new Error('Output must not overwrite the league input');
        mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(result,null,2)+'\n');
      }
      if(values.json) console.log(JSON.stringify(result,null,2));
      else if (proposalBundle) {
        console.log(`Proposal ranking for team ${result.teamId}: ${result.evaluated} evaluated, ${result.skipped.length} skipped, ${result.unevaluatedValid} beyond limit`);
        console.log(`Shared baseline: ${result.baseline.strength.toFixed(2)} estimated net points/100; ${result.phase}; ${result.simulatedGames} games`);
        for (const [i,r] of result.ranked.entries()) {
          const outgoing=r.transfers.filter(p=>p.fromTid===result.teamId).map(p=>p.name).join(', ') || 'no players';
          const incoming=r.transfers.filter(p=>p.toTid===result.teamId).map(p=>p.name).join(', ') || 'no players';
          console.log(`\n${i+1}. ${r.id}: ${r.delta.net.estimate.toFixed(2)} points/100 (95% CI ${r.delta.net.confidence95.map(x=>x.toFixed(2)).join(' to ')}); ${r.verdict}`);
          console.log(`  Send: ${outgoing}; receive: ${incoming}`);
          for (const side of r.picks) if(side.send.length) console.log(`  Team ${side.tid} sends picks: ${side.send.map(p=>p.desc ?? `DPID ${p.dpid}`).join(', ')} (future value unscored)`);
          console.log(`  Synergy change O/D/R: ${['off','def','reb'].map(k=>r.synergyChange[k].toFixed(1)).join(' / ')}`);
        }
        for (const skip of result.skipped) console.log(`Skipped ${skip.id ?? skip.index}: ${skip.reason}`);
        for (const warning of result.warnings) console.log(`Note: ${warning}`);
        if(values.out) console.log(`Full report: ${values.out}`);
      }
      else if (values.trade) {
        console.log(`Trade evaluation — ${result.phase}, ${result.health} health; ${result.simulatedGames} simulated games`);
        for (const p of result.transfers) console.log(`${p.name} [PID ${p.pid}]: team ${p.fromTid} -> team ${p.toTid}`);
        console.log(`Rotation policy: ${result.rotationPolicy}`);
        for (const c of result.comparisons) {
          const d = c.delta.net;
          console.log(`\nTeam ${c.tid}${c.tid === result.teamId ? ' (selected)' : ' (trade partner)'}: ${c.verdict}`);
          console.log(`Strength: ${c.before.strength.toFixed(2)} -> ${c.after.strength.toFixed(2)}; change ${d.estimate.toFixed(2)} points/100 possessions (95% paired CI ${d.confidence95.map(x=>x.toFixed(2)).join(' to ')})`);
          console.log(`Offense: ${c.before.offensiveRating.toFixed(2)} -> ${c.after.offensiveRating.toFixed(2)}; defense: ${c.before.defensiveRating.toFixed(2)} -> ${c.after.defensiveRating.toFixed(2)} (lower defense is better)`);
          console.log(`Game win rate: ${(100*c.before.winRate).toFixed(1)}% -> ${(100*c.after.winRate).toFixed(1)}%`);
          console.log(`Synergy O/D/R: ${['off','def','reb'].map(k=>c.before.synergy.scale100[k].toFixed(1)).join(' / ')} -> ${['off','def','reb'].map(k=>c.after.synergy.scale100[k].toFixed(1)).join(' / ')}`);
          for (const p of c.playerChanges.slice(0,5)) console.log(`  ${p.name} (${p.status}): ${p.beforeMinutes.toFixed(1)} -> ${p.afterMinutes.toFixed(1)} minutes/game`);
        }
        console.log(`\n${result.transactionAssessment}`);
        for (const warning of result.warnings) console.log(`Note: ${warning}`);
        if(values.out) console.log(`Full report: ${values.out}`);
      }
      else if (seriesMode) {
        console.log(`Best-of-seven: team ${options.teamId} vs team ${values['opponent-id']} — ${result.series} series, ${result.simulatedGames} games`);
        console.log(`League: ${values.league}`);
        console.log(result.neutralSite ? 'Neutral playoff venues (league setting).' : `Home-court advantage: team ${result.homeCourt}; 2-2-1-1-1 schedule.`);
        for (const t of result.teams) console.log(`Team ${t.tid}: ${(100*t.seriesWinProbability).toFixed(1)}% chance to win the series (95% sampling interval: ${t.seriesWinConfidence95.map(x => (100*x).toFixed(1)+'%').join(' to ')})`);
        console.log(`Average series length: ${result.meanSeriesLength.toFixed(2)} games`);
        for (const o of result.outcomes) console.log(`Team ${o.winner} wins 4-${o.loserWins}: ${(100*o.probability).toFixed(1)}%`);
        console.log('Frozen rosters and availability; no new injuries or injury recovery between games. Intervals cover simulation sampling only.');
        for (const warning of result.warnings) console.log(`Note: ${warning}`);
        if(values.out) console.log(`Full report: ${values.out}`);
      }
      else {
        console.log(`Team strength — ${result.phase}, ${result.health} health; ${result.simulatedGames} games`);
        console.log('Score = estimated net points / 100 possessions. Higher is better. CI = approximate 95% sampling interval.');
        console.log(' TID    SCORE          95% CI     OFF     DEF    WIN%   SYN-O SYN-D SYN-R   Players with most minutes');
        for(const t of result.teams) console.log(`${String(t.tid).padStart(4)} ${t.strength.toFixed(2).padStart(8)} [${t.strengthConfidence95.map(x=>x.toFixed(2).padStart(6)).join(',')}] ${t.offensiveRating.toFixed(1).padStart(7)} ${t.defensiveRating.toFixed(1).padStart(7)} ${(100*t.winRate).toFixed(1).padStart(7)}   ${['off','def','reb'].map(k=>t.synergy.scale100[k].toFixed(1).padStart(5)).join(' ')}   ${t.leaders.join(', ')}`);
        console.log('SYN-O/D/R: time-weighted offensive/defensive/rebounding synergy, scaled to each formula’s upper bound (0–100; not league percentiles).');
        if(result.teams.length===1) {
          const s=result.teams[0].synergy;
          console.log(`Opponent-average synergy O/D/R: ${['off','def','reb'].map(k=>s.opponentAverageScale100[k].toFixed(1)).join(' / ')}`);
          console.log(`Average fractional lineup skills: ${Object.entries(s.fractionalSkills).map(([k,v])=>`${k}=${v.toFixed(2)}`).join(', ')}`);
          console.log('Skills: 3=shooting, B=handling, Ps=passing, Po=post, A=athleticism, Di=interior defense, Dp=perimeter defense, R=rebounding. Counts are smooth skill measures, not badge counts.');
        }
        for(const warning of result.warnings) console.log(`Note: ${warning}`);
        if(values.out) console.log(`Full report: ${values.out}`);
      }
    }
  }
} catch(error) { console.error(`Error: ${error.message}`);process.exitCode=1; }
