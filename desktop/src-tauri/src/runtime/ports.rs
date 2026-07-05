//! Loopback port selection for the local workspace runtime.

use std::net::TcpListener;

/// The preferred port if free, else an OS-assigned free port. Loopback only —
/// the local workspace is never exposed on the LAN.
pub fn free_port(preferred: u16) -> Result<u16, String> {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return Ok(preferred);
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("no free loopback port: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_when_preferred_port_is_taken() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken = holder.local_addr().unwrap().port();
        let got = free_port(taken).unwrap();
        assert_ne!(got, taken);
    }

    #[test]
    fn returns_preferred_when_free() {
        // Find a free port, release it, then ask for it as preferred.
        let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        assert_eq!(free_port(port).unwrap(), port);
    }
}
