//! What the gateway does after a crash and with a lagging RPC: no record it paid for is
//! forgotten for good, and none is counted forever. A crash between the send and its confirmation,
//! and a stale read of the chain, are the first tests of this file.
use buckspay_gateway::float::*;
use buckspay_protocol::lock::RECORD_TTL;
use std::collections::HashSet;

const RENT: u64 = 1_061_720;
const NOW: u32 = 1_900_000_000;
const SLOT: u64 = 1_000;
const USDC: u64 = 1_000_000;
const CLOSABLE: u32 = NOW + 31 * DAY;

fn caps() -> Caps {
    Caps::pilot(RECORD_TTL)
}

fn address(n: u64) -> [u8; 32] {
    let mut a = [0; 32];
    a[..8].copy_from_slice(&n.to_le_bytes());
    a
}

fn request(first: u64, count: u64) -> Request {
    Request {
        kind: Kind::Settlement,
        prefix: Prefix::V4([10, 0, 1]),
        key: [1; 33],
        issuer: [1; 33],
        lock: [1; 32],
        bond: 100 * USDC,
        amount: count * USDC,
        records: (first..first + count)
            .map(|i| NewRecord {
                address: address(i),
                closable_at: CLOSABLE,
            })
            .collect(),
        rent: RENT,
        now: NOW,
    }
}

fn all(count: u64) -> HashSet<[u8; 32]> {
    (0..count).map(address).collect()
}

fn read(slot: u64, existing: HashSet<[u8; 32]>) -> Read {
    Read { slot, existing }
}

fn ledger(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(name);
    (dir, path)
}

fn begin(limits: &std::sync::Arc<SettlementLimits>, r: Request) -> Sending {
    limits
        .reserve(r)
        .unwrap()
        .begin(NOW, SLOT, 100 * USDC)
        .unwrap()
}

#[test]
fn a_crash_between_the_send_and_its_confirmation_orphans_nothing() {
    let (_dir, path) = ledger("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    let sending = begin(&limits, request(0, 3));
    // The transaction is sent here and lands; the process dies before `landed` or `unknown`.
    std::mem::forget(sending);
    drop(limits);
    let again = SettlementLimits::open(caps(), &path).unwrap();
    assert_eq!(again.open_records(), 3, "a restart still knows the three");
    assert_eq!(again.status(NOW).open_float, 3 * RENT);
    assert_eq!(again.open_of_lock(&[1; 32]), 3);
    assert_eq!(again.sponsored_by_prefix(Prefix::V4([10, 0, 1]), NOW), 1);
    // The janitor reads the chain: the records are there, and from now on they are known.
    let outcome = again.reconcile(&read(SLOT + 10, all(3)), NOW + 5).unwrap();
    assert_eq!(
        outcome,
        Reconciled {
            stale: false,
            forgotten: 0
        }
    );
    // They are closed when they are due, with the margin.
    assert!(again.closable(CLOSABLE + 119, 10).is_empty());
    assert_eq!(again.closable(CLOSABLE + 120, 10).len(), 3);
}

#[test]
fn a_crash_between_writing_the_send_down_and_making_it_frees_the_float_when_the_blockhash_is_gone()
{
    let (_dir, path) = ledger("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    std::mem::forget(begin(&limits, request(0, 3)));
    drop(limits);
    let again = SettlementLimits::open(caps(), &path).unwrap();
    let none = HashSet::new();
    // It may still land: a read soon after, or one long after but before the grace, proves nothing.
    again
        .reconcile(&read(SLOT + 10, none.clone()), NOW + 10)
        .unwrap();
    again
        .reconcile(&read(SLOT + 400, none.clone()), NOW + 60)
        .unwrap();
    assert_eq!(again.open_records(), 3);
    // After the grace, in a read taken after the blockhash expired, it never landed.
    let outcome = again.reconcile(&read(SLOT + 401, none), NOW + 120).unwrap();
    assert_eq!(outcome.forgotten, 3);
    assert_eq!(again.status(NOW).open_float, 0);
    assert_eq!(
        again.sponsored_by_prefix(Prefix::V4([10, 0, 1]), NOW),
        1,
        "the attempt still counts against the limits"
    );
}

/// A replica that lags behind the send proves nothing, however late the clock says it is.
#[test]
fn a_read_from_before_the_blockhash_expired_cannot_forget_a_written_down_send() {
    let limits = SettlementLimits::new(caps());
    std::mem::forget(begin(&limits, request(0, 3)));
    let after_the_grace = NOW + 500;
    let lagging = limits
        .reconcile(&read(SLOT + 290, HashSet::new()), after_the_grace)
        .unwrap();
    assert_eq!((lagging.forgotten, limits.open_records()), (0, 3));
    let current = limits
        .reconcile(&read(SLOT + 301, HashSet::new()), after_the_grace)
        .unwrap();
    assert_eq!((current.forgotten, limits.open_records()), (3, 0));
}

#[test]
fn a_crash_after_the_confirmation_changes_nothing() {
    let (_dir, path) = ledger("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    begin(&limits, request(0, 2)).landed(SLOT + 3).unwrap();
    let before = (
        limits.open_records(),
        limits.status(NOW).open_float,
        limits.counter_rows(),
    );
    drop(limits);
    let again = SettlementLimits::open(caps(), &path).unwrap();
    assert_eq!(
        before,
        (
            again.open_records(),
            again.status(NOW).open_float,
            again.counter_rows()
        )
    );
}

/// A read from before the record landed, or from a replica that has not seen it yet, is not an
/// answer. Only newer reads that keep missing it, one after the other, are.
#[test]
fn a_stale_read_cannot_make_the_ledger_forget_a_landed_record() {
    let limits = SettlementLimits::new(caps());
    begin(&limits, request(0, 3)).landed(SLOT + 2).unwrap();
    // Taken before the transaction was confirmed.
    let outcome = limits
        .reconcile(&read(SLOT, HashSet::new()), NOW + 5)
        .unwrap();
    assert_eq!((limits.open_records(), outcome.forgotten), (3, 0));
    // Newer but lagging: two misses are not enough, and a read that sees them starts over.
    limits
        .reconcile(&read(SLOT + 100, HashSet::new()), NOW + 10)
        .unwrap();
    limits
        .reconcile(&read(SLOT + 200, HashSet::new()), NOW + 15)
        .unwrap();
    assert_eq!(limits.open_records(), 3);
    limits
        .reconcile(&read(SLOT + 300, all(3)), NOW + 20)
        .unwrap();
    limits
        .reconcile(&read(SLOT + 400, HashSet::new()), NOW + 25)
        .unwrap();
    limits
        .reconcile(&read(SLOT + 500, HashSet::new()), NOW + 30)
        .unwrap();
    assert_eq!(limits.open_records(), 3, "the sighting reset the count");
    let outcome = limits
        .reconcile(&read(SLOT + 600, HashSet::new()), NOW + 35)
        .unwrap();
    assert_eq!(outcome.forgotten, 3, "three newer reads in a row lack them");
}

#[test]
fn a_read_that_is_not_newer_than_one_applied_changes_nothing() {
    let limits = SettlementLimits::new(caps());
    begin(&limits, request(0, 1)).landed(SLOT).unwrap();
    let miss = |slot| {
        limits
            .reconcile(&read(slot, HashSet::new()), NOW + 1)
            .unwrap()
    };
    assert!(!miss(SLOT + 10).stale);
    for repeated in [SLOT + 10, SLOT + 9, SLOT] {
        assert!(miss(repeated).stale, "slot {repeated}");
    }
    assert!(!miss(SLOT + 20).stale);
    assert_eq!(limits.open_records(), 1, "two misses counted, not five");
    assert_eq!(miss(SLOT + 30).forgotten, 1);
}

#[test]
fn a_record_that_was_due_to_close_is_forgotten_by_one_read() {
    let limits = SettlementLimits::new(caps());
    begin(&limits, request(0, 1)).landed(SLOT).unwrap();
    // Somebody else closed it after `closable_at`: the rent went back, nothing is lent.
    let outcome = limits
        .reconcile(&read(SLOT + 10, HashSet::new()), CLOSABLE + 1)
        .unwrap();
    assert_eq!(outcome.forgotten, 1);
}

/// The scan that does not trust the ledger: every record on chain whose payer is the fee payer
/// is the gateway's, known or not.
#[test]
fn the_scan_adopts_the_records_the_ledger_forgot() {
    let (_dir, path) = ledger("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    begin(&limits, request(0, 1)).landed(SLOT).unwrap();
    let found = |n: u64| Found {
        address: address(n),
        closable_at: CLOSABLE,
        lamports: RENT,
    };
    // The ledger knows record 0; the chain shows 0, 1 and 2 under the fee payer.
    assert_eq!(
        limits
            .adopt(SLOT + 50, &[found(0), found(1), found(2)])
            .unwrap(),
        2
    );
    assert_eq!(limits.open_records(), 3);
    assert_eq!(limits.status(NOW).open_float, 3 * RENT);
    assert_eq!(
        limits.open_of_lock(&[1; 32]),
        1,
        "the adopted ones belong to no known lock"
    );
    // Idempotent, and a read that is not newer is ignored.
    assert_eq!(
        limits
            .adopt(SLOT + 60, &[found(0), found(1), found(2)])
            .unwrap(),
        0
    );
    assert_eq!(limits.adopt(SLOT + 10, &[found(3)]).unwrap(), 0);
    assert_eq!(limits.open_records(), 3);
    // They are closed like the others, and the file survives a restart.
    drop(limits);
    let again = SettlementLimits::open(caps(), &path).unwrap();
    assert_eq!(again.closable(CLOSABLE + 120, 10).len(), 3);
    again.closed(&[address(1), address(2)]).unwrap();
    assert_eq!(again.open_records(), 1);
}

#[test]
fn a_lost_ledger_is_rebuilt_from_the_chain() {
    let (_dir, path) = ledger("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    begin(&limits, request(0, 4)).landed(SLOT).unwrap();
    drop(limits);
    std::fs::remove_file(&path).unwrap();
    let rebuilt = SettlementLimits::open(caps(), &path).unwrap();
    assert_eq!(rebuilt.open_records(), 0);
    let found: Vec<Found> = (0..4)
        .map(|n| Found {
            address: address(n),
            closable_at: CLOSABLE,
            lamports: RENT,
        })
        .collect();
    assert_eq!(rebuilt.adopt(SLOT + 100, &found).unwrap(), 4);
    assert_eq!(rebuilt.status(NOW).open_float, 4 * RENT);
}

/// One record at the boundary must not make the batch revert with `RecordNotClosable`, whatever
/// the gateway's clock says: records are due `close_margin` seconds after `closable_at`.
#[test]
fn the_janitor_batch_leaves_a_margin_and_never_includes_a_send_that_is_not_confirmed() {
    let limits = SettlementLimits::new(caps());
    begin(&limits, request(0, 3)).landed(SLOT).unwrap();
    let margin = caps().close_margin;
    assert!(limits.closable(CLOSABLE, 10).is_empty());
    assert!(limits.closable(CLOSABLE + margin - 1, 10).is_empty());
    assert_eq!(limits.closable(CLOSABLE + margin, 10).len(), 3);
    assert_eq!(
        limits.closable(CLOSABLE + margin, 2).len(),
        2,
        "the batch is bounded"
    );
    let unconfirmed = SettlementLimits::new(caps());
    std::mem::forget(begin(&unconfirmed, request(10, 2)));
    assert!(unconfirmed.closable(CLOSABLE + 10 * DAY, 10).is_empty());
}

#[test]
fn the_oldest_records_are_closed_first() {
    let limits = SettlementLimits::new(caps());
    let at = |first: u64, closable_at: u32| {
        let mut r = request(first, 1);
        r.records[0].closable_at = closable_at;
        r.key = [first as u8 + 1; 33];
        r.prefix = Prefix::V4([10, 0, first as u8 + 1]);
        r
    };
    for (first, closable_at) in [(0, CLOSABLE + 30), (1, CLOSABLE), (2, CLOSABLE + 10)] {
        begin(&limits, at(first, closable_at)).landed(SLOT).unwrap();
    }
    assert_eq!(
        limits.closable(CLOSABLE + DAY, 3),
        vec![address(1), address(2), address(0)]
    );
}

/// The temporary file of a write is the write's own: a file named like the ledger's stem with
/// another extension (another module's, in the same directory) is not touched, and nothing is left
/// behind.
#[test]
fn a_write_uses_a_temporary_file_of_its_own_and_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settlements.json");
    let neighbour = dir.path().join("settlements.tmp");
    std::fs::write(&neighbour, b"another module's file").unwrap();
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    for i in 0..20 {
        begin(
            &limits,
            Request {
                key: [i as u8 + 1; 33],
                prefix: Prefix::V4([10, 0, i as u8 + 1]),
                ..request(i, 1)
            },
        )
        .landed(SLOT)
        .unwrap();
    }
    assert_eq!(std::fs::read(&neighbour).unwrap(), b"another module's file");
    let mut names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["settlements.json", "settlements.tmp"]);
    let reopened = SettlementLimits::open(caps(), &path).unwrap();
    assert_eq!(reopened.open_records(), 20);
}
