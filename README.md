# Panotact

A browser-based editor for transforming images and PDF figure candidates into **60 × 40 Dot Pad DTMS tactile graphics**.

## Features

- Creates three tactile-draft views for each source: overall form, structural boundaries, and a focused detail.
- Detects image candidates from one or more PDF files, excluding native PDF text or OCR-detected text where available.
- Lets authors resize, rotate, and position the focus crop, manually correct detected candidate boundaries, and edit tactile dots directly.
- Supports drag-and-drop ordering for PDFs and for figure candidates within the same PDF.
- Preserves the working draft in the browser using IndexedDB and exports a DTMS JSON file suitable for Dot Pad workflows.

## Local development

```bash
pnpm install
pnpm dev
```

Validate and build the project with:

```bash
pnpm check
pnpm build
```

## Privacy

All analysis and editing run in the browser. Source files are not uploaded by this application.

## License

MIT
