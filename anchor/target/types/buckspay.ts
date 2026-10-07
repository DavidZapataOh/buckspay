/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/buckspay.json`.
 */
export type Buckspay = {
  "address": "zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM",
  "metadata": {
    "name": "buckspay",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Buckspay on-chain program"
  },
  "instructions": [
    {
      "name": "applyWalletRotation",
      "discriminator": [
        20,
        213,
        22,
        192,
        41,
        156,
        230,
        10
      ],
      "accounts": [
        {
          "name": "device",
          "writable": true
        },
        {
          "name": "rotation",
          "writable": true
        },
        {
          "name": "rentReceiver",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        }
      ]
    },
    {
      "name": "cancelAttesterExit",
      "discriminator": [
        191,
        253,
        128,
        141,
        197,
        233,
        19,
        240
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "attester"
          ]
        },
        {
          "name": "attester",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester.id",
                "account": "attester"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelWalletRotation",
      "discriminator": [
        233,
        63,
        159,
        51,
        196,
        144,
        171,
        206
      ],
      "accounts": [
        {
          "name": "wallet",
          "signer": true,
          "relations": [
            "device"
          ]
        },
        {
          "name": "device",
          "writable": true
        },
        {
          "name": "rotation",
          "writable": true
        },
        {
          "name": "rentReceiver",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        }
      ]
    },
    {
      "name": "claimLostSpend",
      "docs": [
        "Burns what the loss of the branch that lost the contested output proves."
      ],
      "discriminator": [
        90,
        67,
        152,
        110,
        114,
        14,
        106,
        164
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone: the claim pays nobody, so nobody needs standing to file it."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "lock"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Writable because the burn lowers its supply."
          ],
          "writable": true
        },
        {
          "name": "device",
          "docs": [
            "The device that owns the liable lock, read only when the culprit's spend named no lock: its",
            "current wallet is the one a loss paid to itself cannot burn the bond of."
          ],
          "optional": true
        },
        {
          "name": "claim",
          "docs": [
            "which creates it."
          ],
          "writable": true
        },
        {
          "name": "record"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lost",
          "type": {
            "defined": {
              "name": "lostSpend"
            }
          }
        }
      ]
    },
    {
      "name": "claimRewards",
      "docs": [
        "Pays the leaves of the reward pool to the recipient the proofs name. Anyone may submit."
      ],
      "discriminator": [
        4,
        144,
        132,
        71,
        116,
        23,
        151,
        80
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the nullifier accounts."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "rewardConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "rewardMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "poolEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "feeAccount",
          "writable": true
        },
        {
          "name": "recipient",
          "docs": [
            "The proofs bind the owner of this account as the recipient."
          ],
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "claimArgs"
            }
          }
        }
      ]
    },
    {
      "name": "claimUnbacked",
      "docs": [
        "Burns what the loss of a chain the issuer's backing can no longer pay proves."
      ],
      "discriminator": [
        101,
        56,
        237,
        173,
        41,
        93,
        166,
        120
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Anyone: the claim pays nobody, so nobody needs standing to file it."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "lock"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Writable because the burn lowers its supply."
          ],
          "writable": true
        },
        {
          "name": "claim",
          "docs": [
            "which creates it."
          ],
          "writable": true
        },
        {
          "name": "record"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "issue",
          "type": {
            "array": [
              "u8",
              163
            ]
          }
        },
        {
          "name": "spends",
          "type": {
            "vec": {
              "defined": {
                "name": "link"
              }
            }
          }
        }
      ]
    },
    {
      "name": "closeChannel",
      "docs": [
        "Closes a channel whose words can no longer be settled and returns its rent to its payer."
      ],
      "discriminator": [
        0,
        104,
        36,
        1,
        66,
        0,
        103,
        157
      ],
      "accounts": [
        {
          "name": "channel",
          "writable": true
        },
        {
          "name": "payer",
          "docs": [
            "Gets the rent of the channel back, whoever closes it."
          ],
          "writable": true,
          "relations": [
            "channel"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "closeLock",
      "discriminator": [
        58,
        254,
        183,
        130,
        151,
        238,
        95,
        54
      ],
      "accounts": [
        {
          "name": "lock",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "docs": [
            "account, which anyone may have sent lamports to."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "rentReceiver",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        },
        {
          "name": "lockSeq",
          "type": "u32"
        }
      ]
    },
    {
      "name": "closeProofBuffer",
      "docs": [
        "Closes a buffer nobody settled within `STALE_BUFFER_SECS` and returns its rent."
      ],
      "discriminator": [
        130,
        150,
        6,
        35,
        193,
        34,
        243,
        87
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true,
          "relations": [
            "buffer"
          ]
        },
        {
          "name": "buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  111,
                  102,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              },
              {
                "kind": "account",
                "path": "buffer.nonce",
                "account": "proofBuffer"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeRecords",
      "docs": [
        "Closes claims whose retention has passed."
      ],
      "discriminator": [
        37,
        238,
        211,
        208,
        66,
        79,
        182,
        30
      ],
      "accounts": [],
      "args": []
    },
    {
      "name": "closeSpent",
      "docs": [
        "Closes the records whose retention has passed and returns their rent to whoever paid it."
      ],
      "discriminator": [
        120,
        136,
        252,
        212,
        124,
        146,
        228,
        199
      ],
      "accounts": [],
      "args": []
    },
    {
      "name": "createLock",
      "discriminator": [
        171,
        216,
        92,
        167,
        165,
        8,
        153,
        90
      ],
      "accounts": [
        {
          "name": "wallet",
          "signer": true,
          "relations": [
            "device"
          ]
        },
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the lock's three accounts and gets it back at release and close."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "device",
          "writable": true
        },
        {
          "name": "lock",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "funder",
          "writable": true
        },
        {
          "name": "sponsorToken",
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createLockArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initRewardConfig",
      "discriminator": [
        152,
        188,
        130,
        236,
        115,
        237,
        53,
        159
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "rewardConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "admin",
          "type": "pubkey"
        },
        {
          "name": "pauser",
          "type": "pubkey"
        },
        {
          "name": "claimKey",
          "type": {
            "defined": {
              "name": "keyHashes"
            }
          }
        }
      ]
    },
    {
      "name": "initRewardMint",
      "discriminator": [
        7,
        81,
        73,
        12,
        174,
        180,
        120,
        165
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "rewardConfig"
          ]
        },
        {
          "name": "rewardConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "rewardMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "poolEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "tree",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "const",
                "value": [
                  0,
                  0,
                  0,
                  0
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "policy",
          "type": {
            "defined": {
              "name": "rewardPolicy"
            }
          }
        }
      ]
    },
    {
      "name": "initZkConfig",
      "discriminator": [
        151,
        226,
        82,
        118,
        28,
        221,
        246,
        225
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "admin",
          "type": "pubkey"
        },
        {
          "name": "pauser",
          "type": "pubkey"
        },
        {
          "name": "current",
          "type": {
            "defined": {
              "name": "keyHashes"
            }
          }
        }
      ]
    },
    {
      "name": "migrateDevice",
      "docs": [
        "Grows a `Device` that predates the counters to the current layout. Devnet builds only."
      ],
      "discriminator": [
        198,
        211,
        107,
        143,
        97,
        49,
        220,
        206
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "device",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        }
      ]
    },
    {
      "name": "openProofBuffer",
      "docs": [
        "Opens a buffer for the messages of a chain too long for one transaction."
      ],
      "discriminator": [
        87,
        164,
        242,
        233,
        185,
        97,
        175,
        148
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  111,
                  102,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "len",
          "type": "u32"
        }
      ]
    },
    {
      "name": "reclaimOutput",
      "docs": [
        "Takes back an output nobody settled in time, for the wallet its owner's key is bound to."
      ],
      "discriminator": [
        240,
        8,
        244,
        193,
        42,
        67,
        75,
        140
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "device"
        },
        {
          "name": "lock"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "destination",
          "docs": [
            "Owned by the wallet the owner's key is bound to: a reclaim cannot send funds anywhere the",
            "wallet did not already control."
          ],
          "writable": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "owner",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        },
        {
          "name": "issue",
          "type": {
            "array": [
              "u8",
              163
            ]
          }
        },
        {
          "name": "spends",
          "type": {
            "vec": {
              "defined": {
                "name": "link"
              }
            }
          }
        },
        {
          "name": "which",
          "type": "u8"
        },
        {
          "name": "deadline",
          "type": "u32"
        }
      ]
    },
    {
      "name": "recordPrefix",
      "docs": [
        "Records the consumed outputs of a chain without paying, so a later settlement of the chain",
        "needs the signature of its last message only."
      ],
      "discriminator": [
        35,
        56,
        0,
        37,
        93,
        11,
        86,
        45
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the records."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "lock"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "issue",
          "type": {
            "array": [
              "u8",
              163
            ]
          }
        },
        {
          "name": "spends",
          "type": {
            "vec": {
              "defined": {
                "name": "link"
              }
            }
          }
        }
      ]
    },
    {
      "name": "registerAttester",
      "docs": [
        "Registers an attester with its stake. The authority signs and may be a multisig."
      ],
      "discriminator": [
        111,
        233,
        124,
        30,
        66,
        228,
        125,
        85
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the attester's three accounts and gets the ledger's and the escrow's back",
            "when the stake is withdrawn."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "attester",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "args.id"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "funder",
          "writable": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "registerAttesterArgs"
            }
          }
        }
      ]
    },
    {
      "name": "registerDevice",
      "discriminator": [
        210,
        151,
        56,
        68,
        22,
        158,
        90,
        193
      ],
      "accounts": [
        {
          "name": "wallet",
          "docs": [
            "The wallet the key is bound to: its signature is the consent, checked against the binding."
          ],
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays the device account's rent: the wallet itself, or a sponsor."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "device",
          "writable": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        }
      ]
    },
    {
      "name": "releaseLock",
      "discriminator": [
        241,
        251,
        248,
        8,
        198,
        190,
        195,
        6
      ],
      "accounts": [
        {
          "name": "device"
        },
        {
          "name": "lock"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "destination",
          "docs": [
            "Owned by the lock's wallet: a release cannot send funds anywhere the wallet did not already",
            "control."
          ],
          "writable": true
        },
        {
          "name": "rentReceiver",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        },
        {
          "name": "lockSeq",
          "type": "u32"
        }
      ]
    },
    {
      "name": "reportFalseTicket",
      "docs": [
        "Destroys the whole stake of the attester that signed a ticket the chain contradicts."
      ],
      "discriminator": [
        157,
        110,
        192,
        232,
        107,
        121,
        71,
        230
      ],
      "accounts": [
        {
          "name": "reporter",
          "docs": [
            "Anyone: the report pays nobody, so nobody needs standing to file it."
          ],
          "signer": true
        },
        {
          "name": "attester",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Writable because the burn lowers its supply."
          ],
          "writable": true
        },
        {
          "name": "device",
          "docs": [
            "handler."
          ]
        },
        {
          "name": "lock",
          "docs": [
            "handler."
          ]
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "ticket",
          "type": {
            "array": [
              "u8",
              161
            ]
          }
        }
      ]
    },
    {
      "name": "requestAttesterExit",
      "discriminator": [
        81,
        19,
        181,
        211,
        210,
        121,
        186,
        180
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "attester"
          ]
        },
        {
          "name": "attester",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester.id",
                "account": "attester"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "requestWalletRotation",
      "discriminator": [
        17,
        80,
        61,
        5,
        234,
        245,
        246,
        227
      ],
      "accounts": [
        {
          "name": "newWallet",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "device",
          "writable": true
        },
        {
          "name": "rotation",
          "writable": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        }
      ]
    },
    {
      "name": "revokePreviousClaimVk",
      "docs": [
        "Ends the acceptance of the previous claim key at once; the pauser may call it too."
      ],
      "discriminator": [
        168,
        38,
        109,
        198,
        189,
        194,
        166,
        128
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "rewardConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "revokePreviousVk",
      "docs": [
        "Ends the acceptance of the previous verifying key; the pauser or the admin may call it."
      ],
      "discriminator": [
        77,
        141,
        243,
        251,
        222,
        1,
        200,
        194
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "rotateAttesterKey",
      "docs": [
        "Replaces the key that signs tickets; the old one stays accountable for `EXIT_DELAY`."
      ],
      "discriminator": [
        137,
        138,
        222,
        109,
        82,
        98,
        189,
        220
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "attester"
          ]
        },
        {
          "name": "attester",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester.id",
                "account": "attester"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "trustPrevious",
          "type": "bool"
        }
      ]
    },
    {
      "name": "rotateClaimVk",
      "docs": [
        "Replaces the claim key by the one this program carries. With `keep_previous` the replaced",
        "key stays accepted for a while."
      ],
      "discriminator": [
        88,
        46,
        184,
        84,
        37,
        129,
        3,
        143
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "rewardConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "next",
          "type": {
            "defined": {
              "name": "keyHashes"
            }
          }
        },
        {
          "name": "keepPrevious",
          "type": "bool"
        }
      ]
    },
    {
      "name": "rotateRewardTree",
      "docs": [
        "Starts the next epoch's tree once the current one is full. Anyone may call it."
      ],
      "discriminator": [
        213,
        11,
        85,
        50,
        28,
        154,
        49,
        42
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "rewardMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint.mint",
                "account": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "current",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint.mint",
                "account": "rewardMint"
              },
              {
                "kind": "account",
                "path": "rewardMint.epoch",
                "account": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "next",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint.mint",
                "account": "rewardMint"
              },
              {
                "kind": "account",
                "path": "rewardMint.epoch.saturatingAdd1",
                "account": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "rotateVk",
      "discriminator": [
        154,
        158,
        209,
        96,
        215,
        74,
        232,
        58
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "next",
          "type": {
            "defined": {
              "name": "keyHashes"
            }
          }
        },
        {
          "name": "keepPrevious",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setRewardAuthorities",
      "discriminator": [
        60,
        3,
        122,
        75,
        181,
        137,
        88,
        24
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "rewardConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "admin",
          "type": "pubkey"
        },
        {
          "name": "pauser",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setRewardPolicy",
      "discriminator": [
        194,
        18,
        196,
        2,
        199,
        36,
        123,
        235
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "rewardConfig"
          ]
        },
        {
          "name": "rewardConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "rewardMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint.mint",
                "account": "rewardMint"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "claimFee",
          "type": "u64"
        },
        {
          "name": "feeAccount",
          "type": "pubkey"
        },
        {
          "name": "claimCap",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setRewardsPaused",
      "docs": [
        "The pauser may only pause; the admin may do either. Settling words is never paused."
      ],
      "discriminator": [
        237,
        177,
        240,
        194,
        143,
        95,
        101,
        221
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "rewardConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setZkAuthorities",
      "discriminator": [
        131,
        14,
        8,
        186,
        212,
        216,
        133,
        220
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "admin",
          "type": "pubkey"
        },
        {
          "name": "pauser",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setZkMint",
      "discriminator": [
        171,
        150,
        41,
        56,
        64,
        237,
        98,
        132
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "zkMint",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "globalCap",
          "type": "u64"
        },
        {
          "name": "lockCap",
          "type": "u64"
        },
        {
          "name": "recordFee",
          "type": "u64"
        },
        {
          "name": "feeAccount",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setZkPaused",
      "docs": [
        "The pauser may only pause; the admin may do either."
      ],
      "discriminator": [
        178,
        250,
        189,
        144,
        155,
        130,
        18,
        100
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "settleChainProof",
      "docs": [
        "Settles a chain by one batch of proofs: pays the account the last message names and",
        "records every consumed output, with no key or signature of the chain on chain."
      ],
      "discriminator": [
        129,
        215,
        45,
        86,
        29,
        56,
        27,
        65
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the records and of the draws account; the fee payer in the usual case."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  122,
                  107,
                  45,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "zkMint",
          "docs": [
            "reported as `MintNotEnabled`."
          ],
          "writable": true
        },
        {
          "name": "lock"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "destination",
          "docs": [
            "Any token account of the mint; the handler requires its owner to be the account the note",
            "pays, which the proofs bind."
          ],
          "writable": true
        },
        {
          "name": "feeAccount",
          "writable": true
        },
        {
          "name": "draws",
          "writable": true
        },
        {
          "name": "buffer",
          "docs": [
            "The messages, when they did not fit the transaction; closed to its payer, who is the signer."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "vkSha256",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "issuerKey",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        },
        {
          "name": "lockSeq",
          "type": "u32"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "cumEnd",
          "type": "u64"
        },
        {
          "name": "payAmount",
          "type": "u64"
        },
        {
          "name": "expiry",
          "type": "u32"
        },
        {
          "name": "messages",
          "type": {
            "vec": {
              "defined": {
                "name": "wireMessage"
              }
            }
          }
        }
      ]
    },
    {
      "name": "settleChannel",
      "docs": [
        "Settles words of delivery channels into the reward pool: each pays `word_value` out of its",
        "lock, the leaves of what the pool owes are computed here, never taken from the caller."
      ],
      "discriminator": [
        206,
        201,
        217,
        191,
        233,
        79,
        47,
        208
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the channels it creates."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "rewardMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "poolLedger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "poolEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "feeAccount",
          "writable": true
        },
        {
          "name": "tree",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  119,
                  97,
                  114,
                  100,
                  45,
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "rewardMint.epoch",
                "account": "rewardMint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "settleChannelArgs"
            }
          }
        }
      ]
    },
    {
      "name": "settleNote",
      "docs": [
        "Settles the chain `issue` plus `spends` in clear: pays the account its last spend names."
      ],
      "discriminator": [
        21,
        43,
        198,
        188,
        252,
        22,
        228,
        86
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Pays the rent of the records; the fee payer in the usual case."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "lock"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "destination",
          "docs": [
            "Any token account of the mint; the handler requires its owner to be the account the note",
            "pays. The escrow is refused by the runtime's duplicate-account check as well."
          ],
          "writable": true
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "issue",
          "type": {
            "array": [
              "u8",
              163
            ]
          }
        },
        {
          "name": "spends",
          "type": {
            "vec": {
              "defined": {
                "name": "link"
              }
            }
          }
        }
      ]
    },
    {
      "name": "topUpAttester",
      "discriminator": [
        129,
        247,
        114,
        74,
        139,
        217,
        62,
        0
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "attester"
          ]
        },
        {
          "name": "attester",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester.id",
                "account": "attester"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "attester"
          ]
        },
        {
          "name": "funder",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawAttesterStake",
      "discriminator": [
        93,
        174,
        147,
        206,
        151,
        65,
        240,
        59
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "attester"
          ]
        },
        {
          "name": "attester",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester.id",
                "account": "attester"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "attester"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "attester"
          ]
        },
        {
          "name": "destination",
          "docs": [
            "Any token account of the mint but the escrow itself: the authority's signature names it."
          ],
          "writable": true
        },
        {
          "name": "rentReceiver",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "withdrawLock",
      "discriminator": [
        81,
        157,
        253,
        160,
        94,
        29,
        90,
        143
      ],
      "accounts": [
        {
          "name": "wallet",
          "signer": true,
          "relations": [
            "device"
          ]
        },
        {
          "name": "device"
        },
        {
          "name": "lock"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "lock"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "destination",
          "docs": [
            "Any token account of the mint but the escrow itself: the wallet's signature names it."
          ],
          "writable": true
        },
        {
          "name": "rentReceiver",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "key",
          "type": {
            "array": [
              "u8",
              33
            ]
          }
        },
        {
          "name": "lockSeq",
          "type": "u32"
        }
      ]
    },
    {
      "name": "writeProofBuffer",
      "discriminator": [
        3,
        226,
        158,
        231,
        122,
        154,
        12,
        49
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true,
          "relations": [
            "buffer"
          ]
        },
        {
          "name": "buffer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  111,
                  102,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              },
              {
                "kind": "account",
                "path": "buffer.nonce",
                "account": "proofBuffer"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "offset",
          "type": "u32"
        },
        {
          "name": "data",
          "type": "bytes"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "attester",
      "discriminator": [
        145,
        187,
        162,
        7,
        215,
        117,
        215,
        94
      ]
    },
    {
      "name": "channel",
      "discriminator": [
        49,
        159,
        99,
        106,
        220,
        87,
        219,
        88
      ]
    },
    {
      "name": "device",
      "discriminator": [
        153,
        248,
        23,
        39,
        83,
        45,
        68,
        128
      ]
    },
    {
      "name": "ledger",
      "discriminator": [
        43,
        41,
        21,
        213,
        180,
        176,
        95,
        32
      ]
    },
    {
      "name": "lock",
      "discriminator": [
        8,
        255,
        36,
        202,
        210,
        22,
        57,
        137
      ]
    },
    {
      "name": "proofBuffer",
      "discriminator": [
        71,
        133,
        225,
        94,
        9,
        130,
        40,
        161
      ]
    },
    {
      "name": "rewardConfig",
      "discriminator": [
        163,
        174,
        98,
        80,
        230,
        119,
        69,
        64
      ]
    },
    {
      "name": "rewardMint",
      "discriminator": [
        233,
        63,
        191,
        22,
        229,
        91,
        74,
        155
      ]
    },
    {
      "name": "rewardTree",
      "discriminator": [
        255,
        38,
        153,
        166,
        208,
        59,
        189,
        114
      ]
    },
    {
      "name": "rotation",
      "discriminator": [
        185,
        58,
        166,
        143,
        105,
        11,
        94,
        53
      ]
    },
    {
      "name": "zkConfig",
      "discriminator": [
        181,
        176,
        242,
        167,
        108,
        219,
        13,
        202
      ]
    }
  ],
  "events": [
    {
      "name": "leafAppended",
      "discriminator": [
        253,
        59,
        85,
        246,
        117,
        213,
        27,
        175
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "deviceKey",
      "msg": "Device key is not a compressed P-256 point"
    },
    {
      "code": 6001,
      "name": "deviceBinding",
      "msg": "Missing or malformed secp256r1 verification of the device binding"
    },
    {
      "code": 6002,
      "name": "lockSeqMismatch",
      "msg": "lock_seq is not the device's next lock sequence number"
    },
    {
      "code": 6003,
      "name": "lockSeqExhausted",
      "msg": "The device has used every lock sequence number"
    },
    {
      "code": 6004,
      "name": "amountZero",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6005,
      "name": "amountOverflow",
      "msg": "Amount overflows"
    },
    {
      "code": 6006,
      "name": "lockTooShort",
      "msg": "lock_until is too close"
    },
    {
      "code": 6007,
      "name": "lockTooLong",
      "msg": "lock_until is too far"
    },
    {
      "code": 6008,
      "name": "clockOutOfRange",
      "msg": "The cluster clock is outside the supported range"
    },
    {
      "code": 6009,
      "name": "unsupportedMintExtension",
      "msg": "The mint has an extension the program does not support"
    },
    {
      "code": 6010,
      "name": "feeNotAllowed",
      "msg": "A sponsor fee is only allowed on a sponsored first lock"
    },
    {
      "code": 6011,
      "name": "feeTooHigh",
      "msg": "The sponsor fee is above its cap"
    },
    {
      "code": 6012,
      "name": "withdrawTooEarly",
      "msg": "The lock cannot be withdrawn yet"
    },
    {
      "code": 6013,
      "name": "releaseTooEarly",
      "msg": "The lock cannot be released yet"
    },
    {
      "code": 6014,
      "name": "closeTooEarly",
      "msg": "The lock cannot be closed yet"
    },
    {
      "code": 6015,
      "name": "notWithdrawn",
      "msg": "The lock has not been withdrawn"
    },
    {
      "code": 6016,
      "name": "escrowOpen",
      "msg": "The escrow is still open"
    },
    {
      "code": 6017,
      "name": "slashPending",
      "msg": "A slash is still pending in the lock"
    },
    {
      "code": 6018,
      "name": "insufficientEscrow",
      "msg": "The escrow holds less than the ledger owes"
    },
    {
      "code": 6019,
      "name": "rotationBinding",
      "msg": "Missing or malformed secp256r1 verification of the wallet rotation"
    },
    {
      "code": 6020,
      "name": "rotationNotReady",
      "msg": "The wallet rotation cannot be applied yet"
    },
    {
      "code": 6021,
      "name": "sameWallet",
      "msg": "The new wallet is the current wallet"
    },
    {
      "code": 6022,
      "name": "notMigratable",
      "msg": "The account is not a device account to migrate"
    },
    {
      "code": 6023,
      "name": "chainVerification",
      "msg": "The transaction does not carry the secp256r1 verification of exactly this chain"
    },
    {
      "code": 6024,
      "name": "chainInvalid",
      "msg": "The messages are not a valid chain"
    },
    {
      "code": 6025,
      "name": "wrongLock",
      "msg": "The issue does not match the lock it names"
    },
    {
      "code": 6026,
      "name": "tooManySpends",
      "msg": "Too many spends for one instruction"
    },
    {
      "code": 6027,
      "name": "settlementClosed",
      "msg": "The settlement window of the output has closed"
    },
    {
      "code": 6028,
      "name": "lockEnded",
      "msg": "The lock has ended"
    },
    {
      "code": 6029,
      "name": "wrongPayee",
      "msg": "The destination does not belong to the account the note pays"
    },
    {
      "code": 6030,
      "name": "conflictingSpend",
      "msg": "The output was already consumed by another message"
    },
    {
      "code": 6031,
      "name": "alreadySettled",
      "msg": "This message was already paid"
    },
    {
      "code": 6032,
      "name": "reclaimTooEarly",
      "msg": "The output cannot be reclaimed yet"
    },
    {
      "code": 6033,
      "name": "recordAccounts",
      "msg": "Wrong number or address of record accounts"
    },
    {
      "code": 6034,
      "name": "recordNotClosable",
      "msg": "The record cannot be closed yet"
    },
    {
      "code": 6035,
      "name": "reclaimClosed",
      "msg": "The reclaim window of the output has closed"
    },
    {
      "code": 6036,
      "name": "reclaimExpired",
      "msg": "The reclaim signature is past its deadline"
    },
    {
      "code": 6037,
      "name": "unrecordableOutput",
      "msg": "An output of the chain has no record address or no claim address"
    },
    {
      "code": 6038,
      "name": "notConflicting",
      "msg": "The two messages do not conflict"
    },
    {
      "code": 6039,
      "name": "conflictProof",
      "msg": "The proof does not match its body, signer or lock"
    },
    {
      "code": 6040,
      "name": "noBond",
      "msg": "The lock has no free bond to slash"
    },
    {
      "code": 6041,
      "name": "claimTooLate",
      "msg": "The claim deadline of the output has passed"
    },
    {
      "code": 6042,
      "name": "notClaimable",
      "msg": "The loss cannot be claimed from this lock"
    },
    {
      "code": 6043,
      "name": "noRecord",
      "msg": "The output has no record"
    },
    {
      "code": 6044,
      "name": "alreadyClaimed",
      "msg": "The output was already claimed"
    },
    {
      "code": 6045,
      "name": "overCoverage",
      "msg": "The output is larger than the lock's bond covers"
    },
    {
      "code": 6046,
      "name": "stakeTooLow",
      "msg": "The stake is below the minimum"
    },
    {
      "code": 6047,
      "name": "attesterKey",
      "msg": "The key is not a canonical point of the prime-order subgroup"
    },
    {
      "code": 6048,
      "name": "attesterStatus",
      "msg": "The attester's status does not allow this"
    },
    {
      "code": 6049,
      "name": "exitNotReady",
      "msg": "The attester cannot withdraw its stake yet"
    },
    {
      "code": 6050,
      "name": "rotationCooldown",
      "msg": "The key was rotated too recently to rotate again"
    },
    {
      "code": 6051,
      "name": "ticketBinding",
      "msg": "The instruction before this one is not the Ed25519 verification of this ticket"
    },
    {
      "code": 6052,
      "name": "ticketNotProvablyFalse",
      "msg": "The chain does not contradict the ticket"
    },
    {
      "code": 6053,
      "name": "alreadySlashed",
      "msg": "The attester was already slashed"
    },
    {
      "code": 6054,
      "name": "unknownSigner",
      "msg": "The key that signed the ticket is not one the attester answers for"
    },
    {
      "code": 6055,
      "name": "deviceRequired",
      "msg": "A claim on a spend that named no lock needs the device of the lock owner"
    },
    {
      "code": 6056,
      "name": "staleVerifyingKey",
      "msg": "The verifying key is not the one this program accepts"
    },
    {
      "code": 6057,
      "name": "proofRejected",
      "msg": "The batch of proofs does not verify"
    },
    {
      "code": 6058,
      "name": "nonCanonicalPublic",
      "msg": "A value of the proof's public inputs is not a canonical field element"
    },
    {
      "code": 6059,
      "name": "bufferIncomplete",
      "msg": "The proof buffer does not hold every message yet"
    },
    {
      "code": 6060,
      "name": "bufferNotStale",
      "msg": "The proof buffer cannot be closed yet"
    },
    {
      "code": 6061,
      "name": "bufferLength",
      "msg": "The proof buffer has a length that holds no whole number of messages"
    },
    {
      "code": 6062,
      "name": "bufferWrite",
      "msg": "The write does not fit the buffer or leaves a gap"
    },
    {
      "code": 6063,
      "name": "zkPaused",
      "msg": "Private settlement is paused"
    },
    {
      "code": 6064,
      "name": "zkCapExceeded",
      "msg": "The mint's private settlement cap for this window is exhausted"
    },
    {
      "code": 6065,
      "name": "belowRecordFee",
      "msg": "The payment does not exceed the fee for the records it creates"
    },
    {
      "code": 6066,
      "name": "mintNotEnabled",
      "msg": "The mint is not enabled for private settlement"
    },
    {
      "code": 6067,
      "name": "notZkAdmin",
      "msg": "The signer is not allowed to change the private settlement configuration"
    },
    {
      "code": 6068,
      "name": "lockCapTooHigh",
      "msg": "A lock's cap may not exceed a tenth of the mint's cap"
    },
    {
      "code": 6069,
      "name": "testKeysOnMainnet",
      "msg": "The keys of a throwaway ceremony cannot be used on mainnet"
    },
    {
      "code": 6070,
      "name": "wrongFeeAccount",
      "msg": "The fee account is not the one configured for the mint"
    },
    {
      "code": 6071,
      "name": "wordRejected",
      "msg": "The word does not verify against the root of its channel"
    },
    {
      "code": 6072,
      "name": "wordAlreadySettled",
      "msg": "The word was already settled"
    },
    {
      "code": 6073,
      "name": "channelWindowClosed",
      "msg": "The settlement window of the channel has closed"
    },
    {
      "code": 6074,
      "name": "wordValueMismatch",
      "msg": "The commitment does not price its words as the mint does"
    },
    {
      "code": 6075,
      "name": "innersDoNotMatchWords",
      "msg": "The inners are not one per leaf of the words' canonical decomposition"
    },
    {
      "code": 6076,
      "name": "nonCanonicalInner",
      "msg": "An inner is not a canonical field element"
    },
    {
      "code": 6077,
      "name": "tooManyChannels",
      "msg": "Too many channels in one transaction"
    },
    {
      "code": 6078,
      "name": "channelStillOpen",
      "msg": "The channel cannot be closed yet"
    },
    {
      "code": 6079,
      "name": "channelAboveBondQuarter",
      "msg": "The commitment is above a quarter of the lock's bond"
    },
    {
      "code": 6080,
      "name": "commitmentInvalid",
      "msg": "The commitment is malformed or its depth is out of range"
    },
    {
      "code": 6081,
      "name": "notRewardAdmin",
      "msg": "The signer is not allowed to change the reward configuration"
    },
    {
      "code": 6082,
      "name": "notRewardPool",
      "msg": "The ledger is not a reward pool"
    },
    {
      "code": 6083,
      "name": "feeAboveValue",
      "msg": "The fees do not fit the value of a word"
    },
    {
      "code": 6084,
      "name": "treeFull",
      "msg": "The reward tree of this epoch cannot take another batch"
    },
    {
      "code": 6085,
      "name": "treeNotFull",
      "msg": "The reward tree of this epoch still has room"
    },
    {
      "code": 6086,
      "name": "hashFailed",
      "msg": "Poseidon failed on canonical inputs"
    },
    {
      "code": 6087,
      "name": "rewardsPaused",
      "msg": "Rewards are paused"
    },
    {
      "code": 6088,
      "name": "unknownRoot",
      "msg": "The root is not one the tree of this epoch holds"
    },
    {
      "code": 6089,
      "name": "nullifierReused",
      "msg": "A nullifier was already claimed"
    },
    {
      "code": 6090,
      "name": "nonCanonicalNullifier",
      "msg": "A nullifier hash is not a canonical field element"
    },
    {
      "code": 6091,
      "name": "claimRejected",
      "msg": "The claim proof does not verify"
    },
    {
      "code": 6092,
      "name": "feeAboveMax",
      "msg": "The claim fee is above the maximum the proof allows"
    },
    {
      "code": 6093,
      "name": "claimCapExceeded",
      "msg": "The claims in the window are above the cap"
    },
    {
      "code": 6094,
      "name": "badDenomination",
      "msg": "The exponent is not one a word batch can have"
    },
    {
      "code": 6095,
      "name": "staleClaimKey",
      "msg": "The claim key is not the current one, nor the previous one inside its window"
    },
    {
      "code": 6096,
      "name": "claimCount",
      "msg": "The number of claims is zero, above the limit, or not the number of accounts"
    },
    {
      "code": 6097,
      "name": "wrongRewardTree",
      "msg": "The account is not the reward tree of the claim's epoch"
    },
    {
      "code": 6098,
      "name": "wrongNullifierAccount",
      "msg": "The account is not the nullifier account of the claim"
    }
  ],
  "types": [
    {
      "name": "attester",
      "docs": [
        "A registered attester: who answers for it, which mint its stake and tickets are in, and the key",
        "that signs its tickets. Its stake is in the `Ledger` and escrow at `[\"ledger\", attester]` and",
        "`[\"escrow\", attester]`. The record is never closed, so an id is never reused."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u16"
          },
          {
            "name": "authority",
            "docs": [
              "Signs every instruction that changes the attester, and its revocations."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "key",
            "docs": [
              "Signs new tickets."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "prevKey",
            "docs": [
              "The key before the last rotation; all zeros if none. Accountable until `prev_until`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "prevTrustedUntil",
            "docs": [
              "Receivers believe the previous key before this time; zero after a compromise."
            ],
            "type": "u32"
          },
          {
            "name": "prevUntil",
            "type": "u32"
          },
          {
            "name": "registeredAt",
            "type": "u32"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "exitAt",
            "docs": [
              "When the attester asked to leave or was slashed."
            ],
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "channel",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lock",
            "type": "pubkey"
          },
          {
            "name": "commitmentHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "root",
            "docs": [
              "The root of the words, stored at creation: every later batch is verified against it."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "depth",
            "type": "u8"
          },
          {
            "name": "wordValue",
            "type": "u64"
          },
          {
            "name": "cumEnd",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "u32"
          },
          {
            "name": "settled",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "payer",
            "docs": [
              "Gets the rent back when the channel is closed."
            ],
            "type": "pubkey"
          },
          {
            "name": "closableAt",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "channelWords",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issuerKey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "lockSeq",
            "type": "u32"
          },
          {
            "name": "commitment",
            "docs": [
              "Present on the first settlement of a channel: its signature is checked once, by the",
              "secp256r1 instruction of the transaction. Later batches verify against `Channel.root`."
            ],
            "type": {
              "option": {
                "array": [
                  "u8",
                  91
                ]
              }
            }
          },
          {
            "name": "words",
            "type": {
              "vec": {
                "defined": {
                  "name": "wireWord"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "claimArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vkSha256",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxFee",
            "docs": [
              "The fee ceiling every proof of the batch was made with."
            ],
            "type": "u64"
          },
          {
            "name": "claims",
            "type": {
              "vec": {
                "defined": {
                  "name": "oneClaim"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "createLockArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "lockSeq",
            "type": "u32"
          },
          {
            "name": "bond",
            "type": "u64"
          },
          {
            "name": "backing",
            "type": "u64"
          },
          {
            "name": "lockUntil",
            "type": "u32"
          },
          {
            "name": "sponsorFee",
            "docs": [
              "Paid by the wallet to `sponsor_token` on top of `bond + backing`; see `process`."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "device",
      "docs": [
        "A device key bound to a wallet, with the counters of its locks and wallet rotations. The key is",
        "in the account's seeds, so it is not stored. `wallet` and `bump` keep the offsets they have always",
        "had; the counters come after them."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "nextLockSeq",
            "docs": [
              "The sequence number the next lock must use: strictly increasing across mints, never reaches",
              "`NO_LOCK` as a lock's number."
            ],
            "type": "u32"
          },
          {
            "name": "rotations",
            "docs": [
              "Replay counter of wallet rotations."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "keyHashes",
      "docs": [
        "The hashes of the key files the app trusts: verifying key, proving key (binary and dump) and",
        "constraint system."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vk",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "pk",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "dump",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ccs",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "leafAppended",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u32"
          },
          {
            "name": "index",
            "type": "u32"
          },
          {
            "name": "leaf",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "exp",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "ledger",
      "docs": [
        "The mutable accounting of a lock and the authority of its escrow token account. The three",
        "buckets only move forward; see `accounting`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "backingLeft",
            "docs": [
              "Backing not yet paid out."
            ],
            "type": "u64"
          },
          {
            "name": "bondFree",
            "docs": [
              "Bond not committed to a slash."
            ],
            "type": "u64"
          },
          {
            "name": "bondSlashed",
            "docs": [
              "The pool: bond committed to claims, burn and reporter."
            ],
            "type": "u64"
          },
          {
            "name": "payer",
            "docs": [
              "Gets every rent back."
            ],
            "type": "pubkey"
          },
          {
            "name": "key",
            "docs": [
              "The device key, so the locks of one key can be listed with an account filter."
            ],
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "lockSeq",
            "type": "u32"
          },
          {
            "name": "withdrawn",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "link",
      "docs": [
        "One spend of the chain: which output of the previous message it consumes (0 is the payment,",
        "1 the change) and its body. Its signature and slot travel in the precompile instruction."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "input",
            "type": "u8"
          },
          {
            "name": "body",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "lock",
      "docs": [
        "The immutable record of a bond lock. It is written once by `create_lock` and read by everything",
        "else; it states exactly the fields of a bond ticket."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "bond",
            "type": "u64"
          },
          {
            "name": "backing",
            "type": "u64"
          },
          {
            "name": "lockUntil",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "escrowBump",
            "docs": [
              "The canonical bump of the lock's escrow, so settlements derive it without searching: the",
              "issuer's key chooses the lock's address and with it the cost of that search."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "lostSpend",
      "docs": [
        "The chain of a branch that lost: the issue and the spends up to and including the culprit's, the",
        "last spend. The loss claimed is the culprit's payment, output 0 of that spend. `lock_key` and",
        "`lock_seq` name the lock that backed it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "issue",
            "type": {
              "array": [
                "u8",
                163
              ]
            }
          },
          {
            "name": "spends",
            "type": {
              "vec": {
                "defined": {
                  "name": "link"
                }
              }
            }
          },
          {
            "name": "lockKey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "lockSeq",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "oneClaim",
      "docs": [
        "One claim: the tree and root it opens, its nullifier hash, the exponent of its leaf and its",
        "proof. Everything else the proof binds is read from the accounts."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "u32"
          },
          {
            "name": "root",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nullifierHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "exp",
            "type": "u8"
          },
          {
            "name": "proof",
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    },
    {
      "name": "proofBuffer",
      "docs": [
        "Messages written by a settler ahead of the settlement transaction that reads them. The",
        "messages follow this header in the account, `len` bytes of them."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "len",
            "type": "u32"
          },
          {
            "name": "written",
            "docs": [
              "The bytes written so far; writes may not leave a gap."
            ],
            "type": "u32"
          },
          {
            "name": "createdAt",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "registerAttesterArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u16"
          },
          {
            "name": "key",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "stake",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rewardConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pauser",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "docs": [
              "Stops claims only: settling delivery words is never paused."
            ],
            "type": "bool"
          },
          {
            "name": "claimKey",
            "type": {
              "defined": {
                "name": "keyHashes"
              }
            }
          },
          {
            "name": "previousClaimKey",
            "type": {
              "defined": {
                "name": "keyHashes"
              }
            }
          },
          {
            "name": "rotatedAt",
            "docs": [
              "When the key before `claim_key` was replaced; zero when no previous key is accepted."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "rewardMint",
      "docs": [
        "What a mint pays for a delivery word. `word_value`, `word_fee`, `unit` and `max_fee` are fixed",
        "when the mint is configured: a signed commitment is never re-priced."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wordValue",
            "type": "u64"
          },
          {
            "name": "wordFee",
            "type": "u64"
          },
          {
            "name": "unit",
            "type": "u64"
          },
          {
            "name": "maxFee",
            "type": "u64"
          },
          {
            "name": "claimFee",
            "type": "u64"
          },
          {
            "name": "feeAccount",
            "type": "pubkey"
          },
          {
            "name": "claimCap",
            "type": "u64"
          },
          {
            "name": "window",
            "type": {
              "defined": {
                "name": "window"
              }
            }
          },
          {
            "name": "epoch",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "rewardPolicy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wordValue",
            "type": "u64"
          },
          {
            "name": "wordFee",
            "type": "u64"
          },
          {
            "name": "maxFee",
            "type": "u64"
          },
          {
            "name": "claimFee",
            "type": "u64"
          },
          {
            "name": "feeAccount",
            "type": "pubkey"
          },
          {
            "name": "claimCap",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rewardTree",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "type": "u32"
          },
          {
            "name": "nextIndex",
            "type": "u32"
          },
          {
            "name": "rootIndex",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "filled",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                20
              ]
            }
          },
          {
            "name": "roots",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                256
              ]
            }
          }
        ]
      }
    },
    {
      "name": "rotation",
      "docs": [
        "A pending change of a device's wallet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "settleChannelArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "channels",
            "type": {
              "vec": {
                "defined": {
                  "name": "channelWords"
                }
              }
            }
          },
          {
            "name": "inners",
            "docs": [
              "`Poseidon(nullifier, trapdoor)` of the relayer, one per exponent of",
              "`canonical_exps(total words)`, in that order. The program computes the leaves itself."
            ],
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "window",
      "docs": [
        "A rolling draw window: two buckets, the current one and the one before it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "start",
            "type": "i64"
          },
          {
            "name": "cur",
            "type": "u64"
          },
          {
            "name": "prev",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "wireMessage",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "content",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nextBit",
            "type": "u8"
          },
          {
            "name": "sOut",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "proof",
            "type": {
              "array": [
                "u8",
                192
              ]
            }
          }
        ]
      }
    },
    {
      "name": "wireWord",
      "docs": [
        "One word of a channel with the siblings of its path to the root."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "word",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "path",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "zkConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pauser",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "current",
            "type": {
              "defined": {
                "name": "keyHashes"
              }
            }
          },
          {
            "name": "previous",
            "type": {
              "defined": {
                "name": "keyHashes"
              }
            }
          },
          {
            "name": "rotatedAt",
            "docs": [
              "When the key before `current` was replaced; zero when no previous key is accepted."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
