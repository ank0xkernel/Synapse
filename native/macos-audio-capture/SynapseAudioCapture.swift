// synapse-audio-capture: captures macOS system audio without changing the
// user's output device.
//
// Backends, picked at runtime by actual API availability:
//   process-tap     macOS 14.2+  Core Audio process tap. Needs the "System Audio
//                                Recording" permission (NSAudioCaptureUsageDescription
//                                in the host app's Info.plist).
//   screencapturekit macOS 13.0+ ScreenCaptureKit audio. Needs the "Screen
//                                Recording" permission.
//
// Protocol (consumed by src/services/native-audio/native-system-audio.js):
//   stdout  raw little-endian Float32 mono PCM at --rate (default 16000)
//   stderr  one JSON object per line: ready | stats | device-changed | error | stopped
//   stdin   held open by the parent; EOF means the parent died and we exit.
//
//   synapse-audio-capture probe
//   synapse-audio-capture capture [--backend auto|process-tap|screencapturekit]
//                                 [--rate 16000] [--exclude-pid <pid>]...

import AVFoundation
import AudioToolbox
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Event output

let stderrLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    stderrLock.lock()
    defer { stderrLock.unlock() }
    FileHandle.standardError.write(data)
    FileHandle.standardError.write(Data([0x0A]))
}

func emitError(_ code: String, _ message: String, fatal: Bool = true) {
    emit(["type": "error", "code": code, "message": message, "fatal": fatal])
}

// MARK: - PCM sink: convert to target format, bounded hand-off to stdout

/// Converts whatever the capture backend delivers into mono Float32 at the
/// target rate and writes it to stdout on a dedicated queue.
///
/// Backpressure: if the parent stops reading, write() blocks the writer queue,
/// the pending count grows, and new audio is dropped (and counted) instead of
/// buffering without bound. Real-time audio that is seconds old is useless to
/// live transcription anyway.
final class PcmSink {
    let outputFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private let writeQueue = DispatchQueue(label: "synapse.audio.write")
    private let stateLock = NSLock()
    private var pendingSamples = 0
    private let maxPendingSamples: Int
    private var framesOut: UInt64 = 0
    private var droppedSamples: UInt64 = 0
    private var intervalPeak: Float = 0
    private var broken = false
    private var lastRealAudioAt = DispatchTime.now()
    private var silenceFilledSamples: UInt64 = 0

    init(sampleRate: Double) {
        outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: true)!
        // 2 seconds of audio is the most we hold before dropping.
        maxPendingSamples = Int(sampleRate * 2)
    }

    /// Called from the capture backend's queue with a buffer it owns for the
    /// duration of the call only.
    func consume(_ input: AVAudioPCMBuffer) {
        guard input.frameLength > 0 else { return }

        if converterInputFormat == nil || converterInputFormat! != input.format {
            converter = AVAudioConverter(from: input.format, to: outputFormat)
            converter?.downmix = true
            converterInputFormat = input.format
        }
        guard let converter = converter else { return }

        let ratio = outputFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }

        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return input
        }

        if status == .error {
            emitError("CONVERT_FAILED", conversionError?.localizedDescription ?? "audio conversion failed", fatal: false)
            return
        }

        let count = Int(output.frameLength)
        guard count > 0, let samples = output.floatChannelData?[0] else { return }

        var peak: Float = 0
        for index in 0..<count {
            let value = abs(samples[index])
            if value > peak { peak = value }
        }

        let data = Data(bytes: samples, count: count * MemoryLayout<Float>.size)
        stateLock.lock()
        lastRealAudioAt = DispatchTime.now()
        stateLock.unlock()
        enqueue(data, samples: count, peak: peak)
    }

    /// A process tap delivers no IO at all until some app plays audio, and the
    /// HAL may idle it again later. Downstream (live STT sockets, the stall
    /// watchdog) expects a steady stream, so idle gaps are filled with silence
    /// at real-time cadence. Called every `intervalMs` by the controller.
    func fillSilenceIfIdle(intervalMs: Int) {
        stateLock.lock()
        let idleNs = DispatchTime.now().uptimeNanoseconds - lastRealAudioAt.uptimeNanoseconds
        stateLock.unlock()
        guard idleNs > UInt64(intervalMs * 2) * 1_000_000 else { return }

        let count = Int(outputFormat.sampleRate) * intervalMs / 1000
        let data = Data(count: count * MemoryLayout<Float>.size)
        stateLock.lock()
        silenceFilledSamples += UInt64(count)
        stateLock.unlock()
        enqueue(data, samples: count, peak: 0)
    }

    private func enqueue(_ data: Data, samples: Int, peak: Float) {
        stateLock.lock()
        if broken {
            stateLock.unlock()
            return
        }
        if pendingSamples + samples > maxPendingSamples {
            droppedSamples += UInt64(samples)
            stateLock.unlock()
            return
        }
        pendingSamples += samples
        if peak > intervalPeak { intervalPeak = peak }
        stateLock.unlock()

        writeQueue.async { [weak self] in
            guard let self = self else { return }
            let ok = data.withUnsafeBytes { raw -> Bool in
                guard var pointer = raw.baseAddress else { return true }
                var remaining = raw.count
                while remaining > 0 {
                    let written = write(STDOUT_FILENO, pointer, remaining)
                    if written < 0 {
                        if errno == EINTR { continue }
                        return false
                    }
                    remaining -= written
                    pointer = pointer.advanced(by: written)
                }
                return true
            }

            self.stateLock.lock()
            self.pendingSamples -= samples
            if ok {
                self.framesOut += UInt64(samples)
            } else {
                self.broken = true
            }
            self.stateLock.unlock()

            if !ok {
                // The parent closed the pipe: nothing left to capture for.
                shutdown(reason: "stdout-closed", exitCode: 0)
            }
        }
    }

    func resetConverter() {
        converter = nil
        converterInputFormat = nil
    }

    func takeStats() -> [String: Any] {
        stateLock.lock()
        defer { stateLock.unlock() }
        let peakDb: Any = intervalPeak > 0 ? Double(20 * log10(intervalPeak)) : NSNull()
        let stats: [String: Any] = [
            "type": "stats",
            "samplesOut": framesOut,
            "droppedSamples": droppedSamples,
            "pendingSamples": pendingSamples,
            "silenceFilledSamples": silenceFilledSamples,
            "peakDb": peakDb
        ]
        intervalPeak = 0
        return stats
    }
}

// MARK: - Core Audio helpers

func propertyAddress(_ selector: AudioObjectPropertySelector,
                     _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func defaultOutputDeviceID() -> AudioDeviceID? {
    var address = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
    var device = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
    return status == noErr && device != kAudioObjectUnknown ? device : nil
}

func deviceUID(_ device: AudioDeviceID) -> String? {
    var address = propertyAddress(kAudioDevicePropertyDeviceUID)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: Unmanaged<CFString>?
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
    guard status == noErr, let uid = value?.takeRetainedValue() else { return nil }
    return uid as String
}

func deviceName(_ device: AudioDeviceID) -> String {
    var address = propertyAddress(kAudioObjectPropertyName)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: Unmanaged<CFString>?
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
    guard status == noErr, let name = value?.takeRetainedValue() else { return "unknown" }
    return name as String
}

@available(macOS 14.2, *)
func processObjectID(for pid: pid_t) -> AudioObjectID? {
    var address = propertyAddress(kAudioHardwarePropertyTranslatePIDToProcessObject)
    var qualifier = pid
    var object = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                            UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
    return status == noErr && object != kAudioObjectUnknown ? object : nil
}

// MARK: - Backend protocol

protocol CaptureBackend: AnyObject {
    var name: String { get }
    func start() throws
    func stop()
}

struct CaptureError: Error {
    let code: String
    let message: String
}

// MARK: - Process tap backend (macOS 14.2+)

@available(macOS 14.2, *)
final class ProcessTapBackend: CaptureBackend {
    let name = "process-tap"
    private let sink: PcmSink
    private let excludePIDs: [pid_t]
    private let ioQueue = DispatchQueue(label: "synapse.audio.tap-io", qos: .userInteractive)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    init(sink: PcmSink, excludePIDs: [pid_t]) {
        self.sink = sink
        self.excludePIDs = excludePIDs
    }

    func start() throws {
        let excluded = excludePIDs.compactMap { processObjectID(for: $0) }
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        description.uuid = UUID()
        description.name = "Synapse system audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var newTap = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(description, &newTap)
        guard status == noErr, newTap != kAudioObjectUnknown else {
            throw CaptureError(code: "TAP_CREATE_FAILED", message: "AudioHardwareCreateProcessTap failed (OSStatus \(status))")
        }
        tapID = newTap

        var formatAddress = propertyAddress(kAudioTapPropertyFormat)
        var streamDescription = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &streamDescription)
        guard status == noErr, let tapFormat = AVAudioFormat(streamDescription: &streamDescription) else {
            stop()
            throw CaptureError(code: "TAP_FORMAT_FAILED", message: "Could not read the tap's audio format (OSStatus \(status))")
        }

        guard let outputDevice = defaultOutputDeviceID(), let outputUID = deviceUID(outputDevice) else {
            stop()
            throw CaptureError(code: "NO_OUTPUT_DEVICE", message: "No default output device to clock the capture from")
        }

        // A private aggregate device that contains only the tap. The current
        // output device is its clock source; it is not modified, and audio keeps
        // playing through it exactly as before.
        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Synapse Capture",
            kAudioAggregateDeviceUIDKey: "com.synapse.capture.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString
            ]]
        ]

        var newAggregate = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &newAggregate)
        guard status == noErr, newAggregate != kAudioObjectUnknown else {
            stop()
            throw CaptureError(code: "AGGREGATE_CREATE_FAILED", message: "AudioHardwareCreateAggregateDevice failed (OSStatus \(status))")
        }
        aggregateID = newAggregate

        let sink = self.sink
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, ioQueue) { _, inputData, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: inputData, deallocator: nil) else { return }
            sink.consume(buffer)
        }
        guard status == noErr, ioProcID != nil else {
            stop()
            throw CaptureError(code: "IOPROC_FAILED", message: "AudioDeviceCreateIOProcIDWithBlock failed (OSStatus \(status))")
        }

        status = AudioDeviceStart(aggregateID, ioProcID)
        guard status == noErr else {
            stop()
            throw CaptureError(code: "DEVICE_START_FAILED", message: "AudioDeviceStart failed (OSStatus \(status))")
        }

        emit([
            "type": "ready",
            "backend": name,
            "sourceSampleRate": tapFormat.sampleRate,
            "sourceChannels": Int(tapFormat.channelCount),
            "outputSampleRate": sink.outputFormat.sampleRate,
            "clockDevice": deviceName(outputDevice)
        ])
    }

    /// Teardown order matters: stopping IO before destroying the proc, and the
    /// aggregate before the tap, avoids HAL deadlocks.
    func stop() {
        if aggregateID != kAudioObjectUnknown, let procID = ioProcID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        ioProcID = nil
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        sink.resetConverter()
    }
}

// MARK: - ScreenCaptureKit backend (macOS 13.0+)

@available(macOS 13.0, *)
final class ScreenCaptureBackend: NSObject, CaptureBackend, SCStreamOutput, SCStreamDelegate {
    let name = "screencapturekit"
    private let sink: PcmSink
    private let excludePIDs: [pid_t]
    private let sampleQueue = DispatchQueue(label: "synapse.audio.sck", qos: .userInteractive)
    private var stream: SCStream?

    init(sink: PcmSink, excludePIDs: [pid_t]) {
        self.sink = sink
        self.excludePIDs = excludePIDs
    }

    func start() throws {
        let semaphore = DispatchSemaphore(value: 0)
        var startError: Error?

        Task {
            do {
                try await self.startAsync()
            } catch {
                startError = error
            }
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + 15) == .timedOut {
            throw CaptureError(code: "SCK_START_TIMEOUT", message: "ScreenCaptureKit did not start within 15s")
        }

        if let error = startError {
            if let captureError = error as? CaptureError { throw captureError }
            let nsError = error as NSError
            // SCStreamErrorUserDeclined (-3801): Screen Recording permission refused.
            if nsError.domain == SCStreamErrorDomain && nsError.code == -3801 {
                throw CaptureError(code: "PERMISSION_DENIED", message: "Screen Recording permission was denied. Enable Synapse in System Settings → Privacy & Security → Screen & System Audio Recording.")
            }
            throw CaptureError(code: "SCK_START_FAILED", message: nsError.localizedDescription)
        }
    }

    private func startAsync() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw CaptureError(code: "NO_DISPLAY", message: "ScreenCaptureKit found no display to attach audio capture to")
        }

        let excludedApps = content.applications.filter { excludePIDs.contains($0.processID) }
        let filter = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48000
        configuration.channelCount = 2
        // Video is mandatory for an SCStream; keep it as small and slow as allowed.
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 3

        let newStream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        try await newStream.startCapture()
        stream = newStream

        emit([
            "type": "ready",
            "backend": name,
            "sourceSampleRate": 48000,
            "sourceChannels": 2,
            "outputSampleRate": sink.outputFormat.sampleRate,
            "clockDevice": NSNull()
        ])
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let formatDescription = sampleBuffer.formatDescription,
              let streamDescriptionPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else { return }

        var streamDescription = streamDescriptionPointer.pointee
        guard let format = AVAudioFormat(streamDescription: &streamDescription) else { return }

        do {
            try sampleBuffer.withAudioBufferList { audioBufferList, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: audioBufferList.unsafePointer, deallocator: nil) else { return }
                sink.consume(buffer)
            }
        } catch {
            emitError("SCK_BUFFER_FAILED", error.localizedDescription, fatal: false)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitError("SCK_STOPPED", error.localizedDescription, fatal: false)
        controller?.scheduleRestart(reason: "sck-stopped")
    }

    func stop() {
        guard let activeStream = stream else { return }
        stream = nil
        let semaphore = DispatchSemaphore(value: 0)
        activeStream.stopCapture { _ in semaphore.signal() }
        _ = semaphore.wait(timeout: .now() + 3)
        sink.resetConverter()
    }
}

// MARK: - Controller: backend selection, device changes, restart

final class CaptureController {
    let sink: PcmSink
    let requestedBackend: String
    let excludePIDs: [pid_t]
    private let controlQueue = DispatchQueue(label: "synapse.audio.control")
    private var backend: CaptureBackend?
    private var statsTimer: DispatchSourceTimer?
    private var silenceTimer: DispatchSourceTimer?
    private var restartAttempts = 0
    private var restartPending = false
    private var stopped = false
    private var deviceListener: AudioObjectPropertyListenerBlock?

    init(sink: PcmSink, requestedBackend: String, excludePIDs: [pid_t]) {
        self.sink = sink
        self.requestedBackend = requestedBackend
        self.excludePIDs = excludePIDs
    }

    func resolveBackend() throws -> CaptureBackend {
        let wantsTap = requestedBackend == "auto" || requestedBackend == "process-tap"
        let wantsSck = requestedBackend == "auto" || requestedBackend == "screencapturekit"

        if wantsTap, #available(macOS 14.2, *) {
            return ProcessTapBackend(sink: sink, excludePIDs: excludePIDs)
        }
        if wantsSck, #available(macOS 13.0, *) {
            return ScreenCaptureBackend(sink: sink, excludePIDs: excludePIDs)
        }
        throw CaptureError(code: "UNSUPPORTED_OS",
                           message: "Native system audio capture needs macOS 13.0 or later (backend requested: \(requestedBackend))")
    }

    func start() {
        controlQueue.async { self.startLocked() }
        watchDefaultOutputDevice()
        startStatsTimer()
    }

    private func startLocked() {
        guard !stopped else { return }
        do {
            let next = try resolveBackend()
            try next.start()
            backend = next
            restartAttempts = 0
        } catch let error as CaptureError {
            let retryable = !["UNSUPPORTED_OS", "PERMISSION_DENIED"].contains(error.code)
            emitError(error.code, error.message, fatal: !retryable)
            if retryable {
                scheduleRestartLocked(reason: error.code)
            } else {
                shutdown(reason: error.code, exitCode: 2)
            }
        } catch {
            emitError("START_FAILED", error.localizedDescription, fatal: false)
            scheduleRestartLocked(reason: "start-failed")
        }
    }

    func scheduleRestart(reason: String) {
        controlQueue.async { self.scheduleRestartLocked(reason: reason) }
    }

    private func scheduleRestartLocked(reason: String) {
        guard !stopped, !restartPending else { return }
        let delays = [0.25, 0.5, 1.0, 2.0, 4.0]
        guard restartAttempts < delays.count else {
            emitError("RESTART_EXHAUSTED", "Gave up restarting capture after \(restartAttempts) attempts (last: \(reason))")
            shutdown(reason: "restart-exhausted", exitCode: 3)
            return
        }
        let delay = delays[restartAttempts]
        restartAttempts += 1
        restartPending = true
        emit(["type": "restarting", "reason": reason, "attempt": restartAttempts, "delayMs": Int(delay * 1000)])
        controlQueue.asyncAfter(deadline: .now() + delay) {
            self.restartPending = false
            self.backend?.stop()
            self.backend = nil
            self.startLocked()
        }
    }

    /// The tap's aggregate device is clocked by the output device that was the
    /// default when capture began. When the user switches to headphones (or
    /// unplugs them), rebuild against the new default so capture continues.
    private func watchDefaultOutputDevice() {
        var address = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self = self else { return }
            let name = defaultOutputDeviceID().map(deviceName) ?? "none"
            emit(["type": "device-changed", "defaultOutput": name])
            self.controlQueue.async {
                guard !self.stopped, self.backend?.name == "process-tap" else { return }
                self.restartAttempts = 0
                self.scheduleRestartLocked(reason: "default-output-changed")
            }
        }
        deviceListener = listener
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, listener)
    }

    private func startStatsTimer() {
        let timer = DispatchSource.makeTimerSource(queue: controlQueue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self = self, !self.stopped else { return }
            var stats = self.sink.takeStats()
            stats["backend"] = self.backend?.name ?? NSNull()
            emit(stats)
        }
        timer.resume()
        statsTimer = timer

        let silence = DispatchSource.makeTimerSource(queue: controlQueue)
        silence.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100), leeway: .milliseconds(10))
        silence.setEventHandler { [weak self] in
            guard let self = self, !self.stopped, self.backend != nil else { return }
            self.sink.fillSilenceIfIdle(intervalMs: 100)
        }
        silence.resume()
        silenceTimer = silence
    }

    func stop() {
        controlQueue.sync {
            stopped = true
            statsTimer?.cancel()
            statsTimer = nil
            silenceTimer?.cancel()
            silenceTimer = nil
            if let listener = deviceListener {
                var address = propertyAddress(kAudioHardwarePropertyDefaultOutputDevice)
                AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, controlQueue, listener)
                deviceListener = nil
            }
            backend?.stop()
            backend = nil
        }
    }
}

// MARK: - Process lifecycle

var controller: CaptureController?
let shutdownLock = NSLock()
var isShuttingDown = false

func shutdown(reason: String, exitCode: Int32) {
    shutdownLock.lock()
    if isShuttingDown {
        shutdownLock.unlock()
        return
    }
    isShuttingDown = true
    shutdownLock.unlock()

    DispatchQueue.global().async {
        controller?.stop()
        emit(["type": "stopped", "reason": reason])
        exit(exitCode)
    }
}

func installLifecycleHandlers() {
    signal(SIGPIPE, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    term.setEventHandler { shutdown(reason: "sigterm", exitCode: 0) }
    term.resume()

    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    interrupt.setEventHandler { shutdown(reason: "sigint", exitCode: 0) }
    interrupt.resume()

    // Parent death: the parent holds our stdin open, so EOF means it is gone.
    let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .global())
    stdinSource.setEventHandler {
        var scratch = [UInt8](repeating: 0, count: 256)
        let count = read(STDIN_FILENO, &scratch, scratch.count)
        if count <= 0 {
            shutdown(reason: "parent-exited", exitCode: 0)
        }
    }
    stdinSource.resume()

    lifecycleSources = [term, interrupt, stdinSource]
}

var lifecycleSources: [DispatchSourceProtocol] = []

// MARK: - Entry point

func osVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

func probe() {
    var processTap = false
    var screenCaptureKit = false
    if #available(macOS 14.2, *) { processTap = true }
    if #available(macOS 13.0, *) { screenCaptureKit = true }
    let recommended: Any = processTap ? "process-tap" : (screenCaptureKit ? "screencapturekit" as Any : NSNull())
    let output: [String: Any] = [
        "osVersion": osVersionString(),
        "processTap": processTap,
        "screenCaptureKit": screenCaptureKit,
        "recommendedBackend": recommended,
        "defaultOutput": defaultOutputDeviceID().map(deviceName) ?? NSNull()
    ]
    if let data = try? JSONSerialization.data(withJSONObject: output, options: []) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? "probe"

func values(for flag: String) -> [String] {
    var result: [String] = []
    var index = 0
    while index < arguments.count {
        if arguments[index] == flag, index + 1 < arguments.count {
            result.append(arguments[index + 1])
            index += 2
        } else {
            index += 1
        }
    }
    return result
}

switch command {
case "probe":
    probe()
    exit(0)
case "capture":
    let backendName = values(for: "--backend").last ?? "auto"
    guard ["auto", "process-tap", "screencapturekit"].contains(backendName) else {
        emitError("BAD_ARGUMENT", "Unknown backend \(backendName)")
        exit(64)
    }
    let rate = Double(values(for: "--rate").last ?? "16000") ?? 16000
    guard rate >= 8000, rate <= 48000 else {
        emitError("BAD_ARGUMENT", "--rate must be between 8000 and 48000")
        exit(64)
    }
    let excluded = values(for: "--exclude-pid").compactMap { pid_t($0) } + [getpid()]

    installLifecycleHandlers()
    let sink = PcmSink(sampleRate: rate)
    controller = CaptureController(sink: sink, requestedBackend: backendName, excludePIDs: excluded)
    controller?.start()
    dispatchMain()
default:
    FileHandle.standardError.write("usage: synapse-audio-capture probe | capture [--backend auto|process-tap|screencapturekit] [--rate 16000] [--exclude-pid PID]\n".data(using: .utf8)!)
    exit(64)
}
