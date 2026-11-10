/**
 * Photos are resized on the device before upload: faster on mobile data, and on the free plan every photo is stored
 * in the database, which caps a row at 1 MB (decision D-015). Re-encoding also strips EXIF data such as GPS location.
 */
export async function preparePhoto(file: File, maxSide = 1280, maxBytes = 700_000): Promise<File> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new Error("Choose a photo (JPEG, PNG or WebP).");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That photo could not be opened. Try a JPEG or PNG.");
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  for (const q of [0.86, 0.78, 0.68, 0.58, 0.48]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && blob.size <= maxBytes) return new File([blob], "photo.jpg", { type: "image/jpeg" });
  }
  throw new Error("That photo is too detailed to upload. Try a different one.");
}
