//! Creating a program-derived account that may already hold lamports.
use anchor_lang::{
    prelude::*,
    system_program::{
        allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
    },
};

/// Creates `account`, a PDA of this program at `seeds` (bump included), with `space` bytes, funded by
/// `payer` and owned by this program. `create_account` fails on an address that already holds
/// lamports, and anyone can send lamports to a derived address first, so such an address is topped
/// up to the rent minimum, allocated and assigned instead. Fails if the account is already in use.
pub fn create_pda<'info>(
    account: &AccountInfo<'info>,
    seeds: &[&[u8]],
    space: usize,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let signer = &[seeds];
    let required = Rent::get()?.minimum_balance(space);
    if account.lamports() == 0 {
        return create_account(
            CpiContext::new_with_signer(
                system_program.key(),
                CreateAccount {
                    from: payer.to_account_info(),
                    to: account.clone(),
                },
                signer,
            ),
            required,
            space as u64,
            &crate::ID,
        );
    }
    let missing = required.saturating_sub(account.lamports());
    if missing > 0 {
        transfer(
            CpiContext::new(
                system_program.key(),
                Transfer {
                    from: payer.to_account_info(),
                    to: account.clone(),
                },
            ),
            missing,
        )?;
    }
    allocate(
        CpiContext::new_with_signer(
            system_program.key(),
            Allocate {
                account_to_allocate: account.clone(),
            },
            signer,
        ),
        space as u64,
    )?;
    assign(
        CpiContext::new_with_signer(
            system_program.key(),
            Assign {
                account_to_assign: account.clone(),
            },
            signer,
        ),
        &crate::ID,
    )
}
