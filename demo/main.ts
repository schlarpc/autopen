import {
  Signature,
  Encoding,
  Format,
  type Point,
  type Stroke,
  type RenderOptions,
} from "autopen";

// ============================================
// CONSTANTS
// ============================================
const SPLINE_TENSION = 0.5;
const INTERPOLATION_DISTANCE = 3; // Interpolate points if distance > this

// ============================================
// DOM ELEMENTS
// ============================================
const statusAnnouncer = document.getElementById("statusAnnouncer")!;
const inputCanvasEl = document.getElementById(
  "inputCanvas",
) as HTMLCanvasElement;
const outputCanvasEl = document.getElementById(
  "outputCanvas",
) as HTMLCanvasElement;
const clearBtn = document.getElementById("clearBtn")!;
const undoBtn = document.getElementById("undoBtn")!;
const loadSampleBtn = document.getElementById("loadSampleBtn")!;
const loadZ85Btn = document.getElementById("loadZ85Btn")!;
const copyBtn = document.getElementById("copyBtn")!;
const copySvgBtn = document.getElementById("copySvgBtn")!;
const svgWidthInput = document.getElementById("svgWidth") as HTMLInputElement;
const svgHeightInput = document.getElementById("svgHeight") as HTMLInputElement;
const svgStrokeWidthInput = document.getElementById(
  "svgStrokeWidth",
) as HTMLInputElement;
const svgStrokeWidthValue = document.getElementById("svgStrokeWidthValue")!;
const svgStrokeColorInput = document.getElementById(
  "svgStrokeColor",
) as HTMLInputElement;
const svgTensionInput = document.getElementById(
  "svgTension",
) as HTMLInputElement;
const svgTensionValue = document.getElementById("svgTensionValue")!;
const svgBgColorInput = document.getElementById(
  "svgBgColor",
) as HTMLInputElement;
const svgSplineInput = document.getElementById("svgSpline") as HTMLInputElement;
const svgUseBgInput = document.getElementById("svgUseBg") as HTMLInputElement;
const svgContentFitInput = document.getElementById(
  "svgContentFit",
) as HTMLInputElement;
const svgContentPaddingInput = document.getElementById(
  "svgContentPadding",
) as HTMLInputElement;
const svgContentPaddingValue = document.getElementById(
  "svgContentPaddingValue",
)!;
const svgContainer = document.getElementById("svgContainer")!;
const rawSizeEl = document.getElementById("rawSize")!;
const rawDetailEl = document.getElementById("rawDetail")!;
const arithSizeEl = document.getElementById("arithSize")!;
const arithDetailEl = document.getElementById("arithDetail")!;
const deltaBreakdownEl = document.getElementById("deltaBreakdown")!;
const encodedOutputEl = document.getElementById("encodedOutput")!;

// ============================================
// ACCESSIBILITY HELPERS
// ============================================
function announce(message: string): void {
  statusAnnouncer.textContent = message;
  // Reset after a delay so repeated identical messages are announced
  setTimeout(() => {
    statusAnnouncer.textContent = "";
  }, 1000);
}

// ============================================
// INTERPOLATION (for smooth input)
// ============================================
function interpolatePoints(p1: Point, p2: Point, maxDist: number): Point[] {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= maxDist) return [p2];

  const steps = Math.ceil(dist / maxDist);
  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: p1.x + dx * t,
      y: p1.y + dy * t,
    });
  }
  return points;
}

// ============================================
// DRAWING (for rendering on output canvas)
// ============================================
function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawSpline(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  t: number = SPLINE_TENSION,
): void {
  if (pts.length === 0) return;
  if (pts.length === 1) {
    drawDot(ctx, pts[0].x, pts[0].y);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
    return;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[Math.min(pts.length - 1, i + 2)];
    ctx.bezierCurveTo(
      p1.x + ((p2.x - p0.x) * t) / 3,
      p1.y + ((p2.y - p0.y) * t) / 3,
      p2.x - ((p3.x - p1.x) * t) / 3,
      p2.y - ((p3.y - p1.y) * t) / 3,
      p2.x,
      p2.y,
    );
  }
  ctx.stroke();
}

// ============================================
// CANVAS UI
// ============================================
class SigCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  isInput: boolean;
  strokes: Stroke[];
  cur: Point[];
  drawing: boolean;
  w: number;
  h: number;
  onUpdate: (() => void) | null;

  constructor(canvas: HTMLCanvasElement, isInput: boolean) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.isInput = isInput;
    this.strokes = [];
    this.cur = [];
    this.drawing = false;
    this.w = 0;
    this.h = 0;
    this.onUpdate = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    if (isInput) this.setupEvents();
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.w = r.width;
    this.h = r.height;
    this.redraw();
  }

  setupEvents(): void {
    const pos = (e: MouseEvent | Touch): Point => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const start = (e: MouseEvent | Touch): void => {
      this.drawing = true;
      this.cur = [pos(e)];
      this.redraw();
    };
    const move = (e: MouseEvent | Touch): void => {
      if (this.drawing) {
        const newPos = pos(e);
        // Interpolate between last point and new point for smoother lines
        if (this.cur.length > 0) {
          const lastPt = this.cur[this.cur.length - 1];
          const interpolated = interpolatePoints(
            lastPt,
            newPos,
            INTERPOLATION_DISTANCE,
          );
          this.cur.push(...interpolated);
        } else {
          this.cur.push(newPos);
        }
        this.redraw();
      }
    };
    const end = (): void => {
      if (!this.drawing) return;
      this.drawing = false;
      if (this.cur.length >= 1) this.strokes.push([...this.cur]);
      this.cur = [];
      this.redraw();
      if (this.onUpdate) this.onUpdate();
    };
    this.canvas.addEventListener("mousedown", (e) => start(e));
    this.canvas.addEventListener("mousemove", (e) => move(e));
    this.canvas.addEventListener("mouseup", end);
    this.canvas.addEventListener("mouseleave", end);
    this.canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      start(e.touches[0]);
    });
    this.canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      move(e.touches[0]);
    });
    this.canvas.addEventListener("touchend", (e) => {
      e.preventDefault();
      end();
    });
  }

  clear(): void {
    this.strokes = [];
    this.cur = [];
    this.redraw();
    if (this.isInput && this.onUpdate) this.onUpdate();
  }

  undo(): void {
    if (this.strokes.length) {
      this.strokes.pop();
      this.redraw();
      if (this.onUpdate) this.onUpdate();
    }
  }

  setStrokes(s: Stroke[]): void {
    this.strokes = s;
    this.redraw();
  }

  redraw(): void {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.ctx.strokeStyle = "#1a1a2e";
    this.ctx.fillStyle = "#1a1a2e";
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    for (const s of this.strokes) drawSpline(this.ctx, s, SPLINE_TENSION);
    if (this.cur.length) drawSpline(this.ctx, this.cur, SPLINE_TENSION);
  }
}

// ============================================
// MAIN
// ============================================
const inCanvas = new SigCanvas(inputCanvasEl, true);
const outCanvas = new SigCanvas(outputCanvasEl, false);

clearBtn.onclick = () => {
  inCanvas.clear();
  announce("Signature cleared");
};
undoBtn.onclick = () => {
  inCanvas.undo();
  announce("Stroke undone");
};

// Current signature object
let currentSig = new Signature({
  canvasWidth: inCanvas.w,
  canvasHeight: inCanvas.h,
});
let currentZ85 = "";
let currentSvg = "";

copyBtn.onclick = () => {
  if (currentZ85)
    navigator.clipboard.writeText(currentZ85).then(() => {
      copyBtn.textContent = "Copied!";
      announce("Z85 encoded signature copied to clipboard");
      setTimeout(() => (copyBtn.textContent = "Copy Z85"), 1500);
    });
};

copySvgBtn.onclick = () => {
  if (currentSvg)
    navigator.clipboard.writeText(currentSvg).then(() => {
      copySvgBtn.textContent = "Copied!";
      announce("SVG copied to clipboard");
      setTimeout(() => (copySvgBtn.textContent = "Copy SVG"), 1500);
    });
};

loadSampleBtn.onclick = () => {
  const S: Stroke[] = [[], [], [], []];
  for (let t = 0; t <= 1; t += 0.02)
    S[0].push({
      x: 40 + t * 80 + Math.sin(t * Math.PI * 2) * 15,
      y: 75 + Math.cos(t * Math.PI * 3) * 35,
    });
  for (let t = 0; t <= 1; t += 0.025)
    S[1].push({
      x: 100 + t * 120,
      y: 60 + Math.sin(t * Math.PI) * 30 + t * 20,
    });
  for (let t = 0; t <= 1; t += 0.02)
    S[2].push({
      x: 200 + t * 100 + Math.sin(t * Math.PI * 4) * 8,
      y: 70 + Math.cos(t * Math.PI * 2) * 25,
    });
  for (let t = 0; t <= 1; t += 0.03)
    S[3].push({ x: 60 + t * 250, y: 125 + Math.sin(t * Math.PI) * 8 });
  inCanvas.setStrokes(S);
  update();
  announce("Sample signature loaded");
};

// Load Z85 from clipboard or prompt
loadZ85Btn.onclick = async () => {
  let z85String: string | null = null;

  // Try clipboard first
  try {
    z85String = await navigator.clipboard.readText();
    z85String = z85String.trim();
  } catch {
    // Clipboard failed (permission denied or not available), use prompt
    z85String = prompt("Paste Z85 encoded signature:");
    if (z85String) z85String = z85String.trim();
  }

  if (!z85String) {
    return; // User cancelled or empty
  }

  // Try to deserialize
  try {
    const loadedSig = Signature.deserializeFromString(z85String, Encoding.Z85, {
      canvasWidth: inCanvas.w,
      canvasHeight: inCanvas.h,
    });

    // Get strokes scaled to input canvas dimensions
    const strokes = loadedSig.getStrokes();

    if (strokes.length === 0) {
      loadZ85Btn.textContent = "Empty!";
      announce("Loaded signature is empty");
      setTimeout(() => (loadZ85Btn.textContent = "Load Z85"), 1500);
      return;
    }

    // Set strokes on input canvas (replaces current content)
    inCanvas.setStrokes(strokes);

    // Trigger update to refresh outputs
    update();

    loadZ85Btn.textContent = `Loaded ${strokes.length} strokes`;
    announce(`Loaded signature with ${strokes.length} strokes`);
    setTimeout(() => (loadZ85Btn.textContent = "Load Z85"), 1500);
  } catch (e) {
    console.error("Load Z85 error:", e);
    loadZ85Btn.textContent = "Invalid!";
    announce("Invalid Z85 signature data");
    setTimeout(() => (loadZ85Btn.textContent = "Load Z85"), 1500);
  }
};

// Update range display values
svgStrokeWidthInput.addEventListener("input", () => {
  svgStrokeWidthValue.textContent = svgStrokeWidthInput.value;
  updateSvg();
});
svgTensionInput.addEventListener("input", () => {
  svgTensionValue.textContent = svgTensionInput.value;
  updateSvg();
});
svgContentPaddingInput.addEventListener("input", () => {
  svgContentPaddingValue.textContent =
    Math.round(parseFloat(svgContentPaddingInput.value) * 100) + "%";
  updateSvg();
});

// All config inputs trigger SVG update
[
  svgWidthInput,
  svgHeightInput,
  svgStrokeColorInput,
  svgBgColorInput,
  svgSplineInput,
  svgUseBgInput,
  svgContentFitInput,
].forEach((el) => {
  el.addEventListener("change", updateSvg);
  el.addEventListener("input", updateSvg);
});

function getSvgOptions(): RenderOptions {
  return {
    width: parseInt(svgWidthInput.value) || 512,
    height: parseInt(svgHeightInput.value) || 256,
    strokeWidth: parseFloat(svgStrokeWidthInput.value) || 2,
    strokeColor: svgStrokeColorInput.value,
    spline: svgSplineInput.checked,
    splineTension: parseFloat(svgTensionInput.value) || 0.5,
    backgroundColor: svgUseBgInput.checked ? svgBgColorInput.value : null,
    contentFit: svgContentFitInput.checked,
    contentPadding: parseFloat(svgContentPaddingInput.value) || 0.05,
  };
}

function updateSvg(): void {
  if (currentSig.isEmpty()) {
    svgContainer.textContent = "";
    const placeholder = document.createElement("span");
    placeholder.style.cssText = "color: #6b7280; font-size: 14px;";
    placeholder.textContent = "Draw a signature...";
    svgContainer.appendChild(placeholder);
    currentSvg = "";
    return;
  }
  const options = getSvgOptions();
  currentSvg = currentSig.render(Format.SVG, options);
  // Parse and insert SVG safely using DOMParser
  const parser = new DOMParser();
  const doc = parser.parseFromString(currentSvg, "image/svg+xml");
  const svgElement = doc.documentElement;
  if (svgElement.nodeName === "svg") {
    svgContainer.textContent = "";
    svgContainer.appendChild(document.importNode(svgElement, true));
  }
}

inCanvas.onUpdate = update;

function update(): void {
  // Recreate signature from input canvas strokes
  currentSig = new Signature({
    canvasWidth: inCanvas.w,
    canvasHeight: inCanvas.h,
  });

  for (const stroke of inCanvas.strokes) {
    currentSig.pushStroke(stroke);
  }

  // Get internals for analysis
  const internals = currentSig.getInternals();
  const payloadBytes = internals.getPayloadBytes();
  const stats = internals.getEncodeStats();

  // Serialize to get final size
  const serialized = currentSig.serialize();
  currentZ85 = currentSig.serializeToString(Encoding.Z85);

  // Decode for canvas output display (using getStrokes)
  let decodedSig: Signature;
  try {
    decodedSig = Signature.deserialize(serialized, {
      canvasWidth: outCanvas.w,
      canvasHeight: outCanvas.h,
    });
    outCanvas.setStrokes(decodedSig.getStrokes());
  } catch (e) {
    console.error("Decode error:", e);
    outCanvas.setStrokes([]);
  }

  // Update SVG output
  updateSvg();

  // Update comparison display
  const rawSize = payloadBytes.length;
  const finalSize = serialized.length;
  const savings =
    rawSize > 0 ? ((1 - (finalSize - 5) / rawSize) * 100).toFixed(1) : "0";

  rawSizeEl.textContent = String(rawSize);
  rawDetailEl.textContent = `${rawSize} bytes payload`;

  arithSizeEl.textContent = String(finalSize);
  arithDetailEl.textContent = `${currentZ85.length} Z85 chars (${savings}% smaller)`;

  // Update delta breakdown
  const totalPoints = stats.deltas + stats.absolutes;
  const deltaPercent =
    totalPoints > 0 ? ((stats.deltas / totalPoints) * 100).toFixed(1) : "0";

  let overflowInfo = "";
  if (stats.absolutes > 0) {
    const reasons: string[] = [];
    if (stats.overflowDxOnly > 0) reasons.push(`dx: ${stats.overflowDxOnly}`);
    if (stats.overflowDyOnly > 0) reasons.push(`dy: ${stats.overflowDyOnly}`);
    if (stats.overflowBoth > 0) reasons.push(`both: ${stats.overflowBoth}`);
    overflowInfo = reasons.length > 0 ? ` [${reasons.join(", ")}]` : "";
  }

  deltaBreakdownEl.innerHTML =
    `<span style="color: #4ade80;">Delta (2B): ${stats.deltas} (${deltaPercent}%)</span> | ` +
    `<span style="color: #ef4444;">Absolute (3B): ${stats.absolutes}${overflowInfo}</span> | ` +
    `<span style="color: #60a5fa;">Strokes: ${stats.strokeMarkers}</span>`;

  encodedOutputEl.textContent = currentZ85 || "Draw a signature...";
}

update();
