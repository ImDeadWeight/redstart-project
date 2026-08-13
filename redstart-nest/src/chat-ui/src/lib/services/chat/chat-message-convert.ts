/**
 * chat-message-convert - database message to API chat message conversion
 *
 * Owns the DB→API transforms for text, image, audio, video, and PDF
 * attachments, plus MCP prompt and MCP resource extras. Does not know
 * about the streaming pipeline or error classification.
 */

import { formatAttachmentText } from '$lib/utils/formatters';
import {
	ATTACHMENT_LABEL_PDF_FILE,
	ATTACHMENT_LABEL_MCP_PROMPT,
	ATTACHMENT_LABEL_MCP_RESOURCE,
	LEGACY_AGENTIC_REGEX
} from '$lib/constants';
import {
	AttachmentType,
	ContentPartType,
	FileTypeAudio,
	MessageRole,
	MimeTypeAudio
} from '$lib/enums';
import type { ApiChatMessageContentPart, ApiChatMessageData, ApiChatCompletionToolCall } from '$lib/types/api';
import type {
	AudioInputFormat,
	DatabaseMessage,
	DatabaseMessageExtra,
	DatabaseMessageExtraMcpPrompt,
	DatabaseMessageExtraMcpResource,
	DatabaseMessageExtraTextFile,
	DatabaseMessageExtraLegacyContext,
	DatabaseMessageExtraImageFile,
	DatabaseMessageExtraAudioFile,
	DatabaseMessageExtraVideoFile,
	DatabaseMessageExtraPdfFile
} from '$lib/types';
import { settingsStore } from '../../stores/settings.svelte';
import { capImageDataURLSize } from '../../utils/cap-img-size';
import {
	SETTINGS_KEYS
} from '$lib/constants';

function getAudioInputFormat(mimeType: string): AudioInputFormat {
	const normalizedMimeType = mimeType.trim().toLowerCase();

	if (
		normalizedMimeType === MimeTypeAudio.WAV ||
		normalizedMimeType === MimeTypeAudio.WAVE ||
		normalizedMimeType === MimeTypeAudio.X_WAV ||
		normalizedMimeType === MimeTypeAudio.X_WAVE ||
		normalizedMimeType === MimeTypeAudio.VND_WAVE ||
		normalizedMimeType === MimeTypeAudio.X_PN_WAV
	) {
		return FileTypeAudio.WAV;
	}

	return FileTypeAudio.MP3;
}

export async function convertDbMessageToApiChatMessageData(
	message: DatabaseMessage & { extra?: DatabaseMessageExtra[] }
): Promise<ApiChatMessageData> {
	if (message.role === MessageRole.TOOL && message.toolCallId) {
		return {
			role: MessageRole.TOOL,
			content: message.content,
			tool_call_id: message.toolCallId
		};
	}

	let toolCalls: ApiChatCompletionToolCall[] | undefined;
	if (message.toolCalls) {
		try {
			toolCalls = JSON.parse(message.toolCalls);
		} catch {
			// Ignore parse errors for malformed tool calls
		}
	}

	if (!message.extra || message.extra.length === 0) {
		const result: ApiChatMessageData = {
			role: message.role as MessageRole,
			content: message.content
		};

		if (message.reasoningContent) {
			result.reasoning_content = message.reasoningContent;
		}

		if (toolCalls && toolCalls.length > 0) {
			result.tool_calls = toolCalls;
		}

		return result;
	}

	const contentParts: ApiChatMessageContentPart[] = [];

	const textFiles = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraTextFile =>
			extra.type === AttachmentType.TEXT
	);

	for (const textFile of textFiles) {
		contentParts.push({
			type: ContentPartType.TEXT,
			text: formatAttachmentText('File', textFile.name, textFile.content)
		});
	}

	const legacyContextFiles = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraLegacyContext =>
			extra.type === AttachmentType.LEGACY_CONTEXT
	);

	for (const legacyContextFile of legacyContextFiles) {
		contentParts.push({
			type: ContentPartType.TEXT,
			text: formatAttachmentText('File', legacyContextFile.name, legacyContextFile.content)
		});
	}

	const imageFiles = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraImageFile =>
			extra.type === AttachmentType.IMAGE
	);

	for (const image of imageFiles) {
		const maxImageResolution = settingsStore.getConfig(SETTINGS_KEYS.MAX_IMAGE_RESOLUTION);

		const base64Url = await capImageDataURLSize(image.base64Url, maxImageResolution);

		contentParts.push({
			type: ContentPartType.IMAGE_URL,
			image_url: { url: base64Url }
		});
	}

	const audioFiles = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraAudioFile =>
			extra.type === AttachmentType.AUDIO
	);

	for (const audio of audioFiles) {
		contentParts.push({
			type: ContentPartType.INPUT_AUDIO,
			input_audio: {
				data: audio.base64Data,
				format: getAudioInputFormat(audio.mimeType)
			}
		});
	}

	if (message.content) {
		contentParts.push({
			type: ContentPartType.TEXT,
			text: message.content
		});
	}

	const videoFiles = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraVideoFile =>
			extra.type === AttachmentType.VIDEO
	);

	for (const video of videoFiles) {
		contentParts.push({
			type: ContentPartType.INPUT_VIDEO,
			input_video: {
				data: video.base64Data,
				format: video.mimeType.includes('mp4')
					? 'mp4'
					: video.mimeType.includes('ogg')
						? 'ogg'
						: 'auto'
			}
		});
	}

	const pdfFiles = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraPdfFile =>
			extra.type === AttachmentType.PDF
	);

	for (const pdfFile of pdfFiles) {
		if (pdfFile.processedAsImages && pdfFile.images) {
			for (let i = 0; i < pdfFile.images.length; i++) {
				contentParts.push({
					type: ContentPartType.IMAGE_URL,
					image_url: { url: pdfFile.images[i] }
				});
			}
		} else {
			contentParts.push({
				type: ContentPartType.TEXT,
				text: formatAttachmentText(ATTACHMENT_LABEL_PDF_FILE, pdfFile.name, pdfFile.content)
			});
		}
	}

	const mcpPrompts = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraMcpPrompt =>
			extra.type === AttachmentType.MCP_PROMPT
	);

	for (const mcpPrompt of mcpPrompts) {
		contentParts.push({
			type: ContentPartType.TEXT,
			text: formatAttachmentText(
				ATTACHMENT_LABEL_MCP_PROMPT,
				mcpPrompt.name,
				mcpPrompt.content,
				mcpPrompt.serverName
			)
		});
	}

	const mcpResources = message.extra.filter(
		(extra: DatabaseMessageExtra): extra is DatabaseMessageExtraMcpResource =>
			extra.type === AttachmentType.MCP_RESOURCE
	);

	for (const mcpResource of mcpResources) {
		contentParts.push({
			type: ContentPartType.TEXT,
			text: formatAttachmentText(
				ATTACHMENT_LABEL_MCP_RESOURCE,
				mcpResource.name,
				mcpResource.content,
				mcpResource.serverName
			)
		});
	}

	const result: ApiChatMessageData = {
		role: message.role as MessageRole,
		content: contentParts
	};
	if (message.reasoningContent) {
		result.reasoning_content = message.reasoningContent;
	}
	if (toolCalls && toolCalls.length > 0) {
		result.tool_calls = toolCalls;
	}
	return result;
}

export function stripReasoningContent(
	content: string | ApiChatMessageContentPart[]
): string | ApiChatMessageContentPart[] {
	const stripFromString = (text: string): string =>
		text.replace(LEGACY_AGENTIC_REGEX.REASONING_BLOCK, '').trim();

	if (typeof content === 'string') {
		return stripFromString(content);
	}

	return content.map((part) => {
		if (part.type === ContentPartType.TEXT && part.text) {
			return { ...part, text: stripFromString(part.text) };
		}
		return part;
	});
}
