/**
 * ui/js/zpl-bitmap.js
 * Parser de blocos ZPL, decodificador de imagens (~DG e ^GF em :Z64: e Hex),
 * medição de espaço branco real no bitmap (topo e rodapé), deslocamento vertical
 * ("Subir etiqueta") e renderização em Canvas para miniaturas e leitura de códigos.
 */

(function (global) {
  'use strict';

  /**
   * Verifica se um bloco ZPL contém elementos imprimíveis reais (gráfico ~DG/^GF/^XG,
   * texto ^FD fora de comando ^ID, códigos de barras ^B ou caixas ^GB) e não é apenas
   * um bloco auxiliar de limpeza de memória da impressora (ex: ^XA^IDR:DEMO.GRF^FS^XZ).
   * @param {string} block
   * @returns {boolean}
   */
  function isPrintableZplBlock(block) {
    if (!block) return false;
    // Se tem download gráfico ~DG ou ^GFA/^GFB ou chamada ^XG -> imprimível
    if (/~DG/i.test(block) || /\^GF[AB]/i.test(block) || /\^XG/i.test(block)) {
      return true;
    }
    // Remove comandos ^ID...^FS (Image Delete, ex: ^IDR:DEMO.GRF^FS) para checar o restante
    const withoutId = block.replace(/\^ID[^\^]*?\^FS/gi, '');
    if (/\^FD[\s\S]*?\^FS/i.test(withoutId) || /\^B[0-9A-Z]/i.test(withoutId) || /\^GB/i.test(withoutId)) {
      return true;
    }
    return false;
  }

  /**
   * Divide um arquivo ZPL contendo uma ou mais etiquetas em blocos individuais.
   * Mantém comandos ~DG que antecedem imediatamente um bloco ^XA...^XZ juntos
   * e descarta blocos vazios ou de limpeza de memória (^XA^IDR:DEMO.GRF^FS^XZ).
   * @param {string} rawZpl - Conteúdo ZPL completo
   * @returns {string[]} Lista de blocos ZPL imprimíveis (um por etiqueta)
   */
  function splitZplLabels(rawZpl) {
    if (!rawZpl || typeof rawZpl !== 'string') return [];
    const text = rawZpl.trim();
    if (!text) return [];

    // Captura qualquer conteúdo antes de ^XZ (incluindo ~DG antes de ^XA) até ^XZ
    const regex = /[\s\S]*?\^XA[\s\S]*?\^XZ/gi;
    const matches = text.match(regex);
    if (matches && matches.length > 0) {
      const cleaned = matches.map((m) => m.trim()).filter(Boolean);
      const printable = cleaned.filter(isPrintableZplBlock);
      if (cleaned.length !== printable.length && global.DiagLogger && global.DiagLogger.log) {
        global.DiagLogger.log(
          'info',
          'ZPL',
          `Descartado(s) ${cleaned.length - printable.length} bloco(s) ZPL auxiliar(es) sem conteúdo imprimível (ex: limpeza de memória ^IDR:DEMO.GRF).`
        );
      }
      return printable;
    }
    return isPrintableZplBlock(text) ? [text] : [];
  }

  /**
   * Extrai metadados do comando gráfico (~DG ou ^GFA/^GFB) dentro de um bloco ZPL.
   * Suporta:
   *  - ~DGR:DEMO.GRF,124236,102,:Z64:<base64>:<crc>
   *  - ~DGR:DEMO.GRF,124236,102,<hex>
   *  - ^GFA,124236,124236,102,:Z64:<base64>:<crc>
   *  - ^GFA,124236,124236,102,<hex>
   * @param {string} blockZpl - Bloco ZPL de uma etiqueta
   * @returns {Object|null} Dados extraídos do comando gráfico
   */
  function parseGraphicCommand(blockZpl) {
    if (!blockZpl) return null;

    // 1. Tenta casar ~DG (Download Graphics)
    const dgRegex = /~DG\s*([A-Z0-9:._-]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,([\s\S]*?)(?=\^XA|\^FO|\^XZ|$)/i;
    const dgMatch = blockZpl.match(dgRegex);
    if (dgMatch) {
      const graphicName = dgMatch[1].trim();
      const totalBytes = parseInt(dgMatch[2], 10);
      const bytesPerRow = parseInt(dgMatch[3], 10);
      const rawPayload = dgMatch[4].trim();
      return {
        type: 'DG',
        graphicName,
        totalBytes,
        bytesPerRow,
        rawPayload,
        fullMatch: dgMatch[0]
      };
    }

    // 2. Tenta casar ^GFA ou ^GFB (Graphic Field)
    const gfRegex = /\^GF([AB])\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,([\s\S]*?)(?=\^FS|\^FO|\^XZ|$)/i;
    const gfMatch = blockZpl.match(gfRegex);
    if (gfMatch) {
      const mode = gfMatch[1].toUpperCase();
      const totalBytes = parseInt(gfMatch[3], 10) || parseInt(gfMatch[2], 10);
      const bytesPerRow = parseInt(gfMatch[4], 10);
      const rawPayload = gfMatch[5].trim();
      return {
        type: 'GF',
        mode,
        graphicName: null,
        totalBytes,
        bytesPerRow,
        rawPayload,
        fullMatch: gfMatch[0]
      };
    }

    return null;
  }

  /**
   * Descomprime um buffer zlib/deflate usando DecompressionStream nativo do navegador.
   * Tenta 'deflate' (com cabeçalho zlib RFC 1950) e faz fallback para 'deflate-raw'.
   * @param {Uint8Array} compressedBytes - Bytes comprimidos
   * @returns {Promise<Uint8Array>} Bytes descomprimidos
   */
  async function decompressZlibBytes(compressedBytes) {
    async function tryStream(format, sliceBytes) {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      writer.write(sliceBytes);
      writer.close();
      const response = new Response(ds.readable);
      const ab = await response.arrayBuffer();
      return new Uint8Array(ab);
    }

    try {
      return await tryStream('deflate', compressedBytes);
    } catch (_err1) {
      // Fallback: pula os 2 bytes de header zlib (ex: 0x78 0x9C) e remove os 4 bytes de Adler32 no final
      const rawSlice = compressedBytes.length > 6
        ? compressedBytes.subarray(2, compressedBytes.length - 4)
        : compressedBytes.subarray(2);
      try {
        return await tryStream('deflate-raw', rawSlice);
      } catch (_err2) {
        // Segunda tentativa sem cortar o final
        return await tryStream('deflate-raw', compressedBytes.subarray(2));
      }
    }
  }

  /**
   * Comprime um Uint8Array em formato :Z64: (zlib + base64) usando CompressionStream nativo.
   * @param {Uint8Array} rawBytes - Bitmap 1-bit
   * @returns {Promise<string|null>} String no formato :Z64:<base64>:0000 ou null se indisponível
   */
  async function compressToZ64(rawBytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate');
      const writer = cs.writable.getWriter();
      writer.write(rawBytes);
      writer.close();
      const resp = new Response(cs.readable);
      const ab = await resp.arrayBuffer();
      const u8 = new Uint8Array(ab);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < u8.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
      }
      const b64 = btoa(binary);
      const crc = computeZplCrc16(b64);
      return `:Z64:${b64}:${crc}`;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Calcula o CRC-16 CCITT (polinômio 0x1021) em hexadecimal de 4 dígitos para o rodapé :Z64:.
   * @param {string} str - Texto base64
   * @returns {string} CRC hexadecimal de 4 caracteres
   */
  function computeZplCrc16(str) {
    let crc = 0x0000;
    for (let i = 0; i < str.length; i++) {
      crc ^= (str.charCodeAt(i) & 0xff) << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  /**
   * Decodifica um payload :Z64:<base64>:<crc> para Uint8Array (1 bit por pixel).
   * @param {string} payload - Payload contendo :Z64:
   * @param {number} expectedBytes - Total de bytes esperados no bitmap
   * @returns {Promise<Uint8Array>}
   */
  async function decodeZ64Payload(payload, expectedBytes) {
    let clean = payload.trim();
    const z64Idx = clean.toUpperCase().indexOf(':Z64:');
    if (z64Idx >= 0) {
      clean = clean.slice(z64Idx + 5);
    }
    // Remove o :CRC final (ex: :A1B2) ou comandos ZPL subsequentes
    const colonIdx = clean.indexOf(':');
    if (colonIdx >= 0) {
      clean = clean.slice(0, colonIdx);
    }
    const caretIdx = clean.indexOf('^');
    if (caretIdx >= 0) {
      clean = clean.slice(0, caretIdx);
    }
    clean = clean.replace(/[\r\n\s]/g, '');

    const binStr = atob(clean);
    const compBytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      compBytes[i] = binStr.charCodeAt(i);
    }

    const decompressed = await decompressZlibBytes(compBytes);
    if (expectedBytes > 0 && decompressed.length !== expectedBytes) {
      const out = new Uint8Array(expectedBytes);
      out.set(decompressed.subarray(0, Math.min(decompressed.length, expectedBytes)));
      return out;
    }
    return decompressed;
  }

  /**
   * Decodifica dados gráficos ZPL em Hexadecimal ASCII (incluindo compressão RLE da Zebra:
   * G..Y = 1..19, g..z = 20..400, ',' = preenche fim da linha com 00, '!' = preenche com FF, ':' = repete linha anterior).
   * @param {string} hexPayload - String hexadecimal/RLE ZPL
   * @param {number} totalBytes - Total de bytes do bitmap
   * @param {number} bytesPerRow - Bytes por linha
   * @returns {Uint8Array}
   */
  function decodeZplHexPayload(hexPayload, totalBytes, bytesPerRow) {
    const out = new Uint8Array(totalBytes);
    const charsPerRow = bytesPerRow * 2;
    let hexChars = '';
    let currentLineChars = 0;
    let prevRowHex = '0'.repeat(charsPerRow);

    const s = hexPayload.replace(/[\r\n\s]/g, '');
    let repeatCount = 0;
    let i = 0;

    while (i < s.length && hexChars.length < totalBytes * 2) {
      const ch = s[i++];
      const code = ch.charCodeAt(0);

      if (code >= 71 && code <= 89) {
        // 'G' (71) a 'Y' (89) -> 1 a 19
        repeatCount += code - 70;
        continue;
      }
      if (code >= 103 && code <= 122) {
        // 'g' (103) a 'z' (122) -> 20 a 400
        repeatCount += (code - 102) * 20;
        continue;
      }

      if (ch === ',') {
        const rem = charsPerRow - (currentLineChars % charsPerRow);
        const fill = '0'.repeat(rem === 0 ? charsPerRow : rem);
        hexChars += fill;
        currentLineChars += fill.length;
        repeatCount = 0;
        if (currentLineChars >= charsPerRow) {
          prevRowHex = hexChars.slice(hexChars.length - charsPerRow);
          currentLineChars = 0;
        }
        continue;
      }

      if (ch === '!') {
        const rem = charsPerRow - (currentLineChars % charsPerRow);
        const fill = 'F'.repeat(rem === 0 ? charsPerRow : rem);
        hexChars += fill;
        currentLineChars += fill.length;
        repeatCount = 0;
        if (currentLineChars >= charsPerRow) {
          prevRowHex = hexChars.slice(hexChars.length - charsPerRow);
          currentLineChars = 0;
        }
        continue;
      }

      if (ch === ':') {
        hexChars += prevRowHex;
        currentLineChars = 0;
        repeatCount = 0;
        continue;
      }

      if (/[0-9A-Fa-f]/.test(ch)) {
        const count = repeatCount > 0 ? repeatCount : 1;
        const chunk = ch.repeat(count);
        hexChars += chunk;
        currentLineChars += chunk.length;
        repeatCount = 0;
        while (currentLineChars >= charsPerRow) {
          prevRowHex = hexChars.slice(hexChars.length - currentLineChars, hexChars.length - currentLineChars + charsPerRow);
          currentLineChars -= charsPerRow;
        }
      } else {
        repeatCount = 0;
      }
    }

    const maxPairs = Math.min(totalBytes, Math.floor(hexChars.length / 2));
    for (let b = 0; b < maxPairs; b++) {
      out[b] = parseInt(hexChars.substr(b * 2, 2), 16) || 0;
    }
    return out;
  }

  /**
   * Codifica um bitmap 1-bit em Hexadecimal ASCII puro para substituir ~DG ou ^GFA caso CompressionStream falhe.
   * @param {Uint8Array} bitmap - Bytes do bitmap
   * @returns {string} String hexadecimal maiúscula
   */
  function encodeBitmapToHex(bitmap) {
    const hexLut = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));
    const parts = new Array(bitmap.length);
    for (let i = 0; i < bitmap.length; i++) {
      parts[i] = hexLut[bitmap[i]];
    }
    return parts.join('');
  }

  /**
   * Mede a primeira e a última linha com pixel preto (bit = 1) no bitmap 1-bit.
   * Ignora eventuais ruídos de 1 pixel isolado na borda se necessário, mas considera
   * qualquer byte != 0 como linha com tinta preta para segurança máxima na térmica.
   * @param {Uint8Array} bitmap - Bitmap 1-bit
   * @param {number} bytesPerRow - Bytes por linha (ex: 102 para 816 dots)
   * @param {number} height - Altura total em linhas (ex: 1218)
   * @returns {{firstBlackRow: number, lastBlackRow: number, freeTopDots: number, freeBottomDots: number}}
   */
  function measureBitmapVerticalSpace(bitmap, bytesPerRow, height) {
    let firstBlackRow = height;
    let lastBlackRow = 0;

    for (let y = 0; y < height; y++) {
      const rowStart = y * bytesPerRow;
      let hasBlack = false;
      for (let bx = 0; bx < bytesPerRow; bx++) {
        if (bitmap[rowStart + bx] !== 0) {
          hasBlack = true;
          break;
        }
      }
      if (hasBlack) {
        if (y < firstBlackRow) firstBlackRow = y;
        if (y > lastBlackRow) lastBlackRow = y;
      }
    }

    if (firstBlackRow === height) {
      // Etiqueta totalmente branca
      firstBlackRow = 0;
      lastBlackRow = 0;
    }

    const freeTopDots = firstBlackRow;
    const freeBottomDots = Math.max(0, height - 1 - lastBlackRow);

    return {
      firstBlackRow,
      lastBlackRow,
      freeTopDots,
      freeBottomDots
    };
  }

  /**
   * Desloca o bitmap para cima em até `requestedShiftDots`, garantindo no mínimo
   * 16 dots de margem branca no topo. As linhas liberadas na base recebem 0x00 (branco).
   * @param {Uint8Array} bitmap - Bitmap original
   * @param {number} bytesPerRow - Bytes por linha
   * @param {number} height - Altura em dots
   * @param {number} requestedShiftDots - Quantidade de dots solicitada para subir
   * @returns {{shiftedBitmap: Uint8Array, actualShift: number, bounds: Object}}
   */
  function shiftBitmapUp(bitmap, bytesPerRow, height, requestedShiftDots) {
    const initialBounds = measureBitmapVerticalSpace(bitmap, bytesPerRow, height);
    const req = Math.max(0, Math.floor(Number(requestedShiftDots) || 0));
    if (req === 0) {
      return {
        shiftedBitmap: bitmap,
        actualShift: 0,
        bounds: initialBounds
      };
    }

    // Não deixa menos de 16 dots brancos no topo
    const maxAllowedShift = Math.max(0, initialBounds.firstBlackRow - 16);
    const actualShift = Math.min(req, maxAllowedShift);

    if (actualShift <= 0) {
      return {
        shiftedBitmap: bitmap,
        actualShift: 0,
        bounds: initialBounds
      };
    }

    const shifted = new Uint8Array(bitmap.length);
    const byteOffset = actualShift * bytesPerRow;
    shifted.set(bitmap.subarray(byteOffset), 0);
    // O restante no final já é 0x00 (branco) por padrão no Uint8Array

    const newBounds = measureBitmapVerticalSpace(shifted, bytesPerRow, height);
    return {
      shiftedBitmap: shifted,
      actualShift,
      bounds: newBounds
    };
  }

  /**
   * Redimensiona proporcionalmente o bitmap 1-bit da etiqueta (ex: 88%) centralizando na horizontal
   * e ancorando no topo (com suporte adicional a "Subir etiqueta"), liberando amplo espaço branco
   * no rodapé para impressão das SKUs numeradas sem cortar o cabeçalho.
   * @param {Uint8Array} bitmap - Bitmap 1-bit original (816x1218)
   * @param {number} bytesPerRow - Bytes por linha (102)
   * @param {number} height - Altura em dots (1218)
   * @param {number} scalePercent - Escala percentual (ex: 88 para 88%)
   * @param {number} requestedShiftDots - Deslocamento vertical adicional para cima
   * @returns {{transformedBitmap: Uint8Array, actualShift: number, scalePercent: number, bounds: Object}}
   */
  function scaleAndShiftBitmap1Bit(bitmap, bytesPerRow, height, scalePercent, requestedShiftDots) {
    const pct = Math.min(100, Math.max(60, Number(scalePercent) || 88));
    const shiftReq = Math.max(0, Math.floor(Number(requestedShiftDots) || 0));

    if (pct >= 100) {
      const s = shiftBitmapUp(bitmap, bytesPerRow, height, shiftReq);
      return {
        transformedBitmap: s.shiftedBitmap,
        actualShift: s.actualShift,
        scalePercent: 100,
        bounds: s.bounds
      };
    }

    const width = bytesPerRow * 8;
    const scaledW = Math.round((width * pct) / 100);
    const scaledH = Math.round((height * pct) / 100);
    const offsetX = Math.floor((width - scaledW) / 2);
    const baseTopPad = 6;

    const out = new Uint8Array(bitmap.length);

    for (let dy = 0; dy < scaledH; dy++) {
      const dstY = dy + baseTopPad - shiftReq;
      if (dstY < 4 || dstY >= height) continue;

      const sy = Math.min(height - 1, Math.floor(((dy + 0.5) * height) / scaledH));
      const srcRowOffset = sy * bytesPerRow;
      const dstRowOffset = dstY * bytesPerRow;

      for (let dx = 0; dx < scaledW; dx++) {
        const dstX = dx + offsetX;
        if (dstX < 0 || dstX >= width) continue;

        const sx = Math.min(width - 1, Math.floor(((dx + 0.5) * width) / scaledW));
        const srcByte = bitmap[srcRowOffset + (sx >> 3)];
        if ((srcByte & (0x80 >> (sx & 7))) !== 0) {
          out[dstRowOffset + (dstX >> 3)] |= 0x80 >> (dstX & 7);
        }
      }
    }

    const newBounds = measureBitmapVerticalSpace(out, bytesPerRow, height);
    return {
      transformedBitmap: out,
      actualShift: shiftReq,
      scalePercent: pct,
      bounds: newBounds
    };
  }

  /**
   * Renderiza o bitmap 1-bit (ou uma região recortada dele) em um elemento HTMLCanvasElement.
   * Suporta ampliação inteira sem suavização (nearest-neighbor) e inversão de cores.
   * @param {Uint8Array} bitmap - Bitmap 1-bit (bit 1 = preto, bit 0 = branco)
   * @param {number} width - Largura em dots (bytesPerRow * 8)
   * @param {number} height - Altura em dots
   * @param {number} bytesPerRow - Bytes por linha
   * @param {Object} [opts] - Opções: { scale: 1|2, invert: boolean, cropY: number, cropH: number }
   * @returns {HTMLCanvasElement}
   */
  function bitmapToCanvas(bitmap, width, height, bytesPerRow, opts) {
    const options = opts || {};
    const scale = options.scale || 1;
    const invert = Boolean(options.invert);
    const cropY = Math.max(0, options.cropY || 0);
    const cropH = Math.min(height - cropY, options.cropH || height);

    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = width;
    baseCanvas.height = cropH;
    const ctx = baseCanvas.getContext('2d');
    const imgData = ctx.createImageData(width, cropH);
    const data = imgData.data;

    const fg = invert ? 255 : 0;
    const bg = invert ? 0 : 255;

    for (let y = 0; y < cropH; y++) {
      const srcY = cropY + y;
      const rowOffset = srcY * bytesPerRow;
      const dstRowOffset = y * width * 4;

      for (let bx = 0; bx < bytesPerRow; bx++) {
        const byte = bitmap[rowOffset + bx];
        const baseX = bx * 8;
        for (let bit = 0; bit < 8; bit++) {
          const isBlack = (byte & (0x80 >> bit)) !== 0;
          const color = isBlack ? fg : bg;
          const idx = dstRowOffset + (baseX + bit) * 4;
          data[idx] = color;
          data[idx + 1] = color;
          data[idx + 2] = color;
          data[idx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);

    if (scale === 1) {
      return baseCanvas;
    }

    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = width * scale;
    scaledCanvas.height = cropH * scale;
    const sCtx = scaledCanvas.getContext('2d');
    sCtx.imageSmoothingEnabled = false;
    sCtx.drawImage(baseCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
    return scaledCanvas;
  }

  /**
   * Decodifica uma etiqueta ZPL completa, retornando o bitmap, dimensões, espaço livre
   * e miniatura para exibição na tabela de conferência.
   * @param {string} blockZpl - Bloco ZPL de uma etiqueta
   * @param {number} index - Índice da etiqueta (0..N-1)
   * @returns {Promise<Object>} Objeto estruturado da etiqueta
   */
  async function decodeSingleLabelBlock(blockZpl, index) {
    const dlog = global.DiagLogger ? global.DiagLogger.log : () => {};
    const cmd = parseGraphicCommand(blockZpl);
    if (!cmd || !cmd.bytesPerRow || !cmd.totalBytes) {
      dlog('info', 'ZPL', `Etiqueta #${index + 1}: Bloco ZPL textual puro (sem comando gráfico ~DG ou ^GF).`, {
        chars: blockZpl ? blockZpl.length : 0,
        preview: blockZpl ? blockZpl.slice(0, 160) : ''
      });
      // Etiqueta ZPL textual (sem ~DG ou ^GF gráfico)
      return {
        index,
        rawZpl: blockZpl,
        hasGraphic: false,
        widthDots: 816,
        heightDots: 1218,
        bytesPerRow: 102,
        totalBytes: 0,
        bitmap: null,
        blackPixels: 0,
        firstBlackRow: 0,
        lastBlackRow: 1120,
        freeTopDots: 40,
        freeBottomDots: 98,
        thumbnailUrl: null,
        graphicMeta: null
      };
    }

    const widthDots = cmd.bytesPerRow * 8;
    const heightDots = Math.floor(cmd.totalBytes / cmd.bytesPerRow);
    const isZ64 = cmd.rawPayload.toUpperCase().includes(':Z64:');
    const dgBeforeXa = cmd.type === 'DG' && blockZpl.indexOf('~DG') < blockZpl.toUpperCase().indexOf('^XA');

    let bitmap;
    try {
      if (isZ64) {
        bitmap = await decodeZ64Payload(cmd.rawPayload, cmd.totalBytes);
      } else {
        bitmap = decodeZplHexPayload(cmd.rawPayload, cmd.totalBytes, cmd.bytesPerRow);
      }
    } catch (err) {
      dlog('error', 'BITMAP', `Etiqueta #${index + 1}: Falha ao descomprimir gráfico ${cmd.type} (${isZ64 ? ':Z64:' : 'Hex'}): ${err.message}`, {
        graphicName: cmd.graphicName,
        totalBytes: cmd.totalBytes,
        bytesPerRow: cmd.bytesPerRow,
        payloadStart: cmd.rawPayload.slice(0, 80)
      });
      bitmap = new Uint8Array(cmd.totalBytes);
    }

    const blackPixels = global.LocalLabelRenderer
      ? global.LocalLabelRenderer.countBlackPixelsInBitmap(bitmap)
      : 1;

    const bounds = measureBitmapVerticalSpace(bitmap, cmd.bytesPerRow, heightDots);
    const canvas = bitmapToCanvas(bitmap, widthDots, heightDots, cmd.bytesPerRow, { scale: 1 });
    const thumbnailUrl = canvas.toDataURL('image/png');

    if (blackPixels === 0) {
      dlog('warn', 'BITMAP', `Etiqueta #${index + 1}: Bitmap decodificado contém 0 pixels pretos (etiqueta em branco na origem)!`, {
        type: cmd.type,
        isZ64,
        totalBytes: cmd.totalBytes
      });
    } else {
      dlog('ok', 'BITMAP', `Etiqueta #${index + 1}: Gráfico ${cmd.type} (${isZ64 ? ':Z64:' : 'Hex'}) decodificado com sucesso (${widthDots}x${heightDots} dots).`, {
        graphicName: cmd.graphicName,
        dgForaDoXA: dgBeforeXa,
        blackPixels,
        firstBlackRow: bounds.firstBlackRow,
        lastBlackRow: bounds.lastBlackRow,
        freeBottomDots: bounds.freeBottomDots
      });
    }

    return {
      index,
      rawZpl: blockZpl,
      hasGraphic: true,
      widthDots,
      heightDots,
      bytesPerRow: cmd.bytesPerRow,
      totalBytes: cmd.totalBytes,
      bitmap,
      blackPixels,
      firstBlackRow: bounds.firstBlackRow,
      lastBlackRow: bounds.lastBlackRow,
      freeTopDots: bounds.freeTopDots,
      freeBottomDots: bounds.freeBottomDots,
      thumbnailUrl,
      graphicMeta: cmd
    };
  }

  global.ZplBitmap = {
    splitZplLabels,
    parseGraphicCommand,
    decodeSingleLabelBlock,
    measureBitmapVerticalSpace,
    shiftBitmapUp,
    scaleAndShiftBitmap1Bit,
    compressToZ64,
    encodeBitmapToHex,
    bitmapToCanvas
  };
})(window);
