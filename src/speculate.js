// Speculate (on the Elysium chain) plays Beezie's claws through Beezie's own
// infrastructure; the pulls come back in Beezie's feed under one shared name,
// "Speculate user" (formerly "NextRare user"), with no username of their own. We show that name as
// Speculate (Elysium), mark those plays, and in the Data tab count them as a
// chain of their own.
export const SPECULATE_NAME = 'Speculate (Elysium)';
// Every Speculate play comes from this one Solana wallet (and Beezie flags it
// fromIsExternal), so it identifies them even if the feed's display name changes.
export const SPECULATE_WALLET = '72e4YKH5WWpGu9rzxn6LcjctifKWhNosXGjYETDZuuX7';
export const SPECULATE_FEED_NAME = 'Speculate user';
export const ELYSIUM = 'elysium';
export const isSpeculate = (player) => /^(speculate|nextrare) user$/i.test(String(player || '').trim());
/** The name to show for a player. */
export const playerLabel = (player) => (isSpeculate(player) ? SPECULATE_NAME : player);
