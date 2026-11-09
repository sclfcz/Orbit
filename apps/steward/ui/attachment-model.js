// ADR-0014 client rules kept pure: limits, error copy and state copy. The DOM layer
// (attachment-ui.js) only applies these decisions; tests exercise them directly.

export const ATTACHMENT_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;
export const ATTACHMENT_MAX_TOTAL_BYTES = 6 * 1024 * 1024;

/** `null` means the batch is acceptable; otherwise an i18n key. */
export function validateAttachmentSelection(files, existing = []) {
  const all = [...existing, ...files];
  if (all.length > ATTACHMENT_MAX_COUNT) return 'attachTooMany';
  for (const file of files) {
    if (!ATTACHMENT_MIME.includes(file.type)) return 'attachUnsupportedType';
    if (file.size > ATTACHMENT_MAX_BYTES) return 'attachTooLarge';
  }
  const total = all.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (total > ATTACHMENT_MAX_TOTAL_BYTES) return 'attachTotalTooLarge';
  return null;
}

export function attachmentErrorKey(code) {
  return {
    attachments_not_allowed: 'attachNotAllowed',
    attachment_not_found: 'attachNotFound',
    attachment_unavailable: 'attachUnavailable',
    duplicate_attachment: 'attachDuplicate',
    too_many_attachments: 'attachTooMany',
    too_large: 'attachTooLarge',
    unsupported_media_type: 'attachUnsupportedType',
    unsupported_capability: 'attachUnsupportedAgent',
    upgrade_required: 'attachUpgradeRequired',
    storage_low: 'attachStorageLow',
    id_conflict: 'attachConflict',
  }[code] ?? 'attachFailed';
}

export function attachmentStateKey(state) {
  return {
    uploading: 'attachStateUploading',
    sent: 'attachStateSent',
    delivered: 'attachStateDelivered',
    failed: 'attachStateFailed',
    expired: 'attachStateExpired',
  }[state] ?? 'attachStateFailed';
}

/**
 * Whether to show the attach control and whether it is usable. `imageInput` comes from the
 * server snapshot and is the same state the server uses to accept or refuse the message.
 */
export function attachmentControl(imageInput, offline = false) {
  if (!imageInput) return { visible: false, enabled: false, messageKey: null };
  if (imageInput === 'unsupported') return { visible: false, enabled: false, messageKey: 'attachUnsupportedAgent' };
  if (imageInput === 'upgrade_required') return { visible: true, enabled: false, messageKey: 'attachUpgradeRequired' };
  if (offline) return { visible: true, enabled: false, messageKey: 'attachOffline' };
  return { visible: true, enabled: true, messageKey: null };
}

/** All selected images have been uploaded and the send button may include their ids. */
export function attachmentsReady(items) {
  return items.length > 0 && items.every((item) => item.state === 'ready' && typeof item.id === 'string');
}
