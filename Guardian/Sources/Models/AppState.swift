import SwiftUI


/// AG 进程状态
enum AGStatus: String {
    case running = "运行中"
    case stopped = "未运行"
}

/// Guardian 整体状态
enum GuardianStatus {
    case protecting   // AG 运行 + .pb 文件最近有更新
    case warning      // AG 运行 + .pb 文件长时间没更新
    case standby      // AG 未运行
    case offline      // 备份目录不存在
}

/// 单个对话条目
struct ConversationItem: Identifiable, Hashable {
    let id: String          // cascadeId
    var title: String
    var lastModified: Date
    var isInAGIndex: Bool   // 是否已在 state.vscdb 索引中
    var isSelected: Bool    // 用户是否勾选恢复

    var displayTitle: String {
        title.isEmpty ? "Untitled (\(id.prefix(8))…)" : title
    }
}

class AppState: ObservableObject {
    @Published var status: GuardianStatus = .standby
    @Published var agStatus: AGStatus = .stopped
    @Published var backupCount: Int = 0
    @Published var indexedCount: Int = 0
    @Published var conversations: [ConversationItem] = []
    @Published var lastScanTime: Date? = nil
    @Published var isRecovering: Bool = false
    @Published var recoveryMessage: String = ""
    @Published var searchText: String = ""

    private let monitor = StatusMonitor()
    private let recovery = RecoveryManager()

    var statusIcon: String {
        switch status {
        case .protecting: return "shield.checkmark.fill"
        case .warning:    return "shield.trianglebadge.exclamationmark.fill"
        case .standby:    return "shield.slash"
        case .offline:    return "shield.slash"
        }
    }

    var statusColor: Color {
        switch status {
        case .protecting: return .green
        case .warning:    return .yellow
        case .standby:    return .gray
        case .offline:    return .red
        }
    }

    var statusText: String {
        switch status {
        case .protecting: return "保护中"
        case .warning:    return "插件可能异常"
        case .standby:    return "待命"
        case .offline:    return "离线"
        }
    }

    var statusEmoji: String {
        switch status {
        case .protecting: return "🛡"
        case .warning:    return "⚠️"
        case .standby:    return "⏸"
        case .offline:    return "🔴"
        }
    }

    var missingCount: Int {
        conversations.filter { !$0.isInAGIndex }.count
    }

    var selectedCount: Int {
        conversations.filter { $0.isSelected }.count
    }

    var filteredConversations: [ConversationItem] {
        if searchText.isEmpty { return conversations }
        return conversations.filter {
            $0.title.localizedCaseInsensitiveContains(searchText)
        }
    }

    init() {
        // 不自动启动定时器 — 由 AppDelegate 控制
    }

    func scan() async {
        let result = monitor.scan()
        agStatus = result.agRunning ? .running : .stopped
        backupCount = result.backupPbCount
        indexedCount = result.indexedCount
        lastScanTime = Date()

        if !result.backupDirExists {
            status = .offline
        } else if result.agRunning {
            status = result.recentlyUpdated ? .protecting : .warning
            // AG 已启动，清除恢复消息
            if !recoveryMessage.isEmpty { recoveryMessage = "" }
        } else {
            status = .standby
        }

        // 合并新数据，保留用户的 isSelected 状态
        let oldSelections = Dictionary(uniqueKeysWithValues: conversations.map { ($0.id, $0.isSelected) })
        conversations = result.conversations.map { item in
            var updated = item
            if let wasSelected = oldSelections[item.id] {
                updated.isSelected = wasSelected
            }
            return updated
        }
    }

    func toggleAll(_ selected: Bool) {
        for i in conversations.indices {
            conversations[i].isSelected = selected
        }
    }

    func recover() async {
        guard !isRecovering else { return }
        isRecovering = true
        recoveryMessage = ""

        // 检查 AG
        if monitor.isAGRunning() {
            recoveryMessage = "⚠️ 请先退出 AG (Cmd+Q)"
            isRecovering = false
            return
        }

        let selectedIds = Set(conversations.filter { $0.isSelected }.map { $0.id })
        let result = await recovery.inject(selectedIds: selectedIds)

        if result.success {
            recoveryMessage = "✅ 已恢复 \(result.count) 个对话\n\(result.details)"
        } else {
            recoveryMessage = "❌ 恢复失败: \(result.error)\n\(result.details)"
        }
        isRecovering = false

        // 刷新状态
        await scan()
    }

    func launchAG() {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Antigravity.app"))
    }

    func openBackupFolder() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let backupDir = "\(home)/.ag-recover"
        NSWorkspace.shared.open(URL(fileURLWithPath: backupDir))
    }
}
