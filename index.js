import { Telegraf, Markup } from "telegraf";
import fs from "fs-extra";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== CONFIG =====
const ADMINS = [5840513237]; // Admin Telegram ID
const STOCK_DIR = "./stock";

// ===== STATE =====
const userSession = {};

// ===== GUARD =====
function adminOnly(ctx) {
  if (!ADMINS.includes(ctx.from?.id)) {
    ctx.reply("⛔ Akses ditolak.");
    return false;
  }
  return true;
}

// ===== UTIL (RAW MODE) =====
function formatNumberID(n) {
  return new Intl.NumberFormat("id-ID").format(n);
}

function getProducts() {
  if (!fs.existsSync(STOCK_DIR)) return [];
  return fs.readdirSync(STOCK_DIR)
    .filter(f => f.endsWith(".txt"))
    .map(f => f.replace(".txt", ""))
    .sort();
}

function readStockLines(product) {
  const file = `${STOCK_DIR}/${product}.txt`;
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x.length > 0);
}

function writeStockLines(product, lines) {
  const file = `${STOCK_DIR}/${product}.txt`;
  fs.writeFileSync(file, lines.join("\n"));
}

function getStockCount(product) {
  return readStockLines(product).length;
}

function takeStock(product, amount) {
  const lines = readStockLines(product);
  if (lines.length < amount) return null;

  const taken = lines.splice(0, amount);
  writeStockLines(product, lines);
  return taken.join("\n"); // RAW
}

// ===== RENDER HELPERS =====
async function renderHome(ctx) {
  const products = getProducts();
  if (products.length === 0) {
    return ctx.reply(
      "👋 Halo, Admin.\n\n" +
      "⚠️ Belum ada produk terdaftar.\n\n" +
      "Gunakan tombol di bawah untuk membuat produk pertama.",
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Create Product", "create_product_btn")]
      ])
    );
  }

  const buttons = products.map(p => [Markup.button.callback(p.toUpperCase(), `pick_${p}`)]);
  buttons.push([Markup.button.callback("📦 Cek Semua Stok", "allstock_btn")]);
  buttons.push([Markup.button.callback("➕ Create Product", "create_product_btn")]);

  return ctx.reply(
    "👋 Halo, Admin.\n\nPilih produk atau aksi:",
    Markup.inlineKeyboard(buttons)
  );
}

async function renderProductPanel(ctx, product) {
  const stock = getStockCount(product);
  const stockFmt = formatNumberID(stock);

  if (stock === 0) {
    return ctx.editMessageText(
      `📦 Produk: ${product.toUpperCase()}\nStok: ${stockFmt} ⚠️\n\nStok kosong.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Tambah Stok", `add_${product}`)],
        [Markup.button.callback("⬅️ Kembali", "back_home")]
      ])
    );
  }

  return ctx.editMessageText(
    `📦 Produk: ${product.toUpperCase()}\nStok tersedia: ${stockFmt}\n\nPilih aksi:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📤 Ambil Stok", `take_${product}`)],
      [Markup.button.callback("➕ Tambah Stok", `add_${product}`)],
      [Markup.button.callback("🗑️ Kurangi Stok", `remove_${product}`)],
      [Markup.button.callback("⬅️ Kembali", "back_home")]
    ])
  );
}

// ===== START =====
bot.start(async (ctx) => {
  if (!adminOnly(ctx)) return;
  await renderHome(ctx);
});

// ===== ALL STOCK (BUTTON + COMMAND) =====
async function replyAllStock(ctx) {
  const products = getProducts();
  if (products.length === 0) {
    return ctx.reply("⚠️ Belum ada produk terdaftar.");
  }
  const lines = products.map(p => {
    const c = getStockCount(p);
    return `${p.toUpperCase()}: ${formatNumberID(c)}${c === 0 ? " ⚠️" : ""}`;
  });
  return ctx.reply("📊 Laporan Stok Semua Produk\n\n" + lines.join("\n"));
}

bot.action("allstock_btn", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await replyAllStock(ctx);
});

bot.command("allstock", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await replyAllStock(ctx);
});

// ===== CREATE PRODUCT (BUTTON) =====
bot.action("create_product_btn", async (ctx) => {
  if (!adminOnly(ctx)) return;
  userSession[ctx.from.id] = { step: "input_product_name" };
  await ctx.reply("Masukkan nama produk:");
});

// ===== PICK PRODUCT =====
bot.action(/pick_(.+)/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const product = ctx.match[1];
  userSession[ctx.from.id] = { product };
  await renderProductPanel(ctx, product);
});

// ===== BACK =====
bot.action("back_home", async (ctx) => {
  if (!adminOnly(ctx)) return;
  delete userSession[ctx.from.id];
  await renderHome(ctx);
});

bot.action(/back_product_(.+)/, async (ctx) => {
  if (!adminOnly(ctx)) return;
  const product = ctx.match[1];
  userSession[ctx.from.id] = { product };
  await renderProductPanel(ctx, product);
});

// ===== TAKE =====
bot.action(/take_(.+)/, async (ctx) => {
  if (!adminOnly(ctx)) return;

  const product = ctx.match[1];
  const stock = getStockCount(product);
  if (stock === 0) {
    return ctx.reply(`⚠️ Stok ${product.toUpperCase()} kosong.`);
  }

  userSession[ctx.from.id] = { product, step: "input_qty_take" };
  await ctx.reply(
    `Masukkan jumlah ${product} yang ingin diambil (angka saja):`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `back_product_${product}`)]])
  );
});

// ===== REMOVE =====
bot.action(/remove_(.+)/, async (ctx) => {
  if (!adminOnly(ctx)) return;

  const product = ctx.match[1];
  userSession[ctx.from.id] = { product, step: "input_qty_remove" };
  await ctx.reply(
    `Masukkan jumlah ${product} yang ingin dikurangi (angka saja):`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `back_product_${product}`)]])
  );
});

// ===== ADD (UPLOAD MODE) =====
bot.action(/add_(.+)/, async (ctx) => {
  if (!adminOnly(ctx)) return;

  const product = ctx.match[1];
  userSession[ctx.from.id] = { product, step: "upload_stock" };
  await ctx.reply(
    `Upload file .txt untuk produk ${product.toUpperCase()} (RAW MODE):`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `back_product_${product}`)]])
  );
});

// ===== HANDLE TEXT =====
bot.on("text", async (ctx) => {
  if (!adminOnly(ctx)) return;

  const session = userSession[ctx.from.id];
  if (!session) return;

  // CREATE PRODUCT FLOW
  if (session.step === "input_product_name") {
    const product = ctx.message.text.trim().toLowerCase().replace(/\s+/g, "-");
    if (!product) return ctx.reply("Nama produk tidak boleh kosong.");

    await fs.ensureDir(STOCK_DIR);
    const file = `${STOCK_DIR}/${product}.txt`;
    if (fs.existsSync(file)) {
      return ctx.reply(`❌ Produk ${product.toUpperCase()} sudah ada.`);
    }

    await fs.writeFile(file, "");
    delete userSession[ctx.from.id];

    const stock = getStockCount(product);
    return ctx.reply(
      `✅ Produk ${product.toUpperCase()} berhasil dibuat (stok ${formatNumberID(stock)}).\n\n` +
      `📦 Produk: ${product.toUpperCase()}\n` +
      `Stok: ${formatNumberID(stock)} ⚠️`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Tambah Stok", `add_${product}`)],
        [Markup.button.callback("⬅️ Kembali", "back_home")]
      ])
    );
  }

  // TAKE / REMOVE FLOW
  const qty = parseInt(ctx.message.text);
  if (isNaN(qty) || qty <= 0) {
    return ctx.reply("❌ Masukkan angka yang valid.");
  }

  const stock = getStockCount(session.product);

  if (session.step === "input_qty_take") {
    if (qty > stock) {
      return ctx.reply(`❌ Stok tidak mencukupi. Tersedia: ${formatNumberID(stock)}`);
    }

    const result = takeStock(session.product, qty);
    delete userSession[ctx.from.id];

    // monospace per baris (MarkdownV2 safe)
    const mdEscape = (t) => t.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
    const formatted = result
      .split("\n")
      .map(line => `\`${mdEscape(line)}\``)
      .join("\n");

    return ctx.reply(
      `✅ Berhasil mengambil ${formatNumberID(qty)} stok ${session.product.toUpperCase()}:\n\n${formatted}`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (session.step === "input_qty_remove") {
    const lines = readStockLines(session.product);
    lines.splice(0, qty);
    writeStockLines(session.product, lines);

    delete userSession[ctx.from.id];
    return ctx.reply(`✅ Berhasil mengurangi ${formatNumberID(qty)} stok ${session.product.toUpperCase()}.`);
  }
});

// ===== HANDLE FILE UPLOAD (RAW MODE) =====
bot.on("document", async (ctx) => {
  if (!adminOnly(ctx)) return;

  const session = userSession[ctx.from.id];
  if (!session || session.step !== "upload_stock") {
    return ctx.reply("Gunakan panel produk untuk upload stok.");
  }

  const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
  const res = await fetch(link.href);
  const text = await res.text();

  const newLines = text
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x.length > 0);

  if (newLines.length === 0) {
    return ctx.reply("❌ File kosong. Tidak ada stok yang ditambahkan.");
  }

  const existing = readStockLines(session.product);
  const merged = existing.concat(newLines);
  writeStockLines(session.product, merged);

  const total = merged.length;
  delete userSession[ctx.from.id];

  ctx.reply(`✅ Stok ${session.product.toUpperCase()} berhasil ditambahkan.\nTotal stok sekarang: ${formatNumberID(total)}`);
});

bot.launch();
console.log("Bot running...");
