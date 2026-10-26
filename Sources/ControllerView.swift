// Live vector drawing of a DualSense (PS5) or DualShock 4 (PS4), traced from top-down
// reference photos. Drawn in a 1500-wide design space and scaled to fit. Pressed parts glow,
// sticks and triggers move, the light bar mirrors the real one, and clicking a part selects it.

import SwiftUI

enum Shell: String { case white, black }

private let designWidth: CGFloat = 1500
private let designHeight: CGFloat = 1400
private let lift: CGFloat = 120          // room above the body for the detached L2/R2 triggers

private func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y + lift) }

private struct Seg { let to: CGPoint, c1: CGPoint, c2: CGPoint }
private func seg(_ x: CGFloat, _ y: CGFloat, _ c1x: CGFloat, _ c1y: CGFloat, _ c2x: CGFloat, _ c2y: CGFloat) -> Seg {
    Seg(to: pt(x, y), c1: pt(c1x, c1y), c2: pt(c2x, c2y))
}

/// Builds a left-right symmetric closed path from its left half (top centre → bottom centre).
private func mirrored(_ start: CGPoint, _ left: [Seg]) -> Path {
    func m(_ q: CGPoint) -> CGPoint { CGPoint(x: designWidth - q.x, y: q.y) }
    var p = Path()
    p.move(to: start)
    var points = [start]
    for s in left { p.addCurve(to: s.to, control1: s.c1, control2: s.c2); points.append(s.to) }
    for (i, s) in left.enumerated().reversed() {
        p.addCurve(to: m(points[i]), control1: m(s.c2), control2: m(s.c1))
    }
    p.closeSubpath()
    return p
}

private func roundedPolygon(_ pts: [CGPoint], radius: CGFloat) -> Path {
    var p = Path()
    let n = pts.count
    p.move(to: CGPoint(x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2))
    for i in 0..<n { p.addArc(tangent1End: pts[i], tangent2End: pts[(i + 1) % n], radius: radius) }
    p.closeSubpath()
    return p
}

// MARK: - Body shapes

private let ps5Body: [Seg] = [
    seg(440, 276, 620, 268, 520, 270),
    seg(215, 300, 360, 282, 270, 290),
    seg(100, 470, 160, 315, 120, 390),
    seg(86, 780, 82, 560, 80, 680),
    seg(150, 1160, 92, 900, 115, 1060),
    seg(250, 1252, 172, 1215, 205, 1250),
    seg(310, 1215, 282, 1254, 300, 1240),
    seg(420, 905, 335, 1110, 375, 980),
    seg(750, 872, 470, 880, 620, 872),
]

private let ds4Body: [Seg] = [
    seg(480, 292, 650, 288, 560, 290),
    seg(300, 300, 420, 293, 350, 294),
    seg(205, 420, 250, 308, 220, 360),
    seg(190, 600, 192, 480, 186, 540),
    seg(255, 830, 195, 690, 220, 770),
    seg(345, 905, 278, 878, 305, 905),
    seg(430, 860, 380, 905, 410, 888),
    seg(540, 712, 455, 820, 490, 735),
    seg(750, 698, 600, 700, 680, 698),
]

struct BodyShape: Shape {
    let kind: PadKind
    func path(in rect: CGRect) -> Path {
        kind == .ps5 ? mirrored(pt(750, 268), ps5Body) : mirrored(pt(750, 290), ds4Body)
    }
}

/// The DualSense's black core: under the touchpad, around the sticks, down the inner grips.
struct CoreShape: Shape {
    func path(in rect: CGRect) -> Path {
        mirrored(pt(750, 540), [
            seg(470, 530, 650, 540, 520, 534),
            seg(420, 640, 455, 570, 432, 600),
            seg(395, 820, 405, 690, 398, 760),
            seg(250, 1252, 390, 950, 290, 1130),
            ps5Body[6], ps5Body[7], ps5Body[8],
        ])
    }
}

struct TouchpadShape: Shape {
    let kind: PadKind
    func path(in rect: CGRect) -> Path {
        var p = Path()
        if kind == .ps5 {
            p.move(to: pt(455, 282))
            p.addCurve(to: pt(1045, 282), control1: pt(650, 270), control2: pt(850, 270))
            p.addCurve(to: pt(1005, 525), control1: pt(1035, 360), control2: pt(1015, 460))
            p.addCurve(to: pt(945, 578), control1: pt(995, 565), control2: pt(975, 578))
            p.addLine(to: pt(555, 578))
            p.addCurve(to: pt(495, 525), control1: pt(525, 578), control2: pt(505, 565))
            p.addCurve(to: pt(455, 282), control1: pt(485, 460), control2: pt(465, 360))
        } else {
            p.move(to: pt(579, 293))
            p.addLine(to: pt(921, 293))
            p.addLine(to: pt(906, 460))
            p.addQuadCurve(to: pt(880, 486), control: pt(904, 486))
            p.addLine(to: pt(620, 486))
            p.addQuadCurve(to: pt(594, 460), control: pt(596, 486))
        }
        p.closeSubpath()
        return p
    }
    static func bounds(_ kind: PadKind) -> CGRect {
        kind == .ps5 ? CGRect(x: 470, y: 290 + lift, width: 560, height: 280)
                     : CGRect(x: 590, y: 300 + lift, width: 320, height: 180)
    }
}

/// Light strips: down both sides of the DualSense touchpad, along the top edge on a DualShock 4.
struct LightBarShape: Shape {
    let kind: PadKind
    func path(in rect: CGRect) -> Path {
        var p = Path()
        if kind == .ps5 {
            p.move(to: pt(462, 300)); p.addCurve(to: pt(502, 540), control1: pt(472, 380), control2: pt(488, 480))
            p.move(to: pt(1038, 300)); p.addCurve(to: pt(998, 540), control1: pt(1028, 380), control2: pt(1012, 480))
        } else {
            p.move(to: pt(596, 286)); p.addLine(to: pt(904, 286))
        }
        return p
    }
}

struct BumperShape: Shape {
    let right: Bool
    let kind: PadKind
    func path(in rect: CGRect) -> Path {
        let pts: [CGPoint] = kind == .ps5
            ? [pt(212, 310), pt(222, 252), pt(402, 244), pt(410, 300)]
            : [pt(292, 310), pt(302, 254), pt(468, 248), pt(478, 306)]
        return roundedPolygon(right ? pts.map { CGPoint(x: designWidth - $0.x, y: $0.y) } : pts, radius: 22)
    }
}

struct DpadPiece: Shape {
    let tipInset: CGFloat     // fraction of the height where the sides start converging
    func path(in r: CGRect) -> Path {
        roundedPolygon([CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.minY),
                        CGPoint(x: r.maxX, y: r.minY + r.height * tipInset), CGPoint(x: r.midX, y: r.maxY),
                        CGPoint(x: r.minX, y: r.minY + r.height * tipInset)], radius: r.width * 0.2)
    }
}

struct TriggerShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX + 14, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.maxY - 18), control: CGPoint(x: r.minX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + r.width * 0.03, y: r.minY + r.height * 0.42))
        p.addCurve(to: CGPoint(x: r.midX, y: r.minY), control1: CGPoint(x: r.minX + r.width * 0.08, y: r.minY + r.height * 0.06),
                   control2: CGPoint(x: r.minX + r.width * 0.28, y: r.minY))
        p.addCurve(to: CGPoint(x: r.maxX - r.width * 0.03, y: r.minY + r.height * 0.42), control1: CGPoint(x: r.maxX - r.width * 0.28, y: r.minY),
                   control2: CGPoint(x: r.maxX - r.width * 0.08, y: r.minY + r.height * 0.06))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - 18))
        p.addQuadCurve(to: CGPoint(x: r.maxX - 14, y: r.maxY), control: CGPoint(x: r.maxX, y: r.maxY))
        p.closeSubpath()
        return p
    }
}

// MARK: - PlayStation symbols (thin line style)

struct FaceSymbol: Shape {
    let name: String
    func path(in r: CGRect) -> Path {
        var p = Path()
        let s = min(r.width, r.height)
        let c = CGPoint(x: r.midX, y: r.midY)
        switch name {
        case "triangle":
            let h = s * 0.86
            p.move(to: CGPoint(x: c.x, y: c.y - h * 0.55))
            p.addLine(to: CGPoint(x: c.x + s * 0.5, y: c.y + h * 0.45))
            p.addLine(to: CGPoint(x: c.x - s * 0.5, y: c.y + h * 0.45))
            p.closeSubpath()
        case "circle":
            p.addEllipse(in: CGRect(x: c.x - s / 2, y: c.y - s / 2, width: s, height: s))
        case "cross":
            let d = s * 0.42
            p.move(to: CGPoint(x: c.x - d, y: c.y - d)); p.addLine(to: CGPoint(x: c.x + d, y: c.y + d))
            p.move(to: CGPoint(x: c.x + d, y: c.y - d)); p.addLine(to: CGPoint(x: c.x - d, y: c.y + d))
        default:
            let d = s * 0.4
            p.addRect(CGRect(x: c.x - d, y: c.y - d, width: d * 2, height: d * 2))
        }
        return p
    }
}

// MARK: - Palette

struct PadPalette {
    var bodyTop, bodyBottom, outline, core, padTop, padBottom, padEdge: Color
    var button, buttonEdge, symbol, dpad, dpadEdge, arrow, dish: Color
    var stickRing, stickCap, stickGrip, bumper, logo, speaker: Color
    var coloredSymbols: Bool

    static func make(_ kind: PadKind, _ shell: Shell) -> PadPalette {
        func c(_ hex: UInt32) -> Color {
            Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
        }
        switch (kind == .ps5, shell) {
        case (true, .white):
            return PadPalette(bodyTop: c(0xFBFBFC), bodyBottom: c(0xE4E6EA), outline: c(0xC9CDD3), core: c(0x17181C),
                              padTop: c(0xFFFFFF), padBottom: c(0xECEEF1), padEdge: c(0xD3D6DB),
                              button: c(0xF4F5F7), buttonEdge: c(0xC2C6CC), symbol: c(0x8A9098),
                              dpad: c(0xF4F5F7), dpadEdge: c(0xC2C6CC), arrow: c(0x8A9098), dish: .clear,
                              stickRing: c(0x0E0F11), stickCap: c(0x2A2C31), stickGrip: c(0x383A40),
                              bumper: c(0x1E1F23), logo: c(0x2E3036), speaker: c(0x050506), coloredSymbols: false)
        case (true, .black):
            return PadPalette(bodyTop: c(0x34363C), bodyBottom: c(0x222428), outline: c(0x141518), core: c(0x111214),
                              padTop: c(0x3A3C42), padBottom: c(0x2A2C31), padEdge: c(0x18191C),
                              button: c(0x3A3D43), buttonEdge: c(0x4D5057), symbol: c(0xB4B9C1),
                              dpad: c(0x3A3D43), dpadEdge: c(0x4D5057), arrow: c(0xB4B9C1), dish: .clear,
                              stickRing: c(0x0B0C0D), stickCap: c(0x2A2C31), stickGrip: c(0x383A40),
                              bumper: c(0x1A1B1E), logo: c(0x3A3D43), speaker: c(0x040405), coloredSymbols: false)
        case (false, .white):
            return PadPalette(bodyTop: c(0xFAFBFC), bodyBottom: c(0xE2E4E8), outline: c(0xC6CAD0), core: .clear,
                              padTop: c(0x26282D), padBottom: c(0x16171A), padEdge: c(0x0E0F11),
                              button: c(0x2B2E34), buttonEdge: c(0x1B1D21), symbol: .white,
                              dpad: c(0x2B2E34), dpadEdge: c(0x1B1D21), arrow: c(0x9DA3AB), dish: c(0xE9EBEE),
                              stickRing: c(0xD8DBDF), stickCap: c(0x2A2D32), stickGrip: c(0x3A3D43),
                              bumper: c(0x2B2E34), logo: c(0x2B2E34), speaker: c(0x2B2E34), coloredSymbols: true)
        case (false, .black):
            return PadPalette(bodyTop: c(0x2C2E33), bodyBottom: c(0x1A1B1E), outline: c(0x0E0F11), core: .clear,
                              padTop: c(0x1E2024), padBottom: c(0x131417), padEdge: c(0x0A0B0C),
                              button: c(0x33363C), buttonEdge: c(0x17181B), symbol: .white,
                              dpad: c(0x33363C), dpadEdge: c(0x17181B), arrow: c(0x8C929A), dish: c(0x222428),
                              stickRing: c(0x33363C), stickCap: c(0x1E2024), stickGrip: c(0x2C2E33),
                              bumper: c(0x2E3136), logo: c(0x3A3D43), speaker: c(0x0F1012), coloredSymbols: true)
        }
    }
}

// MARK: - The view

struct ControllerView: View {
    @ObservedObject var model: LiveModel
    let kind: PadKind
    var shell: Shell = .white
    var displayWidth: CGFloat = 660
    var showReadouts = true
    @Environment(\.colorScheme) private var scheme

    private var pal: PadPalette { PadPalette.make(kind, shell) }
    /// A faint light rim so dark plastic still reads against a dark window.
    private var rim: Color { scheme == .dark ? Color.white.opacity(0.2) : Color.black.opacity(0.12) }
    private var ps5: Bool { kind == .ps5 }
    private var scale: CGFloat { displayWidth / designWidth }
    private let hot = Color(red: 0.85, green: 0.47, blue: 0.34)
    private let hotTop = Color(red: 0.95, green: 0.6, blue: 0.45)
    private let accent = Color(red: 0.24, green: 0.52, blue: 1.0)

    var body: some View {
        ZStack(alignment: .topLeading) {
            triggerView("l2", model.l2, CGPoint(x: 300, y: 100))
            triggerView("r2", model.r2, CGPoint(x: 1200, y: 100))
            controller
                .scaleEffect(ps5 ? 1 : 1.2, anchor: UnitPoint(x: 0.5, y: 0.22))
            if showReadouts { readouts }
        }
        .frame(width: designWidth, height: designHeight, alignment: .topLeading)
        .scaleEffect(scale, anchor: .topLeading)
        .frame(width: designWidth * scale, height: designHeight * scale, alignment: .topLeading)
    }

    private var controller: some View {
        ZStack(alignment: .topLeading) {
            Ellipse().fill(Color.black.opacity(0.22))
                .frame(width: ps5 ? 1150 : 900, height: 90).blur(radius: 40)
                .position(x: 750, y: (ps5 ? 1250 : 905) + lift + 10)
                .allowsHitTesting(false)
            bumper("l1", right: false)
            bumper("r1", right: true)
            BodyShape(kind: kind)
                .fill(LinearGradient(colors: [pal.bodyTop, pal.bodyBottom], startPoint: .top, endPoint: .bottom))
                .overlay(BodyShape(kind: kind).stroke(pal.outline, lineWidth: 3))
                .allowsHitTesting(false)
            if ps5 { CoreShape().fill(pal.core).allowsHitTesting(false) }
            BodyShape(kind: kind).stroke(rim, lineWidth: 3).allowsHitTesting(false)
            details.allowsHitTesting(false)
            touchpad
            lightBar.allowsHitTesting(false)
            dpad
            faceButtons
            stick("l3", model.leftStick, at: ps5 ? CGPoint(x: 520, y: 708) : CGPoint(x: 585, y: 591))
            stick("r3", model.rightStick, at: ps5 ? CGPoint(x: 980, y: 708) : CGPoint(x: 915, y: 591))
            smallButtons
        }
        .frame(width: designWidth, height: designHeight, alignment: .topLeading)
    }

    // MARK: Interaction chrome

    private func ring(_ name: String) -> (Color, CGFloat) {
        if model.selected == name { return (accent, 8) }
        if model.hovered == name { return (accent.opacity(0.55), 6) }
        return (.clear, 0)
    }

    private func glow(_ name: String) -> Color {
        if model.pressed.contains(name) { return hot.opacity(0.85) }
        if model.selected == name { return accent.opacity(0.45) }
        return .clear
    }

    private func hotFill(_ name: String, _ base: Color) -> AnyShapeStyle {
        model.pressed.contains(name)
            ? AnyShapeStyle(LinearGradient(colors: [hotTop, hot], startPoint: .top, endPoint: .bottom))
            : AnyShapeStyle(base)
    }

    private func interactive<V: View, S: Shape>(_ name: String, _ shape: S, _ view: V) -> some View {
        let (ringColor, ringWidth) = ring(name)
        return view
            .overlay(shape.stroke(ringColor, lineWidth: ringWidth))
            .shadow(color: glow(name), radius: model.pressed.contains(name) ? 22 : 14)
            .contentShape(shape)
            .onTapGesture { model.selected = name }
            .onHover { inside in
                if inside { model.hovered = name } else if model.hovered == name { model.hovered = nil }
            }
            .help(buttonTitle(name, kind))
    }

    // MARK: Parts

    private func triggerView(_ name: String, _ value: CGFloat, _ c: CGPoint) -> some View {
        let shape = TriggerShape()
        let v = min(max(value, 0), 1)
        let body = ZStack(alignment: .bottom) {
            shape.fill(LinearGradient(colors: [pal.bumper.opacity(0.85), pal.bumper], startPoint: .top, endPoint: .bottom))
            Rectangle().fill(LinearGradient(colors: [hotTop, hot], startPoint: .top, endPoint: .bottom))
                .frame(height: 150 * v)
            VStack(spacing: 2) {
                Text(name.uppercased()).font(.system(size: 34, weight: .bold, design: .rounded))
                Text("\(Int((v * 100).rounded()))%").font(.system(size: 28, weight: .medium, design: .rounded)).monospacedDigit()
                    .opacity(0.8)
            }
            .foregroundColor(.white)
            .frame(maxHeight: .infinity)
        }
        .frame(width: 190, height: 150)
        .clipShape(shape)
        .overlay(shape.stroke(rim, lineWidth: 3))
        return interactive(name, shape, body).position(c)
    }

    private func bumper(_ name: String, right: Bool) -> some View {
        let shape = BumperShape(right: right, kind: kind)
        return interactive(name, shape, shape.fill(hotFill(name, pal.bumper)).overlay(shape.stroke(rim, lineWidth: 3)))
    }

    /// Live stick values in the gap between the grips, like a controller tester.
    private var readouts: some View {
        let y: CGFloat = ps5 ? 1075 : 1040
        func column(_ a: String, _ av: CGFloat, _ b: String, _ bv: CGFloat) -> some View {
            VStack(alignment: .leading, spacing: 6) {
                ForEach([(a, av), (b, bv)], id: \.0) { label, v in
                    HStack(spacing: 14) {
                        Text(label).foregroundColor(accent).font(.system(size: 34, weight: .bold, design: .rounded))
                        Text(String(format: "%+.3f", Double(v))).font(.system(size: 34, weight: .medium, design: .monospaced))
                            .foregroundColor(.primary.opacity(0.85))
                    }
                }
            }
        }
        return ZStack(alignment: .topLeading) {
            column("LX", model.leftStick.x, "LY", model.leftStick.y).position(x: 610, y: y)
            column("RX", model.rightStick.x, "RY", model.rightStick.y).position(x: 890, y: y)
        }
        .allowsHitTesting(false)
    }

    private var details: some View {
        ZStack(alignment: .topLeading) {
            if ps5 {
                ForEach(0..<10, id: \.self) { i in
                    Circle().fill(pal.speaker).frame(width: 15, height: 15)
                        .position(pt(700 + CGFloat(i % 5) * 25, i < 5 ? 607 : 633))
                }
                Circle().fill(pal.speaker).frame(width: 7, height: 7).position(pt(750, 852))
            } else {
                Circle().fill(pal.dish).frame(width: 196, height: 196).position(pt(426, 444))
                Circle().fill(pal.dish).frame(width: 196, height: 196).position(pt(1086, 447))
                ForEach(Array(ds4SpeakerHoles.enumerated()), id: \.offset) { _, p in
                    Circle().fill(pal.speaker).frame(width: 8, height: 8).position(pt(p.x, p.y))
                }
            }
        }
    }

    private var ds4SpeakerHoles: [CGPoint] {
        var holes: [CGPoint] = []
        for (row, count) in [5, 4, 3].enumerated() {
            for i in 0..<count {
                holes.append(CGPoint(x: 750 + (CGFloat(i) - CGFloat(count - 1) / 2) * 13, y: 514 + CGFloat(row) * 13))
            }
        }
        return holes
    }

    private var touchpad: some View {
        let shape = TouchpadShape(kind: kind)
        let b = TouchpadShape.bounds(kind)
        let surface = ZStack(alignment: .topLeading) {
            shape.fill(model.pressed.contains("touchpad")
                       ? AnyShapeStyle(LinearGradient(colors: [hotTop.opacity(0.9), hot.opacity(0.9)], startPoint: .top, endPoint: .bottom))
                       : AnyShapeStyle(LinearGradient(colors: [pal.padTop, pal.padBottom], startPoint: .top, endPoint: .bottom)))
            shape.stroke(pal.padEdge, lineWidth: 3)
            ForEach(Array(model.touches.enumerated()), id: \.offset) { _, t in
                Circle()
                    .fill(RadialGradient(colors: [accent.opacity(0.9), accent.opacity(0.0)], center: .center, startRadius: 4, endRadius: 34))
                    .frame(width: 68, height: 68)
                    .position(x: b.minX + (t.x + 1) / 2 * b.width, y: b.minY + (1 - t.y) / 2 * b.height)
            }
        }
        .frame(width: designWidth, height: designHeight, alignment: .topLeading)
        return interactive("touchpad", shape, surface)
    }

    private var lightBar: some View {
        LightBarShape(kind: kind)
            .stroke(model.light, style: StrokeStyle(lineWidth: ps5 ? 10 : 12, lineCap: .round))
            .shadow(color: model.light, radius: 16)
            .shadow(color: model.light.opacity(0.6), radius: 30)
    }

    private var dpad: some View {
        let c = ps5 ? CGPoint(x: 300, y: 510) : CGPoint(x: 426, y: 444)
        let hw: CGFloat = ps5 ? 40 : 29, outer: CGFloat = ps5 ? 112 : 86, tip: CGFloat = ps5 ? 12 : 14
        let len = outer - tip
        let mid = (outer + tip) / 2
        return ZStack(alignment: .topLeading) {
            dpadKey("up", 0, CGPoint(x: c.x, y: c.y - mid), CGSize(width: hw * 2, height: len))
            dpadKey("right", 90, CGPoint(x: c.x + mid, y: c.y), CGSize(width: hw * 2, height: len))
            dpadKey("down", 180, CGPoint(x: c.x, y: c.y + mid), CGSize(width: hw * 2, height: len))
            dpadKey("left", 270, CGPoint(x: c.x - mid, y: c.y), CGSize(width: hw * 2, height: len))
        }
    }

    private func dpadKey(_ name: String, _ angle: Double, _ center: CGPoint, _ size: CGSize) -> some View {
        let shape = DpadPiece(tipInset: 0.62)
        let key = ZStack {
            shape.fill(hotFill(name, pal.dpad))
            shape.stroke(pal.dpadEdge, lineWidth: 3)
            Image(systemName: "arrowtriangle.up.fill")
                .font(.system(size: size.width * 0.26))
                .foregroundColor(model.pressed.contains(name) ? .white : pal.arrow)
                .offset(y: -size.height * 0.16)
        }
        .frame(width: size.width, height: size.height)
        return interactive(name, shape, key)
            .rotationEffect(.degrees(angle))
            .position(pt(center.x, center.y))
    }

    private var faceButtons: some View {
        let c = ps5 ? CGPoint(x: 1195, y: 517) : CGPoint(x: 1086, y: 447)
        let d: CGFloat = ps5 ? 103 : 79
        return ZStack(alignment: .topLeading) {
            faceKey("triangle", CGPoint(x: c.x, y: c.y - d), Color(red: 0.25, green: 0.82, blue: 0.68))
            faceKey("circle", CGPoint(x: c.x + d, y: c.y), Color(red: 0.98, green: 0.33, blue: 0.4))
            faceKey("cross", CGPoint(x: c.x, y: c.y + d), Color(red: 0.42, green: 0.62, blue: 1.0))
            faceKey("square", CGPoint(x: c.x - d, y: c.y), Color(red: 0.93, green: 0.5, blue: 0.85))
        }
    }

    private func faceKey(_ name: String, _ center: CGPoint, _ tint: Color) -> some View {
        let r: CGFloat = ps5 ? 47 : 35
        let pressed = model.pressed.contains(name)
        let key = ZStack {
            Circle().fill(hotFill(name, pal.button))
            Circle().stroke(pal.buttonEdge, lineWidth: 3)
            FaceSymbol(name: name)
                .stroke(pressed ? .white : (pal.coloredSymbols ? tint : pal.symbol),
                        style: StrokeStyle(lineWidth: ps5 ? 4.5 : 5, lineCap: .round, lineJoin: .round))
                .frame(width: r * 0.95, height: r * 0.95)
        }
        .frame(width: r * 2, height: r * 2)
        return interactive(name, Circle(), key).position(pt(center.x, center.y))
    }

    private func stick(_ name: String, _ v: CGPoint, at c: CGPoint) -> some View {
        let ringR: CGFloat = ps5 ? 92 : 64, capR: CGFloat = ps5 ? 72 : 48, travel: CGFloat = ps5 ? 22 : 15
        let pressed = model.pressed.contains(name)
        let view = ZStack {
            Circle().fill(pal.stickRing)
            Circle()
                .fill(pressed ? AnyShapeStyle(LinearGradient(colors: [hotTop, hot], startPoint: .top, endPoint: .bottom))
                              : AnyShapeStyle(RadialGradient(colors: [pal.stickGrip, pal.stickCap], center: UnitPoint(x: 0.4, y: 0.35),
                                                             startRadius: 2, endRadius: capR)))
                .overlay(Circle().stroke(Color.black.opacity(0.35), lineWidth: 3))
                .overlay(Circle().stroke(Color.white.opacity(0.05), lineWidth: capR * 0.18).padding(capR * 0.22))
                .frame(width: capR * 2, height: capR * 2)
                .shadow(color: .black.opacity(0.35), radius: 8, y: 4)
                .offset(x: v.x * travel, y: -v.y * travel)
        }
        .frame(width: ringR * 2, height: ringR * 2)
        return interactive(name, Circle(), view).position(pt(c.x, c.y))
    }

    private var smallButtons: some View {
        let createAt = ps5 ? CGPoint(x: 418, y: 362) : CGPoint(x: 540, y: 336)
        let optionsAt = ps5 ? CGPoint(x: 1082, y: 362) : CGPoint(x: 960, y: 336)
        let pill = ps5 ? CGSize(width: 32, height: 66) : CGSize(width: 24, height: 50)
        return ZStack(alignment: .topLeading) {
            pillKey("create", createAt, pill, ps5 ? -12 : 0)
            pillKey("options", optionsAt, pill, ps5 ? 12 : 0)
            if ps5 {
                Image(systemName: "light.beacon.max").font(.system(size: 22, weight: .semibold)).foregroundColor(pal.symbol)
                    .position(pt(408, 312))
                Image(systemName: "line.3.horizontal").font(.system(size: 22, weight: .semibold)).foregroundColor(pal.symbol)
                    .position(pt(1092, 312))
                pillKey("mute", CGPoint(x: 750, y: 792), CGSize(width: 84, height: 20), 0, base: Color(white: 0.38))
            }
            psButton(ps5 ? CGPoint(x: 750, y: 706) : CGPoint(x: 750, y: 596))
        }
    }

    private func pillKey(_ name: String, _ c: CGPoint, _ size: CGSize, _ angle: Double, base: Color? = nil) -> some View {
        let key = ZStack {
            Capsule().fill(hotFill(name, base ?? (ps5 ? pal.button : pal.dpad)))
            Capsule().stroke(base == nil ? pal.buttonEdge : .clear, lineWidth: 3)
        }
        .frame(width: size.width, height: size.height)
        return interactive(name, Capsule(), key).rotationEffect(.degrees(angle)).position(pt(c.x, c.y))
    }

    private func psButton(_ c: CGPoint) -> some View {
        let size: CGFloat = ps5 ? 96 : 66
        let logo = Image(systemName: "playstation.logo")
            .font(.system(size: ps5 ? 62 : 40, weight: .bold))
            .foregroundColor(model.pressed.contains("ps") ? hot : pal.logo)
            .frame(width: size, height: size)
        return interactive("ps", Circle(), logo).position(pt(c.x, c.y))
    }
}
