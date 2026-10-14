#include "root.h"

#include "JITCacheHost.h"

#include <JavaScriptCore/JITCacheAPI.h>
#include <JavaScriptCore/JITCacheMaintenance.h>
#include <JavaScriptCore/JITCacheTwinsHost.h>
#include <JavaScriptCore/JSGlobalObject.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/VM.h>
#include <atomic>
#include <limits>
#include <optional>
#include <span>
#include <stdio.h>
#include <wtf/Vector.h>
#include <wtf/text/ASCIILiteral.h>
#include <wtf/text/CString.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/WTFString.h>

#if ENABLE(JITCACHE_TWINS)
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#endif

// Bun's side of JITCache (SPEC-integrator.md section 11.2). Every VM the host configures reads the flags Arguments::parse
// read once per process; THREAD Session leaves to the host which VMs it configures and when it calls delta, and Bun
// calls it at exit, its idle point.

namespace Bun {

namespace JITCacheHostInternal {

enum class VMKind : uint8_t {
    Main,
    Worker,
    Other,
};

// SPEC-integrator.md N15: VirtualMachine::init gives the main thread's VM 1 and a worker's VM the worker's identifier,
// which ScriptExecutionContext::generateIdentifier makes greater than 1, and the macro VMs and the debugger thread's VM
// INT32_MAX.
static VMKind kindOf(int32_t executionContextId)
{
    if (executionContextId == 1)
        return VMKind::Main;
    if (executionContextId > 1 && executionContextId < std::numeric_limits<int32_t>::max())
        return VMKind::Worker;
    return VMKind::Other;
}

static String flagText(const JITCacheFlagText& text)
{
    if (!text.length)
        return {};
    return String::fromUTF8WithLatin1Fallback(std::span<const char>(text.characters, text.length));
}

// A report's path or the body-event dump's: a worker VM's gets the suffix .<executionContextId>, so each VM writes a file
// of its own, and the main VM's is the configured path, where the runner looks (harness sub-SPEC section 7.7).
static String pathFor(VMKind kind, int32_t executionContextId, const JITCacheFlagText& text)
{
    String path = flagText(text);
    if (path.isEmpty() || kind != VMKind::Worker)
        return path;
    return makeString(path, '.', executionContextId);
}

// Set when the main VM's start returns Started with a producing role: a worker whose producing role then meets Busy
// met the lock its own process's main VM holds.
static std::atomic<bool> mainVMProduces { false };

// Each kind of line goes out once per process, whatever the number of VMs: that JITCache is off or stopped writing, and
// that it replaced an incompatible cache.
static std::atomic<bool> warnedOff { false };
static std::atomic<bool> warnedReplaced { false };

static void writeStderrLine(const String& line)
{
    CString bytes = makeString(line, '\n').utf8();
    fwrite(bytes.data(), 1, bytes.length(), stderr);
    fflush(stderr);
}

static void writeStderrLineOnce(std::atomic<bool>& written, const String& line)
{
    if (written.exchange(true))
        return;
    writeStderrLine(line);
}

static void warnOff(const String& line)
{
    writeStderrLineOnce(warnedOff, line);
}

// "<step>: <detail>", the form section 11.2 gives every line that names a step.
static String stepAndDetail(const String& step, const String& detail)
{
    return makeString(step, ": "_s, detail);
}

#if ENABLE(JITCACHE_TWINS)
// What the exit needs of a VM configureVM kept, which only twins builds use: whether the host called start for it, so
// that its final status line goes out, and the path of its body-event dump.
struct HostVM {
    bool started { false };
    String bodyEventsPath;
};

static Lock hostVMsLock;
static HashMap<JSC::VM*, HostVM>& hostVMs() WTF_REQUIRES_LOCK(hostVMsLock)
{
    static NeverDestroyed<HashMap<JSC::VM*, HostVM>> vms;
    return vms;
}

static void rememberHostVM(JSC::VM& vm, HostVM&& hostVM)
{
    Locker locker { hostVMsLock };
    hostVMs().set(&vm, WTF::move(hostVM));
}

// The exit takes the VM's entry, so a second exit of the same VM writes neither line again.
static std::optional<HostVM> takeHostVM(JSC::VM& vm)
{
    Locker locker { hostVMsLock };
    auto iterator = hostVMs().find(&vm);
    if (iterator == hostVMs().end())
        return std::nullopt;
    HostVM hostVM = WTF::move(iterator->value);
    hostVMs().remove(iterator);
    return hostVM;
}
#endif

static void startJITCache(JSC::VM& vm, VMKind kind, int32_t executionContextId, const JITCacheFlags& flags, const String& artifactPath)
{
    using JSC::JITCache::Role;
    using JSC::JITCache::StartOutcome;

    JSC::JITCache::Config config;
    config.artifactPath = artifactPath;
    config.role = static_cast<Role>(flags.role);
    // The producer limit is the host's to set: SIZE_MAX, what the jsc shell uses without --jitcache-max-memory, until the
    // bench sets defaultProducerLimitBytes (section 16), from when the host leaves it empty for that default.
    config.producerLimitBytes = std::numeric_limits<size_t>::max();
    config.strict = flags.strict;
    config.deltaCapture = static_cast<JSC::JITCache::DeltaCapture>(flags.deltaCapture);
    config.benchReportPath = pathFor(kind, executionContextId, flags.benchReportPath);
    config.twinReportPath = pathFor(kind, executionContextId, flags.twinsReportPath);

    JSC::JITCache::StartResult result = JSC::JITCache::start(vm, config);
    // Busy records nothing (THREAD Session). A worker whose producing role met the lock its process's main VM holds
    // starts again as a Consumer, sharing the main VM's opened artifact and index, which each of its commits updates, so
    // code that only workers run is not captured.
    if (result.outcome == StartOutcome::Busy && kind == VMKind::Worker && mainVMProduces.load()) {
        config.role = Role::Consumer;
        result = JSC::JITCache::start(vm, config);
    }

    switch (result.outcome) {
    case StartOutcome::Started:
        if (kind == VMKind::Main && config.role != Role::Consumer)
            mainVMProduces.store(true);
        // A ConsumerProducer replaced an artifact another build wrote; the detail names the field that differed.
        if (result.step == "start.replaced"_s)
            writeStderrLineOnce(warnedReplaced, makeString("warn: JITCache replaced an incompatible cache at "_s, artifactPath, ": "_s, result.detail));
        return;
    case StartOutcome::Busy:
        // Another process holds the producer lock, a producer or maintenance, and the VM runs with JITCache off: a
        // process asked to write never stops writing silently.
        warnOff(makeString("warn: JITCache is off: another process is writing "_s, artifactPath));
        return;
    case StartOutcome::Rejected:
        warnOff(makeString("warn: JITCache is off: "_s, stepAndDetail(String { result.step }, result.detail)));
        return;
    case StartOutcome::Fault:
        // The start fault is the state's activity fault, which the exit warns about.
        return;
    }
}

} // namespace JITCacheHostInternal

namespace JITCacheHost {

void configureVM(JSC::VM& vm, int32_t executionContextId)
{
    using namespace JITCacheHostInternal;
    VMKind kind = kindOf(executionContextId);
    if (kind == VMKind::Other)
        return;
    const JITCacheFlags& flags = *Bun__JITCache__flags();
    String artifactPath = flagText(flags.artifactPath);

#if ENABLE(JITCACHE_TWINS)
    // Harness sub-SPEC section 4: the main VM's heap probes, with or without --jitcache.
    if (kind == VMKind::Main) {
        if (String layoutPath = flagText(flags.twinsRecordLayoutPath); !layoutPath.isEmpty())
            JSC::JITCache::recordVMLayout(vm, layoutPath);
    }
    rememberHostVM(vm, HostVM { !artifactPath.isEmpty(), pathFor(kind, executionContextId, flags.bodyEventsPath) });
#endif

    // Without --jitcache, JITCache stays off.
    if (artifactPath.isEmpty())
        return;
    startJITCache(vm, kind, executionContextId, flags, artifactPath);
}

#if ENABLE(JITCACHE_TWINS)
void willInitializeJSC()
{
    // An empty value is an empty list, which the first run of a sequence gets (harness sub-SPEC section 5.1).
    Vector<String> layoutPaths;
    if (String paths = JITCacheHostInternal::flagText(Bun__JITCache__flags()->twinsAvoidLayoutPaths); !paths.isEmpty())
        layoutPaths = paths.split(',');
    JSC::JITCache::placeholdersBeforeInitialize(layoutPaths);
}

void didInitializeJSC()
{
    JSC::JITCache::releasePlaceholdersAfterInitialize();
    if (String path = JITCacheHostInternal::flagText(Bun__JITCache__flags()->twinsRecordLayoutPath); !path.isEmpty())
        JSC::JITCache::recordLayout(path);
}
#endif

} // namespace JITCacheHost

} // namespace Bun

extern "C" void Bun__JITCache__atExit(JSC::JSGlobalObject* globalObject)
{
    using namespace Bun::JITCacheHostInternal;
    JSC::VM& vm = globalObject->vm();
    JSC::JSLockHolder locker(vm);
#if ENABLE(JITCACHE_TWINS)
    std::optional<HostVM> hostVM = takeHostVM(vm);
#endif

    // THREAD's "no implicit delta" binds JITCache; the host calls delta at exit, its idle point, only when
    // --jitcache-delta-at-exit asks, for a VM still producing.
    JSC::JITCache::Status status = JSC::JITCache::status(vm);
    if (Bun__JITCache__flags()->deltaAtExit && status.production == JSC::JITCache::ProductionState::Active) {
        JSC::JITCache::delta(vm);
        status = JSC::JITCache::status(vm);
    }

    // The API makes no callbacks, so the exit is where a host learns of a fault.
    if (status.activityFault)
        warnOff(makeString("warn: JITCache is off: "_s, stepAndDetail(status.activityFault->stepName(), status.activityFault->detail)));
    else if (status.productionFault)
        warnOff(makeString("warn: JITCache stopped writing the cache: "_s, stepAndDetail(status.productionFault->stepName(), status.productionFault->detail)));

#if ENABLE(JITCACHE_TWINS)
    if (hostVM) {
        // The runner's status checks read one final status line per VM the host configured (harness sub-SPEC section 7.7).
        if (hostVM->started && Bun__JITCache__flags()->twinsReportPath.length)
            writeStderrLine(JSC::JITCache::toJSON(status));
        // Harness sub-SPEC section 10.3, whether or not JITCache is configured.
        if (!hostVM->bodyEventsPath.isEmpty())
            JSC::JITCache::writeBodyEvents(vm, hostVM->bodyEventsPath);
    }
#endif

    // A consumer never calls delta, and Bun destroys its main VM at exit only under BUN_DESTRUCT_VM_ON_EXIT, so without
    // this flush the events still buffered would be lost.
    JSC::JITCache::flushBenchReport(vm);
}

extern "C" int Bun__JITCache__runMaintenance(int argc, const char* const* argv)
{
    Vector<CString> arguments;
    for (const char* argument : std::span(argv, static_cast<size_t>(argc)))
        arguments.append(CString(argument));
    return JSC::JITCache::Maintenance::runCommandLine(arguments.span(), stdin, stdout, stderr);
}
