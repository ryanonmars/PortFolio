import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  attachmentPath,
  type AttachmentList,
  type AttachmentOwner,
  type AttachmentRecord,
} from '../../../../packages/shared/src/attachments.js';
import { api, uploadAttachment } from '../api.js';
import {
  attachmentAccept,
  attachmentFileUrl,
  attachmentSize,
  validateAttachmentFiles,
} from './attachments-client.js';
import './attachments.css';
interface Props {
  boardId: string;
  owner: AttachmentOwner;
  ready?: boolean;
  beforeAttachmentChange?: () => Promise<void>;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The attachment request failed.';
export function AttachmentsSection(props: Props) {
  return (
    <OwnerSection
      key={JSON.stringify([props.boardId, props.owner])}
      {...props}
    />
  );
}
function OwnerSection({
  boardId,
  owner,
  beforeAttachmentChange,
  ready = true,
}: Props) {
  const [list, setList] = useState<AttachmentList | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    name: string;
    percent: number;
  } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState<AttachmentRecord | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const listRequest = useRef(0);
  const upload = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const beforeChange = useRef(beforeAttachmentChange);
  useEffect(() => {
    beforeChange.current = beforeAttachmentChange;
  }, [beforeAttachmentChange]);
  const path = attachmentPath(boardId, owner);
  const refresh = async () => {
    const request = ++listRequest.current;
    const result = await api<AttachmentList>(path);
    if (mounted.current && request === listRequest.current) setList(result);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      upload.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const request = ++listRequest.current;
    // New/restored owners must exist in the saved board before listing files.
    void (async () => {
      await beforeChange.current?.();
      if (!active) return null;
      return api<AttachmentList>(path);
    })()
      .then((result) => {
        if (result && active && request === listRequest.current) {
          setList(result);
          setError('');
        }
      })
      .catch((reason) => {
        if (active && request === listRequest.current)
          setError(message(reason));
      });
    return () => {
      active = false;
    };
  }, [path, ready]);
  useEffect(() => {
    if (preview) dialog.current?.showModal();
    else dialog.current?.close();
  }, [preview]);
  const run = async (action: () => Promise<void>, success: string) => {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await beforeAttachmentChange?.();
      if (!mounted.current) return;
      await action();
      if (!mounted.current) return;
      await refresh();
      if (mounted.current) setNotice(success);
    } catch (reason) {
      if (mounted.current) {
        setError(
          reason instanceof DOMException && reason.name === 'AbortError'
            ? 'Upload cancelled. Files already uploaded are kept.'
            : message(reason),
        );
        void refresh().catch(() => {});
      }
    } finally {
      inFlight.current = false;
      upload.current = null;
      if (mounted.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };
  const selectFiles = (files: File[]) => {
    if (!list || !files.length) return;
    const invalid = validateAttachmentFiles(
      files,
      list.limits,
      list.attachments.length,
    );
    if (invalid) {
      setError(invalid);
      return;
    }
    void run(async () => {
      const controller = new AbortController();
      upload.current = controller;
      for (const file of files) {
        if (!mounted.current || controller.signal.aborted)
          throw new DOMException('Upload cancelled.', 'AbortError');
        setProgress({ name: file.name, percent: 0 });
        await uploadAttachment(
          `${path}&filename=${encodeURIComponent(file.name)}`,
          file,
          controller.signal,
          (sent, total) => {
            if (mounted.current)
              setProgress({
                name: file.name,
                percent: Math.round((sent / Math.max(total, 1)) * 100),
              });
          },
        );
      }
      upload.current = null;
    }, `${files.length} attachments uploaded.`);
  };
  const save = (
    event: FormEvent<HTMLFormElement>,
    attachment: AttachmentRecord,
  ) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      await api(attachmentPath(boardId, owner, attachment.id), 'PATCH', {
        displayName: String(data.get('displayName') ?? ''),
        description: String(data.get('description') ?? ''),
        rowVersion: attachment.rowVersion,
      });
      if (mounted.current) setEditing(null);
    }, 'Attachment details saved.');
  };
  return (
    <section
      className="detail-section attachments-section"
      aria-label="Attachments"
    >
      <div className="detail-section-heading">
        <h2>Attachments</h2>
        <label className="attachment-add">
          Add photos or files
          <input
            aria-label="Add photos or files"
            type="file"
            multiple
            accept={attachmentAccept}
            disabled={busy || !list || !ready}
            onChange={(event) => {
              selectFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = '';
            }}
          />
        </label>
      </div>
      <p className="detail-muted">
        Optional photos and reference files for this{' '}
        {owner.type === 'device' ? 'device' : 'network'}.
      </p>
      {list && (
        <p className="detail-footnote">
          Images, PDF and text files · up to{' '}
          {attachmentSize(list.limits.maxFileBytes)} each ·{' '}
          {list.attachments.length}/{list.limits.maxFilesPerOwner} files
        </p>
      )}
      {!list && !error && (
        <p role="status">
          {ready ? 'Loading attachments…' : 'Waiting for board…'}
        </p>
      )}
      {error && (
        <div role="alert" className="attachment-error">
          {error}{' '}
          <button
            disabled={busy}
            onClick={() => {
              setError('');
              void refresh().catch((reason) => {
                if (mounted.current) setError(message(reason));
              });
            }}
          >
            Refresh attachments
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && (
        <div role="status" className="attachment-progress">
          {progress ? (
            <>
              <span>
                Uploading {progress.name} · {progress.percent}%
              </span>
              <progress max={100} value={progress.percent} />
              <button onClick={() => upload.current?.abort()}>
                Cancel upload
              </button>
            </>
          ) : (
            'Saving attachment changes…'
          )}
        </div>
      )}
      {list?.attachments.length === 0 && (
        <p className="detail-empty">
          No attachments yet. Add a photo or reference file when useful.
        </p>
      )}
      <div className="attachment-gallery">
        {list?.attachments.map((attachment) => (
          <article className="attachment-card" key={attachment.id}>
            {attachment.available &&
            attachment.mimeType.startsWith('image/') ? (
              <button
                className="attachment-image"
                aria-label={`Preview ${attachment.displayName}`}
                onClick={() => {
                  setPreviewError(false);
                  setPreview(attachment);
                }}
              >
                <Thumbnail
                  src={attachmentFileUrl(
                    boardId,
                    owner,
                    attachment.id,
                    'thumbnail',
                  )}
                  name={attachment.displayName}
                />
                <span>View image</span>
              </button>
            ) : (
              <div className="attachment-file-kind">
                {attachment.available
                  ? attachment.mimeType === 'application/pdf'
                    ? 'PDF'
                    : 'Document'
                  : 'File unavailable'}
              </div>
            )}
            <div className="attachment-info">
              <h3>{attachment.displayName}</h3>
              {attachment.description && (
                <p className="attachment-caption">{attachment.description}</p>
              )}
              <p className="detail-muted attachment-filename">
                {attachment.originalFilename}
              </p>
              <p className="detail-footnote">
                {attachment.mimeType} · {attachmentSize(attachment.sizeBytes)}
                <br />
                Uploaded {new Date(attachment.createdAt).toLocaleString()}
              </p>
              {!attachment.available && (
                <p className="attachment-error">
                  Stored file is missing. Restore from a complete backup or
                  delete this record and upload again.
                </p>
              )}
              {editing === attachment.id ? (
                <form
                  className="attachment-edit"
                  onSubmit={(event) => save(event, attachment)}
                >
                  <label>
                    Display name
                    <input
                      name="displayName"
                      required
                      maxLength={240}
                      defaultValue={attachment.displayName}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    Caption
                    <textarea
                      name="description"
                      maxLength={4000}
                      defaultValue={attachment.description}
                      disabled={busy}
                    />
                  </label>
                  <div className="attachment-actions">
                    <button disabled={busy}>Save details</button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="attachment-actions">
                  {attachment.available && (
                    <a
                      href={attachmentFileUrl(
                        boardId,
                        owner,
                        attachment.id,
                        'original',
                      )}
                      download={attachment.originalFilename}
                    >
                      Download original
                    </a>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => setEditing(attachment.id)}
                    aria-label={`Edit attachment ${attachment.displayName}`}
                  >
                    Edit details
                  </button>
                  <button
                    disabled={busy}
                    aria-label={`Delete attachment ${attachment.displayName}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Permanently delete “${attachment.displayName}”? This removes the file and cannot be undone with board Undo.`,
                        )
                      )
                        void run(async () => {
                          await api(
                            attachmentPath(boardId, owner, attachment.id),
                            'DELETE',
                            { rowVersion: attachment.rowVersion },
                          );
                        }, 'Attachment permanently deleted.');
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
      <p className="detail-footnote">
        Attachments save separately from the board. Permanently deleting an
        attachment cannot be undone with board Undo.
      </p>
      <dialog
        ref={dialog}
        className="attachment-lightbox"
        aria-label={
          preview ? `Preview ${preview.displayName}` : 'Image preview'
        }
        onClose={() => setPreview(null)}
      >
        {preview && (
          <>
            <div className="attachment-preview-heading">
              <strong>{preview.displayName}</strong>
              <button autoFocus onClick={() => setPreview(null)}>
                Close preview
              </button>
            </div>
            {previewError ? (
              <p role="alert">
                Preview unavailable. Download the original to view this file.
              </p>
            ) : (
              <img
                src={attachmentFileUrl(boardId, owner, preview.id, 'preview')}
                alt={preview.description || preview.displayName}
                onError={() => setPreviewError(true)}
              />
            )}
            <a
              href={attachmentFileUrl(boardId, owner, preview.id, 'original')}
              download={preview.originalFilename}
            >
              Download original
            </a>
          </>
        )}
      </dialog>
    </section>
  );
}

function Thumbnail({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span>Thumbnail unavailable. Open preview or download the original.</span>
  ) : (
    <img loading="lazy" src={src} alt={name} onError={() => setFailed(true)} />
  );
}
