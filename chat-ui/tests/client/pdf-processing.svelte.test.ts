import { describe, expect, it } from 'vitest';
import { convertPDFToImage, convertPDFToText } from '$lib/utils/pdf-processing';

// pdf-processing.ts runs PDF.js on files a user drops into the chat, so it is
// the one place untrusted documents are parsed in the browser. It had no test
// until the move to pdfjs-dist 6 (forced by an arbitrary-code-execution
// advisory covering 5.6.83 to 6.2.107). These pin the two entry points against
// a real PDF in a real Chromium: the worker loads from the inlined blob, text
// comes back in page order, and pages render to non-blank PNGs.

// Builds a small valid PDF with one line of Helvetica text per page, with a
// correct xref table so PDF.js parses it directly rather than through its
// broken-file recovery path.
function makePdf(pageTexts: string[]): File {
	const objects: string[] = [];
	const pageIds: number[] = [];
	// 1 catalog, 2 pages, 3 font, then a page and a content stream per page.
	objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
	objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
	pageTexts.forEach((text, i) => {
		const pageId = 4 + i * 2;
		const contentId = pageId + 1;
		pageIds.push(pageId);
		const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
		objects[pageId] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
			`/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
		objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	});
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

	let body = '%PDF-1.4\n';
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = body.length;
		body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xrefAt = body.length;
	body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) {
		body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
	}
	body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return new File([body], 'fixture.pdf', { type: 'application/pdf' });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('rendered page is not a loadable image'));
		img.src = dataUrl;
	});
}

describe('pdf-processing (PDF.js in the browser)', () => {
	it('extracts text from every page, in page order', async () => {
		const text = await convertPDFToText(makePdf(['First page text', 'Second page text']));
		const first = text.indexOf('First page text');
		const second = text.indexOf('Second page text');
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBeGreaterThan(first);
	});

	it('renders each page to a PNG with ink on it', async () => {
		const pages = await convertPDFToImage(makePdf(['Rendered']), 1);
		expect(pages).toHaveLength(1);
		expect(pages[0].startsWith('data:image/png')).toBe(true);

		const img = await loadImage(pages[0]);
		expect(img.width).toBe(612);
		expect(img.height).toBe(792);

		// The text sits near the top left; a blank render would be all white
		// (or all transparent) there.
		const canvas = document.createElement('canvas');
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const { data } = ctx.getImageData(60, 40, 250, 50);
		let dark = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i + 3] > 0 && data[i] < 128) dark++;
		}
		expect(dark).toBeGreaterThan(50);
	});

	it('rejects a file that is not a PDF instead of hanging', async () => {
		const notPdf = new File(['plain text, not a pdf'], 'x.pdf', { type: 'application/pdf' });
		await expect(convertPDFToText(notPdf)).rejects.toThrow(/Failed to convert PDF to text/);
	});
});
