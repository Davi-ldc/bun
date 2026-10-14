#pragma once

#include "root.h"

#include <stddef.h>
#include <stdint.h>

// Bun's side of JITCache (SPEC-integrator.md section 11.2): the flags, each VM's start, the exit work and `bun jitcache`.
// It calls JSC only through the exported headers <JavaScriptCore/JITCacheAPI.h>, <JavaScriptCore/JITCacheMaintenance.h>
// and <JavaScriptCore/JITCacheTwinsHost.h> (section 3.5).

namespace JSC {
class JSGlobalObject;
class VM;
} // namespace JSC

namespace Bun {

// A byte string the flags hold: characters[0..length), not NUL-terminated, null when empty. The bytes live for the
// process.
struct JITCacheFlagText {
    const char* characters;
    size_t length;
};

// JITCache's flags, which Arguments::parse reads once per process into RuntimeOptions (src/options_types/context.rs). The
// layout is C's and matches that file's JITCacheFlags field for field.
struct JITCacheFlags {
    JITCacheFlagText artifactPath; // --jitcache, resolved against the working directory; empty without it: JITCache off
    uint8_t role; // --jitcache-mode, as JSC::JITCache::Role: 1 consumer, 2 producer, 3 consumer-producer
    bool strict; // --jitcache-strict
    bool deltaAtExit; // --jitcache-delta-at-exit: the exit hook calls delta for a VM still producing
    uint8_t deltaCapture; // --jitcache-delta-capture, as JSC::JITCache::DeltaCapture: 1 all (the default), 2 compiled
    JITCacheFlagText benchReportPath; // --jitcache-bench-report
    // The four flags of harness sub-SPEC section 5.1 that Bun takes. Only twins builds declare and read them, under
    // cfg(jitcache_twins), and act on them, under ENABLE(JITCACHE_TWINS); every other build leaves them empty. They stay
    // in every build, so this layout and context.rs's agree whatever the two switches say.
    JITCacheFlagText twinsReportPath; // --jitcache-twins-report
    JITCacheFlagText twinsRecordLayoutPath; // --jitcache-twins-record-layout
    JITCacheFlagText twinsAvoidLayoutPaths; // --jitcache-twins-avoid-layout: the paths joined by ','; empty for none
    JITCacheFlagText bodyEventsPath; // --jitcache-body-events
};
static_assert(sizeof(JITCacheFlags) == 6 * sizeof(JITCacheFlagText) + sizeof(size_t), "the layout of context.rs's JITCacheFlags");

namespace JITCacheHost {

// Zig__GlobalObject__create calls it right after taking the new VM's API lock, with heap access, before
// JSVMClientData::create and the first global object. 1 is the main thread's VM and a value above 1 and below INT32_MAX
// a worker's; any other VM, the macro VMs' and the debugger thread's included, is left alone. The line saying JITCache
// is off, after a Busy or a Rejected start, and the one saying it replaced an incompatible cache each reach stderr at
// most once per process.
void configureVM(JSC::VM&, int32_t executionContextId);

#if ENABLE(JITCACHE_TWINS)
// JSCInitialize calls them once per process, right before and right after JSC::initialize: the address-space placement
// and layout record of harness sub-SPEC section 4, from --jitcache-twins-avoid-layout and --jitcache-twins-record-layout.
void willInitializeJSC();
void didInitializeJSC();
#endif

} // namespace JITCacheHost

} // namespace Bun

// Defined in src/runtime/cli/Arguments.rs. JITCache is off in a process whose command line Arguments::parse did not
// read.
extern "C" const Bun::JITCacheFlags* Bun__JITCache__flags();

// VirtualMachine::on_exit calls it right after the user's exit handlers, on the VM's thread: delta for a VM whose
// production is active, the warning of a fault, in twins builds the final status line and the body-event dump, then the
// bench report's flush in every role.
extern "C" void Bun__JITCache__atExit(JSC::JSGlobalObject*);

// `bun jitcache <command>` (maintenance sub-SPEC section 5): runs the maintenance command line on argv[0..argc) with
// stdin, stdout and stderr, and returns its exit code. It needs no VM.
extern "C" int Bun__JITCache__runMaintenance(int argc, const char* const* argv);
