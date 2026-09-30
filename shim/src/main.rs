//! Start the Lithic shim: find the payload, serve it on loopback, open a browser.
//!
//! The server stays in the foreground on purpose. It is what the open page is
//! loaded from, so leaving it in a terminal (or behind a desktop launcher that
//! owns the process) is what makes "close the window to stop" the way to stop it.

use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lithic_shim::{
    bind, default_payload_root, open_in_browser, payload_problems, payload_warnings, probe_existing_shim,
    serve, url_for, APPDIR_ENV, DEFAULT_PORT, PORT_ENV, REQUIRED_PAYLOAD, ROOT_ENV,
};

const USAGE: &str = "\
USAGE: lithic-shim [options]

  --port N     serve on this loopback port (default: 5484, or LITHIC_SHIM_PORT)
  --root DIR   serve this payload directory instead of the one found beside the binary
  --check      find the payload, report it and exit without serving
  --no-open    do not hand the address to the browser
  --version    print the version
  --help       print this text

The address is fixed rather than random because browser storage is scoped to it,
so the same port has to be reachable again for the saved Liths to be there.";

struct Options {
    port: u16,
    root: Option<PathBuf>,
    open: bool,
    check: bool,
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

    let listener = match bind(options.port) {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            // Either this machine already has a shim, in which case a second copy
            // would only be a second storage origin, or something else owns the
            // port, in which case the port is the person's to change.
            if probe_existing_shim(options.port) {
                let url = url_for(options.port);
                println!("Lithic is already serving {url}");
                if options.open && !open_in_browser(&url) {
                    println!("Open {url} in your browser.");
                }
                return ExitCode::SUCCESS;
            }
            eprintln!("Port {} is held by another program.", options.port);
            eprintln!("Start the shim with a free port, for example: --port 5485");
            eprintln!("Keep in mind that a different port is a different browser storage.");
            return ExitCode::FAILURE;
        }
        Err(error) => {
            eprintln!("Lithic shim: cannot listen on 127.0.0.1:{}: {error}", options.port);
            return ExitCode::FAILURE;
        }
    };

    let url = url_for(options.port);
    println!("Lithic shim {}", env!("CARGO_PKG_VERSION"));
    println!("Serving {}", root.display());
    println!("{url}");
    println!("The launcher opens in your browser. Saves stay in that browser's storage, under this address.");
    println!("Press Ctrl+C here to stop serving.");
    for missing in payload_warnings(&root) {
        println!("Optional file not in the payload: {missing}");
    }

    if options.open && !open_in_browser(&url) {
        println!("No browser command answered, so open {url} yourself.");
    }

    match serve(listener, root, options.port) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Lithic shim stopped: {error}");
            ExitCode::FAILURE
        }
    }
}

/// `Ok(None)` means the arguments were answered by printing something instead.
fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Option<Options>, String> {
    let mut options = Options {
        port: env::var(PORT_ENV).ok().and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_PORT),
        root: None,
        open: true,
        check: false,
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
            "--version" => {
                println!("lithic-shim {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(None);
            }
            other => return Err(format!("unrecognised argument: {other}")),
        }
    }
    Ok(Some(options))
}
