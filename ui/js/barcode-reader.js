/**
 * ui/js/barcode-reader.js
 * Leitor 100% offline de códigos de barras (Code 128 e QR Code) a partir do bitmap ZPL.
 * Combina:
 *  1. Varredura direta 1-bit de linhas horizontais para Code 128 (subsets A, B e C com checksum mod 103);
 *  2. Biblioteca local ZXing (ui/lib/zxing.min.js) em escala 1x, 2x sem suavização e invertida;
 *  3. BarcodeDetector nativo do navegador (apenas se disponível localmente);
 *  4. Extração de ^FD caso o ZPL também contenha comandos textuais.
 */

(function (global) {
  'use strict';

  // Tabela oficial de larguras (bar, space, bar, space, bar, space) dos 107 símbolos Code 128
  const CODE128_PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '233111'
  ];

  const PATTERN_TO_VALUE = new Map();
  CODE128_PATTERNS.forEach((pat, idx) => PATTERN_TO_VALUE.set(pat, idx));

  /**
   * Extrai sequências alternadas de pixels pretos e brancos (run-lengths) em uma linha Y do bitmap.
   * Começa sempre na primeira barra preta encontrada na linha.
   * @param {Uint8Array} bitmap
   * @param {number} width
   * @param {number} bytesPerRow
   * @param {number} y
   * @returns {number[]} Array de comprimentos [preto, branco, preto, branco, ...]
   */
  function getRowRuns(bitmap, width, bytesPerRow, y) {
    const runs = [];
    const rowOffset = y * bytesPerRow;
    let currentColor = 0; // 0 = branco, 1 = preto
    let currentLen = 0;
    let started = false;

    for (let x = 0; x < width; x++) {
      const byte = bitmap[rowOffset + (x >> 3)];
      const bit = (byte & (0x80 >> (x & 7))) !== 0 ? 1 : 0;

      if (!started) {
        if (bit === 1) {
          started = true;
          currentColor = 1;
          currentLen = 1;
        }
      } else if (bit === currentColor) {
        currentLen++;
      } else {
        runs.push(currentLen);
        currentColor = bit;
        currentLen = 1;
      }
    }
    if (started && currentLen > 0) {
      runs.push(currentLen);
    }
    return runs;
  }

  /**
   * Converte 6 barras/espaços consecutivos em um código de 6 dígitos normalizado (soma = 11 módulos).
   * @param {number[]} runs - Array de runs
   * @param {number} offset - Índice inicial (sempre em barra preta, índice par)
   * @returns {number} Valor do símbolo (0..106) ou -1 se inválido
   */
  function matchCode128Symbol(runs, offset) {
    if (offset + 5 >= runs.length) return -1;
    const r0 = runs[offset];
    const r1 = runs[offset + 1];
    const r2 = runs[offset + 2];
    const r3 = runs[offset + 3];
    const r4 = runs[offset + 4];
    const r5 = runs[offset + 5];
    const total = r0 + r1 + r2 + r3 + r4 + r5;
    if (total < 11) return -1;

    const unit = total / 11;
    const m0 = Math.max(1, Math.min(4, Math.round(r0 / unit)));
    const m1 = Math.max(1, Math.min(4, Math.round(r1 / unit)));
    const m2 = Math.max(1, Math.min(4, Math.round(r2 / unit)));
    const m3 = Math.max(1, Math.min(4, Math.round(r3 / unit)));
    const m4 = Math.max(1, Math.min(4, Math.round(r4 / unit)));
    const m5 = Math.max(1, Math.min(4, Math.round(r5 / unit)));

    if (m0 + m1 + m2 + m3 + m4 + m5 !== 11) return -1;
    const key = `${m0}${m1}${m2}${m3}${m4}${m5}`;
    return PATTERN_TO_VALUE.has(key) ? PATTERN_TO_VALUE.get(key) : -1;
  }

  /**
   * Decodifica uma sequência de valores Code 128 (incluindo Start A/B/C e trocas de subset)
   * após validar o checksum módulo 103.
   * @param {number[]} codes - Símbolos [startCode, ...dataCodes, checksumCode]
   * @returns {string|null} String decodificada ou null se checksum inválido
   */
  function decodeCode128Values(codes) {
    if (codes.length < 3) return null;
    const start = codes[0];
    if (start !== 103 && start !== 104 && start !== 105) return null;

    const checksumExpected = codes[codes.length - 1];
    let sum = start;
    for (let i = 1; i < codes.length - 1; i++) {
      sum += codes[i] * i;
    }
    if (sum % 103 !== checksumExpected) return null;

    let set = start === 103 ? 'A' : start === 104 ? 'B' : 'C';
    let out = '';
    let i = 1;
    const end = codes.length - 1;

    while (i < end) {
      const val = codes[i++];
      if (set === 'C') {
        if (val < 100) {
          out += String(val).padStart(2, '0');
        } else if (val === 100) {
          set = 'B';
        } else if (val === 101) {
          set = 'A';
        }
      } else if (set === 'B') {
        if (val < 95) {
          out += String.fromCharCode(32 + val);
        } else if (val === 98 && i < end) {
          // Shift A
          const nextVal = codes[i++];
          if (nextVal < 64) out += String.fromCharCode(32 + nextVal);
        } else if (val === 99) {
          set = 'C';
        } else if (val === 101) {
          set = 'A';
        }
      } else if (set === 'A') {
        if (val < 64) {
          out += String.fromCharCode(32 + val);
        } else if (val < 96) {
          out += String.fromCharCode(val - 64);
        } else if (val === 98 && i < end) {
          // Shift B
          const nextVal = codes[i++];
          if (nextVal < 95) out += String.fromCharCode(32 + nextVal);
        } else if (val === 99) {
          set = 'C';
        } else if (val === 100) {
          set = 'B';
        }
      }
    }

    return out.trim() || null;
  }

  /**
   * Varre linhas horizontais do bitmap 1-bit procurando códigos de barras Code 128.
   * Extremamente eficaz para o rastreio Shopee (BR + 13 caracteres) e chave de 44 dígitos da DANFE.
   * @param {Uint8Array} bitmap
   * @param {number} width
   * @param {number} height
   * @param {number} bytesPerRow
   * @returns {string[]} Lista de textos Code 128 únicos decodificados
   */
  function scanBitmapForCode128(bitmap, width, height, bytesPerRow) {
    if (!bitmap) return [];
    const found = new Set();

    // Varre a cada 6 dots verticalmente para cobrir todas as faixas de códigos de barras
    for (let y = 16; y < height - 16; y += 6) {
      const runs = getRowRuns(bitmap, width, bytesPerRow, y);
      if (runs.length < 19) continue;

      // Procura por um símbolo inicial (103, 104 ou 105) em cada barra preta (índices pares)
      for (let startIdx = 0; startIdx <= runs.length - 19; startIdx += 2) {
        const firstSym = matchCode128Symbol(runs, startIdx);
        if (firstSym !== 103 && firstSym !== 104 && firstSym !== 105) continue;

        const codes = [firstSym];
        let cursor = startIdx + 6;
        let matchedStop = false;

        while (cursor + 5 < runs.length && codes.length < 80) {
          const sym = matchCode128Symbol(runs, cursor);
          if (sym === -1) break;
          if (sym === 106) {
            // Stop symbol (possui uma barra final extra de 2 módulos)
            matchedStop = true;
            break;
          }
          codes.push(sym);
          cursor += 6;
        }

        if (matchedStop && codes.length >= 3) {
          const decoded = decodeCode128Values(codes);
          if (decoded && decoded.length >= 4) {
            found.add(decoded);
            break;
          }
        }
      }
    }

    return Array.from(found);
  }

  /**
   * Tenta decodificar um HTMLCanvasElement usando a biblioteca local ZXing (@zxing/library).
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<Array<{text: string, format: string}>>}
   */
  async function decodeCanvasWithZXing(canvas) {
    const results = [];
    if (!global.ZXing) return results;

    try {
      const luminanceSource = new global.ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const hybridBinarizer = new global.ZXing.HybridBinarizer(luminanceSource);
      const binaryBitmap = new global.ZXing.BinaryBitmap(hybridBinarizer);

      const hints = new Map();
      if (global.ZXing.DecodeHintType && global.ZXing.BarcodeFormat) {
        hints.set(global.ZXing.DecodeHintType.TRY_HARDER, true);
        hints.set(global.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
          global.ZXing.BarcodeFormat.CODE_128,
          global.ZXing.BarcodeFormat.QR_CODE
        ]);
      }

      // 1. Tenta MultiFormatReader
      if (global.ZXing.MultiFormatReader) {
        const reader = new global.ZXing.MultiFormatReader();
        reader.setHints(hints);
        try {
          const res = reader.decodeWithState(binaryBitmap);
          if (res && res.getText()) {
            results.push({
              text: res.getText().trim(),
              format: String(res.getBarcodeFormat ? res.getBarcodeFormat() : 'ZXING')
            });
          }
        } catch (_e) {
          // Ignora NotFoundException
        }
      }

      // 2. Tenta QRCodeReader especificamente na região
      if (global.ZXing.QRCodeReader) {
        const qrReader = new global.ZXing.QRCodeReader();
        try {
          const qrRes = qrReader.decode(binaryBitmap, hints);
          if (qrRes && qrRes.getText()) {
            results.push({
              text: qrRes.getText().trim(),
              format: 'QR_CODE'
            });
          }
        } catch (_e2) {
          // Ignora NotFoundException
        }
      }
    } catch (_err) {
      // Silencioso caso a versão carregada não exponha LuminanceSource diretamente
    }

    return results;
  }

  /**
   * Tenta decodificar um HTMLCanvasElement usando BarcodeDetector nativo (se disponível offline no navegador).
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<Array<{text: string, format: string}>>}
   */
  async function decodeCanvasWithNativeDetector(canvas) {
    if (typeof global.BarcodeDetector === 'undefined') return [];
    try {
      const detector = new global.BarcodeDetector({
        formats: ['code_128', 'qr_code']
      });
      const detected = await detector.detect(canvas);
      return (detected || [])
        .filter((d) => d && d.rawValue)
        .map((d) => ({
          text: d.rawValue.trim(),
          format: (d.format || 'NATIVE').toUpperCase()
        }));
    } catch (_e) {
      return [];
    }
  }

  /**
   * Extrai textos de ^FD...^FS caso o ZPL possua comandos de barra nativos (^BC, ^BQ).
   * @param {string} rawZpl
   * @returns {Array<{text: string, format: string}>}
   */
  function extractTextualZplCodes(rawZpl) {
    const out = [];
    if (!rawZpl) return out;
    const regex = /\^FD([^\^]+)\^FS/gi;
    let m;
    while ((m = regex.exec(rawZpl)) !== null) {
      let val = m[1].trim();
      // Remove prefixo de configuração de QR Code ^FDQA, ou ^FDMA,
      val = val.replace(/^[QMHL]A,/i, '').trim();
      if (val && val.length >= 5) {
        out.push({ text: val, format: 'ZPL_FD' });
      }
    }
    return out;
  }

  /**
   * Decodifica todos os códigos (Code 128 e QR Code) de uma etiqueta decodificada.
   * Testa:
   *  1. Varredura direta 1-bit para Code 128;
   *  2. Imagem 1x, 2x sem suavização (em faixas estratégicas da etiqueta Shopee) e invertida via ZXing / nativo;
   *  3. Classifica qual código é a chave de 44 dígitos da DANFE e qual é o rastreio principal (BR...).
   * @param {Object} labelObj - Objeto retornado por ZplBitmap.decodeSingleLabelBlock
   * @returns {Promise<Object>} { codes: Array<{text, format, isDanfe}>, trackingCode: string|null, danfeKey: string|null }
   */
  async function readAllCodesFromLabel(labelObj) {
    const codeMap = new Map(); // text -> { text, format, isDanfe }

    function addCode(text, format) {
      if (!text || typeof text !== 'string') return;
      const clean = text.trim();
      if (clean.length < 4) return;
      const isDanfe = /^\d{44}$/.test(clean.replace(/\s+/g, ''));
      const normalized = isDanfe ? clean.replace(/\s+/g, '') : clean;
      if (!codeMap.has(normalized)) {
        codeMap.set(normalized, {
          text: normalized,
          format: format || 'CODE_128',
          isDanfe
        });
      }
    }

    if (labelObj.hasGraphic && labelObj.bitmap) {
      const { bitmap, widthDots, heightDots, bytesPerRow } = labelObj;

      // 1. Leitura direta 1-bit de Code 128 (lê instantaneamente o BR... e a chave de 44 dígitos)
      const directCode128 = scanBitmapForCode128(bitmap, widthDots, heightDots, bytesPerRow);
      directCode128.forEach((txt) => addCode(txt, 'CODE_128'));

      // 2. Definição de faixas para leitura de QR Code e reforço de Code 128 (escala 1x, 2x sem suavização e invertida)
      const h = heightDots;
      const bands = [
        // Imagem completa 1x
        { cropY: 0, cropH: h, scale: 1, invert: false },
        // Faixa superior (destinatário + QR Code superior) ampliada 2x sem suavizar
        { cropY: 0, cropH: Math.min(h, 460), scale: 2, invert: false },
        // Faixa central (Code 128 BR... + QR Codes intermediários) ampliada 2x sem suavizar
        { cropY: Math.min(h - 100, 340), cropH: Math.min(h - 340, 520), scale: 2, invert: false },
        // Faixa inferior (DANFE) ampliada 2x sem suavizar
        { cropY: Math.max(0, h - 450), cropH: Math.min(h, 450), scale: 2, invert: false },
        // Versão invertida 2x da faixa superior/central para QR Codes sobre fundo escuro
        { cropY: 0, cropH: Math.min(h, 750), scale: 2, invert: true }
      ];

      for (const band of bands) {
        if (band.cropH <= 0) continue;
        const canvas = global.ZplBitmap.bitmapToCanvas(bitmap, widthDots, heightDots, bytesPerRow, band);

        const zxingResults = await decodeCanvasWithZXing(canvas);
        zxingResults.forEach((r) => addCode(r.text, r.format));

        const nativeResults = await decodeCanvasWithNativeDetector(canvas);
        nativeResults.forEach((r) => addCode(r.text, r.format));
      }
    } else {
      // Fallback para etiquetas ZPL em texto puro
      const txtCodes = extractTextualZplCodes(labelObj.rawZpl);
      txtCodes.forEach((r) => addCode(r.text, r.format));
    }

    const codes = Array.from(codeMap.values());
    const danfeObj = codes.find((c) => c.isDanfe) || null;
    // Prioriza código começando com BR + dígitos para trackingCode principal
    const brTrackingObj =
      codes.find((c) => !c.isDanfe && /^BR[0-9A-Z]{10,16}$/i.test(c.text)) ||
      codes.find((c) => !c.isDanfe && c.format.includes('128')) ||
      codes.find((c) => !c.isDanfe) ||
      null;

    return {
      codes,
      trackingCode: brTrackingObj ? brTrackingObj.text : null,
      danfeKey: danfeObj ? danfeObj.text : null
    };
  }

  global.BarcodeReader = {
    scanBitmapForCode128,
    readAllCodesFromLabel
  };
})(window);
