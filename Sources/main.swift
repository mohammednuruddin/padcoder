// PadCoder — drive Claude (or any Mac app) with a PS5 DualSense or PS4 DualShock controller.
// App shell: menu bar item, Accessibility check, login item.

import AppKit
import ApplicationServices
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    let pad = PadCoder()
    lazy var settings = SettingsWindowController(model: pad.model, store: ConfigStore(config: pad.config))
    let game = GameWindowController()
    var status: NSStatusItem!
    var pauseItem: NSMenuItem!
    var loginItem: NSMenuItem!

    private var installed: Bool { Bundle.main.bundlePath.hasPrefix("/Applications/") }

    func applicationDidFinishLaunching(_ note: Notification) {
        log("---- PadCoder starting (pid \(getpid())) from \(Bundle.main.bundlePath)")
        NSApp.mainMenu = makeMainMenu()
        NSApp.applicationIconImage = makeAppIcon()
        let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        log("accessibility trusted: \(trusted)")
        if !trusted { watchTrust() }

        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "🎮"
        let menu = NSMenu()
        item(menu, "Open PadCoder…", #selector(openSettings))
        item(menu, "Play Bug Dash (L1 + touchpad)", #selector(playGame))
        menu.addItem(.separator())
        pauseItem = item(menu, "Pause (Create button)", #selector(togglePause))
        item(menu, "Edit Config File…", #selector(editConfig))
        loginItem = item(menu, "Launch at Login", #selector(toggleLogin))
        item(menu, "Open Log", #selector(openLog))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit PadCoder", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        status.menu = menu

        pad.onPauseChange = { [weak self] paused in
            self?.pauseItem.title = paused ? "Resume (Create button)" : "Pause (Create button)"
            self?.status.button?.title = paused ? "⏸︎🎮" : "🎮"
        }
        pad.game = game
        game.onEvent = { [weak self] in self?.pad.gameHaptic($0) }
        game.claudeStatus = { [weak self] in
            guard let model = self?.pad.model else { return ("", .gray) }
            if model.paused { return ("PadCoder paused", .gray) }
            switch model.claudeState {
            case .idle: return ("Claude idle", claudeOrange)
            case .working: return ("Claude is working…", NSColor(srgbRed: 0.3, green: 0.5, blue: 1, alpha: 1))
            case .needsYou: return ("Claude needs you", NSColor(srgbRed: 0.95, green: 0.3, blue: 0.3, alpha: 1))
            case .done: return ("Claude finished", NSColor(srgbRed: 0.3, green: 0.85, blue: 0.5, alpha: 1))
            }
        }
        pad.model.onPlayGame = { [weak self] in self?.game.show() }
        pad.start()
        setUpLoginItem()
        if !UserDefaults.standard.bool(forKey: "settingsShownOnce") {
            UserDefaults.standard.set(true, forKey: "settingsShownOnce")
            settings.show()
        }
    }

    /// Opening the app again (Spotlight, Finder, `open`) shows the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        settings.show()
        return false
    }

    func applicationWillTerminate(_ note: Notification) { pad.shutdown() }

    @discardableResult
    private func item(_ menu: NSMenu, _ title: String, _ action: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        menu.addItem(i)
        return i
    }

    private func watchTrust() {
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { t in
            if AXIsProcessTrusted() { log("accessibility trusted: true"); t.invalidate() }
        }
    }

    /// Only the /Applications copy registers itself, once; after that the menu toggle owns it.
    private func setUpLoginItem() {
        guard installed else {
            loginItem.title = "Launch at Login (install to /Applications first)"
            loginItem.isEnabled = false
            return
        }
        let svc = SMAppService.mainApp
        if !UserDefaults.standard.bool(forKey: "loginItemConfigured") {
            UserDefaults.standard.set(true, forKey: "loginItemConfigured")
            do { try svc.register() } catch { log("login item error: \(error)") }
        }
        log("login item status: \(describe(svc.status))")
        loginItem.state = svc.status == .enabled ? .on : .off
    }

    private func describe(_ s: SMAppService.Status) -> String {
        switch s {
        case .enabled: return "enabled"
        case .requiresApproval: return "needs approval in System Settings > General > Login Items"
        case .notRegistered: return "not registered"
        case .notFound: return "not found"
        @unknown default: return "unknown"
        }
    }

    @objc func toggleLogin() {
        let svc = SMAppService.mainApp
        do {
            if svc.status == .enabled { try svc.unregister() } else { try svc.register() }
        } catch { log("login item error: \(error)") }
        log("login item status: \(describe(svc.status))")
        loginItem.state = svc.status == .enabled ? .on : .off
    }

    @objc func openSettings() { settings.show() }
    @objc func playGame() { game.show() }
    @objc func togglePause() { pad.togglePause() }
    @objc func editConfig() { NSWorkspace.shared.open(configURL) }
    @objc func openLog() { NSWorkspace.shared.open(logURL) }
}

/// App, Edit and Window menus, so copy/paste/undo and ⌘W/⌘Q work while the window is open.
func makeMainMenu() -> NSMenu {
    let main = NSMenu()
    func submenu(_ title: String, _ items: [(String, String, String, NSEvent.ModifierFlags)]) {
        let menu = NSMenu(title: title)
        for (name, selector, key, mods) in items {
            let item = NSMenuItem(title: name, action: Selector(selector), keyEquivalent: key)
            item.keyEquivalentModifierMask = mods
            menu.addItem(item)
        }
        let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        holder.submenu = menu
        main.addItem(holder)
    }
    submenu("PadCoder", [("Hide PadCoder", "hide:", "h", .command), ("Quit PadCoder", "terminate:", "q", .command)])
    submenu("Edit", [("Undo", "undo:", "z", .command), ("Redo", "redo:", "z", [.command, .shift]),
                     ("Cut", "cut:", "x", .command), ("Copy", "copy:", "c", .command),
                     ("Paste", "paste:", "v", .command), ("Select All", "selectAll:", "a", .command)])
    submenu("Window", [("Close", "performClose:", "w", .command), ("Minimize", "performMiniaturize:", "m", .command)])
    return main
}

// `PadCoder --render-icon <dir.iconset>` writes the icon PNGs for build.sh and exits.
if let i = CommandLine.arguments.firstIndex(of: "--render-icon"), i + 1 < CommandLine.arguments.count {
    renderIconSet(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
    exit(0)
}

// `PadCoder --snapshot <dir>` renders the UI to PNGs and exits (layout checks without a screen).
if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), i + 1 < CommandLine.arguments.count {
    MainActor.assumeIsolated { renderSnapshots(to: URL(fileURLWithPath: CommandLine.arguments[i + 1])) }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
