// `resCom` is matched together with `id` because IDFM reuses RER ids on TER
// rows (C01727, C01728).

/** @typedef {import('./source.js').TransitMode} TransitMode */
/**
 * @typedef {object} CatalogLine
 * @property {string} id IDFM idrefligc, e.g. 'C01371'.
 * @property {string} resCom IDFM res_com, matched verbatim.
 * @property {string} code Short code: '1', 'A', 'T3a', 'H'.
 * @property {string} name Display name: 'Métro 1', 'RER A'.
 * @property {TransitMode} mode
 * @property {number} rank Index in this table.
 */

const ROWS = [
  ['C01742', 'RER A', 'A', 'RER A', 'rer'],
  ['C01743', 'RER B', 'B', 'RER B', 'rer'],
  ['C01727', 'RER C', 'C', 'RER C', 'rer'],
  ['C01728', 'RER D', 'D', 'RER D', 'rer'],
  ['C01729', 'RER E', 'E', 'RER E', 'rer'],
  ['C01737', 'TRAIN H', 'H', 'Transilien H', 'train'],
  ['C01739', 'TRAIN J', 'J', 'Transilien J', 'train'],
  ['C01738', 'TRAIN K', 'K', 'Transilien K', 'train'],
  ['C01740', 'TRAIN L', 'L', 'Transilien L', 'train'],
  ['C01736', 'TRAIN N', 'N', 'Transilien N', 'train'],
  ['C01730', 'TRAIN P', 'P', 'Transilien P', 'train'],
  ['C01731', 'TRAIN R', 'R', 'Transilien R', 'train'],
  ['C01741', 'TRAIN U', 'U', 'Transilien U', 'train'],
  ['C02711', 'TRAIN V', 'V', 'Transilien V', 'train'],
  ['C01371', 'METRO 1', '1', 'Métro 1', 'metro'],
  ['C01372', 'METRO 2', '2', 'Métro 2', 'metro'],
  ['C01373', 'METRO 3', '3', 'Métro 3', 'metro'],
  ['C01386', 'METRO 3bis', '3bis', 'Métro 3bis', 'metro'],
  ['C01374', 'METRO 4', '4', 'Métro 4', 'metro'],
  ['C01375', 'METRO 5', '5', 'Métro 5', 'metro'],
  ['C01376', 'METRO 6', '6', 'Métro 6', 'metro'],
  ['C01377', 'METRO 7', '7', 'Métro 7', 'metro'],
  ['C01387', 'METRO 7bis', '7bis', 'Métro 7bis', 'metro'],
  ['C01378', 'METRO 8', '8', 'Métro 8', 'metro'],
  ['C01379', 'METRO 9', '9', 'Métro 9', 'metro'],
  ['C01380', 'METRO 10', '10', 'Métro 10', 'metro'],
  ['C01381', 'METRO 11', '11', 'Métro 11', 'metro'],
  ['C01382', 'METRO 12', '12', 'Métro 12', 'metro'],
  ['C01383', 'METRO 13', '13', 'Métro 13', 'metro'],
  ['C01384', 'METRO 14', '14', 'Métro 14', 'metro'],
  ['C01389', 'TRAM 1', 'T1', 'Tram T1', 'tram'],
  ['C01390', 'TRAM 2', 'T2', 'Tram T2', 'tram'],
  ['C01391', 'TRAM 3a', 'T3a', 'Tram T3a', 'tram'],
  ['C01679', 'TRAM 3b', 'T3b', 'Tram T3b', 'tram'],
  ['C01843', 'TRAM 4', 'T4', 'Tram T4', 'tram'],
  ['C01684', 'TRAM 5', 'T5', 'Tram T5', 'tram'],
  ['C01794', 'TRAM 6', 'T6', 'Tram T6', 'tram'],
  ['C01774', 'TRAM 7', 'T7', 'Tram T7', 'tram'],
  ['C01795', 'TRAM 8', 'T8', 'Tram T8', 'tram'],
  ['C02317', 'TRAM 9', 'T9', 'Tram T9', 'tram'],
  ['C02528', 'TRAM 10', 'T10', 'Tram T10', 'tram'],
  ['C01999', 'TRAM 11', 'T11', 'Tram T11', 'tram'],
  ['C02529', 'TRAM 12', 'T12', 'Tram T12', 'tram'],
  ['C02344', 'TRAM 13', 'T13', 'Tram T13', 'tram'],
  ['C01388', 'ORLYVAL', 'Orlyval', 'Orlyval', 'shuttle'],
  ['C00563', 'CDGVAL', 'CDGVAL', 'CDGVAL', 'shuttle'],
];

/** @type {ReadonlyArray<CatalogLine>} */
export const TRANSIT_NETWORK_LINES = Object.freeze(
  ROWS.map(([id, resCom, code, name, mode], rank) =>
    Object.freeze({ id, resCom, code, name, mode, rank }),
  ),
);

/** Known defects in the IDFM traces export. */
export const TRACE_REPAIRS = Object.freeze([
  Object.freeze({
    objectId: 550,
    match: Object.freeze({ res_com: 'TRAIN J', idrefligc: 'C0173' }),
    set: Object.freeze({ idrefligc: 'C01739' }),
    reason: 'truncated line id and missing colour on one TRAIN J segment',
  }),
]);
