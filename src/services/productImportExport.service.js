const XLSX = require('xlsx');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const activityLogService = require('./activityLog.service');
const { LOG_ACTIONS } = require('../utils/constants');
const { AppError } = require('../middleware/errorHandler.middleware');
const { invalidateCache } = require('./product.service');
const { normalizeImageUrls } = require('../utils/imageUrl');

const HEADER_ROW = [
  'Product Name *',
  'Category *',
  'Product Description',
  'Active (TRUE/FALSE)',
  'Variety Name *',
  'Variety Description',
  'Packaging Size *',
  'Price KES',
  'Stock Quantity',
  'Low Stock Alert',
  'Quote Only (TRUE/FALSE)',
  'Image URLs (JSON array)', // column L — optional, populated by generate-xlsx.js
];

const validateHeaders = (headerRow = []) => {
  const normalized = headerRow.map(value => String(value || '').trim());
  const missing = HEADER_ROW.filter((expected, index) => normalized[index] !== expected);

  if (missing.length > 0) {
    throw new AppError(
      'Invalid import template. Please download the latest template and try again.',
      400,
      'INVALID_IMPORT_TEMPLATE'
    );
  }
};

// ── EXPORT ────────────────────────────────────────────────────────────────────
const exportProducts = async (branchId = null) => {
  const filter = {};
  if (branchId) filter.branchId = branchId;
  const products = await Product.find(filter).lean();
  const rows = [];

  for (const product of products) {
    const varieties = product.varieties || [];
    if (varieties.length === 0) {
      rows.push([product.name, product.category, product.description || '',
        product.isActive ? 'TRUE' : 'FALSE', '', '', '', '', '', '', '', '']);
      continue;
    }
    for (const variety of varieties) {
      const packaging = variety.packaging || [];
      if (packaging.length === 0) {
        rows.push([product.name, product.category, product.description || '',
          product.isActive ? 'TRUE' : 'FALSE', variety.varietyName || '',
          variety.description || '', '', '', '', '', '',
          JSON.stringify(normalizeImageUrls(variety.imageURLs || product.imageURLs || []))]);
        continue;
      }
      for (const pkg of packaging) {
        rows.push([
          product.name, product.category, product.description || '',
          product.isActive ? 'TRUE' : 'FALSE',
          variety.varietyName || '', variety.description || '',
          pkg.size || '',
          pkg.quoteOnly ? '' : (pkg.priceKES || ''),
          pkg.quoteOnly ? '' : (pkg.stock ?? ''),
          pkg.lowStockThreshold ?? 10,
          pkg.quoteOnly ? 'TRUE' : 'FALSE',
          JSON.stringify(normalizeImageUrls(variety.imageURLs || product.imageURLs || [])),
        ]);
      }
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([HEADER_ROW, ...rows]);
  ws['!cols'] = [
    { wch: 22 }, { wch: 15 }, { wch: 30 }, { wch: 16 },
    { wch: 20 }, { wch: 25 }, { wch: 14 }, { wch: 12 },
    { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 60 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  const instructions = [
    ['IMPORT INSTRUCTIONS'], [''],
    ['1. Do not change column headers'],
    ['2. ONE ROW PER PACKAGING SIZE — e.g. Yellow Maize 50kg = row 1, Yellow Maize 90kg = row 2'],
    ['3. Product Name + Variety Name groups rows into the same product/variety'],
    ['4. If a product already exists (matched by name), it will be UPDATED'],
    ['5. Set Active to TRUE to make product visible in the shop immediately'],
    ['6. For Bulk sizes, set Quote Only to TRUE and leave Price and Stock blank'],
    ['7. Image URLs column accepts a JSON array: ["url1","url2"] — leave blank to keep existing images'],
  ];
  const wsInstr = XLSX.utils.aoa_to_sheet(instructions);
  wsInstr['!cols'] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsInstr, 'Instructions');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// ── TEMPLATE ──────────────────────────────────────────────────────────────────
const getTemplate = () => {
  const wb = XLSX.utils.book_new();
  const sampleRows = [
    HEADER_ROW,
    // Maize — Yellow variety — 3 packaging sizes (3 rows)
    ['Maize', 'Cereals', 'Quality dried maize', 'TRUE', 'Yellow Maize', 'Grade A', '50kg',  3800, 120, 20, 'FALSE', ''],
    ['Maize', 'Cereals', 'Quality dried maize', 'TRUE', 'Yellow Maize', 'Grade A', '90kg',  6500,  45, 10, 'FALSE', ''],
    ['Maize', 'Cereals', 'Quality dried maize', 'TRUE', 'Yellow Maize', 'Grade A', 'Bulk',    '',  '',  5, 'TRUE',  ''],
    // Maize — White variety — 2 packaging sizes (2 rows)
    ['Maize', 'Cereals', 'Quality dried maize', 'TRUE', 'White Maize',  'Premium', '50kg',  4000,  80, 15, 'FALSE', ''],
    ['Maize', 'Cereals', 'Quality dried maize', 'TRUE', 'White Maize',  'Premium', '90kg',  7000,  30, 10, 'FALSE', ''],
    // Beans — Rose Coco — 1 packaging size
    ['Beans', 'Beans',   'Fresh dried beans',   'TRUE', 'Rose Coco',    '',        '50kg',  7500,  60, 10, 'FALSE', ''],
    // Beans — Mwitemania — 1 packaging size
    ['Beans', 'Beans',   'Fresh dried beans',   'TRUE', 'Mwitemania',   '',        '50kg',  8000,  40, 10, 'FALSE', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(sampleRows);
  ws['!cols'] = [
    { wch: 22 }, { wch: 15 }, { wch: 30 }, { wch: 16 },
    { wch: 20 }, { wch: 25 }, { wch: 14 }, { wch: 12 },
    { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 60 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// ── VALIDATE A SINGLE ROW ─────────────────────────────────────────────────────
const validateRow = (row, rowNum) => {
  const errors = [];
  const productName = String(row[0] || '').trim();
  const category    = String(row[1] || '').trim();
  const varietyName = String(row[4] || '').trim();
  const pkgSize     = String(row[6] || '').trim();
  const priceRaw    = row[7];
  const stockRaw    = row[8];
  const quoteOnly   = String(row[10] || '').trim().toUpperCase() === 'TRUE';

  if (!productName) errors.push('Product Name is required');
  if (!category)    errors.push('Category is required');

  if (varietyName && pkgSize) {
    if (!quoteOnly) {
      if (priceRaw === '' || priceRaw === null || priceRaw === undefined) {
        errors.push('Price KES is required (or set Quote Only to TRUE)');
      } else if (isNaN(Number(priceRaw)) || Number(priceRaw) < 0) {
        errors.push(`Price KES must be a positive number (got: "${priceRaw}")`);
      }
      if (stockRaw !== '' && stockRaw !== null && stockRaw !== undefined) {
        if (isNaN(Number(stockRaw)) || Number(stockRaw) < 0) {
          errors.push(`Stock must be a positive number (got: "${stockRaw}")`);
        }
      }
    }
    const threshold = row[9];
    if (threshold !== '' && threshold !== null && threshold !== undefined) {
      if (isNaN(Number(threshold)) || Number(threshold) < 0) {
        errors.push(`Low Stock Alert must be a positive number (got: "${threshold}")`);
      }
    }
  } else if (varietyName && !pkgSize) {
    errors.push('Packaging Size is required when Variety Name is provided');
  }

  return errors.length > 0
    ? { valid: false, rowNum, productName: productName || '(unknown)', errors }
    : { valid: true };
};

// ── PARSE IMAGE URLS FROM COLUMN L ────────────────────────────────────────────
const parseImageURLs = (raw) => {
  if (!raw || String(raw).trim() === '') return [];
  try {
    const parsed = JSON.parse(String(raw).trim());
    if (Array.isArray(parsed)) {
      return parsed.filter(u => typeof u === 'string' && u.trim().startsWith('http')).map(u => u.trim());
    }
  } catch {
    // If not JSON, treat as single URL
    const url = String(raw).trim();
    if (url.startsWith('http')) return [url];
  }
  return [];
};

const mergeUniqueStrings = (existing = [], incoming = []) => {
  const values = [...(existing || []), ...(incoming || [])]
    .filter(Boolean);

  return [...new Set(values)];
};

const buildMergedVarieties = (existingVarieties = [], importedVarieties = []) => {
  const existingMap = new Map(
    (existingVarieties || []).map(variety => [String(variety.varietyName || '').trim().toLowerCase(), variety])
  );

  const merged = importedVarieties.map((importedVariety) => {
    const varietyKey = String(importedVariety.varietyName || '').trim().toLowerCase();
    const existingVariety = existingMap.get(varietyKey);
    const existingPackagingMap = new Map(
      (existingVariety?.packaging || []).map(pkg => [String(pkg.size || '').trim().toLowerCase(), pkg])
    );

    const packaging = (importedVariety.packaging || []).map((importedPkg) => {
      const pkgKey = String(importedPkg.size || '').trim().toLowerCase();
      const existingPkg = existingPackagingMap.get(pkgKey);

      return {
        size: importedPkg.size,
        priceKES: importedPkg.quoteOnly
          ? null
          : (importedPkg.priceKES ?? existingPkg?.priceKES ?? null),
        stock: importedPkg.quoteOnly
          ? null
          : (importedPkg.stock ?? existingPkg?.stock ?? 0),
        lowStockThreshold: importedPkg.lowStockThreshold ?? existingPkg?.lowStockThreshold ?? 10,
        quoteOnly: importedPkg.quoteOnly,
      };
    });

    for (const existingPkg of (existingVariety?.packaging || [])) {
      const pkgKey = String(existingPkg.size || '').trim().toLowerCase();
      const alreadyIncluded = packaging.some(pkg => String(pkg.size || '').trim().toLowerCase() === pkgKey);
      if (!alreadyIncluded) packaging.push(existingPkg);
    }

    existingMap.delete(varietyKey);

    return {
      varietyName: importedVariety.varietyName,
      description: importedVariety.description || existingVariety?.description || '',
      imageURLs: importedVariety.imageURLs?.length > 0
        ? mergeUniqueStrings(existingVariety?.imageURLs, importedVariety.imageURLs)
        : (existingVariety?.imageURLs || []),
      packaging,
    };
  });

  for (const leftoverVariety of existingMap.values()) {
    merged.push(leftoverVariety);
  }

  return merged;
};

// ── IMPORT ────────────────────────────────────────────────────────────────────
const resolveImportBranches = async ({ branchId, actorRole, importScope }) => {
  if (branchId) {
    const branch = await Branch.findOne({ _id: branchId, isActive: true }).select('_id name').lean();
    if (!branch) throw new AppError('Selected branch was not found or is inactive', 404, 'BRANCH_NOT_FOUND');
    return [branch];
  }

  if (actorRole !== 'superadmin') {
    throw new AppError('Branch context required for product import', 403, 'BRANCH_REQUIRED');
  }

  const scope = String(importScope || 'allBranches').trim();
  if (scope !== 'allBranches') {
    throw new AppError('Superadmin import without branch context must target all branches', 400, 'INVALID_IMPORT_SCOPE');
  }

  const branches = await Branch.find({ isActive: true }).select('_id name').lean();
  if (branches.length === 0) {
    throw new AppError('No active branches found for import', 400, 'NO_ACTIVE_BRANCHES');
  }

  return branches;
};

const importProducts = async (fileBuffer, adminId, options = {}) => {
  const {
    branchId = null,
    actorRole = 'admin',
    importScope = 'currentBranch',
    dryRun = false,
  } = options;

  const wb = XLSX.read(fileBuffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (rawRows.length < 2) throw new Error('File is empty or missing data rows');
  validateHeaders(rawRows[0]);

  const dataRows = rawRows.slice(1).filter(row =>
    row.some(cell => cell !== '' && cell !== null && cell !== undefined)
  );

  if (dataRows.length === 0) throw new Error('No data rows found in file');

  const targetBranches = await resolveImportBranches({ branchId, actorRole, importScope });
  const results = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    dryRun,
    preview: [],
    importedToBranches: targetBranches.map(branch => ({ id: branch._id, name: branch.name })),
  };
  const productMap = new Map();

  // ── PASS 1: VALIDATE + BUILD MAP ─────────────────────────────────────────
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2;
    const validation = validateRow(row, rowNum);

    if (!validation.valid) {
      validation.errors.forEach(msg => {
        results.errors.push({ row: rowNum, product: validation.productName, message: msg });
      });
      results.skipped++;
      continue;
    }

    const productName = String(row[0] || '').trim();
    const category    = String(row[1] || '').trim();
    const productDesc = String(row[2] || '').trim();
    const isActive    = String(row[3] || '').trim().toUpperCase() === 'TRUE';
    const varietyName = String(row[4] || '').trim();
    const varietyDesc = String(row[5] || '').trim();
    const pkgSize     = String(row[6] || '').trim();
    const priceKES    = row[7] !== '' ? Number(row[7]) : null;
    const stock       = row[8] !== '' ? Number(row[8]) : null;
    const threshold   = row[9] !== '' ? Number(row[9]) : 10;
    const quoteOnly   = String(row[10] || '').trim().toUpperCase() === 'TRUE';
    const imageURLs   = parseImageURLs(row[11]); // column L

    const key = productName.toLowerCase();

    if (!productMap.has(key)) {
      productMap.set(key, {
        name: productName,
        category,
        description: productDesc,
        isActive,
        imageURLs: [],
        varieties: new Map(),
      });
    }

    const product = productMap.get(key);
    product.isActive = isActive;
    product.category = category;
    if (productDesc) product.description = productDesc;
    // Collect product-level images (de-duplicated)
    imageURLs.forEach(url => {
      if (!product.imageURLs.includes(url)) product.imageURLs.push(url);
    });

    if (!varietyName || !pkgSize) continue;

    const varKey = varietyName.toLowerCase();
    if (!product.varieties.has(varKey)) {
      product.varieties.set(varKey, {
        varietyName,
        description: varietyDesc,
        imageURLs: [],
        packaging: [],
      });
    }

    const variety = product.varieties.get(varKey);
    if (varietyDesc) variety.description = varietyDesc;

    // Save images at variety level too
    imageURLs.forEach(url => {
      if (!variety.imageURLs.includes(url)) variety.imageURLs.push(url);
    });

    // Prevent duplicate packaging sizes within same variety
    const pkgExists = variety.packaging.some(p => p.size.toLowerCase() === pkgSize.toLowerCase());
    if (pkgExists) {
      results.errors.push({
        row: rowNum, product: productName,
        message: `Duplicate packaging size "${pkgSize}" for variety "${varietyName}" — row skipped`
      });
      continue;
    }

    variety.packaging.push({
      size: pkgSize,
      priceKES: quoteOnly ? null : (isNaN(priceKES) ? null : priceKES),
      stock: quoteOnly ? null : (stock === null || isNaN(stock) ? null : stock),
      lowStockThreshold: isNaN(threshold) ? 10 : threshold,
      quoteOnly,
    });
  }

  // ── PASS 2: UPSERT TO DATABASE ────────────────────────────────────────────
  for (const branch of targetBranches) {
    for (const [, productData] of productMap) {
      try {
        const varieties = Array.from(productData.varieties.values());

        const payload = {
          name: productData.name,
          category: productData.category,
          description: productData.description || '',
          isActive: productData.isActive,
          imageURLs: productData.imageURLs,
          varieties,
          branchId: branch._id,
        };

        const escapedName = productData.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const existing = await Product.findOne({
          branchId: branch._id,
          name: { $regex: new RegExp(`^${escapedName}$`, 'i') }
        });

        const packagingCount = varieties.reduce((total, variety) => total + (variety.packaging?.length || 0), 0);
        const action = existing ? 'update' : 'create';
        if (results.preview.length < 40) {
          results.preview.push({
            branch: branch.name,
            productName: productData.name,
            action,
            varieties: varieties.length,
            packagingCount,
          });
        }

        if (existing) {
          results.updated++;
          if (!dryRun) {
            const mergedImages = mergeUniqueStrings(existing.imageURLs, productData.imageURLs);
            const mergedVarieties = buildMergedVarieties(existing.varieties, varieties);
            await Product.findByIdAndUpdate(existing._id, {
              ...payload,
              imageURLs: mergedImages,
              varieties: mergedVarieties,
              updatedAt: new Date()
            }, { runValidators: true });
            await activityLogService.log({
              actorId: adminId,
              actorRole,
              action: LOG_ACTIONS.PRODUCT_EDITED,
              branchId: branch._id,
              targetId: existing._id,
              targetType: 'Product',
              detail: {
                source: 'bulk_import',
                productName: productData.name,
                branchName: branch.name,
              },
            });
          }
        } else {
          results.created++;
          if (!dryRun) {
            const newProduct = await Product.create({ ...payload, createdBy: adminId });
            await activityLogService.log({
              actorId: adminId,
              actorRole,
              action: LOG_ACTIONS.PRODUCT_ADDED,
              branchId: branch._id,
              targetId: newProduct._id,
              targetType: 'Product',
              detail: {
                source: 'bulk_import',
                productName: productData.name,
                branchName: branch.name,
              },
            });
          }
        }

        if (!dryRun) invalidateCache(branch._id);
      } catch (err) {
        let message = err.message;
        if (err.name === 'ValidationError') {
          message = Object.values(err.errors).map(e => e.message).join('; ');
        }
        results.errors.push({
          product: productData.name,
          branch: branch.name,
          message,
        });
        results.skipped++;
      }
    }
  }

  return results;
};

module.exports = {
  exportProducts,
  importProducts,
  getTemplate,
  __private: {
    HEADER_ROW,
    validateHeaders,
    validateRow,
    buildMergedVarieties,
    mergeUniqueStrings,
    parseImageURLs,
  }
};
