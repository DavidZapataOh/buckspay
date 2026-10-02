use anchor_lang::{error::ErrorCode, solana_program::instruction::Instruction};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError};

const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_TARGET_TMPDIR"),
    "/../deploy/buckspay.so"
));

#[test]
fn rejects_unknown_instruction() {
    let mut svm = LiteSVM::new();
    svm.add_program(buckspay::ID, PROGRAM).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let ix = Instruction {
        program_id: buckspay::ID,
        accounts: vec![],
        data: vec![0; 8],
    };
    let message =
        Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&payer]).unwrap();

    let err = svm.send_transaction(tx).unwrap_err();

    assert_eq!(
        err.err,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(ErrorCode::InstructionFallbackNotFound as u32)
        )
    );
}
