// Posting keyboard and mouse events, plus logging and macOS dictation.

import AppKit
import ApplicationServices

// MARK: - Logging

let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/PadCoder.log")

func log(_ msg: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date()))  \(msg)\n"
    if let h = try? FileHandle(forWritingTo: logURL) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close()
    } else {
        try? line.write(to: logURL, atomically: true, encoding: .utf8)
    }
}

// MARK: - Keys

let eventSource = CGEventSource(stateID: .hidSystemState)
let repeatDelay = 0.35
let repeatInterval = 0.045

struct KeyCombo { let code: CGKeyCode; let flags: CGEventFlags }

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
    "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

/// Keys that auto-repeat while their button is held, like holding the real key.
let repeatableKeys: Set<CGKeyCode> = [51, 117, 116, 121, 123, 124, 125, 126]

func parseCombo(_ text: String) -> KeyCombo? {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for part in text.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        switch part {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "opt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: key = keyCodes[part]
        }
    }
    return key.map { KeyCombo(code: $0, flags: flags) }
}

func postKey(_ combo: KeyCombo, down: Bool) {
    let e = CGEvent(keyboardEventSource: eventSource, virtualKey: combo.code, keyDown: down)
    e?.flags = combo.flags
    e?.post(tap: .cghidEventTap)
}

func tapKey(_ combo: KeyCombo) {
    postKey(combo, down: true)
    postKey(combo, down: false)
}

let returnKey = KeyCombo(code: 36, flags: [])

/// When the text already queued finishes typing; new text starts after it so prompts never interleave.
private var typingDoneAt = DispatchTime.now()

/// Splits text into ≤16 UTF-16 unit chunks without cutting a character (emoji stay whole).
private func unicodeChunks(_ text: String) -> [[UInt16]] {
    var chunks: [[UInt16]] = []
    var current: [UInt16] = []
    for character in text {
        let units = Array(String(character).utf16)
        if !current.isEmpty && current.count + units.count > 16 {
            chunks.append(current)
            current = []
        }
        current += units
    }
    if !current.isEmpty { chunks.append(current) }
    return chunks
}

func typeText(_ text: String, thenReturn: Bool) {
    var at = max(DispatchTime.now(), typingDoneAt)
    for chunk in unicodeChunks(text) {
        DispatchQueue.main.asyncAfter(deadline: at) {
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down)
                e?.flags = []
                chunk.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                e?.post(tap: .cghidEventTap)
            }
        }
        at = at + 0.015
    }
    if thenReturn {
        at = at + 0.08
        DispatchQueue.main.asyncAfter(deadline: at) { tapKey(returnKey) }
    }
    typingDoneAt = at + 0.05
}

// MARK: - Mouse

func cursorLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func desktopBounds() -> CGRect {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.map { CGDisplayBounds($0) }.reduce(CGRect.null) { $0.union($1) }
}

final class Mouse {
    /// Every button currently holding the left button down (R2 and the touchpad can overlap).
    private var leftSources: Set<String> = []
    var leftDown: Bool { !leftSources.isEmpty }
    private var moveAccum = CGVector(dx: 0, dy: 0)
    private var scrollAccum = CGVector(dx: 0, dy: 0)
    private var lastClick = (time: 0.0, point: CGPoint.zero, count: 1)

    func move(dx: Double, dy: Double) {
        moveAccum.dx += dx; moveAccum.dy += dy
        let ix = moveAccum.dx.rounded(.towardZero), iy = moveAccum.dy.rounded(.towardZero)
        guard ix != 0 || iy != 0 else { return }
        moveAccum.dx -= ix; moveAccum.dy -= iy
        let b = desktopBounds()
        var p = cursorLocation()
        p.x = min(max(p.x + ix, b.minX), b.maxX - 1)
        p.y = min(max(p.y + iy, b.minY), b.maxY - 1)
        let type: CGEventType = leftDown ? .leftMouseDragged : .mouseMoved
        CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
    }

    /// Presses on the first source down, releases when the last source lets go.
    func left(_ down: Bool, source: String) {
        let wasDown = leftDown
        if down { leftSources.insert(source) } else { leftSources.remove(source) }
        if leftDown != wasDown { postLeft(leftDown) }
    }

    func releaseLeft() {
        guard leftDown else { return }
        leftSources.removeAll()
        postLeft(false)
    }

    private func postLeft(_ down: Bool) {
        let p = cursorLocation()
        if down {
            let now = CACurrentMediaTime()
            let close = hypot(p.x - lastClick.point.x, p.y - lastClick.point.y) < 5
            let count = (now - lastClick.time < NSEvent.doubleClickInterval && close) ? lastClick.count + 1 : 1
            lastClick = (now, p, count)
        }
        let e = CGEvent(mouseEventSource: eventSource, mouseType: down ? .leftMouseDown : .leftMouseUp,
                        mouseCursorPosition: p, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(lastClick.count))
        e?.post(tap: .cghidEventTap)
    }

    func right(_ down: Bool) {
        CGEvent(mouseEventSource: eventSource, mouseType: down ? .rightMouseDown : .rightMouseUp,
                mouseCursorPosition: cursorLocation(), mouseButton: .right)?.post(tap: .cghidEventTap)
    }

    /// Positive dy scrolls up, positive dx scrolls left (pixel units).
    func scroll(dx: Double, dy: Double) {
        scrollAccum.dx += dx; scrollAccum.dy += dy
        let ix = scrollAccum.dx.rounded(.towardZero), iy = scrollAccum.dy.rounded(.towardZero)
        guard ix != 0 || iy != 0 else { return }
        scrollAccum.dx -= ix; scrollAccum.dy -= iy
        CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2,
                wheel1: Int32(iy), wheel2: Int32(ix), wheel3: 0)?.post(tap: .cghidEventTap)
    }
}

// MARK: - macOS dictation

/// Presses the frontmost app's "Start Dictation…" / "Stop Dictation" menu item through Accessibility.
func toggleDictation() {
    guard let app = NSWorkspace.shared.frontmostApplication else { return }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)

    func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }
    func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

    guard let barRef = attr(axApp, kAXMenuBarAttribute) else {
        log("dictation: no menu bar for \(app.localizedName ?? "?")"); return
    }
    let bar = barRef as! AXUIElement
    for barItem in children(bar) {
        for menu in children(barItem) {
            for item in children(menu) {
                let title = (attr(item, kAXTitleAttribute) as? String) ?? ""
                if title.localizedCaseInsensitiveContains("dictation") {
                    let err = AXUIElementPerformAction(item, kAXPressAction as CFString)
                    log("dictation: pressed '\(title)' in \(app.localizedName ?? "?") -> \(err.rawValue)")
                    return
                }
            }
        }
    }
    let menus = children(bar).compactMap { attr($0, kAXTitleAttribute) as? String }
    log("dictation: no Dictation item in \(app.localizedName ?? "?"); menus: \(menus)")
}
