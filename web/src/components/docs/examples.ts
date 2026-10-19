// Example responses for the API docs page, recorded from the /v1 API on 2026-10-19: the $SPORE
// family and tree, the map (full and since=), the heat sidecar and frames of the event stream.
// Values are exactly what the API sent; only long arrays are cut, and `counts` records by how
// much so the page can say so next to each example. Re-record rather than hand-edit.

export const SPORE_MINT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
export const MUSHROOM_MINT = "DzpHEj1rhS93fcohsG83pDPgY4GSa7v9g6yP8viwGhET";

export const EX = {
  "familySpore": {
    "mint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
    "name": "Spore",
    "symbol": "SPORE",
    "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png",
    "depth": 0,
    "quoteMint": null,
    "quoteSymbol": "SOL",
    "root": {
      "mint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
      "name": "Spore",
      "symbol": "SPORE",
      "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png",
      "depth": 0
    },
    "parent": null,
    "ancestors": [],
    "children": {
      "count": 6,
      "top": [
        {
          "mint": "g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi",
          "name": "Hyphae",
          "symbol": "HYPHAE",
          "image": null,
          "depth": 1,
          "mcapUsd": 4426.70661598257,
          "lockedUsd": 0.10962042949517171
        },
        {
          "mint": "9wov7fiErh5mxEuK8uR7sd2Q9HBh3mb14kh9mopbYXgP",
          "name": "SPOREINU",
          "symbol": "SPOREINU",
          "image": null,
          "depth": 1,
          "mcapUsd": 4500.130978131357,
          "lockedUsd": 0
        },
        {
          "mint": "75WaoewrcoaDtT5HpQnovQS1wNL3Y21LvX45iQkLfGaU",
          "name": "Spore Cat",
          "symbol": "SPCAT",
          "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2F115ac376976947c468552319b52f8940d1fc6e9ec9a945c3ac173fa7c7acffe0.png",
          "depth": 1,
          "mcapUsd": 10961.558820254608,
          "lockedUsd": null
        },
        {
          "mint": "DPxXgyzN6JpgVsefByh6nEsbciUiE7vcaEsNHAtbddvm",
          "name": "Shroompup",
          "symbol": "SHROOMPUP",
          "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2F566c611e76b3a30079fd329deff4a3a1d26f0b8c9f548e8e3a9fc08dd9965092.jpg",
          "depth": 1,
          "mcapUsd": 5779.6931202242085,
          "lockedUsd": null
        },
        {
          "mint": "BH1TKxr8pYQVLaBau8WdPzXxwY53SfWRpnjTwMvBYamk",
          "name": "Micology",
          "symbol": "MICOLOGY",
          "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fe1cd5258bf333d5ed3c30c06628fe27df6926ebf9bc5db43631c2e4156362819.jpg",
          "depth": 1,
          "mcapUsd": 3601.7565880212455,
          "lockedUsd": null
        },
        {
          "mint": "5HDVaS79KxCpxm14io8y42d4reG4pJJDS2yzSu3zYDgq",
          "name": "VIRUS",
          "symbol": "SPOREVIRUS",
          "image": null,
          "depth": 1,
          "mcapUsd": 2547.1927807138495,
          "lockedUsd": null
        }
      ]
    },
    "descendants": 8,
    "lockedUsd": 1508.1184926197145,
    "mcapUsd": 77401.52127856431,
    "change24h": 312.6,
    "trades1h": 13,
    "launchedOnSpore": false,
    "links": {
      "spore": "https://sporepad.com/c/HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
      "launchUnder": "https://sporepad.com/launch?parent=HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
      "embed": "https://sporepad.com/embed/tree/HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"
    }
  },
  "familyMush": {
    "mint": "DzpHEj1rhS93fcohsG83pDPgY4GSa7v9g6yP8viwGhET",
    "name": "Tiny Little Mushroom",
    "symbol": "MUSHROOM",
    "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2F28c5bf72b1a3efb8ecdcabc27c952a66436a35e09280e7871cf15cf61483969d.jpg",
    "depth": 2,
    "quoteMint": "g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi",
    "quoteSymbol": "HYPHAE",
    "root": {
      "mint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
      "name": "Spore",
      "symbol": "SPORE",
      "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png",
      "depth": 0
    },
    "parent": {
      "mint": "g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi",
      "name": "Hyphae",
      "symbol": "HYPHAE",
      "image": null,
      "depth": 1
    },
    "ancestors": [
      {
        "mint": "g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi",
        "name": "Hyphae",
        "symbol": "HYPHAE",
        "image": null,
        "depth": 1
      },
      {
        "mint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
        "name": "Spore",
        "symbol": "SPORE",
        "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png",
        "depth": 0
      }
    ],
    "children": {
      "count": 0,
      "top": []
    },
    "descendants": 0,
    "lockedUsd": null,
    "mcapUsd": 996.9070396863406,
    "change24h": 27.95,
    "trades1h": 0,
    "launchedOnSpore": true,
    "links": {
      "spore": "https://sporepad.com/c/DzpHEj1rhS93fcohsG83pDPgY4GSa7v9g6yP8viwGhET",
      "launchUnder": "https://sporepad.com/launch?parent=DzpHEj1rhS93fcohsG83pDPgY4GSa7v9g6yP8viwGhET",
      "embed": "https://sporepad.com/embed/tree/DzpHEj1rhS93fcohsG83pDPgY4GSa7v9g6yP8viwGhET"
    }
  },
  "tree": {
    "root": {
      "mint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
      "name": "Spore",
      "symbol": "SPORE",
      "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png",
      "depth": 0
    },
    "nodes": [
      {
        "mint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY",
        "name": "Spore",
        "symbol": "SPORE",
        "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png",
        "depth": 0,
        "ours": false,
        "oursPending": false,
        "mcapUsd": 77401.52127856431,
        "lockedUsd": 1508.1184926197145,
        "children": 6,
        "descendants": 8,
        "otherChildren": 0,
        "migrated": true,
        "createdAt": null,
        "parentMint": null
      },
      {
        "mint": "g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi",
        "name": "Hyphae",
        "symbol": "HYPHAE",
        "image": null,
        "depth": 1,
        "ours": true,
        "oursPending": false,
        "mcapUsd": 4426.70661598257,
        "lockedUsd": 0.10962042949517171,
        "children": 1,
        "descendants": 1,
        "otherChildren": 0,
        "migrated": false,
        "createdAt": 1792375893,
        "parentMint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"
      },
      {
        "mint": "9wov7fiErh5mxEuK8uR7sd2Q9HBh3mb14kh9mopbYXgP",
        "name": "SPOREINU",
        "symbol": "SPOREINU",
        "image": null,
        "depth": 1,
        "ours": true,
        "oursPending": false,
        "mcapUsd": 4500.130978131357,
        "lockedUsd": 0,
        "children": 1,
        "descendants": 1,
        "otherChildren": 0,
        "migrated": false,
        "createdAt": 1792382642,
        "parentMint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"
      },
      {
        "mint": "75WaoewrcoaDtT5HpQnovQS1wNL3Y21LvX45iQkLfGaU",
        "name": "Spore Cat",
        "symbol": "SPCAT",
        "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2F115ac376976947c468552319b52f8940d1fc6e9ec9a945c3ac173fa7c7acffe0.png",
        "depth": 1,
        "ours": true,
        "oursPending": false,
        "mcapUsd": 10961.558820254608,
        "lockedUsd": null,
        "children": 0,
        "descendants": 0,
        "otherChildren": 0,
        "migrated": false,
        "createdAt": 1792374989,
        "parentMint": "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"
      }
    ],
    "total": 9
  },
  "mapDelta": {
    "nodes": [
      {
        "mint": "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump",
        "name": "GTA memes",
        "symbol": "GTA",
        "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2Fbafkreihskz4lasserwwxvnm2x5cujfps76ifn75pcynczxiwns74ty677u",
        "depth": 0,
        "ours": false,
        "oursPending": false,
        "mcapUsd": 1256098.7673093663,
        "lockedUsd": 46386.50121901305,
        "children": 104,
        "descendants": 105,
        "otherChildren": 0,
        "migrated": true,
        "createdAt": null,
        "parentMint": null
      },
      {
        "mint": "NTRNDMqQSiwEC2jJs3wJiZS6bpGYQJtMNQJgiX3WyV6",
        "name": "notrandom",
        "symbol": "NTRNDM",
        "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fmeta.notrandom.fun%2Fntrndm%2Fb25d240d49ef8934d8db0daf0be0e5e85fba14d6bdfb80c95b7da72b3fe309ee.png",
        "depth": 0,
        "ours": false,
        "oursPending": false,
        "mcapUsd": 496281.4548808953,
        "lockedUsd": 46180.04737842738,
        "children": 298,
        "descendants": 302,
        "otherChildren": 0,
        "migrated": true,
        "createdAt": null,
        "parentMint": null
      }
    ],
    "removed": [],
    "generatedAt": 1792409496205,
    "total": 16247,
    "version": 1204
  },
  "mapFull": {
    "roots": [
      {
        "coin": {
          "mint": "991L48va9rMiysu3fCpeg5p9bN4NLzhujojzmFtkgacE",
          "name": "Spurdo",
          "symbol": "spurdo",
          "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fcf-ipfs.com%2Fipfs%2FQmbFhigYnZsxqBEZ155o4KajYz2shGPXoodzyvrLJ8EHQ5",
          "depth": 0,
          "ours": false,
          "oursPending": false,
          "mcapUsd": 60399.905157311114,
          "lockedUsd": 207.07985686763286,
          "children": 1,
          "descendants": 1,
          "otherChildren": 0,
          "migrated": true,
          "createdAt": 1711865933
        },
        "children": [
          {
            "coin": {
              "mint": "7wJSty1fmeJYzNispTE6dCXHfCcg1aAHsLeMUDympump",
              "name": "Gondola",
              "symbol": "Gondola",
              "image": "https://sporepad.com/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2Fbafkreiaaku5np7rwbar2qyj7hoffzoijzr5edbiwvipigorlwiirjmybfe",
              "depth": 1,
              "ours": false,
              "oursPending": false,
              "mcapUsd": 2539.42909277427,
              "lockedUsd": null,
              "children": 0,
              "descendants": 0,
              "otherChildren": 0,
              "migrated": false,
              "createdAt": 1791496898
            },
            "children": []
          }
        ]
      }
    ],
    "scope": "all",
    "version": 1204,
    "generatedAt": 1792409495642,
    "total": 16247
  },
  "heat": {
    "at": 1792409496,
    "since": 1792323096,
    "mint": [
      "9tti2o8c7eBABVBfQ9xMAuHrppyKSycKvaewz3R6qJV1",
      "4df1q5JNKYK7XjxHKsnwdenpjBgxAgfCXed7YFNHpump",
      "8CYyivwMZPg6Edaofxo3eHiveZkDrU6TtUDwtMjTpump"
    ],
    "t1h": [
      2018,
      1199,
      886
    ],
    "n24": [
      2018,
      1199,
      2005
    ],
    "v24": [
      77250.21,
      54320.78,
      76175.75
    ],
    "last": [
      1792409491,
      1792409460,
      1792409486
    ],
    "buys1h": [
      1095,
      745,
      508
    ]
  },
  "stream": {
    "pair": {
      "coin": {
        "mint": "C3x4yzs6SjJnHWYXEFdwiB5VbCHVRaK9wMiARbqFpump",
        "name": "ZERO KNOWLEDGE INU",
        "symbol": "ZKINU",
        "image": null,
        "depth": 1,
        "ours": false,
        "oursPending": false,
        "mcapUsd": null,
        "lockedUsd": null,
        "children": 0,
        "descendants": 0,
        "otherChildren": 0,
        "migrated": false,
        "createdAt": 1792409513,
        "parentMint": "ctJ2i4k7xcoKp6Tovb6AXSsC4AtLVJiTkfbd2GMpump"
      },
      "parent": {
        "mint": "ctJ2i4k7xcoKp6Tovb6AXSsC4AtLVJiTkfbd2GMpump",
        "name": "XTO",
        "symbol": "XTO",
        "image": null,
        "depth": 0,
        "ours": false,
        "oursPending": false,
        "mcapUsd": null,
        "lockedUsd": null,
        "children": 1,
        "descendants": 1,
        "otherChildren": 0,
        "migrated": true,
        "createdAt": null,
        "parentMint": null
      }
    },
    "trade": {
      "sig": "YZdCUtFpemTpt3ANwcuBEnC5Ro3jEGeHstiGKoXM7fGVPFGyGzvxHpg5bL5V93GSYLqjeBt2z7TasvCB7coypLQ",
      "mint": "3dgGDYKaab1pAZhaEC6gZQS3PrbZdShXMcoWeVZJpump",
      "slot": 458817636,
      "time": 1792409495,
      "isBuy": false,
      "user": "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn",
      "baseAmount": "16558905050",
      "quoteAmount": "1971338",
      "priceQuote": 0.00009404535399748874,
      "priceUsd": null,
      "valueUsd": null
    },
    "heat": {
      "mint": "3dgGDYKaab1pAZhaEC6gZQS3PrbZdShXMcoWeVZJpump",
      "at": 1792409496,
      "t1h": 1,
      "n24": 3,
      "v24": 0,
      "last": 1792409495,
      "buys1h": 0
    },
    "stats": {
      "coins": 16250,
      "roots": 2233,
      "byDepth": [
        2233,
        13790,
        227
      ],
      "lockedUsd": 269525.76774560846,
      "volume24hUsd": 3455518.881995434,
      "solUsd": 104.56,
      "maxDepth": 2,
      "backfill": {
        "done": true,
        "total": 13411,
        "resolved": 13411,
        "failed": 0
      },
      "updatedAt": 1792409521,
      "mode": "all",
      "ourCoins": 10,
      "otherChildren": 0
    },
    "mapdelta": {
      "at": 1792409496746,
      "updated": [
        {
          "mint": "AScJypsSKih2rryTtTxLqeH6eoazmoYgSYJS6WjHpump",
          "mcapUsd": null,
          "lockedUsd": null,
          "children": 0,
          "descendants": 0,
          "migrated": true,
          "name": "Xtremely Big Titties",
          "symbol": "XBT",
          "image": "https://sporepad.com/api/img?u=https%3A%2F%2Faxiomtrading-v2.axiom-cdn.io%2FjGkwvtc8uDZ9CFReDvm2MhGfQ8Bbbs3J4V2xSCQpump.webp"
        },
        {
          "mint": "8NfX91yvHXyHKn8cnMjg9Q4bCeRLKFDoVtEomXstpump",
          "mcapUsd": null,
          "lockedUsd": null,
          "children": 39,
          "descendants": 39,
          "migrated": true,
          "name": "XBT",
          "symbol": "XBT",
          "image": "https://sporepad.com/api/img?u=https%3A%2F%2Faxiomtrading-v2.axiom-cdn.io%2FBLLieANeMifThH5gBeKRaNixYJPkf7fuM13VZfJ5STNK.webp"
        }
      ]
    }
  },
  "counts": {
    "treeShown": 4,
    "treeTotal": 9,
    "roots": 2232,
    "mapTotal": 16247,
    "heatMints": 1662,
    "heatShown": 3,
    "deltaTotal": 38,
    "deltaShown": 2,
    "mapdeltaEntries": 3,
    "recordedPair": true
  }
};
