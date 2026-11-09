// DOM half of ADR-0014: upload drafts, lazy thumbnails and the in-page image viewer.
// Everything is built with h() from text nodes; image bytes only ever become blob: URLs.
import { h, icon } from './dom.js';
import { t } from './i18n.js';
import { createBlobUrlCache } from './attachment-cache.js';
import {
  attachmentErrorKey,
  attachmentStateKey,
  attachmentsReady,
  validateAttachmentSelection,
} from './attachment-model.js';

const attachmentCache = createBlobUrlCache({
  load: async (id) => {
    const response = await fetch(`/app/api/attachments/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`attachment ${response.status}`);
    return response.blob();
  },
});
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => attachmentCache.clear());

/** A lazy thumbnail: nothing is fetched until the image approaches the viewport. */
function lazyImage(id, alt, onFailure) {
  const img = h('img', { class: 'attachment-thumb-img', alt, loading: 'lazy' });
  let requested = false;
  const load = async () => {
    if (requested) return;
    requested = true;
    try {
      img.src = await attachmentCache.get(id);
    } catch {
      requested = false;
      onFailure?.();
    }
  };
  if (typeof IntersectionObserver === 'undefined') {
    void load();
  } else {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        io.disconnect();
        void load();
      }
    }, { rootMargin: '200px' });
    io.observe(img);
  }
  return img;
}

/**
 * Metadata-only attachment strip. `expired` never issues a request; pending drafts pass
 * `previewUrl` and render that local object URL instead.
 */
export function attachmentThumbnails(attachments, { className = '' } = {}) {
  return h('div', { class: `attachment-strip ${className}`.trim() },
    ...attachments.map((attachment) => {
      const label = t(attachmentStateKey(attachment.state));
      if (attachment.state === 'expired') {
        return h('div', { class: 'attachment-thumb is-expired', title: label },
          icon('image'),
          h('span', { class: 'attachment-state' }, label));
      }
      const preview = attachment.previewUrl;
      const img = preview
        ? h('img', { class: 'attachment-thumb-img', src: preview, alt: t('attachImageAlt') })
        : lazyImage(attachment.id, t('attachImageAlt'), () => {
            img.replaceWith(h('div', { class: 'attachment-thumb is-expired', title: t('attachStateExpired') },
              icon('image'), h('span', { class: 'attachment-state' }, t('attachStateExpired'))));
          });
      const button = h('button', {
        type: 'button',
        class: `attachment-thumb is-${attachment.state}`,
        title: t('attachOpen'),
        'aria-label': t('attachOpen'),
      }, img, h('span', { class: 'attachment-state' }, label));
      button.addEventListener('click', () => {
        void openAttachmentViewer({ id: attachment.id, url: preview, mimeType: attachment.mimeType });
      });
      return button;
    }));
}

/** A same-page viewer. A remote image comes from the page cache; the cache owns its URL. */
export async function openAttachmentViewer({ id, url, mimeType }) {
  const body = h('div', { class: 'attachment-viewer-body' }, h('div', { class: 'attachment-loading', role: 'status' }, t('attachLoading')));
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  const overlay = h('div', { class: 'attachment-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('attachViewer') },
    h('button', { type: 'button', class: 'attachment-viewer-close', 'aria-label': t('close') }, icon('close')),
    body);
  overlay.querySelector('.attachment-viewer-close').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);

  let src = null;
  if (id) {
    try {
      src = await attachmentCache.get(id);
    } catch {
      src = url ?? null;
    }
  }
  if (!src && url) src = url;
  if (!src) {
    body.replaceChildren(h('p', { class: 'attachment-error', role: 'alert' }, t('attachStateExpired')));
    return;
  }
  if (!overlay.isConnected) {
    return;
  }
  body.replaceChildren(h('img', { class: 'attachment-viewer-image', src, alt: t('attachImageAlt'), 'data-mime': mimeType ?? '' }));
}

/**
 * The composer's draft list: validates client-side, uploads each file once, and exposes only
 * uploaded ids. `take()` transfers local preview URLs to the pending message (which revokes
 * them when the snapshot confirms it); `clear()` revokes them immediately.
 */
export function createAttachmentDraft({ getCsrf, onError, onChange }) {
  const root = h('div', { class: 'attachment-drafts', hidden: true });
  const items = [];
  const changed = () => onChange?.();

  const fail = (item, key) => {
    item.state = 'failed';
    item.error = key;
    item.progress = 0;
    render();
    onError?.(key);
  };

  function upload(item) {
    item.state = 'uploading';
    item.error = null;
    item.progress = 0;
    render();
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open('POST', '/app/api/attachments');
    xhr.setRequestHeader('x-orbit-upload-id', item.uploadId);
    xhr.setRequestHeader('x-csrf-token', getCsrf());
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.min(100, Math.round((event.loaded / event.total) * 100));
      render();
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
      if (xhr.status === 200 && typeof data.id === 'string') {
        item.id = data.id;
        item.mimeType = data.mimeType ?? item.file.type;
        item.bytes = data.bytes ?? item.file.size;
        item.state = 'ready';
        item.progress = 100;
        render();
        return;
      }
      fail(item, attachmentErrorKey(data.error));
    });
    xhr.addEventListener('error', () => fail(item, 'attachNetworkFailed'));
    xhr.addEventListener('abort', () => { item.state = 'failed'; render(); });
    xhr.send(item.file);
  }

  function itemNode(item) {
    const state = t(attachmentStateKey(item.state));
    const remove = h('button', {
      type: 'button', class: 'attachment-remove', 'aria-label': t('attachRemove'), title: t('attachRemove'),
    }, icon('close'));
    remove.addEventListener('click', () => removeItem(item));
    const retry = item.state === 'failed'
      ? h('button', { type: 'button', class: 'text-button attachment-retry' }, t('retry'))
      : null;
    retry?.addEventListener('click', () => upload(item));
    return h('div', { class: `attachment-draft is-${item.state}`, dataset: { key: item.key } },
      h('img', { class: 'attachment-draft-image', src: item.previewUrl, alt: item.file.name }),
      h('div', { class: 'attachment-draft-meta' },
        h('span', { class: 'attachment-draft-name' }, item.file.name),
        item.state === 'uploading' ? h('progress', { max: 100, value: item.progress }) : null,
        h('span', { class: `attachment-state is-${item.state}` }, item.error ? t(item.error) : state),
        retry),
      remove);
  }

  function render() {
    root.hidden = items.length === 0;
    root.replaceChildren(...items.map(itemNode));
    changed();
  }

  function addFiles(files) {
    const list = [...files];
    const existing = items.map((item) => ({ type: item.file.type, size: item.file.size }));
    const error = validateAttachmentSelection(list, existing);
    if (error) {
      onError?.(error);
      return false;
    }
    for (const file of list) {
      const item = {
        key: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        uploadId: `upload-${crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`,
        file,
        previewUrl: URL.createObjectURL(file),
        state: 'uploading',
        progress: 0,
        id: null,
        mimeType: file.type,
        bytes: file.size,
        error: null,
        xhr: null,
      };
      items.push(item);
      upload(item);
    }
    render();
    return true;
  }

  function removeItem(item) {
    item.xhr?.abort();
    URL.revokeObjectURL(item.previewUrl);
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
    render();
  }

  function clear() {
    for (const item of items) {
      item.xhr?.abort();
      URL.revokeObjectURL(item.previewUrl);
    }
    items.length = 0;
    render();
  }

  /** Transfer ownership of preview URLs to a pending message; do not revoke them here. */
  function take() {
    if (!attachmentsReady(items)) return null;
    const taken = items.map((item) => ({
      id: item.id,
      mimeType: item.mimeType,
      bytes: item.bytes,
      previewUrl: item.previewUrl,
      state: 'sent',
    }));
    items.length = 0;
    root.replaceChildren();
    root.hidden = true;
    changed();
    return taken;
  }

  return {
    element: root,
    addFiles,
    removeItem,
    clear,
    take,
    ids: () => items.map((item) => item.id).filter(Boolean),
    hasItems: () => items.length > 0,
    ready: () => attachmentsReady(items),
    busy: () => items.some((item) => item.state === 'uploading'),
    refresh: () => render(),
    destroy() {
      for (const item of items) {
        item.xhr?.abort();
        URL.revokeObjectURL(item.previewUrl);
      }
      items.length = 0;
    },
  };
}

/** Pending-message cleanup: the snapshot confirmed these ids, so their local previews go. */
export function releasePendingAttachments(attachments) {
  for (const attachment of attachments ?? []) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}
