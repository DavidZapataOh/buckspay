use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_message::{
    MessageHeader, VersionedMessage, compiled_instruction::CompiledInstruction, v0,
};
use solana_pubkey::Pubkey;
use std::cmp::Ordering;

/// Compiles a version 0 message without address lookup tables, with its accounts in the order
/// `@solana/kit` 7 gives them: the fee payer, then signers before the rest and writable before
/// read-only accounts, then by address as kit's collator sorts base58 strings. The app builds the
/// same message with kit and accepts only these exact bytes.
pub fn compile(
    fee_payer: &Pubkey,
    instructions: &[Instruction],
    blockhash: Hash,
) -> VersionedMessage {
    let mut accounts: Vec<(Pubkey, bool, bool)> = vec![(*fee_payer, true, true)];
    let mut merge = |key: Pubkey, signer: bool, writable: bool| match accounts
        .iter_mut()
        .find(|(k, _, _)| *k == key)
    {
        Some(entry) => {
            entry.1 |= signer;
            entry.2 |= writable;
        }
        None => accounts.push((key, signer, writable)),
    };
    for instruction in instructions {
        merge(instruction.program_id, false, false);
        for meta in &instruction.accounts {
            merge(meta.pubkey, meta.is_signer, meta.is_writable);
        }
    }
    let payer = accounts.remove(0);
    accounts.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then(b.2.cmp(&a.2))
            .then_with(|| kit_address_order(&a.0.to_string(), &b.0.to_string()))
    });
    accounts.insert(0, payer);

    let count =
        |f: fn(&(Pubkey, bool, bool)) -> bool| accounts.iter().filter(|a| f(a)).count() as u8;
    let header = MessageHeader {
        num_required_signatures: count(|a| a.1),
        num_readonly_signed_accounts: count(|a| a.1 && !a.2),
        num_readonly_unsigned_accounts: count(|a| !a.1 && !a.2),
    };
    let account_keys: Vec<Pubkey> = accounts.iter().map(|a| a.0).collect();
    let index = |key: &Pubkey| account_keys.iter().position(|k| k == key).unwrap() as u8;
    let instructions = instructions
        .iter()
        .map(|instruction| CompiledInstruction {
            program_id_index: index(&instruction.program_id),
            accounts: instruction
                .accounts
                .iter()
                .map(|meta| index(&meta.pubkey))
                .collect(),
            data: instruction.data.clone(),
        })
        .collect();
    VersionedMessage::V0(v0::Message {
        header,
        account_keys,
        recent_blockhash: blockhash,
        instructions,
        address_table_lookups: vec![],
    })
}

/// kit's address comparator (`Intl.Collator('en', { caseFirst: 'lower', sensitivity: 'variant' })`)
/// on base58 strings: case-insensitive first, then lower case before upper case at the first
/// position where the case differs.
fn kit_address_order(a: &str, b: &str) -> Ordering {
    a.to_ascii_lowercase()
        .cmp(&b.to_ascii_lowercase())
        .then_with(|| b.cmp(a))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_addresses_like_kit() {
        let mut addresses = vec![
            "Sysvar1nstructions1111111111111111111111111",
            "Secp256r1SigVerify1111111111111111111111111",
            "ComputeBudget111111111111111111111111111111",
            "11111111111111111111111111111111",
            "DWNv4TvjQNRRqXeQi1WFyZpvHgmLeJqFppaKDiHSWH3T",
            "dWNv4TvjQNRRqXeQi1WFyZpvHgmLeJqFppaKDiHSWH3T",
            "Dwnv4TvjQNRRqXeQi1WFyZpvHgmLeJqFppaKDiHSWH3T",
        ];
        addresses.sort_by(|a, b| kit_address_order(a, b));
        assert_eq!(
            addresses,
            [
                "11111111111111111111111111111111",
                "ComputeBudget111111111111111111111111111111",
                "dWNv4TvjQNRRqXeQi1WFyZpvHgmLeJqFppaKDiHSWH3T",
                "Dwnv4TvjQNRRqXeQi1WFyZpvHgmLeJqFppaKDiHSWH3T",
                "DWNv4TvjQNRRqXeQi1WFyZpvHgmLeJqFppaKDiHSWH3T",
                "Secp256r1SigVerify1111111111111111111111111",
                "Sysvar1nstructions1111111111111111111111111",
            ]
        );
    }
}
