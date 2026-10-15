//! `bun jitcache`: JITCache's maintenance command line (SPEC-integrator.maintenance.md section 5),
//! `compact [<ratio>] [<path>] [--yes|--no]`, with ratio 0 when the first argument is not a number and `./.jitcache`
//! without a path. It needs no context, config or VM: `Bun__JITCache__runMaintenance` (src/jsc/bindings/JITCacheHost.cpp)
//! hands the arguments to JSC's `Maintenance::runCommandLine` with the ratio optional, and its exit code becomes Bun's.

use core::ffi::{c_char, c_int};

use bun_core::Global;

unsafe extern "C" {
    fn Bun__JITCache__runMaintenance(argc: c_int, argv: *const *const c_char) -> c_int;
}

pub(crate) struct JITCacheCommand;

impl JITCacheCommand {
    /// Runs the maintenance command line on the argv entries after the word `jitcache` and exits with its code.
    #[cold]
    pub(crate) fn exec() -> ! {
        let argv = bun_core::argv().as_slice();
        // `which()` matched the first entry after argv[0] that it does not skip, and every entry it skips begins with
        // `-`, so the first `jitcache` after argv[0] is the word it matched. argv[0] names the executable, never the
        // command.
        let command_start = argv
            .iter()
            .skip(1)
            .position(|entry| entry.as_bytes() == b"jitcache")
            .map_or(argv.len(), |index| index + 2);
        let arguments: Vec<*const c_char> = argv[command_start..]
            .iter()
            .map(|argument| argument.as_ptr())
            .collect();
        let argc = c_int::try_from(arguments.len()).expect("argv's length fits a C int");
        // SAFETY: each pointer is a NUL-terminated argv entry that lives for the process, and `arguments` holds `argc`
        // of them.
        let code = unsafe { Bun__JITCache__runMaintenance(argc, arguments.as_ptr()) };
        // The codes are 0 to 5 (maintenance sub-SPEC section 5).
        Global::exit(u32::try_from(code).unwrap_or(1));
    }
}
