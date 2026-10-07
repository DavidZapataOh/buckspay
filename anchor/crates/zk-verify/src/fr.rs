//! Arithmetic modulo the BN254 scalar field for the batch equation.

/// The scalar field modulus `r`, as little-endian limbs.
const R: [u64; 4] = [
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
];
/// `floor(2^512 / r)`, as little-endian limbs.
const MU: [u64; 5] = [
    0x20703a6be1de9259,
    0x144852009e880ae6,
    0xb074a58680730147,
    0x4a47462623a04a7a,
    0x5,
];

/// The modulus as 32 big-endian bytes.
pub const MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Whether `x`, read as a big-endian integer, is below the modulus.
pub fn is_canonical(x: &[u8; 32]) -> bool {
    x < &MODULUS
}

/// `x` reduced below the modulus. The input is any 32 bytes, below `6r`, so five subtractions at
/// most.
pub fn reduce(x: &[u8; 32]) -> [u8; 32] {
    let mut out = *x;
    while out >= MODULUS {
        let mut borrow = 0i16;
        for (byte, modulus) in out.iter_mut().zip(MODULUS).rev() {
            let diff = i16::from(*byte) - i16::from(modulus) - borrow;
            borrow = i16::from(diff < 0);
            *byte = diff.rem_euclid(256) as u8;
        }
    }
    out
}

/// An unreduced sum of products `r_i * x_i` with `r_i < 2^128` and `x_i < 2^256`. Seventeen terms
/// stay below `2^389`, so seven limbs hold the sum and it is reduced once, at the end.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct Acc([u64; 7]);

impl Acc {
    /// Adds `r * x`; `x` is any 32 big-endian bytes.
    pub fn mul_add(&mut self, r: u128, x: &[u8; 32]) {
        let mut xl = [0u64; 4];
        for (k, limb) in xl.iter_mut().enumerate() {
            let at = 24 - 8 * k;
            *limb = u64::from_be_bytes(x[at..at + 8].try_into().unwrap_or_default());
        }
        for (i, ri) in [r as u64, (r >> 64) as u64].into_iter().enumerate() {
            let mut carry = 0u128;
            for (j, xj) in xl.iter().enumerate() {
                let t = u128::from(ri) * u128::from(*xj) + u128::from(self.0[i + j]) + carry;
                self.0[i + j] = t as u64;
                carry = t >> 64;
            }
            let mut k = i + 4;
            while carry != 0 && k < self.0.len() {
                let t = u128::from(self.0[k]) + carry;
                self.0[k] = t as u64;
                carry = t >> 64;
                k += 1;
            }
        }
    }

    pub fn is_zero(&self) -> bool {
        self.0 == [0; 7]
    }

    /// Barrett reduction modulo `r`, as 32 big-endian bytes.
    pub fn reduce(&self) -> [u8; 32] {
        let product: [u64; 12] = mul_limbs(&self.0, &MU);
        let quotient = &product[8..12];
        let q_times_r: [u64; 7] = mul_limbs(quotient, &R);
        let mut x = self.0;
        sub_assign(&mut x, &q_times_r);
        let mut low = [x[0], x[1], x[2], x[3]];
        while geq_modulus(&low) {
            sub_assign(&mut low, &R);
        }
        let mut out = [0u8; 32];
        for (chunk, limb) in out.chunks_exact_mut(8).zip(low.iter().rev()) {
            chunk.copy_from_slice(&limb.to_be_bytes());
        }
        out
    }
}

fn mul_limbs<const N: usize>(a: &[u64], b: &[u64]) -> [u64; N] {
    let mut out = [0u64; N];
    for (i, ai) in a.iter().enumerate() {
        let mut carry = 0u128;
        for (j, bj) in b.iter().enumerate() {
            if i + j >= N {
                break;
            }
            let t = u128::from(*ai) * u128::from(*bj) + u128::from(out[i + j]) + carry;
            out[i + j] = t as u64;
            carry = t >> 64;
        }
        if i + b.len() < N {
            out[i + b.len()] = carry as u64;
        }
    }
    out
}

fn geq_modulus(x: &[u64; 4]) -> bool {
    for k in (0..4).rev() {
        if x[k] != R[k] {
            return x[k] > R[k];
        }
    }
    true
}

fn sub_assign<const N: usize>(x: &mut [u64; N], y: &[u64]) {
    let mut borrow = false;
    for (k, xk) in x.iter_mut().enumerate() {
        let (d1, b1) = xk.overflowing_sub(y.get(k).copied().unwrap_or(0));
        let (d2, b2) = d1.overflowing_sub(u64::from(borrow));
        *xk = d2;
        borrow = b1 || b2;
    }
}
