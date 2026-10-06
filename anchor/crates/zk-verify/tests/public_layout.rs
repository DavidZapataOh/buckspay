use buckspay_zk_verify::{consumed_outputs, public_inputs};

mod common;

#[test]
fn rebuilds_the_go_public_inputs_from_wire_data_only() {
    let v = common::vectors();
    for chain in &v.valid {
        let (ctx, msgs) = common::wire(chain);
        let got = public_inputs(&ctx, &msgs).unwrap();
        assert_eq!(got.len(), chain.public.len(), "{}", chain.name);
        for (i, p) in got.iter().enumerate() {
            for (j, limb) in p.iter().enumerate() {
                assert_eq!(
                    common::dec(limb),
                    common::normalized(&chain.public[i][j]),
                    "{} {i}.{j}",
                    chain.name
                );
            }
        }
    }
}

#[test]
fn s_in_is_always_the_previous_s_out() {
    let v = common::vectors();
    let (ctx, mut msgs) = common::wire(&v.valid[3]);
    let good = public_inputs(&ctx, &msgs).unwrap();
    assert_eq!(good[2][3], msgs[1].s_out);
    msgs[1].s_out[31] ^= 1;
    let bad = public_inputs(&ctx, &msgs).unwrap();
    assert_eq!(
        bad[2][3], msgs[1].s_out,
        "s_in follows the transmitted s_out; the proof, not the layout, rejects it"
    );
}

#[test]
fn output_ids_use_the_next_bit() {
    let v = common::vectors();
    let (ctx, mut msgs) = common::wire(&v.valid[3]);
    let a = consumed_outputs(&ctx, &msgs).unwrap();
    msgs[0].next_bit ^= 1;
    let b = consumed_outputs(&ctx, &msgs).unwrap();
    assert_ne!(a[0], b[0]);
}

#[test]
fn one_consumed_output_per_spend() {
    let v = common::vectors();
    for chain in &v.valid {
        let (ctx, msgs) = common::wire(chain);
        assert_eq!(consumed_outputs(&ctx, &msgs).unwrap().len(), msgs.len() - 1);
    }
}

#[test]
fn wire_fields_out_of_range_are_refused() {
    let v = common::vectors();
    let (ctx, msgs) = common::wire(&v.valid[3]);
    let mut m = msgs.clone();
    m[0].next_bit = 2;
    assert!(public_inputs(&ctx, &m).is_err());
    let mut m = msgs.clone();
    m[0].s_out = buckspay_zk_verify::fr::MODULUS;
    assert!(public_inputs(&ctx, &m).is_err());
    let mut m = msgs.clone();
    m[2].next_bit = 1;
    assert!(public_inputs(&ctx, &m).is_err());
    let mut m = msgs;
    m[2].s_out[31] = 1;
    assert!(public_inputs(&ctx, &m).is_err());
    let mut bad = ctx;
    bad.cum_end = bad.amount - 1;
    assert!(public_inputs(&bad, &[]).is_err());
}
