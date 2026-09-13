// Download helpers: trigger browser downloads for Blob, Uint8Array, or string
// payloads without polluting the DOM.
//
// revokeObjectURL 的时序:revoke 过早会与浏览器下载管理器异步读取 blob
// 的过程赛跑,导致下载被静默取消(没有文件、没有报错)。原实现用
// `setTimeout(..., 0)`(下一个宏任务)回收,对 ~1 MB 的 blob 偶发取消。
// 改为 1 s 后再 revoke,确保浏览器已开始读取;1 s 内的 URL 泄漏由 GC 兜底。
const REVOKE_DELAY_MS = 1000;

export function downloadBlob(
  data: Blob | Uint8Array | string,
  filename: string,
  mime?: string
): void {
  let blob: Blob;
  if (data instanceof Blob) {
    blob = data;
  } else if (typeof data === 'string') {
    blob = new Blob([data], { type: mime ?? 'text/plain;charset=utf-8' });
  } else {
    // Copy into a fresh ArrayBuffer to satisfy the BlobPart type which
    // requires ArrayBuffer (not ArrayBufferLike).
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    blob = new Blob([copy.buffer], { type: mime ?? 'application/octet-stream' });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // 延迟回收:避免 revokeObjectURL 抢在浏览器下载管理器读取 blob 之前,
  // 导致"导出成功"却没有文件。详情见上方 REVOKE_DELAY_MS 注释。
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}
