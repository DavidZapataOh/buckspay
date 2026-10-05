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
    }
  ],
  "accounts": [
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
    }
  ],
  "types": [
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
    }
  ]
};
