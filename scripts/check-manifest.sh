#!/usr/bin/env bash
# Asserts what the merged manifest of a release build may declare.
#
#   scripts/check-manifest.sh <app-release.apk | merged AndroidManifest.xml>
#   scripts/check-manifest.sh --self-test <app-release.apk | merged AndroidManifest.xml>
#
# An APK is read with apkanalyzer and aapt2 from $ANDROID_HOME. The self-test applies a series of
# deliberate breakages to a copy of the manifest and fails unless each one is rejected by the check
# that is named for it, so the checks cannot pass vacuously.
set -euo pipefail

self_test=0
if [ "${1:-}" = "--self-test" ]; then
  self_test=1
  shift
fi
input=${1:?usage: check-manifest.sh [--self-test] <app-release.apk | AndroidManifest.xml>}
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ $input == *.apk ]]; then
  : "${ANDROID_HOME:?ANDROID_HOME is not set}"
  aapt2=$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 | sort -V | tail -1)
  "$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" manifest print "$input" >"$work/manifest.xml"
  # The service's AID file is a compiled resource whose path the build may rename.
  path=$("$aapt2" dump resources "$input" | grep -A1 'xml/buckspay_apdu_service$' | sed -n 's/.*(file) \(.*\) type=XML/\1/p')
  [ -n "$path" ] || { echo "FAIL aid-file: xml/buckspay_apdu_service is not in the APK"; exit 1; }
  "$aapt2" dump xmltree --file "$path" "$input" >"$work/aid.xml"
else
  cp "$input" "$work/manifest.xml"
  cp "$repo/modules/nfc/android/src/main/res/xml/buckspay_apdu_service.xml" "$work/aid.xml"
fi

python3 - "$work/manifest.xml" "$work/aid.xml" "$repo" "$self_test" <<'PY'
import copy
import glob
import json
import re
import sys
import xml.etree.ElementTree as ET

manifest_path, aid_path, repo, self_test = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
NS = "{http://schemas.android.com/apk/res/android}"
PERM = "android.permission."

# name -> (minSdkVersion, maxSdkVersion, neverForLocation). Anything else, or any other value, fails.
ALLOWED = {
    "CAMERA": (None, None, False),
    "INTERNET": (None, None, False),
    "READ_EXTERNAL_STORAGE": (None, "32", False),
    "WRITE_EXTERNAL_STORAGE": (None, "32", False),
    "USE_BIOMETRIC": (None, None, False),
    "USE_FINGERPRINT": (None, None, False),
    "VIBRATE": (None, None, False),
    "RECORD_AUDIO": (None, None, False),
    "FOREGROUND_SERVICE": (None, None, False),
    "FOREGROUND_SERVICE_CONNECTED_DEVICE": (None, None, False),
    "ACCESS_NETWORK_STATE": (None, None, False),
    "POST_NOTIFICATIONS": (None, None, False),
    "RECEIVE_BOOT_COMPLETED": (None, None, False),
    "WAKE_LOCK": (None, None, False),
    "NFC": (None, None, False),
    "BLUETOOTH_ADVERTISE": ("31", None, False),
    "BLUETOOTH_CONNECT": ("31", None, False),
    "BLUETOOTH_SCAN": ("31", None, True),
    "NEARBY_WIFI_DEVICES": ("32", None, True),
    "ACCESS_WIFI_STATE": (None, None, False),
    "CHANGE_WIFI_STATE": (None, None, False),
    "BLUETOOTH": (None, "30", False),
    "BLUETOOTH_ADMIN": (None, "30", False),
    "ACCESS_COARSE_LOCATION": (None, "28", False),
    "ACCESS_FINE_LOCATION": ("29", "31", False),
}
FEATURES = {
    "android.hardware.nfc": "false",
    "android.hardware.nfc.hce": "false",
    "android.hardware.bluetooth_le": "false",
}
FGS_TYPES = {
    0x1: "dataSync", 0x2: "mediaPlayback", 0x4: "phoneCall", 0x8: "location", 0x10: "connectedDevice",
    0x20: "mediaProjection", 0x40: "camera", 0x80: "microphone", 0x100: "health",
    0x200: "remoteMessaging", 0x400: "systemExempted", 0x800: "shortService", 0x40000000: "specialUse",
}
AID = "F04255434B5350415901"
HOST_APDU = "android.nfc.cardemulation.action.HOST_APDU_SERVICE"


def attrs(e):
    return {k.replace(NS, ""): v for k, v in e.attrib.items()}


def flags(value):
    """usesPermissionFlags from either the symbolic merged manifest or the compiled form."""
    if value is None:
        return set()
    if value.startswith("0x"):
        return {"neverForLocation"} if int(value, 16) & 0x10000 else set()
    return set(value.split("|"))


def fgs_types(value):
    if value is None:
        return set()
    if value.startswith("0x"):
        bits = int(value, 16)
        return {n for b, n in FGS_TYPES.items() if bits & b}
    return set(value.split("|"))


def permissions(root):
    out = {}
    for e in root.findall("uses-permission"):
        a = attrs(e)
        out[a["name"]] = (a.get("minSdkVersion"), a.get("maxSdkVersion"), "neverForLocation" in flags(a.get("usesPermissionFlags")))
    return out


def services(root):
    app = root.find("application")
    return {attrs(s)["name"].rsplit(".", 1)[-1]: s for s in app.findall("service")}


def check_permission_allowlist(root, aid, pkg):
    errs = []
    own = f"{pkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
    declared = permissions(root)
    for name, got in declared.items():
        if name == own:
            continue
        short = name[len(PERM):] if name.startswith(PERM) else None
        if short not in ALLOWED:
            errs.append(f"unexpected permission {name}")
        elif got != ALLOWED[short]:
            errs.append(f"{name} is (min, max, neverForLocation) = {got}, expected {ALLOWED[short]}")
    for short in ALLOWED:
        if PERM + short not in declared:
            errs.append(f"missing permission {PERM + short}")
    return errs


def check_nearby_wifi_unbounded(root, aid, pkg):
    # Nearby Connections needs these on every API level; a maxSdkVersion removes them on the phones
    # that use them.
    declared = permissions(root)
    errs = []
    for short in ("ACCESS_WIFI_STATE", "CHANGE_WIFI_STATE"):
        got = declared.get(PERM + short)
        if got is None:
            errs.append(f"{short} is not declared")
        elif got[1] is not None:
            errs.append(f"{short} carries maxSdkVersion={got[1]}")
    return errs


def check_never_for_location(root, aid, pkg):
    declared = permissions(root)
    return [
        f"{short} lacks neverForLocation"
        for short in ("BLUETOOTH_SCAN", "NEARBY_WIFI_DEVICES")
        if not declared.get(PERM + short, (None, None, False))[2]
    ]


def check_camera_and_audio(root, aid, pkg):
    declared = permissions(root)
    errs = []
    if PERM + "CAMERA" not in declared:
        errs.append("CAMERA is not declared")
    if PERM + "RECORD_AUDIO" not in declared:
        errs.append("RECORD_AUDIO is not declared (the witness module needs it)")
    # RECORD_AUDIO must come from the witness module alone, never from the QR scanner.
    declarers = []
    for path in glob.glob(f"{repo}/modules/*/android/src/main/AndroidManifest.xml"):
        if "RECORD_AUDIO" in open(path).read():
            declarers.append(path.split("/modules/")[1].split("/")[0])
    if declarers != ["copresence"]:
        errs.append(f"RECORD_AUDIO is declared by modules {declarers}, expected only copresence")
    try:
        app = json.load(open(f"{repo}/app.json"))["expo"]
        cam = next(p[1] for p in app["plugins"] if isinstance(p, list) and p[0] == "expo-camera")
        if cam.get("recordAudioAndroid") is not False:
            errs.append("expo-camera is not configured with recordAudioAndroid=false")
    except (OSError, StopIteration, KeyError):
        errs.append("app.json has no expo-camera plugin entry")
    return errs


def check_nfc_service(root, aid, pkg):
    svc = services(root).get("BuckspayApduService")
    if svc is None:
        return ["BuckspayApduService is not declared"]
    a = attrs(svc)
    errs = []
    if a.get("permission") != PERM + "BIND_NFC_SERVICE":
        errs.append(f"service permission is {a.get('permission')}")
    if a.get("exported") != "true":
        errs.append("service is not exported")
    actions = [attrs(x)["name"] for x in svc.findall("intent-filter/action")]
    if HOST_APDU not in actions:
        errs.append("service has no HOST_APDU_SERVICE intent filter")
    metas = [attrs(m) for m in svc.findall("meta-data") if attrs(m).get("name") == "android.nfc.cardemulation.host_apdu_service"]
    if len(metas) != 1 or not metas[0].get("resource"):
        errs.append("service has no host_apdu_service meta-data resource")
    return errs


def check_nfc_aid(root, aid, pkg):
    errs = []
    if aid.tag != "host-apdu-service":
        return ["AID file root is not host-apdu-service"]
    a = attrs(aid)
    for key in ("requireDeviceUnlock", "requireDeviceScreenOn"):
        if a.get(key) != "true":
            errs.append(f"{key} is {a.get(key)}")
    groups = aid.findall("aid-group")
    if len(groups) != 1 or attrs(groups[0]).get("category") != "other":
        errs.append("expected exactly one aid-group in category other")
    else:
        aids = [attrs(f)["name"].upper() for f in groups[0].findall("aid-filter")]
        if aids != [AID]:
            errs.append(f"AID filters are {aids}, expected [{AID}]")
    return errs


def check_features(root, aid, pkg):
    got = {attrs(f)["name"]: attrs(f).get("required") for f in root.findall("uses-feature") if "name" in attrs(f)}
    errs = []
    for name, required in FEATURES.items():
        if got.get(name) != required:
            errs.append(f"uses-feature {name} required={got.get(name)}, expected {required}")
    for name in got:
        if name not in FEATURES and got[name] != "false":
            errs.append(f"uses-feature {name} is required")
    return errs


def check_foreground_services(root, aid, pkg):
    errs = []
    found = {}
    for name, s in services(root).items():
        types = fgs_types(attrs(s).get("foregroundServiceType"))
        if types:
            found[name] = types
    if found != {"MeshService": {"connectedDevice"}}:
        errs.append(f"foreground service types are {found}, expected only MeshService: connectedDevice")
    mesh = services(root).get("MeshService")
    if mesh is not None and attrs(mesh).get("exported") != "false":
        errs.append("MeshService is exported")
    declared = permissions(root)
    for short in ("FOREGROUND_SERVICE", "FOREGROUND_SERVICE_CONNECTED_DEVICE"):
        if PERM + short not in declared:
            errs.append(f"{short} is not declared")
    return errs


CHECKS = [
    ("permission-allowlist", check_permission_allowlist),
    ("nearby-wifi-permissions-unbounded", check_nearby_wifi_unbounded),
    ("never-for-location", check_never_for_location),
    ("camera-and-record-audio", check_camera_and_audio),
    ("nfc-service", check_nfc_service),
    ("nfc-aid", check_nfc_aid),
    ("hardware-features-optional", check_features),
    ("mesh-foreground-service", check_foreground_services),
]


def run(root, aid, quiet=False):
    pkg = root.get("package")
    failed = {}
    for name, fn in CHECKS:
        errs = fn(root, aid, pkg)
        if errs:
            failed[name] = errs
        if not quiet:
            print(f"{'FAIL' if errs else 'ok  '} {name}")
            for e in errs:
                print(f"       {e}")
    return failed


def perm_el(root, short):
    return next(e for e in root.findall("uses-permission") if attrs(e)["name"] == PERM + short)


def drop_perm(short):
    def mutate(root, aid):
        root.remove(perm_el(root, short))
    return mutate


def set_attr(short, key, value):
    def mutate(root, aid):
        perm_el(root, short).set(NS + key, value)
    return mutate


def add_perm(short):
    def mutate(root, aid):
        e = ET.Element("uses-permission")
        e.set(NS + "name", PERM + short)
        root.insert(0, e)
    return mutate


def strip_flags(short):
    def mutate(root, aid):
        perm_el(root, short).attrib.pop(NS + "usesPermissionFlags", None)
    return mutate


def mutate_service(fn):
    def mutate(root, aid):
        fn(services(root)["BuckspayApduService"])
    return mutate


def mesh_type(value):
    def mutate(root, aid):
        s = services(root)["MeshService"]
        if value is None:
            s.attrib.pop(NS + "foregroundServiceType", None)
        else:
            s.set(NS + "foregroundServiceType", value)
    return mutate


def other_service_fgs(root, aid):
    services(root)["MeshTaskService"].set(NS + "foregroundServiceType", "dataSync")


def aid_edit(fn):
    def mutate(root, aid):
        fn(aid)
    return mutate


def set_aid(aid, value):
    aid.find("aid-group/aid-filter").set(NS + "name", value)


MUTANTS = [
    ("extra permission SYSTEM_ALERT_WINDOW", "permission-allowlist", add_perm("SYSTEM_ALERT_WINDOW")),
    ("permission CAMERA removed", "permission-allowlist", drop_perm("CAMERA")),
    ("ACCESS_FINE_LOCATION with maxSdkVersion 35", "permission-allowlist", set_attr("ACCESS_FINE_LOCATION", "maxSdkVersion", "35")),
    ("ACCESS_WIFI_STATE with maxSdkVersion 32", "nearby-wifi-permissions-unbounded", set_attr("ACCESS_WIFI_STATE", "maxSdkVersion", "32")),
    ("CHANGE_WIFI_STATE with maxSdkVersion 30", "nearby-wifi-permissions-unbounded", set_attr("CHANGE_WIFI_STATE", "maxSdkVersion", "30")),
    ("ACCESS_WIFI_STATE removed", "nearby-wifi-permissions-unbounded", drop_perm("ACCESS_WIFI_STATE")),
    ("BLUETOOTH_SCAN loses neverForLocation", "never-for-location", strip_flags("BLUETOOTH_SCAN")),
    ("NEARBY_WIFI_DEVICES loses neverForLocation", "never-for-location", strip_flags("NEARBY_WIFI_DEVICES")),
    ("RECORD_AUDIO removed", "camera-and-record-audio", drop_perm("RECORD_AUDIO")),
    ("CAMERA removed (camera check)", "camera-and-record-audio", drop_perm("CAMERA")),
    ("NFC service removed", "nfc-service", lambda root, aid: root.find("application").remove(services(root)["BuckspayApduService"])),
    ("NFC service loses BIND_NFC_SERVICE", "nfc-service", mutate_service(lambda s: s.attrib.pop(NS + "permission"))),
    ("NFC service loses its HOST_APDU_SERVICE action", "nfc-service", mutate_service(lambda s: s.remove(s.find("intent-filter")))),
    ("NFC service loses its AID meta-data", "nfc-service", mutate_service(lambda s: s.remove(s.find("meta-data")))),
    ("AID changed", "nfc-aid", aid_edit(lambda a: set_aid(a, "F04255434B5350415902"))),
    ("AID category payment", "nfc-aid", aid_edit(lambda a: a.find("aid-group").set(NS + "category", "payment"))),
    ("AID file without requireDeviceUnlock", "nfc-aid", aid_edit(lambda a: a.attrib.pop(NS + "requireDeviceUnlock"))),
    ("AID file without requireDeviceScreenOn", "nfc-aid", aid_edit(lambda a: a.attrib.pop(NS + "requireDeviceScreenOn"))),
    ("NFC feature required", "hardware-features-optional", lambda root, aid: next(f for f in root.findall("uses-feature") if attrs(f).get("name") == "android.hardware.nfc.hce").set(NS + "required", "true")),
    ("mesh service without a foreground type", "mesh-foreground-service", mesh_type(None)),
    ("mesh service typed dataSync", "mesh-foreground-service", mesh_type("dataSync")),
    ("mesh service typed 0x1 (compiled form of dataSync)", "mesh-foreground-service", mesh_type("0x1")),
    ("second foreground service", "mesh-foreground-service", other_service_fgs),
    ("FOREGROUND_SERVICE_CONNECTED_DEVICE removed", "mesh-foreground-service", drop_perm("FOREGROUND_SERVICE_CONNECTED_DEVICE")),
]

def load_xmltree(text):
    """Rebuilds an element tree from `aapt2 dump xmltree` output."""
    stack = []
    top = None
    for line in text.splitlines():
        m = re.match(r"(\s*)E: (\S+)", line)
        if m:
            e = ET.Element(m.group(2))
            depth = len(m.group(1))
            while stack and stack[-1][0] >= depth:
                stack.pop()
            if stack:
                stack[-1][1].append(e)
            else:
                top = e
            stack.append((depth, e))
            continue
        m = re.match(r"\s*A: (\S+?)\(0x[0-9a-f]+\)=(.*)$", line)
        if m and stack:
            value = re.sub(r' \(Raw: .*\)$', "", m.group(2)).strip('"')
            ns, name = m.group(1).rsplit(":", 1)
            stack[-1][1].set("{%s}%s" % (ns, name), value)
    return top


ET.register_namespace("android", NS[1:-1])
root = ET.parse(manifest_path).getroot()
aid_text = open(aid_path).read()
aid = ET.fromstring(aid_text) if aid_text.lstrip().startswith("<") else load_xmltree(aid_text)

failed = run(root, aid)
if failed:
    print(f"\n{len(failed)} check(s) failed")
    sys.exit(1)
print(f"\nall {len(CHECKS)} checks passed")

if self_test:
    print("\nself-test")
    bad = 0
    for label, check, mutate in MUTANTS:
        r, a = copy.deepcopy(root), copy.deepcopy(aid)
        mutate(r, a)
        rejected = run(r, a, quiet=True)
        ok = check in rejected
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {label} -> {check}{'' if ok else ' not rejected'}")
    if bad:
        print(f"\n{bad} mutant(s) were not rejected")
        sys.exit(1)
    print(f"\nall {len(MUTANTS)} mutants rejected")
PY
