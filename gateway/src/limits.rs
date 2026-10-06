use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    num::NonZeroU32,
    sync::Mutex,
    time::{Duration, Instant},
};

/// The network a request comes from: its /24 for IPv4 and its /64 for IPv6, the blocks one
/// subscriber usually holds, so that rotating addresses inside them does not reset a limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Prefix {
    V4([u8; 3]),
    V6([u8; 8]),
}

impl From<IpAddr> for Prefix {
    fn from(ip: IpAddr) -> Self {
        match ip.to_canonical() {
            IpAddr::V4(v4) => Self::V4(v4.octets()[..3].try_into().unwrap()),
            IpAddr::V6(v6) => Self::V6(v6.octets()[..8].try_into().unwrap()),
        }
    }
}

impl fmt::Display for Prefix {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::V4([a, b, c]) => write!(f, "{}/24", Ipv4Addr::new(*a, *b, *c, 0)),
            Self::V6(head) => {
                let mut octets = [0; 16];
                octets[..8].copy_from_slice(head);
                write!(f, "{}/64", Ipv6Addr::from(octets))
            }
        }
    }
}

/// Too many requests from one network: try again later.
#[derive(Debug, PartialEq)]
pub struct RateLimited;

/// Requests per minute from one network, to every endpoint but `/health`.
pub struct RequestLimits {
    requests: DefaultKeyedRateLimiter<Prefix>,
    /// When the rate limiter last forgot the networks whose quota had refilled.
    swept: Mutex<Instant>,
}

impl RequestLimits {
    pub fn new(per_minute: NonZeroU32) -> Self {
        Self {
            requests: RateLimiter::keyed(Quota::per_minute(per_minute)),
            swept: Mutex::new(Instant::now()),
        }
    }

    /// Counts one request from `prefix`. Once a minute, the networks whose quota has refilled are
    /// forgotten: the rate limiter keeps no network longer than its quota needs it.
    pub fn check(&self, prefix: Prefix) -> Result<(), RateLimited> {
        let mut swept = self.swept.lock().unwrap();
        if swept.elapsed() >= Duration::from_secs(60) {
            self.requests.retain_recent();
            *swept = Instant::now();
        }
        drop(swept);
        self.requests.check_key(&prefix).map_err(|_| RateLimited)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefix(ip: &str) -> Prefix {
        Prefix::from(ip.parse::<IpAddr>().unwrap())
    }

    #[test]
    fn groups_addresses_by_ipv4_slash_24_and_ipv6_slash_64() {
        assert_eq!(prefix("203.0.113.7"), prefix("203.0.113.250"));
        assert_ne!(prefix("203.0.113.7"), prefix("203.0.114.7"));
        assert_eq!(prefix("2001:db8:1:2::1"), prefix("2001:db8:1:2:ffff::9"));
        assert_ne!(prefix("2001:db8:1:2::1"), prefix("2001:db8:1:3::1"));
        assert_eq!(prefix("::ffff:203.0.113.7"), prefix("203.0.113.9"));
        assert_ne!(prefix("203.0.113.7"), prefix("cb00:7100::"));
        assert_eq!(prefix("203.0.113.7").to_string(), "203.0.113.0/24");
        assert_eq!(prefix("2001:db8:1:2::1").to_string(), "2001:db8:1:2::/64");
    }

    #[test]
    fn limits_requests_per_prefix() {
        let limits = RequestLimits::new(NonZeroU32::new(3).unwrap());
        for _ in 0..3 {
            limits.check(prefix("203.0.113.7")).unwrap();
        }
        assert_eq!(limits.check(prefix("203.0.113.8")), Err(RateLimited));
        limits.check(prefix("198.51.100.1")).unwrap();
    }
}
