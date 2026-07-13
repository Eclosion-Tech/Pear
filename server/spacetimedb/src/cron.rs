//! Shared five-field cron evaluation (minute hour day month weekday), used by
//! both Automations scheduled rules and AI-user routines. Supports `*`,
//! `*/step`, ranges `a-b`, comma lists, and the Sunday alias `7` → `0`.
//!
//! Timezone-aware: expressions are evaluated in an IANA timezone (chrono-tz),
//! so "30 8 * * *" in America/New_York fires at 8:30 local across DST
//! transitions. An empty/blank timezone means UTC. Callers should validate
//! expressions with [`parse_cron_fields`] and timezones with [`parse_timezone`]
//! at authoring time; evaluation falls back to UTC on an unparseable zone
//! rather than silently never firing.

use std::str::FromStr;

use chrono::{Datelike, Timelike, Utc};
use chrono_tz::Tz;
use spacetimedb::Timestamp;

/// Parse an IANA timezone name ("America/New_York"). Empty/whitespace → UTC.
pub(crate) fn parse_timezone(timezone: &str) -> Result<Tz, String> {
    let trimmed = timezone.trim();
    if trimmed.is_empty() {
        return Ok(Tz::UTC);
    }
    Tz::from_str(trimmed).map_err(|_| format!("Unknown IANA timezone: {trimmed}"))
}

/// Minute-granularity bucket for dedup: a cron expression matches for a whole
/// minute, so a poller that ticks more than once within it must fire only once.
pub(crate) fn minute_bucket(ts: Timestamp) -> i64 {
    ts.to_micros_since_unix_epoch() / 60_000_000
}

/// True iff `expr` matches the wall-clock minute of `ts` in `timezone`.
pub(crate) fn cron_matches(expr: &str, ts: Timestamp, timezone: &str) -> Result<bool, String> {
    let fields = parse_cron_fields(expr)?;
    let micros = ts.to_micros_since_unix_epoch();
    let utc = chrono::DateTime::<Utc>::from_timestamp_micros(micros)
        .ok_or("Timestamp out of cron evaluation range")?;
    let tz = parse_timezone(timezone).unwrap_or(Tz::UTC);
    let dt = utc.with_timezone(&tz);
    let minute = dt.minute();
    let hour = dt.hour();
    let day = dt.day();
    let month = dt.month();
    let dow = dt.weekday().num_days_from_sunday();
    Ok(cron_field_matches(&fields[0], minute, 0, 59, false)?
        && cron_field_matches(&fields[1], hour, 0, 23, false)?
        && cron_field_matches(&fields[2], day, 1, 31, false)?
        && cron_field_matches(&fields[3], month, 1, 12, false)?
        && cron_field_matches(&fields[4], dow, 0, 7, true)?)
}

pub(crate) fn parse_cron_fields(expr: &str) -> Result<Vec<String>, String> {
    let fields: Vec<String> = expr.split_whitespace().map(str::to_string).collect();
    if fields.len() != 5 {
        return Err(
            "Cron expression must have five fields: minute hour day month weekday".to_string(),
        );
    }
    for (idx, field) in fields.iter().enumerate() {
        let (min, max, sunday_alias) = match idx {
            0 => (0, 59, false),
            1 => (0, 23, false),
            2 => (1, 31, false),
            3 => (1, 12, false),
            4 => (0, 7, true),
            _ => unreachable!(),
        };
        cron_field_matches(field, min, min, max, sunday_alias)?;
    }
    Ok(fields)
}

fn cron_field_matches(
    field: &str,
    value: u32,
    min: u32,
    max: u32,
    sunday_alias: bool,
) -> Result<bool, String> {
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err("Cron field contains an empty segment".to_string());
        }
        if part == "*" {
            return Ok(true);
        }
        if let Some(step) = part.strip_prefix("*/") {
            let step = step
                .parse::<u32>()
                .map_err(|_| "Cron step must be an integer".to_string())?;
            if step == 0 {
                return Err("Cron step must be greater than zero".to_string());
            }
            if (value - min) % step == 0 {
                return Ok(true);
            }
            continue;
        }
        if let Some((start, end)) = part.split_once('-') {
            let start = parse_cron_number(start, sunday_alias)?;
            let end = parse_cron_number(end, sunday_alias)?;
            if start < min || end > max || start > end {
                return Err("Cron range is out of bounds".to_string());
            }
            if value >= start && value <= end {
                return Ok(true);
            }
            continue;
        }
        let exact = parse_cron_number(part, sunday_alias)?;
        if exact < min || exact > max {
            return Err("Cron value is out of bounds".to_string());
        }
        if exact == value || (sunday_alias && exact == 7 && value == 0) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn parse_cron_number(raw: &str, sunday_alias: bool) -> Result<u32, String> {
    let n = raw
        .parse::<u32>()
        .map_err(|_| "Cron value must be an integer".to_string())?;
    if sunday_alias && n == 7 {
        Ok(7)
    } else {
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-07-13 12:30:00 UTC — a Monday; 08:30 in America/New_York (EDT).
    const MON_1230_UTC_MICROS: i64 = 1_783_945_800_000_000;

    #[test]
    fn cron_matches_evaluates_in_the_given_timezone() {
        let ts = Timestamp::from_micros_since_unix_epoch(MON_1230_UTC_MICROS);
        // 8:30 local in New York == 12:30 UTC during DST.
        assert!(cron_matches("30 8 * * *", ts, "America/New_York").unwrap());
        assert!(!cron_matches("30 8 * * *", ts, "UTC").unwrap());
        assert!(cron_matches("30 12 * * *", ts, "").unwrap()); // blank → UTC
        // Weekday check crosses the tz boundary correctly (Monday = 1).
        assert!(cron_matches("30 8 * * 1", ts, "America/New_York").unwrap());
        assert!(!cron_matches("30 8 * * 2", ts, "America/New_York").unwrap());
    }

    #[test]
    fn parse_timezone_validates_iana_names() {
        assert!(parse_timezone("America/New_York").is_ok());
        assert!(parse_timezone("UTC").is_ok());
        assert!(parse_timezone("  ").is_ok()); // blank → UTC
        assert!(parse_timezone("Mars/Olympus_Mons").is_err());
    }

    #[test]
    fn cron_syntax_still_covered_after_the_lift() {
        let ts = Timestamp::from_micros_since_unix_epoch(MON_1230_UTC_MICROS);
        assert!(cron_matches("* * * * *", ts, "UTC").unwrap());
        assert!(cron_matches("*/15 * * * *", ts, "UTC").unwrap());
        assert!(cron_matches("0-45 12 * * 0,1", ts, "UTC").unwrap());
        assert!(parse_cron_fields("bad").is_err());
        assert!(parse_cron_fields("61 * * * *").is_err());
    }
}
