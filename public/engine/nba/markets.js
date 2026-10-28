/**
 * NBA prop markets.
 *
 * Line grids are the ones books actually post: points and PRA in whole numbers ending
 * in .5, threes/steals/blocks in halves. The ladder anchors on the projection, which is
 * what keeps a probability from sitting at 50% by construction.
 */

export const NBA_MARKETS = [
  { id: 'pts', label: 'Points', unit: 'points', inc: 1, minLine: 0.5, decimals: 1, family: 'scoring' },
  { id: 'reb', label: 'Rebounds', unit: 'rebounds', inc: 1, minLine: 0.5, decimals: 1, family: 'rebounding' },
  { id: 'ast', label: 'Assists', unit: 'assists', inc: 1, minLine: 0.5, decimals: 1, family: 'playmaking' },
  { id: 'tpm', label: 'Threes made', unit: 'threes', inc: 0.5, minLine: 0.5, decimals: 1, family: 'scoring' },
  { id: 'pra', label: 'Pts + Reb + Ast', unit: 'PRA', inc: 1, minLine: 2.5, decimals: 1, family: 'combo' },
  { id: 'stl', label: 'Steals', unit: 'steals', inc: 0.5, minLine: 0.5, decimals: 1, family: 'defense' },
  { id: 'blk', label: 'Blocks', unit: 'blocks', inc: 0.5, minLine: 0.5, decimals: 1, family: 'defense' },
];

export const NBA_MARKET_BY_ID = new Map(NBA_MARKETS.map((m) => [m.id, m]));

export const NBA_FAMILIES = [
  { id: 'all', label: 'All markets' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'rebounding', label: 'Rebounding' },
  { id: 'playmaking', label: 'Playmaking' },
  { id: 'combo', label: 'Combo' },
  { id: 'defense', label: 'Defence' },
];

/** Plain-English phrasing for a market, used by the simple view, the guide and the drawer. */
export const NBA_PHRASE = {
  pts: { noun: 'points', says: (l, n) => `he scored ${n} or more points` },
  reb: { noun: 'rebounds', says: (l, n) => `he grabbed ${n} or more rebounds` },
  ast: { noun: 'assists', says: (l, n) => `he handed out ${n} or more assists` },
  tpm: { noun: 'threes', says: (l, n) => `he made ${n} or more threes` },
  pra: { noun: 'points + rebounds + assists', says: (l, n) => `he totalled ${n} or more` },
  stl: { noun: 'steals', says: (l, n) => `he recorded ${n} or more steals` },
  blk: { noun: 'blocks', says: (l, n) => `he blocked ${n} or more shots` },
};
