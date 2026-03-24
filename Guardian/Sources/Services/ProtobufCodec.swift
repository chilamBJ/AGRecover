import Foundation

/// 轻量 protobuf wire format 编解码器
/// 复现 AG 的 trajectorySummaries 存储格式
enum ProtobufCodec {

    // MARK: - Varint

    static func encodeVarint(_ value: UInt64) -> Data {
        var v = value
        var result = Data()
        while v > 0x7F {
            result.append(UInt8(v & 0x7F) | 0x80)
            v >>= 7
        }
        result.append(UInt8(v))
        return result
    }

    static func decodeVarint(from data: Data, offset: inout Int) -> UInt64? {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while offset < data.count {
            let byte = data[offset]
            offset += 1
            result |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return result }
            shift += 7
            if shift > 63 { return nil }
        }
        return nil
    }

    // MARK: - Tag

    static func makeTag(fieldNumber: Int, wireType: Int) -> Data {
        encodeVarint(UInt64(fieldNumber << 3 | wireType))
    }

    // MARK: - Length-delimited field

    static func lengthDelimited(fieldNumber: Int, data: Data) -> Data {
        var result = makeTag(fieldNumber: fieldNumber, wireType: 2)
        result.append(encodeVarint(UInt64(data.count)))
        result.append(data)
        return result
    }

    static func stringField(fieldNumber: Int, value: String) -> Data {
        lengthDelimited(fieldNumber: fieldNumber, data: Data(value.utf8))
    }

    static func varintField(fieldNumber: Int, value: UInt64) -> Data {
        var result = makeTag(fieldNumber: fieldNumber, wireType: 0)
        result.append(encodeVarint(value))
        return result
    }

    // MARK: - Timestamp (Google Protobuf Timestamp)

    static func timestampField(fieldNumber: Int, date: Date) -> Data {
        let seconds = Int64(date.timeIntervalSince1970)
        let nanos = Int32((date.timeIntervalSince1970 - Double(seconds)) * 1_000_000_000)
        var inner = Data()
        if seconds != 0 {
            inner.append(makeTag(fieldNumber: 1, wireType: 0))
            inner.append(encodeVarint(UInt64(bitPattern: Int64(seconds))))
        }
        if nanos != 0 {
            inner.append(makeTag(fieldNumber: 2, wireType: 0))
            inner.append(encodeVarint(UInt64(bitPattern: Int64(nanos))))
        }
        return lengthDelimited(fieldNumber: fieldNumber, data: inner)
    }

    // MARK: - Map Entry

    /// 构造 CascadeSummary message
    static func encodeCascadeSummary(
        cascadeId: String,
        title: String,
        createdAt: Date,
        updatedAt: Date,
        stepCount: Int
    ) -> Data {
        var msg = Data()
        msg.append(stringField(fieldNumber: 1, value: cascadeId))      // cascade_id
        msg.append(stringField(fieldNumber: 2, value: title))          // title
        msg.append(timestampField(fieldNumber: 3, date: createdAt))    // created_time
        msg.append(timestampField(fieldNumber: 4, date: updatedAt))    // updated_time
        msg.append(varintField(fieldNumber: 5, value: UInt64(stepCount)))  // step_count
        return msg
    }

    /// 构造 map<string, CascadeSummary> entry
    static func buildMapEntry(key: String, value: Data) -> Data {
        var entry = Data()
        entry.append(stringField(fieldNumber: 1, value: key))    // map key
        entry.append(lengthDelimited(fieldNumber: 2, data: value))  // map value
        return lengthDelimited(fieldNumber: 1, data: entry)       // field 1 of container
    }

    // MARK: - Payload

    static func buildPayload(
        selectedIds: Set<String>,
        summaries: [String: [String: Any]]
    ) -> Data {
        let isoFormatter = ISO8601DateFormatter()
        var payload = Data()

        for id in selectedIds {
            let s = summaries[id]
            let title = (s?["title"] as? String) ?? ""
            let created = (s?["createdTime"] as? String).flatMap { isoFormatter.date(from: $0) } ?? Date()
            let updated = (s?["lastModifiedTime"] as? String).flatMap { isoFormatter.date(from: $0) } ?? Date()
            let steps = (s?["stepCount"] as? Int) ?? 1

            let summary = encodeCascadeSummary(
                cascadeId: id,
                title: title,
                createdAt: created,
                updatedAt: updated,
                stepCount: steps
            )
            payload.append(buildMapEntry(key: id, value: summary))
        }

        return payload
    }

    // MARK: - Parse existing IDs

    /// 从现有 protobuf 数据中提取所有 cascadeId
    static func parseEntryIds(from data: Data) -> Set<String> {
        var ids = Set<String>()
        var offset = 0

        while offset < data.count {
            // 读 tag
            guard let tag = decodeVarint(from: data, offset: &offset) else { break }
            let wireType = Int(tag & 0x7)

            if wireType == 2 {
                // length-delimited
                guard let length = decodeVarint(from: data, offset: &offset) else { break }
                let end = offset + Int(length)
                guard end <= data.count else { break }

                // 尝试解析 map entry：field 1 = key (string)
                let entryData = data[offset..<end]
                if let key = extractMapKey(from: Data(entryData)) {
                    ids.insert(key)
                }
                offset = end
            } else if wireType == 0 {
                // varint: skip
                _ = decodeVarint(from: data, offset: &offset)
            } else {
                // 无法解析，退出
                break
            }
        }

        return ids
    }

    private static func extractMapKey(from data: Data) -> String? {
        var offset = 0
        guard let tag = decodeVarint(from: data, offset: &offset) else { return nil }
        let fieldNumber = Int(tag >> 3)
        let wireType = Int(tag & 0x7)

        guard fieldNumber == 1, wireType == 2 else { return nil }
        guard let length = decodeVarint(from: data, offset: &offset) else { return nil }
        let end = offset + Int(length)
        guard end <= data.count else { return nil }

        return String(data: data[offset..<end], encoding: .utf8)
    }
}
