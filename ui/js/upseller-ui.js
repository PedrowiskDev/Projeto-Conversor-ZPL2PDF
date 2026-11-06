/**
 * ui/js/upseller-ui.js
 * Controlador de interface do modo Shopee / UpSeller:
 *  - Gerencia as abas da coluna esquerda (Código ZPL vs Conferência / SKU UpSeller);
 *  - Coordena o carregamento do ZPL e da Lista de Empacotamento Excel (.xlsx/.csv/.tsv);
 *  - Renderiza o mapeamento de colunas, avisos e a tabela de conferência;
 *  - Permite inverter ordem, reassociar pedido por select e editar o texto da SKU manualmente;
 *  - Implementa o botão "Gerar etiqueta de teste" (1 etiqueta com a dica 100x150 mm),
 *    navegação paginada no preview (Anterior / Próxima), ordenação por SKU e download do ZPL editado.
 */

(function (global) {
  'use strict';

  const AppState = {
    activeTab: 'editor', // 'editor' | 'upseller'
    rawSourceZpl: '', // ZPL original antes da injeção de rodapé
    labels: [], // Etiquetas decodificadas (bitmap, códigos lidos, espaço livre)
    excelHeaders: [],
    excelRawRows: [],
    columnMap: {
      tracking_number: '',
      order_sn: '',
      product_info: '',
      remark_from_buyer: '',
      seller_note: '',
      short_code: ''
    },
    orders: [],
    excelWarnings: [],
    matches: [], // Associação labelIndex -> orderIndex + customTextOverride
    reverseOrder: false,
    previewPageIndex: 0, // 0 = todas, 1..N = página específica no preview
    isProcessing: false,
    lastCompiledBlocks: [], // Blocos ZPL finais após injeção (e eventual ordenação)
    lastCompiledItems: [], // Metadados completos { originalIndex, labelObj, orderObj, fitResult, zplBlock }
    config: {
      enabled: true,
      skuPreference: 'sku', // 'sku' (reserva: SKU pai) | 'parent' | 'both'
      showQtyGreaterOne: true, // Sempre mostrar quantidade *1, *2... na frente de cada peça
      baseFontSize: 16, // 16 dots (Pequena - padrão)
      bold: false, // Negrito simulado (+1 dot)
      align: 'L', // 'L' | 'C' | 'R'
      bottomMarginDots: 20, // Margem inferior de segurança padrão: 20 dots
      labelScalePercent: 88, // Reduzir etiqueta para 88% liberando espaço no rodapé
      shiftUpDots: 0, // Subir etiqueta (dots), preservando margem no topo
      sortBySku: false, // Ordenar saída por SKU (reordenando blocos inteiros)
      printExtraLabel: false, // Imprimir lista completa em etiqueta extra 4x6 (desligado por padrão)
      allowExtendLL: false, // Avançado, desligado por padrão (aviso: pode cortar na térmica)
      zplGraphicFormat: 'z64' // 'z64' (original :Z64:) | 'gfa-hex' (^GFA Hex descomprimido)
    }
  };

  function dlog(level, cat, msg, details) {
    if (global.DiagLogger && global.DiagLogger.log) {
      global.DiagLogger.log(level, cat, msg, details);
    }
  }

  /**
   * Alterna entre as abas "Código ZPL", "Conferência / SKU (UpSeller)" e "Logs / Diagnóstico".
   * @param {string} tabName - 'editor' | 'upseller' | 'logs'
   */
  function switchLeftTab(tabName) {
    AppState.activeTab = tabName;
    const tabEditorBtn = document.getElementById('tab-btn-editor');
    const tabUpsellerBtn = document.getElementById('tab-btn-upseller');
    const tabLogsBtn = document.getElementById('tab-btn-logs');
    const paneEditor = document.getElementById('pane-editor');
    const paneUpseller = document.getElementById('pane-upseller');
    const paneLogs = document.getElementById('pane-logs');

    if (tabEditorBtn) tabEditorBtn.classList.toggle('active', tabName === 'editor');
    if (tabUpsellerBtn) tabUpsellerBtn.classList.toggle('active', tabName === 'upseller');
    if (tabLogsBtn) tabLogsBtn.classList.toggle('active', tabName === 'logs');

    if (paneEditor) paneEditor.style.display = tabName === 'editor' ? 'flex' : 'none';
    if (paneUpseller) paneUpseller.style.display = tabName === 'upseller' ? 'flex' : 'none';
    if (paneLogs) paneLogs.style.display = tabName === 'logs' ? 'flex' : 'none';
  }

  /**
   * Lê os valores atuais dos controles do painel de configuração do rodapé.
   */
  function syncConfigFromInputs() {
    const elEnabled = document.getElementById('cfg-enabled');
    const elSkuPref = document.getElementById('cfg-sku-pref');
    const elShowQty = document.getElementById('cfg-show-qty');
    const elFontSize = document.getElementById('cfg-font-size');
    const elBold = document.getElementById('cfg-bold');
    const elAlign = document.getElementById('cfg-align');
    const elBottomMargin = document.getElementById('cfg-bottom-margin');
    const elScalePct = document.getElementById('cfg-scale-pct');
    const elShiftUp = document.getElementById('cfg-shift-up');
    const elSortSku = document.getElementById('cfg-sort-sku');
    const elExtraLabel = document.getElementById('cfg-extra-label');
    const elAllowExtend = document.getElementById('cfg-allow-extend');
    const elZplFormat = document.getElementById('cfg-zpl-format');

    if (elEnabled) AppState.config.enabled = elEnabled.checked;
    if (elSkuPref) AppState.config.skuPreference = elSkuPref.value;
    if (elShowQty) AppState.config.showQtyGreaterOne = elShowQty.checked;
    if (elFontSize) AppState.config.baseFontSize = parseInt(elFontSize.value, 10) || 16;
    if (elBold) AppState.config.bold = elBold.checked;
    if (elAlign) AppState.config.align = elAlign.value || 'L';
    if (elBottomMargin) AppState.config.bottomMarginDots = Math.max(10, parseInt(elBottomMargin.value, 10) || 20);
    if (elScalePct) AppState.config.labelScalePercent = Math.min(100, Math.max(60, parseInt(elScalePct.value, 10) || 88));
    if (elShiftUp) AppState.config.shiftUpDots = Math.max(0, parseInt(elShiftUp.value, 10) || 0);
    if (elSortSku) AppState.config.sortBySku = elSortSku.checked;
    if (elExtraLabel) AppState.config.printExtraLabel = elExtraLabel.checked;
    if (elAllowExtend) AppState.config.allowExtendLL = elAllowExtend.checked;
    if (elZplFormat) AppState.config.zplGraphicFormat = elZplFormat.value || 'z64';
  }

  /**
   * Processa o código ZPL atual: separa etiquetas, decodifica os bitmaps :Z64:/Hex,
   * mede o espaço livre no rodapé e lê todos os códigos Code 128 e QR Codes.
   * @param {string} zplText - Código ZPL de origem
   */
  async function analyzeZplSource(zplText) {
    AppState.rawSourceZpl = zplText || '';
    const rawBlocks = global.ZplBitmap.splitZplLabels(AppState.rawSourceZpl);
    if (rawBlocks.length === 0) {
      AppState.labels = [];
      AppState.matches = [];
      AppState.lastCompiledBlocks = [];
      AppState.lastCompiledItems = [];
      updateBadgeCounts();
      renderUpsellerPanel();
      return;
    }

    dlog('info', 'ZPL', `Iniciando análise de ${rawBlocks.length} bloco(s) ZPL (${AppState.rawSourceZpl.length} caracteres).`);
    AppState.isProcessing = true;
    global.setStatus(`Decodificando ${rawBlocks.length} etiqueta(s) e lendo códigos…`, '');

    const decodedLabels = [];
    for (let i = 0; i < rawBlocks.length; i++) {
      const lbl = await global.ZplBitmap.decodeSingleLabelBlock(rawBlocks[i], i);
      lbl.codeInfo = await global.BarcodeReader.readAllCodesFromLabel(lbl);
      const readList = (lbl.codeInfo && lbl.codeInfo.codes ? lbl.codeInfo.codes : []).map((c) => `${c.format}: ${c.text}`);
      dlog(
        readList.length > 0 ? 'ok' : 'warn',
        'BARCODE',
        `Etiqueta #${i + 1}: ${readList.length} código(s) lido(s) na imagem.`,
        {
          primaryTrackingCode: lbl.codeInfo ? lbl.codeInfo.primaryTrackingCode : null,
          danfeKey: lbl.codeInfo ? lbl.codeInfo.danfeKey : null,
          todosOsCodigos: readList
        }
      );
      decodedLabels.push(lbl);
    }

    AppState.labels = decodedLabels;
    AppState.isProcessing = false;

    recomputeMatchesAndRender();
    await rebuildInjectedZplInEditor(false);
  }

  /**
   * Recalcula o casamento entre etiquetas e pedidos mantendo eventuais edições manuais de SKU.
   */
  function recomputeMatchesAndRender() {
    const prevOverrides = new Map();
    AppState.matches.forEach((m) => {
      if (m && m.customTextOverride !== null) {
        prevOverrides.set(m.labelIndex, m.customTextOverride);
      }
    });

    AppState.matches = global.MatcherInjector.matchLabelsWithOrders(
      AppState.labels,
      AppState.orders,
      AppState.reverseOrder
    );

    AppState.matches.forEach((m) => {
      if (prevOverrides.has(m.labelIndex)) {
        m.customTextOverride = prevOverrides.get(m.labelIndex);
      }
    });

    if (AppState.labels.length > 0 && AppState.orders.length > 0) {
      const exactCount = AppState.matches.filter((m) => m.matchType === 'exact').length;
      const orderCount = AppState.matches.filter((m) => m.matchType === 'order').length;
      const unmCount = AppState.matches.filter((m) => m.matchType === 'unmatched').length;
      dlog('info', 'MATCH', `Casamento concluído: ${exactCount} exato(s) via Code 128, ${orderCount} por ordem, ${unmCount} sem correspondência.`);
    }

    updateBadgeCounts();
    renderUpsellerPanel();
  }

  /**
   * Atualiza o contador na aba "Conferência / SKU (UpSeller)" e os controles de paginação do preview.
   */
  function updateBadgeCounts() {
    const badge = document.getElementById('upseller-count-badge');
    if (badge) {
      const nLbl = AppState.labels.length;
      const nOrd = AppState.orders.length;
      badge.textContent = nOrd > 0 ? `${nLbl} etiq · ${nOrd} ped` : `${nLbl}`;
    }
    updatePreviewPagerUi();
  }

  /**
   * Reconstrói o ZPL de todas as etiquetas aplicando a escala ("Tamanho da etiqueta (%)"),
   * o deslocamento vertical ("Subir etiqueta"), o escalonamento de SKU e a ordenação por SKU.
   * @param {boolean} [autoPreview=false] - Se true, dispara a conversão da página atual no preview
   */
  async function rebuildInjectedZplInEditor(autoPreview) {
    syncConfigFromInputs();
    if (AppState.labels.length === 0) return;

    const ed = document.getElementById('editor');
    if (!AppState.config.enabled) {
      AppState.lastCompiledBlocks = AppState.labels.map((l) => l.rawZpl);
      AppState.lastCompiledItems = AppState.labels.map((l, idx) => ({
        originalIndex: idx,
        labelObj: l,
        orderObj: null,
        fitResult: null,
        zplBlock: l.rawZpl
      }));
      if (ed) {
        ed.value = AppState.rawSourceZpl;
        global.syncGutter();
      }
      renderUpsellerPanel();
      return;
    }

    const compiledItems = [];
    for (let i = 0; i < AppState.labels.length; i++) {
      const lbl = AppState.labels[i];
      const match = AppState.matches[i] || {
        labelIndex: i,
        orderIndex: null,
        matchType: 'unmatched',
        customTextOverride: null
      };
      const orderObj =
        match.orderIndex !== null && match.orderIndex !== undefined
          ? AppState.orders.find((o) => o.rowIndex === match.orderIndex) || null
          : null;

      // Calcula a última linha preta considerando escala proporcional (ex: 88%) e eventual "Subir etiqueta (dots)"
      const shiftReq = Math.max(0, Math.floor(Number(AppState.config.shiftUpDots) || 0));
      const scalePct = Math.min(100, Math.max(60, Number(AppState.config.labelScalePercent) || 88));
      let effectiveLastBlackRow = lbl.lastBlackRow;
      let effectiveFreeBottomDots = lbl.freeBottomDots;
      let actualShift = 0;

      if (lbl.hasGraphic) {
        const scaledLastRow = scalePct < 100
          ? Math.round((lbl.lastBlackRow * scalePct) / 100) + 6
          : lbl.lastBlackRow;
        actualShift = shiftReq;
        effectiveLastBlackRow = Math.max(0, scaledLastRow - actualShift);
        effectiveFreeBottomDots = Math.max(0, lbl.heightDots - 1 - effectiveLastBlackRow);
      }

      const skuTokens = global.MatcherInjector.buildItemSkuTokens(orderObj, AppState.config);
      const fitResult = global.MatcherInjector.formatAndFitLabelFooter(
        skuTokens,
        match.customTextOverride,
        effectiveLastBlackRow,
        lbl.heightDots,
        AppState.config
      );

      // Armazena fitResult e espaços para exibir na tabela de conferência
      lbl.lastFitResult = fitResult;
      lbl.actualShiftDots = actualShift;
      lbl.effectiveFreeBottomDots = effectiveFreeBottomDots;

      const finalBlockZpl = await global.MatcherInjector.injectZplForSingleLabel(
        lbl,
        orderObj,
        fitResult,
        AppState.config,
        i
      );

      const firstSkuForSort = (skuTokens[0] || fitResult.displayText || 'ZZZZZZ').toUpperCase();
      compiledItems.push({
        originalIndex: i,
        labelObj: lbl,
        orderObj,
        fitResult,
        firstSkuForSort,
        zplBlock: finalBlockZpl
      });
    }

    // Se "Ordenar por SKU" estiver ativo, reordena os blocos inteiros de etiqueta
    if (AppState.config.sortBySku) {
      compiledItems.sort((a, b) => a.firstSkuForSort.localeCompare(b.firstSkuForSort, 'pt-BR'));
    }

    AppState.lastCompiledItems = compiledItems;
    AppState.lastCompiledBlocks = compiledItems.map((it) => it.zplBlock);

    if (ed) {
      ed.value = AppState.lastCompiledBlocks.join('\n\n');
      global.syncGutter();
    }

    renderUpsellerPanel();
    updatePreviewPagerUi();

    if (autoPreview) {
      await convertCurrentPreviewSelection();
    }
  }

  /**
   * Renderiza os selects de mapeamento de colunas do Excel, banners de alerta e a tabela de conferência.
   */
  function renderUpsellerPanel() {
    renderColumnMappingBar();
    renderAlertsBanner();
    renderVerificationTable();
  }

  /**
   * Renderiza a barra de remapeamento de colunas do Excel quando uma planilha está carregada.
   */
  function renderColumnMappingBar() {
    const wrap = document.getElementById('excel-colmap-wrap');
    if (!wrap) return;

    if (AppState.excelHeaders.length === 0) {
      wrap.style.display = 'none';
      return;
    }

    wrap.style.display = 'flex';
    const fields = [
      { key: 'tracking_number', label: 'Rastreio (tracking_number)' },
      { key: 'order_sn', label: 'Pedido (order_sn)' },
      { key: 'product_info', label: 'Produtos / SKU (product_info)' }
    ];

    wrap.innerHTML = fields
      .map((f) => {
        const currentVal = AppState.columnMap[f.key] || '';
        const opts = ['<option value="">— não mapeado —</option>']
          .concat(
            AppState.excelHeaders.map(
              (h) =>
                `<option value="${global.esc(h)}" ${h === currentVal ? 'selected' : ''}>${global.esc(h)}</option>`
            )
          )
          .join('');
        return `
          <div class="colmap-item">
            <label>${f.label}</label>
            <select data-colkey="${f.key}" onchange="window.UpsellerUI.onColumnRemapChange(this)">
              ${opts}
            </select>
          </div>
        `;
      })
      .join('');
  }

  /**
   * Renderiza alertas claros (diferença na quantidade de etiquetas vs pedidos, coluna ausente,
   * nenhum código lido, etiquetas resumidas ou sem espaço no rodapé).
   */
  function renderAlertsBanner() {
    const box = document.getElementById('upseller-alerts');
    if (!box) return;

    const msgs = [];
    const nLabels = AppState.labels.length;
    const nOrders = AppState.orders.length;

    if (nOrders > 0 && nLabels > 0 && nLabels !== nOrders) {
      msgs.push({
        type: 'warn',
        text: `Atenção: Quantidade de etiquetas (${nLabels}) é diferente da quantidade de pedidos no Excel (${nOrders}).`
      });
    }

    AppState.excelWarnings.forEach((w) => {
      msgs.push({ type: 'warn', text: w });
    });

    if (nLabels > 0) {
      const noCodeCount = AppState.labels.filter(
        (l) => !l.codeInfo || !l.codeInfo.codes || l.codeInfo.codes.filter((c) => !c.isDanfe).length === 0
      ).length;
      if (noCodeCount > 0 && nOrders > 0) {
        msgs.push({
          type: 'warn',
          text: `${noCodeCount} etiqueta(s) sem código de rastreio lido na imagem — associada(s) pela ordem da fila.`
        });
      }

      const summarizedCount = AppState.labels.filter((l) => l.lastFitResult && l.lastFitResult.isSummarized).length;
      if (summarizedCount > 0) {
        msgs.push({
          type: 'info',
          text: `${summarizedCount} etiqueta(s) marcada(s) como "Resumido" (+N itens). Confira na tabela ou ative "Imprimir lista completa em etiqueta extra".`
        });
      }

      const noSpaceCount = AppState.labels.filter((l) => l.lastFitResult && l.lastFitResult.noSpaceError).length;
      if (noSpaceCount > 0) {
        msgs.push({
          type: 'err',
          text: `${noSpaceCount} etiqueta(s) não têm espaço branco suficiente (< 20 dots úteis). Use o campo "Subir etiqueta (dots)" para liberar espaço no rodapé.`
        });
      }
    }

    if (msgs.length === 0) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }

    box.style.display = 'flex';
    box.innerHTML = msgs
      .map((m) => `<div class="u-alert u-alert-${m.type}">● ${global.esc(m.text)}</div>`)
      .join('');
  }

  /**
   * Renderiza a tabela interativa de conferência (miniatura, códigos lidos + DANFE, pedido,
   * edição manual da SKU, espaço livre e status OK / Por ordem / Resumido / Sem correspondência).
   */
  function renderVerificationTable() {
    const tbody = document.getElementById('upseller-tbody');
    if (!tbody) return;

    if (AppState.labels.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center;padding:24px;color:var(--ink4);">
            Carregue um arquivo ZPL (.zpl, .txt ou .zip) e a Lista de Empacotamento (.xlsx/.csv) para conferir as etiquetas.
          </td>
        </tr>
      `;
      return;
    }

    const rowsHtml = AppState.labels.map((lbl, idx) => {
      const match = AppState.matches[idx] || {
        labelIndex: idx,
        orderIndex: null,
        matchType: 'unmatched',
        customTextOverride: null
      };
      const orderObj =
        match.orderIndex !== null && match.orderIndex !== undefined
          ? AppState.orders.find((o) => o.rowIndex === match.orderIndex) || null
          : null;

      const fit = lbl.lastFitResult || {
        displayText: '',
        fontSize: 28,
        lineCount: 1,
        usableHeight: Math.max(0, lbl.freeBottomDots - 42),
        isSummarized: false,
        noSpaceError: false
      };

      // Miniatura clicável
      const thumbHtml = lbl.thumbnailUrl
        ? `<img src="${lbl.thumbnailUrl}" class="u-thumb" alt="Etiqueta ${idx + 1}" title="Clique para visualizar esta etiqueta no Preview" onclick="window.UpsellerUI.previewSingleLabel(${idx})">`
        : `<div class="u-thumb-placeholder" onclick="window.UpsellerUI.previewSingleLabel(${idx})">ZPL #${idx + 1}</div>`;

      // Códigos lidos (destacando o Code 128 principal e mostrando a chave de 44 dígitos da DANFE separada)
      const codes = lbl.codeInfo && lbl.codeInfo.codes ? lbl.codeInfo.codes : [];
      const nonDanfe = codes.filter((c) => !c.isDanfe);
      const danfe = lbl.codeInfo && lbl.codeInfo.danfeKey ? lbl.codeInfo.danfeKey : null;

      let codesHtml = '';
      if (nonDanfe.length > 0) {
        codesHtml += nonDanfe
          .map(
            (c) =>
              `<div class="u-code-pill" title="${global.esc(c.format)}"><strong>${global.esc(c.text)}</strong></div>`
          )
          .join('');
      } else {
        codesHtml += `<span style="color:var(--ink4);font-size:11px;">Nenhum código lido</span>`;
      }
      if (danfe) {
        codesHtml += `<div class="u-danfe-pill" title="Chave DANFE (44 dígitos - ignorada no casamento)">DANFE: ${global.esc(danfe.slice(0, 10))}…${global.esc(danfe.slice(-6))}</div>`;
      }

      // Select para reassociar pedido manualmente
      const orderOptions = ['<option value="">— Sem pedido —</option>']
        .concat(
          AppState.orders.map((o) => {
            const firstSku = o.items && o.items[0] ? o.items[0].sku || o.items[0].parentSku : '';
            const labelStr = `#${o.rowIndex + 1} · ${o.trackingNumber || o.orderSn || 'Sem Cód'} (${firstSku || 'Sem SKU'})`;
            const selected = o.rowIndex === match.orderIndex ? 'selected' : '';
            return `<option value="${o.rowIndex}" ${selected}>${global.esc(labelStr)}</option>`;
          })
        )
        .join('');

      // Notas do comprador / vendedor (se existirem)
      let notesHtml = '';
      if (orderObj && (orderObj.remarkFromBuyer || orderObj.sellerNote || orderObj.shortCode)) {
        const parts = [];
        if (orderObj.shortCode) parts.push(`Cód: ${orderObj.shortCode}`);
        if (orderObj.remarkFromBuyer) parts.push(`Obs: ${orderObj.remarkFromBuyer}`);
        if (orderObj.sellerNote) parts.push(`Nota: ${orderObj.sellerNote}`);
        notesHtml = `<div class="u-order-notes">${global.esc(parts.join(' · '))}</div>`;
      }

      // Valor do campo editável de SKU (rodapé)
      const autoSkuTokens = global.MatcherInjector.buildItemSkuTokens(orderObj, AppState.config);
      const autoSkuString = autoSkuTokens.join(' | ');
      const inputVal =
        match.customTextOverride !== null && match.customTextOverride !== undefined
          ? match.customTextOverride
          : autoSkuString;

      // Resumo de produtos/quantidades para conferência
      const itemsSummaryHtml =
        orderObj && orderObj.items && orderObj.items.length > 0
          ? orderObj.items
              .map(
                (it) =>
                  `<div class="u-item-line" title="${global.esc(it.productName)}">` +
                  `<strong>${global.esc(it.sku || it.parentSku || 'S/ SKU')}</strong> × ${it.quantity} ` +
                  `<span style="color:var(--ink3)">${global.esc((it.productName || '').slice(0, 34))}</span>` +
                  `</div>`
              )
              .join('')
          : `<span style="color:var(--ink4);font-size:11px;">—</span>`;

      // Espaço livre no rodapé
      const shiftApplied = lbl.actualShiftDots || 0;
      const scalePct = Number(AppState.config.labelScalePercent) || 88;
      const rawFree =
        lbl.effectiveFreeBottomDots !== undefined
          ? lbl.effectiveFreeBottomDots
          : lbl.freeBottomDots + shiftApplied;
      const spaceHtml = `
        <div class="u-space-info">
          <span>Bruto: <strong>${rawFree}</strong> dots</span>
          <span>Útil: <strong>${fit.usableHeight}</strong> dots</span>
          <span>Fonte: <strong>${fit.fontSize}</strong>d (${fit.lineCount || 1}L)</span>
          <span>Escala: <strong>${scalePct}%</strong></span>
          ${shiftApplied > 0 ? `<span style="color:var(--orange)">↑ Subiu ${shiftApplied}d</span>` : ''}
        </div>
      `;

      // Status badge (OK, Por ordem, conferir, Resumido, Sem correspondência)
      const badges = [];
      if (fit.noSpaceError) {
        badges.push(`<span class="u-badge u-badge-err">Sem espaço</span>`);
      } else if (fit.isSummarized) {
        badges.push(`<span class="u-badge u-badge-sum" title="${global.esc(fit.displayText)}">Resumido</span>`);
      }

      if (match.matchType === 'exact') {
        badges.push(`<span class="u-badge u-badge-ok">OK</span>`);
      } else if (match.matchType === 'order') {
        badges.push(`<span class="u-badge u-badge-warn">Por ordem, conferir</span>`);
      } else if (match.matchType === 'manual') {
        badges.push(`<span class="u-badge u-badge-ok">Manual</span>`);
      } else {
        badges.push(`<span class="u-badge u-badge-err">Sem correspondência</span>`);
      }

      return `
        <tr>
          <td class="u-td-num">${idx + 1}</td>
          <td class="u-td-thumb">${thumbHtml}</td>
          <td class="u-td-codes">${codesHtml}</td>
          <td class="u-td-order">
            <select class="u-order-select" onchange="window.UpsellerUI.onReassignOrder(${idx}, this.value)">
              ${orderOptions}
            </select>
            ${orderObj && orderObj.orderSn ? `<div class="u-ordersn">Pedido: ${global.esc(orderObj.orderSn)}</div>` : ''}
            ${notesHtml}
          </td>
          <td class="u-td-sku">
            <input
              type="text"
              class="u-sku-input"
              value="${global.esc(inputVal)}"
              placeholder="Digite a SKU para o rodapé…"
              onchange="window.UpsellerUI.onManualSkuEdit(${idx}, this.value)"
            />
            <div class="u-printed-preview" title="Texto final que será impresso no rodapé">
              Rodapé: <code>${global.esc(fit.displayText || '(vazio)')}</code>
            </div>
          </td>
          <td class="u-td-items">${itemsSummaryHtml}</td>
          <td class="u-td-status">
            <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;">
              ${badges.join('')}
              ${spaceHtml}
            </div>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = rowsHtml.join('');
  }

  /**
   * Evento acionado quando o usuário altera o mapeamento de colunas do Excel.
   */
  async function onColumnRemapChange(selectEl) {
    const key = selectEl.dataset.colkey;
    if (!key) return;
    AppState.columnMap[key] = selectEl.value;
    const built = global.ExcelParser.buildOrdersFromRows(AppState.excelRawRows, AppState.columnMap);
    AppState.orders = built.orders;
    AppState.excelWarnings = built.warnings;
    recomputeMatchesAndRender();
    await rebuildInjectedZplInEditor(false);
  }

  /**
   * Evento acionado quando o usuário reassocia manualmente uma etiqueta a outro pedido da lista.
   */
  async function onReassignOrder(labelIdx, newOrderRowIdxStr) {
    const match = AppState.matches[labelIdx];
    if (!match) return;
    if (newOrderRowIdxStr === '') {
      match.orderIndex = null;
      match.matchType = 'unmatched';
    } else {
      match.orderIndex = parseInt(newOrderRowIdxStr, 10);
      match.matchType = 'manual';
    }
    match.customTextOverride = null;
    await rebuildInjectedZplInEditor(false);
  }

  /**
   * Evento acionado quando o usuário edita manualmente o texto da SKU na tabela.
   */
  async function onManualSkuEdit(labelIdx, newText) {
    const match = AppState.matches[labelIdx];
    if (!match) return;
    match.customTextOverride = newText;
    await rebuildInjectedZplInEditor(false);
  }

  /**
   * Inverte a ordem de associação dos pedidos (útil quando o PDF/ZPL veio na ordem inversa do Excel).
   */
  async function toggleReverseOrders() {
    AppState.reverseOrder = !AppState.reverseOrder;
    recomputeMatchesAndRender();
    await rebuildInjectedZplInEditor(false);
    global.toast(
      AppState.reverseOrder ? 'Ordem dos pedidos invertida.' : 'Ordem original dos pedidos restaurada.',
      'info'
    );
  }

  /**
   * Abre uma etiqueta específica no Preview da coluna direita.
   * @param {number} labelIdx - Índice da etiqueta (0..N-1)
   */
  async function previewSingleLabel(labelIdx) {
    AppState.previewPageIndex = labelIdx + 1;
    updatePreviewPagerUi();
    await convertCurrentPreviewSelection();
  }

  /**
   * Atualiza os botões Anterior / Próxima na barra superior do Preview.
   */
  function updatePreviewPagerUi() {
    const total = AppState.lastCompiledBlocks.length || AppState.labels.length;
    const pagerWrap = document.getElementById('preview-pager');
    const pagerLabel = document.getElementById('preview-pager-label');
    if (!pagerWrap || !pagerLabel) return;

    if (total <= 1) {
      pagerWrap.style.display = 'none';
      return;
    }

    pagerWrap.style.display = 'inline-flex';
    if (AppState.previewPageIndex === 0) {
      pagerLabel.textContent = `Todas (${total})`;
    } else {
      pagerLabel.textContent = `${AppState.previewPageIndex} / ${total}`;
    }
  }

  /**
   * Navega entre "Todas (0)" e as páginas individuais (1..N) no preview.
   * @param {number} delta - -1 para anterior, +1 para próxima, 0 para todas
   */
  async function stepPreviewPage(delta) {
    const total = AppState.lastCompiledBlocks.length || AppState.labels.length;
    if (total <= 1) return;

    if (delta === 0) {
      AppState.previewPageIndex = 0;
    } else {
      let next = AppState.previewPageIndex + delta;
      if (next < 0) next = total;
      if (next > total) next = 0;
      AppState.previewPageIndex = next;
    }
    updatePreviewPagerUi();
    await convertCurrentPreviewSelection();
  }

  /**
   * Constrói os HTMLCanvasElement (816x1218) correspondentes à seleção atual ou a um índice único,
   * incluindo eventuais etiquetas extras de continuação.
   * @param {number|null} [singleIdx=null]
   * @returns {HTMLCanvasElement[]}
   */
  function buildCanvasesForConvert(singleIdx) {
    if (!global.LocalLabelRenderer) return [];
    const items = AppState.lastCompiledItems && AppState.lastCompiledItems.length > 0
      ? AppState.lastCompiledItems
      : AppState.labels.map((l, idx) => ({
          originalIndex: idx,
          labelObj: l,
          orderObj: null,
          fitResult: l.lastFitResult || null
        }));

    if (items.length === 0) return [];

    const selectedItems = (typeof singleIdx === 'number' && singleIdx >= 0 && singleIdx < items.length)
      ? [items[singleIdx]]
      : items;

    const canvases = [];
    selectedItems.forEach((it) => {
      const c = global.LocalLabelRenderer.renderLabelWithSkuToCanvas(it.labelObj, it.fitResult, AppState.config);
      canvases.push(c);
      if (
        AppState.config.enabled &&
        AppState.config.printExtraLabel &&
        it.fitResult &&
        it.fitResult.isSummarized &&
        it.orderObj
      ) {
        const extraCanvas = global.LocalLabelRenderer.renderExtraContinuationCanvas(
          it.orderObj,
          it.labelObj.index + 1,
          AppState.config
        );
        canvases.push(extraCanvas);
      }
    });
    return canvases;
  }

  /**
   * Constrói o ZPL compatível com motores offline (^GFA Hex descomprimido dentro de ^XA...^XZ)
   * quando as etiquetas contêm gráficos ~DG/:Z64:.
   * @param {number|null} [singleIdx=null]
   * @returns {string}
   */
  function buildApiCompatibleZplForConvert(singleIdx) {
    const items = AppState.lastCompiledItems && AppState.lastCompiledItems.length > 0
      ? AppState.lastCompiledItems
      : [];
    if (items.length === 0) return '';

    const selectedItems = (typeof singleIdx === 'number' && singleIdx >= 0 && singleIdx < items.length)
      ? [items[singleIdx]]
      : items;

    return selectedItems.map((it) => {
      if (it.labelObj && it.labelObj.hasGraphic && global.MatcherInjector.buildApiCompatibleGfaZpl) {
        return global.MatcherInjector.buildApiCompatibleGfaZpl(it.labelObj, it.orderObj, it.fitResult, AppState.config);
      }
      return it.zplBlock;
    }).join('\n\n');
  }

  /**
   * Converte apenas a seleção atual do preview (ou todas se previewPageIndex === 0).
   */
  async function convertCurrentPreviewSelection() {
    const total = AppState.lastCompiledBlocks.length;
    if (total === 0 || AppState.previewPageIndex === 0) {
      await global.doConvert(null, null, null);
      return;
    }
    const idx = Math.max(0, Math.min(total - 1, AppState.previewPageIndex - 1));
    const singleZpl = AppState.lastCompiledBlocks[idx];
    await global.doConvert(singleZpl, `Etiqueta ${idx + 1} de ${total}`, idx);
  }

  /**
   * Ponto 8: Botão "Gerar etiqueta de teste".
   * Gera apenas 1 etiqueta (a selecionada no preview ou a primeira) já com a SKU injetada
   * e destaca a dica de impressão 100% em papel 100x150 mm.
   */
  async function generateSingleTestLabel() {
    await rebuildInjectedZplInEditor(false);
    if (AppState.lastCompiledBlocks.length === 0) {
      global.toast('Carregue um ZPL antes de gerar a etiqueta de teste.', 'error');
      return;
    }
    const targetIdx = AppState.previewPageIndex > 0 ? AppState.previewPageIndex - 1 : 0;
    const singleZpl = AppState.lastCompiledBlocks[targetIdx] || AppState.lastCompiledBlocks[0];

    const tipBanner = document.getElementById('test-print-tip');
    if (tipBanner) {
      tipBanner.style.display = 'block';
    }

    dlog('info', 'CONVERT', `Solicitada Etiqueta de Teste (#${targetIdx + 1}).`);
    global.toast(
      'Imprima em 100% (tamanho real), sem ajustar à página, margens nenhuma, papel 100x150 mm',
      'info'
    );
    await global.doConvert(singleZpl, 'Etiqueta de Teste (1 pág.)', targetIdx);
  }

  /**
   * Baixa o arquivo .zpl editado contendo todas as etiquetas com as SKUs injetadas no rodapé.
   */
  async function downloadEditedZpl() {
    await rebuildInjectedZplInEditor(false);
    const ed = document.getElementById('editor');
    const zplContent = ed ? ed.value.trim() : '';
    if (!zplContent) {
      global.toast('Nenhum código ZPL para baixar.', 'error');
      return;
    }
    const zplBlob = new Blob([zplContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(zplBlob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    a.href = url;
    a.download = `etiquetas_com_sku_${ts}.zpl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    dlog('ok', 'ZPL', `Arquivo .zpl editado baixado (${zplContent.length} chars).`);
    global.toast('ZPL editado baixado com sucesso!', 'ok');
  }

  /**
   * Carrega o conjunto de demonstração Shopee/UpSeller (3 etiquetas :Z64: + 3 pedidos Excel)
   * para testar imediatamente o parser, leitura de Code 128, casamento e escalonamento.
   */
  async function loadShopeeDemoData(chipBtn) {
    if (chipBtn) {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      chipBtn.classList.add('active');
    }
    global.toast('Gerando etiquetas :Z64: e planilha Shopee/UpSeller de exemplo…', 'info');
    const demo = await global.ShopeeSample.generateDemoShopeeDataset();

    // Carrega os pedidos simulados da planilha
    AppState.excelHeaders = [
      'tracking_number',
      'order_sn',
      'product_info',
      'remark_from_buyer',
      'seller_note',
      'short_code'
    ];
    AppState.excelRawRows = demo.sampleRows;
    AppState.columnMap = global.ExcelParser.autoDetectColumns(AppState.excelHeaders);
    const built = global.ExcelParser.buildOrdersFromRows(AppState.excelRawRows, AppState.columnMap);
    AppState.orders = built.orders;
    AppState.excelWarnings = built.warnings;

    const excelStatusEl = document.getElementById('excel-file-status');
    if (excelStatusEl) {
      excelStatusEl.textContent = `exemplo_upseller.xlsx (${AppState.orders.length} pedidos)`;
    }

    const ed = document.getElementById('editor');
    if (ed) {
      ed.value = demo.combinedZpl;
      global.syncGutter();
    }

    await analyzeZplSource(demo.combinedZpl);
    switchLeftTab('upseller');
    global.toast('Exemplo Shopee/UpSeller carregado e casado via Code 128!', 'ok');
  }

  /**
   * Inicializa os listeners dos botões de arquivo Excel e controles do modo UpSeller.
   */
  function initUpsellerEvents() {
    const excelInput = document.getElementById('excel-input');
    if (excelInput) {
      excelInput.addEventListener('change', async function () {
        const f = this.files[0];
        if (!f) return;
        this.value = '';
        try {
          dlog('info', 'EXCEL', `Lendo arquivo de lista de empacotamento: "${f.name}" (${f.size} bytes)…`);
          global.toast(`Lendo lista de empacotamento: ${f.name}…`, 'info');
          const res = await global.ExcelParser.readPackingListFile(f);
          AppState.excelHeaders = res.headers;
          AppState.excelRawRows = res.rawRows;
          AppState.columnMap = res.columnMap;
          AppState.orders = res.orders;
          AppState.excelWarnings = res.warnings;

          dlog('ok', 'EXCEL', `Planilha "${f.name}" lida com sucesso: ${res.orders.length} pedido(s) extraído(s).`, {
            colunasDetectadas: res.headers,
            mapeamento: res.columnMap,
            pedidos: res.orders.map((o) => ({
              linha: o.rowIndex + 1,
              tracking: o.trackingNumber,
              orderSn: o.orderSn,
              itens: o.items.map((it) => `${it.sku || it.parentSku} x${it.quantity}`)
            }))
          });

          const excelStatusEl = document.getElementById('excel-file-status');
          if (excelStatusEl) {
            excelStatusEl.textContent = `${f.name} (${res.orders.length} pedidos)`;
          }

          recomputeMatchesAndRender();
          await rebuildInjectedZplInEditor(false);
          switchLeftTab('upseller');
          global.toast(`Lista carregada: ${res.orders.length} pedido(s)!`, 'ok');
        } catch (err) {
          dlog('error', 'EXCEL', `Erro ao ler planilha "${f.name}": ${err.message}`, { stack: err.stack });
          global.toast('Erro ao ler planilha: ' + err.message, 'error');
          global.setStatus('✗ ' + err.message, 'err');
        }
      });
    }
  }

  global.UpsellerUI = {
    AppState,
    switchLeftTab,
    analyzeZplSource,
    rebuildInjectedZplInEditor,
    buildCanvasesForConvert,
    buildApiCompatibleZplForConvert,
    onColumnRemapChange,
    onReassignOrder,
    onManualSkuEdit,
    toggleReverseOrders,
    previewSingleLabel,
    stepPreviewPage,
    generateSingleTestLabel,
    downloadEditedZpl,
    loadShopeeDemoData,
    initUpsellerEvents
  };
})(window);

