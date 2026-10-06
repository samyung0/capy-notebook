//! A byte-bounded LRU (sourceDocuments.ts `ByteCache`): bases, their seeds and
//! baselines, keyed by immutable content identity.

use indexmap::IndexMap;

pub struct ByteCache<V> {
    entries: IndexMap<String, (u64, V)>,
    used: u64,
    budget: u64,
}

impl<V: Clone> ByteCache<V> {
    pub fn new(budget: u64) -> Self {
        Self {
            entries: IndexMap::new(),
            used: 0,
            budget,
        }
    }

    pub fn get(&mut self, key: &str) -> Option<V> {
        let index = self.entries.get_index_of(key)?;
        let last = self.entries.len() - 1;
        self.entries.move_index(index, last);
        self.entries
            .get_index(last)
            .map(|(_, (_, value))| value.clone())
    }

    /// Keeps `value`, pushing out least recently used entries until it fits
    /// (an entry larger than the budget pushes out everything else).
    pub fn set(&mut self, key: &str, value: V, bytes: u64) {
        self.delete(key);
        while self.used + bytes > self.budget {
            let Some((_, (size, _))) = self.entries.shift_remove_index(0) else {
                break;
            };
            self.used -= size;
        }
        self.entries.insert(key.to_owned(), (bytes, value));
        self.used += bytes;
    }

    pub fn delete(&mut self, key: &str) {
        if let Some((size, _)) = self.entries.shift_remove(key) {
            self.used -= size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_least_recently_used_by_bytes() {
        let mut cache = ByteCache::new(10);
        cache.set("a", 1, 4);
        cache.set("b", 2, 4);
        assert_eq!(cache.get("a"), Some(1));
        cache.set("c", 3, 4);
        assert_eq!(cache.get("b"), None);
        assert_eq!((cache.get("a"), cache.get("c")), (Some(1), Some(3)));
        cache.set("big", 4, 20);
        assert_eq!((cache.get("a"), cache.get("big")), (None, Some(4)));
    }
}
