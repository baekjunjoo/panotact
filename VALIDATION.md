# Validation notes

The batch PDF queue, direct candidate-boundary editor, and ordered learning-flow preview passed `pnpm check` and the production build.

A browser test began with an existing restored review, then added `biology-a.pdf` and `biology-b.pdf` in one multi-file upload. The queue analysed documents sequentially and retained all three document rows. It reported that two newly uploaded PDFs produced four additional figure candidates, leaving six candidate cards available in one shared review area. Each queue row displayed its document order, candidate count, selected count, and processing status.

The first candidate boundary was moved by dispatching pointer events to the on-canvas move control. The yellow boundary's `left` style changed from `53.8889%` to `57.7778%`, and the application reported that the candidate boundary had been corrected. The update regenerates the extracted source image from the corrected crop, so the edited region is used in later conversion. Candidate review edits are included in workspace undo snapshots and browser temporary storage.

After excluding all candidates and selecting one candidate each from `biology-a.pdf` and `biology-b.pdf`, individual conversion produced two ordered learning units and six linked tactile pages. The learning-flow preview showed the actual selected image, an editable figure explanation, and links to the overall, structure, and focus pages for each PDF source page. The source order was validated as `biology-a.pdf` before `biology-b.pdf`. Opening the second unit activated the `biology-b` overall tactile page. A manual save followed by reload restored both the ordered learning flow and the edited figure explanation.

DTMS export still uses the currently ordered tactile-page sequence. The learning-flow preview acts as a review layer, while its linked pages remain the same editable pages that are written to the final DTMS file.
