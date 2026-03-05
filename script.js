// DOM References
const fileInput = document.getElementById('file-input');
const uploadArea = document.getElementById('upload-area');
const errorMsg = document.getElementById('error-msg');
const previewSection = document.getElementById('preview-section');
const previewImg = document.getElementById('preview-img');
const colorCountEl = document.getElementById('color-count');
const countDisplay = document.getElementById('count-display');
const extractBtn = document.getElementById('extract-btn');
const clearBtn = document.getElementById('clear-btn');
const paletteSection = document.getElementById('palette-section');
const swatchesGrid = document.getElementById('swatches-grid');
const canvas = document.getElementById('offscreen-canvas');
const ctx = canvas.getContext('2d');
const toast = document.getElementById('toast');

// State
let currentImage = null;
let toastTimer = null;

// Convert RGB components to uppercase HEX string
function rgbToHex(r, g, b) {
    return '#' + [r, g, b]
        .map(v => v.toString(16).padStart(2, '0').toUpperCase())
        .join('');
}

// Determine black or white text based on luminance.
// Using the WCAG relative luminance formula.
function getTextColor(r, g, b) {
    const lin = [r, g, b].map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return L > 0.179 ? '#1A1209' : '#FAFAFA';
}

// Show global toast notification
function showToast(msg, duration = 2000) {
    clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// Utility: Show / hide error message
function showError(msg) {
    errorMsg.textContent = '⚠ ' + msg;
    errorMsg.hidden = false;
}

function clearError() {
    errorMsg.textContent = '';
    errorMsg.hidden = true;
}

// loadImage: validate file and display preview
function loadImage(file) {
    clearError();

    // Validate MIME type
    if (!file || !file.type.startsWith('image/')) {
        showError('That file doesn\'t look like an image. Please choose a PNG, JPG, GIF, WEBP, or similar file.');
        return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
        currentImage = img;
        previewImg.src = url;
        previewImg.alt = `Preview of ${file.name}`;
        previewSection.hidden = false;
        extractBtn.disabled = false;

        // Reset previous palette on new load
        paletteSection.hidden = true;
        swatchesGrid.innerHTML = '';
    };

    img.onerror = () => {
        URL.revokeObjectURL(url);
        showError('Could not decode the image. The file might be corrupt or an unsupported format.');
    };

    img.src = url;
}

// extractPalette: main extraction pipeline
//   1. Scale image to offscreen canvas (max 400px)
//   2. Sample pixels with step stride
//   3. Skip transparent pixels; soft-skip near-white/near-black
//   4. Bucket quantization (round each channel to nearest `step`)
//   5. Sort buckets by frequency
//   6. Apply loose uniqueness filter (Euclidean distance threshold)
//   7. Take top N colors
function extractPalette() {
    if (!currentImage) return;

    // UX: loading state
    extractBtn.textContent = 'Extracting…';
    extractBtn.disabled = true;

    // Defer heavy work so browser can repaint the button state
    setTimeout(() => {
        try {
            _doExtract();
        } catch (err) {
            showError('An error occurred during extraction: ' + err.message);
        } finally {
            extractBtn.textContent = 'Extract Palette';
            extractBtn.disabled = (currentImage === null);
        }
    }, 16);
}

function _doExtract() {
    const targetSize = 400;
    const { naturalWidth: iw, naturalHeight: ih } = currentImage;

    // Scale down to fit within targetSize, preserving aspect ratio
    const scale = Math.min(1, targetSize / Math.max(iw, ih));
    const cw = Math.round(iw * scale);
    const ch = Math.round(ih * scale);

    canvas.width = cw;
    canvas.height = ch;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(currentImage, 0, 0, cw, ch);

    const imageData = ctx.getImageData(0, 0, cw, ch);
    const data = imageData.data;

    // Quantization bucket size
    // Rounding each channel to nearest multiple of `bucketStep`
    // gives us ~(256/bucketStep)^3 possible buckets.
    // A value of 24 is a good balance: broad enough to cluster
    // similar shades, fine enough to preserve distinct hues.
    const bucketStep = 24;

    // Sampling stride
    // Every `sampleStride`-th pixel is checked (in RGBA units).
    const sampleStride = 5; // samples every 5th pixel

    const buckets = new Map(); // key: "R_G_B" → { r, g, b, count }

    for (let i = 0; i < data.length; i += 4 * sampleStride) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        // Skip transparent/semi-transparent pixels
        if (a < 128) continue;

        // Soft skip: near-white (all channels > 245) and near-black (all < 10)
        // We keep grays/near-whites that still have some saturation variation.
        const maxChannel = Math.max(r, g, b);
        const minChannel = Math.min(r, g, b);
        if (maxChannel > 248 && minChannel > 240) continue; // near-pure white
        if (maxChannel < 8) continue;                       // near-pure black

        // Quantize channels
        const qr = Math.round(r / bucketStep) * bucketStep;
        const qg = Math.round(g / bucketStep) * bucketStep;
        const qb = Math.round(b / bucketStep) * bucketStep;
        const key = `${qr}_${qg}_${qb}`;

        if (buckets.has(key)) {
            buckets.get(key).count++;
        } else {
            buckets.set(key, { r: qr, g: qg, b: qb, count: 1 });
        }
    }

    // Sort buckets by frequency (most common first)
    const sorted = Array.from(buckets.values())
        .sort((a, b) => b.count - a.count);

    // Uniqueness filter (loose Euclidean distance)
    // Threshold of ~60 in RGB space means we allow visually
    // similar but not identical colors to coexist. This gives
    // gradations and tones their own swatch.
    const uniqueThreshold = 60;
    const selected = [];

    for (const candidate of sorted) {
        const isTooClose = selected.some(sel => {
            const dr = candidate.r - sel.r;
            const dg = candidate.g - sel.g;
            const db = candidate.b - sel.b;
            return Math.sqrt(dr * dr + dg * dg + db * db) < uniqueThreshold;
        });

        if (!isTooClose) {
            selected.push(candidate);
        }

        if (selected.length >= parseInt(colorCountEl.value, 10)) break;
    }

    renderSwatches(selected);
}

// renderSwatches: build swatch DOM from color array
function renderSwatches(colors) {
    swatchesGrid.innerHTML = '';

    if (colors.length === 0) {
        showError('No colors could be extracted. The image may be fully transparent or too uniform.');
        paletteSection.hidden = true;
        return;
    }

    colors.forEach(({ r, g, b }) => {
        const hex = rgbToHex(r, g, b);
        const rgbStr = `rgb(${r}, ${g}, ${b})`;
        const textColor = getTextColor(r, g, b);

        // Swatch container
        const swatch = document.createElement('div');
        swatch.className = 'swatch';
        swatch.setAttribute('role', 'listitem');
        swatch.setAttribute('tabindex', '0');
        swatch.setAttribute('aria-label', `Color ${hex}. Click to copy HEX.`);
        swatch.title = `Click to copy ${hex}`;

        // Color block
        const colorBlock = document.createElement('div');
        colorBlock.className = 'swatch-color';
        colorBlock.style.background = hex;

        // "Copied!" badge (absolutely positioned over color block)
        const copiedBadge = document.createElement('span');
        copiedBadge.className = 'swatch-copied-badge';
        copiedBadge.textContent = 'Copied!';
        copiedBadge.setAttribute('aria-hidden', 'true');

        // Info block - use a neutral warm background so text is always legible
        // regardless of swatch color. Text color pulled from luminance calc for
        // future reference, but info panel has its own background.
        const info = document.createElement('div');
        info.className = 'swatch-info';

        const hexEl = document.createElement('div');
        hexEl.className = 'swatch-hex';
        hexEl.textContent = hex;
        hexEl.style.color = '#2C2417'; // always dark on info panel

        const rgbEl = document.createElement('div');
        rgbEl.className = 'swatch-rgb';
        rgbEl.textContent = rgbStr;
        rgbEl.style.color = '#8B7355'; // muted dark

        info.appendChild(hexEl);
        info.appendChild(rgbEl);

        swatch.appendChild(colorBlock);
        swatch.appendChild(copiedBadge);
        swatch.appendChild(info);

        // Click & keyboard: copy HEX to clipboard
        const handleCopy = () => copyToClipboard(hex, copiedBadge);
        swatch.addEventListener('click', handleCopy);
        swatch.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleCopy();
            }
        });

        swatchesGrid.appendChild(swatch);
    });

    paletteSection.hidden = false;

    // Scroll palette into view smoothly
    paletteSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// copyToClipboard: write HEX, show per-swatch badge + toast
function copyToClipboard(hex, badgeEl) {
    navigator.clipboard.writeText(hex)
        .then(() => {
            // Per-swatch micro-feedback
            if (badgeEl) {
                badgeEl.classList.add('visible');
                setTimeout(() => badgeEl.classList.remove('visible'), 1400);
            }
            // Global toast
            showToast(`Copied ${hex} to clipboard!`);
        })
        .catch(() => {
            // Fallback for older browsers / insecure contexts
            try {
                const el = document.createElement('textarea');
                el.value = hex;
                el.style.position = 'fixed';
                el.style.opacity = '0';
                document.body.appendChild(el);
                el.focus();
                el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
                showToast(`Copied ${hex} to clipboard!`);
            } catch {
                showToast('Copy failed — please copy manually.');
            }
        });
}

// clearAll: reset image, preview, palette
function clearAll() {
    currentImage = null;

    // Reset file input so same file can be re-uploaded
    fileInput.value = '';

    // Reset preview
    previewImg.src = '';
    previewSection.hidden = true;

    // Reset palette
    swatchesGrid.innerHTML = '';
    paletteSection.hidden = true;

    // Reset button state
    extractBtn.disabled = true;
    extractBtn.textContent = 'Extract Palette';

    clearError();
}

// Slider: update live display
colorCountEl.addEventListener('input', () => {
    countDisplay.textContent = colorCountEl.value;
});

// File input change
fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadImage(file);
});

// Upload area: click forwarded to hidden input
uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
    }
});

// Drag-and-drop
uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadImage(file);
});

// Extract button
extractBtn.addEventListener('click', extractPalette);

// Clear button
clearBtn.addEventListener('click', clearAll);
