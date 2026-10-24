# Île-de-France rail network (IDFM)

Compiled bundle for the `transit-network` layer: 46 commercial rail lines
(metro, RER, Transilien, tram, Orlyval, CDGVAL) in their official colours,
and one point per station.

## Files

- `network.geojson`: one FeatureCollection. Line features are one
  `MultiLineString` per (line, casing level), with id `<idrefligc>:<level>`.
  Station features are `Point`s with id `gare:<id_gare_g>` and the ids of the
  lines they serve. Generated; do not edit by hand.
- `source.json`: provenance. Dataset URLs, capture date, licence, SHA-256 of
  both raw exports and of `network.geojson`, counts, compiler report and
  parameters. Generated.

## Source and licence

Île-de-France Mobilités open data, under the
[Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/):

- [Tracés du réseau ferré IDF](https://data.iledefrance-mobilites.fr/explore/dataset/traces-du-reseau-ferre-idf/)
- [Emplacement des gares IDF](https://data.iledefrance-mobilites.fr/explore/dataset/emplacement-des-gares-idf/)

Both datasets were last modified on 2026-10-21 according to the IDFM catalog.
The exports were captured on 2026-10-24. The licence requires citing the
source and its update date; the app credit does so.

## Refresh

Download both GeoJSON exports (the URLs are in `source.json`), then:

```sh
node scripts/build-transit-network.mjs \
  --traces traces.geojson --stations gares.geojson \
  --captured-at YYYY-MM-DD --out src/data/local_data/idfm_transit_network
```

Add `--check` to verify that the committed files reproduce byte for byte
from the same exports. The line table and the known data repairs live in
`src/layers/transitNetwork/catalog.js`. After a refresh, update the credit
date in `src/data/dataCredits.js` and review the counts pinned in
`src/layers/transitNetwork/bundle.test.mjs`.
