// Controller handling: button actions, sticks, touchpad, gyro, light bar, triggers, approvals.

import AppKit
import SwiftUI
import GameController
import CoreHaptics
import notify

enum ClaudeState { case idle, working, needsYou, done }

struct Pending { let id: String; let tool: String; let summary: String; let deadline: Date; let hookPID: Int32 }

final class PadState {
    let controller: GCController
    let pad: GCExtendedGamepad
    var engine: CHHapticEngine?
    var l1DownAt: Double?
    var layerUsed = false
    var wheelSelection: Int?
    var gyro = false
    var lastGyroLog = 0.0
    var touchButton: GCControllerButtonInput?
    var primary: GCControllerDirectionPad?
    var secondary: GCControllerDirectionPad?
    var lastPrimary: (x: Float, y: Float, t: Double)?
    var gestureStart: (x: Float, y: Float, t: Double)?
    var gestureLast: (x: Float, y: Float)?
    var triggerArmed: Bool?

    init(controller: GCController, pad: GCExtendedGamepad) { self.controller = controller; self.pad = pad }

    var adaptiveR2: GCDualSenseAdaptiveTrigger? { (pad as? GCDualSenseGamepad)?.rightTrigger }
    var secondaryTouching: Bool {
        guard let s = secondary else { return false }
        return s.xAxis.value != 0 || s.yAxis.value != 0
    }
}

final class PadCoder {
    let config = Config()
    let mouse = Mouse()
    let model = LiveModel.shared
    lazy var overlay = Overlay()
    private(set) var paused = false
    var onPauseChange: ((Bool) -> Void)?

    /// Bug Dash; while its window is in front the pad plays the game instead of typing.
    weak var game: GameWindowController?
    private var gameFocused: Bool { game?.isFocused ?? false }
    private var gameHeld: Set<String> = []

    /// While the PadCoder window is in front, the pad only lights up the drawing.
    private var previewing: Bool { model.windowVisible && NSApp.isActive && !gameFocused }
    private var lastBatteryAt = 0.0

    private var pads: [ObjectIdentifier: PadState] = [:]
    private var held: [String: String] = [:]                     // "<pad>-<button>" -> action being held
    private var repeaters: [String: (combo: KeyCombo, next: Double)] = [:]
    private var state: ClaudeState = .idle
    private var pending: Pending?
    private var lastTick = CACurrentMediaTime()
    private var lastLight: (Float, Float, Float) = (-1, -1, -1)
    private var notifyTokens: [Int32] = []

    // MARK: Lifecycle

    func start() {
        GCController.shouldMonitorBackgroundEvents = true
        NotificationCenter.default.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] n in
            if let c = n.object as? GCController { self?.attach(c) }
        }
        NotificationCenter.default.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] n in
            if let c = n.object as? GCController { self?.detach(c) }
        }
        GCController.controllers().forEach(attach)
        watchFiles()

        // Signals from Claude Code hooks (see README) or `notifyutil -p <name>`.
        let signals: [(String, (PadCoder) -> Void)] = [
            ("com.padcoder.working", { $0.signalWorking() }),
            ("com.padcoder.buzz", { $0.setState(.done); $0.rumbleAll(pulses: 1) }),
            ("com.padcoder.attention", { $0.setState(.needsYou); $0.rumbleAll(pulses: 3) }),
            ("com.padcoder.request", { $0.loadPendingRequest() }),
        ]
        for (name, handler) in signals {
            var token: Int32 = 0
            notify_register_dispatch(name, &token, .main) { [weak self] _ in
                guard let self else { return }
                if name != "com.padcoder.working" { log("signal \(name.split(separator: ".").last ?? "")") }
                handler(self)
            }
            notifyTokens.append(token)
        }
        model.onTogglePause = { [weak self] in self?.togglePause() }
        model.onTestRumble = { [weak self] in self?.rumbleAll(pulses: 2) }
        model.onTestLight = { [weak self] in
            self?.lightTestUntil = CACurrentMediaTime() + 2.5
            self?.refreshLight()
        }
        model.onTriggerTest = { [weak self] name, on in self?.triggerTest(name, on) }
        model.onWindowShown = { [weak self] in
            self?.refreshLight()
            self?.liveChanged()
        }
        config.onReload { [weak self] in
            self?.refreshLight()
            self?.refreshActiveFlag()
        }
        refreshActiveFlag()
        refreshLight()
    }

    private var lightTestUntil = 0.0

    /// Settings-window test: makes the shown DualSense's trigger push back.
    private func triggerTest(_ name: String, _ on: Bool) {
        guard let id = model.shown?.id, let ps = pads[id], let ds = ps.pad as? GCDualSenseGamepad else { return }
        let trigger = name == "l2" ? ds.leftTrigger : ds.rightTrigger
        if on {
            trigger.setModeFeedbackWithStartPosition(0.1, resistiveStrength: 0.85)
        } else {
            trigger.setModeOff()
            if name == "r2" { ps.triggerArmed = nil; updateTriggers() }
        }
        log("trigger test \(name) \(on ? "on" : "off")")
    }

    /// On quit: let go of anything held and hand every waiting request back to Claude's dialog.
    func shutdown() {
        shuttingDown = true
        pads.values.forEach(releaseInputs)
        mouse.releaseLeft()
        releaseAllRequests()
        try? FileManager.default.removeItem(at: activeFlagURL)
    }

    private var shuttingDown = false

    private func attach(_ c: GCController) {
        let id = ObjectIdentifier(c)
        guard pads[id] == nil else { return }
        guard let pad = c.extendedGamepad else {
            log("ignored controller without extended profile: \(c.vendorName ?? "?")"); return
        }
        let ps = PadState(controller: c, pad: pad)
        pads[id] = ps
        model.pads.append(PadInfo(id: id, name: c.vendorName ?? "Controller", kind: PadKind(pad),
                                  battery: c.battery?.batteryLevel, charging: c.battery?.batteryState == .charging))
        if model.shownPad == nil { model.shownPad = id }
        log("connected: \(c.vendorName ?? "?") [\(c.productCategory)] \(type(of: pad)), motion: \(c.motion != nil)")

        pad.buttonOptions?.preferredSystemGestureState = .disabled   // Share/Create: don't screenshot

        func bind(_ el: GCControllerButtonInput?, _ name: String) {
            el?.pressedChangedHandler = { [weak self, weak ps] _, _, pressed in
                guard let self, let ps else { return }
                self.button(name, pressed, ps)
            }
        }
        bind(pad.buttonA, "cross"); bind(pad.buttonB, "circle"); bind(pad.buttonX, "square"); bind(pad.buttonY, "triangle")
        bind(pad.dpad.up, "up"); bind(pad.dpad.down, "down"); bind(pad.dpad.left, "left"); bind(pad.dpad.right, "right")
        bind(pad.rightShoulder, "r1"); bind(pad.rightTrigger, "r2"); bind(pad.leftTrigger, "l2")
        bind(pad.leftThumbstickButton, "l3"); bind(pad.rightThumbstickButton, "r3")
        bind(pad.buttonMenu, "options"); bind(pad.buttonOptions, "create")
        pad.leftShoulder.pressedChangedHandler = { [weak self, weak ps] _, _, pressed in
            guard let self, let ps else { return }
            self.l1(pressed, ps)
        }

        // Touchpad (DualSense and DualShock 4)
        if let ds = pad as? GCDualSenseGamepad {
            (ps.touchButton, ps.primary, ps.secondary) = (ds.touchpadButton, ds.touchpadPrimary, ds.touchpadSecondary)
        } else if let ds = pad as? GCDualShockGamepad {
            (ps.touchButton, ps.primary, ps.secondary) = (ds.touchpadButton, ds.touchpadPrimary, ds.touchpadSecondary)
        }
        bind(ps.touchButton, "touchpad")
        ps.primary?.valueChangedHandler = { [weak self, weak ps] _, x, y in
            guard let self, let ps else { return }
            self.primaryTouch(x, y, ps)
            self.liveChanged()
        }
        ps.secondary?.valueChangedHandler = { [weak self, weak ps] _, x, y in
            guard let self, let ps else { return }
            self.secondaryTouch(x, y, ps)
            self.liveChanged()
        }
        // Sticks and triggers report changes; the input loop only runs while they need it.
        pad.leftThumbstick.valueChangedHandler = { [weak self] _, _, _ in self?.inputChanged() }
        pad.rightThumbstick.valueChangedHandler = { [weak self] _, _, _ in self?.inputChanged() }
        pad.leftTrigger.valueChangedHandler = { [weak self] _, _, _ in self?.liveChanged() }
        pad.rightTrigger.valueChangedHandler = { [weak self] _, _, _ in self?.liveChanged() }

        ps.engine = c.haptics?.createEngine(withLocality: .default)
        ps.engine?.isAutoShutdownEnabled = true   // the motors' engine powers down between rumbles
        if let e = ps.engine { rumble(e, pulses: 1) }
        refreshLight()
        updateTriggers()
        refreshActiveFlag()
    }

    private func detach(_ c: GCController) {
        log("disconnected: \(c.vendorName ?? "?")")
        let id = ObjectIdentifier(c)
        if let ps = pads[id] { releaseInputs(of: ps) }
        pads[id] = nil
        model.pads.removeAll { $0.id == id }
        if model.shownPad == id { model.shownPad = model.pads.first?.id }
        refreshActiveFlag()
    }

    /// Lets go of everything a pad is holding (keys, repeats, mouse drag, gyro, wheel), e.g. when it disconnects.
    private func releaseInputs(of ps: PadState) {
        let prefix = "\(ObjectIdentifier(ps))-"
        for (slot, action) in held where slot.hasPrefix(prefix) {
            held[slot] = nil
            perform(action, down: false, slot: slot, ps: ps)
        }
        repeaters = repeaters.filter { !$0.key.hasPrefix(prefix) }
        if ps.gyro { setGyro(false, ps) }
        if ps.l1DownAt != nil, overlay.mode.name == "wheel" { overlay.show(.hidden) }
        ps.l1DownAt = nil
        ps.wheelSelection = nil
    }

    // MARK: Buttons

    private func button(_ name: String, _ pressed: Bool, _ ps: PadState) {
        let slot = "\(ObjectIdentifier(ps))-\(name)"
        showLive(name, pressed, ps)
        if pressed {
            log("press \(name)")
            if previewing { return }
            if let p = pending, approvalsActive, let decision = ["cross": "allow", "circle": "deny", "triangle": "dialog"][name] {
                decide(decision, p)
                held[slot] = "none"
                return
            }
            var action = config.action(name, layer: false) ?? "none"
            if ps.pad.leftShoulder.isPressed, let layered = config.action(name, layer: true), !layered.isEmpty {
                action = layered
                ps.layerUsed = true
                if overlay.mode.name == "wheel" { overlay.show(.hidden) }
            }
            if gameFocused && action != "game" {
                gameHeld.insert(slot)
                game?.press(name, true)
                return
            }
            if paused && action != "pause" && action != "game" { return }
            held[slot] = action
            perform(action, down: true, slot: slot, ps: ps)
        } else if gameHeld.remove(slot) != nil {
            game?.press(name, false)
        } else if let action = held.removeValue(forKey: slot) {
            perform(action, down: false, slot: slot, ps: ps)   // releases always pass, so nothing sticks
        }
    }

    private func perform(_ action: String, down: Bool, slot: String, ps: PadState) {
        switch action {
        case "none", "": return
        case "leftClick": mouse.left(down, source: slot)
        case "rightClick": mouse.right(down)
        case "gyro": setGyro(down, ps)
        case "dictation": if down { toggleDictation() }
        case "pause": if down { togglePause() }
        case "game": if down { game?.toggle() }
        default:
            if action.hasPrefix("send:") || action.hasPrefix("type:") {
                if down { typeText(String(action.dropFirst(5)), thenReturn: action.hasPrefix("send:")) }
                return
            }
            guard let combo = parseCombo(action) else {
                if down { log("unknown action '\(action)'") }
                return
            }
            if repeatableKeys.contains(combo.code) {
                if down {
                    tapKey(combo)
                    repeaters[slot] = (combo, CACurrentMediaTime() + repeatDelay)
                    wakeLoop()
                } else {
                    repeaters[slot] = nil
                }
            } else {
                postKey(combo, down: down)   // held like a real key, so hold-to-talk shortcuts work
            }
        }
    }

    // MARK: L1 layer and prompt wheel

    private func showLive(_ name: String, _ pressed: Bool, _ ps: PadState) {
        let id = ObjectIdentifier(ps.controller)
        if pressed && model.shownPad != id { model.shownPad = id; model.pressed = [] }   // show the pad in use
        guard model.shownPad == id else { return }
        if pressed { model.pressed.insert(name) } else { model.pressed.remove(name) }
    }

    private func l1(_ pressed: Bool, _ ps: PadState) {
        showLive("l1", pressed, ps)
        if pressed {
            log("press l1")
            ps.l1DownAt = previewing || gameFocused ? nil : CACurrentMediaTime()
            if ps.l1DownAt != nil { wakeLoop() }   // the wheel follows the right stick
            ps.layerUsed = false
            ps.wheelSelection = nil
            return
        }
        if overlay.mode.name == "wheel" {
            let items = config.wheel
            if let sel = ps.wheelSelection, sel < items.count, !items[sel].isEmpty, !paused, !previewing {
                log("wheel send \(sel): \(items[sel])")
                typeText(items[sel], thenReturn: true)
            } else {
                log("wheel cancelled")
            }
            overlay.show(.hidden)
        }
        ps.l1DownAt = nil
        ps.wheelSelection = nil
    }

    private func updateWheel(_ ps: PadState, _ x: Float, _ y: Float, _ now: Double) {
        guard pending == nil, !ps.layerUsed, let downAt = ps.l1DownAt else { return }
        let items = config.wheel
        let pushed = hypot(x, y) > 0.5
        guard !items.isEmpty, overlay.mode.name == "wheel" || pushed || now - downAt > 0.3 else { return }
        var sel: Int?
        if pushed {
            var deg = atan2(Double(x), Double(y)) * 180 / .pi    // 0 = up, clockwise
            if deg < 0 { deg += 360 }
            let i = Int((deg + 22.5) / 45) % 8
            sel = i < items.count && !items[i].isEmpty ? i : nil
        }
        if let sel, sel != ps.wheelSelection { log("wheel select \(sel)") }
        ps.wheelSelection = sel
        overlay.show(.wheel(items: items, selected: sel))
    }

    // MARK: Per-frame

    private func curve(_ v: Float, _ deadzone: Float) -> Double {
        let m = abs(v)
        guard m > deadzone else { return 0 }
        let n = Double((m - deadzone) / (1 - deadzone))
        return pow(n, 2.2) * (v < 0 ? -1 : 1)
    }

    // MARK: Input loop
    // The 120 Hz loop only runs while a stick is pushed, a key repeats, gyro aims or the wheel is up.
    // Everything else is event-driven, so an idle PadCoder doesn't wake the CPU.

    private var loopTimer: Timer?
    private var loopIdleSince: Double?

    private func wakeLoop() {
        guard loopTimer == nil else { return }
        lastTick = CACurrentMediaTime()
        loopIdleSince = nil
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.tick() }
        timer.tolerance = 0.002
        RunLoop.main.add(timer, forMode: .common)
        loopTimer = timer
    }

    private var loopNeeded: Bool {
        if !repeaters.isEmpty { return true }
        let deadzone = Float(config.double("stickDeadzone", 0.12))
        let leftOn = config.string("leftStick", "mouse") != "off"
        let rightOn = config.string("rightStick", "scroll") != "off"
        return pads.values.contains { ps in
            ps.gyro || ps.l1DownAt != nil
                || (leftOn && hypot(ps.pad.leftThumbstick.xAxis.value, ps.pad.leftThumbstick.yAxis.value) > deadzone)
                || (rightOn && hypot(ps.pad.rightThumbstick.xAxis.value, ps.pad.rightThumbstick.yAxis.value) > deadzone)
        }
    }

    /// Sticks and triggers moved: wake the loop if it's needed, and refresh the window's drawing.
    private func inputChanged() {
        if loopTimer == nil && loopNeeded { wakeLoop() }
        liveChanged()
    }

    private func sleepLoopIfIdle(_ now: Double) {
        if loopNeeded {
            loopIdleSince = nil
        } else if let since = loopIdleSince {
            if now - since > 0.3 {
                loopTimer?.invalidate()
                loopTimer = nil
                loopIdleSince = nil
            }
        } else {
            loopIdleSince = now
        }
    }

    private func tick() {
        let now = CACurrentMediaTime()
        let dt = min(now - lastTick, 0.05)
        lastTick = now
        defer { sleepLoopIfIdle(now) }
        guard !paused, !previewing, !gameFocused else { return }

        let deadzone = Float(config.double("stickDeadzone", 0.12))
        let mouseSpeed = config.double("mouseSpeed", 1900)
        let scrollSpeed = config.double("scrollSpeed", 2400)
        let invert = config.bool("invertScroll", false) ? -1.0 : 1.0
        // What moving each stick does: "mouse", "scroll" or "off".
        func drive(_ mode: String, _ x: Float, _ y: Float) {
            let cx = curve(x, deadzone), cy = curve(y, deadzone)
            guard cx != 0 || cy != 0 else { return }
            switch mode {
            case "mouse": mouse.move(dx: cx * mouseSpeed * dt, dy: -cy * mouseSpeed * dt)
            case "scroll": mouse.scroll(dx: -cx * scrollSpeed * dt * invert, dy: cy * scrollSpeed * dt * invert)
            default: break
            }
        }
        let leftMode = config.string("leftStick", "mouse"), rightMode = config.string("rightStick", "scroll")
        for ps in pads.values {
            let pad = ps.pad
            drive(leftMode, pad.leftThumbstick.xAxis.value, pad.leftThumbstick.yAxis.value)

            let rx = pad.rightThumbstick.xAxis.value, ry = pad.rightThumbstick.yAxis.value
            if ps.l1DownAt != nil {
                updateWheel(ps, rx, ry, now)                 // right stick aims the wheel while L1 is held
            } else {
                drive(rightMode, rx, ry)
            }
            if ps.gyro { applyGyro(ps, dt, now) }
        }

        for (slot, r) in repeaters where now >= r.next {
            tapKey(r.combo)
            repeaters[slot] = (r.combo, r.next + repeatInterval)
        }
    }

    private var liveUpdateQueued = false

    /// Coalesces drawing updates for the PadCoder window to at most 30 a second, and only while it's open.
    func liveChanged() {
        guard model.windowVisible, !liveUpdateQueued else { return }
        liveUpdateQueued = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 30) { [weak self] in
            guard let self else { return }
            self.liveUpdateQueued = false
            self.updateLiveModel(CACurrentMediaTime())
        }
    }

    private func updateLiveModel(_ now: Double) {
        guard let id = model.shown?.id, let ps = pads[id] else { return }
        let pad = ps.pad
        // Rounded, with resting jitter dropped, so a still stick doesn't keep redrawing the window.
        func q(_ v: Float) -> CGFloat { abs(v) < 0.03 ? 0 : (CGFloat(v) * 100).rounded() / 100 }
        func pt(_ d: GCControllerDirectionPad) -> CGPoint { CGPoint(x: q(d.xAxis.value), y: q(d.yAxis.value)) }
        let left = pt(pad.leftThumbstick), right = pt(pad.rightThumbstick)
        if left != model.leftStick { model.leftStick = left }
        if right != model.rightStick { model.rightStick = right }
        let l2 = q(pad.leftTrigger.value), r2 = q(pad.rightTrigger.value)
        if l2 != model.l2 { model.l2 = l2 }
        if r2 != model.r2 { model.r2 = r2 }
        let touches = [ps.primary, ps.secondary].compactMap { $0 }.map(pt).filter { $0 != .zero }
        if touches != model.touches { model.touches = touches }
        if now - lastBatteryAt > 5, let i = model.pads.firstIndex(where: { $0.id == id }) {
            lastBatteryAt = now
            let level = ps.controller.battery?.batteryLevel
            let charging = ps.controller.battery?.batteryState == .charging
            if model.pads[i].battery != level || model.pads[i].charging != charging {
                model.pads[i].battery = level
                model.pads[i].charging = charging
            }
        }
    }

    // MARK: File watching (instead of polling)

    private var watchers: [DispatchSourceFileSystemObject] = []
    private var pendingTimer: Timer?

    /// Reacts to config saves and approval requests as they land on disk, with a slow safety net
    /// for edits a directory watch can miss (an editor writing a file in place).
    private func watchFiles() {
        for dir in [supportDir, requestsDir] {
            let fd = open(dir.path, O_EVTONLY)
            guard fd >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: .main)
            source.setEventHandler { [weak self] in self?.filesChanged() }
            source.setCancelHandler { close(fd) }
            source.resume()
            watchers.append(source)
        }
        let net = Timer(timeInterval: 10, repeats: true) { [weak self] _ in self?.filesChanged() }
        net.tolerance = 5
        RunLoop.main.add(net, forMode: .common)
    }

    private func filesChanged() {
        config.reload()   // reload handlers refresh the light and the approvals flag
        checkPending()
    }

    /// The countdown on the approval panel needs a tick only while a request is showing.
    private func setPendingTimer(_ on: Bool) {
        if on, pendingTimer == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.checkPending() }
            timer.tolerance = 0.2
            RunLoop.main.add(timer, forMode: .common)
            pendingTimer = timer
        } else if !on {
            pendingTimer?.invalidate()
            pendingTimer = nil
        }
    }

    private func checkPending() {
        if let p = pending {
            let file = requestsDir.appendingPathComponent("\(p.id).json")
            if !FileManager.default.fileExists(atPath: file.path) || !requestIsLive(p) {
                log("approval \(p.id): timed out or answered elsewhere")
                try? FileManager.default.removeItem(at: file)
                clearPending()
            } else {
                overlay.show(approvalMode(p))   // refresh the countdown
            }
        } else if approvalsActive {
            loadPendingRequest()               // in case a request signal was missed
        }
    }

    // MARK: Gyro

    private func setGyro(_ on: Bool, _ ps: PadState) {
        ps.gyro = on
        if let m = ps.controller.motion, m.sensorsRequireManualActivation { m.sensorsActive = on }
        if on { wakeLoop() }
        log("gyro \(on ? "on" : "off") (motion: \(ps.controller.motion != nil), rotation rate: \(ps.controller.motion?.hasRotationRate ?? false))")
    }

    private func applyGyro(_ ps: PadState, _ dt: Double, _ now: Double) {
        guard let m = ps.controller.motion, m.hasRotationRate else { return }
        let r = m.rotationRate
        if now - ps.lastGyroLog > 0.5 {
            ps.lastGyroLog = now
            log(String(format: "gyro raw x=%.2f y=%.2f z=%.2f", r.x, r.y, r.z))
        }
        let g = config.section("gyro")
        let sens = num(g, "sensitivity", 900)
        let horizontal = (g["horizontalAxis"] as? String) == "z" ? r.z : r.y
        func dz(_ v: Double) -> Double { abs(v) < 0.03 ? 0 : v }
        let dx = -dz(horizontal) * sens * dt * ((g["invertX"] as? Bool) == true ? -1 : 1)
        let dy = -dz(r.x) * sens * dt * ((g["invertY"] as? Bool) == true ? -1 : 1)
        if dx != 0 || dy != 0 { mouse.move(dx: dx, dy: dy) }
    }

    // MARK: Touchpad

    private func primaryTouch(_ x: Float, _ y: Float, _ ps: PadState) {
        let now = CACurrentMediaTime()
        if paused || previewing || gameFocused || (x == 0 && y == 0) { ps.lastPrimary = nil; return }   // (0,0) = finger lifted
        defer { ps.lastPrimary = (x, y, now) }
        if ps.gestureStart != nil { ps.gestureLast = (x, y) }
        guard let l = ps.lastPrimary, now - l.t < 0.08 else { return }
        let dx = x - l.x, dy = y - l.y
        guard abs(dx) < 0.5 && abs(dy) < 0.5 else { return }
        let tp = config.section("touchpad")
        if ps.secondaryTouching {
            let invert = config.bool("invertScroll", false) ? -1.0 : 1.0
            mouse.scroll(dx: 0, dy: -Double(dy) * num(tp, "scrollScale", 1400) * invert)   // two fingers scroll
        } else {
            let k = num(tp, "scale", 750)
            mouse.move(dx: Double(dx) * k, dy: Double(-dy) * k)
        }
    }

    private func secondaryTouch(_ x: Float, _ y: Float, _ ps: PadState) {
        let now = CACurrentMediaTime()
        let touching = x != 0 || y != 0
        if touching, ps.gestureStart == nil, let p = ps.lastPrimary {
            ps.gestureStart = (p.x, p.y, now)
            ps.gestureLast = (p.x, p.y)
        } else if !touching, let s = ps.gestureStart {
            ps.gestureStart = nil
            guard !paused, !previewing, !gameFocused, let e = ps.gestureLast else { return }
            let dx = e.x - s.x, dy = e.y - s.y
            guard now - s.t < 0.5, abs(dx) > 0.6, abs(dx) > 2 * abs(dy) else { return }
            let key = dx < 0 ? "swipeLeft" : "swipeRight"
            let action = config.section("touchpad")[key] as? String ?? "none"
            log("\(key) -> \(action)")
            perform(action, down: true, slot: "swipe", ps: ps)
            perform(action, down: false, slot: "swipe", ps: ps)
        }
    }

    // MARK: Claude state, light bar, triggers

    /// Hook signals carry no request identity, so they never dismiss a pending approval; a request
    /// ends when its hook process exits or its deadline passes (see `requestIsLive`).
    private func signalWorking() {
        if pending == nil { setState(.working) }
    }

    private var doneWork: DispatchWorkItem?

    private func setState(_ s: ClaudeState) {
        if s == .done {
            // The green "finished" light fades back to idle after a moment.
            doneWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                if self?.state == .done { self?.setState(.idle) }
            }
            doneWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
        }
        guard s != state else { return }
        log("state \(state) -> \(s)")
        state = s
        model.claudeState = s
        updateTriggers()
        refreshLight()
        if s == .done || s == .needsYou { game?.claudeNeedsAttention(finished: s == .done) }
    }

    /// Short rumbles for Bug Dash moments.
    func gameHaptic(_ event: RunnerEvent) {
        let (intensity, sharpness, duration, count): (Float, Float, Double, Int)
        switch event {
        case .start: (intensity, sharpness, duration, count) = (0.5, 0.4, 0.08, 1)
        case .jump: (intensity, sharpness, duration, count) = (0.35, 0.8, 0.04, 1)
        case .token: (intensity, sharpness, duration, count) = (0.25, 1.0, 0.025, 1)
        case .dash: (intensity, sharpness, duration, count) = (0.75, 0.3, 0.16, 1)
        case .smash: (intensity, sharpness, duration, count) = (0.9, 0.9, 0.06, 1)
        case .hit: (intensity, sharpness, duration, count) = (1.0, 0.2, 0.22, 2)
        }
        for engine in pads.values.compactMap(\.engine) {
            do {
                try engine.start()
                let events = (0..<count).map { i in
                    CHHapticEvent(eventType: .hapticContinuous,
                                  parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                                               CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)],
                                  relativeTime: Double(i) * (duration + 0.08), duration: duration)
                }
                try engine.makePlayer(with: CHHapticPattern(events: events, parameters: [])).start(atTime: CHHapticTimeImmediate)
            } catch {
                log("rumble failed: \(error)")
            }
        }
    }

    private func lightColor(_ now: Double) -> (Float, Float, Float) {
        if now < lightTestUntil {
            let c = NSColor(hue: CGFloat(now.truncatingRemainder(dividingBy: 1.2) / 1.2), saturation: 1, brightness: 1, alpha: 1)
            return (Float(c.redComponent), Float(c.greenComponent), Float(c.blueComponent))
        }
        if paused { return (0.08, 0.08, 0.12) }
        func pulse(_ period: Double, _ low: Double) -> Float {
            Float(low + (1 - low) * (0.5 + 0.5 * sin(2 * .pi * now / period)))
        }
        switch state {
        case .working: return (0.15, 0.35, 1.0)   // steady: no Bluetooth chatter while Claude works
        case .needsYou: let k = pulse(0.8, 0.2); return (1.0 * k, 0.08 * k, 0.05 * k)
        case .done: return (0.1, 0.9, 0.3)
        case .idle: return (0.85, 0.47, 0.34)
        }
    }

    private var lightTimer: Timer?

    /// Only "needs you" and the light test animate; every other state is one write to the pad.
    private var lightAnimating: Bool {
        CACurrentMediaTime() < lightTestUntil || (!paused && state == .needsYou)
    }

    private func refreshLight() {
        applyLight(force: true)
        if lightAnimating, lightTimer == nil {
            let timer = Timer(timeInterval: 1.0 / 12, repeats: true) { [weak self] _ in self?.lightFrame() }
            timer.tolerance = 0.02
            RunLoop.main.add(timer, forMode: .common)
            lightTimer = timer
        }
    }

    private func lightFrame() {
        if lightAnimating {
            applyLight(force: false)
        } else {
            lightTimer?.invalidate()
            lightTimer = nil
            applyLight(force: true)
        }
    }

    private func applyLight(force: Bool) {
        let c = lightColor(CACurrentMediaTime())
        guard force || abs(c.0 - lastLight.0) + abs(c.1 - lastLight.1) + abs(c.2 - lastLight.2) > 0.03 else { return }
        lastLight = c
        let color = GCColor(red: c.0, green: c.1, blue: c.2)
        for ps in pads.values { ps.controller.light?.color = color }
        if model.windowVisible { model.light = Color(red: Double(c.0), green: Double(c.1), blue: Double(c.2)) }
    }

    /// DualSense only: R2 gets a click-like resistance while Claude is waiting on you.
    private func updateTriggers() {
        let armed = !paused && (state == .needsYou || pending != nil)
        for ps in pads.values where ps.triggerArmed != armed {
            guard let trigger = ps.adaptiveR2, !model.triggerTests.contains("r2") else { continue }
            if armed {
                trigger.setModeWeaponWithStartPosition(0.15, endPosition: 0.55, resistiveStrength: 0.9)
            } else {
                trigger.setModeOff()
            }
            ps.triggerArmed = armed
            log("adaptive trigger \(armed ? "on" : "off")")
        }
    }

    // MARK: Approvals

    /// Pad approvals only run while a pad is connected, PadCoder isn't paused and the setting is on.
    private var approvalsActive: Bool { !shuttingDown && !paused && !pads.isEmpty && config.bool("padApprovals", true) }

    /// The PermissionRequest hook only waits for the pad while this file exists.
    private func refreshActiveFlag() {
        let active = approvalsActive
        let fm = FileManager.default
        let exists = fm.fileExists(atPath: activeFlagURL.path)
        if active && !exists {
            fm.createFile(atPath: activeFlagURL.path, contents: Data())
            log("pad approvals: on")
        } else if !active && exists {
            try? fm.removeItem(at: activeFlagURL)
            log("pad approvals: off")
        }
        if !active { releaseAllRequests() }
    }

    /// Hands the current and every queued request back to Claude's own dialog.
    private func releaseAllRequests() {
        if let p = pending { decide("dialog", p) }
        let fm = FileManager.default
        for file in (try? fm.contentsOfDirectory(at: requestsDir, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension == "json" {
            let decision = file.deletingPathExtension().appendingPathExtension("decision")
            if !fm.fileExists(atPath: decision.path) { try? "dialog".write(to: decision, atomically: true, encoding: .utf8) }
        }
    }

    /// A request is live while its hook process is still waiting and its deadline hasn't passed.
    private func requestIsLive(_ p: Pending) -> Bool {
        let hookAlive = p.hookPID <= 0 || kill(p.hookPID, 0) == 0 || errno == EPERM
        return hookAlive && p.deadline.timeIntervalSinceNow > -2
    }

    private func loadPendingRequest() {
        guard pending == nil, approvalsActive else { return }
        let fm = FileManager.default
        let files = ((try? fm.contentsOfDirectory(at: requestsDir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for file in files {
            let id = file.deletingPathExtension().lastPathComponent
            let decisionFile = requestsDir.appendingPathComponent("\(id).decision")
            guard let raw = try? Data(contentsOf: file),
                  let obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else { continue }
            let tool = obj["tool"] as? String ?? "a tool"
            let created = (obj["created"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970
            let timeout = (obj["timeout"] as? NSNumber)?.doubleValue ?? config.double("approvalTimeout", 20)
            let p = Pending(id: id, tool: tool, summary: summarize(obj["input"] as? [String: Any] ?? [:], tool),
                            deadline: Date(timeIntervalSince1970: created + timeout),
                            hookPID: (obj["pid"] as? NSNumber)?.int32Value ?? 0)
            guard requestIsLive(p) else {
                log("approval \(id): discarding stale request")
                try? fm.removeItem(at: file)
                try? fm.removeItem(at: decisionFile)
                continue
            }
            if fm.fileExists(atPath: decisionFile.path) { continue }   // answered, hook is wrapping up
            pending = p
            setPendingTimer(true)
            log("approval request \(id): \(tool)")
            setState(.needsYou)
            rumbleAll(pulses: 3)
            overlay.show(approvalMode(p))
            updateTriggers()
            return
        }
    }

    private func summarize(_ input: [String: Any], _ tool: String) -> String {
        for key in ["command", "file_path", "notebook_path", "url", "pattern", "path", "query", "description"] {
            if let v = input[key] as? String, !v.isEmpty { return String(v.prefix(400)) }
        }
        if let d = try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]),
           let s = String(data: d, encoding: .utf8) { return String(s.prefix(400)) }
        return tool
    }

    private func approvalMode(_ p: Pending) -> Overlay.Mode {
        .approval(tool: p.tool, summary: p.summary, secondsLeft: max(0, Int(p.deadline.timeIntervalSinceNow.rounded(.up))))
    }

    private func decide(_ decision: String, _ p: Pending) {
        try? decision.write(to: requestsDir.appendingPathComponent("\(p.id).decision"), atomically: true, encoding: .utf8)
        log("approval \(p.id): \(decision)")
        if decision != "dialog" { setState(.working) }
        clearPending()   // may load the next queued request, which sets needsYou again
    }

    private func clearPending() {
        pending = nil
        setPendingTimer(false)
        if overlay.mode.name == "approval" { overlay.show(.hidden) }
        updateTriggers()
        loadPendingRequest()   // next queued request, if any
    }

    // MARK: Pause and rumble

    func togglePause() {
        paused.toggle()
        repeaters.removeAll()
        mouse.releaseLeft()
        if paused, overlay.mode.name == "wheel" { overlay.show(.hidden) }
        log(paused ? "paused" : "resumed")
        model.paused = paused
        refreshLight()
        updateTriggers()
        refreshActiveFlag()
        rumbleAll(pulses: paused ? 2 : 1)
        onPauseChange?(paused)
    }

    func rumbleAll(pulses: Int) { pads.values.compactMap(\.engine).forEach { rumble($0, pulses: pulses) } }

    private func rumble(_ engine: CHHapticEngine, pulses: Int) {
        do {
            try engine.start()
            let events = (0..<pulses).map { i in
                CHHapticEvent(eventType: .hapticContinuous,
                              parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.9),
                                           CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5)],
                              relativeTime: Double(i) * 0.2, duration: 0.12)
            }
            try engine.makePlayer(with: CHHapticPattern(events: events, parameters: [])).start(atTime: CHHapticTimeImmediate)
        } catch {
            log("rumble failed: \(error)")
        }
    }
}
