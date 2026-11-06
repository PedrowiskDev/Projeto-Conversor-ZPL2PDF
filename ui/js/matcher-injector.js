/**
 * ui/js/matcher-injector.js
 * Motor de casamento (etiqueta <-> pedido via Code 128 == tracking_number ou ordem),
 * formatação exclusiva de SKU com "*N" (quando N > 1), escalonamento em 3 níveis
 * com estimativa conservadora de largura (0,6 x fonte), deslocamento vertical ("Subir etiqueta")
 * e injetor de comandos ZPL mantendo a página fixa em 816x1218 dots (4x6 pol).
 */

(function (global) {
  'use strict';

  /**
   * Normaliza código para comparação (remove espaços e converte para maiúsculas).
   * @param {string} s
   * @returns {string}
   */
  function normCode(s) {
    return String(s || '').trim().toUpperCase();
  }

  /**
   * Realiza o casamento entre a lista de etiquetas ZPL decodificadas e as linhas do Excel.
   * Regras:
   *  1. Caminho principal: comparação exata do Code 128 lido (BR + dígitos) com `tracking_number` -> status "OK".
   *  2. Comparação secundária: qualquer código/QR lido (exceto chave DANFE de 44 dígitos) igual ou contendo `tracking_number` ou `order_sn` -> status "OK".
   *  3. Reserva: associação pela ordem (etiqueta N = linha N) -> status "Por ordem, conferir".
   * @param {Array<Object>} labels - Etiquetas decodificadas com `.codeInfo`
   * @param {Array<Object>} orders - Pedidos lidos do Excel
   * @param {boolean} [reverseOrder=false] - Se true, inverte a ordem dos pedidos no fallback por ordem
   * @returns {Array<Object>} Lista de associações (uma por etiqueta)
   */
  function matchLabelsWithOrders(labels, orders, reverseOrder) {
    const orderedList = reverseOrder ? [...orders].reverse() : [...orders];
    const usedOrderIndices = new Set();
    const matches = new Array(labels.length);

    // 1ª Passagem: Casamento exato por Code 128 == tracking_number (ou igual/contido em order_sn / tracking_number)
    for (let i = 0; i < labels.length; i++) {
      const lbl = labels[i];
      const nonDanfeCodes = (lbl.codeInfo && lbl.codeInfo.codes ? lbl.codeInfo.codes : [])
        .filter((c) => !c.isDanfe)
        .map((c) => normCode(c.text))
        .filter(Boolean);

      let matchedOrder = null;
      let matchedCodeText = '';

      if (nonDanfeCodes.length > 0 && orderedList.length > 0) {
        // Prioridade 1: Igualdade exata com tracking_number
        for (const ord of orderedList) {
          if (usedOrderIndices.has(ord.rowIndex)) continue;
          const trk = normCode(ord.trackingNumber);
          if (trk && nonDanfeCodes.includes(trk)) {
            matchedOrder = ord;
            matchedCodeText = trk;
            break;
          }
        }

        // Prioridade 2: Igualdade exata com order_sn ou código QR contendo tracking_number / order_sn
        if (!matchedOrder) {
          for (const ord of orderedList) {
            if (usedOrderIndices.has(ord.rowIndex)) continue;
            const trk = normCode(ord.trackingNumber);
            const osn = normCode(ord.orderSn);

            for (const codeStr of nonDanfeCodes) {
              if ((osn && (codeStr === osn || codeStr.includes(osn))) ||
                  (trk && codeStr.includes(trk))) {
                matchedOrder = ord;
                matchedCodeText = codeStr;
                break;
              }
            }
            if (matchedOrder) break;
          }
        }
      }

      if (matchedOrder) {
        usedOrderIndices.add(matchedOrder.rowIndex);
        matches[i] = {
          labelIndex: i,
          orderIndex: matchedOrder.rowIndex,
          matchType: 'exact', // Status "OK"
          matchedCode: matchedCodeText,
          customTextOverride: null
        };
      } else {
        matches[i] = null;
      }
    }

    // 2ª Passagem: Reserva por ordem (etiqueta N = linha N disponível)
    let fallbackCursor = 0;
    for (let i = 0; i < labels.length; i++) {
      if (matches[i]) continue;

      // Se a linha correspondente direta `orderedList[i]` estiver livre, prioriza N = N
      let chosenOrder = null;
      if (i < orderedList.length && !usedOrderIndices.has(orderedList[i].rowIndex)) {
        chosenOrder = orderedList[i];
      } else {
        while (fallbackCursor < orderedList.length && usedOrderIndices.has(orderedList[fallbackCursor].rowIndex)) {
          fallbackCursor++;
        }
        if (fallbackCursor < orderedList.length) {
          chosenOrder = orderedList[fallbackCursor];
        }
      }

      if (chosenOrder) {
        usedOrderIndices.add(chosenOrder.rowIndex);
        matches[i] = {
          labelIndex: i,
          orderIndex: chosenOrder.rowIndex,
          matchType: 'order', // Status "Por ordem, conferir"
          matchedCode: '',
          customTextOverride: null
        };
      } else {
        matches[i] = {
          labelIndex: i,
          orderIndex: null,
          matchType: 'unmatched', // Status "Sem correspondência"
          matchedCode: '',
          customTextOverride: null
        };
      }
    }

    return matches;
  }

  /**
   * Formata os itens de um pedido em strings individuais numeradas com quantidade:
   *  - Sempre numera cada peça: "1. ", "2. ", "3. ", mesmo quando há apenas 1 peça;
   *  - Sempre mostra a quantidade na frente de cada peça ("*1", "*2", etc.), mesmo quando a quantidade é 1.
   * Exemplo com 1 peça de qtd 1: ["1. SKUD250X *1"]
   * @param {Object|null} order - Objeto do pedido do Excel
   * @param {Object} config - Configurações do editor
   * @returns {string[]} Lista de strings formatadas por item
   */
  function buildItemSkuTokens(order, config) {
    if (!order || !order.items || order.items.length === 0) return [];
    const skuPref = (config && config.skuPreference) || 'sku';
    const alwaysShowQty = config ? config.showQtyGreaterOne !== false : true;

    const tokens = [];
    let itemCounter = 1;
    order.items.forEach((item) => {
      const baseSku = global.ExcelParser.resolveItemSkuText(item, skuPref);
      if (!baseSku) return;
      const qty = Math.max(1, Number(item.quantity) || 1);
      const suffix = alwaysShowQty ? ` *${qty}` : (qty > 1 ? ` *${qty}` : '');
      tokens.push(`${itemCounter}. ${baseSku}${suffix}`);
      itemCounter++;
    });
    return tokens;
  }

  /**
   * Estima a largura em dots de uma linha de texto de forma conservadora:
   * largura = caracteres * (0,6 * altura_da_fonte).
   * @param {string} text
   * @param {number} fontHeightDots
   * @returns {number} Largura estimada em dots
   */
  function estimateConservativeWidth(text, fontHeightDots) {
    const len = String(text || '').length;
    return Math.ceil(len * (0.6 * fontHeightDots));
  }

  /**
   * Retorna o número máximo de caracteres que cabem em `usableWidthDots` na fonte `fontHeightDots`
   * usando a estimativa conservadora de 0,6 x altura da fonte por caractere.
   * @param {number} usableWidthDots
   * @param {number} fontHeightDots
   * @returns {number}
   */
  function maxCharsForFont(usableWidthDots, fontHeightDots) {
    return Math.max(1, Math.floor(usableWidthDots / (0.6 * fontHeightDots)));
  }

  /**
   * Executa o escalonamento do texto da(s) SKU(s) no espaço livre medido do rodapé:
   *  - Fonte padrão pequena (16 dots, reduzindo até 12 dots se necessário);
   *  - Cada peça já vem numerada ("1. SKU *1", "2. SKU *2", "3. SKU *1");
   *  - Prioriza 1 peça por linha ("1. ...\n2. ...\n3. ...") enquanto couber na altura útil;
   *  - Se houver muitas peças, agrupa 2 ou mais peças por linha separadas por "   " ou " | ";
   *  - Se ainda assim exceder o espaço, resume com "+N" e status "Resumido".
   * @param {string[]} skuTokens - Lista de SKUs formatadas do pedido (ex: ["1. SKUD250X *1"])
   * @param {string|null} customOverride - Texto editado manualmente pelo usuário (se houver)
   * @param {number} lastBlackRow - Última linha Y com pixel preto (já considerando escala e subida)
   * @param {number} labelHeightDots - Altura da etiqueta (padrão 1218)
   * @param {Object} config - Configurações { baseFontSize: 16, bottomMarginDots: 20, allowExtendLL: false }
   * @returns {Object} Resultado do escalonamento e posicionamento
   */
  function formatAndFitLabelFooter(skuTokens, customOverride, lastBlackRow, labelHeightDots, config) {
    const pageH = labelHeightDots || 1218;
    const usableWidth = 776; // 816 - 20 (esq) - 20 (dir)
    const topGap = 10; // Espaço limpo abaixo do último pixel preto da etiqueta
    const bottomMargin = Math.max(10, Number(config.bottomMarginDots ?? 20));
    const baseFont = Math.max(12, Number(config.baseFontSize) || 16);
    const minFont = 12;

    const yStart = lastBlackRow + topGap;
    const yMax = pageH - bottomMargin;
    const usableHeight = Math.max(0, yMax - yStart);

    // Se o usuário digitou um texto manual para esta etiqueta
    let tokens = skuTokens;
    if (customOverride !== null && customOverride !== undefined && String(customOverride).trim() !== '') {
      tokens = String(customOverride)
        .split(/\r?\n|\s*\|\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    if (!tokens || tokens.length === 0) {
      return {
        hasText: false,
        lines: [],
        zplText: '',
        displayText: '',
        fontSize: baseFont,
        lineCount: 0,
        yStart,
        usableHeight,
        isSummarized: false,
        noSpaceError: false,
        extendedHeightDots: null
      };
    }

    let effectiveUsableHeight = usableHeight;
    let extendedHeightDots = null;

    if (effectiveUsableHeight < minFont) {
      if (config.allowExtendLL) {
        extendedHeightDots = yStart + baseFont * tokens.length + bottomMargin;
        effectiveUsableHeight = baseFont * tokens.length + 8;
      } else {
        return {
          hasText: false,
          lines: [],
          zplText: '',
          displayText: tokens.join(' | '),
          fontSize: minFont,
          lineCount: 0,
          yStart,
          usableHeight,
          isSummarized: false,
          noSpaceError: true,
          extendedHeightDots: null
        };
      }
    }

    // PASSO 1: Tentar cada peça numerada em sua própria linha (1. SKU1 *1 / 2. SKU2 *2 / 3. SKU3 *1...)
    for (let f = baseFont; f >= minFont; f -= 2) {
      const linePitch = f + 3;
      const neededH = tokens.length * linePitch;
      if (effectiveUsableHeight >= neededH) {
        const allFitWidth = tokens.every((t) => estimateConservativeWidth(t, f) <= usableWidth);
        if (allFitWidth) {
          return {
            hasText: true,
            lines: [...tokens],
            zplText: tokens.join('\\&'),
            displayText: tokens.join(' | '),
            fontSize: f,
            lineCount: tokens.length,
            yStart,
            usableHeight,
            isSummarized: false,
            noSpaceError: false,
            extendedHeightDots
          };
        }
      }
    }

    // PASSO 2: Agrupar múltiplas peças por linha (ex: 2 ou 3 por linha) para caber na altura disponível
    for (let f = baseFont; f >= minFont; f -= 2) {
      const linePitch = f + 3;
      const maxLinesAvailable = Math.max(1, Math.floor(effectiveUsableHeight / linePitch));
      const packedLines = [];
      let currentLine = '';
      let fitsAll = true;

      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        const candidate = currentLine ? `${currentLine}   ${tok}` : tok;
        if (estimateConservativeWidth(candidate, f) <= usableWidth) {
          currentLine = candidate;
        } else {
          if (currentLine) packedLines.push(currentLine);
          currentLine = tok;
          if (estimateConservativeWidth(currentLine, f) > usableWidth) {
            fitsAll = false;
            break;
          }
        }
      }
      if (currentLine) packedLines.push(currentLine);

      if (fitsAll && packedLines.length <= maxLinesAvailable) {
        return {
          hasText: true,
          lines: packedLines,
          zplText: packedLines.join('\\&'),
          displayText: packedLines.join(' / '),
          fontSize: f,
          lineCount: packedLines.length,
          yStart,
          usableHeight,
          isSummarized: false,
          noSpaceError: false,
          extendedHeightDots
        };
      }
    }

    // PASSO 3: Resumir na fonte mínima (12 dots) aproveitando todas as linhas disponíveis e acrescentando +N
    const summaryFont = minFont;
    const maxChars = maxCharsForFont(usableWidth, summaryFont);
    let summaryText = '';

    if (tokens.length === 1) {
      summaryText = tokens[0].slice(0, Math.max(8, maxChars - 3)) + '...';
    } else {
      for (let k = tokens.length - 1; k >= 1; k--) {
        const rem = tokens.length - k;
        const candidate = `${tokens.slice(0, k).join(' | ')} +${rem}`;
        if (candidate.length <= maxChars) {
          summaryText = candidate;
          break;
        }
      }
      if (!summaryText) {
        const rem = tokens.length - 1;
        const suffix = ` +${rem}`;
        const avail = Math.max(4, maxChars - suffix.length);
        summaryText = `${tokens[0].slice(0, avail)}${suffix}`;
      }
    }

    return {
      hasText: true,
      lines: [summaryText],
      zplText: summaryText,
      displayText: summaryText,
      fontSize: summaryFont,
      lineCount: 1,
      yStart,
      usableHeight,
      isSummarized: true,
      noSpaceError: false,
      extendedHeightDots
    };
  }

  /**
   * Sanitiza texto para inserção dentro de ^FD...^FS em ZPL.
   * @param {string} str
   * @returns {string}
   */
  function escapeZplFd(str) {
    return String(str || '').replace(/\^/g, ' ').replace(/~/g, ' ');
  }

  /**
   * Gera uma etiqueta 4x6 adicional em ZPL texto puro com a lista completa de SKUs do pedido
   * quando a opção "Imprimir lista completa em etiqueta extra" estiver ativada.
   * @param {Object} order
   * @param {number} labelNumber
   * @param {Object} config
   * @returns {string} Bloco ^XA...^XZ
   */
  function buildExtraContinuationLabelZpl(order, labelNumber, config) {
    const tokens = buildItemSkuTokens(order, config);
    const linesZpl = [];
    linesZpl.push('^XA');
    linesZpl.push('^PW816');
    linesZpl.push('^LL1218');
    linesZpl.push('^PON');
    linesZpl.push('^CI28');

    const headerTitle = `CONTINUACAO ETIQUETA #${labelNumber} (${tokens.length} ITENS)`;
    linesZpl.push(`^FO24,28^A0N,22,22^FD${escapeZplFd(headerTitle)}^FS`);
    if (order && order.trackingNumber) {
      linesZpl.push(`^FO24,58^A0N,18,18^FDRastreio: ${escapeZplFd(order.trackingNumber)}^FS`);
    }
    linesZpl.push('^FO24,84^GB768,2,2^FS');

    let y = 100;
    tokens.forEach((skuTok) => {
      if (y > 1170) return;
      linesZpl.push(`^FO24,${y}^A0N,18,18^FB768,2,2,L,0^FD${escapeZplFd(skuTok)}^FS`);
      if (config.bold) {
        linesZpl.push(`^FO25,${y}^A0N,18,18^FB768,2,2,L,0^FD${escapeZplFd(skuTok)}^FS`);
      }
      y += 26;
    });

    linesZpl.push('^XZ');
    return linesZpl.join('\n');
  }

  /**
   * Reconstrói o bloco ZPL de uma etiqueta:
   *  - Aplica redução proporcional de escala (ex: 88%) e eventual deslocamento vertical para liberar espaço no rodapé;
   *  - Garante ^PW816 e ^LL1218 dentro do bloco ^XA para que o rodapé nunca seja cortado;
   *  - Injeta o texto numerado da SKU no rodapé (^CI28, ^FO, ^A0N, ^FD, ^FS);
   *  - Anexa a etiqueta extra 4x6 se a opção estiver ligada e a etiqueta estiver resumida.
   * @param {Object} labelObj - Objeto da etiqueta decodificada
   * @param {Object|null} orderObj - Objeto do pedido associado
   * @param {Object} fitResult - Resultado de formatAndFitLabelFooter
   * @param {Object} config - Configurações atuais do editor
   * @param {number} uniqueIdx - Índice único para nomear o recurso gráfico GRF
   * @returns {Promise<string>} Bloco ZPL final pronto para impressão/editor
   */
  async function injectZplForSingleLabel(labelObj, orderObj, fitResult, config, uniqueIdx) {
    let zpl = labelObj.rawZpl;
    const grfId = `LBL${String(uniqueIdx + 1).padStart(4, '0')}`;
    const shiftReq = Math.max(0, Math.floor(Number(config.shiftUpDots) || 0));
    const scalePct = Math.min(100, Math.max(60, Number(config.labelScalePercent) || 88));
    const useGfaInEditor = config.zplGraphicFormat === 'gfa-hex';

    // 1. Manipulação do comando gráfico (~DG ou ^GF) com escala e/ou deslocamento
    if (labelObj.hasGraphic && labelObj.graphicMeta) {
      const meta = labelObj.graphicMeta;
      let currentBitmap = labelObj.bitmap;
      let payloadModified = false;
      let payloadToUse = meta.rawPayload;

      if ((scalePct < 100 || shiftReq > 0) && labelObj.bitmap && global.ZplBitmap.scaleAndShiftBitmap1Bit) {
        const transformed = global.ZplBitmap.scaleAndShiftBitmap1Bit(
          labelObj.bitmap,
          labelObj.bytesPerRow,
          labelObj.heightDots,
          scalePct,
          shiftReq
        );
        currentBitmap = transformed.transformedBitmap;
        payloadModified = true;
        const z64 = await global.ZplBitmap.compressToZ64(currentBitmap);
        payloadToUse = z64 || global.ZplBitmap.encodeBitmapToHex(currentBitmap);
      }

      if (useGfaInEditor && currentBitmap) {
        const hexStr = global.ZplBitmap.encodeBitmapToHex(currentBitmap);
        const gfaCmd = `^FO0,0^GFA,${meta.totalBytes},${meta.totalBytes},${meta.bytesPerRow},${hexStr}^FS`;
        if (meta.type === 'DG') {
          zpl = zpl.replace(meta.fullMatch, '');
          if (/\^FO\s*\d+\s*,\s*\d+\s*\^XG[^\^]*?\^FS/i.test(zpl)) {
            zpl = zpl.replace(/\^FO\s*\d+\s*,\s*\d+\s*\^XG[^\^]*?\^FS/i, gfaCmd);
          } else if (/\^XG[^\^]*?\^FS/i.test(zpl)) {
            zpl = zpl.replace(/\^XG[^\^]*?\^FS/i, gfaCmd);
          } else {
            zpl = zpl.replace(/\^XA/i, `^XA\n${gfaCmd}`);
          }
        } else if (meta.type === 'GF') {
          zpl = zpl.replace(meta.fullMatch, `^GFA,${meta.totalBytes},${meta.totalBytes},${meta.bytesPerRow},${hexStr}`);
        }
      } else if (meta.type === 'DG' && (payloadModified || config.sortBySku)) {
        const newDgHeader = `~DGR:${grfId}.GRF,${meta.totalBytes},${meta.bytesPerRow},${payloadToUse}`;
        zpl = zpl.replace(meta.fullMatch, newDgHeader + '\n');
        zpl = zpl.replace(/\^XG\s*(?:R:)?[A-Z0-9._-]+(\.GRF)?/i, (_m, ext) => `^XGR:${grfId}${ext || ''}`);
      } else if (meta.type === 'GF' && payloadModified) {
        const newGf = `^GF${meta.mode},${meta.totalBytes},${meta.totalBytes},${meta.bytesPerRow},${payloadToUse}`;
        zpl = zpl.replace(meta.fullMatch, newGf);
      }
    }

    // 2. Garante ^PW816 e ^LL1218 logo após ^XA para que coordenadas Y > 1000 nunca sejam ignoradas
    const targetLL = (fitResult && fitResult.extendedHeightDots)
      ? fitResult.extendedHeightDots
      : (labelObj.heightDots || 1218);
    const targetPW = labelObj.widthDots || 816;

    if (!/\^PW\d+/i.test(zpl)) {
      zpl = zpl.replace(/\^XA/i, `^XA\n^PW${targetPW}`);
    }
    if (!/\^LL\d+/i.test(zpl)) {
      zpl = zpl.replace(/\^XA/i, `^XA\n^LL${targetLL}`);
    } else if (fitResult && fitResult.extendedHeightDots) {
      zpl = zpl.replace(/\^LL\d+/i, `^LL${fitResult.extendedHeightDots}`);
    }

    // 3. Se não houver texto para injetar ou se estiver sem espaço e bloqueado
    if (!fitResult || !fitResult.hasText || !fitResult.zplText) {
      return zpl.trim();
    }

    // 4. Monta os comandos ZPL de injeção no rodapé
    const alignChar = config.align || 'L'; // 'L', 'C', 'R'
    const fontH = fitResult.fontSize;
    const fontW = fitResult.fontSize;
    const yPos = fitResult.yStart;
    const maxLines = fitResult.lineCount || 1;
    const safeText = escapeZplFd(fitResult.zplText);

    const injectedCmds = [];
    injectedCmds.push('^CI28');

    if (alignChar === 'L' && fitResult.lines && fitResult.lines.length >= 1) {
      fitResult.lines.forEach((lineStr, lineIdx) => {
        const lineY = yPos + lineIdx * (fontH + 3);
        const cleanLine = escapeZplFd(lineStr);
        injectedCmds.push(`^FO20,${lineY}^A0N,${fontH},${fontW}^FD${cleanLine}^FS`);
        if (config.bold) {
          injectedCmds.push(`^FO21,${lineY}^A0N,${fontH},${fontW}^FD${cleanLine}^FS`);
        }
      });
    } else {
      injectedCmds.push(`^FO20,${yPos}^A0N,${fontH},${fontW}^FB776,${maxLines},3,${alignChar},0^FD${safeText}^FS`);
      if (config.bold) {
        injectedCmds.push(`^FO21,${yPos}^A0N,${fontH},${fontW}^FB776,${maxLines},3,${alignChar},0^FD${safeText}^FS`);
      }
    }

    const injectionBlock = '\n' + injectedCmds.join('\n') + '\n^XZ';
    zpl = zpl.replace(/\^XZ\s*$/i, injectionBlock);

    // 5. Se a opção "Imprimir lista completa em etiqueta extra" estiver ativa e a etiqueta foi resumida
    if (config.printExtraLabel && fitResult.isSummarized && orderObj) {
      const extraZpl = buildExtraContinuationLabelZpl(orderObj, labelObj.index + 1, config);
      zpl = zpl + '\n\n' + extraZpl;
    }

    return zpl.trim();
  }

  /**
   * Constrói uma versão do bloco ZPL com gráfico ^GFA Hex descomprimido dentro de ^XA...^XZ
   * e SKU já gravada no bitmap 1-bit + comandos ^FO/^A0N, maximizando a compatibilidade com a API offline.
   */
  function buildApiCompatibleGfaZpl(labelObj, orderObj, fitResult, config) {
    if (!labelObj || !labelObj.hasGraphic || !labelObj.bitmap || !global.LocalLabelRenderer) {
      return labelObj ? labelObj.rawZpl : '';
    }
    const canvas = global.LocalLabelRenderer.renderLabelWithSkuToCanvas(labelObj, fitResult, config);
    const bytesPerRow = labelObj.bytesPerRow || 102;
    const mergedBitmap = global.LocalLabelRenderer.canvasTo1BitBitmap(canvas, bytesPerRow);
    const totalBytes = mergedBitmap.length;
    const hexPayload = global.ZplBitmap.encodeBitmapToHex(mergedBitmap);

    const lines = [
      '^XA',
      `^PW${canvas.width}`,
      `^LL${canvas.height}`,
      '^PON',
      `^FO0,0^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hexPayload}^FS`,
      '^XZ'
    ];
    let out = lines.join('\n');
    if (config && config.printExtraLabel && fitResult && fitResult.isSummarized && orderObj) {
      out += '\n\n' + buildExtraContinuationLabelZpl(orderObj, labelObj.index + 1, config);
    }
    return out;
  }

  global.MatcherInjector = {
    matchLabelsWithOrders,
    buildItemSkuTokens,
    estimateConservativeWidth,
    formatAndFitLabelFooter,
    injectZplForSingleLabel,
    buildApiCompatibleGfaZpl
  };
})(window);

