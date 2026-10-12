# BBGM Solver: Project Brief and Implementation Handoff

## Goal

Build a Basketball GM decision assistant that takes a league state and recommends the next move that maximizes the expected number of championships won over the next eight seasons.

Potential actions include trades, free-agent signings, re-signings, draft selections, releases, and rotation changes. The system should also recommend making no move when that is best.

The long-term objective is:

\[
\max_{\pi}\;\mathbb{E}\left[\sum_{y=1}^{8}\mathbf{1}(\text{our team wins the championship in year }y)\mid S_0,\pi\right]
\]

Here, `S_0` is the current league state and `π` is a policy for choosing actions as new information arrives. All eight championships have equal weight. Future decisions must adapt to development, injuries, contracts, drafts, and other teams' actions.

The immediate project is the **current-team evaluator**, not the full multiyear solver. Build and validate that foundation before optimizing transactions.

## Why this project exists

Player OVR and average roster OVR do not fully describe team performance. The game allocates opportunities unevenly and models passing, turnovers, shooting, rebounding, defense, fatigue, substitutions, and lineup synergy. A player's contribution depends on teammates, opponents, and minutes.

The evaluator should accept underlying player attributes and the actual league settings, then estimate team efficiency in meaningful units: points scored and allowed per 100 possessions. It should eventually explain whether a proposed roster change improves those outcomes.

Do not invent an arbitrary weighted sum of ratings and present it as proven team strength. A fast approximation is useful only after validation against the game engine.

## Immediate deliverable

Build a local CLI/library that can:

1. Import a `.json` or `.json.gz` BBGM league export.
2. Reconstruct rosters, ratings, health, roster order, and playing-time modifiers.
3. Apply the export's simulation settings.
4. Evaluate a selected team against every other reconstructed roster.
5. Compare the baseline with one roster or rotation change.
6. Produce machine-readable results and a readable report with assumptions and uncertainty.

Start with the actual game engine and a modest simulation budget. A browser UI and browser extraction are later conveniences, not prerequisites.

## Input files already inspected

The user supplied these exports. Place them in the project input directory if they are not present in the new workspace; this document does not embed their contents.

| File | Root keys | Assessment |
|---|---|---|
| `BBGM_League_9_2004_free_agency.json.gz` | `version`, `meta`, `players`, `awards` | Player data only; insufficient to reproduce league settings |
| `BBGM_League_9_2004_free_agency.json(1).gz` | Above, plus `gameAttributes` | Use this as the initial evaluator input |

The first export contains 3,046 total player records, 364 rostered players across 30 team IDs, and 206 free agents. All rostered players have latest ratings for 2004, all 15 rating attributes, roster order, playing-time modifiers, injuries, contracts, statistics, and `valueNoPot`. Revalidate these properties on the second export rather than assuming the player arrays are identical.

The second export includes league settings but **does not include `teams`, a schedule, or playoff-series records**. Team membership can be reconstructed from player `tid`. Team names, conference assignments, records, and the controlled team cannot be established from team records because those records are absent. The controlled team has not yet been identified by the user.

For now, expose all team IDs with recognizable player names and allow explicit team selection. Missing team identity should not block building or evaluating all rosters. Do not guess historical team-ID mappings.

Notable settings from the second export:

| Setting | Value |
|---|---:|
| Export schema version | 73 |
| Season / starting season | 2004 / 2004 |
| Pace | 90.1 |
| Three-point tendency factor | 0.488 |
| Three-point accuracy factor | 1 |
| Two-point accuracy factor | 0.943 |
| Turnover factor | 1.07 |
| Offensive rebound factor | 1.086625 |
| Block factor | 1.2 |
| Steal factor | 1.16 |
| Home-court advantage | 1 |
| Periods / period length | 4 / 12 minutes |
| Players on court | 5 |
| Playoff series lengths | 7, 7, 7, 7 |
| Salary cap / cap type | 43,850 / soft |
| Minimum contract / maximum contract | 350 / 14,600 |

Read the complete settings object programmatically. The table is not a substitute for importing all relevant attributes. Monetary values use the export's units; do not assume these numbers are dollars.

This is a free-agency snapshot. A frozen-roster evaluator measures the players as exported, before future signings or preseason development. That is not automatically a forecast of the coming season.

## Engine integration

Upstream source: https://github.com/zengm-games/zengm

Previously inspected revision: `e2e6a3c7cd87d456b64ed94b67539dee7da71aa7`.

Relevant source areas include:

- `src/common/constants.basketball.ts`: composite rating definitions.
- `src/worker/core/GameSim.basketball/`: possession simulation, synergy, fatigue, substitutions, and shot selection.
- `src/worker/core/game/loadTeams.ts`: preparation of simulation inputs; locate and verify the path in the selected revision.
- `src/worker/core/player/`: composite calculation, player value, and development logic.

Pin a source revision and record it in every result. Export schema version is not a unique game-engine build identifier. The pinned source is a reproducible reference, not proof that it exactly matches the build that produced the export.

Use a narrow adapter around the engine. Preserve upstream logic where possible. Audit the full path from exported players to simulator inputs; importing `GameSim` alone is insufficient.

The public source has licensing restrictions. Read the repository license before packaging or distributing engine code; public availability is not equivalent to an unrestricted open-source license.

### Prior prototype available in the original workspace

A previous matchup simulator exists under `bbgm-matchup/`, with `engine.mjs`, `adapter.mjs`, `simulate.mjs`, vendored engine files, a README, and source hashes. A downloadable archive was produced as `basketball-gm-matchup-source.zip`. The full clone was under `zengm/`.

These are optional starting material, not dependencies guaranteed to exist in the new project directory. If absent, obtain the archive separately or rebuild the integration from upstream. Do not reference the old scratch directory as a permanent installation path.

The previous prototype used manually transcribed screenshot rosters and approximated some inputs. Its results were not sufficient validation of export-based integration. Replace those assumptions with export-derived values where available.

## Mechanics to preserve and verify

These findings came from the previously inspected revision. Recheck them in the chosen implementation revision.

- There are 15 underlying attributes: `hgt`, `stre`, `spd`, `jmp`, `endu`, `ins`, `dnk`, `ft`, `fg`, `tp`, `oiq`, `diq`, `drb`, `pss`, `reb`. Use rating `hgt`, not physical height in inches.
- Composite ratings generally use weighted combinations of attributes, normalized and clamped. Raw ratings and box-score statistics are different inputs.
- Raw usage on the 0–100 scale is `(1.5*ins + dnk + fg + tp + 0.5*(spd+hgt+drb+oiq))/6.5`.
- The normalized usage composite is raised to `1.9` during team loading, then shooting weights use `(usage * fatigue)^1.25`. Before the minimum-weight adjustment, this gives raw normalized usage exponent `2.375` and fatigue exponent `1.25`.
- Shooter weights have a minimum-weight adjustment before normalization. Do not describe it as an exact final 5% shot-share guarantee.
- Synergy uses smooth functions of lineup skills, with diminishing returns. Displayed skill badges are not hard on/off synergy switches.
- Playoffs change fatigue and synergy behavior. Explicitly configure regular-season and playoff evaluation separately.
- Substitutions depend on player value, fatigue, position constraints, playing-time modifiers, foul trouble, and game context. Do not simply assign minutes proportional to OVR.
- Use exported `valueNoPot` where appropriate and verify how the game transforms it. The prior screenshot prototype fell back to OVR.
- Free-throw accuracy is not the FT rating divided by 100. The inspected engine used `clamp(ftAccuracyFactor * shootingFT * 0.6 + 0.45, 0, 0.95)`.
- Injury availability and playing-through penalties must follow the engine's loading logic. Do not apply both a raw-rating penalty and a composite penalty accidentally.
- Potential is an estimate, not a development cap or causal development input.

The full evaluator should reuse possession mechanics rather than replace this list with a simplified analytical formula.

## Evaluation protocol

### Baseline

Evaluate each selected team against a fixed reference set: initially the other 29 exported rosters with equal opponent weights. Balance home and away games and reset each trial to the same initial state.

Report both regular-season and playoff settings as separately labeled evaluations. Do not interpret a playoff-style game win rate as championship probability.

Support two explicitly labeled health scenarios:

- Current availability, respecting exported injuries.
- Fully healthy, to estimate roster capability independent of current injuries.

For a static evaluator, prevent new injuries from carrying across independent trials. Any decision to disable in-game injuries must be recorded. Existing injuries and future injury risk are separate concepts.

### Main outputs

- Offensive rating: points scored per 100 possessions.
- Defensive rating: points allowed per 100 possessions.
- Net rating: offensive minus defensive rating.
- Balanced game win rate against the reference set.
- Margin variability and uncertainty estimates.
- Player minutes, shooting opportunities, efficiency, assists, turnovers, rebounds, and fouls.
- Supporting team rates: turnovers, offensive rebounds, free throws, and shot distribution.

Define possession accounting explicitly. Prefer engine-derived possession counts if reliably available. Otherwise document the box-score estimator and label the ratings as estimates. Account for overtime and do not divide points by a fixed number of possessions.

For an equal-opponent score, compute each opponent's result and average with the specified weights; avoid accidentally changing opponent weights through unequal simulation budgets or possession counts.

### Comparisons

Compare baseline and candidate states using identical opponent weights, venue balance, settings, and trial budgets. Reuse seed schedules for variance reduction, while recognizing that changed lineups can consume random draws differently; identical seeds do not guarantee identical possession-level randomness.

Report the estimated difference and its uncertainty. Allow “no clear improvement.” Avoid selecting a candidate based on tiny differences within simulation noise.

Attribute weaknesses through interventions: changing a player, changing a rotation, or introducing a comparable player archetype. A player's individual net rating or PER is not a causal measure of replacement value.

## Suggested architecture

| Module | Responsibility |
|---|---|
| Importer | Decompress, validate, normalize exports, and record missing data |
| State model | Preserve IDs, ratings, contracts, health, rotation, and settings |
| Engine adapter | Construct faithful simulator inputs and isolate upstream dependencies |
| Evaluator | Run repeatable trials, aggregate outcomes, estimate uncertainty |
| Scenario editor | Apply reversible roster and rotation changes to copied states |
| Reporter | Produce JSON plus readable summaries and assumptions |
| Fast evaluator, later | Approximate engine results for screening many candidates |
| Action generator, later | Generate legal, acceptable trades and signings |
| Future rollout model, later | Simulate development, finances, drafts, rivals, and future decisions |
| Search policy, later | Allocate evaluation budget and recommend the next action |

A Node/TypeScript implementation is a natural fit for the upstream engine. Start with a CLI and reusable library; do not build an elaborate UI before the evaluation works.

Illustrative CLI interface, not an existing command:

```sh
bbgm-evaluate inspect --league data/league.json.gz
bbgm-evaluate evaluate --league data/league.json.gz --team-id 7 \
  --phase playoffs --health current --games-per-opponent 200 --seed 12345
bbgm-evaluate compare --league data/league.json.gz --team-id 7 \
  --scenario scenarios/candidate.json --seed 12345
```

Team ID 7 above is only an example. No controlled team has been identified.

## Milestones and acceptance criteria

### 1. Import and inspect

- Read both compressed and uncompressed JSON.
- Enumerate team IDs and roster names without team metadata.
- Validate attributes, IDs, rating seasons, roster sizes, and settings.
- Preserve the input and compute its hash.
- Produce explicit warnings for missing information; do not silently guess.

### 2. Faithful single-game execution

- Populate composites, usage transformations, values, health, and rotation correctly.
- Apply historical simulation factors from the export.
- Make seeded runs repeatable in the pinned environment.
- Verify points identities, plausible minute totals including overtime, and finite results.
- Run symmetric-team trials to check venue handling and systematic side bias.

### 3. Baseline team evaluator

- Evaluate against the same league reference set with balanced venues.
- Return efficiency, win rate, player usage/minutes, uncertainty, and assumptions.
- Show convergence on a representative case before committing to a large fixed budget.
- Keep sampling uncertainty separate from engine-version and input-model uncertainty.

### 4. Scenario comparison

- Support one roster replacement and one rotation edit.
- Preserve other inputs consistently and compare using matched experimental settings.
- Explain where the estimated change comes from: scoring, turnovers, rebounding, defense, or minutes.
- Do not require a scenario to be a legal trade yet; clearly label hypothetical replacements.

### 5. Validate a fast approximation

- Generate diverse simulated roster/rotation examples.
- Fit or derive an approximation and test on held-out teams and roster changes.
- Compare against OVR baselines using prediction error and candidate-ranking quality.
- Use the approximation to screen candidates, then verify finalists with the engine.

## Path to the eight-year solver

Represent a search state as the whole relevant league state, not just our roster: rosters, ages, contracts, picks, finances, health, league date/rules, and available information.

Trades change both teams. Rival strength and the future value of traded picks matter. Trading logic can help check acceptance, but also reproduce legality, salary matching, tradability restrictions, and any negotiation behavior needed for a realizable action.

Start with bounded candidate generation and shallow search. Exhaustively exploring all roster compositions and eight years of transactions is not tractable. Allocate more simulations to promising candidates, and include the no-action baseline.

Add stochastic development, aging, injuries, contracts, drafts, and opponent actions incrementally. Compare initial actions under the same future management policy. A policy that freezes one roster and optimizes another creates a biased comparison.

Eventually estimate:

\[
\Delta(a)=\mathbb{E}[\text{eight-year titles}\mid a,\pi_{\text{future}}]
-\mathbb{E}[\text{eight-year titles}\mid\text{no action},\pi_{\text{future}}]
\]

Distinguish underlying-rating mode from scouting-information mode. The export can expose information unavailable through the normal interface; a realistic assistant should later model scouting uncertainty rather than unknowingly using perfect information.

## Guidance for the next Codex session

Begin with importer inspection and engine-adapter work. Identify available source and input files, read the upstream license, pin the revision, and implement milestones 1–3. Do not block foundational work on the user's missing team identity: list reconstructed teams and support evaluation by ID.

Prefer faithful, reproducible comparisons over precise-looking unsupported forecasts. The central engineering risk is an optimizer exploiting evaluator errors. Do not advance to transaction optimization until the evaluator's input pipeline and basic behavior have been checked.

Useful official documentation:

- Export format and customization: https://basketball-gm.com/manual/customization/
- Export schema: https://basketball-gm.com/manual/customization/json-schema/
- Player rating fields: https://basketball-gm.com/manual/customization/players/

