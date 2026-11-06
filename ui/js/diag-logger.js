/**
 * ui/js/diag-logger.js
 * Sistema de Logs de Diagnóstico em tempo real + Renderizador Local de Etiquetas (Canvas 1-bit + Gerador PDF 100x150mm).
 * Permite identificar exatamente falhas de conversão na API (como páginas em branco com ~DG/:Z64:)
 * e garante geração fiel do Preview e do PDF mesmo quando o motor offline da API ignora gráficos :Z64:.
 */

(function (global) {
  'use strict';

  const LOG_ENTRIES = [];
  let errorAndWarnCount = 0;

  function formatTime(d) {
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  /**
   * Registra uma entrada no Console de Diagnóstico da interface e no DevTools.
   * @param {'info'|'ok'|'warn'|'error'|'debug'} level
   * @param {string} category - Ex: 'API', 'ZPL', 'BITMAP', 'BARCODE', 'EXCEL', 'CONVERT'
   * @param {string} message
   * @param {any} [details]
   */
  function log(level, category, message, details) {
    const entry = {
      id: LOG_ENTRIES.length + 1,
      ts: formatTime(new Date()),
      level: level || 'info',
      category: String(category || 'APP').toUpperCase(),
      message: String(message || ''),
      details: details !== undefined && details !== null
        ? (typeof details === 'string' ? details : JSON.stringify(details, null, 2))
        : null
    };
    LOG_ENTRIES.push(entry);

    if (entry.level === 'error' || entry.level === 'warn') {
      errorAndWarnCount++;
    }

    // Espelha no console do navegador para inspeção no F12
    const prefix = `[${entry.ts}] [${entry.category}] ${entry.message}`;
    if (entry.level === 'error') {
      console.error(prefix, details || '');
    } else if (entry.level === 'warn') {
      console.warn(prefix, details || '');
    } else {
      console.log(prefix, details || '');
    }

    renderLogList();
  }

  function renderLogList() {
    const badge = document.getElementById('log-count-badge');
    if (badge) {
      badge.textContent = String(LOG_ENTRIES.length);
      if (errorAndWarnCount > 0) {
        badge.style.background = '#fee2e2';
        badge.style.color = '#991b1b';
        badge.style.borderColor = '#fecaca';
      } else {
        badge.style.background = '';
        badge.style.color = '';
        badge.style.borderColor = '';
      }
    }

    const container = document.getElementById('diag-log-list');
    if (!container) return;

    if (LOG_ENTRIES.length === 0) {
      container.innerHTML = `<div class="log-empty">Nenhum evento registrado ainda.</div>`;
      return;
    }

    const escFn = global.esc || ((s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

    container.innerHTML = LOG_ENTRIES.map((e) => {
      const detailsHtml = e.details
        ? `<pre class="log-details">${escFn(e.details)}</pre>`
        : '';
      return `
        <div class="log-item log-${e.level}">
          <div class="log-head">
            <span class="log-ts">${escFn(e.ts)}</span>
            <span class="log-lvl log-lvl-${e.level}">${escFn(e.level.toUpperCase())}</span>
            <span class="log-cat">[${escFn(e.category)}]</span>
            <span class="log-msg">${escFn(e.message)}</span>
          </div>
          ${detailsHtml}
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  }

  function clearLogs() {
    LOG_ENTRIES.length = 0;
    errorAndWarnCount = 0;
    renderLogList();
    log('info', 'SYS', 'Histórico de logs limpo pelo usuário.');
  }

  async function copyLogs() {
    const text = LOG_ENTRIES.map((e) => {
      let line = `[${e.ts}] [${e.level.toUpperCase()}] [${e.category}] ${e.message}`;
      if (e.details) line += `\n  Detalhes: ${e.details.replace(/\n/g, '\n  ')}`;
      return line;
    }).join('\n');

    try {
      await navigator.clipboard.writeText(text || 'Sem logs.');
      if (global.toast) global.toast('Logs copiados para a área de transferência!', 'ok');
    } catch (_err) {
      const ta = document.createElement('textarea');
      ta.value = text || 'Sem logs.';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      if (global.toast) global.toast('Logs copiados!', 'ok');
    }
  }

  function downloadLogs() {
    const text = LOG_ENTRIES.map((e) => {
      let line = `[${e.ts}] [${e.level.toUpperCase()}] [${e.category}] ${e.message}`;
      if (e.details) line += `\n  Detalhes: ${e.details.replace(/\n/g, '\n  ')}`;
      return line;
    }).join('\n\n');
    const b = new Blob([text || 'Sem logs.'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagnostico_zpl2pdf_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /**
   * Verifica o ambiente offline do navegador e registra no log.
   */
  function logEnvironmentCheck() {
    const libs = {
      JSZip: typeof global.JSZip !== 'undefined',
      XLSX: typeof global.XLSX !== 'undefined',
      ZXing: typeof global.ZXing !== 'undefined',
      DecompressionStream: typeof global.DecompressionStream !== 'undefined',
      CompressionStream: typeof global.CompressionStream !== 'undefined',
      BarcodeDetector: typeof global.BarcodeDetector !== 'undefined'
    };
    log('info', 'INIT', 'Ambiente ZPL²PDF Studio inicializado.', libs);
  }

  // ============================================================================
  // RENDERIZADOR LOCAL DE ETIQUETAS (BITMAP 1-BIT + RODAPÉ SKU + PDF 100x150mm)
  // ============================================================================

  /**
   * Conta quantos pixels pretos (bits = 1) existem em um bitmap 1-bit.
   * @param {Uint8Array|null} bitmap
   * @returns {number}
   */
  function countBlackPixelsInBitmap(bitmap) {
    if (!bitmap || !bitmap.length) return 0;
    let total = 0;
    for (let i = 0; i < bitmap.length; i++) {
      let b = bitmap[i];
      while (b) {
        b &= b - 1;
        total++;
      }
    }
    return total;
  }

  /**
   * Desenha o texto da SKU no rodapé de um Canvas 816x1218 e binariza os pixels (preto puro #000000),
   * reproduzindo fielmente a posição Y, tamanho da fonte em dots, alinhamento e negrito.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} fitResult
   * @param {Object} config
   */
  function drawSkuFooterOnCanvas(canvas, fitResult, config) {
    if (!canvas || !fitResult || !fitResult.hasText || !fitResult.lines || fitResult.lines.length === 0) {
      return;
    }
    const ctx = canvas.getContext('2d');
    const fontH = Number(fitResult.fontSize) || 16;
    const yStart = Number(fitResult.yStart) || 1050;
    const align = (config && config.align) || 'L';
    const isBold = Boolean(config && config.bold);

    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'top';
    ctx.font = `${isBold ? '700' : '500'} ${fontH}px "Figtree", "IBM Plex Mono", Arial, sans-serif`;

    const leftMargin = 20;
    const usableWidth = canvas.width - 40; // 776 para largura 816

    fitResult.lines.forEach((lineStr, idx) => {
      const y = yStart + idx * (fontH + 3);
      let x = leftMargin;
      if (align === 'C') {
        ctx.textAlign = 'center';
        x = leftMargin + Math.floor(usableWidth / 2);
      } else if (align === 'R') {
        ctx.textAlign = 'right';
        x = leftMargin + usableWidth;
      } else {
        ctx.textAlign = 'left';
        x = leftMargin;
      }
      ctx.fillText(lineStr, x, y);
      if (isBold) {
        ctx.fillText(lineStr, x + 1, y);
      }
    });
    ctx.restore();
  }

  /**
   * Converte um HTMLCanvasElement de volta para bitmap 1-bit (Uint8Array) onde luminância < 170 vira bit 1 (preto).
   * Útil para embutir a SKU desenhada diretamente nos bytes gráficos se necessário.
   * @param {HTMLCanvasElement} canvas
   * @param {number} bytesPerRow
   * @returns {Uint8Array}
   */
  function canvasTo1BitBitmap(canvas, bytesPerRow) {
    const w = canvas.width;
    const h = canvas.height;
    const bpr = bytesPerRow || Math.ceil(w / 8);
    const out = new Uint8Array(bpr * h);
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;

    for (let y = 0; y < h; y++) {
      const rowByteOffset = y * bpr;
      const rowPixOffset = y * w * 4;
      for (let x = 0; x < w; x++) {
        const p = rowPixOffset + x * 4;
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        const a = data[p + 3];
        // Se for escuro e opaco -> bit 1 (preto)
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (a > 128 && lum < 175) {
          const bx = Math.floor(x / 8);
          const bit = 7 - (x % 8);
          out[rowByteOffset + bx] |= (1 << bit);
        }
      }
    }
    return out;
  }

  /**
   * Renderiza uma etiqueta decodificada (com redução proporcional de tamanho, deslocamento vertical e SKU no rodapé)
   * em um HTMLCanvasElement de alta definição (816x1218 dots).
   * @param {Object} labelObj
   * @param {Object|null} fitResult
   * @param {Object} config
   * @returns {HTMLCanvasElement}
   */
  function renderLabelWithSkuToCanvas(labelObj, fitResult, config) {
    const widthDots = (labelObj && labelObj.widthDots) || 816;
    const baseHeightDots = (labelObj && labelObj.heightDots) || 1218;
    const heightDots = (fitResult && fitResult.extendedHeightDots)
      ? Math.max(baseHeightDots, fitResult.extendedHeightDots)
      : baseHeightDots;
    const bytesPerRow = (labelObj && labelObj.bytesPerRow) || Math.ceil(widthDots / 8);

    if (labelObj && labelObj.hasGraphic && labelObj.bitmap) {
      const shiftReq = Math.max(0, Math.floor(Number(config && config.shiftUpDots) || 0));
      const scalePct = Math.min(100, Math.max(60, Number(config && config.labelScalePercent) || 88));
      let bitmapToDraw = labelObj.bitmap;

      if ((scalePct < 100 || shiftReq > 0) && global.ZplBitmap && global.ZplBitmap.scaleAndShiftBitmap1Bit) {
        const transformed = global.ZplBitmap.scaleAndShiftBitmap1Bit(
          labelObj.bitmap,
          bytesPerRow,
          baseHeightDots,
          scalePct,
          shiftReq
        );
        bitmapToDraw = transformed.transformedBitmap;
      }

      const baseCanvas = global.ZplBitmap.bitmapToCanvas(
        bitmapToDraw,
        widthDots,
        baseHeightDots,
        bytesPerRow,
        { scale: 1 }
      );

      let targetCanvas = baseCanvas;
      if (heightDots > baseHeightDots) {
        targetCanvas = document.createElement('canvas');
        targetCanvas.width = widthDots;
        targetCanvas.height = heightDots;
        const tCtx = targetCanvas.getContext('2d');
        tCtx.fillStyle = '#ffffff';
        tCtx.fillRect(0, 0, widthDots, heightDots);
        tCtx.drawImage(baseCanvas, 0, 0);
      }

      if (!config || config.enabled !== false) {
        drawSkuFooterOnCanvas(targetCanvas, fitResult, config);
      }
      return targetCanvas;
    }

    // Fallback para etiqueta ZPL puramente textual caso renderizada localmente
    const canvas = document.createElement('canvas');
    canvas.width = widthDots;
    canvas.height = heightDots;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, widthDots, heightDots);
    ctx.fillStyle = '#000000';

    const raw = (labelObj && labelObj.rawZpl) || '';
    // Renderiza caixas ^GB básicas e textos ^FD básicos
    const gbRegex = /\^FO\s*(\d+)\s*,\s*(\d+)\s*\^GB\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi;
    let m;
    while ((m = gbRegex.exec(raw)) !== null) {
      const x = parseInt(m[1], 10);
      const y = parseInt(m[2], 10);
      const w = parseInt(m[3], 10);
      const h = parseInt(m[4], 10);
      ctx.fillRect(x, y, w, Math.max(2, h));
    }

    const fdRegex = /\^FO\s*(\d+)\s*,\s*(\d+)(?:[^\^]*?\^(?:A0N|CF0)\s*,\s*(\d+))?[^\^]*?\^FD([^\^]*?)\^FS/gi;
    while ((m = fdRegex.exec(raw)) !== null) {
      const x = parseInt(m[1], 10);
      const y = parseInt(m[2], 10);
      const fh = parseInt(m[3], 10) || 26;
      const txt = m[4].replace(/\\&/g, ' / ');
      ctx.font = `700 ${fh}px "IBM Plex Mono", Arial, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(txt, x, y);
    }

    if (!config || config.enabled !== false) {
      drawSkuFooterOnCanvas(canvas, fitResult, config);
    }
    return canvas;
  }

  /**
   * Renderiza uma etiqueta extra de continuação (quando "Imprimir lista completa em etiqueta extra" está ativa)
   * em um Canvas 816x1218.
   */
  function renderExtraContinuationCanvas(orderObj, labelNumber, config) {
    const canvas = document.createElement('canvas');
    canvas.width = 816;
    canvas.height = 1218;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 816, 1218);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'top';

    const tokens = global.MatcherInjector
      ? global.MatcherInjector.buildItemSkuTokens(orderObj, config)
      : [];

    ctx.font = '700 26px "IBM Plex Mono", Arial, sans-serif';
    ctx.fillText(`CONTINUACAO ETIQUETA #${labelNumber} (${tokens.length} ITENS)`, 24, 28);
    if (orderObj && orderObj.trackingNumber) {
      ctx.font = '500 22px "IBM Plex Mono", Arial, sans-serif';
      ctx.fillText(`Rastreio: ${orderObj.trackingNumber}`, 24, 62);
    }
    ctx.fillRect(24, 94, 768, 2);

    let y = 114;
    ctx.font = `${config && config.bold ? '900' : '700'} 25px "IBM Plex Mono", Arial, sans-serif`;
    tokens.forEach((skuTok, idx) => {
      if (y > 1160) return;
      ctx.fillText(`${idx + 1}. ${skuTok}`, 24, y);
      y += 38;
    });
    return canvas;
  }

  /**
   * Gera um arquivo PDF multi-página binário válido (PDF 1.4 com streams JPEG /DCTDecode)
   * diretamente no navegador a partir de uma lista de HTMLCanvasElement.
   * Dimensão física exata: widthInches x heightInches (padrão 4x6 pol = 288x432 pt = 100x150 mm).
   * @param {HTMLCanvasElement[]} canvases
   * @param {number} [widthInches=4]
   * @param {number} [heightInches=6]
   * @returns {Blob} Blob application/pdf pronto para visualização e download
   */
  function generatePdfBlobFromCanvases(canvases, widthInches, heightInches) {
    const wPt = Math.round((Number(widthInches) || 4) * 72);
    const hPt = Math.round((Number(heightInches) || 6) * 72);
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [0]; // 1-indexed object offsets
    let byteOffset = 0;

    function pushAscii(str) {
      const bytes = encoder.encode(str);
      chunks.push(bytes);
      byteOffset += bytes.length;
    }

    function pushBinary(u8) {
      chunks.push(u8);
      byteOffset += u8.length;
    }

    function startObj(id) {
      offsets[id] = byteOffset;
      pushAscii(`${id} 0 obj\n`);
    }

    function endObj() {
      pushAscii(`\nendobj\n`);
    }

    // Cabeçalho PDF 1.4 com comentário binário
    pushAscii(`%PDF-1.4\n%\xFF\xFF\xFF\xFF\n`);

    const numPages = canvases.length;
    // Object 1: Catalog
    // Object 2: Pages
    // Para cada página i (0..numPages-1):
    //   pageObjId = 3 + i * 3
    //   contentObjId = 4 + i * 3
    //   imageObjId = 5 + i * 3
    const totalObjects = 2 + numPages * 3;
    const pageObjIds = [];
    for (let i = 0; i < numPages; i++) {
      pageObjIds.push(3 + i * 3);
    }

    startObj(1);
    pushAscii(`<< /Type /Catalog /Pages 2 0 R >>`);
    endObj();

    startObj(2);
    pushAscii(`<< /Type /Pages /Kids [ ${pageObjIds.map((id) => `${id} 0 R`).join(' ')} ] /Count ${numPages} >>`);
    endObj();

    for (let i = 0; i < numPages; i++) {
      const canvas = canvases[i];
      const pageObjId = 3 + i * 3;
      const contentObjId = 4 + i * 3;
      const imageObjId = 5 + i * 3;

      const dataUrl = canvas.toDataURL('image/jpeg', 0.96);
      const b64 = dataUrl.split(',')[1] || '';
      const binStr = atob(b64);
      const jpegBytes = new Uint8Array(binStr.length);
      for (let k = 0; k < binStr.length; k++) {
        jpegBytes[k] = binStr.charCodeAt(k);
      }

      // Page Object
      startObj(pageObjId);
      pushAscii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${wPt} ${hPt} ] ` +
        `/Resources << /XObject << /Im0 ${imageObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`
      );
      endObj();

      // Content Stream
      const contentStream = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
      const contentBytes = encoder.encode(contentStream);
      startObj(contentObjId);
      pushAscii(`<< /Length ${contentBytes.length} >>\nstream\n`);
      pushBinary(contentBytes);
      pushAscii(`\nendstream`);
      endObj();

      // Image XObject
      startObj(imageObjId);
      pushAscii(
        `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
      );
      pushBinary(jpegBytes);
      pushAscii(`\nendstream`);
      endObj();
    }

    const xrefOffset = byteOffset;
    pushAscii(`xref\n0 ${totalObjects + 1}\n`);
    pushAscii(`0000000000 65535 f \n`);
    for (let id = 1; id <= totalObjects; id++) {
      const offStr = String(offsets[id] || 0).padStart(10, '0');
      pushAscii(`${offStr} 00000 n \n`);
    }
    pushAscii(
      `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    );

    return new Blob(chunks, { type: 'application/pdf' });
  }

  global.DiagLogger = {
    log,
    clearLogs,
    copyLogs,
    downloadLogs,
    logEnvironmentCheck,
    entries: LOG_ENTRIES
  };

  global.LocalLabelRenderer = {
    countBlackPixelsInBitmap,
    drawSkuFooterOnCanvas,
    canvasTo1BitBitmap,
    renderLabelWithSkuToCanvas,
    renderExtraContinuationCanvas,
    generatePdfBlobFromCanvases
  };
})(window);
