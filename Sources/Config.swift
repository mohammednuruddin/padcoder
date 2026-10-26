// User-editable settings in ~/Library/Application Support/PadCoder/config.json, hot-reloaded.

import Foundation

let supportDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/PadCoder")
let configURL = supportDir.appendingPathComponent("config.json")
let requestsDir = supportDir.appendingPathComponent("requests")
let activeFlagURL = supportDir.appendingPathComponent("active")

/// Actions: a key combo ("return", "cmd+d", "ctrl+shift+tab"), "send:<text>" (type + Return),
/// "type:<text>", "leftClick", "rightClick", "gyro" (hold to aim), "dictation" (macOS), "pause",
/// "game" (Bug Dash game mode: shows the mod above the prompt and plays it with the pad), "none".
/// Wheel slots run clockwise from the top: up, up-right, right, down-right, down, down-left, left, up-left.
/// leftStick / rightStick: what moving the stick does, "mouse", "scroll" or "off".
let defaultConfigJSON = """
{
  "buttons": {
    "cross": "return",
    "circle": "escape",
    "square": "backspace",
    "triangle": "cmd+d",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "r1": "gyro",
    "r2": "leftClick",
    "l2": "rightClick",
    "l3": "cmd+z",
    "r3": "cmd+v",
    "options": "cmd+return",
    "create": "pause",
    "touchpad": "leftClick"
  },
  "l1Layer": {
    "cross": "send:yes, go ahead",
    "circle": "send:undo that and try a different approach",
    "square": "send:run it and fix any errors",
    "triangle": "send:explain what you just changed, briefly",
    "r1": "shift+tab",
    "l2": "cmd+shift+i",
    "r2": "cmd+shift+e",
    "create": "cmd+shift+m",
    "touchpad": "game",
    "options": "cmd+n",
    "up": "pageup",
    "down": "pagedown",
    "left": "home",
    "right": "end"
  },
  "wheel": [
    "continue",
    "what's next?",
    "make it simpler",
    "write tests for this",
    "fix the failing tests",
    "summarize what you changed",
    "add comments where it's unclear",
    "double-check your work"
  ],
  "touchpad": {
    "scale": 750,
    "scrollScale": 1400,
    "swipeLeft": "ctrl+shift+tab",
    "swipeRight": "ctrl+tab"
  },
  "gyro": {
    "sensitivity": 900,
    "invertX": false,
    "invertY": false,
    "horizontalAxis": "y"
  },
  "leftStick": "mouse",
  "rightStick": "scroll",
  "mouseSpeed": 1900,
  "scrollSpeed": 2400,
  "invertScroll": false,
  "stickDeadzone": 0.12,
  "padApprovals": true,
  "approvalTimeout": 20
}
"""

final class Config {
    private(set) var data: [String: Any] = [:]
    /// Run after new settings are applied, whoever triggered the reload.
    private var reloadHandlers: [() -> Void] = []
    func onReload(_ handler: @escaping () -> Void) { reloadHandlers.append(handler) }
    private var loadedDate: Date?
    private let defaults = (try? JSONSerialization.jsonObject(with: Data(defaultConfigJSON.utf8))) as? [String: Any] ?? [:]

    init() {
        try? FileManager.default.createDirectory(at: requestsDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: configURL.path) {
            try? defaultConfigJSON.write(to: configURL, atomically: true, encoding: .utf8)
            log("wrote default config to \(configURL.path)")
        }
        reload()
    }

    /// Re-reads the file if it changed on disk. Returns true when new settings were applied.
    @discardableResult
    func reload() -> Bool {
        let modified = (try? FileManager.default.attributesOfItem(atPath: configURL.path))?[.modificationDate] as? Date
        guard modified != loadedDate else { return false }
        loadedDate = modified
        guard let raw = try? Data(contentsOf: configURL),
              let user = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else {
            log("config: couldn't parse config.json, keeping previous settings")
            if data.isEmpty { data = defaults }
            return false
        }
        // One level of merging, so a user file can override single buttons without restating the rest.
        var merged = defaults
        for (key, value) in user {
            if let base = merged[key] as? [String: Any], let override = value as? [String: Any] {
                merged[key] = base.merging(override) { _, new in new }
            } else {
                merged[key] = value
            }
        }
        data = merged
        log("config loaded")
        reloadHandlers.forEach { $0() }
        return true
    }

    func section(_ key: String) -> [String: Any] { data[key] as? [String: Any] ?? [:] }
    func action(_ button: String, layer: Bool) -> String? { section(layer ? "l1Layer" : "buttons")[button] as? String }
    func double(_ key: String, _ fallback: Double) -> Double { (data[key] as? NSNumber)?.doubleValue ?? fallback }
    func bool(_ key: String, _ fallback: Bool) -> Bool { data[key] as? Bool ?? fallback }
    func string(_ key: String, _ fallback: String) -> String { data[key] as? String ?? fallback }
    var wheel: [String] { Array(((data["wheel"] as? [String]) ?? []).prefix(8)) }
}

func num(_ dict: [String: Any], _ key: String, _ fallback: Double) -> Double {
    (dict[key] as? NSNumber)?.doubleValue ?? fallback
}
