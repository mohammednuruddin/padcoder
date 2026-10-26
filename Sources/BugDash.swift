// Bug Dash: an endless runner to play while Claude works. Jump bugs, slide under failing tests,
// dash through anything, collect tokens. Pauses itself when Claude finishes or needs you.

import SpriteKit
import AppKit

enum RunnerEvent { case start, jump, token, dash, smash, hit }

private let orange = NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 1)
private let orangeLight = NSColor(srgbRed: 0.95, green: 0.64, blue: 0.51, alpha: 1)
private let bugRed = NSColor(srgbRed: 0.90, green: 0.28, blue: 0.30, alpha: 1)

/// One soft white dot, tinted per use: trails and dust as sprites draw far cheaper than shape nodes.
private let dotTexture: SKTexture = {
    let image = NSImage(size: NSSize(width: 32, height: 32), flipped: false) { rect in
        NSColor.white.setFill()
        NSBezierPath(ovalIn: rect.insetBy(dx: 1, dy: 1)).fill()
        return true
    }
    return SKTexture(image: image)
}()

private func dot(radius: CGFloat, color: NSColor) -> SKSpriteNode {
    let sprite = SKSpriteNode(texture: dotTexture, size: CGSize(width: radius * 2, height: radius * 2))
    sprite.color = color
    sprite.colorBlendFactor = 1
    sprite.alpha = color.alphaComponent
    return sprite
}

private let codeSnippets = [
    "func vibe() async throws {", "let fix = try await claude.run()", "// TODO: dodge bugs", "git commit -m \"wip\"",
    "if bugs > 0 { dash() }", "return tokens * 25", "npm test -- --watch", "while waiting { play() }",
    "@MainActor final class Pad", "print(\"hello, pad\")", "} catch { retry() }", "let speed = 420",
    "guard ok else { return }", "for bug in bugs { jump() }", "assert(score > best)", "make it simpler",
]

final class RunnerScene: SKScene {
    enum Phase { case ready, playing, paused, over }
    private(set) var phase: Phase = .ready { didSet { onVisualChange?() } }
    var onEvent: ((RunnerEvent) -> Void)?
    /// Something on screen changed while not playing (a card appeared), so the view should draw once.
    var onVisualChange: (() -> Void)?
    /// What Claude is doing, shown in the corner: text and dot colour.
    var claudeStatus: () -> (String, NSColor) = { ("", .gray) }

    private let groundY: CGFloat = 120
    private let playerX: CGFloat = 210
    private var runSpeed: CGFloat = 430
    private var distance: CGFloat = 0
    private var tokens = 0
    private var smashed = 0
    private var bonus = 0
    private var wasAirborne = false
    private var shownScore = -1, shownStatus = "", shownEnergy: CGFloat = -1
    private var best = UserDefaults.standard.integer(forKey: "bugdash.best")
    /// Off for offscreen test renders, so they never touch your real high score.
    var recordsBest = true
    private var score: Int { Int(distance / 12) + tokens * 25 + bonus }

    private var py: CGFloat = 0, vy: CGFloat = 0, jumpsLeft = 2
    private var sliding = false, dashLeft: CGFloat = 0, energy: CGFloat = 1
    private var lastTime: TimeInterval = 0
    private var nextSpawnAt: CGFloat = 700
    private var trailClock: CGFloat = 0

    private enum Kind { case bug, failBar, token }
    private struct Thing { let node: SKNode; let kind: Kind; let size: CGSize; let lift: CGFloat }
    private var things: [Thing] = []

    private let world = SKNode()
    private let player = SKNode()
    private let bodyNode = SKNode()
    private var codeLines: [(label: SKLabelNode, depth: CGFloat)] = []
    private var groundMarks: [SKShapeNode] = []
    private let scoreLabel = SKLabelNode(fontNamed: "Menlo-Bold")
    private let bestLabel = SKLabelNode(fontNamed: "Menlo-Bold")
    private let statusLabel = SKLabelNode(fontNamed: "HelveticaNeue-Bold")
    private let statusDot = SKShapeNode(circleOfRadius: 6)
    private let statusPill = SKShapeNode()
    private let energyFill = SKShapeNode()
    private let overlay = SKNode()
    private let overlayTitle = SKLabelNode(fontNamed: "HelveticaNeue-Bold")
    private let overlayText = SKLabelNode(fontNamed: "HelveticaNeue")
    private let overlayHint = SKLabelNode(fontNamed: "HelveticaNeue-Medium")
    private let controlChips = SKNode()

    override init(size: CGSize) {
        super.init(size: size)
        scaleMode = .aspectFit
        backgroundColor = NSColor(srgbRed: 0.07, green: 0.075, blue: 0.09, alpha: 1)
        build()
        showOverlay("BUG DASH", "Dodge bugs while Claude fixes them.", "", tint: orange, chips: true)
    }

    required init?(coder: NSCoder) { fatalError() }

    // MARK: Building the scene

    private func build() {
        addChild(world)
        // Soft glow behind the play area: stacked faint ovals fade out without a hard edge.
        for i in 0..<8 {
            let k = CGFloat(i) / 7
            let glow = dot(radius: 1, color: orange.withAlphaComponent(0.012))
            glow.size = CGSize(width: 1300 - 700 * k, height: 560 - 300 * k)
            glow.position = CGPoint(x: size.width / 2, y: groundY + 40)
            world.addChild(glow)
        }

        // Two layers of drifting code for depth.
        for depth in [0.18, 0.4] as [CGFloat] {
            for _ in 0..<9 {
                let label = SKLabelNode(fontNamed: "Menlo-Regular")
                label.text = codeSnippets.randomElement()
                label.fontSize = depth < 0.3 ? 15 : 19
                label.fontColor = NSColor.white.withAlphaComponent(depth < 0.3 ? 0.025 : 0.045)
                label.horizontalAlignmentMode = .left
                label.position = CGPoint(x: .random(in: 0...size.width), y: .random(in: (groundY + 40)...(size.height - 70)))
                world.addChild(label)
                codeLines.append((label, depth))
            }
        }

        // Ground.
        let ground = SKShapeNode(rect: CGRect(x: 0, y: 0, width: size.width, height: groundY))
        ground.fillColor = NSColor(srgbRed: 0.1, green: 0.105, blue: 0.125, alpha: 1)
        ground.strokeColor = .clear
        world.addChild(ground)
        let edge = SKShapeNode(rect: CGRect(x: 0, y: groundY - 2, width: size.width, height: 3))
        edge.fillColor = orange.withAlphaComponent(0.8)
        edge.strokeColor = .clear
        edge.glowWidth = 3
        world.addChild(edge)
        for i in 0..<14 {
            let mark = SKShapeNode(rect: CGRect(x: 0, y: 0, width: 36, height: 4), cornerRadius: 2)
            mark.fillColor = NSColor.white.withAlphaComponent(0.08)
            mark.strokeColor = .clear
            mark.position = CGPoint(x: CGFloat(i) * 80, y: groundY - 40)
            world.addChild(mark)
            groundMarks.append(mark)
        }

        // The runner: a little orange robot.
        let shell = SKShapeNode(rectOf: CGSize(width: 54, height: 54), cornerRadius: 15)
        shell.fillColor = orange
        shell.strokeColor = orangeLight
        shell.lineWidth = 2
        shell.position = CGPoint(x: 0, y: 27)
        let visor = SKShapeNode(rectOf: CGSize(width: 38, height: 16), cornerRadius: 8)
        visor.fillColor = NSColor(srgbRed: 0.12, green: 0.12, blue: 0.15, alpha: 1)
        visor.strokeColor = .clear
        visor.position = CGPoint(x: 4, y: 34)
        for dx in [-5.0, 9.0] {
            let eye = SKShapeNode(circleOfRadius: 3.5)
            eye.fillColor = NSColor(srgbRed: 0.55, green: 0.85, blue: 1, alpha: 1)
            eye.strokeColor = .clear
            eye.glowWidth = 2
            eye.position = CGPoint(x: dx, y: 0)
            visor.addChild(eye)
        }
        let antenna = SKShapeNode(rect: CGRect(x: -1.5, y: 54, width: 3, height: 12))
        antenna.fillColor = orangeLight
        antenna.strokeColor = .clear
        let tip = SKShapeNode(circleOfRadius: 4)
        tip.fillColor = orangeLight
        tip.strokeColor = .clear
        tip.glowWidth = 3
        tip.position = CGPoint(x: 0, y: 68)
        [shell, visor, antenna, tip].forEach(bodyNode.addChild)
        player.addChild(bodyNode)
        player.position = CGPoint(x: playerX, y: groundY)
        world.addChild(player)

        // HUD: score card top left, Claude status pill top right.
        let scoreCard = SKShapeNode(rect: CGRect(x: 20, y: size.height - 92, width: 196, height: 72), cornerRadius: 16)
        scoreCard.fillColor = NSColor.white.withAlphaComponent(0.05)
        scoreCard.strokeColor = NSColor.white.withAlphaComponent(0.08)
        scoreLabel.fontSize = 30
        scoreLabel.horizontalAlignmentMode = .left
        scoreLabel.position = CGPoint(x: 36, y: size.height - 58)
        bestLabel.fontSize = 12
        bestLabel.fontColor = NSColor.white.withAlphaComponent(0.45)
        bestLabel.horizontalAlignmentMode = .left
        bestLabel.position = CGPoint(x: 38, y: size.height - 80)
        statusPill.fillColor = NSColor.white.withAlphaComponent(0.06)
        statusPill.strokeColor = NSColor.white.withAlphaComponent(0.08)
        statusLabel.fontSize = 14
        statusLabel.horizontalAlignmentMode = .right
        statusLabel.verticalAlignmentMode = .center
        statusLabel.position = CGPoint(x: size.width - 40, y: size.height - 42)
        statusDot.strokeColor = .clear
        statusDot.glowWidth = 3
        addChild(scoreCard)
        addChild(statusPill)
        let dashLabel = SKLabelNode(fontNamed: "HelveticaNeue-Bold")
        dashLabel.text = "DASH"
        dashLabel.fontSize = 12
        dashLabel.fontColor = NSColor.white.withAlphaComponent(0.5)
        dashLabel.horizontalAlignmentMode = .left
        dashLabel.position = CGPoint(x: 28, y: 32)
        let track = SKShapeNode(rect: CGRect(x: 72, y: 32, width: 140, height: 10), cornerRadius: 5)
        track.fillColor = NSColor.white.withAlphaComponent(0.1)
        track.strokeColor = .clear
        energyFill.strokeColor = .clear
        [scoreLabel, bestLabel, statusLabel, statusDot, dashLabel, track, energyFill].forEach(addChild)

        // Centre card for start, pause, game over and Claude banners.
        let card = SKShapeNode(rect: CGRect(x: -300, y: -100, width: 600, height: 200), cornerRadius: 24)
        card.fillColor = NSColor(srgbRed: 0.05, green: 0.05, blue: 0.07, alpha: 0.9)
        card.strokeColor = NSColor.white.withAlphaComponent(0.1)
        card.lineWidth = 1.5
        card.name = "card"
        overlayTitle.fontSize = 42
        overlayTitle.position = CGPoint(x: 0, y: 28)
        overlayText.fontSize = 18
        overlayText.fontColor = NSColor.white.withAlphaComponent(0.85)
        overlayText.position = CGPoint(x: 0, y: -10)
        overlayHint.fontSize = 14
        overlayHint.fontColor = NSColor.white.withAlphaComponent(0.55)
        overlayHint.position = CGPoint(x: 0, y: -60)
        // Button chips for the start card.
        let chips: [(String, String)] = [("✕", "Jump"), ("○", "Slide"), ("R2", "Dash"), ("≡", "Pause")]
        for (i, (glyph, word)) in chips.enumerated() {
            let chip = SKNode()
            let pill = SKShapeNode(rect: CGRect(x: -58, y: -16, width: 116, height: 32), cornerRadius: 16)
            pill.fillColor = NSColor.white.withAlphaComponent(0.07)
            pill.strokeColor = NSColor.white.withAlphaComponent(0.12)
            let g = SKLabelNode(fontNamed: "HelveticaNeue-Bold")
            g.text = glyph
            g.fontSize = 14
            g.fontColor = orangeLight
            g.verticalAlignmentMode = .center
            g.horizontalAlignmentMode = .right
            g.position = CGPoint(x: -14, y: 0)
            let w = SKLabelNode(fontNamed: "HelveticaNeue-Medium")
            w.text = word
            w.fontSize = 14
            w.fontColor = NSColor.white.withAlphaComponent(0.85)
            w.verticalAlignmentMode = .center
            w.horizontalAlignmentMode = .left
            w.position = CGPoint(x: -6, y: 0)
            [pill, g, w].forEach(chip.addChild)
            chip.position = CGPoint(x: CGFloat(i) - 1.5, y: 0)
            chip.position.x *= 128
            controlChips.addChild(chip)
        }
        controlChips.position = CGPoint(x: 0, y: -62)
        [card, overlayTitle, overlayText, overlayHint, controlChips].forEach(overlay.addChild)
        overlay.position = CGPoint(x: size.width / 2, y: size.height / 2 + 30)
        overlay.zPosition = 10
        addChild(overlay)
        updateHUD()
    }

    private func showOverlay(_ title: String, _ text: String, _ hint: String, tint: NSColor, chips: Bool = false) {
        overlayTitle.text = title
        overlayTitle.fontColor = tint
        overlayText.text = text
        overlayHint.text = hint
        overlayHint.isHidden = chips
        controlChips.isHidden = !chips
        (overlay.childNode(withName: "card") as? SKShapeNode)?.strokeColor = tint.withAlphaComponent(0.6)
        overlay.isHidden = false
        onVisualChange?()
    }

    /// "+25" style text that floats up and fades.
    private func popup(_ text: String, at point: CGPoint, color: NSColor) {
        let label = SKLabelNode(fontNamed: "Menlo-Bold")
        label.text = text
        label.fontSize = 18
        label.fontColor = color
        label.position = point
        world.addChild(label)
        label.run(.sequence([.group([.moveBy(x: -30, y: 46, duration: 0.6), .fadeOut(withDuration: 0.6)]), .removeFromParent()]))
    }

    /// A little puff of dust when the runner lands.
    private func dust() {
        for i in 0..<5 {
            let puff = dot(radius: .random(in: 3...6), color: NSColor.white.withAlphaComponent(0.25))
            puff.position = CGPoint(x: playerX + CGFloat(i - 2) * 9, y: groundY + 3)
            world.addChild(puff)
            puff.run(.sequence([.group([.moveBy(x: CGFloat(i - 2) * 14 - 30, y: .random(in: 6...18), duration: 0.35),
                                        .fadeOut(withDuration: 0.35)]), .removeFromParent()]))
        }
    }

    // MARK: Controls

    /// Controller buttons (and keyboard keys mapped to them) by PadCoder's button names.
    func press(_ button: String, _ down: Bool) {
        switch button {
        case "cross", "up":
            if down { primary() }
        case "circle", "down":
            if phase == .playing { setSliding(down) }
        case "r2", "square", "right", "r1":
            if down && phase == .playing { dash() }
        case "options":
            if down { phase == .playing ? pause() : primary() }
        default:
            break
        }
    }

    private func primary() {
        switch phase {
        case .ready, .over: start()
        case .paused: resume()
        case .playing: jump()
        }
    }

    private func start() {
        things.forEach { $0.node.removeFromParent() }
        things.removeAll()
        runSpeed = 430; distance = 0; tokens = 0; bonus = 0; smashed = 0; wasAirborne = false
        py = 0; vy = 0; jumpsLeft = 2; energy = 1; dashLeft = 0
        nextSpawnAt = 700
        setSliding(false)
        overlay.isHidden = true
        lastTime = 0
        phase = .playing
        onEvent?(.start)
    }

    func pause() {
        guard phase == .playing else { return }
        phase = .paused
        setSliding(false)
        showOverlay("Paused", "Score \(score)", "✕ resume", tint: .white)
    }

    private func resume() {
        overlay.isHidden = true
        lastTime = 0
        phase = .playing
    }

    /// A Claude banner over the paused game (finished / needs you).
    func showClaudeBanner(_ title: String, _ text: String, tint: NSColor) {
        if phase == .playing { phase = .paused; setSliding(false) }
        showOverlay(title, text, phase == .paused ? "✕ resume when you're back" : "✕ to start", tint: tint)
    }

    private func jump() {
        if sliding { setSliding(false) }
        guard jumpsLeft > 0 else { return }
        vy = jumpsLeft == 2 ? 930 : 820
        jumpsLeft -= 1
        onEvent?(.jump)
        bodyNode.run(.sequence([.scaleX(to: 0.85, y: 1.15, duration: 0.07), .scale(to: 1, duration: 0.18)]))
        if jumpsLeft == 0 { bodyNode.run(.rotate(byAngle: -.pi * 2, duration: 0.45)) }
    }

    private func setSliding(_ on: Bool) {
        guard on != sliding else { return }
        sliding = on
        if on && py > 0 { vy = min(vy, -900) }   // fast-fall into a slide
        bodyNode.removeAction(forKey: "slide")
        bodyNode.run(on ? .scaleX(to: 1.2, y: 0.5, duration: 0.06) : .scale(to: 1, duration: 0.08), withKey: "slide")
    }

    private func dash() {
        guard energy >= 0.5, dashLeft <= 0 else { return }
        energy -= 0.5
        dashLeft = 0.45
        onEvent?(.dash)
    }

    // MARK: Spawning

    private func makeBug() -> SKNode {
        let n = SKNode()
        for (i, side) in [-1.0, 1.0].enumerated() {
            for leg in 0..<3 {
                let path = CGMutablePath()
                let x = CGFloat(leg - 1) * 11
                path.move(to: CGPoint(x: x, y: 12))
                path.addLine(to: CGPoint(x: x + CGFloat(side) * 4 + CGFloat(i) * 2, y: 0))
                let l = SKShapeNode(path: path)
                l.strokeColor = NSColor(srgbRed: 0.45, green: 0.1, blue: 0.12, alpha: 1)
                l.lineWidth = 3
                n.addChild(l)
            }
        }
        let shell = SKShapeNode(ellipseOf: CGSize(width: 46, height: 34))
        shell.fillColor = bugRed
        shell.strokeColor = NSColor(srgbRed: 0.55, green: 0.12, blue: 0.14, alpha: 1)
        shell.lineWidth = 2
        shell.position = CGPoint(x: 0, y: 20)
        let seam = SKShapeNode(rect: CGRect(x: -1, y: 4, width: 2, height: 32))
        seam.fillColor = NSColor(srgbRed: 0.55, green: 0.12, blue: 0.14, alpha: 1)
        seam.strokeColor = .clear
        let head = SKShapeNode(circleOfRadius: 11)
        head.fillColor = NSColor(srgbRed: 0.35, green: 0.08, blue: 0.1, alpha: 1)
        head.strokeColor = .clear
        head.position = CGPoint(x: -24, y: 18)
        for dy in [-4.0, 4.0] {
            let eye = SKShapeNode(circleOfRadius: 2.6)
            eye.fillColor = .white
            eye.strokeColor = .clear
            eye.position = CGPoint(x: -4, y: dy)
            head.addChild(eye)
        }
        [shell, seam, head].forEach(n.addChild)
        n.run(.repeatForever(.sequence([.moveBy(x: 0, y: 3, duration: 0.14), .moveBy(x: 0, y: -3, duration: 0.14)])))
        return n
    }

    private func makeFailBar() -> SKNode {
        let n = SKNode()
        let bar = SKShapeNode(rect: CGRect(x: -80, y: 0, width: 160, height: 36), cornerRadius: 9)
        bar.fillColor = NSColor(srgbRed: 0.78, green: 0.2, blue: 0.23, alpha: 1)
        bar.strokeColor = NSColor(srgbRed: 1, green: 0.45, blue: 0.45, alpha: 0.8)
        bar.glowWidth = 2
        let label = SKLabelNode(fontNamed: "Menlo-Bold")
        label.text = "✗ test failed"
        label.fontSize = 15
        label.fontColor = .white
        label.verticalAlignmentMode = .center
        label.position = CGPoint(x: 0, y: 18)
        [bar, label].forEach(n.addChild)
        return n
    }

    private func makeToken() -> SKNode {
        let t = SKShapeNode(rectOf: CGSize(width: 18, height: 18), cornerRadius: 3)
        t.fillColor = orangeLight
        t.strokeColor = .white
        t.lineWidth = 1.5
        t.glowWidth = 4
        t.zRotation = .pi / 4
        t.run(.repeatForever(.sequence([.scale(to: 1.15, duration: 0.3), .scale(to: 1, duration: 0.3)])))
        return t
    }

    private func spawn(_ kind: Kind, at x: CGFloat, lift: CGFloat = 0) {
        let node: SKNode
        let hitbox: CGSize
        var bottom = lift
        switch kind {
        case .bug: node = makeBug(); hitbox = CGSize(width: 40, height: 34)
        case .failBar: node = makeFailBar(); hitbox = CGSize(width: 150, height: 34); bottom = 42
        case .token: node = makeToken(); hitbox = CGSize(width: 26, height: 26)
        }
        node.position = CGPoint(x: x, y: groundY + bottom + (kind == .token ? 13 : 0))
        world.addChild(node)
        things.append(Thing(node: node, kind: kind, size: hitbox, lift: bottom))
    }

    private func spawnPattern() {
        let x = size.width + 120
        let roll = Double.random(in: 0..<1)
        if roll < 0.42 {
            spawn(.bug, at: x)
        } else if roll < 0.68 {
            spawn(.failBar, at: x)
        } else if roll < 0.84 {
            spawn(.bug, at: x)
            spawn(.bug, at: x + 92)
        } else {
            spawn(.bug, at: x)
            spawn(.token, at: x, lift: 150)
        }
        if Bool.random() {
            let lift: CGFloat = Bool.random() ? 20 : 120
            for i in 0..<3 { spawn(.token, at: x + 300 + CGFloat(i) * 46, lift: lift + (i == 1 ? 18 : 0)) }
        }
    }

    // MARK: Loop

    override func update(_ currentTime: TimeInterval) {
        let dt = CGFloat(lastTime == 0 ? 1.0 / 60 : min(currentTime - lastTime, 1.0 / 20))
        lastTime = currentTime
        updateHUD()
        guard phase == .playing else { return }

        runSpeed = min(1150, runSpeed + 14 * dt)
        let speed = runSpeed * (dashLeft > 0 ? 1.7 : 1)
        dashLeft -= dt
        energy = min(1, energy + 0.07 * dt)
        distance += speed * dt

        vy -= 2700 * dt
        py += vy * dt
        if py <= 0 { py = 0; vy = 0; jumpsLeft = 2 }
        if wasAirborne && py == 0 { dust() }
        wasAirborne = py > 0
        player.position = CGPoint(x: playerX, y: groundY + py)
        if py == 0 && !sliding && bodyNode.action(forKey: "run") == nil && jumpsLeft == 2 {
            bodyNode.run(.repeatForever(.sequence([.moveBy(x: 0, y: 3, duration: 0.09), .moveBy(x: 0, y: -3, duration: 0.09)])), withKey: "run")
        } else if py > 0 || sliding {
            bodyNode.removeAction(forKey: "run")
        }

        for line in codeLines {
            line.label.position.x -= speed * line.depth * dt
            if line.label.position.x < -420 {
                line.label.text = codeSnippets.randomElement()
                line.label.position = CGPoint(x: size.width + .random(in: 0...200), y: .random(in: (groundY + 40)...(size.height - 70)))
            }
        }
        for mark in groundMarks {
            mark.position.x -= speed * dt
            if mark.position.x < -40 { mark.position.x += CGFloat(groundMarks.count) * 80 }
        }

        trailClock += dt
        if trailClock > (dashLeft > 0 ? 0.015 : 0.04) {
            trailClock = 0
            let spark = dot(radius: dashLeft > 0 ? 9 : 5, color: (dashLeft > 0 ? orangeLight : orange).withAlphaComponent(0.6))
            spark.position = CGPoint(x: playerX - 22, y: groundY + py + (sliding ? 10 : 22))
            world.addChild(spark)
            spark.run(.sequence([.group([.moveBy(x: -60, y: 0, duration: 0.35), .fadeOut(withDuration: 0.35), .scale(to: 0.3, duration: 0.35)]), .removeFromParent()]))
        }

        if distance >= nextSpawnAt {
            spawnPattern()
            nextSpawnAt = distance + speed * .random(in: 1.0...1.75)
        }

        let me = sliding ? CGRect(x: playerX - 27, y: py, width: 54, height: 26)
                         : CGRect(x: playerX - 20, y: py, width: 40, height: 50)
        for i in things.indices.reversed() {
            let t = things[i]
            t.node.position.x -= speed * dt
            if t.node.position.x < -200 {
                t.node.removeFromParent()
                things.remove(at: i)
                continue
            }
            let box = CGRect(x: t.node.position.x - t.size.width / 2, y: t.lift, width: t.size.width, height: t.size.height)
            guard me.intersects(box) else { continue }
            switch t.kind {
            case .token:
                tokens += 1
                energy = min(1, energy + 0.2)
                onEvent?(.token)
                popup("+25", at: CGPoint(x: t.node.position.x, y: t.node.position.y + 18), color: orangeLight)
                t.node.run(.sequence([.group([.scale(to: 2, duration: 0.15), .fadeOut(withDuration: 0.15)]), .removeFromParent()]))
                things.remove(at: i)
            case .bug, .failBar:
                if dashLeft > 0 {
                    bonus += 50
                    smashed += 1
                    onEvent?(.smash)
                    popup("+50", at: CGPoint(x: t.node.position.x, y: groundY + t.lift + 50), color: .white)
                    t.node.run(.sequence([.group([.scale(to: 0.1, duration: 0.18), .fadeOut(withDuration: 0.18)]), .removeFromParent()]))
                    things.remove(at: i)
                } else {
                    gameOver()
                    return
                }
            }
        }
    }

    private func gameOver() {
        phase = .over
        setSliding(false)
        onEvent?(.hit)
        world.run(.sequence([.moveBy(x: 12, y: 0, duration: 0.04), .moveBy(x: -24, y: 0, duration: 0.06),
                             .moveBy(x: 16, y: 0, duration: 0.05), .moveBy(x: -4, y: 0, duration: 0.04)]))
        let newBest = score > best
        if newBest {
            best = score
            if recordsBest { UserDefaults.standard.set(best, forKey: "bugdash.best") }
        }
        showOverlay(newBest ? "New best!" : "Squashed by a bug", "Score \(score)  ·  Best \(best)",
                    "\(Int(distance / 100)) m  ·  \(tokens) tokens  ·  \(smashed) bugs smashed  ·  ✕ run again",
                    tint: newBest ? orangeLight : bugRed)
    }

    /// Redraws HUD pieces only when their values change, so a quiet frame costs nothing extra.
    private func updateHUD() {
        if score != shownScore {
            shownScore = score
            scoreLabel.text = String(format: "%06d", score)
            bestLabel.text = "BEST \(String(format: "%06d", max(best, score)))"
        }
        let (text, color) = claudeStatus()
        if text != shownStatus {
            shownStatus = text
            statusLabel.text = text
            statusLabel.fontColor = NSColor.white.withAlphaComponent(0.85)
            statusDot.fillColor = color
            let width = statusLabel.frame.width
            statusDot.position = CGPoint(x: size.width - 54 - width, y: size.height - 42)
            statusPill.path = CGPath(roundedRect: CGRect(x: size.width - 70 - width, y: size.height - 60, width: width + 48, height: 36),
                                     cornerWidth: 18, cornerHeight: 18, transform: nil)
            statusDot.isHidden = text.isEmpty
            statusPill.isHidden = text.isEmpty
        }
        let step = (energy * 50).rounded() / 50
        if step != shownEnergy {
            shownEnergy = step
            energyFill.path = CGPath(roundedRect: CGRect(x: 72, y: 32, width: max(10, 140 * step), height: 10),
                                     cornerWidth: 5, cornerHeight: 5, transform: nil)
            energyFill.fillColor = energy >= 0.5 ? orange : NSColor.white.withAlphaComponent(0.25)
        }
    }
}

/// SKView that also plays with the keyboard: space / ↑ jump, ↓ slide, → or shift dash, esc pause.
final class RunnerView: SKView {
    override var acceptsFirstResponder: Bool { true }
    private func button(for event: NSEvent) -> String? {
        switch event.keyCode {
        case 49, 126, 36: return "cross"
        case 125: return "circle"
        case 124: return "r2"
        case 53: return "options"
        default: return nil
        }
    }
    override func keyDown(with event: NSEvent) {
        guard let name = button(for: event), let scene = scene as? RunnerScene else { return super.keyDown(with: event) }
        if !event.isARepeat { scene.press(name, true) }
    }
    override func keyUp(with event: NSEvent) {
        guard let name = button(for: event), let scene = scene as? RunnerScene else { return super.keyUp(with: event) }
        scene.press(name, false)
    }
    override func flagsChanged(with event: NSEvent) {
        if event.keyCode == 56 || event.keyCode == 60, event.modifierFlags.contains(.shift) {
            (scene as? RunnerScene)?.press("r2", true)
        }
    }
}

/// Owns the Bug Dash window. PadCoder routes the pad here while the window is in front.
final class GameWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private(set) var scene: RunnerScene?
    var onEvent: ((RunnerEvent) -> Void)?
    var claudeStatus: () -> (String, NSColor) = { ("", .gray) }
    private var hideWork: DispatchWorkItem?

    var isFocused: Bool { (window?.isKeyWindow ?? false) && NSApp.isActive }
    var isVisible: Bool { window?.isVisible ?? false }

    func toggle() { isFocused ? hide(returnToClaude: true) : show() }

    func show() {
        hideWork?.cancel()
        if window == nil {
            let scene = RunnerScene(size: CGSize(width: 1000, height: 560))
            scene.onEvent = { [weak self] in self?.onEvent?($0) }
            scene.claudeStatus = { [weak self] in self?.claudeStatus() ?? ("", .gray) }
            let view = RunnerView(frame: NSRect(x: 0, y: 0, width: 1000, height: 560))
            view.ignoresSiblingOrder = true
            view.preferredFramesPerSecond = 60   // no need for 120 Hz on ProMotion screens
            view.presentScene(scene)
            scene.onVisualChange = { [weak self] in self?.settleRendering() }
            let w = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.title = "Bug Dash"
            w.titleVisibility = .hidden
            w.titlebarAppearsTransparent = true
            w.appearance = NSAppearance(named: .darkAqua)
            w.backgroundColor = scene.backgroundColor
            w.contentView = view
            w.contentAspectRatio = NSSize(width: 1000, height: 560)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            window = w
            self.scene = scene
        }
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(window?.contentView)
        NSApp.activate(ignoringOtherApps: true)
        settleRendering()
        log("bug dash shown")
    }

    private var view: SKView? { window?.contentView as? SKView }
    private var settleWork: DispatchWorkItem?

    /// SpriteKit renders 60 frames a second even on a still screen, so the view only runs while you're
    /// playing, plus a moment after a card changes so it gets drawn.
    private func settleRendering() {
        settleWork?.cancel()
        view?.isPaused = false
        guard let scene, scene.phase != .playing else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.scene?.phase != .playing else { return }
            self.view?.isPaused = true
        }
        settleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    func hide(returnToClaude: Bool) {
        hideWork?.cancel()
        scene?.pause()
        settleWork?.cancel()
        view?.isPaused = true
        window?.orderOut(nil)
        dropDockIconIfNoWindows()
        if returnToClaude {
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first?
                .activate(options: [])
        }
        log("bug dash hidden")
    }

    /// Claude finished or needs you: show a banner on the paused game, then hand focus back to Claude.
    func claudeNeedsAttention(finished: Bool) {
        guard isVisible, let scene else { return }
        let green = NSColor(srgbRed: 0.3, green: 0.85, blue: 0.5, alpha: 1)
        let red = NSColor(srgbRed: 0.95, green: 0.3, blue: 0.3, alpha: 1)
        scene.showClaudeBanner(finished ? "Claude finished ✓" : "Claude needs you",
                               finished ? "Back to work. Your run is paused." : "Approve or deny the request.",
                               tint: finished ? green : red)
        let work = DispatchWorkItem { [weak self] in self?.hide(returnToClaude: true) }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (finished ? 1.4 : 0.3), execute: work)
    }

    func press(_ button: String, _ down: Bool) { scene?.press(button, down) }

    func windowDidResignKey(_ notification: Notification) { scene?.pause() }

    func windowWillClose(_ notification: Notification) {
        scene?.pause()
        DispatchQueue.main.async { dropDockIconIfNoWindows() }
    }
}

/// PadCoder is a menu bar app: it only shows in the Dock while one of its windows is open.
func dropDockIconIfNoWindows() {
    let open = NSApp.windows.contains { $0.isVisible && $0.styleMask.contains(.titled) }
    if !open { NSApp.setActivationPolicy(.accessory) }
}
