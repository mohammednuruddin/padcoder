// Floating HUD for the prompt wheel and approval requests. Never takes focus, so keys
// PadCoder posts keep going to the app underneath.

import AppKit

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

let claudeOrange = NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 1)

final class Overlay {
    enum Mode: Equatable {
        case hidden
        case wheel(items: [String], selected: Int?)
        case approval(tool: String, summary: String, secondsLeft: Int)

        var name: String {
            switch self {
            case .hidden: return "hidden"
            case .wheel: return "wheel"
            case .approval: return "approval"
            }
        }
    }

    private let panel: OverlayPanel
    private let view = OverlayView()
    private(set) var mode: Mode = .hidden

    init() {
        panel = OverlayPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .screenSaver
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = view
    }

    func show(_ new: Mode) {
        guard new != mode else { return }
        let old = mode
        mode = new
        view.mode = new
        if new == .hidden {
            panel.orderOut(nil)
            log("overlay hidden")
            return
        }
        if old.name != new.name {
            let size = new.name == "wheel" ? NSSize(width: 460, height: 460) : NSSize(width: 580, height: 200)
            let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
            if let f = screen?.visibleFrame {
                let y = new.name == "wheel" ? f.midY - size.height / 2 : f.maxY - size.height - 40
                panel.setFrame(NSRect(x: f.midX - size.width / 2, y: y, width: size.width, height: size.height), display: false)
            }
        }
        view.needsDisplay = true
        if old == .hidden {
            panel.orderFrontRegardless()
            log("overlay shown (\(new.name)); frontmost app: \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")")
        }
    }
}

final class OverlayView: NSView {
    var mode: Overlay.Mode = .hidden
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        switch mode {
        case .hidden: return
        case let .wheel(items, selected): drawWheel(items, selected)
        case let .approval(tool, summary, secondsLeft): drawApproval(tool, summary, secondsLeft)
        }
    }

    private func text(_ s: String, size: CGFloat, color: NSColor = .white, bold: Bool = false,
                      mono: Bool = false, align: NSTextAlignment = .center) -> NSAttributedString {
        let p = NSMutableParagraphStyle()
        p.alignment = align
        p.lineBreakMode = .byWordWrapping
        let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
                        : NSFont.systemFont(ofSize: size, weight: bold ? .semibold : .regular)
        return NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: p])
    }

    /// Draws text vertically centred in `rect`, truncating what doesn't fit.
    private func put(_ s: NSAttributedString, in rect: NSRect, center: Bool = true) {
        let h = min(s.boundingRect(with: rect.size, options: [.usesLineFragmentOrigin]).height, rect.height)
        let r = center ? NSRect(x: rect.minX, y: rect.minY + (rect.height - h) / 2, width: rect.width, height: h) : rect
        s.draw(with: r, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    private func drawWheel(_ items: [String], _ selected: Int?) {
        NSColor(white: 0.08, alpha: 0.9).setFill()
        NSBezierPath(ovalIn: bounds.insetBy(dx: 8, dy: 8)).fill()
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        for (i, item) in items.enumerated() {
            let angle = CGFloat(i) * .pi / 4                      // 0 = top, clockwise
            let p = NSPoint(x: c.x + sin(angle) * 140, y: c.y - cos(angle) * 140)
            let box = NSRect(x: p.x - 62, y: p.y - 24, width: 124, height: 48)
            if i == selected {
                claudeOrange.setFill()
                NSBezierPath(roundedRect: box.insetBy(dx: -4, dy: -2), xRadius: 12, yRadius: 12).fill()
            }
            put(text(item, size: 12, bold: i == selected), in: box)
        }
        let title = selected.map { items[$0] } ?? "Point the right stick"
        put(text(title, size: 14, bold: true), in: NSRect(x: c.x - 80, y: c.y - 40, width: 160, height: 56))
        put(text("release L1 to send\ncenter the stick to cancel", size: 10, color: .lightGray),
            in: NSRect(x: c.x - 80, y: c.y + 18, width: 160, height: 30))
    }

    private func drawApproval(_ tool: String, _ summary: String, _ secondsLeft: Int) {
        let b = bounds.insetBy(dx: 8, dy: 8)
        let shape = NSBezierPath(roundedRect: b, xRadius: 16, yRadius: 16)
        NSColor(white: 0.08, alpha: 0.94).setFill()
        shape.fill()
        claudeOrange.setStroke()
        shape.lineWidth = 2
        shape.stroke()
        put(text("Claude wants to use \(tool)", size: 15, color: claudeOrange, bold: true, align: .left),
            in: NSRect(x: b.minX + 20, y: b.minY + 14, width: b.width - 40, height: 22), center: false)
        put(text(summary, size: 13, mono: true, align: .left),
            in: NSRect(x: b.minX + 20, y: b.minY + 44, width: b.width - 40, height: 84), center: false)
        put(text("✕ Approve     ○ Deny     △ Show the normal dialog          \(secondsLeft)s",
                 size: 13, color: .lightGray, align: .left),
            in: NSRect(x: b.minX + 20, y: b.maxY - 34, width: b.width - 40, height: 20), center: false)
    }
}
