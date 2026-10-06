#!/usr/bin/env bash
# Reads the result of the in-app contract run from logcat; run it after .maestro/nfc-contract.yaml.
set -euo pipefail
line=$(adb logcat -d -s ReactNativeJS | grep -o "NFCLAB {\"suite\":\"contract\",\"passed\":[0-9]*,\"failed\":[0-9]*}" | tail -1)
echo "$line"
[ "$line" = "NFCLAB {\"suite\":\"contract\",\"passed\":10,\"failed\":0}" ]
