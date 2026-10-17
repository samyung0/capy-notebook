//! The source rooms' disk store (Epo 2026-10-17): original file bytes, seeds
//! and indexed baselines as files in one folder, keyed by content identity
//! and shared by every loaded room of the same file. A loaded room holds the
//! files it took; once no loaded room holds a file it is deleted [`GRACE`]
//! later, unless a room takes it again. Nothing stays in memory between
//! calls: every read loads the file and checks its SHA-256, and a file that
//! fails the check is deleted so the caller downloads or rebuilds it. Only
//! loaded rooms write files, and the folder never holds more than its cap:
//! idle files go first (oldest first), and a write is refused only when the
//! files loaded rooms hold leave no room. The folder is wiped when the store
//! opens (server start) and cleared at a graceful stop.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::Mutex;

use crate::SourceFormat;

/// How long a file no loaded room holds waits for a room to take it again.
pub const GRACE: Duration = Duration::from_secs(180);

/// A file name built only from validated parts: lowercase SHA-256 hex and
/// format names, so no key can name a path outside the folder.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Key(String);

fn sha_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

const FORMATS: [&str; 4] = ["docx", "xlsx", "pptx", "text"];

fn format_name(format: SourceFormat) -> &'static str {
    match format {
        SourceFormat::Docx => FORMATS[0],
        SourceFormat::Xlsx => FORMATS[1],
        SourceFormat::Pptx => FORMATS[2],
        SourceFormat::Text => FORMATS[3],
    }
}

impl Key {
    /// An original by its SHA-256.
    pub fn base(sha: &str) -> Option<Key> {
        sha_hex(sha).then(|| Key(format!("base-{sha}")))
    }

    /// seed(base) per format and base SHA-256.
    pub fn seed(format: SourceFormat, base: &str) -> Option<Key> {
        sha_hex(base).then(|| Key(format!("seed-{}-{base}", format_name(format))))
    }

    /// An indexed baseline: of seed(base), or of a published capture (its
    /// whole state's SHA-256) while a rebuild is pending.
    pub fn baseline(format: SourceFormat, base: &str, published: Option<&str>) -> Option<Key> {
        if !sha_hex(base) || !published.is_none_or(sha_hex) {
            return None;
        }
        let format = format_name(format);
        Some(Key(match published {
            None => format!("baseline-{format}-{base}"),
            Some(published) => format!("baseline-{format}-{base}-{published}"),
        }))
    }

    pub fn file_name(&self) -> &str {
        &self.0
    }

    /// Whether a file in the folder has a name this store writes (a key's,
    /// or a write's temporary `tmp-<serial>`, which no key can be): the start
    /// wipe deletes those and leaves anything else alone.
    fn ours(name: &str) -> bool {
        let parts: Vec<&str> = name.split('-').collect();
        match parts.as_slice() {
            ["tmp", serial] => !serial.is_empty() && serial.bytes().all(|b| b.is_ascii_digit()),
            ["base", sha] => sha_hex(sha),
            ["seed", format, sha] => FORMATS.contains(format) && sha_hex(sha),
            ["baseline", format, sha] => FORMATS.contains(format) && sha_hex(sha),
            ["baseline", format, sha, published] => {
                FORMATS.contains(format) && sha_hex(sha) && sha_hex(published)
            }
            _ => false,
        }
    }
}

/// A file on disk, or being written.
struct File {
    bytes: u64,
    sha256: String,
    /// Which write made it, so a failed read deletes only the file it read.
    serial: u64,
    /// Renamed into place. Until then reads miss, and its bytes count as
    /// used (and held) so concurrent writes stay within the cap.
    ready: bool,
}

#[derive(Default)]
struct Entry {
    /// The loaded rooms (load generations) holding the file.
    holders: BTreeSet<u64>,
    /// When the last holder let go.
    idle_since: Option<Instant>,
    /// None until a holder writes it, or after a failed check deleted it.
    file: Option<File>,
    /// Refused for the cap since rooms took it (a save logs the first one).
    refused: bool,
}

#[derive(Default)]
struct Index {
    entries: HashMap<Key, Entry>,
    /// The bytes of the files on disk.
    used: u64,
    serial: u64,
}

impl Index {
    /// A loaded room unloaded (or its load failed): the files only it held
    /// go idle from `now`.
    fn release(&mut self, holder: u64, now: Instant) {
        self.entries.retain(|_, entry| {
            if entry.holders.remove(&holder) && entry.holders.is_empty() {
                if entry.file.is_none() {
                    return false;
                }
                entry.idle_since = Some(now);
            }
            true
        });
    }
}

/// Deletes the files in `dir` with a name this store writes (anything else
/// stays).
fn wipe(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_str().is_some_and(Key::ours) {
            match std::fs::remove_file(entry.path()) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
    }
    Ok(())
}

fn held(entries: &HashMap<Key, Entry>) -> u64 {
    entries
        .values()
        .filter(|entry| !entry.holders.is_empty())
        .filter_map(|entry| entry.file.as_ref())
        .map(|file| file.bytes)
        .sum()
}

/// A room load's hold on the files it takes, by its generation. Dropping it
/// lets them go: the room unloaded, its load failed, or a panic unwound
/// either, so no path leaves them held against the cap.
pub struct Hold {
    disk: Arc<DiskStore>,
    generation: u64,
}

impl Hold {
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl std::fmt::Debug for Hold {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Hold").field(&self.generation).finish()
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let (generation, now) = (self.generation, Instant::now());
        // At once when the index is free, else on a task (a drop cannot wait).
        if let Ok(mut index) = self.disk.index.try_lock() {
            index.release(generation, now);
        } else if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let disk = self.disk.clone();
            runtime.spawn(async move { disk.index.lock().await.release(generation, now) });
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PutError {
    /// `again`: refused before while rooms hold the file.
    #[error("loaded rooms' files fill the source disk store ({held} of {cap} bytes)")]
    Full { held: u64, cap: u64, again: bool },
    #[error("source disk store: {0}")]
    Io(#[from] std::io::Error),
}

pub struct DiskStore {
    dir: PathBuf,
    cap: u64,
    index: Mutex<Index>,
}

impl DiskStore {
    /// Opens `dir` (created, mode 0700 on Unix) and deletes every file a
    /// previous run left.
    pub fn open(dir: PathBuf, cap: u64) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        wipe(&dir)?;
        Ok(DiskStore {
            dir,
            cap,
            index: Mutex::default(),
        })
    }

    fn path(&self, key: &Key) -> PathBuf {
        self.dir.join(key.file_name())
    }

    /// The file's bytes and SHA-256 when it is here and intact. `holder` (a
    /// loaded room) takes the file first, so it stays while the room is
    /// loaded even when it is not here yet; without one (a roomless job) the
    /// read changes nothing. A file whose bytes fail the check is deleted:
    /// the caller downloads or rebuilds it.
    pub async fn get(&self, key: &Key, holder: Option<u64>) -> Option<(Vec<u8>, String)> {
        let (sha256, serial) = {
            let mut index = self.index.lock().await;
            let entry = match holder {
                Some(holder) => {
                    let entry = index.entries.entry(key.clone()).or_default();
                    entry.holders.insert(holder);
                    entry.idle_since = None;
                    entry
                }
                None => index.entries.get_mut(key)?,
            };
            let file = entry.file.as_ref().filter(|file| file.ready)?;
            (file.sha256.clone(), file.serial)
        };
        let path = self.path(key);
        let expected = sha256.clone();
        let read = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(path).ok()?;
            (office_service::sha256_hex(&bytes) == expected).then_some(bytes)
        })
        .await
        .ok()
        .flatten();
        match read {
            Some(bytes) => Some((bytes, sha256)),
            None => {
                self.failed_check(key, serial).await;
                None
            }
        }
    }

    /// Deletes a file whose read failed its check (or vanished), unless a
    /// later write replaced it; its holders keep their claim.
    async fn failed_check(&self, key: &Key, serial: u64) {
        let mut index = self.index.lock().await;
        let Index { entries, used, .. } = &mut *index;
        let Some(entry) = entries.get_mut(key) else {
            return;
        };
        let Some(file) = entry.file.take_if(|file| file.serial == serial) else {
            return;
        };
        *used -= file.bytes;
        if entry.holders.is_empty() {
            entries.remove(key);
        }
        crate::observe::log(
            "warn",
            "source disk file failed its check",
            json!({ "file": key.file_name() }),
        );
        self.remove(key).await;
    }

    /// Refused ([`PutError::Full`]) when a file of `need` bytes would not fit
    /// beside the files loaded rooms hold: [`DiskStore::put`]'s own check,
    /// for a room load to make before it downloads or builds the file.
    pub async fn room_for(&self, need: u64) -> Result<(), PutError> {
        self.fits(&self.index.lock().await.entries, need)
    }

    /// The bytes of the files loaded rooms hold (what a refusal compares
    /// with the cap; idle files are not counted).
    pub async fn held(&self) -> u64 {
        held(&self.index.lock().await.entries)
    }

    fn fits(&self, entries: &HashMap<Key, Entry>, need: u64) -> Result<(), PutError> {
        let held = held(entries);
        if held + need > self.cap {
            return Err(PutError::Full {
                held,
                cap: self.cap,
                again: false,
            });
        }
        Ok(())
    }

    /// Writes a loaded room's file, which it then holds. Idle files go first
    /// (oldest first) to make room; refused when the files loaded rooms hold
    /// leave none. A file another room wrote, or is writing, is kept as it
    /// is. The bytes go to a temporary file outside the lock (reads and other
    /// writes go on meanwhile) and are renamed into place under it. No fsync:
    /// the index is in memory and the start wipe deletes every file, so a
    /// crash leaves nothing on disk to trust.
    pub async fn put(
        &self,
        key: &Key,
        bytes: &[u8],
        sha256: &str,
        holder: u64,
    ) -> Result<(), PutError> {
        let serial = {
            let mut index = self.index.lock().await;
            let Index {
                entries,
                used,
                serial,
            } = &mut *index;
            let entry = entries.entry(key.clone()).or_default();
            entry.holders.insert(holder);
            entry.idle_since = None;
            if entry.file.is_some() {
                return Ok(());
            }
            let need = bytes.len() as u64;
            if let Err(mut refused) = self.fits(entries, need) {
                if let (PutError::Full { again, .. }, Some(entry)) =
                    (&mut refused, entries.get_mut(key))
                {
                    *again = std::mem::replace(&mut entry.refused, true);
                }
                return Err(refused);
            }
            let mut idle: Vec<(Instant, Key)> = entries
                .iter()
                .filter(|(_, entry)| entry.holders.is_empty() && entry.file.is_some())
                .filter_map(|(key, entry)| Some((entry.idle_since?, key.clone())))
                .collect();
            idle.sort();
            for (_, victim) in idle {
                if *used + need <= self.cap {
                    break;
                }
                if let Some(file) = entries.remove(&victim).and_then(|entry| entry.file) {
                    *used -= file.bytes;
                    self.remove(&victim).await;
                }
            }
            *serial += 1;
            *used += need;
            if let Some(entry) = entries.get_mut(key) {
                entry.file = Some(File {
                    bytes: need,
                    sha256: sha256.to_owned(),
                    serial: *serial,
                    ready: false,
                });
            }
            *serial
        };
        let temp = self.dir.join(format!("tmp-{serial}"));
        let written = tokio::fs::write(&temp, bytes).await;
        let mut index = self.index.lock().await;
        let Index { entries, used, .. } = &mut *index;
        // Its rooms let go meanwhile and a sweep or an eviction took it.
        let Some(entry) = entries.get_mut(key).filter(|entry| {
            entry
                .file
                .as_ref()
                .is_some_and(|file| file.serial == serial)
        }) else {
            let _ = tokio::fs::remove_file(&temp).await;
            return Ok(());
        };
        let error = match written {
            Ok(()) => match tokio::fs::rename(&temp, self.path(key)).await {
                Ok(()) => {
                    if let Some(file) = entry.file.as_mut() {
                        file.ready = true;
                    }
                    return Ok(());
                }
                Err(error) => error,
            },
            Err(error) => error,
        };
        if let Some(file) = entry.file.take() {
            *used -= file.bytes;
        }
        if entry.holders.is_empty() {
            entries.remove(key);
        }
        let _ = tokio::fs::remove_file(&temp).await;
        Err(error.into())
    }

    /// The hold of a room load (its generation) on the files it takes.
    pub fn hold(self: &Arc<Self>, generation: u64) -> Hold {
        Hold {
            disk: self.clone(),
            generation,
        }
    }

    /// A graceful stop (Epo 2026-10-17): forgets every file and deletes the
    /// names this store writes, as the start wipe does. A crash leaves them
    /// for the next start; a write finishing after this deletes its own.
    pub async fn clear(&self) -> std::io::Result<()> {
        let mut index = self.index.lock().await;
        index.entries.clear();
        index.used = 0;
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || wipe(&dir))
            .await
            .map_err(std::io::Error::other)?
    }

    #[cfg(test)]
    pub async fn release(&self, holder: u64, now: Instant) {
        self.index.lock().await.release(holder, now);
    }

    /// Deletes the files no loaded room took again within [`GRACE`].
    pub async fn sweep(&self, now: Instant) {
        let mut index = self.index.lock().await;
        let Index { entries, used, .. } = &mut *index;
        let expired: Vec<Key> = entries
            .iter()
            .filter(|(_, entry)| {
                entry.holders.is_empty()
                    && entry
                        .idle_since
                        .is_some_and(|since| now.saturating_duration_since(since) >= GRACE)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            if let Some(file) = entries.remove(&key).and_then(|entry| entry.file) {
                *used -= file.bytes;
                self.remove(&key).await;
            }
        }
    }

    async fn remove(&self, key: &Key) {
        match tokio::fs::remove_file(self.path(key)).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => crate::observe::log(
                "warn",
                "source disk file could not be deleted",
                json!({ "error": error.to_string(), "file": key.file_name() }),
            ),
            _ => {}
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh folder under the system temp dir (removed by the caller's
    /// [`Folder`] guard).
    pub(crate) struct Folder(pub PathBuf);

    impl Folder {
        pub(crate) fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "capy-source-disk-{name}-{}-{}",
                std::process::id(),
                next_id()
            ));
            Folder(path)
        }

        /// The names of the files in the folder, sorted.
        pub(crate) fn files(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(&self.0)
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn next_id() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    fn sha(byte: char) -> String {
        std::iter::repeat_n(byte, 64).collect()
    }

    fn base(byte: char) -> Key {
        Key::base(&sha(byte)).unwrap()
    }

    async fn put(store: &DiskStore, key: &Key, bytes: &[u8], holder: u64) {
        let hash = office_service::sha256_hex(bytes);
        store.put(key, bytes, &hash, holder).await.unwrap();
    }

    #[test]
    fn keys_take_only_lowercase_sha_hex_and_known_formats() {
        let good = sha('a');
        assert_eq!(
            Key::base(&good).unwrap().file_name(),
            format!("base-{good}")
        );
        assert_eq!(
            Key::seed(SourceFormat::Pptx, &good).unwrap().file_name(),
            format!("seed-pptx-{good}")
        );
        assert_eq!(
            Key::baseline(SourceFormat::Docx, &good, Some(&sha('b')))
                .unwrap()
                .file_name(),
            format!("baseline-docx-{good}-{}", sha('b'))
        );
        let traversal = format!("../{}", &good[3..]);
        let bad = [
            "",
            "../../etc/passwd",
            traversal.as_str(),
            &good[1..],
            &format!("{good}0"),
            &good.to_uppercase(),
            &format!("{}/", &good[1..]),
            &format!("{}\\", &good[1..]),
            &format!("{}\0", &good[1..]),
        ];
        for value in bad {
            assert_eq!(Key::base(value), None, "{value:?}");
            assert_eq!(Key::seed(SourceFormat::Text, value), None, "{value:?}");
            assert_eq!(Key::baseline(SourceFormat::Xlsx, value, None), None);
            assert_eq!(Key::baseline(SourceFormat::Xlsx, &good, Some(value)), None);
        }
    }

    #[tokio::test]
    async fn the_folder_is_wiped_at_start_and_keeps_what_it_did_not_write() {
        let folder = Folder::new("wipe");
        std::fs::create_dir_all(&folder.0).unwrap();
        let ours = [
            base('a').file_name().to_owned(),
            Key::seed(SourceFormat::Docx, &sha('a'))
                .unwrap()
                .file_name()
                .to_owned(),
            Key::baseline(SourceFormat::Pptx, &sha('a'), Some(&sha('b')))
                .unwrap()
                .file_name()
                .to_owned(),
            // A write a crash cut short.
            "tmp-7".to_owned(),
        ];
        let theirs = ["notes.txt", "tmp-", "tmp-notes"];
        for name in ours.iter().map(String::as_str).chain(theirs) {
            std::fs::write(folder.0.join(name), b"left over").unwrap();
        }
        DiskStore::open(folder.0.clone(), 100).unwrap();
        assert_eq!(folder.files(), theirs);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&folder.0).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[tokio::test]
    async fn rooms_of_the_same_file_share_it_until_the_grace_after_the_last_unload() {
        let folder = Folder::new("share");
        let store = DiskStore::open(folder.0.clone(), 100).unwrap();
        let key = base('a');
        let start = Instant::now();
        // Room 1 writes the file; room 2 takes the same one.
        assert_eq!(store.get(&key, Some(1)).await, None);
        put(&store, &key, b"original", 1).await;
        let (bytes, hash) = store.get(&key, Some(2)).await.unwrap();
        assert_eq!(bytes, b"original");
        assert_eq!(hash, office_service::sha256_hex(b"original"));
        assert_eq!(folder.files(), [key.file_name()]);
        // One room unloading keeps it, however long.
        store.release(1, start).await;
        store.sweep(start + GRACE * 10).await;
        assert_eq!(folder.files(), [key.file_name()]);
        // After the last one, it stays for the grace and then goes.
        let unloaded = start + GRACE * 10;
        store.release(2, unloaded).await;
        store.sweep(unloaded + GRACE - Duration::from_secs(1)).await;
        assert_eq!(folder.files(), [key.file_name()]);
        // A roomless read within the grace does not keep it.
        assert!(store.get(&key, None).await.is_some());
        store.sweep(unloaded + GRACE).await;
        assert!(folder.files().is_empty());
        assert_eq!(store.get(&key, None).await, None);
    }

    #[tokio::test]
    async fn a_room_taking_the_file_within_the_grace_keeps_it() {
        let folder = Folder::new("retake");
        let store = DiskStore::open(folder.0.clone(), 100).unwrap();
        let key = base('a');
        let start = Instant::now();
        put(&store, &key, b"original", 1).await;
        store.release(1, start).await;
        // A new load takes it two minutes later.
        assert!(store.get(&key, Some(2)).await.is_some());
        store.sweep(start + GRACE * 2).await;
        assert_eq!(folder.files(), [key.file_name()]);
        // Its grace starts again from that room's unload.
        let unloaded = start + GRACE * 2;
        store.release(2, unloaded).await;
        store.sweep(unloaded + GRACE / 2).await;
        assert_eq!(folder.files(), [key.file_name()]);
        store.sweep(unloaded + GRACE).await;
        assert!(folder.files().is_empty());
    }

    #[tokio::test]
    async fn idle_files_go_oldest_first_and_only_loaded_rooms_files_refuse_a_write() {
        let folder = Folder::new("cap");
        let store = DiskStore::open(folder.0.clone(), 100).unwrap();
        let start = Instant::now();
        let (held, older, newer) = (base('a'), base('b'), base('c'));
        put(&store, &held, &[1; 40], 1).await;
        put(&store, &older, &[2; 30], 2).await;
        put(&store, &newer, &[3; 30], 3).await;
        store.release(2, start).await;
        store.release(3, start + Duration::from_secs(1)).await;
        // 100 of 100 used, 40 held: a 30-byte file pushes out the older idle one.
        let (d, e) = (base('d'), base('e'));
        put(&store, &d, &[4; 30], 4).await;
        let mut expected = vec![held.file_name(), newer.file_name(), d.file_name()];
        expected.sort();
        assert_eq!(folder.files(), expected);
        // 70 held: a 40-byte file is refused, and the idle file stays.
        let refused = store
            .put(&e, &[5; 40], &office_service::sha256_hex([5; 40]), 5)
            .await;
        assert!(
            matches!(
                refused,
                Err(PutError::Full {
                    held: 70,
                    cap: 100,
                    again: false
                })
            ),
            "{refused:?}"
        );
        // Refused again while its room holds it: a save logs the first only.
        let again = store
            .put(&e, &[5; 40], &office_service::sha256_hex([5; 40]), 5)
            .await;
        assert!(
            matches!(again, Err(PutError::Full { again: true, .. })),
            "{again:?}"
        );
        assert_eq!(folder.files(), expected);
        // 30 fits once the idle file goes.
        put(&store, &e, &[5; 30], 5).await;
        let mut expected = vec![held.file_name(), d.file_name(), e.file_name()];
        expected.sort();
        assert_eq!(folder.files(), expected);
    }

    #[tokio::test]
    async fn a_write_that_fails_gives_its_room_back_and_leaves_no_file() {
        let folder = Folder::new("unwritten");
        let store = DiskStore::open(folder.0.clone(), 10).unwrap();
        std::fs::remove_dir_all(&folder.0).unwrap();
        let refused = store
            .put(
                &base('a'),
                &[1; 10],
                &office_service::sha256_hex([1; 10]),
                1,
            )
            .await;
        assert!(matches!(refused, Err(PutError::Io(_))), "{refused:?}");
        std::fs::create_dir_all(&folder.0).unwrap();
        put(&store, &base('b'), &[2; 10], 2).await;
        assert_eq!(folder.files(), [base('b').file_name()]);
    }

    // The write runs outside the index lock: a read is served while another
    // file's write waits on the disk (a FIFO where the file goes, which the
    // write's rename replaces; a write in place would wait for a reader).
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_read_is_served_while_another_file_is_written() {
        let folder = Folder::new("unlocked");
        let store = Arc::new(DiskStore::open(folder.0.clone(), 100).unwrap());
        let (served, written) = (base('a'), base('b'));
        put(&store, &served, b"served", 1).await;
        let fifo = folder.0.join(written.file_name());
        let made = std::process::Command::new("mkfifo").arg(&fifo).status();
        assert!(made.unwrap().success());
        let writing = {
            let (store, written) = (store.clone(), written.clone());
            tokio::spawn(async move { put(&store, &written, b"written", 2).await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        let read = tokio::time::timeout(Duration::from_secs(5), store.get(&served, None)).await;
        if read.is_err() {
            // Let a write stuck on the FIFO finish before failing.
            let _ = tokio::task::spawn_blocking(move || std::fs::read(fifo)).await;
        }
        assert_eq!(read.expect("served").unwrap().0, b"served");
        writing.await.unwrap();
        assert_eq!(store.get(&written, None).await.unwrap().0, b"written");
    }

    // A load's hold lets go of its files when dropped: by a panic between
    // the load and serving, and while the index is busy (a leaked hold would
    // keep its bytes against the cap until a restart).
    #[tokio::test]
    async fn a_dropped_hold_lets_go_of_its_files_even_in_a_panic() {
        let folder = Folder::new("hold");
        let store = Arc::new(DiskStore::open(folder.0.clone(), 100).unwrap());
        let hold = store.hold(1);
        put(&store, &base('a'), b"first", 1).await;
        let unwound = tokio::spawn(async move {
            let _hold = hold;
            panic!("between the load and serving");
        });
        assert!(unwound.await.unwrap_err().is_panic());
        let hold = store.hold(2);
        put(&store, &base('b'), b"second", 2).await;
        {
            let _busy = store.index.lock().await;
            drop(hold);
        }
        tokio::task::yield_now().await;
        store.sweep(Instant::now() + GRACE).await;
        assert!(folder.files().is_empty());
    }

    #[tokio::test]
    async fn a_file_that_fails_its_check_is_deleted_and_written_again() {
        let folder = Folder::new("check");
        let store = DiskStore::open(folder.0.clone(), 100).unwrap();
        let key = base('a');
        put(&store, &key, b"original", 1).await;
        put(&store, &key, b"ignored", 2).await;
        // Short on disk: not served, deleted.
        std::fs::write(folder.0.join(key.file_name()), b"orig").unwrap();
        assert_eq!(store.get(&key, Some(1)).await, None);
        assert!(folder.files().is_empty());
        // Written again, both rooms still hold it.
        put(&store, &key, b"original", 1).await;
        let start = Instant::now();
        store.release(1, start).await;
        store.sweep(start + GRACE).await;
        assert_eq!(store.get(&key, None).await.unwrap().0, b"original");
        // Same length, other bytes: not served either.
        std::fs::write(folder.0.join(key.file_name()), b"ORIGINAL").unwrap();
        assert_eq!(store.get(&key, None).await, None);
        assert!(folder.files().is_empty());
    }
}
