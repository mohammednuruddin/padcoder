// PadCoder — drive Claude (or any Mac app) with a PS5 DualSense or PS4 DualShock controller.
// App shell: menu bar item, Accessibility check, login item.

import AppKit
import ApplicationServices
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    let pad = PadCoder()
    lazy var settings = SettingsWindowController(model: pad.model, store: ConfigStore(config: pad.config))
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

/// The orange gamepad badge, used for the Dock and ⌘-Tab while the window is open.
func makeAppIcon() -> NSImage {
    NSImage(size: NSSize(width: 512, height: 512), flipped: false) { rect in
        let tile = NSBezierPath(roundedRect: rect.insetBy(dx: 50, dy: 50), xRadius: 92, yRadius: 92)
        NSGradient(starting: NSColor(srgbRed: 0.96, green: 0.62, blue: 0.47, alpha: 1), ending: claudeOrange)?
            .draw(in: tile, angle: -90)
        let config = NSImage.SymbolConfiguration(pointSize: 210, weight: .semibold)
            .applying(.init(paletteColors: [.white]))
        if let pad = NSImage(systemSymbolName: "gamecontroller.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(config) {
            let s = pad.size
            pad.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height))
        }
        return true
    }
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
