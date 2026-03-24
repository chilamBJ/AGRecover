import Foundation
import AppKit

/// 扫描结果
struct ScanResult {
    var agRunning: Bool
    var backupDirExists: Bool
    var backupPbCount: Int
    var indexedCount: Int
    var recentlyUpdated: Bool
    var conversations: [ConversationItem]
}

class StatusMonitor {
    private let backupDir: String
    private let stateDbPath: String
    private let agConversationsDir: String

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.backupDir = "\(home)/.ag-recover"
        self.stateDbPath = "\(home)/Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
        self.agConversationsDir = "\(home)/.gemini/antigravity/conversations"
    }

    func isAGRunning() -> Bool {
        let apps = NSWorkspace.shared.runningApplications
        return apps.contains { app in
            app.bundleIdentifier == "com.google.antigravity" ||
            app.localizedName?.lowercased().contains("antigravity") == true
        }
    }

    func scan() -> ScanResult {
        let agRunning = isAGRunning()
        let fm = FileManager.default
        let pbDir = "\(backupDir)/conversations"
        let mdDir = "\(backupDir)/conversations_md"
        let backupExists = fm.fileExists(atPath: backupDir)

        // 数 .pb 文件
        var pbFiles: [String] = []
        if let files = try? fm.contentsOfDirectory(atPath: pbDir) {
            pbFiles = files.filter { $0.hasSuffix(".pb") }
        }

        // 检查最近更新（10 分钟内有 .pb 文件变化 = recently updated）
        var recentlyUpdated = false
        let tenMinAgo = Date().addingTimeInterval(-600)
        for f in pbFiles {
            if let attrs = try? fm.attributesOfItem(atPath: "\(pbDir)/\(f)"),
               let mtime = attrs[.modificationDate] as? Date,
               mtime > tenMinAgo {
                recentlyUpdated = true
                break
            }
        }

        // 读 state.vscdb 获取已索引的对话 ID
        let indexedIds = readIndexedIds()

        // 构建对话列表
        var conversations: [ConversationItem] = []
        let knownIds = Set(pbFiles.map { $0.replacingOccurrences(of: ".pb", with: "") })

        // 从 MD metadata 获取标题
        var titleMap: [String: String] = [:]
        var mtimeMap: [String: Date] = [:]
        if let dirs = try? fm.contentsOfDirectory(atPath: mdDir) {
            for d in dirs where !d.hasPrefix("_") {
                let metaPath = "\(mdDir)/\(d)/metadata.json"
                if let data = fm.contents(atPath: metaPath),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    titleMap[d] = json["title"] as? String ?? ""
                    if let ts = json["lastModifiedTime"] as? String {
                        mtimeMap[d] = ISO8601DateFormatter().date(from: ts)
                    }
                }
            }
        }

        for id in knownIds {
            let title = titleMap[id] ?? ""
            let isIndexed = indexedIds.contains(id)
            let mtime = mtimeMap[id] ?? {
                let attrs = try? fm.attributesOfItem(atPath: "\(pbDir)/\(id).pb")
                return (attrs?[.modificationDate] as? Date) ?? Date.distantPast
            }()

            conversations.append(ConversationItem(
                id: id,
                title: title,
                lastModified: mtime,
                isInAGIndex: isIndexed,
                isSelected: !isIndexed  // 默认勾选缺失的
            ))
        }

        // 按时间倒序
        conversations.sort { $0.lastModified > $1.lastModified }

        return ScanResult(
            agRunning: agRunning,
            backupDirExists: backupExists,
            backupPbCount: pbFiles.count,
            indexedCount: indexedIds.count,
            recentlyUpdated: recentlyUpdated,
            conversations: conversations
        )
    }

    /// 读 state.vscdb 中 trajectorySummaries 的已索引 ID
    private func readIndexedIds() -> Set<String> {
        guard FileManager.default.fileExists(atPath: stateDbPath) else { return [] }

        // 使用 sqlite3 命令行读取（避免引入 SQLite 库）
        let key = "antigravityUnifiedStateSync.trajectorySummaries"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [stateDbPath, "SELECT value FROM ItemTable WHERE key = '\(key)';"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let b64 = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !b64.isEmpty,
                  let raw = Data(base64Encoded: b64) else { return [] }

            return ProtobufCodec.parseEntryIds(from: raw)
        } catch {
            return []
        }
    }
}
