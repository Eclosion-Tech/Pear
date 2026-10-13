//! Canonical 32-byte principal encoding at the trusted relay boundary.
//! SQL identities may have a `0x` prefix; SDK identities use bare hex.
pub(crate) fn canonical(value: &str) -> Option<String> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}
pub(crate) fn matches(request: &str, actual: &str) -> bool {
    match (canonical(request), canonical(actual)) {
        (Some(request), Some(actual)) => request == actual,
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_and_sdk_encodings_are_the_same_bytes() {
        let bare = "a1".repeat(32);
        assert!(matches(&bare, &format!("0x{}", bare.to_uppercase())));
        assert_eq!(canonical(&format!("0x{bare}")), Some(bare));
    }
    #[test]
    fn malformed_and_distinct_identities_never_match() {
        let bare = "a1".repeat(32);
        for bad in [
            "".into(),
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
            format!("0x0x{bare}"),
            format!(" {bare}"),
            format!("{bare}\n"),
            format!("0X{bare}"),
        ] {
            assert!(!matches(&bare, &bad));
            assert!(!matches(&bad, &bad));
        }
        assert!(!matches(&bare, &"b1".repeat(32)));
    }
}
