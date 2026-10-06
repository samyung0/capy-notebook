//! `JSON.stringify` as V8 writes it: the limits count its UTF-8 bytes
//! (`measureMaterialValue`), and the bound prices strings and attributes with
//! it. Numbers follow ECMAScript `Number::toString`, strings the well-formed
//! escaping (`\"`, `\\`, the short escapes, `\u00xx` for other controls).

use serde_json::Value;
use yrs::Any;

/// A value `JSON.stringify` throws on (a BigInt).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Do not know how to serialize a BigInt")]
pub struct Unencodable;

/// `Number.prototype.toString()` for a finite number.
pub fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    // Shortest round-trip digits and the decimal exponent: d.ddde±x.
    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if n > 0 { '+' } else { '-' });
        out.push_str(&(n - 1).abs().to_string());
    }
    out
}

/// A JSON number: non-finite values are `null`.
fn number(value: f64) -> String {
    if value.is_finite() {
        js_number(value)
    } else {
        "null".into()
    }
}

/// The escaped form of one character, if it has one.
fn escape(c: char) -> Option<&'static str> {
    Some(match c {
        '"' => "\\\"",
        '\\' => "\\\\",
        '\u{8}' => "\\b",
        '\u{c}' => "\\f",
        '\n' => "\\n",
        '\r' => "\\r",
        '\t' => "\\t",
        _ => return None,
    })
}

/// UTF-8 bytes of `JSON.stringify(text)` without its two quotes.
pub fn escaped_len(text: &str) -> usize {
    let mut len = text.len();
    for byte in text.bytes() {
        if byte < 0x20 {
            // `\n` and friends take 2 bytes, other controls `\u00xx` 6.
            len += if matches!(byte, 8 | 9 | 10 | 12 | 13) {
                1
            } else {
                5
            };
        } else if byte == b'"' || byte == b'\\' {
            len += 1;
        }
    }
    len
}

/// Appends `JSON.stringify(text)`.
pub fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        if let Some(escaped) = escape(c) {
            out.push_str(escaped);
        } else if (c as u32) < 0x20 {
            out.push_str(&format!("\\u{:04x}", c as u32));
        } else {
            out.push(c);
        }
    }
    out.push('"');
}

/// UTF-8 bytes of `JSON.stringify(value)`; `None` for `undefined`, which an
/// object drops and an array writes as `null`.
pub fn any_len(value: &Any) -> Result<Option<usize>, Unencodable> {
    Ok(Some(match value {
        Any::Undefined => return Ok(None),
        Any::Null => 4,
        Any::Bool(true) => 4,
        Any::Bool(false) => 5,
        Any::Number(n) => number(*n).len(),
        Any::BigInt(_) => return Err(Unencodable),
        Any::String(s) => escaped_len(s) + 2,
        // A Uint8Array is an object keyed by index.
        Any::Buffer(bytes) => {
            let entries: usize = bytes
                .iter()
                .enumerate()
                .map(|(i, b)| i.to_string().len() + 3 + b.to_string().len())
                .sum();
            2 + entries + bytes.len().saturating_sub(1)
        }
        Any::Array(items) => {
            let mut len = 2 + items.len().saturating_sub(1);
            for item in items.iter() {
                len += any_len(item)?.unwrap_or(4);
            }
            len
        }
        Any::Map(map) => {
            let mut len = 2;
            let mut entries: usize = 0;
            for (key, item) in map.iter() {
                if let Some(item) = any_len(item)? {
                    len += escaped_len(key) + 3 + item;
                    entries += 1;
                }
            }
            len + entries.saturating_sub(1)
        }
    }))
}

/// UTF-8 bytes of `JSON.stringify(value)` for a JSON value.
pub fn value_len(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => number(n.as_f64().unwrap_or(f64::NAN)).len(),
        Value::String(s) => escaped_len(s) + 2,
        Value::Array(items) => {
            2 + items.len().saturating_sub(1) + items.iter().map(value_len).sum::<usize>()
        }
        Value::Object(map) => {
            2 + map.len().saturating_sub(1)
                + map
                    .iter()
                    .map(|(k, v)| escaped_len(k) + 3 + value_len(v))
                    .sum::<usize>()
        }
    }
}

/// `JSON.stringify(value)` for a JSON value, keys in their order.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, false);
    out
}

/// Sorted-key JSON (the corpus hashes values with it).
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, true);
    out
}

fn write_value(out: &mut String, value: &Value, sorted: bool) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item, sorted);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut entries: Vec<_> = map.iter().collect();
            if sorted {
                entries.sort_by(|a, b| utf16_cmp(a.0, b.0));
            }
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item, sorted);
            }
            out.push('}');
        }
    }
}

/// JS string order (UTF-16 code units).
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A yrs value as JSON, as `JSON.stringify` then `JSON.parse` would give it
/// (`undefined` entries dropped, non-finite numbers `null`).
pub fn any_to_value(value: &Any) -> Result<Value, Unencodable> {
    Ok(match value {
        Any::Undefined | Any::Null => Value::Null,
        Any::Bool(b) => Value::Bool(*b),
        Any::Number(n) => number_value(*n),
        Any::BigInt(_) => return Err(Unencodable),
        Any::String(s) => Value::String(s.to_string()),
        Any::Buffer(bytes) => Value::Object(
            bytes
                .iter()
                .enumerate()
                .map(|(i, b)| (i.to_string(), Value::from(*b)))
                .collect(),
        ),
        Any::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| match item {
                    Any::Undefined => Ok(Value::Null),
                    item => any_to_value(item),
                })
                .collect::<Result<_, _>>()?,
        ),
        Any::Map(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut object = serde_json::Map::new();
            for key in keys {
                let item = &map[key];
                if !matches!(item, Any::Undefined) {
                    object.insert(key.clone(), any_to_value(item)?);
                }
            }
            Value::Object(object)
        }
    })
}

/// A JS number as a JSON number: integers stay integers.
pub fn number_value(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        // -0 is written as 0.
        return Value::from(n as i64);
    }
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// A JSON value as the yrs value slate-yjs writes for it.
pub fn value_to_any(value: &Value) -> Any {
    match value {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => Any::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Any::String(s.as_str().into()),
        Value::Array(items) => Any::Array(items.iter().map(value_to_any).collect()),
        Value::Object(map) => Any::Map(std::sync::Arc::new(
            map.iter()
                .map(|(k, v)| (k.clone(), value_to_any(v)))
                .collect(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_does() {
        for (value, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-12.5, "-12.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (5e-7, "5e-7"),
            (1e-6, "0.000001"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (2f64.powi(40), "1099511627776"),
            (1.5e300, "1.5e+300"),
            (-2.5e-10, "-2.5e-10"),
            (f64::MAX, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(js_number(value), text, "{value}");
        }
    }

    #[test]
    fn strings_escape_as_javascript_does() {
        let text = "a\"b\\c\u{1}\u{1f}\u{8}\u{c}\n\r\té中😀\u{2028}\u{7f}";
        let mut out = String::new();
        write_string(&mut out, text);
        let expected = concat!(r#""a\"b\\c\u0001\u001f\b\f\n\r\té中😀"#, "\u{2028}\u{7f}\"");
        assert_eq!(out, expected);
        assert_eq!(escaped_len(text) + 2, out.len());
    }
}
