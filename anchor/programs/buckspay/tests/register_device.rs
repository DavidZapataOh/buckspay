use anchor_lang::{
    error::ErrorCode,
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_instruction},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use buckspay::{device_envelope, BuckspayError, Device, DEVICE_SEED};
use buckspay_protocol::{
    cluster::MAINNET_GENESIS_HASH,
    device::device_binding_envelope,
    hash::{domain, purpose},
};
use litesvm::LiteSVM;
use p256::ecdsa::{signature::Signer as _, Signature, SigningKey};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_precompile_error::PrecompileError;
use solana_secp256r1_program::new_secp256r1_instruction_with_signature;
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError};
use std::collections::BTreeSet;

const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_TARGET_TMPDIR"),
    "/../deploy/buckspay.so"
));

struct DeviceKey(SigningKey);

impl DeviceKey {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_slice(&[seed; 32]).unwrap())
    }
    fn sec1(&self) -> [u8; 33] {
        self.0
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .try_into()
            .unwrap()
    }
    fn sign(&self, message: &[u8]) -> [u8; 64] {
        let signature: Signature = self.0.sign(message);
        signature.normalize_s().to_bytes().into()
    }
    fn high_s(&self, message: &[u8]) -> [u8; 64] {
        let low = self.sign(message);
        let signature = Signature::from_slice(&low).unwrap();
        let (r, s) = signature.split_scalars();
        Signature::from_scalars(r.to_bytes(), (-*s).to_bytes())
            .unwrap()
            .to_bytes()
            .into()
    }
    fn binding(&self, wallet: &Pubkey) -> Instruction {
        let message = device_envelope(wallet, &self.sec1()).unwrap();
        new_secp256r1_instruction_with_signature(&message, &self.sign(&message), &self.sec1())
    }
}

fn device_address(key: &[u8; 33]) -> Pubkey {
    Pubkey::find_program_address(&[DEVICE_SEED, &key[..1], &key[1..]], &buckspay::ID).0
}

/// The device account `register_device` creates: discriminator, wallet and bump.
const DEVICE_SIZE: usize = 8 + 32 + 1;

/// `register_device` paid by the wallet itself, as the app sends it without a sponsor.
fn register(wallet: &Pubkey, key: [u8; 33]) -> Instruction {
    register_paid_by(wallet, wallet, key)
}

/// `register_device` with the device account's rent paid by `payer`.
fn register_paid_by(wallet: &Pubkey, payer: &Pubkey, key: [u8; 33]) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::RegisterDevice {
            wallet: *wallet,
            payer: *payer,
            device: device_address(&key),
            instructions: solana_instructions_sysvar::ID,
            system_program: solana_sdk_ids::system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::RegisterDevice { key }.data(),
    }
}

struct Env {
    svm: LiteSVM,
}

struct Landed {
    units: u64,
    size: usize,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(buckspay::ID, PROGRAM).unwrap();
        Self { svm }
    }

    fn wallet(&mut self) -> Keypair {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
        wallet
    }

    fn send(&mut self, wallet: &Keypair, ixs: &[Instruction]) -> Result<Landed, TransactionError> {
        self.svm.expire_blockhash();
        let message =
            Message::new_with_blockhash(ixs, Some(&wallet.pubkey()), &self.svm.latest_blockhash());
        let message = VersionedMessage::Legacy(message);
        let size = 1 + 64 + message.serialize().len();
        let tx = VersionedTransaction::try_new(message, &[wallet]).unwrap();
        let meta = self.svm.send_transaction(tx).map_err(|failed| {
            failed.meta.logs.iter().for_each(|l| eprintln!("{l}"));
            failed.err
        })?;
        Ok(Landed {
            units: meta.compute_units_consumed,
            size,
        })
    }

    /// Sends `ixs` with `fee_payer` paying the fee, signed by `signers`.
    fn send_signed(
        &mut self,
        fee_payer: &Pubkey,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<Landed, TransactionError> {
        self.svm.expire_blockhash();
        let message =
            Message::new_with_blockhash(ixs, Some(fee_payer), &self.svm.latest_blockhash());
        let message = VersionedMessage::Legacy(message);
        let size = 1 + 64 * signers.len() + message.serialize().len();
        let tx = VersionedTransaction::try_new(message, signers).unwrap();
        let meta = self.svm.send_transaction(tx).map_err(|failed| failed.err)?;
        Ok(Landed {
            units: meta.compute_units_consumed,
            size,
        })
    }

    fn device(&self, key: &[u8; 33]) -> Option<Device> {
        let account = self.svm.get_account(&device_address(key))?;
        assert_eq!(account.owner, buckspay::ID);
        assert_eq!(account.data.len(), DEVICE_SIZE);
        Some(Device::try_deserialize(&mut account.data.as_slice()).unwrap())
    }
}

fn program_error(index: u8, code: u32) -> Result<Landed, TransactionError> {
    Err(TransactionError::InstructionError(
        index,
        InstructionError::Custom(code),
    ))
}

fn assert_err(
    result: Result<Landed, TransactionError>,
    expected: Result<Landed, TransactionError>,
) {
    assert_eq!(result.err(), expected.err());
}

fn binding_error(index: u8) -> Result<Landed, TransactionError> {
    program_error(index, 6000 + BuckspayError::DeviceBinding as u32)
}

fn precompile_error(error: PrecompileError) -> Result<Landed, TransactionError> {
    program_error(0, error as u32)
}

#[test]
fn registers_a_device_key_under_its_wallet() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let device = DeviceKey::new(1);
    let landed = env
        .send(
            &wallet,
            &[
                device.binding(&wallet.pubkey()),
                register(&wallet.pubkey(), device.sec1()),
            ],
        )
        .unwrap();
    println!(
        "register_device: {} CU, {} B transaction",
        landed.units, landed.size
    );

    let stored = env.device(&device.sec1()).unwrap();
    assert_eq!(stored.wallet, wallet.pubkey());
    assert_eq!(
        stored.bump,
        Pubkey::find_program_address(
            &[DEVICE_SEED, &device.sec1()[..1], &device.sec1()[1..]],
            &buckspay::ID
        )
        .1
    );
    let account = env
        .svm
        .get_account(&device_address(&device.sec1()))
        .unwrap();
    assert_eq!(account.data[8..40], wallet.pubkey().to_bytes());
}

#[test]
fn a_wallet_registers_several_keys() {
    let mut env = Env::new();
    let wallet = env.wallet();
    for seed in 1..=3 {
        let device = DeviceKey::new(seed);
        env.send(
            &wallet,
            &[
                device.binding(&wallet.pubkey()),
                register(&wallet.pubkey(), device.sec1()),
            ],
        )
        .unwrap();
    }
}

#[test]
fn a_key_binds_to_one_wallet_only() {
    let mut env = Env::new();
    let (first, second) = (env.wallet(), env.wallet());
    let device = DeviceKey::new(1);
    env.send(
        &first,
        &[
            device.binding(&first.pubkey()),
            register(&first.pubkey(), device.sec1()),
        ],
    )
    .unwrap();
    let again = env.send(
        &second,
        &[
            device.binding(&second.pubkey()),
            register(&second.pubkey(), device.sec1()),
        ],
    );
    assert_err(
        again,
        Err(TransactionError::InstructionError(
            1,
            InstructionError::Custom(0),
        )),
    );
    assert_eq!(env.device(&device.sec1()).unwrap().wallet, first.pubkey());
}

#[test]
fn rejects_a_binding_for_another_wallet() {
    let mut env = Env::new();
    let (victim, attacker) = (env.wallet(), env.wallet());
    let device = DeviceKey::new(1);
    let result = env.send(
        &attacker,
        &[
            device.binding(&victim.pubkey()),
            register(&attacker.pubkey(), device.sec1()),
        ],
    );
    assert_err(result, binding_error(1));
}

#[test]
fn rejects_a_binding_for_another_cluster() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let device = DeviceKey::new(1);
    let mainnet = domain(
        purpose::DEVICE,
        &MAINNET_GENESIS_HASH,
        &buckspay::ID.to_bytes(),
    );
    let message =
        device_binding_envelope(&mainnet, &wallet.pubkey().to_bytes(), &device.sec1()).unwrap();
    let ix =
        new_secp256r1_instruction_with_signature(&message, &device.sign(&message), &device.sec1());
    let result = env.send(&wallet, &[ix, register(&wallet.pubkey(), device.sec1())]);
    assert_err(result, binding_error(1));
}

#[test]
fn rejects_another_key() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let (signer, claimed) = (DeviceKey::new(1), DeviceKey::new(2));
    let result = env.send(
        &wallet,
        &[
            signer.binding(&wallet.pubkey()),
            register(&wallet.pubkey(), claimed.sec1()),
        ],
    );
    assert_err(result, binding_error(1));
}

#[test]
fn rejects_a_high_s_signature() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let device = DeviceKey::new(1);
    let message = device_envelope(&wallet.pubkey(), &device.sec1()).unwrap();
    let ix = new_secp256r1_instruction_with_signature(
        &message,
        &device.high_s(&message),
        &device.sec1(),
    );
    let result = env.send(&wallet, &[ix, register(&wallet.pubkey(), device.sec1())]);
    assert_err(result, precompile_error(PrecompileError::InvalidSignature));
}

#[test]
fn accepts_the_verification_anywhere_before_the_registration() {
    let mut env = Env::new();
    let wallet = env.wallet();
    for seed in 1..=3 {
        let device = DeviceKey::new(seed);
        let verify = device.binding(&wallet.pubkey());
        let budget = ComputeBudgetInstruction::set_compute_unit_limit(60_000);
        let register = register(&wallet.pubkey(), device.sec1());
        let ixs = match seed {
            1 => [verify, budget, register],
            2 => [budget, verify, register],
            _ => [verify, register, budget],
        };
        env.send(&wallet, &ixs).unwrap();
        assert_eq!(env.device(&device.sec1()).unwrap().wallet, wallet.pubkey());
    }
}

/// The cost of the app's transaction `[compute unit limit, verification, register_device]`:
/// Anchor's canonical bump search costs 1,500 CU for each bump below 255.
#[test]
fn costs_7916_cu_plus_1500_for_each_bump_below_255() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let mut bumps = BTreeSet::new();
    for seed in 1..=64 {
        let device = DeviceKey::new(seed);
        let (_, bump) = Pubkey::find_program_address(
            &[DEVICE_SEED, &device.sec1()[..1], &device.sec1()[1..]],
            &buckspay::ID,
        );
        let landed = env
            .send(
                &wallet,
                &[
                    ComputeBudgetInstruction::set_compute_unit_limit(200_000),
                    device.binding(&wallet.pubkey()),
                    register(&wallet.pubkey(), device.sec1()),
                ],
            )
            .unwrap();
        assert_eq!(
            landed.units,
            7_916 + 1_500 * u64::from(255 - bump),
            "bump {bump}"
        );
        bumps.insert(bump);
    }
    assert!(bumps.len() >= 3, "{bumps:?}");
}

/// The cost of a registration onto a device account prefunded with less than its rent (a transfer,
/// an allocation and an assignment instead of a creation), the most expensive case, at bump 255.
const PREFUNDED_COMPUTE_UNITS: u32 = 7_916 + 2_917;
/// The compute units the app leaves for instructions a wallet adds to its transaction.
const WALLET_COMPUTE_UNITS: u32 = 4_500;

/// The compute unit limit the app sets on a registration (`registerDeviceComputeUnitLimit`): the
/// most expensive registration at the key's bump plus the wallet's share, and at least 40,000 CU.
fn app_compute_unit_limit(bump: u8) -> u32 {
    (PREFUNDED_COMPUTE_UNITS + 1_500 * u32::from(255 - bump) + WALLET_COMPUTE_UNITS).max(40_000)
}

/// Sends `lamports` to `key`'s device account address before it exists, as anyone can.
fn prefund(env: &mut Env, key: &[u8; 33], lamports: u64) {
    let funder = env.wallet();
    let transfer = system_instruction::transfer(&funder.pubkey(), &device_address(key), lamports);
    env.send(&funder, &[transfer]).unwrap();
}

fn bump(device: &DeviceKey) -> u8 {
    let key = device.sec1();
    Pubkey::find_program_address(&[DEVICE_SEED, &key[..1], &key[1..]], &buckspay::ID).1
}

/// A prefunded device account costs 2,917 CU more with less than its rent, 1,338 CU more with all
/// of it (no transfer), and lands under the app's limit.
#[test]
fn registers_onto_a_prefunded_device_account_within_the_app_limit() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let empty = env.svm.minimum_balance_for_rent_exemption(0);
    let rent = env.svm.minimum_balance_for_rent_exemption(DEVICE_SIZE);
    for (seed, lamports, extra) in [(2, empty, 2_917), (3, rent, 1_338)] {
        let device = DeviceKey::new(seed);
        prefund(&mut env, &device.sec1(), lamports);
        let landed = env
            .send(
                &wallet,
                &[
                    ComputeBudgetInstruction::set_compute_unit_limit(app_compute_unit_limit(bump(
                        &device,
                    ))),
                    device.binding(&wallet.pubkey()),
                    register(&wallet.pubkey(), device.sec1()),
                ],
            )
            .unwrap();
        assert_eq!(
            landed.units,
            7_916 + extra + 1_500 * u64::from(255 - bump(&device)),
            "prefund {lamports}"
        );
        assert_eq!(env.device(&device.sec1()).unwrap().wallet, wallet.pubkey());
        let account = env
            .svm
            .get_account(&device_address(&device.sec1()))
            .unwrap();
        assert_eq!(account.lamports, rent);
    }
}

/// A key whose device account's canonical bump is 235 (a bump of 235 or lower has a chance of
/// 2^-20): the secret `0x11 ‖ 0^23 ‖ n` for the first n that gives one, ground once.
fn low_bump_key() -> DeviceKey {
    let mut secret = [0u8; 32];
    secret[0] = 0x11;
    secret[24..].copy_from_slice(&436_876u64.to_be_bytes());
    DeviceKey(SigningKey::from_slice(&secret).unwrap())
}

/// The worst case: a device account prefunded with less than its rent, a wallet that adds a
/// priority fee and 25 transfers, and a key of bump 235. A flat 40,000 CU cannot register it; the
/// app's limit for its bump can.
#[test]
fn the_app_limit_covers_a_prefunded_low_bump_key_with_wallet_instructions() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let payee = env.wallet().pubkey();
    let device = low_bump_key();
    let bump = bump(&device);
    assert_eq!(bump, 235);
    let empty = env.svm.minimum_balance_for_rent_exemption(0);
    prefund(&mut env, &device.sec1(), empty);
    let transaction = |limit: u32| {
        let mut ixs = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(limit),
            ComputeBudgetInstruction::set_compute_unit_price(1_000),
            device.binding(&wallet.pubkey()),
            register(&wallet.pubkey(), device.sec1()),
        ];
        ixs.extend(
            (1..=25)
                .map(|lamports| system_instruction::transfer(&wallet.pubkey(), &payee, lamports)),
        );
        ixs
    };
    assert_err(
        env.send(&wallet, &transaction(40_000)),
        Err(TransactionError::InstructionError(
            3,
            InstructionError::ProgramFailedToComplete,
        )),
    );
    let limit = app_compute_unit_limit(bump);
    let landed = env.send(&wallet, &transaction(limit)).unwrap();
    let added = landed.units - u64::from(PREFUNDED_COMPUTE_UNITS + 1_500 * u32::from(255 - bump));
    println!(
        "wallet instructions: {added} CU; bump {bump}: {} of {limit} CU; {} B transaction",
        landed.units, landed.size
    );
    assert!(added <= u64::from(WALLET_COMPUTE_UNITS));
    assert_eq!(env.device(&device.sec1()).unwrap().wallet, wallet.pubkey());
}

#[test]
fn rejects_a_missing_verification() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let device = DeviceKey::new(1);
    let alone = env.send(&wallet, &[register(&wallet.pubkey(), device.sec1())]);
    assert_err(alone, binding_error(0));
    let after = env.send(
        &wallet,
        &[
            register(&wallet.pubkey(), device.sec1()),
            device.binding(&wallet.pubkey()),
        ],
    );
    assert_err(after, binding_error(0));
}

#[test]
fn rejects_two_verifications_of_the_same_binding() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let device = DeviceKey::new(1);
    let result = env.send(
        &wallet,
        &[
            device.binding(&wallet.pubkey()),
            device.binding(&wallet.pubkey()),
            register(&wallet.pubkey(), device.sec1()),
        ],
    );
    assert_err(result, binding_error(2));
}

/// Each registration takes the verification of its own binding and ignores the others, so one
/// transaction registers several keys whatever the order of their verifications.
#[test]
fn registers_several_keys_in_one_transaction() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let owner = wallet.pubkey();
    let [a, b, c, d] = [1, 2, 3, 4].map(DeviceKey::new);
    env.send(
        &wallet,
        &[
            a.binding(&owner),
            register(&owner, a.sec1()),
            b.binding(&owner),
            register(&owner, b.sec1()),
        ],
    )
    .unwrap();
    env.send(
        &wallet,
        &[
            c.binding(&owner),
            d.binding(&owner),
            register(&owner, c.sec1()),
            register(&owner, d.sec1()),
        ],
    )
    .unwrap();
    for device in [a, b, c, d] {
        assert_eq!(env.device(&device.sec1()).unwrap().wallet, owner);
    }
}

#[test]
fn one_verification_serves_one_registration() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let owner = wallet.pubkey();
    let (device, other) = (DeviceKey::new(1), DeviceKey::new(2));
    // The same key again: its device account already exists.
    let again = env.send(
        &wallet,
        &[
            device.binding(&owner),
            register(&owner, device.sec1()),
            register(&owner, device.sec1()),
        ],
    );
    assert_err(
        again,
        Err(TransactionError::InstructionError(
            2,
            InstructionError::Custom(0),
        )),
    );
    // Another key: the verification is not its binding.
    let other = env.send(
        &wallet,
        &[
            device.binding(&owner),
            register(&owner, device.sec1()),
            register(&owner, other.sec1()),
        ],
    );
    assert_err(other, binding_error(2));
    assert!(env.device(&device.sec1()).is_none());
}

#[test]
fn rejects_a_key_that_is_not_compressed() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let mut key = DeviceKey::new(1).sec1();
    key[0] = 0x04;
    let result = env.send(&wallet, &[register(&wallet.pubkey(), key)]);
    assert_err(
        result,
        program_error(0, 6000 + BuckspayError::DeviceKey as u32),
    );
}

/// Verifications the precompile accepts (each lands alone) that are not the exact inline binding
/// `register_device` rebuilds, so the program refuses every one of them.
#[test]
fn rejects_verifications_the_precompile_accepts() {
    let mut env = Env::new();
    let (wallet, victim) = (env.wallet(), env.wallet());
    let device = DeviceKey::new(1);
    let good = device.binding(&wallet.pubkey());
    let field = |ix: &mut Instruction, at: usize, value: u16| {
        ix.data[at..at + 2].copy_from_slice(&value.to_le_bytes());
    };

    let mut trailing = good.clone();
    trailing.data.push(0);

    let mut padding = good.clone();
    padding.data[1] = 1;

    // The same bytes, with the instruction indices naming the verification itself (0).
    let mut explicit = good.clone();
    for at in [4, 8, 14] {
        field(&mut explicit, at, 0);
    }

    // The same 209 bytes in another order: message, then key, then signature.
    let mut swapped = good.clone();
    swapped.data.truncate(16);
    swapped.data.extend_from_slice(&good.data[113..]);
    swapped.data.extend_from_slice(&good.data[16..113]);
    field(&mut swapped, 2, 16 + 96 + 33);
    field(&mut swapped, 6, 16 + 96);
    field(&mut swapped, 10, 16);

    // The canonical bytes, but the message the precompile checks is a binding of the same key to
    // another wallet, appended after them.
    let mut appended = good.clone();
    let elsewhere = device_envelope(&victim.pubkey(), &device.sec1()).unwrap();
    appended.data[49..113].copy_from_slice(&device.sign(&elsewhere));
    let tail = appended.data.len() as u16;
    appended.data.extend_from_slice(&elsewhere);
    field(&mut appended, 10, tail);

    // Two signatures, both the binding.
    let mut two = good.clone();
    two.data[0] = 2;
    let second: [u8; 14] = two.data[2..16].try_into().unwrap();
    two.data.splice(16..16, second);
    for at in [2, 6, 10, 16, 20, 24] {
        let value = u16::from_le_bytes([two.data[at], two.data[at + 1]]) + 14;
        field(&mut two, at, value);
    }

    for (name, ix) in [
        ("trailing bytes", trailing),
        ("padding byte", padding),
        ("explicit index 0", explicit),
        ("swapped layout", swapped),
        ("appended binding for another wallet", appended),
        ("two signatures", two),
    ] {
        assert!(
            env.send(&wallet, std::slice::from_ref(&ix)).is_ok(),
            "{name}: the precompile refused it"
        );
        let result = env.send(&wallet, &[ix, register(&wallet.pubkey(), device.sec1())]);
        assert_err(result, binding_error(1));
    }
}

/// Which check refuses a transaction: the secp256r1 precompile (instruction 0) or the program.
#[derive(Debug, PartialEq)]
enum Refused {
    Precompile,
    Program,
}

fn refused(result: Result<Landed, TransactionError>) -> Refused {
    match result.err() {
        Some(TransactionError::InstructionError(0, InstructionError::Custom(code)))
            if code <= PrecompileError::InvalidInstructionDataSize as u32 =>
        {
            Refused::Precompile
        }
        Some(error) if Some(error.clone()) == binding_error(1).err() => Refused::Program,
        other => panic!("unexpected result {other:?}"),
    }
}

#[test]
fn every_single_byte_change_of_the_verification_is_rejected() {
    let mut env = Env::new();
    let wallet = env.wallet();
    let device = DeviceKey::new(1);
    let good = device.binding(&wallet.pubkey());
    for at in 0..good.data.len() {
        let mut ix = good.clone();
        ix.data[at] ^= 0x01;
        let result = env.send(&wallet, &[ix, register(&wallet.pubkey(), device.sec1())]);
        // The precompile ignores only the padding byte; the program's exact comparison refuses it.
        let expected = if at == 1 {
            Refused::Program
        } else {
            Refused::Precompile
        };
        assert_eq!(refused(result), expected, "byte {at}");
    }
}

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/secp256r1.json");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A binding of a fixed device key to a fixed wallet, built by the Rust SDK, for the app builder.
fn fixture() -> (Keypair, DeviceKey, String) {
    let wallet = Keypair::new_from_array([0x57; 32]);
    let device = DeviceKey::new(9);
    let message = device_envelope(&wallet.pubkey(), &device.sec1()).unwrap();
    let signature = device.sign(&message);
    let ix = new_secp256r1_instruction_with_signature(&message, &signature, &device.sec1());
    let mut json = serde_json::to_string_pretty(&serde_json::json!({
        "wallet": wallet.pubkey().to_string(),
        "device": hex(&device.sec1()),
        "signature": hex(&signature),
        "message": hex(&message),
        "data": hex(&ix.data),
    }))
    .unwrap();
    json.push('\n');
    (wallet, device, json)
}

#[test]
fn secp256r1_fixture_is_current_and_lands() {
    let (wallet, device, json) = fixture();
    if std::env::var_os("WRITE_FIXTURE").is_some() {
        std::fs::write(FIXTURE, &json).unwrap();
    }
    let committed = std::fs::read_to_string(FIXTURE).unwrap_or_default();
    assert_eq!(
        committed, json,
        "run: WRITE_FIXTURE=1 cargo test -p buckspay --features devnet --test register_device secp256r1_fixture"
    );

    let mut env = Env::new();
    env.svm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
    env.send(
        &wallet,
        &[
            device.binding(&wallet.pubkey()),
            register(&wallet.pubkey(), device.sec1()),
        ],
    )
    .unwrap();
}
/// A wallet with no lamports registers with a sponsor as fee payer and `payer`: the wallet signs,
/// pays nothing and is not written to; the sponsor pays the fee and the rent.
#[test]
fn a_sponsor_pays_for_an_unfunded_wallet() {
    let mut env = Env::new();
    let sponsor = env.wallet();
    let wallet = Keypair::new();
    let device = DeviceKey::new(1);
    let before = env.svm.get_balance(&sponsor.pubkey()).unwrap();
    let landed = env
        .send_signed(
            &sponsor.pubkey(),
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(app_compute_unit_limit(bump(
                    &device,
                ))),
                device.binding(&wallet.pubkey()),
                register_paid_by(&wallet.pubkey(), &sponsor.pubkey(), device.sec1()),
            ],
            &[&sponsor, &wallet],
        )
        .unwrap();
    let rent = env.svm.minimum_balance_for_rent_exemption(DEVICE_SIZE);
    let spent = before - env.svm.get_balance(&sponsor.pubkey()).unwrap();
    println!(
        "sponsored register_device: {} CU, {} B transaction, sponsor spent {spent} lamports, rent {rent}",
        landed.units, landed.size
    );
    assert_eq!(spent, rent + 3 * 5_000);
    assert_eq!(env.svm.get_balance(&wallet.pubkey()).unwrap_or(0), 0);
    assert_eq!(env.device(&device.sec1()).unwrap().wallet, wallet.pubkey());
}

/// The wallet's signature is its consent: without it, a payer cannot bind a device to the wallet.
#[test]
fn the_wallet_must_sign() {
    let mut env = Env::new();
    let sponsor = env.wallet();
    let wallet = Keypair::new();
    let device = DeviceKey::new(1);
    let mut register = register_paid_by(&wallet.pubkey(), &sponsor.pubkey(), device.sec1());
    register.accounts[0].is_signer = false;
    let result = env.send_signed(
        &sponsor.pubkey(),
        &[device.binding(&wallet.pubkey()), register],
        &[&sponsor],
    );
    assert_err(result, program_error(1, ErrorCode::AccountNotSigner as u32));
    assert!(env.device(&device.sec1()).is_none());
}

/// The payer signs for the lamports it gives, even when the wallet pays the fee.
#[test]
fn the_payer_must_sign() {
    let mut env = Env::new();
    let (wallet, payer) = (env.wallet(), env.wallet());
    let device = DeviceKey::new(1);
    let mut register = register_paid_by(&wallet.pubkey(), &payer.pubkey(), device.sec1());
    register.accounts[1].is_signer = false;
    let result = env.send(&wallet, &[device.binding(&wallet.pubkey()), register]);
    assert_err(result, program_error(1, ErrorCode::AccountNotSigner as u32));
}

/// A payer cannot bind a key to a wallet the binding does not name, itself included: the binding is
/// checked against the `wallet` signer, never against the payer.
#[test]
fn a_payer_cannot_bind_a_device_to_another_wallet() {
    let mut env = Env::new();
    let (payer, victim) = (env.wallet(), env.wallet());
    let device = DeviceKey::new(1);
    // The device consented to the victim's wallet; the payer names itself as the wallet.
    let result = env.send(
        &payer,
        &[
            device.binding(&victim.pubkey()),
            register_paid_by(&payer.pubkey(), &payer.pubkey(), device.sec1()),
        ],
    );
    assert_err(result, binding_error(1));
    // The device consented to the payer; the payer names the victim, who does not sign.
    let mut register = register_paid_by(&victim.pubkey(), &payer.pubkey(), device.sec1());
    register.accounts[0].is_signer = false;
    let result = env.send(&payer, &[device.binding(&payer.pubkey()), register]);
    assert_err(result, program_error(1, ErrorCode::AccountNotSigner as u32));
    assert!(env.device(&device.sec1()).is_none());
}
