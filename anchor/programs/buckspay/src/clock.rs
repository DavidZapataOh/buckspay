use anchor_lang::prelude::*;

use crate::error::BuckspayError;

/// The cluster clock as `u32` Unix seconds, or `ClockOutOfRange` before 1970 and after 2106.
pub fn now() -> Result<u32> {
    u32::try_from(Clock::get()?.unix_timestamp).map_err(|_| error!(BuckspayError::ClockOutOfRange))
}
