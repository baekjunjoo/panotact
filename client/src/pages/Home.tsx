import { memo, useEffect, useMemo, useRef, useState } from "react";
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
  GripVertical,
  ImageUp,
  Layers3,
  Loader2,
  LocateFixed,
  Maximize2,
  MousePointer2,
  PencilRuler,
  RefreshCw,
  RotateCcw,
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
const FOCUS_FRAME_RATIO = 16 / 9;
const CANDIDATE_FRAME_RATIO = 4 / 3;
const FULL_CROP = { x: 0, y: 0, width: 1, height: 1, rotation: 0 };
const EMPTY_GRID = () => Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(false));
const imageLoadCache = new Map<string, Promise<HTMLImageElement>>();

type ConversionMode = "edges" | "filled";
type PageKind = "overall" | "structure" | "focus" | "manual";
type Crop = { x: number; y: number; width: number; height: number; rotation: number };
type FocusOutline = { points: Array<[number, number]>; crop: Crop };
type FocusCandidate = { id: string; label: string; crop: Crop; score: number };
type SourceInput = { source: string; label: string; documentId?: string; documentName?: string; documentOrder?: number; candidateOrder?: number; pdfPageNumber?: number; candidateIds?: string[] };
type TextRegion = { x: number; y: number; width: number; height: number };
type BatchDocument = { id: string; name: string; order: number; candidateCount: number; selectedCount: number; status: "queued" | "analyzing" | "ready" | "error"; error?: string };
type PdfFigureCandidate = {
  id: string;
  documentId: string;
  documentName: string;
  documentOrder: number;
  candidateOrder: number;
  source: string;
  label: string;
  pageNumber: number;
  crop: Crop;
  selected: boolean;
  textRegions: TextRegion[];
  pagePreview: string;
  detection: "native" | "ocr" | "none";
};
type LearningFlowEntry = { id: string; documentId: string; documentName: string; documentOrder: number; candidateOrder: number; pageNumber: number; label: string; source: string; candidateIds: string[]; pageIds: string[]; description: string };
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

function containedImageFrame(sourceAspect: number, frameAspect: number) {
  const aspect = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : frameAspect;
  if (aspect >= frameAspect) {
    const height = frameAspect / aspect;
    return { x: 0, y: (1 - height) / 2, width: 1, height };
  }
  const width = aspect / frameAspect;
  return { x: (1 - width) / 2, y: 0, width, height: 1 };
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

function outlineForPoint(source: HTMLImageElement, point: { x: number; y: number }): FocusOutline | null {
  const longestSide = 480;
  const scale = Math.min(1, longestSide / Math.max(source.naturalWidth, source.naturalHeight));
  const width = Math.max(1, Math.round(source.naturalWidth * scale));
  const height = Math.max(1, Math.round(source.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const startX = clamp(Math.round(point.x * (width - 1)), 0, width - 1);
  const startY = clamp(Math.round(point.y * (height - 1)), 0, height - 1);
  const colorAt = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    return [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]] as const;
  };
  const visited = new Uint8Array(width * height);
  const contains = new Uint8Array(width * height);
  const queue: number[] = [startY * width + startX];
  visited[queue[0]] = 1;
  const tolerance = 54;
  const maxPixels = Math.floor(width * height * 0.55);
  let count = 0;
  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;

  for (let queueIndex = 0; queueIndex < queue.length && count < maxPixels; queueIndex += 1) {
    const current = queue[queueIndex];
    const x = current % width;
    const y = Math.floor(current / width);
    const color = colorAt(x, y);
    contains[current] = 1;
    count += 1;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].forEach(([nextX, nextY]) => {
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) return;
      const next = nextY * width + nextX;
      const nextColor = colorAt(nextX, nextY);
      if (!visited[next] && nextColor[3] >= 20 && colorDistance(nextColor, color) <= tolerance && Math.abs(luminance(nextColor) - luminance(color)) <= 42) { visited[next] = 1; queue.push(next); }
    });
  }

  if (count < 20 || count >= maxPixels) return null;
  const leftBoundary: Array<[number, number]> = [];
  const rightBoundary: Array<[number, number]> = [];
  for (let y = minY; y <= maxY; y += 2) {
    let left = width;
    let right = -1;
    for (let x = minX; x <= maxX; x += 2) {
      const index = y * width + x;
      if (contains[index]) { left = Math.min(left, x); right = Math.max(right, x); }
    }
    if (right >= left) { leftBoundary.push([left / width, y / height]); rightBoundary.push([right / width, y / height]); }
  }
  const boundary = [...leftBoundary, ...rightBoundary.reverse()];
  if (boundary.length < 8) return null;
  const padX = Math.max(0.025, ((maxX - minX) / width) * 0.08);
  const padY = Math.max(0.025, ((maxY - minY) / height) * 0.08);
  const crop = constrainCrop({ x: minX / width - padX, y: minY / height - padY, width: (maxX - minX + 1) / width + padX * 2, height: (maxY - minY + 1) / height + padY * 2, rotation: 0 });
  return { points: boundary, crop };
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
  const nextOrderByDocument = new Map<string, number>();
  return candidates.map((candidate) => {
    const documentId = candidate.documentId || fallbackId;
    const nextOrder = nextOrderByDocument.get(documentId) ?? 0;
    nextOrderByDocument.set(documentId, nextOrder + 1);
    return {
    ...candidate,
    documentId,
    documentName: candidate.documentName || fallbackName || "이전 PDF 작업",
    documentOrder: Number.isFinite(candidate.documentOrder) ? candidate.documentOrder : 0,
    candidateOrder: Number.isFinite(candidate.candidateOrder) ? candidate.candidateOrder : nextOrder,
    };
  });
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

function normalizeLearningFlow(entries: LearningFlowEntry[]) {
  const nextOrderByDocument = new Map<string, number>();
  return entries.map((entry) => {
    const fallbackOrder = nextOrderByDocument.get(entry.documentId) ?? 0;
    nextOrderByDocument.set(entry.documentId, fallbackOrder + 1);
    return { ...entry, candidateOrder: Number.isFinite(entry.candidateOrder) ? entry.candidateOrder : fallbackOrder };
  });
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
  const cached = imageLoadCache.get(source);
  if (cached) return cached;
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
    image.src = source;
  });
  imageLoadCache.set(source, loaded);
  return loaded;
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
  const [status, setStatus] = useState("이미지 또는 PDF를 올리면 3개의 촉각 구조도 초안을 만듭니다.");
  const [isDrawing, setIsDrawing] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [pdfCandidates, setPdfCandidates] = useState<PdfFigureCandidate[]>([]);
  const [reviewFileName, setReviewFileName] = useState("");
  const [batchDocuments, setBatchDocuments] = useState<BatchDocument[]>([]);
  const [learningFlow, setLearningFlow] = useState<LearningFlowEntry[]>([]);
  const [draggedDocumentId, setDraggedDocumentId] = useState<string | null>(null);
  const [draggedCandidateId, setDraggedCandidateId] = useState<string | null>(null);
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
  const orderedDocuments = useMemo(() => [...batchDocuments].sort((left, right) => left.order - right.order), [batchDocuments]);
  const orderedCandidates = useMemo(() => [...pdfCandidates].sort((left, right) => left.documentOrder - right.documentOrder || left.candidateOrder - right.candidateOrder), [pdfCandidates]);

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
          setLearningFlow(normalizeLearningFlow(draft.learningFlow ?? []));
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

  async function refreshFocusPage(sourceSet: SourceSet, announce = true) {
    const requestId = ++focusRenderRef.current;
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
      if (announce) setStatus("핵심 부위 확대 페이지를 선택한 영역으로 갱신했습니다.");
    } catch {
      if (announce) setStatus("핵심 부위 확대를 만들 수 없습니다. 다른 위치를 선택해 주세요.");
    }
  }

  function selectFocusCanvas(sourceSet: SourceSet) {
    const focusPage = pages.find((page) => page.sourceKey === sourceSet.id && page.kind === "focus");
    if (focusPage) setSelectedId(focusPage.id);
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
            candidateOrder: candidates.length,
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
          candidateOrder: candidates.length,
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

  function reorderDocuments(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const ordered = [...batchDocuments].sort((left, right) => left.order - right.order);
    const sourceIndex = ordered.findIndex((document) => document.id === sourceId);
    const targetIndex = ordered.findIndex((document) => document.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...ordered];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    const orderByDocument = new Map(next.map((document, index) => [document.id, index]));
    recordHistory();
    setBatchDocuments(next.map((document, index) => ({ ...document, order: index })));
    setPdfCandidates((current) => current.map((candidate) => ({ ...candidate, documentOrder: orderByDocument.get(candidate.documentId) ?? candidate.documentOrder })));
    setStatus("PDF 대기열 순서를 바꿨습니다. 이후 변환과 학습 흐름에 이 순서가 적용됩니다.");
  }

  function reorderCandidates(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const source = pdfCandidates.find((candidate) => candidate.id === sourceId);
    const target = pdfCandidates.find((candidate) => candidate.id === targetId);
    if (!source || !target) return;
    if (source.documentId !== target.documentId) {
      setStatus("그림 후보는 같은 PDF 안에서 순서를 바꿀 수 있습니다. PDF 사이의 순서는 위 대기열에서 바꿔 주세요.");
      return;
    }
    const siblings = pdfCandidates.filter((candidate) => candidate.documentId === source.documentId).sort((left, right) => left.candidateOrder - right.candidateOrder);
    const sourceIndex = siblings.findIndex((candidate) => candidate.id === sourceId);
    const targetIndex = siblings.findIndex((candidate) => candidate.id === targetId);
    const next = [...siblings];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    const orderByCandidate = new Map(next.map((candidate, index) => [candidate.id, index]));
    recordHistory();
    setPdfCandidates((current) => current.map((candidate) => candidate.documentId === source.documentId ? { ...candidate, candidateOrder: orderByCandidate.get(candidate.id) ?? candidate.candidateOrder } : candidate));
    setStatus(`${source.documentName} 안에서 그림 후보 순서를 바꿨습니다.`);
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
    const selected = pdfCandidates.filter((candidate) => candidate.selected).sort((left, right) => left.documentOrder - right.documentOrder || left.candidateOrder - right.candidateOrder);
    if (!selected.length) {
      setStatus("변환할 그림 후보를 하나 이상 선택해 주세요.");
      return;
    }
    setIsGenerating(true);
    try {
      let sources: SourceInput[];
      let flowEntries: Omit<LearningFlowEntry, "pageIds">[];
      if (!merge) {
        sources = selected.map((candidate) => ({ source: candidate.source, label: candidate.label, documentId: candidate.documentId, documentName: candidate.documentName, documentOrder: candidate.documentOrder, candidateOrder: candidate.candidateOrder, pdfPageNumber: candidate.pageNumber, candidateIds: [candidate.id] }));
        flowEntries = selected.map((candidate) => ({ id: createId(), documentId: candidate.documentId, documentName: candidate.documentName, documentOrder: candidate.documentOrder, candidateOrder: candidate.candidateOrder, pageNumber: candidate.pageNumber, label: candidate.label, source: candidate.source, candidateIds: [candidate.id], description: `${candidate.documentName} ${candidate.pageNumber}쪽에서 선택한 그림 후보입니다.` }));
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
            candidateOrder: group[0].candidateOrder,
            pdfPageNumber: group[0].pageNumber,
            candidateIds: group.map((candidate) => candidate.id),
          };
        }));
        sources = merged;
        flowEntries = merged.map((source) => ({ id: createId(), documentId: source.documentId ?? "", documentName: source.documentName ?? source.label, documentOrder: source.documentOrder ?? 0, candidateOrder: source.candidateOrder ?? 0, pageNumber: source.pdfPageNumber ?? 0, label: source.label, source: source.source, candidateIds: source.candidateIds ?? [], description: `${source.documentName} ${source.pdfPageNumber}쪽의 선택 그림 ${source.candidateIds?.length ?? 1}개를 하나의 학습 원본으로 병합했습니다.` }));
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
    selectFocusCanvas(updatedSet);
    void refreshFocusPage(updatedSet);
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
    <div className="archive-shell min-h-screen bg-white text-[#111]">
      <header className="archive-header border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-5 py-3 sm:px-12">
          <div className="flex min-w-0 items-center gap-5"><span aria-hidden="true" className="arena-mark">✳</span><div className="flex min-w-0 items-baseline gap-2 text-sm tracking-[-.04em]"><h1 className="font-semibold">Panotact</h1><span className="hidden text-zinc-400 sm:inline">/</span><span className="hidden text-zinc-500 sm:inline">Workspace</span></div></div>
          <div className="flex items-center gap-1.5">
            <span aria-live="polite" className="sr-only">{savedLabel}</span>
            <Button size="icon" variant="outline" className="archive-icon-button button-morph" title="현재 작업 임시 저장" aria-label="현재 작업 임시 저장" onClick={saveTemporaryDraftNow} disabled={isSavingDraft}><Save className={cn("h-4 w-4", isSavingDraft && "animate-pulse")} /></Button>
            <Button size="icon" variant="outline" className="archive-icon-button button-rotate" title="실행 취소" aria-label="실행 취소" onClick={undoWorkspace} disabled={!undoCount}><Undo2 className="h-4 w-4" /></Button>
            <Button size="icon" variant="outline" className="archive-icon-button button-rotate" title="다시 실행" aria-label="다시 실행" onClick={redoWorkspace} disabled={!redoCount}><Redo2 className="h-4 w-4" /></Button>
            <Button className="archive-primary-button button-download ml-1" onClick={downloadDtms}><Download className="mr-2 h-4 w-4" />DTMS</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 py-9 sm:px-12 sm:py-12">
        <section className="arena-intro mb-7 grid border border-zinc-200 bg-[#f7f7f7] sm:grid-cols-[1fr_auto]">
          <div className="p-5 sm:p-8"><p className="text-[11px] font-medium uppercase tracking-[.14em] text-zinc-500">image to tactile diagram</p><p className="mt-2 text-[26px] font-medium tracking-[-.055em] text-zinc-800 sm:text-[32px]">Panotact <span className="text-zinc-400">/ Tactile workspace</span></p></div>
          <div className="flex border-t border-zinc-200 sm:border-l sm:border-t-0">
            <input ref={uploadRef} aria-label="이미지 또는 PDF 파일 선택" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="pointer-events-none absolute h-px w-px opacity-0" onChange={(event) => handleFile(event.target.files?.[0])} />
            <input ref={batchUploadRef} aria-label="여러 PDF 파일 대기열 선택" type="file" accept="application/pdf,.pdf" multiple className="pointer-events-none absolute h-px w-px opacity-0" onChange={(event) => { void handlePdfBatch(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
            <Button variant="ghost" className="archive-action-button button-upload flex-1 border-r border-zinc-200" onClick={() => uploadRef.current?.click()} disabled={isLoading}>{isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}FILE</Button>
            <Button variant="ghost" className="archive-action-button button-upload flex-1" onClick={() => batchUploadRef.current?.click()} disabled={isLoading}><Files className="mr-2 h-4 w-4" />PDFs</Button>
          </div>
        </section>

        {(pdfCandidates.length > 0 || batchDocuments.length > 0) && (
          <section className="archive-card mb-4">
            <div className="archive-section-heading"><span>QUEUE</span><span>{orderedDocuments.length} files · {pdfCandidates.length} blocks</span><div className="ml-auto flex gap-1"><Button variant="ghost" className="archive-mini-button" onClick={() => setAllCandidates(true)}>all</Button><Button variant="ghost" className="archive-mini-button" onClick={() => setAllCandidates(false)}>none</Button><Button variant="ghost" className="archive-mini-button" aria-pressed={showTextOverlay} onClick={() => setShowTextOverlay((current) => !current)}>{showTextOverlay ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</Button></div></div>
            <div className="grid divide-y divide-[#111] border-b border-[#111] sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-3">
              {orderedDocuments.map((document, index) => <div key={document.id} onDragOver={(event) => { if (draggedDocumentId) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (draggedDocumentId) reorderDocuments(draggedDocumentId, document.id); setDraggedDocumentId(null); }} className={cn("flex min-w-0 items-center gap-2 p-3 transition", draggedDocumentId === document.id && "bg-[#dfe5ff]", document.status === "error" && "bg-rose-50")}><div draggable aria-label={`${document.name} 순서 변경`} title="끌어서 PDF 순서 변경" className="archive-drag-handle" onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", document.id); setDraggedDocumentId(document.id); }} onDragEnd={() => setDraggedDocumentId(null)}><GripVertical className="h-4 w-4" /></div><span className="text-xs text-zinc-500">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0 flex-1 truncate text-xs font-medium">{document.name}</span><span className="text-[10px] text-zinc-500">{document.status === "analyzing" ? <Loader2 className="h-3 w-3 animate-spin" /> : `${document.selectedCount}/${document.candidateCount}`}</span></div>)}
            </div>
            <div className="archive-masonry p-3 sm:p-4">
              {orderedCandidates.map((candidate) => <article key={candidate.id} onDragOver={(event) => { if (draggedCandidateId) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); if (draggedCandidateId) reorderCandidates(draggedCandidateId, candidate.id); setDraggedCandidateId(null); }} className={cn("break-inside-avoid border border-[#111] bg-white transition", draggedCandidateId === candidate.id && "bg-[#dfe5ff]", !candidate.selected && "opacity-40")}><CandidateBoundaryEditor source={candidate.pagePreview} crop={candidate.crop} textRegions={candidate.textRegions} showTextOverlay={showTextOverlay} documentLabel={`${candidate.documentName} · ${candidate.pageNumber} · ${candidate.candidateOrder + 1}`} detection={candidate.detection} onCommit={(crop) => void updateCandidateBoundary(candidate.id, crop)} /><div className="flex items-center gap-2 border-t border-[#111] p-2"><div draggable aria-label={`${candidate.label} 순서 변경`} title="끌어서 그림 후보 순서 변경" className="archive-drag-handle" onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", candidate.id); setDraggedCandidateId(candidate.id); }} onDragEnd={() => setDraggedCandidateId(null)}><GripVertical className="h-4 w-4" /></div><span className="min-w-0 flex-1 truncate text-[11px]">{candidate.label}</span><Button variant="ghost" size="sm" className="archive-select-button" onClick={() => toggleCandidate(candidate.id)} aria-label={`${candidate.label} ${candidate.selected ? "변환에서 제외" : "변환에 포함"}`}>{candidate.selected ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}</Button></div></article>)}
            </div>
            <div className="flex border-t border-[#111]"><Button variant="ghost" className="archive-action-button flex-1 border-r border-[#111]" onClick={() => void convertReviewedCandidates(false)} disabled={isGenerating}><FilePlus2 className="mr-2 h-4 w-4" />INDIVIDUAL</Button><Button variant="ghost" className="archive-action-button flex-1" onClick={() => void convertReviewedCandidates(true)} disabled={isGenerating}>{isGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Layers3 className="mr-2 h-4 w-4" />}MERGE</Button></div>
          </section>
        )}

        {learningFlow.length > 0 && <section className="archive-card mb-4"><div className="archive-section-heading"><span>FLOW</span><span>{learningFlow.length}</span></div><div className="grid divide-y divide-[#111] md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-4">{learningFlow.slice().sort((left, right) => left.documentOrder - right.documentOrder || left.candidateOrder - right.candidateOrder).map((entry, index) => { const tactilePages = entry.pageIds.map((pageId) => pages.find((page) => page.id === pageId)).filter((page): page is TactilePage => Boolean(page)); return <article key={entry.id} className="p-3"><div className="flex items-center justify-between text-[10px] text-zinc-500"><span>{String(index + 1).padStart(2, "0")}</span><span>{entry.documentName} · {entry.pageNumber}</span></div><img src={entry.source} alt={`${entry.documentName} ${entry.pageNumber}쪽에서 선택한 그림`} className="mt-2 aspect-[4/3] w-full border border-[#111] object-contain" /><Textarea aria-label={`${entry.label} 그림 설명`} id={`flow-description-${entry.id}`} className="mt-2 min-h-16 border-[#111] bg-transparent text-xs" value={entry.description} onFocus={recordHistory} onChange={(event) => updateLearningDescription(entry.id, event.target.value)} /><div className="mt-2 flex gap-1">{tactilePages.map((page) => <button key={page.id} title={pageInfo(page.kind).title} aria-label={`${entry.label} ${pageInfo(page.kind).title} 열기`} onClick={() => { setSelectedId(page.id); setStatus(`${entry.documentName} ${entry.pageNumber}쪽과 연결된 ${pageInfo(page.kind).title} 페이지를 열었습니다.`); }} className={cn("archive-page-dot", page.id === selectedId && "bg-[#2f45ff] text-white")}>{pageInfo(page.kind).title.slice(0, 1)}</button>)}<Button variant="ghost" size="sm" className="archive-open-button ml-auto" onClick={() => openLearningEntry(entry)} aria-label={`${entry.label} 학습 단위 열기`}><ArrowRight className="h-4 w-4" /></Button></div></article>; })}</div></section>}

        {activeSourceSet && <section className="archive-card mb-4"><div className="archive-section-heading"><span>FOCUS</span><span className="truncate">{activeSourceSet.label}</span></div><div className="p-3"><FocusPicker source={activeSourceSet.source} crop={activeSourceSet.selectedCrop} onCommit={selectFocusCrop} /></div></section>}

        <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_280px]">
          <aside className="archive-card order-2 xl:order-1"><div className="archive-section-heading"><span>PAGES</span><span>{pages.length}</span></div><div className="divide-y divide-[#111]">{pages.map((page, index) => <button key={page.id} className={cn("flex w-full items-center gap-2 p-2 text-left transition hover:bg-[#f1f1f1]", page.id === selectedId && "bg-[#dfe5ff]")} onClick={() => setSelectedId(page.id)}><div className="grid h-10 w-14 shrink-0 place-items-center border border-[#111] bg-white"><MiniGrid grid={page.grid} /></div><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{page.title || `PAGE ${index + 1}`}</span><span className="text-[10px] text-zinc-500">{dotCount(page.grid)} dots</span></span></button>)}</div><div className="grid grid-cols-2 border-t border-[#111]"><Button variant="ghost" className="archive-action-button border-r border-[#111]" onClick={addBlankPage}><FilePlus2 className="mr-2 h-4 w-4" />NEW</Button><Button variant="ghost" className="archive-action-button" onClick={duplicatePage}><Layers3 className="mr-2 h-4 w-4" />COPY</Button></div></aside>

          <section className="archive-card order-1 min-w-0 xl:order-2"><div className="archive-section-heading"><span>CANVAS</span><span>{pageInfo(activePage?.kind ?? "manual").title}</span><div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" className={cn("archive-mini-button", tool === "draw" && "bg-[#111] text-white hover:bg-[#111] hover:text-white")} onClick={() => setTool("draw")}><MousePointer2 className="mr-1 h-3.5 w-3.5" />DRAW</Button><Button size="sm" variant="ghost" className={cn("archive-mini-button", tool === "erase" && "bg-[#111] text-white hover:bg-[#111] hover:text-white")} onClick={() => setTool("erase")}><Eraser className="mr-1 h-3.5 w-3.5" />ERASE</Button></div></div><div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_190px]"><div className="border border-[#111] bg-[#f7f7f7] p-3 sm:p-4"><div role="application" aria-label="60 곱하기 40 촉각 점자 격자. 클릭하여 점을 편집합니다." className="tactile-grid mx-auto aspect-[3/2] w-full max-w-[760px] touch-none select-none bg-white p-[2.3%]" onPointerDown={handleGridPointerDown} onPointerMove={handleGridPointerMove} onPointerUp={() => setIsDrawing(false)} onPointerLeave={() => setIsDrawing(false)} onPointerCancel={() => setIsDrawing(false)}>{activePage?.grid.map((row, y) => row.map((raised, x) => <span key={`${x}-${y}`} className={cn("dot", raised && "dot-raised")} />))}</div><div className="mt-2 flex justify-between text-[10px] uppercase text-zinc-500"><span>60 × 40</span><span>{activePage ? dotCount(activePage.grid) : 0} dots</span></div></div><div className="flex flex-col gap-3"><div className="border border-[#111] p-2">{sourceImage ? <img className="aspect-[3/2] w-full object-contain" src={sourceImage} alt="업로드한 원본" /> : <div className="grid aspect-[3/2] place-items-center text-[10px] text-zinc-400">NO SOURCE</div>}</div><div className="grid grid-cols-2 gap-1">{[1, 3].map((size) => <button key={size} onClick={() => setBrushSize(size)} className={cn("archive-choice-button", brushSize === size && "bg-[#2f45ff] text-white")}>{size === 1 ? "1" : "3×3"}</button>)}</div><Button variant="ghost" className="archive-action-button border border-[#111]" onClick={resetActiveGrid}><RotateCcw className="mr-2 h-4 w-4" />CLEAR</Button></div></div><div className="grid border-t border-[#111] md:grid-cols-[1fr_auto]"><div className="grid gap-3 p-3 sm:grid-cols-2"><div><Label htmlFor="page-title" className="archive-label">TITLE</Label><Input id="page-title" className="archive-input mt-1" value={activePage?.title ?? ""} onFocus={recordHistory} onChange={(event) => updateActivePage({ title: event.target.value })} /></div><div><Label htmlFor="alt-text" className="archive-label">ALT</Label><Textarea id="alt-text" className="archive-input mt-1 min-h-10" value={activePage?.altText ?? ""} onFocus={recordHistory} onChange={(event) => updateActivePage({ altText: event.target.value })} /></div></div><div className="flex border-t border-[#111] md:border-l md:border-t-0"><Button variant="ghost" className="archive-action-button border-r border-[#111]" onClick={deleteActivePage}><Trash2 className="mr-2 h-4 w-4" />DELETE</Button><Button variant="ghost" className="archive-action-button" onClick={downloadDtms}><Download className="mr-2 h-4 w-4" />SAVE</Button></div></div></section>

          <aside className="archive-card order-3"><div className="archive-section-heading"><span>SETTINGS</span></div><div className="p-3"><div className="grid grid-cols-2 gap-1"><button className={cn("archive-choice-button", mode === "edges" && "bg-[#111] text-white")} onClick={() => setMode("edges")}>EDGE</button><button className={cn("archive-choice-button", mode === "filled" && "bg-[#111] text-white")} onClick={() => setMode("filled")}>FILL</button></div><SettingSlider label="THRESHOLD" value={threshold} min={60} max={220} onChange={setThreshold} /><SettingSlider label="CLEANUP" value={simplification} min={0} max={3} onChange={setSimplification} /><div className="mt-5 flex items-center justify-between border-t border-[#111] pt-3"><Label htmlFor="invert-switch" className="archive-label">INVERT</Label><Switch id="invert-switch" checked={invert} onCheckedChange={setInvert} /></div><Button variant="ghost" className="archive-action-button mt-5 w-full border border-[#111]" onClick={regenerateAllPages} disabled={!sourceSets.length || isGenerating}>{isGenerating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}REGENERATE</Button>{lastSavedAt && <Button variant="ghost" className="archive-action-button mt-2 w-full" onClick={clearTemporaryDraft}><Trash2 className="mr-2 h-4 w-4" />RESET DRAFT</Button>}<p aria-live="polite" className="sr-only">{status}</p></div></aside>
        </div>

        <footer className="mt-4 flex items-center justify-between border-t border-[#111] pt-3 text-[10px] uppercase tracking-[.08em] text-zinc-500"><span>local workspace</span><a className="font-medium text-[#111] underline underline-offset-4" href="https://dot.apps-dotincorp.com/canvas" target="_blank" rel="noreferrer">Dot Canvas <ArrowRight className="ml-1 inline h-3 w-3" /></a></footer>
      </main>
    </div>
  );
}

function FocusPicker({ source, crop, onCommit }: { source: string; crop: Crop; onCommit: (crop: Crop) => void }) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [outline, setOutline] = useState<FocusOutline | null>(null);
  const [sourceAspect, setSourceAspect] = useState(FOCUS_FRAME_RATIO);
  const imageFrame = useMemo(() => containedImageFrame(sourceAspect, FOCUS_FRAME_RATIO), [sourceAspect]);

  useEffect(() => {
    setOutline(null);
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth) inspectImage({ currentTarget: image } as React.SyntheticEvent<HTMLImageElement>);
  }, [source]);

  function point(event: React.PointerEvent<HTMLElement>) {
    const bounds = pickerRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0.5, y: 0.5 };
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    return {
      x: clamp((x - imageFrame.x) / imageFrame.width, 0, 1),
      y: clamp((y - imageFrame.y) / imageFrame.height, 0, 1),
    };
  }

  function choosePosition(event: React.PointerEvent<HTMLDivElement>) {
    const selected = point(event);
    const selectedOutline = imageRef.current ? outlineForPoint(imageRef.current, selected) : null;
    const nextCrop = selectedOutline?.crop ?? cropFromCenter(selected.x, selected.y, 0.5, sourceAspect);
    setOutline(selectedOutline);
    onCommit(nextCrop);
  }

  function inspectImage(event: React.SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    const aspect = image.naturalWidth / image.naturalHeight;
    setSourceAspect(aspect);
    const current = cropCenter(crop);
    setOutline(outlineForPoint(image, current));
  }

  const points = outline?.points.map(([x, y]) => `${(imageFrame.x + x * imageFrame.width) * 100},${(imageFrame.y + y * imageFrame.height) * 100}`).join(" ") ?? "";

  return (
    <div className="focus-workspace">
      <div ref={pickerRef} role="button" tabIndex={0} aria-label="원본에서 확대할 대상을 클릭하면 대상의 외곽선이 선택되고 촉각 캔버스가 갱신됩니다." className="focus-picker focus-frame relative cursor-crosshair overflow-hidden" onPointerDown={choosePosition} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") choosePosition({ currentTarget: event.currentTarget, clientX: event.currentTarget.getBoundingClientRect().left + event.currentTarget.getBoundingClientRect().width / 2, clientY: event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 } as React.PointerEvent<HTMLDivElement>); }}>
        <div className="absolute overflow-hidden bg-white" style={{ left: `${imageFrame.x * 100}%`, top: `${imageFrame.y * 100}%`, width: `${imageFrame.width * 100}%`, height: `${imageFrame.height * 100}%` }}>
          <img ref={imageRef} className="h-full w-full select-none object-contain" src={source} alt="핵심 부위 선택용 원본 이미지" draggable={false} onLoad={inspectImage} />
        </div>
        {outline && <><svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon className="focus-object-outline" points={points} /></svg><span className="focus-object-label pointer-events-none absolute z-20 px-1.5 py-1 text-[9px] font-medium text-white" style={{ left: `${(imageFrame.x + outline.crop.x * imageFrame.width) * 100}%`, top: `${(imageFrame.y + outline.crop.y * imageFrame.height) * 100}%` }}>FOCUS</span></>}
      </div>
    </div>
  );
}

function CandidateBoundaryEditor({ source, crop, textRegions, showTextOverlay, documentLabel, detection, onCommit }: { source: string; crop: Crop; textRegions: TextRegion[]; showTextOverlay: boolean; documentLabel: string; detection: PdfFigureCandidate["detection"]; onCommit: (crop: Crop) => void }) {
  type CandidateInteraction = { type: "move" | "resize"; handle?: "nw" | "ne" | "se" | "sw"; startX: number; startY: number; origin: Crop };
  const editorRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(crop);
  const draftRef = useRef(crop);
  const interactionRef = useRef<CandidateInteraction | null>(null);
  const [sourceAspect, setSourceAspect] = useState(CANDIDATE_FRAME_RATIO);
  const imageFrame = useMemo(() => containedImageFrame(sourceAspect, CANDIDATE_FRAME_RATIO), [sourceAspect]);

  useEffect(() => {
    draftRef.current = crop;
    setDraft(crop);
  }, [crop]);

  function point(event: React.PointerEvent<HTMLElement>) {
    const bounds = editorRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0.5, y: 0.5 };
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    return {
      x: clamp((x - imageFrame.x) / imageFrame.width, 0, 1),
      y: clamp((y - imageFrame.y) / imageFrame.height, 0, 1),
    };
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
    <div ref={editorRef} aria-label={`${documentLabel} 그림 후보 경계 편집기`} className="candidate-boundary-editor relative overflow-hidden bg-[#f6f6f6]" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div className="absolute overflow-hidden bg-white" style={{ left: `${imageFrame.x * 100}%`, top: `${imageFrame.y * 100}%`, width: `${imageFrame.width * 100}%`, height: `${imageFrame.height * 100}%` }}>
        <img className="h-full w-full select-none object-contain" src={source} alt={`${documentLabel} PDF 원본 페이지`} draggable={false} onLoad={(event) => setSourceAspect(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)} />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-black/5" />
      {showTextOverlay && textRegions.map((region, index) => <span key={index} className="pointer-events-none absolute border border-dashed border-zinc-500 bg-zinc-200/55" style={{ left: `${(imageFrame.x + region.x * imageFrame.width) * 100}%`, top: `${(imageFrame.y + region.y * imageFrame.height) * 100}%`, width: `${region.width * imageFrame.width * 100}%`, height: `${region.height * imageFrame.height * 100}%` }} />)}
      <div className="candidate-crop absolute border" style={{ left: `${(imageFrame.x + draft.x * imageFrame.width) * 100}%`, top: `${(imageFrame.y + draft.y * imageFrame.height) * 100}%`, width: `${draft.width * imageFrame.width * 100}%`, height: `${draft.height * imageFrame.height * 100}%` }}>
        <button type="button" aria-label="그림 후보 경계 이동" className="absolute inset-0 cursor-move" onPointerDown={(event) => begin(event, "move")} />
        <span className="focus-crop-label pointer-events-none absolute -top-6 left-0 whitespace-nowrap px-1.5 py-1 text-[9px] font-medium text-white">FIGURE</span>
        {handles.map(([handle, position]) => <button key={handle} type="button" aria-label={`그림 후보 ${handle} 모서리 크기 조절`} className={cn("focus-crop-handle absolute z-10 h-3 w-3 border bg-white", position)} onPointerDown={(event) => begin(event, "resize", handle)} />)}
      </div>
      <span className="archive-float-label pointer-events-none absolute left-2 top-2">{documentLabel}</span>
      {showTextOverlay && <span className="archive-float-label pointer-events-none absolute bottom-2 left-2">{detection === "ocr" ? "OCR" : detection === "native" ? "TEXT" : "NONE"}</span>}
    </div>
  );
}

const MiniGrid = memo(function MiniGrid({ grid }: { grid: boolean[][] }) {
  return (
    <div className="mini-grid">
      {grid.map((row, y) => row.map((raised, x) => (
        <span key={`${x}-${y}`} className={raised ? "mini-dot mini-dot-raised" : "mini-dot"} />
      )))}
    </div>
  );
});

function SettingSlider({ label, value, min, max, onChange, description }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; description?: string }) {
  return <div className="mt-5"><div className="flex items-center justify-between"><p className="archive-label">{label}</p><span className="text-[10px] text-zinc-500">{value}</span></div><Slider className="mt-3" min={min} max={max} step={1} value={[value]} onValueChange={([next]) => onChange(next)} /></div>;
}
