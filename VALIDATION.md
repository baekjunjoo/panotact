# Validation notes

- TypeScript check and production build completed successfully after the three-page workflow update.
- Browser integration test uploaded a generated image and produced the three expected pages: **전체 형태**, **구조 구분**, and **핵심 부위 확대**.
- The same test confirmed that the focus picker is displayed after upload.
- Clicking a new location in the original-image focus picker moved the crop from `40% / 25%` to `50% / 3%` and regenerated the focus-page dot count from 821 to 589, confirming user-controlled focus selection and update.
- A one-page PDF test also produced the same three expected pages and displayed the focus picker.
- DTMS export remains JSON with Korean grade-2 settings and one `bitmapHex` field per current page.
