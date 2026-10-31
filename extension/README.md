# Courtside browser extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**, choose **Load unpacked**, and select this folder.
3. Reload BBGM, then open **Roster**, **Trade**, or a player profile.

After updates, reload the extension and then the BBGM tab. No local server or exports are needed.

## Panels

A dark, square-edged panel sits at the right of the screen. **Hide** collapses it to a small header and pauses reads. **↔** widens it. Details expand independently. Small screens keep the panel within the viewport.

Roster compares current starters against the best lineup under a fast estimate. Expand **Starting lineup** to switch between best estimate, highest average synergy, highest offensive/defensive/rebounding synergy, or current starters. The skill breakdown follows that selection. Current starters are selected initially; skill contributions and all eight totals are expanded by default. Widen the panel to see more columns, or scroll horizontally with player names pinned.

Trade compares the best estimated lineup before and after the complete package. Expand the lineups or assets for details. Picks, ages, and contracts are displayed; future value is not scored. BBGM handles legality and acceptance. No trades or roster changes are performed by this extension.

Player profiles show all eight individual skill contributions on the same 0–1 scale as the roster table, using the latest underlying ratings (the rating year is displayed). The reader includes prospects, free agents, and archived players. Injured players show a healthy baseline and current contributions when eligible to play through injury under their team's policy; unavailable players show a dash for current contributions. Hide/Show and width controls work on profiles too.

## What the estimate means

The displayed **Lineup estimate** is a screening heuristic, not predicted wins, point differential, or a proven optimal lineup. Higher is better within this model; compare changes, rather than treating a particular score as a championship threshold. Full-roster team OVR has been removed from the interface.

For a lineup, the score is the mean true player OVR (each adjusted by `1 - 0.025 * injury games remaining`) plus a fit bonus:

```
score = mean adjusted player OVR + factor * (raw offensive synergy + raw defensive synergy + raw rebounding synergy) / 3
factor = 10 in regular-season settings, 25 in playoff settings
```

The raw synergy scales have ceilings of 1, 5/6, and 1/2 respectively. Displayed synergies are normalized to 0–100. The factor follows the game's regular/playoff synergy scaling, but combining it with mean player OVR is our own uncalibrated heuristic. It does not reproduce the full possession simulator. OVR already includes some of the same abilities, and the added fit bonus is a modeling choice. This makes tradeoffs between talent and fit explicit without asserting a conversion to wins.

All eligible combinations are checked when there are at most 100,000. Larger searches use bounded single-player swaps from talent and skill-based seeds (at most 20,000 evaluations), labeled **bounded search**. Highest average synergy uses the equally weighted mean of the three displayed synergy scores. Maximizing it can select weaker players than the best-estimate lineup. Player order within a selected five does not change synergy. Bench depth, substitutions, fatigue over a game, and opponent-specific matchups are outside this starting-lineup score.

Both trade rosters use the same search and the user's injury policy. Roster current starters retain the game's order. Ineligible injured players are excluded; playing-through injuries reduce skill contributions. Reads and analysis results are cached; unchanged rosters do not repeat the search.

## Integration and provenance

Only the BBGM host and Chrome's scripting permission are requested. Fixed packaged readers call `bbgm.toWorker('main','evalOnWorker',...)` to read the live cache. Two matching reads are required before publishing. Reads are serialized across extension tabs and run about once per second while visible and expanded. Errors clear stale results. Historical roster pages are unsupported. Internal game APIs and formulas may change.

`engine-data.mjs` is generated with `node scripts/build-extension.mjs` after `npm run build`. It contains composite weights and player OVR from pinned ZenGM revision `e2e6a3c7cd87d456b64ed94b67539dee7da71aa7`. Synergy follows that revision's `GameSim.basketball.updateSynergy`. Safari and Firefox packaging is not included.
