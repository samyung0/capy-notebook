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

/// Order keys for entries wanted in the given order, from each entry's
/// `(id, held key)` (an empty key for one with none yet), as the browser's
/// `risingOrders` (`src/lib/orderKey.ts`): held keys are compared with ties
/// broken by id, as readers sort, and the longest strictly rising run stays,
/// so a tie two writers' adds left that reads in the wanted order is kept.
/// Every other entry (a moved or a new one) takes a key between its
/// neighbours; one placed between tied neighbours, where no key fits,
/// re-keys the later tied neighbours with it.
pub fn rising(held: &[(&str, &str)]) -> Vec<String> {
    placed(held, None, None)
}

/// Whether `order` is a key strictly between `lower` and `upper` (none: the
/// start or the end).
fn within(order: &str, lower: Option<&str>, upper: Option<&str>) -> bool {
    !order.is_empty()
        && lower.is_none_or(|lower| lower < order)
        && upper.is_none_or(|upper| order < upper)
}

/// `count` keys rising from `last` to before `before`.
fn keys_between(mut last: Option<String>, before: Option<&str>, count: usize) -> Vec<String> {
    (0..count)
        .map(|_| {
            // No key fits only between malformed held keys.
            let key = between(last.as_deref(), before).unwrap_or_else(|| after(last.as_deref()));
            last = Some(key.clone());
            key
        })
        .collect()
}

/// [rising] for entries placed between `lower` and `upper`: only a held key
/// inside them can stay, and each gap between kept entries is placed the
/// same way between its neighbours, so a held key inside a gap stays too.
fn placed(held: &[(&str, &str)], lower: Option<&str>, upper: Option<&str>) -> Vec<String> {
    // Patience sorting: `tails[n]` ends the best run of length n + 1 so far,
    // `previous` links runs.
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![None; held.len()];
    for (i, &(id, order)) in held.iter().enumerate() {
        if !within(order, lower, upper) {
            continue;
        }
        let low = tails.partition_point(|&t| (held[t].1, held[t].0) < (order, id));
        if low > 0 {
            previous[i] = Some(tails[low - 1]);
        }
        if low == tails.len() {
            tails.push(i);
        } else {
            tails[low] = i;
        }
    }
    // Nothing to keep: every entry takes a new key (this ends the recursion,
    // since a gap is smaller than the list that kept an entry).
    if tails.is_empty() {
        return keys_between(lower.map(str::to_owned), upper, held.len());
    }
    let mut kept = vec![false; held.len()];
    let mut at = tails.last().copied();
    while let Some(i) = at {
        kept[i] = true;
        at = previous[i];
    }
    let mut orders: Vec<String> = held.iter().map(|&(_, order)| order.to_owned()).collect();
    let mut i = 0;
    while i < orders.len() {
        if kept[i] {
            i += 1;
            continue;
        }
        // The entry before a gap is a kept one holding its own key; kept
        // entries tied with it join the gap, so the gap ends at a greater key.
        let last = match i.checked_sub(1) {
            Some(p) => Some(orders[p].clone()),
            None => lower.map(str::to_owned),
        };
        let mut end = i;
        while end < orders.len() && (!kept[end] || last.as_ref() == Some(&orders[end])) {
            end += 1;
        }
        let before = orders
            .get(end)
            .cloned()
            .or_else(|| upper.map(str::to_owned));
        let keys = placed(&held[i..end], last.as_deref(), before.as_deref());
        for (order, key) in orders[i..end].iter_mut().zip(keys) {
            *order = key;
        }
        i = end;
    }
    orders
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rising_keeps_the_longest_rising_run_by_key_then_id() {
        // The browser's cases (src/lib/orderKey.test.ts).
        let held = [("p0", "a0"), ("p1", "a5"), ("p2", "")];
        assert_eq!(rising(&held), ["a0", "a5", "a6"]);
        let held = [("p0", "a0"), ("p1", ""), ("p2", "a5")];
        assert_eq!(rising(&held), ["a0", "a1", "a5"]);
        let held = [("p0", "a2"), ("p1", "a0"), ("p2", "a1")];
        assert_eq!(rising(&held), ["Zz", "a0", "a1"]);
        let held = [("p0", "a1"), ("p1", "a2"), ("p2", "a0")];
        assert_eq!(rising(&held), ["a1", "a2", "a3"]);
        // A tie two adds left, wanted in id order, stays; wanted against id
        // order, one of the two takes a new key.
        let held = [("b", "a0"), ("c", "a0"), ("d", "a1")];
        assert_eq!(rising(&held), ["a0", "a0", "a1"]);
        let held = [("c", "a0"), ("b", "a0"), ("d", "a1")];
        assert_eq!(rising(&held), ["Zz", "a0", "a1"]);
        // An entry placed between tied neighbours re-keys the later tied
        // ones: a new entry, a held one moved there, one in a three-way tie.
        let held = [("b", "a0"), ("x", ""), ("c", "a0"), ("d", "a1")];
        assert_eq!(rising(&held), ["a0", "a0V", "a0l", "a1"]);
        let held = [("b", "a0"), ("x", ""), ("c", "a0")];
        assert_eq!(rising(&held), ["a0", "a1", "a2"]);
        let held = [("b", "a0"), ("m", "a5"), ("c", "a0"), ("d", "a1")];
        assert_eq!(rising(&held), ["a0", "a0V", "a0l", "a1"]);
        let held = [("b", "a0"), ("x", ""), ("c", "a0"), ("d", "a0")];
        assert_eq!(rising(&held), ["a0", "a1", "a2", "a3"]);
        // A tie stays with an entry added before or after it.
        let held = [("n", ""), ("b", "a0"), ("c", "a0")];
        assert_eq!(rising(&held), ["Zz", "a0", "a0"]);
        let held = [("b", "a3"), ("c", "a3"), ("n", "")];
        assert_eq!(rising(&held), ["a3", "a3", "a4"]);
        // c moved after d splits the b/c tie: the bystander d keeps its key.
        let held = [("b", "a1"), ("d", "a3"), ("c", "a1")];
        assert_eq!(rising(&held), ["a1", "a3", "a4"]);
    }

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
