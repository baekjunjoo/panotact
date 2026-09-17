# Validation notes

The expanded review workflow passed `pnpm check` and the production build.

A PDF containing native text plus two spatially separate graphic regions opened a review stage with exactly two candidate cards. The review stage showed each candidate in its original page context, provided the extracted image, and allowed each candidate to be included or excluded. Enabling the OCR/PDF-text overlay changed the control state to “본문 제외 영역 숨기기,” demonstrating that the excluded-text layer can be inspected. Excluding one candidate and using individual conversion produced exactly three tactile pages, confirming that only the selected graphic entered the conversion flow.

With two selected candidates on one PDF page, selected-merge conversion generated one source workflow with three tactile pages. The merged source is created from the union of the selected source-page rectangles, so it preserves the intervening layout rather than compositing independent thumbnails.

Temporary work is stored in browser IndexedDB. A manual save followed by reload restored the three-page workspace and its source image. A separate test saved an unfinished PDF review, including two candidates and the visible OCR-overlay setting; after reload, both candidate review and the overlay preference were restored. The header exposes save status and a manual save control, while the import panel provides an option to delete the browser-stored draft without discarding the currently open workspace.

DTMS export remains unchanged: it preserves the current page sequence and edits as Korean grade-2 metadata plus one 60×40 `bitmapHex` value per page.
