/**
 * agentic-attachments - base64 payloads returned by a tool
 *
 * A tool may return an image as a data URI inline in its text result. These two
 * functions lift those out into DatabaseMessageExtra attachments and leave a
 * placeholder line behind, so the transcript stays readable and the image is
 * stored once.
 *
 * Pure: no store state, no reactivity, no I/O.
 */

import { AttachmentType, MimeTypePrefix } from '$lib/enums';
import {
	NEWLINE_SEPARATOR,
	DATA_URI_BASE64_REGEX,
	IMAGE_MIME_TO_EXTENSION,
	DEFAULT_IMAGE_EXTENSION,
	MCP_ATTACHMENT_NAME_PREFIX
} from '$lib/constants';

export function extractBase64Attachments(result: string): {
	cleanedResult: string;
	attachments: DatabaseMessageExtra[];
} {
	if (!result.trim()) {
		return { cleanedResult: result, attachments: [] };
	}

	const lines = result.split(NEWLINE_SEPARATOR);
	const attachments: DatabaseMessageExtra[] = [];
	let attachmentIndex = 0;

	const cleanedLines = lines.map((line) => {
		const trimmedLine = line.trim();

		const match = trimmedLine.match(DATA_URI_BASE64_REGEX);
		if (!match) {
			return line;
		}

		const mimeType = match[1].toLowerCase();
		const base64Data = match[2];

		if (!base64Data) {
			return line;
		}

		attachmentIndex += 1;
		const name = buildAttachmentName(mimeType, attachmentIndex);

		if (mimeType.startsWith(MimeTypePrefix.IMAGE)) {
			attachments.push({ type: AttachmentType.IMAGE, name, base64Url: trimmedLine });

			return `[Attachment saved: ${name}]`;
		}

		return line;
	});

	return { cleanedResult: cleanedLines.join(NEWLINE_SEPARATOR), attachments };
}

export function buildAttachmentName(mimeType: string, index: number): string {
	const extension = IMAGE_MIME_TO_EXTENSION[mimeType] ?? DEFAULT_IMAGE_EXTENSION;

	return `${MCP_ATTACHMENT_NAME_PREFIX}-${Date.now()}-${index}.${extension}`;
}
