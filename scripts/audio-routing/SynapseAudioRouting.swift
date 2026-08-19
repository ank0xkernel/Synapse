// Creates the Multi-Output Device that Synapse needs to hear the far end of a
// call, using CoreAudio directly so nobody has to click through Audio MIDI Setup.
//
// A "Multi-Output Device" is a *stacked* aggregate device: one logical output
// that fans the same stream out to several real devices at once. We stack the
// user's real speakers with BlackHole, so the call audio is audible AND lands in
// the loopback device Synapse records.
//
//   swiftc -O -o synapse-audio-routing SynapseAudioRouting.swift
//   ./synapse-audio-routing list
//   ./synapse-audio-routing create [--name "Synapse Output"] [--set-default]
//   ./synapse-audio-routing set-default "<device name>"
//   ./synapse-audio-routing destroy [--name "Synapse Output"]

import CoreAudio
import Foundation

let DEFAULT_NAME = "Synapse Output"
let DEFAULT_UID = "com.synapse.multioutput"

// MARK: - Property helpers

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal)
    -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector,
                               mScope: scope,
                               mElement: kAudioObjectPropertyElementMain)
}

func allDeviceIDs() -> [AudioDeviceID] {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0

    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                         &addr, 0, nil, &size) == noErr else { return [] }

    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)

    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                     &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func stringProperty(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil

    let status = withUnsafeMutablePointer(to: &value) { pointer -> OSStatus in
        AudioObjectGetPropertyData(device, &addr, 0, nil, &size, pointer)
    }

    guard status == noErr, let result = value else { return nil }
    return result as String
}

func deviceName(_ device: AudioDeviceID) -> String {
    stringProperty(device, kAudioObjectPropertyName) ?? "(unnamed)"
}

func deviceUID(_ device: AudioDeviceID) -> String? {
    stringProperty(device, kAudioDevicePropertyDeviceUID)
}

/// A device is an output if it exposes at least one channel in the output scope.
func outputChannelCount(_ device: AudioDeviceID) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput)
    var size: UInt32 = 0

    guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }

    let buffer = UnsafeMutableRawPointer.allocate(byteCount: Int(size),
                                                  alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { buffer.deallocate() }

    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, buffer) == noErr else { return 0 }

    let list = UnsafeMutableAudioBufferListPointer(buffer.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func defaultOutputDevice() -> AudioDeviceID {
    var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
    var device = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device)
    return device
}

func setDefaultOutputDevice(_ device: AudioDeviceID) -> Bool {
    var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
    var value = device
    let size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                            &addr, 0, nil, size, &value)
    return status == noErr
}

func findDevice(named name: String) -> AudioDeviceID? {
    allDeviceIDs().first { deviceName($0).caseInsensitiveCompare(name) == .orderedSame }
}

func findDevice(matching pattern: String) -> AudioDeviceID? {
    allDeviceIDs().first { deviceName($0).range(of: pattern, options: .caseInsensitive) != nil }
}

// MARK: - Commands

func commandList() {
    let current = defaultOutputDevice()
    print("Audio devices:\n")
    for id in allDeviceIDs() {
        let outputs = outputChannelCount(id)
        guard outputs > 0 else { continue }
        let marker = id == current ? "  ← current output" : ""
        print("  \(deviceName(id))  [\(outputs)ch out]\(marker)")
    }
}

func commandCreate(name: String, setDefault: Bool) -> Int32 {
    guard let blackHole = findDevice(matching: "BlackHole") else {
        FileHandle.standardError.write("Error: BlackHole not found. Run: brew install blackhole-2ch\n".data(using: .utf8)!)
        return 1
    }

    if let existing = findDevice(named: name) {
        print("Multi-output device \"\(name)\" already exists.")
        if setDefault && setDefaultOutputDevice(existing) {
            print("Set \"\(name)\" as the system output.")
        }
        return 0
    }

    // The physical device to keep hearing through. Prefer whatever is currently
    // the default output, so we inherit the user's real choice — unless that is
    // already BlackHole, in which case fall back to the built-in speakers.
    var physical = defaultOutputDevice()
    if physical == blackHole || deviceName(physical).range(of: "BlackHole", options: .caseInsensitive) != nil {
        physical = findDevice(matching: "MacBook Pro Speakers")
            ?? findDevice(matching: "Speakers")
            ?? physical
    }

    guard let physicalUID = deviceUID(physical), let blackHoleUID = deviceUID(blackHole) else {
        FileHandle.standardError.write("Error: could not read device UIDs.\n".data(using: .utf8)!)
        return 1
    }

    print("Creating \"\(name)\":")
    print("  • \(deviceName(physical))   (you hear this)")
    print("  • \(deviceName(blackHole))  (Synapse records this)")

    // The master drives the clock; the secondary device gets drift correction,
    // otherwise the two clocks slowly separate and the capture develops gaps.
    let subDevices: [[String: Any]] = [
        [kAudioSubDeviceUIDKey as String: physicalUID,
         kAudioSubDeviceDriftCompensationKey as String: 0],
        [kAudioSubDeviceUIDKey as String: blackHoleUID,
         kAudioSubDeviceDriftCompensationKey as String: 1]
    ]

    let description: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: name,
        kAudioAggregateDeviceUIDKey as String: DEFAULT_UID,
        kAudioAggregateDeviceSubDeviceListKey as String: subDevices,
        kAudioAggregateDeviceMasterSubDeviceKey as String: physicalUID,
        // Stacked == "Multi-Output Device" rather than a plain aggregate input.
        kAudioAggregateDeviceIsStackedKey as String: 1,
        // Public, so it shows up in Audio MIDI Setup and survives this process.
        kAudioAggregateDeviceIsPrivateKey as String: 0
    ]

    var aggregateID = AudioDeviceID(0)
    let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateID)

    guard status == noErr, aggregateID != 0 else {
        FileHandle.standardError.write("Error: AudioHardwareCreateAggregateDevice failed (OSStatus \(status)).\n".data(using: .utf8)!)
        return 1
    }

    print("Created \"\(name)\".")

    if setDefault {
        // CoreAudio publishes the device asynchronously; selecting it too early
        // silently no-ops.
        usleep(400_000)
        if setDefaultOutputDevice(aggregateID) {
            print("Set \"\(name)\" as the system output.")
        } else {
            FileHandle.standardError.write("Warning: created the device but could not select it. Pick it in System Settings → Sound.\n".data(using: .utf8)!)
        }
    }

    return 0
}

func commandSetDefault(_ name: String) -> Int32 {
    guard let device = findDevice(named: name) ?? findDevice(matching: name) else {
        FileHandle.standardError.write("Error: no device named \"\(name)\".\n".data(using: .utf8)!)
        return 1
    }
    guard setDefaultOutputDevice(device) else {
        FileHandle.standardError.write("Error: could not set \"\(deviceName(device))\" as output.\n".data(using: .utf8)!)
        return 1
    }
    print("System output is now \"\(deviceName(device))\".")
    return 0
}

func commandDestroy(name: String) -> Int32 {
    guard let device = findDevice(named: name) else {
        print("No device named \"\(name)\" — nothing to remove.")
        return 0
    }

    // Move off the device first; destroying the current output leaves the system
    // with no output selected.
    if defaultOutputDevice() == device {
        if let speakers = findDevice(matching: "MacBook Pro Speakers") ?? findDevice(matching: "Speakers") {
            _ = setDefaultOutputDevice(speakers)
            print("Switched output back to \"\(deviceName(speakers))\".")
        }
    }

    let status = AudioHardwareDestroyAggregateDevice(device)
    guard status == noErr else {
        FileHandle.standardError.write("Error: could not destroy the device (OSStatus \(status)).\n".data(using: .utf8)!)
        return 1
    }
    print("Removed \"\(name)\".")
    return 0
}

// MARK: - Entry point

var args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "list"
args = Array(args.dropFirst())

func flagValue(_ flag: String) -> String? {
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    return args[index + 1]
}

let deviceLabel = flagValue("--name") ?? DEFAULT_NAME
let wantsDefault = args.contains("--set-default")

switch command {
case "list":
    commandList()
case "create":
    exit(commandCreate(name: deviceLabel, setDefault: wantsDefault))
case "set-default":
    let target = args.first(where: { !$0.hasPrefix("--") }) ?? DEFAULT_NAME
    exit(commandSetDefault(target))
case "destroy":
    exit(commandDestroy(name: deviceLabel))
default:
    print("""
    Usage:
      synapse-audio-routing list
      synapse-audio-routing create [--name "Synapse Output"] [--set-default]
      synapse-audio-routing set-default "<device name>"
      synapse-audio-routing destroy [--name "Synapse Output"]
    """)
    exit(1)
}
