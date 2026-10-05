use buckspay::records::{decide, Record, RecordError, Role, PAID};
use proptest::prelude::*;
use std::collections::HashMap;

#[derive(Clone, Debug)]
struct Op {
    key: u8,
    content: u8,
    role: Role,
}

fn op() -> impl Strategy<Value = Op> {
    (
        0u8..4,
        0u8..3,
        prop_oneof![Just(Role::Prefix), Just(Role::Final), Just(Role::Reclaim)],
    )
        .prop_map(|(key, content, role)| Op { key, content, role })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]

    /// No sequence of presented messages pays one output twice, changes a recorded content, or
    /// pays a content other than the recorded one.
    #[test]
    fn no_output_is_paid_twice_and_the_first_content_wins(ops in proptest::collection::vec(op(), 1..64)) {
        let mut store: HashMap<u8, Record> = HashMap::new();
        let mut paid: HashMap<u8, [u8; 32]> = HashMap::new();
        let mut first: HashMap<u8, [u8; 32]> = HashMap::new();
        for o in ops {
            let content = [o.content; 32];
            let before = store.get(&o.key).copied();
            match decide(before, o.role, content) {
                Ok(d) => {
                    if let Some(record) = d.write {
                        store.insert(o.key, record);
                    }
                    first.entry(o.key).or_insert(content);
                    if d.pay {
                        prop_assert!(paid.insert(o.key, content).is_none(), "paid twice");
                        prop_assert_eq!(store[&o.key].content, content);
                        prop_assert!(store[&o.key].flags & PAID != 0);
                    }
                }
                Err(RecordError::Conflict) => prop_assert_ne!(before.unwrap().content, content),
                Err(RecordError::AlreadySettled) => prop_assert!(before.unwrap().flags & PAID != 0),
            }
            if let Some(record) = store.get(&o.key) {
                prop_assert_eq!(record.content, first[&o.key], "the recorded content never changes");
            }
            if let Some(content) = paid.get(&o.key) {
                prop_assert_eq!(store[&o.key].content, *content);
            }
        }
    }
}
