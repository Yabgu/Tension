//! `tension::res` — the read-only volume VFS, and the one writable root.
//!
//! Twelve imports, moved out of `main()` unchanged. Every one of them reaches
//! the mount table, the write root and the fd table through `Caller::data()`;
//! none closes over a `main` local, which is why the move needed no parameters
//! beyond the linker.
//!
//! The table itself is shared by `Arc` — the adapter host reads the same one
//! from a worker thread (`res_volume_bytes`), so a second copy here would be a
//! second answer to "what is in this pak".

use wasmtime::{Caller, Linker};

use crate::{
    fd_index, guest_path, is_write_fd, mount_table, pack_fd, read_guest_span, write_files,
    write_guest, write_stat, HostState, EBADF, EINVAL, ENOENT, FD_LOCAL_MASK, FD_SET_SHIFT,
    FD_WRITE_TAG,
};

/// Register the `tension::res` verbs.
pub fn link_res(linker: &mut Linker<HostState>) -> anyhow::Result<()> {
    // tension::res ABI ----------------------------------------------------
    // The read-only resource VFS (tension-res, ECMA-208 SIDF). Every call is
    // strict: a path that does not resolve in any loaded pak is -ENOENT, and
    // the framework layer is what turns that into null/[] for the guest (§7).
    //
    // `res_write` is the one verb that is not the VFS: it lands on the real
    // filesystem under `--write-root`, because a pak is an immutable archive and
    // an editor that cannot save is a viewer. The sandbox is `res::WriteRoot`'s,
    // and every refusal there is -EROFS.
    // `res_mount(prefix_ptr, prefix_len, path_ptr, path_len) -> mount index`
    //
    // The generic mount. A guest that wants a packed volume visible at
    // `resources/models/x.mesh` says so once, here, and every `tension::res`
    // verb sees it from then on — including `res_read_file`, which is what lets
    // one volume serve both a guest's own readers and a capability's loader.
    //
    // **The host owns this table.** Before it, a mount existed only inside the
    // Ogre capability: `ogre.mount_tns` kept its own prefix table, resolved
    // paths by its own rule and read the disk with its own reader, so any guest
    // that wanted a volume needed the Ogre adapter loaded, and the same volume
    // had to be passed to the host (`--res`) *and* to the adapter (`--tns`) to be
    // visible to both. One table removes the second implementation and the
    // second copy of the bytes.
    //
    // Refusals: an empty prefix or path, a prefix with a trailing `/` or a
    // leading `/` (-EINVAL — a prefix is a name, not a path), a duplicate prefix
    // (-EEXIST), a file that does not exist (-ENOENT), and a volume that does not
    // parse (-EIO). Returns the mount's index in the table, which is also what
    // an fd's high bits name.
    linker.func_wrap(
        "tension::res",
        "res_mount",
        |mut caller: Caller<'_, HostState>, prefix_ptr: i32, prefix_len: i32,
         path_ptr: i32, path_len: i32|
         -> i32 {
            let Some(prefix) = guest_path(&mut caller, prefix_ptr, prefix_len) else {
                return EINVAL;
            };
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            let table = mount_table(&caller);
            let mut guard = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match guard.mount(&prefix, &path) {
                Ok(index) => {
                    drop(guard);
                    crate::logging::log(
                        crate::logging::Level::Info,
                        "res",
                        &format!("mounted \"{prefix}/\" from {path} (mount {index})"),
                    );
                    index as i32
                }
                Err(error) => error.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_write",
        |mut caller: Caller<'_, HostState>,
         path_ptr: i32,
         path_len: i32,
         data_ptr: i32,
         data_len: i32|
         -> i32 {
            if data_len < 0 {
                return EINVAL;
            }
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            if data_len == 0 {
                // An empty file is a legitimate save (a cleared document), so the
                // zero-length case is a real write rather than a refusal.
            }
            let Some(bytes) = read_guest_span(&mut caller, data_ptr as u32, data_len as u32) else {
                return EINVAL;
            };
            match caller.data().write_root.as_ref() {
                Some(root) => match root.write(&path, &bytes) {
                    Ok(written) => written as i32,
                    Err(error) => error.code(),
                },
                // No root: a host whose `--write-root` did not resolve. Refused
                // rather than silently writing to the working directory, which
                // is the flag's absence meaning something else.
                None => -30, // EROFS
            }
        },
    )?;
    linker.func_wrap(
        "tension::res",
        "res_open",
        |mut caller: Caller<'_, HostState>, path_ptr: i32, path_len: i32| -> i32 {
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            let table = mount_table(&caller);
            let open = {
                let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                mounts.resolve(&path, |set, relative| set.open_fd(relative))
            };
            match open {
                Ok((index, fd)) => return pack_fd(index, fd),
                // **Not in any pak: try what the guest itself wrote.** The paks
                // are immutable and `res_write` lands on the filesystem, so
                // without this an editor could save a document and never load it
                // back — the write succeeded and the read looked in archives that
                // never held it.
                Err(error) if error.code() == ENOENT => {}
                // Only a *miss* falls through. A malformed path (`-EINVAL`) or a
                // volume that failed to read is reported, because the fallback
                // exists for "not there", not for "the question was wrong".
                Err(error) => return error.code(),
            }
            // Both handles are *cloned* out of the store rather than borrowed:
            // `WriteRoot` is a canonical `PathBuf` and the files table is an
            // `Arc`, so this is one path copy and one refcount bump — and it
            // keeps the borrow checker's answer simple instead of reaching for
            // a pointer that the store's own `data_mut` calls could invalidate.
            let files = std::sync::Arc::clone(&caller.data().write_files);
            let root = caller.data().write_root.clone();
            let Some(root) = root else {
                return ENOENT; // no write root means nothing was ever written
            };
            let mut files = files.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match files.open(&root, &path) {
                Ok(local) => (FD_WRITE_TAG << FD_SET_SHIFT) | (local & FD_LOCAL_MASK),
                Err(error) => error.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_close",
        |caller: Caller<'_, HostState>, fd: i32| -> i32 {
            if is_write_fd(fd) {
                let files = write_files(&caller);
                let mut files = files.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                return match files.close(fd & FD_LOCAL_MASK) {
                    Ok(()) => 0,
                    Err(error) => error.code(),
                };
            }
            let Some((index, local)) = fd_index(fd) else {
                return EBADF;
            };
            let table = mount_table(&caller);
            let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(mount) = mounts.get(index) else {
                return EBADF;
            };
            match mount.set.close_fd(local) {
                Ok(()) => 0,
                Err(e) => e.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_read",
        |mut caller: Caller<'_, HostState>, fd: i32, ptr: i32, len: i32| -> i32 {
            if len < 0 {
                return EINVAL;
            }
            if is_write_fd(fd) {
                // Same loop, different reader. The write-root file owns a cursor,
                // so a short read leaves the position exactly where the next call
                // should continue — which is what `res_read`'s contract is and
                // what a pak's offset argument gives it for free.
                let files = write_files(&caller);
                let want = len as usize;
                let mut copied: usize = 0;
                let mut chunk = [0u8; 4096];
                while copied < want {
                    let step = (want - copied).min(chunk.len());
                    let outcome = {
                        let mut files =
                            files.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        files.read(fd & FD_LOCAL_MASK, &mut chunk[..step])
                    };
                    match outcome {
                        Ok(0) => break,
                        Ok(n) => {
                            if !write_guest(&mut caller, ptr + copied as i32, &chunk[..n]) {
                                return EINVAL;
                            }
                            copied += n;
                            if n < step {
                                break;
                            }
                        }
                        Err(error) => return error.code(),
                    }
                }
                return copied as i32;
            }
            let Some((index, local)) = fd_index(fd) else {
                return EBADF;
            };
            let want = len as usize;
            let mut copied: usize = 0;
            let mut chunk = [0u8; 4096];
            // Cloned before the loop: `write_guest` takes `&mut caller` below,
            // so the table must not be borrowed from the store across it.
            let table = mount_table(&caller);
            while copied < want {
                let step = (want - copied).min(chunk.len());
                let outcome = {
                    let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    match mounts.get(index) {
                        Some(mount) => mount.set.read_fd(local, &mut chunk[..step]),
                        None => return EBADF,
                    }
                };
                match outcome {
                    Ok(0) => break,
                    Ok(n) => {
                        if !write_guest(&mut caller, ptr + copied as i32, &chunk[..n]) {
                            return EINVAL;
                        }
                        copied += n;
                        if n < step {
                            break;
                        }
                    }
                    // Bytes already handed over are the guest's; the error is
                    // only reported when nothing was delivered.
                    Err(e) => {
                        return if copied > 0 { copied as i32 } else { e.code() };
                    }
                }
            }
            copied as i32
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_seek",
        |caller: Caller<'_, HostState>, fd: i32, off: i64, whence: i32| -> i64 {
            if is_write_fd(fd) {
                let files = write_files(&caller);
                let mut files = files.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                return match files.seek(fd & FD_LOCAL_MASK, off, whence) {
                    Ok(pos) => pos,
                    Err(error) => error.code() as i64,
                };
            }
            let Some((index, local)) = fd_index(fd) else {
                return EBADF as i64;
            };
            let table = mount_table(&caller);
            let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(mount) = mounts.get(index) else {
                return EBADF as i64;
            };
            match mount.set.seek_fd(local, off, whence) {
                Ok(pos) => pos,
                Err(e) => e.code() as i64,
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_tell",
        |caller: Caller<'_, HostState>, fd: i32| -> i64 {
            if is_write_fd(fd) {
                let files = write_files(&caller);
                let mut files = files.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                return match files.tell(fd & FD_LOCAL_MASK) {
                    Ok(pos) => pos,
                    Err(error) => error.code() as i64,
                };
            }
            let Some((index, local)) = fd_index(fd) else {
                return EBADF as i64;
            };
            let table = mount_table(&caller);
            let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(mount) = mounts.get(index) else {
                return EBADF as i64;
            };
            match mount.set.tell_fd(local) {
                Ok(pos) => pos,
                Err(e) => e.code() as i64,
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_stat",
        |mut caller: Caller<'_, HostState>, path_ptr: i32, path_len: i32, out_ptr: i32| -> i32 {
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            let table = mount_table(&caller);
            let stat = {
                let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                mounts.resolve(&path, |set, relative| set.stat(relative))
            };
            // Same fallback as `res_open`, and needed for the same reason: a guest
            // that asks what it just saved must be told the truth, or it cannot
            // know whether a load has anything to read.
            let stat = match stat {
                Err(error) if error.code() == -2 => match caller.data().write_root.clone() {
                    Some(root) => root.stat(&path).map(|stat| (0usize, stat)),
                    None => Err(error),
                },
                other => other,
            };
            match stat {
                Ok((_, stat)) => {
                    if write_stat(&mut caller, out_ptr, &stat) {
                        0
                    } else {
                        EINVAL
                    }
                }
                Err(e) => e.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_stat_fd",
        |mut caller: Caller<'_, HostState>, fd: i32, out_ptr: i32| -> i32 {
            if is_write_fd(fd) {
                let files = write_files(&caller);
                let outcome = {
                    let mut files =
                        files.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    files.stat(fd & FD_LOCAL_MASK)
                };
                return match outcome {
                    Ok(stat) => {
                        if write_stat(&mut caller, out_ptr, &stat) {
                            0
                        } else {
                            EINVAL
                        }
                    }
                    Err(error) => error.code(),
                };
            }
            let Some((index, local)) = fd_index(fd) else {
                return EBADF;
            };
            let table = mount_table(&caller);
            let outcome = {
                let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                match mounts.get(index) {
                    Some(mount) => mount.set.stat_fd(local),
                    None => return EBADF,
                }
            };
            match outcome {
                Ok(stat) => {
                    if write_stat(&mut caller, out_ptr, &stat) {
                        0
                    } else {
                        EINVAL
                    }
                }
                Err(e) => e.code(),
            }
        },
    )?;

    linker.func_wrap(
        "tension::res",
        "res_readdir",
        |mut caller: Caller<'_, HostState>,
         path_ptr: i32,
         path_len: i32,
         index: i32,
         name_ptr: i32,
         name_cap: i32,
         out_ptr: i32|
         -> i32 {
            if index < 0 {
                return EINVAL;
            }
            let Some(path) = guest_path(&mut caller, path_ptr, path_len) else {
                return EINVAL;
            };
            let table = mount_table(&caller);
            let listed = {
                let mounts = table.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                mounts.resolve(&path, |set, relative| set.read_dir_at(relative, index as u32))
            };
            let entry = match listed {
                Ok((_, Some(entry))) => entry,
                Ok((_, None)) => return 0, // past the last child
                Err(e) => return e.code(),
            };
            if !write_stat(&mut caller, out_ptr, &entry.stat) {
                return EINVAL;
            }
            let bytes = entry.name.as_bytes();
            let cap = name_cap.max(0) as usize;
            if cap > 0 {
                let n = bytes.len().min(cap);
                if !write_guest(&mut caller, name_ptr, &bytes[..n]) {
                    return EINVAL;
                }
            }
            // The `arg` convention: min(cap, len) written, full length back.
            bytes.len() as i32
        },
    )?;

    Ok(())
}
