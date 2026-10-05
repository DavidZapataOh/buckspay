use crate::{hash, kind, ProtocolError, Result, VERSION};

pub const BODY_LEN: usize = 67;

/// `ver ‖ kind ‖ wallet[32] ‖ key[33]`: the device key consents to being bound to `wallet`.
pub fn device_binding_body(wallet: &[u8; 32], key: &[u8; 33]) -> Result<[u8; BODY_LEN]> {
    if !matches!(key[0], 0x02 | 0x03) {
        return Err(ProtocolError::Owner);
    }
    let mut body = [0; BODY_LEN];
    body[0] = VERSION;
    body[1] = kind::DEVICE_BINDING;
    body[2..34].copy_from_slice(wallet);
    body[34..].copy_from_slice(key);
    Ok(body)
}

/// `DOMAIN(device) ‖ wallet ‖ SHA-256(body)`, the message the device key signs.
pub fn device_binding_envelope(
    domain_device: &[u8; 32],
    wallet: &[u8; 32],
    key: &[u8; 33],
) -> Result<[u8; 96]> {
    let body = device_binding_body(wallet, key)?;
    Ok(hash::envelope(domain_device, wallet, &hash::content(&body)))
}

pub const ROTATION_BODY_LEN: usize = 103;

/// `ver ‖ kind ‖ old_wallet[32] ‖ new_wallet[32] ‖ key[33] ‖ rotations:u32`: the device key consents
/// to moving its binding from `old_wallet` to `new_wallet`; `rotations` is the device's counter, so
/// a signature is good for one rotation only.
pub fn device_rotation_body(
    old_wallet: &[u8; 32],
    new_wallet: &[u8; 32],
    key: &[u8; 33],
    rotations: u32,
) -> Result<[u8; ROTATION_BODY_LEN]> {
    if !matches!(key[0], 0x02 | 0x03) {
        return Err(ProtocolError::Owner);
    }
    let mut body = [0; ROTATION_BODY_LEN];
    body[0] = VERSION;
    body[1] = kind::ROTATION;
    body[2..34].copy_from_slice(old_wallet);
    body[34..66].copy_from_slice(new_wallet);
    body[66..99].copy_from_slice(key);
    body[99..].copy_from_slice(&rotations.to_le_bytes());
    Ok(body)
}

/// `DOMAIN(device) ‖ old_wallet ‖ SHA-256(body)`: the slot is the wallet being replaced, as the
/// binding's slot is the wallet being bound.
pub fn device_rotation_envelope(
    domain_device: &[u8; 32],
    old_wallet: &[u8; 32],
    new_wallet: &[u8; 32],
    key: &[u8; 33],
    rotations: u32,
) -> Result<[u8; 96]> {
    let body = device_rotation_body(old_wallet, new_wallet, key, rotations)?;
    Ok(hash::envelope(
        domain_device,
        old_wallet,
        &hash::content(&body),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::DEVNET_GENESIS_HASH;
    use crate::hash::{content, domain, purpose};

    const WALLET: [u8; 32] = [0xa1; 32];

    fn key(tag: u8) -> [u8; 33] {
        let mut key = [tag; 33];
        key[0] = 0x03;
        key
    }

    #[test]
    fn body_is_version_kind_wallet_key() {
        let body = device_binding_body(&WALLET, &key(7)).unwrap();
        assert_eq!(body.len(), BODY_LEN);
        assert_eq!(body[0], VERSION);
        assert_eq!(body[1], kind::DEVICE_BINDING);
        assert_eq!(body[2..34], WALLET);
        assert_eq!(body[34..], key(7));
    }

    #[test]
    fn envelope_is_device_domain_wallet_and_content() {
        let device = domain(purpose::DEVICE, &DEVNET_GENESIS_HASH, &[7; 32]);
        let envelope = device_binding_envelope(&device, &WALLET, &key(7)).unwrap();
        let body = device_binding_body(&WALLET, &key(7)).unwrap();
        assert_eq!(envelope[..32], device);
        assert_eq!(envelope[32..64], WALLET);
        assert_eq!(envelope[64..], content(&body));
    }

    #[test]
    fn another_wallet_gives_another_envelope() {
        let device = domain(purpose::DEVICE, &DEVNET_GENESIS_HASH, &[7; 32]);
        assert_ne!(
            device_binding_envelope(&device, &WALLET, &key(7)),
            device_binding_envelope(&device, &[0xa2; 32], &key(7))
        );
    }

    #[test]
    fn rejects_a_key_that_is_not_a_device_key() {
        for prefix in [0x00, 0x01, 0x04, 0xff] {
            let mut key = key(7);
            key[0] = prefix;
            assert_eq!(
                device_binding_body(&WALLET, &key),
                Err(ProtocolError::Owner)
            );
            assert_eq!(
                device_binding_envelope(&[0; 32], &WALLET, &key),
                Err(ProtocolError::Owner)
            );
        }
    }

    const OLD: [u8; 32] = [0xa1; 32];
    const NEW: [u8; 32] = [0xb2; 32];

    #[test]
    fn rotation_body_is_version_kind_old_new_key_counter() {
        let body = device_rotation_body(&OLD, &NEW, &key(7), 0x0102_0304).unwrap();
        assert_eq!(body.len(), ROTATION_BODY_LEN);
        assert_eq!(body[0], VERSION);
        assert_eq!(body[1], kind::ROTATION);
        assert_eq!(body[2..34], OLD);
        assert_eq!(body[34..66], NEW);
        assert_eq!(body[66..99], key(7));
        assert_eq!(body[99..], 0x0102_0304u32.to_le_bytes());
    }

    #[test]
    fn rotation_envelope_is_device_domain_old_wallet_and_content() {
        let device = domain(purpose::DEVICE, &DEVNET_GENESIS_HASH, &[7; 32]);
        let envelope = device_rotation_envelope(&device, &OLD, &NEW, &key(7), 3).unwrap();
        let body = device_rotation_body(&OLD, &NEW, &key(7), 3).unwrap();
        assert_eq!(envelope[..32], device);
        assert_eq!(envelope[32..64], OLD);
        assert_eq!(envelope[64..], content(&body));
    }

    #[test]
    fn every_field_changes_the_rotation_envelope() {
        let device = domain(purpose::DEVICE, &DEVNET_GENESIS_HASH, &[7; 32]);
        let other_program = domain(purpose::DEVICE, &DEVNET_GENESIS_HASH, &[8; 32]);
        let base = device_rotation_envelope(&device, &OLD, &NEW, &key(7), 3).unwrap();
        for other in [
            device_rotation_envelope(&device, &[0xc3; 32], &NEW, &key(7), 3).unwrap(),
            device_rotation_envelope(&device, &OLD, &[0xc3; 32], &key(7), 3).unwrap(),
            device_rotation_envelope(&device, &OLD, &NEW, &key(8), 3).unwrap(),
            device_rotation_envelope(&device, &OLD, &NEW, &key(7), 4).unwrap(),
            device_rotation_envelope(&other_program, &OLD, &NEW, &key(7), 3).unwrap(),
        ] {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn a_binding_signature_is_never_a_rotation_signature() {
        // The same wallet in both slots is the most favourable case for a confusion: the envelopes
        // still differ because the hashed bodies carry different kinds and lengths.
        let device = domain(purpose::DEVICE, &DEVNET_GENESIS_HASH, &[7; 32]);
        let binding = device_binding_envelope(&device, &OLD, &key(7)).unwrap();
        let rotation = device_rotation_envelope(&device, &OLD, &OLD, &key(7), 0).unwrap();
        assert_ne!(binding, rotation);
        assert_ne!(binding[64..], rotation[64..]);
    }

    #[test]
    fn rotation_rejects_a_key_that_is_not_a_device_key() {
        for prefix in [0x00, 0x01, 0x04, 0xff] {
            let mut bad = key(7);
            bad[0] = prefix;
            assert_eq!(
                device_rotation_body(&OLD, &NEW, &bad, 0),
                Err(ProtocolError::Owner)
            );
            assert_eq!(
                device_rotation_envelope(&[0; 32], &OLD, &NEW, &bad, 0),
                Err(ProtocolError::Owner)
            );
        }
    }
}
