# Eight-season comparison runner

## Predictor comparison and fresh evaluation

Compare fixed model candidates without running campaigns:

```sh
npm run campaign:benchmark -- --data results/training-expansion-v2.json \
  --out results/predictor-benchmark.json
```

The benchmark holds out one whole lineage at a time, so every related snapshot,
seed and trade plan stays on the same side of each split. It compares the current
13-feature model, stronger regularization, a top-five-OVR-only model, and a compact
talent/age model (top player, top five, top eight, young talent, old talent and
mean age). Inactive coefficients are zero. Every candidate learns scaling,
coefficients and future-team allocation exclusively from its training lineages.
Eight candidate configurations are fixed in `campaign/benchmark.mjs`.

The report weights each lineage's RMSE equally and includes zero-title and equal
title-allocation baselines, per-fold errors and descriptive team rankings. The
folds share data and teams within a rollout are correlated. Selecting a candidate
from these results uses the held-out lineages for development; it is not fresh
validation or a test of trade-ranking accuracy. No model is promoted automatically.
Each fold's model is saved in the sibling `.models` directory with training and
development lineage metadata.

On the current 14 rollouts from two lineages, the compact model with lambda 10
scores 0.822 mean lineage RMSE versus 0.844 for the previous configuration, but
equal allocation scores 0.818. No tested model beats equal allocation on both
lineages. This remains an experimental predictor.

Individual profiles are also available through `campaign:learn --kind relative
--profile full|top5|talentAge --lambda N`. Default training remains `full` at 0.1.

Once a genuinely separate league has been collected, evaluate a previously frozen
candidate without fitting or selecting again:

```sh
npm run campaign:benchmark -- --model results/predictor-benchmark.models/talent_age_10-fold1.json \
  --data results/fresh-lineage-data.json --out results/fresh-lineage-evaluation.json
```

The data path above is a placeholder for a newly collected dataset. Evaluation
rejects lineages recorded in that artifact's training, prior holdout or benchmark
development groups. A renamed copy of an existing league is not independent;
correct grouping remains the user's responsibility. Freeze the candidate before
looking at fresh outcomes. A favorable title-count metric still needs paired
trade evaluation before it can support recommendations.

## Expansion allocation and paired evaluation update

New relative models carry `allocationVersion: 2` and `outsideTitles`, the mean
number of championships won by future teams in training rollouts. Existing teams'
predictions sum to `8 - outsideTitles`; that sum plus the outside allocation is
eight. The roster model fits the observed incumbent title mass, so expansion wins
are not incorrectly redistributed to current teams during training. The outside
estimate and all weights use training lineages only. It is a global baseline:
it does not yet use expansion schedules or capture how trades alter expansion
teams' chances. Older saved models predict exactly as before.

Re-ingest saved reports via `campaign:learn --mode ingest --report PATH --data
NEW_DATASET.json`. Ingestion adds per-rollout outside counts and safely enriches
matching old rows. Complete starting-team context, valid champions and a total of
eight incumbent-plus-outside titles are required. Reports and datasets are kept
separate from features: future winners are labels, never prediction inputs.

This update rebuilt `results/training-expansion-v2.json` from all saved completed
training batches and pilots: 390 team rows in 14 rollouts, including three with
future-team champions. `results/title-predictor-expansion-v2.json` trained only on
league14 and evaluated on league17. Its team RMSE is about 0.739 versus 0.714 for
equal allocation, and descriptive ranking agreement is about 49.6%. These are
correlated development results, not evidence of useful recommendations.

Trade pilot reviews now include `evaluation.baseline` and
`evaluation.betweenPlans`. They compare matched seeds, include conservative
95% intervals adjusted across all comparisons within the review, count nonzero
observed differences, and report prediction error alongside a zero-change
baseline. All-zero title differences give no directional agreement score.
Incomplete batches cannot establish an improvement. Error against two noisy
trials is descriptive; it is not the error against the unknown expected effect.

Updated reviews are saved as
`results/trade-pilot-league14-expansion-v2-review.json` and
`results/trade-pilot-league17-expansion-v2-review.json`. Both remain inconclusive.
No full campaigns were repeated for this update. The adapter build was rebuilt;
use a new batch output directory for future simulations after a build change.
Saved campaign reports remain usable for offline ingestion and review.

Compare specified opening trade plans by **expected championships over the next
eight seasons**, using the complete Basketball GM engine. A baseline with no
opening move is always included. All teams, including yours, then use BBGM's
native auto-play management. The optional bounded planner generates opening
trade packages and two-trade sequences for comparison. Future decisions still
follow native AI management.

## Run it

Requires Node 22.19 or newer and `tar`. From the project directory, install/build
the optional runtime once:

```sh
npm run campaign:setup
```

Setup downloads a specific ZenGM source archive, verifies its checksum and source
tree, installs locked dependencies in `campaign/node_modules`, and builds a
private local engine. It does not change the existing single-game evaluator.
After setup, campaigns run offline. To rebuild after editing the adapter:

```sh
npm run campaign:build
```

Start with a single trial to verify your league:

```sh
npm run campaign -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --trials 1 --seed 123 \
  --out results/eight-season-baseline.json
```

This particular export's team 21 is Indianapolis. To find another team's ID:

```sh
npm run campaign -- --league "League json files/BBGM_League_14_2000_preseason.json" --list-teams
```

`--trials` defaults to 10 and applies to **each plan, including the baseline**.
`--jobs 2` runs two independent trials concurrently; the maximum is four. Default
is one to limit memory/CPU use. Each campaign has a 20-minute timeout, adjustable
with `--timeout-minutes`. Progress goes to stderr; reports are JSON, checkpointed
after each completed campaign. Ctrl+C terminates active workers and saves a final
report with completed results. There is no automatic resume yet.

A full 29-team 2000 export ran through 2007 in about **three minutes for one
eight-season trial** on the development machine, including historical expansion
and realignment. Runtime varies with league size, draft classes, and hardware.
One or two trials test the plumbing; they cannot establish that a trade is better.

## Compare trade sequences

### Generate plans automatically

The bounded planner constructs packages with native `trade.makeItWork`, filters
salary/rule warnings, and replays shortlisted sequences through native
`trade.propose(false)`. Packages can contain multiple players and picks on either
side. Each second trade is generated in a fresh import **after executing the
first trade**, so changed ownership, salary commitments, and trade cooldowns apply.

Start by generating and inspecting plans without running campaigns:

```sh
npm run campaign:plan -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --generate-only --out results/trade-plans.json
```

Remove `--generate-only` for a preliminary short-season comparison against doing nothing:

```sh
npm run campaign:plan -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --budget 6 --jobs 2 --out results/trade-plans.json
```

Defaults: 32 package searches per state, four first-trade branches, depth two,
and four final plans. Adjust `--attempts`, `--branches`, `--depth` (1 or 2), and
`--shortlist`. These bound search breadth; they do not restrict packages to a fixed
number of assets. The generator varies opponents, targets, paired targets, and
outgoing players. Native negotiation may fail or produce a salary-illegal package;
such candidates are discarded rather than forcibly completed.

Screening alternates between native playoff team OVR, productive young players,
asset value, and lower remaining salary commitments. Asset value includes rough
first/second-round pick credits (30/10); the youth score uses age and current OVR,
not a development forecast. These are deliberately diverse **screening heuristics**,
not estimated championships. There is no requirement that the first move improve
current strength. One shortlist slot is reserved for a verified two-trade plan
when one is available. The search can still miss excellent packages or combinations.

The report contains candidate packages with player names and pick IDs, screening
components, rejected sequences, verified plans, and the campaign comparison.
A companion `.plans.json` file is directly reusable with `npm run campaign --
--plans PATH`, so more trials can be run without repeating search. Checkpointing
preserves completed campaign results on cancellation. Your export and live game
are never modified.

The default simulation stage uses **one season and one trial per plan**. Set
`--short-seasons 2` or `--short-trials N` for more short-stage evidence. Short
results rank candidates by observed titles, then regular-season win percentage;
they are explicitly preliminary and never become eight-year estimates.

The shortlist covers distinct first-trade packages before returning to variants
of the same opening. It retains a combination when available, regardless of
whether its first move is immediately strong. Finalist selection takes the best
short-run result and, when there are at least two slots, reserves one for a
remaining candidate with high youth/asset scores. This is a heuristic protection
for long-term plans, not a guarantee that the best future team survives screening.

Full campaigns require explicit `--deep`:

```sh
npm run campaign:plan -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --deep --finalists 2 --trials 2 --budget 12 --jobs 2
```

`--budget` caps the number of **simulated campaigns**, including the baseline and
failed attempts, across both stages. It defaults to 12. Imports, generation and
preflight checks are excluded; this is not a wall-clock limit. Shortlist simulation
is reduced to fit the budget. The deep stage runs only if the entire requested
paired batch fits the remaining budget; otherwise the saved result is
`budget-limited`. Reports preserve both stages, their horizons, finalist IDs,
excluded plans, and budget usage. Default four-plan screening costs at most five
one-season campaigns; two deep finalists at two trials add six eight-season
campaigns. Deep runs can still take many minutes or hours at larger trial counts.

Stages use separate reproducible seed sets to avoid reusing short-run outcomes
for final evaluation. Before simulation, plans must pass native acceptance on all
requested stage seeds; rejected plans are recorded and excluded. A simulation
failure stops the stage and prevents further stages. Cancellation saves completed
results. Future management remains BBGM AI. Neither short results nor a small deep
sample establishes an optimal strategy.

The standalone campaign CLI also accepts `--seasons 1` through `--seasons 8`;
its default remains eight. Saved `.plans.json` contains the whole generated
shortlist, while `finalists` in the planner report identifies the deep subset.

### Review a planner run

```sh
npm run campaign:review -- \
  --report results/trade-plans.json --out results/trade-review.json
```

This read-only command reports net players/picks exchanged, changes from baseline
in each screening component, title estimates, complete paired trial counts, and
uncertainty. It flags concentrated shortlists (all plans sharing one first trade).
When both a sequence and its first move were simulated, it also reports the paired
incremental effect of the second trade. Intermediate players traded in and then
out are removed from the net asset summary.

Improvement verdicts use conservative Hoeffding intervals with a Bonferroni
adjustment across tested plans versus baseline, so inspecting several plans does
not silently treat each separate 95% interval as a 95% overall claim. Second-trade
comparisons are descriptive pointwise intervals. Incomplete simulations never
produce an improvement verdict. Tiny runs will normally be inconclusive.

To gather more trials for the same shortlist, use the companion `.plans.json`
with the campaign CLI, then review that separate comparison:

```sh
npm run campaign -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --plans results/trade-plans.plans.json \
  --trials 20 --jobs 2 --out results/trade-comparison.json
npm run campaign:review -- \
  --report results/trade-plans.json --comparison results/trade-comparison.json
```

The review checks that league hash, team, engine build, and trade actions match.
It does not merge runs or simulate discarded candidates. To assess screening
quality, excluded plans must also be evaluated on matched seeds; a good result
for the shortlist alone cannot show that it retained the best available plan.

### Supply your own plans

Create a JSON array of plans, then pass `--plans scenarios/my-plans.json`.
The following illustrates the format; **replace all asset and partner IDs with
those in your export**. It is not a recommended or verified trade.

```json
[
  {
    "id": "guard_then_center",
    "name": "Acquire a guard, then a center",
    "actions": [
      {
        "type": "trade",
        "teams": [
          { "tid": 21, "pids": [101, 102], "dpids": [301] },
          { "tid": 0, "pids": [201], "dpids": [] }
        ]
      },
      {
        "type": "trade",
        "teams": [
          { "tid": 21, "pids": [103], "dpids": [302, 303] },
          { "tid": 26, "pids": [204, 205], "dpids": [] }
        ]
      }
    ]
  }
]
```

The first side must be your team. Each side's `pids` and `dpids` identify assets
that side **sends**. Use player IDs and draft-pick record IDs, not draft positions.
Omitted asset arrays default to empty. This format uses `pids`/`dpids`, unlike
the old single-trade CLI's `send` field. Unknown fields are rejected.

List a team's assets to construct a plan:

```sh
npm run campaign -- --league "League json files/BBGM_League_14_2000_preseason.json" --team-id 21 --list-assets
```

Then compare:

```sh
npm run campaign -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --plans scenarios/my-plans.json \
  --trials 20 --jobs 2 --seed 123 --out results/trade-comparison.json
```

There is no one-for-one or two-for-one restriction. Each opening sequence runs
in order, at the snapshot's current phase. Native ownership, tradability,
salary rules, and AI acceptance are checked after earlier trades have changed
the league. Players and picks move through native `processTrade`, preserving
contract, transaction, and ownership bookkeeping. God Mode cannot bypass the
opening trade checks. An unavailable/rejected deal fails the plan rather than
quietly removing an asset or forcing acceptance. A newly acquired player may
be subject to a cooldown, so some immediate combinations are not achievable.

All plans are checked before expensive campaigns begin. The initial action
format currently supports trades only. Signing, re-signing, drafting, releases,
and future trades still occur through native AI during each campaign. An empty
`actions` array is useful as a reproducibility control.

## Read the report

- `summary[].expectedTitles.mean`: average titles per eight-season campaign,
  from 0 to 8. Higher is the objective.
- `deltaFromBaseline.mean`: additional expected titles relative to no opening
  move, using the same trial seeds. Negative means fewer titles.
- `years[].titleProbability.mean`: title frequency for that season; the eight
  frequencies sum to expected titles.
- `titleCountDistribution`: frequencies of 0, 1, …, 8 total championships.
- `interval95`: conservative, pointwise Hoeffding bounds. They stay nonzero at
  zero observed titles and can be very wide with small samples. `standardError`
  is also supplied, but is not a reliable uncertainty bound for rare outcomes.
- `trials`: individual campaigns, champions, your records, end-of-season rosters,
  contracts, injuries, cash, opening actions, and league development/movement
  counts. Transaction counts cover the interval since the previous checkpoint,
  including the intervening offseason; the first interval begins after import
  and opening moves.
- `engine` and `input.sha256`: pinned source, bundle/adapter hashes, and input
  hash. Preflight information lists settings absent from the export, for which
  native import defaults or derived values are used, and imported prospect counts.

Seeds are paired by trial across every plan. Different actions can consume
different random draws, so this does not force identical injuries or development
paths. Each complete campaign is an independent sample; seasons within one
campaign are correlated. Failures never count as zero championships. Only trials
where **all** plans finish enter summaries. A failure marks the report incomplete;
resolve it before relying on a ranking because excluding failures can bias it.
Intervals measure sampling noise, not engine mismatch, policy quality, or the
uncertainty introduced by omitted export fields. They are not simultaneous
confidence bounds for picking the best of many plans.

The horizon begins with the current season if its championship is still ahead;
an offseason/draft snapshot starts with next season. Every title has equal weight.
The runner follows one continuous auto-play session and records completed years,
including nested expansion-draft transitions.

## Input and fidelity

Use a **full league export**, schema 73 or 74, with players and prospects, teams
and financial histories, settings, draft picks, released-player liabilities, and
scheduled events. Player-only exports and the extension's compact read-only
snapshot are insufficient. In-season snapshots also need the remaining schedule;
playoff snapshots need the current bracket. Finish any expansion/fantasy draft
before exporting. Repeat-season and forced historical roster modes are rejected.
Missing required data produces an error rather than guessed rosters or schedules.

Native import may fill out incomplete prospect classes and apply default settings.
Future development follows the export's actual rules, including any real-player
determinism settings. The runner neither uses exported potential as a development
cap nor gives its opening plans knowledge of future simulated outcomes. It does
not preserve/export a resumable final league database in this version.

The complete engine is pinned separately from the existing evaluator to
[ZenGM `c42bca30040f7407dee90892b768acef02cb0b4e`](https://github.com/zengm-games/zengm/tree/c42bca30040f7407dee90892b768acef02cb0b4e).
The old evaluator's schema-73 pin cannot process newer scheduled conference and
award changes. The new build applies upstream's basketball-specific compiler
transform and polyfills. Simulation, development, finances, drafts, trade logic,
and phase changes execute from upstream source; the adapter replaces browser UI
messages and uses in-memory IndexedDB in a fresh Node worker for each campaign.
It opens no browser profile and does not edit the export or your live game.

Source and dependency hashes make this reproducible in the pinned environment;
they do not establish parity with every live BBGM release. The source remains
subject to [ZenGM's license](https://github.com/zengm-games/zengm/blob/c42bca30040f7407dee90892b768acef02cb0b4e/LICENSE.md):
private local execution, no public hosting or redistributable game installer.
Downloaded source and compiled engine are ignored by Git.

## Verification

Compare the pinned engine in **headless Chrome with native IndexedDB** against
the Node runner's in-memory IndexedDB, using the same export and random seed:

```sh
npm run campaign:validate
npm run campaign:validate -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --out results/campaign-validation-2000.json
```

The first command uses a small controlled league. The second checks your export.
Both compare imported state and state after a season **plus its offseason**, at
the next preseason. `--seasons 8` extends advancement to eight seasons and eight
offseasons. Offseason exports begin the championship horizon next season, matching
the campaign runner. `--seed 71` is the default. Chrome is detected automatically
at its standard macOS location; use `--browser /path/to/browser` elsewhere, or
install Chromium with `campaign/node_modules/.bin/playwright install chromium`.
After updating an existing installation, run `npm run campaign:setup` first to
install the browser driver and build both engine bundles.

The JSON report gives a pass/fail result, per-store row counts, input/build hashes,
and the first 30 differing fields per checkpoint. It checks player ratings,
contracts, injuries, rosters, stats, picks, standings, playoff brackets,
transaction records, league settings, and scheduled events. A separate check
confirms exported player ratings, teams, birth data, contracts and injuries survive
import, allowing and listing the native importer's salary rounding separately.
Integer pairs must match exactly; other numeric comparisons allow only tiny
roundoff (32 machine epsilons, scaled by magnitude). Exact snapshot hashes can
therefore differ even when the comparison passes. A mismatch or runtime error
exits with status 1; the report defaults to `results/campaign-validation.json`.

This uses a disposable browser profile and a loopback-only server, leaving your
live game and export untouched. The two drivers share the pinned source, compiler,
UI shim and snapshot projection. Passing checks backend/import parity for the
observed state and seed; it does not validate another live BBGM version, every
possible league, unobserved fields, or the ordinary campaign reporting hook.

Run the separate regression suite for campaign reporting and action handling:

```sh
npm run campaign:test
```

Integration checks cover eight real engine seasons, deterministic replay across
isolated workers, evolving ratings/rosters/drafts, multi-asset packages, pick
ownership across trade sequences, AI rejection, cooldowns, parallel paired
comparisons, failure reporting, timeout, and cancellation. Engine tests require
setup first; without a local build, only input/report tests run.

## Experimental learned screening

`campaign:learn` adds an offline ridge-regression baseline for expected titles
under native AI management over eight seasons. No OpenAI API or GPU is used.
Features describe current talent and depth, age groups, salary commitments,
owned picks, opponent strength and league context. Player identity, exported
potential, future ratings and simulated outcomes are excluded from inputs.

Collect one full campaign with starting features for **every initial team**:

```sh
npm run campaign:learn -- --mode collect \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --group league14 --trials 1 --out results/learning-league14.json
npm run campaign:learn -- --mode ingest \
  --report results/learning-league14.json --data results/training-data.json
```

Collection is expensive; it runs eight seasons, default one trial, sequentially.
BBGM's export omits empty stores. If you exported through BBGM with **Players**
selected and `releasedPlayers` is absent, pass `--empty-released-players` to
record that it was empty in the collector's in-memory copy. The original export
is untouched. Do not use the option if Players was not selected or the file's
origin is uncertain; a missing field could then represent omitted contracts.
Cancellation/failures stop collection and preserve its report. Ingestion requires
complete eight-season reports containing initial features. Old reports and short
runs are rejected rather than guessing missing inputs or treating failures as
zero titles. Re-ingesting identical rows is idempotent; conflicting duplicates
are rejected. Each team gets its observed eight-year title count as its label.
Teams within one campaign are correlated, not independent evidence.

Repeat collection/ingestion for **independent full league exports** using another
group, for example `league15`. Assign every related snapshot, season, trial and
trade variant from one league lineage to the SAME group. Export hashes alone
cannot detect related histories: group assignment is your responsibility.
Train with a whole group held out:

```sh
npm run campaign:learn -- --mode train --data results/training-data.json \
  --holdout league15 --out results/title-predictor.json
```

At least two independent groups are required. The model fits on training groups
only, with a fixed ridge penalty (`--lambda`, default 10), and reports held-out
MAE/RMSE plus the constant-training-mean baseline MAE. Scaling also uses training
data only. The held-out groups are not refitted into the saved model. More groups
are needed for credible evaluation; repeated manual tuning against one holdout
will overfit it. A good title-count error does not establish good trade rankings:
those still need matched, held-out trade comparisons and screening-recall tests.
One league's team outcomes are insufficient to validate a usable predictor.

Enable learned screening explicitly:

```sh
npm run campaign:plan -- \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --model results/title-predictor.json --budget 6
```

Predictions are clamped to 0–8 and stored on candidates as `predictedTitles`.
They prioritize candidates before the usual opening-family diversity and native
acceptance checks. The combination and long-term finalist protections remain.
The default heuristic mode stays available without `--model`. Engine revision
and compiled engine hashes must match the model. All models are marked
experimental; no model is automatically promoted based on a small evaluation.
Initial baseline training covers native AI trajectories; using it on heavily
traded rosters can shift the input distribution. This version does not remove
short/deep validation or supply calibrated confidence bounds for predictions.

### Diagnose predictor failures

```sh
npm run campaign:learn -- --mode diagnose --data results/training-data.json \
  --model results/title-predictor.json --out results/predictor-diagnostics.json
```

Diagnostics show unclipped and bounded prediction ranges, clipping counts,
constant-zero and training-mean baselines, within-export pairwise ranking
concordance (ties get half credit), and feature ranges and mean-shift contributions.
Ranking is descriptive: teams and repeated simulations are correlated, and team
ranking does not establish trade-ranking quality. New training artifacts include
these diagnostics and print their warnings. Nearly constant training features
are now disabled using a relative numerical tolerance; they receive scale 1 and
coefficient 0, so rounding noise cannot amplify a change in league settings.
Older saved models retain their original behavior for reproducible diagnosis;
retrain into a new file to apply the fix. Diagnostics use the groups recorded in
the saved model, without fitting on their outcomes.

The first real two-league investigation found a constant three-point tendency
standardized by a tiny rounding residual, shifting every held-out raw prediction
below zero. Fixing that numerical bug exposed a separate generalization failure:
opponent-strength differences between leagues shifted all predictions upward.
One training league cannot establish how league-wide context affects title odds.
The corrected model remains experimental and should not guide trades. Further
model changes based on this inspected holdout need a new independent evaluation
league; repeated tuning against league17 is no longer a fresh holdout test.

### League-relative title allocation

An alternative to the original ridge model is available with `--kind relative`:

```sh
npm run campaign:learn -- --mode train --kind relative \
  --data results/training-data.json --holdout league17 \
  --out results/title-predictor-relative.json
```

This centers the first 13 roster/age/contract/pick features within each league,
scales them using training groups only, and fits an L2-regularized softmax title
share model (`--lambda`, default 0.1). Each rollout contributes a title-share loss.
Predictions across the current league sum to eight; identical teams receive equal
shares. Absolute opponent strength, league size, phase, difficulty and three-point
frequency are omitted from learned scores. Common shifts in roster feature levels
cancel under centering. A weaker league cannot raise all teams' title estimates
at once. This structural constraint does not establish prediction accuracy.

Full league context is required at inference. The planner recomputes all teams'
features after the hypothetical transfer, including the weakened/strengthened
partner, before calculating the user's title share. Use the artifact with the
existing `campaign:plan --model results/title-predictor-relative.json` option.
Legacy ridge artifacts remain supported; the default trainer is still ridge.

New ingestion records rollout IDs to keep different trials/plans separate.
Existing data without rollout IDs is accepted only when each source has exactly
one complete initial league and eight observed titles. Ambiguous/incomplete data
is rejected. To rebuild data with explicit IDs, ingest the saved collection
reports into a NEW dataset path; there is no need to repeat simulations. Existing
rows can also be enriched by re-ingestion when all original fields agree.

Legacy models allocate all eight titles among today's teams. New training
records an explicit `outsideTitles` count for future-team championships, allowing
complete expansion rollouts to enter training. Eight titles must still be accounted
for. Older datasets with missing allocation metadata must be re-ingested from
saved reports; no new simulation is needed. See the allocation update below.

The model at `results/title-predictor-relative.json` was developed using the
already-inspected league17 sample. That result is development feedback rather
than fresh validation. Its predictions conserve titles, but its observed ranking
and error still do not beat simple baselines reliably. Keep it experimental;
more independent league groups and held-out trade tests are needed before using
its ranking for decisions.

## Resumable training batches

Prepare a reviewable manifest, without running simulations:

```sh
npm run campaign:batch -- --mode prepare --directory "League json files" \
  --out results/training-manifest.json --seeds 12345,67890
```

The scanner validates every export, deduplicates equivalent JSON/gzip copies,
infers groups from `League_ID_` filenames, and lists skipped files and reasons.
Review group assignments: copies/forks of one lineage must share a group even
when the game gives them different IDs. Use `--empty-released-players` only for
standard BBGM exports known to have Players selected. Otherwise omitted records
are not assumed empty. Unknown filenames need manual manifest entries.

Run one NEW campaign at a time and rerun the same command to resume:

```sh
caffeinate -i npm run campaign:batch -- --mode run \
  --manifest results/training-manifest.json --out results/training-batch --budget 1
```

Each campaign runs eight seasons and records outcomes for all starting teams.
The budget counts new attempts in THIS invocation; cached campaigns are free.
`--timeout-minutes` caps each campaign's elapsed wall time (default 20), including
time while the computer is asleep. Keep the lid open; `caffeinate -i` prevents
idle sleep. A timeout is recorded as a failure and stops the invocation.
`--budget 0` only reconstructs the dataset from available matching saved runs.
Processing is sequential to limit memory and CPU. The first seed of each snapshot
is processed before second seeds, improving state coverage early in collection.
Failures stop the batch; rerunning retries the failed job after reusing successful
ones. Ctrl+C terminates the active worker and saves completed work. Interrupted
campaigns restart from import; mid-campaign state is not resumed.

Completed reports live in `runs/`, the deduplicated dataset in `dataset.json`, and
status/coverage in `batch.json`. A changed source, plan, group or pinned build
requires a new output directory. This avoids silently mixing incompatible work.
Only exact source/team/seed/actions/engine-and-adapter matches are reusable via
`--reuse REPORT` during preparation. Incompatible old reports are skipped for
simulation reuse; their existing datasets can still be merged separately when
feature versions and engine builds agree.

Merge the expanded data with the original dataset, preserving both inputs:

```sh
npm run campaign:batch -- --mode merge \
  --data results/training-data.json --data results/training-batch/dataset.json \
  --out results/training-expanded.json
npm run campaign:learn -- --mode train --kind relative \
  --data results/training-expanded.json --holdout league17 \
  --out results/title-predictor-expanded.json
```

To collect trade situations, add a `plans` array to a manifest entry using the
existing campaign plan format, or paste in plans from a `.plans.json` file. Asset
IDs must belong to THAT snapshot and selected `teamId`. Baseline is automatic;
each plan/seed gets its own native acceptance check and campaign budget unit.
Unaccepted plans fail visibly rather than being forced. Every entry needs explicit
`league`, `group`, `teamId`, `seeds`, and optionally `plans`/`emptyReleasedPlayers`.
The seed is a base seed; the worker uses `trialSeed(baseSeed,0)`, matching one-trial
campaign CLI behavior.

Coverage counts snapshots and rollouts separately from independent lineages.
Many league14 seasons still count as one group. Batching expands training data;
it does not certify that prediction or trade-ranking quality improved. Model
training is separate, and league17 remains development feedback. Fresh independent
leagues are still needed before recommendations can be trusted.

## Paired trade pilot

To create a pilot for another league without an existing plan file, use
`--mode generate`. It searches multi-asset trades and two-trade sequences with
the existing heuristic planner, then replays each retained sequence through
native acceptance on **every requested seed**. Rejections and the full search
are saved beside the manifest. No seasons run during this step. The selection
does not use the learned model or simulated championship outcomes.

The league17 example is prepared with:

```sh
npm run campaign:trade-pilot -- --mode generate \
  --league "League json files/BBGM_League_17_1994_draft_lottery.json" \
  --team-id 1 --group league17 --empty-released-players \
  --seeds 12345,67890 --count 2 \
  --out results/trade-pilot-league17.manifest.json
caffeinate -i npm run campaign:batch -- --mode run \
  --manifest results/trade-pilot-league17.manifest.json \
  --out results/trade-pilot-league17-batch --budget 3
```

Repeat the batch command to finish the other three campaigns, then review:

```sh
npm run campaign:trade-pilot -- --mode review \
  --manifest results/trade-pilot-league17.manifest.json \
  --batch results/trade-pilot-league17-batch \
  --model results/title-predictor-expanded.json \
  --out results/trade-pilot-league17-review.json
```

League17 was already inspected while designing the model; this pilot is
development feedback from another lineage, not fresh validation. Group all
related snapshots together. A genuinely new lineage is still needed for a
final test. Legacy model files retain their closed-league behavior; newly trained
models include the outside allocation described below. The simulator and paired
review include expansion normally.

The trade pilot turns a generated `.plans.json` file into a small resumable
training batch. It compares each trade with no opening move on the same snapshot
and seed, then reviews the observed eight-season championship difference for
your team. It accepts both single trades and multi-trade sequences.

For the Indianapolis 2000 export and existing generated plans:

```sh
npm run campaign:trade-pilot -- --mode prepare \
  --league "League json files/BBGM_League_14_2000_preseason.json" \
  --team-id 21 --group league14 \
  --plans results/planner-review-2000.plans.json \
  --plan-ids plan_2,plan_1 --seeds 12345 \
  --out results/trade-pilot-2000.manifest.json
caffeinate -i npm run campaign:batch -- --mode run \
  --manifest results/trade-pilot-2000.manifest.json \
  --out results/trade-pilot-2000-batch --budget 1
```

Repeat the `campaign:batch` command to finish the baseline and both trade
plans. Here one seed means three full campaigns; `--budget 1` spends at most
one new attempt per call. A second seed would double the total. Use a **new**
batch output directory if the manifest's plans, seed set, source, or build changes.
The batch stops if native BBGM rejects a trade on a seed; the saved baseline
remains available and the review marks the comparison incomplete.

To add another seed later, prepare a **new** manifest with `--seeds
12345,67890 --reuse-batch results/trade-pilot-2000-batch`, then run it with a
new batch output directory. Exact matching completed campaigns are copied into
that directory and do not consume the new budget. A different pinned engine,
source, team, seed, or action cannot be reused.

After any call, review the available complete pairs:

```sh
npm run campaign:trade-pilot -- --mode review \
  --manifest results/trade-pilot-2000.manifest.json \
  --batch results/trade-pilot-2000-batch \
  --model results/title-predictor-expanded.json \
  --out results/trade-pilot-2000-review.json
```

`--model` is optional. It adds the experimental predictor's expected title
change using all starting teams' features **after** each opening plan. The
review names whether the pilot lineage was used to train that model; league14
with the example model is an in-sample development check. The JSON lists each
pair's baseline/trade title counts and predicted change. It excludes missing
and failed pairs rather than counting them as zero. A one-seed result is a
plumbing and data example, not evidence that a trade is good or the predictor
is accurate. A useful trade-ranking test needs more independent league lineages,
multiple candidates and seeds, and a model evaluated on lineages it never saw
during design.

The batch dataset includes all teams' starting features and outcomes. If the
pilot completes, merge it with other training data via `campaign:batch --mode
merge` into a **new** dataset path. Keep snapshots, plans, and seeds from the
same game lineage under the same `group` so evaluation does not leak related
examples across training and holdout.

The example pilot produced three complete rollouts with 87 team rows. The
existing `results/training-batch/dataset.json` also contains a 1994 rollout
where an expansion team won one of the eight titles. That rollout remains in
the full merged data, but the current league-relative model cannot train on
it because it allocates all eight titles to starting teams. To try the
experimental model on compatible rows only:

```sh
npm run campaign:batch -- --mode merge \
  --data results/training-data.json \
  --data results/trade-pilot-2000-batch/dataset.json \
  --out results/training-relative-pilot.json
npm run campaign:learn -- --mode train --kind relative \
  --data results/training-relative-pilot.json --holdout league17 \
  --out results/title-predictor-trade-pilot.json
```

This uses only league14 for training and the already-inspected league17 for
development feedback. The saved model still has not beaten simple baselines
on that lineage, so it is not ready to rank trades for the user.
