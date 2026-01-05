# Autopen

[![npm version](https://img.shields.io/npm/v/autopen.svg)](https://www.npmjs.com/package/autopen)
[![CI](https://github.com/schlarpc/autopen/actions/workflows/ci.yml/badge.svg)](https://github.com/schlarpc/autopen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A compact signature serialization library for capturing, encoding, and rendering hand-drawn signatures.

**[Live Demo](https://schlarpc.github.io/autopen/)**

## Features

- **Compact encoding**: Typical signatures serialize to 100-200 bytes
- **Multiple text encodings**: Z85 (compact), Base64, Base64URL (URL-safe)
- **Vectorization**: Raw input points are simplified to efficient vector strokes
- **SVG rendering**: Generate clean SVG output with spline interpolation and content fitting
- **No dependencies**: Pure TypeScript, works in browsers and Node.js
- **Forward-compatible**: Versioned binary format with CRC-8 error detection

## Installation

```bash
npm install autopen
```

Or use directly from a CDN:

```html
<script type="module">
  import { Signature, Encoding, Format } from "https://esm.sh/autopen";
</script>
```

## Quick Start

```javascript
import { Signature, Encoding, Format } from "autopen";

// Create a signature and add strokes
const sig = new Signature({
  canvasWidth: 400, // Your canvas dimensions
  canvasHeight: 200,
});

// Add strokes (arrays of {x, y} points from your drawing canvas)
sig.pushStroke([
  { x: 50, y: 100 },
  { x: 100, y: 80 },
  { x: 150, y: 120 },
  // ... more points
]);

// Serialize to different formats
const bytes = sig.serialize(); // Uint8Array
const z85 = sig.serializeToString(Encoding.Z85); // Compact text
const b64url = sig.serializeToString(Encoding.BASE64URL); // URL-safe

// Deserialize
const fromBytes = Signature.deserialize(bytes);
const fromZ85 = Signature.deserializeFromString(z85, Encoding.Z85);

// Render to SVG
const svg = fromZ85.render(Format.SVG, {
  width: 512,
  height: 256,
  strokeColor: "#000000",
  strokeWidth: 2,
});
```

## API Reference

### `new Signature(options)`

Create a new signature object.

| Option            | Type   | Default | Description                                                                                 |
| ----------------- | ------ | ------- | ------------------------------------------------------------------------------------------- |
| `simplifyEpsilon` | number | 2       | Tolerance for Ramer-Douglas-Peucker simplification. Higher = fewer points = smaller output. |
| `canvasWidth`     | number | 512     | Your input canvas width for coordinate scaling.                                             |
| `canvasHeight`    | number | 256     | Your input canvas height for coordinate scaling.                                            |

### Instance Methods

#### `pushStroke(points)`

Add a stroke to the signature. Points should be `{x, y}` objects in your canvas coordinate space.

```javascript
sig.pushStroke([
  { x: 10, y: 20 },
  { x: 15, y: 25 },
  { x: 20, y: 22 },
]);
```

The stroke is automatically simplified using the Ramer-Douglas-Peucker algorithm to reduce point count while preserving shape.

#### `popStroke()`

Remove and return the last stroke (in your canvas coordinates). Returns `null` if empty. Useful for implementing undo.

```javascript
const removed = sig.popStroke();
```

#### `getStrokes()`

Get all strokes (simplified, in your canvas coordinates).

```javascript
const strokes = sig.getStrokes();
for (const stroke of strokes) {
  console.log("Stroke:", stroke.length, "points");
}
```

#### `clear()`

Remove all strokes.

#### `isEmpty()`

Returns `true` if the signature has no strokes.

#### `strokeCount`

Property returning the number of strokes.

#### `clone()`

Create a deep copy of the signature.

#### `serialize()`

Serialize the signature to binary.

```javascript
const bytes = sig.serialize(); // Returns Uint8Array
```

#### `serializeToString(encoding)`

Serialize the signature to an encoded string.

```javascript
const z85 = sig.serializeToString(Encoding.Z85); // Compact
const b64 = sig.serializeToString(Encoding.BASE64); // Standard base64
const b64url = sig.serializeToString(Encoding.BASE64URL); // URL-safe
```

#### `render(format, options)`

Render the signature to the specified format.

```javascript
const svg = sig.render(Format.SVG, {
  width: 512, // Output width (default: 512)
  height: 256, // Output height (default: 256)
  strokeWidth: 2, // Line width in pixels (default: 2)
  strokeColor: "#000", // Stroke color (default: '#000000')
  spline: true, // Use Catmull-Rom spline interpolation (default: true)
  splineTension: 0.5, // Spline tension 0-1 (default: 0.5)
  backgroundColor: null, // Background color, null for transparent (default: null)
  contentFit: true, // Fit to content bounds instead of full canvas (default: true)
  contentPadding: 0.05, // Padding as fraction of output dims when contentFit=true (default: 0.05)
});
```

**Content Fitting**: When `contentFit` is `true`, the SVG scales to fit the actual signature bounds (plus padding) rather than the full internal canvas. This eliminates whitespace around signatures that don't fill the canvas. Set `contentFit: false` to always use the full internal canvas bounds.

#### `getInternals()`

Access version-specific internals for analysis/debugging.

```javascript
const internals = sig.getInternals();

// Get normalized strokes (in 512x256 internal space)
const normalized = internals.getNormalizedStrokes();

// Get raw delta-encoded payload bytes (before compression)
const payload = internals.getPayloadBytes();

// Get encoding statistics
const stats = internals.getEncodeStats();
// { deltas, absolutes, strokeMarkers, overflowDxOnly, overflowDyOnly, overflowBoth }

// Get delta frequency distributions
const { dx, dy, joint } = internals.getDeltaFrequencies();

// Get byte frequency distribution
const byteFreq = internals.getByteFrequencies();

// Get the arithmetic coder (for analysis)
const coder = internals.getArithmeticCoder();
```

### Static Methods

#### `Signature.deserialize(data, options)`

Deserialize a signature from binary data.

```javascript
const sig = Signature.deserialize(uint8Array, {
  canvasWidth: 400,
  canvasHeight: 200,
});
```

#### `Signature.deserializeFromString(data, encoding, options)`

Deserialize a signature from an encoded string.

```javascript
const sig = Signature.deserializeFromString(z85String, Encoding.Z85, {
  canvasWidth: 400,
  canvasHeight: 200,
});
```

#### `Signature.fromNormalizedStrokes(strokes, options)`

**Advanced**: Create a Signature from strokes already in the internal 512x256 coordinate space. Bypasses simplification and coordinate scaling.

```javascript
const sig = Signature.fromNormalizedStrokes(normalizedStrokes, {
  canvasWidth: 400,
  canvasHeight: 200,
});
```

### Enums

#### `Encoding`

```javascript
Encoding.Z85; // Z85 encoding (25% overhead, not URL-safe)
Encoding.BASE64; // Standard base64 (33% overhead)
Encoding.BASE64URL; // URL-safe base64 (33% overhead)
```

#### `Format`

```javascript
Format.SVG; // SVG string output
```

## Exports

### Stable API (safe for production use)

| Export      | Description                                            |
| ----------- | ------------------------------------------------------ |
| `Signature` | Main signature class                                   |
| `Encoding`  | Encoding enum (`BINARY`, `Z85`, `BASE64`, `BASE64URL`) |
| `Format`    | Output format enum (`SVG`)                             |

### TypeScript Types

| Export             | Description                                 |
| ------------------ | ------------------------------------------- |
| `Point`            | Interface for 2D point (`{x, y}`)           |
| `Stroke`           | Type alias for `Point[]`                    |
| `SignatureOptions` | Options for `new Signature()`               |
| `RenderOptions`    | Options for `render()`                      |
| `EncodeStats`      | Encoding statistics from `getEncodeStats()` |
| `DeltaFrequencies` | Delta frequency data for analysis           |
| `EncodingType`     | Union type for `Encoding` values            |
| `FormatType`       | Union type for `Format` values              |

### Advanced/Analysis (may change in minor versions)

| Export                   | Description                                    |
| ------------------------ | ---------------------------------------------- |
| `SignatureV1Internals`   | V1 internals class for analysis (**unstable**) |
| `V1_CANVAS_WIDTH`        | V1 internal width (512)                        |
| `V1_CANVAS_HEIGHT`       | V1 internal height (256)                       |
| `DEFAULT_EPSILON`        | Default simplification tolerance (2)           |
| `DEFAULT_SPLINE_TENSION` | Default spline tension (0.5)                   |
| `MAX_TOTAL_POINTS`       | Maximum points allowed (100,000)               |
| `VERSION`                | Current format version (1)                     |
| `MAGIC`                  | Magic byte (0x53 = 'S')                        |

### Utilities (may change in minor versions)

| Export                          | Description                                        |
| ------------------------------- | -------------------------------------------------- |
| `simplifyPolyline`              | Ramer-Douglas-Peucker simplification               |
| `computeCRC8`                   | CRC-8-CCITT checksum                               |
| `z85Encode` / `z85Decode`       | Z85 encoding (note: decode expects Autopen format) |
| `base64Encode` / `base64Decode` | Base64 encoding                                    |

## Format Specification

### Stability Guarantees

The binary format is designed for long-term storage:

- **Envelope structure is frozen**: Magic byte, version byte, length field, and CRC-8 positions will never change
- **V1 payloads will always be decodable**: Future library versions will continue to decode V1 data
- **CRC-8 ensures integrity**: Corrupted data is detected and rejected

### Envelope (version-independent)

```
+-------+---------+-----+---------+-----+
| MAGIC | VERSION | LEN | PAYLOAD | CRC |
| 1B    | 1B      | 2B  | var     | 1B  |
+-------+---------+-----+---------+-----+
```

| Field   | Size     | Description                                                       |
| ------- | -------- | ----------------------------------------------------------------- |
| MAGIC   | 1 byte   | `0x53` ('S') - Identifies Autopen format                          |
| VERSION | 1 byte   | Payload format version                                            |
| LEN     | 2 bytes  | Big-endian uint16, length of PAYLOAD (max 65535)                  |
| PAYLOAD | variable | Version-specific opaque bytes                                     |
| CRC     | 1 byte   | CRC-8-CCITT (polynomial 0x07) over bytes 0 through end of PAYLOAD |

### V1 Payload Structure

```
+----------+------------+
| ORIG_LEN | COMPRESSED |
| 2B       | var        |
+----------+------------+
```

| Field      | Size     | Description                                          |
| ---------- | -------- | ---------------------------------------------------- |
| ORIG_LEN   | 2 bytes  | Big-endian uint16, length of uncompressed delta data |
| COMPRESSED | variable | Arithmetic-coded delta data                          |

### V1 Delta Encoding

Coordinates are stored in a 512x256 internal space (9-bit X, 8-bit Y).

**2-byte delta** (most common, covers ~98% of points):

- Byte 0: `dx + 125` (range 0x00-0xFB, dx in [-125, +126])
- Byte 1: `dy + 127` (range 0x00-0xFF, dy in [-127, +128])

**3-byte commands** (control bytes 0xFC-0xFF):

| Byte | Command   | Description                 |
| ---- | --------- | --------------------------- |
| 0xFC | STROKE_LO | New stroke, X < 256         |
| 0xFD | STROKE_HI | New stroke, X >= 256        |
| 0xFE | ABS_LO    | Absolute position, X < 256  |
| 0xFF | ABS_HI    | Absolute position, X >= 256 |

For 3-byte commands: byte 1 = X & 0xFF, byte 2 = Y.

### V1 Arithmetic Coding

Delta data is compressed using arithmetic coding with a static Laplacian probability model optimized for signature data. Typical compression: 20-40%.

### Text Encodings

| Encoding  | Overhead | URL-Safe | Use Case               |
| --------- | -------- | -------- | ---------------------- |
| Z85       | 25%      | No       | Database storage, APIs |
| Base64    | 33%      | No       | General interchange    |
| Base64URL | 33%      | Yes      | URLs, query parameters |

## Coordinate Scaling

Signatures are internally stored in a 512x256 coordinate space. The `canvasWidth` and `canvasHeight` options control automatic scaling using "contain" fit (uniform scale, preserving aspect ratio, centered).

```javascript
// Your 400x200 canvas maps to the internal 512x256 space
const sig = new Signature({ canvasWidth: 400, canvasHeight: 200 });

// pushStroke() converts your coordinates to internal space
sig.pushStroke([{ x: 200, y: 100 }]); // Center of your canvas

// getStrokes() converts back to your coordinates
const strokes = sig.getStrokes(); // Points in 400x200 space

// When deserializing, specify your canvas dimensions to get correct scaling
const restored = Signature.deserializeFromString(z85, Encoding.Z85, {
  canvasWidth: 400,
  canvasHeight: 200,
});
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test           # Watch mode
npm run test:run   # Single run

# Development mode (watch)
npm run dev
```

## Demo

The demo page is available at [schlarpc.github.io/autopen](https://schlarpc.github.io/autopen/).

To run locally:

```bash
npm run demo          # Start dev server with hot reload
npm run demo:build    # Build for production
npm run demo:preview  # Preview production build
```

## Error Handling

The library throws descriptive errors for various failure conditions:

### Deserialization Errors

```javascript
try {
  const sig = Signature.deserialize(data);
} catch (e) {
  // Possible errors:
  // - "Data must be Uint8Array; use deserializeFromString for encoded strings"
  // - "Data too short: X bytes (minimum 5)"
  // - "Invalid magic byte: 0xXX (expected 0x53)"
  // - "Unsupported version: X"
  // - "Truncated data: expected X bytes, got Y"
  // - "CRC mismatch: expected 0xXX, got 0xYY"
}
```

### String Decoding Errors

```javascript
try {
  const sig = Signature.deserializeFromString(encoded, Encoding.Z85);
} catch (e) {
  // Possible errors:
  // - "Invalid Z85 string: length X is not a multiple of 5"
  // - "Invalid Z85 string: unexpected character 'X' at position Y"
  // - "Invalid base64 string: length X after padding removal is 1 mod 4"
  // - "Invalid base64 string: unexpected character 'X' at position Y"
}
```

### Input Validation Errors

```javascript
try {
  const sig = new Signature({ canvasWidth: 0 });
} catch (e) {
  // "Canvas dimensions must be positive (got 0×256)"
}

try {
  // Adding too many points (> 100,000 total)
  sig.pushStroke(hugeArrayOfPoints);
} catch (e) {
  // "Cannot add stroke: would exceed maximum of 100000 total points"
}
```

**Note:** Invalid coordinates (NaN, Infinity) are silently filtered out rather than throwing errors, allowing partial recovery from corrupted input data.

## Runtime Requirements

**Node.js:** Requires Node.js 18 or later (ES2022 features).

**Browsers:** Requires ES module support. Compatible with all evergreen browsers:

- Chrome/Edge 61+
- Firefox 60+
- Safari 11+
- Mobile Safari/Chrome (iOS 11+, Android Chrome 61+)

No transpilation or polyfills needed.

## License

MIT
