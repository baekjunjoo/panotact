import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import {
  ArrowRight,
  Eraser,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  FileImage,
  FilePlus2,
  FileText,
  Grid3X3,
  ImageUp,
  Layers3,
  Loader2,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  WandSparkles,
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
const EMPTY_GRID = () => Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(false));

type TactilePage = {
  id: string;
  title: string;
  altText: string;
  grid: boolean[][];
  source?: string;
};

type ConversionMode = "edges" | "filled";

function cloneGrid(grid: boolean[][]) {
  return grid.map((row) => [...row]);
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dotCount(grid: boolean[][]) {
  return grid.flat().filter(Boolean).length;
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
        for (let col = 0; col < 2; col += 1) {
          if (grid[y + row][x + col]) bits |= 1 << bitPositions[row][col];
        }
      }
      cells.push((0x2800 + bits).toString(16).padStart(4, "0"));
    }
  }
  return cells.join("");
}

function getImageDataFromSource(source: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = GRID_WIDTH;
      canvas.height = GRID_HEIGHT;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return reject(new Error("Canvas를 시작할 수 없습니다."));
      context.drawImage(image, 0, 0, GRID_WIDTH, GRID_HEIGHT);
      resolve(context.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT));
    };
    image.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
    image.src = source;
  });
}

function sourceToGrid(imageData: ImageData, threshold: number, mode: ConversionMode, invert: boolean) {
  const grid = EMPTY_GRID();
  const luminance = (x: number, y: number) => {
    const safeX = Math.min(GRID_WIDTH - 1, Math.max(0, x));
    const safeY = Math.min(GRID_HEIGHT - 1, Math.max(0, y));
    const index = (safeY * GRID_WIDTH + safeX) * 4;
    const data = imageData.data;
    return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  };

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const value = luminance(x, y);
      const isRaised =
        mode === "filled"
          ? value < threshold
          : Math.abs(luminance(x + 1, y) - luminance(x - 1, y)) +
              Math.abs(luminance(x, y + 1) - luminance(x, y - 1)) >
            threshold * 0.72;
      grid[y][x] = invert ? !isRaised : isRaised;
    }
  }
  return grid;
}

function simplifyGrid(grid: boolean[][], passes: number) {
  let result = cloneGrid(grid);
  for (let pass = 0; pass < passes; pass += 1) {
    const next = cloneGrid(result);
    for (let y = 1; y < GRID_HEIGHT - 1; y += 1) {
      for (let x = 1; x < GRID_WIDTH - 1; x += 1) {
        let neighbors = 0;
        for (let yy = -1; yy <= 1; yy += 1) {
          for (let xx = -1; xx <= 1; xx += 1) {
            if (xx !== 0 || yy !== 0) neighbors += Number(result[y + yy][x + xx]);
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

function createBlankPage(title = "새 촉각 페이지"): TactilePage {
  return { id: createId(), title, altText: "", grid: EMPTY_GRID() };
}

export default function Home() {
  const [pages, setPages] = useState<TactilePage[]>([createBlankPage("촉각 도식 1")]);
  const [selectedId, setSelectedId] = useState<string>(() => pages[0].id);
  const [fileTitle, setFileTitle] = useState("나의 촉각 도식");
  const [threshold, setThreshold] = useState(132);
  const [mode, setMode] = useState<ConversionMode>("edges");
  const [simplification, setSimplification] = useState(1);
  const [invert, setInvert] = useState(false);
  const [tool, setTool] = useState<"draw" | "erase">("draw");
  const [brushSize, setBrushSize] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("이미지 또는 PDF를 올려 시작하세요.");
  const [isDrawing, setIsDrawing] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const activePage = useMemo(
    () => pages.find((page) => page.id === selectedId) ?? pages[0],
    [pages, selectedId],
  );

  const sourceImage = activePage?.source;

  useEffect(() => {
    if (!sourceImage || !activePage) return;
    let cancelled = false;
    getImageDataFromSource(sourceImage)
      .then((imageData) => {
        if (cancelled) return;
        const raw = sourceToGrid(imageData, threshold, mode, invert);
        const grid = simplifyGrid(raw, simplification);
        setPages((current) =>
          current.map((page) => (page.id === activePage.id ? { ...page, grid } : page)),
        );
      })
      .catch(() => setStatus("변환을 적용할 수 없습니다. 다른 파일을 시도해 주세요."));
    return () => {
      cancelled = true;
    };
  }, [sourceImage, threshold, mode, invert, simplification, activePage?.id]);

  function updateActivePage(patch: Partial<TactilePage>) {
    if (!activePage) return;
    setPages((current) => current.map((page) => (page.id === activePage.id ? { ...page, ...patch } : page)));
  }

  function applyAt(x: number, y: number) {
    if (!activePage || x < 0 || y < 0 || x >= GRID_WIDTH || y >= GRID_HEIGHT) return;
    const radius = brushSize === 3 ? 1 : 0;
    const grid = cloneGrid(activePage.grid);
    for (let yy = y - radius; yy <= y + radius; yy += 1) {
      for (let xx = x - radius; xx <= x + radius; xx += 1) {
        if (xx >= 0 && yy >= 0 && xx < GRID_WIDTH && yy < GRID_HEIGHT) grid[yy][xx] = tool === "draw";
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
    setIsDrawing(true);
    applyAt(x, y);
  }

  function handleGridPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!isDrawing) return;
    const { x, y } = pointerToDot(event);
    applyAt(x, y);
  }

  async function makePageFromImage(source: string, title: string) {
    const imageData = await getImageDataFromSource(source);
    const raw = sourceToGrid(imageData, threshold, mode, invert);
    const page: TactilePage = {
      id: createId(),
      title,
      altText: "원본 그림을 단순화한 60×40 촉각 그래픽입니다.",
      grid: simplifyGrid(raw, simplification),
      source,
    };
    return page;
  }

  async function processPdf(file: File) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdfDocument = await pdfjsLib.getDocument({ data }).promise;
    const generated: TactilePage[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      setStatus(`PDF ${pageNumber}/${pdfDocument.numPages} 페이지를 촉각 격자로 변환 중…`);
      const pdfPage = await pdfDocument.getPage(pageNumber);
      const viewport = pdfPage.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("PDF 캔버스를 만들 수 없습니다.");
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      const source = canvas.toDataURL("image/png");
      generated.push(await makePageFromImage(source, `${file.name.replace(/\.pdf$/i, "")} · ${pageNumber}쪽`));
    }
    return generated;
  }

  async function handleFile(file?: File) {
    if (!file) return;
    setIsLoading(true);
    try {
      let generated: TactilePage[] = [];
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        generated = await processPdf(file);
      } else if (file.type.startsWith("image/")) {
        const source = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("이미지를 읽을 수 없습니다."));
          reader.readAsDataURL(file);
        });
        generated = [await makePageFromImage(source, file.name.replace(/\.[^.]+$/, ""))];
      } else {
        throw new Error("PNG, JPG, WebP 또는 PDF 파일만 지원합니다.");
      }
      setPages(generated);
      setSelectedId(generated[0].id);
      setFileTitle(file.name.replace(/\.[^.]+$/, ""));
      setStatus(`${generated.length}개 촉각 페이지가 준비되었습니다. 라벨·잔선을 지우개로 정리해 주세요.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "파일을 처리하지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
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
    updateActivePage({ grid: EMPTY_GRID(), source: undefined });
    setStatus("현재 페이지를 빈 60×40 격자로 초기화했습니다.");
  }

  function addBlankPage() {
    const page = createBlankPage(`촉각 도식 ${pages.length + 1}`);
    setPages((current) => [...current, page]);
    setSelectedId(page.id);
  }

  function duplicatePage() {
    if (!activePage) return;
    const copy = { ...activePage, id: createId(), title: `${activePage.title} 복사본`, grid: cloneGrid(activePage.grid) };
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
          <div className="hidden items-center gap-2 text-xs text-slate-500 md:flex">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            브라우저 안에서만 처리됩니다
          </div>
          <Button className="rounded-xl bg-[#17352b] px-4 text-white hover:bg-[#244b3d]" onClick={downloadDtms}>
            <Download className="mr-2 h-4 w-4" /> DTMS 저장
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 py-7 lg:px-8">
        <section className="mb-7 flex flex-col justify-between gap-4 rounded-[24px] border border-[#d9e3df] bg-[radial-gradient(circle_at_75%_20%,#f8eac8_0%,transparent_25%),linear-gradient(130deg,#e9f2ee_0%,#fdfcf8_58%,#f6f3ed_100%)] px-6 py-6 shadow-sm lg:flex-row lg:items-end lg:px-8">
          <div className="max-w-2xl">
            <p className="mb-2 text-xs font-bold tracking-[0.16em] text-[#557469]">촉각 교육용 구조도 만들기</p>
            <h1 className="font-display text-3xl tracking-tight text-[#17352b] sm:text-4xl">이미지를 점으로 바꾸고,<br className="hidden sm:block" /> 손끝으로 읽히게 다듬으세요.</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">PDF와 이미지를 60×40 촉각 격자로 변환합니다. 라벨·지시선·미세한 잡음은 지우개와 점 편집으로 정리한 뒤 Dot Pad용 DTMS로 저장하세요.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-medium text-[#315c4d]">
            <span className="rounded-full border border-[#bdd4c9] bg-white/70 px-3 py-1.5">무료 · 계정 불필요</span>
            <span className="rounded-full border border-[#bdd4c9] bg-white/70 px-3 py-1.5">이미지·PDF 지원</span>
            <span className="rounded-full border border-[#bdd4c9] bg-white/70 px-3 py-1.5">다중 페이지 DTMS</span>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className="order-2 rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm xl:order-1">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-slate-800">페이지</p>
                <p className="text-xs text-slate-500">DTMS에 순서대로 저장됩니다</p>
              </div>
              <span className="grid h-7 min-w-7 place-items-center rounded-full bg-[#edf4f0] px-2 text-xs font-bold text-[#315c4d]">{pages.length}</span>
            </div>
            <div className="space-y-2">
              {pages.map((page, index) => (
                <button
                  key={page.id}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-xl p-2 text-left transition",
                    page.id === selectedId ? "bg-[#e8f1ed] ring-1 ring-[#b3cebf]" : "hover:bg-slate-50",
                  )}
                  onClick={() => setSelectedId(page.id)}
                >
                  <div className="grid h-11 w-14 shrink-0 place-items-center rounded-lg border border-slate-200 bg-[#fcfcfa]">
                    <MiniGrid grid={page.grid} />
                  </div>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-slate-700">{page.title || `페이지 ${index + 1}`}</span>
                    <span className="mt-1 block text-[11px] text-slate-500">{dotCount(page.grid)} / 2400 점</span>
                  </span>
                  {page.id === selectedId && <Check className="h-4 w-4 text-[#2d7a58]" />}
                </button>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button variant="outline" className="rounded-xl border-slate-200 text-xs" onClick={addBlankPage}>
                <FilePlus2 className="mr-1.5 h-3.5 w-3.5" /> 빈 페이지
              </Button>
              <Button variant="outline" className="rounded-xl border-slate-200 text-xs" onClick={duplicatePage}>
                <Layers3 className="mr-1.5 h-3.5 w-3.5" /> 복제
              </Button>
            </div>
            <div className="mt-6 rounded-xl bg-[#f6f7f5] p-3">
              <p className="mb-1 text-xs font-bold text-[#315c4d]">촉각 설계 팁</p>
              <p className="text-[11px] leading-5 text-slate-600">한 페이지에는 외곽·핵심 경계·주요 구조처럼 3~5개 정보만 남기면 더 읽기 쉽습니다.</p>
            </div>
          </aside>

          <section className="order-1 min-w-0 xl:order-2">
            <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">60 × 40 촉각 편집기</p>
                  <p className="text-xs text-slate-500">클릭하거나 드래그해서 점을 추가·제거합니다.</p>
                </div>
                <div className="flex rounded-xl bg-slate-100 p-1">
                  <Button size="sm" variant="ghost" className={cn("h-8 rounded-lg px-3 text-xs", tool === "draw" && "bg-white shadow-sm")} onClick={() => setTool("draw")}>
                    <MousePointer2 className="mr-1.5 h-3.5 w-3.5" /> 점 찍기
                  </Button>
                  <Button size="sm" variant="ghost" className={cn("h-8 rounded-lg px-3 text-xs", tool === "erase" && "bg-white shadow-sm")} onClick={() => setTool("erase")}>
                    <Eraser className="mr-1.5 h-3.5 w-3.5" /> 지우기
                  </Button>
                </div>
              </div>

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="relative overflow-hidden rounded-2xl border border-[#d5e1db] bg-[radial-gradient(circle_at_1px_1px,rgba(23,53,43,.07)_1px,transparent_0)] [background-size:16px_16px] p-3 sm:p-5">
                  <div
                    role="application"
                    aria-label="60 곱하기 40 촉각 점자 격자. 클릭하여 점을 편집합니다."
                    className="tactile-grid mx-auto aspect-[3/2] w-full max-w-[720px] touch-none select-none rounded-lg bg-[#fbfdfb] p-[2.3%] shadow-inner"
                    onPointerDown={handleGridPointerDown}
                    onPointerMove={handleGridPointerMove}
                    onPointerUp={() => setIsDrawing(false)}
                    onPointerLeave={() => setIsDrawing(false)}
                  >
                    {activePage?.grid.map((row, y) =>
                      row.map((raised, x) => (
                        <span key={`${x}-${y}`} className={cn("dot", raised && "dot-raised")} />
                      )),
                    )}
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11px] font-medium text-slate-500">
                    <span>가로 60점</span>
                    <span className="rounded-full bg-white px-2 py-1 shadow-sm">{activePage ? dotCount(activePage.grid) : 0} raised dots</span>
                    <span>세로 40점</span>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="rounded-2xl border border-slate-200 bg-[#fbfcfb] p-3">
                    <p className="mb-2 text-xs font-bold text-slate-700">원본 보기</p>
                    {sourceImage ? (
                      <img className="aspect-[3/2] w-full rounded-lg border border-slate-200 object-contain bg-white" src={sourceImage} alt="업로드한 원본" />
                    ) : (
                      <div className="grid aspect-[3/2] place-items-center rounded-lg border border-dashed border-slate-300 bg-white px-3 text-center text-[11px] leading-4 text-slate-400">
                        업로드하면 원본이 이곳에 표시됩니다
                      </div>
                    )}
                  </div>
                  <div className="rounded-2xl bg-[#17352b] p-3 text-white">
                    <p className="text-xs font-bold">편집 브러시</p>
                    <div className="mt-3 flex gap-2">
                      {[1, 3].map((size) => (
                        <button key={size} onClick={() => setBrushSize(size)} className={cn("grid h-8 flex-1 place-items-center rounded-lg text-xs font-bold transition", brushSize === size ? "bg-[#f4ca68] text-[#17352b]" : "bg-white/10 text-white/80 hover:bg-white/20")}>
                          {size === 1 ? "1점" : "3×3"}
                        </button>
                      ))}
                    </div>
                    <Button variant="ghost" className="mt-3 h-8 w-full rounded-lg text-xs text-white hover:bg-white/10 hover:text-white" onClick={resetActiveGrid}>
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> 이 페이지 비우기
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center gap-2"><FileText className="h-4 w-4 text-[#507366]" /><p className="text-sm font-bold text-slate-800">DTMS 설명</p></div>
                <Label htmlFor="page-title" className="text-xs font-semibold text-slate-600">페이지 제목</Label>
                <Input id="page-title" className="mt-1.5 rounded-xl border-slate-200" value={activePage?.title ?? ""} onChange={(event) => updateActivePage({ title: event.target.value })} />
                <Label htmlFor="alt-text" className="mt-4 block text-xs font-semibold text-slate-600">대체 설명</Label>
                <Textarea id="alt-text" className="mt-1.5 min-h-24 rounded-xl border-slate-200 text-sm" placeholder="예: 단면 외곽, 상단의 반복 블록, 내부의 굵은 연결 구조를 표현한 촉각 도식" value={activePage?.altText ?? ""} onChange={(event) => updateActivePage({ altText: event.target.value })} />
              </div>
              <div className="rounded-[20px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center gap-2"><CircleHelp className="h-4 w-4 text-[#507366]" /><p className="text-sm font-bold text-slate-800">내보내기 전 확인</p></div>
                <ul className="space-y-2.5 text-xs leading-5 text-slate-600">
                  <li className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />텍스트·긴 지시선과 미세 잡음을 지웠는지</li>
                  <li className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />중요한 구조 간에 충분한 빈 공간이 있는지</li>
                  <li className="flex gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />Dot Canvas에서는 ‘추가’가 아닌 ‘열기’를 사용할지</li>
                </ul>
                <div className="mt-4 flex gap-2">
                  <Button variant="outline" className="flex-1 rounded-xl border-slate-200 text-xs" onClick={deleteActivePage}><Trash2 className="mr-1.5 h-3.5 w-3.5" /> 삭제</Button>
                  <Button className="flex-1 rounded-xl bg-[#e0a93a] text-[#17352b] hover:bg-[#f1bd51]" onClick={downloadDtms}><Download className="mr-1.5 h-3.5 w-3.5" /> 저장</Button>
                </div>
              </div>
            </div>
          </section>

          <aside className="order-3 space-y-5">
            <section className="rounded-[22px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-2"><WandSparkles className="h-4 w-4 text-[#b57d16]" /><h2 className="text-sm font-bold text-slate-800">자동 단순화</h2></div>
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
                <button className={cn("rounded-lg px-3 py-2 text-xs font-bold transition", mode === "edges" && "bg-white text-[#17352b] shadow-sm")} onClick={() => setMode("edges")}>윤곽 우선</button>
                <button className={cn("rounded-lg px-3 py-2 text-xs font-bold transition", mode === "filled" && "bg-white text-[#17352b] shadow-sm")} onClick={() => setMode("filled")}>면적 우선</button>
              </div>
              <SettingSlider label="감도" value={threshold} min={60} max={220} onChange={setThreshold} description={mode === "edges" ? "선과 경계를 더 많이 찾습니다" : "어두운 영역을 점으로 채웁니다"} />
              <SettingSlider label="잡음 정리" value={simplification} min={0} max={3} onChange={setSimplification} description="작은 점 군집과 빈틈을 정리합니다" />
              <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
                <div><p className="text-xs font-bold text-slate-700">흑백 반전</p><p className="mt-0.5 text-[11px] text-slate-500">밝은 형태를 점으로 변환</p></div>
                <Switch checked={invert} onCheckedChange={setInvert} />
              </div>
            </section>

            <section className="rounded-[22px] border border-dashed border-[#a9c8bb] bg-[#eff6f2] p-5">
              <input ref={uploadRef} aria-label="이미지 또는 PDF 파일 선택" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="pointer-events-none absolute h-px w-px opacity-0" onChange={(event) => handleFile(event.target.files?.[0])} />
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-white text-[#2d7056] shadow-sm"><ImageUp className="h-5 w-5" /></div>
              <h2 className="mt-3 text-sm font-bold text-[#17352b]">새 이미지 불러오기</h2>
              <p className="mt-1 text-xs leading-5 text-[#527267]">PNG, JPG, WebP 또는 PDF 전체 페이지를 처리합니다.</p>
              <Button className="mt-4 w-full rounded-xl bg-[#17352b] text-white hover:bg-[#244b3d]" onClick={() => uploadRef.current?.click()} disabled={isLoading}>
                {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                파일 선택
              </Button>
              <p aria-live="polite" className="mt-3 text-[11px] leading-4 text-[#527267]">{status}</p>
            </section>

            <section className="rounded-[22px] bg-[#17352b] p-5 text-white shadow-[0_14px_28px_rgba(23,53,43,.16)]">
              <p className="text-xs font-bold tracking-[0.12em] text-[#f4ca68]">작동 방식</p>
              <ol className="mt-3 space-y-3 text-xs leading-5 text-white/80">
                <li className="flex gap-2"><span className="font-display text-lg leading-5 text-[#f4ca68]">1</span><span>그림 또는 PDF를 올려 60×40 격자로 축소합니다.</span></li>
                <li className="flex gap-2"><span className="font-display text-lg leading-5 text-[#f4ca68]">2</span><span>자동 변환 후 라벨·지시선·불필요한 점을 직접 지웁니다.</span></li>
                <li className="flex gap-2"><span className="font-display text-lg leading-5 text-[#f4ca68]">3</span><span>여러 페이지를 하나의 DTMS로 저장합니다.</span></li>
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

function MiniGrid({ grid }: { grid: boolean[][] }) {
  return <div className="mini-grid">{grid.map((row, y) => row.map((raised, x) => <span key={`${x}-${y}`} className={raised ? "mini-dot mini-dot-raised" : "mini-dot"} />))}</div>;
}

function SettingSlider({ label, value, min, max, onChange, description }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; description: string }) {
  return <div className="mt-5"><div className="flex items-center justify-between"><p className="text-xs font-bold text-slate-700">{label}</p><span className="rounded-md bg-[#edf4f0] px-1.5 py-0.5 text-[10px] font-bold text-[#315c4d]">{value}</span></div><p className="mt-1 text-[11px] text-slate-500">{description}</p><Slider className="mt-3" min={min} max={max} step={1} value={[value]} onValueChange={([next]) => onChange(next)} /></div>;
}
