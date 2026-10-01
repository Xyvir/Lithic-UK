//! Start the Lithic shim: find the payload, serve it on loopback, open a browser.
//!
//! The server stays in the foreground on purpose. It is what the open page is
//! loaded from, so leaving it in a terminal (or behind a desktop launcher that
//! owns the process) is what makes "close the window to stop" the way to stop it.

use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use lithic_shim::{
    bind, default_payload_root, existing_shim, is_stale, open_in_browser, payload_problems, payload_warnings,
    request_open, serve, terminate, url_for, BrowserLaunch, ServerIdentity, APPDIR_ENV, DEFAULT_PORT, PORT_ENV,
    REQUIRED_PAYLOAD, ROOT_ENV,
};

const USAGE: &str = "\
USAGE: lithic-shim [options]

  lithic-shim [options] [FILE.lith]

  --port N     serve on this loopback port (default: 5484, or LITHIC_SHIM_PORT)
  --root DIR   serve this payload directory instead of the one found beside the binary
  --check      find the payload, report it and exit without serving
  --no-open    do not hand the address to the browser
  --attach     join a shim already on the port instead of replacing an older one
  --version    print the version
  --help       print this text

A FILE named on the command line is offered to the launcher, which opens it once it
boots. That is what a file manager passes for an Open With association, so opening a
Lith is one double click like any other document. When a shim of this build is already
serving, the file is handed to it instead, so the launcher already open is the one that
shows it.

When the port is held by a shim of ours that is an older build, or that is serving a
different payload, this launch ends it and takes the port, so the page that opens is
always the one this binary serves. A shim already serving this same build and payload
is opened as it is. --attach always joins instead of replacing.

A Chromium-family browser is opened as an app window, with a profile of its own
under $XDG_DATA_HOME/lithic/chrome. Any other browser gets an ordinary tab.

Environment:
  LITHIC_SHIM_BROWSER  a Chromium-family program to use instead of the detected one
  LITHIC_SHIM_PROFILE  the profile directory that app window uses

The address is fixed rather than random because browser storage is scoped to it,
so the same port has to be reachable again for the saved Liths to be there.";

struct Options {
    port: u16,
    root: Option<PathBuf>,
    open: bool,
    check: bool,
    attach: bool,
    startup: Option<PathBuf>,
}

fn main() -> ExitCode {
    let options = match parse_args(env::args().skip(1)) {
        Ok(Some(options)) => options,
        Ok(None) => return ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            eprintln!();
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    let current_exe = env::current_exe().ok();
    let exe_dir = current_exe
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."));
    let appdir = env::var_os(APPDIR_ENV).map(PathBuf::from);
    let override_root = options
        .root
        .clone()
        .or_else(|| env::var_os(ROOT_ENV).map(PathBuf::from));

    let Some(root) = default_payload_root(exe_dir, appdir.as_deref(), override_root.clone()) else {
        let looked_in = override_root.unwrap_or_else(|| exe_dir.to_path_buf());
        eprintln!("Lithic shim: no launcher payload in {}", looked_in.display());
        for missing in payload_problems(&looked_in) {
            eprintln!("  missing: {missing}");
        }
        eprintln!("A payload holds: {}", REQUIRED_PAYLOAD.join(", "));
        eprintln!("Point {ROOT_ENV} at a directory that has them, or at a Lithic checkout.");
        return ExitCode::FAILURE;
    };

    // `--check` is what the AppImage build runs against the AppDir it just
    // assembled, so the list of files the build copies and the list the shim
    // refuses to start without cannot drift: the same code makes both judgements.
    if options.check {
        println!("Payload OK at {}", root.display());
        for missing in payload_warnings(&root) {
            println!("Optional file not in the payload: {missing}");
        }
        return ExitCode::SUCCESS;
    }

    // Built before the port is claimed, because the takeover decision below compares
    // the shim already on the port against what this launch would serve.
    let identity = ServerIdentity::current(options.port, &root);

    let listener = match bind(options.port) {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            // Either this machine already has a shim, in which case a second copy
            // would only be a second storage origin, or something else owns the
            // port, in which case the port is the person's to change.
            let Some(existing) = existing_shim(options.port) else {
                eprintln!("Port {} is held by another program.", options.port);
                eprintln!("Start the shim with a free port, for example: --port 5485");
                eprintln!("Keep in mind that a different port is a different browser storage.");
                return ExitCode::FAILURE;
            };
            let url = url_for(options.port);
            let stale = is_stale(&existing, &identity);
            // A shim that will not name itself (an older build answering with a marker
            // and little else) has no pid to end, and is not this launch's to replace
            // on a comparison it cannot make. It is joined, as it always was.
            let replaceable = !options.attach && stale && existing.pid != 0;
            if replaceable && terminate(existing.pid) {
                println!("Replacing the shim already on the port ({}).", existing.describe());
                match wait_for_port(options.port, Duration::from_secs(3)) {
                    Ok(listener) => listener,
                    Err(()) => {
                        eprintln!("The shim on {url} did not let go of the port ({}).", existing.describe());
                        eprintln!("Stop it yourself, then run the shim again.");
                        return ExitCode::FAILURE;
                    }
                }
            } else {
                if options.attach || !stale {
                    println!("Lithic is already serving {url} ({}).", existing.describe());
                } else {
                    println!(
                        "Lithic is already serving {url} ({}); it is not this launch's to replace.",
                        existing.describe()
                    );
                }
                // A file named on this launch belongs to the shim that already owns the port,
                // since this process is only joining it. Leave it where that shim's launcher
                // will find it, before opening the browser so the page can answer at boot.
                if let Some(startup) = &options.startup {
                    if let Err(error) = request_open(options.port, startup) {
                        eprintln!("Could not hand {} to the running shim: {error}", startup.display());
                    }
                }
                if options.open {
                    report_launch(&url);
                }
                return ExitCode::SUCCESS;
            }
        }
        Err(error) => {
            eprintln!("Lithic shim: cannot listen on 127.0.0.1:{}: {error}", options.port);
            return ExitCode::FAILURE;
        }
    };

    let url = url_for(options.port);
    println!("Lithic shim {} (pid {})", identity.version, identity.pid);
    println!("Serving {}", root.display());
    println!("{url}");
    println!("The launcher opens in your browser. A save goes back to the file you picked, or to that browser's storage under this address.");
    println!("Press Ctrl+C here to stop serving.");
    for missing in payload_warnings(&root) {
        println!("Optional file not in the payload: {missing}");
    }

    if options.open {
        report_launch(&url);
    }

    if let Some(startup) = &options.startup {
        println!("Opens it in the launcher: {}", startup.display());
    }

    match serve(listener, root, options.startup.clone(), identity) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Lithic shim stopped: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Bind the port, waiting a moment for a replaced shim to let go of it.
///
/// `SIGTERM` is delivered and the kernel closes the listener, but not before that
/// process is scheduled to run its last instruction, so a bind immediately after the
/// signal can still see the port in use. Polling briefly is cheaper than a sleep long
/// enough to be noticeable, and it gives up rather than hanging.
fn wait_for_port(port: u16, timeout: Duration) -> Result<TcpListener, ()> {
    let deadline = Instant::now() + timeout;
    loop {
        match bind(port) {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return Err(()),
        }
    }
}

/// Say how the address was handed over, or that nothing answered it.
///
/// The two rungs are worth telling apart: an app window is the shape the shim is
/// going for, and a tab is the fallback a Firefox-only desktop takes, worth naming
/// so the difference is not mistaken for a fault.
fn report_launch(url: &str) {
    match open_in_browser(url) {
        Some(BrowserLaunch::AppWindow(program)) => {
            println!("Opened {url} in {program}, in a window of its own.");
        }
        Some(BrowserLaunch::Tab) => {
            println!("Opened {url} in a browser tab. A Chromium-family browser would open it as its own window.");
        }
        None => println!("No browser command answered, so open {url} yourself."),
    }
}

/// `Ok(None)` means the arguments were answered by printing something instead.
fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Option<Options>, String> {
    let mut options = Options {
        port: env::var(PORT_ENV).ok().and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_PORT),
        root: None,
        open: true,
        check: false,
        attach: false,
        startup: None,
    };
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--port" => {
                let value = args.next().ok_or("--port needs a number")?;
                options.port = value.parse().map_err(|_| format!("{value} is not a port number"))?;
            }
            "--root" => {
                options.root = Some(PathBuf::from(args.next().ok_or("--root needs a directory")?));
            }
            "--no-open" => options.open = false,
            "--check" => options.check = true,
            "--attach" => options.attach = true,
            "--version" => {
                println!("lithic-shim {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(None);
            }
            // Anything else is the file a file manager handed over. The first one is
            // the document to open; a second would only be a Lith nobody asked for.
            other if options.startup.is_none() && !other.starts_with('-') => {
                options.startup = Some(PathBuf::from(other));
            }
            other => return Err(format!("unrecognised argument: {other}")),
        }
    }
    Ok(Some(options))
}
