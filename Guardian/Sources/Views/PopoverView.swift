import SwiftUI

struct PopoverView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.colorScheme) var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            headerView
            Divider()

            if state.conversations.isEmpty {
                emptyView
            } else {
                listView
            }

            Divider()
            footerView
        }
        .frame(width: 380, height: 500)
        .background(colorScheme == .dark ? Color(white: 0.12) : Color(white: 0.98))
    }

    // MARK: - Header

    private var headerView: some View {
        VStack(spacing: 10) {
            // 状态栏
            HStack(alignment: .top) {
                // 状态图标 + 文字
                HStack(spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(state.statusColor.opacity(0.15))
                            .frame(width: 36, height: 36)
                        Text(state.statusEmoji)
                            .font(.system(size: 18))
                    }

                    VStack(alignment: .leading, spacing: 1) {
                        Text("AG Guardian")
                            .font(.system(size: 14, weight: .semibold))
                        Text(state.statusText)
                            .font(.system(size: 11))
                            .foregroundStyle(state.statusColor)
                    }
                }

                Spacer()

                // 统计
                VStack(alignment: .trailing, spacing: 1) {
                    HStack(spacing: 3) {
                        Text("\(state.backupCount)")
                            .font(.system(size: 13, weight: .medium, design: .monospaced))
                        Text("备份")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 3) {
                        Text("\(state.indexedCount)")
                            .font(.system(size: 13, weight: .medium, design: .monospaced))
                        Text("已索引")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // 搜索框
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                TextField("搜索对话…", text: $state.searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                if !state.searchText.isEmpty {
                    Button { withAnimation(.easeOut(duration: 0.15)) { state.searchText = "" } } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(colorScheme == .dark ? Color(white: 0.18) : Color(white: 0.92))
            )

            // 缺失对话提示
            if state.missingCount > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(.orange)
                    Text("\(state.missingCount) 个对话未在 AG 索引中")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.orange)
                    Spacer()
                    Button("全选") { withAnimation { state.toggleAll(true) } }
                        .font(.system(size: 11))
                        .buttonStyle(.plain)
                        .foregroundStyle(.blue)
                    Text("·").foregroundStyle(.quaternary)
                    Button("全不选") { withAnimation { state.toggleAll(false) } }
                        .font(.system(size: 11))
                        .buttonStyle(.plain)
                        .foregroundStyle(.blue)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.orange.opacity(0.08))
                )
            }
        }
        .padding(14)
    }

    // MARK: - List

    private var listView: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                // 未索引的对话置顶
                let missing = state.filteredConversations.filter { !$0.isInAGIndex }
                let indexed = state.filteredConversations.filter { $0.isInAGIndex }

                if !missing.isEmpty {
                    SectionHeader(title: "待恢复", count: missing.count, color: .blue)
                    ForEach(missing) { conv in
                        ConversationRow(
                            item: conv,
                            colorScheme: colorScheme,
                            onToggle: { id in toggleConversation(id) }
                        )
                    }
                }

                if !indexed.isEmpty {
                    SectionHeader(title: "已索引", count: indexed.count, color: .green)
                    ForEach(indexed) { conv in
                        ConversationRow(
                            item: conv,
                            colorScheme: colorScheme,
                            onToggle: { id in toggleConversation(id) }
                        )
                    }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
        }
    }

    private func toggleConversation(_ id: String) {
        if let idx = state.conversations.firstIndex(where: { $0.id == id }) {
            withAnimation(.easeInOut(duration: 0.15)) {
                state.conversations[idx].isSelected.toggle()
            }
        }
    }

    // MARK: - Empty

    private var emptyView: some View {
        VStack(spacing: 14) {
            Spacer()
            Text("📭")
                .font(.system(size: 40))
            Text("暂无备份数据")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
            Text("请先安装 AGR 插件到 Antigravity\n插件会自动备份对话记录")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Footer

    private var footerView: some View {
        VStack(spacing: 6) {
            // AG 运行提示
            if state.agStatus == .running && state.selectedCount > 0 {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 10))
                    Text("AG 正在运行中，请退出 AG 后进行恢复")
                        .font(.system(size: 11))
                }
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.orange.opacity(0.08)))
            }

            // 恢复结果
            if !state.recoveryMessage.isEmpty {
                Text(state.recoveryMessage)
                    .font(.system(size: 11))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }

            HStack(spacing: 8) {
                // 恢复成功后显示启动按钮
                if state.recoveryMessage.contains("✅") {
                    Button { state.launchAG() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 10))
                            Text("启动 AG")
                                .font(.system(size: 11, weight: .medium))
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .controlSize(.small)
                }

                Spacer()

                // 打开备份文件夹
                Button { state.openBackupFolder() } label: {
                    Image(systemName: "folder")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("打开备份文件夹")

                // 刷新
                Button {
                    Task { await state.scan() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("刷新")

                // 恢复
                Button {
                    Task { await state.recover() }
                } label: {
                    if state.isRecovering {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.uturn.backward.circle.fill")
                                .font(.system(size: 11))
                            Text("恢复 (\(state.selectedCount))")
                                .font(.system(size: 11, weight: .medium))
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(state.selectedCount == 0 || state.isRecovering || state.agStatus == .running)

                // 退出
                Button { NSApplication.shared.terminate(nil) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("退出")
            }
        }
        .padding(14)
    }
}

// MARK: - Section Header

struct SectionHeader: View {
    let title: String
    let count: Int
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 5, height: 5)
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text("(\(count))")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 2)
    }
}

// MARK: - Row

struct ConversationRow: View {
    let item: ConversationItem
    let colorScheme: ColorScheme
    let onToggle: (String) -> Void

    var body: some View {
        HStack(spacing: 8) {
            // 勾选状态
            if item.isInAGIndex {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green.opacity(0.6))
                    .font(.system(size: 14))
            } else {
                Button { onToggle(item.id) } label: {
                    Image(systemName: item.isSelected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(item.isSelected ? .blue : Color.gray.opacity(0.3))
                        .font(.system(size: 14))
                }
                .buttonStyle(.plain)
            }

            // 标题 + 时间
            VStack(alignment: .leading, spacing: 2) {
                Text(item.displayTitle)
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .foregroundStyle(item.isInAGIndex ? .secondary : .primary)

                Text(item.lastModified, style: .relative)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            // 状态标签
            if item.isInAGIndex {
                Text("已索引")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.green.opacity(0.7))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(.green.opacity(0.08))
                    )
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(rowBackground)
        )
    }

    private var rowBackground: Color {
        if item.isSelected && !item.isInAGIndex {
            return .blue.opacity(0.06)
        }
        return .clear
    }
}
