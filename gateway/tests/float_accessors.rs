//! What the janitor and the refusals read from the limits: which records are open and when the
//! next one may close.
mod float_support;
use buckspay_gateway::float::DAY;
use float_support::*;

#[test]
fn the_open_records_and_the_next_close_are_what_the_ledger_holds() {
    let limits = buckspay_gateway::float::SettlementLimits::new(caps());
    assert!(limits.open_addresses().is_empty());
    assert_eq!(limits.next_closable(NOW), None);
    land(&limits, settle(1, 1, 0, 2));
    let mut open = limits.open_addresses();
    open.sort();
    assert_eq!(open, vec![address(0), address(1)]);
    assert_eq!(limits.next_closable(NOW), Some(NOW + 31 * DAY));
    // A record already due reports the present, never the past.
    assert_eq!(limits.next_closable(NOW + 40 * DAY), Some(NOW + 40 * DAY));
}
