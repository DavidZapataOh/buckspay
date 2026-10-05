use anchor_lang::prelude::*;

/// Where a refund of rent goes: to `receiver`, the account that paid it, unless that account has
/// become executable, which the runtime never credits. The refund then rests in `fallback`, an
/// account the program owns or can sign for and nothing can spend from, so a payer can neither
/// block a payout or a close nor keep what it refused.
pub fn refund_target<'a, 'info>(
    receiver: &'a AccountInfo<'info>,
    fallback: &'a AccountInfo<'info>,
) -> &'a AccountInfo<'info> {
    if receiver.executable {
        fallback
    } else {
        receiver
    }
}
