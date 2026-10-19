# BBGM Solver — Courtside

This local program imports the league export and ranks teams by **estimated net
points per 100 possessions against the other exported rosters**. A score of +8
means an average advantage of about eight points per 100 possessions against
that reference set. Zero means parity; higher is stronger. It is not a 0–100
player rating or a championship probability.

## Website

Requires Node 22.13 or newer. Run this from the project directory:

```sh
npm start
```

Open **http://127.0.0.1:3000**. No npm installation is needed. To use a different
port, run `PORT=3001 npm start`. Stop the server with Ctrl+C.

1. Import a BBGM `.json` or `.json.gz` export and select your team. Team names
   are displayed when exported; otherwise use team IDs and the roster names.
2. Click **Evaluate team** for estimated net rating, offense, defense, win rate,
   player production, and offensive/defensive/rebounding synergy. Choose regular
   season or playoffs, current injuries or full health, and the simulation budget.
3. Open **Trade builder** and choose a trading partner. Use the **In** checkboxes
   to select any combination of players and available draft picks from both
   rosters. The package summaries show salaries and post-trade roster sizes;
   the impact panel updates automatically as you change the deal.
4. Use **Keep** to protect players from counteroffers, then click
   **What would make this trade work?** to ask the pinned game's negotiation
   algorithm for additions. Suggested players appear in the package and are
   marked in the rosters. **Clear** removes the selections and protections.
5. Use **Refine estimate** for a larger simulation budget, or **Export report**
   to download the current evaluation or trade comparison as JSON.

Uploads remain in local server memory. The program never edits the imported
file or makes trades in Basketball GM. Reimport after restarting the server.
The server binds only to `127.0.0.1` and runs one worker at a time. Runs can be
cancelled and have a five-minute maximum. Uploads are limited to 64 MiB
(256 MiB decompressed); the last three imports are retained.

### Live trade impact

Changing a package waits 300 milliseconds for further edits, then runs a quick
preview with **4 games per opponent**, split evenly between home and away.
You can keep editing during the calculation: newer selections cancel and replace
pending previews, and results from an older package are discarded. An empty
package runs no simulation. **Refine** uses the **Games / opponent** setting in
the evaluation toolbar, which defaults to 20.

The panel compares your team's strength, offensive rating, defensive rating,
win rate, and all three synergy scores before and after the trade. The strength
change includes an approximate 95% interval from paired game differences.
A positive strength change is favorable; a defensive-rating decrease is
favorable. An interval crossing zero means the sampling evidence does not
clearly distinguish an improvement from a decline. Four games per opponent is
a preliminary estimate, so refine close comparisons.

Before and after use identical opponent IDs, venue weights, budgets, and seed
schedules, with the trading partner's changed roster included afterward.
**Every team** uses the same automatic rotation policy in both states:
`valueNoPot` descending, PID tie-break, and normal playing-time modifiers.
The engine handles substitutions. This comparison baseline can differ from
**Team overview**, which evaluates exported rotations. Neither view proves an
optimal starting five or rotation.

The server caches comparison baselines for matching team, simulation format,
health, seed, and budget. Once a baseline is ready, another package usually
requires only its after-trade simulations. Repeating a recently evaluated
package with the same options can reuse the complete result. Caches stay within
the imported session; runtime depends on the league, hardware, and budget.

### Transaction checks and counteroffers

Basketball impact, transaction legality, and the partner's willingness are
separate results. The website can simulate a hypothetical trade even if it
fails salary rules or the AI rejects it. Player ownership, cooldowns, phase
restrictions, salary matching, and released-player liabilities are checked
against the imported snapshot. Player-only AI acceptance also uses team
strategy, difficulty, age, injuries, and contract value.

The rules and negotiation come from the pinned
[ZenGM revision `e2e6a3c7cd87d456b64ed94b67539dee7da71aa7`](https://github.com/zengm-games/zengm/tree/e2e6a3c7cd87d456b64ed94b67539dee7da71aa7/src/worker/core/trade).
The counteroffer action executes that revision's `makeItWork` algorithm with
snapshot-backed data and player valuation. It can add players on either side,
respects protected players, and is not restricted to one-for-one or two-for-one
packages. A counteroffer seeks AI willingness; it does not search for the deal
with the greatest basketball benefit. Its salary and eligibility checks are
shown separately, and the newly selected package gets its own impact preview.

**Verified** means the pinned model passes using the imported inputs, not a
promise that another game version will accept the deal. Missing transaction or
AI context is reported. **Trade context & explicit assumptions** lets you specify
the transaction phase, difficulty, and partner strategy when needed. Overrides
that differ from exported values make passing results conditional. The supplied
2006 export omits several of these fields, so it cannot establish acceptance on
its own. Simulation format (regular season or playoffs) is separate from the
league's current transaction phase.

Draft picks appear when their ownership was exported. They can be selected and
retained in a hypothetical package, but **future pick value is not included in
current team strength**, and local AI draft-pick valuation is unavailable.
A picks-only package has no current basketball impact. The counteroffer action
is unavailable when picks are selected; remove them for player-only negotiation
or negotiate that package in Basketball GM. This remains a current-strength
tool, not the eight-year championship solver.

### Import full trade context

The builder links to
[scripts/collect-snapshot.js](scripts/collect-snapshot.js). Open your league in
Basketball GM, copy the script, and paste it into the browser developer console.
Import the downloaded JSON into this website. The snapshot includes active
players and free agents, team strategies, game attributes, released-player
liabilities, and available draft picks.

This collector is **read-only**: it makes no trades, refreshes no proposals, and
advances no league time. It reads twice and aborts if the league changes during
collection. Its API calls were checked against the pinned upstream source and
tested with mocked responses; collection has not been verified in a live
Basketball GM browser session, so compatibility with another game build is not
guaranteed.

### Interpreting synergy

The simulator's on-court offensive, defensive, and rebounding synergies are
accumulated over playing time, then averaged with equal game/opponent/venue
weights. The website scales them to 0–100 using their mathematical ceilings:
offense 1, defense 5/6, rebounding 1/2. Team overview marks opponents' average;
the trade panel marks your team's before-trade value next to its after-trade bar.
These are **not league percentiles, predicted efficiencies, or added points**.
Smooth fractional skill contributions appear in the overview's expanded
breakdown. Use low synergy as a clue for roster experiments; the full simulated
strength determines whether a change helps. CLI team, trade, and proposal
reports include these synergy measurements too.

## Command line

Requires Node 22.13 or newer. There are no external npm dependencies.

```sh
# List team IDs and all player names
node src/cli.mjs --inspect

# Rank all 30 teams using the supplied league export
node src/cli.mjs --games-per-opponent 40 --out results/regular.json

# Evaluate playoff-style strength separately
node src/cli.mjs --phase playoffs --games-per-opponent 40 --out results/playoffs.json

# Evaluate a selected team with a larger budget
node src/cli.mjs --team-id 7 --games-per-opponent 200 --seed 12345

# Different input, including compressed exports
node src/cli.mjs --league path/to/league.json.gz --health healthy --json

# Verify the implementation
npm test
```

Team 7 is an example, not an assumed user team. Without `--league`, the CLI
selects the only snapshot in `League json files/` (a `.json` and its `.json.gz`
copy count as one snapshot, with the uncompressed file preferred). If there are
multiple snapshots, specify `--league` explicitly. The first evaluation
automatically builds the local engine; `npm run build` rebuilds it explicitly.
Node may print an experimental TypeScript-stripping warning during the build.
`npm run evaluate -- ...` also runs the CLI.

### Rank collected game proposals

The separate [scripts/collect-proposals.js](scripts/collect-proposals.js) script
can still be pasted into Basketball GM's developer console to download a richer
snapshot plus up to **20 distinct offers**. It refreshes the game's suggestion
seed but makes no trades, and aborts if league state changes while collecting.
Its API integration was checked against the pinned source and mocked responses,
not a live game browser. Use its bundle with the CLI:

```sh
node src/cli.mjs --proposals path/to/bbgm-proposals.json \
  --proposal-limit 20 --games-per-opponent 20 --out results/proposals.json
```

The game's proposal view seeks five offers from shuffled opponents. It seeds
negotiations with a player (70%), a pick (15%), or both (15%), then uses its AI
valuation to greedily add up to five assets across the two sides. It tries up to
ten times per opponent. Some last attempts include a salary warning, so the
collector rejects those. Refresh can repeat offers; the collector deduplicates
and stops after at most 40 batches. These are proposed packages rather than an
exhaustive search of all trades. Captured proposal checks apply to the collected
snapshot; draft picks stay in the packages but their future value is unscored.
The website can import these bundles as league snapshots for manual trade
building; proposal ranking remains available through the CLI.

The earlier OVR screen experiment can also be reproduced independently of the
website's simulation-based live previews:

```sh
node scripts/validate-screen.mjs \
  "League json files/BBGM_League_9_2006_preseason.json" 29 results/screen-validation.json
```

## Evaluate a trade

Load one league export and describe the hypothetical exchange in a small JSON
file. The league export is never modified. You can evaluate many scenarios
against the same snapshot without making trades in the game or exporting again.

First find player IDs by name, or list an entire roster with IDs:

```sh
node src/cli.mjs --league "League json files/BBGM_League_9_2006_preseason.json" --players "Kwame Brown"
node src/cli.mjs --league "League json files/BBGM_League_9_2006_preseason.json" --inspect --team-id 29
```

The included `scenarios/example-trade.json` swaps Predrag Drobnjak (PID 151)
from team 29 for Kwame Brown (PID 73) from team 8 in the supplied 2006 snapshot.
This is an illustrative hypothetical exchange, not a recommended or validated
transaction. Check ownership against the particular snapshot you select.

```json
{
  "teams": [
    { "tid": 29, "send": [151] },
    { "tid": 8, "send": [73] }
  ]
}
```

Each `send` array lists that team's outgoing player IDs. Use multiple IDs for
packages. One side may send an empty array, but at least one player must move.
Exactly two teams are supported. Unknown fields, picks, duplicate IDs, wrong
ownership, and rosters too small to simulate are rejected explicitly.

```sh
node src/cli.mjs \
  --league "League json files/BBGM_League_9_2006_preseason.json" \
  --team-id 29 --trade scenarios/example-trade.json \
  --games-per-opponent 40 --out results/trade.json
```

Use `--phase playoffs` for playoff-style games, `--health healthy` to remove
existing injury effects, and `--json` for machine-readable output. Trade mode
cannot be combined with head-to-head series mode.

Both participants are evaluated before and after against all other team IDs.
The other team's changed roster is included in each candidate evaluation.
Opponent weights, venue balance, settings, and seeds are matched. The reported
change uses **paired game differences** to estimate its sampling uncertainty;
sharing a seed does not force changed lineups to experience identical events.
At 40 games per opponent with 30 teams, the comparison runs 4,640 games total.

The report shows strength before/after, its change and approximate 95% interval,
offensive and defensive efficiency, win rate, and the largest changes in minutes.
The JSON also contains full player production and team diagnostics for both
states, the scenario, transfers, and input/engine provenance. A positive net
change is favorable; a defensive-rating decrease is favorable. If the change's
interval includes zero, the verdict is **No clear change**.

For both participating teams, the baseline and candidate use the same explicit
rotation policy: sort by exported `valueNoPot` descending (PID breaks ties) and
set playing-time modifiers to 1. This gives incoming players meaningful roles
and avoids transferring their former team's rotation settings. The engine still
handles substitutions, fatigue and position considerations. This policy is not
an optimal rotation search or the game's auto-sort algorithm. Consequently,
the trade baseline can differ from the ordinary exported-rotation evaluation.
Uninvolved teams keep their exported rotations.

This evaluates **current basketball impact**. Salary matching, trade eligibility,
AI acceptance, draft picks, contract value, and long-term development are not
evaluated. Roster-limit violations are reported, and scenarios are never labeled
legal merely because they can be simulated.

## Head-to-head series

Choose any two team IDs with `--team-id` and `--opponent-id`:

```sh
node src/cli.mjs --league "League json files/BBGM_League_9_2006_preseason.json" \
  --team-id 29 --opponent-id 8 --series 1000 --home-court 29
```

This runs 1,000 independent best-of-seven series under playoff settings. Each
series stops when one team wins four games. Home-court advantage defaults to
`--team-id`; use `--home-court 8` to give it to the opponent instead. The venue
schedule is 2-2-1-1-1: the home-court team hosts games 1, 2, 5, and 7. League
settings requiring neutral playoff venues override that advantage.

The report gives both teams' series win probabilities, Wilson 95% sampling
intervals, average series length, and probabilities of each outcome (each team
winning 4-0, 4-1, 4-2 or 4-3). Outcome probabilities sum to 100% before rounding.
Increase `--series` for a more precise estimate. `--league`, `--health`, `--seed`,
`--out`, and `--json` work here too; use `--series` instead of
`--games-per-opponent`. A sample series' game scores are included in JSON.

Every game uses the same exported roster and availability: existing injuries do
not heal during a series, and new injuries are disabled. Playoff overtime limits
must be unlimited so each game has a winner. These are generic playoff series;
finals-only neutral venues are not applied. Only the two selected teams play.

The full JSON report contains rankings, confidence intervals, matchup results,
player minutes and box-score averages, shot shares, true shooting estimates,
offensive/defensive four-factor diagnostics, input hash, engine source hashes,
seed, settings, and assumptions. `results/` and the compiled `.engine/` are
ignored by Git. No command changes the league input.

## Why this score

Winning depends on scoring more efficiently than the opponent. Instead of
assigning invented weights to shooting, defense, and rebounding, this evaluator
lets the pinned Basketball GM engine combine those skills in full games. Its
possession logic includes:

- Usage-weighted shooter selection, shot type/accuracy, passing and turnovers.
- Defensive effects, steals, blocks, shooting fouls and free throws.
- Offensive rebounds and additional opportunities to score.
- Smooth lineup synergy, substitutions, endurance, fatigue and foul trouble.
- Exported roster order, playing-time modifiers, player value and availability.
- Historical simulation factors, home advantage, overtime and late-game play.

There is no additional weighted sum of these outputs: their effects are already
reflected in scoring and points allowed. Adding a rebounding or defense bonus
to net rating would count that contribution twice. The diagnostics describe
how a team performed; they are not causal estimates of individual player value.

Every pair plays an even number of independent games, split evenly between home
and away. Each game starts from a deep copy of the same roster. The default is
20 games per opponent: 580 games per team, with 8,700 unique games for 30 teams.
When ranking everyone, each actual matchup contributes to both teams.

For each game, possessions are estimated as:

```text
P = 0.5 × [(FGA + 0.44 × FTA − ORB + TOV) for each of the two teams]
offensive_rating = 100 × points_scored / P
defensive_rating = 100 × points_allowed / P
net_rating = offensive_rating − defensive_rating
strength = equal-weight mean over opponents of
           0.5 × (mean home net_rating + mean away net_rating)
```

The unmodified engine does not expose a reliable completed-possession counter.
The box-score estimator includes overtime but approximates free-throw trips
and possession endings. Thus the score and efficiencies are explicitly labeled
estimates. Opponents are not weighted by their possession totals. Supporting
four-factor percentages are pooled box-score diagnostics, separate from the score.

The reported 95% intervals use a normal approximation, with sampling variance
estimated within each opponent/venue stratum. For K strata, the score standard
error is `sqrt(sum(sample_variance / games_in_stratum)) / K`. These intervals
measure simulation noise, not engine-version mismatch or input uncertainty.
Do not treat a tiny difference between ranked teams as a proven improvement.
Win rate is supporting evidence; ties count as half a win.

## Engine integration and limitations

The source is pinned to
[`e2e6a3c7cd87d456b64ed94b67539dee7da71aa7`](https://github.com/zengm-games/zengm/tree/e2e6a3c7cd87d456b64ed94b67539dee7da71aa7).
The build verifies SHA-256 hashes before stripping TypeScript from a small,
unmodified source subset. The browser/database utility barrel is replaced with
an explicit settings getter and mathematical helpers. The adapter reproduces
the basketball input preparation in upstream `loadTeams.processTeam`.

The authoritative reference is the [ZenGM repository](https://github.com/zengm-games/zengm),
with each local engine build tied to the revision above. The relevant source areas are:

- `src/worker/core/GameSim.basketball/`: possessions, rotations, fatigue, and on-court synergy.
- `src/common/constants.basketball.ts`: composite weights and skill thresholds.
- `src/worker/core/player/`: OVR, player valuation, and development. This frozen-snapshot
  evaluator uses exported `value` and `valueNoPot`; it does not advance development.
- `src/worker/core/trade/` and `src/worker/core/team/ValueChangeCalculator.ts`:
  eligibility, salary matching, AI value, and counteroffer additions.
- `src/ui/views/Trade/`: the asset-selection and negotiation interaction used as
  the model for this website's trade builder.

The local `engine_reference.md` is useful background, but is not exact in all
details. In particular, usage is raised to 1.9 **before** shooter weighting;
free-throw probability is `clamp(ftAccuracyFactor * shootingFT * 0.6 + 0.45,
0, 0.95)`; and rotations use exported `valueNoPot`, fatigue, positions, and
playing-time modifiers. These mechanics come from the pinned source, not a
new approximation of the reference document.

Regular and playoff modes are separate. The engine changes fatigue and synergy
in the playoffs; a playoff-style game against every roster is not a playoff
bracket simulation. The original 2004 export had all 15 ratings for 364 rostered
players on 30 teams, all healthy, but no team metadata. Team 26 has only eight
players. We use IDs/player names and evaluate the rosters exactly as exported.

Current-health mode follows the upstream default injury thresholds: no playing
through injuries in regular games; up to four games remaining in playoffs.
Healthy mode removes existing injury effects for **all** teams. New in-game
injuries are disabled. The export's team-specific injury policies are unavailable.
Playing-time modifiers are preserved for all teams, since the controlled team
is unidentified; the upstream loader normally resets AI modifiers to one.

The standalone evaluation is an underlying-rating, frozen-roster measurement,
not a forecast after free agency and preseason development. The website adds
interactive trade comparisons and player counteroffers; neither mode optimizes
future contracts, aging, injury risk, or championships.
Elam endings and shootouts currently fail explicitly. Generic playoff matchups
honor playoff-wide neutral venues, but are not treated as finals. Opponent
rosters and weights should stay fixed when comparing future candidate changes.

The library is synchronous and temporarily seeds `Math.random`, restoring it
after each game. Run concurrent simulations only in separate worker isolates.
Reproducibility is specified for the same source, input, Node environment, and
seed; it does not imply matching the original game's hidden random state.

## Verification

`npm test` checks imports, compressed inputs, season-indexed settings, bad-input
handling, adapter equality against the actual upstream loader (including playing
through injuries), deterministic resets, overtime minutes, scoring identities,
neutral identical-team symmetry, rating sensitivity, and opponent weighting.
It also checks trade-rule/AI source parity, arbitrary package sizes and multi-step
ownership, deterministic bounded search, unresolved feasibility, import and HTTP
worker flows, cancellation, and timeouts. Desktop and mobile Chrome smoke checks
cover import, team selection, evaluation, synergy, search, proposals, errors, and
clearing stale results when inputs change.

A full original-2004-export run used 17,400 games per mode (40 per opponent) and
checked player/team stat totals and minute/point identities in every game.
A seeded regular-season convergence check for team 0 produced:

| Games per opponent | Team games | Strength | Approximate 95% interval |
|---:|---:|---:|---:|
| 20 | 580 | +4.31 | +3.22 to +5.40 |
| 80 | 2,320 | +3.90 | +3.36 to +4.45 |
| 320 | 9,280 | +4.11 | +3.84 to +4.38 |

This shows declining sampling uncertainty, not proof of exact agreement with
the build that created the export. Small roster changes may need substantially
larger, paired comparison budgets.

## Source license

The vendored ZenGM code is copyright ZenGM, LLC, under its custom license, which
is included in [vendor/zengm/LICENSE.md](vendor/zengm/LICENSE.md). This project
is a local evaluator. Keep that license with any shared upstream source; the
upstream license restricts public hosting and distribution of runnable products.
