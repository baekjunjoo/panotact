# Validation notes

The crop and PDF extraction upgrade passed TypeScript checking and the production build.

A browser test uploaded an illustrative image, then operated the visible crop controls. The southeast resize handle changed the crop width from 50% to 50.7308%, and the rotation handle changed the crop from 0° to 100°. Both changes committed to the active focus crop and caused its tactile page to refresh.

A one-page PDF containing two spatially separated filled rectangles was rendered in the browser and automatically detected as two visual regions. The application created six separate pages—three tactile pages for each source image—and the regenerated page titles correctly identified `그림 1` and `그림 2`.

DTMS export retains the current page order, user edits, Korean grade-2 language metadata, and one 60×40 `bitmapHex` entry for every page.
