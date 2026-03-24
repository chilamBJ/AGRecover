/**
 * protobufCodec.ts
 *
 * 纯 TypeScript protobuf wire format 编解码器。
 * 基于 2026-03-24 对 state.vscdb 中 CascadeTrajectorySummary 的逆向分析。
 *
 * state.vscdb 中 `antigravityUnifiedStateSync.trajectorySummaries` 的存储格式：
 *   value = base64(outer_protobuf)
 *
 * outer_protobuf 结构:
 *   repeated field 1 (map_entry) {
 *     field 1: cascadeId (string)        — map key
 *     field 2: wrapper_message {         — map value
 *       field 1: base64(inner_protobuf)  — double encoding!
 *     }
 *   }
 *
 * inner_protobuf (CascadeTrajectorySummary):
 *   field 1: summary (string)
 *   field 2: stepCount (varint)
 *   field 3: lastModifiedTime (Timestamp: {1:seconds, 2:nanos})
 *   field 4: trajectoryId (string)
 *   field 5: status (varint/enum)
 *   field 7: createdTime (Timestamp)
 *   field 9: workspaces (repeated message: {1:uri, 2:rootUri, 3:repo})
 *   field 10: lastUserInputTime (Timestamp)
 */

import type { TrajectorySummary } from './lsClient';

// ─── Wire format primitives ───

export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0; // ensure unsigned for small values
  // Handle large numbers (> 32-bit) via BigInt-style encoding
  if (value > 0x7FFFFFFF) {
    // Use string conversion for large epoch seconds
    let big = BigInt(value);
    while (big > 0x7Fn) {
      bytes.push(Number(big & 0x7Fn) | 0x80);
      big >>= 7n;
    }
    bytes.push(Number(big & 0x7Fn));
    return Buffer.from(bytes);
  }
  while (v > 0x7F) {
    bytes.push((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7F);
  return Buffer.from(bytes);
}

export function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(data.length);
  return Buffer.concat([tag, len, data]);
}

export function encodeString(fieldNumber: number, value: string): Buffer {
  return encodeLengthDelimited(fieldNumber, Buffer.from(value, 'utf-8'));
}

export function encodeVarintField(fieldNumber: number, value: number): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 0);
  return Buffer.concat([tag, encodeVarint(value)]);
}

export function encodeTimestamp(fieldNumber: number, seconds: number, nanos: number): Buffer {
  let inner = encodeVarintField(1, seconds);
  if (nanos) {
    inner = Buffer.concat([inner, encodeVarintField(2, nanos)]);
  }
  return encodeLengthDelimited(fieldNumber, inner);
}

// ─── ISO 8601 timestamp parsing ───

export function parseIsoTimestamp(ts: string): { seconds: number; nanos: number } | null {
  if (!ts) return null;
  try {
    let cleaned = ts.replace(/Z$/, '');
    let nanos = 0;
    const dotIdx = cleaned.indexOf('.');
    if (dotIdx >= 0) {
      const frac = cleaned.substring(dotIdx + 1).padEnd(9, '0').substring(0, 9);
      nanos = parseInt(frac, 10);
      cleaned = cleaned.substring(0, dotIdx);
    }
    const dt = new Date(cleaned + 'Z');
    const seconds = Math.floor(dt.getTime() / 1000);
    return { seconds, nanos };
  } catch {
    return null;
  }
}

// ─── Status enum mapping ───

const STATUS_MAP: Record<string, number> = {
  CASCADE_RUN_STATUS_UNSPECIFIED: 0,
  CASCADE_RUN_STATUS_IDLE: 1,
  CASCADE_RUN_STATUS_RUNNING: 2,
  CASCADE_RUN_STATUS_STREAMING: 3,
  CASCADE_RUN_STATUS_DONE: 4,
};

// ─── CascadeTrajectorySummary encoder ───

/**
 * Encode a CascadeTrajectorySummary from LS API JSON to protobuf binary.
 */
export function encodeCascadeSummary(summary: TrajectorySummary): Buffer {
  const parts: Buffer[] = [];

  // f1: summary (string)
  if (summary.summary) {
    parts.push(encodeString(1, summary.summary));
  }

  // f2: stepCount (varint)
  if (summary.stepCount) {
    parts.push(encodeVarintField(2, summary.stepCount));
  }

  // f3: lastModifiedTime (Timestamp)
  const lmt = parseIsoTimestamp(summary.lastModifiedTime);
  if (lmt) {
    parts.push(encodeTimestamp(3, lmt.seconds, lmt.nanos));
  }

  // f4: trajectoryId (string)
  if (summary.trajectoryId) {
    parts.push(encodeString(4, summary.trajectoryId));
  }

  // f5: status (varint/enum)
  const statusVal = STATUS_MAP[summary.status] ?? 1;
  if (statusVal) {
    parts.push(encodeVarintField(5, statusVal));
  }

  // f7: createdTime (Timestamp)
  const ct = parseIsoTimestamp(summary.createdTime);
  if (ct) {
    parts.push(encodeTimestamp(7, ct.seconds, ct.nanos));
  }

  // f9: workspaces (repeated message: {1:uri, 2:rootUri, 3:repo})
  if (summary.workspaces) {
    for (const ws of summary.workspaces) {
      const wsParts: Buffer[] = [];
      const uri = ws.workspaceFolderAbsoluteUri || '';
      if (uri) {
        wsParts.push(encodeString(1, uri));
        wsParts.push(encodeString(2, 'file:///'));
        wsParts.push(encodeString(3, ''));
      }
      if (wsParts.length > 0) {
        parts.push(encodeLengthDelimited(9, Buffer.concat(wsParts)));
      }
    }
  }

  // f10: lastUserInputTime (Timestamp)
  const luit = parseIsoTimestamp((summary as any).lastUserInputTime);
  if (luit) {
    parts.push(encodeTimestamp(10, luit.seconds, luit.nanos));
  }

  return Buffer.concat(parts);
}

// ─── Map entry builder ───

/**
 * Build a single map entry for the outer protobuf.
 *
 * Wire format:
 *   field 1 (LEN): map_entry {
 *     field 1 (LEN): cascadeId (string)
 *     field 2 (LEN): wrapper {
 *       field 1 (LEN): base64(summary_proto)    ← double encoding
 *     }
 *   }
 */
export function buildMapEntry(cascadeId: string, summaryProto: Buffer): Buffer {
  const b64Value = summaryProto.toString('base64');
  const wrapper = encodeString(1, b64Value);
  const entry = Buffer.concat([
    encodeString(1, cascadeId),
    encodeLengthDelimited(2, wrapper),
  ]);
  return encodeLengthDelimited(1, entry);
}

// ─── Parsing existing protobuf ───

/** Read a varint from buffer at pos, return [value, newPos] */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7F) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
    // For large varints (> 28 bits), switch to safe math
    if (shift >= 28) {
      let big = BigInt(result);
      while (pos < buf.length) {
        const b2 = buf[pos++];
        big |= BigInt(b2 & 0x7F) << BigInt(shift);
        shift += 7;
        if (!(b2 & 0x80)) break;
      }
      return [Number(big), pos];
    }
  }
  return [result >>> 0, pos];
}

/**
 * Parse the outer protobuf to extract existing cascade IDs.
 */
export function parseExistingEntryIds(rawProto: Buffer): Set<string> {
  const ids = new Set<string>();
  let pos = 0;

  while (pos < rawProto.length) {
    const [tag, pos2] = readVarint(rawProto, pos);
    pos = pos2;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) {
      const [len, pos3] = readVarint(rawProto, pos);
      pos = pos3;
      const entryData = rawProto.subarray(pos, pos + len);
      pos += len;

      if (fieldNum === 1) {
        // Parse map entry → extract key (field 1)
        let epos = 0;
        while (epos < entryData.length) {
          const [eTag, epos2] = readVarint(entryData, epos);
          epos = epos2;
          const eFn = eTag >>> 3;
          const eWt = eTag & 0x07;

          if (eWt === 2) {
            const [eLen, epos3] = readVarint(entryData, epos);
            epos = epos3;
            const eData = entryData.subarray(epos, epos + eLen);
            epos += eLen;
            if (eFn === 1) {
              ids.add(eData.toString('utf-8'));
            }
          } else {
            break; // unexpected wire type
          }
        }
      }
    } else {
      break; // unexpected top-level wire type
    }
  }

  return ids;
}

// ─── Full index builder ───

/**
 * Build a complete inject payload by appending new entries to existing protobuf.
 *
 * Protobuf repeated fields can be simply concatenated — this is safe
 * and preserves the exact binary format of existing entries.
 *
 * @param existingRaw - existing protobuf bytes from state.vscdb (preserved as-is)
 * @param newSummaries - map of cascadeId → TrajectorySummary to add
 * @returns combined protobuf bytes
 */
export function buildInjectPayload(
  existingRaw: Buffer | null,
  newSummaries: Map<string, TrajectorySummary>
): Buffer {
  const existingIds = existingRaw ? parseExistingEntryIds(existingRaw) : new Set<string>();
  const parts: Buffer[] = [];

  // Keep existing data as-is
  if (existingRaw && existingRaw.length > 0) {
    parts.push(existingRaw);
  }

  // Append new entries
  let added = 0;
  for (const [cascadeId, summary] of newSummaries) {
    if (existingIds.has(cascadeId)) continue;
    const summaryProto = encodeCascadeSummary(summary);
    parts.push(buildMapEntry(cascadeId, summaryProto));
    added++;
  }

  return Buffer.concat(parts);
}
