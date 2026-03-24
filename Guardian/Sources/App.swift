import AppKit
import SwiftUI

@main
struct AGGuardianMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var appState: AppState!
    private var refreshTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        appState = AppState()

        // 菜单栏
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🛡 AGR"
            button.action = #selector(togglePopover(_:))
            button.target = self
        }

        // Popover
        popover = NSPopover()
        popover.contentSize = NSSize(width: 380, height: 500)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: PopoverView().environmentObject(appState)
        )

        // 首次立即扫描
        refreshState()

        // 每 3 秒自动刷新（更快感知 AG 状态变化）
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.refreshState()
        }

        NSLog("[AG Guardian] Ready")
    }

    private func refreshState() {
        Task {
            await appState.scan()
            DispatchQueue.main.async { self.updateButton() }
        }
    }

    @objc func togglePopover(_ sender: Any?) {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
            refreshState()
        }
    }

    private func updateButton() {
        guard let button = statusItem.button else { return }
        let emoji: String
        switch appState.status {
        case .protecting: emoji = "🟢"
        case .warning:    emoji = "🟡"
        case .standby:    emoji = "⚪"
        case .offline:    emoji = "🔴"
        }
        let count = appState.backupCount
        button.title = "\(emoji) AGR\(count > 0 ? " (\(count))" : "")"
    }
}
