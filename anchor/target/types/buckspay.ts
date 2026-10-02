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
    }
  ],
  "types": [
    {
      "name": "device",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
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
            "name": "registeredSlot",
            "type": "u64"
          },
          {
            "name": "registeredAt",
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
