/**
 * Autopen - Compact Signature Serialization Library
 *
 * A library for capturing, encoding, and rendering hand-drawn signatures
 * with efficient binary serialization and optional text encoding.
 *
 * @license MIT
 * @version 1.0.0
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * A 2D point with x and y coordinates
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A stroke is an array of points
 */
export type Stroke = Point[];

/**
 * Options for creating a new Signature
 */
export interface SignatureOptions {
  /** RDP simplification tolerance (default: 2) */
  readonly simplifyEpsilon?: number;
  /** User canvas width for coordinate scaling (default: 512) */
  readonly canvasWidth?: number;
  /** User canvas height for coordinate scaling (default: 256) */
  readonly canvasHeight?: number;
}

/**
 * Options for rendering to SVG
 */
export interface RenderOptions {
  /** Output SVG width (default: 512) */
  readonly width?: number;
  /** Output SVG height (default: 256) */
  readonly height?: number;
  /** Stroke width in output pixels (default: 2) */
  readonly strokeWidth?: number;
  /** Stroke color (default: '#000000') */
  readonly strokeColor?: string;
  /** Use spline interpolation (default: true) */
  readonly spline?: boolean;
  /** Catmull-Rom spline tension 0-1 (default: 0.5) */
  readonly splineTension?: number;
  /** Background color, null for transparent (default: null) */
  readonly backgroundColor?: string | null;
  /** Fit to content bounds instead of full canvas (default: true) */
  readonly contentFit?: boolean;
  /** Padding as fraction of output dimensions when contentFit=true (default: 0.05) */
  readonly contentPadding?: number;
}

/**
 * Encoding statistics from V1 encoder
 */
export interface EncodeStats {
  /** Number of 2-byte delta encodings */
  deltas: number;
  /** Number of 3-byte absolute position encodings */
  absolutes: number;
  /** Number of stroke markers */
  strokeMarkers: number;
  /** Number of absolutes due to dx overflow only */
  overflowDxOnly: number;
  /** Number of absolutes due to dy overflow only */
  overflowDyOnly: number;
  /** Number of absolutes due to both dx and dy overflow */
  overflowBoth: number;
}

/**
 * Delta frequency data for analysis
 */
export interface DeltaFrequencies {
  /** Frequency of each dx value (252 entries) */
  readonly dx: Uint32Array;
  /** Frequency of each dy value (256 entries) */
  readonly dy: Uint32Array;
  /** Joint frequency of (dx, dy) pairs */
  readonly joint: Uint32Array;
}

// ============================================================================
// ERROR CLASSES
// ============================================================================

/**
 * Base error class for Autopen-related errors
 */
export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

/**
 * Error thrown when signature data fails validation during deserialization
 */
export class SignatureValidationError extends SignatureError {
  /** The field that failed validation */
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "SignatureValidationError";
    this.field = field;
  }
}

/**
 * Error thrown during signature deserialization
 */
export class SignatureDeserializationError extends SignatureError {
  /** Error code for programmatic handling */
  readonly code: DeserializationErrorCode;
  /** Byte position where the error occurred (if applicable) */
  readonly position?: number;

  constructor(
    message: string,
    code: DeserializationErrorCode,
    position?: number,
  ) {
    super(message);
    this.name = "SignatureDeserializationError";
    this.code = code;
    this.position = position;
  }
}

/**
 * Error codes for deserialization errors
 */
export enum DeserializationErrorCode {
  /** Invalid magic byte (not an Autopen signature) */
  INVALID_MAGIC = "INVALID_MAGIC",
  /** Unsupported format version */
  INVALID_VERSION = "INVALID_VERSION",
  /** CRC checksum mismatch */
  CRC_MISMATCH = "CRC_MISMATCH",
  /** Data is truncated */
  TRUNCATED_DATA = "TRUNCATED_DATA",
  /** Payload data is corrupted */
  CORRUPTED_PAYLOAD = "CORRUPTED_PAYLOAD",
  /** Invalid encoding format */
  INVALID_ENCODING = "INVALID_ENCODING",
}

/**
 * Packed position data for 17-bit coordinates
 */
interface PackedPosition {
  /** High bit of x (0 or 1) */
  bit16: number;
  /** Low 8 bits of x */
  hi: number;
  /** Full y coordinate */
  lo: number;
}

/**
 * Bounding box for coordinate transforms
 */
interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ============================================================================
// FORMAT SPECIFICATION
// ============================================================================
//
// Autopen Signature Format
// ------------------------
//
// The format is designed for compact storage of signature stroke data with
// these goals:
//   1. Small size (typically 50-200 bytes for a signature)
//   2. Self-describing with version for forward compatibility
//   3. Error detection via CRC-8 checksum
//   4. Text-safe encoding options (Z85, base64)
//
// ENVELOPE (version-independent):
// ┌───────┬─────────┬────────┬────────┬─────────────┬───────┐
// │ MAGIC │ VERSION │ LEN_HI │ LEN_LO │ PAYLOAD...  │ CRC-8 │
// │ 'S'   │         │        │        │             │       │
// │ 1B    │  1B     │ 1B     │ 1B     │ variable    │ 1B    │
// └───────┴─────────┴────────┴────────┴─────────────┴───────┘
//
// - MAGIC (1 byte): 0x53 ('S') - identifies this as an Autopen signature
// - VERSION (1 byte): Payload format version (determines how to decode PAYLOAD)
// - LEN (2 bytes): Big-endian length of PAYLOAD only (max 65535)
// - PAYLOAD (variable): Version-specific opaque bytes
// - CRC-8 (1 byte): CRC-8-CCITT checksum of bytes 0..(4+LEN-1)
//
// The envelope structure is version-independent and will not change.
// Only the PAYLOAD interpretation changes between versions. The envelope
// treats PAYLOAD as opaque bytes - compression, encoding schemes, etc.
// are all version-specific concerns hidden inside the payload.
//
// ============================================================================
// VERSION 1 PAYLOAD FORMAT
// ============================================================================
//
// V1 Payload Structure:
// ┌────────────┬────────────┬─────────────────────────┐
// │ ORIG_LEN_HI│ ORIG_LEN_LO│ ARITH_COMPRESSED_BITS   │
// │ 1B         │ 1B         │ variable                │
// └────────────┴────────────┴─────────────────────────┘
//
// - ORIG_LEN (2 bytes): Big-endian length of uncompressed delta-encoded data
// - ARITH_COMPRESSED_BITS: Arithmetic-coded delta data
//
// The compressed data decodes to delta-encoded stroke data:
//
// V1 Internal Coordinate Space: 512×256
//   - x ∈ [0, 511] (9 bits)
//   - y ∈ [0, 255] (8 bits)
//   - This is an INTERNAL storage detail of V1 - users work with any canvas size
//   - The library automatically scales between user coordinates and V1 storage
//   - Future versions may use different internal resolutions
//
// Delta encoding uses variable-length commands:
//
// 2-byte delta (most common):
//   - First byte 0x00-0xFB: dx + 125
//   - Second byte 0x00-0xFF: dy + 127
//   - dx in [-125, +126] (252 values)
//   - dy in [-127, +128] (256 values)
//   - Both ranges favor positive by 1 for symmetry
//   - The 256-value dy range ensures byte-aligned encoding (no bit mixing)
//
// 3-byte commands (control bytes 0xFC-0xFF):
//   - 0xFC + 2 bytes: Stroke marker, x < 256 (new stroke starts here)
//   - 0xFD + 2 bytes: Stroke marker, x >= 256
//   - 0xFE + 2 bytes: Absolute position, x < 256 (for large jumps)
//   - 0xFF + 2 bytes: Absolute position, x >= 256
//
// Position packing (17 bits → control byte + 2 data bytes):
//   - Control byte encodes x's high bit (bit 8)
//   - Data byte 1: x & 0xFF
//   - Data byte 2: y (full 8 bits)
//
// Arithmetic Coding (V1-specific):
//   V1 compresses the delta data using arithmetic coding with a static
//   Laplacian probability model. The model assumes:
//   - Delta bytes cluster around their center values (125 for dx, 127 for dy)
//   - Control bytes (0xFC-0xFF) are rare
//   This typically achieves 20-40% compression on real signatures.
//   Future versions may use different compression or none at all.
//
// ============================================================================

// ============================================================================
// CONSTANTS
// ============================================================================

/** Magic byte identifying Autopen format */
export const MAGIC = 0x53; // 'S'

/** Current format version */
const VERSION_1 = 0x01;

/**
 * V1 internal storage dimensions - signatures are normalized to this coordinate space.
 * This is an implementation detail of the V1 format, not a constraint on user canvas size.
 * Users can work with any canvas dimensions; the library handles scaling automatically.
 * Exported for advanced use cases (e.g., understanding storage resolution limits).
 */
export const V1_CANVAS_WIDTH = 512; // 9 bits (0-511)
/** V1 internal canvas height (8 bits: 0-255) */
export const V1_CANVAS_HEIGHT = 256;

/** Delta encoding ranges (V1) - both favor positive by 1 for symmetry */
const DX_MIN = -125;
const DX_MAX = 126;
const DY_MIN = -127;
const DY_MAX = 128;
const DX_RANGE: number = DX_MAX - DX_MIN + 1; // 252
const DY_RANGE: number = DY_MAX - DY_MIN + 1; // 256

/** Control byte values (V1) */
const CTRL_STROKE_LO = 0xfc; // Stroke marker, x < 256
const CTRL_STROKE_HI = 0xfd; // Stroke marker, x >= 256
const CTRL_ABS_LO = 0xfe; // Absolute position, x < 256
const CTRL_ABS_HI = 0xff; // Absolute position, x >= 256

/** Default RDP simplification epsilon */
export const DEFAULT_EPSILON = 2;

/** Default spline tension for rendering */
export const DEFAULT_SPLINE_TENSION = 0.5;

/** Maximum total points allowed across all strokes (memory protection) */
export const MAX_TOTAL_POINTS = 100000;

// ============================================================================
// ENCODING TYPES
// ============================================================================

/**
 * Supported serialization encodings for string output
 */
export const Encoding = {
  /** Z85 encoding (4 bytes → 5 chars, compact but not URL-safe) */
  Z85: "z85",
  /** Standard base64 (3 bytes → 4 chars) */
  BASE64: "base64",
  /** URL-safe base64 (uses -_ instead of +/) */
  BASE64URL: "base64url",
} as const;

export type EncodingType = (typeof Encoding)[keyof typeof Encoding];

/**
 * Supported render output formats
 */
export const Format = {
  /** SVG string */
  SVG: "svg",
} as const;

export type FormatType = (typeof Format)[keyof typeof Format];

// ============================================================================
// Z85 ENCODING
// ============================================================================
// Z85 is a binary-to-text encoding that converts 4 bytes to 5 ASCII characters.
// It's more compact than base64 (25% overhead vs 33%) but uses some characters
// that aren't URL-safe. The character set avoids quotes and backslashes for
// easy embedding in strings.
//
// Reference: https://rfc.zeromq.org/spec/32/

const Z85_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
const Z85_DECODE_MAP = new Map<string, number>(
  [...Z85_ALPHABET].map((c, i) => [c, i]),
);

/**
 * Encode bytes to Z85 string
 * @param bytes - Input bytes
 * @returns Z85-encoded string
 */
export function z85Encode(bytes: Uint8Array): string {
  if (!bytes.length) return "";

  // Pad to multiple of 4 bytes
  const remainder = bytes.length % 4;
  const padding = remainder ? 4 - remainder : 0;
  const padded = new Uint8Array(bytes.length + padding);
  padded.set(bytes);

  // Pre-allocate result array to avoid O(n²) string concatenation
  const numGroups = padded.length / 4;
  const resultChars = new Array<string>(numGroups * 5);
  let charIdx = 0;

  for (let i = 0; i < padded.length; i += 4) {
    // Combine 4 bytes into 32-bit value (big-endian)
    let value =
      ((padded[i] << 24) |
        (padded[i + 1] << 16) |
        (padded[i + 2] << 8) |
        padded[i + 3]) >>>
      0;

    // Convert to 5 base-85 digits (build in reverse order)
    const baseIdx = charIdx;
    charIdx += 5;
    for (let j = 4; j >= 0; j--) {
      resultChars[baseIdx + j] = Z85_ALPHABET[value % 85];
      value = Math.floor(value / 85);
    }
  }

  return resultChars.join("");
}

/**
 * Decode Z85 string to bytes
 * @param str - Z85-encoded string
 * @returns Decoded bytes (uses embedded length to trim padding)
 */
export function z85Decode(str: string): Uint8Array {
  if (!str.length) return new Uint8Array(0);

  if (str.length % 5 !== 0) {
    throw new SignatureDeserializationError(
      `Invalid Z85 string: length ${str.length} is not a multiple of 5`,
      DeserializationErrorCode.INVALID_ENCODING,
    );
  }

  // Pre-allocate array: 5 Z85 chars decode to 4 bytes
  const numGroups = str.length / 5;
  const bytes = new Uint8Array(numGroups * 4);
  let byteIdx = 0;

  for (let i = 0; i < str.length; i += 5) {
    let value = 0;
    for (let j = 0; j < 5; j++) {
      const charVal = Z85_DECODE_MAP.get(str[i + j]);
      if (charVal === undefined) {
        throw new SignatureDeserializationError(
          `Invalid Z85 string: unexpected character '${str[i + j]}' at position ${i + j}`,
          DeserializationErrorCode.INVALID_ENCODING,
          i + j,
        );
      }
      value = value * 85 + charVal;
    }
    bytes[byteIdx++] = (value >> 24) & 0xff;
    bytes[byteIdx++] = (value >> 16) & 0xff;
    bytes[byteIdx++] = (value >> 8) & 0xff;
    bytes[byteIdx++] = value & 0xff;
  }

  // Use embedded length header to trim padding
  // Format: [MAGIC][VERSION][LEN_HI][LEN_LO][PAYLOAD...][CRC]
  if (bytes.length < 5) {
    throw new SignatureDeserializationError(
      `Invalid Z85 string: decoded to only ${bytes.length} bytes (minimum 5 required for header)`,
      DeserializationErrorCode.TRUNCATED_DATA,
    );
  }

  if (bytes[0] !== MAGIC) {
    throw new SignatureDeserializationError(
      `Invalid Z85 string: wrong magic byte 0x${bytes[0].toString(16)} (expected 0x${MAGIC.toString(16)} 'S')`,
      DeserializationErrorCode.INVALID_MAGIC,
    );
  }

  const payloadLen = (bytes[1 + 1] << 8) | bytes[1 + 2]; // Skip version byte
  const totalLen = 1 + 1 + 2 + payloadLen + 1; // magic + version + len + payload + crc

  if (totalLen > bytes.length) {
    throw new SignatureDeserializationError(
      `Invalid Z85 string: header claims ${totalLen} bytes but only ${bytes.length} were decoded (data may be truncated)`,
      DeserializationErrorCode.TRUNCATED_DATA,
    );
  }

  return bytes.subarray(0, totalLen);
}

// ============================================================================
// BASE64 ENCODING
// ============================================================================
// Standard base64 and URL-safe base64 (base64url) implementations.
// These work in both browser and Node.js environments.

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Pre-built decode map supporting both standard and URL-safe alphabets
const B64_DECODE_MAP = new Map<string, number>();
for (let i = 0; i < 64; i++) {
  B64_DECODE_MAP.set(B64_ALPHABET[i], i);
  B64_DECODE_MAP.set(B64URL_ALPHABET[i], i);
}

/**
 * Encode bytes to base64 string
 * @param bytes - Input bytes
 * @param urlSafe - Use URL-safe alphabet
 * @returns Base64-encoded string
 */
export function base64Encode(bytes: Uint8Array, urlSafe = false): string {
  const alphabet = urlSafe ? B64URL_ALPHABET : B64_ALPHABET;
  let result = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    result += alphabet[b0 >> 2];
    result += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    result +=
      i + 1 < bytes.length ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    result += i + 2 < bytes.length ? alphabet[b2 & 0x3f] : "=";
  }

  return result;
}

/**
 * Decode base64 string to bytes
 * @param str - Base64-encoded string (standard or URL-safe)
 * @returns Decoded bytes
 */
export function base64Decode(str: string): Uint8Array {
  // Remove padding
  str = str.replace(/=+$/, "");

  // Validate length: base64 encodes 3 bytes → 4 chars, so valid lengths
  // after padding removal are 0, 2, 3, 4, 6, 7, 8, ... (never 1 mod 4)
  if (str.length % 4 === 1) {
    throw new SignatureDeserializationError(
      `Invalid base64 string: length ${str.length} after padding removal is 1 mod 4 (impossible for valid base64)`,
      DeserializationErrorCode.INVALID_ENCODING,
    );
  }

  const len = str.length;
  // Calculate output size: 4 chars → 3 bytes, with remainder handling
  const fullGroups = Math.floor(len / 4);
  const remainder = len % 4;
  const outputLen =
    fullGroups * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  const bytes = new Uint8Array(outputLen);
  let byteIdx = 0;

  // Process complete 4-char groups
  const fullGroupsEnd = fullGroups * 4;
  for (let i = 0; i < fullGroupsEnd; i += 4) {
    const c0 = B64_DECODE_MAP.get(str[i]);
    const c1 = B64_DECODE_MAP.get(str[i + 1]);
    const c2 = B64_DECODE_MAP.get(str[i + 2]);
    const c3 = B64_DECODE_MAP.get(str[i + 3]);

    if (
      c0 === undefined ||
      c1 === undefined ||
      c2 === undefined ||
      c3 === undefined
    ) {
      const badPos = [c0, c1, c2, c3].findIndex((c) => c === undefined);
      throw new SignatureDeserializationError(
        `Invalid base64 string: unexpected character '${str[i + badPos]}' at position ${i + badPos}`,
        DeserializationErrorCode.INVALID_ENCODING,
        i + badPos,
      );
    }

    bytes[byteIdx++] = (c0 << 2) | (c1 >> 4);
    bytes[byteIdx++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    bytes[byteIdx++] = ((c2 & 0x03) << 6) | c3;
  }

  // Process remaining 2 or 3 chars (if any)
  if (remainder === 2) {
    const c0 = B64_DECODE_MAP.get(str[fullGroupsEnd]);
    const c1 = B64_DECODE_MAP.get(str[fullGroupsEnd + 1]);
    if (c0 === undefined || c1 === undefined) {
      const badPos = c0 === undefined ? 0 : 1;
      throw new SignatureDeserializationError(
        `Invalid base64 string: unexpected character '${str[fullGroupsEnd + badPos]}' at position ${fullGroupsEnd + badPos}`,
        DeserializationErrorCode.INVALID_ENCODING,
        fullGroupsEnd + badPos,
      );
    }
    bytes[byteIdx++] = (c0 << 2) | (c1 >> 4);
  } else if (remainder === 3) {
    const c0 = B64_DECODE_MAP.get(str[fullGroupsEnd]);
    const c1 = B64_DECODE_MAP.get(str[fullGroupsEnd + 1]);
    const c2 = B64_DECODE_MAP.get(str[fullGroupsEnd + 2]);
    if (c0 === undefined || c1 === undefined || c2 === undefined) {
      const badPos = c0 === undefined ? 0 : c1 === undefined ? 1 : 2;
      throw new SignatureDeserializationError(
        `Invalid base64 string: unexpected character '${str[fullGroupsEnd + badPos]}' at position ${fullGroupsEnd + badPos}`,
        DeserializationErrorCode.INVALID_ENCODING,
        fullGroupsEnd + badPos,
      );
    }
    bytes[byteIdx++] = (c0 << 2) | (c1 >> 4);
    bytes[byteIdx++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
  }

  return bytes;
}

// ============================================================================
// CRC-8 CHECKSUM
// ============================================================================
// CRC-8-CCITT with polynomial 0x07. Provides good error detection for
// short messages:
// - Detects all single-bit errors
// - Detects all burst errors up to 8 bits
// - Detects ~99.6% of multi-bit errors
//
// SECURITY NOTE: CRC-8 is designed for ERROR DETECTION, not tamper resistance.
// With only 256 possible checksums, an attacker can easily craft collisions or
// modify data and fix the CRC. If you need protection against intentional
// tampering, wrap signatures in HMAC-SHA256 or similar cryptographic MAC.
// CRC-8 is appropriate for detecting accidental corruption during storage or
// transmission, which is its intended use case here.

/**
 * Compute CRC-8-CCITT checksum
 * @param bytes - Input bytes
 * @param start - Start index
 * @param length - Number of bytes to checksum
 * @returns 8-bit checksum
 */
export function computeCRC8(
  bytes: Uint8Array,
  start: number,
  length: number,
): number {
  let crc = 0;
  for (let i = start; i < start + length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1;
    }
    crc &= 0xff;
  }
  return crc;
}

// ============================================================================
// POLYLINE SIMPLIFICATION (Ramer-Douglas-Peucker)
// ============================================================================
// Reduces the number of points in a stroke while preserving its shape.
// This is essential for compact encoding - a typical stroke might have
// hundreds of raw points but only needs 10-30 points after simplification.
//
// The algorithm iteratively finds the point with maximum perpendicular
// distance from the line segment connecting endpoints, and subdivides
// if that distance exceeds epsilon.

/**
 * Simplify a polyline using Ramer-Douglas-Peucker algorithm
 * @param points - Input points
 * @param epsilon - Maximum allowed perpendicular distance
 * @returns Simplified points
 */
export function simplifyPolyline(
  points: readonly Point[],
  epsilon: number,
): Point[] {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }));

  const epsilonSq = epsilon * epsilon;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Stack-based iteration to avoid recursion
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;

    const s = points[start];
    const e = points[end];
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const lenSq = dx * dx + dy * dy;

    let maxDistSq = 0;
    let maxIdx = start;

    for (let i = start + 1; i < end; i++) {
      let distSq: number;
      if (lenSq === 0) {
        // Start and end are same point
        const px = points[i].x - s.x;
        const py = points[i].y - s.y;
        distSq = px * px + py * py;
      } else {
        // Perpendicular distance squared
        const t = ((points[i].x - s.x) * dx + (points[i].y - s.y) * dy) / lenSq;
        const projX = s.x + t * dx;
        const projY = s.y + t * dy;
        const px = points[i].x - projX;
        const py = points[i].y - projY;
        distSq = px * px + py * py;
      }

      if (distSq > maxDistSq) {
        maxDistSq = distSq;
        maxIdx = i;
      }
    }

    if (maxDistSq > epsilonSq) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  // Collect kept points
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push({ x: points[i].x, y: points[i].y });
  }
  return result;
}

// ============================================================================
// ARITHMETIC CODING
// ============================================================================
// Arithmetic coding compresses data by encoding the entire message as a
// single number in the range [0, 1). Each symbol narrows this range based
// on its probability. With accurate probability estimates, arithmetic
// coding approaches the theoretical entropy limit.
//
// This implementation uses a static Laplacian probability model tuned for
// signature delta-encoded bytes. The model assumes:
// - First bytes (dx) cluster around 126 (delta = 0)
// - Second bytes (dy) cluster around 127 (delta = 0)
// - Control bytes (0xFC-0xFF) are rare
//
// The static model avoids transmitting probability tables with each
// signature while still achieving good compression (typically 20-40%).

/**
 * Build static Laplacian probability model for V1 payload bytes.
 *
 * Parameters were empirically derived from a corpus of real signature data.
 * The Laplacian distribution models the observation that most strokes move
 * in small increments (deltas near zero), with occasional larger jumps.
 *
 * @returns Frequency table (256 entries)
 */
function buildStaticModel(): Uint32Array {
  const freq = new Uint32Array(256);

  // Laplacian distribution: P(x) proportional to exp(-|x - center| / scale)
  // Parameters empirically derived from real signature data
  const DX_CENTER = 125; // dx=0 maps to byte 125
  const DY_CENTER = 127; // dy=0 maps to byte 127
  const SCALE_DX = 10; // Tighter distribution (movement along stroke)
  const SCALE_DY = 16; // Wider distribution (vertical variation)
  const AMPLITUDE = 100;

  for (let i = 0; i < 256; i++) {
    // First byte contribution (dx): valid for 0x00-0xFB
    if (i <= 0xfb) {
      freq[i] += Math.round(
        AMPLITUDE * Math.exp(-Math.abs(i - DX_CENTER) / SCALE_DX),
      );
    }
    // Second byte contribution (dy): all 256 values valid
    freq[i] += Math.round(
      AMPLITUDE * Math.exp(-Math.abs(i - DY_CENTER) / SCALE_DY),
    );
  }

  // Control byte frequencies (empirically derived from real signatures)
  freq[CTRL_STROKE_LO] = 30; // Common: stroke marker, x < 256
  freq[CTRL_STROKE_HI] = 3; // Rare: stroke marker, x >= 256
  freq[CTRL_ABS_LO] = 1; // Very rare: absolute position
  freq[CTRL_ABS_HI] = 1;

  // Ensure minimum frequency of 1 (Laplace smoothing)
  for (let i = 0; i < 256; i++) {
    freq[i] = Math.max(freq[i], 1);
  }

  return freq;
}

/**
 * Arithmetic encoder/decoder using a frequency table
 */
class ArithmeticCoder {
  private readonly NUM_BITS: number = 31;
  private readonly FULL: number;
  private readonly HALF: number;
  private readonly QUARTER: number;
  private readonly freq: Uint32Array;
  private cumFreq: Uint32Array;
  private total: number;

  constructor(freqTable: Uint32Array) {
    this.FULL = (1 << this.NUM_BITS) >>> 0;
    this.HALF = (1 << (this.NUM_BITS - 1)) >>> 0;
    this.QUARTER = (1 << (this.NUM_BITS - 2)) >>> 0;
    this.freq = freqTable;
    this.cumFreq = new Uint32Array(257);
    this.total = 0;
    this._buildCumulative();
  }

  /**
   * Build cumulative frequency table for range coding
   */
  private _buildCumulative(): void {
    this.cumFreq = new Uint32Array(257);
    this.cumFreq[0] = 0;
    for (let i = 0; i < 256; i++) {
      this.cumFreq[i + 1] = this.cumFreq[i] + this.freq[i];
    }
    this.total = this.cumFreq[256];

    // Prevent integer overflow in range calculations
    // range * symHigh must fit in 53-bit safe integer
    // With range up to 2^31 and total up to 2^22, product is safe
    const MAX_SAFE_TOTAL = 1 << 22;
    if (this.total >= MAX_SAFE_TOTAL) {
      const scale = MAX_SAFE_TOTAL / this.total;
      this.cumFreq[0] = 0;
      for (let i = 0; i < 256; i++) {
        const scaled = Math.max(1, Math.floor(this.freq[i] * scale));
        this.cumFreq[i + 1] = this.cumFreq[i] + scaled;
      }
      this.total = this.cumFreq[256];
    }
  }

  /**
   * Encode data bytes to compressed bits (no framing - caller handles length)
   * @param data - Input bytes
   * @returns Compressed bits only
   */
  encode(data: Uint8Array): Uint8Array {
    if (data.length === 0) return new Uint8Array(0);

    // Pre-allocate output buffer with margin
    let output = new Uint8Array(Math.max(16, data.length + 8));
    let outPos = 0;
    let currentByte = 0;
    let bitCount = 0;

    const ensureCapacity = (): void => {
      if (outPos >= output.length) {
        const newOutput = new Uint8Array(output.length * 2);
        newOutput.set(output);
        output = newOutput;
      }
    };

    const writeBit = (bit: number): void => {
      currentByte = (currentByte << 1) | bit;
      bitCount++;
      if (bitCount === 8) {
        ensureCapacity();
        output[outPos++] = currentByte;
        currentByte = 0;
        bitCount = 0;
      }
    };

    let low = 0;
    let high = this.FULL;
    let pending = 0;

    const outputBit = (bit: number): void => {
      writeBit(bit);
      while (pending > 0) {
        writeBit(1 - bit);
        pending--;
      }
    };

    for (const byte of data) {
      const range = high - low;
      const symLow = this.cumFreq[byte];
      const symHigh = this.cumFreq[byte + 1];

      // The -1 on high is essential for correct interval semantics.
      // Without it, boundary values decode to the wrong symbol.
      // See: Nayuki reference implementation, Witten-Neal-Cleary paper.
      high = low + Math.floor((range * symHigh) / this.total) - 1;
      low = low + Math.floor((range * symLow) / this.total);

      while (true) {
        if (high < this.HALF) {
          outputBit(0);
          low = low * 2;
          high = high * 2 + 1;
        } else if (low >= this.HALF) {
          outputBit(1);
          low = (low - this.HALF) * 2;
          high = (high - this.HALF) * 2 + 1;
        } else if (low >= this.QUARTER && high < 3 * this.QUARTER) {
          pending++;
          low = (low - this.QUARTER) * 2;
          high = (high - this.QUARTER) * 2 + 1;
        } else {
          break;
        }
        low = low >>> 0;
        high = high >>> 0;
      }
    }

    // Flush final bits
    pending++;
    outputBit(low < this.QUARTER ? 0 : 1);

    if (bitCount > 0) {
      ensureCapacity();
      output[outPos++] = currentByte << (8 - bitCount);
    }

    return output.subarray(0, outPos);
  }

  /**
   * Decode compressed bits to original data
   * @param compressed - Compressed bits (no framing)
   * @param originalLength - Original uncompressed length (caller provides)
   * @returns Original data
   */
  decode(compressed: Uint8Array, originalLength: number): Uint8Array {
    if (originalLength === 0 || compressed.length === 0)
      return new Uint8Array(0);

    // Sanity check: with the static Laplacian model, compression ratio is typically
    // 0.6-0.8x (mild compression). Even with optimal data, entropy limits compression
    // to ~6 bits/byte minimum. Allow up to 2:1 ratio as a generous bound that still
    // catches severe corruption (e.g., originalLength header corrupted to huge value).
    if (originalLength > compressed.length * 2) {
      throw new SignatureDeserializationError(
        `Implausible decoded length: ${originalLength} from ${compressed.length} compressed bytes (max ratio 2:1)`,
        DeserializationErrorCode.CORRUPTED_PAYLOAD,
      );
    }

    // Read bits on-demand from compressed bytes (avoids allocating full bit array)
    const totalBits = compressed.length * 8;
    let bitIdx = 0;
    const readBit = (): number => {
      if (bitIdx >= totalBits) return 0;
      const byteIdx = bitIdx >> 3;
      const bitOffset = 7 - (bitIdx & 7);
      bitIdx++;
      return (compressed[byteIdx] >> bitOffset) & 1;
    };

    let low = 0;
    let high = this.FULL;
    let value = 0;

    for (let i = 0; i < this.NUM_BITS && bitIdx < totalBits; i++) {
      value = (value << 1) | readBit();
    }
    value = value >>> 0;

    const result: number[] = [];

    for (let n = 0; n < originalLength; n++) {
      const range = high - low;
      if (range <= 0) {
        throw new SignatureDeserializationError(
          "Corrupt data: range collapsed",
          DeserializationErrorCode.CORRUPTED_PAYLOAD,
        );
      }

      const scaled = Math.floor(((value - low + 1) * this.total - 1) / range);

      if (scaled < 0 || scaled >= this.total) {
        throw new SignatureDeserializationError(
          `Corrupt data: scaled value ${scaled} out of range`,
          DeserializationErrorCode.CORRUPTED_PAYLOAD,
        );
      }

      // Binary search for symbol
      let lo = 0,
        hi = 255;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.cumFreq[mid] <= scaled) lo = mid;
        else hi = mid - 1;
      }
      const symbol = lo;

      result.push(symbol);

      const symLow = this.cumFreq[symbol];
      const symHigh = this.cumFreq[symbol + 1];
      // Must match encoder's -1 adjustment for correct interval tracking
      high = low + Math.floor((range * symHigh) / this.total) - 1;
      low = low + Math.floor((range * symLow) / this.total);

      while (true) {
        if (high < this.HALF) {
          low = low * 2;
          high = high * 2 + 1;
          value = value * 2 + readBit();
        } else if (low >= this.HALF) {
          low = (low - this.HALF) * 2;
          high = (high - this.HALF) * 2 + 1;
          value = (value - this.HALF) * 2 + readBit();
        } else if (low >= this.QUARTER && high < 3 * this.QUARTER) {
          low = (low - this.QUARTER) * 2;
          high = (high - this.QUARTER) * 2 + 1;
          value = (value - this.QUARTER) * 2 + readBit();
        } else {
          break;
        }
        low = low >>> 0;
        high = high >>> 0;
        value = value >>> 0;
      }
    }

    return new Uint8Array(result);
  }
}

// ============================================================================
// VERSION 1 ENCODER/DECODER
// ============================================================================
//
// V1 payload structure:
//   [ORIG_LEN_HI] [ORIG_LEN_LO] [ARITH_COMPRESSED_BITS...]
//
// The payload is:
//   1. Delta-encoded stroke data (2-byte deltas, 3-byte absolute/stroke markers)
//   2. Arithmetic compressed using a static Laplacian probability model
//
// Compression is a V1-specific concern - the envelope just sees opaque bytes.

// V1's arithmetic coder with its hardcoded frequency table
const v1ArithmeticCoder = new ArithmeticCoder(buildStaticModel());

/**
 * Pack 17-bit position (9-bit x, 8-bit y) into control byte indicator + 2 data bytes
 * @param x - X coordinate (0-511)
 * @param y - Y coordinate (0-255)
 * @returns Packed position data
 */
function packPosition(x: number, y: number): PackedPosition {
  const bit16 = (x >> 8) & 1; // High bit of x
  const hi = x & 0xff; // Low 8 bits of x
  const lo = y; // Full y
  return { bit16, hi, lo };
}

/**
 * Unpack 17-bit position from control byte indicator + 2 data bytes
 * @param bit16 - High bit of x (0 or 1)
 * @param hi - Low 8 bits of x
 * @param lo - Y coordinate
 * @returns Unpacked point
 */
function unpackPosition(bit16: number, hi: number, lo: number): Point {
  return { x: (bit16 << 8) | hi, y: lo };
}

/**
 * Encode strokes to V1 payload bytes
 * @param strokes - Normalized strokes
 * @returns Payload and encoding statistics
 */
function encodeV1(strokes: readonly Stroke[]): {
  payload: Uint8Array;
  stats: EncodeStats;
} {
  const stats: EncodeStats = {
    deltas: 0,
    absolutes: 0,
    strokeMarkers: 0,
    overflowDxOnly: 0,
    overflowDyOnly: 0,
    overflowBoth: 0,
  };

  // Estimate max size: 3 bytes per point + 3 per stroke
  const maxPoints = strokes.reduce((sum, s) => sum + s.length, 0);
  const maxSize = strokes.length * 3 + maxPoints * 3;
  const buffer = new Uint8Array(maxSize);
  let pos = 0;

  for (const stroke of strokes) {
    if (!stroke.length) continue;

    // Stroke marker with first point
    const x0 = Math.min(
      V1_CANVAS_WIDTH - 1,
      Math.max(0, Math.round(stroke[0].x)),
    );
    const y0 = Math.min(
      V1_CANVAS_HEIGHT - 1,
      Math.max(0, Math.round(stroke[0].y)),
    );
    const p0 = packPosition(x0, y0);
    buffer[pos++] = p0.bit16 ? CTRL_STROKE_HI : CTRL_STROKE_LO;
    buffer[pos++] = p0.hi;
    buffer[pos++] = p0.lo;
    stats.strokeMarkers++;

    let px = x0,
      py = y0;

    for (let i = 1; i < stroke.length; i++) {
      const cx = Math.min(
        V1_CANVAS_WIDTH - 1,
        Math.max(0, Math.round(stroke[i].x)),
      );
      const cy = Math.min(
        V1_CANVAS_HEIGHT - 1,
        Math.max(0, Math.round(stroke[i].y)),
      );
      const dx = cx - px;
      const dy = cy - py;

      const dxInRange = dx >= DX_MIN && dx <= DX_MAX;
      const dyInRange = dy >= DY_MIN && dy <= DY_MAX;

      if (dxInRange && dyInRange) {
        // 2-byte delta
        buffer[pos++] = dx - DX_MIN; // 0x00-0xFB
        buffer[pos++] = dy - DY_MIN; // 0x00-0xFF
        stats.deltas++;
      } else {
        // 3-byte absolute
        const p = packPosition(cx, cy);
        buffer[pos++] = p.bit16 ? CTRL_ABS_HI : CTRL_ABS_LO;
        buffer[pos++] = p.hi;
        buffer[pos++] = p.lo;
        stats.absolutes++;

        if (!dxInRange && !dyInRange) stats.overflowBoth++;
        else if (!dxInRange) stats.overflowDxOnly++;
        else stats.overflowDyOnly++;
      }

      px = cx;
      py = cy;
    }
  }

  return { payload: buffer.subarray(0, pos), stats };
}

/**
 * Decode V1 payload bytes to strokes
 *
 * Note: Coordinates are silently clamped to the valid range [0, V1_CANVAS_WIDTH-1] × [0, V1_CANVAS_HEIGHT-1].
 * This ensures the decoder always produces valid output even if the data is slightly corrupted,
 * but means out-of-range coordinates will be coerced rather than rejected. For most use cases
 * this is preferable to hard failure, since CRC validation catches actual corruption.
 *
 * @param payload - V1 payload bytes
 * @returns Decoded strokes
 */
function decodeV1(payload: Uint8Array): Stroke[] {
  const strokes: Stroke[] = [];
  let current: Point[] = [];
  let px = 0,
    py = 0;
  let inStroke = false;
  let i = 0;

  while (i < payload.length) {
    const b = payload[i];

    // Stroke marker
    if (b === CTRL_STROKE_LO || b === CTRL_STROKE_HI) {
      if (current.length) strokes.push(current);
      current = [];

      if (i + 2 >= payload.length) {
        throw new SignatureDeserializationError(
          `Truncated stroke marker at position ${i}`,
          DeserializationErrorCode.TRUNCATED_DATA,
          i,
        );
      }

      const bit16 = b === CTRL_STROKE_HI ? 1 : 0;
      const pos = unpackPosition(bit16, payload[i + 1], payload[i + 2]);
      px = Math.max(0, Math.min(V1_CANVAS_WIDTH - 1, pos.x));
      py = Math.max(0, Math.min(V1_CANVAS_HEIGHT - 1, pos.y));
      current.push({ x: px, y: py });
      inStroke = true;
      i += 3;
      continue;
    }

    // Absolute position
    if (b === CTRL_ABS_LO || b === CTRL_ABS_HI) {
      if (!inStroke) {
        throw new SignatureDeserializationError(
          `Absolute position before stroke marker at position ${i}`,
          DeserializationErrorCode.CORRUPTED_PAYLOAD,
          i,
        );
      }
      if (i + 2 >= payload.length) {
        throw new SignatureDeserializationError(
          `Truncated absolute position at position ${i}`,
          DeserializationErrorCode.TRUNCATED_DATA,
          i,
        );
      }

      const bit16 = b === CTRL_ABS_HI ? 1 : 0;
      const pos = unpackPosition(bit16, payload[i + 1], payload[i + 2]);
      px = Math.max(0, Math.min(V1_CANVAS_WIDTH - 1, pos.x));
      py = Math.max(0, Math.min(V1_CANVAS_HEIGHT - 1, pos.y));
      current.push({ x: px, y: py });
      i += 3;
      continue;
    }

    // 2-byte delta
    if (!inStroke) {
      throw new SignatureDeserializationError(
        `Delta before stroke marker at position ${i}`,
        DeserializationErrorCode.CORRUPTED_PAYLOAD,
        i,
      );
    }
    if (i + 1 >= payload.length) {
      throw new SignatureDeserializationError(
        `Truncated delta at position ${i}`,
        DeserializationErrorCode.TRUNCATED_DATA,
        i,
      );
    }

    const dx = b + DX_MIN;
    const dy = payload[i + 1] + DY_MIN;
    px += dx;
    py += dy;
    px = Math.max(0, Math.min(V1_CANVAS_WIDTH - 1, px));
    py = Math.max(0, Math.min(V1_CANVAS_HEIGHT - 1, py));
    current.push({ x: px, y: py });
    i += 2;
  }

  if (current.length) strokes.push(current);
  return strokes;
}

/**
 * Encode strokes to complete V1 payload (delta encode + arithmetic compress)
 * V1 payload format: [ORIG_LEN_HI] [ORIG_LEN_LO] [ARITH_COMPRESSED_BITS...]
 * @param strokes - Normalized strokes
 * @returns Payload and encoding statistics
 */
function encodeV1Payload(strokes: readonly Stroke[]): {
  payload: Uint8Array;
  stats: EncodeStats;
} {
  // Step 1: Delta encode
  const { payload: deltaBytes, stats } = encodeV1(strokes);

  // Step 2: Arithmetic compress
  const compressed = v1ArithmeticCoder.encode(deltaBytes);

  // Step 3: Prepend original length header
  const payload = new Uint8Array(2 + compressed.length);
  payload[0] = (deltaBytes.length >> 8) & 0xff;
  payload[1] = deltaBytes.length & 0xff;
  payload.set(compressed, 2);

  return { payload, stats };
}

/**
 * Decode complete V1 payload to strokes (arithmetic decompress + delta decode)
 * V1 payload format: [ORIG_LEN_HI] [ORIG_LEN_LO] [ARITH_COMPRESSED_BITS...]
 * @param payload - V1 payload bytes
 * @returns Decoded strokes
 */
function decodeV1Payload(payload: Uint8Array): Stroke[] {
  if (payload.length < 2) {
    throw new SignatureDeserializationError(
      "V1 payload too short",
      DeserializationErrorCode.TRUNCATED_DATA,
    );
  }

  // Step 1: Extract original length
  const originalLength = (payload[0] << 8) | payload[1];
  const compressed = payload.subarray(2);

  // Step 2: Arithmetic decompress
  const deltaBytes = v1ArithmeticCoder.decode(compressed, originalLength);

  // Step 3: Delta decode
  return decodeV1(deltaBytes);
}

// ============================================================================
// SIGNATURE V1 INTERNALS
// ============================================================================

/**
 * Version 1 internals for analysis and inspection.
 *
 * **UNSTABLE API**: This class exposes internal implementation details of the V1
 * format for debugging and analysis purposes. The API surface of this class may
 * change in minor versions without notice. Do not depend on this class for
 * production code that requires stability guarantees.
 *
 * Use cases:
 * - Debugging compression efficiency
 * - Analyzing delta encoding statistics
 * - Understanding the binary format
 */
export class SignatureV1Internals {
  private readonly _strokes: Stroke[];
  private _cachedPayload: Uint8Array | null = null;
  private _cachedStats: EncodeStats | null = null;

  constructor(normalizedStrokes: Stroke[]) {
    this._strokes = normalizedStrokes;
  }

  /** Format version */
  get version(): number {
    return VERSION_1;
  }

  /**
   * Get normalized strokes (512×256 coordinate space)
   * @returns Copy of strokes
   */
  getNormalizedStrokes(): Stroke[] {
    return this._strokes.map((s) => s.map((p) => ({ x: p.x, y: p.y })));
  }

  /**
   * Get V1 payload bytes (delta-encoded, before arithmetic compression)
   * @returns Payload bytes
   */
  getPayloadBytes(): Uint8Array {
    this._ensureEncoded();
    return this._cachedPayload!.slice();
  }

  /**
   * Get encoding statistics from last encode
   * @returns Stats object
   */
  getEncodeStats(): EncodeStats {
    this._ensureEncoded();
    return { ...this._cachedStats! };
  }

  /**
   * Get delta frequencies for analysis
   * @returns Delta frequency data
   */
  getDeltaFrequencies(): DeltaFrequencies {
    this._ensureEncoded();

    const dxFreq = new Uint32Array(DX_RANGE);
    const dyFreq = new Uint32Array(DY_RANGE);
    const joint = new Uint32Array(DX_RANGE * DY_RANGE);

    const payload = this._cachedPayload!;
    let i = 0;

    while (i < payload.length) {
      const b = payload[i];

      // Skip 3-byte commands
      if (b >= CTRL_STROKE_LO) {
        i += 3;
        continue;
      }

      // 2-byte delta
      if (i + 1 < payload.length) {
        const dxIdx = b; // Already offset from DX_MIN
        const dyIdx = payload[i + 1];
        dxFreq[dxIdx]++;
        dyFreq[dyIdx]++;
        joint[dxIdx * DY_RANGE + dyIdx]++;
        i += 2;
      } else {
        break;
      }
    }

    return { dx: dxFreq, dy: dyFreq, joint };
  }

  /**
   * Get byte frequency distribution of payload
   * @returns 256-entry frequency table
   */
  getByteFrequencies(): Uint32Array {
    this._ensureEncoded();
    const freq = new Uint32Array(256);
    for (const b of this._cachedPayload!) {
      freq[b]++;
    }
    return freq;
  }

  /**
   * Get the arithmetic coder used for V1 compression (for analysis)
   * @returns The V1 arithmetic coder instance
   */
  getArithmeticCoder(): ArithmeticCoder {
    return v1ArithmeticCoder;
  }

  /**
   * Ensure payload is encoded (lazy encoding)
   */
  private _ensureEncoded(): void {
    if (this._cachedPayload === null) {
      const { payload, stats } = encodeV1(this._strokes);
      this._cachedPayload = payload;
      this._cachedStats = stats;
    }
  }

  /**
   * Invalidate cached encoding (call when strokes change)
   * @internal
   */
  _invalidate(): void {
    this._cachedPayload = null;
    this._cachedStats = null;
  }
}

// ============================================================================
// SVG RENDERER
// ============================================================================

/**
 * Render strokes as SVG path data using Catmull-Rom spline interpolation
 * @param points - Stroke points
 * @param tension - Spline tension (0-1)
 * @returns SVG path d attribute
 */
function strokeToSplinePath(points: readonly Point[], tension: number): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // Single point - render as small circle (handled separately)
    return "";
  }

  // Use array + join to avoid O(n²) string concatenation
  const parts: string[] = [
    `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
  ];

  if (points.length === 2) {
    parts.push(`L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`);
    return parts.join(" ");
  }

  // Catmull-Rom to Bezier conversion
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    const cp1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const cp2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    const cp2y = p2.y - ((p3.y - p1.y) * tension) / 3;

    parts.push(
      `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    );
  }

  return parts.join(" ");
}

/**
 * Render strokes as SVG path data using linear interpolation
 * @param points - Stroke points
 * @returns SVG path d attribute
 */
function strokeToLinearPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return "";

  // Use array + join to avoid O(n²) string concatenation
  const parts: string[] = [
    `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`,
  ];
  for (let i = 1; i < points.length; i++) {
    parts.push(`L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`);
  }
  return parts.join(" ");
}

/** Minimum bounding box size in normalized space to prevent degenerate scaling */
const MIN_CONTENT_BOUNDS = 20;

/**
 * Sanitize a color value for safe SVG embedding.
 * Uses CSS.supports() in browser environments for accurate validation,
 * falls back to regex patterns in Node.js.
 * Rejects anything that could contain SVG/XML injection characters.
 * @param color - Color value to sanitize
 * @param fallback - Fallback color if invalid
 * @returns Safe color value
 */
function sanitizeColor(color: unknown, fallback: string): string {
  if (typeof color !== "string") return fallback;

  // First, reject anything with injection-risk characters
  if (/[<>"';\\]/.test(color)) return fallback;

  // Use CSS.supports() if available (browser environments)
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    if (CSS.supports("color", color)) return color;
    return fallback;
  }

  // Fallback patterns for Node.js or environments without CSS.supports()
  // Allow: hex colors, named colors (letters only), rgb/hsl functions with safe chars
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^[a-zA-Z]{1,20}$/.test(color)) return color;
  if (/^(rgb|hsl)a?\([0-9,.\s%]+\)$/.test(color)) return color;
  return fallback;
}

/**
 * Render normalized strokes to SVG string
 * @param strokes - Strokes in 512×256 space
 * @param options - Render options
 * @returns SVG document string
 */
function renderSVG(
  strokes: readonly Stroke[],
  options: RenderOptions = {},
): string {
  const {
    width = V1_CANVAS_WIDTH,
    height = V1_CANVAS_HEIGHT,
    strokeWidth = 2,
    strokeColor: rawStrokeColor = "#000000",
    spline = true,
    splineTension = DEFAULT_SPLINE_TENSION,
    backgroundColor: rawBgColor = null,
    contentFit = true,
    contentPadding = 0.05,
  } = options;

  // Validate render dimensions to prevent division by zero and DoS
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(strokeWidth)
  ) {
    throw new SignatureValidationError(
      "Render dimensions must be finite numbers",
      "dimensions",
    );
  }
  if (width <= 0 || height <= 0) {
    throw new SignatureValidationError(
      `Render dimensions must be positive (got ${width}×${height})`,
      "dimensions",
    );
  }
  if (strokeWidth < 0) {
    throw new SignatureValidationError(
      `Stroke width must be non-negative (got ${strokeWidth})`,
      "strokeWidth",
    );
  }
  const MAX_RENDER_DIMENSION = 10000;
  if (width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION) {
    throw new SignatureValidationError(
      `Render dimensions exceed maximum of ${MAX_RENDER_DIMENSION} (got ${width}×${height})`,
      "dimensions",
    );
  }

  // Validate spline tension
  if (
    !Number.isFinite(splineTension) ||
    splineTension < 0 ||
    splineTension > 1
  ) {
    throw new SignatureValidationError(
      `Spline tension must be a number between 0 and 1 (got ${splineTension})`,
      "splineTension",
    );
  }

  // Validate content padding
  if (
    !Number.isFinite(contentPadding) ||
    contentPadding < 0 ||
    contentPadding >= 0.5
  ) {
    throw new SignatureValidationError(
      `Content padding must be a number in range [0, 0.5) (got ${contentPadding})`,
      "contentPadding",
    );
  }

  // Sanitize color inputs to prevent SVG injection
  const strokeColor = sanitizeColor(rawStrokeColor, "#000000");
  const backgroundColor =
    rawBgColor === null ? null : sanitizeColor(rawBgColor, "#ffffff");

  // Determine source region (what part of normalized space to map from)
  let srcBounds: Bounds = {
    x: 0,
    y: 0,
    w: V1_CANVAS_WIDTH,
    h: V1_CANVAS_HEIGHT,
  };

  // Determine destination region (what part of output to map to)
  let dstBounds: Bounds = { x: 0, y: 0, w: width, h: height };

  if (contentFit && strokes.length > 0) {
    // Calculate bounding box of all stroke points
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const stroke of strokes) {
      for (const p of stroke) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    let boundsW = maxX - minX;
    let boundsH = maxY - minY;

    // Anti-degeneracy: enforce minimum bounds size to prevent extreme scaling
    // for single points or very thin strokes
    if (boundsW < MIN_CONTENT_BOUNDS) {
      const expand = (MIN_CONTENT_BOUNDS - boundsW) / 2;
      minX -= expand;
      boundsW = MIN_CONTENT_BOUNDS;
    }
    if (boundsH < MIN_CONTENT_BOUNDS) {
      const expand = (MIN_CONTENT_BOUNDS - boundsH) / 2;
      minY -= expand;
      boundsH = MIN_CONTENT_BOUNDS;
    }

    srcBounds = { x: minX, y: minY, w: boundsW, h: boundsH };

    // Apply padding to destination
    const padX = width * contentPadding;
    const padY = height * contentPadding;
    dstBounds = { x: padX, y: padY, w: width - 2 * padX, h: height - 2 * padY };
  }

  // Calculate scale to contain source in destination
  const scaleX = dstBounds.w / srcBounds.w;
  const scaleY = dstBounds.h / srcBounds.h;
  const scale = Math.min(scaleX, scaleY);

  // Calculate centering offsets within destination
  const scaledW = srcBounds.w * scale;
  const scaledH = srcBounds.h * scale;
  const offsetX = dstBounds.x + (dstBounds.w - scaledW) / 2;
  const offsetY = dstBounds.y + (dstBounds.h - scaledH) / 2;

  // Transform strokes from source to destination
  const scaledStrokes = strokes.map((stroke) =>
    stroke.map((p) => ({
      x: (p.x - srcBounds.x) * scale + offsetX,
      y: (p.y - srcBounds.y) * scale + offsetY,
    })),
  );

  // Build SVG paths
  const paths: string[] = [];
  const dots: string[] = [];

  for (const stroke of scaledStrokes) {
    if (stroke.length === 1) {
      // Single point - render as circle
      dots.push(
        `<circle cx="${stroke[0].x.toFixed(2)}" cy="${stroke[0].y.toFixed(2)}" r="${(strokeWidth / 2).toFixed(2)}" fill="${strokeColor}"/>`,
      );
    } else if (stroke.length > 1) {
      const d = spline
        ? strokeToSplinePath(stroke, splineTension)
        : strokeToLinearPath(stroke);
      if (d) {
        paths.push(
          `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
        );
      }
    }
  }

  // Assemble SVG
  const bgRect = backgroundColor
    ? `<rect width="${width}" height="${height}" fill="${backgroundColor}"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bgRect}${paths.join("")}${dots.join("")}</svg>`;
}

// ============================================================================
// SIGNATURE CLASS
// ============================================================================

/**
 * Main Signature class - public API for signature capture and serialization
 */
export class Signature {
  private readonly _epsilon: number;
  private readonly _canvasWidth: number;
  private readonly _canvasHeight: number;
  private readonly _scale: number;
  private readonly _offsetX: number;
  private readonly _offsetY: number;
  private _strokes: Stroke[];
  private _internals: SignatureV1Internals | null;

  /**
   * Create a new Signature
   * @param options - Configuration options
   */
  constructor(options: SignatureOptions = {}) {
    this._epsilon = options.simplifyEpsilon ?? DEFAULT_EPSILON;
    this._canvasWidth = options.canvasWidth ?? V1_CANVAS_WIDTH;
    this._canvasHeight = options.canvasHeight ?? V1_CANVAS_HEIGHT;

    // Validate epsilon
    if (!Number.isFinite(this._epsilon) || this._epsilon < 0) {
      throw new SignatureValidationError(
        `Simplify epsilon must be a non-negative finite number (got ${this._epsilon})`,
        "simplifyEpsilon",
      );
    }

    // Guard against invalid dimensions which cause division by zero or NaN propagation
    if (
      !Number.isFinite(this._canvasWidth) ||
      !Number.isFinite(this._canvasHeight)
    ) {
      throw new SignatureValidationError(
        "Canvas dimensions must be finite numbers",
        "canvasDimensions",
      );
    }
    if (this._canvasWidth <= 0 || this._canvasHeight <= 0) {
      throw new SignatureValidationError(
        `Canvas dimensions must be positive (got ${this._canvasWidth}×${this._canvasHeight})`,
        "canvasDimensions",
      );
    }

    this._strokes = []; // Normalized strokes (512×256)
    this._internals = null;

    // Cache scaling factors (computed once, used for all coordinate transforms)
    const scaleX = (V1_CANVAS_WIDTH - 1) / this._canvasWidth;
    const scaleY = (V1_CANVAS_HEIGHT - 1) / this._canvasHeight;
    this._scale = Math.min(scaleX, scaleY);

    const scaledWidth = this._canvasWidth * this._scale;
    const scaledHeight = this._canvasHeight * this._scale;
    this._offsetX = (V1_CANVAS_WIDTH - 1 - scaledWidth) / 2;
    this._offsetY = (V1_CANVAS_HEIGHT - 1 - scaledHeight) / 2;
  }

  /**
   * Scale points from user canvas to normalized 512×256 space
   */
  private _scaleToNormalized(points: readonly Point[]): Point[] {
    return points.map((p) => ({
      x: p.x * this._scale + this._offsetX,
      y: p.y * this._scale + this._offsetY,
    }));
  }

  /**
   * Scale points from normalized 512×256 space to user canvas
   */
  private _scaleFromNormalized(points: readonly Point[]): Point[] {
    return points.map((p) => ({
      x: (p.x - this._offsetX) / this._scale,
      y: (p.y - this._offsetY) / this._scale,
    }));
  }

  /**
   * Get total point count across all strokes
   */
  private _getTotalPoints(): number {
    return this._strokes.reduce((sum, s) => sum + s.length, 0);
  }

  /**
   * Validate and filter points, removing NaN/Infinity values
   * @param points - Raw points to validate
   * @returns Filtered array with only finite coordinates
   */
  private _validatePoints(points: readonly Point[]): Point[] {
    return points.filter(
      (p) =>
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y),
    );
  }

  /**
   * Add a stroke (raw points in user canvas coordinates)
   * @param points - Raw stroke points
   * @throws Error if adding the stroke would exceed MAX_TOTAL_POINTS
   */
  pushStroke(points: readonly Point[]): void {
    if (!points || points.length === 0) return;

    // Filter out invalid coordinates (NaN, Infinity)
    const validPoints = this._validatePoints(points);
    if (validPoints.length === 0) return;

    // Check point limit before adding
    const currentTotal = this._getTotalPoints();
    // Estimate simplified point count (can't exceed input count)
    if (currentTotal + validPoints.length > MAX_TOTAL_POINTS) {
      throw new Error(
        `Cannot add stroke: would exceed maximum of ${MAX_TOTAL_POINTS} total points (current: ${currentTotal}, adding: ${validPoints.length})`,
      );
    }

    // Scale to normalized coordinates (using cached factors)
    const scaled = this._scaleToNormalized(validPoints);

    // Simplify
    const simplified = simplifyPolyline(scaled, this._epsilon);

    // Round to integer coordinates
    const rounded = simplified.map((p) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
    }));

    this._strokes.push(rounded);
    this._invalidateInternals();
  }

  /**
   * Remove and return the last stroke
   * @returns Removed stroke in user coordinates, or null if empty
   */
  popStroke(): Point[] | null {
    if (this._strokes.length === 0) return null;

    const normalized = this._strokes.pop()!;
    this._invalidateInternals();

    // Scale back to user coordinates (using cached factors)
    return this._scaleFromNormalized(normalized);
  }

  /**
   * Get all strokes (simplified, in user canvas coordinates)
   * @returns Copy of strokes
   */
  getStrokes(): Stroke[] {
    return this._strokes.map((stroke) => this._scaleFromNormalized(stroke));
  }

  /**
   * Clear all strokes
   */
  clear(): void {
    this._strokes = [];
    this._invalidateInternals();
  }

  /**
   * Check if signature is empty
   */
  isEmpty(): boolean {
    return this._strokes.length === 0;
  }

  /**
   * Get number of strokes
   */
  get strokeCount(): number {
    return this._strokes.length;
  }

  /**
   * Create a deep copy of this signature
   */
  clone(): Signature {
    const copy = new Signature({
      simplifyEpsilon: this._epsilon,
      canvasWidth: this._canvasWidth,
      canvasHeight: this._canvasHeight,
    });
    copy._strokes = this._strokes.map((s) =>
      s.map((p) => ({ x: p.x, y: p.y })),
    );
    return copy;
  }

  /**
   * Create a Signature from pre-processed strokes in normalized coordinates.
   *
   * ADVANCED: This bypasses simplification and coordinate scaling. Use only when
   * you have strokes that are already in the internal 512×256 coordinate space
   * (e.g., from another Signature's getInternals().getNormalizedStrokes() or
   * from deserializing and re-serializing).
   *
   * For typical use cases, prefer the constructor with pushStroke() or deserialize().
   *
   * @param strokes - Strokes in 512×256 space
   * @param options - Signature options (canvasWidth, canvasHeight, etc.)
   */
  static fromNormalizedStrokes(
    strokes: readonly Stroke[],
    options: SignatureOptions = {},
  ): Signature {
    const sig = new Signature(options);
    sig._strokes = strokes.map((s) =>
      s.map((p) => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
      })),
    );
    return sig;
  }

  /**
   * Serialize signature to bytes
   */
  serialize(): Uint8Array {
    // Encode strokes to version-specific payload (V1 handles its own compression)
    const { payload } = encodeV1Payload(this._strokes);

    // Build envelope: MAGIC + VERSION + LEN + PAYLOAD + CRC
    // The envelope doesn't know about compression - that's V1's business
    const packet = new Uint8Array(4 + payload.length + 1);
    packet[0] = MAGIC;
    packet[1] = VERSION_1;
    packet[2] = (payload.length >> 8) & 0xff;
    packet[3] = payload.length & 0xff;
    packet.set(payload, 4);

    // Compute and append CRC (covers MAGIC through end of payload)
    const crc = computeCRC8(packet, 0, 4 + payload.length);
    packet[4 + payload.length] = crc;

    return packet;
  }

  /**
   * Serialize signature to encoded string
   * @param encoding - Output encoding (Z85, BASE64, or BASE64URL)
   */
  serializeToString(encoding: EncodingType): string {
    const packet = this.serialize();

    switch (encoding) {
      case Encoding.Z85:
        return z85Encode(packet);
      case Encoding.BASE64:
        return base64Encode(packet, false);
      case Encoding.BASE64URL:
        return base64Encode(packet, true);
      default:
        throw new Error(`Unknown encoding: ${encoding}`);
    }
  }

  /**
   * Deserialize signature from bytes
   * @param data - Serialized signature bytes
   * @param options - Signature options (canvasWidth, canvasHeight, etc.)
   */
  static deserialize(
    data: Uint8Array,
    options: SignatureOptions = {},
  ): Signature {
    if (!(data instanceof Uint8Array)) {
      throw new SignatureDeserializationError(
        "Data must be Uint8Array; use deserializeFromString for encoded strings",
        DeserializationErrorCode.INVALID_ENCODING,
      );
    }

    const bytes = data;

    // Validate header
    if (bytes.length < 5) {
      throw new SignatureDeserializationError(
        `Data too short: ${bytes.length} bytes (minimum 5)`,
        DeserializationErrorCode.TRUNCATED_DATA,
        bytes.length,
      );
    }

    if (bytes[0] !== MAGIC) {
      throw new SignatureDeserializationError(
        `Invalid magic byte: 0x${bytes[0].toString(16)} (expected 0x${MAGIC.toString(16)})`,
        DeserializationErrorCode.INVALID_MAGIC,
        0,
      );
    }

    const version = bytes[1];
    if (version !== VERSION_1) {
      throw new SignatureDeserializationError(
        `Unsupported version: ${version}`,
        DeserializationErrorCode.INVALID_VERSION,
        1,
      );
    }

    const payloadLen = (bytes[2] << 8) | bytes[3];
    const expectedLen = 4 + payloadLen + 1;

    if (bytes.length < expectedLen) {
      throw new SignatureDeserializationError(
        `Truncated data: expected ${expectedLen} bytes, got ${bytes.length}`,
        DeserializationErrorCode.TRUNCATED_DATA,
        bytes.length,
      );
    }

    // Verify CRC
    const expectedCRC = bytes[4 + payloadLen];
    const actualCRC = computeCRC8(bytes, 0, 4 + payloadLen);
    if (expectedCRC !== actualCRC) {
      throw new SignatureDeserializationError(
        `CRC mismatch: expected 0x${expectedCRC.toString(16)}, got 0x${actualCRC.toString(16)}`,
        DeserializationErrorCode.CRC_MISMATCH,
        4 + payloadLen,
      );
    }

    // Extract payload and decode using version-specific decoder
    // The envelope doesn't know about compression - that's V1's business
    const payload = bytes.subarray(4, 4 + payloadLen);
    const strokes = decodeV1Payload(payload);

    // Create signature
    const sig = new Signature(options);
    sig._strokes = strokes;

    return sig;
  }

  /**
   * Deserialize signature from encoded string
   * @param data - Encoded signature string
   * @param encoding - Input encoding (Z85, BASE64, or BASE64URL)
   * @param options - Signature options (canvasWidth, canvasHeight, etc.)
   */
  static deserializeFromString(
    data: string,
    encoding: EncodingType,
    options: SignatureOptions = {},
  ): Signature {
    if (typeof data !== "string") {
      throw new SignatureDeserializationError(
        "Data must be string; use deserialize for Uint8Array",
        DeserializationErrorCode.INVALID_ENCODING,
      );
    }

    let bytes: Uint8Array;
    switch (encoding) {
      case Encoding.Z85:
        bytes = z85Decode(data);
        break;
      case Encoding.BASE64:
      case Encoding.BASE64URL:
        bytes = base64Decode(data);
        break;
      default:
        throw new SignatureDeserializationError(
          `Unknown encoding: ${encoding}`,
          DeserializationErrorCode.INVALID_ENCODING,
        );
    }

    return Signature.deserialize(bytes, options);
  }

  /**
   * Render signature to specified format
   * @param format - Output format (default: SVG)
   * @param options - Render options
   */
  render(format: FormatType = Format.SVG, options: RenderOptions = {}): string {
    switch (format) {
      case Format.SVG:
        return renderSVG(this._strokes, options);
      default:
        throw new Error(`Unknown format: ${format}`);
    }
  }

  /**
   * Get version-specific internals for analysis
   */
  getInternals(): SignatureV1Internals {
    this._internals ??= new SignatureV1Internals(this._strokes);
    return this._internals;
  }

  /**
   * Invalidate cached internals
   */
  private _invalidateInternals(): void {
    if (this._internals) {
      this._internals._invalidate();
    }
    this._internals = null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

// Re-export VERSION_1 as VERSION for public API
export const VERSION: number = VERSION_1;
