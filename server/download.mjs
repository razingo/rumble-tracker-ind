// Reading a download with a size limit, for the data-pack update and the app update.

/**
 * The body of a fetch response. Past `limit` bytes it throws `tooLarge` (a message), which also stops the download.
 * onProgress(bytes so far, total from Content-Length or 0) is called after each chunk.
 */
export async function readLimited(response, limit, tooLarge, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > limit) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error(tooLarge);
    chunks.push(Buffer.from(chunk));
    onProgress?.(size, total);
  }
  return Buffer.concat(chunks);
}
