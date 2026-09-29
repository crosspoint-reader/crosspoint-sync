//! Resolve `crosspoint.local` to an IPv4 address. The OS resolver handles
//! `.local` on macOS/iOS (Bonjour), Windows and most Linux desktops; Android's
//! doesn't, so fall back to a one-shot mDNS query. Adapted from common-stacks'
//! Crosspoint send target. Android also needs a MulticastLock (MainActivity.kt)
//! or it drops the reply.

use std::net::{Ipv4Addr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::time::Duration;

#[tauri::command]
pub async fn resolve_local(host: String) -> Option<String> {
  tauri::async_runtime::spawn_blocking(move || resolve(&host).map(|ip| ip.to_string()))
    .await
    .ok()
    .flatten()
}

fn resolve(host: &str) -> Option<Ipv4Addr> {
  let host = host.trim_end_matches('.').to_ascii_lowercase();
  os_ipv4(&host).or_else(|| mdns_ipv4(&host))
}

fn os_ipv4(host: &str) -> Option<Ipv4Addr> {
  (host, 80).to_socket_addrs().ok()?.find_map(|a| match a.ip() {
    std::net::IpAddr::V4(v4) => Some(v4),
    _ => None,
  })
}

fn mdns_ipv4(host: &str) -> Option<Ipv4Addr> {
  let query = build_query(host)?;
  let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
  socket.set_read_timeout(Some(Duration::from_millis(550))).ok()?;
  let _ = socket.set_multicast_ttl_v4(255);
  let group = SocketAddrV4::new(Ipv4Addr::new(224, 0, 0, 251), 5353);
  let mut buf = [0u8; 1500];
  for _ in 0..3 {
    let _ = socket.send_to(&query, group);
    if let Ok((n, _)) = socket.recv_from(&mut buf) {
      if let Some(ip) = parse_a_record(host, &buf[..n]) {
        return Some(ip);
      }
    }
  }
  None
}

fn build_query(host: &str) -> Option<Vec<u8>> {
  // Header: id 0, flags 0, one question.
  let mut out = vec![0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for label in host.split('.') {
    if label.is_empty() || label.len() > 63 {
      return None;
    }
    out.push(label.len() as u8);
    out.extend_from_slice(label.as_bytes());
  }
  // A record, class IN with the QU bit so responders reply unicast.
  out.extend_from_slice(&[0, 0, 1, 0x80, 1]);
  Some(out)
}

fn parse_a_record(host: &str, p: &[u8]) -> Option<Ipv4Addr> {
  if p.len() < 12 {
    return None;
  }
  let count = |i: usize| u16::from_be_bytes([p[i], p[i + 1]]) as usize;
  let (qd, records) = (count(4), count(6) + count(8) + count(10));
  let mut off = 12;
  for _ in 0..qd {
    read_name(p, &mut off)?;
    off += 4;
  }
  for _ in 0..records {
    let name = read_name(p, &mut off)?;
    let rr = p.get(off..off + 10)?;
    let (rtype, class, len) = (
      u16::from_be_bytes([rr[0], rr[1]]),
      u16::from_be_bytes([rr[2], rr[3]]) & 0x7fff,
      u16::from_be_bytes([rr[8], rr[9]]) as usize,
    );
    off += 10;
    let data = p.get(off..off + len)?;
    if rtype == 1 && class == 1 && len == 4 && name.eq_ignore_ascii_case(host) {
      return Some(Ipv4Addr::new(data[0], data[1], data[2], data[3]));
    }
    off += len;
  }
  None
}

fn read_name(p: &[u8], off: &mut usize) -> Option<String> {
  let (mut labels, mut pos, mut jumped) = (Vec::new(), *off, false);
  for _ in 0..128 {
    let len = *p.get(pos)? as usize;
    if len & 0xc0 == 0xc0 {
      // Compression pointer.
      if !jumped {
        *off = pos + 2;
      }
      pos = ((len & 0x3f) << 8) | *p.get(pos + 1)? as usize;
      jumped = true;
      continue;
    }
    if len == 0 {
      if !jumped {
        *off = pos + 1;
      }
      return Some(labels.join("."));
    }
    labels.push(std::str::from_utf8(p.get(pos + 1..pos + 1 + len)?).ok()?.to_string());
    pos += 1 + len;
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_a_record_answer() {
    let mut packet = build_query("crosspoint.local").unwrap();
    packet[7] = 1; // one answer
    // Answer: pointer to the question name, A, IN, TTL, len 4, 192.168.4.50.
    packet.extend_from_slice(&[0xc0, 12, 0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 192, 168, 4, 50]);
    assert_eq!(parse_a_record("crosspoint.local", &packet), Some(Ipv4Addr::new(192, 168, 4, 50)));
    assert_eq!(parse_a_record("other.local", &packet), None);
  }
}
