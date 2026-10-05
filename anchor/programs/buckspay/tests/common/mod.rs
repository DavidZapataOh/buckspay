//! The LiteSVM harness every test file of the program shares: it loads the built SBF binary, a
//! mint of either token program, funded users with registered device keys, and builders for every
//! instruction.
#![allow(dead_code, unused_imports)]

pub use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
};
pub use buckspay::{
    accounting::Debit,
    state::{Device, Ledger, Rotation},
    BuckspayError, CreateLockArgs,
};
pub use buckspay_protocol::{
    lock::{CLAIM_WINDOW, MAX_LOCK, MIN_LOCK, RECORD_TTL, RELEASE_DELAY, ROTATION_DELAY},
    NO_LOCK,
};
pub use solana_account::Account;
pub use solana_keypair::Keypair;
pub use solana_signer::Signer;
pub use solana_transaction::{InstructionError, TransactionError};

use anchor_lang::{
    prelude::Clock,
    solana_program::{program_option::COption, program_pack::Pack},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::{
    token::spl_token,
    token_2022::spl_token_2022::{
        self,
        extension::{
            confidential_transfer::ConfidentialTransferMint,
            default_account_state::DefaultAccountState, memo_transfer::MemoTransfer,
            metadata_pointer::MetadataPointer, mint_close_authority::MintCloseAuthority,
            non_transferable::NonTransferable, pausable::PausableConfig,
            permanent_delegate::PermanentDelegate, transfer_fee::TransferFeeConfig,
            transfer_hook::TransferHook, BaseStateWithExtensionsMut, ExtensionType,
            StateWithExtensionsMut,
        },
    },
    token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata,
};
use litesvm::LiteSVM;
use p256::ecdsa::{signature::Signer as _, Signature, SigningKey};
use solana_message::{Message, VersionedMessage};
use solana_secp256r1_program::new_secp256r1_instruction_with_signature;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_TARGET_TMPDIR"),
    "/../deploy/buckspay.so"
));

mod notes;
mod settle;
pub use notes::*;
pub use settle::*;

/// The clock every environment starts at: far from both ends of the `u32` range.
const START: i64 = 1_800_000_000;
const SOL: u64 = 1_000_000_000;
/// The SPL Memo program, which LiteSVM loads: executable, and nothing a lock should ever call.
const MEMO_PROGRAM: Pubkey = Pubkey::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TokenKind {
    Classic,
    Token2022,
}

/// A mint to create: which token program, how many decimals and which Token-2022 extensions.
#[derive(Clone, Debug)]
pub struct MintSetup {
    pub kind: TokenKind,
    pub decimals: u8,
    pub extensions: Vec<ExtensionType>,
}

impl MintSetup {
    pub fn classic() -> Self {
        Self {
            kind: TokenKind::Classic,
            decimals: 6,
            extensions: vec![],
        }
    }

    pub fn token2022(extensions: &[ExtensionType]) -> Self {
        Self {
            kind: TokenKind::Token2022,
            decimals: 6,
            extensions: extensions.to_vec(),
        }
    }
}

#[derive(Clone)]
pub struct DeviceKey(pub SigningKey);

/// The key of a note's issuer or holder.
pub type Key = DeviceKey;

impl DeviceKey {
    pub fn new(seed: u8) -> Self {
        Self(SigningKey::from_slice(&[seed; 32]).unwrap())
    }

    /// The key with scalar `n + 1`: as many distinct keys as a test wants to search through.
    pub fn from_index(n: u32) -> Self {
        let mut scalar = [0u8; 32];
        scalar[28..].copy_from_slice(&(n + 1).to_be_bytes());
        Self(SigningKey::from_slice(&scalar).unwrap())
    }

    pub fn owner(&self) -> buckspay_protocol::Owner {
        buckspay_protocol::Owner::Device(self.sec1())
    }

    pub fn sec1(&self) -> [u8; 33] {
        self.0
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .try_into()
            .unwrap()
    }

    /// A low-S signature, as the secp256r1 precompile requires.
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        let signature: Signature = self.0.sign(message);
        signature.normalize_s().to_bytes().into()
    }

    pub fn high_s(&self, message: &[u8]) -> [u8; 64] {
        let low = self.sign(message);
        let signature = Signature::from_slice(&low).unwrap();
        let (r, s) = signature.split_scalars();
        Signature::from_scalars(r.to_bytes(), (-*s).to_bytes())
            .unwrap()
            .to_bytes()
            .into()
    }

    /// The verification the key makes of its binding to `wallet`.
    pub fn binding(&self, wallet: &Pubkey) -> Instruction {
        let message = buckspay::device_envelope(wallet, &self.sec1()).unwrap();
        new_secp256r1_instruction_with_signature(&message, &self.sign(&message), &self.sec1())
    }

    /// The verification the key makes of moving its binding from `old` to `new` as rotation `counter`.
    pub fn rotation(&self, old: &Pubkey, new: &Pubkey, counter: u32) -> Instruction {
        let message = buckspay::rotation_envelope(old, new, &self.sec1(), counter).unwrap();
        new_secp256r1_instruction_with_signature(&message, &self.sign(&message), &self.sec1())
    }
}

pub struct User {
    pub wallet: Keypair,
    pub key: DeviceKey,
    pub token: Pubkey,
}

impl User {
    /// The same wallet and token account with another device key.
    pub fn with_key(&self, key: DeviceKey) -> User {
        User {
            wallet: self.wallet.insecure_clone(),
            key,
            token: self.token,
        }
    }
}

#[derive(Debug)]
pub struct Lock {
    pub seq: u32,
    pub address: Pubkey,
    pub ledger: Pubkey,
    pub escrow: Pubkey,
    pub bond: u64,
    pub backing: u64,
    pub until: u32,
}

impl Lock {
    /// A lock's addresses, derived; nothing is sent.
    pub fn at(user: &User, seq: u32, bond: u64, backing: u64, until: u32) -> Lock {
        let address = lock_address(&user.key.sec1(), seq);
        Lock {
            seq,
            address,
            ledger: ledger_address(&address),
            escrow: escrow_address(&address),
            bond,
            backing,
            until,
        }
    }
}

#[derive(Debug)]
pub struct Landed {
    pub units: u64,
    pub size: usize,
}

pub struct Env {
    pub svm: LiteSVM,
    pub mint: Pubkey,
    pub mint_authority: Keypair,
    pub freeze_authority: Keypair,
    pub sponsor: Keypair,
    /// A funded wallet that pays the fee and the rent of the settlements the tests submit.
    pub payer: Keypair,
    pub sponsor_token: Pubkey,
    pub token_program: Pubkey,
    /// Where the stand-ins for later payouts send tokens: out of every escrow and user.
    sink: Pubkey,
    /// Where donations to an escrow come from.
    donor: Pubkey,
    next_key: u8,
    logs: Vec<String>,
}

pub fn lock_address(key: &[u8; 33], seq: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[
            buckspay::LOCK_SEED,
            &key[..1],
            &key[1..],
            &seq.to_le_bytes(),
        ],
        &buckspay::ID,
    )
    .0
}

pub fn ledger_address(lock: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[buckspay::LEDGER_SEED, lock.as_ref()], &buckspay::ID).0
}

pub fn escrow_address(lock: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[buckspay::ESCROW_SEED, lock.as_ref()], &buckspay::ID).0
}

pub fn device_address(key: &[u8; 33]) -> Pubkey {
    Pubkey::find_program_address(
        &[buckspay::DEVICE_SEED, &key[..1], &key[1..]],
        &buckspay::ID,
    )
    .0
}

pub fn rotation_address(key: &[u8; 33]) -> Pubkey {
    Pubkey::find_program_address(
        &[buckspay::ROTATION_SEED, &key[..1], &key[1..]],
        &buckspay::ID,
    )
    .0
}

pub fn program_error(index: u8, code: u32) -> TransactionError {
    TransactionError::InstructionError(index, InstructionError::Custom(code))
}

/// A mint account of either token program with the given extensions initialised to their
/// defaults, `supply` tokens in circulation and the authorities set.
fn mint_account(
    setup: &MintSetup,
    authority: &Pubkey,
    freeze: &Pubkey,
    supply: u64,
) -> (Vec<u8>, Pubkey) {
    let base = spl_token_2022::state::Mint {
        mint_authority: COption::Some(*authority),
        supply,
        decimals: setup.decimals,
        is_initialized: true,
        freeze_authority: COption::Some(*freeze),
    };
    if setup.kind == TokenKind::Classic {
        let mut data = vec![0; spl_token::state::Mint::LEN];
        spl_token::state::Mint::pack(
            spl_token::state::Mint {
                mint_authority: base.mint_authority,
                supply: base.supply,
                decimals: base.decimals,
                is_initialized: true,
                freeze_authority: base.freeze_authority,
            },
            &mut data,
        )
        .unwrap();
        return (data, spl_token::ID);
    }

    let metadata = setup
        .extensions
        .contains(&ExtensionType::TokenMetadata)
        .then(|| TokenMetadata {
            mint: Pubkey::default(),
            name: "Test".into(),
            symbol: "TST".into(),
            uri: "https://example.com".into(),
            ..Default::default()
        });
    let fixed: Vec<ExtensionType> = setup
        .extensions
        .iter()
        .copied()
        .filter(|e| *e != ExtensionType::TokenMetadata)
        .collect();
    let mut len =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&fixed).unwrap();
    if let Some(metadata) = &metadata {
        len += metadata.tlv_size_of().unwrap();
    }
    let mut data = vec![0; len];
    let mut state =
        StateWithExtensionsMut::<spl_token_2022::state::Mint>::unpack_uninitialized(&mut data)
            .unwrap();
    state.base = base;
    state.pack_base();
    state.init_account_type().unwrap();
    for extension in &fixed {
        match extension {
            ExtensionType::TransferFeeConfig => {
                state.init_extension::<TransferFeeConfig>(true).unwrap();
            }
            ExtensionType::TransferHook => {
                state.init_extension::<TransferHook>(true).unwrap();
            }
            ExtensionType::PermanentDelegate => {
                state.init_extension::<PermanentDelegate>(true).unwrap();
            }
            ExtensionType::DefaultAccountState => {
                state
                    .init_extension::<DefaultAccountState>(true)
                    .unwrap()
                    .state = spl_token_2022::state::AccountState::Frozen as u8;
            }
            ExtensionType::Pausable => {
                state.init_extension::<PausableConfig>(true).unwrap();
            }
            ExtensionType::ConfidentialTransferMint => {
                state
                    .init_extension::<ConfidentialTransferMint>(true)
                    .unwrap();
            }
            ExtensionType::NonTransferable => {
                state.init_extension::<NonTransferable>(true).unwrap();
            }
            ExtensionType::MintCloseAuthority => {
                state.init_extension::<MintCloseAuthority>(true).unwrap();
            }
            ExtensionType::MetadataPointer => {
                state.init_extension::<MetadataPointer>(true).unwrap();
            }
            other => panic!("the harness cannot initialise {other:?}"),
        }
    }
    if let Some(metadata) = &metadata {
        state.init_variable_len_extension(metadata, true).unwrap();
    }
    (data, spl_token_2022::ID)
}

fn token_account_data(
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    state: spl_token::state::AccountState,
) -> Vec<u8> {
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(
        spl_token::state::Account {
            mint: *mint,
            owner: *owner,
            amount,
            delegate: COption::None,
            state,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    data
}

impl Env {
    pub fn new(kind: TokenKind) -> Self {
        Self::new_with_mint(MintSetup {
            kind,
            ..MintSetup::classic()
        })
    }

    pub fn new_with_decimals(kind: TokenKind, decimals: u8) -> Self {
        Self::new_with_mint(MintSetup {
            kind,
            decimals,
            extensions: vec![],
        })
    }

    pub fn new_with_mint(setup: MintSetup) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(buckspay::ID, PROGRAM).unwrap();
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = START;
        svm.set_sysvar(&clock);

        let mint = Keypair::new().pubkey();
        let (mint_authority, freeze_authority) = (Keypair::new(), Keypair::new());
        const DONATIONS: u64 = 1_000_000;
        let (data, token_program) = mint_account(
            &setup,
            &mint_authority.pubkey(),
            &freeze_authority.pubkey(),
            DONATIONS,
        );
        svm.set_account(
            mint,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: token_program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        let sponsor = Keypair::new();
        svm.airdrop(&sponsor.pubkey(), 1_000 * SOL).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100 * SOL).unwrap();
        let mut env = Self {
            svm,
            mint,
            mint_authority,
            freeze_authority,
            sponsor_token: Pubkey::default(),
            sponsor,
            payer,
            token_program,
            sink: Pubkey::default(),
            donor: Pubkey::default(),
            next_key: 1,
            logs: Vec::new(),
        };
        env.sponsor_token = env.token_account_of(&env.sponsor.pubkey(), 0);
        env.sink = env.token_account_of(&Keypair::new().pubkey(), 0);
        env.donor = env.token_account_of(&Keypair::new().pubkey(), DONATIONS);
        env
    }

    /// A token account of the mint, owned by `owner`, holding `amount`. The mint's supply is not touched.
    pub fn token_account_of(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let address = Keypair::new().pubkey();
        let data = token_account_data(
            &self.mint,
            owner,
            amount,
            spl_token::state::AccountState::Initialized,
        );
        self.set_account(
            address,
            Account {
                lamports: self.rent(data.len()),
                data,
                owner: self.token_program,
                executable: false,
                rent_epoch: 0,
            },
        );
        address
    }

    pub fn new_token_account(&mut self, owner: &Pubkey) -> Pubkey {
        self.token_account_of(owner, 0)
    }

    /// A token account of another mint.
    pub fn foreign_token_account(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        let address = Keypair::new().pubkey();
        let data = token_account_data(
            mint,
            owner,
            amount,
            spl_token::state::AccountState::Initialized,
        );
        self.set_account(
            address,
            Account {
                lamports: self.rent(data.len()),
                data,
                owner: self.token_program,
                executable: false,
                rent_epoch: 0,
            },
        );
        address
    }

    /// A Token-2022 account that refuses incoming transfers without a memo.
    pub fn memo_required_token_account(&mut self, owner: &Pubkey) -> Pubkey {
        let len = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[
            ExtensionType::MemoTransfer,
        ])
        .unwrap();
        let mut data = vec![0; len];
        let mut state =
            StateWithExtensionsMut::<spl_token_2022::state::Account>::unpack_uninitialized(
                &mut data,
            )
            .unwrap();
        state.base = spl_token_2022::state::Account {
            mint: self.mint,
            owner: *owner,
            amount: 0,
            delegate: COption::None,
            state: spl_token_2022::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        state.pack_base();
        state.init_account_type().unwrap();
        state
            .init_extension::<MemoTransfer>(true)
            .unwrap()
            .require_incoming_transfer_memos = true.into();
        let address = Keypair::new().pubkey();
        self.set_account(
            address,
            Account {
                lamports: self.rent(len),
                data,
                owner: self.token_program,
                executable: false,
                rent_epoch: 0,
            },
        );
        address
    }

    pub fn funded_keypair(&mut self) -> Keypair {
        let keypair = Keypair::new();
        self.svm.airdrop(&keypair.pubkey(), 10 * SOL).unwrap();
        keypair
    }

    fn mint_more(&mut self, amount: u64) {
        let mut account = self.svm.get_account(&self.mint).unwrap();
        let supply = &mut account.data[36..44];
        let total = u64::from_le_bytes(supply.try_into().unwrap()) + amount;
        supply.copy_from_slice(&total.to_le_bytes());
        self.set_account(self.mint, account);
    }

    /// A funded wallet with a registered device key and `tokens` in its token account.
    pub fn user(&mut self, tokens: u64) -> User {
        let user = self.unregistered_user(tokens);
        self.register(user)
    }

    /// Registers the device key of `user` with its wallet.
    pub fn register(&mut self, user: User) -> User {
        let wallet = user.wallet.pubkey();
        self.svm.airdrop(&wallet, 10 * SOL).unwrap();
        self.send(
            &user.wallet,
            &[user.key.binding(&wallet), register_ix(&user, &wallet)],
        )
        .unwrap();
        user
    }

    /// A wallet with no lamports and `tokens` in its token account, whose device key is not registered.
    pub fn unregistered_user(&mut self, tokens: u64) -> User {
        let key = DeviceKey::new(self.next_key);
        self.next_key += 1;
        self.unregistered_user_with(key, tokens)
    }

    /// The same with a chosen device key.
    pub fn unregistered_user_with(&mut self, key: DeviceKey, tokens: u64) -> User {
        let wallet = Keypair::new();
        let token = self.token_account_of(&wallet.pubkey(), tokens);
        if tokens > 0 {
            self.mint_more(tokens);
        }
        User { wallet, key, token }
    }

    pub fn warp(&mut self, unix: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix;
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> u32 {
        u32::try_from(self.svm.get_sysvar::<Clock>().unix_timestamp).unwrap()
    }

    /// Sends `ixs` signed by `wallet`, which also pays the fee.
    pub fn send(
        &mut self,
        wallet: &Keypair,
        ixs: &[Instruction],
    ) -> Result<Landed, TransactionError> {
        self.send_signed(&wallet.pubkey(), ixs, &[wallet])
    }

    /// Sends `ixs` with `fee_payer` paying the fee, signed by `signers`.
    pub fn send_signed(
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
        let meta = self.svm.send_transaction(tx).map_err(|failed| {
            self.logs = failed.meta.logs;
            failed.err
        })?;
        self.logs = meta.logs.clone();
        Ok(Landed {
            units: meta.compute_units_consumed,
            size,
        })
    }

    /// How many times the last transaction invoked `program`, from its logs.
    pub fn invocations_of(&self, program: &Pubkey) -> usize {
        let prefix = format!("Program {program} invoke");
        self.logs
            .iter()
            .filter(|line| line.starts_with(&prefix))
            .count()
    }

    /// A deployed program that is not a token program.
    pub fn foreign_program(&self) -> Pubkey {
        MEMO_PROGRAM
    }

    /// Adds a plain classic mint other than the environment's and returns its address.
    pub fn add_mint(&mut self, decimals: u8) -> Pubkey {
        let address = Keypair::new().pubkey();
        let setup = MintSetup {
            decimals,
            ..MintSetup::classic()
        };
        let (data, owner) = mint_account(
            &setup,
            &Keypair::new().pubkey(),
            &Keypair::new().pubkey(),
            0,
        );
        self.set_account(
            address,
            Account {
                lamports: self.rent(data.len()),
                data,
                owner,
                executable: false,
                rent_epoch: 0,
            },
        );
        address
    }

    /// Puts a plain classic mint at `address`, as the network has at the native mint's.
    pub fn install_classic_mint_at(&mut self, address: Pubkey) {
        let (data, owner) = mint_account(
            &MintSetup::classic(),
            &Keypair::new().pubkey(),
            &Keypair::new().pubkey(),
            0,
        );
        self.set_account(
            address,
            Account {
                lamports: self.rent(data.len()),
                data,
                owner,
                executable: false,
                rent_epoch: 0,
            },
        );
    }

    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        self.token_account(token_account).amount
    }

    /// Turns `address` into a deployed program, as its keypair holder can by deploying to its own
    /// address.
    pub fn make_executable(&mut self, address: &Pubkey) {
        self.svm.add_program(*address, PROGRAM).unwrap();
        assert!(self.svm.get_account(address).unwrap().executable);
    }

    /// The logs of the last transaction, for failure messages.
    pub fn logs(&self) -> String {
        self.logs.join("\n")
    }

    pub fn balance_or_zero(&self, token_account: &Pubkey) -> u64 {
        self.svm
            .get_account(token_account)
            .map_or(0, |_| self.balance(token_account))
    }

    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_balance(address).unwrap_or(0)
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    pub fn token_account(&self, address: &Pubkey) -> spl_token::state::Account {
        let account = self.svm.get_account(address).unwrap();
        spl_token::state::Account::unpack_from_slice(
            &account.data[..spl_token::state::Account::LEN],
        )
        .unwrap()
    }

    pub fn account<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).unwrap();
        assert_eq!(account.owner, buckspay::ID);
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn device(&self, key: &[u8; 33]) -> Device {
        self.account(&device_address(key))
    }

    pub fn try_device(&self, key: &[u8; 33]) -> Option<Device> {
        self.svm.get_account(&device_address(key))?;
        Some(self.device(key))
    }

    pub fn ledger(&self, lock: &Pubkey) -> Ledger {
        self.account(&ledger_address(lock))
    }

    pub fn try_ledger(&self, lock: &Pubkey) -> Option<Ledger> {
        self.svm
            .get_account(&ledger_address(lock))
            .map(|_| self.ledger(lock))
    }

    pub fn rotation(&self, key: &[u8; 33]) -> Rotation {
        self.account(&rotation_address(key))
    }

    pub fn set_account(&mut self, address: Pubkey, account: Account) {
        self.svm.set_account(address, account).unwrap();
    }

    fn write_account<T: AccountSerialize>(&mut self, address: &Pubkey, value: &T) {
        let mut account = self.svm.get_account(address).unwrap();
        account.data.clear();
        value.try_serialize(&mut account.data).unwrap();
        self.set_account(*address, account);
    }

    /// Cuts a device back to the 41 bytes it had before the counters existed.
    #[cfg(feature = "devnet")]
    pub fn shrink_device_to_legacy(&mut self, key: &[u8; 33]) {
        let mut account = self.svm.get_account(&device_address(key)).unwrap();
        account.data.truncate(41);
        account.lamports = self.rent(41);
        self.set_account(device_address(key), account);
    }

    pub fn edit_device(&mut self, key: &[u8; 33], f: impl FnOnce(&mut Device)) {
        let mut device = self.device(key);
        f(&mut device);
        self.write_account(&device_address(key), &device);
    }

    /// Test-only stand-in for the later payout programs: applies a `Ledger` method that moves no tokens.
    pub fn edit_ledger(&mut self, lock: &Pubkey, f: impl FnOnce(&mut Ledger)) {
        let mut ledger = self.ledger(lock);
        f(&mut ledger);
        self.write_account(&ledger_address(lock), &ledger);
    }

    pub fn try_edit(
        &mut self,
        lock: &Pubkey,
        f: impl FnOnce(&mut Ledger) -> anchor_lang::Result<()>,
    ) -> Result<(), TransactionError> {
        let Some(mut ledger) = self.try_ledger(lock) else {
            return Err(TransactionError::AccountNotFound);
        };
        f(&mut ledger)
            .map_err(|_| TransactionError::InstructionError(0, InstructionError::Custom(0)))?;
        self.write_account(&ledger_address(lock), &ledger);
        Ok(())
    }

    /// Test-only stand-in for `pay_out`: applies the `Ledger` method that authorises a payout and
    /// moves exactly the amount of the `Debit` it returns out of the escrow.
    pub fn try_pay(
        &mut self,
        lock: &Lock,
        f: impl FnOnce(&mut Ledger) -> anchor_lang::Result<Debit>,
    ) -> Result<(), TransactionError> {
        let Some(mut ledger) = self.try_ledger(&lock.address) else {
            return Err(TransactionError::AccountNotFound);
        };
        let debit = f(&mut ledger)
            .map_err(|_| TransactionError::InstructionError(0, InstructionError::Custom(0)))?;
        let amount = debit.amount();
        if amount > self.balance_or_zero(&lock.escrow) {
            return Err(TransactionError::InstructionError(
                0,
                InstructionError::Custom(0),
            ));
        }
        self.write_account(&ledger_address(&lock.address), &ledger);
        self.move_tokens(&lock.escrow, &self.sink.clone(), amount);
        Ok(())
    }

    pub fn pay(&mut self, lock: &Lock, f: impl FnOnce(&mut Ledger) -> anchor_lang::Result<Debit>) {
        self.try_pay(lock, f).unwrap();
    }

    pub fn move_tokens_out_of_escrow(&mut self, lock: &Lock, amount: u64) {
        self.move_tokens(&lock.escrow, &self.sink.clone(), amount);
    }

    pub fn donate(&mut self, lock: &Lock, amount: u64) {
        // Nobody can send tokens to an escrow that was closed.
        if self.svm.get_account(&lock.escrow).is_none() {
            return;
        }
        self.move_tokens(&self.donor.clone(), &lock.escrow, amount);
    }

    fn move_tokens(&mut self, from: &Pubkey, to: &Pubkey, amount: u64) {
        for (address, delta) in [(from, false), (to, true)] {
            let mut account = self.svm.get_account(address).unwrap();
            let held = u64::from_le_bytes(account.data[64..72].try_into().unwrap());
            let held = if delta { held + amount } else { held - amount };
            account.data[64..72].copy_from_slice(&held.to_le_bytes());
            self.set_account(*address, account);
        }
    }

    pub fn freeze(&mut self, token_account: &Pubkey) {
        self.set_token_state(token_account, spl_token::state::AccountState::Frozen);
    }

    pub fn thaw(&mut self, token_account: &Pubkey) {
        self.set_token_state(token_account, spl_token::state::AccountState::Initialized);
    }

    fn set_token_state(&mut self, token_account: &Pubkey, state: spl_token::state::AccountState) {
        let mut account = self.svm.get_account(token_account).unwrap();
        account.data[108] = state as u8;
        self.set_account(*token_account, account);
    }

    /// A hash over every account the program owns and every account the token program owns (the
    /// mint, every token account): two equal snapshots mean a transaction changed none of them.
    pub fn snapshot(&self) -> u64 {
        let mut accounts = self.svm.get_program_accounts(&buckspay::ID);
        accounts.extend(self.svm.get_program_accounts(&self.token_program));
        accounts.sort_by_key(|(address, _)| *address);
        let mut hasher = DefaultHasher::new();
        for (address, account) in accounts {
            (address, account.lamports, account.owner, account.data).hash(&mut hasher);
        }
        hasher.finish()
    }

    pub fn total_supply(&self) -> u64 {
        let account = self.svm.get_account(&self.mint).unwrap();
        u64::from_le_bytes(account.data[36..44].try_into().unwrap())
    }

    pub fn circulating(&self, users: &[User]) -> u64 {
        users.iter().map(|user| self.balance(&user.token)).sum()
    }

    pub fn in_escrows(&self, locks: &[(usize, Lock)]) -> u64 {
        locks
            .iter()
            .map(|(_, lock)| self.balance_or_zero(&lock.escrow))
            .sum()
    }

    /// Everything outside users and escrows: what payouts took and what donations have not given yet.
    pub fn paid_out(&self) -> u64 {
        self.balance(&self.sink) + self.balance(&self.donor) + self.balance(&self.sponsor_token)
    }

    /// A lock paid for by the wallet itself.
    pub fn try_lock(
        &mut self,
        user: &User,
        bond: u64,
        backing: u64,
        until: u32,
    ) -> Result<Lock, TransactionError> {
        let seq = self.device(&user.key.sec1()).next_lock_seq;
        let w = user.wallet.pubkey();
        let ix = create_lock_ix(
            self,
            user,
            &w,
            args_for(user, seq, bond, backing, until),
            None,
        );
        self.send_signed(&w, &[ix], &[&user.wallet])?;
        Ok(Lock::at(user, seq, bond, backing, until))
    }

    /// `signer` signs a withdrawal of `owner`'s lock to `owner`'s token account.
    pub fn try_withdraw(
        &mut self,
        owner: &User,
        signer: &User,
        lock: &Lock,
    ) -> Result<(), TransactionError> {
        let mut ix = withdraw_ix(self, owner, lock, &owner.token);
        ix.accounts[0].pubkey = signer.wallet.pubkey();
        let sponsor = self.sponsor.insecure_clone();
        self.send_signed(&sponsor.pubkey(), &[ix], &[&sponsor, &signer.wallet])
            .map(drop)
    }

    /// Anyone releases: the sponsor pays and no wallet signs.
    pub fn try_release(&mut self, owner: &User, lock: &Lock) -> Result<(), TransactionError> {
        let sponsor = self.sponsor.insecure_clone();
        let rent_receiver = self.ledger(&lock.address).payer;
        let ix = release_ix(self, owner, lock, &owner.token, &rent_receiver);
        self.send_signed(&sponsor.pubkey(), &[ix], &[&sponsor])
            .map(drop)
    }

    pub fn try_close(&mut self, owner: &User, lock: &Lock) -> Result<(), TransactionError> {
        let sponsor = self.sponsor.insecure_clone();
        let payer = self
            .try_ledger(&lock.address)
            .map_or(owner.wallet.pubkey(), |ledger| ledger.payer);
        let ix = close_ix(lock, owner.key.sec1(), &payer);
        self.send_signed(&sponsor.pubkey(), &[ix], &[&sponsor])
            .map(drop)
    }
}

pub fn args_for(user: &User, seq: u32, bond: u64, backing: u64, until: u32) -> CreateLockArgs {
    CreateLockArgs {
        key: user.key.sec1(),
        lock_seq: seq,
        bond,
        backing,
        lock_until: until,
        sponsor_fee: 0,
    }
}

pub fn register_ix(user: &User, payer: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::RegisterDevice {
            wallet: user.wallet.pubkey(),
            payer: *payer,
            device: device_address(&user.key.sec1()),
            instructions: solana_instructions_sysvar::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::RegisterDevice {
            key: user.key.sec1(),
        }
        .data(),
    }
}

pub fn create_lock_ix(
    env: &Env,
    user: &User,
    payer: &Pubkey,
    args: CreateLockArgs,
    sponsor_token: Option<Pubkey>,
) -> Instruction {
    let lock = lock_address(&args.key, args.lock_seq);
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::CreateLock {
            wallet: user.wallet.pubkey(),
            payer: *payer,
            device: device_address(&args.key),
            lock,
            ledger: ledger_address(&lock),
            escrow: escrow_address(&lock),
            mint: env.mint,
            funder: user.token,
            sponsor_token,
            token_program: env.token_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::CreateLock { args }.data(),
    }
}

/// `[secp256r1 verification of the binding, register_device, create_lock]`: the onboarding transaction.
pub fn onboard_ixs(
    env: &Env,
    user: &User,
    payer: &Pubkey,
    args: CreateLockArgs,
    sponsor_token: Option<Pubkey>,
) -> Vec<Instruction> {
    vec![
        user.key.binding(&user.wallet.pubkey()),
        register_ix(user, payer),
        create_lock_ix(env, user, payer, args, sponsor_token),
    ]
}

pub fn withdraw_ix(env: &Env, user: &User, lock: &Lock, destination: &Pubkey) -> Instruction {
    let key = user.key.sec1();
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::WithdrawLock {
            wallet: user.wallet.pubkey(),
            device: device_address(&key),
            lock: lock.address,
            ledger: lock.ledger,
            escrow: lock.escrow,
            mint: env.mint,
            destination: *destination,
            rent_receiver: env.ledger(&lock.address).payer,
            token_program: env.token_program,
        }
        .to_account_metas(None),
        data: buckspay::instruction::WithdrawLock {
            key,
            lock_seq: lock.seq,
        }
        .data(),
    }
}

pub fn release_ix(
    env: &Env,
    user: &User,
    lock: &Lock,
    destination: &Pubkey,
    rent_receiver: &Pubkey,
) -> Instruction {
    let key = user.key.sec1();
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::ReleaseLock {
            device: device_address(&key),
            lock: lock.address,
            ledger: lock.ledger,
            escrow: lock.escrow,
            mint: env.mint,
            destination: *destination,
            rent_receiver: *rent_receiver,
            token_program: env.token_program,
        }
        .to_account_metas(None),
        data: buckspay::instruction::ReleaseLock {
            key,
            lock_seq: lock.seq,
        }
        .data(),
    }
}

pub fn close_ix(lock: &Lock, key: [u8; 33], rent_receiver: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::CloseLock {
            lock: lock.address,
            ledger: lock.ledger,
            escrow: lock.escrow,
            rent_receiver: *rent_receiver,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::CloseLock {
            key,
            lock_seq: lock.seq,
        }
        .data(),
    }
}

/// `[secp256r1 verification, request_wallet_rotation]` moving the device's wallet to `new_wallet`,
/// with the device key signing `counter` as the rotation's number.
pub fn request_ix(
    env: &Env,
    user: &User,
    new_wallet: &Pubkey,
    payer: &Pubkey,
    counter: u32,
) -> Vec<Instruction> {
    let key = user.key.sec1();
    let old_wallet = env.device(&key).wallet;
    vec![
        user.key.rotation(&old_wallet, new_wallet, counter),
        request_only_ix(&key, new_wallet, payer),
    ]
}

pub fn request_only_ix(key: &[u8; 33], new_wallet: &Pubkey, payer: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::RequestWalletRotation {
            new_wallet: *new_wallet,
            payer: *payer,
            device: device_address(key),
            rotation: rotation_address(key),
            instructions: solana_instructions_sysvar::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::RequestWalletRotation { key: *key }.data(),
    }
}

pub fn cancel_ix(key: &[u8; 33], wallet: &Pubkey, rent_receiver: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::CancelWalletRotation {
            wallet: *wallet,
            device: device_address(key),
            rotation: rotation_address(key),
            rent_receiver: *rent_receiver,
        }
        .to_account_metas(None),
        data: buckspay::instruction::CancelWalletRotation { key: *key }.data(),
    }
}

pub fn apply_ix(key: &[u8; 33], rent_receiver: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::ApplyWalletRotation {
            device: device_address(key),
            rotation: rotation_address(key),
            rent_receiver: *rent_receiver,
        }
        .to_account_metas(None),
        data: buckspay::instruction::ApplyWalletRotation { key: *key }.data(),
    }
}

/// A lock paid for by the wallet itself; asserts it landed.
pub fn lock_for(env: &mut Env, user: &User, bond: u64, backing: u64, duration: u32) -> Lock {
    let until = env.now() + duration;
    env.try_lock(user, bond, backing, until).unwrap()
}

/// The instruction that brings a device created before the counters existed to the
/// current layout.
#[cfg(feature = "devnet")]
pub fn migrate_ix(payer: &Pubkey, key: [u8; 33]) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::MigrateDevice {
            payer: *payer,
            device: device_address(&key),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::MigrateDevice { key }.data(),
    }
}
