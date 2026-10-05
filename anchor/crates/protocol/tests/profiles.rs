//! The committed profile block of `v1.json` is what the apps read to pick their windows and
//! program id; hold the active profile's windows to the crate's constants.
use buckspay_protocol::{
    lock::{
        CLAIM_WINDOW, EXPIRY_STEP, MAX_REGISTRY_AGE, MIN_NOTE_LIFE, RELEASE_DELAY, ROTATION_DELAY,
        TICKET_TTL_MAX,
    },
    CHALLENGE, GRACE,
};
use serde_json::Value;

fn committed() -> Value {
    serde_json::from_str(include_str!("vectors/v1.json")).unwrap()
}

#[test]
fn the_committed_windows_of_the_active_profile_are_the_constants() {
    let profile = if cfg!(feature = "short-windows") {
        "short"
    } else {
        "production"
    };
    let windows = &committed()["profiles"][profile]["windows"];
    let expected = [
        ("grace", GRACE),
        ("challenge", CHALLENGE),
        ("claimWindow", CLAIM_WINDOW),
        ("minNoteLife", MIN_NOTE_LIFE),
        ("releaseDelay", RELEASE_DELAY),
        ("rotationDelay", ROTATION_DELAY),
        ("expiryStep", EXPIRY_STEP),
        ("ticketTtlMax", TICKET_TTL_MAX),
        ("maxRegistryAge", MAX_REGISTRY_AGE),
    ];
    for (name, value) in expected {
        assert_eq!(windows[name], value, "{profile} {name}");
    }
}

#[test]
fn the_profiles_have_distinct_program_ids() {
    let profiles = &committed()["profiles"];
    let short = profiles["short"]["programId"].as_str().unwrap();
    assert_ne!(
        short,
        profiles["production"]["programIds"]["devnet"]
            .as_str()
            .unwrap()
    );
}
