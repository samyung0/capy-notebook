#![allow(clippy::unwrap_used)] // Tests panic on a broken case.
//! Security regression (notes REVIEW2 M6): yrs reserved what an update
//! declared (a map's or array's length, the counts of clients, structs and
//! delete ranges) before reading it, so a few bytes could make the server
//! write gigabytes. Decoding now reserves no more than the input can hold.
//! This binary counts the bytes allocated while an update decodes (its only
//! test, so nothing else allocates meanwhile).
use std::alloc::System;

use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};
use yrs::encoding::write::Write;

#[global_allocator]
static GLOBAL: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;

/// One client with one struct: content `Any` (ref 8) under the root "t",
/// one value whose encoding starts with `value` and then ends.
fn any_item(value: &[u8]) -> Vec<u8> {
    let mut bytes: Vec<u8> = Vec::new();
    bytes.write_var(1u32);
    bytes.write_var(1u32);
    bytes.write_var(77u64);
    bytes.write_var(0u32);
    bytes.write_u8(8);
    bytes.write_var(1u32); // the parent is a root, by name
    bytes.write_string("t");
    bytes.write_var(1u32); // one value
    bytes.extend_from_slice(value);
    bytes
}

#[test]
fn declared_lengths_reserve_nothing_the_input_cannot_hold() {
    let huge = 1u32 << 22;
    let mut map = vec![118]; // an object
    map.write_var(huge);
    let mut array = vec![117];
    array.write_var(huge);
    let mut clients = Vec::new();
    clients.write_var(huge);
    let mut structs = Vec::new();
    structs.write_var(1u32);
    structs.write_var(huge);
    structs.write_var(77u64); // the client, then its first clock
    structs.write_var(0u32);
    let mut deletes = Vec::new();
    deletes.write_var(0u32); // no structs
    deletes.write_var(1u32); // one client in the delete set
    deletes.write_var(77u64);
    deletes.write_var(huge); // ranges
    let cases = [
        ("a map", any_item(&map)),
        ("an array", any_item(&array)),
        ("the clients", clients),
        ("a client's structs", structs),
        ("a client's delete ranges", deletes),
    ];
    for (name, bytes) in cases {
        let region = Region::new(GLOBAL);
        let decoded = ydoc::decode(&bytes);
        let change = region.change();
        let allocated = change.bytes_allocated + change.bytes_reallocated.max(0) as usize;
        assert!(decoded.is_err(), "{name}: decoded");
        // Declaring 2^22 entries took over 100 MiB before.
        assert!(allocated < 64 << 10, "{name}: {allocated} bytes allocated");
    }
}
