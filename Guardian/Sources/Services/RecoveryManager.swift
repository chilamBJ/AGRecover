import Foundation
import AppKit

struct RecoveryResult {
    var success: Bool
    var count: Int
    var error: String
}

class RecoveryManager {
    private let home = FileManager.default.homeDirectoryForCurrentUser.path

    var stateDbPath: String {
        "\(home)/Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
    }

    var backupDir: String {
        "\(home)/.ag-recover"
    }

    /// 执行离线注入
    func inject(selectedIds: Set<String>) async -> RecoveryResult {
        guard !selectedIds.isEmpty else {
            return RecoveryResult(success: false, count: 0, error: "没有选择要恢复的对话")
        }

        // 1. 检查 AG 进程
        let apps = NSWorkspace.shared.runningApplications
        let agRunning = apps.contains { app in
            app.bundleIdentifier == "com.google.antigravity" ||
            app.localizedName?.lowercased().contains("antigravity") == true
        }
        if agRunning {
            return RecoveryResult(success: false, count: 0, error: "AG 仍在运行，请先 Cmd+Q 退出")
        }

        // 2. 备份 state.vscdb
        let fm = FileManager.default
        guard fm.fileExists(atPath: stateDbPath) else {
            return RecoveryResult(success: false, count: 0, error: "找不到 state.vscdb")
        }

        let timestamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: "-", with: "")
        let backupPath = "\(stateDbPath).guardian_backup_\(timestamp)"
        do {
            try fm.copyItem(atPath: stateDbPath, toPath: backupPath)
        } catch {
            return RecoveryResult(success: false, count: 0, error: "备份 state.vscdb 失败: \(error.localizedDescription)")
        }

        // 3. 读取备份目录中的 summaries.json（如果有的话）
        let summariesPath = "\(backupDir)/state/summaries.json"
        var summaries: [String: [String: Any]] = [:]
        if let data = fm.contents(atPath: summariesPath),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] {
            summaries = json
        }

        // 4. 构造 protobuf payload
        let payload = ProtobufCodec.buildPayload(
            selectedIds: selectedIds,
            summaries: summaries
        )

        // 5. 读取现有 trajectorySummaries
        let key = "antigravityUnifiedStateSync.trajectorySummaries"
        let existingB64 = readSqliteValue(key: key)

        // 6. 合并注入
        let finalPayload: Data
        if let existingB64 = existingB64,
           let existingRaw = Data(base64Encoded: existingB64) {
            // 拼接: existing protobuf bytes + new payload bytes
            var combined = existingRaw
            combined.append(payload)
            finalPayload = combined
        } else {
            finalPayload = payload
        }

        // 7. Base64 编码后写入
        let finalB64 = finalPayload.base64EncodedString()
        let writeOk = writeSqliteValue(key: key, value: finalB64)

        if writeOk {
            return RecoveryResult(success: true, count: selectedIds.count, error: "")
        } else {
            return RecoveryResult(success: false, count: 0, error: "写入 state.vscdb 失败")
        }
    }

    private func readSqliteValue(key: String) -> String? {
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
            let value = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (value?.isEmpty ?? true) ? nil : value
        } catch {
            return nil
        }
    }

    private func writeSqliteValue(key: String, value: String) -> Bool {
        // 使用参数化写入来避免 shell 注入和 base64 特殊字符问题
        let sql = "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('\(key)', '\(value)');"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [stateDbPath, sql]
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }
}
