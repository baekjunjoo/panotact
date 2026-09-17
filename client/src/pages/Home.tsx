import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileImage,
  FilePlus2,
  Files,
  FileText,
  Grid3X3,
  ImageUp,
  Layers3,
  Loader2,
  LocateFixed,
  Maximize2,
  MousePointer2,
  PencilRuler,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Save,
  Trash2,
  Redo2,
  Undo2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const GRID_WIDTH = 60;
const GRID_HEIGHT = 40;
const GRID_RATIO = GRID_WIDTH / GRID_HEIGHT;
const FULL_CROP = { x: 0, y: 0, width: 1, height: 1, rotation: 0 };
const EMPTY_GRID = () => Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(false));

type ConversionMode = "edges" | "filled";
type PageKind = "overall" | "structure" | "focus" | "manual";
type Crop = { x: number; y: number; width: number; height: number; rotation: number };
type FocusCandidate = { id: string; label: string; crop: Crop; score: number };
type SourceInput = { source: string; label: string; documentId?: string; documentName?: string; documentOrder?: number; pdfPageNumber?: number; candidateIds?: string[] };
type TextRegion = { x: number; y: number; width: number; height: number };
type BatchDocument = { id: string; name: string; order: number; candidateCount: number; selectedCount: number; status: "queued" | "analyzing" | "ready" | "error"; error?: string };
type PdfFigureCandidate = {
  id: string;
  documentId: string;
  documentName: string;
  documentOrder: number;
  source: string;
  label: string;
  pageNumber: number;
  crop: Crop;
  selected: boolean;
  textRegions: TextRegion[];
  pagePreview: string;
  detection: "native" | "ocr" | "none";
};
type LearningFlowEntry = { id: string; documentId: string; documentName: string; documentOrder: number; pageNumber: number; label: string; source: string; candidateIds: string[]; pageIds: string[]; description: string };
type SourceSet = SourceInput & {
  id: string;
  aspect: number;
  candidates: FocusCandidate[];
  selectedCrop: Crop;
};
type TactilePage = {
  id: string;
  title: string;
  altText: string;
  grid: boolean[][];
  kind: PageKind;
  source?: string;
  sourceKey?: string;
  crop?: Crop;
};

type WorkspaceSnapshot = {
  pages: TactilePage[];
  sourceSets: SourceSet[];
  selectedId: string;
  pdfCandidates: PdfFigureCandidate[];
  batchDocuments: BatchDocument[];
  learningFlow: LearningFlowEntry[];
  reviewFileName: string;
  showTextOverlay: boolean;
};

type TemporaryDraft = {
  version: 1;
  savedAt: number;
  pages: TactilePage[];
  sourceSets: SourceSet[];
  selectedId: string;
  fileTitle: string;
  settings: { threshold: number; mode: ConversionMode; simplification: number; invert: boolean };
  pdfCandidates: PdfFigureCandidate[];
  reviewFileName: string;
  showTextOverlay?: boolean;
  batchDocuments?: BatchDocument[];
  learningFlow?: LearningFlowEntry[];
};

const DRAFT_DATABASE = "tactile-dtms-studio";
const DRAFT_STORE = "drafts";
const DRAFT_KEY = "current-workspace";

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneGrid(grid: boolean[][]) {
  return grid.map((row) => [...row]);
}

function dotCount(grid: boolean[][]) {
  return grid.flat().filter(Boolean).length;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cropFromCenter(centerX: number, centerY: number, width: number, sourceAspect: number, rotation = 0): Crop {
  let cropWidth = clamp(width, 0.22, 0.92);
  let cropHeight = (cropWidth * sourceAspect) / GRID_RATIO;

  if (cropHeight > 0.9) {
    cropHeight = 0.9;
    cropWidth = (cropHeight * GRID_RATIO) / sourceAspect;
  }

  return {
    x: clamp(centerX - cropWidth / 2, 0, 1 - cropWidth),
    y: clamp(centerY - cropHeight / 2, 0, 1 - cropHeight),
    width: cropWidth,
    height: cropHeight,
    rotation,
  };
}

function cropCenter(crop: Crop) {
  return { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
}

function constrainCrop(crop: Crop): Crop {
  const width = clamp(crop.width, 0.12, 0.96);
  const height = clamp(crop.height, 0.12, 0.96);
  return {
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
    rotation: clamp(crop.rotation, -180, 180),
  };
}

function copySourceSet(sourceSet: SourceSet): SourceSet {
  return {
    ...sourceSet,
    selectedCrop: { ...sourceSet.selectedCrop },
    candidates: sourceSet.candidates.map((candidate) => ({ ...candidate, crop: { ...candidate.crop } })),
  };
}

function copyPage(page: TactilePage): TactilePage {
  return { ...page, grid: cloneGrid(page.grid), crop: page.crop ? { ...page.crop } : undefined };
}

function copyCandidate(candidate: PdfFigureCandidate): PdfFigureCandidate {
  return { ...candidate, crop: { ...candidate.crop }, textRegions: candidate.textRegions.map((region) => ({ ...region })) };
}

function normalizeQueuedCandidates(candidates: PdfFigureCandidate[], fallbackName: string) {
  const fallbackId = `restored-${fallbackName || "pdf"}`;
  return candidates.map((candidate) => ({
    ...candidate,
    documentId: candidate.documentId || fallbackId,
    documentName: candidate.documentName || fallbackName || "이전 PDF 작업",
    documentOrder: Number.isFinite(candidate.documentOrder) ? candidate.documentOrder : 0,
  }));
}

function documentsFromCandidates(candidates: PdfFigureCandidate[]) {
  return candidates.reduce<BatchDocument[]>((documents, candidate) => {
    const existing = documents.find((document) => document.id === candidate.documentId);
    if (existing) {
      existing.candidateCount += 1;
      existing.selectedCount += Number(candidate.selected);
    } else {
      documents.push({ id: candidate.documentId, name: candidate.documentName, order: candidate.documentOrder, candidateCount: 1, selectedCount: Number(candidate.selected), status: "ready" });
    }
    return documents;
  }, []).sort((left, right) => left.order - right.order);
}

function openDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_STORE)) request.result.createObjectStore(DRAFT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getTemporaryDraft() {
  const database = await openDraftDatabase();
  return new Promise<TemporaryDraft | undefined>((resolve, reject) => {
    const request = database.transaction(DRAFT_STORE, "readonly").objectStore(DRAFT_STORE).get(DRAFT_KEY);
    request.onsuccess = () => { database.close(); resolve(request.result as TemporaryDraft | undefined); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function putTemporaryDraft(draft: TemporaryDraft) {
  const database = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(DRAFT_STORE, "readwrite").objectStore(DRAFT_STORE).put(draft, DRAFT_KEY);
    request.onsuccess = () => { database.close(); resolve(); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function removeTemporaryDraft() {
  const database = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(DRAFT_STORE, "readwrite").objectStore(DRAFT_STORE).delete(DRAFT_KEY);
    request.onsuccess = () => { database.close(); resolve(); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

function gridToBitmapHex(grid: boolean[][]) {
  const cells: string[] = [];
  const bitPositions = [
    [0, 3],
    [1, 4],
    [2, 5],
    [6, 7],
  ];

  for (let y = 0; y < GRID_HEIGHT; y += 4) {
    for (let x = 0; x < GRID_WIDTH; x += 2) {
      let bits = 0;
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          if (grid[y + row][x + column]) bits |= 1 << bitPositions[row][column];
        }
      }
      cells.push((0x2800 + bits).toString(16).padStart(4, "0"));
    }
  }
  return cells.join("");
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
    image.src = source;
  });
}

async function getImageDataFromSource(
  source: string,
  crop: Crop = FULL_CROP,
  width = GRID_WIDTH,
  height = GRID_HEIGHT,
): Promise<ImageData> {
  const image = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas를 시작할 수 없습니다.");

  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((-crop.rotation * Math.PI) / 180);
  context.scale(width / (image.naturalWidth * crop.width), height / (image.naturalHeight * crop.height));
  context.drawImage(
    image,
    -image.naturalWidth * (crop.x + crop.width / 2),
    -image.naturalHeight * (crop.y + crop.height / 2),
  );
  context.restore();
  return context.getImageData(0, 0, width, height);
}

async function inspectSource(source: string) {
  const image = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 80;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("이미지를 분석할 수 없습니다.");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    aspect: image.naturalWidth / image.naturalHeight,
    imageData: context.getImageData(0, 0, canvas.width, canvas.height),
  };
}

function pixel(imageData: ImageData, x: number, y: number) {
  const safeX = clamp(x, 0, imageData.width - 1);
  const safeY = clamp(y, 0, imageData.height - 1);
  const offset = (safeY * imageData.width + safeX) * 4;
  const { data } = imageData;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]] as const;
}

function luminance(color: readonly number[]) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function colorDistance(a: readonly number[], b: readonly number[]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function isForeground(color: readonly number[]) {
  const high = Math.max(color[0], color[1], color[2]);
  const low = Math.min(color[0], color[1], color[2]);
  return color[3] > 25 && (luminance(color) < 242 || high - low > 26);
}

function foregroundMask(imageData: ImageData) {
  const mask = EMPTY_GRID();
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) mask[y][x] = isForeground(pixel(imageData, x, y));
  }
  return mask;
}

function largestComponent(mask: boolean[][]) {
  const visited = EMPTY_GRID();
  let best: Array<[number, number]> = [];

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!mask[y][x] || visited[y][x]) continue;
      const component: Array<[number, number]> = [];
      const queue: Array<[number, number]> = [[x, y]];
      visited[y][x] = true;

      while (queue.length) {
        const [currentX, currentY] = queue.shift()!;
        component.push([currentX, currentY]);
        const neighbors = [
          [currentX + 1, currentY],
          [currentX - 1, currentY],
          [currentX, currentY + 1],
          [currentX, currentY - 1],
        ];
        neighbors.forEach(([nextX, nextY]) => {
          if (
            nextX >= 0 &&
            nextY >= 0 &&
            nextX < GRID_WIDTH &&
            nextY < GRID_HEIGHT &&
            mask[nextY][nextX] &&
            !visited[nextY][nextX]
          ) {
            visited[nextY][nextX] = true;
            queue.push([nextX, nextY]);
          }
        });
      }

      if (component.length > best.length) best = component;
    }
  }

  const result = EMPTY_GRID();
  best.forEach(([x, y]) => {
    result[y][x] = true;
  });
  return result;
}

function dilateGrid(grid: boolean[][], radius = 1) {
  const result = EMPTY_GRID();
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!grid[y][x]) continue;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const targetX = x + offsetX;
          const targetY = y + offsetY;
          if (targetX >= 0 && targetY >= 0 && targetX < GRID_WIDTH && targetY < GRID_HEIGHT) {
            result[targetY][targetX] = true;
          }
        }
      }
    }
  }
  return result;
}

function simplifyGrid(grid: boolean[][], passes: number) {
  let result = cloneGrid(grid);
  for (let pass = 0; pass < passes; pass += 1) {
    const next = cloneGrid(result);
    for (let y = 1; y < GRID_HEIGHT - 1; y += 1) {
      for (let x = 1; x < GRID_WIDTH - 1; x += 1) {
        let neighbors = 0;
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (offsetX !== 0 || offsetY !== 0) neighbors += Number(result[y + offsetY][x + offsetX]);
          }
        }
        if (neighbors <= 1) next[y][x] = false;
        if (neighbors >= 7) next[y][x] = true;
      }
    }
    result = next;
  }
  return result;
}

function sourceToOverallGrid(imageData: ImageData) {
  const subject = largestComponent(foregroundMask(imageData));
  const outline = EMPTY_GRID();

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!subject[y][x]) continue;
      const touchesBackground = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ].some(([nextX, nextY]) => nextX < 0 || nextY < 0 || nextX >= GRID_WIDTH || nextY >= GRID_HEIGHT || !subject[nextY][nextX]);
      if (touchesBackground) outline[y][x] = true;
    }
  }
  return dilateGrid(outline, 1);
}

function sourceToStructureGrid(imageData: ImageData, threshold: number, filled: boolean, focus: boolean) {
  const result = EMPTY_GRID();
  const mask = foregroundMask(imageData);
  const edgeLimit = 54 + threshold * (focus ? 0.26 : 0.34);

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const current = pixel(imageData, x, y);
      if (filled) {
        result[y][x] = mask[y][x] && luminance(current) < threshold;
        continue;
      }
      const horizontal = colorDistance(pixel(imageData, x + 1, y), pixel(imageData, x - 1, y));
      const vertical = colorDistance(pixel(imageData, x, y + 1), pixel(imageData, x, y - 1));
      const isDarkLine = luminance(current) < 76;
      result[y][x] = mask[y][x] && (horizontal + vertical > edgeLimit || isDarkLine);
    }
  }
  return result;
}

function scoreCrop(imageData: ImageData, crop: Crop) {
  const startX = Math.floor(crop.x * imageData.width);
  const endX = Math.min(imageData.width - 1, Math.ceil((crop.x + crop.width) * imageData.width));
  const startY = Math.floor(crop.y * imageData.height);
  const endY = Math.min(imageData.height - 1, Math.ceil((crop.y + crop.height) * imageData.height));
  let score = 0;

  for (let y = startY + 1; y < endY - 1; y += 1) {
    for (let x = startX + 1; x < endX - 1; x += 1) {
      const current = pixel(imageData, x, y);
      if (!isForeground(current)) continue;
      score += colorDistance(pixel(imageData, x + 1, y), pixel(imageData, x - 1, y));
      score += colorDistance(pixel(imageData, x, y + 1), pixel(imageData, x, y - 1));
    }
  }
  return score;
}

function findFocusCandidates(imageData: ImageData, sourceAspect: number) {
  const options: FocusCandidate[] = [];
  const centers = [0.2, 0.35, 0.5, 0.65, 0.8];
  centers.forEach((centerY) => {
    centers.forEach((centerX) => {
      const crop = cropFromCenter(centerX, centerY, 0.5, sourceAspect);
      options.push({ id: createId(), label: "", crop, score: scoreCrop(imageData, crop) });
    });
  });

  const selected: FocusCandidate[] = [];
  options
    .sort((a, b) => b.score - a.score)
    .forEach((candidate) => {
      const candidateCenter = cropCenter(candidate.crop);
      const isDistantEnough = selected.every((current) => {
        const currentCenter = cropCenter(current.crop);
        return Math.hypot(candidateCenter.x - currentCenter.x, candidateCenter.y - currentCenter.y) > 0.24;
      });
      if (isDistantEnough && selected.length < 3) selected.push(candidate);
    });

  const fallbackCenters: Array<[number, number]> = [
    [0.5, 0.5],
    [0.3, 0.5],
    [0.7, 0.5],
  ];
  fallbackCenters.forEach(([x, y]) => {
    if (selected.length < 3) {
      const crop = cropFromCenter(x, y, 0.5, sourceAspect);
      selected.push({ id: createId(), label: "", crop, score: 0 });
    }
  });

  return selected.map((candidate, index) => ({ ...candidate, label: `후보 ${String.fromCharCode(65 + index)}` }));
}

function createBlankPage(title = "새 촉각 페이지"): TactilePage {
  return { id: createId(), title, altText: "", grid: EMPTY_GRID(), kind: "manual" };
}

function pageInfo(kind: PageKind) {
  if (kind === "overall") return { title: "1. 전체 형태", description: "가장 큰 외곽 윤곽" };
  if (kind === "structure") return { title: "2. 구조 구분", description: "내부 경계와 반복 구조" };
  if (kind === "focus") return { title: "3. 핵심 부위 확대", description: "사용자가 고른 영역" };
  return { title: "수동 페이지", description: "직접 만든 촉각 도식" };
}

export default function Home() {
  const [pages, setPages] = useState<TactilePage[]>([createBlankPage("촉각 도식 1")]);
  const [selectedId, setSelectedId] = useState<string>(() => pages[0].id);
  const [sourceSets, setSourceSets] = useState<SourceSet[]>([]);
  const [fileTitle, setFileTitle] = useState("나의 촉각 도식");
  const [threshold, setThreshold] = useState(132);
  const [mode, setMode] = useState<ConversionMode>("edges");
  const [simplification, setSimplification] = useState(1);
  const [invert, setInvert] = useState(false);
  const [tool, setTool] = useState<"draw" | "erase">("draw");
  const [brushSize, setBrushSize] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isFocusing, setIsFocusing] = useState(false);
  const [status, setStatus] = useState("이미지 또는 PDF를 올리면 3개의 촉각 구조도 초안을 만듭니다.");
  const [isDrawing, setIsDrawing] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [pdfCandidates, setPdfCandidates] = useState<PdfFigureCandidate[]>([]);
  const [reviewFileName, setReviewFileName] = useState("");
  const [batchDocuments, setBatchDocuments] = useState<BatchDocument[]>([]);
  const [learningFlow, setLearningFlow] = useState<LearningFlowEntry[]>([]);
  const [showTextOverlay, setShowTextOverlay] = useState(false);
  const [autosaveReady, setAutosaveReady] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const batchUploadRef = useRef<HTMLInputElement>(null);
  const undoStackRef = useRef<WorkspaceSnapshot[]>([]);
  const redoStackRef = useRef<WorkspaceSnapshot[]>([]);
  const focusRenderRef = useRef(0);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePage = useMemo(
    () => pages.find((page) => page.id === selectedId) ?? pages[0],
    [pages, selectedId],
  );
  const activeSourceSet = useMemo(() => {
    const sourceKey = activePage?.sourceKey;
    return sourceSets.find((sourceSet) => sourceSet.id === sourceKey) ?? sourceSets[0];
  }, [activePage?.sourceKey, sourceSets]);
  const sourceImage = activePage?.source ?? activeSourceSet?.source;
  const savedLabel = lastSavedAt ? `임시 저장됨 · ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(lastSavedAt)}` : "자동 임시 저장 준비됨";

  function buildTemporaryDraft(): TemporaryDraft {
    return {
      version: 1,
      savedAt: Date.now(),
      pages: pages.map(copyPage),
      sourceSets: sourceSets.map(copySourceSet),
      selectedId,
      fileTitle,
      settings: { threshold, mode, simplification, invert },
      pdfCandidates: pdfCandidates.map((candidate) => ({ ...candidate, crop: { ...candidate.crop }, textRegions: candidate.textRegions.map((region) => ({ ...region })) })),
      reviewFileName,
      showTextOverlay,
      batchDocuments,
      learningFlow: learningFlow.map((entry) => ({ ...entry, candidateIds: [...entry.candidateIds], pageIds: [...entry.pageIds] })),
    };
  }

  useEffect(() => {
    let cancelled = false;
    void getTemporaryDraft()
      .then((draft) => {
        if (cancelled || !draft || draft.version !== 1) return;
        if (draft.pages.length) {
          setPages(draft.pages.map(copyPage));
          setSelectedId(draft.selectedId);
          setSourceSets(draft.sourceSets.map(copySourceSet));
          setFileTitle(draft.fileTitle);
          setThreshold(draft.settings.threshold);
          setMode(draft.settings.mode);
          setSimplification(draft.settings.simplification);
          setInvert(draft.settings.invert);
          const restoredCandidates = normalizeQueuedCandidates(draft.pdfCandidates ?? [], draft.reviewFileName ?? "");
          setPdfCandidates(restoredCandidates);
          setReviewFileName(draft.reviewFileName ?? "");
          setBatchDocuments(draft.batchDocuments?.length ? draft.batchDocuments : documentsFromCandidates(restoredCandidates));
          setLearningFlow(draft.learningFlow ?? []);
          setShowTextOverlay(Boolean(draft.showTextOverlay));
          setLastSavedAt(draft.savedAt);
          setStatus("브라우저 임시 저장 작업을 복원했습니다.");
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setAutosaveReady(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!autosaveReady) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void putTemporaryDraft(buildTemporaryDraft())
        .then(() => setLastSavedAt(Date.now()))
        .catch(() => undefined);
    }, 850);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [pages, sourceSets, selectedId, fileTitle, threshold, mode, simplification, invert, pdfCandidates, reviewFileName, batchDocuments, learningFlow, showTextOverlay, autosaveReady]);

  function saveTemporaryDraftNow() {
    setIsSavingDraft(true);
    void putTemporaryDraft(buildTemporaryDraft())
      .then(() => {
        setLastSavedAt(Date.now());
        setStatus("현재 작업을 이 브라우저에 임시 저장했습니다.");
      })
      .catch(() => setStatus("임시 저장을 사용할 수 없습니다. 브라우저 저장소 설정을 확인해 주세요."))
      .finally(() => setIsSavingDraft(false));
  }

  function clearTemporaryDraft() {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    void removeTemporaryDraft()
      .then(() => {
        setLastSavedAt(null);
        setStatus("브라우저에 저장된 임시 작업을 삭제했습니다. 현재 화면의 작업은 유지됩니다.");
      })
      .catch(() => setStatus("임시 저장 삭제에 실패했습니다."));
  }

  function makeSnapshot(): WorkspaceSnapshot {
    return {
      pages: pages.map((page) => ({ ...page, grid: cloneGrid(page.grid), crop: page.crop ? { ...page.crop } : undefined })),
      sourceSets: sourceSets.map((sourceSet) => ({
        ...sourceSet,
        selectedCrop: { ...sourceSet.selectedCrop },
        candidates: sourceSet.candidates.map((candidate) => ({ ...candidate, crop: { ...candidate.crop } })),
      })),
      selectedId,
      pdfCandidates: pdfCandidates.map(copyCandidate),
      batchDocuments: batchDocuments.map((document) => ({ ...document })),
      learningFlow: learningFlow.map((entry) => ({ ...entry, candidateIds: [...entry.candidateIds], pageIds: [...entry.pageIds] })),
      reviewFileName,
      showTextOverlay,
    };
  }

  function recordHistory() {
    undoStackRef.current = [...undoStackRef.current.slice(-29), makeSnapshot()];
    redoStackRef.current = [];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
  }

  function restoreSnapshot(snapshot: WorkspaceSnapshot) {
    focusRenderRef.current += 1;
    setPages(snapshot.pages.map((page) => ({ ...page, grid: cloneGrid(page.grid), crop: page.crop ? { ...page.crop } : undefined })));
    setSourceSets(snapshot.sourceSets.map((sourceSet) => ({
      ...sourceSet,
      selectedCrop: { ...sourceSet.selectedCrop },
      candidates: sourceSet.candidates.map((candidate) => ({ ...candidate, crop: { ...candidate.crop } })),
    })));
    setSelectedId(snapshot.selectedId);
    setPdfCandidates(snapshot.pdfCandidates.map(copyCandidate));
    setBatchDocuments(snapshot.batchDocuments.map((document) => ({ ...document })));
    setLearningFlow(snapshot.learningFlow.map((entry) => ({ ...entry, candidateIds: [...entry.candidateIds], pageIds: [...entry.pageIds] })));
    setReviewFileName(snapshot.reviewFileName);
    setShowTextOverlay(snapshot.showTextOverlay);
  }

  function undoWorkspace() {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current = [...redoStackRef.current, makeSnapshot()];
    restoreSnapshot(previous);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    setStatus("직전 작업을 되돌렸습니다.");
  }

  function redoWorkspace() {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current = [...undoStackRef.current, makeSnapshot()];
    restoreSnapshot(next);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    setStatus("되돌린 작업을 다시 적용했습니다.");
  }

  function updateActivePage(patch: Partial<TactilePage>) {
    if (!activePage) return;
    setPages((current) => current.map((page) => (page.id === activePage.id ? { ...page, ...patch } : page)));
  }

  function applyAt(x: number, y: number) {
    if (!activePage || x < 0 || y < 0 || x >= GRID_WIDTH || y >= GRID_HEIGHT) return;
    const radius = brushSize === 3 ? 1 : 0;
    const grid = cloneGrid(activePage.grid);
    for (let offsetY = y - radius; offsetY <= y + radius; offsetY += 1) {
      for (let offsetX = x - radius; offsetX <= x + radius; offsetX += 1) {
        if (offsetX >= 0 && offsetY >= 0 && offsetX < GRID_WIDTH && offsetY < GRID_HEIGHT) {
          grid[offsetY][offsetX] = tool === "draw";
        }
      }
    }
    updateActivePage({ grid });
  }

  function pointerToDot(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(GRID_WIDTH - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * GRID_WIDTH)),
      y: Math.min(GRID_HEIGHT - 1, Math.floor(((event.clientY - bounds.top) / bounds.height) * GRID_HEIGHT)),
    };
  }

  function handleGridPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = pointerToDot(event);
    recordHistory();
    setIsDrawing(true);
    applyAt(x, y);
  }

  function handleGridPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!isDrawing) return;
    const { x, y } = pointerToDot(event);
    applyAt(x, y);
  }

  async function gridFor(source: string, crop: Crop, kind: PageKind) {
    const imageData = await getImageDataFromSource(source, crop);
    let raw: boolean[][];
    if (kind === "overall") {
      raw = sourceToOverallGrid(imageData);
    } else {
      raw = sourceToStructureGrid(imageData, threshold, mode === "filled", kind === "focus");
    }
    const passes = kind === "overall" ? Math.max(1, simplification) : simplification;
    raw = simplifyGrid(raw, passes);
    return invert ? raw.map((row) => row.map((value) => !value)) : raw;
  }

  async function makeAutoPage(sourceSet: SourceSet, kind: Exclude<PageKind, "manual">, includeSourceLabel: boolean): Promise<TactilePage> {
    const crop = kind === "focus" ? sourceSet.selectedCrop : FULL_CROP;
    const grid = await gridFor(sourceSet.source, crop, kind);
    const info = pageInfo(kind);
    const altText =
      kind === "overall"
        ? "원본에서 가장 큰 형태의 외곽선을 추린 촉각 도식입니다."
        : kind === "structure"
          ? "원본의 경계와 색·명암 차이를 구조 구분용 촉각 선으로 바꾼 도식입니다."
          : "사용자가 선택한 핵심 부위를 확대해 구조 경계를 표현한 촉각 도식입니다.";
    return {
      id: createId(),
      title: includeSourceLabel ? `${sourceSet.label} · ${info.title}` : info.title,
      altText,
      grid,
      kind,
      source: sourceSet.source,
      sourceKey: sourceSet.id,
      crop,
    };
  }

  async function makeAutoPages(sets: SourceSet[]) {
    const includeSourceLabel = sets.length > 1 || sets.some((sourceSet) => sourceSet.label.includes("병합"));
    return Promise.all(sets.flatMap((sourceSet) => [
      makeAutoPage(sourceSet, "overall", includeSourceLabel),
      makeAutoPage(sourceSet, "structure", includeSourceLabel),
      makeAutoPage(sourceSet, "focus", includeSourceLabel),
    ]));
  }

  async function refreshFocusPage(sourceSet: SourceSet) {
    const requestId = ++focusRenderRef.current;
    setIsFocusing(true);
    try {
      const grid = await gridFor(sourceSet.source, sourceSet.selectedCrop, "focus");
      if (requestId !== focusRenderRef.current) return;
      setPages((current) =>
        current.map((page) =>
          page.sourceKey === sourceSet.id && page.kind === "focus"
            ? { ...page, grid, crop: sourceSet.selectedCrop }
            : page,
        ),
      );
      setStatus("핵심 부위 확대 페이지를 선택한 영역으로 갱신했습니다.");
    } catch {
      setStatus("핵심 부위 확대를 만들 수 없습니다. 다른 위치를 선택해 주세요.");
    } finally {
      if (requestId === focusRenderRef.current) setIsFocusing(false);
    }
  }

  async function createSourceSet(input: SourceInput): Promise<SourceSet> {
    const inspection = await inspectSource(input.source);
    const candidates = findFocusCandidates(inspection.imageData, inspection.aspect);
    return {
      ...input,
      id: createId(),
      aspect: inspection.aspect,
      candidates,
      selectedCrop: candidates[0].crop,
    };
  }

  async function textLayerRegions(pdfPage: { getTextContent: () => Promise<{ items: unknown[] }> }, viewport: { width: number; height: number; scale: number }) {
    const content = await pdfPage.getTextContent();
    return content.items.flatMap((item) => {
      if (!item || typeof item !== "object" || !("str" in item) || !("transform" in item) || !("width" in item) || !("height" in item)) return [];
      const textItem = item as { str: string; transform: number[]; width: number; height: number };
      if (!textItem.str.trim()) return [];
      const [,, , transformHeight, transformX, transformY] = textItem.transform;
      const height = Math.max(9, Math.abs(textItem.height || transformHeight) * viewport.scale);
      const width = Math.max(6, Math.abs(textItem.width) * viewport.scale);
      return [{ x: transformX * viewport.scale, y: viewport.height - transformY * viewport.scale - height, width, height }];
    });
  }

  async function ocrRegions(canvas: HTMLCanvasElement) {
    let worker: { recognize: (image: HTMLCanvasElement, options?: object, output?: { blocks?: boolean }) => Promise<{ data: { blocks: Array<{ paragraphs: Array<{ lines: Array<{ words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> }> }> }> | null } }>; terminate: () => Promise<unknown> } | undefined;
    try {
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker("kor+eng", undefined, { logger: () => undefined });
      const result = await worker.recognize(canvas, {}, { blocks: true });
      const words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> = [];
      const blocks = result.data.blocks ?? [];
      blocks.forEach((block) => {
        block.paragraphs.forEach((paragraph) => {
          paragraph.lines.forEach((line) => words.push(...line.words));
        });
      });
      await worker.terminate();
      return words
        .filter((word) => word.text.trim() && word.confidence >= 35)
        .map((word) => ({ x: word.bbox.x0, y: word.bbox.y0, width: word.bbox.x1 - word.bbox.x0, height: word.bbox.y1 - word.bbox.y0 }));
    } catch {
      await worker?.terminate().catch(() => undefined);
      return [];
    }
  }

  function detectVisualRegions(canvas: HTMLCanvasElement, excludedTextRegions: Array<{ x: number; y: number; width: number; height: number }> = []): Crop[] {
    const analysisWidth = 180;
    const analysisHeight = Math.max(80, Math.round((canvas.height / canvas.width) * analysisWidth));
    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = analysisWidth;
    analysisCanvas.height = analysisHeight;
    const context = analysisCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    context.fillStyle = "white";
    context.fillRect(0, 0, analysisWidth, analysisHeight);
    context.drawImage(canvas, 0, 0, analysisWidth, analysisHeight);
    const imageData = context.getImageData(0, 0, analysisWidth, analysisHeight);
    const mask = Array.from({ length: analysisHeight }, () => Array(analysisWidth).fill(false));
    const ink = Array.from({ length: analysisHeight }, () => Array(analysisWidth).fill(false));

    for (let y = 0; y < analysisHeight; y += 1) {
      for (let x = 0; x < analysisWidth; x += 1) {
        const originalX = (x / analysisWidth) * canvas.width;
        const originalY = (y / analysisHeight) * canvas.height;
        const isTextPixel = excludedTextRegions.some((region) => originalX >= region.x - 8 && originalX <= region.x + region.width + 8 && originalY >= region.y - 8 && originalY <= region.y + region.height + 8);
        if (isTextPixel) continue;
        const color = pixel(imageData, x, y);
        const colorful = Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]) > 18;
        ink[y][x] = luminance(color) < 232 || colorful;
      }
    }

    const seed = Array.from({ length: analysisHeight }, () => Array(analysisWidth).fill(false));
    const inkVisited = Array.from({ length: analysisHeight }, () => Array(analysisWidth).fill(false));
    for (let y = 0; y < analysisHeight; y += 1) {
      for (let x = 0; x < analysisWidth; x += 1) {
        if (!ink[y][x] || inkVisited[y][x]) continue;
        const queue: Array<[number, number]> = [[x, y]];
        const component: Array<[number, number]> = [];
        inkVisited[y][x] = true;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;

        while (queue.length) {
          const [currentX, currentY] = queue.shift()!;
          component.push([currentX, currentY]);
          minX = Math.min(minX, currentX);
          maxX = Math.max(maxX, currentX);
          minY = Math.min(minY, currentY);
          maxY = Math.max(maxY, currentY);
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
              const nextX = currentX + offsetX;
              const nextY = currentY + offsetY;
              if (nextX >= 0 && nextY >= 0 && nextX < analysisWidth && nextY < analysisHeight && ink[nextY][nextX] && !inkVisited[nextY][nextX]) {
                inkVisited[nextY][nextX] = true;
                queue.push([nextX, nextY]);
              }
            }
          }
        }

        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        const isVisualSeed = component.length >= 36 || (componentWidth >= 18 && componentHeight >= 3) || (componentHeight >= 18 && componentWidth >= 3);
        if (isVisualSeed) component.forEach(([pointX, pointY]) => { seed[pointY][pointX] = true; });
      }
    }

    for (let y = 0; y < analysisHeight; y += 1) {
      for (let x = 0; x < analysisWidth; x += 1) {
        if (!seed[y][x]) continue;
        for (let offsetY = -3; offsetY <= 3; offsetY += 1) {
          for (let offsetX = -3; offsetX <= 3; offsetX += 1) {
            const targetX = x + offsetX;
            const targetY = y + offsetY;
            if (targetX >= 0 && targetY >= 0 && targetX < analysisWidth && targetY < analysisHeight) mask[targetY][targetX] = true;
          }
        }
      }
    }

    const visited = Array.from({ length: analysisHeight }, () => Array(analysisWidth).fill(false));
    const boxes: Array<{ x: number; y: number; width: number; height: number; inkDensity: number }> = [];
    for (let y = 0; y < analysisHeight; y += 1) {
      for (let x = 0; x < analysisWidth; x += 1) {
        if (!mask[y][x] || visited[y][x]) continue;
        const queue: Array<[number, number]> = [[x, y]];
        visited[y][x] = true;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        let inkCount = 0;

        while (queue.length) {
          const [currentX, currentY] = queue.shift()!;
          minX = Math.min(minX, currentX);
          maxX = Math.max(maxX, currentX);
          minY = Math.min(minY, currentY);
          maxY = Math.max(maxY, currentY);
          inkCount += Number(ink[currentY][currentX]);
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([offsetX, offsetY]) => {
            const nextX = currentX + offsetX;
            const nextY = currentY + offsetY;
            if (nextX >= 0 && nextY >= 0 && nextX < analysisWidth && nextY < analysisHeight && mask[nextY][nextX] && !visited[nextY][nextX]) {
              visited[nextY][nextX] = true;
              queue.push([nextX, nextY]);
            }
          });
        }

        const width = maxX - minX + 1;
        const height = maxY - minY + 1;
        const area = width * height;
        const inkDensity = inkCount / area;
        if (width >= 18 && height >= 16 && area >= analysisWidth * analysisHeight * 0.025 && inkDensity >= 0.025) {
          boxes.push({ x: minX, y: minY, width, height, inkDensity });
        }
      }
    }

    const merged = boxes.reduce<Array<{ x: number; y: number; width: number; height: number; inkDensity: number }>>((regions, box) => {
      const overlapping = regions.findIndex((region) =>
        box.x <= region.x + region.width + 7 && box.x + box.width + 7 >= region.x && box.y <= region.y + region.height + 7 && box.y + box.height + 7 >= region.y,
      );
      if (overlapping === -1) {
        regions.push(box);
      } else {
        const region = regions[overlapping];
        const minX = Math.min(region.x, box.x);
        const minY = Math.min(region.y, box.y);
        const maxX = Math.max(region.x + region.width, box.x + box.width);
        const maxY = Math.max(region.y + region.height, box.y + box.height);
        regions[overlapping] = { x: minX, y: minY, width: maxX - minX, height: maxY - minY, inkDensity: Math.max(region.inkDensity, box.inkDensity) };
      }
      return regions;
    }, []);

    return merged
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, 8)
      .map((region) => {
        const padding = 8;
        const x = clamp((region.x - padding) / analysisWidth, 0, 1);
        const y = clamp((region.y - padding) / analysisHeight, 0, 1);
        const right = clamp((region.x + region.width + padding) / analysisWidth, 0, 1);
        const bottom = clamp((region.y + region.height + padding) / analysisHeight, 0, 1);
        return { x, y, width: right - x, height: bottom - y, rotation: 0 };
      });
  }

  function sourceFromRegion(canvas: HTMLCanvasElement, crop: Crop) {
    const extracted = document.createElement("canvas");
    extracted.width = Math.max(1, Math.round(canvas.width * crop.width));
    extracted.height = Math.max(1, Math.round(canvas.height * crop.height));
    const context = extracted.getContext("2d");
    if (!context) throw new Error("PDF 그림을 분리할 수 없습니다.");
    context.fillStyle = "white";
    context.fillRect(0, 0, extracted.width, extracted.height);
    context.drawImage(canvas, canvas.width * crop.x, canvas.height * crop.y, canvas.width * crop.width, canvas.height * crop.height, 0, 0, extracted.width, extracted.height);
    return extracted.toDataURL("image/png");
  }

  async function sourceFromCrop(source: string, crop: Crop) {
    const image = await loadImage(source);
    const extracted = document.createElement("canvas");
    extracted.width = Math.max(1, Math.round(image.naturalWidth * crop.width));
    extracted.height = Math.max(1, Math.round(image.naturalHeight * crop.height));
    const context = extracted.getContext("2d");
    if (!context) throw new Error("병합한 그림을 만들 수 없습니다.");
    context.fillStyle = "white";
    context.fillRect(0, 0, extracted.width, extracted.height);
    context.drawImage(image, image.naturalWidth * crop.x, image.naturalHeight * crop.y, image.naturalWidth * crop.width, image.naturalHeight * crop.height, 0, 0, extracted.width, extracted.height);
    return extracted.toDataURL("image/png");
  }

  async function processPdf(file: File, queuedDocument: Pick<BatchDocument, "id" | "name" | "order">): Promise<PdfFigureCandidate[]> {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdfDocument = await pdfjsLib.getDocument({ data }).promise;
    const candidates: PdfFigureCandidate[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      setStatus(`PDF ${pageNumber}/${pdfDocument.numPages} 페이지를 분석 중…`);
      const pdfPage = await pdfDocument.getPage(pageNumber);
      const viewport = pdfPage.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("PDF 캔버스를 만들 수 없습니다.");
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      const nativeText = await textLayerRegions(pdfPage, viewport);
      let excludedText = nativeText;
      let detection: PdfFigureCandidate["detection"] = nativeText.length ? "native" : "none";
      if (!nativeText.length) {
        setStatus(`PDF ${pageNumber}/${pdfDocument.numPages} 페이지의 문자 영역을 OCR로 인식 중…`);
        excludedText = await ocrRegions(canvas);
        detection = excludedText.length ? "ocr" : "none";
      }
      const regions = detectVisualRegions(canvas, excludedText);
      const pagePreview = canvas.toDataURL("image/png");
      const normalizedText = excludedText.map((region) => ({
        x: region.x / canvas.width,
        y: region.y / canvas.height,
        width: region.width / canvas.width,
        height: region.height / canvas.height,
      }));
      if (regions.length) {
        setStatus(`PDF ${pageNumber}/${pdfDocument.numPages} 페이지에서 ${regions.length}개 그림 영역을 분리했습니다…`);
        regions.forEach((region, index) => {
          candidates.push({
            id: createId(),
            documentId: queuedDocument.id,
            documentName: queuedDocument.name,
            documentOrder: queuedDocument.order,
            source: sourceFromRegion(canvas, region),
            label: `${file.name.replace(/\.pdf$/i, "")} · ${pageNumber}쪽 그림 ${index + 1}`,
            pageNumber,
            crop: region,
            selected: true,
            textRegions: normalizedText,
            pagePreview,
            detection,
          });
        });
      } else {
        candidates.push({
          id: createId(),
          documentId: queuedDocument.id,
          documentName: queuedDocument.name,
          documentOrder: queuedDocument.order,
          source: pagePreview,
          label: `${file.name.replace(/\.pdf$/i, "")} · ${pageNumber}쪽 전체`,
          pageNumber,
          crop: FULL_CROP,
          selected: true,
          textRegions: normalizedText,
          pagePreview,
          detection,
        });
      }
    }
    return candidates;
  }

  async function generateSourceWorkflow(sources: SourceInput[], title: string, flowEntries: Omit<LearningFlowEntry, "pageIds">[] = []) {
    if (!sources.length) {
      setStatus("변환할 그림 후보를 하나 이상 선택해 주세요.");
      return;
    }
    setStatus("전체 형태·구조 구분·핵심 부위 확대 초안을 만들고 있습니다…");
    const sets = await Promise.all(sources.map(createSourceSet));
    const generated = await makeAutoPages(sets);
    recordHistory();
    setSourceSets(sets);
    setPages(generated);
    setSelectedId(generated[0].id);
    setFileTitle(title);
    setPdfCandidates([]);
    setReviewFileName("");
    setBatchDocuments([]);
    setLearningFlow(flowEntries.map((entry, index) => ({
      ...entry,
      pageIds: generated.filter((page) => page.sourceKey === sets[index]?.id).map((page) => page.id),
    })));
    setStatus(`${sources.length}개 원본에서 ${generated.length}개 촉각 구조도 초안을 만들었습니다. 핵심 부위를 클릭해 3번째 페이지를 바꿔 보세요.`);
    return { sets, generated };
  }

  function toggleCandidate(candidateId: string) {
    setPdfCandidates((current) => {
      const next = current.map((candidate) => candidate.id === candidateId ? { ...candidate, selected: !candidate.selected } : candidate);
      updateBatchCounts(next);
      return next;
    });
  }

  function setAllCandidates(selected: boolean) {
    setPdfCandidates((current) => {
      const next = current.map((candidate) => ({ ...candidate, selected }));
      updateBatchCounts(next);
      return next;
    });
  }

  function updateBatchCounts(candidates: PdfFigureCandidate[]) {
    setBatchDocuments((documents) => documents.map((document) => {
      const documentCandidates = candidates.filter((candidate) => candidate.documentId === document.id);
      return { ...document, candidateCount: documentCandidates.length, selectedCount: documentCandidates.filter((candidate) => candidate.selected).length };
    }));
  }

  async function updateCandidateBoundary(candidateId: string, crop: Crop) {
    const candidate = pdfCandidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    const constrained = constrainCrop({ ...crop, rotation: 0 });
    recordHistory();
    try {
      const source = await sourceFromCrop(candidate.pagePreview, constrained);
      setPdfCandidates((current) => current.map((item) => item.id === candidateId ? { ...item, crop: constrained, source } : item));
      setStatus(`${candidate.documentName} ${candidate.pageNumber}쪽의 그림 후보 경계를 보정했습니다.`);
    } catch {
      setStatus("그림 후보 경계를 갱신하지 못했습니다.");
    }
  }

  function updateLearningDescription(entryId: string, description: string) {
    setLearningFlow((current) => current.map((entry) => entry.id === entryId ? { ...entry, description } : entry));
  }

  function openLearningEntry(entry: LearningFlowEntry) {
    const firstPage = entry.pageIds.find((pageId) => pages.some((page) => page.id === pageId));
    if (firstPage) {
      setSelectedId(firstPage);
      setStatus(`${entry.documentName} ${entry.pageNumber}쪽의 촉각 구조도 세트를 열었습니다.`);
    }
  }

  async function convertReviewedCandidates(merge: boolean) {
    const selected = pdfCandidates.filter((candidate) => candidate.selected).sort((left, right) => left.documentOrder - right.documentOrder || left.pageNumber - right.pageNumber || left.label.localeCompare(right.label));
    if (!selected.length) {
      setStatus("변환할 그림 후보를 하나 이상 선택해 주세요.");
      return;
    }
    setIsGenerating(true);
    try {
      let sources: SourceInput[];
      let flowEntries: Omit<LearningFlowEntry, "pageIds">[];
      if (!merge) {
        sources = selected.map((candidate) => ({ source: candidate.source, label: candidate.label, documentId: candidate.documentId, documentName: candidate.documentName, documentOrder: candidate.documentOrder, pdfPageNumber: candidate.pageNumber, candidateIds: [candidate.id] }));
        flowEntries = selected.map((candidate) => ({ id: createId(), documentId: candidate.documentId, documentName: candidate.documentName, documentOrder: candidate.documentOrder, pageNumber: candidate.pageNumber, label: candidate.label, source: candidate.source, candidateIds: [candidate.id], description: `${candidate.documentName} ${candidate.pageNumber}쪽에서 선택한 그림 후보입니다.` }));
      } else {
        const pagesByNumber = new Map<string, PdfFigureCandidate[]>();
        selected.forEach((candidate) => {
          const key = `${candidate.documentId}-${candidate.pageNumber}`;
          pagesByNumber.set(key, [...(pagesByNumber.get(key) ?? []), candidate]);
        });
        const groups: PdfFigureCandidate[][] = Array.from(pagesByNumber.values());
        const merged = await Promise.all(groups.map(async (group: PdfFigureCandidate[]) => {
          const left = Math.min(...group.map((candidate) => candidate.crop.x));
          const top = Math.min(...group.map((candidate) => candidate.crop.y));
          const right = Math.max(...group.map((candidate) => candidate.crop.x + candidate.crop.width));
          const bottom = Math.max(...group.map((candidate) => candidate.crop.y + candidate.crop.height));
          const crop = { x: left, y: top, width: right - left, height: bottom - top, rotation: 0 };
          return {
            source: await sourceFromCrop(group[0].pagePreview, crop),
            label: `${group[0].documentName.replace(/\.pdf$/i, "")} · ${group[0].pageNumber}쪽 선택 그림 ${group.length}개 병합`,
            documentId: group[0].documentId,
            documentName: group[0].documentName,
            documentOrder: group[0].documentOrder,
            pdfPageNumber: group[0].pageNumber,
            candidateIds: group.map((candidate) => candidate.id),
          };
        }));
        sources = merged;
        flowEntries = merged.map((source) => ({ id: createId(), documentId: source.documentId ?? "", documentName: source.documentName ?? source.label, documentOrder: source.documentOrder ?? 0, pageNumber: source.pdfPageNumber ?? 0, label: source.label, source: source.source, candidateIds: source.candidateIds ?? [], description: `${source.documentName} ${source.pdfPageNumber}쪽의 선택 그림 ${source.candidateIds?.length ?? 1}개를 하나의 학습 원본으로 병합했습니다.` }));
      }
      const title = batchDocuments.length > 1 ? `${batchDocuments.length}개 PDF 일괄 촉각 구조도` : (selected[0]?.documentName ?? reviewFileName).replace(/\.pdf$/i, "");
      await generateSourceWorkflow(sources, title, flowEntries);
    } catch {
      setStatus("선택한 그림 후보를 변환하지 못했습니다.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handlePdfBatch(files: File[]) {
    const pdfFiles = files.filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    if (!pdfFiles.length) {
      setStatus("PDF 파일을 하나 이상 선택해 주세요.");
      return;
    }
    setIsLoading(true);
    const startOrder = batchDocuments.length;
    const queued = pdfFiles.map((file, index): BatchDocument => ({ id: createId(), name: file.name, order: startOrder + index, candidateCount: 0, selectedCount: 0, status: "queued" }));
    setBatchDocuments((current) => [...current, ...queued]);
    let totalCandidates = 0;
    let completed = 0;
    try {
      for (let index = 0; index < pdfFiles.length; index += 1) {
        const file = pdfFiles[index];
        const queuedDocument = queued[index];
        setBatchDocuments((current) => current.map((document) => document.id === queuedDocument.id ? { ...document, status: "analyzing" } : document));
        setStatus(`일괄 대기열 ${index + 1}/${pdfFiles.length}: ${file.name} 분석 중…`);
        try {
          const candidates = await processPdf(file, queuedDocument);
          totalCandidates += candidates.length;
          completed += 1;
          setPdfCandidates((current) => {
            const next = [...current, ...candidates];
            updateBatchCounts(next);
            return next;
          });
          setBatchDocuments((current) => current.map((document) => document.id === queuedDocument.id ? { ...document, status: "ready", candidateCount: candidates.length, selectedCount: candidates.length } : document));
        } catch (error) {
          setBatchDocuments((current) => current.map((document) => document.id === queuedDocument.id ? { ...document, status: "error", error: error instanceof Error ? error.message : "분석 실패" } : document));
        }
      }
      setReviewFileName(pdfFiles.length === 1 ? pdfFiles[0].name : `${pdfFiles.length}개 PDF 일괄 대기열`);
      setShowTextOverlay(false);
      setStatus(`${completed}/${pdfFiles.length}개 PDF에서 총 ${totalCandidates}개 그림 후보를 대기열에 추가했습니다. 후보를 검토해 변환을 시작하세요.`);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleFile(file?: File) {
    if (!file) return;
    setIsLoading(true);
    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        setIsLoading(false);
        await handlePdfBatch([file]);
        return;
      } else if (file.type.startsWith("image/")) {
        const source = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("이미지를 읽을 수 없습니다."));
          reader.readAsDataURL(file);
        });
        await generateSourceWorkflow([{ source, label: file.name.replace(/\.[^.]+$/, "") }], file.name.replace(/\.[^.]+$/, ""));
      } else {
        throw new Error("PNG, JPG, WebP 또는 PDF 파일만 지원합니다.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "파일을 처리하지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }

  async function regenerateAllPages() {
    if (!sourceSets.length) {
      setStatus("먼저 이미지 또는 PDF를 올려 주세요.");
      return;
    }
    setIsGenerating(true);
    try {
      const currentSourceKey = activePage?.sourceKey;
      const currentKind = activePage?.kind;
      const generated = await makeAutoPages(sourceSets);
      recordHistory();
      setPages(generated);
      const replacement = generated.find((page) => page.sourceKey === currentSourceKey && page.kind === currentKind) ?? generated[0];
      setSelectedId(replacement.id);
      setStatus("현재 변환 설정으로 3페이지 촉각 구조도 초안을 다시 만들었습니다.");
    } catch {
      setStatus("자동 초안을 다시 만들 수 없습니다. 파일을 다시 올려 주세요.");
    } finally {
      setIsGenerating(false);
    }
  }

  function selectFocusCrop(crop: Crop) {
    if (!activeSourceSet) return;
    recordHistory();
    const updatedSet = { ...activeSourceSet, selectedCrop: constrainCrop(crop) };
    setSourceSets((current) => current.map((item) => (item.id === updatedSet.id ? updatedSet : item)));
    void refreshFocusPage(updatedSet);
  }

  function updateFocusCrop(patch: Partial<Crop>) {
    if (!activeSourceSet) return;
    selectFocusCrop({ ...activeSourceSet.selectedCrop, ...patch });
  }

  function selectFocusAt(centerX: number, centerY: number) {
    if (!activeSourceSet) return;
    selectFocusCrop(cropFromCenter(centerX, centerY, activeSourceSet.selectedCrop.width, activeSourceSet.aspect, activeSourceSet.selectedCrop.rotation));
  }

  function changeFocusScale(width: number) {
    if (!activeSourceSet) return;
    const center = cropCenter(activeSourceSet.selectedCrop);
    selectFocusCrop(cropFromCenter(center.x, center.y, width, activeSourceSet.aspect, activeSourceSet.selectedCrop.rotation));
  }

  function downloadDtms() {
    const payload = {
      title: fileTitle.trim() || "나의 촉각 도식",
      lang: "korean",
      langOption: "2",
      pages: pages.map((page) => ({
        pageTitle: page.title.trim() || "촉각 도식",
        altText: page.altText.trim(),
        bitmapHex: gridToBitmapHex(page.grid),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${payload.title.replace(/[\\/:*?\"<>|]/g, "-")}.dtms`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("DTMS 파일을 저장했습니다. Dot Canvas에서 ‘열기’로 불러오세요.");
  }

  function resetActiveGrid() {
    if (!activePage) return;
    recordHistory();
    updateActivePage({ grid: EMPTY_GRID() });
    setStatus("현재 페이지의 점을 모두 지웠습니다. 원본과 페이지 설정은 유지됩니다.");
  }

  function addBlankPage() {
    const page = createBlankPage(`수동 촉각 도식 ${pages.length + 1}`);
    recordHistory();
    setPages((current) => [...current, page]);
    setSelectedId(page.id);
  }

  function duplicatePage() {
    if (!activePage) return;
    const copy = { ...activePage, id: createId(), title: `${activePage.title} 복사본`, grid: cloneGrid(activePage.grid) };
    recordHistory();
    setPages((current) => [...current, copy]);
    setSelectedId(copy.id);
  }

  function deleteActivePage() {
    if (!activePage || pages.length === 1) {
      resetActiveGrid();
      return;
    }
    const index = pages.findIndex((page) => page.id === activePage.id);
    const next = pages.filter((page) => page.id !== activePage.id);
    recordHistory();
    setPages(next);
    setSelectedId(next[Math.max(0, index - 1)].id);
  }

  return (
    <div className="min-h-screen bg-[#f5f7f6] text-slate-900">
      <header className="border-b border-slate-200/90 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#17352b] shadow-[0_8px_18px_rgba(23,53,43,.22)]">
              <Grid3X3 className="h-5 w-5 text-[#f4ca68]" aria-hidden="true" />
            </div>
            <div>
              <p className="font-display text-lg leading-none tracking-tight text-[#17352b]">Tactile DTMS Studio</p>
              <p className="mt-1 text-[11px] font-medium tracking-[0.12em] text-slate-500">DOT PAD 320 · 60 × 40</p>
            </div>
          </div>
          <div aria-live="polite" className="hidden items-center gap-2 text-xs text-slate-500 md:flex">
            <span className="h-2 w-2 rounded-full bg-emerald-500" /> {savedLabel}
          </div>
          <div className="flex items-center gap-2">
            <Button size="icon" variant="outline" className="h-9 w-9 rounded-xl border-slate-200 bg-white" title="현재 작업 임시 저장" aria-label="현재 작업 임시 저장" onClick={saveTemporaryDraftNow} disabled={isSavingDraft}><Save className={cn("h-4 w-4", isSavingDraft && "animate-pulse")} /></Button>
            <Button size="icon" variant="outline" className="h-9 w-9 rounded-xl border-slate-200 bg-white" title="실행 취소" aria-label="실행 취소" onClick={undoWorkspace} disabled={!undoCount}><Undo2 className="h-4 w-4" /></Button>
            <Button size="icon" variant="outline" className="h-9 w-9 rounded-xl border-slate-200 bg-white" title="다시 실행" aria-label="다시 실행" onClick={redoWorkspace} disabled={!redoCount}><Redo2 className="h-4 w-4" /></Button>
            <Button className="rounded-xl bg-[#17352b] px-4 text-white hover:bg-[#244b3d]" onClick={downloadDtms}>
              <Download className="mr-2 h-4 w-4" /> DTMS 저장
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 py-7 lg:px-8">
        <section className="mb-7 flex flex-col justify-between gap-4 rounded-[24px] border border-[#d9e3df] bg-[radial-gradient(circle_at_75%_20%,#f8eac8_0%,transparent_25%),linear-gradient(130deg,#e9f2ee_0%,#fdfcf8_58%,#f6f3ed_100%)] px-6 py-6 shadow-sm lg:flex-row lg:items-end lg:px-8">
          <div className="max-w-2xl">
            <p className="mb-2 text-xs font-bold tracking-[0.16em] text-[#557469]">촉각 교육용 구조도 만들기</p>
            <h1 className="font-display text-3xl tracking-tight text-[#17352b] sm:text-4xl">한 장의 이미지에서<br className="hidden sm:block" /> 세 단계 촉각 구조도를 만드세요.</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">업로드 즉시 전체 형태·구조 구분·핵심 부위 확대 초안을 만들고, 원본에서 직접 핵심 위치를 선택해 세 번째 페이지를 바꾼 뒤 Dot Pad용 DTMS로 저장합니다.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-medium text-[#315c4d]">
            <span className="rounded-full border border-[#bdd4c9] bg-white/70 px-3 py-1.5">무료 · 계정 불필요</span>
            <span className="rounded-full border border-[#bdd4c9] bg-white/70 px-3 py-1.5">3페이지 자동 초안</span>
            <span className="rounded-full border border-[#bdd4c9] bg-white/70 px-3 py-1.5">여러 PDF 일괄 검토</span>
            <span className="rounded-full border border-[#bdd4c9] bg-white/70 px-3 py-1.5">클릭하여 핵심 부위 선택</span>
          </div>
        </section>

        {(pdfCandidates.length > 0 || batchDocuments.length > 0) && (
          <section className="mb-7 overflow-hidden rounded-[24px] border border-[#b8d5c7] bg-white shadow-[0_14px_28px_rgba(31,73,57,.08)]">
            <div className="flex flex-col gap-4 border-b border-[#dcebe3] bg-[linear-gradient(120deg,#eaf4ef_0%,#fdfbf3_100%)] px-5 py-5 lg:flex-row lg:items-center lg:justify-between lg:px-6">
              <div className="flex gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#17352b] text-[#f4ca68]"><FileImage className="h-5 w-5" /></div>
                <div>
                  <p className="text-sm font-bold text-[#17352b]">PDF 그림 후보 일괄 검토</p>
                  <p className="mt-1 text-xs leading-5 text-[#527267]"><strong>{reviewFileName}</strong> 대기열에서 감지한 {pdfCandidates.length}개 후보입니다. 파일 순서대로 후보를 고르고, 같은 PDF 페이지의 선택 그림은 하나의 원본으로 병합할 수 있습니다.</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="h-9 rounded-xl border-[#b7d4c5] bg-white text-xs" onClick={() => batchUploadRef.current?.click()} disabled={isLoading}><Files className="mr-1.5 h-3.5 w-3.5" />PDF 추가</Button>
                <Button variant="outline" className="h-9 rounded-xl border-[#b7d4c5] bg-white text-xs" onClick={() => setAllCandidates(true)}>모두 포함</Button>
                <Button variant="outline" className="h-9 rounded-xl border-[#b7d4c5] bg-white text-xs" onClick={() => setAllCandidates(false)}>모두 제외</Button>
                <Button variant="outline" className={cn("h-9 rounded-xl border-[#b7d4c5] bg-white text-xs", showTextOverlay && "bg-[#17352b] text-white hover:bg-[#244b3d] hover:text-white")} onClick={() => setShowTextOverlay((current) => !current)}>{showTextOverlay ? <EyeOff className="mr-1.5 h-3.5 w-3.5" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}{showTextOverlay ? "본문 제외 영역 숨기기" : "본문 제외 영역 보기"}</Button>
              </div>
            </div>

            <div className="grid gap-2 border-b border-[#dcebe3] bg-[#fbfdfb] px-5 py-4 sm:grid-cols-2 lg:grid-cols-3 lg:px-6">
              {batchDocuments.map((document, index) => (
                <div key={document.id} className={cn("flex items-center gap-3 rounded-xl border px-3 py-2.5", document.status === "error" ? "border-rose-200 bg-rose-50" : document.status === "analyzing" ? "border-[#e9c66e] bg-[#fffaf0]" : "border-[#d8e7df] bg-white")}>
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#17352b] text-[11px] font-bold text-[#f4ca68]">{index + 1}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-[#17352b]">{document.name}</span><span className="mt-0.5 block text-[10px] text-slate-500">{document.status === "analyzing" ? "그림·본문 영역 분석 중…" : document.status === "error" ? document.error ?? "분석 실패" : `${document.candidateCount}개 후보 · ${document.selectedCount}개 포함`}</span></span>
                  {document.status === "analyzing" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#b57d16]" />}
                </div>
              ))}
            </div>

            <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3 lg:p-6">
              {pdfCandidates.map((candidate, index) => (
                <article key={candidate.id} className={cn("overflow-hidden rounded-2xl border bg-white transition", candidate.selected ? "border-[#5a9a79] shadow-[0_8px_20px_rgba(41,103,76,.12)]" : "border-slate-200 opacity-65")}> 
                  <CandidateBoundaryEditor source={candidate.pagePreview} crop={candidate.crop} textRegions={candidate.textRegions} showTextOverlay={showTextOverlay} documentLabel={`${candidate.documentName} · ${candidate.pageNumber}쪽 · 후보 ${index + 1}`} detection={candidate.detection} onCommit={(crop) => void updateCandidateBoundary(candidate.id, crop)} />
                  <div className="p-3">
                    <div className="flex items-start gap-3">
                      <img className="h-16 w-20 rounded-lg border border-slate-200 bg-[#fafbf9] object-contain" src={candidate.source} alt={`${candidate.label} 추출 이미지`} />
                      <div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-slate-700">{candidate.label}</p><p className="mt-1 text-[11px] leading-4 text-slate-500"><PencilRuler className="mr-1 inline h-3 w-3 text-[#b57d16]" />노란 경계를 드래그하고 모서리를 움직여 추출 영역을 보정합니다.</p></div>
                    </div>
                    <Button variant={candidate.selected ? "default" : "outline"} className={cn("mt-3 h-8 w-full rounded-lg text-xs", candidate.selected ? "bg-[#17352b] text-white hover:bg-[#244b3d]" : "border-slate-200 text-slate-600")} onClick={() => toggleCandidate(candidate.id)}>{candidate.selected ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <X className="mr-1.5 h-3.5 w-3.5" />}{candidate.selected ? "변환에 포함" : "변환에서 제외"}</Button>
                  </div>
                </article>
              ))}
            </div>

            <div className="flex flex-col gap-3 border-t border-[#dcebe3] bg-[#f8fbf9] px-5 py-4 sm:flex-row sm:items-center sm:justify-between lg:px-6">
              <p className="text-xs leading-5 text-[#527267]"><strong className="text-[#17352b]">{pdfCandidates.filter((candidate) => candidate.selected).length}개 선택됨.</strong> 개별 변환은 그림마다 3페이지를 생성하고, 병합 변환은 같은 페이지의 선택 영역을 하나의 원본으로 합칩니다.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="rounded-xl border-[#9ec3af] bg-white text-xs text-[#17352b]" onClick={() => void convertReviewedCandidates(false)} disabled={isGenerating}><FilePlus2 className="mr-1.5 h-3.5 w-3.5" />개별 변환</Button>
                <Button className="rounded-xl bg-[#e0a93a] text-xs font-bold text-[#17352b] hover:bg-[#f1bd51]" onClick={() => void convertReviewedCandidates(true)} disabled={isGenerating}>{isGenerating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Layers3 className="mr-1.5 h-3.5 w-3.5" />}선택 병합 변환</Button>
              </div>
            </div>
          </section>
        )}

        {learningFlow.length > 0 && (
          <section className="mb-7 overflow-hidden rounded-[24px] border border-[#cadcd4] bg-white shadow-[0_14px_28px_rgba(31,73,57,.08)]">
            <div className="flex flex-col gap-3 border-b border-[#dcebe3] bg-[linear-gradient(120deg,#f1f7f3_0%,#fdf9ea_100%)] px-5 py-5 lg:flex-row lg:items-center lg:justify-between lg:px-6">
              <div className="flex gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#17352b] text-[#f4ca68]"><BookOpen className="h-5 w-5" /></div>
                <div><p className="text-sm font-bold text-[#17352b]">PDF → 촉각 학습 흐름</p><p className="mt-1 text-xs leading-5 text-[#527267]">PDF 파일·페이지 순서를 유지해, 각 그림의 설명과 연결된 전체·구조·확대 촉각 페이지를 확인합니다.</p></div>
              </div>
              <span className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-[#315c4d] shadow-sm">{learningFlow.length}개 학습 단위 · {learningFlow.reduce((total, entry) => total + entry.pageIds.length, 0)}개 촉각 페이지</span>
            </div>
            <div className="space-y-0 divide-y divide-[#e3ece7]">
              {learningFlow.slice().sort((left, right) => left.documentOrder - right.documentOrder || left.pageNumber - right.pageNumber).map((entry, index) => {
                const tactilePages = entry.pageIds.map((pageId) => pages.find((page) => page.id === pageId)).filter((page): page is TactilePage => Boolean(page));
                return (
                  <article key={entry.id} className="grid gap-4 px-5 py-5 lg:grid-cols-[42px_148px_minmax(0,1fr)_minmax(280px,.95fr)] lg:items-center lg:px-6">
                    <div className="flex lg:flex-col lg:items-center"><span className="grid h-8 w-8 place-items-center rounded-xl bg-[#17352b] text-xs font-bold text-[#f4ca68]">{index + 1}</span><ChevronRight className="ml-2 h-4 w-4 text-[#a6bcaf] lg:ml-0 lg:mt-1 lg:rotate-90" /></div>
                    <img src={entry.source} alt={`${entry.documentName} ${entry.pageNumber}쪽에서 선택한 그림`} className="aspect-[4/3] w-full rounded-xl border border-[#d7e5de] bg-[#fbfcfa] object-contain" />
                    <div className="min-w-0"><p className="text-xs font-bold text-[#17352b]">{entry.documentName} · {entry.pageNumber}쪽</p><p className="mt-1 truncate text-[11px] font-medium text-[#527267]">{entry.label}</p><Label htmlFor={`flow-description-${entry.id}`} className="mt-3 block text-[11px] font-bold text-slate-600">그림 설명</Label><Textarea id={`flow-description-${entry.id}`} className="mt-1 min-h-20 rounded-xl border-[#d8e7df] bg-[#fbfdfb] text-xs leading-5" value={entry.description} onFocus={recordHistory} onChange={(event) => updateLearningDescription(entry.id, event.target.value)} /></div>
                    <div className="rounded-2xl border border-[#d8e7df] bg-[#f8fbf9] p-3"><p className="text-[11px] font-bold text-[#315c4d]">연결된 촉각 페이지</p><div className="mt-2 grid grid-cols-3 gap-2">{tactilePages.map((page) => <button key={page.id} onClick={() => { setSelectedId(page.id); setStatus(`${entry.documentName} ${entry.pageNumber}쪽과 연결된 ${pageInfo(page.kind).title} 페이지를 열었습니다.`); }} className={cn("rounded-lg border px-2 py-2 text-center text-[10px] font-bold transition", page.id === selectedId ? "border-[#2e7759] bg-[#17352b] text-white" : "border-[#cfe0d7] bg-white text-[#315c4d] hover:bg-[#e9f3ed]")}>{pageInfo(page.kind).title.replace(/^\d\. /, "")}</button>)}</div><Button variant="outline" className="mt-3 h-8 w-full rounded-lg border-[#a6c7b6] bg-white text-[11px] text-[#17352b]" onClick={() => openLearningEntry(entry)}>이 학습 단위 열기 <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Button></div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {activeSourceSet ? (
          <section className="mb-7 overflow-hidden rounded-[24px] border border-[#cadcd4] bg-white shadow-sm">
            <div className="flex flex-col justify-between gap-3 border-b border-[#e3ece7] bg-[#f5f9f6] px-5 py-4 sm:flex-row sm:items-center sm:px-6">
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#17352b] text-[#f4ca68]"><LocateFixed className="h-4.5 w-4.5" /></div>
                <div>
                  <h2 className="text-sm font-bold text-[#17352b]">핵심 부위 선택</h2>
                  <p className="text-xs text-slate-500">원본을 클릭하면 확대 범위가 이동하고, 3번째 촉각 페이지가 자동으로 갱신됩니다.</p>
                </div>
              </div>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-[#315c4d] shadow-sm">{activeSourceSet.label}</span>
            </div>
            <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_310px] lg:p-6">
              <FocusPicker source={activeSourceSet.source} crop={activeSourceSet.selectedCrop} onSelectCenter={selectFocusAt} onCommit={selectFocusCrop} />
              <div className="flex flex-col">
                <p className="text-xs font-bold tracking-[0.1em] text-[#507366]">자동 탐색 후보</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">경계와 색 변화가 밀집된 곳을 후보로 찾았습니다. 교육에 중요한 부분이 다르면 원본을 직접 클릭해 옮기세요.</p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {activeSourceSet.candidates.map((candidate) => {
                    const chosen = Math.abs(candidate.crop.x - activeSourceSet.selectedCrop.x) < 0.01 && Math.abs(candidate.crop.y - activeSourceSet.selectedCrop.y) < 0.01;
                    return (
                      <button key={candidate.id} onClick={() => selectFocusCrop(candidate.crop)} className={cn("rounded-xl border px-2 py-2 text-left text-xs font-bold transition", chosen ? "border-[#2e7759] bg-[#e7f2ec] text-[#17352b] shadow-sm" : "border-slate-200 bg-white text-slate-600 hover:border-[#9ab9ab]")}>{candidate.label}</button>
                    );
                  })}
                </div>
                <div className="mt-5 border-t border-slate-100 pt-4">
                  <div className="flex items-center justify-between"><p className="text-xs font-bold text-slate-700">확대 범위</p><span className="text-[11px] text-slate-500">가로·세로 독립 조절</span></div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {[
                      ["좁게", 0.34],
                      ["보통", 0.5],
                      ["넓게", 0.68],
                    ].map(([label, width]) => (
                      <button key={String(label)} onClick={() => changeFocusScale(Number(width))} className={cn("rounded-lg px-2 py-2 text-xs font-bold transition", Math.abs(activeSourceSet.selectedCrop.width - Number(width)) < 0.08 ? "bg-[#17352b] text-white" : "bg-slate-100 text-slate-600 hover:bg-[#e7f2ec]")}>{label}</button>
                    ))}
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4">
                  <CropSlider label="가로" value={Number((activeSourceSet.selectedCrop.width * 100).toFixed(1))} min={12} max={96} step={0.1} suffix="%" onChange={(value) => updateFocusCrop({ width: value / 100 })} />
                  <CropSlider label="세로" value={Number((activeSourceSet.selectedCrop.height * 100).toFixed(1))} min={12} max={96} step={0.1} suffix="%" onChange={(value) => updateFocusCrop({ height: value / 100 })} />
                </div>
                <div className="mt-3 border-t border-slate-100 pt-4">
                  <CropSlider label="회전" value={Math.round(activeSourceSet.selectedCrop.rotation)} min={-180} max={180} step={1} suffix="°" onChange={(value) => updateFocusCrop({ rotation: value })} />
                </div>
                <div className="mt-auto rounded-xl bg-[#17352b] px-3 py-3 text-xs leading-5 text-white/80">
                  <Maximize2 className="mr-1.5 inline h-3.5 w-3.5 text-[#f4ca68]" />
                  {isFocusing ? "선택한 부위를 60×40 촉각 격자로 바꾸는 중…" : "선택한 범위는 ‘3. 핵심 부위 확대’ 페이지에 반영됩니다."}
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="mb-7 grid gap-3 rounded-[24px] border border-dashed border-[#adc8ba] bg-[#eff6f2] p-5 sm:grid-cols-3 sm:p-6">
            {[
              ["1", "전체 형태", "가장 큰 외곽 형태를 우선 추립니다."],
              ["2", "구조 구분", "경계·반복 구조를 촉각선으로 바꿉니다."],
              ["3", "핵심 부위 확대", "원본에서 직접 위치를 골라 확대합니다."],
            ].map(([number, title, description]) => (
              <div key={number} className="flex gap-3 rounded-xl bg-white/70 p-3"><span className="font-display text-2xl leading-6 text-[#c28d25]">{number}</span><div><p className="text-xs font-bold text-[#17352b]">{title}</p><p className="mt-1 text-[11px] leading-4 text-slate-500">{description}</p></div></div>
            ))}
          </section>
        )}

        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className="order-2 rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm xl:order-1">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-slate-800">DTMS 페이지</p>
                <p className="text-xs text-slate-500">자동 초안과 수동 도식을 함께 저장</p>
              </div>
              <span className="grid h-7 min-w-7 place-items-center rounded-full bg-[#edf4f0] px-2 text-xs font-bold text-[#315c4d]">{pages.length}</span>
            </div>
            <div className="space-y-2">
              {pages.map((page, index) => {
                const info = pageInfo(page.kind);
                return (
                  <button key={page.id} className={cn("group flex w-full items-center gap-3 rounded-xl p-2 text-left transition", page.id === selectedId ? "bg-[#e8f1ed] ring-1 ring-[#b3cebf]" : "hover:bg-slate-50")} onClick={() => setSelectedId(page.id)}>
                    <div className="grid h-11 w-14 shrink-0 place-items-center rounded-lg border border-slate-200 bg-[#fcfcfa]"><MiniGrid grid={page.grid} /></div>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-bold text-slate-700">{page.title || `페이지 ${index + 1}`}</span>
                      <span className="mt-1 flex items-center gap-1 text-[10px] text-slate-500"><span className="rounded bg-white px-1 text-[#507366]">{info.description}</span><span>{dotCount(page.grid)}점</span></span>
                    </span>
                    {page.id === selectedId && <Check className="h-4 w-4 shrink-0 text-[#2d7a58]" />}
                  </button>
                );
              })}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button variant="outline" className="rounded-xl border-slate-200 text-xs" onClick={addBlankPage}><FilePlus2 className="mr-1.5 h-3.5 w-3.5" /> 빈 페이지</Button>
              <Button variant="outline" className="rounded-xl border-slate-200 text-xs" onClick={duplicatePage}><Layers3 className="mr-1.5 h-3.5 w-3.5" /> 복제</Button>
            </div>
            <div className="mt-6 rounded-xl bg-[#f6f7f5] p-3">
              <p className="mb-1 text-xs font-bold text-[#315c4d]">촉각 설계 팁</p>
              <p className="text-[11px] leading-5 text-slate-600">자동 결과는 초안입니다. 라벨·긴 지시선·미세한 잔선은 지우개로 빼고, 중요한 구조 사이에는 빈 공간을 남기세요.</p>
            </div>
          </aside>

          <section className="order-1 min-w-0 xl:order-2">
            <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">60 × 40 촉각 편집기</p>
                  <p className="text-xs text-slate-500">{pageInfo(activePage?.kind ?? "manual").title} · 클릭하거나 드래그해서 점을 추가·제거합니다.</p>
                </div>
                <div className="flex rounded-xl bg-slate-100 p-1">
                  <Button size="sm" variant="ghost" className={cn("h-8 rounded-lg px-3 text-xs", tool === "draw" && "bg-white shadow-sm")} onClick={() => setTool("draw")}><MousePointer2 className="mr-1.5 h-3.5 w-3.5" /> 점 찍기</Button>
                  <Button size="sm" variant="ghost" className={cn("h-8 rounded-lg px-3 text-xs", tool === "erase" && "bg-white shadow-sm")} onClick={() => setTool("erase")}><Eraser className="mr-1.5 h-3.5 w-3.5" /> 지우기</Button>
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="relative overflow-hidden rounded-2xl border border-[#d5e1db] bg-[radial-gradient(circle_at_1px_1px,rgba(23,53,43,.07)_1px,transparent_0)] [background-size:16px_16px] p-3 sm:p-5">
                  <div role="application" aria-label="60 곱하기 40 촉각 점자 격자. 클릭하여 점을 편집합니다." className="tactile-grid mx-auto aspect-[3/2] w-full max-w-[720px] touch-none select-none rounded-lg bg-[#fbfdfb] p-[2.3%] shadow-inner" onPointerDown={handleGridPointerDown} onPointerMove={handleGridPointerMove} onPointerUp={() => setIsDrawing(false)} onPointerLeave={() => setIsDrawing(false)} onPointerCancel={() => setIsDrawing(false)}>
                    {activePage?.grid.map((row, y) => row.map((raised, x) => <span key={`${x}-${y}`} className={cn("dot", raised && "dot-raised")} />))}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] font-medium text-slate-500"><span>가로 60점</span><span className="rounded-full bg-white px-2 py-1 shadow-sm">{activePage ? dotCount(activePage.grid) : 0} raised dots</span><span>세로 40점</span></div>
                </div>
                <div className="space-y-3">
                  <div className="rounded-2xl border border-slate-200 bg-[#fbfcfb] p-3">
                    <p className="mb-2 text-xs font-bold text-slate-700">현재 원본</p>
                    {sourceImage ? <img className="aspect-[3/2] w-full rounded-lg border border-slate-200 bg-white object-contain" src={sourceImage} alt="업로드한 원본" /> : <div className="grid aspect-[3/2] place-items-center rounded-lg border border-dashed border-slate-300 bg-white px-3 text-center text-[11px] leading-4 text-slate-400">업로드하면 원본이 이곳에 표시됩니다</div>}
                  </div>
                  <div className="rounded-2xl bg-[#17352b] p-3 text-white">
                    <p className="text-xs font-bold">편집 브러시</p>
                    <div className="mt-3 flex gap-2">{[1, 3].map((size) => <button key={size} onClick={() => setBrushSize(size)} className={cn("grid h-8 flex-1 place-items-center rounded-lg text-xs font-bold transition", brushSize === size ? "bg-[#f4ca68] text-[#17352b]" : "bg-white/10 text-white/80 hover:bg-white/20")}>{size === 1 ? "1점" : "3×3"}</button>)}</div>
                    <Button variant="ghost" className="mt-3 h-8 w-full rounded-lg text-xs text-white hover:bg-white/10 hover:text-white" onClick={resetActiveGrid}><RotateCcw className="mr-1.5 h-3.5 w-3.5" /> 이 페이지 비우기</Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center gap-2"><FileText className="h-4 w-4 text-[#507366]" /><p className="text-sm font-bold text-slate-800">DTMS 설명</p></div>
                <Label htmlFor="page-title" className="text-xs font-semibold text-slate-600">페이지 제목</Label>
                <Input id="page-title" className="mt-1.5 rounded-xl border-slate-200" value={activePage?.title ?? ""} onFocus={recordHistory} onChange={(event) => updateActivePage({ title: event.target.value })} />
                <Label htmlFor="alt-text" className="mt-4 block text-xs font-semibold text-slate-600">대체 설명</Label>
                <Textarea id="alt-text" className="mt-1.5 min-h-24 rounded-xl border-slate-200 text-sm" placeholder="이 촉각 도식에 표시한 구조와 위치 관계를 간략히 설명하세요." value={activePage?.altText ?? ""} onFocus={recordHistory} onChange={(event) => updateActivePage({ altText: event.target.value })} />
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center gap-2"><CircleHelp className="h-4 w-4 text-[#507366]" /><p className="text-sm font-bold text-slate-800">내보내기 전 확인</p></div>
                <ul className="space-y-2.5 text-xs leading-5 text-slate-600">
                  <li className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />전체 → 구조 → 확대 순서가 학습 목적에 맞는지</li>
                  <li className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />텍스트·긴 지시선과 미세 잡음을 지웠는지</li>
                  <li className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />Dot Canvas에서는 ‘추가’가 아닌 ‘열기’를 사용할지</li>
                </ul>
                <div className="mt-4 flex gap-2"><Button variant="outline" className="flex-1 rounded-xl border-slate-200 text-xs" onClick={deleteActivePage}><Trash2 className="mr-1.5 h-3.5 w-3.5" /> 삭제</Button><Button className="flex-1 rounded-xl bg-[#e0a93a] text-[#17352b] hover:bg-[#f1bd51]" onClick={downloadDtms}><Download className="mr-1.5 h-3.5 w-3.5" /> 저장</Button></div>
              </div>
            </div>
          </section>

          <aside className="order-3 space-y-5">
            <section className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-2"><WandSparkles className="h-4 w-4 text-[#b57d16]" /><h2 className="text-sm font-bold text-slate-800">자동 초안 설정</h2></div>
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1"><button className={cn("rounded-lg px-3 py-2 text-xs font-bold transition", mode === "edges" && "bg-white text-[#17352b] shadow-sm")} onClick={() => setMode("edges")}>윤곽 우선</button><button className={cn("rounded-lg px-3 py-2 text-xs font-bold transition", mode === "filled" && "bg-white text-[#17352b] shadow-sm")} onClick={() => setMode("filled")}>면적 우선</button></div>
              <SettingSlider label="감도" value={threshold} min={60} max={220} onChange={setThreshold} description={mode === "edges" ? "경계·색 변화 감지 수준" : "어두운 영역을 채우는 수준"} />
              <SettingSlider label="잡음 정리" value={simplification} min={0} max={3} onChange={setSimplification} description="작은 점 군집과 빈틈을 정리합니다" />
              <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4"><div><p className="text-xs font-bold text-slate-700">흑백 반전</p><p className="mt-0.5 text-[11px] text-slate-500">밝은 형태를 점으로 변환</p></div><Switch checked={invert} onCheckedChange={setInvert} /></div>
              <Button className="mt-5 w-full rounded-xl bg-[#e6b346] text-xs font-bold text-[#17352b] hover:bg-[#f3c85f]" onClick={regenerateAllPages} disabled={!sourceSets.length || isGenerating}>{isGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}{isGenerating ? "3페이지 생성 중" : "3페이지 다시 생성"}</Button>
            </section>

            <section className="rounded-[22px] border border-dashed border-[#a9c8bb] bg-[#eff6f2] p-5">
              <input ref={uploadRef} aria-label="이미지 또는 PDF 파일 선택" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="pointer-events-none absolute h-px w-px opacity-0" onChange={(event) => handleFile(event.target.files?.[0])} />
              <input ref={batchUploadRef} aria-label="여러 PDF 파일 대기열 선택" type="file" accept="application/pdf,.pdf" multiple className="pointer-events-none absolute h-px w-px opacity-0" onChange={(event) => { void handlePdfBatch(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-white text-[#2d7056] shadow-sm"><ImageUp className="h-5 w-5" /></div>
              <h2 className="mt-3 text-sm font-bold text-[#17352b]">원본 불러오기</h2>
              <p className="mt-1 text-xs leading-5 text-[#527267]">PNG, JPG, WebP 또는 PDF 전체 페이지에서 3단계 촉각 구조도를 만듭니다. PDF는 텍스트 레이어를 제외하고, 스캔본은 OCR로 문자 영역을 찾습니다.</p>
              <Button className="mt-4 w-full rounded-xl bg-[#17352b] text-white hover:bg-[#244b3d]" onClick={() => uploadRef.current?.click()} disabled={isLoading}>{isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}{isLoading ? "분석 중…" : "파일 선택"}</Button>
              <Button variant="outline" className="mt-2 w-full rounded-xl border-[#9fc3b1] bg-white text-xs text-[#17352b] hover:bg-[#f9fcfa]" onClick={() => batchUploadRef.current?.click()} disabled={isLoading}><Files className="mr-2 h-4 w-4 text-[#2d7056]" />여러 PDF 대기열에 추가</Button>
              <p className="mt-2 text-[10px] leading-4 text-[#527267]">여러 PDF를 선택하면 파일 순서대로 분석한 뒤, 모든 그림 후보를 하나의 검토 목록에 모읍니다.</p>
              {lastSavedAt && <Button variant="ghost" className="mt-2 h-8 w-full rounded-lg text-[11px] text-[#527267] hover:bg-white/70 hover:text-[#17352b]" onClick={clearTemporaryDraft}><Trash2 className="mr-1.5 h-3.5 w-3.5" />브라우저 임시 저장 삭제</Button>}
              <p aria-live="polite" className="mt-3 text-[11px] leading-4 text-[#527267]">{status}</p>
            </section>

            <section className="rounded-[22px] bg-[#17352b] p-5 text-white shadow-[0_14px_28px_rgba(23,53,43,.16)]">
              <p className="text-xs font-bold tracking-[0.12em] text-[#f4ca68]">자동화 범위</p>
              <ol className="mt-3 space-y-3 text-xs leading-5 text-white/80">
                <li className="flex gap-2"><span className="font-display text-lg leading-5 text-[#f4ca68]">1</span><span>전체 형태는 가장 큰 전경 영역의 외곽선을 추립니다.</span></li>
                <li className="flex gap-2"><span className="font-display text-lg leading-5 text-[#f4ca68]">2</span><span>구조 구분은 색·명암·윤곽의 변화로 초안을 만듭니다.</span></li>
                <li className="flex gap-2"><span className="font-display text-lg leading-5 text-[#f4ca68]">3</span><span>핵심 부위는 사용자가 선택하므로 학습 목적을 직접 반영할 수 있습니다.</span></li>
              </ol>
            </section>
          </aside>
        </div>

        <section className="mt-7 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-xs text-slate-500 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2"><FileImage className="h-4 w-4 text-[#507366]" /><span>원본 파일은 서버로 전송되지 않으며, 이 브라우저 탭 안에서만 변환됩니다.</span></div>
          <a className="inline-flex items-center font-bold text-[#2d7056] hover:text-[#17352b]" href="https://dot.apps-dotincorp.com/canvas" target="_blank" rel="noreferrer">Dot Canvas 열기 <ArrowRight className="ml-1 h-3.5 w-3.5" /></a>
        </section>
      </main>
    </div>
  );
}

function FocusPicker({ source, crop, onSelectCenter, onCommit }: { source: string; crop: Crop; onSelectCenter: (x: number, y: number) => void; onCommit: (crop: Crop) => void }) {
  type CropInteraction = { type: "move" | "resize" | "rotate"; handle?: "nw" | "ne" | "se" | "sw"; startX: number; startY: number; origin: Crop };
  const pickerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(crop);
  const draftRef = useRef(crop);
  const interactionRef = useRef<CropInteraction | null>(null);

  useEffect(() => {
    draftRef.current = crop;
    setDraft(crop);
  }, [crop]);

  function updateDraft(next: Crop) {
    const constrained = constrainCrop(next);
    draftRef.current = constrained;
    setDraft(constrained);
  }

  function point(event: React.PointerEvent<HTMLElement>) {
    const bounds = pickerRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0.5, y: 0.5 };
    return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
  }

  function choosePosition(event: React.PointerEvent<HTMLDivElement>) {
    if (interactionRef.current) return;
    const selected = point(event);
    onSelectCenter(selected.x, selected.y);
  }

  function beginInteraction(event: React.PointerEvent<HTMLElement>, type: "move" | "resize" | "rotate", handle?: "nw" | "ne" | "se" | "sw") {
    event.preventDefault();
    event.stopPropagation();
    const start = point(event);
    interactionRef.current = { type, handle, startX: start.x, startY: start.y, origin: draftRef.current };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable for synthetic events; the picker still tracks the drag.
    }
  }

  function updateInteraction(event: React.PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const current = point(event);
    const deltaX = current.x - interaction.startX;
    const deltaY = current.y - interaction.startY;
    let next = interaction.origin;

    if (interaction.type === "move") {
      next = { ...interaction.origin, x: interaction.origin.x + deltaX, y: interaction.origin.y + deltaY };
    }
    if (interaction.type === "resize") {
      const { origin, handle } = interaction;
      if (handle === "nw") next = { ...origin, x: origin.x + deltaX, y: origin.y + deltaY, width: origin.width - deltaX, height: origin.height - deltaY };
      if (handle === "ne") next = { ...origin, y: origin.y + deltaY, width: origin.width + deltaX, height: origin.height - deltaY };
      if (handle === "se") next = { ...origin, width: origin.width + deltaX, height: origin.height + deltaY };
      if (handle === "sw") next = { ...origin, x: origin.x + deltaX, width: origin.width - deltaX, height: origin.height + deltaY };
    }
    if (interaction.type === "rotate") {
      const center = cropCenter(interaction.origin);
      let degrees = (Math.atan2(current.y - center.y, current.x - center.x) * 180) / Math.PI + 90;
      if (degrees > 180) degrees -= 360;
      next = { ...interaction.origin, rotation: Math.round(degrees / 5) * 5 };
    }
    updateDraft(next);
  }

  function endInteraction() {
    if (!interactionRef.current) return;
    interactionRef.current = null;
    onCommit(draftRef.current);
  }

  const handles = [
    ["nw", "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"],
    ["ne", "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"],
    ["se", "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"],
    ["sw", "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"],
  ] as const;

  return (
    <div>
      <div ref={pickerRef} role="button" tabIndex={0} aria-label="원본 이미지에서 핵심 부위 선택. 확대 영역은 이동, 모서리 조절, 회전이 가능합니다." className="focus-picker relative cursor-crosshair overflow-hidden rounded-2xl border border-[#c5d8cf] bg-[#f8faf8] shadow-inner" onPointerDown={choosePosition} onPointerMove={updateInteraction} onPointerUp={endInteraction} onPointerCancel={endInteraction} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelectCenter(0.5, 0.5); }}>
        <img className="block h-auto w-full select-none" src={source} alt="핵심 부위 선택용 원본 이미지" draggable={false} />
        <div className="absolute border-2 border-[#f4ca68] bg-[#f4ca68]/10 shadow-[0_0_0_9999px_rgba(9,28,20,.42)]" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.width * 100}%`, height: `${draft.height * 100}%`, transform: `rotate(${draft.rotation}deg)`, transformOrigin: "center" }}>
          <button type="button" aria-label="확대 영역 이동" className="absolute inset-0 cursor-move" onPointerDown={(event) => beginInteraction(event, "move")} />
          <span className="pointer-events-none absolute -top-7 left-0 whitespace-nowrap rounded-md bg-[#17352b] px-2 py-1 text-[10px] font-bold text-white">확대 영역</span>
          <span className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-[#17352b]/80"><span className="absolute left-1/2 top-0 h-full border-l border-white/80" /><span className="absolute left-0 top-1/2 w-full border-t border-white/80" /></span>
          {handles.map(([handle, position]) => <button key={handle} type="button" aria-label={`확대 영역 ${handle} 모서리 크기 조절`} className={cn("absolute z-10 h-4 w-4 rounded-sm border-2 border-[#17352b] bg-[#f4ca68] shadow-sm", position)} onPointerDown={(event) => beginInteraction(event, "resize", handle)} />)}
          <span className="pointer-events-none absolute left-1/2 -top-8 h-7 border-l-2 border-[#f4ca68]" />
          <button type="button" aria-label="확대 영역 회전" className="absolute left-1/2 -top-11 z-10 h-5 w-5 -translate-x-1/2 rounded-full border-2 border-[#17352b] bg-[#f4ca68] shadow-sm cursor-grab active:cursor-grabbing" onPointerDown={(event) => beginInteraction(event, "rotate")} />
        </div>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] leading-4 text-slate-500"><ScanSearch className="h-3.5 w-3.5 text-[#507366]" />원본을 클릭하면 중심을 이동합니다. 박스를 드래그하고, 모서리로 크기를, 위쪽 원으로 회전을 조절하세요.</p>
    </div>
  );
}

function CandidateBoundaryEditor({ source, crop, textRegions, showTextOverlay, documentLabel, detection, onCommit }: { source: string; crop: Crop; textRegions: TextRegion[]; showTextOverlay: boolean; documentLabel: string; detection: PdfFigureCandidate["detection"]; onCommit: (crop: Crop) => void }) {
  type CandidateInteraction = { type: "move" | "resize"; handle?: "nw" | "ne" | "se" | "sw"; startX: number; startY: number; origin: Crop };
  const editorRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(crop);
  const draftRef = useRef(crop);
  const interactionRef = useRef<CandidateInteraction | null>(null);

  useEffect(() => {
    draftRef.current = crop;
    setDraft(crop);
  }, [crop]);

  function point(event: React.PointerEvent<HTMLElement>) {
    const bounds = editorRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0.5, y: 0.5 };
    return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
  }

  function updateDraft(next: Crop) {
    const constrained = constrainCrop({ ...next, rotation: 0 });
    draftRef.current = constrained;
    setDraft(constrained);
  }

  function begin(event: React.PointerEvent<HTMLElement>, type: CandidateInteraction["type"], handle?: CandidateInteraction["handle"]) {
    event.preventDefault();
    event.stopPropagation();
    const start = point(event);
    interactionRef.current = { type, handle, startX: start.x, startY: start.y, origin: draftRef.current };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer capture can be unavailable. */ }
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const current = point(event);
    const deltaX = current.x - interaction.startX;
    const deltaY = current.y - interaction.startY;
    let next = interaction.origin;
    if (interaction.type === "move") next = { ...interaction.origin, x: interaction.origin.x + deltaX, y: interaction.origin.y + deltaY };
    if (interaction.type === "resize") {
      const { origin, handle } = interaction;
      if (handle === "nw") next = { ...origin, x: origin.x + deltaX, y: origin.y + deltaY, width: origin.width - deltaX, height: origin.height - deltaY };
      if (handle === "ne") next = { ...origin, y: origin.y + deltaY, width: origin.width + deltaX, height: origin.height - deltaY };
      if (handle === "se") next = { ...origin, width: origin.width + deltaX, height: origin.height + deltaY };
      if (handle === "sw") next = { ...origin, x: origin.x + deltaX, width: origin.width - deltaX, height: origin.height + deltaY };
    }
    updateDraft(next);
  }

  function end() {
    if (!interactionRef.current) return;
    interactionRef.current = null;
    onCommit(draftRef.current);
  }

  const handles = [
    ["nw", "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"],
    ["ne", "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"],
    ["se", "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"],
    ["sw", "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"],
  ] as const;

  return (
    <div ref={editorRef} aria-label={`${documentLabel} 그림 후보 경계 편집기`} className="relative overflow-hidden bg-slate-100" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <img className="block h-auto w-full select-none" src={source} alt={`${documentLabel} PDF 원본 페이지`} draggable={false} />
      <div className="pointer-events-none absolute inset-0 bg-black/10" />
      {showTextOverlay && textRegions.map((region, index) => <span key={index} className="pointer-events-none absolute border border-dashed border-[#d4713e] bg-[#f6a56f]/35" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />)}
      <div className="absolute border-2 border-[#f4ca68] bg-[#f4ca68]/15 shadow-[0_0_0_9999px_rgba(17,40,31,.28)]" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.width * 100}%`, height: `${draft.height * 100}%` }}>
        <button type="button" aria-label="그림 후보 경계 이동" className="absolute inset-0 cursor-move" onPointerDown={(event) => begin(event, "move")} />
        <span className="pointer-events-none absolute -top-7 left-0 whitespace-nowrap rounded-md bg-[#17352b] px-2 py-1 text-[10px] font-bold text-white">드래그하여 경계 이동</span>
        {handles.map(([handle, position]) => <button key={handle} type="button" aria-label={`그림 후보 ${handle} 모서리 크기 조절`} className={cn("absolute z-10 h-3.5 w-3.5 rounded-sm border-2 border-[#17352b] bg-[#f4ca68] shadow-sm", position)} onPointerDown={(event) => begin(event, "resize", handle)} />)}
      </div>
      <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-[#17352b] px-2 py-1 text-[10px] font-bold text-white">{documentLabel}</span>
      {showTextOverlay && <span className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-[#d4713e] px-2 py-1 text-[10px] font-bold text-white">{detection === "ocr" ? "OCR 본문 제외" : detection === "native" ? "PDF 텍스트 제외" : "본문 영역 없음"}</span>}
    </div>
  );
}

function CropSlider({ label, value, min, max, step = 1, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix: string; onChange: (value: number) => void }) {
  return <div><div className="flex items-center justify-between gap-2"><p className="text-[11px] font-bold text-slate-600">{label}</p><label className="flex items-center gap-1 text-[10px] font-bold text-[#315c4d]"><Input aria-label={`${label} 정밀 수치`} type="number" className="h-6 w-15 rounded-md border-[#cfe0d7] bg-white px-1.5 text-right text-[10px]" min={min} max={max} step={step} value={value} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(clamp(next, min, max)); }} />{suffix}</label></div><Slider className="mt-2" min={min} max={max} step={step} value={[value]} onValueChange={([next]) => onChange(next)} /></div>;
}

function MiniGrid({ grid }: { grid: boolean[][] }) {
  return <div className="mini-grid">{grid.map((row, y) => row.map((raised, x) => <span key={`${x}-${y}`} className={raised ? "mini-dot mini-dot-raised" : "mini-dot"} />))}</div>;
}

function SettingSlider({ label, value, min, max, onChange, description }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; description: string }) {
  return <div className="mt-5"><div className="flex items-center justify-between"><p className="text-xs font-bold text-slate-700">{label}</p><span className="rounded-md bg-[#edf4f0] px-1.5 py-0.5 text-[10px] font-bold text-[#315c4d]">{value}</span></div><p className="mt-1 text-[11px] text-slate-500">{description}</p><Slider className="mt-3" min={min} max={max} step={1} value={[value]} onValueChange={([next]) => onChange(next)} /></div>;
}
