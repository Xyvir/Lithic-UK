//! The Windows answers to `platform`'s capabilities.
//!
//! Moved here from `lib.rs` unchanged: the shell link, the Start Menu entry, the
//! registry registration and the browser hand-off are the same code, called from one
//! place instead of three. The FFI bodies stay behind `#[cfg(windows)]` because this is
//! the only platform in the table that needs a platform crate; the module itself is only
//! compiled on Windows, and everything else in `platform` is compiled everywhere.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, ASFW_ANY, HICON};

use super::associations;

/// Open a link in the user's default browser.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // SAFETY: the verb and the address are fresh HSTRINGs that outlive the call,
    // and ShellExecuteW only reads its arguments.
    let opened = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(url),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success as a value above 32; at or below it the
    // number is an error code rather than a window.
    if (opened.0 as isize) <= 32 {
        return Err(format!("Could not open {}", url));
    }
    Ok(())
}

/// The Chromium browser this app can hand the flash page to, when one is installed.
///
/// Chrome first, then Edge. Both implement Web Serial, which is the only thing the offer needs;
/// Edge is listed at all because Windows itself installs it, so it is what answers on a machine
/// where nobody has installed a browser by hand, which is most of them.
///
/// The three folders are the ones a Windows browser lands in: the machine's programs, the 32-bit
/// program folder Chrome still uses on some installs, and this user's own programs, which is
/// where a per-user Chrome install goes when the installer was not elevated.
pub fn flash_browser() -> Option<PathBuf> {
    let roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .collect::<Vec<_>>();
    super::first_existing(&browser_candidates(&roots))
}

/// Chrome in every root before Edge in any of them, so a machine with both opens Chrome.
fn browser_candidates(roots: &[PathBuf]) -> Vec<PathBuf> {
    let routes = [
        ("Google", "Chrome", "chrome.exe"),
        ("Microsoft", "Edge", "msedge.exe"),
    ];
    routes
        .iter()
        .flat_map(|(vendor, product, executable)| {
            roots.iter().map(move |root| {
                root.join(vendor).join(product).join("Application").join(executable)
            })
        })
        .collect()
}

/// Reveal a file in Explorer, with the file itself selected, and in front of everything.
///
/// `explorer /select,<path>` is the one platform here that can do the selecting half,
/// which is what `reveal` in the capability table means.
///
/// The shell cannot do the second half on its own, and the reason is structural: the window
/// belongs to the Explorer process that is already running, that process holds neither the
/// foreground nor the last input event, so Windows refuses its activation and a new window
/// arrives behind with a taskbar flash. Two things put it in front instead.
/// `AllowSetForegroundWindow` passes the right this app holds, having just been clicked in,
/// to that process, so Explorer's own activation call succeeds; `raise_folder_window` waits
/// for the window and raises it from here as the backstop, which is what covers a folder
/// Explorer reuses rather than opens anew. Both are best effort: an install is not a failed
/// install because a window stayed behind.
pub fn reveal(path: &Path) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

    let folder = path.parent().map(|parent| parent.to_path_buf());
    // SAFETY: the call takes no pointers, and `ASFW_ANY` names the permission rather than a
    // process, so there is nothing to outlive it.
    unsafe {
        let _ = AllowSetForegroundWindow(ASFW_ANY);
    }
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Some(folder) = folder {
        // Behind the answer rather than in front of it: the install has already succeeded,
        // and a window that takes a moment to appear is not worth a delayed report of it.
        std::thread::spawn(move || raise_folder_window(&folder));
    }
    Ok(())
}

/// How long the raise waits for a window to exist at all.
///
/// The shell answers in milliseconds on a healthy machine, so this is a ceiling rather than
/// an expectation, and it is short because the person is waiting in front of it.
const RAISE_PATIENCE: Duration = Duration::from_millis(2000);

/// The pause between looks, which is a clock tick's worth of patience and no more.
const RAISE_INTERVAL: Duration = Duration::from_millis(60);

/// How long a reused window waits behind a window that did not exist before.
///
/// A new window is unambiguous, because it was not there when the shell was asked. A reused
/// one is only recognised by the name Explorer puts on it, so it is accepted once a new
/// window has had its chance, and never in preference to one.
const REUSE_GRACE: Duration = Duration::from_millis(400);

/// The Explorer window showing a folder, held in front of everything else.
///
/// Two shapes are asked for in turn. A window the reveal just created is the one that was not
/// there before it was asked for, and once `REUSE_GRACE` has passed, a window whose title is
/// the folder's own name, which is how Explorer labels a folder it already had open and merely
/// selected the file in.
///
/// Gives up quietly after `RAISE_PATIENCE`. By then the system has been asked twice, once
/// through the grant and once through `SetForegroundWindow`, and somebody who moved on to
/// another program in the meantime told Windows what they wanted instead.
fn raise_folder_window(folder: &Path) {
    let started = Instant::now();
    let before = folder_windows();
    loop {
        let now = folder_windows();
        let opening = now.iter().find(|window| !before.contains(window));
        let reused = (started.elapsed() >= REUSE_GRACE)
            .then(|| now.iter().find(|window| names_folder(**window, folder)))
            .flatten();
        if let Some(window) = opening.or(reused) {
            raise(*window);
            return;
        }
        if started.elapsed() >= RAISE_PATIENCE {
            return;
        }
        std::thread::sleep(RAISE_INTERVAL);
    }
}

/// Ask Windows for the foreground for one window, once.
///
/// `SW_RESTORE` is used only for a minimised window, because it also returns a maximised one
/// to its former size, and a window resized by an install that finished quietly is a worse
/// surprise than a window that stayed where it was.
///
/// The request can still be refused, because it is made from a thread that holds neither the
/// foreground nor the last input event by the time the window exists. Attaching to the
/// foreground thread's input queue for the length of one call is the documented way to become
/// part of the process that does hold it, and it is detached again immediately so this thread
/// shares nothing with anything afterwards.
fn raise(window: HWND) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    // SAFETY: `window` is a live top-level window taken from the enumeration above, and the
    // attach is detached on every path that makes it.
    unsafe {
        if GetForegroundWindow() == window {
            return;
        }
        if IsIconic(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }
        if SetForegroundWindow(window).as_bool() {
            return;
        }
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
            return;
        }
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let this_thread = GetCurrentThreadId();
        if foreground_thread == 0 || foreground_thread == this_thread {
            return;
        }
        if AttachThreadInput(this_thread, foreground_thread, true).as_bool() {
            let _ = BringWindowToTop(window);
            let _ = SetForegroundWindow(window);
            let _ = AttachThreadInput(this_thread, foreground_thread, false);
        }
    }
}

/// Every top-level Explorer folder window, in the order the shell keeps them.
fn folder_windows() -> Vec<HWND> {
    let mut found: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes handles into `found`, which outlives the call.
    unsafe {
        let _ = EnumWindows(
            Some(collect_folder_window),
            LPARAM(&mut found as *mut Vec<HWND> as isize),
        );
    }
    found
}

/// The window callback of `folder_windows`, taking each top-level window that is a folder.
///
/// `ExploreWClass` is the pre-Windows 7 spelling of the same window, and it is listed because
/// the reveal is not the place to notice that a machine is old.
unsafe extern "system" fn collect_folder_window(window: HWND, found: LPARAM) -> BOOL {
    let class = class_name(window);
    if class == "CabinetWClass" || class == "ExploreWClass" {
        // SAFETY: `folder_windows` hands over a pointer to a vector that outlives this call.
        let found = unsafe { &mut *(found.0 as *mut Vec<HWND>) };
        found.push(window);
    }
    true.into()
}

/// A window's class name, empty where the window cannot say.
fn class_name(window: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    let mut buffer = [0u16; 64];
    // SAFETY: the buffer is a local sized for the call, which writes at most its length.
    let length = unsafe { GetClassNameW(window, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

/// A window's title, empty where the window cannot say.
fn window_title(window: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;

    let mut buffer = [0u16; 512];
    // SAFETY: the buffer is a local sized for the call, which writes at most its length.
    let length = unsafe { GetWindowTextW(window, &mut buffer) };
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

/// Whether a window is the one Explorer draws for a folder, judged by its title.
fn names_folder(window: HWND, folder: &Path) -> bool {
    is_folder_title(&window_title(window), folder)
}

/// Whether Explorer's label for a folder is the folder's own name.
///
/// Explorer titles a folder window with the folder's name and nothing else, so the comparison
/// is the whole of the test. It folds case and ignores surrounding space because the shell
/// draws the name it was given rather than the name that was typed, and a name it is showing
/// unreachable is a name it cannot match. Nothing more is read from the window, because
/// reading the folder a window is showing means asking the shell for it, which is a round trip
/// through COM to answer a question this already answers for every window a person could have
/// open on that folder.
fn is_folder_title(title: &str, folder: &Path) -> bool {
    let Some(name) = folder.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let shown = title.trim();
    !shown.is_empty() && shown.to_lowercase() == name.trim().to_lowercase()
}

/// Write a Windows shell link.
///
/// Through the shell's own `IShellLink`, rather than by hand-rolling the binary
/// format or scripting a launcher: Windows owns the format, so the result is
/// exactly what "Create shortcut" would have made and behaves like it: pinnable,
/// renameable, movable, and readable by Explorer and the taskbar.
pub(crate) fn write_shell_link(link: &Path, exe: &Path) -> Result<(), String> {
    use windows::core::{HSTRING, Interface};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let exe_text = exe.to_string_lossy().into_owned();
    let working_dir = exe
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned())
        .unwrap_or_default();

    // SAFETY: COM is initialized on this thread before the objects are created,
    // and every HSTRING outlives the call that reads it.
    unsafe {
        // Anything other than success means COM could not be started here. The
        // usual case is RPC_E_CHANGED_MODE, this thread already owning a
        // different apartment model, which is fine: every apartment can build
        // a shell link, and that state is the caller's to unwind, not ours.
        let owned_apartment = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let written = (|| -> Result<(), String> {
            let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| error.to_string())?;
            shell_link
                .SetPath(&HSTRING::from(exe_text.as_str()))
                .map_err(|error| error.to_string())?;
            shell_link
                .SetWorkingDirectory(&HSTRING::from(working_dir.as_str()))
                .map_err(|error| error.to_string())?;
            shell_link
                .SetDescription(&HSTRING::from("Lithic, local-first wiki launcher"))
                .map_err(|error| error.to_string())?;
            // Index 0 of the exe's own icon, so the entry is recognisably Lithic
            // in the Start Menu and on the taskbar once pinned.
            shell_link
                .SetIconLocation(&HSTRING::from(exe_text.as_str()), 0)
                .map_err(|error| error.to_string())?;
            let file: IPersistFile = shell_link.cast().map_err(|error| error.to_string())?;
            // Save writes or overwrites; a stale link would keep pointing at a
            // previous install location after the app is moved.
            file.Save(&HSTRING::from(link.to_string_lossy().as_ref()), true)
                .map_err(|error| error.to_string())
        })();
        if owned_apartment {
            CoUninitialize();
        }
        written
    }
}

/// The user's Start Menu entry for the installed copy.
///
/// `Documents\Lithic` is on nobody's Start Menu, so without this the app can only
/// be launched by finding the exe. This is what makes it appear under Apps > All
/// so it can be pinned to the taskbar like any other program.
pub fn install_launch_entry(exe: &Path) -> Result<Option<PathBuf>, String> {
    let programs = dirs::data_dir()
        .map(|roaming| roaming.join("Microsoft").join("Windows").join("Start Menu").join("Programs"))
        .ok_or_else(|| "Could not resolve the Start Menu folder".to_string())?;
    std::fs::create_dir_all(&programs).map_err(|error| error.to_string())?;
    let link = programs.join("Lithic.lnk");
    write_shell_link(&link, exe)?;
    Ok(Some(link))
}

/// Per-user (HKCU) Open With registration: a ProgID per extension whose
/// open command targets the installed exe, plus an entry appended to the
/// extension's OpenWithProgids list. Every type is offered rather than claimed, with one
/// exception: `.lith` is the format this app defines, so it is named as the type's own where
/// nobody has claimed it already.
///
/// One thing is borrowed rather than declared: the icon. A ProgID with no `DefaultIcon`
/// makes Explorer draw the handler executable's own mark, so every type Lithic opened wore
/// the same L and a folder of mixed files stopped reading at a glance. The mark Windows
/// already draws for the type is copied onto our ProgID instead (see `borrowed_mark`), which
/// is the whole of it: the association does not move, and a photograph, a PDF or a page keeps
/// the shape it had before Lithic was anywhere near it.
pub fn register_file_associations(program: &Path) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let exe_path = program.to_string_lossy();
    let exe_path = exe_path.as_ref();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu
        .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
        .map_err(|error| error.to_string())?;

    for association in associations::all() {
        let ext = association.ext.as_str();
        let description = association.label.as_str();
        let progid = format!("Lithic.{}", ext);
        let (key, _) = classes
            .create_subkey(&progid)
            .map_err(|error| error.to_string())?;
        key.set_value("", &format!("{} Document", description))
            .map_err(|error| error.to_string())?;
        let (cmd, _) = key
            .create_subkey(r"shell\open\command")
            .map_err(|error| error.to_string())?;
        cmd.set_value("", &format!("\"{}\" \"%1\"", exe_path))
            .map_err(|error| error.to_string())?;

        // The mark this type wears when Lithic is what opens it. The three types this app is
        // *about* state the app's icon outright, because the fallback for a ProgID with no icon
        // is also the picture an extension nobody handles draws, and the two must not look
        // alike. Every other type borrows the mark Windows already draws for it, so a
        // photograph, a PDF or a page keeps the shape it had before Lithic was near it, copied
        // as bytes rather than repeated as a reference (see `saved_icon`). A type with nothing
        // to borrow keeps whatever it already has, because a reinstall on a machine where
        // Lithic is already the default finds only Lithic's own ProgID and must not erase the
        // mark the first install copied.
        let mark = if association.own_icon {
            Some(format!("\"{}\",0", exe_path))
        } else {
            borrowed_mark(ext)
        };
        if let Some(mark) = mark {
            let (icon_key, _) = key
                .create_subkey("DefaultIcon")
                .map_err(|error| error.to_string())?;
            icon_key
                .set_value("", &mark)
                .map_err(|error| error.to_string())?;
        }

        // Append Lithic to the extension's Open With list via the
        // OpenWithProgids subkey, where each *value name* is a ProgID.
        // Existing entries are preserved; this list says what can open the
        // type, not what does.
        let (ext_key, _) = classes
            .create_subkey(format!(".{}", ext))
            .map_err(|error| error.to_string())?;
        let (open_with, _) = ext_key
            .create_subkey("OpenWithProgids")
            .map_err(|error| error.to_string())?;
        open_with
            .set_value(&progid, &String::new())
            .map_err(|error| error.to_string())?;
    }

    // Generic application registration so "Open with" -> "Choose another
    // app" lists Lithic for every supported type. Keyed by the installed
    // binary's file name so it matches wherever the copy lands.
    let installed_name = PathBuf::from(exe_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "lithic.exe".to_string());
    let (app, _) = classes
        .create_subkey(format!(r"Applications\{}", installed_name))
        .map_err(|error| error.to_string())?;
    app.set_value("FriendlyAppName", &"Lithic".to_string())
        .map_err(|error| error.to_string())?;
    let (cmd, _) = app
        .create_subkey(r"shell\open\command")
        .map_err(|error| error.to_string())?;
    cmd.set_value("", &format!("\"{}\" \"%1\"", exe_path))
        .map_err(|error| error.to_string())?;
    // SupportedTypes is likewise a subkey whose value names are the
    // extensions this application can open.
    let (supported, _) = app
        .create_subkey("SupportedTypes")
        .map_err(|error| error.to_string())?;
    for association in associations::all() {
        supported
            .set_value(format!(".{}", association.ext), &String::new())
            .map_err(|error| error.to_string())?;
    }

    // `.lith` is the extension this app defines, so it is claimed rather than merely offered.
    // Left unclaimed, Windows files it under the `lith_auto_file` stub it invents for a type
    // nobody owns, and that stub has no icon to draw, so the format's own mark never appears.
    // Claiming is what makes Explorer call the file a Lithic Wiki and read the mark written
    // above. Only claimed where the type is not already somebody else's choice, so a person
    // who deliberately pointed `.lith` at another program keeps it.
    let lith_is_free = current_handler("lith")
        .as_deref()
        .is_none_or(|progid| progid.starts_with("Lithic."));
    if lith_is_free {
        let (extension, _) = classes
            .create_subkey(".lith")
            .map_err(|error| error.to_string())?;
        extension
            .set_value("", &"Lithic.lith".to_string())
            .map_err(|error| error.to_string())?;
    }

    // Explorer caches each type's icon, so a borrowed mark does not appear until the cache
    // is flushed. Announcing the change is the documented way to ask, and saves the person
    // from restarting Explorer to see what the install did.
    // SAFETY: the call takes no pointers here; both items are null because the event is
    // about the association set rather than about one file.
    unsafe {
        windows::Win32::UI::Shell::SHChangeNotify(
            windows::Win32::UI::Shell::SHCNE_ASSOCCHANGED,
            windows::Win32::UI::Shell::SHCNF_IDLIST,
            None,
            None,
        );
    }

    Ok(())
}

/// The icon another program already draws for an extension, ready to be repeated on ours.
///
/// Two answers are worth having, in this order. The handler that currently opens the type is
/// the mark the person recognises today, and while that handler is a Windows program the icon
/// is effectively the system's own art. Failing that, the extension's own registered ProgID is
/// what Windows considers the type to *be* before anybody has chosen an app for it, which is
/// where the plain `imageres.dll` pictures for `.png` and `.jpg` come from.
///
/// A plain reference always beats an indirect one. An indirect `@{Package?ms-resource://...}`
/// names the Store package's *version*, so it stops resolving the day that app updates, and it
/// is worth using only where nothing better exists.
/// Every icon worth trying for an extension, best first: the handler's, then the extension's
/// own, with a plain reference ahead of an indirect one.
fn borrowed_icons(ext: &str) -> Vec<String> {
    if associations::own_icon(ext) {
        return Vec::new();
    }
    let mut icons = Vec::new();
    if let Some(progid) = current_handler(ext).filter(|progid| borrowable_progid(progid)) {
        icons.extend(icon_of(&progid));
    }
    if let Some(progid) = stock_handler(ext).filter(|progid| borrowable_progid(progid)) {
        icons.extend(icon_of(&progid));
    }
    // `false` sorts before `true`, and the sort is stable, so the handler's mark still wins
    // among those of the same shape.
    icons.sort_by_key(|icon| icon_kind(icon) != Some(IconKind::Plain));
    icons
}

/// The ProgID that opens an extension today, as the shell records the person's own choice.
///
/// `UserChoice` is signed, so it is read and never written here; it is only ever a source of
/// an icon string for our own key.
fn current_handler(ext: &str) -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let path = format!(
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{}\UserChoice",
        ext
    );
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(path)
        .ok()?
        .get_value::<String, _>("ProgId")
        .ok()
}

/// The ProgID an extension is registered as, independent of who currently opens it.
fn stock_handler(ext: &str) -> Option<String> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(format!(".{}", ext))
        .ok()?
        .get_value::<String, _>("")
        .ok()
}

/// A ProgID's icon reference, if it has one and if it is a reference worth repeating.
fn icon_of(progid: &str) -> Option<String> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    let raw = RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(format!(r"{}\DefaultIcon", progid))
        .ok()?
        .get_value::<String, _>("")
        .ok()?;
    icon_kind(&raw).map(|_| raw.trim().to_string())
}

/// Whether a ProgID is one whose icon is worth copying.
///
/// Ours is not: copying it would write Lithic's mark back onto Lithic. `*_auto_file` is the
/// stub Windows invents for an extension nobody has registered, and it has no icon of its own
/// to give.
fn borrowable_progid(progid: &str) -> bool {
    let progid = progid.trim();
    !progid.is_empty() && !progid.starts_with("Lithic.") && !progid.ends_with("_auto_file")
}

/// The two shapes a `DefaultIcon` value can take, as far as copying one is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IconKind {
    /// A file and an index into it: `C:\Windows\System32\imageres.dll,-83`.
    Plain,
    /// A resource inside a Store package, named with the package's version.
    Indirect,
}

/// Whether a `DefaultIcon` value is a reference this app can repeat, and in which shape.
///
/// `"%1",n` is refused: it asks Explorer to draw the file being drawn, so copying it onto a
/// different ProgID would point at the wrong thing entirely.
fn icon_kind(raw: &str) -> Option<IconKind> {
    let icon = raw.trim();
    if icon.is_empty() || icon.contains("%1") {
        return None;
    }
    Some(if icon.starts_with('@') {
        IconKind::Indirect
    } else {
        IconKind::Plain
    })
}

/// The mark to write onto our ProgID for a type that is not this app's own.
///
/// The art is Windows' own, taken as **bytes** wherever it can be. See `saved_icon` for why a
/// repeated string is the fallback rather than the shape this is built around.
fn borrowed_mark(ext: &str) -> Option<String> {
    let icons = borrowed_icons(ext);
    for source in &icons {
        if let Some(icon) = saved_icon(ext, source) {
            return Some(format!("\"{}\",0", icon.display()));
        }
    }
    if let Some(icon) = family_art(ext) {
        return Some(format!("\"{}\",0", icon.display()));
    }
    // Nothing could be copied: repeat the best reference and accept that it is only as durable
    // as the program that wrote it.
    icons.into_iter().next()
}

/// The picture a format borrows when its own cannot be copied at all.
///
/// A `.bmp` and a `.webp` are two of the four formats this app opens on a board. On a machine
/// where Photos owns them their art lives inside that app's package as a `@{...}` reference that
/// names the package's version, with no file path behind it to read — so the sibling that did
/// copy, `.png`, which resolves to `imageres.dll`, lends them its picture. They are the same
/// kind of file as far as this app is concerned, and a Windows picture that keeps drawing beats
/// a store reference that dies with the next Photos update.
fn family_art(ext: &str) -> Option<PathBuf> {
    const IMAGES: &[&str] = &["png", "jpg", "jpeg", "bmp", "webp"];
    if !IMAGES.contains(&ext) {
        return None;
    }
    let donor = IMAGES
        .iter()
        .find(|donor| **donor != ext && borrowed_icons(donor).iter().any(|icon| icon_kind(icon) == Some(IconKind::Plain)))?;
    let source = borrowed_icons(donor).into_iter().next()?;
    saved_icon(donor, &source)
}

/// The borrowed mark, copied into a file this app owns.
///
/// A borrowed reference usually names a *build-numbered* folder: a PDF on a machine where Edge
/// opens it resolves to `...\Microsoft\Edge\Application\156.0.4314.42\msedge.exe,11`. Repeating
/// that string writes a mark that dies the next time Edge updates, and the type then falls back
/// to the generic page — worse than the Lithic mark it replaced, because it describes nothing.
/// Bytes copied once keep drawing, which is the point of borrowing Windows' own art at all: it
/// is a copy of what the person already recognises, not a standing dependency on somebody
/// else's installer.
///
/// Written once and left alone after that, so a vendor's later redesign is not inherited behind
/// the person's back — the mark is what the machine drew when Lithic arrived.
///
/// `None` where the source cannot be read as bytes, which is a Store package's
/// `@{Package?ms-resource://...}` resource: it names no file to open, so the caller repeats the
/// string instead and accepts its fragility.
fn saved_icon(ext: &str, source: &str) -> Option<PathBuf> {
    let (file, index) = parse_icon_source(source)?;
    let dir = icons_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{}.ico", ext));
    if !path.is_file() {
        std::fs::write(&path, extract_icon(&file, index)?).ok()?;
    }
    Some(path)
}

/// Where the copied marks live.
///
/// Not beside the program, because that is also the folder a person keeps their liths in: a
/// couple of hundred kilobytes of borrowed pictures have no business in a wiki's history, let
/// alone in every clone of it. The per-machine application folder the rest of this app already
/// treats as its own is the place for what belongs to this install.
fn icons_dir() -> Option<PathBuf> {
    dirs::data_local_dir()
        .map(|local| local.join("Lithic").join("assoc-icons"))
        .or_else(|| super::state_dir().map(|dir| dir.join("assoc-icons")))
}

/// A `DefaultIcon` reference split into the file it names and the index into that file.
fn parse_icon_source(source: &str) -> Option<(PathBuf, i32)> {
    let trimmed = source.trim();
    if trimmed.starts_with('@') {
        return None;
    }
    let (file, index) = trimmed.rsplit_once(',')?;
    let index = index.trim().parse::<i32>().ok()?;
    let path = PathBuf::from(expand_environment(file.trim().trim_matches('"')));
    // A relative name is one the shell resolves against its own working folder, so repeating it
    // in our key would point somewhere else entirely.
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    Some((path, index))
}

/// `%SystemRoot%\System32\imageres.dll` as a path this process can open.
///
/// The registry writes some of Windows' own marks this way, and the reference is worth taking
/// as bytes like any other: the variable is stable, but the index it points at is not promised
/// to keep meaning the same picture across Windows builds.
fn expand_environment(file: &str) -> String {
    let mut expanded = String::new();
    let mut rest = file;
    while let Some(open) = rest.find('%') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('%') else {
            break;
        };
        match std::env::var(&after[..close]) {
            Ok(value) => {
                expanded.push_str(&rest[..open]);
                expanded.push_str(&value);
                rest = &after[close + 1..];
            }
            // A variable this machine does not have, or a literal pair of percent signs: the
            // text is left exactly as it was written, so an unexpandable reference fails the
            // path check rather than turning into somewhere else.
            Err(_) => {
                expanded.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    expanded.push_str(rest);
    expanded
}

/// The sizes copied out of a borrowed icon.
///
/// The four Explorer draws: a Details row, a medium tile, the large tile Windows 11 uses, and
/// the extra-large one. A size the artwork does not have is scaled by the shell's own extractor
/// rather than refused, so a type is never left without a mark.
const ICON_SIZES: &[u32] = &[16, 32, 48, 256];

/// An icon file made of every size worth having, taken from one index of one file.
fn extract_icon(file: &Path, index: i32) -> Option<Vec<u8>> {
    let mut images = Vec::new();
    for size in ICON_SIZES {
        if let Some((colors, mask)) = extract_size(file, index, *size) {
            images.push((*size, ico_image(*size, &colors, &mask)));
        }
    }
    if images.is_empty() {
        return None;
    }
    Some(ico_container(&images))
}

/// One size of one icon, as the colour pixels and the 1-bit shape mask behind them.
fn extract_size(file: &Path, index: i32, size: u32) -> Option<(Vec<u8>, Vec<u8>)> {
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, PrivateExtractIconsW, HICON,
    };

    // The binding takes a fixed `MAX_PATH` buffer rather than a pointer, so the name is copied
    // into one with the terminator the call expects.
    let mut name = [0u16; 260];
    let written: Vec<u16> = file
        .to_string_lossy()
        .encode_utf16()
        .take(name.len() - 1)
        .collect();
    name[..written.len()].copy_from_slice(&written);

    let edge = size as i32;
    let mut icon = HICON::default();
    // SAFETY: the name outlives the call, and the one out-slice is a local the function writes
    // only when it reports having found an icon.
    let found = unsafe {
        PrivateExtractIconsW(
            &name,
            index,
            edge,
            edge,
            Some(std::slice::from_mut(&mut icon)),
            None,
            1,
        )
    };
    if found == 0 || icon.is_invalid() {
        return None;
    }
    let pixels = icon_pixels(icon, size);
    // SAFETY: the handle came from the extractor above and is not used again.
    unsafe {
        let _ = DestroyIcon(icon);
    }
    pixels
}

/// The colour pixels and shape mask of a live icon, laid out for an icon file.
///
/// A 32-bit DIB from an icon that predates the alpha channel is entirely transparent, and a
/// fully transparent mark is not what anybody wants on a photograph. The mask is where those
/// icons keep their shape, so it is what the alpha is rebuilt from when every pixel says zero —
/// the same rule the shell itself applies.
fn icon_pixels(icon: HICON, size: u32) -> Option<(Vec<u8>, Vec<u8>)> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut info = ICONINFO::default();
    // SAFETY: `icon` is live for the whole of this function, and `info` is a local.
    unsafe { GetIconInfo(icon, &mut info) }.ok()?;

    let edge = size as usize;
    let colour_stride = edge * 4;
    // One bit per pixel, rounded up to whole four-byte rows, which is how the format pads a
    // mask.
    let mask_stride = edge.div_ceil(32) * 4;
    let mut colors = vec![0u8; colour_stride * edge];
    let mut mask = vec![0u8; mask_stride * edge];

    let mut header = BITMAPINFO::default();
    header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    header.bmiHeader.biWidth = size as i32;
    header.bmiHeader.biHeight = size as i32;
    header.bmiHeader.biPlanes = 1;
    header.bmiHeader.biBitCount = 32;
    header.bmiHeader.biCompression = BI_RGB.0;

    // SAFETY: both bitmaps belong to the icon, the device context is a throwaway, and every
    // buffer handed over is sized for the strides the header asks for. The bitmaps are deleted
    // here because `GetIconInfo` hands over copies rather than references to the icon's own.
    let (painted, shaped) = unsafe {
        let context = CreateCompatibleDC(None);
        let painted = GetDIBits(
            context,
            info.hbmColor,
            0,
            size,
            Some(colors.as_mut_ptr() as *mut _),
            &mut header,
            DIB_RGB_COLORS,
        );
        let shaped = if info.hbmMask.is_invalid() {
            0
        } else {
            header.bmiHeader.biBitCount = 1;
            header.bmiHeader.biHeight = size as i32;
            GetDIBits(
                context,
                info.hbmMask,
                0,
                size,
                Some(mask.as_mut_ptr() as *mut _),
                &mut header,
                DIB_RGB_COLORS,
            )
        };
        let _ = DeleteDC(context);
        let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
        (painted, shaped)
    };
    if painted == 0 {
        return None;
    }
    if shaped > 0 && colors.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        for y in 0..edge {
            for x in 0..edge {
                let set = mask[y * mask_stride + x / 8] & (0x80 >> (x % 8)) != 0;
                colors[y * colour_stride + x * 4 + 3] = if set { 0 } else { 255 };
            }
        }
    }
    mask.truncate(mask_stride * edge);
    Some((colors, mask))
}

/// One image of an icon file: a `BITMAPINFOHEADER` whose height covers the colours and the mask
/// that follows them, both bottom-up as the format requires.
fn ico_image(size: u32, colors: &[u8], mask: &[u8]) -> Vec<u8> {
    let mut image = Vec::with_capacity(40 + colors.len() + mask.len());
    image.extend_from_slice(&40u32.to_le_bytes());
    image.extend_from_slice(&(size as i32).to_le_bytes());
    image.extend_from_slice(&((size as i32) * 2).to_le_bytes());
    image.extend_from_slice(&1u16.to_le_bytes());
    image.extend_from_slice(&32u16.to_le_bytes());
    image.extend_from_slice(&0u32.to_le_bytes());
    image.extend_from_slice(&((colors.len() + mask.len()) as u32).to_le_bytes());
    image.extend_from_slice(&[0u8; 16]);
    image.extend_from_slice(colors);
    image.extend_from_slice(mask);
    image
}

/// The icon file itself: a directory of images, then the images.
fn ico_container(images: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());
    // Each directory entry is sixteen bytes and the images start after the last of them, so the
    // offsets are known before the images are laid out.
    let mut offset = 6 + images.len() * 16;
    for (size, image) in images {
        // 256 is written as zero, which is the format's way of saying a byte cannot hold it.
        let edge = if *size >= 256 { 0 } else { *size as u8 };
        out.push(edge);
        out.push(edge);
        out.push(0);
        out.push(0);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(image.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += image.len();
    }
    for (_, image) in images {
        out.extend_from_slice(image);
    }
    out
}

/// A copied `.exe` needs no permission bits, so there is nothing to do here.
pub fn make_launchable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every program folder is searched for Chrome before any is searched for Edge, so a machine
    /// with both opens the browser a person installed over the one Windows shipped.
    #[test]
    fn chrome_is_tried_before_edge_in_every_program_folder() {
        let roots = vec![
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Users\u\AppData\Local"),
        ];
        let candidates = browser_candidates(&roots);
        assert_eq!(candidates.len(), 4, "two browsers in two program folders");
        assert_eq!(
            candidates[0],
            PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        );
        assert_eq!(
            candidates[1],
            PathBuf::from(r"C:\Users\u\AppData\Local\Google\Chrome\Application\chrome.exe")
        );
        assert_eq!(
            candidates[2],
            PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")
        );
        assert!(candidates[3].ends_with(r"msedge.exe"), "the executable is what gets started");
    }

    /// The three types that keep Lithic's mark do so before any registry is read, so this is a
    /// cheap assertion that the exclusion is real.
    #[test]
    fn the_formats_this_app_is_about_keep_their_own_mark() {
        for ext in ["lith", "tid", "json"] {
            assert!(borrowed_icons(ext).is_empty(), ".{} must keep the Lithic icon", ext);
        }
    }

    /// The mark the app keeps is asked of the shared table, so a type cannot be excluded from
    /// borrowing without being registered: the two used to be a table and a separate list here,
    /// and a format could be added to one of them and forgotten in the other.
    #[test]
    fn the_mark_is_decided_by_the_registration_itself() {
        for association in associations::all() {
            assert_eq!(
                associations::own_icon(&association.ext),
                association.own_icon,
                ".{} disagrees with the table about its mark",
                association.ext
            );
            assert!(
                association.ext.is_empty() || !association.mime.is_empty(),
                ".{} is registered without a type",
                association.ext
            );
        }
    }

    /// A photograph's own icon is a file and an index, which keeps meaning the same thing on
    /// every Windows build. A Store package's is a versioned resource, which does not.
    #[test]
    fn a_plain_reference_is_recognised_apart_from_a_packaged_one() {
        assert_eq!(
            icon_kind(r"C:\Windows\System32\imageres.dll,-83"),
            Some(IconKind::Plain)
        );
        assert_eq!(
            icon_kind(r#""C:\Program Files\Y\resources.dll",-101"#),
            Some(IconKind::Plain)
        );
        assert_eq!(
            icon_kind("@{Microsoft.Windows.Photos_2026?ms-resource://Photos/Assets/icon.png}"),
            Some(IconKind::Indirect)
        );
        assert_eq!(icon_kind(r#""%1",1"#), None, "that draws the file, not an icon");
        assert_eq!(icon_kind("   "), None);
    }

    /// Ours would write Lithic's mark back onto Lithic, and Windows' stub for an unregistered
    /// extension has nothing to give.
    #[test]
    fn only_another_programs_progid_is_borrowed() {
        assert!(borrowable_progid("pngfile"));
        assert!(borrowable_progid("MSEdgeHTM"));
        assert!(!borrowable_progid("Lithic.png"));
        assert!(!borrowable_progid("lith_auto_file"));
        assert!(!borrowable_progid("  "));
    }

    /// A reference is a file and an index, in any of the shapes the registry writes them: with
    /// quotes, without, and with a resource id where the index would be.
    #[test]
    fn a_reference_is_split_into_the_file_and_its_index() {
        let exe = std::env::current_exe().expect("the test binary exists");
        let shown = exe.display();
        assert_eq!(
            parse_icon_source(&format!("\"{}\",-83", shown)),
            Some((exe.clone(), -83))
        );
        assert_eq!(
            parse_icon_source(&format!("{},11", shown)),
            Some((exe.clone(), 11))
        );
    }

    /// A reference written with a variable is resolved before it is read, and one naming a
    /// variable this machine does not have is left exactly as it was written.
    #[test]
    fn a_reference_naming_a_folder_is_resolved_before_it_is_read() {
        let root = std::env::var("SystemRoot").expect("every Windows has one");
        assert_eq!(
            expand_environment(r"%SystemRoot%\System32\imageres.dll"),
            format!(r"{}\System32\imageres.dll", root)
        );
        assert_eq!(
            expand_environment(r"C:\Windows\no-variables.dll"),
            r"C:\Windows\no-variables.dll"
        );
        assert_eq!(
            expand_environment(r"%NOT_A_REAL_VARIABLE_1234%\x.dll"),
            r"%NOT_A_REAL_VARIABLE_1234%\x.dll"
        );
        assert_eq!(expand_environment("100%% sure"), "100%% sure");
    }

    /// Three shapes cannot be copied as bytes: a Store package's resource, a reference to the
    /// file being drawn, and one the shell would resolve against its own folder.
    #[test]
    fn a_reference_with_no_file_behind_it_is_refused() {
        assert_eq!(parse_icon_source("@{Photos?ms-resource://Photos/Assets/icon.png}"), None);
        assert_eq!(parse_icon_source("\"%1\",1"), None, "that draws the file, not an icon");
        assert_eq!(parse_icon_source("imageres.dll,-83"), None, "a bare name is not a path");
        assert_eq!(
            parse_icon_source(r"C:\nope\missing.dll,0"),
            None,
            "a file that is not there cannot be read"
        );
    }

    /// An icon file is a directory followed by its images, and every offset has to land on the
    /// image it belongs to.
    #[test]
    fn an_icon_keeps_its_directory_in_step_with_its_images() {
        let first = vec![0u8; 8];
        let second = vec![1u8; 12];
        let file = ico_container(&[(16, first), (256, second)]);
        assert_eq!(&file[0..6], &[0, 0, 1, 0, 2, 0], "one icon holding two images");
        assert_eq!(file[6], 16, "the first image is 16 across");
        assert_eq!(file[6 + 16], 0, "256 is written as zero, which the format defines");
        let offset = |entry: usize| {
            let at = 6 + entry * 16 + 12;
            u32::from_le_bytes([file[at], file[at + 1], file[at + 2], file[at + 3]]) as usize
        };
        assert_eq!(offset(0), 6 + 2 * 16, "the first image starts after the directory");
        assert_eq!(offset(1), 6 + 2 * 16 + 8, "the second follows the first");
        assert_eq!(file.len(), 6 + 2 * 16 + 20);
    }

    /// An image is described by a header whose height counts the mask as a second copy of the
    /// rows, which is what makes the colours and the mask one image rather than two.
    #[test]
    fn an_icon_image_describes_itself_and_its_mask() {
        let colors = vec![7u8; 48 * 48 * 4];
        let mask = vec![0u8; 48 * 6];
        let image = ico_image(48, &colors, &mask);
        assert_eq!(u32::from_le_bytes(image[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(image[4..8].try_into().unwrap()), 48);
        assert_eq!(i32::from_le_bytes(image[8..12].try_into().unwrap()), 96);
        assert_eq!(u16::from_le_bytes(image[14..16].try_into().unwrap()), 32);
        assert_eq!(
            u32::from_le_bytes(image[20..24].try_into().unwrap()) as usize,
            colors.len() + mask.len()
        );
        assert_eq!(image.len(), 40 + colors.len() + mask.len());
        let painted = 40 + colors.len();
        assert_eq!(&image[40..painted], &colors[..], "the colours come first");
        assert_eq!(&image[painted..], &mask[..], "and the shape mask follows them");
    }

    /// The title Explorer puts on a folder window is the folder's last name, in whatever case
    /// the folder itself was created with, so the comparison folds case and trims.
    #[test]
    fn a_folder_window_is_recognised_by_the_name_explorer_shows() {
        let folder = Path::new(r"C:\Users\u\Documents\Lithic");
        assert!(is_folder_title("Lithic", folder));
        assert!(is_folder_title("  lithic ", folder));
        assert!(
            !is_folder_title("Lithic-old", folder),
            "a folder whose name merely starts the same is a different folder"
        );
        assert!(!is_folder_title("", folder), "a window with no title names nothing");
        assert!(
            !is_folder_title("Lithic", Path::new(r"C:\")),
            "a drive has no last name to match"
        );
    }
}
