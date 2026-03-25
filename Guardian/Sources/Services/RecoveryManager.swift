import Foundation
import AppKit

struct RecoveryResult {
    var success: Bool
    var count: Int
    var error: String
    var details: String  // 详细日志
}

class RecoveryManager {
    private let home = FileManager.default.homeDirectoryForCurrentUser.path

    var stateDbPath: String {
        "\(home)/Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
    }

    var backupDir: String {
        "\(home)/.ag-recover"
    }

    var agConversationsDir: String {
        "\(home)/.gemini/antigravity/conversations"
    }

    /// 执行离线注入
    func inject(selectedIds: Set<String>) async -> RecoveryResult {
        var log = ""

        guard !selectedIds.isEmpty else {
            return RecoveryResult(success: false, count: 0, error: "没有选择要恢复的对话", details: "")
        }

        // 1. 检查 AG 进程
        let apps = NSWorkspace.shared.runningApplications
        let agRunning = apps.contains { app in
            app.bundleIdentifier == "com.google.antigravity" ||
            app.localizedName?.lowercased().contains("antigravity") == true
        }
        if agRunning {
            return RecoveryResult(success: false, count: 0, error: "AG 仍在运行，请先 Cmd+Q 退出", details: "")
        }

        let fm = FileManager.default

        // 2. 备份 state.vscdb
        guard fm.fileExists(atPath: stateDbPath) else {
            return RecoveryResult(success: false, count: 0, error: "找不到 state.vscdb", details: "")
        }

        let timestamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: "-", with: "")
        let backupPath = "\(stateDbPath).guardian_backup_\(timestamp)"
        do {
            try fm.copyItem(atPath: stateDbPath, toPath: backupPath)
            log += "✅ 已备份 state.vscdb\n"
        } catch {
            return RecoveryResult(success: false, count: 0, error: "备份 state.vscdb 失败", details: error.localizedDescription)
        }

        // 3. 拷贝 .pb 文件到 AG conversations 目录
        let pbDir = "\(backupDir)/conversations"
        var copiedPbCount = 0
        for id in selectedIds {
            let src = "\(pbDir)/\(id).pb"
            let dst = "\(agConversationsDir)/\(id).pb"
            if fm.fileExists(atPath: src) {
                do {
                    if fm.fileExists(atPath: dst) {
                        try fm.removeItem(atPath: dst)
                    }
                    try fm.copyItem(atPath: src, toPath: dst)
                    copiedPbCount += 1
                } catch {
                    log += "⚠️ 拷贝 \(id.prefix(8)).pb 失败: \(error.localizedDescription)\n"
                }
            } else {
                log += "⚠️ 备份中找不到 \(id.prefix(8)).pb\n"
            }
        }
        log += "✅ 已拷贝 \(copiedPbCount) 个 .pb 文件到 AG\n"

        // 4. 读取备份目录中的 summaries.json
        let summariesPath = "\(backupDir)/state/summaries.json"
        var summaries: [String: [String: Any]] = [:]
        if let data = fm.contents(atPath: summariesPath),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] {
            summaries = json
            log += "✅ 读取 summaries.json (\(summaries.count) 条)\n"
        } else {
            log += "⚠️ summaries.json 不存在或无法解析，用默认值\n"
        }

        // 5. 构造 protobuf payload
        let payload = ProtobufCodec.buildPayload(
            selectedIds: selectedIds,
            summaries: summaries
        )
        log += "✅ 构造 protobuf payload (\(payload.count) bytes)\n"

        // 6. 读取现有 trajectorySummaries
        let key = "antigravityUnifiedStateSync.trajectorySummaries"
        let existingB64 = readSqliteValue(key: key)

        // 7. 合并注入
        let finalPayload: Data
        if let existingB64 = existingB64,
           let existingRaw = Data(base64Encoded: existingB64) {
            var combined = existingRaw
            combined.append(payload)
            finalPayload = combined
            log += "✅ 合并现有索引 (\(existingRaw.count) bytes) + 新增 (\(payload.count) bytes)\n"
        } else {
            finalPayload = payload
            log += "ℹ️ 无现有索引，直接写入\n"
        }

        // 8. 写入（通过 stdin 传 SQL，避免 base64 特殊字符问题）
        let finalB64 = finalPayload.base64EncodedString()
        let writeOk = writeSqliteValue(key: key, value: finalB64)

        if writeOk {
            log += "✅ 写入 state.vscdb 成功 (\(finalB64.count) chars)\n"
            return RecoveryResult(success: true, count: selectedIds.count, error: "", details: log)
        } else {
            log += "❌ 写入 state.vscdb 失败\n"
            return RecoveryResult(success: false, count: 0, error: "写入 state.vscdb 失败", details: log)
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
        // 通过 stdin 传 SQL，避免 base64 中 +/= 等特殊字符被 shell 解释
        let sql = "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('\(key)', '\(value)');\n"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [stateDbPath]

        let inputPipe = Pipe()
        process.standardInput = inputPipe
        process.standardError = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice

        do {
            try process.run()
            inputPipe.fileHandleForWriting.write(Data(sql.utf8))
            inputPipe.fileHandleForWriting.closeFile()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }
}
