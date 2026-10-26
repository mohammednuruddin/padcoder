// State the settings window shows: live controller input (from PadCoder) and the config being edited.

import SwiftUI
import GameController

enum PadKind {
    case ps5, ps4, other

    var title: String {
        switch self {
        case .ps5: return "DualSense (PS5)"
        case .ps4: return "DualShock 4 (PS4)"
        case .other: return "Game controller"
        }
    }

    init(_ pad: GCExtendedGamepad) {
        if pad is GCDualSenseGamepad { self = .ps5 }
        else if pad is GCDualShockGamepad { self = .ps4 }
        else { self = .other }
    }
}

struct PadInfo: Identifiable, Equatable {
    let id: ObjectIdentifier
    let name: String
    let kind: PadKind
    var battery: Float?
    var charging: Bool
}

final class LiveModel: ObservableObject {
    static let shared = LiveModel()

    @Published var pads: [PadInfo] = []
    @Published var shownPad: ObjectIdentifier?
    @Published var pressed: Set<String> = []
    @Published var leftStick = CGPoint.zero
    @Published var rightStick = CGPoint.zero
    @Published var l2: CGFloat = 0
    @Published var r2: CGFloat = 0
    @Published var touches: [CGPoint] = []
    @Published var light = Color(red: 0.85, green: 0.47, blue: 0.34)
    @Published var claudeState: ClaudeState = .idle
    @Published var paused = false
    @Published var selected: String? = "cross"
    @Published var hovered: String?
    @Published var triggerTests: Set<String> = []
    @Published var shellPS5 = Shell(rawValue: UserDefaults.standard.string(forKey: "shell.ps5") ?? "") ?? .white {
        didSet { UserDefaults.standard.set(shellPS5.rawValue, forKey: "shell.ps5") }
    }
    @Published var shellPS4 = Shell(rawValue: UserDefaults.standard.string(forKey: "shell.ps4") ?? "") ?? .white {
        didSet { UserDefaults.standard.set(shellPS4.rawValue, forKey: "shell.ps4") }
    }

    /// True while the settings window is open; PadCoder only feeds live input then.
    var windowVisible = false
    var onTogglePause: (() -> Void)?
    var onTestRumble: (() -> Void)?
    var onTestLight: (() -> Void)?
    var onTriggerTest: ((String, Bool) -> Void)?

    var shown: PadInfo? { pads.first { $0.id == shownPad } ?? pads.first }
    var shownKind: PadKind { shown?.kind ?? .ps5 }

    func shell(for kind: PadKind) -> Binding<Shell> {
        Binding(get: { kind == .ps5 ? self.shellPS5 : self.shellPS4 },
                set: { if kind == .ps5 { self.shellPS5 = $0 } else { self.shellPS4 = $0 } })
    }
}

/// Edits config.json for the settings window. Saves shortly after each change; the running
/// PadCoder picks the file up through its normal hot reload.
final class ConfigStore: ObservableObject {
    let config: Config
    @Published private(set) var data: [String: Any] = [:]
    private var pendingSave: DispatchWorkItem?
    private let defaults = (try? JSONSerialization.jsonObject(with: Data(defaultConfigJSON.utf8))) as? [String: Any] ?? [:]

    func defaultText(_ section: String, _ key: String) -> String {
        (defaults[section] as? [String: Any])?[key] as? String ?? ""
    }

    func resetText(_ section: String, _ key: String) {
        set(section, key, defaultText(section, key))
    }

    /// Edits not yet written to disk. Saving merges only these into the file as it is now,
    /// so changes made outside the window (or by another copy of it) aren't overwritten.
    private var edits: [(section: String?, key: String, value: Any)] = []

    init(config: Config) {
        self.config = config
        data = config.data
        config.onReload { [weak self] in
            guard let self else { return }
            self.data = Self.apply(self.edits, to: config.data)
        }
    }

    func refresh() {
        config.reload()
        data = Self.apply(edits, to: config.data)
    }

    private static func apply(_ edits: [(section: String?, key: String, value: Any)], to base: [String: Any]) -> [String: Any] {
        var result = base
        for edit in edits {
            if let section = edit.section {
                var s = result[section] as? [String: Any] ?? [:]
                s[edit.key] = edit.value
                result[section] = s
            } else {
                result[edit.key] = edit.value
            }
        }
        return result
    }

    private func value(_ section: String?, _ key: String) -> Any? {
        guard let section else { return data[key] }
        return (data[section] as? [String: Any])?[key]
    }

    private func set(_ section: String?, _ key: String, _ newValue: Any) {
        edits.append((section, key, newValue))
        data = Self.apply([(section, key, newValue)], to: data)
        scheduleSave()
    }

    private func scheduleSave() {
        pendingSave?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.save() }
        pendingSave = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    private func save() {
        var onDisk: [String: Any] = [:]
        if let raw = try? Data(contentsOf: configURL) {
            guard let parsed = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else {
                log("config.json has a syntax error; not saving over it")
                return
            }
            onDisk = parsed
        }
        let merged = Self.apply(edits, to: onDisk)
        guard let json = try? JSONSerialization.data(withJSONObject: merged, options: [.prettyPrinted, .sortedKeys]) else { return }
        do {
            try json.write(to: configURL, options: .atomic)
            edits.removeAll()
            log("config saved from settings window")
        } catch {
            log("config save failed: \(error)")
        }
    }

    func text(_ section: String?, _ key: String) -> Binding<String> {
        Binding(get: { self.value(section, key) as? String ?? "" }, set: { self.set(section, key, $0) })
    }

    func number(_ section: String?, _ key: String, _ fallback: Double) -> Binding<Double> {
        Binding(get: { (self.value(section, key) as? NSNumber)?.doubleValue ?? fallback },
                set: { v in self.set(section, key, v >= 10 ? v.rounded() : (v * 100).rounded() / 100) })
    }

    func flag(_ section: String?, _ key: String) -> Binding<Bool> {
        Binding(get: { self.value(section, key) as? Bool ?? false }, set: { self.set(section, key, $0) })
    }

    func wheelSlot(_ i: Int) -> Binding<String> {
        Binding(get: {
            let w = self.data["wheel"] as? [String] ?? []
            return i < w.count ? w[i] : ""
        }, set: { text in
            var w = self.data["wheel"] as? [String] ?? []
            while w.count < 8 { w.append("") }
            w[i] = text
            self.set(nil, "wheel", w)
        })
    }
}

/// "cmd+shift+d" → "⌘⇧D", "send:hi" → "Sends “hi”".
func describeAction(_ action: String) -> String {
    switch action {
    case "", "none": return "Nothing"
    case "leftClick": return "Left click"
    case "rightClick": return "Right click"
    case "gyro": return "Gyro aim"
    case "dictation": return "macOS dictation"
    case "pause": return "Pause PadCoder"
    default: break
    }
    if action.hasPrefix("send:") { return "Sends “\(action.dropFirst(5))”" }
    if action.hasPrefix("type:") { return "Types “\(action.dropFirst(5))”" }
    let glyphs: [String: String] = [
        "cmd": "⌘", "command": "⌘", "shift": "⇧", "alt": "⌥", "opt": "⌥", "option": "⌥", "ctrl": "⌃", "control": "⌃",
        "return": "↩", "enter": "↩", "escape": "⎋", "esc": "⎋", "backspace": "⌫", "delete": "⌫", "forwarddelete": "⌦",
        "tab": "⇥", "space": "Space", "up": "↑", "down": "↓", "left": "←", "right": "→",
        "pageup": "Page Up", "pagedown": "Page Down", "home": "Home", "end": "End",
    ]
    let parts = action.lowercased().split(separator: "+").map { String($0) }
    let mods = parts.dropLast().map { glyphs[$0] ?? $0 }.joined()
    let key = parts.last.map { glyphs[$0] ?? $0.uppercased() } ?? ""
    if let name = claudeShortcutName(action) { return "\(mods + key)  \(name)" }
    let names: [String: String] = ["↩": "Return", "⎋": "Esc", "⌫": "Backspace", "⇥": "Tab"]
    if mods.isEmpty, let word = names[key] { return "\(key)  \(word)" }
    return mods + key
}

/// Shortcuts of the Claude desktop app's Code tab, offered in the shortcut editor.
let claudeShortcuts: [(combo: String, name: String)] = [
    ("cmd+shift+i", "Model menu"),
    ("cmd+shift+e", "Effort menu"),
    ("cmd+shift+m", "Permission mode menu"),
    ("cmd+d", "Claude dictation"),
    ("cmd+return", "Accept / submit"),
    ("escape", "Stop Claude"),
]

func claudeShortcutName(_ action: String) -> String? {
    guard let combo = parseCombo(action) else { return nil }
    return claudeShortcuts.first { entry in
        parseCombo(entry.combo).map { $0.code == combo.code && $0.flags == combo.flags } ?? false
    }?.name
}

func buttonGlyph(_ name: String) -> String {
    switch name {
    case "cross": return "xmark"
    case "circle": return "circle"
    case "square": return "square"
    case "triangle": return "triangle"
    case "up": return "arrowtriangle.up.fill"
    case "down": return "arrowtriangle.down.fill"
    case "left": return "arrowtriangle.left.fill"
    case "right": return "arrowtriangle.right.fill"
    case "l1": return "l1.rectangle.roundedbottom"
    case "r1": return "r1.rectangle.roundedbottom"
    case "l2": return "l2.rectangle.roundedtop"
    case "r2": return "r2.rectangle.roundedtop"
    case "l3": return "l.joystick.press.down"
    case "r3": return "r.joystick.press.down"
    case "options": return "line.3.horizontal"
    case "create": return "light.beacon.max"
    case "touchpad": return "hand.point.up.left"
    case "ps": return "playstation.logo"
    case "mute": return "mic.slash"
    default: return "gamecontroller"
    }
}

func buttonTitle(_ name: String, _ kind: PadKind) -> String {
    switch name {
    case "cross": return "✕ Cross"
    case "circle": return "○ Circle"
    case "square": return "□ Square"
    case "triangle": return "△ Triangle"
    case "up": return "D-pad up"
    case "down": return "D-pad down"
    case "left": return "D-pad left"
    case "right": return "D-pad right"
    case "l1": return "L1"
    case "r1": return "R1"
    case "l2": return "L2 trigger"
    case "r2": return "R2 trigger"
    case "l3": return "Left stick"
    case "r3": return "Right stick"
    case "options": return "Options"
    case "create": return kind == .ps4 ? "Share" : "Create"
    case "touchpad": return "Touchpad"
    case "ps": return "PS button"
    case "mute": return "Mute"
    default: return name
    }
}
