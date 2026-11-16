//! Order keys: the `fractional-indexing` 3.2.0 strings (base 62) the browser
//! writes with `generateKeyBetween`, ported for the server's own inserts and
//! checked on every key a writer sends (a malformed key would make every
//! other browser's next `generateKeyBetween` throw).

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/// The longest key a writer may send: keys grow by about one character per
/// insert between the same two neighbours.
pub const MAX_ORDER_KEY: usize = 128;

fn digit(c: u8) -> Option<usize> {
    DIGITS.iter().position(|d| *d == c)
}

fn integer_length(head: u8) -> Option<usize> {
    match head {
        b'a'..=b'z' => Some((head - b'a') as usize + 2),
        b'A'..=b'Z' => Some((b'Z' - head) as usize + 2),
        _ => None,
    }
}

/// `validateOrderKey`, plus the length bound and base-62 digits.
pub fn valid(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_ORDER_KEY {
        return false;
    }
    let Some(length) = integer_length(bytes[0]) else {
        return false;
    };
    if length > bytes.len() || bytes[1..].iter().any(|c| digit(*c).is_none()) {
        return false;
    }
    if bytes.len() == 27 && bytes[0] == b'A' && bytes[1..].iter().all(|c| *c == b'0') {
        return false;
    }
    let fraction = &bytes[length..];
    fraction.last() != Some(&b'0')
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let digit_a = a.first().and_then(|c| digit(*c)).unwrap_or(0);
    let digit_b = b.map_or(DIGITS.len(), |b| {
        b.first().and_then(|c| digit(*c)).unwrap_or(0)
    });
    if digit_b - digit_a > 1 {
        let mid = ((digit_a + digit_b) as f64 * 0.5).round() as usize;
        return vec![DIGITS[mid]];
    }
    match b {
        Some(b) if b.len() > 1 => b[..1].to_vec(),
        _ => {
            let mut out = vec![DIGITS[digit_a]];
            out.extend(midpoint(a.get(1..).unwrap_or(&[]), None));
            out
        }
    }
}

fn increment_integer(x: &[u8]) -> Option<Vec<u8>> {
    let head = x[0];
    let mut digits = x[1..].to_vec();
    let mut carry = true;
    for d in digits.iter_mut().rev() {
        if !carry {
            break;
        }
        let next = digit(*d).unwrap_or(0) + 1;
        if next == DIGITS.len() {
            *d = DIGITS[0];
        } else {
            *d = DIGITS[next];
            carry = false;
        }
    }
    if !carry {
        let mut out = vec![head];
        out.extend(digits);
        return Some(out);
    }
    match head {
        b'Z' => Some(vec![b'a', DIGITS[0]]),
        b'z' => None,
        _ => {
            let h = head + 1;
            if h > b'a' {
                digits.push(DIGITS[0]);
            } else {
                digits.pop();
            }
            let mut out = vec![h];
            out.extend(digits);
            Some(out)
        }
    }
}

fn decrement_integer(x: &[u8]) -> Option<Vec<u8>> {
    let head = x[0];
    let mut digits = x[1..].to_vec();
    let mut borrow = true;
    for d in digits.iter_mut().rev() {
        if !borrow {
            break;
        }
        match digit(*d).unwrap_or(0) {
            0 => *d = DIGITS[DIGITS.len() - 1],
            n => {
                *d = DIGITS[n - 1];
                borrow = false;
            }
        }
    }
    if !borrow {
        let mut out = vec![head];
        out.extend(digits);
        return Some(out);
    }
    match head {
        b'a' => Some(vec![b'Z', DIGITS[DIGITS.len() - 1]]),
        b'A' => None,
        _ => {
            let h = head - 1;
            if h < b'Z' {
                digits.push(DIGITS[DIGITS.len() - 1]);
            } else {
                digits.pop();
            }
            let mut out = vec![h];
            out.extend(digits);
            Some(out)
        }
    }
}

fn integer_part(key: &[u8]) -> &[u8] {
    let length = integer_length(key[0]).unwrap_or(key.len()).min(key.len());
    &key[..length]
}

/// `generateKeyBetween(a, null)`: a key after `a` (the first key when none).
/// `a` must be [valid].
pub fn after(a: Option<&str>) -> String {
    let Some(a) = a else {
        return "a0".into();
    };
    let a = a.as_bytes();
    let ia = integer_part(a);
    let fa = &a[ia.len()..];
    let key = match increment_integer(ia) {
        Some(next) => next,
        None => {
            let mut out = ia.to_vec();
            out.extend(midpoint(fa, None));
            out
        }
    };
    String::from_utf8(key).unwrap_or_else(|_| "a0".into())
}

/// `generateKeyBetween(a, b)` for two [valid] keys with `a < b`; `None` when
/// they are equal or out of order (two writers that inserted at the same
/// place hold the same key; the caller places after `a`'s later twin).
pub fn between(a: Option<&str>, b: Option<&str>) -> Option<String> {
    let Some(b) = b else {
        return Some(after(a));
    };
    let bb = b.as_bytes();
    let ib = integer_part(bb);
    let fb = &bb[ib.len()..];
    let Some(a) = a else {
        if ib.len() == 27 && ib[0] == b'A' && ib[1..].iter().all(|c| *c == b'0') {
            let mut out = ib.to_vec();
            out.extend(midpoint(&[], Some(fb)));
            return String::from_utf8(out).ok();
        }
        if ib.len() < bb.len() {
            return String::from_utf8(ib.to_vec()).ok();
        }
        return decrement_integer(ib).and_then(|key| String::from_utf8(key).ok());
    };
    if a >= b {
        return None;
    }
    let ab = a.as_bytes();
    let ia = integer_part(ab);
    let fa = &ab[ia.len()..];
    let key = if ia == ib {
        let mut out = ia.to_vec();
        out.extend(midpoint(fa, Some(fb)));
        out
    } else {
        match increment_integer(ia) {
            Some(next) if next.as_slice() < bb => next,
            _ => {
                let mut out = ia.to_vec();
                out.extend(midpoint(fa, None));
                out
            }
        }
    };
    String::from_utf8(key).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_match_fractional_indexing() {
        // generateKeyBetween's own sequence: a0..az, then b00.
        let mut key = after(None);
        assert_eq!(key, "a0");
        for _ in 0..35 {
            key = after(Some(&key));
        }
        assert_eq!(key, "aZ");
        for _ in 0..26 {
            key = after(Some(&key));
        }
        assert_eq!(key, "az");
        assert_eq!(after(Some("az")), "b00");
        assert_eq!(between(Some("a0"), Some("a1")).as_deref(), Some("a0V"));
        assert_eq!(between(Some("a0V"), Some("a1")).as_deref(), Some("a0l"));
        assert_eq!(between(Some("a1"), Some("a1")), None);
        // Before the first key: a0 -> Zz, a0V -> a0.
        assert_eq!(between(None, Some("a0")).as_deref(), Some("Zz"));
        assert_eq!(between(None, Some("a0V")).as_deref(), Some("a0"));
    }

    #[test]
    fn writers_keys_are_checked() {
        for key in ["a0", "a0V", "b00", "Zz", "a1x"] {
            assert!(valid(key), "{key}");
        }
        for key in ["", "a", "a0V0", "b0", "-1", "a0!", &"a".repeat(129)] {
            assert!(!valid(key), "{key}");
        }
    }
}
