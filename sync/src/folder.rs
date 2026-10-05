//! Where the bytes behind the document live.
//!
//! A native prong mirrors a real directory; the browser keeps a session copy
//! in memory, because there the launcher's own store is the durable copy.

use std::{collections::HashMap, future::Future, pin::Pin, sync::Mutex};
#[cfg(feature = "native")]
use std::path::PathBuf;

use anyhow::Result;
#[cfg(feature = "native")]
use anyhow::Context;

#[cfg(feature = "native")]
use crate::engine::is_safe_name;

type FolderFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Every file the folder holds right now: a name and its bytes.
pub(crate) type FolderFiles = Vec<(String, Vec<u8>)>;

/// The files behind the document, one entry per file name.
pub(crate) trait Folder: Send + Sync + 'static {
    /// Every file the folder holds right now, for seeding and drift checks.
    fn snapshot(&self) -> FolderFuture<'_, Result<FolderFiles>>;

    /// Write a file, so the folder and the document hold the same bytes.
    fn write(&self, name: &str, bytes: &[u8]) -> FolderFuture<'_, Result<()>>;

    /// The current bytes of a file, when the folder holds it.
    fn read(&self, name: &str) -> FolderFuture<'_, Option<Vec<u8>>>;
}

/// A real directory, used by every native prong.
#[cfg(feature = "native")]
pub(crate) struct DiskFolder {
    dir: PathBuf,
}

#[cfg(feature = "native")]
impl DiskFolder {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
}

#[cfg(feature = "native")]
impl Folder for DiskFolder {
    fn snapshot(&self) -> FolderFuture<'_, Result<FolderFiles>> {
        let dir = self.dir.clone();
        Box::pin(async move {
            let mut files = Vec::new();
            let mut entries = tokio::fs::read_dir(&dir)
                .await
                .with_context(|| format!("failed to read {}", dir.display()))?;
            while let Some(entry) = entries
                .next_entry()
                .await
                .context("failed to read the folder")?
            {
                if !entry
                    .file_type()
                    .await
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
                {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if !is_safe_name(&name) {
                    continue;
                }
                if let Ok(bytes) = tokio::fs::read(entry.path()).await {
                    files.push((name, bytes));
                }
            }
            Ok(files)
        })
    }

    fn write(&self, name: &str, bytes: &[u8]) -> FolderFuture<'_, Result<()>> {
        let name = name.to_owned();
        let path = self.dir.join(&name);
        let bytes = bytes.to_vec();
        Box::pin(async move {
            tokio::fs::write(&path, &bytes)
                .await
                .with_context(|| format!("failed to write {name}"))
        })
    }

    fn read(&self, name: &str) -> FolderFuture<'_, Option<Vec<u8>>> {
        let path = self.dir.join(name);
        Box::pin(async move { tokio::fs::read(path).await.ok() })
    }
}

/// A session copy in memory, used by the browser.
pub(crate) struct MemoryFolder {
    files: Mutex<HashMap<String, Vec<u8>>>,
}

impl MemoryFolder {
    pub(crate) fn new() -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
        }
    }
}

impl Folder for MemoryFolder {
    fn snapshot(&self) -> FolderFuture<'_, Result<FolderFiles>> {
        Box::pin(async move {
            let files = self.files.lock().unwrap();
            Ok(files
                .iter()
                .map(|(name, bytes)| (name.clone(), bytes.clone()))
                .collect())
        })
    }

    fn write(&self, name: &str, bytes: &[u8]) -> FolderFuture<'_, Result<()>> {
        let name = name.to_owned();
        let bytes = bytes.to_vec();
        Box::pin(async move {
            self.files.lock().unwrap().insert(name, bytes);
            Ok(())
        })
    }

    fn read(&self, name: &str) -> FolderFuture<'_, Option<Vec<u8>>> {
        let name = name.to_owned();
        Box::pin(async move { self.files.lock().unwrap().get(&name).cloned() })
    }
}
