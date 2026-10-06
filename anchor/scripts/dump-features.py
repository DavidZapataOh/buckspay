#!/usr/bin/env python3
"""Writes the feature gates of each cluster, read from the feature accounts, for the LiteSVM tests.

Every feature of the pinned agave-feature-set gets one line: `<id> <activation slot or -> <name>`.
Usage: dump-features.py <agave-feature-set lib.rs> <output directory>
"""
import base64
import json
import re
import struct
import sys
import urllib.request

source = open(sys.argv[1]).read()
features = re.findall(
    r"pub mod (\w+) \{\s*(?://[^\n]*\n\s*)*(?:use [^;]+;\s*)?solana_pubkey::declare_id!\(\"(\w+)\"\)", source
)
CLUSTERS = {
    "devnet": "https://api.devnet.solana.com",
    "mainnet": "https://api.mainnet-beta.solana.com",
}
for cluster, url in CLUSTERS.items():
    lines = []
    for start in range(0, len(features), 100):
        chunk = features[start : start + 100]
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getMultipleAccounts",
                "params": [[key for _, key in chunk], {"encoding": "base64"}],
            }
        ).encode()
        request = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        reply = json.load(urllib.request.urlopen(request))
        for (name, key), account in zip(chunk, reply["result"]["value"]):
            slot = "-"
            if account is not None:
                data = base64.b64decode(account["data"][0])
                if len(data) >= 9 and data[0] == 1:
                    slot = str(struct.unpack("<Q", data[1:9])[0])
            lines.append(f"{key} {slot} {name}\n")
    with open(f"{sys.argv[2]}/features-{cluster}.txt", "w") as out:
        out.writelines(lines)
    active = sum(1 for line in lines if line.split()[1] != "-")
    print(cluster, len(lines), "features,", active, "active")
