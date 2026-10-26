// The app icon, drawn in code: a Claude-orange tile with a white controller whose light bar glows.
// build.sh renders it into AppIcon.icns (`PadCoder --render-icon <dir>`); the Dock uses it at runtime.

import AppKit

private func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

/// The controller silhouette in the 1024-point icon space (y down), mirrored from its left half.
private func controllerPath() -> CGPath {
    typealias Seg = (to: CGPoint, c1: CGPoint, c2: CGPoint)
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y - 22) }
    let start = p(512, 352)
    let left: [Seg] = [
        (p(330, 356), p(440, 350), p(380, 352)),
        (p(232, 420), p(282, 360), p(248, 385)),
        (p(206, 560), p(214, 460), p(202, 510)),
        (p(262, 704), p(210, 628), p(228, 684)),
        (p(332, 716), p(286, 720), p(314, 722)),
        (p(380, 640), p(352, 702), p(362, 666)),
        (p(512, 600), p(412, 606), p(460, 600)),
    ]
    func m(_ q: CGPoint) -> CGPoint { CGPoint(x: 1024 - q.x, y: q.y) }
    let path = CGMutablePath()
    path.move(to: start)
    var points = [start]
    for s in left { path.addCurve(to: s.to, control1: s.c1, control2: s.c2); points.append(s.to) }
    for (i, s) in left.enumerated().reversed() {
        path.addCurve(to: m(points[i]), control1: m(s.c2), control2: m(s.c1))
    }
    path.closeSubpath()
    return path
}

/// Paints the icon into `ctx`, whose user space must be y-down and `size` points square.
func paintAppIcon(_ ctx: CGContext, size: CGFloat) {
    let s = size / 1024
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    func gradient(_ a: CGColor, _ b: CGColor) -> CGGradient {
        CGGradient(colorsSpace: space, colors: [a, b] as CFArray, locations: [0, 1])!
    }
    ctx.saveGState()
    ctx.scaleBy(x: s, y: s)

    // Tile, with the soft drop shadow macOS icons carry.
    let tile = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824), cornerWidth: 185, cornerHeight: 185, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10 * s), blur: 28 * s, color: rgb(0x000000, 0.32))
    ctx.addPath(tile)
    ctx.setFillColor(rgb(0xD97757))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(tile)
    ctx.clip()
    ctx.drawLinearGradient(gradient(rgb(0xF2A383), rgb(0xC4592F)), start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    ctx.drawRadialGradient(gradient(rgb(0xFFFFFF, 0.28), rgb(0xFFFFFF, 0)),
                           startCenter: CGPoint(x: 512, y: 150), startRadius: 0,
                           endCenter: CGPoint(x: 512, y: 150), endRadius: 560, options: [])
    ctx.restoreGState()

    // Controller body.
    let body = controllerPath()
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -18 * s), blur: 36 * s, color: rgb(0x5A2310, 0.45))
    ctx.addPath(body)
    ctx.setFillColor(rgb(0xFFFFFF))
    ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(body)
    ctx.clip()
    ctx.drawLinearGradient(gradient(rgb(0xFFFFFF), rgb(0xE7E9EE)), start: CGPoint(x: 512, y: 330), end: CGPoint(x: 512, y: 700), options: [])
    ctx.restoreGState()

    // Light bar, glowing.
    let bar = CGPath(roundedRect: CGRect(x: 446, y: 352, width: 132, height: 16), cornerWidth: 8, cornerHeight: 8, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: .zero, blur: 22 * s, color: rgb(0xE8835A, 0.95))
    ctx.addPath(bar)
    ctx.setFillColor(rgb(0xE8835A))
    ctx.fillPath()
    ctx.restoreGState()

    // D-pad and face buttons.
    let accent = rgb(0xD0643D)
    ctx.setFillColor(accent)
    for r in [CGRect(x: 287, y: 430, width: 104, height: 36), CGRect(x: 321, y: 396, width: 36, height: 104)] {
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 10, cornerHeight: 10, transform: nil))
    }
    ctx.fillPath()
    for (dx, dy) in [(0, -50), (50, 0), (0, 50), (-50, 0)] {
        ctx.fillEllipse(in: CGRect(x: 685 + dx - 21, y: 448 + dy - 21, width: 42, height: 42))
    }

    // Sticks.
    for x in [432.0, 592.0] {
        ctx.setFillColor(rgb(0xD3D6DC))
        ctx.fillEllipse(in: CGRect(x: x - 40, y: 520, width: 80, height: 80))
        ctx.setFillColor(rgb(0x3A3D44))
        ctx.fillEllipse(in: CGRect(x: x - 28, y: 532, width: 56, height: 56))
    }
    ctx.restoreGState()
}

/// The icon as an NSImage, for the Dock and ⌘-Tab while the app is running.
func makeAppIcon() -> NSImage {
    NSImage(size: NSSize(width: 1024, height: 1024), flipped: true) { _ in
        guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
        paintAppIcon(ctx, size: 1024)
        return true
    }
}

/// Writes the PNGs of an .iconset folder (for `iconutil -c icns`).
func renderIconSet(to dir: URL) {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
        let px = points * scale
        guard let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
        ctx.translateBy(x: 0, y: CGFloat(px))
        ctx.scaleBy(x: 1, y: -1)
        paintAppIcon(ctx, size: CGFloat(px))
        guard let image = ctx.makeImage() else { continue }
        let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
        try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?
            .write(to: dir.appendingPathComponent(name))
    }
}
