// Offscreen renders of the window and HUD, so layout can be checked without screen access.

import AppKit
import SwiftUI

@MainActor
func renderSnapshots(to dir: URL) {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    let token = NSObject()
    let model = LiveModel()
    model.pressed = ["cross", "r1", "up"]
    model.selected = "l3"
    model.hovered = "square"
    model.leftStick = CGPoint(x: 0.7, y: 0.4)
    model.r2 = 0.6
    model.touches = [CGPoint(x: -0.3, y: 0.2)]
    model.claudeState = .working
    model.light = Color(red: 0.15, green: 0.35, blue: 1.0)
    let store = ConfigStore(config: Config())

    for kind in [PadKind.ps5, .ps4] {
        for shell in [Shell.white, .black] {
            model.pads = [PadInfo(id: ObjectIdentifier(token), name: "Wireless Controller", kind: kind, battery: 0.8, charging: false)]
            model.shownPad = ObjectIdentifier(token)
            let tag = "\(kind == .ps5 ? "ps5" : "ps4")-\(shell.rawValue)"
            let view = ControllerView(model: model, kind: kind, shell: shell, displayWidth: 900)
                .padding(20).background(Color(white: shell == .white ? 0.93 : 0.97))
            if let image = ImageRenderer(content: view).nsImage { saveImage(image, dir.appendingPathComponent("controller-\(tag).png")) }
        }
    }

    model.pads = [PadInfo(id: ObjectIdentifier(token), name: "Wireless Controller", kind: .ps5, battery: 0.8, charging: false)]
    let shots: [(Page, NSAppearance.Name, String)] = Page.allCases.map { ($0, .darkAqua, "") }
        + [(.buttons, .aqua, "-light"), (.wheel, .aqua, "-light")]
    for (page, appearance, suffix) in shots {
        NSApp.appearance = NSAppearance(named: appearance)
        let host = NSHostingView(rootView: SettingsView(model: model, store: store, page: page))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                              styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.contentView = host
        host.wantsLayer = true
        window.layoutIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        saveLayer(host, dir.appendingPathComponent("window-\(page.rawValue.replacingOccurrences(of: " ", with: ""))\(suffix).png"))
    }
    NSApp.appearance = nil

    let hud = OverlayView(frame: NSRect(x: 0, y: 0, width: 580, height: 200))
    hud.mode = .approval(tool: "Bash", summary: "cd ~/projects/app && npm run build && npm test -- --coverage --reporter=verbose 2>&1 | tee build.log && git status --porcelain | wc -l && echo a deliberately long command to check that truncation works", secondsLeft: 17)
    save(hud, dir.appendingPathComponent("hud-approval.png"))

    let wheel = OverlayView(frame: NSRect(x: 0, y: 0, width: 460, height: 460))
    wheel.mode = .wheel(items: Config().wheel, selected: 2)
    save(wheel, dir.appendingPathComponent("hud-wheel.png"))
    print("snapshots written to \(dir.path)")
}

private func save(_ view: NSView, _ url: URL) {
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
}

/// Renders the view's layer tree, which (unlike cacheDisplay) includes SwiftUI's text layers.
private func saveLayer(_ view: NSView, _ url: URL) {
    guard let layer = view.layer else { return save(view, url) }
    let scale: CGFloat = 2
    let w = Int(view.bounds.width * scale), h = Int(view.bounds.height * scale)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
    ctx.setFillColor(NSColor.windowBackgroundColor.cgColor)
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    if view.isFlipped {
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: scale, y: -scale)
    } else {
        ctx.scaleBy(x: scale, y: scale)
    }
    layer.render(in: ctx)
    guard let cg = ctx.makeImage() else { return }
    try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: url)
}

private func saveImage(_ image: NSImage, _ url: URL) {
    guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return }
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
}
