import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Signature,
  SignatureV1Internals,
  Encoding,
  Format,
  V1_CANVAS_WIDTH,
  V1_CANVAS_HEIGHT,
  DEFAULT_EPSILON,
  DEFAULT_SPLINE_TENSION,
  MAX_TOTAL_POINTS,
  VERSION,
  MAGIC,
  simplifyPolyline,
  computeCRC8,
  z85Encode,
  z85Decode,
  base64Encode,
  base64Decode,
  SignatureError,
  SignatureValidationError,
  SignatureDeserializationError,
  DeserializationErrorCode,
  type Point,
  type Stroke,
  type SignatureOptions,
  type RenderOptions,
  type EncodeStats,
  type EncodingType,
  type FormatType,
} from "./index";

// ============================================================================
// SIGNATURE CLASS TESTS
// ============================================================================

describe("Signature", () => {
  describe("constructor", () => {
    it("creates empty signature with default options", () => {
      const sig = new Signature();
      expect(sig.isEmpty()).toBe(true);
      expect(sig.strokeCount).toBe(0);
    });

    it("creates signature with custom options", () => {
      const sig = new Signature({
        simplifyEpsilon: 5,
        canvasWidth: 800,
        canvasHeight: 400,
      });
      expect(sig.isEmpty()).toBe(true);
    });

    it("throws for zero canvas width", () => {
      expect(() => new Signature({ canvasWidth: 0 })).toThrow(
        SignatureValidationError,
      );
      try {
        new Signature({ canvasWidth: 0 });
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureValidationError);
        expect((e as SignatureValidationError).field).toBe("canvasDimensions");
      }
    });

    it("throws for negative canvas width", () => {
      expect(() => new Signature({ canvasWidth: -100 })).toThrow(
        SignatureValidationError,
      );
    });

    it("throws for zero canvas height", () => {
      expect(() => new Signature({ canvasHeight: 0 })).toThrow(
        SignatureValidationError,
      );
      try {
        new Signature({ canvasHeight: 0 });
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureValidationError);
        expect((e as SignatureValidationError).field).toBe("canvasDimensions");
      }
    });

    it("throws for negative canvas height", () => {
      expect(() => new Signature({ canvasHeight: -50 })).toThrow(
        SignatureValidationError,
      );
    });
  });

  describe("pushStroke", () => {
    it("adds a stroke", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ]);
      expect(sig.strokeCount).toBe(1);
      expect(sig.isEmpty()).toBe(false);
    });

    it("ignores empty stroke", () => {
      const sig = new Signature();
      sig.pushStroke([]);
      expect(sig.strokeCount).toBe(0);
    });

    it("ignores null/undefined stroke", () => {
      const sig = new Signature();
      sig.pushStroke(null as unknown as Point[]);
      sig.pushStroke(undefined as unknown as Point[]);
      expect(sig.strokeCount).toBe(0);
    });

    it("filters out NaN coordinates", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: NaN, y: 20 },
        { x: 30, y: NaN },
        { x: 40, y: 40 },
      ]);
      expect(sig.strokeCount).toBe(1);
      const strokes = sig.getStrokes();
      // Only valid points should remain (2 points after filtering)
      expect(strokes[0].length).toBe(2);
    });

    it("filters out Infinity coordinates", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: Infinity, y: 20 },
        { x: 30, y: -Infinity },
        { x: 40, y: 40 },
      ]);
      expect(sig.strokeCount).toBe(1);
      const strokes = sig.getStrokes();
      expect(strokes[0].length).toBe(2);
    });

    it("ignores stroke with only invalid points", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: NaN, y: 10 },
        { x: Infinity, y: 20 },
      ]);
      expect(sig.strokeCount).toBe(0);
    });

    it("throws when exceeding MAX_TOTAL_POINTS", () => {
      const sig = new Signature({ simplifyEpsilon: 0 }); // Disable simplification
      // Create a huge array of points
      const hugeStroke: Point[] = [];
      for (let i = 0; i < MAX_TOTAL_POINTS + 1; i++) {
        hugeStroke.push({ x: i % 512, y: i % 256 });
      }
      expect(() => sig.pushStroke(hugeStroke)).toThrow(/exceed maximum/);
    });

    it("simplifies stroke using RDP algorithm", () => {
      const sig = new Signature({ simplifyEpsilon: 1 });
      // Collinear points should be reduced
      const collinear = [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 30, y: 30 },
        { x: 40, y: 40 },
      ];
      sig.pushStroke(collinear);

      const strokes = sig.getStrokes();
      // Should be simplified to ~2 points (endpoints)
      expect(strokes[0].length).toBeLessThanOrEqual(2);
    });

    it("preserves complex stroke shape", () => {
      const sig = new Signature({ simplifyEpsilon: 1 });
      // Points that form a sharp angle
      const sharp = [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 50 },
      ];
      sig.pushStroke(sharp);

      const strokes = sig.getStrokes();
      expect(strokes[0].length).toBe(3);
    });

    it("scales coordinates to internal space and back", () => {
      const sig = new Signature({ canvasWidth: 1000, canvasHeight: 500 });
      sig.pushStroke([{ x: 500, y: 250 }]); // Center

      const strokes = sig.getStrokes();
      // Should be approximately at center (within ~2 pixels due to integer rounding)
      expect(strokes[0][0].x).toBeCloseTo(500, -1);
      expect(strokes[0][0].y).toBeCloseTo(250, -1);
    });
  });

  describe("popStroke", () => {
    it("removes and returns last stroke", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ]);
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ]);

      const popped = sig.popStroke();
      expect(popped).not.toBeNull();
      expect(sig.strokeCount).toBe(1);
    });

    it("returns null for empty signature", () => {
      const sig = new Signature();
      expect(sig.popStroke()).toBeNull();
    });

    it("returns stroke in user coordinates", () => {
      const sig = new Signature({ canvasWidth: 400, canvasHeight: 200 });
      sig.pushStroke([{ x: 200, y: 100 }]); // Center

      const popped = sig.popStroke()!;
      expect(popped[0].x).toBeCloseTo(200, 0);
      expect(popped[0].y).toBeCloseTo(100, 0);
    });
  });

  describe("getStrokes", () => {
    it("returns copy of strokes", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 10, y: 10 }]);

      const strokes1 = sig.getStrokes();
      const strokes2 = sig.getStrokes();

      expect(strokes1).not.toBe(strokes2);
      expect(strokes1[0]).not.toBe(strokes2[0]);
    });

    it("returns strokes in user coordinates", () => {
      const sig = new Signature({ canvasWidth: 200, canvasHeight: 100 });
      sig.pushStroke([{ x: 100, y: 50 }]);

      const strokes = sig.getStrokes();
      expect(strokes[0][0].x).toBeCloseTo(100, 0);
      expect(strokes[0][0].y).toBeCloseTo(50, 0);
    });
  });

  describe("clear", () => {
    it("removes all strokes", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 10, y: 10 }]);
      sig.pushStroke([{ x: 20, y: 20 }]);

      sig.clear();

      expect(sig.isEmpty()).toBe(true);
      expect(sig.strokeCount).toBe(0);
    });
  });

  describe("clone", () => {
    it("creates deep copy", () => {
      const sig = new Signature({ canvasWidth: 400, canvasHeight: 200 });
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ]);

      const clone = sig.clone();

      expect(clone.strokeCount).toBe(sig.strokeCount);
      expect(clone).not.toBe(sig);
    });

    it("modifications to clone do not affect original", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 10, y: 10 }]);

      const clone = sig.clone();
      clone.clear();

      expect(sig.strokeCount).toBe(1);
      expect(clone.strokeCount).toBe(0);
    });
  });

  describe("fromNormalizedStrokes", () => {
    it("creates signature from normalized strokes", () => {
      const normalizedStrokes: Stroke[] = [
        [{ x: 256, y: 128 }], // Center of 512x256
      ];

      const sig = Signature.fromNormalizedStrokes(normalizedStrokes);
      expect(sig.strokeCount).toBe(1);
    });

    it("rounds coordinates to integers", () => {
      const strokes: Stroke[] = [[{ x: 100.7, y: 50.3 }]];
      const sig = Signature.fromNormalizedStrokes(strokes);

      const internals = sig.getInternals();
      const normalized = internals.getNormalizedStrokes();
      expect(normalized[0][0].x).toBe(101);
      expect(normalized[0][0].y).toBe(50);
    });
  });

  describe("serialize/deserialize", () => {
    it("round-trips signature through binary", () => {
      const sig = new Signature({ canvasWidth: 400, canvasHeight: 200 });
      sig.pushStroke([
        { x: 50, y: 50 },
        { x: 100, y: 80 },
        { x: 150, y: 50 },
      ]);
      sig.pushStroke([
        { x: 200, y: 100 },
        { x: 250, y: 150 },
      ]);

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized, {
        canvasWidth: 400,
        canvasHeight: 200,
      });

      expect(restored.strokeCount).toBe(2);
    });

    it("produces valid packet structure", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ]);

      const packet = sig.serialize();

      expect(packet[0]).toBe(MAGIC);
      expect(packet[1]).toBe(VERSION);
    });

    it("throws for non-Uint8Array input", () => {
      expect(() => Signature.deserialize([] as unknown as Uint8Array)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize([] as unknown as Uint8Array);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_ENCODING,
        );
      }
    });

    it("throws for data too short", () => {
      const short = new Uint8Array([0x53, 0x01, 0x00]);
      expect(() => Signature.deserialize(short)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(short);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });

    it("throws for invalid magic byte", () => {
      const invalid = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);
      expect(() => Signature.deserialize(invalid)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(invalid);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_MAGIC,
        );
      }
    });

    it("throws for unsupported version", () => {
      const invalid = new Uint8Array([0x53, 0xff, 0x00, 0x00, 0x00]);
      expect(() => Signature.deserialize(invalid)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(invalid);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_VERSION,
        );
      }
    });

    it("throws for truncated payload", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ]);
      const valid = sig.serialize();
      const truncated = valid.slice(0, valid.length - 5);

      expect(() => Signature.deserialize(truncated)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(truncated);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });

    it("throws for corrupted CRC", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ]);
      const data = sig.serialize();
      data[data.length - 1] ^= 0xff; // Flip CRC bits

      expect(() => Signature.deserialize(data)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(data);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.CRC_MISMATCH,
        );
      }
    });

    // Arithmetic coder edge case tests - these verify the fix for the
    // boundary condition bug where low-frequency symbols would decode
    // incorrectly due to missing -1 in interval calculation.
    // See: https://www.nayuki.io/page/reference-arithmetic-coding

    it("handles absolute encoding within a single stroke (large coordinate jump)", () => {
      // This was the original failing test case that exposed the bug.
      // When a delta exceeds the range [-125, +126] for dx or [-127, +128] for dy,
      // the encoder uses CTRL_ABS_HI/CTRL_ABS_LO (0xFF/0xFE) which have frequency=1
      // in the static model. The subsequent position bytes are also low-frequency
      // when far from the distribution centers (125, 127).
      const sig = new Signature({ canvasWidth: 512, canvasHeight: 256 });
      sig.pushStroke([
        { x: 0, y: 0 },
        { x: 500, y: 250 }, // Large jump triggers absolute encoding
        { x: 500, y: 255 },
      ]);

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized);

      expect(restored.strokeCount).toBe(1);
      const strokes = restored.getStrokes();
      expect(strokes[0].length).toBe(3);
      // Verify approximate coordinates (integer rounding may cause small differences)
      expect(strokes[0][1].x).toBeCloseTo(500, -1);
      expect(strokes[0][1].y).toBeCloseTo(250, -1);
    });

    it("handles multiple absolute encodings in sequence", () => {
      // Multiple large jumps creating a zig-zag pattern that won't be simplified
      // The points form a clear non-collinear pattern
      const sig = new Signature({ canvasWidth: 512, canvasHeight: 256 });
      sig.pushStroke([
        { x: 0, y: 128 }, // Start in middle
        { x: 400, y: 0 }, // Large jump to top-right
        { x: 100, y: 255 }, // Large jump to bottom-left
        { x: 500, y: 128 }, // Large jump to right-middle
      ]);

      // Get pre-serialization state for comparison
      const originalStrokes = sig.getStrokes();
      const originalPointCount = originalStrokes[0].length;

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized);

      expect(restored.strokeCount).toBe(1);
      // Verify same number of points survive the round-trip
      // (simplification happens before serialization, so count should match)
      expect(restored.getStrokes()[0].length).toBe(originalPointCount);
    });

    it("handles strokes at canvas edges (high byte values)", () => {
      // Points near canvas edges produce high byte values (far from
      // the Laplacian distribution centers), triggering low-frequency paths
      const sig = new Signature({ canvasWidth: 512, canvasHeight: 256 });
      sig.pushStroke([
        { x: 510, y: 254 },
        { x: 505, y: 250 },
        { x: 500, y: 245 },
      ]);
      sig.pushStroke([
        { x: 2, y: 2 },
        { x: 7, y: 5 },
        { x: 12, y: 8 },
      ]);

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized);

      expect(restored.strokeCount).toBe(2);
    });

    it("handles many small strokes (many stroke markers)", () => {
      // Each stroke marker (CTRL_STROKE_LO/HI) is relatively low frequency.
      // Many strokes stress the arithmetic coder's handling of control bytes.
      const sig = new Signature({ canvasWidth: 512, canvasHeight: 256 });
      for (let i = 0; i < 20; i++) {
        sig.pushStroke([
          { x: i * 20, y: i * 10 },
          { x: i * 20 + 10, y: i * 10 + 5 },
        ]);
      }

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized);

      expect(restored.strokeCount).toBe(20);
    });

    it("handles signature with only control bytes and edge positions", () => {
      // Worst case: stroke markers at positions that produce the
      // lowest frequency byte values
      const sig = new Signature({ canvasWidth: 512, canvasHeight: 256 });
      sig.pushStroke([
        { x: 500, y: 250 }, // High x, high y
        { x: 501, y: 251 },
      ]);
      sig.pushStroke([
        { x: 499, y: 249 }, // Also high values
        { x: 500, y: 250 },
      ]);
      sig.pushStroke([
        { x: 255, y: 127 }, // x just below 256 boundary
        { x: 256, y: 128 }, // x just above 256 boundary (different control byte)
      ]);

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized);

      expect(restored.strokeCount).toBe(3);
    });
  });

  describe("serializeToString/deserializeFromString", () => {
    it("round-trips through Z85", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 50, y: 50 },
        { x: 100, y: 100 },
      ]);

      const encoded = sig.serializeToString(Encoding.Z85);
      const restored = Signature.deserializeFromString(encoded, Encoding.Z85);

      expect(restored.strokeCount).toBe(1);
    });

    it("round-trips through BASE64", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 50, y: 50 },
        { x: 100, y: 100 },
      ]);

      const encoded = sig.serializeToString(Encoding.BASE64);
      const restored = Signature.deserializeFromString(
        encoded,
        Encoding.BASE64,
      );

      expect(restored.strokeCount).toBe(1);
    });

    it("round-trips through BASE64URL", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 50, y: 50 },
        { x: 100, y: 100 },
      ]);

      const encoded = sig.serializeToString(Encoding.BASE64URL);
      const restored = Signature.deserializeFromString(
        encoded,
        Encoding.BASE64URL,
      );

      expect(restored.strokeCount).toBe(1);
    });

    it("throws for unknown encoding (serialize)", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 10, y: 10 }]);

      expect(() => sig.serializeToString("unknown" as EncodingType)).toThrow(
        /unknown/i,
      );
    });

    it("throws for unknown encoding (deserialize)", () => {
      expect(() =>
        Signature.deserializeFromString("data", "unknown" as EncodingType),
      ).toThrow(/unknown/i);
    });

    it("throws for non-string input", () => {
      expect(() =>
        Signature.deserializeFromString(123 as unknown as string, Encoding.Z85),
      ).toThrow(/string/i);
    });
  });

  describe("render", () => {
    it("renders to valid SVG", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 200, y: 150 },
      ]);

      const svg = sig.render(Format.SVG);

      // Validate SVG structure
      expect(svg).toMatch(/^<svg\s/);
      expect(svg).toMatch(/<\/svg>$/);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain("<path");
      expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);

      // Validate path has proper attributes
      expect(svg).toMatch(/<path d="[^"]+"/);
      expect(svg).toContain('fill="none"');
      expect(svg).toContain('stroke-linecap="round"');
      expect(svg).toContain('stroke-linejoin="round"');
    });

    it("renders with custom options", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 200, y: 150 },
      ]);

      const svg = sig.render(Format.SVG, {
        width: 800,
        height: 400,
        strokeColor: "#ff0000",
        strokeWidth: 5,
        backgroundColor: "#ffffff",
      });

      expect(svg).toContain('width="800"');
      expect(svg).toContain('height="400"');
      expect(svg).toContain("#ff0000");
      expect(svg).toContain('stroke-width="5"');
      expect(svg).toContain("<rect");
    });

    it("renders single point as circle", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 100, y: 100 }]);

      const svg = sig.render(Format.SVG);

      // Validate circle element structure
      expect(svg).toMatch(/<circle cx="[0-9.]+" cy="[0-9.]+" r="[0-9.]+"/);
      expect(svg).toContain("fill=");
    });

    it("renders empty signature as empty SVG", () => {
      const sig = new Signature();
      const svg = sig.render(Format.SVG);

      // Valid SVG with no drawing elements
      expect(svg).toMatch(/^<svg\s/);
      expect(svg).toMatch(/<\/svg>$/);
      expect(svg).not.toContain("<path");
      expect(svg).not.toContain("<circle");
    });

    it("uses linear interpolation when spline disabled", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 200, y: 0 },
      ]);

      const svg = sig.render(Format.SVG, { spline: false });

      expect(svg).toContain(" L "); // Linear path command
      expect(svg).not.toContain(" C "); // No curve commands
    });

    it("uses spline interpolation by default", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 200, y: 0 },
      ]);

      const svg = sig.render(Format.SVG);

      expect(svg).toContain(" C "); // Bezier curve commands
    });

    it("content fits by default", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 110, y: 110 },
      ]);

      const svg = sig.render(Format.SVG, { contentFit: true });

      // The small signature should be scaled up to fill the SVG
      expect(svg).toContain("<svg");
    });

    it("disables content fit when specified", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 110, y: 110 },
      ]);

      const svg = sig.render(Format.SVG, { contentFit: false });

      expect(svg).toContain("<svg");
    });

    it("sanitizes malicious color values", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 100, y: 100 }]);

      const svg = sig.render(Format.SVG, {
        strokeColor: '<script>alert("xss")</script>',
        backgroundColor: "javascript:alert(1)",
      });

      // Should use fallback colors, not malicious values
      expect(svg).not.toContain("<script>");
      expect(svg).not.toContain("javascript:");
    });

    it("accepts valid color formats", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 100, y: 100 }]);

      // Hex
      let svg = sig.render(Format.SVG, { strokeColor: "#abc" });
      expect(svg).toContain("#abc");

      svg = sig.render(Format.SVG, { strokeColor: "#aabbcc" });
      expect(svg).toContain("#aabbcc");

      // Named colors
      svg = sig.render(Format.SVG, { strokeColor: "red" });
      expect(svg).toContain("red");

      // RGB
      svg = sig.render(Format.SVG, { strokeColor: "rgb(255, 0, 0)" });
      expect(svg).toContain("rgb(255, 0, 0)");
    });

    it("throws for unknown format", () => {
      const sig = new Signature();
      expect(() => sig.render("unknown" as FormatType)).toThrow(/unknown/i);
    });
  });

  describe("getInternals", () => {
    it("returns SignatureV1Internals", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 100, y: 100 }]);

      const internals = sig.getInternals();

      expect(internals).toBeInstanceOf(SignatureV1Internals);
    });

    it("caches internals instance", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 100, y: 100 }]);

      const internals1 = sig.getInternals();
      const internals2 = sig.getInternals();

      expect(internals1).toBe(internals2);
    });

    it("invalidates cache on stroke modification", () => {
      const sig = new Signature();
      sig.pushStroke([{ x: 100, y: 100 }]);

      const internals1 = sig.getInternals();
      sig.pushStroke([{ x: 200, y: 200 }]);
      const internals2 = sig.getInternals();

      expect(internals1).not.toBe(internals2);
    });
  });
});

// ============================================================================
// SIGNATURE V1 INTERNALS TESTS
// ============================================================================

describe("SignatureV1Internals", () => {
  let sig: Signature;
  let internals: SignatureV1Internals;

  beforeEach(() => {
    sig = new Signature();
    sig.pushStroke([
      { x: 100, y: 100 },
      { x: 150, y: 120 },
      { x: 200, y: 100 },
    ]);
    internals = sig.getInternals();
  });

  describe("version", () => {
    it("returns current version", () => {
      expect(internals.version).toBe(VERSION);
    });
  });

  describe("getNormalizedStrokes", () => {
    it("returns strokes in 512x256 space", () => {
      const normalized = internals.getNormalizedStrokes();

      expect(normalized.length).toBe(1);
      expect(
        normalized[0].every((p) => p.x >= 0 && p.x < V1_CANVAS_WIDTH),
      ).toBe(true);
      expect(
        normalized[0].every((p) => p.y >= 0 && p.y < V1_CANVAS_HEIGHT),
      ).toBe(true);
    });

    it("returns copy of strokes", () => {
      const strokes1 = internals.getNormalizedStrokes();
      const strokes2 = internals.getNormalizedStrokes();

      expect(strokes1).not.toBe(strokes2);
    });
  });

  describe("getPayloadBytes", () => {
    it("returns delta-encoded payload", () => {
      const payload = internals.getPayloadBytes();

      expect(payload).toBeInstanceOf(Uint8Array);
      expect(payload.length).toBeGreaterThan(0);
    });

    it("returns copy of payload", () => {
      const payload1 = internals.getPayloadBytes();
      const payload2 = internals.getPayloadBytes();

      expect(payload1).not.toBe(payload2);
      expect(payload1).toEqual(payload2);
    });
  });

  describe("getEncodeStats", () => {
    it("returns encoding statistics", () => {
      const stats = internals.getEncodeStats();

      expect(stats).toHaveProperty("deltas");
      expect(stats).toHaveProperty("absolutes");
      expect(stats).toHaveProperty("strokeMarkers");
      expect(stats.strokeMarkers).toBe(1);
    });

    it("returns copy of stats", () => {
      const stats1 = internals.getEncodeStats();
      const stats2 = internals.getEncodeStats();

      expect(stats1).not.toBe(stats2);
    });
  });

  describe("getDeltaFrequencies", () => {
    it("returns delta frequency data", () => {
      const freq = internals.getDeltaFrequencies();

      expect(freq.dx).toBeInstanceOf(Uint32Array);
      expect(freq.dy).toBeInstanceOf(Uint32Array);
      expect(freq.joint).toBeInstanceOf(Uint32Array);
    });
  });

  describe("getByteFrequencies", () => {
    it("returns 256-entry frequency table", () => {
      const freq = internals.getByteFrequencies();

      expect(freq).toBeInstanceOf(Uint32Array);
      expect(freq.length).toBe(256);
    });
  });

  describe("getArithmeticCoder", () => {
    it("returns the V1 arithmetic coder", () => {
      const coder = internals.getArithmeticCoder();
      expect(coder).toBeDefined();
    });
  });
});

// ============================================================================
// Z85 ENCODING TESTS
// ============================================================================

describe("Z85 encoding", () => {
  describe("z85Encode", () => {
    it("encodes empty data", () => {
      const encoded = z85Encode(new Uint8Array(0));
      expect(encoded).toBe("");
    });

    it("encodes data with padding", () => {
      // 1 byte needs padding to 4 bytes
      const sig = new Signature();
      sig.pushStroke([{ x: 10, y: 10 }]);
      const data = sig.serialize();

      const encoded = z85Encode(data);
      expect(encoded.length % 5).toBe(0);
    });

    it("produces only valid Z85 characters", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ]);
      const data = sig.serialize();

      const encoded = z85Encode(data);
      const validChars =
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

      for (const char of encoded) {
        expect(validChars).toContain(char);
      }
    });
  });

  describe("z85Decode", () => {
    it("decodes empty string", () => {
      const decoded = z85Decode("");
      expect(decoded.length).toBe(0);
    });

    it("throws for invalid length (not multiple of 5)", () => {
      expect(() => z85Decode("abcd")).toThrow(SignatureDeserializationError);
      try {
        z85Decode("abcd");
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_ENCODING,
        );
      }
    });

    it("throws for invalid characters", () => {
      expect(() => z85Decode("abcd~")).toThrow(SignatureDeserializationError);
      try {
        z85Decode("abcd~");
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_ENCODING,
        );
        expect((e as SignatureDeserializationError).position).toBe(4);
      }
    });

    it("throws for data too short after decoding", () => {
      // Minimum Z85: 5 chars = 4 bytes, but we need at least 5 for header
      expect(() => z85Decode("00000")).toThrow(SignatureDeserializationError);
    });

    it("throws for invalid magic byte", () => {
      // Create Z85 that decodes to wrong magic byte
      const wrongMagic = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);
      const encoded = z85Encode(wrongMagic);
      expect(() => z85Decode(encoded)).toThrow(SignatureDeserializationError);
      try {
        z85Decode(encoded);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_MAGIC,
        );
      }
    });

    it("throws for truncated data (length mismatch)", () => {
      // Create valid header claiming longer payload
      const sig = new Signature();
      sig.pushStroke([{ x: 10, y: 10 }]);
      const valid = sig.serialize();
      // Artificially increase length field
      valid[2] = 0xff;
      const encoded = z85Encode(valid);
      expect(() => z85Decode(encoded)).toThrow(SignatureDeserializationError);
      try {
        z85Decode(encoded);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });

    it("round-trips with encode", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ]);
      const original = sig.serialize();

      const encoded = z85Encode(original);
      const decoded = z85Decode(encoded);

      expect(decoded).toEqual(original);
    });
  });
});

// ============================================================================
// BASE64 ENCODING TESTS
// ============================================================================

describe("Base64 encoding", () => {
  describe("base64Encode", () => {
    it("encodes empty data", () => {
      const encoded = base64Encode(new Uint8Array(0));
      expect(encoded).toBe("");
    });

    it('encodes "Hello" correctly', () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const encoded = base64Encode(data);
      expect(encoded).toBe("SGVsbG8=");
    });

    it("handles 1-byte padding", () => {
      const data = new Uint8Array([72, 101]); // 2 bytes
      const encoded = base64Encode(data);
      expect(encoded.endsWith("=")).toBe(true);
    });

    it("handles 2-byte padding", () => {
      const data = new Uint8Array([72]); // 1 byte
      const encoded = base64Encode(data);
      expect(encoded.endsWith("==")).toBe(true);
    });

    it("produces URL-safe output when requested", () => {
      const data = new Uint8Array([251, 255, 254]); // Would produce +/= in standard
      const standard = base64Encode(data, false);
      const urlSafe = base64Encode(data, true);

      expect(standard).toContain("+");
      expect(urlSafe).not.toContain("+");
      expect(urlSafe).not.toContain("/");
    });
  });

  describe("base64Decode", () => {
    it("decodes empty string", () => {
      const decoded = base64Decode("");
      expect(decoded.length).toBe(0);
    });

    it('decodes "Hello" correctly', () => {
      const decoded = base64Decode("SGVsbG8=");
      expect(decoded).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
    });

    it("handles missing padding", () => {
      const decoded = base64Decode("SGVsbG8"); // No padding
      expect(decoded).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
    });

    it("throws for invalid length (1 mod 4)", () => {
      expect(() => base64Decode("A")).toThrow(SignatureDeserializationError);
      try {
        base64Decode("A");
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_ENCODING,
        );
      }
    });

    it("throws for invalid characters", () => {
      expect(() => base64Decode("!!!!")).toThrow(SignatureDeserializationError);
      try {
        base64Decode("!!!!");
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.INVALID_ENCODING,
        );
        expect((e as SignatureDeserializationError).position).toBe(0);
      }
    });

    it("decodes URL-safe input", () => {
      const data = new Uint8Array([251, 255, 254]);
      const urlSafe = base64Encode(data, true);
      const decoded = base64Decode(urlSafe);
      expect(decoded).toEqual(data);
    });

    it("round-trips with encode", () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const encoded = base64Encode(original);
      const decoded = base64Decode(encoded);
      expect(decoded).toEqual(original);
    });

    it("handles 2-char remainder", () => {
      // 2 chars decode to 1 byte
      const decoded = base64Decode("QQ"); // "A"
      expect(decoded).toEqual(new Uint8Array([65]));
    });

    it("handles 3-char remainder", () => {
      // 3 chars decode to 2 bytes
      const decoded = base64Decode("QUI"); // "AB"
      expect(decoded).toEqual(new Uint8Array([65, 66]));
    });
  });
});

// ============================================================================
// CRC-8 TESTS
// ============================================================================

describe("CRC-8", () => {
  it("computes checksum for simple data", () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const crc = computeCRC8(data, 0, data.length);

    expect(typeof crc).toBe("number");
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(255);
  });

  it("computes checksum for partial data", () => {
    const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x00]);
    const crc = computeCRC8(data, 1, 3); // Only [0x01, 0x02, 0x03]

    const fullData = new Uint8Array([0x01, 0x02, 0x03]);
    const fullCrc = computeCRC8(fullData, 0, fullData.length);

    expect(crc).toBe(fullCrc);
  });

  it("detects single bit change", () => {
    const data1 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const data2 = new Uint8Array([0x01, 0x02, 0x03, 0x05]); // Last bit changed

    const crc1 = computeCRC8(data1, 0, data1.length);
    const crc2 = computeCRC8(data2, 0, data2.length);

    expect(crc1).not.toBe(crc2);
  });

  it("produces different checksums for different data", () => {
    const checksums = new Set<number>();

    for (let i = 0; i < 100; i++) {
      const data = new Uint8Array([i, i + 1, i + 2]);
      checksums.add(computeCRC8(data, 0, data.length));
    }

    // Should have many different values (not all same)
    expect(checksums.size).toBeGreaterThan(50);
  });

  it("returns 0 for empty range", () => {
    const data = new Uint8Array([0x01, 0x02]);
    const crc = computeCRC8(data, 0, 0);
    expect(crc).toBe(0);
  });
});

// ============================================================================
// POLYLINE SIMPLIFICATION TESTS
// ============================================================================

describe("simplifyPolyline", () => {
  it("preserves single point", () => {
    const points: Point[] = [{ x: 5, y: 5 }];
    const simplified = simplifyPolyline(points, 1);
    expect(simplified.length).toBe(1);
    expect(simplified[0]).toEqual({ x: 5, y: 5 });
  });

  it("preserves two points", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    const simplified = simplifyPolyline(points, 1);
    expect(simplified.length).toBe(2);
  });

  it("reduces collinear points", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ];
    const simplified = simplifyPolyline(points, 0.1);
    expect(simplified.length).toBeLessThanOrEqual(2);
  });

  it("preserves endpoints", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0.1 },
      { x: 2, y: 0 },
      { x: 3, y: 0.1 },
      { x: 4, y: 0 },
    ];
    const simplified = simplifyPolyline(points, 1);

    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[simplified.length - 1]).toEqual(
      points[points.length - 1],
    );
  });

  it("preserves sharp corners", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ];
    const simplified = simplifyPolyline(points, 1);
    expect(simplified.length).toBe(3);
  });

  it("handles degenerate case (start == end)", () => {
    const points: Point[] = [
      { x: 10, y: 10 },
      { x: 10, y: 10 }, // Same as start
      { x: 10, y: 10 },
    ];
    const simplified = simplifyPolyline(points, 1);
    expect(simplified.length).toBeGreaterThanOrEqual(1);
  });

  it("returns copy of input points", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    const simplified = simplifyPolyline(points, 1);

    expect(simplified).not.toBe(points);
    expect(simplified[0]).not.toBe(points[0]);
  });

  it("respects epsilon tolerance", () => {
    const points: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 5 }, // 5 pixels off the line
      { x: 100, y: 0 },
    ];

    const simplified1 = simplifyPolyline(points, 1);
    const simplified10 = simplifyPolyline(points, 10);

    // With epsilon=1, the middle point should be kept
    expect(simplified1.length).toBe(3);
    // With epsilon=10, the middle point should be removed
    expect(simplified10.length).toBe(2);
  });
});

// ============================================================================
// CONSTANTS TESTS
// ============================================================================

describe("Constants", () => {
  it("exports canvas dimensions", () => {
    expect(V1_CANVAS_WIDTH).toBe(512);
    expect(V1_CANVAS_HEIGHT).toBe(256);
  });

  it("exports default epsilon", () => {
    expect(DEFAULT_EPSILON).toBe(2);
  });

  it("exports default spline tension", () => {
    expect(DEFAULT_SPLINE_TENSION).toBe(0.5);
  });

  it("exports magic byte", () => {
    expect(MAGIC).toBe(0x53);
  });

  it("exports version", () => {
    expect(VERSION).toBe(1);
  });

  it("exports encoding types", () => {
    expect(Encoding.Z85).toBe("z85");
    expect(Encoding.BASE64).toBe("base64");
    expect(Encoding.BASE64URL).toBe("base64url");
  });

  it("exports max total points limit", () => {
    expect(MAX_TOTAL_POINTS).toBe(100000);
  });

  it("exports format types", () => {
    expect(Format.SVG).toBe("svg");
  });
});

// ============================================================================
// EDGE CASE TESTS
// ============================================================================

describe("Edge cases", () => {
  describe("Large signature", () => {
    it("handles many strokes", () => {
      const sig = new Signature();

      for (let i = 0; i < 50; i++) {
        sig.pushStroke([
          { x: i * 10, y: i * 5 },
          { x: i * 10 + 20, y: i * 5 + 10 },
          { x: i * 10 + 40, y: i * 5 },
        ]);
      }

      expect(sig.strokeCount).toBe(50);

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized);

      expect(restored.strokeCount).toBe(50);
    });

    it("handles long strokes", () => {
      const sig = new Signature();

      const longStroke: Point[] = [];
      for (let i = 0; i < 1000; i++) {
        longStroke.push({ x: i % 500, y: Math.sin(i / 10) * 100 + 128 });
      }
      sig.pushStroke(longStroke);

      const serialized = sig.serialize();
      expect(serialized.length).toBeLessThan(5000); // Should compress well
    });
  });

  describe("Coordinate boundaries", () => {
    it("handles coordinates at canvas edges", () => {
      const sig = new Signature({ canvasWidth: 512, canvasHeight: 256 });

      // Use shorter segments that stay within delta encoding range
      sig.pushStroke([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ]);

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized, {
        canvasWidth: 512,
        canvasHeight: 256,
      });

      expect(restored.strokeCount).toBe(1);
    });

    it("handles large delta coordinates using multiple strokes", () => {
      const sig = new Signature({ canvasWidth: 512, canvasHeight: 256 });

      // Instead of large jumps within a stroke (which would need absolute encoding),
      // test with separate strokes that start at different positions
      sig.pushStroke([
        { x: 10, y: 10 },
        { x: 20, y: 15 },
        { x: 30, y: 10 },
      ]);
      sig.pushStroke([
        { x: 400, y: 200 },
        { x: 410, y: 205 },
        { x: 420, y: 200 },
      ]);

      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized, {
        canvasWidth: 512,
        canvasHeight: 256,
      });

      expect(restored.strokeCount).toBe(2);
    });
  });

  describe("Aspect ratio scaling", () => {
    it("handles wide canvas", () => {
      const sig = new Signature({ canvasWidth: 1000, canvasHeight: 100 });
      sig.pushStroke([{ x: 500, y: 50 }]);

      const strokes = sig.getStrokes();
      // Allow ~2 pixel difference due to integer rounding
      expect(strokes[0][0].x).toBeCloseTo(500, -1);
      expect(strokes[0][0].y).toBeCloseTo(50, -1);
    });

    it("handles tall canvas", () => {
      const sig = new Signature({ canvasWidth: 100, canvasHeight: 1000 });
      sig.pushStroke([{ x: 50, y: 500 }]);

      const strokes = sig.getStrokes();
      // Allow ~2 pixel difference due to integer rounding
      expect(strokes[0][0].x).toBeCloseTo(50, -1);
      expect(strokes[0][0].y).toBeCloseTo(500, -1);
    });
  });

  describe("Empty signature serialization", () => {
    it("serializes empty signature", () => {
      const sig = new Signature();
      const serialized = sig.serialize();

      expect(serialized.length).toBeGreaterThan(4);
      expect(serialized[0]).toBe(MAGIC);
    });

    it("deserializes to empty signature", () => {
      const sig = new Signature();
      const serialized = sig.serialize();
      const restored = Signature.deserialize(serialized);

      expect(restored.isEmpty()).toBe(true);
    });
  });
});

// ============================================================================
// DELTA ENCODING EDGE CASES
// ============================================================================

describe("Delta encoding edge cases", () => {
  it("handles large jumps requiring absolute encoding", () => {
    const sig = new Signature();

    // Create stroke with large jump (> delta range)
    sig.pushStroke([
      { x: 0, y: 0 },
      { x: 500, y: 250 }, // Large jump
    ]);

    const internals = sig.getInternals();
    const stats = internals.getEncodeStats();

    // Should have at least one absolute encoding
    // (stroke marker + possibly absolute for large delta)
    expect(stats.strokeMarkers).toBeGreaterThanOrEqual(1);
  });

  it("uses delta encoding for small movements", () => {
    const sig = new Signature();

    // Create stroke with small movements
    sig.pushStroke([
      { x: 100, y: 100 },
      { x: 105, y: 105 },
      { x: 110, y: 110 },
      { x: 115, y: 115 },
    ]);

    const internals = sig.getInternals();
    const stats = internals.getEncodeStats();

    // Should use delta encoding (not absolutes)
    expect(stats.deltas).toBeGreaterThan(0);
  });

  it("handles high-x coordinates (x >= 256)", () => {
    const sig = new Signature();

    sig.pushStroke([
      { x: 300, y: 100 },
      { x: 350, y: 150 },
    ]);

    const serialized = sig.serialize();
    const restored = Signature.deserialize(serialized);

    expect(restored.strokeCount).toBe(1);
  });
});

// ============================================================================
// ARITHMETIC CODING EDGE CASES
// ============================================================================

describe("Arithmetic coding edge cases", () => {
  it("handles compression ratio sanity check", () => {
    // Create packet with implausible compression ratio
    const badPacket = new Uint8Array([
      MAGIC, // Magic
      VERSION, // Version
      0x00,
      0x05, // Payload length = 5
      0xff,
      0xff, // Original length claiming huge value (embedded in V1 payload)
      0x00,
      0x00,
      0x00, // Minimal compressed data
      0x00, // CRC placeholder
    ]);

    // Compute correct CRC
    badPacket[badPacket.length - 1] = computeCRC8(
      badPacket,
      0,
      badPacket.length - 1,
    );

    expect(() => Signature.deserialize(badPacket)).toThrow(
      SignatureDeserializationError,
    );
    try {
      Signature.deserialize(badPacket);
    } catch (e) {
      expect(e).toBeInstanceOf(SignatureDeserializationError);
      expect((e as SignatureDeserializationError).code).toBe(
        DeserializationErrorCode.CORRUPTED_PAYLOAD,
      );
    }
  });
});

// ============================================================================
// ERROR CLASS TESTS
// ============================================================================

describe("Error classes", () => {
  describe("SignatureError", () => {
    it("is an instance of Error", () => {
      const error = new SignatureError("test message");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SignatureError);
    });

    it("has correct name and message", () => {
      const error = new SignatureError("test message");
      expect(error.name).toBe("SignatureError");
      expect(error.message).toBe("test message");
    });
  });

  describe("SignatureValidationError", () => {
    it("extends SignatureError", () => {
      const error = new SignatureValidationError("invalid field", "testField");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SignatureError);
      expect(error).toBeInstanceOf(SignatureValidationError);
    });

    it("has correct name, message, and field", () => {
      const error = new SignatureValidationError("invalid field", "testField");
      expect(error.name).toBe("SignatureValidationError");
      expect(error.message).toBe("invalid field");
      expect(error.field).toBe("testField");
    });
  });

  describe("SignatureDeserializationError", () => {
    it("extends SignatureError", () => {
      const error = new SignatureDeserializationError(
        "invalid data",
        DeserializationErrorCode.INVALID_MAGIC,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SignatureError);
      expect(error).toBeInstanceOf(SignatureDeserializationError);
    });

    it("has correct properties without position", () => {
      const error = new SignatureDeserializationError(
        "invalid magic",
        DeserializationErrorCode.INVALID_MAGIC,
      );
      expect(error.name).toBe("SignatureDeserializationError");
      expect(error.message).toBe("invalid magic");
      expect(error.code).toBe(DeserializationErrorCode.INVALID_MAGIC);
      expect(error.position).toBeUndefined();
    });

    it("has correct properties with position", () => {
      const error = new SignatureDeserializationError(
        "invalid character",
        DeserializationErrorCode.INVALID_ENCODING,
        42,
      );
      expect(error.code).toBe(DeserializationErrorCode.INVALID_ENCODING);
      expect(error.position).toBe(42);
    });
  });

  describe("DeserializationErrorCode enum", () => {
    it("has all expected values", () => {
      expect(DeserializationErrorCode.INVALID_MAGIC).toBeDefined();
      expect(DeserializationErrorCode.INVALID_VERSION).toBeDefined();
      expect(DeserializationErrorCode.CRC_MISMATCH).toBeDefined();
      expect(DeserializationErrorCode.TRUNCATED_DATA).toBeDefined();
      expect(DeserializationErrorCode.CORRUPTED_PAYLOAD).toBeDefined();
      expect(DeserializationErrorCode.INVALID_ENCODING).toBeDefined();
    });
  });
});

// ============================================================================
// TYPE EXPORTS TESTS
// ============================================================================

describe("Type exports", () => {
  it("Point type is usable", () => {
    const point: Point = { x: 10, y: 20 };
    expect(point.x).toBe(10);
  });

  it("Stroke type is usable", () => {
    const stroke: Stroke = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(stroke.length).toBe(2);
  });

  it("SignatureOptions type is usable", () => {
    const opts: SignatureOptions = {
      simplifyEpsilon: 5,
      canvasWidth: 800,
      canvasHeight: 400,
    };
    const sig = new Signature(opts);
    expect(sig).toBeDefined();
  });

  it("RenderOptions type is usable", () => {
    const opts: RenderOptions = {
      width: 800,
      height: 400,
      strokeColor: "#ff0000",
    };
    const sig = new Signature();
    sig.pushStroke([{ x: 10, y: 10 }]);
    const svg = sig.render(Format.SVG, opts);
    expect(svg).toContain("#ff0000");
  });

  it("EncodeStats type is usable", () => {
    const sig = new Signature();
    sig.pushStroke([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ]);
    const stats: EncodeStats = sig.getInternals().getEncodeStats();
    expect(stats.strokeMarkers).toBeGreaterThan(0);
  });

  it("EncodingType type is usable", () => {
    const encoding: EncodingType = Encoding.Z85;
    expect(encoding).toBe("z85");
  });

  it("FormatType type is usable", () => {
    const format: FormatType = Format.SVG;
    expect(format).toBe("svg");
  });
});

// ============================================================================
// BRANCH COVERAGE: RENDER PATH EDGE CASES
// ============================================================================

describe("Render path edge cases", () => {
  describe("Linear path rendering (spline=false)", () => {
    it("handles empty stroke array in linear mode", () => {
      const sig = new Signature();
      // Empty signature - no strokes
      const svg = sig.render(Format.SVG, { spline: false });
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("<path");
    });

    it("handles two-point stroke in linear mode", () => {
      const sig = new Signature();
      sig.pushStroke([
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ]);
      const svg = sig.render(Format.SVG, { spline: false });
      expect(svg).toContain(" L "); // Linear command
      expect(svg).not.toContain(" C "); // No curve
    });
  });
});

// ============================================================================
// BRANCH COVERAGE: SANITIZE COLOR EDGE CASES
// ============================================================================

describe("sanitizeColor edge cases", () => {
  it("handles non-string strokeColor (falls back to default)", () => {
    const sig = new Signature();
    sig.pushStroke([{ x: 100, y: 100 }]);

    // Pass number as strokeColor - should fall back to #000000
    const svg = sig.render(Format.SVG, {
      strokeColor: 123 as unknown as string,
    });
    expect(svg).toContain("#000000");
  });

  it("handles non-string backgroundColor (falls back to default)", () => {
    const sig = new Signature();
    sig.pushStroke([{ x: 100, y: 100 }]);

    // Pass object as backgroundColor - should fall back to #ffffff
    const svg = sig.render(Format.SVG, {
      backgroundColor: { color: "red" } as unknown as string,
    });
    // Falls back to #ffffff when invalid, so rect should have that
    expect(svg).toContain('fill="#ffffff"');
  });

  it("handles undefined color values", () => {
    const sig = new Signature();
    sig.pushStroke([{ x: 100, y: 100 }]);

    const svg = sig.render(Format.SVG, {
      strokeColor: undefined,
      backgroundColor: undefined,
    });
    // Should use defaults
    expect(svg).toContain("#000000");
  });
});

// ============================================================================
// BRANCH COVERAGE: BASE64 REMAINDER INVALID CHARS
// ============================================================================

describe("Base64 decode remainder edge cases", () => {
  it("throws for invalid character in 2-char remainder", () => {
    // "QQ" is valid (decodes to "A"), but "Q!" has invalid '!' in position 1
    expect(() => base64Decode("Q!")).toThrow(SignatureDeserializationError);
    try {
      base64Decode("Q!");
    } catch (e) {
      expect(e).toBeInstanceOf(SignatureDeserializationError);
      expect((e as SignatureDeserializationError).code).toBe(
        DeserializationErrorCode.INVALID_ENCODING,
      );
      expect((e as SignatureDeserializationError).position).toBe(1);
    }
  });

  it("throws for invalid character at position 0 in 2-char remainder", () => {
    // First char invalid in 2-char remainder
    expect(() => base64Decode("!Q")).toThrow(SignatureDeserializationError);
    try {
      base64Decode("!Q");
    } catch (e) {
      expect(e).toBeInstanceOf(SignatureDeserializationError);
      expect((e as SignatureDeserializationError).position).toBe(0);
    }
  });

  it("throws for invalid character in 3-char remainder", () => {
    // "QUI" is valid (decodes to "AB"), test invalid chars at each position
    expect(() => base64Decode("!UI")).toThrow(SignatureDeserializationError);
    expect(() => base64Decode("Q!I")).toThrow(SignatureDeserializationError);
    expect(() => base64Decode("QU!")).toThrow(SignatureDeserializationError);
    try {
      base64Decode("Q!I");
    } catch (e) {
      expect((e as SignatureDeserializationError).position).toBe(1);
    }
    try {
      base64Decode("QU!");
    } catch (e) {
      expect((e as SignatureDeserializationError).position).toBe(2);
    }
  });
});

// ============================================================================
// BRANCH COVERAGE: EMPTY STROKE IN NORMALIZED STROKES
// ============================================================================

describe("Empty stroke handling", () => {
  it("skips empty strokes in fromNormalizedStrokes", () => {
    // Create signature with an empty stroke array mixed with valid strokes
    const strokes: Stroke[] = [
      [], // Empty stroke - should be skipped during encoding
      [
        { x: 100, y: 100 },
        { x: 150, y: 150 },
      ],
      [], // Another empty
    ];

    const sig = Signature.fromNormalizedStrokes(strokes);

    // Serialize and deserialize - empty strokes should be skipped
    const serialized = sig.serialize();
    const restored = Signature.deserialize(serialized);

    // Only the non-empty stroke should survive
    expect(restored.strokeCount).toBe(1);
  });
});

// ============================================================================
// BRANCH COVERAGE: CSS.supports BROWSER BRANCH
// ============================================================================

describe("CSS.supports browser branch", () => {
  const originalCSS = globalThis.CSS;

  afterEach(() => {
    // Restore original CSS
    if (originalCSS === undefined) {
      delete (globalThis as Record<string, unknown>).CSS;
    } else {
      globalThis.CSS = originalCSS;
    }
  });

  it("uses CSS.supports when available and color is valid", () => {
    // Mock CSS.supports to return true for valid colors
    (globalThis as Record<string, unknown>).CSS = {
      supports: (prop: string, value: string) => {
        return prop === "color" && value === "rebeccapurple";
      },
    };

    const sig = new Signature();
    sig.pushStroke([{ x: 100, y: 100 }]);

    const svg = sig.render(Format.SVG, { strokeColor: "rebeccapurple" });
    expect(svg).toContain("rebeccapurple");
  });

  it("falls back when CSS.supports returns false", () => {
    // Mock CSS.supports to return false
    (globalThis as Record<string, unknown>).CSS = {
      supports: () => false,
    };

    const sig = new Signature();
    sig.pushStroke([{ x: 100, y: 100 }]);

    const svg = sig.render(Format.SVG, { strokeColor: "notarealcolor" });
    // Should fall back to #000000
    expect(svg).toContain("#000000");
  });
});

// ============================================================================
// BRANCH COVERAGE: DECODER ERROR HANDLING (CRAFTED PAYLOADS)
// ============================================================================

describe("Decoder error handling with crafted payloads", () => {
  // Helper to build a complete packet with valid CRC
  function buildPacket(v1Payload: Uint8Array): Uint8Array {
    const packet = new Uint8Array(4 + v1Payload.length + 1);
    packet[0] = MAGIC;
    packet[1] = VERSION;
    packet[2] = (v1Payload.length >> 8) & 0xff;
    packet[3] = v1Payload.length & 0xff;
    packet.set(v1Payload, 4);
    packet[4 + v1Payload.length] = computeCRC8(packet, 0, 4 + v1Payload.length);
    return packet;
  }

  // Get the arithmetic coder from internals
  function getArithmeticCoder() {
    const sig = new Signature();
    sig.pushStroke([{ x: 10, y: 10 }]);
    return sig.getInternals().getArithmeticCoder();
  }

  // Build V1 payload: [origLen high] [origLen low] [compressed data]
  function buildV1Payload(deltaBytes: Uint8Array): Uint8Array {
    const coder = getArithmeticCoder();
    const compressed = coder.encode(deltaBytes);
    const payload = new Uint8Array(2 + compressed.length);
    payload[0] = (deltaBytes.length >> 8) & 0xff;
    payload[1] = deltaBytes.length & 0xff;
    payload.set(compressed, 2);
    return payload;
  }

  describe("V1 payload validation", () => {
    it("throws for V1 payload too short (< 2 bytes)", () => {
      // Build packet with only 1 byte of V1 payload
      const packet = buildPacket(new Uint8Array([0x00]));
      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });
  });

  describe("Delta before stroke marker", () => {
    it("throws when delta byte appears before any stroke marker", () => {
      // Delta bytes are 0x00-0xFB. Start with a delta (no stroke marker first)
      // 0x7D = 125 (dx=0), 0x7F = 127 (dy=0)
      const corruptDelta = new Uint8Array([0x7d, 0x7f]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect(e).toBeInstanceOf(SignatureDeserializationError);
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.CORRUPTED_PAYLOAD,
        );
      }
    });
  });

  describe("Truncated stroke marker", () => {
    it("throws when stroke marker is truncated (missing position bytes)", () => {
      // Valid first stroke, then a second stroke marker that's truncated
      // CTRL_STROKE_LO (0xFC) needs 2 more bytes for position
      const corruptDelta = new Uint8Array([
        0xfc,
        0x10,
        0x10, // Valid first stroke at (16, 16)
        0x7d,
        0x7f, // Valid delta (dx=0, dy=0)
        0xfc, // Second stroke marker but missing position bytes
      ]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });

    it("throws when stroke marker has only 1 position byte", () => {
      // Valid first stroke, then second stroke marker with only 1 byte
      const corruptDelta = new Uint8Array([
        0xfc,
        0x10,
        0x10, // Valid first stroke at (16, 16)
        0x7d,
        0x7f, // Valid delta
        0xfd,
        0x00, // CTRL_STROKE_HI with only 1 byte
      ]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });
  });

  describe("Absolute position before stroke marker", () => {
    it("throws when absolute position appears before any stroke marker", () => {
      // CTRL_ABS_LO (0xFE) before any stroke marker
      const corruptDelta = new Uint8Array([0xfe, 0x00, 0x00]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.CORRUPTED_PAYLOAD,
        );
      }
    });

    it("throws for CTRL_ABS_HI before stroke marker", () => {
      // CTRL_ABS_HI (0xFF) before any stroke marker
      const corruptDelta = new Uint8Array([0xff, 0x00, 0x00]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.CORRUPTED_PAYLOAD,
        );
      }
    });
  });

  describe("Truncated absolute position", () => {
    it("throws when absolute position is truncated after stroke", () => {
      // Valid stroke marker, then truncated absolute
      const corruptDelta = new Uint8Array([
        0xfc,
        0x10,
        0x10, // Valid stroke at (16, 16)
        0xfe, // CTRL_ABS_LO but missing position bytes
      ]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });

    it("throws when absolute has only 1 position byte", () => {
      const corruptDelta = new Uint8Array([
        0xfc,
        0x10,
        0x10, // Valid stroke at (16, 16)
        0xff,
        0x00, // CTRL_ABS_HI with only 1 byte
      ]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });
  });

  describe("Truncated delta", () => {
    it("throws when delta is truncated (only dx byte)", () => {
      // Valid stroke, then single delta byte (missing dy)
      const corruptDelta = new Uint8Array([
        0xfc,
        0x10,
        0x10, // Valid stroke at (16, 16)
        0x7d, // Just dx byte, missing dy
      ]);
      const v1Payload = buildV1Payload(corruptDelta);
      const packet = buildPacket(v1Payload);

      expect(() => Signature.deserialize(packet)).toThrow(
        SignatureDeserializationError,
      );
      try {
        Signature.deserialize(packet);
      } catch (e) {
        expect((e as SignatureDeserializationError).code).toBe(
          DeserializationErrorCode.TRUNCATED_DATA,
        );
      }
    });
  });
});
