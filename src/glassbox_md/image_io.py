"""Plain PNG/JPEG images as pipeline input.

Why this module exists. The app used to accept only PDF and DICOM. A DICOM
file is converted to a fresh PNG of its pixels before it reaches the model, so
its many identifying tags never travel. A PNG or JPEG needs the same
guarantee and does not get it for free: a phone or scanner JPEG carries EXIF
(GPS position, capture time, device make and serial, sometimes an author or a
free-text comment) and a PNG can carry text chunks and an ICC profile. Reading
the file's raw bytes into the model request, as the code did for any image
path, would ship all of that.

So every raster image is decoded and rebuilt from its pixels only:

- the EXIF orientation is applied first (a phone photo is often stored sideways
  with a flag), then every piece of metadata is dropped by constructing a new
  image from the raw pixel bytes;
- transparency is flattened onto white, palette/CMYK/1-bit images become RGB or
  greyscale, and 16-bit greyscale (a common export from imaging software) is
  scaled to 8 bits the same way the DICOM path scales pixel data;
- the long side is capped (`MAX_SIDE`) so a 12-megapixel photo does not become
  a 30 MB request, and the result is always an 8-bit PNG.

Validation happens before any of that: the file must decode as PNG or JPEG by
its *content* (a renamed PDF or GIF is refused, not trusted by extension), stay
under `MAX_PIXELS` (a decompression-bomb guard), and not be truncated.

What this does NOT do, and cannot: text burned into the pixels. A screenshot or
a photographed report with a patient's name printed on it keeps that name. That
is the same gap the DICOM path documents ("not pixel-defaced"), and it is likelier
here, because photos and screenshots are exactly where burned-in text lives. The
app says so where the user uploads.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg"})
# MPO is a JPEG with extra frames (several phone cameras write it); Pillow names it separately.
ALLOWED_FORMATS = frozenset({"PNG", "JPEG", "MPO"})

# 40 megapixels: comfortably above any real radiograph or phone photo, far below
# what a crafted file could ask a decoder to allocate.
MAX_PIXELS = 40_000_000
# Long side of the image sent to a model. Vision encoders resize to a few hundred
# to ~1500 pixels anyway; more only inflates the request.
MAX_SIDE = 2048

_SIXTEEN_BIT_MODES = frozenset({"I;16", "I;16L", "I;16B", "I;16N", "I", "F"})


class ImageError(ValueError):
    """The file is not an image this project accepts (wrong content, too big,
    truncated). A per-file problem, recorded by the parser, never a crash."""


def _open(path: str | Path):
    from PIL import Image, UnidentifiedImageError

    try:
        image = Image.open(path)
    except UnidentifiedImageError as exc:
        raise ImageError("not a PNG or JPEG image (file content was not recognised as an image)") from exc
    except (OSError, ValueError) as exc:
        raise ImageError(f"could not read the image: {exc}") from exc
    if image.format not in ALLOWED_FORMATS:
        fmt = image.format
        image.close()
        raise ImageError(f"unsupported image format {fmt!r}; only PNG and JPEG are accepted")
    width, height = image.size
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        image.close()
        raise ImageError(f"image is {width}x{height} pixels; the limit is {MAX_PIXELS:,} pixels in total")
    return image


def inspect_image(path: str | Path) -> dict[str, Any]:
    """Validate the file and return structural facts only -- format, shape, dtype.
    Never returns any metadata value (EXIF, PNG text), so none can enter the
    pipeline state."""
    image = _open(path)
    try:
        try:
            image.load()  # decodes fully: catches a truncated or corrupt file
        except (OSError, ValueError, SyntaxError) as exc:
            raise ImageError(f"the image is truncated or corrupt: {exc}") from exc
        width, height = image.size
        bands = len(image.getbands())
        deep = image.mode in _SIXTEEN_BIT_MODES
        shape = (height, width) if bands == 1 else (height, width, bands)
        fmt = "JPEG" if image.format == "MPO" else image.format
        return {"format": fmt, "shape": shape, "dtype": "uint16" if deep else "uint8"}
    finally:
        image.close()


def _to_eight_bit(image):
    """Greyscale or RGB, 8 bits per channel, no alpha."""
    import numpy as np
    from PIL import Image

    mode = image.mode
    if mode in _SIXTEEN_BIT_MODES:
        array = np.asarray(image, dtype="float32")
        array = array - array.min()
        if array.max() > 0:
            array = array / array.max() * 255.0
        return Image.fromarray(array.astype("uint8"), mode="L")
    if mode in ("RGBA", "LA", "PA") or (mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.getchannel("A"))
        return flat
    if mode in ("L", "RGB"):
        return image
    if mode == "1":
        return image.convert("L")
    return image.convert("RGB")  # P, CMYK, YCbCr, LAB, HSV ...


def sanitized_png_bytes(path: str | Path) -> bytes:
    """The image as an 8-bit PNG built from its pixels alone: orientation applied,
    long side capped, and no metadata of any kind carried over."""
    from PIL import Image, ImageOps

    source = _open(path)
    try:
        try:
            source.load()
        except (OSError, ValueError, SyntaxError) as exc:
            raise ImageError(f"the image is truncated or corrupt: {exc}") from exc
        oriented = ImageOps.exif_transpose(source)
        flat = _to_eight_bit(oriented)
        # A brand-new image from the raw pixel bytes: `info`, EXIF, text chunks and
        # any ICC profile stay behind with the old object.
        clean = Image.frombytes(flat.mode, flat.size, flat.tobytes())
    finally:
        source.close()

    if max(clean.size) > MAX_SIDE:
        clean.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        clean = Image.frombytes(clean.mode, clean.size, clean.tobytes())  # thumbnail may re-attach nothing, but be certain

    buffer = io.BytesIO()
    clean.save(buffer, format="PNG")
    return buffer.getvalue()
