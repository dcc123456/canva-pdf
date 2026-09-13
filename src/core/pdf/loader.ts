// PDF.js loader: wraps getDocument and configures the worker using Vite's ?url import.
import * as pdfjsLib from 'pdfjs-dist';
// Use Vite's ?url to copy the worker file to the build output and resolve its URL.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type PdfSource = string | URL | Uint8Array | ArrayBuffer;

export async function loadDocument(source: PdfSource): Promise<PDFDocumentProxy> {
  // pdfjs **transfers**(detaches) the ArrayBuffer it is handed to its worker.
  //
  // Callers routinely keep using the same Uint8Array after this returns: they
  // store it in the document store, base64-encode it as a template, probe page
  // sizes and then export. Passing the caller's buffer straight through made
  // those uses blow up with "Cannot perform Construct on a detached or
  // out-of-bounds ArrayBuffer" (the built-in / user template flows did exactly
  // that). Handing pdfjs a private copy costs one memcpy and removes the whole
  // class of bug at a single choke point.
  const params: Parameters<typeof pdfjsLib.getDocument>[0] =
    typeof source === 'string' || source instanceof URL
      ? { url: source.toString() }
      : {
          data:
            source instanceof Uint8Array
              ? new Uint8Array(source)
              : source.slice(0),
        };
  const task = pdfjsLib.getDocument(params);
  return task.promise;
}

export { pdfjsLib };
