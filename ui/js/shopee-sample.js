/**
 * ui/js/shopee-sample.js
 * Gerador local de exemplos reais no formato Shopee/UpSeller:
 *  - Gera etiquetas ZPL 4x6 pol (816x1218 dots, 102 bytes/linha, 124236 bytes) em :Z64:
 *    contendo cabeçalho, faixas divisórias, código de barras Code 128 real (BR + 13 dígitos),
 *    código de barras de 44 dígitos da DANFE e faixa branca de ~72 dots no rodapé.
 *  - Gera linhas de exemplo idênticas à Lista de Empacotamento Excel do UpSeller.
 */

(function (global) {
  'use strict';

  // Padrões Code 128 (subsets B e C) para desenhar barras 1-bit reais no bitmap de exemplo
  const PATTERNS = [
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
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
  ];

  function setPixel(bitmap, bytesPerRow, x, y) {
    if (x < 0 || x >= bytesPerRow * 8 || y < 0 || y >= 1218) return;
    const idx = y * bytesPerRow + (x >> 3);
    bitmap[idx] |= 0x80 >> (x & 7);
  }

  function drawRect(bitmap, bytesPerRow, x, y, w, h) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        setPixel(bitmap, bytesPerRow, col, row);
      }
    }
  }

  /**
   * Desenha um código de barras Code 128 Subset B diretamente no bitmap 1-bit.
   */
  function drawCode128B(bitmap, bytesPerRow, startX, startY, barHeight, moduleWidth, text) {
    const codes = [104]; // Start B
    let checksum = 104;
    for (let i = 0; i < text.length; i++) {
      const val = text.charCodeAt(i) - 32;
      codes.push(val);
      checksum += val * (i + 1);
    }
    codes.push(checksum % 103);
    codes.push(106); // Stop

    let curX = startX;
    codes.forEach((sym) => {
      const pat = PATTERNS[sym];
      for (let i = 0; i < pat.length; i++) {
        const w = parseInt(pat[i], 10) * moduleWidth;
        const isBlack = i % 2 === 0;
        if (isBlack) {
          drawRect(bitmap, bytesPerRow, curX, startY, w, barHeight);
        }
        curX += w;
      }
    });
  }

  /**
   * Desenha um código de barras Code 128 Subset C (pares de dígitos, ideal para 44 dígitos da DANFE).
   */
  function drawCode128C(bitmap, bytesPerRow, startX, startY, barHeight, moduleWidth, digits) {
    const codes = [105]; // Start C
    let checksum = 105;
    let weight = 1;
    for (let i = 0; i < digits.length; i += 2) {
      const val = parseInt(digits.substr(i, 2), 10) || 0;
      codes.push(val);
      checksum += val * weight;
      weight++;
    }
    codes.push(checksum % 103);
    codes.push(106); // Stop

    let curX = startX;
    codes.forEach((sym) => {
      const pat = PATTERNS[sym];
      for (let i = 0; i < pat.length; i++) {
        const w = parseInt(pat[i], 10) * moduleWidth;
        const isBlack = i % 2 === 0;
        if (isBlack) {
          drawRect(bitmap, bytesPerRow, curX, startY, w, barHeight);
        }
        curX += w;
      }
    });
  }

  /**
   * Gera um bitmap 816x1218 (102 bytes/linha, 124236 bytes) imitando o layout real Shopee/UpSeller,
   * terminando na linha Y = 1145 (deixando 72 dots de faixa branca no rodapé).
   */
  async function createShopeeLabelZpl(trackingNumber, danfeKey) {
    const bytesPerRow = 102;
    const height = 1218;
    const totalBytes = bytesPerRow * height; // 124236
    const bitmap = new Uint8Array(totalBytes);

    // Moldura superior (a partir de Y = 36 para ter 36 dots brancos no topo)
    drawRect(bitmap, bytesPerRow, 24, 36, 768, 4);
    drawRect(bitmap, bytesPerRow, 24, 190, 768, 3);
    // Faixa preta de roteamento Shopee
    drawRect(bitmap, bytesPerRow, 24, 240, 768, 46);

    // Code 128 do rastreio (BR + 13 caracteres) na faixa central (Y = 360..480)
    drawCode128B(bitmap, bytesPerRow, 68, 360, 120, 3, trackingNumber);

    // Divisória do remetente e DANFE simplificado
    drawRect(bitmap, bytesPerRow, 24, 540, 768, 3);
    drawRect(bitmap, bytesPerRow, 24, 790, 768, 4);

    // Código de barras longo de 44 dígitos da DANFE terminando em Y = 1145 (restam 72 dots brancos no rodapé)
    drawCode128C(bitmap, bytesPerRow, 54, 1025, 120, 2, danfeKey);

    const z64 = await global.ZplBitmap.compressToZ64(bitmap);
    const payload = z64 || global.ZplBitmap.encodeBitmapToHex(bitmap);

    return (
      `~DGR:DEMO.GRF,${totalBytes},${bytesPerRow},${payload}\n` +
      `^XA^MMT,Y^PON^MNY^FO0,0^XGR:DEMO^FS^XZ`
    );
  }

  /**
   * Retorna um conjunto completo de demonstração (3 etiquetas ZPL :Z64: + 3 pedidos da planilha UpSeller)
   * para testar imediatamente 1 item, múltiplos itens e resumo.
   */
  async function generateDemoShopeeDataset() {
    const sampleRows = [
      {
        tracking_number: 'BR261787314969D',
        order_sn: '2610314MFNXV1J',
        product_info:
          '[1] Product Name:Reparo Driver Para D250x Corneta 8ohms 100w; Variation Name:; Price: R$ 19.00; Quantity: 1; SKU Reference No.: SKUD250X; Parent SKU Reference No.: SKUD250X;',
        remark_from_buyer: '',
        seller_note: '',
        short_code: 'A-01'
      },
      {
        tracking_number: 'BR261787314970E',
        order_sn: '2610314MFNXV2K',
        product_info:
          '[1] Product Name:Capacitor Poliester 47uf 250v; Variation Name:Kit; Price: R$ 12.50; Quantity: 2; SKU Reference No.: CAP-47UF; Parent SKU Reference No.: CAP-47UF;\n' +
          '[2] Product Name:Bocal Corneta Curta Preta; Variation Name:Preto; Price: R$ 15.00; Quantity: 4; SKU Reference No.: BOCAL-LC14; Parent SKU Reference No.: BOCAL-LC14;',
        remark_from_buyer: 'Enviar bem embalado',
        seller_note: '',
        short_code: 'A-02'
      },
      {
        tracking_number: 'BR261787314971F',
        order_sn: '2610314MFNXV3L',
        product_info:
          '[1] Product Name:Driver Fenolico 100w; Variation Name:8 Ohms; Price: R$ 59.90; Quantity: 2; SKU Reference No.: DRV-FEN100; Parent SKU Reference No.: DRV-FEN100;\n' +
          '[2] Product Name:Super Tweeter 120w; Variation Name:Preto; Price: R$ 49.90; Quantity: 2; SKU Reference No.: STW-120W; Parent SKU Reference No.: STW-120W;\n' +
          '[3] Product Name:Cabo RCA Duplo 5mBlindado; Variation Name:Azul; Price: R$ 24.00; Quantity: 3; SKU Reference No.: CABO-RCA5M-AZ; Parent SKU Reference No.: CABO-RCA5M;\n' +
          '[4] Product Name:Conector Speakon Macho; Variation Name:; Price: R$ 8.00; Quantity: 6; SKU Reference No.: CON-SPK-M; Parent SKU Reference No.: CON-SPK;\n' +
          '[5] Product Name:Filtro Divisor de Frequencia; Variation Name:; Price: R$ 18.00; Quantity: 2; SKU Reference No.: DIV-FREQ-2V; Parent SKU Reference No.: DIV-FREQ;',
        remark_from_buyer: '',
        seller_note: 'Pedido grande',
        short_code: 'A-03'
      }
    ];

    const zpl1 = await createShopeeLabelZpl(
      'BR261787314969D',
      '35261112345678000199550010000842911008429105'
    );
    const zpl2 = await createShopeeLabelZpl(
      'BR261787314970E',
      '35261112345678000199550010000842921008429208'
    );
    const zpl3 = await createShopeeLabelZpl(
      'BR261787314971F',
      '35261112345678000199550010000842931008429301'
    );

    return {
      combinedZpl: [zpl1, zpl2, zpl3].join('\n\n'),
      sampleRows
    };
  }

  global.ShopeeSample = {
    createShopeeLabelZpl,
    generateDemoShopeeDataset
  };
})(window);
