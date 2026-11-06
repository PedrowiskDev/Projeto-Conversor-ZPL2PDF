/**
 * ui/js/excel-parser.js
 * Leitor de planilhas Excel (.xlsx) e CSV/TSV via SheetJS (ui/lib/xlsx.full.min.js)
 * e parser determinístico da coluna `product_info` no padrão Shopee/UpSeller.
 */

(function (global) {
  'use strict';

  /**
   * Normaliza o nome de um cabeçalho removendo acentos, espaços extras e convertendo para minúsculas.
   * @param {string} str
   * @returns {string}
   */
  function normalizeHeader(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
  }

  /**
   * Detecta automaticamente o mapeamento das colunas a partir da lista de cabeçalhos da planilha.
   * @param {string[]} headers - Cabeçalhos originais da planilha
   * @returns {Object} Mapeamento { tracking_number, order_sn, product_info, remark_from_buyer, seller_note, short_code }
   */
  function autoDetectColumns(headers) {
    const map = {
      tracking_number: '',
      order_sn: '',
      product_info: '',
      remark_from_buyer: '',
      seller_note: '',
      short_code: ''
    };

    const aliases = {
      tracking_number: ['tracking_number', 'tracking_no', 'tracking', 'rastreio', 'codigo_de_rastreio', 'num_rastreio'],
      order_sn: ['order_sn', 'ordersn', 'order_id', 'pedido', 'numero_do_pedido', 'n_do_pedido'],
      product_info: ['product_info', 'product_information', 'info_produto', 'produtos', 'itens', 'informacoes_do_produto'],
      remark_from_buyer: ['remark_from_buyer', 'buyer_remark', 'observacao_comprador', 'nota_comprador'],
      seller_note: ['seller_note', 'observacao_vendedor', 'nota_vendedor'],
      short_code: ['short_code', 'codigo_curto']
    };

    headers.forEach((h) => {
      const norm = normalizeHeader(h);
      Object.keys(aliases).forEach((targetKey) => {
        if (!map[targetKey] && aliases[targetKey].includes(norm)) {
          map[targetKey] = h;
        }
      });
    });

    // Segunda passagem por substring caso não tenha casado exato
    headers.forEach((h) => {
      const norm = normalizeHeader(h);
      if (!map.tracking_number && (norm.includes('tracking') || norm.includes('rastre'))) map.tracking_number = h;
      if (!map.order_sn && (norm.includes('order') || norm.includes('pedido'))) map.order_sn = h;
      if (!map.product_info && (norm.includes('product') || norm.includes('produto') || norm.includes('sku'))) map.product_info = h;
      if (!map.remark_from_buyer && norm.includes('remark')) map.remark_from_buyer = h;
      if (!map.seller_note && norm.includes('seller')) map.seller_note = h;
      if (!map.short_code && norm.includes('short')) map.short_code = h;
    });

    return map;
  }

  /**
   * Faz o parsing de um bloco de texto de item individual do UpSeller sem dividir por ';'.
   * Rótulos extraídos:
   *  - Product Name
   *  - Variation Name
   *  - Price
   *  - Quantity
   *  - SKU Reference No. (com lookbehind negativo para não casar dentro de Parent SKU Reference No.)
   *  - Parent SKU Reference No.
   * @param {string} itemChunk - Texto de um item (após o marcador "[N] Product Name:")
   * @returns {Object} Dados do item extraídos
   */
  function parseSingleProductChunk(itemChunk) {
    // Garante que o chunk comece com "Product Name:" para uniformizar a busca por posições de rótulos
    const text = /^\s*Product Name\s*:/i.test(itemChunk)
      ? itemChunk.trim()
      : 'Product Name:' + itemChunk;

    const labelDefs = [
      { key: 'productName', regex: /Product Name\s*:/i },
      { key: 'variationName', regex: /Variation Name\s*:/i },
      { key: 'price', regex: /Price\s*:/i },
      { key: 'quantity', regex: /Quantity\s*:/i },
      // Lookbehind negativo garante que "SKU Reference No.:" nunca case dentro de "Parent SKU Reference No.:"
      { key: 'sku', regex: /(?<!Parent\s)SKU Reference No\.\s*:/i },
      { key: 'parentSku', regex: /Parent SKU Reference No\.\s*:/i }
    ];

    // Localiza a posição inicial e final de cada rótulo encontrado no texto do item
    const foundPositions = [];
    labelDefs.forEach((def) => {
      const match = def.regex.exec(text);
      if (match) {
        foundPositions.push({
          key: def.key,
          labelStart: match.index,
          valueStart: match.index + match[0].length
        });
      }
    });

    foundPositions.sort((a, b) => a.labelStart - b.labelStart);

    const extracted = {
      productName: '',
      variationName: '',
      price: '',
      quantity: 1,
      quantityRaw: '1',
      sku: '',
      parentSku: ''
    };

    for (let i = 0; i < foundPositions.length; i++) {
      const current = foundPositions[i];
      const next = foundPositions[i + 1];
      const rawVal = next
        ? text.slice(current.valueStart, next.labelStart)
        : text.slice(current.valueStart);

      // Remove apenas o ponto e vírgula delimitador do final do campo, preservando ';' internos
      const cleanVal = rawVal.trim().replace(/;\s*$/, '').trim();

      if (current.key === 'quantity') {
        extracted.quantityRaw = cleanVal || '1';
        const qNum = parseInt(cleanVal, 10);
        extracted.quantity = Number.isFinite(qNum) && qNum > 0 ? qNum : 1;
      } else {
        extracted[current.key] = cleanVal;
      }
    }

    return extracted;
  }

  /**
   * Analisa o conteúdo completo da célula `product_info` de uma linha do Excel.
   * Divide múltiplos itens por /\[\d+\]\s*Product Name:/i sem usar split(';').
   * @param {string} rawProductInfo
   * @returns {{items: Array<Object>, formatWarning: string|null}}
   */
  function parseProductInfoCell(rawProductInfo) {
    if (!rawProductInfo || typeof rawProductInfo !== 'string' || !rawProductInfo.trim()) {
      return { items: [], formatWarning: 'Célula product_info vazia' };
    }

    const raw = rawProductInfo.trim();
    const multiSplitRegex = /\[\d+\]\s*Product Name\s*:/i;

    if (multiSplitRegex.test(raw)) {
      const parts = raw
        .split(/\[\d+\]\s*Product Name\s*:/i)
        .map((p) => p.trim())
        .filter(Boolean);

      const items = parts.map((chunk) => parseSingleProductChunk(chunk));
      return { items, formatWarning: null };
    }

    // Caso tenha apenas 1 item sem prefixo "[1]", mas com "Product Name:" ou "SKU Reference No.:"
    if (/Product Name\s*:/i.test(raw) || /SKU Reference No\.\s*:/i.test(raw)) {
      return {
        items: [parseSingleProductChunk(raw)],
        formatWarning: 'Formato sem índice [1], mas rótulos reconhecidos'
      };
    }

    // Caso o usuário tenha mapeado uma coluna que já contém diretamente a SKU pura
    return {
      items: [
        {
          productName: '',
          variationName: '',
          price: '',
          quantity: 1,
          quantityRaw: '1',
          sku: raw.replace(/;\s*$/, '').trim(),
          parentSku: ''
        }
      ],
      formatWarning: 'Formato diferente do padrão "[1] Product Name:..."; lido como texto direto de SKU'
    };
  }

  /**
   * Resolve qual string de SKU deve ser impressa para um item de acordo com a preferência do usuário.
   * Por padrão usa `SKU Reference No.` e faz fallback automático para `Parent SKU Reference No.`.
   * @param {Object} item - Item retornado por parseProductInfoCell
   * @param {string} skuPreference - 'sku' (padrão com fallback), 'parent' (apenas SKU pai), 'both' (ambos)
   * @returns {string}
   */
  function resolveItemSkuText(item, skuPreference) {
    if (!item) return '';
    const sku = (item.sku || '').trim();
    const parent = (item.parentSku || '').trim();

    if (skuPreference === 'parent') {
      return parent || sku;
    }
    if (skuPreference === 'both') {
      if (sku && parent && sku.toUpperCase() !== parent.toUpperCase()) {
        return `${sku} (${parent})`;
      }
      return sku || parent;
    }
    // Padrão ('sku'): usa SKU Reference No., se vazio usa Parent SKU Reference No. como reserva
    return sku || parent;
  }

  /**
   * Converte as linhas brutas da planilha em objetos de pedido estruturados usando o mapeamento de colunas.
   * @param {Array<Object>} rawRows - Linhas lidas pelo SheetJS
   * @param {Object} columnMap - Mapeamento de colunas ativo
   * @returns {{orders: Array<Object>, warnings: string[]}}
   */
  function buildOrdersFromRows(rawRows, columnMap) {
    const warnings = [];
    if (!columnMap.product_info) {
      warnings.push('Coluna "product_info" não encontrada automaticamente. Selecione a coluna correta no mapeamento.');
    }

    let emptySkuCount = 0;
    let formatDiffCount = 0;

    const orders = (rawRows || []).map((row, idx) => {
      const trackingNumber = columnMap.tracking_number ? String(row[columnMap.tracking_number] || '').trim() : '';
      const orderSn = columnMap.order_sn ? String(row[columnMap.order_sn] || '').trim() : '';
      const rawProductInfo = columnMap.product_info ? String(row[columnMap.product_info] || '').trim() : '';
      const remarkFromBuyer = columnMap.remark_from_buyer ? String(row[columnMap.remark_from_buyer] || '').trim() : '';
      const sellerNote = columnMap.seller_note ? String(row[columnMap.seller_note] || '').trim() : '';
      const shortCode = columnMap.short_code ? String(row[columnMap.short_code] || '').trim() : '';

      const parsed = parseProductInfoCell(rawProductInfo);
      if (parsed.formatWarning && rawProductInfo) {
        formatDiffCount++;
      }

      const hasAnySku = parsed.items.some((it) => Boolean((it.sku || '').trim() || (it.parentSku || '').trim()));
      if (!hasAnySku) {
        emptySkuCount++;
      }

      return {
        rowIndex: idx,
        excelRowNumber: idx + 2,
        trackingNumber,
        orderSn,
        rawProductInfo,
        remarkFromBuyer,
        sellerNote,
        shortCode,
        items: parsed.items,
        hasAnySku
      };
    });

    if (emptySkuCount > 0) {
      warnings.push(`${emptySkuCount} pedido(s) na planilha estão com a SKU vazia.`);
    }
    if (formatDiffCount > 0) {
      warnings.push(`${formatDiffCount} linha(s) possuem formato de product_info diferente do padrão "[1] Product Name:...". Confira na tabela.`);
    }

    return { orders, warnings };
  }

  /**
   * Lê um arquivo File (.xlsx, .csv, .tsv) usando a biblioteca SheetJS local.
   * @param {File} file
   * @returns {Promise<{headers: string[], rawRows: Array<Object>, columnMap: Object, orders: Array<Object>, warnings: string[]}>}
   */
  async function readPackingListFile(file) {
    if (!global.XLSX) {
      throw new Error('Biblioteca SheetJS (ui/lib/xlsx.full.min.js) não carregada.');
    }

    const ab = await file.arrayBuffer();
    const workbook = global.XLSX.read(ab, { type: 'array', raw: false });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error('A planilha selecionada não possui abas.');
    }

    const sheet = workbook.Sheets[firstSheetName];
    const jsonRows = global.XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!jsonRows || jsonRows.length === 0) {
      throw new Error('A lista de empacotamento está vazia.');
    }

    const headers = Object.keys(jsonRows[0] || {});
    const columnMap = autoDetectColumns(headers);
    const { orders, warnings } = buildOrdersFromRows(jsonRows, columnMap);

    return {
      fileName: file.name,
      headers,
      rawRows: jsonRows,
      columnMap,
      orders,
      warnings
    };
  }

  global.ExcelParser = {
    normalizeHeader,
    autoDetectColumns,
    parseProductInfoCell,
    resolveItemSkuText,
    buildOrdersFromRows,
    readPackingListFile
  };
})(window);
