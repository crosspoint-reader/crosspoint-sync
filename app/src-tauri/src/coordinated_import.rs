//! Security scope is acquired at URL delivery and owned until the worker is done.
use objc2::rc::Retained;
use objc2_foundation::{NSString, NSURL};
use std::path::Path;

// All Open In workers share one slot, including workers from separate batches.
static IMPORT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub struct ScopedSource {
  url: Retained<NSURL>,
  accessed: bool,
}
impl ScopedSource {
  pub fn acquire(url: &url::Url) -> Result<Self, String> {
    if url.scheme() != "file" { return Err("Expected a file URL".into()); }
    let native = NSURL::URLWithString(&NSString::from_str(url.as_str())).ok_or("Invalid file URL")?;
    let accessed = unsafe { native.startAccessingSecurityScopedResource() };
    Ok(Self { url: native, accessed })
  }

  pub fn import_into(&self, root: &Path, name: &str) -> Result<crate::import_store::Entry, String> {
    use objc2_foundation::{NSFileCoordinator, NSFileCoordinatorReadingOptions};
    use std::{cell::RefCell, ptr::NonNull};
    // Acquire before coordination/reading and retain through publication and
    // buffer disposal. The worker continues owning its source grant while waiting.
    // This mutex protects scheduling only, so a prior panic cannot corrupt state.
    let _serial = IMPORT_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let outcome = RefCell::new(None);
    let reader = block2::StackBlock::new(|readable: NonNull<NSURL>| {
      // The coordinator may supply a different URL; read only its accessor URL
      // and finish reading before relinquishing the provider's coordinated access.
      let readable = unsafe { readable.as_ref() };
      let result = readable.path().ok_or_else(|| "Invalid coordinated file URL".to_string())
        .and_then(|path| std::fs::read(path.to_string()).map_err(|e| e.to_string()));
      *outcome.borrow_mut() = Some(result);
    });
    let mut error = None;
    NSFileCoordinator::new().coordinateReadingItemAtURL_options_error_byAccessor(
      &self.url, NSFileCoordinatorReadingOptions::empty(), Some(&mut error), &reader,
    );
    if let Some(error) = error { return Err(error.localizedDescription().to_string()); }
    let bytes = outcome.into_inner().ok_or("The file provider did not supply readable contents")??;
    crate::import_store::add(root, name, &bytes).map_err(|e| e.to_string())
  }
}
impl Drop for ScopedSource {
  fn drop(&mut self) {
    if self.accessed { unsafe { self.url.stopAccessingSecurityScopedResource() }; }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use objc2::rc::autoreleasepool;
  use objc2_foundation::{NSFileCoordinator, NSFileCoordinatorWritingOptions};
  use std::{fs, ptr::NonNull, sync::mpsc, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

  fn root() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("crosspoint-coordination-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&path).unwrap(); path
  }

  #[test]
  fn waits_for_a_coordinated_writer_and_serializes_other_imports() {
    autoreleasepool(|_| {
      let root = root();
      let input = root.join("source.epub");
      let queue = root.join("queue");
      fs::write(&input,b"old partial content").unwrap();
      let url = url::Url::from_file_path(&input).unwrap();
      let source = ScopedSource::acquire(&url).unwrap();
      let native = source.url.clone();
      let (locked_tx,locked_rx) = mpsc::channel();
      let (release_tx,release_rx) = mpsc::channel();
      let writer = thread::spawn(move || autoreleasepool(|_| {
        let callback = block2::StackBlock::new(|_: NonNull<NSURL>| {
          locked_tx.send(()).unwrap();
          release_rx.recv().unwrap();
          fs::write(&input,b"complete provider content").unwrap();
        });
        let mut error = None;
        NSFileCoordinator::new().coordinateWritingItemAtURL_options_error_byAccessor(&native,NSFileCoordinatorWritingOptions::empty(),Some(&mut error),&callback);
        assert!(error.is_none(),"{error:?}");
      }));
      locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
      let (done_tx,done_rx) = mpsc::channel();
      let destination = queue.clone();
      let reader = thread::spawn(move || autoreleasepool(|_| {
        done_tx.send(source.import_into(&destination,"book.epub")).unwrap();
      }));
      let early = done_rx.recv_timeout(Duration::from_millis(150));
      let before_publish = crate::import_store::list(&queue).unwrap();
      // While the first import waits on its provider, a different source must
      // not start buffering its contents or publish ahead of that import.
      let second_path = root.join("second.txt");
      fs::write(&second_path, b"second complete file").unwrap();
      let second = ScopedSource::acquire(&url::Url::from_file_path(&second_path).unwrap()).unwrap();
      let destination = queue.clone();
      let (second_tx, second_rx) = mpsc::channel();
      let second_reader = thread::spawn(move || autoreleasepool(|_| {
        second_tx.send(second.import_into(&destination, "second.txt")).unwrap();
      }));
      let concurrent = second_rx.recv_timeout(Duration::from_millis(150));
      release_tx.send(()).unwrap();
      writer.join().unwrap();
      reader.join().unwrap();
      second_reader.join().unwrap();
      let second_result = if let Ok(result) = concurrent.as_ref() { result.as_ref().unwrap().clone() } else { second_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap() };
      let result = if let Ok(result) = early.as_ref() { result.as_ref().unwrap().clone() } else { done_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap() };
      assert!(early.is_err(),"import completed while the provider still owned its write");
      assert!(before_publish.is_empty(),"partial provider content was published");
      assert!(concurrent.is_err(), "a second import buffered and published while the first was still coordinating");
      assert_eq!(crate::import_store::read(&queue,&second_result.id).unwrap(),b"second complete file");
      assert_eq!(crate::import_store::read(&queue,&result.id).unwrap(),b"complete provider content");
      fs::remove_dir_all(root).unwrap();
    });
  }

  #[test]
  fn a_failed_provider_read_leaves_no_queue_entry() {
    autoreleasepool(|_| {
      let root = root();
      let source = ScopedSource::acquire(&url::Url::from_file_path(root.join("missing.epub")).unwrap()).unwrap();
      let queue = root.join("queue");
      assert!(source.import_into(&queue,"missing.epub").is_err());
      assert!(crate::import_store::list(&queue).unwrap().is_empty());
      fs::remove_dir_all(root).unwrap();
    });
  }
}
