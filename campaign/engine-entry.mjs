import '../.campaign-engine/src/common/polyfills.ts';
// Bundled against the pinned, complete upstream source by build-campaign.mjs.
export { default as createStream } from '../.campaign-engine/src/worker/core/league/createStream.ts';
export { startAutoPlay } from '../.campaign-engine/src/worker/core/league/autoPlay.ts';
export { idb } from '../.campaign-engine/src/worker/db/index.ts';
export { g, local, lock } from '../.campaign-engine/src/worker/util/index.ts';
export { league, trade, team } from '../.campaign-engine/src/worker/core/index.ts';
export { PHASE, LEAGUE_DATABASE_VERSION } from '../.campaign-engine/src/common/constants.ts';
export { makeSeededRandom } from '../.campaign-engine/src/common/random.ts';
export { defaultGameAttributes } from '../.campaign-engine/src/common/defaultGameAttributes.ts';
export { ValueChangeCalculator } from '../.campaign-engine/src/worker/core/team/ValueChangeCalculator.ts';
