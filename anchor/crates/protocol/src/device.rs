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
}
