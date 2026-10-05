//! The program ids of the two build profiles. Each id belongs to one profile: the windows of the
//! lifecycle differ between them (see `lock`), and a device key's signatures are bound to the id.

/// The program every real user's locks live in, on devnet.
pub const PRODUCTION_DEVNET_PROGRAM_ID: &str = "zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM";

/// The `short-windows` build, deployed on devnet only, for checks that cannot wait for days.
pub const SHORT_PROGRAM_ID: &str = "JA82vFUvNM3vvRbYbiU3xx748qEchaJ3Htr8FKFEMFKT";
