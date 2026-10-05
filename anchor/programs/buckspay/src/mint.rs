use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint,
};

use crate::error::BuckspayError;

/// Accepts a plain mint: owned by the classic Token program, or by Token-2022 with no extension but
/// `MetadataPointer` and `TokenMetadata`. Any other Token-2022 extension can move, charge or freeze
/// tokens outside the program's accounting (transfer fees and hooks, a permanent delegate, a
/// default frozen state, confidential or non-transferable balances). Wrapped SOL is refused too: its
/// accounts' balances follow their lamports, which anyone can add to a predictable escrow address.
pub fn validate_mint(mint: &AccountInfo) -> Result<()> {
    require_keys_neq!(
        mint.key(),
        anchor_spl::token::spl_token::native_mint::ID,
        BuckspayError::UnsupportedMintExtension
    );
    if mint.owner == &anchor_spl::token::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint>::unpack(&data)?;
    for extension in state.get_extension_types()? {
        require!(
            matches!(
                extension,
                ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
            ),
            BuckspayError::UnsupportedMintExtension
        );
    }
    Ok(())
}
