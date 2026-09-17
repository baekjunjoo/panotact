# Validation notes

The precision, history, and OCR upgrade passed `pnpm check` and the production build.

A browser test generated a three-page tactile workflow from an image, set the focus-crop width by exact numeric input from 50% to 63.4%, then used the toolbar controls to undo it back to 50% and redo it to 63.4%. This verifies precise input and reversible workspace history. The focus crop supports separate width and height values at 0.1% precision and rotation at 1° precision; the move, resize, and rotation handles remain available on the source-image overlay.

A PDF containing one native text heading and two spatially separated graphic rectangles produced exactly two source-image regions and six tactile pages. Native PDF text bounding boxes were excluded before visual-region detection. For pages without a native text layer, the application loads Tesseract.js dynamically, requests word-level OCR blocks for Korean and English, removes recognized word boxes from the visual mask, and then falls back safely if OCR is unavailable. A scanned-style, no-text-layer PDF import completed successfully with its two visual regions isolated into six tactile pages.

DTMS export remains unchanged: it preserves the current page sequence and edits as Korean grade-2 metadata plus one 60×40 `bitmapHex` value per page.
