// Named, reusable definitions of "what counts as played" against play_history,
// one per content owner process (Decision 63 Part B). Each process derives
// its real state fresh from play_history on every request rather than
// maintaining its own — this module is where that definition lives once,
// instead of being hand-rolled per query site.
//
// Campaign is the only process whose counting is completion-sensitive: a
// spot cut short mid-air must not count toward billing, pacing, or daily
// caps. Music, Branding, and Rundown must NOT use this filter — for
// rotation/cooldown purposes a cut-short play still occupied a slot and must
// still be deprioritized from immediate reuse. Applying this filter outside
// Campaign's billing/pacing queries would make a cut-short item look
// never-played and get it picked again immediately, the opposite of the
// intended fix.

import { eq } from 'drizzle-orm';
import { playHistory as playHistoryTable } from '../../db/schema.js';

export const campaignCompletedPlayFilter = eq(playHistoryTable.aborted, false);
