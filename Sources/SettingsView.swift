// The PadCoder window: live controller stage, per-button remapping, prompt wheel, tuning, approvals.

import SwiftUI
import AppKit

private let brand = Color(red: 0.85, green: 0.47, blue: 0.34)

private struct Card: ViewModifier {
    var padding: CGFloat = 18
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.primary.opacity(0.07)))
            .shadow(color: .black.opacity(0.07), radius: 14, y: 5)
    }
}

private extension View {
    func card(padding: CGFloat = 18) -> some View { modifier(Card(padding: padding)) }
}

private struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundColor(.secondary)
    }
}

enum Page: String, CaseIterable, Identifiable {
    case buttons = "Buttons", wheel = "Prompt Wheel", tuning = "Tuning", approvals = "Approvals"
    var id: String { rawValue }
}

struct SettingsView: View {
    @ObservedObject var model: LiveModel
    @ObservedObject var store: ConfigStore
    @State private var page: Page

    init(model: LiveModel, store: ConfigStore, page: Page = .buttons) {
        self.model = model
        self.store = store
        _page = State(initialValue: page)
    }

    var body: some View {
        VStack(spacing: 0) {
            TopBar(model: model, page: $page)
            Divider().opacity(0.6)
            Group {
                switch page {
                case .buttons: ButtonsPage(model: model, store: store)
                case .wheel: WheelPage(store: store)
                case .tuning: TuningPage(store: store)
                case .approvals: ApprovalsPage(store: store)
                }
            }
            .padding(22)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(width: 1200, height: 800)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: - Top bar

struct TopBar: View {
    @ObservedObject var model: LiveModel
    @Binding var page: Page

    private var status: (String, Color) {
        if model.paused { return ("Paused", .gray) }
        switch model.claudeState {
        case .idle: return ("Claude idle", model.light)
        case .working: return ("Claude working", model.light)
        case .needsYou: return ("Needs your approval", model.light)
        case .done: return ("Claude finished", model.light)
        }
    }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(LinearGradient(colors: [Color(red: 0.95, green: 0.6, blue: 0.45), brand], startPoint: .top, endPoint: .bottom))
                Image(systemName: "gamecontroller.fill").font(.system(size: 15, weight: .semibold)).foregroundColor(.white)
            }
            .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text("PadCoder").font(.system(size: 15, weight: .semibold))
                Text(model.shown.map { "\($0.kind.title) connected" } ?? "No controller connected")
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }
            Spacer(minLength: 20)
            Picker("", selection: $page) {
                ForEach(Page.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 440)
            Spacer(minLength: 20)
            if model.pads.count > 1 {
                Picker("", selection: $model.shownPad) {
                    ForEach(Array(model.pads.enumerated()), id: \.element.id) { i, p in
                        Text("Pad \(i + 1)").tag(Optional(p.id))
                    }
                }
                .labelsHidden()
                .frame(width: 90)
            }
            if let pad = model.shown, let level = pad.battery {
                pill {
                    Image(systemName: pad.charging ? "battery.100.bolt" : level > 0.6 ? "battery.100" : level > 0.25 ? "battery.50" : "battery.25")
                    Text("\(Int(level * 100))%").monospacedDigit()
                }
            }
            pill {
                Circle().fill(status.1).frame(width: 9, height: 9).shadow(color: status.1, radius: 4)
                Text(status.0)
            }
            Button { model.onPlayGame?() } label: { Label("Bug Dash", systemImage: "flag.checkered") }
                .help("Play while Claude works (L1 + touchpad)")
            Toggle("Pause", isOn: Binding(get: { model.paused }, set: { _ in model.onTogglePause?() }))
                .toggleStyle(.switch)
                .controlSize(.small)
        }
        .padding(.leading, 84)      // clear the window's traffic lights
        .padding(.trailing, 20)
        .frame(height: 60)
    }

    private func pill<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 6) { content() }
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(Color.primary.opacity(0.06)))
    }
}

// MARK: - Buttons page

struct ButtonsPage: View {
    @ObservedObject var model: LiveModel
    @ObservedObject var store: ConfigStore

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(spacing: 14) {
                Stage(model: model)
                LiveReadout(model: model)
            }
            InspectorPanel(model: model, store: store)
                .frame(width: 360)
        }
    }
}

struct Stage: View {
    @ObservedObject var model: LiveModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let kind = model.shownKind
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(RadialGradient(colors: [Color.white.opacity(scheme == .dark ? 0.09 : 0.7), Color.white.opacity(0)],
                                     center: UnitPoint(x: 0.5, y: 0.45), startRadius: 30, endRadius: 460))
                .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Color.primary.opacity(0.07)))
                .shadow(color: .black.opacity(0.07), radius: 14, y: 5)
            ControllerView(model: model, kind: kind, shell: model.shell(for: kind).wrappedValue, displayWidth: 640)
                .opacity(model.shown == nil ? 0.35 : 1)
                .padding(.top, 14)
                .frame(maxWidth: .infinity)
            Picker("", selection: model.shell(for: kind)) {
                Text("White").tag(Shell.white)
                Text("Black").tag(Shell.black)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 130)
            .padding(14)
            if model.shown == nil {
                VStack(spacing: 6) {
                    Image(systemName: "dot.radiowaves.left.and.right").font(.system(size: 26)).foregroundColor(.secondary)
                    Text("No controller connected").font(.headline)
                    Text("Turn on your DualSense or DualShock 4, or pair it in System Settings › Bluetooth.")
                        .font(.callout).foregroundColor(.secondary)
                }
                .padding(18)
                .background(RoundedRectangle(cornerRadius: 14).fill(.regularMaterial))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: 650)
    }
}

struct LiveReadout: View {
    @ObservedObject var model: LiveModel

    var body: some View {
        HStack(spacing: 10) {
            Label("Test your controller", systemImage: "checkmark.seal").font(.callout.weight(.medium)).foregroundColor(.secondary)
            Spacer()
            Button { model.onTestRumble?() } label: { Label("Rumble", systemImage: "waveform.path") }
            Button { model.onTestLight?() } label: { Label("Light bar", systemImage: "sparkles") }
            if model.shownKind == .ps5 {
                triggerTest("l2")
                triggerTest("r2")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .controlSize(.regular)
        .card(padding: 12)
    }

    private func triggerTest(_ name: String) -> some View {
        Toggle(isOn: Binding(get: { model.triggerTests.contains(name) }, set: { on in
            if on { model.triggerTests.insert(name) } else { model.triggerTests.remove(name) }
            model.onTriggerTest?(name, on)
        })) {
            Label("\(name.uppercased()) force", systemImage: "hand.tap")
        }
        .toggleStyle(.button)
        .help("Feel the DualSense adaptive trigger push back")
    }
}

struct InspectorPanel: View {
    @ObservedObject var model: LiveModel
    @ObservedObject var store: ConfigStore

    var body: some View {
        let name = model.selected ?? "cross"
        let kind = model.shownKind
        let press = store.text("buttons", name).wrappedValue
        let layered = store.text("l1Layer", name).wrappedValue
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.accentColor.opacity(0.12))
                    Image(systemName: buttonGlyph(name)).font(.system(size: 22, weight: .semibold)).foregroundColor(.accentColor)
                }
                .frame(width: 54, height: 54)
                VStack(alignment: .leading, spacing: 3) {
                    Text(buttonTitle(name, kind)).font(.system(size: 19, weight: .semibold))
                    if reserved(name) == nil {
                        Text(describeAction(press)).font(.callout).foregroundColor(.secondary).lineLimit(1)
                    }
                }
            }
            .padding(.bottom, 16)
            Divider().padding(.bottom, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let note = reserved(name) {
                        Text(note).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        if name == "l3" || name == "r3" {
                            StickModePicker(title: "Moving the stick", value: store.text(nil, name == "l3" ? "leftStick" : "rightStick"))
                        }
                        if let hint = hint(name) {
                            Label(hint, systemImage: "info.circle").font(.callout).foregroundColor(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ActionEditor(title: name == "l3" || name == "r3" ? "Press the stick" : "Press",
                                     value: store.text("buttons", name))
                        ActionEditor(title: "With L1 held", value: store.text("l1Layer", name), allowsInherit: true)
                        if name == "touchpad" {
                            ActionEditor(title: "Two-finger swipe left", value: store.text("touchpad", "swipeLeft"))
                            ActionEditor(title: "Two-finger swipe right", value: store.text("touchpad", "swipeRight"))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 6)
            }
            if reserved(name) == nil {
                Divider().padding(.vertical, 12)
                HStack {
                    Button("Reset to default") {
                        store.resetText("buttons", name)
                        store.resetText("l1Layer", name)
                    }
                    .disabled(press == store.defaultText("buttons", name) && layered == store.defaultText("l1Layer", name))
                    Spacer()
                    Text("Saved automatically").font(.caption).foregroundColor(.secondary)
                }
            }
        }
        .id(name)
        .card(padding: 20)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func reserved(_ name: String) -> String? {
        switch name {
        case "l1": return "L1 is the layer key. Hold it and every button switches to its \"With L1 held\" action, and the right stick aims the prompt wheel."
        case "ps": return "macOS keeps the PS button for itself (Launchpad and the Games overlay), so it can't be remapped."
        case "mute": return "macOS doesn't let apps read the mute button."
        default: return nil
        }
    }

    private func hint(_ name: String) -> String? {
        switch name {
        case "l3": return "Speeds are on the Tuning page."
        case "r3": return "With L1 held, the right stick always aims the prompt wheel."
        case "touchpad": return "One finger moves the mouse, and two fingers scroll."
        default: return nil
        }
    }
}

// MARK: - Action editor

struct ActionEditor: View {
    let title: String
    @Binding var value: String
    var allowsInherit = false
    @State private var monitor: Any?
    /// Keeps the shortcut field on screen while its text is cleared mid-edit.
    @State private var editingKey = false

    enum Kind: String, CaseIterable, Identifiable {
        case inherit, key, send, type, leftClick, rightClick, gyro, dictation, pause, game, none
        var id: String { rawValue }
        var label: String {
            switch self {
            case .inherit: return "Same as normal press"
            case .key: return "Key or shortcut"
            case .send: return "Send a prompt"
            case .type: return "Type text"
            case .leftClick: return "Left click"
            case .rightClick: return "Right click"
            case .gyro: return "Gyro aim (hold)"
            case .dictation: return "macOS dictation"
            case .pause: return "Pause PadCoder"
            case .game: return "Play Bug Dash"
            case .none: return "Nothing"
            }
        }
        var symbol: String {
            switch self {
            case .inherit: return "arrow.turn.down.right"
            case .key: return "command"
            case .send: return "paperplane"
            case .type: return "character.cursor.ibeam"
            case .leftClick, .rightClick: return "cursorarrow.click"
            case .gyro: return "gyroscope"
            case .dictation: return "mic"
            case .pause: return "pause.circle"
            case .game: return "flag.checkered"
            case .none: return "nosign"
            }
        }
        var help: String {
            switch self {
            case .inherit: return "Uses the normal press action."
            case .key: return "For example return, cmd+d (Claude dictation) or ctrl+shift+tab. Click Record, then press the keys."
            case .send: return "Types the text and presses Return."
            case .type: return "Types the text without sending it."
            case .leftClick: return "Hold to drag."
            case .rightClick: return "Opens context menus."
            case .gyro: return "Hold the button and tilt the controller to aim the mouse."
            case .dictation: return "Toggles macOS dictation. Claude's own dictation is the shortcut cmd+d."
            case .pause: return "Pauses PadCoder so you can game. Press it again to resume."
            case .game: return "Shows the Bug Dash mod above Claude's prompt and turns the pad into its controller. Press it again to drive Claude."
            case .none: return "Does nothing."
            }
        }
    }

    private var kind: Kind {
        if editingKey && (value.isEmpty || value == "none") { return .key }
        switch value {
        case "": return allowsInherit ? .inherit : .none
        case "none": return .none
        case "leftClick": return .leftClick
        case "rightClick": return .rightClick
        case "gyro": return .gyro
        case "dictation": return .dictation
        case "pause": return .pause
        case "game": return .game
        default:
            if value.hasPrefix("send:") { return .send }
            if value.hasPrefix("type:") { return .type }
            return .key
        }
    }

    private var kindBinding: Binding<Kind> {
        Binding(get: { kind }, set: { new in
            let text = (kind == .send || kind == .type) ? String(value.dropFirst(5)) : ""
            editingKey = false
            switch new {
            case .inherit: value = ""
            case .key: value = kind == .key ? value : "return"
            case .send: value = "send:" + text
            case .type: value = "type:" + text
            case .none: value = "none"
            default: value = new.rawValue
            }
        })
    }

    private var payload: Binding<String> {
        Binding(get: {
            switch kind {
            case .send, .type: return String(value.dropFirst(5))
            case .key: return value
            default: return ""
            }
        }, set: { new in
            switch kind {
            case .send: value = "send:" + new
            case .type: value = "type:" + new
            case .key:
                editingKey = true
                value = new
            default: break
            }
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: title)
            Picker("", selection: kindBinding) {
                ForEach(Kind.allCases.filter { allowsInherit || $0 != .inherit }) { k in
                    Label(k.label, systemImage: k.symbol).tag(k)
                }
            }
            .labelsHidden()
            if kind == .key {
                HStack(spacing: 8) {
                    Text(describeAction(value))
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .lineLimit(1)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.07)))
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.primary.opacity(0.12)))
                    Spacer(minLength: 0)
                    Menu {
                        ForEach(claudeShortcuts, id: \.combo) { shortcut in
                            Button(describeAction(shortcut.combo)) { value = shortcut.combo }
                        }
                    } label: {
                        Label("Claude", systemImage: "sparkle")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Pick one of the Claude app's shortcuts")
                }
                HStack(spacing: 8) {
                    TextField("cmd+d", text: payload).textFieldStyle(.roundedBorder).font(.system(.body, design: .monospaced))
                    Button(monitor == nil ? "Record" : "Press keys…") { toggleRecording() }
                        .buttonStyle(.borderedProminent)
                        .tint(monitor == nil ? .accentColor : brand)
                }
            } else if kind == .send || kind == .type {
                TextField("What should it say?", text: payload, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...3)
            }
            Text(kind.help).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .onDisappear { if let m = monitor { NSEvent.removeMonitor(m) } }
    }

    private func toggleRecording() {
        if let m = monitor {
            NSEvent.removeMonitor(m)
            monitor = nil
            return
        }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            if let combo = comboString(for: event) { value = combo }
            if let m = monitor { NSEvent.removeMonitor(m) }
            monitor = nil
            return nil
        }
    }
}

/// What moving a stick does: move the mouse, scroll, or nothing.
struct StickModePicker: View {
    let title: String
    @Binding var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: title)
            Picker("", selection: $value) {
                Text("Move mouse").tag("mouse")
                Text("Scroll").tag("scroll")
                Text("Off").tag("off")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            Text(value == "off" ? "The stick is ignored. Pressing it still works."
                 : value == "scroll" ? "Push to scroll the window under the pointer."
                 : "Push to move the pointer.")
                .font(.caption).foregroundColor(.secondary)
        }
    }
}

let reverseKeyCodes: [CGKeyCode: String] = {
    var names: [CGKeyCode: String] = [:]
    for (name, code) in keyCodes where names[code] == nil || ["return", "backspace", "escape"].contains(name) {
        names[code] = name
    }
    return names
}()

func comboString(for event: NSEvent) -> String? {
    guard let name = reverseKeyCodes[CGKeyCode(event.keyCode)] else { return nil }
    var parts: [String] = []
    let f = event.modifierFlags
    if f.contains(.control) { parts.append("ctrl") }
    if f.contains(.option) { parts.append("alt") }
    if f.contains(.shift) { parts.append("shift") }
    if f.contains(.command) { parts.append("cmd") }
    return (parts + [name]).joined(separator: "+")
}

// MARK: - Prompt wheel page

struct WheelPreview: View {
    let items: [String]
    let highlighted: Int?

    var body: some View {
        ZStack {
            Circle().fill(LinearGradient(colors: [Color(white: 0.22), Color(white: 0.11)], startPoint: .top, endPoint: .bottom))
            Circle().stroke(Color.white.opacity(0.12), lineWidth: 1)
            Circle().stroke(Color.white.opacity(0.07), lineWidth: 1).padding(70)
            ForEach(0..<8, id: \.self) { i in
                let a = Double(i) * .pi / 4
                let text = i < items.count ? items[i] : ""
                Text(text.isEmpty ? "—" : text)
                    .font(.system(size: 12, weight: i == highlighted ? .semibold : .regular))
                    .multilineTextAlignment(.center)
                    .foregroundColor(.white.opacity(text.isEmpty ? 0.3 : 1))
                    .lineLimit(2)
                    .frame(width: 112, height: 42)
                    .background(RoundedRectangle(cornerRadius: 11).fill(i == highlighted ? brand : .clear))
                    .offset(x: sin(a) * 138, y: -cos(a) * 138)
            }
            VStack(spacing: 4) {
                Image(systemName: "l1.rectangle.roundedbottom").font(.system(size: 20))
                Text("hold L1 + point\nthe right stick").font(.system(size: 11)).multilineTextAlignment(.center)
            }
            .foregroundColor(.white.opacity(0.6))
        }
        .frame(width: 420, height: 420)
        .shadow(color: .black.opacity(0.25), radius: 20, y: 8)
    }
}

struct WheelPage: View {
    @ObservedObject var store: ConfigStore
    @FocusState private var focus: Int?
    private let directions = ["Up", "Up-right", "Right", "Down-right", "Down", "Down-left", "Left", "Up-left"]
    private let arrows = ["arrow.up", "arrow.up.right", "arrow.right", "arrow.down.right", "arrow.down", "arrow.down.left", "arrow.left", "arrow.up.left"]
    private let quick = ["cross", "circle", "square", "triangle"]

    var body: some View {
        let items = (0..<8).map { store.wheelSlot($0).wrappedValue }
        HStack(alignment: .top, spacing: 26) {
            VStack(spacing: 14) {
                WheelPreview(items: items, highlighted: focus)
                Text("Release L1 to send the highlighted prompt. Center the stick first to cancel.")
                    .font(.callout).foregroundColor(.secondary).multilineTextAlignment(.center).frame(width: 380)
            }
            .padding(.top, 20)
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    SectionLabel(text: "Wheel prompts")
                    ForEach(0..<8, id: \.self) { i in
                        HStack(spacing: 10) {
                            Image(systemName: arrows[i]).frame(width: 22).foregroundColor(focus == i ? brand : .secondary)
                            Text(directions[i]).frame(width: 84, alignment: .leading).foregroundColor(.secondary)
                            TextField("Empty slot", text: store.wheelSlot(i)).textFieldStyle(.roundedBorder).focused($focus, equals: i)
                        }
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 10) {
                    SectionLabel(text: "Quick prompts · hold L1 + a face button")
                    ForEach(quick, id: \.self) { name in
                        HStack(spacing: 10) {
                            FaceSymbol(name: name).stroke(Color.secondary, lineWidth: 1.6).frame(width: 14, height: 14).frame(width: 22)
                            Text(buttonTitle(name, .ps5).dropFirst(2)).frame(width: 84, alignment: .leading).foregroundColor(.secondary)
                            TextField("Not a prompt", text: quickPrompt(name)).textFieldStyle(.roundedBorder)
                        }
                    }
                }
            }
            .card(padding: 22)
        }
        .frame(maxWidth: .infinity)
    }

    private func quickPrompt(_ name: String) -> Binding<String> {
        let raw = store.text("l1Layer", name)
        return Binding(get: { raw.wrappedValue.hasPrefix("send:") ? String(raw.wrappedValue.dropFirst(5)) : "" },
                       set: { raw.wrappedValue = $0.isEmpty ? "" : "send:" + $0 })
    }
}

// MARK: - Tuning page

struct TuningPage: View {
    @ObservedObject var store: ConfigStore

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            group("Sticks", "l.joystick") {
                StickModePicker(title: "Left stick", value: store.text(nil, "leftStick"))
                StickModePicker(title: "Right stick", value: store.text(nil, "rightStick"))
                slider("Mouse speed", store.number(nil, "mouseSpeed", 1900), 400...4000)
                slider("Scroll speed", store.number(nil, "scrollSpeed", 2400), 400...5000)
                slider("Deadzone", store.number(nil, "stickDeadzone", 0.12), 0.02...0.4)
                Toggle("Invert scroll direction", isOn: store.flag(nil, "invertScroll"))
            }
            group("Touchpad", "hand.point.up.left") {
                slider("Pointer speed", store.number("touchpad", "scale", 750), 200...2000)
                slider("Two-finger scroll speed", store.number("touchpad", "scrollScale", 1400), 300...3000)
            }
            group("Gyro aim", "gyroscope") {
                slider("Sensitivity", store.number("gyro", "sensitivity", 900), 200...3000)
                Toggle("Invert left / right", isOn: store.flag("gyro", "invertX"))
                Toggle("Invert up / down", isOn: store.flag("gyro", "invertY"))
                VStack(alignment: .leading, spacing: 6) {
                    Text("Left / right follows")
                    Picker("", selection: store.text("gyro", "horizontalAxis")) {
                        Text("Turning").tag("y")
                        Text("Tilting sideways").tag("z")
                    }
                    .pickerStyle(.segmented).labelsHidden()
                }
                Text("Hold the gyro button (R1 by default) and tilt the controller.")
                    .font(.caption).foregroundColor(.secondary)
            }
        }
    }

    private func group<C: View>(_ title: String, _ symbol: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(title, systemImage: symbol).font(.headline)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 22)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func slider(_ label: String, _ value: Binding<Double>, _ range: ClosedRange<Double>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                Spacer()
                Text(value.wrappedValue >= 10 ? "\(Int(value.wrappedValue))" : String(format: "%.2f", value.wrappedValue))
                    .font(.system(.body, design: .monospaced)).foregroundColor(.secondary)
            }
            Slider(value: value, in: range)
        }
    }
}

// MARK: - Approvals page

struct ApprovalsPage: View {
    @ObservedObject var store: ConfigStore

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 18) {
                Toggle(isOn: store.flag(nil, "padApprovals")) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Approve from the controller").font(.headline)
                        Text("Answer Claude's permission requests without touching the keyboard.")
                            .font(.callout).foregroundColor(.secondary)
                    }
                }
                .toggleStyle(.switch)
                Divider()
                VStack(alignment: .leading, spacing: 10) {
                    step("1", "Claude asks permission. The pad buzzes 3 times, the light bar pulses red, and R2 gets a click (DualSense only).")
                    step("2", "A panel at the top of the screen shows the tool and the exact command or file.")
                    step("3", "Press ✕ to approve, ○ to deny, or △ to leave it to Claude's normal dialog. The dialog stays usable too, and whichever you answer first wins.")
                }
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Offer it on the pad for")
                        Spacer()
                        Text("\(Int(store.number(nil, "approvalTimeout", 20).wrappedValue)) seconds")
                            .font(.system(.body, design: .monospaced)).foregroundColor(.secondary)
                    }
                    Slider(value: wholeSeconds, in: 5...60)
                }
            }
            .frame(width: 470)
            .card(padding: 24)
            .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Preview")
                ApprovalPreview()
            }
            .padding(.top, 6)
        }
    }

    /// The hook waits in whole seconds, so store whole seconds.
    private var wholeSeconds: Binding<Double> {
        let raw = store.number(nil, "approvalTimeout", 20)
        return Binding(get: { raw.wrappedValue }, set: { raw.wrappedValue = $0.rounded() })
    }

    private func step(_ n: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(n).font(.system(size: 12, weight: .bold, design: .rounded)).foregroundColor(.white)
                .frame(width: 22, height: 22).background(Circle().fill(brand))
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct ApprovalPreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Claude wants to use Bash").font(.system(size: 15, weight: .semibold)).foregroundColor(brand)
            Text("npm test -- --watch=false").font(.system(size: 13, design: .monospaced)).foregroundColor(.white)
            HStack(spacing: 18) {
                Text("✕ Approve"); Text("○ Deny"); Text("△ Show the normal dialog")
                Spacer()
                Text("17s").monospacedDigit()
            }
            .font(.system(size: 13)).foregroundColor(Color(white: 0.7))
        }
        .padding(20)
        .frame(width: 520, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(white: 0.08)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(brand, lineWidth: 2))
        .shadow(color: .black.opacity(0.25), radius: 18, y: 8)
    }
}

// MARK: - Window

/// Owns the PadCoder window; the menu bar item and re-opening the app show it.
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let model: LiveModel
    private let store: ConfigStore

    init(model: LiveModel, store: ConfigStore) {
        self.model = model
        self.store = store
    }

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                             styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.title = "PadCoder"
            w.titleVisibility = .hidden
            w.titlebarAppearsTransparent = true
            w.isMovableByWindowBackground = true
            w.contentView = NSHostingView(rootView: SettingsView(model: model, store: store))
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            window = w
        }
        store.refresh()
        model.windowVisible = true
        model.onWindowShown?()
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        log("settings window shown")
    }

    func windowWillClose(_ notification: Notification) {
        for name in model.triggerTests { model.onTriggerTest?(name, false) }
        model.triggerTests = []
        model.windowVisible = false
        DispatchQueue.main.async { dropDockIconIfNoWindows() }
        log("settings window closed")
    }
}

/// PadCoder is a menu bar app: it only shows in the Dock while one of its windows is open.
func dropDockIconIfNoWindows() {
    let open = NSApp.windows.contains { $0.isVisible && $0.styleMask.contains(.titled) }
    if !open { NSApp.setActivationPolicy(.accessory) }
}
