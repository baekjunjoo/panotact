# Validation notes

The PDF batch queue, manual candidate-boundary editor, ordered learning-flow preview, and drag-and-drop queue ordering passed `pnpm check` and the production build.

A browser test added two PDFs, `queue-alpha.pdf` and `queue-beta.pdf`, each containing multiple detected visual regions. The queue rendered a drag handle for each PDF card and each candidate card. Native browser drag events moved `queue-alpha.pdf` onto `queue-beta.pdf`, changing the document queue order from Alpha → Beta to Beta → Alpha. The application confirmed that later conversion and learning-flow steps would follow the revised PDF order.

Within `queue-alpha.pdf`, native drag events moved its first candidate onto its second candidate. The visible candidate-card order changed from 그림 1 → 그림 2 to 그림 2 → 그림 1, and the application confirmed the intra-document candidate reordering. Candidate drag-and-drop is deliberately constrained to the same PDF so a candidate remains associated with its source document; moving PDF cards determines the inter-document order.

After the two reorder operations, individual conversion produced four learning units in this exact sequence: `queue-beta` 그림 1, `queue-beta` 그림 2, `queue-alpha` 그림 2, and `queue-alpha` 그림 1. The generated 12 tactile pages and the PDF-to-tactile learning-flow preview used the same sequence. A page reload restored that ordered flow, confirming browser draft persistence.

DTMS export continues to use the generated tactile-page order, so the manual queue ordering is preserved in the exported workflow.
