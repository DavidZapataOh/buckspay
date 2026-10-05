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
