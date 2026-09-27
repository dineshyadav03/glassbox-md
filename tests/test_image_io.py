"""PNG/JPEG input: validation by content, and the guarantee that what reaches a
model is pixels only. Fixtures are real image files built at test time with
Pillow, carrying metadata that must NOT survive."""

import io

import numpy as np
import pytest
from PIL import Image, PngImagePlugin

from glassbox_md import image_io

SECRET = "Jane Q. Patient"


def _exif_with_phi():
    exif = Image.Exif()
    exif[0x013B] = SECRET  # Artist
    exif[0x010F] = "AcmeScanner"  # Make
    exif[0x0110] = "Model-Serial-123456"  # Model
    exif[0x0132] = "2019:03:14 09:26:53"  # DateTime
    exif[0x9286] = f"note for {SECRET}"  # UserComment-like
    gps = exif.get_ifd(0x8825)
    gps[1], gps[2], gps[3], gps[4] = "N", (12.0, 34.0, 56.0), "E", (77.0, 12.0, 30.0)
    return exif


def _jpeg(path, size=(40, 30), *, exif=True, mode="RGB", color=(10, 120, 200)):
    image = Image.new(mode, size, color if mode == "RGB" else 120)
    kwargs = {"exif": _exif_with_phi()} if exif else {}
    image.save(path, format="JPEG", **kwargs)
    return str(path)


def _png(path, size=(40, 30), *, text=True, mode="RGB", color=(10, 120, 200), **save_kwargs):
    image = Image.new(mode, size, color if mode in ("RGB", "RGBA") else 120)
    info = None
    if text:
        info = PngImagePlugin.PngInfo()
        info.add_text("Author", SECRET)
        info.add_text("Description", f"scan of {SECRET}")
    image.save(path, format="PNG", pnginfo=info, **save_kwargs)
    return str(path)


def _decode(data):
    return Image.open(io.BytesIO(data))


# --- validation --------------------------------------------------------------------

def test_inspect_reports_structure_only_for_a_jpeg_with_exif(tmp_path):
    path = _jpeg(tmp_path / "a.jpg")
    summary = image_io.inspect_image(path)
    assert summary == {"format": "JPEG", "shape": (30, 40, 3), "dtype": "uint8"}
    assert SECRET not in repr(summary)


def test_inspect_reports_structure_only_for_a_png_with_text_chunks(tmp_path):
    summary = image_io.inspect_image(_png(tmp_path / "a.png"))
    assert summary == {"format": "PNG", "shape": (30, 40, 3), "dtype": "uint8"}
    assert SECRET not in repr(summary)


def test_a_greyscale_image_has_a_two_dimensional_shape(tmp_path):
    summary = image_io.inspect_image(_png(tmp_path / "g.png", mode="L", text=False))
    assert summary["shape"] == (30, 40)


def test_sixteen_bit_greyscale_is_reported_as_uint16(tmp_path):
    array = (np.arange(30 * 40, dtype=np.uint16).reshape(30, 40) * 40).astype(np.uint16)
    path = tmp_path / "deep.png"
    Image.fromarray(array).save(path)
    assert image_io.inspect_image(str(path))["dtype"] == "uint16"


@pytest.mark.parametrize("name", ["a.png", "a.jpg", "a.jpeg", "A.PNG"])
def test_extension_set_is_case_insensitive_at_the_caller(name):
    assert (("." + name.rsplit(".", 1)[1]).lower()) in image_io.IMAGE_EXTENSIONS


def test_a_pdf_renamed_to_png_is_refused_by_content(tmp_path):
    path = tmp_path / "fake.png"
    path.write_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF")
    with pytest.raises(image_io.ImageError, match="not a PNG or JPEG"):
        image_io.inspect_image(str(path))


def test_a_gif_renamed_to_jpg_is_refused_by_format(tmp_path):
    path = tmp_path / "anim.jpg"
    Image.new("P", (8, 8)).save(path, format="GIF")
    with pytest.raises(image_io.ImageError, match="only PNG and JPEG"):
        image_io.inspect_image(str(path))


def test_a_bmp_is_refused(tmp_path):
    path = tmp_path / "x.png"
    Image.new("RGB", (8, 8)).save(path, format="BMP")
    with pytest.raises(image_io.ImageError, match="only PNG and JPEG"):
        image_io.inspect_image(str(path))


def test_an_empty_file_is_refused(tmp_path):
    path = tmp_path / "empty.png"
    path.write_bytes(b"")
    with pytest.raises(image_io.ImageError):
        image_io.inspect_image(str(path))


def test_a_truncated_png_is_refused(tmp_path):
    good = _png(tmp_path / "ok.png", size=(200, 200), text=False)
    data = open(good, "rb").read()
    bad = tmp_path / "cut.png"
    bad.write_bytes(data[: len(data) // 2])
    with pytest.raises(image_io.ImageError, match="truncated or corrupt"):
        image_io.inspect_image(str(bad))
    with pytest.raises(image_io.ImageError, match="truncated or corrupt"):
        image_io.sanitized_png_bytes(str(bad))


def test_a_truncated_jpeg_is_refused(tmp_path):
    good = _jpeg(tmp_path / "ok.jpg", size=(200, 200), exif=False)
    data = open(good, "rb").read()
    bad = tmp_path / "cut.jpg"
    bad.write_bytes(data[: len(data) // 2])
    with pytest.raises(image_io.ImageError):
        image_io.inspect_image(str(bad))


def test_an_oversized_image_is_refused_before_it_is_decoded(tmp_path, monkeypatch):
    path = _png(tmp_path / "big.png", size=(50, 50), text=False)
    monkeypatch.setattr(image_io, "MAX_PIXELS", 2000)
    with pytest.raises(image_io.ImageError, match="pixels in total"):
        image_io.inspect_image(path)
    with pytest.raises(image_io.ImageError, match="pixels in total"):
        image_io.sanitized_png_bytes(path)


def test_a_missing_file_is_a_clean_error(tmp_path):
    with pytest.raises(image_io.ImageError):
        image_io.inspect_image(str(tmp_path / "nope.png"))


# --- sanitising ---------------------------------------------------------------------

def test_sanitised_output_is_a_png(tmp_path):
    data = image_io.sanitized_png_bytes(_jpeg(tmp_path / "a.jpg"))
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert _decode(data).format == "PNG"


def test_exif_including_gps_and_free_text_does_not_survive(tmp_path):
    path = _jpeg(tmp_path / "a.jpg")
    assert SECRET.encode() in open(path, "rb").read()  # the fixture really carries it
    data = image_io.sanitized_png_bytes(path)
    image = _decode(data)
    assert not image.getexif()
    assert not image.info.get("exif")
    for needle in (SECRET.encode(), b"AcmeScanner", b"Serial-123456", b"2019:03:14", b"Exif"):
        assert needle not in data


def test_png_text_chunks_do_not_survive(tmp_path):
    path = _png(tmp_path / "a.png")
    assert SECRET.encode() in open(path, "rb").read()
    data = image_io.sanitized_png_bytes(path)
    assert SECRET.encode() not in data
    assert b"tEXt" not in data and b"iTXt" not in data and b"zTXt" not in data
    assert getattr(_decode(data), "text", {}) == {}


def test_an_icc_profile_does_not_survive(tmp_path):
    from PIL import ImageCms

    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    path = tmp_path / "icc.png"
    Image.new("RGB", (16, 16), (1, 2, 3)).save(path, icc_profile=profile)
    assert b"iCCP" in open(path, "rb").read()
    data = image_io.sanitized_png_bytes(str(path))
    assert b"iCCP" not in data and "icc_profile" not in _decode(data).info


def test_pixels_are_preserved_exactly_for_a_small_greyscale_image(tmp_path):
    array = (np.arange(30 * 40).reshape(30, 40) % 251).astype(np.uint8)
    path = tmp_path / "g.png"
    Image.fromarray(array).save(path)
    out = np.asarray(_decode(image_io.sanitized_png_bytes(str(path))))
    assert out.dtype == np.uint8 and np.array_equal(out, array)


def test_pixels_are_preserved_exactly_for_a_small_rgb_png(tmp_path):
    rng = np.random.default_rng(0)
    array = rng.integers(0, 256, size=(20, 25, 3), dtype=np.uint8)
    path = tmp_path / "c.png"
    Image.fromarray(array).save(path)
    out = np.asarray(_decode(image_io.sanitized_png_bytes(str(path))))
    assert np.array_equal(out, array)


def test_exif_orientation_is_applied_then_removed(tmp_path):
    # 3 wide x 2 tall, left half black, right half white; orientation 6 = rotate 90 CW on display.
    array = np.zeros((2, 3), dtype=np.uint8)
    array[:, 2:] = 255
    exif = Image.Exif()
    exif[0x0112] = 6
    path = tmp_path / "rot.jpg"
    Image.fromarray(array).save(path, format="JPEG", exif=exif, quality=100)

    image = _decode(image_io.sanitized_png_bytes(str(path)))

    assert image.size == (2, 3)  # width/height swapped
    assert not image.getexif().get(0x0112)


def test_transparency_is_flattened_onto_white(tmp_path):
    path = tmp_path / "alpha.png"
    Image.new("RGBA", (4, 4), (0, 0, 0, 0)).save(path)  # fully transparent black
    out = np.asarray(_decode(image_io.sanitized_png_bytes(str(path))).convert("RGB"))
    assert (out == 255).all()


def test_a_palette_image_becomes_rgb(tmp_path):
    path = tmp_path / "p.png"
    Image.new("P", (6, 6), 3).save(path)
    assert _decode(image_io.sanitized_png_bytes(str(path))).mode == "RGB"


def test_a_cmyk_jpeg_becomes_rgb(tmp_path):
    path = tmp_path / "cmyk.jpg"
    Image.new("CMYK", (6, 6), (0, 0, 0, 0)).save(path, format="JPEG")
    assert _decode(image_io.sanitized_png_bytes(str(path))).mode == "RGB"


def test_a_one_bit_image_becomes_greyscale(tmp_path):
    path = tmp_path / "bw.png"
    Image.new("1", (6, 6), 1).save(path)
    assert _decode(image_io.sanitized_png_bytes(str(path))).mode == "L"


def test_sixteen_bit_greyscale_is_scaled_to_eight_bit_across_the_full_range(tmp_path):
    array = np.linspace(1000, 30000, 30 * 40).reshape(30, 40).astype(np.uint16)
    path = tmp_path / "deep.png"
    Image.fromarray(array).save(path)
    out = np.asarray(_decode(image_io.sanitized_png_bytes(str(path))))
    assert out.dtype == np.uint8 and out.min() == 0 and out.max() == 255


def test_a_constant_sixteen_bit_image_does_not_divide_by_zero(tmp_path):
    path = tmp_path / "flat.png"
    Image.fromarray(np.full((5, 5), 4000, dtype=np.uint16)).save(path)
    out = np.asarray(_decode(image_io.sanitized_png_bytes(str(path))))
    assert (out == 0).all()


def test_a_very_large_side_is_capped_keeping_the_aspect_ratio(tmp_path):
    path = tmp_path / "wide.png"
    Image.new("L", (4096, 512), 90).save(path)
    image = _decode(image_io.sanitized_png_bytes(str(path)))
    assert max(image.size) == image_io.MAX_SIDE and image.size == (2048, 256)


def test_an_image_within_the_cap_is_not_resized(tmp_path):
    path = tmp_path / "ok.png"
    Image.new("L", (300, 200), 90).save(path)
    assert _decode(image_io.sanitized_png_bytes(str(path))).size == (300, 200)


def test_output_is_deterministic(tmp_path):
    path = _jpeg(tmp_path / "a.jpg")
    assert image_io.sanitized_png_bytes(path) == image_io.sanitized_png_bytes(path)


def test_sanitising_never_modifies_the_source_file(tmp_path):
    path = _jpeg(tmp_path / "a.jpg")
    before = open(path, "rb").read()
    image_io.sanitized_png_bytes(path)
    assert open(path, "rb").read() == before
