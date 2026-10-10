//! The timestamp: an injectable clock and a hand-rolled RFC-3339 formatter.
//!
//! No `chrono` and no `time`: the crate is dependency-frugal, and the format is
//! one line of arithmetic. The conversion from a Unix day count to a civil date
//! is Howard Hinnant's `civil_from_days` algorithm, which is exact for every
//! date the proleptic Gregorian calendar defines — including the 400-year leap
//! rules, which is why 2000-02-29 is a date and 1900-02-29 is not.
//!
//! The timestamp is always UTC with a `Z` suffix and millisecond precision:
//! `2026-10-10T19:46:12.345Z`. There is deliberately no local-time option — a
//! log a second machine reads back must not depend on `TZ`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Where the logger reads the wall clock. Split out so a test can pin the time
/// and assert byte-exact output.
pub trait Clock: Send + Sync {
    fn now(&self) -> SystemTime;
}

/// The real clock: `SystemTime::now()`.
#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

/// Format an instant as RFC-3339 / ISO-8601 UTC with milliseconds.
///
/// A time before the Unix epoch — which a wall clock never reports, and which
/// tests do not construct — saturates to the epoch rather than formatting a
/// negative year. That is a documented clamp, not a silent wrap.
pub fn format_rfc3339(instant: SystemTime) -> String {
    let since_epoch = instant.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let seconds = since_epoch.as_secs() as i64;
    let millis = since_epoch.subsec_millis();

    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
    );

    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    )
}

/// Days since 1970-01-01 to `(year, month, day)`.
///
/// Hinnant's algorithm, shifted so the era begins on March 1st: the shift puts
/// the leap day at the end of the year, which is what makes the month-length
/// arithmetic below branch-free.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365; // [0, 399]
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100); // [0, 365]
    let month_prime = (5 * day_of_year + 2) / 153; // [0, 11]
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32; // [1, 31]
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
pub(crate) struct FixedClock(pub SystemTime);

#[cfg(test)]
impl Clock for FixedClock {
    fn now(&self) -> SystemTime {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn at_ms(seconds: u64, millis: u32) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(seconds * 1000 + millis as u64)
    }

    #[test]
    fn the_epoch_is_the_canonical_zero() {
        assert_eq!(format_rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn known_instants_round_trip() {
        assert_eq!(format_rfc3339(at(1_000_000_000)), "2001-09-09T01:46:40.000Z");
        assert_eq!(format_rfc3339(at(1_700_000_000)), "2023-11-14T22:13:20.000Z");
        assert_eq!(
            format_rfc3339(at_ms(1_700_000_000, 345)),
            "2023-11-14T22:13:20.345Z"
        );
        // Midnight, the boundary between two civil days.
        assert_eq!(format_rfc3339(at(86_400)), "1970-01-02T00:00:00.000Z");
    }

    #[test]
    fn post_epoch_leap_days_format() {
        // 2000-02-29 existed (divisible by 400).
        assert_eq!(format_rfc3339(at(951_782_400)), "2000-02-29T00:00:00.000Z");
        // A plain leap year, for the ordinary path.
        assert_eq!(format_rfc3339(at(1_709_164_800)), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn the_four_hundred_year_leap_rule_holds() {
        // `civil_from_days` is tested with negative day counts directly: the
        // formatter clamps pre-epoch instants, so 1900 is out of its reach, but
        // the calendar arithmetic must still be right for it.
        //
        // 1900-03-01 is day -25508; 1900 was NOT a leap year (divisible by 100
        // but not 400), so the day before it is 1900-02-28, not -02-29. A naive
        // `% 4` gets this wrong.
        assert_eq!(civil_from_days(-25_508), (1900, 3, 1));
        assert_eq!(civil_from_days(-25_509), (1900, 2, 28));
        // 2000-02-29 is day 11016, and it existed.
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn a_pre_epoch_clock_saturates_rather_than_wrapping() {
        // Documented clamp: nothing a wall clock reports, but the formatter must
        // not emit a negative year if it is ever handed one.
        let before = UNIX_EPOCH - Duration::from_secs(60);
        assert_eq!(format_rfc3339(before), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn milliseconds_are_zero_padded() {
        assert_eq!(
            format_rfc3339(at_ms(0, 7)),
            "1970-01-01T00:00:00.007Z"
        );
    }

    #[test]
    fn the_fixed_clock_answers_the_instant_it_was_given() {
        use super::Clock;
        let instant = at(1_700_000_000);
        assert_eq!(FixedClock(instant).now(), instant);
    }
}
